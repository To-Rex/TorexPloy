/**
 * Packing a project into a `.torexploy` archive.
 *
 * The order is the import's order: the manifest first (everything needed to
 * rebuild the project, and which data entries follow), then each service's
 * data, the applications' volumes, their code and their images. Code is
 * fetched before the manifest is written, so the manifest only promises code
 * that is really there; a repository that cannot be reached becomes a warning,
 * not a failed export.
 *
 * Data whose size is not known in advance (a dump, a volume, an image) is
 * spooled to the export's work directory first, so every entry carries its
 * size and the importing panel can stream it straight into Docker. Objects of
 * a file store come straight from S3, which states their size. Databases are
 * dumped while they run; a service without a dump, and a volume that asks
 * for it, are frozen for the moment their files are copied.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { TransferInclude } from '@ploy/shared';
import type { Context } from '../context.ts';
import { composeProject, COMPOSE_PROJECT_LABEL } from '../compose/engine.ts';
import type { DockerClient } from '../docker/client.ts';
import { AppError, errorMessage, reasonOf } from '../lib/errors.ts';
import { catalogEntry } from '../services/catalog.ts';
import type { ApplicationRecord, ProjectRecord, ServiceRecord, TransferRecord } from '../store/index.ts';
import { HELPER_MOUNT, withVolumeHelper } from '../volumes/backups.ts';
import { ArchiveWriter, MANIFEST_PATH } from './archive.ts';
import { ENTRY, MANIFEST_FORMAT, MANIFEST_VERSION, SUMMARY_PATH, type EntryKind, type Manifest, type ManifestApplication, type ManifestDomain, type ManifestService, type ManifestSummary } from './manifest.ts';
import { note, type Progress } from './progress.ts';
import { snapshotSource, type SourceSnapshot } from './source.ts';

/** Compose's own label naming a volume within its project. */
const COMPOSE_VOLUME_LABEL = 'com.docker.compose.volume';

export interface TransferPaths {
  archive: string;
  part: string;
  work: string;
}

export function transferPaths(dataDir: string, id: string): TransferPaths {
  const dir = join(dataDir, 'transfers');
  return { archive: join(dir, `${id}.torexploy`), part: join(dir, `${id}.torexploy.part`), work: join(dir, `${id}.work`) };
}

export interface ExportJob {
  transfer: TransferRecord;
  passphrase: string;
  progress: Progress;
  signal: AbortSignal;
  /** Containers frozen right now (recorded so a restart in the middle resumes them). */
  paused: (containers: { serverId: string; container: string }[]) => void;
}

type ServiceData = 'dump' | 'files' | 'objects' | null;

/** How a service's data travels: a dump where the engine has one (and runs), the objects of a file store, or its files. */
export function serviceDataKind(service: ServiceRecord, include: TransferInclude): ServiceData {
  if (service.type === 'files') return include.storage ? (service.status === 'running' ? 'objects' : 'files') : null;
  if (!include.databases) return null;
  const spec = catalogEntry(service.type).backup;
  return spec !== null && spec.restore !== null && service.status === 'running' ? 'dump' : 'files';
}

function domainOf(domain: { host: string; path: string; stripPath: boolean; https: boolean; port: number | null; serviceName: string | null; redirectTo: string | null }): ManifestDomain {
  return { host: domain.host, path: domain.path, stripPath: domain.stripPath, https: domain.https, port: domain.port, serviceName: domain.serviceName, redirectTo: domain.redirectTo };
}

/** Freeze containers for a copy and thaw them after, whatever happens. */
async function frozen<T>(docker: DockerClient, serverId: string, names: string[], job: ExportJob, work: () => Promise<T>): Promise<T> {
  const paused: string[] = [];
  try {
    for (const name of names) {
      const inspect = await docker.inspectContainer(name).catch(() => null);
      if (inspect === null || inspect.State.Running !== true || inspect.State.Paused === true) continue;
      paused.push(name);
      job.paused(paused.map((container) => ({ serverId, container })));
      await docker.pauseContainer(name);
    }
    return await work();
  } finally {
    for (const name of paused) await docker.unpauseContainer(name).catch(() => undefined);
    if (paused.length > 0) job.paused([]);
  }
}

/** A volume's files as a .tar.gz in the work directory. */
async function spoolVolume(ctx: Context, docker: DockerClient, volume: string, out: string, signal: AbortSignal): Promise<number> {
  await withVolumeHelper(ctx, docker, { source: volume, mode: 'ro', name: 'ploy-export' }, async (helper) => {
    await pipeline(await docker.getArchive(helper, HELPER_MOUNT, signal), createGzip({ level: 6 }), createWriteStream(out, { mode: 0o600 }), { signal });
  });
  return (await stat(out)).size;
}

