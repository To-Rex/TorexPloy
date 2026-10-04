/**
 * The compose engine end to end, without Docker: a fake `docker` CLI on PATH
 * records how it is invoked and "brings the stack up" by creating containers
 * through the Engine API double, exactly where the real plugin would.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { AppError } from '../lib/errors.ts';
import { generateToken } from '../lib/crypto.ts';
import { LogWriter, logPath } from '../deploy/logs.ts';
import { createContext } from '../main.ts';
import { composeProject } from './engine.ts';

interface FakeContainer {
  Id: string;
  Name: string;
  Labels: Record<string, string>;
  Running: boolean;
  ExitCode: number;
}

function fakeDaemon(socket: string): Promise<{ server: Server; containers: Map<string, FakeContainer> }> {
  const containers = new Map<string, FakeContainer>();
  // The proxy already runs on this server.
  containers.set('ploy-proxy', { Id: 'proxy', Name: 'ploy-proxy', Labels: { 'ploy.managed': 'true', 'ploy.role': 'proxy' }, Running: true, ExitCode: 0 });
  let seq = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://docker');
      const path = url.pathname.replace(/^\/v1\.\d+/, '');
      const json = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
      const find = (ref: string) => [...containers.values()].find((container) => container.Id === ref || container.Name === decodeURIComponent(ref));
      if (path === '/version') return json(200, { Version: '28.0.1', ApiVersion: '1.47', Os: 'linux', Arch: 'amd64' });
      if (path === '/networks' && req.method === 'GET') return json(200, []);
      if (path === '/networks/create') return json(201, { Id: 'net' });
      if (/^\/networks\/[^/]+\/connect$/.test(path)) return json(200, {});
      if (path === '/containers/create') {
        const name = url.searchParams.get('name')!;
        containers.set(name, { Id: `c${(seq += 1)}`, Name: name, Labels: (body.Labels as Record<string, string>) ?? {}, Running: false, ExitCode: 0 });
        return json(201, { Id: containers.get(name)!.Id });
      }
      if (path === '/containers/json') {
        const label = (JSON.parse(url.searchParams.get('filters') ?? '{}') as { label?: string[] }).label?.[0];
        const [key, value] = (label ?? '=').split('=');
        const list = [...containers.values()].filter((container) => label === undefined || container.Labels[key!] === value);
        return json(200, list.map((container) => ({ Id: container.Id, Names: [`/${container.Name}`], Image: 'x', ImageID: '', Labels: container.Labels, State: container.Running ? 'running' : 'exited', Status: '', Created: 0 })));
      }
      const action = /^\/containers\/([^/]+)(?:\/(start|stop|restart|json))?$/.exec(path);
      if (action !== null) {
        const container = find(action[1]!);
        if (container === undefined) return json(404, { message: 'No such container' });
        if (action[2] === 'start') container.Running = true;
        if (action[2] === 'stop') container.Running = false;
        if (action[2] === undefined && req.method === 'DELETE') containers.delete(container.Name);
        if (action[2] === 'json') {
          return json(200, {
            Id: container.Id,
            Name: `/${container.Name}`,
            Created: '',
            RestartCount: 0,
            Image: 'x',
            State: { Status: container.Running ? 'running' : 'exited', Running: container.Running, Restarting: false, OOMKilled: false, ExitCode: container.ExitCode, Error: '', StartedAt: new Date().toISOString(), FinishedAt: '' },
            Config: { Image: 'x', Labels: container.Labels, Env: [] },
            NetworkSettings: { Networks: {} },
            HostConfig: { Memory: 0, NanoCpus: 0 },
          });
        }
        res.statusCode = 204;
        return res.end();
      }
      if (path === '/images/json' || path === '/volumes') return json(200, path === '/volumes' ? { Volumes: [] } : []);
      return json(404, { message: `fake daemon: unhandled ${req.method} ${path}` });
    });
  });
  return new Promise((resolve) => server.listen(socket, () => resolve({ server, containers })));
}

/** A `docker` executable that plays `docker compose up` against the daemon in DOCKER_HOST. */
function fakeCli(bin: string, record: string): void {
  const yaml = import.meta.resolve('yaml');
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
const { parse } = await import(${JSON.stringify(yaml)});
const args = process.argv.slice(2);
const readConfig = () => { try { return JSON.parse(readFileSync(process.env.DOCKER_CONFIG + '/config.json', 'utf8')); } catch { return null; } };
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, env: { DOCKER_HOST: process.env.DOCKER_HOST, GREETING: process.env.GREETING, PLOY_APP: process.env.PLOY_APP, COMPOSE_ANSI: process.env.COMPOSE_ANSI, DOCKER_CONFIG: process.env.DOCKER_CONFIG }, config: readConfig() }) + '\\n');
if (args[0] !== 'compose' || !args.includes('up')) process.exit(0);
const project = args[args.indexOf('--project-name') + 1];
const file = parse(readFileSync(args[args.indexOf('--file') + 1], 'utf8'));
const socketPath = process.env.DOCKER_HOST.replace('unix://', '');
const call = (method, path, body) => new Promise((resolve, reject) => {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const req = request({ socketPath, method, path, headers: { host: 'docker', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, (res) => { res.resume(); res.on('end', resolve); });
  req.on('error', reject);
  req.end(payload);
});
for (const [service, spec] of Object.entries(file.services)) {
  const name = project + '-' + service + '-1';
  await call('POST', '/containers/create?name=' + name, { Labels: { ...spec.labels, 'com.docker.compose.project': project, 'com.docker.compose.service': service } });
  await call('POST', '/containers/' + name + '/start');
  console.log(' Container ' + name + '  Started');
}
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
}

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-compose-'));
  const socket = join(dir, 'docker.sock');
  const { server, containers } = await fakeDaemon(socket);
  const bin = join(dir, 'bin');
  const record = join(dir, 'cli.jsonl');
  (await import('node:fs')).mkdirSync(bin);
  fakeCli(bin, record);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket: socket, logLevel: 'error' });
  const { stores } = ctx;
  const team = stores.teams.create('Ops');
  const local = stores.servers.ensureLocal('local');
  const project = stores.projects.create(team.id, 'Shop', null);
  const create = (content: string) =>
    stores.applications.create({
      projectId: project.id,
      teamId: team.id,
      serverId: local.id,
      name: 'Shop',
      slug: 'shop',
      kind: 'compose',
      sourceType: 'raw',
      githubInstallationId: null,
      repository: null,
      gitUrl: null,
      branch: null,
      image: null,
      composeFile: content,
      sealedHookToken: ctx.secrets.seal(generateToken(), 'hook'),
    });
  const deploy = async (appId: string) => {
    const app = stores.applications.get(appId)!;
    stores.applications.update(app.id, { healthCheckTimeoutSec: 30 });
    const deployment = stores.deployments.create({ application: app, trigger: 'manual', createdBy: null });
    const log = await LogWriter.open(logPath(ctx.config.dataDir, 'deployments', deployment.id), deployment.id, ctx.bus);
    try {
      return await ctx.compose.deploy({ app: stores.applications.get(app.id)!, deployment, docker: await ctx.connections.docker(local.id), log, signal: new AbortController().signal });
    } finally {
      await log.close();
    }
  };
  return {
    ctx,
    containers,
    create,
    deploy,
    calls: () =>
      existsSync(record)
        ? readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string>; config: { auths?: Record<string, { auth: string }> } | null })
        : [],
    close: async () => {
      process.env.PATH = previousPath;
      await ctx.connections.closeAll();
      stores.db.close();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const STACK = `
services:
  web:
    image: nginx:alpine
    environment:
      GREETING: \${GREETING}
  worker:
    image: busybox
    command: ["sleep", "infinity"]
`;

test('a stored compose file is rewritten, brought up with app variables, and routed by service alias', async () => {
  const h = await harness();
  try {
    const { stores } = h.ctx;
    const app = h.create(STACK);
    stores.env.replace({ applicationId: app.id }, [{ key: 'GREETING', value: 'salom' }]);
    const result = await h.deploy(app.id);
    const project = composeProject(app);

    const up = h.calls().find((call) => call.args.includes('up'))!;
    const codeDir = join(h.ctx.compose.appDir(app), 'code');
    assert.deepEqual(up.args, ['compose', '--project-name', project, '--project-directory', codeDir, '--file', join(codeDir, '.torexploy-compose.yml'), 'up', '--detach', '--build', '--remove-orphans']);
    assert.match(up.env.DOCKER_HOST!, /^unix:\/\/.*docker\.sock$/);
    assert.equal(up.env.GREETING, 'salom', 'app variables reach ${...} interpolation as the CLI environment');
    assert.equal(up.env.PLOY_APP, 'shop');
    assert.equal(up.env.COMPOSE_ANSI, 'never');

    const written = parse(readFileSync(join(codeDir, '.torexploy-compose.yml'), 'utf8')) as { services: Record<string, { networks: Record<string, unknown>; labels: Record<string, string> }> };
    assert.deepEqual(written.services.web!.networks.torexploy_project, { aliases: ['shop-web'] });
    assert.equal(written.services.web!.labels['ploy.app'], app.id);
    assert.equal(written.services.web!.labels['ploy.role'], 'compose');

    assert.deepEqual(result.containers.sort(), [`${project}-web-1`, `${project}-worker-1`]);
    assert.deepEqual((await h.ctx.compose.containers(app)).map((container) => [container.service, container.state]), [
      ['web', 'running'],
      ['worker', 'running'],
    ]);

    // Routing goes to the service alias on the project network, with the domain's port.
    stores.deployments.setContainers(stores.deployments.latestForApplication(app.id)!.id, result.containers, null);
    stores.applications.setActiveDeployment(app.id, stores.deployments.latestForApplication(app.id)!.id);
    stores.applications.setStatus(app.id, 'running');
    stores.domains.create({ applicationId: app.id, teamId: app.teamId, host: 'shop.example.uz', https: true, port: 8080, isGenerated: false, serviceName: 'web' });
    stores.domains.create({ applicationId: app.id, teamId: app.teamId, host: 'www.shop.example.uz', https: true, port: null, isGenerated: false, redirectTo: 'https://shop.example.uz' });
    const { routes } = h.ctx.proxy.desiredRoutes(app.serverId);
    assert.deepEqual(routes.find((route) => route.host === 'shop.example.uz')!.upstreams, ['shop-web:8080']);
    assert.equal(routes.find((route) => route.host === 'www.shop.example.uz')!.redirectTo, 'https://shop.example.uz');

    // Lifecycle through the Engine API, by compose labels.
    await h.ctx.compose.stop(stores.applications.get(app.id)!);
    assert.ok([...h.containers.values()].filter((container) => container.Name.startsWith(project)).every((container) => !container.Running));
    assert.equal(await h.ctx.compose.start(stores.applications.get(app.id)!), true);
    await h.ctx.compose.destroy(stores.applications.get(app.id)!, true);
    assert.equal([...h.containers.values()].filter((container) => container.Name.startsWith(project)).length, 0);
    assert.ok(!existsSync(h.ctx.compose.appDir(app)), 'removing data also removes the project directory');
  } finally {
    await h.close();
  }
});

test('host-reaching features need an administrator grant before anything runs', async () => {
  const h = await harness();
  try {
    const app = h.create(`
services:
  agent:
    image: portainer/agent
    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
`);
    await assert.rejects(h.deploy(app.id), (error: unknown) => error instanceof AppError && error.params?.reason === 'compose_host_access' && /docker\.sock/.test(error.message));
    assert.equal(h.calls().length, 0, 'the CLI was never invoked');

    h.ctx.stores.applications.setHostAccess(app.id, true);
    const result = await h.deploy(app.id);
    assert.equal(result.containers.length, 1);
  } finally {
    await h.close();
  }
});

test('a service that exits with an error fails the deployment with its reason', async () => {
  const h = await harness();
  try {
    const app = h.create(STACK);
    const project = composeProject(app);
    // Make the worker die right after it starts, like a crashing process.
    const original = h.containers.set.bind(h.containers);
    h.containers.set = (key, value) => {
      if (key === `${project}-worker-1`) {
        const proxy = new Proxy(value, {
          set(target, prop, next) {
            if (prop === 'Running' && next === true) {
              target.Running = false;
              target.ExitCode = 3;
              return true;
            }
            return Reflect.set(target, prop, next);
          },
        });
        return original(key, proxy);
      }
      return original(key, value);
    };
    await assert.rejects(h.deploy(app.id), (error: unknown) => error instanceof AppError && error.params?.reason === 'crash' && /worker exited with code 3/.test(error.message));
  } finally {
    await h.close();
  }
});

test('each run gets its own CLI config with only its own team registry logins, removed afterwards', async () => {
  const h = await harness();
  try {
    const { stores } = h.ctx;
    const mine = h.create(STACK);
    stores.registries.create(mine.teamId, { name: 'GitHub', serverAddress: 'ghcr.io', username: 'robot', password: 'ghp_team_a_secret' });
    stores.registries.create(mine.teamId, { name: 'Hub', serverAddress: 'docker.io', username: 'hubuser', password: 'hub_team_a_secret' });

    // A second team on the same server, with its own login for one of the same registries.
    const rival = stores.teams.create('Rival');
    const rivalProject = stores.projects.create(rival.id, 'Rival', null);
    const theirs = stores.applications.create({
      projectId: rivalProject.id,
      teamId: rival.id,
      serverId: mine.serverId,
      name: 'Rival',
      slug: 'rival',
      kind: 'compose',
      sourceType: 'raw',
      githubInstallationId: null,
      repository: null,
      gitUrl: null,
      branch: null,
      image: null,
      composeFile: STACK,
      sealedHookToken: h.ctx.secrets.seal(generateToken(), 'hook'),
    });
    stores.registries.create(rival.id, { name: 'Rival GitHub', serverAddress: 'ghcr.io', username: 'rival', password: 'ghp_team_b_secret' });
    const third = stores.teams.create('Plain');
    const plainProject = stores.projects.create(third.id, 'Plain', null);
    const plain = stores.applications.create({ ...theirs, projectId: plainProject.id, teamId: third.id, name: 'Plain', slug: 'plain', sealedHookToken: 'x' });

    await h.deploy(mine.id);
    await h.deploy(theirs.id);
    await h.deploy(plain.id);
    const ups = h.calls().filter((call) => call.args.includes('up'));
    assert.equal(ups.length, 3);
    const [a, b, c] = ups as [(typeof ups)[number], (typeof ups)[number], (typeof ups)[number]];

    assert.deepEqual(a.config!.auths, {
      'ghcr.io': { auth: Buffer.from('robot:ghp_team_a_secret').toString('base64') },
      'https://index.docker.io/v1/': { auth: Buffer.from('hubuser:hub_team_a_secret').toString('base64') },
    });
    assert.deepEqual(b.config!.auths, { 'ghcr.io': { auth: Buffer.from('rival:ghp_team_b_secret').toString('base64') } });
    assert.equal(c.config!.auths, undefined, 'a team without registries gets no logins at all');
    assert.ok(Array.isArray((c.config as { cliPluginsExtraDirs?: unknown }).cliPluginsExtraDirs));

    assert.equal(new Set(ups.map((call) => call.env.DOCKER_CONFIG)).size, 3, 'no two runs share a config directory');
    for (const call of ups) assert.equal(existsSync(call.env.DOCKER_CONFIG!), false, 'the config with the logins is removed after the run');
  } finally {
    await h.close();
  }
});
