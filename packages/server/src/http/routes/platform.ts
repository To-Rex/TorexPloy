/**
 * Instance settings, health, the realtime event stream and deploy hooks.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { platformSettingsSchema, type HealthDto, type PlatformSettingsDto } from '@ploy/shared';
import type { Context } from '../../context.ts';
import { publicBaseUrl } from '../../github/app.ts';
import { constantTimeEqual } from '../../lib/crypto.ts';
import { AppError, notFound } from '../../lib/errors.ts';
import { audit, body, limit, RateLimiter, requireAuth, requireInstanceAdmin, type Env } from '../core.ts';

export function registerPlatformRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;
  const hookLimiter = new RateLimiter(30, 30);

  const settingsDto = (): PlatformSettingsDto => {
    const settings = stores.settings.platform();
    return { ...settings, publicUrl: publicBaseUrl(ctx), publicIp: stores.servers.getLocal()?.publicIp ?? null };
  };

  app.get('/api/settings', (c) => {
    requireInstanceAdmin(c);
    return c.json(settingsDto());
  });

  app.patch('/api/settings', async (c) => {
    requireInstanceAdmin(c);
    const input = await body(c, platformSettingsSchema);
    const before = stores.settings.platform();
    if (input.platformDomain != null && stores.domains.findByHost(input.platformDomain) !== undefined) {
      throw new AppError('domain_taken', 'This domain is already used by an application', { params: { host: input.platformDomain } });
    }
    const after = stores.settings.updatePlatform(input);
    audit(ctx, c, 'settings.updated', { type: 'settings', teamId: null }, { fields: Object.keys(input) });
    if (before.platformDomain !== after.platformDomain || before.acmeEmail !== after.acmeEmail) {
      for (const server of stores.servers.listAll()) void ctx.proxy.requestSync(server.id).catch(() => undefined);
    }
    if (before.buildConcurrency !== after.buildConcurrency) ctx.deployer.tick();
    return c.json(settingsDto());
  });

  app.get('/api/health', (c) => {
    let dbOk = true;
    try {
      stores.db.scalar('SELECT 1');
    } catch {
      dbOk = false;
    }
    const local = stores.servers.getLocal();
    const checks: HealthDto['checks'] = {
      database: { ok: dbOk },
      docker: { ok: local?.status === 'ready', ...(local?.statusMessage ? { detail: local.statusMessage } : {}) },
      proxy: { ok: local?.proxyInfo?.running === true },
    };
    const health: HealthDto = {
      status: Object.values(checks).every((check) => check.ok) ? 'ok' : 'degraded',
      version: ctx.config.version,
      uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
      checks,
    };
    // Liveness depends on the database only; Docker/proxy problems are reported, not fatal.
    return c.json(health, dbOk ? 200 : 503);
  });

  /** Team-scoped realtime events. One connection per dashboard tab. */
  app.get('/api/events', (c) => {
    const auth = requireAuth(c);
    return streamSSE(c, async (stream) => {
      // Scoped to the team the connection was opened in; the dashboard reconnects after switching teams.
      const scope = auth.teamId;
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = ctx.bus.onTeamEvent(({ teamId, event }) => {
        if (teamId !== scope) return;
        if (queue.length > 1_000) queue.shift(); // a stalled client loses old signals, not memory
        queue.push(JSON.stringify(event));
        wake?.();
      });
      let open = true;
      stream.onAbort(() => {
        open = false;
        wake?.();
      });
      try {
        await stream.writeSSE({ event: 'ready', data: '{}', retry: 3_000 });
        while (open) {
          const next = queue.shift();
          if (next !== undefined) {
            await stream.writeSSE({ event: 'event', data: next });
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 25_000);
          });
          wake = null;
          if (queue.length === 0 && open) await stream.writeSSE({ event: 'ping', data: '' });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  /**
   * Deploy hook for CI systems: `POST /api/hooks/deploy/<app>/<token>`.
   * The token is the credential; it is compared in constant time.
   */
  app.post('/api/hooks/deploy/:appId/:token', (c) => {
    limit(hookLimiter, c, 'hook');
    const application = stores.applications.get(c.req.param('appId'));
    const expected = application?.deployHookToken == null ? null : ctx.secrets.open(application.deployHookToken, 'hook');
    if (application === undefined || expected === null || !constantTimeEqual(expected, c.req.param('token'))) throw notFound('Deploy hook');
    const deployment = ctx.deployer.enqueue({ app: application, trigger: 'api', createdBy: null });
    stores.audit.record({ teamId: application.teamId, userId: null, action: 'application.deploy_hook', targetType: 'application', targetId: application.id, targetName: application.name, ip: c.get('ip') });
    return c.json({ deploymentId: deployment.id, status: deployment.status }, 202);
  });
}
