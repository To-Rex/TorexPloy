/**
 * GitLab and Bitbucket through their REST APIs, with an access token.
 *
 * Each client answers the same questions: who the token belongs to, which
 * repositories and branches it can see, how to clone over HTTPS with it,
 * and how to keep a webhook on a repository, report a commit's deployment
 * and comment on a merge/pull request. Webhook deliveries are read into the
 * same few shapes (`GitEvent`), so what happens on a push or a merge request
 * does not depend on where the repository lives.
 *
 * GitLab: `PRIVATE-TOKEN` for the API (personal, group or project access
 * tokens alike), `oauth2:<token>` for git. Bitbucket Cloud: a Bearer token
 * (an API token, or a workspace/repository access token), or Basic auth with
 * the Atlassian account email when one is given; `x-token-auth:<token>` for git.
 */
import type { GitProviderKind, GitRepositoryDto } from '@ploy/shared';
import { AppError, errorMessage } from '../lib/errors.ts';
import type { GitProviderCredentials, GitProviderRecord } from '../store/index.ts';

export type Fetch = typeof fetch;

export interface GitAccount {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export type CommitState = 'pending' | 'success' | 'failure' | 'error';

/** An `Authorization` header git sends to one origin (and nowhere else). */
export interface HttpAuth {
  origin: string;
  authorization: string;
}

export interface ProviderClient {
  readonly kind: GitProviderKind;
  /** Who the token belongs to; fails when the token is wrong or cannot list repositories. */
  verify(): Promise<GitAccount>;
  repositories(): Promise<GitRepositoryDto[]>;
  branches(repository: string): Promise<string[]>;
  /** Create the webhook, or bring the one made before up to date. Returns its id. */
  ensureWebhook(repository: string, url: string, secret: string): Promise<string>;
  deleteWebhook(repository: string, hookId: string): Promise<void>;
  commitStatus(repository: string, sha: string, state: CommitState, details: { key: string; name: string; url: string | null; description: string }): Promise<void>;
  /** Comment on merge/pull request `number`, or edit `commentId` in place. Returns the comment's id. */
  upsertComment(repository: string, number: number, commentId: number | null, body: string): Promise<number>;
  cloneUrl(repository: string): string;
  webUrl(repository: string, branch?: string | null): string;
  gitAuth(): HttpAuth;
}

/** What went wrong, as a reason the dashboard can explain. */
function failure(kind: GitProviderKind, status: number, detail: string): AppError {
  const label = kind === 'gitlab' ? 'GitLab' : 'Bitbucket';
  const reason = status === 401 ? 'auth' : status === 403 ? 'permission' : status === 404 ? 'not_found' : status >= 500 ? 'server' : 'rejected';
  const lead =
    reason === 'auth'
      ? `${label} did not accept the token`
      : reason === 'permission'
        ? `The token is not allowed to do this on ${label}`
        : reason === 'not_found'
          ? `${label} does not know this repository, or the token cannot see it`
          : `${label} answered ${status}`;
  return new AppError('git_provider_error', `${lead}${detail.length > 0 ? `: ${detail}` : ''}`, { params: { provider: kind, status, reason } });
}

async function request<T>(
  kind: GitProviderKind,
  fetchImpl: Fetch,
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: unknown },
): Promise<{ data: T; headers: Headers }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'TorexPloy', ...init.headers, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
  } catch (error) {
    throw new AppError('git_provider_error', `${kind === 'gitlab' ? 'GitLab' : 'Bitbucket'} is unreachable: ${errorMessage(error)}`, { params: { provider: kind, reason: 'unreachable' } });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let detail = '';
    try {
      const body = JSON.parse(text) as { message?: unknown; error?: unknown };
      const message = body.message ?? (typeof body.error === 'object' && body.error !== null ? (body.error as { message?: unknown }).message : body.error);
      detail = typeof message === 'string' ? message : message === undefined ? '' : JSON.stringify(message);
    } catch {
      detail = text.slice(0, 200);
    }
    throw failure(kind, response.status, detail.slice(0, 300));
  }
  if (response.status === 204) return { data: undefined as T, headers: response.headers };
  return { data: (await response.json()) as T, headers: response.headers };
}

const basic = (user: string, password: string): string => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

interface GitlabProject {
  id: number;
  path_with_namespace: string;
  visibility?: string;
  default_branch: string | null;
  description: string | null;
  last_activity_at: string | null;
  archived?: boolean;
}

