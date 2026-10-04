/**
 * Database and infrastructure services, their credentials, logs and backups.
 */
import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createServiceSchema, METRIC_RANGE_WINDOWS, SERVICE_TYPES, updateServiceSchema, type ServiceCatalogEntryDto, type ServiceCredentialsDto } from '@ploy/shared';
import { emit, type Context } from '../../context.ts';
import { nextRunFor } from '../../lib/cron.ts';
import { AppError, notFound } from '../../lib/errors.ts';
import { CATALOG, catalogEntry } from '../../services/catalog.ts';
import type { ServiceRecord } from '../../store/index.ts';
import { audit, body, query, requireTeam, type Ctx, type Env } from '../core.ts';
import { backupDto, serviceDto } from '../dto.ts';
import { loadProject } from './projects.ts';
import { rangeQuery } from './servers.ts';

export function registerServiceRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;

  const load = (c: Ctx, role: 'viewer' | 'developer' | 'admin'): ServiceRecord => {
    const auth = requireTeam(c, role);
    const service = stores.services.getForTeam(auth.teamId, c.req.param('id')!);
    if (service === undefined) throw notFound('Service');
    return service;
  };

  app.get('/api/catalog/services', (c) => {
    requireTeam(c);
    const entries: ServiceCatalogEntryDto[] = SERVICE_TYPES.map((type) => ({
      type,
      label: CATALOG[type].label,
      versions: CATALOG[type].versions,
      defaultVersion: CATALOG[type].defaultVersion,
      port: CATALOG[type].port,
      supportsBackup: CATALOG[type].backup !== null,
    }));
    return c.json(entries);
  });

  app.post('/api/projects/:id/services', async (c) => {
    const project = loadProject(ctx, c, 'developer');
    const auth = requireTeam(c, 'developer');
    const input = await body(c, createServiceSchema);
    if (stores.servers.getForTeam(auth.teamId, input.serverId) === undefined) {
      throw new AppError('validation_failed', 'Unknown server', { issues: [{ path: 'serverId', code: 'custom', message: 'Unknown server' }] });
    }
    const service = ctx.services.create(project, input);
    stores.projects.touch(project.id);
    audit(ctx, c, 'service.created', { type: 'service', id: service.id, name: service.name }, { type: service.type, version: service.version });
    emit(ctx, project.teamId, { type: 'service.updated', id: service.id, projectId: project.id, status: service.status });
    return c.json(serviceDto(ctx, service), 201);
  });

  app.get('/api/services/:id', (c) => c.json(serviceDto(ctx, load(c, 'viewer'))));

  app.patch('/api/services/:id', async (c) => {
    const service = load(c, 'developer');
    const input = await body(c, updateServiceSchema);
    if (input.backupSchedule != null) {
      try {
        nextRunFor(input.backupSchedule);
      } catch (error) {
        throw new AppError('validation_failed', 'Invalid schedule', { issues: [{ path: 'backupSchedule', code: 'invalid_format', message: (error as Error).message }] });
      }
      if (catalogEntry(service.type).backup === null) throw new AppError('bad_request', 'This service type does not support backups');
    }
    if (input.backupDestinationId != null && stores.s3.getForTeam(service.teamId, input.backupDestinationId) === undefined) {
      throw new AppError('validation_failed', 'Unknown S3 destination', { issues: [{ path: 'backupDestinationId', code: 'custom', message: 'Unknown destination' }] });
    }
    if (input.publicPort != null && stores.services.isPublicPortTaken(service.serverId, input.publicPort, service.id)) {
      throw new AppError('conflict', 'Another service already uses this public port', { params: { reason: 'port_taken' } });
    }
    if (input.publicPort != null && [22, 80, 443].includes(input.publicPort)) {
      throw new AppError('validation_failed', 'This port is reserved', { issues: [{ path: 'publicPort', code: 'custom', message: 'Reserved port' }] });
    }
    const updated = stores.services.update(service.id, input);
    ctx.maintenance.forgetBackupSchedule(service.id);
    const runtimeChanged = input.publicPort !== undefined || input.cpuLimit !== undefined || input.memoryLimitMb !== undefined;
    if (runtimeChanged && (updated.publicPort !== service.publicPort || updated.cpuLimit !== service.cpuLimit || updated.memoryLimitMb !== service.memoryLimitMb)) {
      void ctx.services.provision(service.id);
    }
    if (input.name !== undefined) stores.applications.markConfigChangedForService(service.id);
    audit(ctx, c, 'service.updated', { type: 'service', id: service.id, name: updated.name }, { fields: Object.keys(input) });
    return c.json(serviceDto(ctx, stores.services.get(service.id)!));
  });

  app.delete('/api/services/:id', async (c) => {
    const service = load(c, 'admin');
    const removeData = c.req.query('removeData') === 'true';
    await ctx.services.destroy(service, removeData);
    stores.applications.markConfigChangedForService(service.id);
    stores.services.delete(service.id);
    stores.metrics.deleteOwner(service.id);
    audit(ctx, c, 'service.deleted', { type: 'service', id: service.id, name: service.name }, { removeData });
    emit(ctx, service.teamId, { type: 'service.deleted', id: service.id, projectId: service.projectId });
    return c.json({ ok: true });
  });

  for (const action of ['start', 'stop', 'restart'] as const) {
    app.post(`/api/services/:id/${action}`, async (c) => {
      const service = load(c, 'developer');
      audit(ctx, c, `service.${action}`, { type: 'service', id: service.id, name: service.name });
      if (action === 'stop') await ctx.services.stop(service);
      else void ctx.services[action](service);
      return c.json(serviceDto(ctx, stores.services.get(service.id)!));
    });
  }

  app.post('/api/services/:id/redeploy', (c) => {
    const service = load(c, 'developer');
    void ctx.services.provision(service.id);
    audit(ctx, c, 'service.recreated', { type: 'service', id: service.id, name: service.name });
    return c.json(serviceDto(ctx, stores.services.get(service.id)!));
  });

  /** Reveal credentials. Audited: every view is recorded with who and from where. */
  app.get('/api/services/:id/credentials', (c) => {
    const service = load(c, 'developer');
    const entry = catalogEntry(service.type);
    const internal = entry.connection(service.credentials, service.slug, service.internalPort);
    const server = stores.servers.get(service.serverId);
    const publicHost = server?.publicIp ?? server?.host ?? null;
    const credentials: ServiceCredentialsDto = {
      username: service.credentials.username,
      password: service.credentials.password,
      database: service.credentials.database,
      internalUrl: internal.url,
      publicUrl: service.publicPort === null || publicHost === null ? null : entry.connection(service.credentials, publicHost, service.publicPort).url,
      env: internal.env,
    };
    audit(ctx, c, 'service.credentials_viewed', { type: 'service', id: service.id, name: service.name });
    return c.json(credentials);
  });

  app.get('/api/services/:id/metrics', (c) => {
    const service = load(c, 'viewer');
    const { range } = query(c, rangeQuery);
    const window = METRIC_RANGE_WINDOWS[range];
    return c.json({ range, points: stores.metrics.appSeries(service.id, Date.now() - window.windowSec * 1000, window.bucketSec * 1000) });
  });

  app.get('/api/services/:id/logs', async (c) => {
    const service = load(c, 'viewer');
    const docker = await ctx.connections.docker(service.serverId);
    const tail = Math.min(2_000, Math.max(10, Number(c.req.query('tail') ?? 300) || 300));
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      let seq = 0;
      const keepAlive = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }).catch(() => controller.abort()), 25_000);
      try {
        const output = await docker.containerLogs(service.containerName, { follow: true, tail, timestamps: true, signal: controller.signal });
        for await (const chunk of output as AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }>) {
          for (const raw of chunk.text.split('\n')) {
            if (raw.length === 0) continue;
            const space = raw.indexOf(' ');
            const t = Date.parse(raw.slice(0, space));
            seq += 1;
            await stream.writeSSE({ event: 'line', data: JSON.stringify({ seq, t: Number.isNaN(t) ? Date.now() : t, stream: chunk.stream, text: Number.isNaN(t) ? raw : raw.slice(space + 1), replica: 0 }) });
          }
        }
      } catch {
        // container missing or client gone
      } finally {
        clearInterval(keepAlive);
      }
      await stream.writeSSE({ event: 'end', data: '{}' }).catch(() => undefined);
    });
  });

  // --------------------------------------------------------------- backups

  app.get('/api/services/:id/backups', (c) => {
    const service = load(c, 'viewer');
    return c.json(stores.backups.listForService(service.id).map((backup) => backupDto(ctx, backup)));
  });

  app.post('/api/services/:id/backups', async (c) => {
    const service = load(c, 'developer');
    const backup = await ctx.services.backup(service, 'manual');
    audit(ctx, c, 'backup.started', { type: 'service', id: service.id, name: service.name });
    return c.json(backupDto(ctx, backup), 202);
  });

  const loadBackup = (c: Ctx, role: 'viewer' | 'developer' | 'admin') => {
    const service = load(c, role);
    const backup = stores.backups.get(c.req.param('backupId')!);
    if (backup === undefined || backup.serviceId !== service.id) throw notFound('Backup');
    return { service, backup };
  };

  app.get('/api/services/:id/backups/:backupId/download', async (c) => {
    const { service, backup } = loadBackup(c, 'admin');
    const source = await ctx.services.openBackup(service, backup);
    if (source === null) throw notFound('Backup file');
    audit(ctx, c, 'backup.downloaded', { type: 'service', id: service.id, name: service.name }, { backupId: backup.id });
    const name = `${service.slug}-${backup.filePath!}`;
    return new Response(Readable.toWeb(source.stream) as ReadableStream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(source.size === null ? {} : { 'Content-Length': String(source.size) }),
        'Content-Disposition': `attachment; filename="${name}"`,
      },
    });
  });

  app.post('/api/services/:id/backups/:backupId/restore', async (c) => {
    const { service, backup } = loadBackup(c, 'admin');
    audit(ctx, c, 'backup.restored', { type: 'service', id: service.id, name: service.name }, { backupId: backup.id });
    await ctx.services.restore(service, backup);
    return c.json({ ok: true });
  });

  app.delete('/api/services/:id/backups/:backupId', async (c) => {
    const { service, backup } = loadBackup(c, 'admin');
    if (backup.status === 'running') throw new AppError('conflict', 'This backup is still running');
    await ctx.services.deleteBackup(service, backup);
    audit(ctx, c, 'backup.deleted', { type: 'service', id: service.id, name: service.name }, { backupId: backup.id });
    return c.json({ ok: true });
  });
}
