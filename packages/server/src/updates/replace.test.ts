/**
 * Replacing the control-plane container, against an Engine API double on a
 * unix socket that records what it is asked to create: ports, volumes,
 * restart policy and networks must survive the swap; settings inherited from
 * the old image must not; a replacement that never gets healthy is rolled back.
 * The updater container's own lifecycle (launch, state, cleanup) is here too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerClient, type ContainerInspect, type ImageInspect } from '../docker/client.ts';
import type { AppConfig } from '../lib/config.ts';
import { launchUpdater, updaterState, UPDATER_CONTAINER } from './launcher.ts';
import { ReplaceError, replaceContainer } from './replace.ts';
import type { SelfContainer } from './self.ts';

interface FakeContainer {
  Id: string;
  Name: string;
  Image: string;
  Running: boolean;
  Status: string;
  ExitCode: number;
  Health?: string;
  Config: ContainerInspect['Config'];
  HostConfig: ContainerInspect['HostConfig'];
  Mounts: NonNullable<ContainerInspect['Mounts']>;
  Networks: ContainerInspect['NetworkSettings']['Networks'];
  spec: Record<string, unknown> | null;
}

class FakeDaemon {
  readonly containers = new Map<string, FakeContainer>();
  readonly images = new Map<string, ImageInspect>();
  readonly created: { name: string; spec: Record<string, unknown> }[] = [];
  readonly connected: { network: string; container: string; aliases: string[] }[] = [];
  readonly ops: string[] = [];
  readonly logs = new Map<string, string>();
  /** Containers that die as soon as they are started. */
  readonly dyingOnStart = new Set<string>();
  private seq = 0;

  find(ref: string): FakeContainer | undefined {
    const name = decodeURIComponent(ref);
    return [...this.containers.values()].find((container) => container.Name === name || container.Id === name || container.Id.startsWith(name));
  }

  add(name: string, container: Partial<FakeContainer> & { Config: ContainerInspect['Config']; HostConfig: ContainerInspect['HostConfig'] }): FakeContainer {
    this.seq += 1;
    const record: FakeContainer = {
      Id: `c${String(this.seq).padStart(11, '0')}`,
      Name: name,
      Image: container.Config.Image,
      Running: true,
      Status: 'running',
      ExitCode: 0,
      Mounts: [],
      Networks: {},
      spec: null,
      ...container,
    };
    this.containers.set(record.Id, record);
    return record;
  }

  inspect(container: FakeContainer): ContainerInspect {
    return {
      Id: container.Id,
      Name: `/${container.Name}`,
      Created: '',
      RestartCount: 0,
      Image: this.images.get(container.Image)?.Id ?? container.Image,
      State: { Status: container.Status, Running: container.Running, Restarting: false, OOMKilled: false, ExitCode: container.ExitCode, Error: '', StartedAt: '', FinishedAt: '', ...(container.Health === undefined ? {} : { Health: { Status: container.Health } }) },
      Config: container.Config,
      NetworkSettings: { Networks: container.Networks },
      HostConfig: container.HostConfig,
      Mounts: container.Mounts,
    };
  }

  private frame(text: string): Buffer {
    const body = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  }

  handle(method: string, rawUrl: string, body: Buffer): { status: number; json?: unknown; raw?: Buffer } {
    const url = new URL(rawUrl, 'http://docker');
    const path = url.pathname.replace(/^\/v1\.\d+/, '');
    const parsed = body.length > 0 ? (JSON.parse(body.toString('utf8')) as Record<string, unknown>) : {};
    if (path === '/version') return { status: 200, json: { Version: '28.0.1', ApiVersion: '1.47', Os: 'linux', Arch: 'amd64' } };

    const image = /^\/images\/(.+)\/(json|tag)$/.exec(path);
    if (image !== null) {
      const name = decodeURIComponent(image[1]!);
      const found = this.images.get(name) ?? [...this.images.values()].find((item) => item.Id === name);
      if (found === undefined) return { status: 404, json: { message: `No such image: ${name}` } };
      if (image[2] === 'tag') {
        this.images.set(`${url.searchParams.get('repo')}:${url.searchParams.get('tag')}`, found);
        return { status: 201 };
      }
      return { status: 200, json: found };
    }
    if (path === '/images/create') {
      const reference = `${url.searchParams.get('fromImage')}:${url.searchParams.get('tag')}`;
      this.ops.push(`pull ${reference}`);
      this.images.set(reference, { Id: `sha256:${reference}`, RepoTags: [reference], Size: 1, Created: '', Config: { Labels: { 'org.opencontainers.image.revision': 'e'.repeat(40) } } });
      return { status: 200, raw: Buffer.from(`${JSON.stringify({ status: 'Pull complete' })}\n`) };
    }

    const connect = /^\/networks\/([^/]+)\/connect$/.exec(path);
    if (connect !== null) {
      const container = this.find(String(parsed.Container));
      if (container === undefined) return { status: 404, json: { message: 'No such container' } };
      const aliases = ((parsed.EndpointConfig as { Aliases?: string[] } | undefined)?.Aliases ?? []);
      this.connected.push({ network: decodeURIComponent(connect[1]!), container: container.Name, aliases });
      container.Networks[decodeURIComponent(connect[1]!)] = { IPAddress: '10.0.9.9', Aliases: aliases, NetworkID: 'n-extra' };
      return { status: 200 };
    }

    if (path === '/containers/create') {
      const name = url.searchParams.get('name')!;
      if (this.find(name) !== undefined) return { status: 409, json: { message: `Conflict. The container name "/${name}" is already in use` } };
      this.created.push({ name, spec: parsed });
      const hostConfig = (parsed.HostConfig as ContainerInspect['HostConfig'] | undefined) ?? { Memory: 0, NanoCpus: 0 };
      const endpoints = ((parsed.NetworkingConfig as { EndpointsConfig?: Record<string, { Aliases?: string[] }> } | undefined)?.EndpointsConfig ?? {});
      const record = this.add(name, {
        Running: false,
        Status: 'created',
        Config: { Image: String(parsed.Image), Labels: (parsed.Labels as Record<string, string>) ?? {}, Env: (parsed.Env as string[]) ?? [] },
        HostConfig: hostConfig,
        Networks: Object.fromEntries(Object.entries(endpoints).map(([network, endpoint], index) => [network, { IPAddress: `10.0.0.${20 + index}`, Aliases: endpoint.Aliases ?? [], NetworkID: `n-${network}` }])),
        spec: parsed,
      });
      this.ops.push(`create ${name}`);
      return { status: 201, json: { Id: record.Id } };
    }

    const action = /^\/containers\/([^/]+)(?:\/(start|stop|rename|json|logs))?$/.exec(path);
    if (action !== null) {
      const container = this.find(action[1]!);
      if (container === undefined) return { status: 404, json: { message: 'No such container' } };
      switch (action[2]) {
        case 'start':
          if (container.Running) return { status: 304 };
          this.ops.push(`start ${container.Name}`);
          if (this.dyingOnStart.has(container.Name)) {
            container.Running = false;
            container.Status = 'exited';
            container.ExitCode = 1;
          } else {
            container.Running = true;
            container.Status = 'running';
          }
          return { status: 204 };
        case 'stop':
          this.ops.push(`stop ${container.Name}`);
          container.Running = false;
          container.Status = 'exited';
          return { status: 204 };
        case 'rename': {
          const name = url.searchParams.get('name')!;
          if (this.find(name) !== undefined) return { status: 409, json: { message: `Conflict. The container name "/${name}" is already in use` } };
          this.ops.push(`rename ${container.Name} ${name}`);
          container.Name = name;
          return { status: 204 };
        }
        case 'json':
          return { status: 200, json: this.inspect(container) };
        case 'logs':
          return { status: 200, raw: this.frame(this.logs.get(container.Id) ?? '') };
        case undefined:
          if (method === 'DELETE') {
            this.ops.push(`remove ${container.Name}`);
            this.containers.delete(container.Id);
            return { status: 204 };
          }
      }
    }
    return { status: 404, json: { message: `fake daemon: unhandled ${method} ${path}` } };
  }

  listen(socket: string): Promise<Server> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const result = this.handle(req.method ?? 'GET', req.url ?? '/', Buffer.concat(chunks));
        res.statusCode = result.status;
        if (result.json !== undefined) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(result.json));
        } else if (result.raw !== undefined) {
          res.setHeader('content-type', 'application/octet-stream');
          res.end(result.raw);
        } else {
          res.end();
        }
      });
    });
    return new Promise((resolve) => server.listen(socket, () => resolve(server)));
  }
}

