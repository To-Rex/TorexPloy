/**
 * Servers: the shared local host plus a team's SSH servers.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { createServerSchema, METRIC_RANGE_WINDOWS, METRIC_RANGES, updateServerSchema, type DockerDiskUsageDto } from '@ploy/shared';
import type { Context } from '../../context.ts';
import { forbidden, notFound } from '../../lib/errors.ts';
import type { ServerRecord } from '../../store/index.ts';
import { audit, body, query, requireTeam, type Ctx, type Env } from '../core.ts';
import { serverDto } from '../dto.ts';

export const rangeQuery = z.object({ range: z.enum(METRIC_RANGES).default('1h') });

export function registerServerRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;

  const load = (c: Ctx, write: boolean): ServerRecord => {
    const auth = requireTeam(c, write ? 'admin' : 'viewer');
    const server = stores.servers.getForTeam(auth.teamId, c.req.param('id')!);
    if (server === undefined) throw notFound('Server');
    // The shared host belongs to the instance, not to any one team.
    if (write && server.kind === 'local' && !auth.user.isInstanceAdmin) throw forbidden('Only the instance administrator can manage this server');
    return server;
  };

  app.get('/api/servers', (c) => {
    const auth = requireTeam(c);
    return c.json(stores.servers.listForTeam(auth.teamId).map((server) => serverDto(ctx, server)));
  });

  app.post('/api/servers', async (c) => {
    const auth = requireTeam(c, 'admin');
    const input = await body(c, createServerSchema);
    const server = await ctx.servers.createSsh(auth.teamId, input);
    audit(ctx, c, 'server.created', { type: 'server', id: server.id, name: server.name }, { host: server.host });
    return c.json(serverDto(ctx, server), 201);
  });

  app.get('/api/servers/:id', (c) => c.json(serverDto(ctx, load(c, false))));

  app.patch('/api/servers/:id', async (c) => {
    const server = load(c, true);
    const input = await body(c, updateServerSchema);
    if (server.kind === 'local' && (input.host !== undefined || input.port !== undefined || input.username !== undefined)) {
      throw forbidden('The local server has no connection settings');
    }
    stores.servers.update(server.id, input);
    await ctx.connections.invalidate(server.id);
    audit(ctx, c, 'server.updated', { type: 'server', id: server.id, name: input.name ?? server.name });
    return c.json(serverDto(ctx, stores.servers.get(server.id)!));
  });

  app.delete('/api/servers/:id', async (c) => {
    const server = load(c, true);
    await ctx.servers.remove(server);
    ctx.reconciler.unwatch(server.id);
    audit(ctx, c, 'server.deleted', { type: 'server', id: server.id, name: server.name });
    return c.json({ ok: true });
  });

  app.post('/api/servers/:id/verify', async (c) => {
    const server = load(c, true);
    const verified = await ctx.servers.verify(server.id);
    if (verified.status === 'ready') ctx.reconciler.watch(server.id);
    audit(ctx, c, 'server.verified', { type: 'server', id: server.id, name: server.name }, { status: verified.status });
    return c.json(serverDto(ctx, verified));
  });

  app.post('/api/servers/:id/install-docker', async (c) => {
    const server = load(c, true);
    audit(ctx, c, 'server.docker_install', { type: 'server', id: server.id, name: server.name });
    const result = await ctx.servers.installDocker(server.id);
    const verified = result.ok ? await ctx.servers.verify(server.id) : stores.servers.get(server.id)!;
    return c.json({ ok: result.ok, output: result.output, server: serverDto(ctx, verified) });
  });

  app.get('/api/servers/:id/metrics', (c) => {
    const server = load(c, false);
    const { range } = query(c, rangeQuery);
    const window = METRIC_RANGE_WINDOWS[range];
    return c.json({
      range,
      points: stores.metrics.hostSeries(server.id, Date.now() - window.windowSec * 1000, window.bucketSec * 1000),
      latest: stores.metrics.latestHost(server.id) ?? null,
    });
  });

  app.get('/api/servers/:id/docker', async (c) => {
    const server = load(c, false);
    const docker = await ctx.connections.docker(server.id);
    const df = await docker.systemDf();
    const images = df.Images ?? [];
    const usage: DockerDiskUsageDto = {
      images: {
        count: images.length,
        bytes: df.LayersSize ?? images.reduce((sum, image) => sum + image.Size, 0),
        reclaimableBytes: images.filter((image) => image.Containers === 0).reduce((sum, image) => sum + image.Size - image.SharedSize, 0),
      },
      containers: { count: (df.Containers ?? []).length, bytes: (df.Containers ?? []).reduce((sum, container) => sum + (container.SizeRw ?? 0), 0) },
      volumes: { count: (df.Volumes ?? []).length, bytes: (df.Volumes ?? []).reduce((sum, volume) => sum + Math.max(0, volume.UsageData?.Size ?? 0), 0) },
      buildCache: {
        bytes: (df.BuildCache ?? []).reduce((sum, entry) => sum + entry.Size, 0),
        reclaimableBytes: (df.BuildCache ?? []).filter((entry) => !entry.InUse).reduce((sum, entry) => sum + entry.Size, 0),
      },
    };
    return c.json(usage);
  });

  app.post('/api/servers/:id/cleanup', async (c) => {
    const server = load(c, true);
    const docker = await ctx.connections.docker(server.id);
    const buildCache = await docker.pruneBuildCache(0);
    const images = await docker.pruneDanglingImages();
    audit(ctx, c, 'server.cleanup', { type: 'server', id: server.id, name: server.name }, { buildCache, images });
    return c.json({ reclaimedBytes: buildCache + images });
  });
}
