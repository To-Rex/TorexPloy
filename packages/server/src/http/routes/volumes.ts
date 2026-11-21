/**
 * Backups of an application's volumes: how each volume is backed up, its
 * copies, and download, restore and deletion of one. The volumes themselves
 * are created and removed with the application's other settings.
 */
import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import { updateVolumeBackupSchema } from '@ploy/shared';
import type { Context } from '../../context.ts';
import { nextRunFor } from '../../lib/cron.ts';
import { AppError, notFound } from '../../lib/errors.ts';
import { audit, body, requireAuth, type Ctx, type Env } from '../core.ts';
import { volumeBackupDto, volumeDto } from '../dto.ts';
import { loadApp } from './applications.ts';

type Role = 'viewer' | 'developer' | 'admin';

export function registerVolumeRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;

  const loadVolume = (c: Ctx, role: Role) => {
    const application = loadApp(ctx, c, role);
    const volume = stores.volumes.get(c.req.param('volumeId')!);
    if (volume === undefined || volume.applicationId !== application.id) throw notFound('Volume');
    return { application, volume };
  };

  const loadBackup = (c: Ctx, role: Role) => {
    const { application, volume } = loadVolume(c, role);
    const backup = stores.volumeBackups.get(c.req.param('backupId')!);
    if (backup === undefined || backup.volumeId !== volume.id) throw notFound('Backup');
    return { application, volume, backup };
  };

  /** How the volume is backed up. */
  app.patch('/api/applications/:id/volumes/:volumeId', async (c) => {
    const { application, volume } = loadVolume(c, 'developer');
    if (application.kind === 'compose') throw new AppError('bad_request', 'Compose stacks declare their own volumes');
    const input = await body(c, updateVolumeBackupSchema);
    if (input.backupSchedule != null) {
      try {
        nextRunFor(input.backupSchedule, new Date(), stores.settings.timezone());
      } catch (error) {
        throw new AppError('validation_failed', 'Invalid schedule', { issues: [{ path: 'backupSchedule', code: 'invalid_format', message: (error as Error).message }] });
      }
    }
    if (input.backupDestinationId != null && stores.s3.getForTeam(application.teamId, input.backupDestinationId) === undefined) {
      throw new AppError('validation_failed', 'Unknown S3 destination', { issues: [{ path: 'backupDestinationId', code: 'custom', message: 'Unknown destination' }] });
    }
    const updated = stores.volumes.setBackupPolicy(volume.id, input);
    if (input.backupSchedule !== undefined) ctx.maintenance.forgetBackupSchedule(volume.id);
    audit(ctx, c, 'volume.backup_policy_updated', { type: 'volume', id: volume.id, name: volume.name }, {
      application: application.name,
      schedule: updated.backupSchedule,
      retention: updated.backupRetention,
      destination: updated.backupDestinationId,
      pause: updated.backupPause,
    });
    return c.json(volumeDto(ctx, updated));
  });

  app.get('/api/applications/:id/volumes/:volumeId/backups', (c) => {
    const { volume } = loadVolume(c, 'viewer');
    return c.json(stores.volumeBackups.listForVolume(volume.id).map((backup) => volumeBackupDto(ctx, backup)));
  });

  app.post('/api/applications/:id/volumes/:volumeId/backups', (c) => {
    const { application, volume } = loadVolume(c, 'developer');
    if (application.kind === 'compose') throw new AppError('bad_request', 'Compose stacks declare their own volumes');
    const backup = ctx.volumeBackups.start(volume, 'manual');
    audit(ctx, c, 'volume.backup_started', { type: 'volume', id: volume.id, name: volume.name }, { application: application.name, backupId: backup.id });
    return c.json(volumeBackupDto(ctx, backup), 202);
  });

  app.get('/api/applications/:id/volumes/:volumeId/backups/:backupId/download', async (c) => {
    const { application, volume, backup } = loadBackup(c, 'admin');
    if (backup.status !== 'succeeded') throw new AppError('bad_request', 'This backup has no file', { params: { reason: 'backup_unusable' } });
    const source = await ctx.volumeBackups.open(backup);
    if (source === null) throw notFound('Backup file');
    audit(ctx, c, 'volume.backup_downloaded', { type: 'volume', id: volume.id, name: volume.name }, { application: application.name, backupId: backup.id });
    const name = `${application.slug}-${volume.name}-${backup.filePath ?? `${backup.id}.tar.gz`}`;
    return new Response(Readable.toWeb(source.stream) as ReadableStream, {
      headers: {
        'Content-Type': 'application/gzip',
        ...(source.size === null ? {} : { 'Content-Length': String(source.size) }),
        'Content-Disposition': `attachment; filename="${name}"`,
      },
    });
  });

  app.post('/api/applications/:id/volumes/:volumeId/backups/:backupId/restore', async (c) => {
    const { application, volume, backup } = loadBackup(c, 'admin');
    const auth = requireAuth(c);
    audit(ctx, c, 'volume.restored', { type: 'volume', id: volume.id, name: volume.name }, { application: application.name, backupId: backup.id, startedAt: backup.startedAt });
    const safety = await ctx.volumeBackups.restore(volume, backup, auth.user.id);
    return c.json({ ok: true, safetyBackup: volumeBackupDto(ctx, safety) });
  });

  app.delete('/api/applications/:id/volumes/:volumeId/backups/:backupId', async (c) => {
    const { application, volume, backup } = loadBackup(c, 'admin');
    if (backup.status === 'running') throw new AppError('conflict', 'This backup is still running', { params: { reason: 'backup_running' } });
    await ctx.volumeBackups.delete(backup);
    audit(ctx, c, 'volume.backup_deleted', { type: 'volume', id: volume.id, name: volume.name }, { application: application.name, backupId: backup.id });
    return c.json({ ok: true });
  });
}