/** Bytes counted on their way past. */
function counter(onBytes: (bytes: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onBytes(chunk.length);
      callback(null, chunk);
    },
  });
}

export async function runExport(ctx: Context, job: ExportJob): Promise<{ size: number }> {
  const { stores } = ctx;
  const { transfer, progress, signal } = job;
  const include = transfer.include!;
  const project: ProjectRecord | undefined = transfer.projectId === null ? undefined : stores.projects.get(transfer.projectId);
  if (project === undefined || project.teamId !== transfer.teamId) throw new AppError('not_found', 'The project no longer exists', { params: { resource: 'project' } });

  const paths = transferPaths(ctx.config.dataDir, transfer.id);
  await rm(paths.work, { recursive: true, force: true });
  await mkdir(paths.work, { recursive: true, mode: 0o700 });
  await rm(paths.part, { force: true });

  const services = stores.services.listForProject(project.id);
  const apps = stores.applications.listForProject(project.id).filter((app) => app.parentApplicationId === null);

  // ------------------------------------------------------------- planning
  progress.add('prepare', 'prepare', project.name, { weight: 1 });
  progress.start('prepare');

  const serviceData = new Map<string, ServiceData>(services.map((service) => [service.id, serviceDataKind(service, include)]));
  for (const service of services) {
    const kind = serviceData.get(service.id);
    if (kind === null || kind === undefined) continue;
    progress.add(`service:${service.id}`, service.type === 'files' ? 'storage' : 'database', service.name, { weight: 6 });
  }

  // Which volumes exist on their servers (a volume of an application never deployed has nothing to carry).
  const volumes = new Map<string, boolean>();
  const composeVolumes = new Map<string, string[]>();
  for (const app of apps) {
    const appVolumes = stores.volumes.listForApplication(app.id);
    if (!include.volumes || (appVolumes.length === 0 && app.kind !== 'compose')) continue;
    let docker: DockerClient | null = null;
    try {
      docker = await ctx.connections.docker(app.serverId);
    } catch (error) {
      progress.warn(note('server_unreachable', `The server of ${app.name} could not be reached, so its volumes were left out: ${errorMessage(error)}`, { name: app.name }));
      continue;
    }
    for (const volume of appVolumes) {
      const exists = await docker.volumeExists(volume.dockerVolume).catch(() => false);
      volumes.set(volume.id, exists);
      if (exists) progress.add(`volume:${volume.id}`, 'volume', `${app.name} · ${volume.name}`, { weight: 4 });
    }
    if (app.kind === 'compose') {
      const listed = await docker.listVolumes(`${COMPOSE_PROJECT_LABEL}=${composeProject(app)}`).catch(() => []);
      const names = listed.map((volume) => volume.Labels?.[COMPOSE_VOLUME_LABEL] ?? '').filter((name) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name));
      composeVolumes.set(app.id, names);
      for (const name of names) progress.add(`compose-volume:${app.id}:${name}`, 'volume', `${app.name} · ${name}`, { weight: 4 });
    }
  }

  // Images that can be saved: what the application runs now, still on its server.
  const images = new Map<string, string>();
  if (include.images) {
    for (const app of apps) {
      if (app.kind === 'compose') {
        progress.warn(note('compose_image', `${app.name} is a compose stack: its images are built or pulled again where it is imported`, { name: app.name }));
        continue;
      }
      const active = app.activeDeploymentId === null ? undefined : stores.deployments.get(app.activeDeploymentId);
      if (active?.imageTag == null || active.imageRemoved) continue;
      const docker = await ctx.connections.docker(app.serverId).catch(() => null);
      if (docker === null || (await docker.inspectImage(active.imageTag).catch(() => null)) === null) continue;
      images.set(app.id, active.imageTag);
      progress.add(`image:${app.id}`, 'image', app.name, { weight: 8 });
    }
  }

  // Code first: the manifest promises only what was fetched.
  const sources = new Map<string, SourceSnapshot>();
  if (include.source) {
    for (const app of apps) {
      if (app.sourceType === 'image' || app.sourceType === 'raw') continue;
      const key = progress.add(`source:${app.id}`, 'source', app.name, { weight: 2 });
      progress.start(key);
      try {
        const snapshot = await snapshotSource(ctx, app, paths.work, signal);
        if (snapshot === null) {
          progress.skip(key);
          continue;
        }
        sources.set(app.id, snapshot);
        progress.done(key, { total: snapshot.size });
      } catch (error) {
        signal.throwIfAborted();
        const reason = reasonOf(error, 'source_unreachable');
        const warning = note(`source_${reason}`, `The code of ${app.name} was left out: ${errorMessage(error)}`, { name: app.name });
        progress.skip(key, warning);
        progress.warn(warning);
      }
    }
  }
  signal.throwIfAborted();

  // ------------------------------------------------------------- manifest
  const manifest: Manifest = {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    panel: { version: ctx.config.version, origin: ctx.config.publicUrl },
    include,
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      variables: stores.env.list({ projectId: project.id }),
      variablesText: stores.env.text({ projectId: project.id }),
    },
    services: services.map((service) => manifestService(ctx, service, serviceData.get(service.id) ?? null)),
    applications: apps.map((app) => manifestApplication(ctx, app, { volumes, composeVolumes: composeVolumes.get(app.id) ?? [], source: sources.get(app.id) ?? null, image: images.get(app.id) ?? null })),
    registries: registriesFor(ctx, project, apps),
    warnings: [],
  };
  for (const service of services) {
    if (service.backupDestinationId !== null) progress.warn(note('backup_destination', `${service.name} copied its backups to an S3 destination; choose one again after the import`, { name: service.name }));
  }
  manifest.warnings = progress.warnings;
  progress.done('prepare');

  const writer = await ArchiveWriter.create(paths.part, job.passphrase, { panelVersion: ctx.config.version, createdAt: manifest.createdAt });
  let entries = 0;
  try {
    await writer.addJson(MANIFEST_PATH, manifest);
    entries += 1;

    const addFile = async (path: string, kind: EntryKind, file: string, meta: Record<string, unknown>, step: string): Promise<void> => {
      const { size } = await stat(file);
      progress.total(step, size, 'bytes');
      await writer.add({ path, size, meta: { kind, ...meta } }, createReadStream(file), (bytes) => progress.advance(step, bytes));
      await rm(file, { force: true });
      entries += 1;
    };

    // -------------------------------------------------------- services
    for (const service of services) {
      const kind = serviceData.get(service.id);
      if (kind === null || kind === undefined) continue;
      const step = `service:${service.id}`;
      progress.start(step);
      const docker = await ctx.connections.docker(service.serverId);
      if (kind === 'dump') {
        const file = join(paths.work, `${service.id}.dump`);
        await ctx.services.dumpToFile(service, file, signal);
        await addFile(ENTRY.serviceDump(service.id), 'service-dump', file, { service: service.id }, step);
      } else if (kind === 'files') {
        const file = join(paths.work, `${service.id}.tar.gz`);
        // A running engine without a dump is frozen while its files are copied.
        await frozen(docker, service.serverId, service.status === 'running' ? [service.containerName] : [], job, () => spoolVolume(ctx, docker, service.volumeName, file, signal));
        await addFile(ENTRY.serviceFiles(service.id), 'service-files', file, { service: service.id }, step);
      } else {
        entries += await exportObjects(ctx, service, writer, progress, step, signal);
      }
      progress.done(step);
      signal.throwIfAborted();
    }

    // -------------------------------------------------------- volumes
    for (const app of apps) {
      const docker = volumes.size > 0 || composeVolumes.size > 0 ? await ctx.connections.docker(app.serverId).catch(() => null) : null;
      if (docker === null) continue;
      const active = app.activeDeploymentId === null ? undefined : stores.deployments.get(app.activeDeploymentId);
      for (const volume of stores.volumes.listForApplication(app.id)) {
        if (volumes.get(volume.id) !== true) continue;
        const step = `volume:${volume.id}`;
        progress.start(step);
        const file = join(paths.work, `${volume.id}.tar.gz`);
        await frozen(docker, app.serverId, volume.backupPause ? (active?.containers ?? []) : [], job, () => spoolVolume(ctx, docker, volume.dockerVolume, file, signal));
        await addFile(ENTRY.volume(app.id, volume.id), 'volume', file, { application: app.id, volume: volume.id }, step);
        progress.done(step);
      }
      for (const name of composeVolumes.get(app.id) ?? []) {
        const step = `compose-volume:${app.id}:${name}`;
        progress.start(step);
        const file = join(paths.work, `${app.id}-${name}.tar.gz`);
        await spoolVolume(ctx, docker, `${composeProject(app)}_${name}`, file, signal);
        await addFile(ENTRY.composeVolume(app.id, name), 'compose-volume', file, { application: app.id, name }, step);
        progress.done(step);
      }
      signal.throwIfAborted();
    }

    // -------------------------------------------------------- code
    for (const [appId, snapshot] of sources) {
      const step = `source:${appId}`;
      await writer.add({ path: ENTRY.source(appId), size: snapshot.size, meta: { kind: 'source', application: appId, name: snapshot.name } }, createReadStream(snapshot.path));
      await rm(snapshot.path, { force: true });
      entries += 1;
      progress.done(step);
    }

    // -------------------------------------------------------- images
    for (const [appId, tag] of images) {
      const app = apps.find((candidate) => candidate.id === appId)!;
      const step = `image:${appId}`;
      progress.start(step);
      const docker = await ctx.connections.docker(app.serverId);
      const file = join(paths.work, `${appId}.image.tar.gz`);
      let raw = 0;
      await pipeline(await docker.saveImage(tag, signal), counter((bytes) => (raw += bytes)), createGzip({ level: 3 }), createWriteStream(file, { mode: 0o600 }), { signal });
      await addFile(ENTRY.image(appId), 'image', file, { application: appId, tag, raw }, step);
      progress.done(step);
    }

    const summary: ManifestSummary = { finishedAt: new Date().toISOString(), entries, bytes: writer.written, warnings: progress.warnings };
    await writer.addJson(SUMMARY_PATH, summary);
    const size = await writer.finish();
    return { size };
  } catch (error) {
    await writer.abort();
    throw error;
  } finally {
    await rm(paths.work, { recursive: true, force: true });
  }
}