const OLD_IMAGE_ENV = ['PATH=/usr/local/bin:/usr/bin', 'NODE_VERSION=26.0.0', 'NODE_ENV=production', 'PLOY_DATA_DIR=/var/lib/torexploy', 'PLOY_PORT=3000', `PLOY_COMMIT=${'a'.repeat(40)}`, 'PLOY_BUILT_AT=2026-10-01T00:00:00Z'];
const OLD_IMAGE: ImageInspect = {
  Id: 'sha256:' + '1'.repeat(64),
  RepoTags: ['torexploy:latest'],
  Size: 1,
  Created: '',
  Config: {
    Env: OLD_IMAGE_ENV,
    Cmd: ['node', 'packages/server/src/main.ts'],
    Entrypoint: ['/sbin/tini', '--'],
    Labels: { 'org.opencontainers.image.revision': 'a'.repeat(40), 'org.opencontainers.image.source': 'https://github.com/To-Rex/TorexPloy' },
    Healthcheck: { Test: ['CMD-SHELL', 'wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1'], Interval: 30_000_000_000 },
    ExposedPorts: { '3000/tcp': {} },
    WorkingDir: '/app',
    User: '',
  },
};

/** `ploy-control` as `install.sh` starts it, plus a second network and an anonymous volume. */
function seedControl(daemon: FakeDaemon): FakeContainer {
  daemon.images.set('torexploy:latest', OLD_IMAGE);
  return daemon.add('ploy-control', {
    // The hostname below is this container's short id, as Docker sets it.
    Id: 'c00000000001' + '0'.repeat(52),
    Config: {
      Image: 'torexploy:latest',
      Hostname: 'c00000000001',
      Env: [...OLD_IMAGE_ENV, 'PLOY_UPDATE_REPO=acme/ploy', 'PLOY_UPDATE_BRANCH=main'],
      Cmd: ['node', 'packages/server/src/main.ts'],
      Entrypoint: ['/sbin/tini', '--'],
      Labels: { ...OLD_IMAGE.Config.Labels, 'ploy.custom': 'yes' },
      Healthcheck: OLD_IMAGE.Config.Healthcheck,
      ExposedPorts: { '3000/tcp': {} },
      WorkingDir: '/app',
      User: '',
    },
    HostConfig: {
      Memory: 0,
      NanoCpus: 0,
      NetworkMode: 'ploy',
      Binds: ['/var/run/docker.sock:/var/run/docker.sock', '/var/lib/torexploy:/var/lib/torexploy'],
      PortBindings: { '3000/tcp': [{ HostIp: '', HostPort: '2003' }] },
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '5' } },
      SecurityOpt: null,
      Mounts: null,
    },
    Mounts: [
      { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true },
      { Type: 'bind', Source: '/var/lib/torexploy', Destination: '/var/lib/torexploy', RW: true },
      { Type: 'volume', Name: 'f00d' + 'c'.repeat(60), Source: '/var/lib/docker/volumes/f00d/_data', Destination: '/run/torexploy', RW: true },
    ],
    Networks: {
      ploy: { IPAddress: '10.0.0.5', Aliases: ['ploy-control', 'c00000000001'], NetworkID: 'n-ploy' },
      monitoring: { IPAddress: '10.0.1.5', Aliases: ['panel', 'c00000000001'], NetworkID: 'n-monitoring' },
    },
  });
}

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-replace-'));
  const socket = join(dir, 'docker.sock');
  const daemon = new FakeDaemon();
  const server = await daemon.listen(socket);
  const docker = new DockerClient(socket);
  const log: string[] = [];
  return {
    daemon,
    docker,
    log,
    close: async () => {
      docker.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the replacement keeps ports, volumes, restart policy, log driver and networks, and drops what came from the old image', async () => {
  const h = await harness();
  try {
    const control = seedControl(h.daemon);
    await replaceContainer(h.docker, { name: 'ploy-control', image: 'torexploy:new', probe: async () => true, intervalMs: 5, timeoutMs: 1_000, log: (line) => h.log.push(line) });

    assert.equal(h.daemon.created.length, 1);
    const { name, spec } = h.daemon.created[0]!;
    assert.equal(name, 'ploy-control');
    assert.equal(spec.Image, 'torexploy:new');
    const host = spec.HostConfig as Record<string, unknown>;
    assert.deepEqual(host.PortBindings, { '3000/tcp': [{ HostIp: '', HostPort: '2003' }] }, 'published ports are exactly the old ones');
    assert.deepEqual(host.RestartPolicy, { Name: 'unless-stopped', MaximumRetryCount: 0 });
    assert.deepEqual(host.LogConfig, { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '5' } });
    assert.equal(host.NetworkMode, 'ploy');
    assert.deepEqual(host.Binds, ['/var/run/docker.sock:/var/run/docker.sock', '/var/lib/torexploy:/var/lib/torexploy', `f00d${'c'.repeat(60)}:/run/torexploy`], 'the anonymous volume travels by name');

    assert.deepEqual(spec.Env, ['PLOY_UPDATE_REPO=acme/ploy', 'PLOY_UPDATE_BRANCH=main'], 'only operator-set variables; the old build identity stays behind');
    assert.deepEqual(spec.Labels, { 'ploy.custom': 'yes' }, 'image labels come from the new image');
    assert.equal('Cmd' in spec, false, 'the image default command applies');
    assert.equal('Entrypoint' in spec, false);
    assert.equal('Healthcheck' in spec, false);
    assert.equal('Hostname' in spec, false, 'a hostname that was just the container id is not pinned');
    assert.equal('WorkingDir' in spec, false);
    assert.deepEqual(spec.ExposedPorts, { '3000/tcp': {} });
    assert.deepEqual(spec.NetworkingConfig, { EndpointsConfig: { ploy: { Aliases: ['ploy-control'] } } }, 'the primary network keeps its alias, without the old short id');
    assert.deepEqual(h.daemon.connected, [{ network: 'monitoring', container: 'ploy-control', aliases: ['panel'] }], 'extra networks are reconnected with their aliases');

    // Order: the old one is only stopped once the replacement exists, and removed once it is healthy.
    assert.deepEqual(h.daemon.ops, ['rename ploy-control ploy-control-old', 'create ploy-control', 'stop ploy-control-old', 'start ploy-control', 'remove ploy-control-old']);
    assert.equal(h.daemon.containers.has(control.Id), false);
    const remaining = [...h.daemon.containers.values()];
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.Name, 'ploy-control');
    assert.equal(remaining[0]?.Running, true);
    assert.equal(remaining[0]?.Image, 'torexploy:new');
    assert.ok(h.log.some((line) => line.startsWith('Removing ploy-control-old')));
  } finally {
    await h.close();
  }
});

