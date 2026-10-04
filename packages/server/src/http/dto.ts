/**
 * Records → API DTOs. Nothing secret crosses this boundary: keys, tokens,
 * credentials and sealed values are either omitted or exposed only through
 * dedicated, audited "reveal" endpoints.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  imageRegistryHost,
  type ApiTokenDto,
  type ApplicationDto,
  type AuditEntryDto,
  type BackupDto,
  type CronJobDto,
  type CronRunDto,
  type DeploymentDto,
  type DeploymentSummaryDto,
  type DomainDto,
  type InvitationDto,
  type LinkDto,
  type MemberDto,
  type PreviewDto,
  type ProjectDto,
  type RegistryDto,
  type ServerDto,
  type ServiceDto,
  type SourceDto,
  type TeamCronJobDto,
  type TeamDeploymentDto,
  type TeamDto,
  type UserDto,
  type VolumeDto,
} from '@ploy/shared';
import type { Context } from '../context.ts';
import { publicBaseUrl } from '../github/app.ts';
import { catalogEntry, linkEnv } from '../services/catalog.ts';
import type {
  ApiTokenRecord,
  ApplicationRecord,
  AuditRecord,
  BackupRecord,
  CronJobRecord,
  CronRunRecord,
  DeploymentRecord,
  DomainRecord,
  InvitationRecord,
  LinkRecord,
  MemberRecord,
  MembershipRecord,
  ProjectRecord,
  ProjectWithStats,
  RegistryRecord,
  ServerRecord,
  ServiceRecord,
  TeamCronJobRecord,
  UserRecord,
  VolumeRecord,
} from '../store/index.ts';

export function userDto(user: UserRecord, githubLogin: string | null): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    locale: user.locale,
    theme: user.theme,
    isInstanceAdmin: user.isInstanceAdmin,
    twoFactorEnabled: user.totpEnabled,
    hasPassword: user.passwordHash !== null,
    githubLogin,
    createdAt: user.createdAt,
  };
}

export function teamDto(membership: MembershipRecord): TeamDto {
  return {
    id: membership.team.id,
    name: membership.team.name,
    slug: membership.team.slug,
    role: membership.role,
    memberCount: membership.memberCount,
    createdAt: membership.team.createdAt,
  };
}

export function memberDto(member: MemberRecord): MemberDto {
  return { ...member };
}

export function invitationDto(invitation: InvitationRecord, link?: string): InvitationDto {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    invitedBy: invitation.invitedByName,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
    ...(link === undefined ? {} : { link }),
  };
}

export function tokenDto(record: ApiTokenRecord, token?: string): ApiTokenDto {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    ...(token === undefined ? {} : { token }),
  };
}

export function auditDto(record: AuditRecord): AuditEntryDto {
  return {
    id: record.id,
    actor: record.userId === null ? null : { id: record.userId, name: record.userName ?? 'Deleted user' },
    action: record.action,
    targetType: record.targetType,
    targetId: record.targetId,
    targetName: record.targetName,
    ip: record.ip,
    metadata: record.metadata,
    createdAt: record.createdAt,
  };
}

export function serverDto(ctx: Context, server: ServerRecord): ServerDto {
  const usage = ctx.stores.servers.usage(server.id);
  return {
    id: server.id,
    name: server.name,
    kind: server.kind,
    host: server.host,
    port: server.port,
    username: server.username,
    status: server.status,
    statusMessage: server.statusMessage,
    statusReason: server.statusReason,
    publicIp: server.publicIp,
    publicKey: server.sshPublicKey,
    hostKeyFingerprint: server.hostKeyFingerprint,
    docker:
      server.dockerInfo === null
        ? null
        : { version: server.dockerInfo.version, os: server.dockerInfo.os, arch: server.dockerInfo.arch, cpus: server.dockerInfo.cpus, memoryBytes: server.dockerInfo.memoryBytes },
    proxy: server.proxyInfo === null ? null : { running: server.proxyInfo.running, version: server.proxyInfo.version },
    applicationCount: usage.applications,
    serviceCount: usage.services,
    lastSeenAt: server.lastSeenAt,
    createdAt: server.createdAt,
  };
}

export function projectDto(project: ProjectWithStats): ProjectDto {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    applicationCount: project.applicationCount,
    serviceCount: project.serviceCount,
    statusSummary: {
      running: project.running,
      failed: project.failed,
      building: project.building,
      total: project.applicationCount + project.serviceCount,
    },
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function sourceDto(app: ApplicationRecord): SourceDto {
  if (app.sourceType === 'github') {
    return { type: 'github', installationId: app.githubInstallationId ?? 0, repository: app.repository ?? '', branch: app.branch ?? 'main' };
  }
  if (app.sourceType === 'git') return { type: 'git', url: app.gitUrl ?? '', branch: app.branch ?? 'main' };
  if (app.sourceType === 'raw') return { type: 'raw' };
  return { type: 'image', image: app.image ?? '' };
}

export function deploymentSummary(deployment: DeploymentRecord): DeploymentSummaryDto {
  return {
    id: deployment.id,
    status: deployment.status,
    trigger: deployment.trigger,
    commitSha: deployment.commitSha,
    commitMessage: deployment.commitMessage,
    createdAt: deployment.createdAt,
    finishedAt: deployment.finishedAt,
  };
}

export function deploymentDto(deployment: DeploymentRecord, app: ApplicationRecord | undefined): DeploymentDto {
  const isActive = app?.activeDeploymentId === deployment.id;
  return {
    ...deploymentSummary(deployment),
    applicationId: deployment.applicationId,
    projectId: deployment.projectId,
    commitAuthor: deployment.commitAuthor,
    branch: deployment.branch,
    imageTag: deployment.imageTag,
    isActive,
    errorMessage: deployment.errorMessage,
    errorCode: deployment.errorCode,
    sourceDeploymentId: deployment.sourceDeploymentId,
    createdBy: deployment.createdBy === null ? null : { id: deployment.createdBy, name: deployment.createdByName ?? 'Deleted user' },
    startedAt: deployment.startedAt,
    buildDurationMs: deployment.buildDurationMs,
    durationMs: deployment.durationMs,
    canRollback: deployment.status === 'succeeded' && deployment.imageTag !== null && !deployment.imageRemoved,
  };
}

/** Deployments from across a team, each with its application and project (looked up once per list). */
export function teamDeploymentDtos(ctx: Context, deployments: DeploymentRecord[]): TeamDeploymentDto[] {
  const apps = new Map<string, ApplicationRecord | undefined>();
  const projects = new Map<string, ProjectRecord | undefined>();
  return deployments.map((deployment) => {
    if (!apps.has(deployment.applicationId)) apps.set(deployment.applicationId, ctx.stores.applications.get(deployment.applicationId));
    if (!projects.has(deployment.projectId)) projects.set(deployment.projectId, ctx.stores.projects.get(deployment.projectId));
    const app = apps.get(deployment.applicationId);
    return {
      ...deploymentDto(deployment, app),
      applicationName: app?.name ?? '—',
      applicationKind: app?.kind ?? 'web',
      projectName: projects.get(deployment.projectId)?.name ?? '—',
    };
  });
}

