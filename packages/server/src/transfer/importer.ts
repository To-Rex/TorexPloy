/**
 * Unpacking a `.torexploy` archive into a new project.
 *
 * Before anything is made, the archive is looked over against this panel
 * (`analyzeImport`): which server it lands on, what clashes (a domain another
 * application serves, a public port in use), and where each application's
 * code comes from: its repository when this panel reaches it (the same GitHub
 * account, a GitLab or Bitbucket connection, a public URL), else the code in
 * the archive, or the built image when the archive has it.
 *
 * The import itself (`runImport`) checks the whole archive first, so a
 * damaged one changes nothing. Then it makes the project, its services and
 * applications with everything attached, reads the archive once from start to
 * end putting each entry back where it belongs (dumps into running
 * databases, files into volumes before their containers start, objects into
 * buckets), and deploys. Every step is recorded by id, so after a failure a
 * retry carries on where it stopped instead of making things twice.
 */
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import {
  DEFAULT_BUILD_TYPE,
  OBJECT_KEY_RE,
  type CreateServiceInput,
  type ImportAnalysisDto,
  type ImportApplicationDto,
  type ImportPlan,
  type ImportServiceDto,
  type ImportSourceChoice,
  type TransferNoteDto,
} from '@ploy/shared';
import { emit, type Context } from '../context.ts';
import { availableBuilders } from '../build/tools.ts';
import { composeProject, COMPOSE_PROJECT_LABEL } from '../compose/engine.ts';
import { receiveUpload } from '../deploy/uploads.ts';
import type { EnqueueInput } from '../deploy/deployer.ts';
import { appVolume, idPart, imageRepository, LABEL_APP, LABEL_MANAGED, LABEL_SERVICE } from '../docker/naming.ts';
import { generateDomain, generateServiceDomain } from '../domains/generate.ts';
import { generateToken } from '../lib/crypto.ts';
import { nextRunFor } from '../lib/cron.ts';
import { AppError, errorMessage } from '../lib/errors.ts';
import { readZipDirectory, readZipEntry } from '../lib/zip.ts';
import { catalogEntry, credentialFields } from '../services/catalog.ts';
import type { ApplicationRecord, ImportState, ProjectRecord, ServerRecord, ServiceRecord, TransferRecord } from '../store/index.ts';
import { HELPER_MOUNT, withVolumeHelper } from '../volumes/backups.ts';
import { ArchiveReader, verifyArchive, type ArchiveInfo } from './archive.ts';
import type { Manifest, ManifestApplication, ManifestDomain, ManifestService } from './manifest.ts';
import { ENTRY, MANIFEST_VERSION } from './manifest.ts';
import { note, type Progress } from './progress.ts';

const COMPOSE_VOLUME_LABEL = 'com.docker.compose.volume';
/** How long the import waits for its deployments before it calls itself done (they carry on either way). */
const DEPLOY_WAIT_MS = 45 * 60_000;

// ---------------------------------------------------------------- access

export interface RepositoryAccess {
  provider: 'github' | 'gitlab' | 'bitbucket' | 'git';
  account: string | null;
  installationId: number | null;
  providerId: string | null;
}