export class GitlabClient implements ProviderClient {
  readonly kind = 'gitlab' as const;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: Fetch;

  constructor(baseUrl: string, credentials: GitProviderCredentials, fetchImpl: Fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = credentials.token;
    this.fetchImpl = fetchImpl;
  }

  private api<T>(path: string, init: { method?: string; body?: unknown } = {}) {
    return request<T>('gitlab', this.fetchImpl, `${this.baseUrl}/api/v4${path}`, { ...init, headers: { 'PRIVATE-TOKEN': this.token } });
  }

  private project(repository: string): string {
    return `/projects/${encodeURIComponent(repository)}`;
  }

  async verify(): Promise<GitAccount> {
    try {
      const { data } = await this.api<{ username: string; name: string | null; avatar_url: string | null }>('/user');
      return { login: data.username, name: data.name, avatarUrl: data.avatar_url };
    } catch (error) {
      // A project or group token without read_user still lists what it may see: that is enough to work with.
      if (!(error instanceof AppError) || error.params?.reason !== 'permission') throw error;
      await this.api('/projects?membership=true&per_page=1');
      return { login: 'token', name: null, avatarUrl: null };
    }
  }

  async repositories(): Promise<GitRepositoryDto[]> {
    const repos: GitRepositoryDto[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const { data } = await this.api<GitlabProject[]>(`/projects?membership=true&archived=false&order_by=last_activity_at&sort=desc&per_page=100&page=${page}`);
      for (const project of data) {
        repos.push({
          id: String(project.id),
          fullName: project.path_with_namespace,
          private: project.visibility !== 'public',
          defaultBranch: project.default_branch ?? 'main',
          description: project.description === '' ? null : project.description,
          updatedAt: project.last_activity_at,
          language: null,
        });
      }
      if (data.length < 100) break;
    }
    return repos;
  }

  async branches(repository: string): Promise<string[]> {
    const names: string[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const { data } = await this.api<{ name: string }[]>(`${this.project(repository)}/repository/branches?per_page=100&page=${page}`);
      names.push(...data.map((branch) => branch.name));
      if (data.length < 100) break;
    }
    return names;
  }

  async ensureWebhook(repository: string, url: string, secret: string): Promise<string> {
    const settings = { url, token: secret, push_events: true, merge_requests_events: true, enable_ssl_verification: url.startsWith('https://') };
    const { data: hooks } = await this.api<{ id: number; url: string }[]>(`${this.project(repository)}/hooks?per_page=100`);
    const existing = hooks.find((hook) => hook.url === url);
    if (existing !== undefined) {
      await this.api(`${this.project(repository)}/hooks/${existing.id}`, { method: 'PUT', body: settings });
      return String(existing.id);
    }
    const { data: created } = await this.api<{ id: number }>(`${this.project(repository)}/hooks`, { method: 'POST', body: settings });
    return String(created.id);
  }

  async deleteWebhook(repository: string, hookId: string): Promise<void> {
    await this.api(`${this.project(repository)}/hooks/${encodeURIComponent(hookId)}`, { method: 'DELETE' });
  }

  async commitStatus(repository: string, sha: string, state: CommitState, details: { key: string; name: string; url: string | null; description: string }): Promise<void> {
    const mapped = { pending: 'running', success: 'success', failure: 'failed', error: 'canceled' }[state];
    await this.api(`${this.project(repository)}/statuses/${sha}`, {
      method: 'POST',
      body: { state: mapped, name: details.name, description: details.description, ...(details.url === null ? {} : { target_url: details.url }) },
    });
  }

  async upsertComment(repository: string, number: number, commentId: number | null, body: string): Promise<number> {
    const notes = `${this.project(repository)}/merge_requests/${number}/notes`;
    if (commentId !== null) {
      try {
        await this.api(`${notes}/${commentId}`, { method: 'PUT', body: { body } });
        return commentId;
      } catch (error) {
        if (!(error instanceof AppError) || error.params?.reason !== 'not_found') throw error;
      }
    }
    const { data } = await this.api<{ id: number }>(notes, { method: 'POST', body: { body } });
    return data.id;
  }

  cloneUrl(repository: string): string {
    return `${this.baseUrl}/${repository}.git`;
  }

  webUrl(repository: string, branch?: string | null): string {
    return branch == null ? `${this.baseUrl}/${repository}` : `${this.baseUrl}/${repository}/-/tree/${branch}`;
  }

  gitAuth(): HttpAuth {
    return { origin: this.baseUrl, authorization: basic('oauth2', this.token) };
  }
}

