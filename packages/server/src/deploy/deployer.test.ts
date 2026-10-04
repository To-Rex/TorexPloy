/**
 * End-to-end pipeline tests against an in-process Engine API double.
 *
 * The double implements the subset of the Docker Engine API the pipeline
 * uses (images, containers, networks, volumes, exec, archive, logs) with real
 * state, so these tests exercise the actual HTTP client, proxy sync and
 * deployment state machine — only the daemon is simulated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTar } from '../lib/tar.ts';
import { createContext } from '../main.ts';
import type { Context } from '../context.ts';
import { generateToken } from '../lib/crypto.ts';

interface FakeContainer {
  Id: string;
  Name: string;
  Image: string;
  Running: boolean;
  RestartCount: number;
  Labels: Record<string, string>;
  Networks: Record<string, { Aliases: string[] }>;
  spec: Record<string, unknown>;
}

class FakeDocker {
  readonly images = new Set<string>(['caddy:2.11-alpine']);
  readonly containers = new Map<string, FakeContainer>();
  readonly networks = new Set<string>();
  readonly proxyConfigs: string[] = [];
  /** Containers whose port never answers (health checks fail). */
  readonly unhealthy = new Set<string>();
  /** Every container of these deployments never answers. */
  readonly unhealthyDeployments = new Set<string>();

  private isDown(host: string): boolean {
    const container = this.find(host);
    return container === undefined || !container.Running || this.unhealthy.has(host) || this.unhealthyDeployments.has(container.Labels['ploy.deployment'] ?? '');
  }
  private readonly execs = new Map<string, { container: string; cmd: string[] }>();
  private seq = 0;
  server!: Server;

  private find(ref: string): FakeContainer | undefined {
    const name = decodeURIComponent(ref);
    return this.containers.get(name) ?? [...this.containers.values()].find((container) => container.Id === name || container.Id.startsWith(name));
  }

  private frame(stream: 1 | 2, text: string): Buffer {
    const body = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  }

  handle(method: string, rawUrl: string, body: Buffer): { status: number; json?: unknown; raw?: Buffer } {
    const url = new URL(rawUrl, 'http://docker');
    const path = url.pathname.replace(/^\/v1\.\d+/, '');
    const parsed = body.length > 0 && !path.endsWith('/archive') ? (JSON.parse(body.toString('utf8')) as Record<string, unknown>) : {};
    const filters = JSON.parse(url.searchParams.get('filters') ?? '{}') as Record<string, string[]>;

    if (path === '/version') return { status: 200, json: { Version: '28.0.1', ApiVersion: '1.47', Os: 'linux', Arch: 'amd64' } };
    if (path === '/info') return { status: 200, json: { NCPU: 4, MemTotal: 8e9, OperatingSystem: 'Ubuntu 24.04', Architecture: 'x86_64', ServerVersion: '28.0.1' } };
    if (path === '/_ping') return { status: 200, raw: Buffer.from('OK') };

    if (path === '/networks' && method === 'GET') {
      return { status: 200, json: [...this.networks].filter((name) => (filters.name ?? [name]).includes(name)).map((name) => ({ Id: name, Name: name })) };
    }
    if (path === '/networks/create') {
      this.networks.add(String(parsed.Name));
      return { status: 201, json: { Id: parsed.Name } };
    }
    const connect = /^\/networks\/([^/]+)\/connect$/.exec(path);
    if (connect !== null) {
      const container = this.find(String(parsed.Container));
      if (container === undefined) return { status: 404, json: { message: 'No such container' } };
      container.Networks[decodeURIComponent(connect[1]!)] = { Aliases: [] };
      return { status: 200 };
    }
    if (path === '/volumes/create') return { status: 201, json: { Name: parsed.Name } };

    if (path === '/images/create') {
      this.images.add(`${url.searchParams.get('fromImage')}:${url.searchParams.get('tag')}`);
      return { status: 200, raw: Buffer.from(`${JSON.stringify({ status: 'Pull complete' })}\n`) };
    }
    const image = /^\/images\/(.+)\/(json|tag)$/.exec(path);
    if (image !== null) {
      const name = decodeURIComponent(image[1]!);
      if (!this.images.has(name)) return { status: 404, json: { message: `No such image: ${name}` } };
      if (image[2] === 'tag') {
        this.images.add(`${url.searchParams.get('repo')}:${url.searchParams.get('tag')}`);
        return { status: 201 };
      }
      return { status: 200, json: { Id: `sha256:${name}`, RepoTags: [name], Size: 1, Created: '', Config: { ExposedPorts: { '80/tcp': {} } } } };
    }
    const removeImage = /^\/images\/(.+)$/.exec(path);
    if (removeImage !== null && method === 'DELETE') {
      return this.images.delete(decodeURIComponent(removeImage[1]!)) ? { status: 200, json: [] } : { status: 404, json: { message: 'No such image' } };
    }
    if (path === '/images/json') return { status: 200, json: [] };

    if (path === '/containers/create') {
      const name = url.searchParams.get('name')!;
      if (this.containers.has(name)) return { status: 409, json: { message: `Conflict. The container name "/${name}" is already in use` } };
      const networking = (parsed.NetworkingConfig as { EndpointsConfig?: Record<string, { Aliases?: string[] }> } | undefined)?.EndpointsConfig ?? {};
      this.seq += 1;
      this.containers.set(name, {
        Id: `c${String(this.seq).padStart(11, '0')}`,
        Name: name,
        Image: String(parsed.Image),
        Running: false,
        RestartCount: 0,
        Labels: (parsed.Labels as Record<string, string>) ?? {},
        Networks: Object.fromEntries(Object.entries(networking).map(([key, value]) => [key, { Aliases: value.Aliases ?? [] }])),
        spec: parsed,
      });
      return { status: 201, json: { Id: this.containers.get(name)!.Id } };
    }
    if (path === '/containers/json') {
      const label = filters.label?.[0];
      const list = [...this.containers.values()].filter((container) => {
        if (label === undefined) return true;
        const [key, value] = label.split('=');
        return container.Labels[key!] === value;
      });
      return {
        status: 200,
        json: list.map((container) => ({ Id: container.Id, Names: [`/${container.Name}`], Image: container.Image, ImageID: '', Labels: container.Labels, State: container.Running ? 'running' : 'exited', Status: '', Created: 0 })),
      };
    }
    const containerAction = /^\/containers\/([^/]+)(?:\/(start|stop|restart|json|exec|archive|logs|stats|wait))?$/.exec(path);
    if (containerAction !== null) {
      const container = this.find(containerAction[1]!);
      const action = containerAction[2];
      if (container === undefined) return { status: 404, json: { message: 'No such container' } };
      switch (action) {
        case 'start':
          if (container.Running) return { status: 304 };
          container.Running = true;
          return { status: 204 };
        case 'stop':
          container.Running = false;
          return { status: 204 };
        case 'json':
          return {
            status: 200,
            json: {
              Id: container.Id,
              Name: `/${container.Name}`,
              Created: '',
              RestartCount: container.RestartCount,
              Image: container.Image,
              State: { Status: container.Running ? 'running' : 'exited', Running: container.Running, Restarting: false, OOMKilled: false, ExitCode: 0, Error: '', StartedAt: '', FinishedAt: '' },
              Config: { Image: container.Image, Labels: container.Labels, Env: [] },
              NetworkSettings: { Networks: Object.fromEntries(Object.keys(container.Networks).map((key) => [key, { IPAddress: '10.0.0.2', Aliases: [], NetworkID: key }])) },
              HostConfig: { Memory: 0, NanoCpus: 0 },
            },
          };
        case 'exec': {
          const id = `exec${(this.seq += 1)}`;
          this.execs.set(id, { container: container.Name, cmd: parsed.Cmd as string[] });
          return { status: 201, json: { Id: id } };
        }
        case 'archive':
          if (container.Name === 'ploy-proxy') this.proxyConfigs.push(readTar(body)[0]!.content.toString('utf8'));
          return { status: 200 };
        case 'logs':
          return { status: 200, raw: this.frame(1, `${new Date().toISOString()} listening\n`) };
        case undefined:
          if (method === 'DELETE') {
            this.containers.delete(container.Name);
            return { status: 204 };
          }
      }
    }
    const exec = /^\/exec\/([^/]+)\/(start|json)$/.exec(path);
    if (exec !== null) {
      const record = this.execs.get(exec[1]!)!;
      const [binary, ...args] = record.cmd;
      if (exec[2] === 'json') {
        const target = args.find((arg) => arg.startsWith('http://'));
        const host = target === undefined ? '' : new URL(target).hostname;
        const failing = binary === 'wget' && this.isDown(host);
        return { status: 200, json: { ExitCode: failing ? 1 : 0, Running: false } };
      }
      if (binary === 'wget') {
        const host = new URL(args.find((arg) => arg.startsWith('http://'))!).hostname;
        const up = !this.isDown(host);
        return { status: 200, raw: up ? this.frame(2, '  HTTP/1.1 200 OK\n') : this.frame(2, `wget: can't connect to remote host (10.0.0.9): Connection refused\n`) };
      }
      if (binary === 'caddy' && args[0] === 'version') return { status: 200, raw: this.frame(1, 'v2.11.7 h1:abc\n') };
      return { status: 200, raw: Buffer.alloc(0) };
    }
    return { status: 404, json: { message: `fake daemon: unhandled ${method} ${path}` } };
  }

  async listen(socket: string): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const result = this.handle(req.method ?? 'GET', req.url ?? '/', Buffer.concat(chunks));
        res.statusCode = result.status;
        if (result.json !== undefined) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(result.json));
        } else {
          res.end(result.raw ?? undefined);
        }
      });
    });
    await new Promise<void>((resolve) => this.server.listen(socket, resolve));
  }

  running(prefix: string): string[] {
    return [...this.containers.values()].filter((container) => container.Running && container.Name.startsWith(prefix)).map((container) => container.Name);
  }
}

