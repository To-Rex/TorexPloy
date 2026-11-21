/**
 * GitLab and Bitbucket connections at work: connecting an account, the
 * webhook each repository in use needs (set up by the panel when the token
 * may, explained for doing by hand when it may not), deliveries from those
 * webhooks, commit statuses and merge/pull request comments, and the
 * credentials a checkout of any repository source needs (GitHub included).
 */
import type { CreateGitProviderInput, GitHookStatusDto, GitProviderKind } from '@ploy/shared';
import type { Context } from '../context.ts';
import { isPublicOrigin, publicBaseUrl } from '../github/app.ts';
import { constantTimeEqual, hmac } from '../lib/crypto.ts';
import { AppError, errorMessage } from '../lib/errors.ts';
import type { ApplicationRecord, GitHookRecord, GitProviderCredentials, GitProviderRecord } from '../store/index.ts';
import { BITBUCKET_WEB, parseBitbucketEvent, parseGitlabEvent, providerClient, type CommitState, type Fetch, type GitEvent, type HttpAuth, type ProviderClient } from './providers.ts';

const LABELS: Record<GitProviderKind, string> = { gitlab: 'GitLab', bitbucket: 'Bitbucket' };

export interface SourceAccess {
  url: string;
  httpAuth: HttpAuth | null;
  /** Values to keep out of logs. */
  secrets: string[];
}

export class GitProviders {
  private readonly ctx: Context;
  /** The HTTP client the connections talk through (replaced in tests). */
  fetch: Fetch = (input, init) => fetch(input, init);

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  client(provider: GitProviderRecord, credentials: GitProviderCredentials = this.ctx.stores.gitProviders.credentials(provider.id)): ProviderClient {
    return providerClient(provider, credentials, this.fetch);
  }

  // ------------------------------------------------------------ connections

  /** Check the token against the host, then keep it. */
  async connect(teamId: string, input: CreateGitProviderInput, userId: string | null): Promise<GitProviderRecord> {
    const baseUrl = input.kind === 'gitlab' ? (input.baseUrl ?? 'https://gitlab.com').replace(/\/+$/, '') : BITBUCKET_WEB;
    const workspace = input.kind === 'bitbucket' ? (input.workspace ?? null) : null;
    const credentials: GitProviderCredentials = { token: input.token.trim(), email: input.kind === 'bitbucket' ? (input.email ?? null) : null };
    const account = await providerClient({ kind: input.kind, baseUrl, workspace }, credentials, this.fetch).verify();
    const name = input.name ?? (input.kind === 'gitlab' && baseUrl !== 'https://gitlab.com' ? `${new URL(baseUrl).host} · ${account.login}` : `${LABELS[input.kind]} · ${workspace ?? account.login}`);
    return this.ctx.stores.gitProviders.create({ teamId, kind: input.kind, name: name.slice(0, 64), baseUrl, account, workspace, credentials, createdBy: userId });
  }

  /** A new token (or email, or workspace): checked before it replaces what was there. */
  async reconnect(provider: GitProviderRecord, patch: { token?: string; email?: string | null; workspace?: string | null }): Promise<GitProviderRecord> {
    const current = this.ctx.stores.gitProviders.credentials(provider.id);
    const credentials: GitProviderCredentials = { token: patch.token?.trim() ?? current.token, email: patch.email === undefined ? current.email : patch.email };
    const workspace = patch.workspace === undefined ? provider.workspace : patch.workspace;
    const account = await providerClient({ ...provider, workspace }, credentials, this.fetch).verify();
    return this.ctx.stores.gitProviders.update(provider.id, { credentials, workspace, account });
  }

  /** Remove the webhooks the panel made on the connection's repositories; best effort (the token may already be revoked). */
  async removeWebhooks(provider: GitProviderRecord): Promise<void> {
    const client = this.client(provider);
    for (const hook of this.ctx.stores.gitProviders.hooks(provider.id)) {
      if (hook.hookId === null || hook.hookId.length === 0) continue;
      await client.deleteWebhook(hook.repository, hook.hookId).catch((error: unknown) =>
        this.ctx.logger.info('Could not remove a webhook', { providerId: provider.id, repository: hook.repository, error: errorMessage(error) }),
      );
    }
  }

  // ---------------------------------------------------------------- webhooks

