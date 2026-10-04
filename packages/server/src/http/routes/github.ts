/**
 * GitHub App setup (manifest flow + installation), repository browsing and
 * the webhook receiver.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { githubManifestSchema, type GithubInstallationDto, type GithubStatusDto } from '@ploy/shared';
import type { Context } from '../../context.ts';
import { isPublicOrigin, publicBaseUrl } from '../../github/app.ts';
import { AppError, errorMessage, notFound } from '../../lib/errors.ts';
import { audit, body, query, requestOrigin, requireInstanceAdmin, requireTeam, type Ctx, type Env } from '../core.ts';

const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;

export function registerGithubRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores, github } = ctx;

  const baseUrl = (c: Ctx): string => publicBaseUrl(ctx) ?? requestOrigin(c);

  const installationDto = (record: ReturnType<typeof stores.installations.listForTeam>[number]): GithubInstallationDto => ({
    id: record.id,
    accountLogin: record.accountLogin,
    accountType: record.accountType,
    avatarUrl: record.avatarUrl,
    repositorySelection: record.repositorySelection,
    createdAt: record.createdAt,
  });

  app.get('/api/github', (c) => {
    const auth = requireTeam(c);
    const credentials = github.credentials();
    const base = github.webhookBase();
    const status: GithubStatusDto = {
      configured: credentials !== null,
      app: credentials === null ? null : { id: credentials.appId, slug: credentials.slug, name: credentials.name, htmlUrl: credentials.htmlUrl, owner: credentials.owner },
      installations: stores.installations.listForTeam(auth.teamId).map(installationDto),
      webhookUrl: base === null ? null : `${base}/api/webhooks/github`,
      publicUrlReady: isPublicOrigin(base),
    };
    return c.json(status);
  });

  /** Step 1: the browser posts this manifest to GitHub, which creates the app. */
  app.post('/api/github/manifest', async (c) => {
    const auth = requireInstanceAdmin(c);
    const input = await body(c, githubManifestSchema);
    const base = baseUrl(c);
    const state = github.createState({ kind: 'manifest', teamId: auth.teamId, userId: auth.user.id, baseUrl: base });
    return c.json(github.manifest(base, input.organization ?? null, state));
  });

  /** Step 2: GitHub redirects back with a one-time code for the credentials. */
  app.get('/api/github/manifest/callback', async (c) => {
    const state = github.consumeState(c.req.query('state'), 'manifest');
    const code = c.req.query('code');
    if (code === undefined) return c.redirect('/settings/git?github=failed');
    try {
      const credentials = await github.completeManifest(code, state.baseUrl ?? baseUrl(c));
      stores.audit.record({ teamId: state.teamId, userId: state.userId, action: 'github.app_created', targetType: 'github', targetName: credentials.slug, ip: c.get('ip') });
      // Straight on to installing it on an account.
      const installState = github.createState({ kind: 'install', teamId: state.teamId, userId: state.userId });
      return c.redirect(github.installUrl(installState));
    } catch (error) {
      ctx.logger.warn('GitHub manifest conversion failed', { error: errorMessage(error) });
      return c.redirect('/settings/git?github=failed');
    }
  });

  /** Start installing the app on another account or organization. */
  app.post('/api/github/install', (c) => {
    const auth = requireTeam(c, 'admin');
    const state = github.createState({ kind: 'install', teamId: auth.teamId, userId: auth.user.id });
    return c.json({ url: github.installUrl(state) });
  });

  /** Step 3: GitHub redirects here after the app is installed (or its repository access changes). */
  app.get('/api/github/setup', async (c) => {
    const installationId = Number(c.req.query('installation_id'));
    if (!Number.isInteger(installationId) || installationId <= 0) return c.redirect('/settings/git?github=failed');
    const existing = stores.installations.get(installationId);
    let teamId: string | null = existing?.teamId ?? null;
    const stateToken = c.req.query('state');
    if (stateToken !== undefined) {
      try {
        teamId = github.consumeState(stateToken, 'install').teamId;
      } catch {
        // Updating access from GitHub's side arrives without our state; keep the existing owner.
      }
    }
    if (teamId === null) return c.redirect('/settings/git?github=unknown_installation');
    if (existing !== undefined && existing.teamId !== teamId) return c.redirect('/settings/git?github=claimed');
    try {
      const info = await github.installation(installationId);
      stores.installations.upsert({ ...info, teamId });
      stores.audit.record({ teamId, userId: c.get('auth')?.user.id ?? null, action: 'github.installed', targetType: 'github', targetName: info.accountLogin, ip: c.get('ip') });
      return c.redirect('/settings/git?github=installed');
    } catch (error) {
      ctx.logger.warn('GitHub installation lookup failed', { installationId, error: errorMessage(error) });
      return c.redirect('/settings/git?github=failed');
    }
  });

  app.delete('/api/github/installations/:id', (c) => {
    const auth = requireTeam(c, 'admin');
    const installation = stores.installations.get(Number(c.req.param('id')));
    if (installation === undefined || installation.teamId !== auth.teamId) throw notFound('Installation');
    stores.installations.delete(installation.id);
    audit(ctx, c, 'github.installation_removed', { type: 'github', id: String(installation.id), name: installation.accountLogin });
    return c.json({ ok: true });
  });

  app.delete('/api/github', (c) => {
    requireInstanceAdmin(c);
    github.disconnect();
    audit(ctx, c, 'github.disconnected', { type: 'github' });
    return c.json({ ok: true });
  });

  const installationFor = (c: Ctx, id: number) => {
    const auth = requireTeam(c, 'developer');
    const installation = stores.installations.get(id);
    if (installation === undefined || installation.teamId !== auth.teamId) throw notFound('Installation');
    return installation;
  };

  app.get('/api/github/installations/:id/repositories', async (c) => {
    const installation = installationFor(c, Number(c.req.param('id')));
    return c.json(await github.repositories(installation.id));
  });

  app.get('/api/github/installations/:id/branches', async (c) => {
    const installation = installationFor(c, Number(c.req.param('id')));
    const { repository } = query(c, z.object({ repository: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/) }));
    return c.json(await github.branches(installation.id, repository));
  });

  // ---------------------------------------------------------------- webhook

  app.post('/api/webhooks/github', async (c) => {
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > MAX_WEBHOOK_BYTES) throw new AppError('payload_too_large', 'Payload too large');
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (!github.verifySignature(raw, c.req.header('x-hub-signature-256'))) throw new AppError('unauthorized', 'Invalid signature');
    const event = c.req.header('x-github-event') ?? 'unknown';
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new AppError('bad_request', 'Invalid JSON');
    }
    const result = await github.handleWebhook(event, payload);
    ctx.logger.info('GitHub webhook', { event, delivery: c.req.header('x-github-delivery'), result });
    return c.json({ ok: true, result });
  });
}