export function applicationDto(ctx: Context, app: ApplicationRecord): ApplicationDto {
  const { stores } = ctx;
  const active = app.activeDeploymentId === null ? undefined : stores.deployments.get(app.activeDeploymentId);
  const latest = stores.deployments.latestForApplication(app.id);
  const base = publicBaseUrl(ctx);
  const hookToken = app.deployHookToken === null ? null : ctx.secrets.open(app.deployHookToken, 'hook');
  return {
    id: app.id,
    projectId: app.projectId,
    serverId: app.serverId,
    serverName: stores.servers.get(app.serverId)?.name ?? '—',
    name: app.name,
    slug: app.slug,
    description: app.description,
    kind: app.kind,
    status: app.status,
    source: sourceDto(app),
    sourceType: app.sourceType,
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
    url: stores.domains.primaryUrl(app.id),
    // Containers join the project network under the app's slug (see the deployer).
    internalUrl: app.kind === 'web' && active?.port != null ? `http://${app.slug}:${active.port}` : null,
    templateId: app.templateId,
    composePath: app.kind === 'compose' && app.sourceType !== 'raw' ? app.composePath : null,
    hostAccess: app.hostAccess,
    activeDeployment: active === undefined ? null : deploymentSummary(active),
    latestDeployment: latest === undefined ? null : deploymentSummary(latest),
    pendingChanges: active !== undefined && app.configUpdatedAt > (active.startedAt ?? active.createdAt),
    deployHookUrl: base === null || hookToken === null ? null : `${base}/api/hooks/deploy/${app.id}/${hookToken}`,
    previewsEnabled: app.previewsEnabled,
    previewLimit: app.previewLimit,
    parentApplicationId: app.parentApplicationId,
    pullRequest:
      app.previewPrNumber === null ? null : { number: app.previewPrNumber, title: app.previewPrTitle ?? '', url: app.previewPrUrl ?? '', author: app.previewPrAuthor },
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  };
}

/** A pull request preview, as its parent application lists it. */
export function previewDto(ctx: Context, preview: ApplicationRecord): PreviewDto {
  const latest = ctx.stores.deployments.latestForApplication(preview.id);
  return {
    id: preview.id,
    number: preview.previewPrNumber ?? 0,
    title: preview.previewPrTitle ?? '',
    url: preview.previewPrUrl ?? '',
    author: preview.previewPrAuthor,
    branch: preview.branch ?? '',
    status: preview.status,
    appUrl: ctx.stores.domains.primaryUrl(preview.id),
    latestDeployment: latest === undefined ? null : deploymentSummary(latest),
    createdAt: preview.createdAt,
    updatedAt: preview.updatedAt,
  };
}

