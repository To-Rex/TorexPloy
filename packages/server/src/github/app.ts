/**
 * GitHub integration through a GitHub App.
 *
 * Setup is one click: the dashboard posts an app *manifest* to GitHub, GitHub
 * creates the app (with webhook URL, permissions and events pre-filled) and
 * hands back its credentials, which are stored encrypted. The same app
 * provides:
 * - repository access via short-lived installation tokens (cached ~55 min),
 * - push webhooks that trigger automatic deployments,
 * - pull request webhooks that drive preview deployments (and a comment with the preview's address),
 * - commit statuses (✓/✗ next to each commit),
 * - "Sign in with GitHub" via the app's OAuth credentials.
 */
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import type { GithubRepositoryDto } from '@ploy/shared';
import type { Context } from '../context.ts';
import { constantTimeEqual, hmac } from '../lib/crypto.ts';
import { AppError, errorMessage } from '../lib/errors.ts';
import type { ApplicationRecord } from '../store/index.ts';

const API = 'https://api.github.com';
const SETTINGS_KEY = 'github.app';

export interface GithubCredentials {
  /** Dashboard origin the app was created for; OAuth redirects must use exactly this origin. */
  baseUrl: string;
  appId: number;
  slug: string;
  name: string;
  htmlUrl: string;
  owner: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  privateKey: string;
}

interface PendingState {
  kind: 'manifest' | 'install' | 'login' | 'link';
  teamId: string | null;
  userId: string | null;
  expiresAt: number;
  /** Origin the flow started from (manifest flow). */
  baseUrl?: string;
}