// ---------------------------------------------------------------------------
// Bitbucket Cloud
// ---------------------------------------------------------------------------

const BITBUCKET_API = 'https://api.bitbucket.org/2.0';
export const BITBUCKET_WEB = 'https://bitbucket.org';
const BITBUCKET_EVENTS = ['repo:push', 'pullrequest:created', 'pullrequest:updated', 'pullrequest:fulfilled', 'pullrequest:rejected'];

interface BitbucketPage<T> {
  values: T[];
  next?: string;
}

interface BitbucketRepository {
  uuid: string;
  full_name: string;
  is_private: boolean;
  mainbranch?: { name?: string } | null;
  description: string | null;
  updated_on: string | null;
  language: string | null;
}

export class BitbucketClient implements ProviderClient {
  readonly kind = 'bitbucket' as const;
  private readonly credentials: GitProviderCredentials;
  private readonly workspace: string | null;
  private readonly fetchImpl: Fetch;

  constructor(credentials: GitProviderCredentials, workspace: string | null, fetchImpl: Fetch = fetch) {
    this.credentials = credentials;
    this.workspace = workspace;
    this.fetchImpl = fetchImpl;
  }

  private get authorization(): string {
    return this.credentials.email === null ? `Bearer ${this.credentials.token}` : basic(this.credentials.email, this.credentials.token);
  }

