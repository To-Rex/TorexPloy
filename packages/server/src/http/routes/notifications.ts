/**
 * Team notification channels (admin only: they hold delivery credentials).
 */
import type { Hono } from 'hono';
import { createNotificationChannelSchema, updateNotificationChannelSchema, type NotificationChannelDto } from '@ploy/shared';
import type { Context } from '../../context.ts';
import { notFound } from '../../lib/errors.ts';
import { channelTarget } from '../../notifications/notifier.ts';
import type { NotificationChannelRecord } from '../../store/index.ts';
import { audit, body, limit, RateLimiter, requireTeam, type Ctx, type Env } from '../core.ts';

function channelDto(channel: NotificationChannelRecord): NotificationChannelDto {
  return {
    id: channel.id,
    name: channel.name,
    kind: channel.kind,
    locale: channel.locale,
    events: channel.events,
    enabled: channel.enabled,
    target: channelTarget(channel),
    lastStatus: channel.lastStatus,
    lastError: channel.lastError,
    lastSentAt: channel.lastSentAt,
    createdAt: channel.createdAt,
  };
}

export function registerNotificationRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;
  const testLimiter = new RateLimiter(10, 10);

  const load = (c: Ctx): NotificationChannelRecord => {
    const auth = requireTeam(c, 'admin');
    const channel = stores.notifications.getForTeam(auth.teamId, c.req.param('id')!);
    if (channel === undefined) throw notFound('Notification channel');
    return channel;
  };

  app.get('/api/notifications', (c) => {
    const auth = requireTeam(c, 'admin');
    return c.json(stores.notifications.listForTeam(auth.teamId).map(channelDto));
  });

  app.post('/api/notifications', async (c) => {
    const auth = requireTeam(c, 'admin');
    const input = await body(c, createNotificationChannelSchema);
    const channel = stores.notifications.create(auth.teamId, input);
    audit(ctx, c, 'notification.created', { type: 'notification', id: channel.id, name: channel.name }, { kind: channel.kind, events: channel.events });
    return c.json(channelDto(channel), 201);
  });

  app.patch('/api/notifications/:id', async (c) => {
    const channel = load(c);
    const input = await body(c, updateNotificationChannelSchema);
    const updated = stores.notifications.update(channel.id, input);
    audit(ctx, c, 'notification.updated', { type: 'notification', id: channel.id, name: updated.name }, { fields: Object.keys(input) });
    return c.json(channelDto(updated));
  });

  app.delete('/api/notifications/:id', (c) => {
    const channel = load(c);
    stores.notifications.delete(channel.id);
    audit(ctx, c, 'notification.deleted', { type: 'notification', id: channel.id, name: channel.name });
    return c.json({ ok: true });
  });

  app.post('/api/notifications/:id/test', async (c) => {
    const channel = load(c);
    limit(testLimiter, c, 'notification-test');
    const error = await ctx.notifier.test(channel);
    return c.json({ ok: error === null, error, channel: channelDto(stores.notifications.get(channel.id)!) });
  });
}