export function domainDto(ctx: Context, domain: DomainRecord): DomainDto {
  const app = ctx.stores.applications.get(domain.applicationId);
  const server = app === undefined ? undefined : ctx.stores.servers.get(app.serverId);
  return {
    id: domain.id,
    applicationId: domain.applicationId,
    host: domain.host,
    path: domain.path,
    stripPath: domain.stripPath,
    https: domain.https,
    port: domain.port,
    serviceName: domain.serviceName,
    redirectTo: domain.redirectTo,
    isGenerated: domain.isGenerated,
    dns: { status: domain.dnsStatus, records: domain.dnsRecords, expected: server?.publicIp ?? null, checkedAt: domain.dnsCheckedAt },
    tls: { status: domain.tlsStatus, issuer: domain.tlsIssuer, expiresAt: domain.tlsExpiresAt, message: domain.tlsMessage },
    createdAt: domain.createdAt,
  };
}

export function volumeDto(volume: VolumeRecord): VolumeDto {
  return { id: volume.id, applicationId: volume.applicationId, name: volume.name, mountPath: volume.mountPath, createdAt: volume.createdAt };
}

export function linkDto(ctx: Context, link: LinkRecord): LinkDto | null {
  const service = ctx.stores.services.get(link.serviceId);
  if (service === undefined) return null;
  const entry = catalogEntry(service.type);
  return {
    id: link.id,
    applicationId: link.applicationId,
    serviceId: service.id,
    serviceName: service.name,
    serviceType: service.type,
    prefix: link.prefix,
    keys: Object.keys(linkEnv(entry, service.credentials, service.slug, service.internalPort, link.prefix)),
    createdAt: link.createdAt,
  };
}

export function cronRunDto(run: CronRunRecord): CronRunDto {
  return { ...run };
}

export function cronJobDto(ctx: Context, job: CronJobRecord): CronJobDto {
  const last = ctx.stores.cron.lastRun(job.id);
  return {
    id: job.id,
    applicationId: job.applicationId,
    name: job.name,
    schedule: job.schedule,
    command: job.command,
    enabled: job.enabled,
    timeoutSec: job.timeoutSec,
    nextRunAt: job.enabled ? job.nextRunAt : null,
    lastRun: last === undefined ? null : cronRunDto(last),
    createdAt: job.createdAt,
  };
}

export function teamCronJobDto(ctx: Context, job: TeamCronJobRecord): TeamCronJobDto {
  return {
    ...cronJobDto(ctx, job),
    applicationName: job.applicationName,
    projectId: job.projectId,
    projectName: job.projectName,
    serverName: job.serverName ?? '—',
  };
}

/** The password never leaves the server. `teamApps` lets a list share one lookup of the team's applications. */
export function registryDto(ctx: Context, registry: RegistryRecord, teamApps: ApplicationRecord[] = ctx.stores.applications.listForTeam(registry.teamId)): RegistryDto {
  return {
    id: registry.id,
    name: registry.name,
    serverAddress: registry.serverAddress,
    username: registry.username,
    applications: teamApps
      .filter((app) => app.sourceType === 'image' && app.image !== null && imageRegistryHost(app.image) === registry.serverAddress)
      .map((app) => ({ id: app.id, name: app.name })),
    createdAt: registry.createdAt,
    updatedAt: registry.updatedAt,
  };
}

export function serviceDto(ctx: Context, service: ServiceRecord): ServiceDto {
  const linked = ctx.stores.links
    .listForService(service.id)
    .map((link) => ctx.stores.applications.get(link.applicationId))
    // Previews share their parent's databases; the parent stands for them.
    .filter((app): app is ApplicationRecord => app !== undefined && app.parentApplicationId === null)
    .map((app) => ({ id: app.id, name: app.name }));
  return {
    id: service.id,
    projectId: service.projectId,
    serverId: service.serverId,
    serverName: ctx.stores.servers.get(service.serverId)?.name ?? '—',
    name: service.name,
    slug: service.slug,
    type: service.type,
    version: service.version,
    status: service.status,
    statusMessage: service.statusMessage,
    statusReason: service.statusReason,
    internalHost: service.slug,
    internalPort: service.internalPort,
    publicPort: service.publicPort,
    cpuLimit: service.cpuLimit,
    memoryLimitMb: service.memoryLimitMb,
    backupSchedule: service.backupSchedule,
    backupRetention: service.backupRetention,
    backupDestinationId: service.backupDestinationId,
    linkedApplications: linked,
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
  };
}

export function backupDto(ctx: Context, backup: BackupRecord): BackupDto {
  const destination = backup.remoteDestinationId === null ? undefined : ctx.stores.s3.get(backup.remoteDestinationId);
  return {
    id: backup.id,
    serviceId: backup.serviceId,
    status: backup.status,
    trigger: backup.trigger,
    sizeBytes: backup.sizeBytes,
    errorMessage: backup.errorMessage,
    startedAt: backup.startedAt,
    finishedAt: backup.finishedAt,
    remote: backup.remoteDestinationId === null || backup.remoteKey === null ? null : { destinationId: backup.remoteDestinationId, destinationName: destination?.name ?? null, key: backup.remoteKey },
    onServer: backup.filePath !== null && existsSync(join(ctx.config.dataDir, 'backups', backup.serviceId, backup.filePath)),
  };
}