const STATE_TTL_MS = 15 * 60_000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export class GithubApp {
  private readonly ctx: Context;
  private readonly tokens = new Map<number, { token: string; expiresAt: number }>();
  private readonly states = new Map<string, PendingState>();
  private cached: GithubCredentials | null | undefined;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  // ------------------------------------------------------------ credentials

  credentials(): GithubCredentials | null {
    if (this.cached !== undefined) return this.cached;
    const sealed = this.ctx.stores.settings.getRaw(SETTINGS_KEY);
    this.cached = sealed === null ? null : this.ctx.secrets.openJson<GithubCredentials>(sealed, 'github');
    return this.cached;
  }

  private requireCredentials(): GithubCredentials {
    const credentials = this.credentials();
    if (credentials === null) throw new AppError('github_not_configured', 'GitHub is not connected yet');
    return credentials;
  }

  private store(credentials: GithubCredentials | null): void {
    this.ctx.stores.settings.setRaw(SETTINGS_KEY, credentials === null ? null : this.ctx.secrets.sealJson(credentials, 'github'));
    this.cached = credentials;
    this.tokens.clear();
  }

  disconnect(): void {
    this.store(null);
  }

  /** Origin GitHub delivers webhooks to: the one the app was created for, else the panel's public URL. */
  webhookBase(): string | null {
    return this.credentials()?.baseUrl ?? publicBaseUrl(this.ctx);
  }

  /** The app is connected and GitHub can reach its webhook (pushes and pull requests arrive). */
  webhookReady(): boolean {
    return this.credentials() !== null && isPublicOrigin(this.webhookBase());
  }

  // ------------------------------------------------------------------ state

  createState(state: Omit<PendingState, 'expiresAt'>): string {
    const now = Date.now();
    for (const [key, value] of this.states) if (value.expiresAt < now) this.states.delete(key);
    const token = randomBytes(24).toString('base64url');
    this.states.set(token, { ...state, expiresAt: now + STATE_TTL_MS });
    return token;
  }

  /** Single-use: a state is consumed by the first callback that presents it. */
  consumeState(token: string | undefined, kinds: PendingState['kind'] | PendingState['kind'][]): PendingState {
    const accepted = Array.isArray(kinds) ? kinds : [kinds];
    const state = token === undefined ? undefined : this.states.get(token);
    if (token !== undefined) this.states.delete(token);
    if (state === undefined || !accepted.includes(state.kind) || state.expiresAt < Date.now()) {
      throw new AppError('bad_request', 'This GitHub link has expired. Start again from the dashboard.', { params: { reason: 'state' } });
    }
    return state;
  }

  // --------------------------------------------------------------- manifest

  manifest(publicUrl: string, organization: string | null, state: string): { action: string; manifest: string } {
    const suffix = randomBytes(3).toString('hex');
    const manifest = {
      name: `TorexPloy ${suffix}`,
      url: publicUrl,
      hook_attributes: { url: `${publicUrl}/api/webhooks/github`, active: true },
      redirect_url: `${publicUrl}/api/github/manifest/callback`,
      callback_urls: [`${publicUrl}/api/auth/github/callback`],
      setup_url: `${publicUrl}/api/github/setup`,
      setup_on_update: true,
      public: false,
      // `emails` — the manifest's name for "Email addresses" (read by /user/emails at sign-in); GitHub refuses
      // a manifest that says `email_addresses` ("Default permission records resource is not included in the list").
      default_permissions: { contents: 'read', metadata: 'read', statuses: 'write', pull_requests: 'write', emails: 'read' },
      default_events: ['push', 'pull_request'],
    };
    const base = organization === null ? 'https://github.com/settings/apps/new' : `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`;
    return { action: `${base}?state=${encodeURIComponent(state)}`, manifest: JSON.stringify(manifest) };
  }

  /** Exchange the one-time manifest code for the new app's credentials. */
  async completeManifest(code: string, baseUrl: string): Promise<GithubCredentials> {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(code)) throw new AppError('bad_request', 'Invalid manifest code');
    const response = await fetch(`${API}/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'TorexPloy' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new AppError('github_error', `GitHub rejected the app manifest (${response.status})`);
    const data = (await response.json()) as {
      id: number;
      slug: string;
      name: string;
      html_url: string;
      owner: { login: string };
      client_id: string;
      client_secret: string;
      webhook_secret: string;
      pem: string;
    };
    const credentials: GithubCredentials = {
      baseUrl,
      appId: data.id,
      slug: data.slug,
      name: data.name,
      htmlUrl: data.html_url,
      owner: data.owner.login,
      clientId: data.client_id,
      clientSecret: data.client_secret,
      webhookSecret: data.webhook_secret,
      privateKey: data.pem,
    };
    this.store(credentials);
    return credentials;
  }

  installUrl(state: string): string {
    return `https://github.com/apps/${this.requireCredentials().slug}/installations/new?state=${encodeURIComponent(state)}`;
  }

  // ---------------------------------------------------------------- tokens

  /** App JWT (RS256), valid 9 minutes, backdated 60s for clock skew — as GitHub recommends. */
  appJwt(now: number = Date.now()): string {
    const credentials = this.requireCredentials();
    const iat = Math.floor(now / 1000) - 60;
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ iat, exp: iat + 600, iss: String(credentials.appId) }));
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPrivateKey(credentials.privateKey));
    return `${header}.${payload}.${base64url(signature)}`;
  }

  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached !== undefined && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const data = await this.request<{ token: string; expires_at: string }>(`/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      auth: `Bearer ${this.appJwt()}`,
    });
    this.tokens.set(installationId, { token: data.token, expiresAt: Date.parse(data.expires_at) });
    return data.token;
  }

  private async request<T>(path: string, options: { method?: string; auth: string; body?: unknown }): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: options.auth,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'TorexPloy',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new AppError('github_error', `GitHub is unreachable: ${errorMessage(error)}`);
    }
    if (response.status === 404) throw new AppError('not_found', 'Not found on GitHub', { params: { resource: 'github' } });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new AppError('github_error', `GitHub API ${response.status}: ${body.message ?? response.statusText}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  // ----------------------------------------------------------- read models

  async installation(installationId: number): Promise<{ id: number; accountLogin: string; accountType: 'User' | 'Organization'; avatarUrl: string | null; repositorySelection: 'all' | 'selected' }> {
    const data = await this.request<{ id: number; account: { login: string; type: string; avatar_url: string }; repository_selection: 'all' | 'selected' }>(
      `/app/installations/${installationId}`,
      { auth: `Bearer ${this.appJwt()}` },
    );
    return {
      id: data.id,
      accountLogin: data.account.login,
      accountType: data.account.type === 'Organization' ? 'Organization' : 'User',
      avatarUrl: data.account.avatar_url,
      repositorySelection: data.repository_selection,
    };
  }

  async repositories(installationId: number): Promise<GithubRepositoryDto[]> {
    const token = await this.installationToken(installationId);
    const repos: GithubRepositoryDto[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const data = await this.request<{
        total_count: number;
        repositories: { id: number; full_name: string; private: boolean; default_branch: string; description: string | null; pushed_at: string | null; language: string | null }[];
      }>(`/installation/repositories?per_page=100&page=${page}`, { auth: `token ${token}` });
      for (const repo of data.repositories) {
        repos.push({
          id: repo.id,
          fullName: repo.full_name,
          private: repo.private,
          defaultBranch: repo.default_branch,
          description: repo.description,
          updatedAt: repo.pushed_at,
          language: repo.language,
        });
      }
      if (repos.length >= data.total_count || data.repositories.length < 100) break;
    }
    return repos.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  async branches(installationId: number, repository: string): Promise<string[]> {
    const token = await this.installationToken(installationId);
    const names: string[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const data = await this.request<{ name: string }[]>(`/repos/${repository}/branches?per_page=100&page=${page}`, { auth: `token ${token}` });
      names.push(...data.map((branch) => branch.name));
      if (data.length < 100) break;
    }
    return names;
  }

  async commitStatus(app: ApplicationRecord, sha: string, state: 'pending' | 'success' | 'failure' | 'error', deploymentId: string): Promise<void> {
    if (this.credentials() === null || app.githubInstallationId === null || app.repository === null) return;
    const token = await this.installationToken(app.githubInstallationId);
    const publicUrl = publicBaseUrl(this.ctx);
    const description = { pending: 'Deploying…', success: 'Deployed', failure: 'Deployment failed', error: 'Deployment cancelled' }[state];
    await this.request(`/repos/${app.repository}/statuses/${sha}`, {
      method: 'POST',
      auth: `token ${token}`,
      body: {
        state,
        context: `TorexPloy / ${app.name}`,
        description,
        ...(publicUrl === null ? {} : { target_url: `${publicUrl}/deployments/${deploymentId}` }),
      },
    });
  }

  /** Comment on an issue or pull request, or edit `commentId` in place. Returns the comment's id. */
  async upsertIssueComment(installationId: number, repository: string, issue: number, commentId: number | null, body: string): Promise<number> {
    const auth = `token ${await this.installationToken(installationId)}`;
    if (commentId !== null) {
      try {
        await this.request(`/repos/${repository}/issues/comments/${commentId}`, { method: 'PATCH', auth, body: { body } });
        return commentId;
      } catch (error) {
        // Deleted on GitHub: post a fresh one.
        if (!(error instanceof AppError) || error.code !== 'not_found') throw error;
      }
    }
    const created = await this.request<{ id: number }>(`/repos/${repository}/issues/${issue}/comments`, { method: 'POST', auth, body: { body } });
    return created.id;
  }

  // --------------------------------------------------------------- webhook

  verifySignature(body: Buffer, signature: string | undefined): boolean {
    const credentials = this.credentials();
    if (credentials === null || signature === undefined || !signature.startsWith('sha256=')) return false;
    return constantTimeEqual(`sha256=${hmac(credentials.webhookSecret, body)}`, signature);
  }

  /** Handle a verified webhook delivery. Returns a short summary for the delivery log. */
  async handleWebhook(event: string, payload: Record<string, unknown>): Promise<string> {
    const { stores } = this.ctx;
    const installationId = (payload.installation as { id?: number } | undefined)?.id;

    if (event === 'ping') return 'pong';

    if (event === 'installation' || event === 'installation_repositories') {
      if (installationId === undefined) return 'ignored';
      const action = String(payload.action);
      const known = stores.installations.get(installationId);
      if (action === 'deleted') {
        if (known !== undefined) stores.installations.delete(installationId);
        return 'installation removed';
      }
      if (known !== undefined) {
        const info = await this.installation(installationId);
        stores.installations.upsert({ ...info, teamId: known.teamId });
      }
      return 'installation updated';
    }

    if (event === 'push') {
      const ref = String(payload.ref ?? '');
      if (!ref.startsWith('refs/heads/') || payload.deleted === true || installationId === undefined) return 'ignored';
      const branch = ref.slice('refs/heads/'.length);
      const repository = String((payload.repository as { full_name?: string } | undefined)?.full_name ?? '');
      const head = payload.head_commit as { id?: string; message?: string; author?: { name?: string } } | null;
      if (head?.id === undefined) return 'ignored';
      const message = head.message ?? '';
      if (/\[(skip deploy|deploy skip|skip ci|ci skip)\]/i.test(message)) return 'skipped by commit message';

      const apps = stores.applications.findForPush(installationId, repository, branch);
      for (const app of apps) {
        this.ctx.deployer.enqueue({
          app,
          trigger: 'push',
          createdBy: null,
          commitSha: head.id,
          commitMessage: message.split('\n')[0]?.slice(0, 500) ?? null,
          commitAuthor: head.author?.name ?? null,
        });
      }
      return `queued ${apps.length} deployment(s)`;
    }

    if (event === 'pull_request') return this.ctx.previews.handlePullRequest(installationId, payload);

    return 'ignored';
  }

  // ------------------------------------------------------------------ OAuth

  oauthUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({ client_id: this.requireCredentials().clientId, redirect_uri: redirectUri, state, allow_signup: 'false' });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /** Exchange an OAuth code and return the GitHub user with their verified primary email. */
  async oauthUser(code: string, redirectUri: string): Promise<{ id: string; login: string; name: string; email: string | null; avatarUrl: string | null }> {
    const credentials = this.requireCredentials();
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'TorexPloy' },
      body: JSON.stringify({ client_id: credentials.clientId, client_secret: credentials.clientSecret, code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(20_000),
    });
    const token = (await response.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
    if (token.access_token === undefined) throw new AppError('github_error', token.error_description ?? 'GitHub sign-in failed');
    const auth = `Bearer ${token.access_token}`;
    const user = await this.request<{ id: number; login: string; name: string | null; avatar_url: string | null }>('/user', { auth });
    const emails = await this.request<{ email: string; primary: boolean; verified: boolean }[]>('/user/emails', { auth }).catch(() => []);
    const primary = emails.find((email) => email.primary && email.verified) ?? emails.find((email) => email.verified);
    return { id: String(user.id), login: user.login, name: user.name ?? user.login, email: primary?.email ?? null, avatarUrl: user.avatar_url };
  }
}

/** Whether GitHub could reach `origin` (not a loopback or private-network address). */
export function isPublicOrigin(origin: string | null): boolean {
  return origin !== null && !/^https?:\/\/(localhost|127\.|10\.|192\.168\.)/.test(origin);
}

/** The dashboard's public origin: explicit config, else the platform domain, else null. */
export function publicBaseUrl(ctx: Context): string | null {
  if (ctx.config.publicUrl !== null) return ctx.config.publicUrl;
  const { platformDomain } = ctx.stores.settings.platform();
  return platformDomain === null ? null : `https://${platformDomain}`;
}
