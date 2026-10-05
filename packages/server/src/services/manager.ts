/**
 * Database and infrastructure services: provisioning, lifecycle, backups.
 *
 * A service is one container from the catalog's official image with a named
 * volume, joined to its project's network under its slug — so a linked app
 * reaches PostgreSQL at `postgres:5432` and nothing outside the project can.
 * Exposing a public port is an explicit, per-service opt-in.
 *
 * Backups stream straight from `docker exec` stdout to a file on the control
 * plane (gzip where the engine does not compress itself); nothing is buffered
 * in memory, so multi-gigabyte databases are fine.
 */
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { CreateServiceInput } from '@ploy/shared';
import { emit, type Context } from '../context.ts';
import { idPart, LABEL_MANAGED, LABEL_PROJECT, LABEL_ROLE, LABEL_SERVICE, LABEL_TEAM, projectNetwork, serviceContainer, serviceVolume } from '../docker/naming.ts';
import { AppError, errorMessage, reasonOf } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { S3Client } from '../lib/s3.ts';
import { createTar, tarSingleFile, type TarEntry } from '../lib/tar.ts';
import type { BackupRecord, ProjectRecord, ServiceRecord } from '../store/index.ts';
import { APP_CAPABILITIES } from '../deploy/deployer.ts';
import { catalogEntry } from './catalog.ts';

const HEALTH_TIMEOUT_MS = 4 * 60_000;

export class ServiceManager {
  private readonly ctx: Context;
  private readonly busy = new Set<string>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  private setStatus(service: ServiceRecord, status: ServiceRecord['status'], message: string | null = null, reason: string | null = null): void {
    this.ctx.stores.services.setStatus(service.id, status, message, reason);
    emit(this.ctx, service.teamId, { type: 'service.updated', id: service.id, projectId: service.projectId, status });
    // A service with domains (a file store) is routed only while it runs: keep the proxy in step.
    if (this.ctx.stores.domains.listForService(service.id).length > 0) void this.ctx.proxy.requestSync(service.serverId).catch(() => undefined);
  }

  create(project: ProjectRecord, input: CreateServiceInput): ServiceRecord {
    const { stores } = this.ctx;
    const entry = catalogEntry(input.type);
    const version = input.version ?? entry.defaultVersion;
    if (!entry.versions.includes(version)) {
      throw new AppError('validation_failed', `Unsupported ${entry.label} version ${version}`, {
        issues: [{ path: 'version', code: 'invalid_value', message: `Choose one of ${entry.versions.join(', ')}` }],
      });
    }
    const id = newId('svc');
    const slug = stores.projects.uniqueResourceSlug(project.id, input.name, input.type);
    const service = stores.services.create({
      id,
      projectId: project.id,
      teamId: project.teamId,
      serverId: input.serverId,
      name: input.name,
      slug,
      type: input.type,
      version,
      credentials: entry.credentials(),
      internalPort: entry.port,
      containerName: serviceContainer({ id, slug }),
      volumeName: serviceVolume({ id }),
      memoryLimitMb: entry.memoryMb,
    });
    void this.provision(service.id);
    return service;
  }

