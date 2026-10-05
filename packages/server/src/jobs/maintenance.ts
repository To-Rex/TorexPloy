/**
 * Housekeeping that keeps a long-running install healthy: expired sessions
 * and invitations, metric and audit retention, abandoned build workspaces,
 * unused BuildKit cache and dangling images, and scheduled database backups.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../context.ts';
import { nextRunFor } from '../lib/cron.ts';
import { errorMessage } from '../lib/errors.ts';

const AUDIT_RETENTION_DAYS = 180;
const BUILD_CACHE_MAX_AGE_HOURS = 7 * 24;

export class Maintenance {
  private readonly ctx: Context;
  private readonly nextBackup = new Map<string, number>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  pruneAuth(): void {
    this.ctx.stores.sessions.pruneExpired();
    this.ctx.stores.teams.pruneInvitations();
  }

  pruneRetention(): void {
    this.ctx.metrics.prune();
    this.ctx.stores.audit.prune(new Date(Date.now() - AUDIT_RETENTION_DAYS * 24 * 3_600_000).toISOString());
  }

  /** Workspaces of builds that are no longer running (left behind by a crash). */
  async pruneWorkspaces(): Promise<void> {
    const dir = join(this.ctx.config.dataDir, 'builds');
    const open = new Set(this.ctx.stores.deployments.listOpen().map((deployment) => deployment.id));
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const id = entry.replace(/\.ploy$|\.key(\.known_hosts)?$/, '');
      if (open.has(id)) continue;
      const path = join(dir, entry);
      const info = await stat(path).catch(() => null);
      if (info !== null && Date.now() - info.mtimeMs > 3_600_000) await rm(path, { recursive: true, force: true });
    }
  }

  async pruneDocker(): Promise<void> {
    for (const server of this.ctx.stores.servers.listAll()) {
      if (server.status !== 'ready') continue;
      try {
        const docker = await this.ctx.connections.docker(server.id);
        const cache = await docker.pruneBuildCache(BUILD_CACHE_MAX_AGE_HOURS);
        const images = await docker.pruneDanglingImages();
        this.ctx.logger.info('Docker cleanup', { serverId: server.id, buildCacheBytes: cache, imageBytes: images });
      } catch (error) {
        this.ctx.logger.warn('Docker cleanup failed', { serverId: server.id, error: errorMessage(error) });
      }
    }
  }

  /** Fire scheduled backups whose time has come. Missed slots while the process was down are skipped, not replayed. */
  runBackups(now: Date = new Date()): void {
    const services = this.ctx.stores.services.listWithBackupSchedule();
    // Schedules are wall-clock times in the instance zone, read on every pass so a change applies without a restart.
    const timeZone = this.ctx.stores.settings.timezone();
    const known = new Set(services.map((service) => service.id));
    for (const id of this.nextBackup.keys()) if (!known.has(id)) this.nextBackup.delete(id);
    for (const service of services) {
      let next = this.nextBackup.get(service.id);
      if (next === undefined) {
        try {
          this.nextBackup.set(service.id, nextRunFor(service.backupSchedule!, now, timeZone).getTime());
        } catch {
          // An invalid schedule is rejected at input; ignore anything that slipped through.
        }
        continue;
      }
      if (now.getTime() < next) continue;
      next = nextRunFor(service.backupSchedule!, now, timeZone).getTime();
      this.nextBackup.set(service.id, next);
      if (service.status !== 'running') continue;
      void this.ctx.services.backup(service, 'schedule').catch((error) =>
        this.ctx.logger.warn('Scheduled backup failed to start', { serviceId: service.id, error: errorMessage(error) }),
      );
    }
  }

  forgetBackupSchedule(serviceId: string): void {
    this.nextBackup.delete(serviceId);
  }

  /** Forget every computed next backup; the next pass recomputes them (after a time-zone change). */
  rescheduleBackups(): void {
    this.nextBackup.clear();
  }
}
