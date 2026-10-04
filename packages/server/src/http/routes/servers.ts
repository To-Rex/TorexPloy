/**
 * Servers: the shared local host plus a team's SSH servers.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { createServerSchema, METRIC_RANGE_WINDOWS, METRIC_RANGES, updateServerSchema, type DockerDiskUsageDto, type ProxyOverviewDto, type ServerContainerDto } from '@ploy/shared';
import type { Context } from '../../context.ts';
import type { ContainerSummary } from '../../docker/client.ts';
import { LABEL_APP, LABEL_MANAGED, LABEL_ROLE, LABEL_SERVICE, PROXY_CONTAINER } from '../../docker/naming.ts';
import { AppError, forbidden, notFound } from '../../lib/errors.ts';
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

  // ------------------------------------------------------------ containers
  // Admin only: the list spans every workload on the machine, not just the caller's.

  const describeOwner = (teamId: string, container: ContainerSummary): ServerContainerDto['owner'] => {
    const labels = container.Labels ?? {};
    const name = container.Names[0]?.replace(/^\//, '') ?? '';
    if (name === PROXY_CONTAINER) return { kind: 'proxy' };
    if (name === 'ploy-control') return { kind: 'platform' };
    if (labels[LABEL_MANAGED] !== 'true') return { kind: 'external' };
    const role = labels[LABEL_ROLE];
    if (role === 'app' || role === 'compose') {
      const app = stores.applications.getForTeam(teamId, labels[LABEL_APP] ?? '');
      return app === undefined ? { kind: 'other-team' } : { kind: app.kind === 'compose' ? 'compose' : 'application', id: app.id, name: app.name, projectId: app.projectId };
    }
    if (role === 'service') {
      const service = stores.services.getForTeam(teamId, labels[LABEL_SERVICE] ?? '');
      return service === undefined ? { kind: 'other-team' } : { kind: 'service', id: service.id, name: service.name, projectId: service.projectId };
    }
    if (role === 'cron') return { kind: 'cron' };
    return { kind: 'build' };
  };

  app.get('/api/servers/:id/containers', async (c) => {
    const server = load(c, true);
    const auth = requireTeam(c, 'admin');
    const docker = await ctx.connections.docker(server.id);
    const list = await docker.listContainers({}, true);
    const dto: ServerContainerDto[] = list
      .map((container) => ({
        id: container.Id.slice(0, 12),
        name: container.Names[0]?.replace(/^\//, '') ?? container.Id.slice(0, 12),
        image: container.Image,
        state: container.State,
        status: container.Status,
        createdAt: new Date(container.Created * 1000).toISOString(),
        ports: (container.Ports ?? []).filter((port) => port.PublicPort !== undefined).map((port) => `${port.IP?.includes(':') ? `[${port.IP}]` : (port.IP ?? '0.0.0.0')}:${port.PublicPort}→${port.PrivatePort}/${port.Type}`),
        owner: describeOwner(auth.teamId, container),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return c.json(dto);
  });

  /** Resolve a container id from the listing; refuse anything that is not on this server. */
  const loadContainer = async (c: Ctx) => {
    const server = load(c, true);
    const docker = await ctx.connections.docker(server.id);
    const id = c.req.param('containerId') ?? '';
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw notFound('Container');
    const inspect = await docker.inspectContainer(id);
    if (inspect === null) throw notFound('Container');
    return { server, docker, inspect };
  };

  for (const action of ['start', 'stop', 'restart'] as const) {
    app.post(`/api/servers/:id/containers/:containerId/${action}`, async (c) => {
      const { server, docker, inspect } = await loadContainer(c);
      const name = inspect.Name.replace(/^\//, '');
      // Stopping the proxy or the control plane from here would cut off the panel itself.
      if (action === 'stop' && (name === PROXY_CONTAINER || name === 'ploy-control')) throw new AppError('bad_request', 'This container keeps the platform running and cannot be stopped from here');
      if (action === 'start') await docker.startContainer(inspect.Id);
      else if (action === 'stop') await docker.stopContainer(inspect.Id, 30);
      else await docker.restartContainer(inspect.Id, 30);
      audit(ctx, c, `server.container_${action}`, { type: 'server', id: server.id, name: server.name }, { container: name });
      return c.json({ ok: true });
    });
  }

  app.get('/api/servers/:id/containers/:containerId/logs', async (c) => {
    const { docker, inspect } = await loadContainer(c);
    const stream = await docker.containerLogs(inspect.Id, { follow: false, tail: 300, timestamps: true });
    const lines: { stream: 'stdout' | 'stderr'; text: string }[] = [];
    for await (const chunk of stream as AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }>) {
      for (const text of chunk.text.split('\n')) if (text.length > 0) lines.push({ stream: chunk.stream, text });
    }
    return c.json({ name: inspect.Name.replace(/^\//, ''), lines: lines.slice(-300) });
  });

  // The proxy (Dokploy's "Traefik" screen): routes, the generated configuration, and a forced reload.
  app.get('/api/servers/:id/proxy', (c) => {
    const server = load(c, true);
    const { routes, config, inSync } = ctx.proxy.overview(server.id);
    const overview: ProxyOverviewDto = {
      running: server.proxyInfo?.running ?? false,
      version: server.proxyInfo?.version ?? null,
      inSync,
      routes: routes.map((route) => ({
        host: route.host,
        path: route.path ?? '/',
        stripPath: route.stripPath ?? false,
        https: route.https,
        upstreams: route.upstreams,
        redirectTo: route.redirectTo ?? null,
        label: route.label,
      })),
      config,
    };
    return c.json(overview);
  });

  app.post('/api/servers/:id/proxy/reload', async (c) => {
    const server = load(c, true);
    if (server.status !== 'ready') throw new AppError('server_unreachable', 'The server is not ready');
    await ctx.proxy.reload(server.id);
    audit(ctx, c, 'proxy.reloaded', { type: 'server', id: server.id, name: server.name });
    return c.json({ ok: true });
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