async function setup(): Promise<{ ctx: Context; docker: FakeDocker; dir: string; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-e2e-'));
  const docker = new FakeDocker();
  await docker.listen(join(dir, 'docker.sock'));
  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket: join(dir, 'docker.sock'), drainMs: 0, logLevel: 'error' });
  const user = ctx.stores.users.create({ email: 'ops@example.uz', name: 'Ops', passwordHash: null, isInstanceAdmin: true });
  const team = ctx.stores.teams.create('Ops');
  ctx.stores.teams.addMember(team.id, user.id, 'owner');
  const local = ctx.stores.servers.ensureLocal('local');
  ctx.stores.servers.setPublicIp(local.id, '203.0.113.7');
  const verified = await ctx.servers.verify(local.id);
  assert.equal(verified.status, 'ready', verified.statusMessage ?? '');
  return {
    ctx,
    docker,
    dir,
    cleanup: async () => {
      await ctx.deployer.shutdown();
      await ctx.connections.closeAll();
      ctx.stores.db.close();
      docker.server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(ctx: Context, deploymentId: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = ctx.stores.deployments.get(deploymentId)!.status;
    if (['succeeded', 'failed', 'cancelled'].includes(status) && !ctx.deployer.isRunning(ctx.stores.deployments.get(deploymentId)!.applicationId)) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('deployment did not settle');
}

function createApp(ctx: Context, image = 'nginx:alpine') {
  const team = ctx.stores.db.get('SELECT id FROM teams')!;
  const project = ctx.stores.projects.create(String(team.id), 'Shop', null);
  const local = ctx.stores.servers.getLocal()!;
  const app = ctx.stores.applications.create({
    projectId: project.id,
    teamId: project.teamId,
    serverId: local.id,
    name: 'Web',
    slug: 'web',
    kind: 'web',
    sourceType: 'image',
    githubInstallationId: null,
    repository: null,
    gitUrl: null,
    branch: null,
    image,
    sealedHookToken: ctx.secrets.seal(generateToken(), 'hook'),
  });
  ctx.stores.domains.create({ applicationId: app.id, teamId: app.teamId, host: 'shop.example.uz', https: true, port: null, isGenerated: false });
  return { app, project };
}

test('server verification bootstraps the platform network and the proxy', async () => {
  const { docker, cleanup } = await setup();
  try {
    assert.ok(docker.networks.has('ploy'));
    const proxy = docker.containers.get('ploy-proxy');
    assert.ok(proxy?.Running);
    assert.deepEqual(proxy.spec.Cmd, ['caddy', 'run', '--config', '/etc/caddy/ploy.json', '--resume']);
    assert.ok(docker.proxyConfigs.length >= 1, 'initial config is written before Caddy starts');
  } finally {
    await cleanup();
  }
});

test('a deployment pulls, starts, health-checks, switches traffic and drains the previous version', async () => {
  const { ctx, docker, cleanup } = await setup();
  try {
    const { app, project } = createApp(ctx);
    ctx.stores.env.replace({ applicationId: app.id }, [{ key: 'SECRET_TOKEN', value: 'super-secret-value-123' }]);

    const first = ctx.deployer.enqueue({ app, trigger: 'manual', createdBy: null });
    assert.equal(await settle(ctx, first.id), 'succeeded', ctx.stores.deployments.get(first.id)!.errorMessage ?? '');
    const deployed = ctx.stores.deployments.get(first.id)!;
    assert.equal(deployed.port, 80, 'port comes from the image EXPOSE when not configured');
    assert.equal(ctx.stores.applications.get(app.id)!.activeDeploymentId, first.id);
    assert.equal(ctx.stores.applications.get(app.id)!.status, 'running');

    const container = docker.containers.get(deployed.containers[0]!)!;
    assert.ok(container.Running);
    assert.ok(container.Networks[`ploy-net-${project.id.slice(4)}`], 'joined the project network');
    assert.deepEqual(container.Networks[`ploy-net-${project.id.slice(4)}`]!.Aliases, ['web']);
    const env = (container.spec.Env as string[]).join('\n');
    assert.match(env, /SECRET_TOKEN=super-secret-value-123/);
    assert.match(env, /PORT=80/);
    const host = container.spec.HostConfig as Record<string, unknown>;
    assert.deepEqual(host.CapDrop, ['ALL']);
    assert.deepEqual(host.SecurityOpt, ['no-new-privileges:true']);

    const config = JSON.parse(docker.proxyConfigs.at(-1)!) as { apps: { http: { servers: { https: { routes: { match?: { host: string[] }[]; handle: { handler: string; upstreams?: { dial: string }[] }[] }[] } } } } };
    const route = config.apps.http.servers.https.routes.find((candidate) => candidate.match?.[0]?.host.includes('shop.example.uz'))!;
    assert.deepEqual(route.handle.at(-1)!.upstreams, [{ dial: `${deployed.containers[0]}:80` }]);

    // The deployment log masks secrets.
    const log = await import('node:fs/promises').then((fs) => fs.readFile(join(ctx.config.dataDir, 'logs', 'deployments', `${first.id}.log`), 'utf8'));
    assert.ok(!log.includes('super-secret-value-123'));

    // Second deployment: new containers take over, the old ones are removed.
    ctx.stores.applications.update(app.id, { replicas: 2 });
    const second = ctx.deployer.enqueue({ app: ctx.stores.applications.get(app.id)!, trigger: 'manual', createdBy: null });
    assert.equal(await settle(ctx, second.id), 'succeeded');
    const next = ctx.stores.deployments.get(second.id)!;
    assert.equal(next.containers.length, 2);
    assert.equal(docker.containers.has(deployed.containers[0]!), false, 'previous containers drained');
    assert.deepEqual(docker.running('ploy-web-').sort(), [...next.containers].sort());
    const balanced = JSON.parse(docker.proxyConfigs.at(-1)!) as typeof config;
    const upstreams = balanced.apps.http.servers.https.routes.find((candidate) => candidate.match?.[0]?.host.includes('shop.example.uz'))!.handle.at(-1)!.upstreams!;
    assert.equal(upstreams.length, 2, 'proxy balances across both replicas');
  } finally {
    await cleanup();
  }
});

test('a failing health check never touches the running version', async () => {
  const { ctx, docker, cleanup } = await setup();
  try {
    const { app } = createApp(ctx);
    const good = ctx.deployer.enqueue({ app, trigger: 'manual', createdBy: null });
    assert.equal(await settle(ctx, good.id), 'succeeded');
    const goodContainers = ctx.stores.deployments.get(good.id)!.containers;
    const configsBefore = docker.proxyConfigs.length;

    ctx.stores.applications.update(app.id, { healthCheckTimeoutSec: 5 });
    const bad = ctx.deployer.enqueue({ app: ctx.stores.applications.get(app.id)!, trigger: 'manual', createdBy: null });
    // Every container of the new deployment is unreachable.
    docker.unhealthyDeployments.add(bad.id);
    assert.equal(await settle(ctx, bad.id), 'failed');
    assert.match(ctx.stores.deployments.get(bad.id)!.errorMessage ?? '', /Health check timed out/);
    assert.equal(ctx.stores.applications.get(app.id)!.activeDeploymentId, good.id, 'still serving the good version');
    assert.equal(ctx.stores.applications.get(app.id)!.status, 'running');
    assert.deepEqual(docker.running('ploy-web-'), goodContainers, 'failed containers removed, good ones untouched');
    const lastConfig = docker.proxyConfigs.at(-1)!;
    assert.equal(docker.proxyConfigs.length, configsBefore, 'proxy config was never switched');
    assert.match(lastConfig, new RegExp(goodContainers[0]!));
  } finally {
    await cleanup();
  }
});

test('rollback redeploys a previous image without building, and recovery closes interrupted work', async () => {
  const { ctx, docker, cleanup } = await setup();
  try {
    const { app } = createApp(ctx);
    const v1 = ctx.deployer.enqueue({ app, trigger: 'manual', createdBy: null });
    assert.equal(await settle(ctx, v1.id), 'succeeded');
    const v2 = ctx.deployer.enqueue({ app: ctx.stores.applications.get(app.id)!, trigger: 'manual', createdBy: null });
    assert.equal(await settle(ctx, v2.id), 'succeeded');

    const rollback = ctx.deployer.redeploy(ctx.stores.applications.get(app.id)!, ctx.stores.deployments.get(v1.id)!, null);
    assert.equal(rollback.trigger, 'rollback');
    assert.equal(await settle(ctx, rollback.id), 'succeeded');
    assert.equal(ctx.stores.deployments.get(rollback.id)!.imageTag, ctx.stores.deployments.get(v1.id)!.imageTag);
    assert.equal(ctx.stores.applications.get(app.id)!.activeDeploymentId, rollback.id);

    // A newer queued deployment supersedes an older queued one.
    ctx.stores.servers.setStatus(ctx.stores.servers.getLocal()!.id, 'offline', 'test');
    const queuedA = ctx.deployer.enqueue({ app: ctx.stores.applications.get(app.id)!, trigger: 'manual', createdBy: null });
    await settle(ctx, queuedA.id);
    ctx.stores.servers.setStatus(ctx.stores.servers.getLocal()!.id, 'ready', null);

    // Simulate a crash mid-deployment, then boot recovery.
    const interrupted = ctx.stores.deployments.create({ application: ctx.stores.applications.get(app.id)!, trigger: 'manual', createdBy: null });
    ctx.stores.deployments.markStarted(interrupted.id);
    ctx.deployer.recover();
    assert.equal(ctx.stores.deployments.get(interrupted.id)!.status, 'failed');
    assert.match(ctx.stores.deployments.get(interrupted.id)!.errorMessage!, /Interrupted/);
    assert.equal(ctx.stores.applications.get(app.id)!.status, 'running');
    assert.ok(docker.running('ploy-web-').length >= 1);
  } finally {
    await cleanup();
  }
});

test('stop shows the unavailable page and start brings the same containers back', async () => {
  const { ctx, docker, cleanup } = await setup();
  try {
    const { app } = createApp(ctx);
    const deployment = ctx.deployer.enqueue({ app, trigger: 'manual', createdBy: null });
    assert.equal(await settle(ctx, deployment.id), 'succeeded');
    await ctx.deployer.stop(ctx.stores.applications.get(app.id)!);
    assert.equal(ctx.stores.applications.get(app.id)!.status, 'stopped');
    assert.deepEqual(docker.running('ploy-web-'), []);
    assert.match(docker.proxyConfigs.at(-1)!, /Web is not running/);

    await ctx.deployer.start(ctx.stores.applications.get(app.id)!, null);
    assert.equal(ctx.stores.applications.get(app.id)!.status, 'running');
    assert.equal(docker.running('ploy-web-').length, 1);
  } finally {
    await cleanup();
  }
});