/** Every object of every bucket, straight from the store into the archive. */
async function exportObjects(ctx: Context, service: ServiceRecord, writer: ArchiveWriter, progress: Progress, step: string, signal: AbortSignal): Promise<number> {
  const buckets = await ctx.storage.listBuckets(service);
  const stats = await ctx.storage.bucketStats(service, buckets.map((bucket) => bucket.name)).catch(() => new Map<string, { objects: number; bytes: number }>());
  const expected = [...stats.values()].reduce((sum, value) => sum + (value.bytes ?? 0), 0);
  progress.total(step, expected > 0 ? expected : null, 'bytes');
  let entries = 0;
  for (const bucket of buckets) {
    const client = await ctx.storage.client(service, bucket.name);
    let token: string | undefined;
    do {
      const page = await client.listObjects({ maxKeys: 1000, ...(token === undefined ? {} : { continuationToken: token }) });
      for (const object of page.objects) {
        signal.throwIfAborted();
        const response = await client.get(object.key);
        const length = Number(response.headers['content-length']);
        const size = Number.isSafeInteger(length) && length >= 0 ? length : object.size;
        const contentType = String(response.headers['content-type'] ?? 'application/octet-stream');
        try {
          await writer.add(
            { path: ENTRY.object(service.id, bucket.name, object.key), size, meta: { kind: 'object', service: service.id, bucket: bucket.name, key: object.key, contentType } },
            response,
            (bytes) => progress.advance(step, bytes),
          );
        } catch (error) {
          response.destroy();
          throw error;
        }
        entries += 1;
      }
      token = page.truncated && page.nextContinuationToken !== null ? page.nextContinuationToken : undefined;
    } while (token !== undefined);
  }
  return entries;
}

