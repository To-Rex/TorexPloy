/**
 * A project moved from one panel to another, end to end, against a Docker
 * double that keeps volumes' files in memory: a PostgreSQL database (dumped
 * and restored), a Redis without a dump (its files copied), an application
 * with variables, a volume, a domain, a cron job, a link and uploaded code,
 * and one that runs an image. The archive goes over by download and upload,
 * and by a transfer link the other panel pulls; a wrong passphrase, the
 * roles and a token's reach are refused where they should be.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { serve, type HttpBindings } from '@hono/node-server';
import { API_TOKEN_PREFIX, concatZip, createZip, type CreatedExportDto, type ImportAnalysisDto, type TransferDto, type TransferShareDto } from '@ploy/shared';
import { uploadPath } from '../deploy/uploads.ts';
import { createHttpApp } from '../http/app.ts';
import { generateToken } from '../lib/crypto.ts';
import { createTar, readTar } from '../lib/tar.ts';
import { createContext } from '../main.ts';
import { catalogEntry } from '../services/catalog.ts';

const BINDINGS = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as unknown as HttpBindings;
const DONE = new Set(['succeeded', 'failed', 'cancelled']);

interface FakeContainer {
  id: string;
  name: string;
  /** The volume it mounts (a helper at /volume, a service at its data directory). */
  volume: string | null;
  mode: string;
  running: boolean;
  paused: boolean;
  helper: boolean;
  /** Files handed in through the archive endpoint (a dump to restore lands in /tmp). */
  tmp: Map<string, Buffer>;
}