  /** A token for Bitbucket hook addresses, so a hook set up without a secret is still verified. */
  private urlToken(provider: GitProviderRecord): string {
    return hmac(this.ctx.stores.gitProviders.webhookSecret(provider.id), 'webhook-url').slice(0, 32);
  }

  /** Where the repositories of this connection send their events; null without a public address. */
  webhookUrl(provider: GitProviderRecord): string | null {
    const base = publicBaseUrl(this.ctx);
    if (base === null) return null;
    const url = `${base}/api/webhooks/${provider.kind}/${provider.id}`;
    return provider.kind === 'bitbucket' ? `${url}?token=${this.urlToken(provider)}` : url;
  }

  hookStatus(app: ApplicationRecord): GitHookStatusDto {
    const provider = app.gitProviderId === null ? undefined : this.ctx.stores.gitProviders.get(app.gitProviderId);
    if (provider === undefined || app.repository === null) return { status: 'failed', reason: 'no_connection', message: null, url: null, updatedAt: null };
    const hook = this.ctx.stores.gitProviders.hook(provider.id, app.repository);
    const url = this.webhookUrl(provider);
    if (hook === undefined) return { status: 'pending', reason: null, message: null, url, updatedAt: null };
    return { status: hook.status, reason: hook.reason, message: hook.message, url, updatedAt: hook.updatedAt };
  }

  /**
   * Make sure the repository an application builds from calls the panel on pushes and merge/pull requests.
   * Never throws: how it went is recorded, and shown with the application.
   */
  async ensureWebhook(app: ApplicationRecord): Promise<GitHookRecord | null> {
    const { stores } = this.ctx;
    if ((app.sourceType !== 'gitlab' && app.sourceType !== 'bitbucket') || app.gitProviderId === null || app.repository === null) return null;
    const provider = stores.gitProviders.get(app.gitProviderId);
    if (provider === undefined) return null;
    const url = this.webhookUrl(provider);
    const origin = publicBaseUrl(this.ctx);
    if (url === null || !isPublicOrigin(origin)) {
      return stores.gitProviders.setHook(provider.id, app.repository, {
        status: 'failed',
        reason: 'no_public_url',
        message: `${LABELS[provider.kind]} cannot reach this panel: give it a public domain (Settings → Web server), then check again`,
      });
    }
    try {
      const hookId = await this.client(provider).ensureWebhook(app.repository, url, stores.gitProviders.webhookSecret(provider.id));
      return stores.gitProviders.setHook(provider.id, app.repository, { status: 'ok', hookId });
    } catch (error) {
      const reason = error instanceof AppError && typeof error.params?.reason === 'string' ? error.params.reason : 'unknown';
      return stores.gitProviders.setHook(provider.id, app.repository, { status: 'failed', reason, message: errorMessage(error) });
    }
  }

  /** Whether a delivery came from the connection's webhook. */
  verifyDelivery(provider: GitProviderRecord, headers: { get(name: string): string | undefined }, body: Buffer, query: { token?: string | undefined }): boolean {
    const secret = this.ctx.stores.gitProviders.webhookSecret(provider.id);
    if (provider.kind === 'gitlab') {
      const token = headers.get('x-gitlab-token');
      return token !== undefined && constantTimeEqual(token, secret);
    }
    // Bitbucket: the HMAC signature when the hook has the secret, else the token in its address.
    const signature = headers.get('x-hub-signature');
    if (signature !== undefined) return signature.startsWith('sha256=') && constantTimeEqual(`sha256=${hmac(secret, body)}`, signature);
    return query.token !== undefined && constantTimeEqual(query.token, this.urlToken(provider));
  }

  /** Act on a verified delivery. Returns a short summary for the log and the sender. */
  async handleDelivery(provider: GitProviderRecord, event: string, payload: Record<string, unknown>): Promise<string> {
    const events: GitEvent[] = provider.kind === 'gitlab' ? parseGitlabEvent(event, payload) : parseBitbucketEvent(event, payload);
    const summary: string[] = [];
    for (const change of events) {
      if (change.kind === 'ping') summary.push('pong');
      else if (change.kind === 'ignored') summary.push(`ignored: ${change.reason}`);
      else if (change.kind === 'push') {
        const apps = this.ctx.stores.applications.findForProviderPush(provider.id, change.repository, change.branch);
        for (const app of apps) {
          this.ctx.deployer.enqueue({
            app,
            trigger: 'push',
            createdBy: null,
            commitSha: change.sha,
            commitMessage: change.message.split('\n')[0]?.slice(0, 500) ?? null,
            commitAuthor: change.author,
          });
        }
        // A delivery is proof that the webhook works, whatever was recorded about it before.
        if (this.ctx.stores.gitProviders.hook(provider.id, change.repository)?.status === 'failed') {
          this.ctx.stores.gitProviders.setHook(provider.id, change.repository, { status: 'ok' });
        }
        summary.push(`queued ${apps.length} deployment(s)`);
      } else {
        summary.push(await this.ctx.previews.handleChange({ kind: provider.kind, providerId: provider.id, teamId: provider.teamId }, change));
      }
    }
    return summary.join('; ');
  }