test('a replacement that never answers is rolled back: the old container gets its name and its process back', async () => {
  const h = await harness();
  try {
    const control = seedControl(h.daemon);
    let probes = 0;
    await assert.rejects(
      replaceContainer(h.docker, {
        name: 'ploy-control',
        image: 'torexploy:new',
        probe: async () => {
          probes += 1;
          return false;
        },
        intervalMs: 5,
        timeoutMs: 60,
        log: (line) => h.log.push(line),
      }),
      (error: unknown) => error instanceof ReplaceError && /did not become healthy within/.test(error.message),
    );
    assert.ok(probes >= 2, 'the probe was retried');
    const old = h.daemon.containers.get(control.Id);
    assert.equal(old?.Name, 'ploy-control', 'renamed back');
    assert.equal(old?.Running, true, 'started again');
    assert.equal([...h.daemon.containers.values()].length, 1, 'the failed replacement is gone');
    assert.deepEqual(h.daemon.ops.slice(-3), ['remove ploy-control', 'rename ploy-control-old ploy-control', 'start ploy-control']);
    assert.ok(h.log.some((line) => line.startsWith('Rolling back:')));
  } finally {
    await h.close();
  }
});

test('a replacement that exits is rolled back at once, and a stale -old container from a crashed run is cleared first', async () => {
  const h = await harness();
  try {
    seedControl(h.daemon);
    const stale = h.daemon.add('ploy-control-old', { Running: false, Status: 'exited', Config: { Image: 'torexploy:older', Labels: {}, Env: [] }, HostConfig: { Memory: 0, NanoCpus: 0 } });
    h.daemon.dyingOnStart.add('ploy-control');
    const started = Date.now();
    await assert.rejects(
      replaceContainer(h.docker, { name: 'ploy-control', image: 'torexploy:new', probe: async () => true, intervalMs: 5, timeoutMs: 5_000, log: (line) => h.log.push(line) }),
      (error: unknown) => error instanceof ReplaceError && /exited with code 1/.test(error.message),
    );
    assert.ok(Date.now() - started < 2_000, 'an exited container is not polled until the timeout');
    assert.equal(h.daemon.ops[0], 'remove ploy-control-old');
    assert.equal(h.daemon.containers.has(stale.Id), false);
    const [remaining] = [...h.daemon.containers.values()];
    assert.equal(remaining?.Name, 'ploy-control');
    assert.equal(remaining?.Image, 'torexploy:latest', 'the old version is back');
  } finally {
    await h.close();
  }
});

