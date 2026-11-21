/**
 * Backups of an application's volumes: the files on a named Docker volume,
 * as a .tar.gz on the control plane (and perhaps in S3), on a schedule or
 * by hand, restorable in place.
 *
 * Nothing runs inside the application's own containers, whose image may have
 * no shell or tar. A throwaway helper container from the proxy image (which
 * every server already has) mounts the volume, and Docker itself hands over
 * the files as a tar stream (`GET /containers/{id}/archive`): owners,
 * permissions and links are kept, and nothing is buffered in memory, so a
 * volume of many gigabytes is fine. The stream is gzipped on its way to disk.
 *
 * Files that are written while they are copied (a SQLite database) may be
 * caught half way. A volume can ask for the application to be paused for the
 * copy: its processes are frozen, not stopped, so connections wait instead of
 * failing. A restart of the control plane in the middle finds the paused
 * containers recorded on the backup and resumes them.
 *
 * A restore stops the application, first takes a copy of what is there now
 * (so a restore can itself be undone), empties the volume, unpacks the
 * backup with its owners, and starts the application again. If unpacking
 * fails, that copy is put back.
 */
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { emit, type Context } from '../context.ts';
import type { DockerClient } from '../docker/client.ts';
import { idPart, LABEL_APP, LABEL_MANAGED, LABEL_ROLE } from '../docker/naming.ts';
import { AppError, errorMessage } from '../lib/errors.ts';
import { randomId } from '../lib/ids.ts';
import { S3Client } from '../lib/s3.ts';
import type { ApplicationRecord, VolumeBackupRecord, VolumeBackupTrigger, VolumeRecord } from '../store/index.ts';

/** How long one copy or restore may take before it is given up. */
const OPERATION_TIMEOUT_MS = 6 * 3_600_000;
/** Copies a restore takes of what it replaces; older ones go, whatever the volume's retention says. */
const SAFETY_COPIES_KEPT = 3;
/** Where the helper container sees the volume. */
const MOUNT = '/volume';

export class VolumeBackups {
  private readonly ctx: Context;
  /** Volumes with a restore under way (a backup is tracked by its row). */
  private readonly restoring = new Set<string>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  dir(volumeId: string): string {
    return join(this.ctx.config.dataDir, 'backups', 'volumes', volumeId);
  }

  file(backup: VolumeBackupRecord): string | null {
    return backup.filePath === null ? null : join(this.dir(backup.volumeId), backup.filePath);
  }

  isRestoring(volumeId: string): boolean {
    return this.restoring.has(volumeId);
  }

  private application(volume: VolumeRecord): ApplicationRecord {
    const app = this.ctx.stores.applications.get(volume.applicationId);
    if (app === undefined) throw new AppError('not_found', 'Application not found', { params: { resource: 'application' } });
    return app;
  }

  private changed(volume: VolumeRecord, backupId: string): void {
    const app = this.ctx.stores.applications.get(volume.applicationId);
    if (app !== undefined) emit(this.ctx, app.teamId, { type: 'volume-backup.updated', id: backupId, volumeId: volume.id, applicationId: app.id });
  }

  // ----------------------------------------------------------------- backup

  /** Start a backup in the background; the record says how it goes. */
  start(volume: VolumeRecord, trigger: 'manual' | 'schedule'): VolumeBackupRecord {
    const { stores } = this.ctx;
    if (stores.volumeBackups.isRunning(volume.id)) throw new AppError('conflict', 'A backup of this volume is already running', { params: { reason: 'backup_running' } });
    if (this.restoring.has(volume.id)) throw new AppError('conflict', 'This volume is being restored', { params: { reason: 'restore_running' } });
    this.application(volume);
    const record = stores.volumeBackups.create(volume, trigger);
    this.changed(volume, record.id);
    void this.run(volume, record);
    return record;
  }