function manifestService(ctx: Context, service: ServiceRecord, data: ServiceData): ManifestService {
  const spec = catalogEntry(service.type).backup;
  return {
    id: service.id,
    name: service.name,
    slug: service.slug,
    type: service.type,
    version: service.version,
    credentials: {
      username: service.credentials.username,
      password: service.credentials.password,
      database: service.credentials.database,
      ...(service.credentials.rootPassword === undefined ? {} : { rootPassword: service.credentials.rootPassword }),
    },
    publicPort: service.publicPort,
    cpuLimit: service.cpuLimit,
    memoryLimitMb: service.memoryLimitMb,
    backup: { schedule: service.backupSchedule, retention: service.backupRetention },
    data: data === null ? null : { kind: data, ...(data === 'dump' && spec !== null ? { extension: spec.extension, gzip: spec.gzip } : {}) },
    domains: ctx.stores.domains.listForService(service.id).filter((domain) => !domain.isGenerated).map(domainOf),
    generatedDomain: ctx.stores.domains.listForService(service.id).some((domain) => domain.isGenerated),
    buckets: service.type === 'files' ? ctx.stores.storageBuckets.listForService(service.id).map((bucket) => ({ name: bucket.name, public: bucket.public })) : [],
    keys:
      service.type === 'files'
        ? ctx.stores.storageKeys
            .listForService(service.id)
            .filter((key) => key.managedBy === 'user')
            .map((key) => ({ name: key.name, accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, buckets: key.buckets, permission: key.permission }))
        : [],
  };
}

