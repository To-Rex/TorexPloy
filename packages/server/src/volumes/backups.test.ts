/**
 * Volume backups through the HTTP API against a Docker double that keeps each
 * volume's files in memory: a copy taken through a helper container, the
 * application paused for it when asked (and resumed after a restart cut a
 * copy short), retention, a restore that stops the application, takes a copy
 * of what it replaces and starts it again, a failed restore put back, and the
 * roles each step needs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HttpBindings } from '@hono/node-server';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { API_TOKEN_PREFIX, type ApiErrorBody, type VolumeBackupDto, type VolumeDto } from '@ploy/shared';
import { generateToken } from '../lib/crypto.ts';
import { createTar, readTar } from '../lib/tar.ts';
import { createContext } from '../main.ts';
import { createHttpApp } from '../http/app.ts';

const BINDINGS = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as unknown as HttpBindings;

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-volbak-'));
  const dockerSocket = join(dir, 'docker.sock');
  /** Docker volumes by name: their files, path → content. */
  const volumes = new Map<string, Map<string, string>>();
  /** Helper containers by id: the volume they mount and how. */
  const helpers = new Map<string, { volume: string; mode: string; name: string }>();
  /** Application containers by name: running or paused. */
  const apps = new Map<string, { running: boolean; paused: boolean }>();
  const calls: string[] = [];
  const execs = new Map<string, { container: string; cmd: string[] }>();
  /** Set to make the next archive upload fail half way (the volume is left empty). */
  const faults = { failUpload: false };
  let nextId = 0;

  const frame = (stream: 1 | 2, text: string): Buffer => {
    const payload = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };

  const daemon = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://docker');
      const path = url.pathname.replace(/^\/v1\.\d+/, '');
      const method = req.method ?? 'GET';
      const json = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      const empty = (status = 204) => {
        res.statusCode = status;
        res.end();
      };
      if (path === '/version') return json(200, { Version: '28.0.1', ApiVersion: '1.47', Os: 'linux', Arch: 'amd64' });
      if (path === '/_ping') return empty(200);
      let match = /^\/volumes\/([^/]+)$/.exec(path);
      if (match !== null && method === 'GET') return volumes.has(decodeURIComponent(match[1]!)) ? json(200, { Name: decodeURIComponent(match[1]!) }) : json(404, { message: 'no such volume' });
      match = /^\/images\/(.+)\/json$/.exec(path);
      if (match !== null) return json(200, { Id: 'sha256:caddy', RepoTags: [decodeURIComponent(match[1]!)], Config: { Labels: {} } });
      if (path === '/containers/create' && method === 'POST') {
        const spec = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { HostConfig: { Binds: string[] }; NetworkDisabled?: boolean; Image: string };
        const [volume, , mode] = spec.HostConfig.Binds[0]!.split(':');
        assert.equal(spec.NetworkDisabled, true, 'a helper has no network');
        const id = `helper${++nextId}`;
        helpers.set(id, { volume: volume!, mode: mode!, name: url.searchParams.get('name')! });
        calls.push(`create ${mode}`);
        return json(201, { Id: id });
      }
      match = /^\/containers\/([^/]+)\/(start|stop|pause|unpause|json|archive|exec)$/.exec(path);
      if (match !== null) {
        const id = decodeURIComponent(match[1]!);
        const action = match[2]!;
        const helper = helpers.get(id);
        const app = apps.get(id);
        if (action === 'json') {
          if (app === undefined) return json(404, { message: 'No such container' });
          return json(200, { Id: id, Name: `/${id}`, State: { Status: app.paused ? 'paused' : app.running ? 'running' : 'exited', Running: app.running, Paused: app.paused, Restarting: false, OOMKilled: false, ExitCode: 0, Error: '', StartedAt: '', FinishedAt: '' }, Config: { Image: 'app', Labels: {} }, NetworkSettings: { Networks: {} }, HostConfig: {} });
        }
        if (action === 'start') {
          if (app !== undefined) app.running = true;
          calls.push(`start ${helper === undefined ? id : 'helper'}`);
          return empty();
        }
        if (action === 'stop') {
          if (app !== undefined) app.running = false;
          calls.push(`stop ${id}`);
          return empty();
        }
        if (action === 'pause' || action === 'unpause') {
          if (app === undefined) return json(404, { message: 'No such container' });
          if (action === 'unpause' && !app.paused) return json(409, { message: `Container ${id} is not paused` });
          app.paused = action === 'pause';
          calls.push(`${action} ${id}`);
          return empty();
        }
        if (helper === undefined) return json(404, { message: 'No such container' });
        const files = volumes.get(helper.volume)!;
        if (action === 'archive' && method === 'GET') {
          assert.equal(url.searchParams.get('path'), '/volume');
          calls.push('archive out');
          res.setHeader('content-type', 'application/x-tar');
          return res.end(createTar([...files].map(([name, content]) => ({ name: `volume/${name}`, content }))));
        }
        if (action === 'archive' && method === 'PUT') {
          assert.equal(helper.mode, 'rw', 'files go back through a writable mount');
          assert.equal(url.searchParams.get('copyUIDGID'), 'true', 'owners are kept');
          let body = Buffer.concat(chunks);
          if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body);
          calls.push('archive in');
          if (faults.failUpload) {
            faults.failUpload = false;
            return json(500, { message: 'no space left on device' });
          }
          for (const entry of readTar(body)) files.set(entry.name.replace(/^volume\//, ''), entry.content.toString('utf8'));
          return empty(200);
        }
        if (action === 'exec') {
          const spec = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { Cmd: string[] };
          const execId = `exec${++nextId}`;
          execs.set(execId, { container: id, cmd: spec.Cmd });
          return json(201, { Id: execId });
        }
      }
      match = /^\/exec\/([^/]+)\/(start|json)$/.exec(path);
      if (match !== null) {
        const exec = execs.get(match[1]!)!;
        const files = volumes.get(helpers.get(exec.container)!.volume)!;
        if (match[2] === 'json') return json(200, { ExitCode: 0, Running: false });
        let out = '';
        if (exec.cmd[0] === 'find') {
          files.clear();
          calls.push('empty');
        } else if (exec.cmd[0] === 'ls') {
          out = [...new Set([...files.keys()].map((name) => name.split('/')[0]))].join('\n');
        }
        res.setHeader('content-type', 'application/vnd.docker.raw-stream');
        return res.end(out.length === 0 ? Buffer.alloc(0) : frame(1, `${out}\n`));
      }
      match = /^\/containers\/([^/]+)$/.exec(path);
      if (match !== null && method === 'DELETE') {
        helpers.delete(decodeURIComponent(match[1]!));
        calls.push('remove helper');
        return empty();
      }
      json(404, { message: `fake daemon: unhandled ${method} ${path}` });
    });
  });
  await new Promise<void>((resolve) => daemon.listen(dockerSocket, resolve));

  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket, logLevel: 'error' });
  ctx.proxy.requestSync = async () => undefined;
  const { stores } = ctx;
  const local = stores.servers.ensureLocal('local');
  const team = stores.teams.create('Acme');
  const member = (email: string, role: 'viewer' | 'developer' | 'admin' | 'owner'): string => {
    const user = stores.users.create({ email, name: email.split('@')[0]!, passwordHash: null, isInstanceAdmin: false });
    stores.teams.addMember(team.id, user.id, role);
    return stores.tokens.create({ userId: user.id, teamId: team.id, name: 'test', expiresAt: null, tokenPrefix: API_TOKEN_PREFIX }).token;
  };
  const tokens = { admin: member('admin@acme.uz', 'admin'), developer: member('dev@acme.uz', 'developer'), viewer: member('viewer@acme.uz', 'viewer') };
  const project = stores.projects.create(team.id, 'Shop', null);
  const application = stores.applications.create({
    projectId: project.id,
    teamId: team.id,
    serverId: local.id,
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
  // Deployed: two running replicas from an active deployment.
  const deployment = stores.deployments.create({ application, trigger: 'manual', createdBy: null });
  stores.deployments.setImage(deployment.id, 'ploy/blog:1', 1_000);
  stores.deployments.setContainers(deployment.id, ['blog-1', 'blog-2'], 2368);
  stores.deployments.finish(deployment.id, 'succeeded');
  stores.applications.setActiveDeployment(application.id, deployment.id);
  stores.applications.setStatus(application.id, 'running');
  apps.set('blog-1', { running: true, paused: false });
  apps.set('blog-2', { running: true, paused: false });

  const app = createHttpApp(ctx);
  const call = async <T>(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await app.request(path, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, BINDINGS);
    return { status: response.status, body: (await response.json()) as T };
  };
  const raw = (token: string, path: string) => app.request(path, { headers: { authorization: `Bearer ${token}` } }, BINDINGS);
  /** Until the volume's newest backup is no longer running. */
  const settle = async (volumeId: string): Promise<VolumeBackupDto[]> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const list = (await call<VolumeBackupDto[]>(tokens.viewer, 'GET', `/api/applications/${application.id}/volumes/${volumeId}/backups`)).body;
      if (list.every((backup) => backup.status !== 'running')) return list;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('backup never finished');
  };

  return {
    ctx,
    dir,
    application,
    tokens,
    volumes,
    helpers,
    apps,
    calls,
    faults,
    call,
    raw,
    settle,
    close: async () => {
      await ctx.deployer.shutdown();
      await ctx.connections.closeAll();
      stores.db.close();
      daemon.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a volume is copied through a helper container, paused for when asked, kept as many as it says, and its settings are checked', async () => {
  const h = await harness();
  try {
    const base = `/api/applications/${h.application.id}/volumes`;
    const created = await h.call<VolumeDto>(h.tokens.developer, 'POST', base, { name: 'content', mountPath: '/var/lib/ghost/content' });
    assert.equal(created.status, 201);
    const volume = created.body;
    assert.deepEqual([volume.backupSchedule, volume.backupRetention, volume.backupPause, volume.lastBackup, volume.backupCount], [null, 7, false, null, 0]);

    // Never deployed with it: Docker has no such volume yet, and none is made by asking.
    const early = await h.call<VolumeBackupDto>(h.tokens.developer, 'POST', `${base}/${volume.id}/backups`);
    assert.equal(early.status, 202);
    const [missing] = await h.settle(volume.id);
    assert.equal(missing!.status, 'failed');
    assert.match(missing!.errorMessage ?? '', /does not exist on the server yet/);
    assert.equal(h.calls.length, 0, 'no helper was made');

    const record = h.ctx.stores.volumes.get(volume.id)!;
    h.volumes.set(record.dockerVolume, new Map([['images/2026/logo.png', 'PNG'], ['data/ghost.db', 'SQLite v1']]));

    // A copy: a read-only helper, the files streamed out, the helper removed. Not paused: not asked to be.
    assert.equal((await h.call(h.tokens.viewer, 'POST', `${base}/${volume.id}/backups`)).status, 403);
    assert.equal((await h.call(h.tokens.developer, 'POST', `${base}/${volume.id}/backups`)).status, 202);
    const [first] = await h.settle(volume.id);
    assert.equal(first!.status, 'succeeded', first!.errorMessage ?? '');
    assert.equal(first!.trigger, 'manual');
    assert.ok(first!.sizeBytes! > 0 && first!.rawBytes! > first!.sizeBytes!, 'gzipped');
    assert.equal(first!.onServer, true);
    assert.deepEqual(h.calls, ['create ro', 'start helper', 'archive out', 'remove helper']);
    assert.equal(h.helpers.size, 0);
    const listed = (await h.call<VolumeDto[]>(h.tokens.viewer, 'GET', base)).body[0]!;
    assert.deepEqual([listed.lastBackup?.id, listed.backupCount], [first!.id, 1]);

    // The archive downloads as the gzipped tar it is (administrators only), with the files under volume/.
    assert.equal((await h.raw(h.tokens.developer, `${base}/${volume.id}/backups/${first!.id}/download`)).status, 403);
    const download = await h.raw(h.tokens.admin, `${base}/${volume.id}/backups/${first!.id}/download`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition') ?? '', /attachment; filename="blog-content-.*\.tar\.gz"/);
    const files = readTar(gunzipSync(Buffer.from(await download.arrayBuffer()))).map((entry) => `${entry.name}=${entry.content.toString()}`);
    assert.deepEqual(files.sort(), ['volume/data/ghost.db=SQLite v1', 'volume/images/2026/logo.png=PNG']);

    // Settings: a schedule (checked), retention, pausing; developers may set them, viewers may not.
    assert.equal((await h.call(h.tokens.viewer, 'PATCH', `${base}/${volume.id}`, { backupPause: true })).status, 403);
    const invalid = await h.call<ApiErrorBody>(h.tokens.developer, 'PATCH', `${base}/${volume.id}`, { backupSchedule: 'every morning' });
    assert.deepEqual([invalid.status, invalid.body.error.issues?.[0]?.path], [422, 'backupSchedule']);
    const unknown = await h.call<ApiErrorBody>(h.tokens.developer, 'PATCH', `${base}/${volume.id}`, { backupDestinationId: 's3d_nowhere' });
    assert.equal(unknown.status, 422);
    const set = await h.call<VolumeDto>(h.tokens.developer, 'PATCH', `${base}/${volume.id}`, { backupSchedule: '0 3 * * *', backupRetention: 2, backupPause: true });
    assert.equal(set.status, 200);
    assert.deepEqual([set.body.backupSchedule, set.body.backupRetention, set.body.backupPause], ['0 3 * * *', 2, true]);
    assert.ok(set.body.nextBackupAt !== null && Date.parse(set.body.nextBackupAt) > Date.now());

    // Paused for the copy: both replicas frozen before the files are read, resumed after.
    h.calls.length = 0;
    await h.call(h.tokens.developer, 'POST', `${base}/${volume.id}/backups`);
    await h.settle(volume.id);
    assert.deepEqual(h.calls, ['create ro', 'start helper', 'pause blog-1', 'pause blog-2', 'archive out', 'unpause blog-1', 'unpause blog-2', 'remove helper']);
    assert.ok([...h.apps.values()].every((container) => !container.paused));

    // One at a time.
    const running = h.ctx.stores.volumeBackups.create(h.ctx.stores.volumes.get(volume.id)!, 'manual');
    const busy = await h.call<ApiErrorBody>(h.tokens.developer, 'POST', `${base}/${volume.id}/backups`);
    assert.deepEqual([busy.status, busy.body.error.params?.reason], [409, 'backup_running']);
    h.ctx.stores.volumeBackups.finish(running.id, { status: 'failed', error: 'test' });

    // Retention 2: a third copy removes the oldest, file and all.
    const oldestFile = h.ctx.volumeBackups.file(h.ctx.stores.volumeBackups.get(first!.id)!)!;
    assert.ok(existsSync(oldestFile));
    await h.call(h.tokens.developer, 'POST', `${base}/${volume.id}/backups`);
    const kept = (await h.settle(volume.id)).filter((backup) => backup.status === 'succeeded');
    assert.equal(kept.length, 2);
    assert.ok(!kept.some((backup) => backup.id === first!.id));
    assert.ok(!existsSync(oldestFile), 'its file went with it');

    // A restart in the middle of a paused copy: the backup is failed, the containers resumed.
    h.apps.get('blog-1')!.paused = true;
    const cut = h.ctx.stores.volumeBackups.create(h.ctx.stores.volumes.get(volume.id)!, 'schedule');
    h.ctx.stores.volumeBackups.setPaused(cut.id, ['blog-1']);
    await h.ctx.volumeBackups.recover();
    assert.equal(h.apps.get('blog-1')!.paused, false);
    assert.equal(h.ctx.stores.volumeBackups.get(cut.id)!.status, 'failed');

    // The scheduler starts one when its time comes (and only for a deployed application).
    const scheduled = h.ctx.stores.volumes.get(volume.id)!;
    h.ctx.maintenance.runBackups(new Date('2026-11-22T02:00:00Z'));
    h.ctx.maintenance.runBackups(new Date('2026-11-23T03:00:30Z'));
    const after = await h.settle(scheduled.id);
    assert.equal(after[0]!.trigger, 'schedule');
    assert.equal(after[0]!.status, 'succeeded');
  } finally {
    await h.close();
  }
});

test('a restore stops the application, keeps a copy of what it replaces, starts it again, and puts the files back when it fails', async () => {
  const h = await harness();
  try {
    const base = `/api/applications/${h.application.id}/volumes`;
    const volume = (await h.call<VolumeDto>(h.tokens.developer, 'POST', base, { name: 'content', mountPath: '/data' })).body;
    const docker = h.ctx.stores.volumes.get(volume.id)!.dockerVolume;
    h.volumes.set(docker, new Map([['posts.json', '["first"]']]));
    await h.call(h.tokens.developer, 'POST', `${base}/${volume.id}/backups`);
    const [good] = await h.settle(volume.id);
    assert.equal(good!.status, 'succeeded');

    // Later the files change; the restore brings back the backup's.
    h.volumes.set(docker, new Map([['posts.json', '["first","second"]'], ['junk.tmp', 'x']]));
    assert.equal((await h.call(h.tokens.developer, 'POST', `${base}/${volume.id}/backups/${good!.id}/restore`)).status, 403);
    h.calls.length = 0;
    const restored = await h.call<{ ok: boolean; safetyBackup: VolumeBackupDto }>(h.tokens.admin, 'POST', `${base}/${volume.id}/backups/${good!.id}/restore`);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual([...h.volumes.get(docker)!], [['posts.json', '["first"]']], 'exactly the backup: what came after is gone');
    assert.deepEqual(h.calls, [
      'stop blog-1',
      'stop blog-2',
      'create ro',
      'start helper',
      'archive out',
      'remove helper',
      'create rw',
      'start helper',
      'empty',
      'archive in',
      'remove helper',
      'start blog-1',
      'start blog-2',
    ]);
    assert.equal(h.ctx.stores.applications.get(h.application.id)!.status, 'running', 'started again');

    // The copy it took first is a backup like any other: restoring it undoes the restore.
    const safety = restored.body.safetyBackup;
    assert.deepEqual([safety.trigger, safety.status], ['before_restore', 'succeeded']);
    await h.call(h.tokens.admin, 'POST', `${base}/${volume.id}/backups/${safety.id}/restore`);
    assert.deepEqual(new Map(h.volumes.get(docker)!), new Map([['posts.json', '["first","second"]'], ['junk.tmp', 'x']]));

    // Unpacking fails half way: the files that were there are put back, and the application runs again.
    h.faults.failUpload = true;
    const failed = await h.call<ApiErrorBody>(h.tokens.admin, 'POST', `${base}/${volume.id}/backups/${good!.id}/restore`);
    assert.deepEqual([failed.status, failed.body.error.params?.reason], [400, 'restore_failed']);
    assert.deepEqual(new Map(h.volumes.get(docker)!), new Map([['posts.json', '["first","second"]'], ['junk.tmp', 'x']]), 'as it was');
    assert.equal(h.ctx.stores.applications.get(h.application.id)!.status, 'running');

    // A stopped application stays stopped.
    h.ctx.stores.applications.setStatus(h.application.id, 'stopped');
    h.calls.length = 0;
    await h.call(h.tokens.admin, 'POST', `${base}/${volume.id}/backups/${good!.id}/restore`);
    assert.ok(!h.calls.some((line) => line.startsWith('start blog')), 'not started');
    assert.equal(h.ctx.stores.applications.get(h.application.id)!.status, 'stopped');

    // Restore copies are kept apart from the volume's own retention, three at most.
    const copies = (await h.settle(volume.id)).filter((backup) => backup.trigger === 'before_restore' && backup.status === 'succeeded');
    assert.ok(copies.length <= 3);

    // Deleting: administrators, not while it runs; deleting the volume with its data removes the files on the server.
    assert.equal((await h.call(h.tokens.developer, 'DELETE', `${base}/${volume.id}/backups/${good!.id}`)).status, 403);
    assert.equal((await h.call(h.tokens.admin, 'DELETE', `${base}/${volume.id}/backups/${good!.id}`)).status, 200);
    assert.equal(h.ctx.stores.volumeBackups.get(good!.id), undefined);
    const dir = h.ctx.volumeBackups.dir(volume.id);
    assert.ok(existsSync(dir));
    assert.equal((await h.call(h.tokens.admin, 'DELETE', `${base}/${volume.id}?removeData=true`)).status, 200);
    assert.ok(!existsSync(dir));
  } finally {
    await h.close();
  }
});