  private api<T>(pathOrUrl: string, init: { method?: string; body?: unknown } = {}) {
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${BITBUCKET_API}${pathOrUrl}`;
    // `next` links come from Bitbucket itself; anything else is refused rather than sent the token.
    if (!url.startsWith(`${BITBUCKET_API}/`)) throw new AppError('git_provider_error', 'Unexpected Bitbucket address', { params: { provider: 'bitbucket', reason: 'rejected' } });
    return request<T>('bitbucket', this.fetchImpl, url, { ...init, headers: { Authorization: this.authorization } });
  }

  /** Every page of a listing, up to `pages` of them. */
  private async all<T>(path: string, pages = 10): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = path;
    for (let page = 0; page < pages && next !== undefined; page += 1) {
      const { data }: { data: BitbucketPage<T> } = await this.api<BitbucketPage<T>>(next);
      items.push(...data.values);
      next = data.next;
    }
    return items;
  }

  private repo(repository: string): string {
    const [workspace, slug] = repository.split('/');
    return `/repositories/${encodeURIComponent(workspace!)}/${encodeURIComponent(slug!)}`;
  }

  async verify(): Promise<GitAccount> {
    try {
      const { data } = await this.api<{ username?: string; nickname?: string; display_name?: string; links?: { avatar?: { href?: string } } }>('/user');
      return { login: data.username ?? data.nickname ?? data.display_name ?? 'bitbucket', name: data.display_name ?? null, avatarUrl: data.links?.avatar?.href ?? null };
    } catch (error) {
      // Workspace and repository access tokens are not a user: they are checked by listing what they can see.
      if (this.workspace === null || !(error instanceof AppError) || !['permission', 'auth', 'not_found'].includes(String(error.params?.reason))) throw error;
      await this.api(`/repositories/${encodeURIComponent(this.workspace)}?pagelen=1`);
      return { login: this.workspace, name: null, avatarUrl: null };
    }
  }

  async repositories(): Promise<GitRepositoryDto[]> {
    const path = this.workspace === null ? '/repositories?role=member&pagelen=100&sort=-updated_on' : `/repositories/${encodeURIComponent(this.workspace)}?pagelen=100&sort=-updated_on`;
    return (await this.all<BitbucketRepository>(path)).map((repo) => ({
      id: repo.uuid,
      fullName: repo.full_name,
      private: repo.is_private,
      defaultBranch: repo.mainbranch?.name ?? 'main',
      description: repo.description === '' ? null : repo.description,
      updatedAt: repo.updated_on,
      language: repo.language === '' ? null : repo.language,
    }));
  }

  async branches(repository: string): Promise<string[]> {
    return (await this.all<{ name: string }>(`${this.repo(repository)}/refs/branches?pagelen=100`, 5)).map((branch) => branch.name);
  }

  async ensureWebhook(repository: string, url: string, secret: string): Promise<string> {
    const hooks = await this.all<{ uuid: string; url: string }>(`${this.repo(repository)}/hooks?pagelen=100`, 3);
    const existing = hooks.find((hook) => hook.url === url);
    const body = { description: 'TorexPloy', url, active: true, events: BITBUCKET_EVENTS, secret };
    const target = existing === undefined ? `${this.repo(repository)}/hooks` : `${this.repo(repository)}/hooks/${encodeURIComponent(existing.uuid)}`;
    const method = existing === undefined ? 'POST' : 'PUT';
    try {
      const { data } = await this.api<{ uuid: string }>(target, { method, body });
      return data.uuid ?? existing?.uuid ?? '';
    } catch (error) {
      // Should a Bitbucket refuse the secret field, the hook still works: its address carries a token of its own.
      if (!(error instanceof AppError) || error.params?.reason !== 'rejected') throw error;
      const { secret: _secret, ...withoutSecret } = body;
      const { data } = await this.api<{ uuid: string }>(target, { method, body: withoutSecret });
      return data.uuid ?? existing?.uuid ?? '';
    }
  }

  async deleteWebhook(repository: string, hookId: string): Promise<void> {
    await this.api(`${this.repo(repository)}/hooks/${encodeURIComponent(hookId)}`, { method: 'DELETE' });
  }

  async commitStatus(repository: string, sha: string, state: CommitState, details: { key: string; name: string; url: string | null; description: string }): Promise<void> {
    // Bitbucket requires a link; without a public address there is nothing to point at.
    if (details.url === null) return;
    const mapped = { pending: 'INPROGRESS', success: 'SUCCESSFUL', failure: 'FAILED', error: 'STOPPED' }[state];
    await this.api(`${this.repo(repository)}/commit/${sha}/statuses/build`, {
      method: 'POST',
      body: { key: details.key.slice(0, 40), state: mapped, name: details.name, url: details.url, description: details.description },
    });
  }

  async upsertComment(repository: string, number: number, commentId: number | null, body: string): Promise<number> {
    const comments = `${this.repo(repository)}/pullrequests/${number}/comments`;
    if (commentId !== null) {
      try {
        await this.api(`${comments}/${commentId}`, { method: 'PUT', body: { content: { raw: body } } });
        return commentId;
      } catch (error) {
        if (!(error instanceof AppError) || error.params?.reason !== 'not_found') throw error;
      }
    }
    const { data } = await this.api<{ id: number }>(comments, { method: 'POST', body: { content: { raw: body } } });
    return data.id;
  }

  cloneUrl(repository: string): string {
    return `${BITBUCKET_WEB}/${repository}.git`;
  }

  webUrl(repository: string, branch?: string | null): string {
    return branch == null ? `${BITBUCKET_WEB}/${repository}` : `${BITBUCKET_WEB}/${repository}/src/${branch}`;
  }

  gitAuth(): HttpAuth {
    return { origin: BITBUCKET_WEB, authorization: basic('x-token-auth', this.credentials.token) };
  }
}

export function providerClient(provider: Pick<GitProviderRecord, 'kind' | 'baseUrl' | 'workspace'>, credentials: GitProviderCredentials, fetchImpl: Fetch = fetch): ProviderClient {
  return provider.kind === 'gitlab' ? new GitlabClient(provider.baseUrl, credentials, fetchImpl) : new BitbucketClient(credentials, provider.workspace, fetchImpl);
}

// ---------------------------------------------------------------------------
// Webhook deliveries
// ---------------------------------------------------------------------------

export type GitEvent =
  | { kind: 'push'; repository: string; branch: string; sha: string; message: string; author: string | null }
  | {
      kind: 'pull';
      action: 'deploy' | 'close';
      repository: string;
      number: number;
      baseBranch: string;
      headBranch: string;
      /** Full or abbreviated (Bitbucket sends 12 characters). */
      headSha: string;
      title: string;
      url: string;
      author: string | null;
      /** The source branch lives in another repository: its code must not run with this one's secrets. */
      fromFork: boolean;
    }
  | { kind: 'ping' }
  | { kind: 'ignored'; reason: string };

const ZERO_SHA = /^0+$/;
const SKIP_DEPLOY = /\[(skip deploy|deploy skip|skip ci|ci skip)\]/i;

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (typeof value === 'object' && value !== null ? (value as Json) : {});
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A GitLab delivery (`X-Gitlab-Event`) as the events it stands for. */
export function parseGitlabEvent(event: string, payload: Json): GitEvent[] {
  const project = text(obj(payload.project).path_with_namespace);
  if (event === 'Push Hook' && payload.object_kind === 'push') {
    const ref = text(payload.ref);
    const sha = text(payload.checkout_sha) || text(payload.after);
    if (!ref.startsWith('refs/heads/') || sha.length === 0 || ZERO_SHA.test(text(payload.after))) return [{ kind: 'ignored', reason: 'not a branch push' }];
    const commits = Array.isArray(payload.commits) ? (payload.commits as Json[]) : [];
    const head = commits.find((commit) => commit.id === sha) ?? commits[commits.length - 1];
    const message = text(head?.message);
    if (SKIP_DEPLOY.test(message)) return [{ kind: 'ignored', reason: 'skipped by commit message' }];
    return [{ kind: 'push', repository: project, branch: ref.slice('refs/heads/'.length), sha, message, author: text(obj(head?.author).name) || text(payload.user_name) || null }];
  }
  if (event === 'Merge Request Hook' && payload.object_kind === 'merge_request') {
    const attributes = obj(payload.object_attributes);
    const action = text(attributes.action);
    const number = Number(attributes.iid);
    if (!Number.isInteger(number)) return [{ kind: 'ignored', reason: 'no merge request number' }];
    // An update without `oldrev` changed the title or labels, not the code.
    const deploy = action === 'open' || action === 'reopen' || (action === 'update' && text(attributes.oldrev).length > 0);
    const close = action === 'close' || action === 'merge';
    if (!deploy && !close) return [{ kind: 'ignored', reason: `merge request ${action || 'event'}` }];
    return [
      {
        kind: 'pull',
        action: deploy ? 'deploy' : 'close',
        repository: project,
        number,
        baseBranch: text(attributes.target_branch),
        headBranch: text(attributes.source_branch),
        headSha: text(obj(attributes.last_commit).id),
        title: text(attributes.title),
        url: text(attributes.url),
        author: text(obj(payload.user).username) || null,
        fromFork: attributes.source_project_id !== attributes.target_project_id,
      },
    ];
  }
  return [{ kind: 'ignored', reason: event }];
}

/** A Bitbucket delivery (`X-Event-Key`) as the events it stands for. */
export function parseBitbucketEvent(eventKey: string, payload: Json): GitEvent[] {
  if (eventKey === 'diagnostics:ping') return [{ kind: 'ping' }];
  const repository = text(obj(payload.repository).full_name);
  if (eventKey === 'repo:push') {
    const changes = Array.isArray(obj(payload.push).changes) ? (obj(payload.push).changes as Json[]) : [];
    const events: GitEvent[] = [];
    for (const change of changes) {
      const next = obj(change.new);
      if (next.type !== 'branch') continue;
      const target = obj(next.target);
      const sha = text(target.hash);
      const message = text(target.message);
      if (sha.length === 0) continue;
      if (SKIP_DEPLOY.test(message)) {
        events.push({ kind: 'ignored', reason: 'skipped by commit message' });
        continue;
      }
      const author = obj(target.author);
      events.push({ kind: 'push', repository, branch: text(next.name), sha, message, author: text(obj(author.user).display_name) || text(author.raw).replace(/\s*<[^>]*>$/, '') || null });
    }
    return events.length > 0 ? events : [{ kind: 'ignored', reason: 'no branch changes' }];
  }
  if (eventKey.startsWith('pullrequest:')) {
    const action = eventKey.slice('pullrequest:'.length);
    const deploy = action === 'created' || action === 'updated';
    const close = action === 'fulfilled' || action === 'rejected';
    if (!deploy && !close) return [{ kind: 'ignored', reason: eventKey }];
    const pr = obj(payload.pullrequest);
    const source = obj(pr.source);
    const destination = obj(pr.destination);
    const number = Number(pr.id);
    if (!Number.isInteger(number)) return [{ kind: 'ignored', reason: 'no pull request number' }];
    const sourceRepository = text(obj(source.repository).full_name);
    return [
      {
        kind: 'pull',
        action: deploy ? 'deploy' : 'close',
        repository: text(obj(destination.repository).full_name) || repository,
        number,
        baseBranch: text(obj(destination.branch).name),
        headBranch: text(obj(source.branch).name),
        headSha: text(obj(source.commit).hash),
        title: text(pr.title),
        url: text(obj(obj(pr.links).html).href),
        author: text(obj(pr.author).display_name) || null,
        fromFork: sourceRepository.length > 0 && sourceRepository.toLowerCase() !== (text(obj(destination.repository).full_name) || repository).toLowerCase(),
      },
    ];
  }
  return [{ kind: 'ignored', reason: eventKey }];
}