test('the updater container: launched from the running image with the socket, the network and the target; its exit is read back', async () => {
  const h = await harness();
  try {
    const control = seedControl(h.daemon);
    const self: SelfContainer = { id: control.Id, name: 'ploy-control', image: 'torexploy:latest', network: 'ploy', inspect: h.daemon.inspect(control) };
    const config = { updates: { enabled: true, repository: 'To-Rex/TorexPloy', branch: 'main', image: null, container: 'ploy-control', intervalMs: 1 } } as AppConfig;

    assert.deepEqual(await updaterState(h.docker), { state: 'idle', error: null });

    // A failed run from earlier: its last lines are the error, and it is replaced by the next launch.
    const failed = h.daemon.add(UPDATER_CONTAINER, { Running: false, Status: 'exited', ExitCode: 1, Config: { Image: 'torexploy:latest', Labels: {}, Env: [] }, HostConfig: { Memory: 0, NanoCpus: 0 } });
    h.daemon.logs.set(failed.Id, Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n') + '\n');
    const failure = await updaterState(h.docker);
    assert.equal(failure.state, 'failed');
    assert.equal(failure.error?.split('\n').length, 15);
    assert.ok(failure.error?.endsWith('line 20'));

    const id = await launchUpdater(h.docker, self, config, 'b'.repeat(40));
    assert.equal(h.daemon.containers.has(failed.Id), false, 'the failed run was removed');
    const launched = h.daemon.created.find((item) => item.name === UPDATER_CONTAINER)!;
    assert.equal(launched.spec.Image, 'torexploy:latest');
    assert.deepEqual(launched.spec.Cmd, ['node', 'packages/server/src/updater.ts']);
    assert.deepEqual(launched.spec.Env, [
      'PLOY_UPDATER_TARGET=ploy-control',
      'PLOY_UPDATER_MODE=source',
      'PLOY_UPDATER_REPO=To-Rex/TorexPloy',
      'PLOY_UPDATER_BRANCH=main',
      `PLOY_UPDATER_COMMIT=${'b'.repeat(40)}`,
      'PLOY_UPDATER_IMAGE=',
      'PLOY_UPDATER_TAG=torexploy:latest',
      'DOCKER_HOST=unix:///var/run/docker.sock',
    ]);
    assert.deepEqual(launched.spec.Labels, { 'ploy.managed': 'true', 'ploy.role': 'updater' });
    const host = launched.spec.HostConfig as Record<string, unknown>;
    assert.deepEqual(host.Binds, ['/var/run/docker.sock:/var/run/docker.sock']);
    assert.equal(host.NetworkMode, 'ploy');
    assert.equal(host.AutoRemove, false);
    assert.deepEqual(launched.spec.NetworkingConfig, { EndpointsConfig: { ploy: {} } });
    assert.equal(h.daemon.find(id)?.Running, true);
    assert.deepEqual(await updaterState(h.docker), { state: 'updating', error: null });

    // Image mode names the prebuilt image and derives the tag from the running reference, digest dropped.
    h.daemon.containers.delete(id);
    const imageSelf = { ...self, image: 'ghcr.io/to-rex/torexploy:main@sha256:' + 'd'.repeat(64) };
    await launchUpdater(h.docker, imageSelf, { updates: { ...config.updates, image: 'ghcr.io/to-rex/torexploy:main' } } as AppConfig, 'b'.repeat(40));
    const env = h.daemon.created.at(-1)!.spec.Env as string[];
    assert.ok(env.includes('PLOY_UPDATER_MODE=image'));
    assert.ok(env.includes('PLOY_UPDATER_IMAGE=ghcr.io/to-rex/torexploy:main'));
    assert.ok(env.includes('PLOY_UPDATER_TAG=ghcr.io/to-rex/torexploy:main'));

    // A run that finished well is removed lazily when its state is read.
    const done = h.daemon.find(UPDATER_CONTAINER)!;
    done.Running = false;
    done.Status = 'exited';
    done.ExitCode = 0;
    assert.deepEqual(await updaterState(h.docker), { state: 'idle', error: null });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.daemon.find(UPDATER_CONTAINER), undefined);
  } finally {
    await h.close();
  }
});
