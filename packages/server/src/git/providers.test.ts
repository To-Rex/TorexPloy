/**
 * GitLab and Bitbucket connections through the HTTP API, against doubles of
 * their REST APIs: connecting (and refusing a bad token), the repository
 * chooser, the webhook each repository in use gets (or the reason it could
 * not be made), deliveries verified by secret or signature, pushes that
 * deploy, merge/pull requests that preview, commit statuses, clone
 * credentials, and the roles each step needs. Webhook payloads are read the
 * way GitLab and Bitbucket send them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HttpBindings } from '@hono/node-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_TOKEN_PREFIX, type ApiErrorBody, type ApplicationDto, type GitHookStatusDto, type GitProviderDto, type GitProviderWebhookDto, type GitRepositoryDto } from '@ploy/shared';
import { hmac } from '../lib/crypto.ts';
import { createContext } from '../main.ts';
import { createHttpApp } from '../http/app.ts';
import { parseBitbucketEvent, parseGitlabEvent } from './providers.ts';

const BINDINGS = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as unknown as HttpBindings;
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA2 = 'f0e1d2c3b4a5968778695a4b3c2d1e0f12345678';

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** GitLab at gitlab.example.uz and Bitbucket Cloud, as far as these flows need them. */
function hosts() {
  const calls: Recorded[] = [];
  const gitlabHooks: { id: number; url: string; token?: string }[] = [];
  const bitbucketHooks: { uuid: string; url: string; secret?: string }[] = [];
  const state = { gitlabToken: 'glpat-good-token-123', bitbucketToken: 'ATATT-good-token-456', hooksForbidden: false };
  const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, headers, body });
    if (url.startsWith('https://gitlab.example.uz/api/v4/')) {
      if (headers['private-token'] !== state.gitlabToken) return json(401, { message: '401 Unauthorized' });
      const path = url.slice('https://gitlab.example.uz/api/v4'.length);
      if (path === '/user') return json(200, { username: 'sardor', name: 'Sardor Aliyev', avatar_url: 'https://gitlab.example.uz/avatar.png' });
      if (path.startsWith('/projects?')) {
        return json(200, [
          { id: 7, path_with_namespace: 'torex/shop/storefront', visibility: 'private', default_branch: 'main', description: 'Doʻkon', last_activity_at: '2026-11-20T10:00:00Z' },
          { id: 8, path_with_namespace: 'torex/landing', visibility: 'public', default_branch: 'master', description: '', last_activity_at: '2026-11-01T10:00:00Z' },
        ]);
      }
      const project = '/projects/torex%2Fshop%2Fstorefront';
      if (path.startsWith(`${project}/repository/branches`)) return json(200, [{ name: 'main' }, { name: 'develop' }]);
      if (path.startsWith(`${project}/hooks`)) {
        if (state.hooksForbidden) return json(403, { message: '403 Forbidden' });
        if (method === 'GET') return json(200, gitlabHooks);
        if (method === 'POST') {
          const hook = { id: gitlabHooks.length + 100, url: String((body as { url: string }).url), token: (body as { token: string }).token };
          gitlabHooks.push(hook);
          return json(201, hook);
        }
        if (method === 'PUT') return json(200, gitlabHooks[0]);
        if (method === 'DELETE') {
          gitlabHooks.splice(0, gitlabHooks.length);
          return json(204, null);
        }
      }
      if (path.startsWith(`${project}/statuses/`)) return json(201, { id: 1 });
      if (path.startsWith(`${project}/merge_requests/`)) return json(201, { id: 555 });
      return json(404, { message: '404 Not Found' });
    }
    if (url.startsWith('https://api.bitbucket.org/2.0/')) {
      if (headers.authorization !== `Bearer ${state.bitbucketToken}`) return json(401, { type: 'error', error: { message: 'Unauthorized' } });
      const path = url.slice('https://api.bitbucket.org/2.0'.length);
      // A workspace access token is not a user.
      if (path === '/user') return json(403, { type: 'error', error: { message: 'This API is only accessible with the following authentication types: session, password, apppassword' } });
      if (path.startsWith('/repositories/torex-team?')) {
        return json(200, { values: [{ uuid: '{r1}', full_name: 'torex-team/api', is_private: true, mainbranch: { name: 'main' }, description: 'API', updated_on: '2026-11-21T10:00:00Z', language: 'go' }] });
      }
      if (path.startsWith('/repositories/torex-team/api/refs/branches')) return json(200, { values: [{ name: 'main' }, { name: 'release' }] });
      if (path.startsWith('/repositories/torex-team/api/hooks')) {
        if (method === 'GET') return json(200, { values: bitbucketHooks });
        if (method === 'POST') {
          const hook = { uuid: `{h${bitbucketHooks.length + 1}}`, url: String((body as { url: string }).url), secret: (body as { secret: string }).secret };
          bitbucketHooks.push(hook);
          return json(201, hook);
        }
        if (method === 'DELETE') {
          bitbucketHooks.splice(0, bitbucketHooks.length);
          return json(204, null);
        }
      }
      if (path.includes('/statuses/build')) return json(201, {});
      if (path.includes('/pullrequests/')) return json(201, { id: 777 });
      return json(404, { type: 'error', error: { message: 'Not found' } });
    }
    return json(599, { message: `unexpected ${method} ${url}` });
  };
  return { calls, gitlabHooks, bitbucketHooks, state, fetchImpl };
}

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-git-'));
  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket: join(dir, 'none.sock'), logLevel: 'error' });
  const { stores } = ctx;
  const remote = hosts();
  ctx.gitProviders.fetch = remote.fetchImpl;
  // Deployments are queued, not run: these tests are about what starts them.
  const queued: { appId: string; commitSha: string | null; trigger: string }[] = [];
  ctx.deployer.enqueue = ((input: { app: { id: string }; commitSha?: string | null; trigger: string }) => {
    queued.push({ appId: input.app.id, commitSha: input.commitSha ?? null, trigger: input.trigger });
    return { id: `dep_${queued.length}` };
  }) as unknown as typeof ctx.deployer.enqueue;
  const local = stores.servers.ensureLocal('local');
  const team = stores.teams.create('Acme');
  const other = stores.teams.create('Rival');
  const member = (teamId: string, email: string, role: 'viewer' | 'developer' | 'admin' | 'owner'): string => {
    const user = stores.users.create({ email, name: email.split('@')[0]!, passwordHash: null, isInstanceAdmin: false });
    stores.teams.addMember(teamId, user.id, role);
    return stores.tokens.create({ userId: user.id, teamId, name: 'test', expiresAt: null, tokenPrefix: API_TOKEN_PREFIX }).token;
  };
  const tokens = {
    admin: member(team.id, 'admin@acme.uz', 'admin'),
    developer: member(team.id, 'dev@acme.uz', 'developer'),
    viewer: member(team.id, 'viewer@acme.uz', 'viewer'),
    rival: member(other.id, 'owner@rival.uz', 'owner'),
  };
  const project = stores.projects.create(team.id, 'Shop', null);
  const app = createHttpApp(ctx);
  const call = async <T>(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const response = await app.request(path, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, BINDINGS);
    return { status: response.status, body: (await response.json()) as T };
  };
  /** A delivery as GitLab or Bitbucket makes it: the raw body and the headers they send. */
  const deliver = async (path: string, payload: unknown, headers: Record<string, string>) => {
    const raw = JSON.stringify(payload);
    const response = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw }, BINDINGS);
    return { status: response.status, body: (await response.json()) as { ok?: boolean; result?: string } & Partial<ApiErrorBody> };
  };
  /** Until background webhook set-up has finished. */
  const settle = async () => {
    for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    ctx,
    local,
    team,
    project,
    tokens,
    remote,
    queued,
    call,
    deliver,
    settle,
    close: async () => {
      stores.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('webhook deliveries are read the way GitLab and Bitbucket send them', () => {
  const gitlabPush = { object_kind: 'push', ref: 'refs/heads/main', before: '0'.repeat(40), after: SHA, checkout_sha: SHA, user_name: 'Sardor', project: { path_with_namespace: 'torex/shop/storefront' }, commits: [{ id: SHA, message: 'Savat\n\nbody', author: { name: 'Aziza' } }] };
  assert.deepEqual(parseGitlabEvent('Push Hook', gitlabPush), [{ kind: 'push', repository: 'torex/shop/storefront', branch: 'main', sha: SHA, message: 'Savat\n\nbody', author: 'Aziza' }]);
  assert.equal(parseGitlabEvent('Push Hook', { ...gitlabPush, after: '0'.repeat(40) })[0]!.kind, 'ignored', 'a deleted branch');
  assert.equal(parseGitlabEvent('Push Hook', { ...gitlabPush, ref: 'refs/tags/v1' })[0]!.kind, 'ignored', 'a tag');
  assert.equal(parseGitlabEvent('Push Hook', { ...gitlabPush, commits: [{ id: SHA, message: 'docs [skip ci]' }] })[0]!.kind, 'ignored');

  const mr = (action: string, extra: Record<string, unknown> = {}) => ({
    object_kind: 'merge_request',
    project: { path_with_namespace: 'torex/shop/storefront' },
    user: { username: 'aziza' },
    object_attributes: { iid: 12, action, source_branch: 'feature/cart', target_branch: 'main', last_commit: { id: SHA2 }, title: 'Savat', url: 'https://gitlab.example.uz/torex/shop/storefront/-/merge_requests/12', source_project_id: 7, target_project_id: 7, ...extra },
  });
  const opened = parseGitlabEvent('Merge Request Hook', mr('open'))[0]!;
  assert.deepEqual(opened, { kind: 'pull', action: 'deploy', repository: 'torex/shop/storefront', number: 12, baseBranch: 'main', headBranch: 'feature/cart', headSha: SHA2, title: 'Savat', url: 'https://gitlab.example.uz/torex/shop/storefront/-/merge_requests/12', author: 'aziza', fromFork: false });
  assert.equal(parseGitlabEvent('Merge Request Hook', mr('update'))[0]!.kind, 'ignored', 'a title edit changes no code');
  assert.equal((parseGitlabEvent('Merge Request Hook', mr('update', { oldrev: SHA }))[0] as { action: string }).action, 'deploy', 'new commits');
  assert.equal((parseGitlabEvent('Merge Request Hook', mr('merge'))[0] as { action: string }).action, 'close');
  assert.equal((parseGitlabEvent('Merge Request Hook', mr('open', { source_project_id: 99 }))[0] as { fromFork: boolean }).fromFork, true);
  assert.equal(parseGitlabEvent('Merge Request Hook', mr('approved'))[0]!.kind, 'ignored');

  const bbPush = {
    repository: { full_name: 'torex-team/api' },
    push: {
      changes: [
        { new: { type: 'branch', name: 'main', target: { hash: SHA, message: 'Fix', author: { raw: 'Aziza Karimova <a@b.uz>', user: { display_name: 'Aziza Karimova' } } } } },
        { new: null, old: { type: 'branch', name: 'gone' } },
        { new: { type: 'tag', name: 'v1', target: { hash: SHA2 } } },
      ],
    },
  };
  assert.deepEqual(parseBitbucketEvent('repo:push', bbPush), [{ kind: 'push', repository: 'torex-team/api', branch: 'main', sha: SHA, message: 'Fix', author: 'Aziza Karimova' }]);
  const pr = (key: string, sourceRepo = 'torex-team/api') =>
    parseBitbucketEvent(key, {
      repository: { full_name: 'torex-team/api' },
      pullrequest: {
        id: 4,
        title: 'Release',
        links: { html: { href: 'https://bitbucket.org/torex-team/api/pull-requests/4' } },
        author: { display_name: 'Sardor' },
        source: { branch: { name: 'release' }, commit: { hash: '0123456789ab' }, repository: { full_name: sourceRepo } },
        destination: { branch: { name: 'main' }, repository: { full_name: 'torex-team/api' } },
      },
    })[0]!;
  assert.deepEqual(pr('pullrequest:created'), { kind: 'pull', action: 'deploy', repository: 'torex-team/api', number: 4, baseBranch: 'main', headBranch: 'release', headSha: '0123456789ab', title: 'Release', url: 'https://bitbucket.org/torex-team/api/pull-requests/4', author: 'Sardor', fromFork: false });
  assert.equal((pr('pullrequest:fulfilled') as { action: string }).action, 'close');
  assert.equal((pr('pullrequest:rejected') as { action: string }).action, 'close');
  assert.equal((pr('pullrequest:created', 'someone/api') as { fromFork: boolean }).fromFork, true);
  assert.deepEqual(parseBitbucketEvent('diagnostics:ping', {}), [{ kind: 'ping' }]);
});

test('a GitLab connection: checked, listed, its repositories deploy on push with a webhook the panel sets up, and merge requests preview', async () => {
  const h = await harness();
  try {
    const { stores } = h.ctx;
    // Connecting: administrators only, and the token is checked first.
    const body = { kind: 'gitlab', baseUrl: 'https://gitlab.example.uz/', token: h.remote.state.gitlabToken };
    assert.equal((await h.call(h.tokens.developer, 'POST', '/api/git-providers', body)).status, 403);
    const bad = await h.call<ApiErrorBody>(h.tokens.admin, 'POST', '/api/git-providers', { ...body, token: 'glpat-wrong-token' });
    assert.deepEqual([bad.status, bad.body.error.code, bad.body.error.params?.reason], [502, 'git_provider_error', 'auth']);
    assert.equal(stores.gitProviders.listForTeam(h.team.id).length, 0, 'nothing kept');
    const created = await h.call<GitProviderDto>(h.tokens.admin, 'POST', '/api/git-providers', body);
    assert.equal(created.status, 201);
    const provider = created.body;
    assert.deepEqual([provider.kind, provider.baseUrl, provider.account.login, provider.name, provider.usedBy], ['gitlab', 'https://gitlab.example.uz', 'sardor', 'gitlab.example.uz · sardor', 0]);
    assert.equal(provider.webhookUrl, null, 'no public address yet');
    assert.ok(!JSON.stringify(provider).includes(h.remote.state.gitlabToken), 'the token never comes back');
    assert.ok(!JSON.stringify(stores.db.all('SELECT credentials FROM git_providers')).includes(h.remote.state.gitlabToken), 'sealed at rest');

    // Everyone in the team sees it; another team does not.
    assert.equal((await h.call<GitProviderDto[]>(h.tokens.viewer, 'GET', '/api/git-providers')).body.length, 1);
    assert.equal((await h.call<GitProviderDto[]>(h.tokens.rival, 'GET', '/api/git-providers')).body.length, 0);
    assert.equal((await h.call(h.tokens.rival, 'GET', `/api/git-providers/${provider.id}/repositories`)).status, 404);

    // The chooser: repositories and branches, for developers.
    assert.equal((await h.call(h.tokens.viewer, 'GET', `/api/git-providers/${provider.id}/repositories`)).status, 403);
    const repos = await h.call<GitRepositoryDto[]>(h.tokens.developer, 'GET', `/api/git-providers/${provider.id}/repositories`);
    assert.deepEqual(repos.body.map((repo) => [repo.fullName, repo.private, repo.defaultBranch, repo.description]), [
      ['torex/shop/storefront', true, 'main', 'Doʻkon'],
      ['torex/landing', false, 'master', null],
    ]);
    const branches = await h.call<string[]>(h.tokens.developer, 'GET', `/api/git-providers/${provider.id}/branches?repository=torex/shop/storefront`);
    assert.deepEqual(branches.body, ['main', 'develop']);

    // An application from it. Without a public address GitLab cannot call the panel: said so, not hidden.
    const createdApp = await h.call<{ application: ApplicationDto }>(h.tokens.developer, 'POST', `/api/projects/${h.project.id}/applications`, {
      name: 'storefront',
      serverId: h.local.id,
      kind: 'web',
      source: { type: 'gitlab', providerId: provider.id, repository: 'torex/shop/storefront', branch: 'main' },
    });
    assert.equal(createdApp.status, 201, JSON.stringify(createdApp.body));
    const appId = createdApp.body.application.id;
    await h.settle();
    let source = (await h.call<ApplicationDto>(h.tokens.viewer, 'GET', `/api/applications/${appId}`)).body.source as { type: string; webhook: GitHookStatusDto; providerName: string; webUrl: string };
    assert.deepEqual([source.type, source.providerName, source.webUrl], ['gitlab', 'gitlab.example.uz · sardor', 'https://gitlab.example.uz']);
    assert.deepEqual([source.webhook.status, source.webhook.reason], ['failed', 'no_public_url']);

    // With a domain the panel sets the webhook up itself, with the secret, push and merge request events.
    stores.settings.updatePlatform({ platformDomain: 'panel.example.uz' });
    const retried = await h.call<GitHookStatusDto>(h.tokens.developer, 'POST', `/api/applications/${appId}/webhook`);
    assert.deepEqual([retried.body.status, retried.body.url], ['ok', `https://panel.example.uz/api/webhooks/gitlab/${provider.id}`]);
    assert.equal(h.remote.gitlabHooks.length, 1);
    const secret = stores.gitProviders.webhookSecret(provider.id);
    assert.equal(h.remote.gitlabHooks[0]!.token, secret);
    const hookBody = h.remote.calls.find((call) => call.method === 'POST' && call.url.endsWith('/hooks'))!.body as Record<string, unknown>;
    assert.deepEqual([hookBody.push_events, hookBody.merge_requests_events, hookBody.enable_ssl_verification], [true, true, true]);
    // Doing it again updates the same hook rather than adding another.
    await h.call(h.tokens.developer, 'POST', `/api/applications/${appId}/webhook`);
    assert.equal(h.remote.gitlabHooks.length, 1);
    // A token without the right to manage hooks: the reason is kept for the dashboard to explain.
    h.remote.state.hooksForbidden = true;
    const forbidden = await h.call<GitHookStatusDto>(h.tokens.developer, 'POST', `/api/applications/${appId}/webhook`);
    assert.deepEqual([forbidden.body.status, forbidden.body.reason], ['failed', 'permission']);
    h.remote.state.hooksForbidden = false;
    // The secret for doing it by hand: administrators only.
    assert.equal((await h.call(h.tokens.developer, 'GET', `/api/git-providers/${provider.id}/webhook`)).status, 403);
    const manual = await h.call<GitProviderWebhookDto>(h.tokens.admin, 'GET', `/api/git-providers/${provider.id}/webhook`);
    assert.deepEqual(manual.body, { url: `https://panel.example.uz/api/webhooks/gitlab/${provider.id}`, secret });

    // Deliveries: the secret token is required; a push to the branch deploys the pushed commit.
    const push = { object_kind: 'push', ref: 'refs/heads/main', after: SHA, checkout_sha: SHA, project: { path_with_namespace: 'torex/shop/storefront' }, commits: [{ id: SHA, message: 'Savat', author: { name: 'Aziza' } }] };
    const url = `/api/webhooks/gitlab/${provider.id}`;
    assert.equal((await h.deliver(url, push, { 'x-gitlab-event': 'Push Hook' })).status, 401);
    assert.equal((await h.deliver(url, push, { 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': 'guess' })).status, 401);
    assert.equal((await h.deliver('/api/webhooks/gitlab/git_unknown', push, { 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': secret })).status, 401);
    const pushed = await h.deliver(url, push, { 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': secret });
    assert.deepEqual([pushed.status, pushed.body.result], [200, 'queued 1 deployment(s)']);
    // The first deployment came with the application itself; the push adds one for the pushed commit.
    assert.deepEqual(h.queued, [{ appId, commitSha: null, trigger: 'manual' }, { appId, commitSha: SHA, trigger: 'push' }]);
    assert.equal((await h.deliver(url, { ...push, ref: 'refs/heads/develop' }, { 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': secret })).body.result, 'queued 0 deployment(s)', 'another branch');

    // Clone credentials: the instance's address with oauth2:<token>, sent to that host only.
    const access = await h.ctx.gitProviders.access(stores.applications.get(appId)!);
    assert.equal(access.url, 'https://gitlab.example.uz/torex/shop/storefront.git');
    assert.deepEqual(access.httpAuth, { origin: 'https://gitlab.example.uz', authorization: `Basic ${Buffer.from(`oauth2:${h.remote.state.gitlabToken}`).toString('base64')}` });
    assert.deepEqual(access.secrets, [h.remote.state.gitlabToken]);

    // Commit statuses go to GitLab, linked to the deployment.
    await h.ctx.gitProviders.commitStatus(stores.applications.get(appId)!, SHA, 'success', 'dep_1');
    const status = h.remote.calls.find((call) => call.url.includes('/statuses/'))!;
    assert.deepEqual(status.body, { state: 'success', name: 'TorexPloy / storefront', description: 'Deployed', target_url: 'https://panel.example.uz/deployments/dep_1' });

    // Merge requests preview the application once previews are on (GitLab is a preview source now).
    assert.equal((await h.call(h.tokens.developer, 'PATCH', `/api/applications/${appId}`, { previewsEnabled: true, previewLimit: 3, previewEnv: 'APP_ENV=preview' })).status, 200);
    const mr = (action: string, extra: Record<string, unknown> = {}) => ({
      object_kind: 'merge_request',
      project: { path_with_namespace: 'torex/shop/storefront' },
      user: { username: 'aziza' },
      object_attributes: { iid: 12, action, source_branch: 'feature/cart', target_branch: 'main', last_commit: { id: SHA2 }, title: 'Savat', url: 'https://gitlab.example.uz/x', source_project_id: 7, target_project_id: 7, ...extra },
    });
    const mrHeaders = { 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-token': secret };
    assert.match((await h.deliver(url, mr('open', { source_project_id: 99 }), mrHeaders)).body.result ?? '', /from a fork/);
    const opened = await h.deliver(url, mr('open'), mrHeaders);
    assert.equal(opened.body.result, 'queued 1 preview deployment(s)');
    const preview = stores.applications.listPreviews(appId)[0]!;
    assert.deepEqual([preview.sourceType, preview.gitProviderId, preview.repository, preview.branch, preview.previewPrNumber], ['gitlab', provider.id, 'torex/shop/storefront', 'feature/cart', 12]);
    assert.deepEqual(h.queued.at(-1), { appId: preview.id, commitSha: SHA2, trigger: 'push' });
    // The preview's address goes to the merge request as a note.
    stores.deployments.create({ application: preview, trigger: 'push', createdBy: null });
    await h.ctx.previews.commentDeployed(preview.id, stores.deployments.latestForApplication(preview.id)!.id);
    const note = h.remote.calls.find((call) => call.url.includes('/merge_requests/12/notes'))!;
    assert.match(String((note.body as { body: string }).body), /merge request/);
    assert.equal(stores.applications.get(preview.id)!.previewCommentId, 555);
    // Merged: the preview goes.
    assert.equal((await h.deliver(url, mr('merge'), mrHeaders)).body.result, 'removed 1 preview(s)');
    assert.equal(stores.applications.listPreviews(appId).length, 0);

    // A connection in use cannot be removed; once nothing uses it, it goes with its webhooks.
    const inUse = await h.call<ApiErrorBody>(h.tokens.admin, 'DELETE', `/api/git-providers/${provider.id}`);
    assert.deepEqual([inUse.status, inUse.body.error.params?.reason], [409, 'in_use']);
    assert.equal((await h.call<GitProviderDto[]>(h.tokens.viewer, 'GET', '/api/git-providers')).body[0]!.usedBy, 1);
    stores.applications.delete(appId);
    assert.equal((await h.call(h.tokens.admin, 'DELETE', `/api/git-providers/${provider.id}`)).status, 200);
    assert.equal(h.remote.gitlabHooks.length, 0, 'the webhook was removed from GitLab');
    assert.equal(stores.gitProviders.listForTeam(h.team.id).length, 0);
  } finally {
    await h.close();
  }
});

test('a Bitbucket workspace token: checked by listing, webhook verified by its signature or its address, pull requests preview, forks do not', async () => {
  const h = await harness();
  try {
    const { stores } = h.ctx;
    stores.settings.updatePlatform({ platformDomain: 'panel.example.uz' });
    // Workspace access tokens are not a user: the connection checks them by listing the workspace instead.
    const created = await h.call<GitProviderDto>(h.tokens.admin, 'POST', '/api/git-providers', { kind: 'bitbucket', token: h.remote.state.bitbucketToken, workspace: 'torex-team' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const provider = created.body;
    assert.deepEqual([provider.account.login, provider.workspace, provider.hasEmail, provider.name], ['torex-team', 'torex-team', false, 'Bitbucket · torex-team']);
    assert.match(provider.webhookUrl ?? '', new RegExp(`^https://panel\\.example\\.uz/api/webhooks/bitbucket/${provider.id}\\?token=[0-9a-f]{32}$`));
    const repos = await h.call<GitRepositoryDto[]>(h.tokens.developer, 'GET', `/api/git-providers/${provider.id}/repositories`);
    assert.deepEqual(repos.body.map((repo) => [repo.id, repo.fullName, repo.language]), [['{r1}', 'torex-team/api', 'go']]);

    const createdApp = await h.call<{ application: ApplicationDto }>(h.tokens.developer, 'POST', `/api/projects/${h.project.id}/applications`, {
      name: 'api',
      serverId: h.local.id,
      kind: 'web',
      source: { type: 'bitbucket', providerId: provider.id, repository: 'torex-team/api', branch: 'main' },
    });
    assert.equal(createdApp.status, 201, JSON.stringify(createdApp.body));
    const appId = createdApp.body.application.id;
    await h.settle();
    assert.equal(h.remote.bitbucketHooks.length, 1, 'set up when the application was made');
    const hookBody = h.remote.calls.find((call) => call.method === 'POST' && call.url.endsWith('/hooks'))!.body as { events: string[]; secret: string; url: string };
    const secret = stores.gitProviders.webhookSecret(provider.id);
    assert.equal(hookBody.secret, secret);
    assert.deepEqual(hookBody.events, ['repo:push', 'pullrequest:created', 'pullrequest:updated', 'pullrequest:fulfilled', 'pullrequest:rejected']);
    assert.equal((await h.call<ApplicationDto>(h.tokens.viewer, 'GET', `/api/applications/${appId}`)).body.source.type, 'bitbucket');

    // A delivery is trusted by its HMAC signature; without one, only with the token in its address.
    const push = { repository: { full_name: 'torex-team/api' }, push: { changes: [{ new: { type: 'branch', name: 'main', target: { hash: SHA, message: 'Fix', author: { raw: 'A <a@b.uz>' } } } }] } };
    const raw = JSON.stringify(push);
    const base = `/api/webhooks/bitbucket/${provider.id}`;
    const urlToken = new URL(provider.webhookUrl!).searchParams.get('token')!;
    assert.equal((await h.deliver(base, push, { 'x-event-key': 'repo:push' })).status, 401, 'neither');
    assert.equal((await h.deliver(base, push, { 'x-event-key': 'repo:push', 'x-hub-signature': `sha256=${hmac('wrong', raw)}` })).status, 401, 'a wrong signature');
    assert.equal((await h.deliver(`${base}?token=${urlToken}`, push, { 'x-event-key': 'repo:push', 'x-hub-signature': `sha256=${hmac('wrong', raw)}` })).status, 401, 'a wrong signature is not saved by the address');
    const signed = await h.deliver(base, push, { 'x-event-key': 'repo:push', 'x-hub-signature': `sha256=${hmac(secret, raw)}` });
    assert.deepEqual([signed.status, signed.body.result], [200, 'queued 1 deployment(s)']);
    const byAddress = await h.deliver(`${base}?token=${urlToken}`, push, { 'x-event-key': 'repo:push' });
    assert.deepEqual([byAddress.status, byAddress.body.result], [200, 'queued 1 deployment(s)']);
    assert.equal(h.queued.filter((entry) => entry.trigger === 'push').length, 2);

    // Clone: bitbucket.org with x-token-auth.
    const access = await h.ctx.gitProviders.access(stores.applications.get(appId)!);
    assert.equal(access.url, 'https://bitbucket.org/torex-team/api.git');
    assert.equal(access.httpAuth?.authorization, `Basic ${Buffer.from(`x-token-auth:${h.remote.state.bitbucketToken}`).toString('base64')}`);

    // Pull requests: an abbreviated head (Bitbucket sends 12 characters) builds the branch head; forks are ignored.
    await h.call(h.tokens.developer, 'PATCH', `/api/applications/${appId}`, { previewsEnabled: true, previewLimit: 2, previewEnv: '' });
    const pr = (sourceRepo = 'torex-team/api') => ({
      repository: { full_name: 'torex-team/api' },
      pullrequest: {
        id: 4,
        title: 'Release',
        links: { html: { href: 'https://bitbucket.org/torex-team/api/pull-requests/4' } },
        author: { display_name: 'Sardor' },
        source: { branch: { name: 'release' }, commit: { hash: '0123456789ab' }, repository: { full_name: sourceRepo } },
        destination: { branch: { name: 'main' }, repository: { full_name: 'torex-team/api' } },
      },
    });
    const send = (payload: unknown, key: string) => h.deliver(base, payload, { 'x-event-key': key, 'x-hub-signature': `sha256=${hmac(secret, JSON.stringify(payload))}` });
    assert.match((await send(pr('stranger/api'), 'pullrequest:created')).body.result ?? '', /from a fork/);
    assert.equal((await send(pr(), 'pullrequest:created')).body.result, 'queued 1 preview deployment(s)');
    const preview = stores.applications.listPreviews(appId)[0]!;
    assert.deepEqual([preview.sourceType, preview.branch], ['bitbucket', 'release']);
    assert.deepEqual(h.queued.at(-1), { appId: preview.id, commitSha: null, trigger: 'push' });
    assert.equal((await send(pr(), 'pullrequest:rejected')).body.result, 'removed 1 preview(s)');

    // Another team cannot point an application at this connection.
    const rivalProject = stores.projects.create(stores.teams.listForUser(stores.users.getByEmail('owner@rival.uz')!.id)[0]!.team.id, 'Rival', null);
    const stolen = await h.call<ApiErrorBody>(h.tokens.rival, 'POST', `/api/projects/${rivalProject.id}/applications`, {
      name: 'x',
      serverId: h.local.id,
      kind: 'web',
      source: { type: 'bitbucket', providerId: provider.id, repository: 'torex-team/api', branch: 'main' },
    });
    assert.equal(stolen.status, 422);

    // A new token is checked before it replaces the old one.
    const wrong = await h.call<ApiErrorBody>(h.tokens.admin, 'PATCH', `/api/git-providers/${provider.id}`, { token: 'ATATT-wrong' });
    assert.equal(wrong.status, 502);
    assert.equal(stores.gitProviders.credentials(provider.id).token, h.remote.state.bitbucketToken, 'the old one stays');
    const renamed = await h.call<GitProviderDto>(h.tokens.admin, 'PATCH', `/api/git-providers/${provider.id}`, { name: 'Jamoa Bitbucket' });
    assert.equal(renamed.body.name, 'Jamoa Bitbucket');
  } finally {
    await h.close();
  }
});