  /** Take a copy and wait for it. */
  private async run(volume: VolumeRecord, record: VolumeBackupRecord, options: { pause?: boolean } = {}): Promise<VolumeBackupRecord> {
    const { stores } = this.ctx;
    const fileName = `${record.startedAt.replace(/[:.]/g, '-')}.tar.gz`;
    const dir = this.dir(volume.id);
    const path = join(dir, fileName);
    try {
      const app = this.application(volume);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const docker = await this.ctx.connections.docker(app.serverId);
      if (!(await docker.volumeExists(volume.dockerVolume))) {
        throw new AppError('bad_request', 'The volume does not exist on the server yet: deploy the application first', { params: { reason: 'volume_missing' } });
      }
      const rawBytes = await this.withHelper(docker, app, volume, 'ro', async (helper) => {
        const paused = options.pause ?? volume.backupPause ? await this.pause(docker, app, record) : [];
        try {
          let raw = 0;
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              raw += chunk.length;
              callback(null, chunk);
            },
          });
          const signal = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
          await pipeline(await docker.getArchive(helper, MOUNT, signal), counter, createGzip({ level: 6 }), createWriteStream(path, { mode: 0o600 }), { signal });
          return raw;
        } finally {
          await this.resume(docker, paused, record);
        }
      });
      const { size } = await stat(path);
      stores.volumeBackups.finish(record.id, { status: 'succeeded', filePath: fileName, sizeBytes: size, rawBytes });
      await this.upload(app, volume, record.id, path, size, fileName);
      await this.prune(volume);
    } catch (error) {
      await rm(path, { force: true });
      stores.volumeBackups.finish(record.id, { status: 'failed', error: errorMessage(error) });
      const app = stores.applications.get(volume.applicationId);
      if (app !== undefined && record.trigger !== 'before_restore') this.ctx.notifier.volumeBackupFailed(app, volume, errorMessage(error));
    }
    this.changed(volume, record.id);
    return stores.volumeBackups.get(record.id)!;
  }

  /**
   * A throwaway container from the proxy image with the volume mounted at /volume: no network, nothing else
   * mounted, removed whatever happens.
   */
  private async withHelper<T>(docker: DockerClient, app: ApplicationRecord, volume: VolumeRecord, mode: 'ro' | 'rw', work: (helper: string) => Promise<T>): Promise<T> {
    const image = this.ctx.config.proxyImage;
    if ((await docker.inspectImage(image)) === null) await docker.pullImage(image);
    const name = `ploy-volume-${idPart(volume.id, 10)}-${randomId(6).toLowerCase()}`;
    const id = await docker.createContainer(name, {
      Image: image,
      Entrypoint: ['sleep'],
      Cmd: ['86400'],
      User: '0:0',
      WorkingDir: '/',
      NetworkDisabled: true,
      Labels: { [LABEL_MANAGED]: 'true', [LABEL_ROLE]: 'volume-helper', [LABEL_APP]: app.id },
      HostConfig: { Binds: [`${volume.dockerVolume}:${MOUNT}:${mode}`], NetworkMode: 'none', AutoRemove: false },
    });
    try {
      await docker.startContainer(id);
      return await work(id);
    } finally {
      await docker.removeContainer(id, { force: true }).catch((error: unknown) => this.ctx.logger.warn('Could not remove a volume helper', { container: name, error: errorMessage(error) }));
    }
  }

  /** Freeze the application's running containers for the copy, and note them on the backup in case of a restart. */
  private async pause(docker: DockerClient, app: ApplicationRecord, record: VolumeBackupRecord): Promise<string[]> {
    const active = app.activeDeploymentId === null ? undefined : this.ctx.stores.deployments.get(app.activeDeploymentId);
    const paused: string[] = [];
    for (const name of active?.containers ?? []) {
      const inspect = await docker.inspectContainer(name).catch(() => null);
      if (inspect === null || inspect.State.Running !== true || inspect.State.Paused === true) continue;
      paused.push(name);
      this.ctx.stores.volumeBackups.setPaused(record.id, paused);
      await docker.pauseContainer(name);
    }
    return paused;
  }

  private async resume(docker: DockerClient, paused: string[], record: VolumeBackupRecord): Promise<void> {
    for (const name of paused) {
      await docker.unpauseContainer(name).catch((error: unknown) => this.ctx.logger.warn('Could not resume a container after a volume backup', { container: name, error: errorMessage(error) }));
    }
    if (paused.length > 0) this.ctx.stores.volumeBackups.setPaused(record.id, []);
  }

  /** Copy a finished backup to the volume's S3 destination, when it has one. A failed upload keeps the local file. */
  private async upload(app: ApplicationRecord, volume: VolumeRecord, backupId: string, path: string, size: number, fileName: string): Promise<void> {
    const fresh = this.ctx.stores.volumes.get(volume.id) ?? volume;
    const destination = fresh.backupDestinationId === null ? undefined : this.ctx.stores.s3.get(fresh.backupDestinationId);
    if (destination === undefined) return;
    const key = [destination.pathPrefix, `${app.slug}-${idPart(app.id, 6)}`, 'volumes', volume.name, fileName].filter((part) => part.length > 0).join('/');
    try {
      await new S3Client(await this.ctx.storage.destinationTarget(destination)).put(key, createReadStream(path), size);
      this.ctx.stores.volumeBackups.setRemote(backupId, destination.id, key);
    } catch (error) {
      const message = `Stored on the server, but the upload to ${destination.name} failed: ${errorMessage(error)}`;
      this.ctx.stores.volumeBackups.setWarning(backupId, message);
      this.ctx.notifier.volumeBackupFailed(app, volume, message);
    }
  }

  private async deleteRemote(backup: VolumeBackupRecord): Promise<void> {
    if (backup.remoteDestinationId === null || backup.remoteKey === null) return;
    const destination = this.ctx.stores.s3.get(backup.remoteDestinationId);
    if (destination === undefined) return;
    await this.ctx.storage
      .destinationTarget(destination)
      .then((target) => new S3Client(target).delete(backup.remoteKey!))
      .catch((error: unknown) => this.ctx.logger.warn('Could not delete a remote volume backup', { backupId: backup.id, error: errorMessage(error) }));
  }

  /** Keep the newest `retention` backups (and a few of the copies restores took); remove the rest on both sides. */
  private async prune(volume: VolumeRecord): Promise<void> {
    const fresh = this.ctx.stores.volumes.get(volume.id) ?? volume;
    const succeeded = this.ctx.stores.volumeBackups.listForVolume(volume.id).filter((backup) => backup.status === 'succeeded');
    const regular = succeeded.filter((backup) => backup.trigger !== 'before_restore');
    const safety = succeeded.filter((backup) => backup.trigger === 'before_restore');
    for (const old of [...regular.slice(fresh.backupRetention), ...safety.slice(SAFETY_COPIES_KEPT)]) await this.delete(old);
    // Failed attempts are kept only while they are recent enough to explain something.
    const failed = this.ctx.stores.volumeBackups.listForVolume(volume.id).filter((backup) => backup.status === 'failed');
    for (const old of failed.slice(10)) this.ctx.stores.volumeBackups.delete(old.id);
  }

  async delete(backup: VolumeBackupRecord): Promise<void> {
    const file = this.file(backup);
    if (file !== null) await rm(file, { force: true });
    await this.deleteRemote(backup);
    this.ctx.stores.volumeBackups.delete(backup.id);
  }

  /** The backup's bytes: the local file, or the S3 copy when the server no longer has it. */
  async open(backup: VolumeBackupRecord): Promise<{ stream: Readable; size: number | null } | null> {
    const file = this.file(backup);
    if (file !== null && existsSync(file)) return { stream: createReadStream(file), size: (await stat(file)).size };
    if (backup.remoteDestinationId === null || backup.remoteKey === null) return null;
    const destination = this.ctx.stores.s3.get(backup.remoteDestinationId);
    if (destination === undefined) return null;
    const response = await new S3Client(await this.ctx.storage.destinationTarget(destination)).get(backup.remoteKey);
    const length = Number(response.headers['content-length']);
    return { stream: response, size: Number.isFinite(length) ? length : null };
  }

  // ---------------------------------------------------------------- restore

  /**
   * Replace the volume's files with a backup's. Returns the copy of the files that were there, taken first.
   * The application is stopped for the duration and started again if it was running.
   */
  async restore(volume: VolumeRecord, backup: VolumeBackupRecord, userId: string | null): Promise<VolumeBackupRecord> {
    const { stores, deployer } = this.ctx;
    if (backup.status !== 'succeeded' || backup.volumeId !== volume.id) throw new AppError('bad_request', 'This backup cannot be restored', { params: { reason: 'backup_unusable' } });
    if (stores.volumeBackups.isRunning(volume.id)) throw new AppError('conflict', 'A backup of this volume is running', { params: { reason: 'backup_running' } });
    if (this.restoring.has(volume.id)) throw new AppError('conflict', 'This volume is being restored', { params: { reason: 'restore_running' } });
    const app = this.application(volume);
    // Checked before anything is stopped: there must be something to restore from.
    const probe = await this.open(backup);
    if (probe === null) throw new AppError('bad_request', 'The backup file is no longer on the server or in S3', { params: { reason: 'backup_missing' } });
    probe.stream.destroy();

    this.restoring.add(volume.id);
    const wasRunning = app.activeDeploymentId !== null && app.status !== 'stopped';
    try {
      if (wasRunning) await deployer.stop(app);
      const docker = await this.ctx.connections.docker(app.serverId);
      // A copy of what is there now: the way back if this restore was a mistake. No pause needed, nothing runs.
      const safety = await this.run(volume, stores.volumeBackups.create(volume, 'before_restore'), { pause: false });
      if (safety.status !== 'succeeded') {
        throw new AppError('bad_request', `The volume could not be copied before the restore, so nothing was changed: ${safety.errorMessage ?? 'unknown error'}`, { params: { reason: 'safety_copy_failed' } });
      }
      try {
        await this.replace(docker, app, volume, backup);
      } catch (error) {
        // Put back what was there, so a failed restore leaves the volume as it found it.
        await this.replace(docker, app, volume, safety).catch((undo: unknown) =>
          this.ctx.logger.error('Could not put a volume back after a failed restore', { volumeId: volume.id, error: errorMessage(undo) }),
        );
        throw new AppError('bad_request', `Restore failed, the previous files were put back: ${errorMessage(error)}`, { params: { reason: 'restore_failed' } });
      }
      return safety;
    } finally {
      this.restoring.delete(volume.id);
      if (wasRunning) {
        const current = stores.applications.get(app.id);
        if (current !== undefined) await deployer.start(current, userId).catch((error: unknown) => this.ctx.logger.warn('Could not start the application after a restore', { applicationId: app.id, error: errorMessage(error) }));
      }
      this.changed(volume, backup.id);
    }
  }

  /** Empty the volume and unpack `backup` into it, keeping the owners recorded in the archive. */
  private async replace(docker: DockerClient, app: ApplicationRecord, volume: VolumeRecord, backup: VolumeBackupRecord): Promise<void> {
    const source = await this.open(backup);
    if (source === null) throw new AppError('bad_request', 'The backup file is no longer on the server or in S3', { params: { reason: 'backup_missing' } });
    await this.withHelper(docker, app, volume, 'rw', async (helper) => {
      let emptied = await docker.exec(helper, ['find', MOUNT, '-mindepth', '1', '-delete'], { timeoutMs: OPERATION_TIMEOUT_MS });
      if (emptied.exitCode !== 0) emptied = await docker.exec(helper, ['sh', '-c', `rm -rf ${MOUNT}/..?* ${MOUNT}/.[!.]* ${MOUNT}/*`], { timeoutMs: OPERATION_TIMEOUT_MS });
      const left = await docker.exec(helper, ['ls', '-A', MOUNT]);
      if (left.stdout.trim().length > 0) throw new AppError('bad_request', `The volume could not be emptied: ${(emptied.stderr || left.stdout).trim().split('\n').slice(0, 3).join(' ')}`);
      // The archive holds "volume/…": unpacked at the root it lands in the mount.
      await docker.putArchive(helper, '/', source.stream, { keepOwners: true, timeoutMs: OPERATION_TIMEOUT_MS });
    });
  }

  // ------------------------------------------------------------ lifecycle

  /** The volume is gone: its local backups go too (copies in S3 are left for whoever wants them). */
  async forgetVolume(volumeId: string): Promise<void> {
    await rm(this.dir(volumeId), { recursive: true, force: true });
  }

  /** At start: backups a restart cut short are failed, and containers they had paused are resumed. */
  async recover(): Promise<void> {
    for (const backup of this.ctx.stores.volumeBackups.failInterrupted()) {
      const file = this.file(backup);
      if (file !== null) await rm(file, { force: true });
      if (backup.pausedContainers.length === 0) continue;
      const app = this.ctx.stores.applications.get(backup.applicationId);
      if (app === undefined) continue;
      try {
        const docker = await this.ctx.connections.docker(app.serverId);
        for (const name of backup.pausedContainers) await docker.unpauseContainer(name);
        this.ctx.logger.info('Resumed containers a volume backup had paused', { applicationId: app.id, containers: backup.pausedContainers });
      } catch (error) {
        this.ctx.logger.warn('Could not resume containers a volume backup had paused', { applicationId: app.id, error: errorMessage(error) });
      }
    }
  }

  /** Scheduled copies: one at a time per volume, never while a restore runs. */
  scheduled(volume: VolumeRecord): void {
    if (this.ctx.stores.volumeBackups.isRunning(volume.id) || this.restoring.has(volume.id)) return;
    const app = this.ctx.stores.applications.get(volume.applicationId);
    if (app === undefined || app.activeDeploymentId === null) return;
    this.start(volume, 'schedule');
  }
}

export type { VolumeBackupTrigger };