/** One Docker daemon both panels share: volumes are name → (path → content). */
async function fakeDocker(dir: string) {
  const socket = join(dir, 'docker.sock');
  const volumes = new Map<string, Map<string, string>>();
  const containers = new Map<string, FakeContainer>();
  const networks = new Set<string>();
  const execs = new Map<string, { container: string; cmd: string[] }>();
  const log: string[] = [];
  /** Containers whose name matches are refused (a server that cannot start them). */
  const faults: { refuse: RegExp | null } = { refuse: null };
  let next = 0;

  const frame = (stream: 1 | 2, payload: Buffer): Buffer => {
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };
  const find = (key: string): FakeContainer | undefined => containers.get(key) ?? [...containers.values()].find((container) => container.name === key);

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://docker');
      const path = url.pathname.replace(/^\/v1\.\d+/, '');
      const method = req.method ?? 'GET';
      const body = Buffer.concat(chunks);
      const json = (status: number, value: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(value));
      };
      const empty = (status = 204) => {
        res.statusCode = status;
        res.end();
      };
      if (path === '/version') return json(200, { Version: '28.0.1', ApiVersion: '1.47', Os: 'linux', Arch: 'amd64' });
      if (path === '/_ping') return empty(200);
      if (path === '/networks' && method === 'GET') return json(200, [...networks].map((name) => ({ Name: name, Id: name })));
      if (path === '/networks/create') {
        const spec = JSON.parse(body.toString()) as { Name: string };
        networks.add(spec.Name);
        return json(201, { Id: spec.Name });
      }
      if (path === '/volumes/create') {
        const spec = JSON.parse(body.toString()) as { Name: string };
        if (!volumes.has(spec.Name)) volumes.set(spec.Name, new Map());
        return json(201, { Name: spec.Name });
      }
      if (path === '/volumes' && method === 'GET') return json(200, { Volumes: [] });
      let match = /^\/volumes\/([^/]+)$/.exec(path);
      if (match !== null && method === 'GET') return volumes.has(decodeURIComponent(match[1]!)) ? json(200, { Name: decodeURIComponent(match[1]!) }) : json(404, { message: 'no such volume' });
      match = /^\/images\/(.+)\/json$/.exec(path);
      if (match !== null) return json(200, { Id: 'sha256:image', RepoTags: [decodeURIComponent(match[1]!)], Config: { Labels: {}, ExposedPorts: {} } });
      if (path === '/containers/create' && method === 'POST') {
        if (faults.refuse !== null && faults.refuse.test(url.searchParams.get('name') ?? '')) return json(500, { message: 'no space left on device' });
        const spec = JSON.parse(body.toString()) as { HostConfig: { Binds?: string[]; Mounts?: { Source: string }[] } };
        const id = `c${++next}`;
        const bind = spec.HostConfig.Binds?.[0]?.split(':');
        const helper = bind !== undefined;
        const volume = helper ? bind[0]! : (spec.HostConfig.Mounts?.[0]?.Source ?? null);
        if (volume !== null && !volumes.has(volume)) volumes.set(volume, new Map());
        containers.set(id, { id, name: url.searchParams.get('name') ?? id, volume, mode: bind?.[2] ?? 'rw', running: false, paused: false, helper, tmp: new Map() });
        return json(201, { Id: id });
      }
      match = /^\/containers\/([^/]+)\/(start|stop|pause|unpause|json|archive|exec|restart)$/.exec(path);
      if (match !== null) {
        const container = find(decodeURIComponent(match[1]!));
        const action = match[2]!;
        if (container === undefined) return json(404, { message: 'No such container' });
        if (action === 'json') {
          return json(200, {
            Id: container.id,
            Name: `/${container.name}`,
            State: { Status: container.running ? 'running' : 'exited', Running: container.running, Paused: container.paused, Restarting: false, OOMKilled: false, ExitCode: 0, Error: '', StartedAt: '', FinishedAt: '', Health: { Status: 'healthy' } },
            Config: { Image: 'x', Labels: {} },
            NetworkSettings: { Networks: {} },
            HostConfig: {},
          });
        }
        if (action === 'start' || action === 'restart') {
          container.running = true;
          return empty();
        }
        if (action === 'stop') {
          container.running = false;
          return empty();
        }
        if (action === 'pause' || action === 'unpause') {
          if (action === 'unpause' && !container.paused) return json(409, { message: 'not paused' });
          container.paused = action === 'pause';
          log.push(`${action} ${container.name}`);
          return empty();
        }
        if (action === 'archive' && method === 'GET') {
          assert.equal(container.helper, true);
          const files = volumes.get(container.volume!)!;
          res.setHeader('content-type', 'application/x-tar');
          return res.end(createTar([...files].map(([name, content]) => ({ name: `volume/${name}`, content }))));
        }
        if (action === 'archive' && method === 'PUT') {
          let tar = body;
          if (tar[0] === 0x1f && tar[1] === 0x8b) tar = gunzipSync(tar);
          const at = url.searchParams.get('path');
          for (const entry of readTar(tar)) {
            if (container.helper) {
              assert.equal(container.mode, 'rw');
              volumes.get(container.volume!)!.set(entry.name.replace(/^volume\//, ''), entry.content.toString('utf8'));
            } else {
              container.tmp.set(`${at}/${entry.name}`, entry.content);
            }
          }
          return empty(200);
        }
        if (action === 'exec') {
          const spec = JSON.parse(body.toString()) as { Cmd: string[] };
          const id = `e${++next}`;
          execs.set(id, { container: container.id, cmd: spec.Cmd });
          return json(201, { Id: id });
        }
      }
      match = /^\/exec\/([^/]+)\/(start|json)$/.exec(path);
      if (match !== null) {
        if (match[2] === 'json') return json(200, { ExitCode: 0, Running: false });
        const exec = execs.get(match[1]!)!;
        const container = containers.get(exec.container)!;
        const files = container.volume === null ? new Map<string, string>() : volumes.get(container.volume)!;
        const line = exec.cmd.join(' ');
        let out = Buffer.alloc(0);
        if (exec.cmd[0] === 'find') files.clear();
        else if (/pg_dump/.test(line)) out = Buffer.from(`DUMP:${files.get('PG_VERSION_DATA') ?? ''}`);
        else if (/pg_restore/.test(line)) {
          const dump = container.tmp.get('/tmp/ploy-restore.dump')!.toString();
          files.set('PG_VERSION_DATA', dump.replace(/^DUMP:/, ''));
          log.push(`restore ${container.name}`);
        }
        res.setHeader('content-type', 'application/vnd.docker.raw-stream');
        return res.end(out.length === 0 ? Buffer.alloc(0) : frame(1, out));
      }
      match = /^\/containers\/([^/]+)$/.exec(path);
      if (match !== null && method === 'DELETE') {
        const container = find(decodeURIComponent(match[1]!));
        if (container === undefined) return json(404, { message: 'No such container' });
        containers.delete(container.id);
        return empty();
      }
      json(404, { message: `fake daemon: unhandled ${method} ${path}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return { socket, volumes, containers, log, server, faults };
}

async function panel(dir: string, name: string, socket: string) {
  process.env.PLOY_RUN_DIR = join(dir, `${name}-run`);
  const ctx = await createContext({ dataDir: join(dir, name), databasePath: join(dir, name, 'panel.db'), dockerSocket: socket, logLevel: 'error' });
  ctx.proxy.requestSync = async () => undefined;
  const { stores } = ctx;
  const server = stores.servers.ensureLocal('local');
  stores.servers.setStatus(server.id, 'ready', null);
  const team = stores.teams.create(`${name} team`);
  const member = (email: string, role: 'viewer' | 'developer' | 'admin' | 'owner', access: 'read' | 'write' | 'full' = 'full'): string => {
    const user = stores.users.create({ email, name: email.split('@')[0]!, passwordHash: null, isInstanceAdmin: false });
    stores.teams.addMember(team.id, user.id, role);
    return stores.tokens.create({ userId: user.id, teamId: team.id, name: 'test', expiresAt: null, tokenPrefix: API_TOKEN_PREFIX, access }).token;
  };
  const admin = member(`admin@${name}.example.com`, 'admin');
  const app = createHttpApp(ctx);
  const call = async <T>(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const headers: Record<string, string> = {};
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, BINDINGS);
    const text = await response.text();
    return { status: response.status, body: (text.length > 0 && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as T };
  };
  const until = async (id: string, done: (transfer: TransferDto) => boolean): Promise<TransferDto> => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const { body } = await call<TransferDto>(admin, 'GET', `/api/transfers/${id}`);
      if (done(body)) return body;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`transfer ${id} never got there`);
  };
  return { ctx, stores, server, team, member, admin, app, call, until };
}

test('a project moves to another panel with its data, its code and its settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-transfer-'));
  const docker = await fakeDocker(dir);
  const a = await panel(dir, 'alpha', docker.socket);
  const b = await panel(dir, 'beta', docker.socket);
  let http: Server | null = null;
  try {
    // ------------------------------------------------------------ the project on panel A
    const { stores, ctx } = a;
    const project = stores.projects.create(a.team.id, 'Shop', 'The shop');
    stores.env.replace({ projectId: project.id }, [{ key: 'REGION', value: 'uz' }]);

    const pg = ctx.services.create(project, { type: 'postgres', name: 'Main DB', serverId: a.server.id, credentials: { password: 'pg-secret-123' } }, { provision: false });
    await ctx.services.provision(pg.id);
    assert.equal(stores.services.get(pg.id)!.status, 'running');
    docker.volumes.get(pg.volumeName)!.set('PG_VERSION_DATA', 'orders:42');

    const cache = ctx.services.create(project, { type: 'redis', name: 'Cache', serverId: a.server.id }, { provision: false });
    await ctx.services.provision(cache.id);
    docker.volumes.get(cache.volumeName)!.set('dump.rdb', 'redis-bytes');

    const web = stores.applications.create({
      projectId: project.id,
      teamId: a.team.id,
      serverId: a.server.id,
      name: 'Web',
      slug: 'web',
      kind: 'web',
      sourceType: 'upload',
      githubInstallationId: null,
      repository: null,
      gitUrl: null,
      branch: null,
      image: null,
      port: 3000,
      sealedHookToken: ctx.secrets.seal(generateToken(), 'hook'),
    });
    const zip = concatZip(await createZip([{ path: 'index.js', data: new TextEncoder().encode('console.log("shop")') }, { path: 'package.json', data: new TextEncoder().encode('{"name":"shop"}') }]));
    const uploadId = 'upl_test1';
    mkdirSync(join(dir, 'alpha', 'uploads', web.id), { recursive: true });
    writeFileSync(uploadPath(ctx.config.dataDir, web.id, uploadId), zip);
    stores.applications.setUpload(web.id, { id: uploadId, name: 'shop.zip', size: zip.length, files: 2, bytes: 40, uploadedAt: new Date().toISOString() });
    stores.env.replace({ applicationId: web.id }, [{ key: 'SECRET_KEY', value: 's3cr3t' }]);
    const volume = stores.volumes.create(web.id, 'data', '/app/data', 'ploy-vol-web-data');
    docker.volumes.set('ploy-vol-web-data', new Map([['notes.txt', 'remember me']]));
    stores.domains.create({ applicationId: web.id, teamId: a.team.id, host: 'shop.example.com', https: true, port: null, isGenerated: false });
    stores.links.create(web.id, pg.id, 'DB_');
    stores.cron.create({ applicationId: web.id, name: 'Nightly', schedule: '0 3 * * *', command: 'node cron.js', enabled: true, timeoutSec: 600, nextRunAt: null });
    assert.ok(volume);

    stores.applications.create({
      projectId: project.id,
      teamId: a.team.id,
      serverId: a.server.id,
      name: 'Blog',
      slug: 'blog',
      kind: 'web',
      sourceType: 'image',
      githubInstallationId: null,
      repository: null,
      gitUrl: null,
      branch: null,
      image: 'ghost:5',
      sealedHookToken: ctx.secrets.seal(generateToken(), 'hook'),
    });

    // ------------------------------------------------------------ who may export
    const developer = a.member('dev@alpha.example.com', 'developer');
    assert.equal((await a.call(developer, 'POST', '/api/transfers/export', { projectId: project.id })).status, 403);
    const writer = a.member('writer@alpha.example.com', 'admin', 'write');
    const refused = await a.call<{ error: { params: { reason: string } } }>(writer, 'POST', '/api/transfers/export', { projectId: project.id });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.params.reason, 'token_full_required');

    // ------------------------------------------------------------ export
    const created = await a.call<CreatedExportDto>(a.admin, 'POST', '/api/transfers/export', { projectId: project.id });
    assert.equal(created.status, 201);
    assert.match(created.body.passphrase, /^[a-z2-9]{5}(-[a-z2-9]{5}){4}$/);
    const exported = await a.until(created.body.transfer.id, (transfer) => transfer.status !== 'queued' && transfer.status !== 'running');
    assert.equal(exported.status, 'succeeded', JSON.stringify(exported.error));
    assert.equal(exported.downloadable, true);
    assert.ok(exported.steps.some((step) => step.kind === 'database' && step.status === 'done'));
    assert.ok(exported.steps.some((step) => step.kind === 'volume' && step.status === 'done'));
    assert.ok(exported.steps.some((step) => step.kind === 'source' && step.status === 'done'));
    // Redis has no dump: its container was frozen while its files were copied, and thawed after.
    assert.deepEqual(docker.log.filter((line) => line.includes(cache.containerName)), [`pause ${cache.containerName}`, `unpause ${cache.containerName}`]);

    const download = await a.app.request(`/api/transfers/${exported.id}/download`, { headers: { authorization: `Bearer ${a.admin}` } }, BINDINGS);
    assert.equal(download.status, 200);
    const archive = Buffer.from(await download.arrayBuffer());
    assert.equal(archive.subarray(0, 9).toString('latin1'), 'TOREXPLOY');
    assert.ok(!archive.includes(Buffer.from('s3cr3t')), 'secrets never appear in the clear');
    assert.ok(!archive.includes(Buffer.from('orders:42')), 'data never appears in the clear');
    const partial = await a.app.request(`/api/transfers/${exported.id}/download`, { headers: { authorization: `Bearer ${a.admin}`, range: 'bytes=10-19' } }, BINDINGS);
    assert.equal(partial.status, 206);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), archive.subarray(10, 20));

    // ------------------------------------------------------------ import on panel B, from the file
    const upload = await b.app.request('/api/transfers/import/upload?name=shop.torexploy', { method: 'POST', headers: { authorization: `Bearer ${b.admin}`, 'content-length': String(archive.length), 'content-type': 'application/octet-stream' }, body: archive }, BINDINGS);
    assert.equal(upload.status, 201);
    const received = (await upload.json()) as TransferDto;
    assert.equal(received.status, 'locked');

    const wrong = await b.call<{ error: { params: { reason: string } } }>(b.admin, 'POST', `/api/transfers/${received.id}/unlock`, { passphrase: 'not-the-passphrase' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.params.reason, 'wrong_passphrase');

    const opened = await b.call<ImportAnalysisDto>(b.admin, 'POST', `/api/transfers/${received.id}/unlock`, { passphrase: created.body.passphrase });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const analysis = opened.body;
    assert.equal(analysis.project.name, 'Shop');
    assert.equal(analysis.suggestedName, 'Shop');
    assert.equal(analysis.serverId, b.server.id);
    assert.deepEqual(analysis.services.map((service) => [service.name, service.data]).sort(), [['Cache', 'files'], ['Main DB', 'dump']]);
    const webPlan = analysis.applications.find((app) => app.name === 'Web')!;
    assert.deepEqual(webPlan.sources, ['archive']);
    assert.deepEqual(webPlan.domains, [{ host: 'shop.example.com', path: '/', conflict: false }]);
    assert.deepEqual(webPlan.links, ['Main DB']);
    assert.deepEqual(analysis.applications.find((app) => app.name === 'Blog')!.sources, []);

    const started = await b.call<TransferDto>(b.admin, 'POST', `/api/transfers/${received.id}/start`, { serverId: b.server.id, projectName: 'Shop', deploy: false });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const imported = await b.until(received.id, (transfer) => transfer.status === 'succeeded' || transfer.status === 'failed');
    assert.equal(imported.status, 'succeeded', JSON.stringify(imported.error ?? imported.steps.filter((step) => step.status === 'failed')));
    assert.ok(imported.projectId !== null);

    // ------------------------------------------------------------ what panel B has now
    const target = b.stores.projects.get(imported.projectId!)!;
    assert.equal(target.name, 'Shop');
    assert.deepEqual(b.stores.env.list({ projectId: target.id }), [{ key: 'REGION', value: 'uz' }]);
    const services = b.stores.services.listForProject(target.id);
    const db = services.find((service) => service.type === 'postgres')!;
    assert.equal(db.slug, pg.slug, 'applications reach it by the same name');
    assert.equal(db.credentials.password, 'pg-secret-123', 'the same credentials');
    assert.equal(db.status, 'running');
    assert.equal(docker.volumes.get(db.volumeName)!.get('PG_VERSION_DATA'), 'orders:42', 'the dump was restored');
    const redis = services.find((service) => service.type === 'redis')!;
    assert.equal(docker.volumes.get(redis.volumeName)!.get('dump.rdb'), 'redis-bytes', 'its files were put back before it started');
    assert.equal(redis.status, 'running');

    const apps = b.stores.applications.listForProject(target.id);
    const newWeb = apps.find((app) => app.name === 'Web')!;
    assert.equal(newWeb.slug, 'web');
    assert.equal(newWeb.sourceType, 'upload');
    assert.ok(newWeb.upload !== null && newWeb.upload.files === 2, 'the code arrived as its upload');
    assert.equal(newWeb.port, 3000);
    assert.deepEqual(b.stores.env.list({ applicationId: newWeb.id }), [{ key: 'SECRET_KEY', value: 's3cr3t' }]);
    const newVolume = b.stores.volumes.listForApplication(newWeb.id)[0]!;
    assert.equal(newVolume.mountPath, '/app/data');
    assert.equal(docker.volumes.get(newVolume.dockerVolume)!.get('notes.txt'), 'remember me');
    assert.deepEqual(b.stores.domains.listForApplication(newWeb.id).filter((domain) => !domain.isGenerated).map((domain) => domain.host), ['shop.example.com']);
    assert.deepEqual(b.stores.links.listForApplication(newWeb.id).map((link) => [link.serviceId, link.prefix]), [[db.id, 'DB_']]);
    assert.deepEqual(b.stores.cron.listForApplication(newWeb.id).map((job) => [job.name, job.schedule, job.enabled]), [['Nightly', '0 3 * * *', true]]);
    const blog = apps.find((app) => app.name === 'Blog')!;
    assert.equal(blog.sourceType, 'image');
    assert.equal(blog.image, 'ghost:5');
    // The archive did its work and is gone; the row remains as history.
    assert.equal(imported.downloadable, false);

    // ------------------------------------------------------------ the same export, pulled by its transfer link
    http = serve({ fetch: a.app.fetch, port: 0, hostname: '127.0.0.1' }) as unknown as Server;
    await new Promise<void>((resolve) => (http!.listening ? resolve() : http!.once('listening', () => resolve())));
    const port = (http.address() as { port: number }).port;
    const shared = await a.call<TransferShareDto>(a.admin, 'POST', `/api/transfers/${exported.id}/share`);
    assert.equal(shared.status, 200);
    const link = shared.body.link.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${port}`);
    assert.ok(link.endsWith(`#${created.body.passphrase}`), 'the link carries the passphrase after #');
    // Without a session the link serves the archive, and nothing else.
    const pulled = await fetch(link.split('#')[0]!);
    assert.equal(pulled.status, 200);
    assert.deepEqual(Buffer.from(await pulled.arrayBuffer()), archive);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/transfers/pull/${'x'.repeat(43)}`)).status, 404);

    const fromLink = await b.call<TransferDto>(b.admin, 'POST', '/api/transfers/import/link', { link });
    assert.equal(fromLink.status, 202, JSON.stringify(fromLink.body));
    const ready = await b.until(fromLink.body.id, (transfer) => !['receiving', 'locked'].includes(transfer.status));
    assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
    const again = await b.call<ImportAnalysisDto>(b.admin, 'GET', `/api/transfers/${fromLink.body.id}/analysis`);
    assert.equal(again.body.suggestedName, 'Shop (2)', 'a name already taken gets a number');
    assert.equal(again.body.applications.find((app) => app.name === 'Web')!.domains[0]!.conflict, true, 'the domain is taken by the first import');
    assert.equal((await a.call<TransferDto>(a.admin, 'GET', `/api/transfers/${exported.id}`)).body.share!.downloads, 2);

    // A withdrawn link stops working.
    await a.call(a.admin, 'DELETE', `/api/transfers/${exported.id}/share`);
    assert.equal((await fetch(link.split('#')[0]!)).status, 404);
    assert.equal((await b.call(b.admin, 'DELETE', `/api/transfers/${fromLink.body.id}`)).status, 200);
  } finally {
    http?.close();
    docker.server.close();
    a.ctx.domains.stop();
    b.ctx.domains.stop();
  }
});

test('every engine with a dump also restores one, which is what an export relies on', () => {
  for (const type of ['postgres', 'mysql', 'mariadb', 'mongo'] as const) assert.notEqual(catalogEntry(type).backup?.restore ?? null, null, type);
});

test('an import that stops half way carries on where it stopped, making nothing twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-transfer-retry-'));
  const docker = await fakeDocker(dir);
  const a = await panel(dir, 'gamma', docker.socket);
  const b = await panel(dir, 'delta', docker.socket);
  try {
    const project = a.stores.projects.create(a.team.id, 'Ledger', null);
    const pg = a.ctx.services.create(project, { type: 'postgres', name: 'books', serverId: a.server.id, credentials: { password: 'ledger-pass-1' } }, { provision: false });
    await a.ctx.services.provision(pg.id);
    docker.volumes.get(pg.volumeName)!.set('PG_VERSION_DATA', 'balance:100');
    a.stores.applications.create({
      projectId: project.id,
      teamId: a.team.id,
      serverId: a.server.id,
      name: 'Api',
      slug: 'api',
      kind: 'worker',
      sourceType: 'image',
      githubInstallationId: null,
      repository: null,
      gitUrl: null,
      branch: null,
      image: 'ledger:1',
      sealedHookToken: a.ctx.secrets.seal(generateToken(), 'hook'),
    });
    const created = await a.call<CreatedExportDto>(a.admin, 'POST', '/api/transfers/export', { projectId: project.id });
    const exported = await a.until(created.body.transfer.id, (transfer) => DONE.has(transfer.status));
    assert.equal(exported.status, 'succeeded');
    const archive = Buffer.from(await (await a.app.request(`/api/transfers/${exported.id}/download`, { headers: { authorization: `Bearer ${a.admin}` } }, BINDINGS)).arrayBuffer());

    const upload = await b.app.request('/api/transfers/import/upload', { method: 'POST', headers: { authorization: `Bearer ${b.admin}`, 'content-length': String(archive.length) }, body: archive }, BINDINGS);
    const received = (await upload.json()) as TransferDto;
    assert.equal((await b.call(b.admin, 'POST', `/api/transfers/${received.id}/unlock`, { passphrase: created.body.passphrase })).status, 200);

    // The server cannot start the database: its dump has nowhere to go, so the import stops (and the panel stays up).
    docker.faults.refuse = /books/;
    await b.call(b.admin, 'POST', `/api/transfers/${received.id}/start`, { serverId: b.server.id, projectName: 'Ledger', deploy: false });
    const failed = await b.until(received.id, (transfer) => DONE.has(transfer.status));
    assert.equal(failed.status, 'failed');
    assert.match(failed.error!.message, /no space left on device/);
    assert.ok(failed.projectId !== null, 'the project was made before it stopped');

    // Fixed: the retry carries on, without a second project, service or application.
    docker.faults.refuse = null;
    assert.equal((await b.call(b.admin, 'POST', `/api/transfers/${received.id}/retry`)).status, 202);
    const done = await b.until(received.id, (transfer) => DONE.has(transfer.status));
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    assert.equal(done.projectId, failed.projectId);
    assert.equal(b.stores.projects.listForTeam(b.team.id).length, 1);
    const services = b.stores.services.listForProject(done.projectId!);
    assert.equal(services.length, 1);
    assert.equal(services[0]!.status, 'running');
    assert.equal(docker.volumes.get(services[0]!.volumeName)!.get('PG_VERSION_DATA'), 'balance:100');
    assert.equal(b.stores.applications.listForProject(done.projectId!).length, 1);
  } finally {
    docker.server.close();
    a.ctx.domains.stop();
    b.ctx.domains.stop();
  }
});