function manifestApplication(
  ctx: Context,
  app: ApplicationRecord,
  extras: { volumes: Map<string, boolean>; composeVolumes: string[]; source: SourceSnapshot | null; image: string | null },
): ManifestApplication {
  const { stores, secrets } = ctx;
  const active = app.activeDeploymentId === null ? undefined : stores.deployments.get(app.activeDeploymentId);
  const provider = app.gitProviderId === null ? undefined : stores.gitProviders.get(app.gitProviderId);
  const installation = app.githubInstallationId === null ? undefined : stores.installations.get(app.githubInstallationId);
  const kind = app.kind === 'compose' ? 'compose' : app.kind === 'worker' ? 'worker' : 'web';
  return {
    id: app.id,
    name: app.name,
    slug: app.slug,
    description: app.description,
    kind,
    settings: {
      sourceType: app.sourceType,
      repository: app.repository,
      gitUrl: app.gitUrl,
      branch: app.branch,
      image: app.image,
      buildType: app.buildType,
      dockerfilePath: app.dockerfilePath,
      rootDirectory: app.rootDirectory,
      installCommand: app.installCommand,
      buildCommand: app.buildCommand,
      startCommand: app.startCommand,
      outputDirectory: app.outputDirectory,
      buildStage: app.buildStage,
      buildpackBuilder: app.buildpackBuilder,
      systemPackages: app.systemPackages,
      port: app.port,
      replicas: app.replicas,
      cpuLimit: app.cpuLimit,
      memoryLimitMb: app.memoryLimitMb,
      healthCheckPath: app.healthCheckPath,
      healthCheckTimeoutSec: app.healthCheckTimeoutSec,
      strategy: app.strategy,
      autoDeploy: app.autoDeploy,
      composeFile: app.composeFile,
      composePath: app.composePath,
      previewsEnabled: app.previewsEnabled,
      previewLimit: app.previewLimit,
      templateId: app.templateId,
    },
    hostAccess: app.hostAccess,
    previewEnv: app.previewEnvSealed === null ? null : secrets.open(app.previewEnvSealed, 'env'),
    deployKey: app.deployKey === null || app.deployPublicKey === null ? null : { privateKey: secrets.open(app.deployKey, 'ssh'), publicKey: app.deployPublicKey },
    repositoryAccount: installation?.accountLogin ?? provider?.name ?? null,
    gitProvider: provider === undefined || (provider.kind !== 'gitlab' && provider.kind !== 'bitbucket') ? null : { kind: provider.kind, baseUrl: provider.baseUrl, workspace: provider.workspace },
    commit: active?.commitSha ?? null,
    variables: stores.env.list({ applicationId: app.id }),
    variablesText: stores.env.text({ applicationId: app.id }),
    volumes: stores.volumes.listForApplication(app.id).map((volume) => ({
      id: volume.id,
      name: volume.name,
      mountPath: volume.mountPath,
      backupSchedule: volume.backupSchedule,
      backupRetention: volume.backupRetention,
      backupPause: volume.backupPause,
      data: extras.volumes.get(volume.id) === true,
    })),
    composeVolumes: extras.composeVolumes,
    domains: stores.domains.listForApplication(app.id).filter((domain) => !domain.isGenerated).map(domainOf),
    generatedDomain: stores.domains.listForApplication(app.id).some((domain) => domain.isGenerated),
    links: stores.links.listForApplication(app.id).map((link) => ({ serviceId: link.serviceId, prefix: link.prefix })),
    cron: stores.cron.listForApplication(app.id).map((job) => ({ name: job.name, schedule: job.schedule, command: job.command, enabled: job.enabled, timeoutSec: job.timeoutSec })),
    source: extras.source === null ? null : { name: extras.source.name, size: extras.source.size, files: extras.source.files, bytes: extras.source.bytes, origin: extras.source.origin },
    image: extras.image === null ? null : { tag: extras.image },
  };
}

/** Registry logins the project's private images need: images run as they are, and images named in stored compose files. */
function registriesFor(ctx: Context, project: ProjectRecord, apps: ApplicationRecord[]): Manifest['registries'] {
  const found = new Map<string, Manifest['registries'][number]>();
  const images: string[] = [];
  for (const app of apps) {
    if (app.sourceType === 'image' && app.image !== null) images.push(app.image);
    if (app.composeFile !== null) for (const match of app.composeFile.matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)) images.push(match[1]!);
  }
  for (const image of images) {
    const registry = ctx.stores.registries.forImage(project.teamId, image);
    if (registry !== undefined) found.set(registry.id, { name: registry.name, serverAddress: registry.serverAddress, username: registry.username, password: registry.password });
  }
  return [...found.values()];
}
