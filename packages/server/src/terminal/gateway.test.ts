/**
 * The terminal gateway against a real HTTP server, a real WebSocket client
 * and an Engine API double that speaks the hijacked exec protocol.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket } from 'ws';
import { generateToken } from '../lib/crypto.ts';
import { createContext } from '../main.ts';
import { TerminalGateway } from './gateway.ts';

interface Harness {
  url: string;
  origin: string;
  owner: string;
  viewer: string;
  appId: string;
  daemonCalls: string[];
  audit: () => string[];
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-term-'));
  const daemonCalls: string[] = [];
  // Engine API double: exec create/resize/inspect plus an upgraded start that
  // echoes keystrokes upper-cased and exits when it sees "exit".
  const daemon = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      daemonCalls.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/version') return void res.end(JSON.stringify({ Version: '28.0.1', ApiVersion: '1.47', Os: 'linux', Arch: 'amd64' }));
      if (req.url?.includes('/containers/ploy-web-missing/exec') === true) {
        res.statusCode = 404;
        return void res.end(JSON.stringify({ message: 'No such container: ploy-web-missing' }));
      }
      if (req.url?.endsWith('/exec') === true) return void res.end(JSON.stringify({ Id: 'exec1' }));
      if (req.url?.endsWith('/exec1/json') === true) return void res.end(JSON.stringify({ ExitCode: 0, Running: false }));
      res.statusCode = 201;
      res.end();
    });
  });
  daemon.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    daemonCalls.push(`UPGRADE ${req.url}`);
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    socket.write('$ ');
    socket.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text.includes('exit')) {
        socket.end();
        return;
      }
      socket.write(text.toUpperCase());
    });
  });
  const dockerSocket = join(dir, 'docker.sock');
  await new Promise<void>((resolve) => daemon.listen(dockerSocket, resolve));

  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket, logLevel: 'error' });
  const { stores } = ctx;
  const ownerUser = stores.users.create({ email: 'owner@example.uz', name: 'Owner', passwordHash: null, isInstanceAdmin: true });
  const viewerUser = stores.users.create({ email: 'viewer@example.uz', name: 'Viewer', passwordHash: null, isInstanceAdmin: false });
  const team = stores.teams.create('Ops');
  stores.teams.addMember(team.id, ownerUser.id, 'owner');
  stores.teams.addMember(team.id, viewerUser.id, 'viewer');
  stores.users.update(ownerUser.id, { currentTeamId: team.id });
  stores.users.update(viewerUser.id, { currentTeamId: team.id });
  const local = stores.servers.ensureLocal('local');
  const project = stores.projects.create(team.id, 'Shop', null);
  const app = stores.applications.create({
    projectId: project.id,
    teamId: team.id,
    serverId: local.id,
    name: 'Web',
    slug: 'web',
    kind: 'web',
    sourceType: 'image',
    githubInstallationId: null,
    repository: null,
    gitUrl: null,
    branch: null,
    image: 'nginx:alpine',
    sealedHookToken: ctx.secrets.seal(generateToken(), 'hook'),
  });
  const deployment = stores.deployments.create({ application: app, trigger: 'manual', createdBy: null });
  stores.deployments.setContainers(deployment.id, ['ploy-web-1', 'ploy-web-missing'], 80);
  stores.applications.setActiveDeployment(app.id, deployment.id);

  const http: Server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const gateway = new TerminalGateway(ctx);
  gateway.attach(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    url: `ws://127.0.0.1:${address.port}/api/applications/${app.id}/terminal`,
    origin,
    owner: stores.sessions.create(ownerUser.id, null, null).token,
    viewer: stores.sessions.create(viewerUser.id, null, null).token,
    appId: app.id,
    daemonCalls,
    audit: () => stores.db.all('SELECT action FROM audit_log').map((row) => String(row.action)),
    close: async () => {
      gateway.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await ctx.connections.closeAll();
      stores.db.close();
      daemon.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Resolve with the HTTP status of a refused upgrade. */
function refusal(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    ws.on('open', () => reject(new Error('upgrade should have been refused')));
    ws.on('error', () => undefined);
  });
}

test('terminal upgrades are refused without a session, cross-origin, or below the developer role', async () => {
  const h = await harness();
  try {
    assert.equal(await refusal(h.url, { origin: h.origin }), 401);
    assert.equal(await refusal(h.url, { origin: 'https://evil.example', cookie: `ploy_session=${h.owner}` }), 403);
    assert.equal(await refusal(h.url, { cookie: `ploy_session=${h.owner}` }), 403, 'a missing Origin is not same-origin');
    assert.equal(await refusal(h.url, { origin: h.origin, cookie: `ploy_session=${h.viewer}` }), 403);
    assert.equal(await refusal(h.url.replace(h.appId, 'app_unknown'), { origin: h.origin, cookie: `ploy_session=${h.owner}` }), 404);
    assert.ok(!h.daemonCalls.some((call) => call.includes('/exec')), 'no exec is created for a refused upgrade');
  } finally {
    await h.close();
  }
});

test('a developer gets a live shell: keystrokes in, output out, resize, exit code on close', async () => {
  const h = await harness();
  try {
    const ws = new WebSocket(`${h.url}?cols=100&rows=40&shell=sh`, { headers: { origin: h.origin, cookie: `ploy_session=${h.owner}` } });
    const controls: Record<string, unknown>[] = [];
    let output = '';
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    ws.on('message', (data, isBinary) => {
      if (isBinary) output += (data as Buffer).toString('utf8');
      else controls.push(JSON.parse((data as Buffer).toString('utf8')) as Record<string, unknown>);
    });
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    const until = async (check: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(check());
    };
    await until(() => controls.some((message) => message.type === 'ready'));
    await until(() => output.includes('$ '));

    ws.send(Buffer.from('echo hi\n'), { binary: true });
    await until(() => output.includes('ECHO HI'));
    ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 50 }));
    await until(() => h.daemonCalls.some((call) => call.includes('/exec/exec1/resize?h=50&w=132')));

    ws.send(Buffer.from('exit\n'), { binary: true });
    assert.equal(await closed, 1000);
    assert.deepEqual(controls.at(-1), { type: 'exit', code: 0 });

    const create = h.daemonCalls.find((call) => call.endsWith('/containers/ploy-web-1/exec'));
    assert.ok(create, 'the shell runs in the first replica');
    assert.ok(h.daemonCalls.some((call) => call.includes('/exec/exec1/resize?h=40&w=100')), 'initial size comes from the URL');
    assert.ok(h.audit().includes('terminal.opened'));
  } finally {
    await h.close();
  }
});

test('a replica whose container is gone reports not_running instead of hanging', async () => {
  const h = await harness();
  try {
    const ws = new WebSocket(`${h.url}?replica=1`, { headers: { origin: h.origin, cookie: `ploy_session=${h.owner}` } });
    const message = await new Promise<Record<string, unknown>>((resolve) => ws.on('message', (data) => resolve(JSON.parse((data as Buffer).toString('utf8')) as Record<string, unknown>)));
    assert.equal(message.type, 'error');
    assert.equal(message.code, 'not_running');
    await new Promise((resolve) => ws.on('close', resolve));
  } finally {
    await h.close();
  }
});
