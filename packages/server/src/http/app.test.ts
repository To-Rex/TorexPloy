/**
 * Team-wide lists, container registries and pull request previews through
 * the real HTTP stack (auth, roles, validation, error mapping, signed
 * webhooks), with an Engine API double that answers `POST /auth` the way a
 * registry login does and lists and removes the containers it is given.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HttpBindings } from '@hono/node-server';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_TOKEN_PREFIX,
  type ApiErrorBody,
  type ApplicationDto,
  type DeploymentDto,
  type OverviewDto,
  type Page,
  type PlatformEvent,
  type PreviewDto,
  type PreviewSettingsDto,
  type ProjectDto,
  type RegistryDto,
  type ServerDto,
  type TeamCronJobDto,
  type TeamDeploymentDto,
} from '@ploy/shared';
import { generateToken, hmac } from '../lib/crypto.ts';
import { createContext } from '../main.ts';
import type { ApplicationRecord } from '../store/index.ts';
import { createHttpApp } from './app.ts';

/** What the request handlers read from the Node binding: the peer address. */
const BINDINGS = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as unknown as HttpBindings;

const WEBHOOK_SECRET = 'webhook-secret-for-the-tests';

async function harness(options: { docker?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-http-'));
  const dockerSocket = join(dir, 'docker.sock');
  /** Logins the fake registry accepts (username → password). */
  const logins = new Map<string, string>([['robot', 'right-password']]);
  const authCalls: { username: string; password: string; serveraddress: string }[] = [];
  /** Containers the daemon lists (label filters honoured), and the ids removed through it. */
  const containers: { Id: string; Names: string[]; Image: string; Labels: Record<string, string>; State: string; Status: string; Created: number }[] = [];
  const removedContainers: string[] = [];
  const daemon = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://docker');
      const path = url.pathname.replace(/^\/v1\.\d+/, '');
      res.setHeader('content-type', 'application/json');
      if (path === '/containers/json') {
        const labels = ((JSON.parse(url.searchParams.get('filters') ?? '{}') as { label?: string[] }).label ?? []).map((label) => label.split('='));
        return void res.end(JSON.stringify(containers.filter((container) => labels.every(([key, value]) => container.Labels[key!] === value))));
      }
      const container = /^\/containers\/([^/]+)$/.exec(path);
      if (container !== null && req.method === 'DELETE') {
        const index = containers.findIndex((item) => item.Id === decodeURIComponent(container[1]!));
        if (index !== -1) removedContainers.push(...containers.splice(index, 1).map((item) => item.Id));
        res.statusCode = 204;
        res.removeHeader('content-type');
        return void res.end();
      }
      if (path === '/images/json') return void res.end('[]');
      if (path === '/version') return void res.end(JSON.stringify({ Version: '28.0.1', ApiVersion: '1.47', Os: 'linux', Arch: 'amd64' }));
      if (path === '/auth' && req.method === 'POST') {
        const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { username: string; password: string; serveraddress: string };
        authCalls.push(credentials);
        if (logins.get(credentials.username) === credentials.password) return void res.end(JSON.stringify({ Status: 'Login Succeeded' }));
        res.statusCode = 401;
        return void res.end(JSON.stringify({ message: `login attempt to https://${credentials.serveraddress}/v2/ failed with status: 401 Unauthorized` }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: `fake daemon: unhandled ${req.method} ${path}` }));
    });
  });
  if (options.docker !== false) await new Promise<void>((resolve) => daemon.listen(dockerSocket, resolve));

  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket, logLevel: 'error' });
  const { stores } = ctx;
  const local = stores.servers.ensureLocal('local');

  const member = (teamId: string, email: string, role: 'viewer' | 'developer' | 'admin' | 'owner'): string => {
    const user = stores.users.create({ email, name: email.split('@')[0]!, passwordHash: null, isInstanceAdmin: false });
    stores.teams.addMember(teamId, user.id, role);
    return stores.tokens.create({ userId: user.id, teamId, name: 'test', expiresAt: null, tokenPrefix: API_TOKEN_PREFIX }).token;
  };
  /** A GitHub-source application of `acme/shop` through installation 42. */
  const githubApp = (teamId: string, projectId: string, name: string, options: { branch?: string; kind?: 'web' | 'worker'; installationId?: number } = {}): ApplicationRecord =>
    stores.applications.create({
      projectId,
      teamId,
      serverId: local.id,
      name,
      slug: stores.projects.uniqueResourceSlug(projectId, name, 'app'),
      kind: options.kind ?? 'web',
      sourceType: 'github',
      githubInstallationId: options.installationId ?? 42,
      repository: 'acme/shop',
      gitUrl: null,
      branch: options.branch ?? 'main',
      image: null,
      sealedHookToken: ctx.secrets.seal(generateToken(), 'hook'),
    });
  const application = (teamId: string, projectId: string, name: string, kind: 'web' | 'worker', image: string): ApplicationRecord =>
    stores.applications.create({
      projectId,
      teamId,
      serverId: local.id,
      name,
      slug: stores.projects.uniqueResourceSlug(projectId, name, 'app'),
      kind,
      sourceType: 'image',
      githubInstallationId: null,
      repository: null,
      gitUrl: null,
      branch: null,
      image,
      sealedHookToken: ctx.secrets.seal(generateToken(), 'hook'),
    });

  const teamA = stores.teams.create('Acme');
  const teamB = stores.teams.create('Rival');
  const tokens = {
    owner: member(teamA.id, 'owner@acme.uz', 'owner'),
    developer: member(teamA.id, 'dev@acme.uz', 'developer'),
    viewer: member(teamA.id, 'viewer@acme.uz', 'viewer'),
    rival: member(teamB.id, 'owner@rival.uz', 'owner'),
  };

  const app = createHttpApp(ctx);
  const call = async <T>(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await app.request(
      path,
      {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      BINDINGS,
    );
    return { status: response.status, body: (await response.json()) as T };
  };

  /** Connect a GitHub App (installation 42 on team A) whose webhooks are signed with WEBHOOK_SECRET. */
  const connectGithub = (): void => {
    stores.settings.setRaw(
      'github.app',
      ctx.secrets.sealJson(
        {
          baseUrl: 'https://panel.example.uz',
          appId: 1,
          slug: 'torexploy-test',
          name: 'TorexPloy test',
          htmlUrl: 'https://github.com/apps/torexploy-test',
          owner: 'acme',
          clientId: 'Iv1.test',
          clientSecret: 'client-secret',
          webhookSecret: WEBHOOK_SECRET,
          privateKey: 'not a key: nothing in these tests may call GitHub',
        },
        'github',
      ),
    );
    stores.installations.upsert({ id: 42, teamId: teamA.id, accountLogin: 'acme', accountType: 'Organization', avatarUrl: null, repositorySelection: 'all' });
  };

  /** Deliver a webhook the way GitHub does: raw JSON signed with HMAC-SHA256. */
  const webhook = async (event: string, payload: unknown, signature?: string): Promise<{ status: number; body: { ok?: boolean; result?: string } & Partial<ApiErrorBody> }> => {
    const raw = JSON.stringify(payload);
    const response = await app.request(
      '/api/webhooks/github',
      { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': signature ?? `sha256=${hmac(WEBHOOK_SECRET, raw)}` }, body: raw },
      BINDINGS,
    );
    return { status: response.status, body: (await response.json()) as { ok?: boolean; result?: string } & Partial<ApiErrorBody> };
  };

  return {
    ctx,
    local,
    teamA,
    teamB,
    tokens,
    logins,
    authCalls,
    containers,
    removedContainers,
    application,
    githubApp,
    call,
    connectGithub,
    webhook,
    close: async () => {
      ctx.domains.stop();
      await ctx.deployer.shutdown();
      await ctx.connections.closeAll();
      stores.db.close();
      daemon.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('GET /api/deployments pages the whole team newest first, filters by status, and stays inside the team', async () => {
  const h = await harness();
  try {
    const { stores } = h.ctx;
    const shop = stores.projects.create(h.teamA.id, 'Shop', null);
    const web = h.application(h.teamA.id, shop.id, 'Web', 'web', 'nginx:alpine');
    const jobs = h.application(h.teamA.id, shop.id, 'Jobs', 'worker', 'busybox');
    const rivalProject = stores.projects.create(h.teamB.id, 'Rival', null);
    const rivalApp = h.application(h.teamB.id, rivalProject.id, 'Rival', 'web', 'nginx:alpine');

    const deploy = (application: ApplicationRecord, day: number): string => {
      const id = stores.deployments.create({ application, trigger: 'manual', createdBy: null }).id;
      stores.db.run('UPDATE deployments SET created_at = ? WHERE id = ?', `2026-03-0${day}T00:00:00.000Z`, id);
      return id;
    };
    const oldest = deploy(web, 1);
    const failed = deploy(jobs, 2);
    const building = deploy(web, 3);
    const newest = deploy(jobs, 4);
    deploy(rivalApp, 5);
    stores.deployments.finish(oldest, 'succeeded');
    stores.deployments.finish(failed, 'failed', 'boom', 'crash');
    stores.deployments.markStarted(building);

    const all = await h.call<Page<TeamDeploymentDto>>(h.tokens.viewer, 'GET', '/api/deployments');
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.items.map((item) => item.id), [newest, building, failed, oldest]);
    assert.equal(all.body.nextCursor, null);
    const first = all.body.items[0]!;
    assert.equal(first.applicationName, 'Jobs');
    assert.equal(first.applicationKind, 'worker');
    assert.equal(first.projectName, 'Shop');
    assert.equal(first.applicationId, jobs.id);

    const page1 = await h.call<Page<TeamDeploymentDto>>(h.tokens.viewer, 'GET', '/api/deployments?limit=3');
    assert.equal(page1.body.items.length, 3);
    assert.ok(page1.body.nextCursor !== null);
    const page2 = await h.call<Page<TeamDeploymentDto>>(h.tokens.viewer, 'GET', `/api/deployments?limit=3&cursor=${page1.body.nextCursor}`);
    assert.deepEqual(page2.body.items.map((item) => item.id), [oldest]);
    assert.equal(page2.body.nextCursor, null);

    const active = await h.call<Page<TeamDeploymentDto>>(h.tokens.viewer, 'GET', '/api/deployments?status=active');
    assert.deepEqual(active.body.items.map((item) => item.id), [newest, building]);
    const onlyFailed = await h.call<Page<TeamDeploymentDto>>(h.tokens.viewer, 'GET', '/api/deployments?status=failed');
    assert.deepEqual(onlyFailed.body.items.map((item) => item.id), [failed]);
    const invalid = await h.call<ApiErrorBody>(h.tokens.viewer, 'GET', '/api/deployments?status=running');
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.error.code, 'validation_failed');

    const rival = await h.call<Page<TeamDeploymentDto>>(h.tokens.rival, 'GET', '/api/deployments');
    assert.deepEqual(rival.body.items.map((item) => item.applicationName), ['Rival']);

    // The detail route still resolves next to the list, and carries the same shape.
    const detail = await h.call<TeamDeploymentDto>(h.tokens.viewer, 'GET', `/api/deployments/${failed}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.applicationKind, 'worker');
    assert.equal(detail.body.errorCode, 'crash');
    assert.equal((await h.call(h.tokens.rival, 'GET', `/api/deployments/${failed}`)).status, 404);

    const overview = await h.call<{ recentDeployments: TeamDeploymentDto[] }>(h.tokens.viewer, 'GET', '/api/overview');
    assert.deepEqual(overview.body.recentDeployments.map((item) => [item.applicationName, item.applicationKind, item.projectName])[0], ['Jobs', 'worker', 'Shop']);
  } finally {
    await h.close();
  }
});

test('GET /api/cron lists every scheduled job of the team with where it runs', async () => {
  const h = await harness();
  try {
    const { stores } = h.ctx;
    const shop = stores.projects.create(h.teamA.id, 'Shop', null);
    const billing = stores.projects.create(h.teamA.id, 'Billing', null);
    const web = h.application(h.teamA.id, shop.id, 'Web', 'web', 'nginx:alpine');
    const invoices = h.application(h.teamA.id, billing.id, 'Invoices', 'worker', 'busybox');
    const rivalProject = stores.projects.create(h.teamB.id, 'Rival', null);
    const rivalApp = h.application(h.teamB.id, rivalProject.id, 'Rival', 'web', 'nginx:alpine');
    const job = (application: ApplicationRecord, name: string, enabled = true) =>
      stores.cron.create({ applicationId: application.id, name, schedule: '*/5 * * * *', command: 'echo hi', enabled, timeoutSec: 60, nextRunAt: enabled ? '2026-03-01T00:05:00.000Z' : null });
    job(web, 'sitemap');
    job(web, 'cache warmup', false);
    job(invoices, 'send reminders');
    job(rivalApp, 'rival job');

    const list = await h.call<TeamCronJobDto[]>(h.tokens.viewer, 'GET', '/api/cron');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((item) => [item.projectName, item.applicationName, item.name]), [
      ['Billing', 'Invoices', 'send reminders'],
      ['Shop', 'Web', 'cache warmup'],
      ['Shop', 'Web', 'sitemap'],
    ]);
    const sitemap = list.body[2]!;
    assert.equal(sitemap.applicationId, web.id);
    assert.equal(sitemap.projectId, shop.id);
    assert.equal(sitemap.serverName, 'local');
    assert.equal(sitemap.nextRunAt, '2026-03-01T00:05:00.000Z');
    assert.equal(list.body[1]!.nextRunAt, null, 'a disabled job has no next run');
    assert.equal(sitemap.lastRun, null);

    const rival = await h.call<TeamCronJobDto[]>(h.tokens.rival, 'GET', '/api/cron');
    assert.deepEqual(rival.body.map((item) => item.name), ['rival job']);
  } finally {
    await h.close();
  }
});

test('registries: admins add verified credentials, never read them back, and other teams never see them', async () => {
  const h = await harness();
  try {
    const { stores } = h.ctx;
    const shop = stores.projects.create(h.teamA.id, 'Shop', null);
    const web = h.application(h.teamA.id, shop.id, 'Web', 'web', 'ghcr.io/acme/web:1.0');
    h.application(h.teamA.id, shop.id, 'Proxy', 'web', 'nginx:alpine');
    const input = { name: 'GitHub', serverAddress: 'https://GHCR.io/', username: 'robot', password: 'right-password' };

    assert.equal((await h.call(h.tokens.developer, 'POST', '/api/registries', input)).status, 403, 'developers cannot add credentials');

    const rejected = await h.call<ApiErrorBody>(h.tokens.owner, 'POST', '/api/registries', { ...input, password: 'wrong' });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error.code, 'registry_auth_failed');
    assert.match(rejected.body.error.message, /401 Unauthorized/);
    assert.equal(stores.registries.listForTeam(h.teamA.id).length, 0, 'nothing is saved when the login fails');

    const created = await h.call<RegistryDto>(h.tokens.owner, 'POST', '/api/registries', input);
    assert.equal(created.status, 201);
    assert.equal(created.body.serverAddress, 'ghcr.io', 'scheme, case and trailing slash are normalized');
    assert.equal(created.body.username, 'robot');
    assert.ok(!JSON.stringify(created.body).includes('right-password'), 'the password never comes back');
    assert.deepEqual(created.body.applications, [{ id: web.id, name: 'Web' }]);
    assert.deepEqual(h.authCalls.at(-1), { username: 'robot', password: 'right-password', serveraddress: 'ghcr.io' });

    const duplicate = await h.call<ApiErrorBody>(h.tokens.owner, 'POST', '/api/registries', { ...input, name: 'Again' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'registry_exists');

    const hub = await h.call<RegistryDto>(h.tokens.owner, 'POST', '/api/registries', { ...input, name: 'Hub', serverAddress: 'index.docker.io' });
    assert.equal(hub.body.serverAddress, 'docker.io');
    assert.equal(h.authCalls.at(-1)!.serveraddress, 'https://index.docker.io/v1/', 'Docker Hub logins use the v1 index URL');
    assert.deepEqual(hub.body.applications.map((item) => item.name), ['Proxy']);

    const listed = await h.call<RegistryDto[]>(h.tokens.developer, 'GET', '/api/registries');
    assert.deepEqual(listed.body.map((item) => item.serverAddress), ['ghcr.io', 'docker.io']);
    assert.deepEqual((await h.call<RegistryDto[]>(h.tokens.rival, 'GET', '/api/registries')).body, []);
    assert.equal((await h.call(h.tokens.viewer, 'GET', '/api/registries')).status, 403);

    const id = created.body.id;
    const calls = h.authCalls.length;
    const renamed = await h.call<RegistryDto>(h.tokens.owner, 'PATCH', `/api/registries/${id}`, { name: 'GitHub Packages' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'GitHub Packages');
    assert.equal(h.authCalls.length, calls, 'a rename does not log in again');

    const badPassword = await h.call<ApiErrorBody>(h.tokens.owner, 'PATCH', `/api/registries/${id}`, { password: 'nope' });
    assert.equal(badPassword.body.error.code, 'registry_auth_failed');
    assert.equal(stores.registries.get(id)!.password, 'right-password', 'a rejected change keeps the working credentials');
    const moved = await h.call<ApiErrorBody>(h.tokens.owner, 'PATCH', `/api/registries/${id}`, { serverAddress: 'docker.io' });
    assert.equal(moved.body.error.code, 'registry_exists');

    h.logins.set('robot', 'rotated-password');
    const rotated = await h.call<RegistryDto>(h.tokens.owner, 'PATCH', `/api/registries/${id}`, { password: 'rotated-password' });
    assert.equal(rotated.status, 200);
    assert.equal(stores.registries.get(id)!.password, 'rotated-password');

    assert.deepEqual((await h.call(h.tokens.owner, 'POST', `/api/registries/${id}/test`)).body, { ok: true, error: null });
    h.logins.delete('robot');
    const revoked = await h.call<{ ok: boolean; error: string | null }>(h.tokens.owner, 'POST', `/api/registries/${id}/test`);
    assert.equal(revoked.body.ok, false);
    assert.match(revoked.body.error ?? '', /401 Unauthorized/);

    assert.equal((await h.call(h.tokens.rival, 'PATCH', `/api/registries/${id}`, { name: 'Mine now' })).status, 404);
    assert.equal((await h.call(h.tokens.rival, 'DELETE', `/api/registries/${id}`)).status, 404);
    assert.equal((await h.call(h.tokens.developer, 'DELETE', `/api/registries/${id}`)).status, 403);

    assert.deepEqual((await h.call(h.tokens.owner, 'DELETE', `/api/registries/${id}`)).body, { ok: true });
    assert.equal(stores.applications.get(web.id)!.image, 'ghcr.io/acme/web:1.0', 'applications keep their image reference');
    assert.deepEqual((await h.call<RegistryDto[]>(h.tokens.owner, 'GET', '/api/registries')).body.map((item) => item.name), ['Hub']);

    const audit = stores.db.all("SELECT action FROM audit_log WHERE action LIKE 'registry.%' ORDER BY created_at").map((row) => String(row.action));
    assert.deepEqual(audit, ['registry.created', 'registry.created', 'registry.updated', 'registry.updated', 'registry.deleted']);
    assert.ok(stores.db.all('SELECT metadata FROM audit_log').every((row) => !/right-password|rotated-password/.test(String(row.metadata))), 'no secret reaches the audit log');
  } finally {
    await h.close();
  }
});

test('registry credentials cannot be checked without Docker: docker_unavailable, nothing saved', async () => {
  const h = await harness({ docker: false });
  try {
    const response = await h.call<ApiErrorBody>(h.tokens.owner, 'POST', '/api/registries', { name: 'GitHub', serverAddress: 'ghcr.io', username: 'robot', password: 'right-password' });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'docker_unavailable');
    assert.equal(h.ctx.stores.registries.listForTeam(h.teamA.id).length, 0);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Pull request previews
// ---------------------------------------------------------------------------

/** A 40-character commit id derived from `n`. */
const sha = (n: number): string => String(n).padStart(40, 'c');

/** A `pull_request` delivery as GitHub sends it (the fields previews read). */
function pullRequestEvent(action: string, number: number, options: { head?: string; base?: string; title?: string; fork?: boolean; installation?: number } = {}) {
  return {
    action,
    number,
    installation: { id: options.installation ?? 42 },
    sender: { login: 'dilnoza' },
    repository: { full_name: 'acme/shop' },
    pull_request: {
      number,
      title: options.title ?? `Feature ${number}`,
      html_url: `https://github.com/acme/shop/pull/${number}`,
      user: { login: 'aziz' },
      head: { ref: `feature/${number}`, sha: options.head ?? sha(number), repo: { full_name: options.fork === true ? 'stranger/shop' : 'acme/shop' } },
      base: { ref: options.base ?? 'main', repo: { full_name: 'acme/shop' } },
    },
  };
}

/** Deployments stay queued in these tests: they check what is enqueued, not what a build does. */
async function previewHarness() {
  const h = await harness();
  await h.ctx.deployer.shutdown();
  h.connectGithub();
  h.ctx.stores.settings.updatePlatform({ appsDomain: 'apps.example.uz' });
  return h;
}

test('pull request webhooks: opened creates and deploys a preview, synchronize refreshes and redeploys it, closed removes it', async () => {
  const h = await previewHarness();
  try {
    const { stores } = h.ctx;
    const events: PlatformEvent[] = [];
    h.ctx.bus.onTeamEvent(({ event }) => events.push(event));
    const shop = stores.projects.create(h.teamA.id, 'Shop', null);
    const web = h.githubApp(h.teamA.id, shop.id, 'Web');
    stores.applications.update(web.id, { port: 3000, healthCheckPath: '/health', cpuLimit: 0.5, memoryLimitMb: 256, replicas: 3, strategy: 'recreate', buildType: 'dockerfile', dockerfilePath: 'docker/Dockerfile' });
    stores.env.replace({ applicationId: web.id }, [{ key: 'DATABASE_URL', value: 'postgres://parent' }, { key: 'KEEP', value: '1' }]);
    const db = stores.services.create({
      id: 'svc_previewtest0001',
      projectId: shop.id,
      teamId: h.teamA.id,
      serverId: h.local.id,
      name: 'db',
      slug: 'db',
      type: 'postgres',
      version: '17',
      credentials: { username: 'app', password: 'db-password', database: 'app' },
      internalPort: 5432,
      containerName: 'ploy-db-previewtest',
      volumeName: 'ploy-data-previewtest',
      memoryLimitMb: null,
    });
    stores.links.create(web.id, db.id, 'MAIN_');

    const enabled = await h.call<ApplicationDto>(h.tokens.developer, 'PATCH', `/api/applications/${web.id}`, {
      previewsEnabled: true,
      previewLimit: 2,
      previewEnv: 'DATABASE_URL=postgres://preview\n# previews only\nEXTRA="two words"',
    });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.previewsEnabled, true);
    assert.equal(enabled.body.previewLimit, 2);
    assert.equal(enabled.body.parentApplicationId, null);
    assert.equal(enabled.body.pullRequest, null);
    assert.ok(!String(stores.db.scalar('SELECT preview_env_sealed FROM applications WHERE id = ?', web.id)).includes('postgres://preview'), 'preview variables are sealed at rest');
    const settings = await h.call<PreviewSettingsDto>(h.tokens.developer, 'GET', `/api/applications/${web.id}/preview-settings`);
    assert.deepEqual(settings.body, { enabled: true, limit: 2, env: 'DATABASE_URL=postgres://preview\n# previews only\nEXTRA="two words"', webhookReady: true });

    // Only GitHub can open previews: the signature is checked first.
    assert.equal((await h.webhook('pull_request', pullRequestEvent('opened', 7), 'sha256=0000')).status, 401);
    assert.equal(stores.applications.listPreviews(web.id).length, 0);

    const opened = await h.webhook('pull_request', pullRequestEvent('opened', 7));
    assert.equal(opened.status, 200);
    assert.equal(opened.body.result, 'queued 1 preview deployment(s)');
    const [preview] = stores.applications.listPreviews(web.id);
    assert.ok(preview);
    assert.equal(preview.name, 'Web-pr-7');
    assert.equal(preview.slug, 'web-pr-7');
    assert.deepEqual([preview.projectId, preview.serverId, preview.teamId], [shop.id, h.local.id, h.teamA.id]);
    assert.deepEqual([preview.sourceType, preview.githubInstallationId, preview.repository, preview.branch], ['github', 42, 'acme/shop', 'feature/7']);
    assert.deepEqual(
      [preview.buildType, preview.dockerfilePath, preview.port, preview.healthCheckPath, preview.cpuLimit, preview.memoryLimitMb, preview.replicas, preview.strategy, preview.autoDeploy],
      ['dockerfile', 'docker/Dockerfile', 3000, '/health', 0.5, 256, 1, 'rolling', false],
    );
    assert.deepEqual(stores.env.list({ applicationId: preview.id }), [
      { key: 'DATABASE_URL', value: 'postgres://preview' },
      { key: 'KEEP', value: '1' },
      { key: 'EXTRA', value: 'two words' },
    ]);
    assert.deepEqual(stores.links.listForApplication(preview.id).map((link) => [link.serviceId, link.prefix]), [[db.id, 'MAIN_']]);
    assert.deepEqual(stores.domains.listForApplication(preview.id).map((domain) => [domain.host, domain.isGenerated]), [['pr-7-web-shop.apps.example.uz', true]]);
    const [first] = stores.deployments.listOpen().filter((deployment) => deployment.applicationId === preview.id);
    assert.ok(first);
    assert.deepEqual([first.status, first.trigger, first.commitSha, first.commitMessage, first.commitAuthor, first.branch], ['queued', 'push', sha(7), 'Feature 7', 'dilnoza', 'feature/7']);
    assert.ok(events.some((event) => event.type === 'application.updated' && event.id === preview.id));
    assert.ok(events.some((event) => event.type === 'application.updated' && event.id === web.id), 'the parent refreshes its list of previews');
    assert.equal(stores.db.scalar("SELECT COUNT(*) FROM audit_log WHERE action = 'preview.created' AND target_id = ?", preview.id), 1);

    // The preview is an application: its own page, deployments and so on work by id.
    const detail = await h.call<ApplicationDto>(h.tokens.viewer, 'GET', `/api/applications/${preview.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.parentApplicationId, web.id);
    assert.deepEqual(detail.body.pullRequest, { number: 7, title: 'Feature 7', url: 'https://github.com/acme/shop/pull/7', author: 'aziz' });
    assert.equal(detail.body.url, 'https://pr-7-web-shop.apps.example.uz');
    assert.equal((await h.call<Page<DeploymentDto>>(h.tokens.viewer, 'GET', `/api/applications/${preview.id}/deployments`)).body.items.length, 1);

    const listed = await h.call<PreviewDto[]>(h.tokens.viewer, 'GET', `/api/applications/${web.id}/previews`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
    const item = listed.body[0]!;
    assert.deepEqual(
      [item.id, item.number, item.title, item.url, item.author, item.branch, item.status, item.appUrl, item.latestDeployment?.id],
      [preview.id, 7, 'Feature 7', 'https://github.com/acme/shop/pull/7', 'aziz', 'feature/7', 'queued', 'https://pr-7-web-shop.apps.example.uz', first.id],
    );

    // New commits: the same preview, refreshed from the parent, deploys the new head.
    stores.env.replace({ applicationId: web.id }, [{ key: 'DATABASE_URL', value: 'postgres://parent' }, { key: 'KEEP', value: '2' }]);
    const synchronized = await h.webhook('pull_request', pullRequestEvent('synchronize', 7, { head: sha(70), title: 'Feature 7, reworked' }));
    assert.equal(synchronized.body.result, 'queued 1 preview deployment(s)');
    assert.equal(stores.applications.listPreviews(web.id).length, 1);
    const refreshed = stores.applications.get(preview.id)!;
    assert.equal(refreshed.previewHeadSha, sha(70));
    assert.equal(refreshed.previewPrTitle, 'Feature 7, reworked');
    assert.equal(stores.env.list({ applicationId: preview.id }).find((variable) => variable.key === 'KEEP')?.value, '2');
    assert.equal(stores.deployments.get(first.id)!.status, 'cancelled', 'the older queued deployment is superseded');
    const [second] = stores.deployments.listOpen().filter((deployment) => deployment.applicationId === preview.id);
    assert.deepEqual([second?.trigger, second?.commitSha], ['push', sha(70)]);
    assert.equal(stores.domains.listForApplication(preview.id).length, 1, 'the address is kept');

    // Redeploy from the dashboard: the current head, as the developer who asked.
    assert.equal((await h.call(h.tokens.viewer, 'POST', `/api/applications/${web.id}/previews/${preview.id}/redeploy`)).status, 403);
    const redeployed = await h.call<DeploymentDto>(h.tokens.developer, 'POST', `/api/applications/${web.id}/previews/${preview.id}/redeploy`);
    assert.equal(redeployed.status, 202);
    assert.deepEqual([redeployed.body.applicationId, redeployed.body.trigger, redeployed.body.commitSha, redeployed.body.branch], [preview.id, 'manual', sha(70), 'feature/7']);
    assert.equal(redeployed.body.createdBy?.name, 'dev');

    // After a successful deployment the address goes on the pull request, in one comment kept up to date.
    const comments: [number, string, number, number | null, string][] = [];
    h.ctx.github.upsertIssueComment = async (installationId, repository, issue, commentId, body) => {
      comments.push([installationId, repository, issue, commentId, body]);
      return 9001;
    };
    await h.ctx.previews.commentDeployed(preview.id, redeployed.body.id);
    await h.ctx.previews.commentDeployed(preview.id, redeployed.body.id);
    assert.deepEqual(comments.map(([installationId, repository, issue, commentId]) => [installationId, repository, issue, commentId]), [
      [42, 'acme/shop', 7, null],
      [42, 'acme/shop', 7, 9001],
    ]);
    assert.match(comments[0]![4], /https:\/\/pr-7-web-shop\.apps\.example\.uz/);
    assert.match(comments[0]![4], new RegExp(`\`${sha(70).slice(0, 7)}\``));
    assert.match(comments[0]![4], new RegExp(`https://panel\\.example\\.uz/deployments/${redeployed.body.id}`));
    h.ctx.github.upsertIssueComment = async () => {
      throw new Error('GitHub is down');
    };
    await h.ctx.previews.commentDeployed(preview.id, redeployed.body.id);

    // Closing the pull request removes the preview: containers first, then every row.
    h.containers.push(
      { Id: 'c-preview', Names: ['/ploy-web-pr-7-x'], Image: 'img', Labels: { 'ploy.managed': 'true', 'ploy.role': 'app', 'ploy.app': preview.id }, State: 'running', Status: 'Up', Created: 0 },
      { Id: 'c-parent', Names: ['/ploy-web-x'], Image: 'img', Labels: { 'ploy.managed': 'true', 'ploy.role': 'app', 'ploy.app': web.id }, State: 'running', Status: 'Up', Created: 0 },
    );
    const closed = await h.webhook('pull_request', pullRequestEvent('closed', 7));
    assert.equal(closed.body.result, 'removed 1 preview(s)');
    assert.equal(stores.applications.get(preview.id), undefined);
    assert.equal(stores.db.scalar('SELECT COUNT(*) FROM deployments WHERE application_id = ?', preview.id), 0);
    assert.equal(stores.db.scalar('SELECT COUNT(*) FROM domains WHERE application_id = ?', preview.id), 0);
    assert.deepEqual(h.removedContainers, ['c-preview']);
    assert.ok(stores.applications.get(web.id), 'the parent stays');
    assert.ok(events.some((event) => event.type === 'application.deleted' && event.id === preview.id));
    assert.equal(stores.db.scalar("SELECT COUNT(*) FROM audit_log WHERE action = 'preview.deleted' AND target_id = ?", preview.id), 1);
    assert.deepEqual((await h.call<PreviewDto[]>(h.tokens.viewer, 'GET', `/api/applications/${web.id}/previews`)).body, []);
    assert.equal((await h.webhook('pull_request', pullRequestEvent('closed', 7))).body.result, 'removed 0 preview(s)', 'a repeated delivery is harmless');
  } finally {
    await h.close();
  }
});

test('pull request webhooks ignore forks, applications without previews or on another branch, and respect the preview limit', async () => {
  const h = await previewHarness();
  try {
    const { stores } = h.ctx;
    const shop = stores.projects.create(h.teamA.id, 'Shop', null);
    const web = h.githubApp(h.teamA.id, shop.id, 'Web');
    stores.applications.update(web.id, { previewsEnabled: true, previewLimit: 1 });
    const docs = h.githubApp(h.teamA.id, shop.id, 'Docs');
    const staging = h.githubApp(h.teamA.id, shop.id, 'Staging', { branch: 'develop' });
    stores.applications.update(staging.id, { previewsEnabled: true });
    const rivalProject = stores.projects.create(h.teamB.id, 'Rival', null);
    const rival = h.githubApp(h.teamB.id, rivalProject.id, 'Rival', { installationId: 43 });
    stores.applications.update(rival.id, { previewsEnabled: true });
    const previews = () => stores.db.all('SELECT parent_application_id, preview_pr_number FROM applications WHERE parent_application_id IS NOT NULL ORDER BY preview_pr_number').map((row) => [row.parent_application_id, row.preview_pr_number]);

    // A fork's code must not run with the repository's secrets.
    const fork = await h.webhook('pull_request', pullRequestEvent('opened', 1, { fork: true }));
    assert.equal(fork.status, 200);
    assert.equal(fork.body.result, 'ignored: pull request from a fork');
    assert.deepEqual(previews(), []);

    assert.equal((await h.webhook('pull_request', pullRequestEvent('opened', 2))).body.result, 'queued 1 preview deployment(s)');
    assert.deepEqual(previews(), [[web.id, 2]], 'Docs has previews off, Staging previews another branch, the rival another installation');
    assert.equal(stores.applications.listPreviews(docs.id).length + stores.applications.listPreviews(rival.id).length, 0);

    // Over the limit: skipped (and logged) until a preview closes.
    const over = await h.webhook('pull_request', pullRequestEvent('opened', 3));
    assert.equal(over.body.result, 'queued 0 preview deployment(s), 1 over the preview limit');
    assert.equal((await h.webhook('pull_request', pullRequestEvent('synchronize', 3, { head: sha(33) }))).body.result, 'queued 0 preview deployment(s), 1 over the preview limit');
    assert.deepEqual(previews(), [[web.id, 2]]);
    await h.webhook('pull_request', pullRequestEvent('closed', 2));
    assert.equal((await h.webhook('pull_request', pullRequestEvent('synchronize', 3, { head: sha(33) }))).body.result, 'queued 1 preview deployment(s)');
    assert.deepEqual(previews(), [[web.id, 3]]);

    // Into another base branch: that branch's application previews it.
    assert.equal((await h.webhook('pull_request', pullRequestEvent('opened', 4, { base: 'develop' }))).body.result, 'queued 1 preview deployment(s)');
    assert.deepEqual(previews(), [[web.id, 3], [staging.id, 4]]);

    // Other actions and events do nothing; previews never deploy on pushes.
    assert.equal((await h.webhook('pull_request', pullRequestEvent('labeled', 3))).body.result, 'ignored');
    const push = await h.webhook('push', { ref: 'refs/heads/feature/3', installation: { id: 42 }, repository: { full_name: 'acme/shop' }, head_commit: { id: sha(34), message: 'more', author: { name: 'Aziz' } } });
    assert.equal(push.body.result, 'queued 0 deployment(s)');
    assert.equal((await h.webhook('pull_request', pullRequestEvent('opened', 5, { installation: 99 }))).body.result, 'ignored: unknown installation');
    assert.equal(previews().length, 2);

    // Turning previews off stops new ones; closing still cleans up.
    stores.applications.update(web.id, { previewsEnabled: false });
    assert.equal((await h.webhook('pull_request', pullRequestEvent('opened', 6))).body.result, 'queued 0 preview deployment(s)');
    assert.equal((await h.webhook('pull_request', pullRequestEvent('closed', 3))).body.result, 'removed 1 preview(s)');
    assert.deepEqual(previews(), [[staging.id, 4]]);
  } finally {
    await h.close();
  }
});

test('previews stay out of team and project lists, and deleting the parent destroys them first', async () => {
  const h = await previewHarness();
  try {
    const { stores } = h.ctx;
    const shop = stores.projects.create(h.teamA.id, 'Shop', null);
    const web = h.githubApp(h.teamA.id, shop.id, 'Web');
    stores.applications.update(web.id, { previewsEnabled: true });
    await h.webhook('pull_request', pullRequestEvent('opened', 11));
    await h.webhook('pull_request', pullRequestEvent('opened', 12));
    const previewIds = stores.applications.listPreviews(web.id).map((preview) => preview.id);
    assert.equal(previewIds.length, 2);
    assert.equal(stores.applications.get(previewIds[0]!)!.previewPrNumber, 12, 'newest first');

    const apps = await h.call<ApplicationDto[]>(h.tokens.viewer, 'GET', '/api/applications');
    assert.deepEqual(apps.body.map((app) => app.id), [web.id]);
    const project = await h.call<{ project: ProjectDto; applications: ApplicationDto[] }>(h.tokens.viewer, 'GET', `/api/projects/${shop.id}`);
    assert.deepEqual(project.body.applications.map((app) => app.id), [web.id]);
    assert.equal(project.body.project.applicationCount, 1);
    assert.equal(project.body.project.statusSummary.total, 1);
    assert.equal(project.body.project.statusSummary.building, 0, 'the queued previews are not counted');
    assert.equal((await h.call<ProjectDto[]>(h.tokens.viewer, 'GET', '/api/projects')).body[0]!.applicationCount, 1);
    const overview = await h.call<OverviewDto>(h.tokens.viewer, 'GET', '/api/overview');
    assert.equal(overview.body.applications.total, 1);
    assert.equal((await h.call<ServerDto[]>(h.tokens.viewer, 'GET', '/api/servers')).body.find((server) => server.id === h.local.id)!.applicationCount, 1);
    // …but each is still reachable by id.
    assert.equal((await h.call(h.tokens.viewer, 'GET', `/api/applications/${previewIds[1]}`)).status, 200);
    assert.equal((await h.call(h.tokens.rival, 'GET', `/api/applications/${previewIds[1]}`)).status, 404);

    h.containers.push(
      ...previewIds.map((id, index) => ({ Id: `c-preview-${index}`, Names: [`/p${index}`], Image: 'img', Labels: { 'ploy.managed': 'true', 'ploy.role': 'app', 'ploy.app': id }, State: 'running', Status: 'Up', Created: 0 })),
      { Id: 'c-web', Names: ['/web'], Image: 'img', Labels: { 'ploy.managed': 'true', 'ploy.role': 'app', 'ploy.app': web.id }, State: 'running', Status: 'Up', Created: 0 },
    );
    assert.deepEqual((await h.call(h.tokens.owner, 'DELETE', `/api/applications/${web.id}`)).body, { ok: true });
    assert.deepEqual(h.removedContainers, ['c-preview-0', 'c-preview-1', 'c-web'], 'the previews are destroyed before the parent');
    assert.equal(stores.db.scalar('SELECT COUNT(*) FROM applications'), 0);

    // Deleting a project takes its previews' containers with it as well.
    const blog = h.githubApp(h.teamA.id, shop.id, 'Blog');
    stores.applications.update(blog.id, { previewsEnabled: true });
    await h.webhook('pull_request', pullRequestEvent('opened', 13));
    const [blogPreview] = stores.applications.listPreviews(blog.id);
    h.containers.push({ Id: 'c-blog-preview', Names: ['/bp'], Image: 'img', Labels: { 'ploy.managed': 'true', 'ploy.role': 'app', 'ploy.app': blogPreview!.id }, State: 'running', Status: 'Up', Created: 0 });
    assert.deepEqual((await h.call(h.tokens.owner, 'DELETE', `/api/projects/${shop.id}`)).body, { ok: true });
    assert.ok(h.removedContainers.includes('c-blog-preview'));
    assert.equal(stores.db.scalar('SELECT COUNT(*) FROM applications'), 0);
  } finally {
    await h.close();
  }
});

test('preview settings: GitHub web applications only, bounded, valid .env text, and role-checked endpoints', async () => {
  const h = await previewHarness();
  try {
    const { stores } = h.ctx;
    const shop = stores.projects.create(h.teamA.id, 'Shop', null);
    const web = h.githubApp(h.teamA.id, shop.id, 'Web');
    const worker = h.githubApp(h.teamA.id, shop.id, 'Jobs', { kind: 'worker' });
    const image = h.application(h.teamA.id, shop.id, 'Proxy', 'web', 'nginx:alpine');
    const patch = (id: string, input: unknown) => h.call<ApiErrorBody>(h.tokens.developer, 'PATCH', `/api/applications/${id}`, input);
    const rejected = async (id: string, input: unknown, path: string) => {
      const response = await patch(id, input);
      assert.equal(response.status, 422, JSON.stringify(input));
      assert.equal(response.body.error.code, 'validation_failed');
      assert.deepEqual(response.body.error.issues?.map((issue) => issue.path), [path]);
    };

    await rejected(image.id, { previewsEnabled: true }, 'previewsEnabled');
    await rejected(worker.id, { previewsEnabled: true }, 'previewsEnabled');
    await rejected(web.id, { previewsEnabled: true, kind: 'worker' }, 'previewsEnabled');
    await rejected(web.id, { previewLimit: 0 }, 'previewLimit');
    await rejected(web.id, { previewLimit: 21 }, 'previewLimit');
    await rejected(web.id, { previewLimit: 2.5 }, 'previewLimit');
    await rejected(web.id, { previewEnv: 'GOOD=1\nnot a variable' }, 'previewEnv');
    await rejected(web.id, { previewEnv: '1BAD=x' }, 'previewEnv');
    await rejected(web.id, { previewEnv: `BIG=${'x'.repeat(32 * 1024)}` }, 'previewEnv');
    assert.equal(stores.applications.get(web.id)!.previewsEnabled, false);
    // An image app that becomes a GitHub app in the same edit may turn previews on.
    assert.equal((await patch(image.id, { source: { type: 'github', installationId: 42, repository: 'acme/shop', branch: 'main' }, previewsEnabled: true })).status, 200);

    assert.equal((await patch(web.id, { previewsEnabled: true, previewLimit: 20, previewEnv: '' })).status, 200);
    assert.deepEqual((await h.call<PreviewSettingsDto>(h.tokens.developer, 'GET', `/api/applications/${web.id}/preview-settings`)).body, { enabled: true, limit: 20, env: '', webhookReady: true });
    assert.equal((await h.call(h.tokens.viewer, 'GET', `/api/applications/${web.id}/preview-settings`)).status, 403, 'the variables are for developers');
    assert.equal((await h.call(h.tokens.rival, 'GET', `/api/applications/${web.id}/preview-settings`)).status, 404);
    assert.equal((await h.call(h.tokens.rival, 'GET', `/api/applications/${web.id}/previews`)).status, 404);

    await h.webhook('pull_request', pullRequestEvent('opened', 21));
    const [preview] = stores.applications.listPreviews(web.id);
    assert.ok(preview);
    // A preview cannot have previews of its own.
    await rejected(preview.id, { previewsEnabled: true }, 'previewsEnabled');
    assert.deepEqual((await h.call<PreviewDto[]>(h.tokens.viewer, 'GET', `/api/applications/${preview.id}/previews`)).body, []);

    // Previews are addressed under their own parent only.
    assert.equal((await h.call(h.tokens.developer, 'DELETE', `/api/applications/${worker.id}/previews/${preview.id}`)).status, 404);
    assert.equal((await h.call(h.tokens.developer, 'POST', `/api/applications/${web.id}/previews/${worker.id}/redeploy`)).status, 404);
    assert.equal((await h.call(h.tokens.rival, 'DELETE', `/api/applications/${web.id}/previews/${preview.id}`)).status, 404);
    assert.equal((await h.call(h.tokens.viewer, 'DELETE', `/api/applications/${web.id}/previews/${preview.id}`)).status, 403);
    assert.deepEqual((await h.call(h.tokens.developer, 'DELETE', `/api/applications/${web.id}/previews/${preview.id}`)).body, { ok: true });
    assert.equal(stores.applications.get(preview.id), undefined);
    assert.equal(stores.db.scalar("SELECT COUNT(*) FROM audit_log WHERE action = 'preview.deleted' AND target_id = ?", preview.id), 1);

    // Moving the app off GitHub turns previews off rather than failing the edit.
    const moved = await h.call<ApplicationDto>(h.tokens.developer, 'PATCH', `/api/applications/${web.id}`, { source: { type: 'image', image: 'nginx:alpine' } });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.previewsEnabled, false);
  } finally {
    await h.close();
  }
});