  // -------------------------------------------------------------- reporting

  /** The commit's deployment, next to the commit on GitLab or Bitbucket. Best effort. */
  async commitStatus(app: ApplicationRecord, sha: string, state: CommitState, deploymentId: string): Promise<void> {
    if (app.gitProviderId === null || app.repository === null) return;
    const provider = this.ctx.stores.gitProviders.get(app.gitProviderId);
    if (provider === undefined) return;
    const base = publicBaseUrl(this.ctx);
    const description = { pending: 'Deploying…', success: 'Deployed', failure: 'Deployment failed', error: 'Deployment cancelled' }[state];
    await this.client(provider).commitStatus(app.repository, sha, state, {
      key: `torexploy-${app.id}`,
      name: `TorexPloy / ${app.name}`,
      url: base === null ? null : `${base}/deployments/${deploymentId}`,
      description,
    });
  }

  async comment(app: ApplicationRecord, number: number, commentId: number | null, body: string): Promise<number | null> {
    if (app.gitProviderId === null || app.repository === null) return null;
    const provider = this.ctx.stores.gitProviders.get(app.gitProviderId);
    if (provider === undefined) return null;
    return this.client(provider).upsertComment(app.repository, number, commentId, body);
  }

  webUrl(app: ApplicationRecord): string | null {
    if (app.gitProviderId === null || app.repository === null) return null;
    const provider = this.ctx.stores.gitProviders.get(app.gitProviderId);
    return provider === undefined ? null : providerClient(provider, { token: '', email: null }).webUrl(app.repository, app.branch);
  }

  // ----------------------------------------------------------------- access

  /** The clone address of an application's repository and the credentials git needs for it, whatever the host. */
  async access(app: ApplicationRecord): Promise<SourceAccess> {
    if (app.sourceType === 'github') {
      if (app.repository === null) throw new AppError('bad_request', 'Application has no repository configured');
      const url = `https://github.com/${app.repository}.git`;
      if (app.githubInstallationId === null) return { url, httpAuth: null, secrets: [] };
      const token = await this.ctx.github.installationToken(app.githubInstallationId);
      return { url, httpAuth: { origin: 'https://github.com', authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` }, secrets: [token] };
    }
    if (app.sourceType === 'gitlab' || app.sourceType === 'bitbucket') {
      const provider = app.gitProviderId === null ? undefined : this.ctx.stores.gitProviders.get(app.gitProviderId);
      if (provider === undefined || app.repository === null) {
        throw new AppError('bad_request', `The ${LABELS[app.sourceType]} connection of this application was removed: choose the repository again`, { params: { reason: 'git_connection_missing' } });
      }
      const credentials = this.ctx.stores.gitProviders.credentials(provider.id);
      const client = this.client(provider, credentials);
      return { url: client.cloneUrl(app.repository), httpAuth: client.gitAuth(), secrets: [credentials.token] };
    }
    if (app.gitUrl !== null) return { url: app.gitUrl, httpAuth: null, secrets: [] };
    throw new AppError('bad_request', 'Application has no repository configured');
  }

  /** The deployment's state next to its commit, wherever the repository lives. Never throws. */
  reportCommit(app: ApplicationRecord, sha: string, state: CommitState, deploymentId: string): void {
    const report =
      app.sourceType === 'github' && app.githubInstallationId !== null
        ? this.ctx.github.commitStatus(app, sha, state, deploymentId)
        : app.sourceType === 'gitlab' || app.sourceType === 'bitbucket'
          ? this.commitStatus(app, sha, state, deploymentId)
          : Promise.resolve();
    void report.catch((error: unknown) => this.ctx.logger.debug('Could not report a commit status', { applicationId: app.id, error: errorMessage(error) }));
  }
}
