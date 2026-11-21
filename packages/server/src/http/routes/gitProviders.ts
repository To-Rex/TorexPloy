/**
 * GitLab and Bitbucket connections (an account reached with an access token),
 * their repositories and branches for the repository chooser, and the
 * receivers their webhooks call.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { BITBUCKET_REPO_RE, createGitProviderSchema, GITLAB_PATH_RE, updateGitProviderSchema, type GitProviderDto, type GitProviderWebhookDto } from '@ploy/shared';
import type { Context } from '../../context.ts';
import { AppError, notFound } from '../../lib/errors.ts';
import type { GitProviderRecord } from '../../store/index.ts';
import { audit, body, query, requireTeam, type Ctx, type Env } from '../core.ts';

const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;

export function gitProviderDto(ctx: Context, provider: GitProviderRecord): GitProviderDto {
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    baseUrl: provider.baseUrl,
    account: { login: provider.accountLogin, name: provider.accountName, avatarUrl: provider.avatarUrl },
    workspace: provider.workspace,
    hasEmail: ctx.stores.gitProviders.credentials(provider.id).email !== null,
    webhookUrl: ctx.gitProviders.webhookUrl(provider),
    usedBy: ctx.stores.applications.countForProvider(provider.id),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

export function registerGitProviderRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;

  const load = (c: Ctx, role: 'viewer' | 'developer' | 'admin') => {
    const auth = requireTeam(c, role);
    const provider = stores.gitProviders.getForTeam(auth.teamId, c.req.param('id')!);
    if (provider === undefined) throw notFound('Connection');
    return provider;
  };

  app.get('/api/git-providers', (c) => {
    const auth = requireTeam(c);
    return c.json(stores.gitProviders.listForTeam(auth.teamId).map((provider) => gitProviderDto(ctx, provider)));
  });

  app.post('/api/git-providers', async (c) => {
    const auth = requireTeam(c, 'admin');
    const input = await body(c, createGitProviderSchema);
    const provider = await ctx.gitProviders.connect(auth.teamId, input, auth.user.id);
    audit(ctx, c, 'git.connected', { type: 'git', id: provider.id, name: provider.name }, { kind: provider.kind, account: provider.accountLogin, baseUrl: provider.baseUrl });
    return c.json(gitProviderDto(ctx, provider), 201);
  });

  app.patch('/api/git-providers/:id', async (c) => {
    const provider = load(c, 'admin');
    const input = await body(c, updateGitProviderSchema);
    if (provider.kind === 'gitlab' && (input.email != null || input.workspace != null)) {
      throw new AppError('validation_failed', 'GitLab connections have no email or workspace', { issues: [{ path: input.email != null ? 'email' : 'workspace', code: 'custom', message: 'Not for GitLab' }] });
    }
    let updated = provider;
    if (input.token !== undefined || input.email !== undefined || input.workspace !== undefined) {
      updated = await ctx.gitProviders.reconnect(provider, {
        ...(input.token === undefined ? {} : { token: input.token }),
        ...(input.email === undefined ? {} : { email: input.email }),
        ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
      });
    }
    if (input.name !== undefined) updated = stores.gitProviders.update(provider.id, { name: input.name });
    audit(ctx, c, 'git.updated', { type: 'git', id: provider.id, name: updated.name }, { token: input.token !== undefined, fields: Object.keys(input).filter((key) => key !== 'token') });
    return c.json(gitProviderDto(ctx, updated));
  });

  app.delete('/api/git-providers/:id', async (c) => {
    const provider = load(c, 'admin');
    const usedBy = stores.applications.countForProvider(provider.id);
    if (usedBy > 0) throw new AppError('conflict', `${usedBy} application(s) still build from this connection`, { params: { reason: 'in_use', count: usedBy } });
    await ctx.gitProviders.removeWebhooks(provider);
    stores.gitProviders.delete(provider.id);
    audit(ctx, c, 'git.disconnected', { type: 'git', id: provider.id, name: provider.name }, { kind: provider.kind, account: provider.accountLogin });
    return c.json({ ok: true });
  });

  app.get('/api/git-providers/:id/repositories', async (c) => {
    const provider = load(c, 'developer');
    return c.json(await ctx.gitProviders.client(provider).repositories());
  });

  app.get('/api/git-providers/:id/branches', async (c) => {
    const provider = load(c, 'developer');
    const pattern = provider.kind === 'gitlab' ? GITLAB_PATH_RE : BITBUCKET_REPO_RE;
    const { repository } = query(c, z.object({ repository: z.string().max(255).regex(pattern) }));
    return c.json(await ctx.gitProviders.client(provider).branches(repository));
  });

  /** The address and secret for setting a webhook up by hand. Administrators only: with the secret, anyone can trigger deployments. */
  app.get('/api/git-providers/:id/webhook', (c) => {
    const provider = load(c, 'admin');
    audit(ctx, c, 'git.webhook_secret_viewed', { type: 'git', id: provider.id, name: provider.name });
    const webhook: GitProviderWebhookDto = { url: ctx.gitProviders.webhookUrl(provider), secret: stores.gitProviders.webhookSecret(provider.id) };
    return c.json(webhook);
  });

  // --------------------------------------------------------------- webhooks

  const receive = (kind: 'gitlab' | 'bitbucket') => async (c: Ctx) => {
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > MAX_WEBHOOK_BYTES) throw new AppError('payload_too_large', 'Payload too large');
    const provider = stores.gitProviders.get(c.req.param('id')!);
    const raw = Buffer.from(await c.req.arrayBuffer());
    // An unknown connection and a wrong secret look the same from outside.
    const headers = { get: (name: string) => c.req.header(name) };
    if (provider === undefined || provider.kind !== kind || !ctx.gitProviders.verifyDelivery(provider, headers, raw, { token: c.req.query('token') })) {
      throw new AppError('unauthorized', 'Invalid webhook signature');
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new AppError('bad_request', 'Invalid JSON');
    }
    const event = (kind === 'gitlab' ? c.req.header('x-gitlab-event') : c.req.header('x-event-key')) ?? 'unknown';
    const result = await ctx.gitProviders.handleDelivery(provider, event, payload);
    ctx.logger.info(`${kind === 'gitlab' ? 'GitLab' : 'Bitbucket'} webhook`, { providerId: provider.id, event, result });
    return c.json({ ok: true, result });
  };

  app.post('/api/webhooks/gitlab/:id', receive('gitlab'));
  app.post('/api/webhooks/bitbucket/:id', receive('bitbucket'));
}