  /** (Re)create the service container from its record. Data lives on the volume and survives. */
  async provision(serviceId: string): Promise<void> {
    if (this.busy.has(serviceId)) return;
    this.busy.add(serviceId);
    const { stores, connections, logger } = this.ctx;
    let service = stores.services.get(serviceId);
    try {
      if (service === undefined) return;
      this.setStatus(service, 'provisioning');
      const entry = catalogEntry(service.type);
      const template = entry.container(service.version, service.credentials);
      const docker = await connections.docker(service.serverId);

      if ((await docker.inspectImage(template.image)) === null) await docker.pullImage(template.image);
      const network = projectNetwork(service.projectId);
      await docker.ensureNetwork(network, { [LABEL_MANAGED]: 'true', [LABEL_PROJECT]: service.projectId });
      await docker.ensureVolume(service.volumeName, { [LABEL_MANAGED]: 'true', [LABEL_SERVICE]: service.id });
      await docker.removeContainer(service.containerName, { force: true });

      const portKey = `${service.internalPort}/tcp`;
      const containerId = await docker.createContainer(service.containerName, {
        Image: template.image,
        // The instance time zone first, so a template that sets its own TZ keeps it.
        Env: Object.entries({ TZ: stores.settings.timezone(), ...template.env }).map(([key, value]) => `${key}=${value}`),
        ...(template.entrypoint === undefined ? {} : { Entrypoint: template.entrypoint }),
        ...(template.cmd === undefined ? {} : { Cmd: template.cmd }),
        Labels: {
          [LABEL_MANAGED]: 'true',
          [LABEL_ROLE]: 'service',
          [LABEL_SERVICE]: service.id,
          [LABEL_PROJECT]: service.projectId,
          [LABEL_TEAM]: service.teamId,
        },
        ExposedPorts: { [portKey]: {} },
        Healthcheck: { Test: ['CMD', ...template.healthcheck], Interval: 10e9, Timeout: 5e9, Retries: 5, StartPeriod: 30e9 },
        StopTimeout: 60,
        HostConfig: {
          RestartPolicy: { Name: 'unless-stopped' },
          ...(service.memoryLimitMb === null ? {} : { Memory: service.memoryLimitMb * 1024 * 1024 }),
          ...(service.cpuLimit === null ? {} : { NanoCpus: Math.round(service.cpuLimit * 1e9) }),
          PidsLimit: 4096,
          CapDrop: ['ALL'],
          CapAdd: APP_CAPABILITIES,
          SecurityOpt: ['no-new-privileges:true'],
          ShmSize: 256 * 1024 * 1024,
          LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '3' } },
          Mounts: [{ Type: 'volume', Source: service.volumeName, Target: template.mountPath }],
          ...(service.publicPort === null ? {} : { PortBindings: { [portKey]: [{ HostPort: String(service.publicPort) }] } }),
          NetworkMode: network,
        },
        NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [service.slug] } } },
      });
      // Configuration the engine reads from disk (the file store's identities) goes in before the first start.
      const seeds = new Map<string, TarEntry[]>();
      for (const file of template.files ?? []) seeds.set(file.dir, [...(seeds.get(file.dir) ?? []), { name: file.name, content: file.content, ...(file.mode === undefined ? {} : { mode: file.mode }) }]);
      for (const [dir, entries] of seeds) await docker.putArchive(containerId, dir, createTar(entries));
      await docker.startContainer(service.containerName);
      await this.waitHealthy(service);
      service = stores.services.get(serviceId);
      if (service !== undefined) this.setStatus(service, 'running');
    } catch (error) {
      const message = errorMessage(error);
      logger.warn('Service provisioning failed', { serviceId, error: message });
      service = stores.services.get(serviceId);
      if (service !== undefined) {
        const portTaken = /port is already allocated|address already in use/i.test(message);
        this.setStatus(service, 'failed', portTaken ? `Port ${service.publicPort} is already in use on this server` : message, portTaken ? 'port_taken' : reasonOf(error));
      }
    } finally {
      this.busy.delete(serviceId);
    }
  }

  private async waitHealthy(service: ServiceRecord): Promise<void> {
    const docker = await this.ctx.connections.docker(service.serverId);
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const inspect = await docker.inspectContainer(service.containerName);
      if (inspect === null) throw new AppError('bad_request', 'The service container disappeared', { params: { reason: 'disappeared' } });
      const health = inspect.State.Health?.Status;
      if (health === 'healthy') return;
      if (health === 'unhealthy') throw new AppError('bad_request', 'The service reported itself unhealthy', { params: { reason: 'unhealthy' } });
      if (!inspect.State.Running && !inspect.State.Restarting) {
        throw new AppError('bad_request', `The service exited with code ${inspect.State.ExitCode}${inspect.State.OOMKilled ? ' (out of memory)' : ''}`, {
          params: { reason: inspect.State.OOMKilled ? 'oom' : 'exited' },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new AppError('bad_request', 'The service did not become healthy in time', { params: { reason: 'timeout' } });
  }

  async stop(service: ServiceRecord): Promise<void> {
    const docker = await this.ctx.connections.docker(service.serverId);
    await docker.stopContainer(service.containerName, 60);
    this.setStatus(service, 'stopped');
  }

  async start(service: ServiceRecord): Promise<void> {
    const docker = await this.ctx.connections.docker(service.serverId);
    if ((await docker.inspectContainer(service.containerName)) === null) {
      await this.provision(service.id);
      return;
    }
    this.setStatus(service, 'restarting');
    await docker.startContainer(service.containerName);
    try {
      await this.waitHealthy(service);
      this.setStatus(service, 'running');
    } catch (error) {
      this.setStatus(service, 'failed', errorMessage(error), reasonOf(error));
    }
  }

  async restart(service: ServiceRecord): Promise<void> {
    const docker = await this.ctx.connections.docker(service.serverId);
    this.setStatus(service, 'restarting');
    try {
      await docker.restartContainer(service.containerName, 60);
      await this.waitHealthy(service);
      this.setStatus(service, 'running');
    } catch (error) {
      this.setStatus(service, 'failed', errorMessage(error), reasonOf(error));
    }
  }

  async destroy(service: ServiceRecord, removeData: boolean): Promise<void> {
    try {
      const docker = await this.ctx.connections.docker(service.serverId);
      await docker.removeContainer(service.containerName, { force: true });
      if (removeData) await docker.removeVolume(service.volumeName);
    } catch (error) {
      this.ctx.logger.warn('Could not clean up service container', { serviceId: service.id, error: errorMessage(error) });
    }
    await rm(this.backupDir(service.id), { recursive: true, force: true });
  }

  // --------------------------------------------------------------- backups

  backupDir(serviceId: string): string {
    return join(this.ctx.config.dataDir, 'backups', serviceId);
  }

  backupFile(service: ServiceRecord, backup: BackupRecord): string | null {
    return backup.filePath === null ? null : join(this.backupDir(service.id), backup.filePath);
  }

  async backup(service: ServiceRecord, trigger: 'manual' | 'schedule'): Promise<BackupRecord> {
    const { stores } = this.ctx;
    const entry = catalogEntry(service.type);
    if (entry.backup === null) throw new AppError('bad_request', `${entry.label} does not support backups`);
    if (stores.backups.isRunning(service.id)) throw new AppError('conflict', 'A backup is already running for this service');
    if (service.status !== 'running') throw new AppError('conflict', 'The service must be running to back it up');

    const record = stores.backups.create(service.id, trigger);
    emit(this.ctx, service.teamId, { type: 'backup.updated', id: record.id, serviceId: service.id });
    void this.runBackup(service, record);
    return record;
  }

  private async runBackup(service: ServiceRecord, record: BackupRecord): Promise<void> {
    const { stores } = this.ctx;
    const spec = catalogEntry(service.type).backup!;
    const fileName = `${record.startedAt.replace(/[:.]/g, '-')}.${spec.extension}${spec.gzip ? '.gz' : ''}`;
    const dir = this.backupDir(service.id);
    const path = join(dir, fileName);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const docker = await this.ctx.connections.docker(service.serverId);
      const { execId, output } = await docker.execStream(service.containerName, spec.dump(service.credentials));
      let stderr = '';
      const stdoutOnly = new Transform({
        readableObjectMode: false,
        writableObjectMode: true,
        transform(chunk: { stream: string; data: Buffer }, _encoding, callback) {
          if (chunk.stream === 'stderr') {
            if (stderr.length < 4_000) stderr += chunk.data.toString('utf8');
            callback();
            return;
          }
          callback(null, chunk.data);
        },
      });
      await pipeline(output, stdoutOnly, ...(spec.gzip ? [createGzip({ level: 6 })] : []), createWriteStream(path, { mode: 0o600 }));
      const exitCode = await docker.execExitCode(execId);
      if (exitCode !== 0) throw new AppError('bad_request', `Backup command failed (exit ${exitCode}): ${stderr.trim().slice(0, 500)}`);
      const { size } = await stat(path);
      stores.backups.finish(record.id, { status: 'succeeded', filePath: fileName, sizeBytes: size });
      await this.uploadBackup(service, record.id, path, size, fileName);
      await this.pruneBackups(service);
    } catch (error) {
      await rm(path, { force: true });
      stores.backups.finish(record.id, { status: 'failed', error: errorMessage(error) });
      this.ctx.notifier.backupFailed(service, errorMessage(error));
    }
    emit(this.ctx, service.teamId, { type: 'backup.updated', id: record.id, serviceId: service.id });
  }

  /** Copy a finished backup to the service's S3 destination, when it has one. A failed upload keeps the local file. */
  private async uploadBackup(service: ServiceRecord, backupId: string, path: string, size: number, fileName: string): Promise<void> {
    const fresh = this.ctx.stores.services.get(service.id) ?? service;
    const destination = fresh.backupDestinationId === null ? undefined : this.ctx.stores.s3.get(fresh.backupDestinationId);
    if (destination === undefined) return;
    const key = [destination.pathPrefix, `${service.slug}-${idPart(service.id, 6)}`, fileName].filter((part) => part.length > 0).join('/');
    try {
      // A destination inside one of the team's file stores is reached by whatever path exists right now.
      await new S3Client(await this.ctx.storage.destinationTarget(destination)).put(key, createReadStream(path), size);
      this.ctx.stores.backups.setRemote(backupId, destination.id, key);
    } catch (error) {
      const message = `Stored on the server, but the upload to ${destination.name} failed: ${errorMessage(error)}`;
      this.ctx.stores.backups.setWarning(backupId, message);
      this.ctx.notifier.backupFailed(service, message);
    }
  }

  /** Remove the off-server copy of a backup; best effort (the destination may be gone). */
  private async deleteRemote(backup: BackupRecord): Promise<void> {
    if (backup.remoteDestinationId === null || backup.remoteKey === null) return;
    const destination = this.ctx.stores.s3.get(backup.remoteDestinationId);
    if (destination === undefined) return;
    await this.ctx.storage
      .destinationTarget(destination)
      .then((target) => new S3Client(target).delete(backup.remoteKey!))
      .catch((error: unknown) => this.ctx.logger.warn('Could not delete remote backup', { backupId: backup.id, error: errorMessage(error) }));
  }

  private async pruneBackups(service: ServiceRecord): Promise<void> {
    const { stores } = this.ctx;
    const succeeded = stores.backups.listForService(service.id).filter((backup) => backup.status === 'succeeded');
    for (const old of succeeded.slice(service.backupRetention)) {
      const file = this.backupFile(service, old);
      if (file !== null) await rm(file, { force: true });
      await this.deleteRemote(old);
      stores.backups.delete(old.id);
    }
  }

  async deleteBackup(service: ServiceRecord, backup: BackupRecord): Promise<void> {
    const file = this.backupFile(service, backup);
    if (file !== null) await rm(file, { force: true });
    await this.deleteRemote(backup);
    this.ctx.stores.backups.delete(backup.id);
  }

  /** The backup's bytes: the local file, or the S3 copy when the server no longer has it. */
  async openBackup(service: ServiceRecord, backup: BackupRecord): Promise<{ stream: Readable; size: number | null } | null> {
    const file = this.backupFile(service, backup);
    if (file !== null && existsSync(file)) return { stream: createReadStream(file), size: (await stat(file)).size };
    if (backup.remoteDestinationId === null || backup.remoteKey === null) return null;
    const destination = this.ctx.stores.s3.get(backup.remoteDestinationId);
    if (destination === undefined) return null;
    const response = await new S3Client(await this.ctx.storage.destinationTarget(destination)).get(backup.remoteKey);
    const length = Number(response.headers['content-length']);
    return { stream: response, size: Number.isFinite(length) ? length : null };
  }

  /** Upload a backup into the container and run the engine's restore command. */
  async restore(service: ServiceRecord, backup: BackupRecord): Promise<void> {
    const spec = catalogEntry(service.type).backup;
    if (spec === null || spec.restore === null) throw new AppError('bad_request', 'This service type does not support restore');
    if (backup.status !== 'succeeded') throw new AppError('bad_request', 'This backup cannot be restored');
    const source = await this.openBackup(service, backup);
    if (source === null || source.size === null) throw new AppError('bad_request', 'The backup file is no longer available on the server or in S3');
    const docker = await this.ctx.connections.docker(service.serverId);
    const size = source.size;
    const name = `ploy-restore.${spec.extension}${spec.gzip ? '.gz' : ''}`;
    const archive = tarSingleFile(name, size, source.stream as AsyncIterable<Buffer>);
    const { Readable } = await import('node:stream');
    await docker.putArchive(service.containerName, '/tmp', Readable.from(archive));
    const result = await docker.exec(service.containerName, spec.restore(service.credentials, `/tmp/${name}`), { timeoutMs: 6 * 3_600_000 });
    await docker.exec(service.containerName, ['rm', '-f', `/tmp/${name}`]).catch(() => undefined);
    if (result.exitCode !== 0) {
      throw new AppError('bad_request', `Restore failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`);
    }
  }
}