/** Which GitHub installation of the team sees each repository (`owner/name`, any case). */
export async function githubAccess(ctx: Context, teamId: string, repositories: string[]): Promise<Map<string, { installationId: number; account: string }>> {
  const found = new Map<string, { installationId: number; account: string }>();
  const wanted = new Set(repositories.map((repository) => repository.toLowerCase()));
  if (wanted.size === 0 || ctx.github.credentials() === null) return found;
  // Installations of the repository's owner first: usually the only one that sees it.
  const owners = new Set([...wanted].map((repository) => repository.split('/')[0]));
  const installations = ctx.stores.installations.listForTeam(teamId).sort((a, b) => Number(owners.has(b.accountLogin.toLowerCase())) - Number(owners.has(a.accountLogin.toLowerCase())));
  for (const installation of installations) {
    try {
      for (const repository of await ctx.github.repositories(installation.id)) {
        const key = repository.fullName.toLowerCase();
        if (wanted.has(key) && !found.has(key)) found.set(key, { installationId: installation.id, account: installation.accountLogin });
      }
    } catch (error) {
      ctx.logger.debug('A GitHub installation could not list its repositories', { installationId: installation.id, error: errorMessage(error) });
    }
    if (found.size === wanted.size) break;
  }
  return found;
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

/** How this panel reaches an application's repository, or null when it cannot. */
export function repositoryAccess(ctx: Context, teamId: string, app: ManifestApplication, github: Map<string, { installationId: number; account: string }>): RepositoryAccess | null {
  const settings = app.settings;
  if (settings.sourceType === 'github' && settings.repository !== null) {
    const match = github.get(settings.repository.toLowerCase());
    return match === undefined ? null : { provider: 'github', account: match.account, installationId: match.installationId, providerId: null };
  }
  if ((settings.sourceType === 'gitlab' || settings.sourceType === 'bitbucket') && settings.repository !== null && app.gitProvider !== null) {
    const host = hostOf(app.gitProvider.baseUrl);
    const provider = ctx.stores.gitProviders
      .listForTeam(teamId)
      .find((candidate) => candidate.kind === settings.sourceType && hostOf(candidate.baseUrl) === host && (candidate.workspace === null || candidate.workspace === app.gitProvider!.workspace));
    return provider === undefined ? null : { provider: settings.sourceType, account: provider.name, installationId: null, providerId: provider.id };
  }
  if (settings.sourceType === 'git' && settings.gitUrl !== null) {
    // A public HTTPS address clones from anywhere; an SSH one with the deploy key the archive brings.
    if (/^https?:\/\//i.test(settings.gitUrl) || app.deployKey !== null) return { provider: 'git', account: hostOf(settings.gitUrl.replace(/^git@([^:]+):/, 'ssh://$1/')), installationId: null, providerId: null };
  }
  return null;
}

/** The ways an application can get its code here, best first. */
export function sourceChoices(app: ManifestApplication, access: RepositoryAccess | null): ImportSourceChoice[] {
  const choices: ImportSourceChoice[] = [];
  if (app.image !== null && app.kind !== 'compose') choices.push('image');
  if (access !== null) choices.push('repository');
  if (app.source !== null && app.settings.sourceType !== 'image' && app.settings.sourceType !== 'raw') choices.push('archive');
  return choices;
}

// ---------------------------------------------------------------- clashes

/** A domain this panel cannot give the imported application: another one serves it, another team owns the host, or it is the panel's own. */
export function domainConflict(ctx: Context, teamId: string, domain: ManifestDomain): boolean {
  const { stores } = ctx;
  const owner = stores.domains.findByHost(domain.host);
  return stores.domains.findRoute(domain.host, domain.path) !== undefined || (owner !== undefined && owner.teamId !== teamId) || stores.settings.platform().platformDomain === domain.host;
}

export function uniqueProjectName(ctx: Context, teamId: string, wanted: string): string {
  const taken = new Set(ctx.stores.projects.listForTeam(teamId).map((project) => project.name.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; n < 1_000; n += 1) {
    const suffix = ` (${n})`;
    const candidate = `${wanted.slice(0, 64 - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${wanted.slice(0, 50)} ${Date.now().toString(36)}`;
}

function builderAvailable(buildType: string): boolean {
  return availableBuilders().includes(buildType as never);
}

// ---------------------------------------------------------------- analysis

export async function analyzeImport(ctx: Context, transfer: TransferRecord, manifest: Manifest, info: ArchiveInfo, requestedServerId: string | null, github: Map<string, { installationId: number; account: string }>): Promise<ImportAnalysisDto> {
  const { stores } = ctx;
  const teamId = transfer.teamId;
  const servers = stores.servers.listForTeam(teamId);
  const chosen = servers.find((server) => server.id === requestedServerId) ?? servers.find((server) => server.status === 'ready') ?? servers[0];
  const serviceNames = new Map(manifest.services.map((service) => [service.id, service.name]));

  const applications: ImportApplicationDto[] = manifest.applications.map((app) => {
    const access = repositoryAccess(ctx, teamId, app, github);
    return {
      id: app.id,
      name: app.name,
      kind: app.kind,
      sourceType: app.settings.sourceType,
      repository: app.settings.repository ?? app.settings.gitUrl,
      branch: app.settings.branch,
      image: app.settings.image,
      commit: app.commit,
      sources: sourceChoices(app, access),
      repositoryAccess: access === null ? null : { provider: access.provider, account: access.account },
      archiveBytes: app.source?.size ?? null,
      imageBytes: app.image === null ? null : 0,
      domains: app.domains.map((domain) => ({ host: domain.host, path: domain.path, conflict: domainConflict(ctx, teamId, domain) })),
      volumes: app.volumes.length + app.composeVolumes.length,
      variables: app.variables.length,
      cron: app.cron.length,
      links: app.links.map((link) => serviceNames.get(link.serviceId) ?? link.serviceId),
      builderAvailable: app.kind === 'compose' || app.settings.sourceType === 'image' || builderAvailable(app.settings.buildType),
      hostAccess: app.hostAccess,
    };
  });

  const services: ImportServiceDto[] = manifest.services.map((service) => ({
    id: service.id,
    name: service.name,
    type: service.type,
    version: service.version,
    data: service.data?.kind ?? null,
    dataBytes: null,
    buckets: service.buckets.length,
    keys: service.keys.length,
    publicPort: service.publicPort,
    portTaken: chosen !== undefined && service.publicPort !== null && (stores.services.isPublicPortTaken(chosen.id, service.publicPort, '') || [22, 80, 443].includes(service.publicPort)),
  }));

  const warnings: TransferNoteDto[] = [...manifest.warnings];
  for (const service of manifest.services) {
    const entry = catalogEntry(service.type);
    if (!entry.versions.includes(service.version)) {
      warnings.push(
        service.data?.kind === 'files'
          ? note('service_version_missing', `${entry.label} ${service.version} (${service.name}) is not offered by this panel, and its files only open in that version: update this panel first`, { name: service.name, version: service.version })
          : note('service_version_changed', `${entry.label} ${service.version} (${service.name}) is not offered by this panel; it gets ${entry.defaultVersion} and its dump is restored into it`, { name: service.name, version: service.version, next: entry.defaultVersion }),
      );
    }
  }
  if (servers.length === 0) warnings.push(note('no_server', 'This team has no server to put the project on yet: add one first'));
  const registries = manifest.registries.map((registry) => ({
    serverAddress: registry.serverAddress,
    username: registry.username,
    exists: stores.registries.listForTeam(teamId).some((existing) => existing.serverAddress === registry.serverAddress && existing.username === registry.username),
  }));

  return {
    transferId: transfer.id,
    createdAt: manifest.createdAt || info.createdAt,
    panelVersion: manifest.panel.version,
    origin: manifest.panel.origin,
    include: manifest.include,
    project: { name: manifest.project.name, description: manifest.project.description, variables: manifest.project.variables.length },
    suggestedName: uniqueProjectName(ctx, teamId, manifest.project.name),
    servers: servers.map((server) => ({ id: server.id, name: server.name, status: server.status, host: server.host })),
    serverId: chosen?.id ?? null,
    applications,
    services,
    registries,
    warnings,
  };
}

// ---------------------------------------------------------------- import

export interface ImportJob {
  transfer: TransferRecord;
  archivePath: string;
  passphrase: string;
  manifest: Manifest;
  plan: ImportPlan;
  progress: Progress;
  signal: AbortSignal;
  userId: string | null;
  state: ImportState;
  verified: boolean;
  /** Record progress in ids (called often; the caller decides how often it reaches the row). */
  save: (state: ImportState, options?: { verified?: boolean; projectId?: string; projectName?: string }) => void;
  github: Map<string, { installationId: number; account: string }>;
}

export function emptyImportState(): ImportState {
  return { services: {}, applications: {}, volumes: {}, images: {}, applied: [], configured: [], stocked: [], deployed: [] };
}

/**
 * A promise kept for later: marked as handled now, so a failure before anyone awaits it never brings the panel
 * down as an unhandled rejection; whoever awaits it later still sees the failure.
 */
function kept<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

/** Bytes counted on their way past. */
async function* counted(source: AsyncIterable<Buffer>, onBytes: (bytes: number) => void): AsyncGenerator<Buffer> {
  for await (const chunk of source) {
    onBytes(chunk.length);
    yield chunk;
  }
}

export async function runImport(ctx: Context, job: ImportJob): Promise<{ projectId: string }> {
  const { stores } = ctx;
  const { manifest, plan, progress, signal, state } = job;
  const teamId = job.transfer.teamId;
  if (manifest.version > MANIFEST_VERSION) throw new AppError('bad_request', 'This archive was made by a newer TorexPloy; update this panel first', { params: { reason: 'unsupported_version' } });
  const server = stores.servers.getForTeam(teamId, plan.serverId);
  if (server === undefined) throw new AppError('validation_failed', 'Unknown server', { params: { reason: 'server_missing' } });

  // Overall progress: checking the archive, making things, putting the data back, deploying.
  const phase = { verify: job.verified ? 1 : 0, setup: 0, data: 0, deploy: 0 };
  progress.percentOf = () => 100 * (0.2 * phase.verify + 0.05 * phase.setup + 0.55 * phase.data + 0.2 * phase.deploy);
  let lastSave = 0;
  const save = (force = false, extra: Parameters<ImportJob['save']>[1] = {}): void => {
    if (!force && Date.now() - lastSave < 1_500) return;
    lastSave = Date.now();
    job.save(state, extra);
  };

  // ---------------------------------------------------------- verify
  progress.add('verify', 'verify', null, { weight: 1 });
  if (!job.verified) {
    progress.start('verify', null, 'bytes');
    await verifyArchive(
      job.archivePath,
      job.passphrase,
      (position, size) => {
        phase.verify = size === 0 ? 1 : position / size;
        progress.total('verify', size, 'bytes');
        progress.set('verify', position);
      },
      signal,
    );
    save(true, { verified: true });
  }
  phase.verify = 1;
  progress.done('verify');

  // ---------------------------------------------------------- project
  progress.add('project', 'project', plan.projectName);
  progress.start('project');
  let project: ProjectRecord | undefined = state.projectId === undefined ? undefined : stores.projects.get(state.projectId);
  if (project === undefined) {
    project = stores.projects.create(teamId, uniqueProjectName(ctx, teamId, plan.projectName), manifest.project.description);
    state.projectId = project.id;
    stores.env.replace({ projectId: project.id }, manifest.project.variables);
    if (manifest.project.variablesText !== null) stores.env.setText({ projectId: project.id }, manifest.project.variablesText);
    save(true, { projectId: project.id, projectName: project.name });
    emit(ctx, teamId, { type: 'project.updated', id: project.id });
  }
  for (const registry of manifest.registries) {
    const exists = stores.registries.listForTeam(teamId).some((existing) => existing.serverAddress === registry.serverAddress && existing.username === registry.username);
    if (!exists) stores.registries.create(teamId, registry);
  }
  progress.done('project');

  // ---------------------------------------------------------- services
  const services = new Map<string, ManifestService>(manifest.services.map((service) => [service.id, service]));
  const provisioning = new Map<string, Promise<ServiceRecord>>();
  const serviceStep = (id: string): string => `service:${id}`;
  for (const item of manifest.services) progress.add(serviceStep(item.id), item.type === 'files' ? 'storage' : 'database', item.name, { weight: 3 });
  for (const item of manifest.services) {
    let service = state.services[item.id] === undefined ? undefined : stores.services.get(state.services[item.id]!);
    if (service === undefined) {
      service = createService(ctx, project, server, item, plan, progress);
      state.services[item.id] = service.id;
      save(true);
    }
    // A service whose files arrive from the archive starts only once they are in place.
    const waitsForFiles = plan.restoreData && item.data?.kind === 'files' && !state.applied.includes(ENTRY.serviceFiles(item.id));
    if (!waitsForFiles) provisioning.set(item.id, kept(provision(ctx, service, item)));
  }

  // ---------------------------------------------------------- applications
  const apps = new Map<string, ManifestApplication>(manifest.applications.map((app) => [app.id, app]));
  const choices = new Map<string, ImportSourceChoice | null>();
  for (const item of manifest.applications) {
    const access = repositoryAccess(ctx, teamId, item, job.github);
    const options = sourceChoices(item, access);
    const wanted = plan.sources[item.id];
    choices.set(item.id, wanted !== undefined && options.includes(wanted) ? wanted : (options[0] ?? null));
    const step = progress.add(`app:${item.id}`, 'application', item.name, { weight: 1 });
    let app = state.applications[item.id] === undefined ? undefined : stores.applications.get(state.applications[item.id]!);
    if (app === undefined) {
      progress.start(step);
      app = createApplication(ctx, project, server, item, choices.get(item.id) ?? null, access, progress);
      state.applications[item.id] = app.id;
      save(true);
    }
    if (!state.configured.includes(item.id)) {
      configureApplication(ctx, project, app, item, plan, state, progress);
      state.configured.push(item.id);
      save(true);
    }
    progress.done(step);
    emit(ctx, teamId, { type: 'application.updated', id: app.id, projectId: project.id, status: app.status });
  }
  phase.setup = 1;

  // ---------------------------------------------------------- data
  const stocked = new Map<string, Promise<void>>();
  const stock = (item: ManifestService, service: ServiceRecord): Promise<void> => {
    let pending = stocked.get(item.id);
    if (pending === undefined) {
      pending = kept(stockStore(ctx, service, item, state).then(() => save(true)));
      stocked.set(item.id, pending);
    }
    return pending;
  };
  const running = async (item: ManifestService): Promise<ServiceRecord> => {
    let pending = provisioning.get(item.id);
    if (pending === undefined) {
      pending = kept(provision(ctx, stores.services.get(state.services[item.id]!)!, item));
      provisioning.set(item.id, pending);
    }
    return pending;
  };

  const archive = await ArchiveReader.open(job.archivePath, job.passphrase);
  const clients = new Map<string, Awaited<ReturnType<Context['storage']['client']>>>();
  try {
    for await (const entry of archive.entries()) {
      signal.throwIfAborted();
      phase.data = archive.info.size === 0 ? 1 : archive.position / archive.info.size;
      const meta = (entry.meta ?? {}) as Record<string, unknown>;
      const kind = typeof meta.kind === 'string' ? meta.kind : '';
      if (state.applied.includes(entry.path) || kind === '' || kind === 'summary') continue;

      if (kind === 'service-dump' || kind === 'service-files' || kind === 'object') {
        const item = services.get(String(meta.service));
        if (item === undefined || state.services[item.id] === undefined) continue;
        const step = serviceStep(item.id);
        if (!plan.restoreData) continue;
        if (kind === 'service-dump') {
          progress.start(step, entry.size, 'bytes');
          const service = await running(item);
          await ctx.services.restoreStream(service, counted(entry.body, (bytes) => progress.advance(step, bytes)), entry.size);
          progress.done(step);
        } else if (kind === 'service-files') {
          progress.start(step, entry.size, 'bytes');
          const service = stores.services.get(state.services[item.id]!)!;
          const docker = await ctx.connections.docker(service.serverId);
          await docker.ensureVolume(service.volumeName, { [LABEL_MANAGED]: 'true', [LABEL_SERVICE]: service.id });
          await fillVolume(ctx, service.serverId, service.volumeName, counted(entry.body, (bytes) => progress.advance(step, bytes)));
          provisioning.set(item.id, kept(provision(ctx, service, item)));
          progress.done(step);
        } else {
          const bucket = String(meta.bucket ?? '');
          const key = String(meta.key ?? '');
          if (!item.buckets.some((candidate) => candidate.name === bucket) || !OBJECT_KEY_RE.test(key)) {
            progress.warn(note('object_skipped', `An object of ${item.name} has a name this panel does not accept; it was left out`, { name: item.name }));
            continue;
          }
          const currentStep = progress.get(step);
          if (currentStep?.status !== 'running') progress.start(step, null, 'bytes');
          const service = await running(item);
          await stock(item, service);
          let client = clients.get(`${item.id}/${bucket}`);
          if (client === undefined) {
            client = await ctx.storage.client(service, bucket);
            clients.set(`${item.id}/${bucket}`, client);
          }
          const contentType = typeof meta.contentType === 'string' && meta.contentType.length < 256 ? meta.contentType : 'application/octet-stream';
          await client.put(key, Readable.from(counted(entry.body, (bytes) => progress.advance(step, bytes))), entry.size, contentType);
        }
      } else if (kind === 'volume' || kind === 'compose-volume') {
        const item = apps.get(String(meta.application));
        const appId = item === undefined ? undefined : state.applications[item.id];
        const app = appId === undefined ? undefined : stores.applications.get(appId);
        if (item === undefined || app === undefined || !plan.restoreData) continue;
        if (kind === 'volume') {
          const volumeId = state.volumes[String(meta.volume)];
          const volume = volumeId === undefined ? undefined : stores.volumes.get(volumeId);
          if (volume === undefined) continue;
          const step = progress.add(`volume:${String(meta.volume)}`, 'volume', `${app.name} · ${volume.name}`, { weight: 2 });
          progress.start(step, entry.size, 'bytes');
          const docker = await ctx.connections.docker(app.serverId);
          await docker.ensureVolume(volume.dockerVolume, { [LABEL_MANAGED]: 'true', [LABEL_APP]: app.id });
          await fillVolume(ctx, app.serverId, volume.dockerVolume, counted(entry.body, (bytes) => progress.advance(step, bytes)));
          progress.done(step);
        } else {
          const name = String(meta.name ?? '');
          if (!item.composeVolumes.includes(name)) continue;
          const step = progress.add(`compose-volume:${item.id}:${name}`, 'volume', `${app.name} · ${name}`, { weight: 2 });
          progress.start(step, entry.size, 'bytes');
          const docker = await ctx.connections.docker(app.serverId);
          const project = composeProject(app);
          await docker.ensureVolume(`${project}_${name}`, { [COMPOSE_PROJECT_LABEL]: project, [COMPOSE_VOLUME_LABEL]: name });
          await fillVolume(ctx, app.serverId, `${project}_${name}`, counted(entry.body, (bytes) => progress.advance(step, bytes)));
          progress.done(step);
        }
      } else if (kind === 'source') {
        const item = apps.get(String(meta.application));
        const appId = item === undefined ? undefined : state.applications[item.id];
        const app = appId === undefined ? undefined : stores.applications.get(appId);
        if (item === undefined || app === undefined) continue;
        const step = progress.add(`source:${item.id}`, 'source', app.name, { weight: 1 });
        if (app.kind === 'compose') {
          if (app.sourceType !== 'raw' || app.composeFile !== null) continue;
          progress.start(step, entry.size, 'bytes');
          await composeFromArchive(ctx, app, item, entry.body, entry.size, progress, step);
        } else if (app.sourceType === 'upload') {
          progress.start(step, entry.size, 'bytes');
          const name = typeof meta.name === 'string' ? meta.name : `${app.slug}.zip`;
          const upload = await receiveUpload(ctx.config.dataDir, app.id, Readable.from(counted(entry.body, (bytes) => progress.advance(step, bytes))), entry.size, name.slice(0, 120));
          stores.applications.setUpload(app.id, upload);
          progress.done(step);
        } else {
          continue;
        }
      } else if (kind === 'image') {
        const item = apps.get(String(meta.application));
        const appId = item === undefined ? undefined : state.applications[item.id];
        const app = appId === undefined ? undefined : stores.applications.get(appId);
        if (item === undefined || app === undefined || choices.get(item.id) !== 'image') continue;
        const step = progress.add(`image:${item.id}`, 'image', app.name, { weight: 2 });
        progress.start(step, entry.size, 'bytes');
        const docker = await ctx.connections.docker(app.serverId);
        const gunzip = createGunzip();
        const loaded = await docker.loadImage(Readable.from(counted(entry.body, (bytes) => progress.advance(step, bytes))).pipe(gunzip), signal);
        const original = typeof meta.tag === 'string' ? meta.tag : loaded[0];
        if (original === undefined) throw new AppError('bad_request', `The image of ${app.name} could not be loaded`);
        const repository = imageRepository(app);
        const tag = `import-${idPart(job.transfer.id, 10)}`;
        await docker.tagImage(original, repository, tag);
        if (original !== `${repository}:${tag}`) await docker.removeImage(original).catch(() => false);
        state.images[item.id] = `${repository}:${tag}`;
        progress.done(step);
      } else {
        continue;
      }
      // Objects go back by overwriting, so a retry simply puts them again: a store of a million files would make
      // this record enormous. Everything else is noted, so a retry skips it.
      if (kind !== 'object') state.applied.push(entry.path);
      save();
    }
  } finally {
    await archive.close();
  }
  phase.data = 1;
  save(true);

  // Every service up, file stores with their buckets and keys.
  for (const item of manifest.services) {
    const step = serviceStep(item.id);
    try {
      const service = await running(item);
      if (item.type === 'files') await stock(item, service);
      if (progress.get(step)?.status !== 'done') progress.done(step);
    } catch (error) {
      const failure = note('service_failed', `${item.name} did not start: ${errorMessage(error)}`, { name: item.name, error: errorMessage(error).slice(0, 300) });
      progress.fail(step, failure);
      progress.warn(failure);
    }
  }
  for (const item of manifest.services) {
    const service = stores.services.get(state.services[item.id]!);
    if (service !== undefined) emit(ctx, teamId, { type: 'service.updated', id: service.id, projectId: project.id, status: service.status });
  }

  // ---------------------------------------------------------- deploy
  if (plan.deploy) await deployAll(ctx, job, project, choices, (fraction) => (phase.deploy = fraction));
  phase.deploy = 1;
  stores.projects.touch(project.id);
  save(true);
  return { projectId: project.id };
}

/** Put a volume's files back: emptied first (a retry starts clean), then unpacked with their owners. */
async function fillVolume(ctx: Context, serverId: string, volume: string, body: AsyncIterable<Buffer>): Promise<void> {
  const docker = await ctx.connections.docker(serverId);
  await withVolumeHelper(ctx, docker, { source: volume, mode: 'rw', name: 'ploy-import' }, async (helper) => {
    await docker.exec(helper, ['find', HELPER_MOUNT, '-mindepth', '1', '-delete'], { timeoutMs: 3_600_000 });
    // The archive holds "volume/…": unpacked at the root it lands in the mount.
    await docker.putArchive(helper, '/', Readable.from(body), { keepOwners: true, timeoutMs: 6 * 3_600_000 });
  });
}

function createService(ctx: Context, project: ProjectRecord, server: ServerRecord, item: ManifestService, plan: ImportPlan, progress: Progress): ServiceRecord {
  const { stores } = ctx;
  const entry = catalogEntry(item.type);
  let version = item.version;
  if (!entry.versions.includes(version)) {
    if (item.data?.kind === 'files' && plan.restoreData) {
      throw new AppError('bad_request', `${entry.label} ${version} (${item.name}) is not offered by this panel, and its files only open in that version: update this panel first`, { params: { reason: 'service_version_missing' } });
    }
    version = entry.defaultVersion;
    progress.warn(note('service_version_changed', `${item.name} runs ${entry.label} ${version} here (it was ${item.version})`, { name: item.name, version: item.version, next: version }));
  }
  // The same credentials: the applications' variables (and anything else that connects) keep working.
  const supported = credentialFields(item.type) as readonly string[];
  const credentials: Record<string, string> = {};
  for (const [field, value] of Object.entries(item.credentials)) if (typeof value === 'string' && value.length > 0 && supported.includes(field)) credentials[field] = value;
  let publicPort: number | undefined;
  if (plan.publicPorts && item.publicPort !== null) {
    if (stores.services.isPublicPortTaken(server.id, item.publicPort, '') || [22, 80, 443].includes(item.publicPort)) {
      progress.warn(note('port_taken', `Port ${item.publicPort} of ${item.name} is taken on ${server.name}; the service stays private`, { name: item.name, port: item.publicPort }));
    } else {
      publicPort = item.publicPort;
    }
  }
  const created = ctx.services.create(
    project,
    { type: item.type, name: item.name, version, serverId: server.id, credentials: credentials as CreateServiceInput['credentials'], ...(publicPort === undefined ? {} : { publicPort }), ...(item.memoryLimitMb === null ? {} : { memoryLimitMb: item.memoryLimitMb }) },
    { slug: item.slug, provision: false },
  );
  let service = stores.services.update(created.id, { cpuLimit: item.cpuLimit, backupRetention: item.backup.retention, ...(entry.backup === null ? {} : { backupSchedule: item.backup.schedule }) });
  if (plan.domains) {
    for (const domain of item.domains) {
      if (domainConflict(ctx, project.teamId, domain)) {
        progress.warn(note('domain_taken', `${domain.host} is already served here; ${item.name} was imported without it`, { host: domain.host, name: item.name }));
        continue;
      }
      const record = stores.domains.create({ serviceId: service.id, teamId: project.teamId, ...domain, isGenerated: false });
      ctx.domains.followUp(record.id);
    }
  }
  if (item.generatedDomain) generateServiceDomain(ctx, service, project);
  service = stores.services.get(service.id)!;
  return service;
}

/** Provision a service and wait until it runs; a failure is the service's, reported by the caller. */
async function provision(ctx: Context, service: ServiceRecord, item: ManifestService): Promise<ServiceRecord> {
  const current = ctx.stores.services.get(service.id);
  if (current?.status === 'running') return current;
  await ctx.services.provision(service.id);
  const after = ctx.stores.services.get(service.id);
  if (after === undefined) throw new AppError('not_found', `${item.name} was removed during the import`);
  if (after.status !== 'running') throw new AppError('bad_request', after.statusMessage ?? `${item.name} did not start`, { params: { reason: after.statusReason ?? 'service_failed' } });
  return after;
}

/** A file store's buckets (with their public flag) and access keys, the same keys as before. */
async function stockStore(ctx: Context, service: ServiceRecord, item: ManifestService, state: ImportState): Promise<void> {
  if (state.stocked.includes(item.id)) return;
  const { stores } = ctx;
  const existing = new Set((await ctx.storage.listBuckets(service)).map((bucket) => bucket.name));
  for (const bucket of item.buckets) {
    if (!existing.has(bucket.name)) await ctx.storage.createBucket(service, bucket.name, bucket.public);
    else if (bucket.public !== stores.storageBuckets.get(service.id, bucket.name)?.public) await ctx.storage.setBucketPublic(service, bucket.name, bucket.public);
  }
  const keys = stores.storageKeys.listForService(service.id);
  for (const key of item.keys) {
    if (keys.some((candidate) => candidate.accessKeyId === key.accessKeyId)) continue;
    await ctx.storage.createKey(service, { name: key.name, buckets: key.buckets, permission: key.permission, accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey });
  }
  ctx.storage.forgetStats(service.id);
  state.stocked.push(item.id);
}

function createApplication(ctx: Context, project: ProjectRecord, server: ServerRecord, item: ManifestApplication, choice: ImportSourceChoice | null, access: RepositoryAccess | null, progress: Progress): ApplicationRecord {
  const { stores, secrets } = ctx;
  const settings = item.settings;
  const none = { githubInstallationId: null, gitProviderId: null, repository: null, gitUrl: null, branch: null, image: null } as const;
  type Source = Pick<ApplicationRecord, 'sourceType' | 'githubInstallationId' | 'gitProviderId' | 'repository' | 'gitUrl' | 'branch' | 'image'>;
  let source: Source;
  // The repository stays the source whenever this panel reaches it (an image only starts it faster).
  const linked = access !== null && (choice === 'repository' || choice === 'image');
  if (settings.sourceType === 'image') {
    source = { ...none, sourceType: 'image', image: settings.image };
  } else if (settings.sourceType === 'raw') {
    source = { ...none, sourceType: 'raw' };
  } else if (linked && access !== null) {
    if (access.provider === 'github') source = { ...none, sourceType: 'github', githubInstallationId: access.installationId, repository: settings.repository, branch: settings.branch };
    else if (access.provider === 'gitlab' || access.provider === 'bitbucket') source = { ...none, sourceType: access.provider, gitProviderId: access.providerId, repository: settings.repository, branch: settings.branch };
    else source = { ...none, sourceType: 'git', gitUrl: settings.gitUrl, branch: settings.branch };
  } else if (item.kind === 'compose' && choice === 'archive') {
    // A stack whose repository is out of reach runs from its compose file, taken from the archived code.
    source = { ...none, sourceType: 'raw' };
  } else if (item.kind !== 'compose' && (choice === 'archive' || (choice === 'image' && item.source !== null))) {
    source = { ...none, sourceType: 'upload' };
  } else {
    // No way to the code here: the repository stays named (a public one still clones), waiting to be connected.
    source = { ...none, sourceType: settings.sourceType, repository: settings.repository, gitUrl: settings.gitUrl, branch: settings.branch };
    if (choice !== 'image') {
      progress.warn(note('source_unlinked', `${item.name} is not connected to its repository on this panel: connect it, or choose the repository again in its settings`, { name: item.name }));
    }
  }
  const buildType = builderAvailable(settings.buildType) ? settings.buildType : DEFAULT_BUILD_TYPE;
  if (buildType !== settings.buildType && item.kind !== 'compose' && settings.sourceType !== 'image') {
    progress.warn(note('builder_missing', `${item.name} was built with ${settings.buildType}, which this panel does not have; it builds with TorexBuilder here`, { name: item.name, builder: settings.buildType }));
  }
  const created = stores.applications.create({
    projectId: project.id,
    teamId: project.teamId,
    serverId: server.id,
    name: item.name,
    slug: stores.projects.uniqueResourceSlug(project.id, item.slug, 'app'),
    kind: item.kind,
    ...source,
    buildType,
    dockerfilePath: settings.dockerfilePath,
    rootDirectory: settings.rootDirectory,
    installCommand: settings.installCommand,
    buildCommand: settings.buildCommand,
    startCommand: settings.startCommand,
    outputDirectory: settings.outputDirectory,
    buildStage: settings.buildStage,
    buildpackBuilder: settings.buildpackBuilder,
    systemPackages: settings.systemPackages,
    port: settings.port,
    templateId: settings.templateId,
    composeFile: settings.composeFile,
    composePath: settings.composePath,
    sealedHookToken: secrets.seal(generateToken(24), 'hook'),
  });
  // Previews need the repository connected here (its pull requests are what they deploy).
  const previewable = linked && created.kind === 'web' && ['github', 'gitlab', 'bitbucket'].includes(created.sourceType);
  stores.applications.update(created.id, {
    description: item.description,
    replicas: settings.replicas,
    cpuLimit: settings.cpuLimit,
    memoryLimitMb: settings.memoryLimitMb,
    healthCheckPath: settings.healthCheckPath,
    healthCheckTimeoutSec: settings.healthCheckTimeoutSec,
    strategy: settings.strategy,
    autoDeploy: settings.autoDeploy,
    previewsEnabled: previewable && settings.previewsEnabled,
    previewLimit: settings.previewLimit,
  });
  if (item.hostAccess) stores.applications.setHostAccess(created.id, true);
  if (item.previewEnv !== null) stores.applications.setPreviewEnv(created.id, secrets.seal(item.previewEnv, 'env'));
  if (item.deployKey !== null) stores.applications.setDeployKey(created.id, secrets.seal(item.deployKey.privateKey, 'ssh'), item.deployKey.publicKey);
  const app = stores.applications.get(created.id)!;
  if (app.sourceType === 'gitlab' || app.sourceType === 'bitbucket') void ctx.gitProviders.ensureWebhook(app).catch(() => undefined);
  return app;
}

function configureApplication(ctx: Context, project: ProjectRecord, app: ApplicationRecord, item: ManifestApplication, plan: ImportPlan, state: ImportState, progress: Progress): void {
  const { stores } = ctx;
  stores.env.replace({ applicationId: app.id }, item.variables);
  if (item.variablesText !== null) stores.env.setText({ applicationId: app.id }, item.variablesText);

  const existingVolumes = stores.volumes.listForApplication(app.id);
  for (const volume of item.volumes) {
    let record = existingVolumes.find((candidate) => candidate.name === volume.name);
    if (record === undefined) {
      record = stores.volumes.create(app.id, volume.name, volume.mountPath, appVolume(app, volume.name));
      stores.volumes.setBackupPolicy(record.id, { backupSchedule: volume.backupSchedule, backupRetention: volume.backupRetention, backupPause: volume.backupPause });
    }
    state.volumes[volume.id] = record.id;
  }

  const links = stores.links.listForApplication(app.id);
  for (const link of item.links) {
    const serviceId = state.services[link.serviceId];
    if (serviceId === undefined || links.some((existing) => existing.serviceId === serviceId)) continue;
    stores.links.create(app.id, serviceId, link.prefix);
  }

  const jobs = stores.cron.listForApplication(app.id);
  const timezone = stores.settings.timezone();
  for (const job of item.cron) {
    if (jobs.some((existing) => existing.name === job.name && existing.command === job.command)) continue;
    let nextRunAt: string | null = null;
    try {
      nextRunAt = job.enabled ? nextRunFor(job.schedule, new Date(), timezone).toISOString() : null;
    } catch {
      progress.warn(note('cron_schedule', `The schedule of ${job.name} (${app.name}) is not valid here; the job was made switched off`, { name: job.name }));
    }
    stores.cron.create({ applicationId: app.id, name: job.name, schedule: job.schedule, command: job.command, enabled: job.enabled && nextRunAt !== null, timeoutSec: job.timeoutSec, nextRunAt });
  }

  const domains = stores.domains.listForApplication(app.id);
  if (plan.domains) {
    for (const domain of item.domains) {
      if (domains.some((existing) => existing.host === domain.host && existing.path === domain.path)) continue;
      if (domainConflict(ctx, project.teamId, domain)) {
        progress.warn(note('domain_taken', `${domain.host} is already served here; ${app.name} was imported without it`, { host: domain.host, name: app.name }));
        continue;
      }
      const record = stores.domains.create({ applicationId: app.id, teamId: app.teamId, ...domain, isGenerated: false });
      ctx.domains.followUp(record.id);
    }
  }
  if (item.generatedDomain && !domains.some((existing) => existing.isGenerated)) generateDomain(ctx, app, project);
  stores.applications.markConfigChanged(app.id);
}

/** A stack whose repository is out of reach: its compose file comes from the archived code. */
async function composeFromArchive(ctx: Context, app: ApplicationRecord, item: ManifestApplication, body: AsyncIterable<Buffer>, size: number, progress: Progress, step: string): Promise<void> {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(ctx.config.dataDir, 'transfers', 'compose-'));
  try {
    const parts: Buffer[] = [];
    for await (const chunk of counted(body, (bytes) => progress.advance(step, bytes))) parts.push(chunk);
    const zip = join(dir, 'source.zip');
    await writeFile(zip, Buffer.concat(parts, size), { mode: 0o600 });
    const wanted = [item.settings.rootDirectory, item.settings.composePath].filter((part) => part.length > 0).join('/').replace(/^\.?\/+/, '');
    const entry = (await readZipDirectory(zip)).find((candidate) => candidate.path === wanted);
    if (entry === undefined) {
      progress.skip(step, note('compose_missing', `The archived code of ${app.name} has no ${wanted}`, { name: app.name, path: wanted }));
      return;
    }
    const text = (await readZipEntry(zip, entry, 1024 * 1024)).toString('utf8');
    ctx.stores.applications.update(app.id, { composeFile: text });
    if (/^\s*build\s*:/m.test(text)) progress.warn(note('compose_build', `${app.name} builds images from its repository, which this panel cannot reach: connect the repository for it to deploy`, { name: app.name }));
    progress.done(step);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Deploy each application the way its code arrived, and wait for them (they carry on if the wait runs out). */
async function deployAll(ctx: Context, job: ImportJob, project: ProjectRecord, choices: Map<string, ImportSourceChoice | null>, onFraction: (fraction: number) => void): Promise<void> {
  const { stores } = ctx;
  const { manifest, progress, state } = job;
  const started = new Map<string, string>();
  for (const item of manifest.applications) {
    const appId = state.applications[item.id];
    const app = appId === undefined ? undefined : stores.applications.get(appId);
    if (app === undefined) continue;
    const step = progress.add(`deploy:${item.id}`, 'deploy', app.name, { weight: 2 });
    if (state.deployed.includes(item.id)) {
      if (progress.get(step)?.status === 'pending') progress.done(step);
      continue;
    }
    const input: EnqueueInput = { app, trigger: 'manual', createdBy: job.userId };
    const image = state.images[item.id];
    if (image !== undefined && choices.get(item.id) === 'image') input.imageTag = image;
    else if (['github', 'gitlab', 'bitbucket', 'git'].includes(app.sourceType) && item.commit !== null && item.commit.length > 0) input.commitSha = item.commit;
    if (input.imageTag == null && app.sourceType === 'upload' && app.upload === null) {
      progress.skip(step, note('no_code', `${app.name} has no code here yet: upload it, or connect its repository`, { name: app.name }));
      continue;
    }
    if (input.imageTag == null && app.kind === 'compose' && app.sourceType === 'raw' && app.composeFile === null) {
      progress.skip(step, note('no_code', `${app.name} has no compose file here yet`, { name: app.name }));
      continue;
    }
    try {
      progress.start(step);
      const deployment = ctx.deployer.enqueue(input);
      started.set(item.id, deployment.id);
      state.deployed.push(item.id);
      job.save(state);
    } catch (error) {
      progress.fail(step, note('deploy_failed', `${app.name} could not be deployed: ${errorMessage(error)}`, { name: app.name, error: errorMessage(error).slice(0, 300) }));
    }
  }
  emit(ctx, project.teamId, { type: 'project.updated', id: project.id });

  const deadline = Date.now() + DEPLOY_WAIT_MS;
  const open = new Map(started);
  const total = Math.max(1, started.size);
  while (open.size > 0 && Date.now() < deadline) {
    job.signal.throwIfAborted();
    for (const [itemId, deploymentId] of open) {
      const deployment = stores.deployments.get(deploymentId);
      if (deployment === undefined || !['succeeded', 'failed', 'cancelled'].includes(deployment.status)) continue;
      open.delete(itemId);
      const step = `deploy:${itemId}`;
      if (deployment.status === 'succeeded') progress.done(step);
      else {
        const name = manifest.applications.find((candidate) => candidate.id === itemId)?.name ?? itemId;
        progress.fail(step, note('deploy_failed', `The deployment of ${name} ${deployment.status}${deployment.errorMessage === null ? '' : `: ${deployment.errorMessage}`}`, { name, error: (deployment.errorMessage ?? deployment.status).slice(0, 300) }));
      }
    }
    onFraction((total - open.size) / total);
    if (open.size > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  for (const itemId of open.keys()) {
    const name = manifest.applications.find((candidate) => candidate.id === itemId)?.name ?? itemId;
    progress.done(`deploy:${itemId}`, { note: note('deploy_pending', `${name} is still deploying; follow it on its page`, { name }) });
  }
}
