/**
 * Row mappers.
 *
 * SQLite has no boolean or JSON type, so rows carry 0/1 integers and JSON
 * strings. Conversion happens exactly once, here, so the rest of the platform
 * only ever sees domain types.
 */
import type { Row } from '../db/database.ts';
import type {
  Application,
  AppSourceType,
  AuditEntry,
  BuildType,
  CertStatus,
  Deployment,
  DeploymentStatus,
  DeploymentTrigger,
  Domain,
  DomainStatus,
  EnvScope,
  EnvVar,
  Job,
  JobStatus,
  Locale,
  Project,
  RepoProvider,
  Server,
  ServerMode,
  ServerStatus,
  Service,
  ServiceCredentials,
  ServiceStatus,
  ServiceType,
  Team,
  TeamMember,
  TeamRole,
  Theme,
  User,
} from './types.ts';

export function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

/** Parse a JSON text column, tolerating malformed data rather than crashing a request. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed === null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function mapUser(row: Row): User {
  return {
    id: str(row.id),
    email: str(row.email),
    name: str(row.name),
    locale: str(row.locale) as Locale,
    theme: str(row.theme) as Theme,
    isPlatformAdmin: toBool(row.is_platform_admin),
    lastLoginAt: strOrNull(row.last_login_at),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function mapTeam(row: Row): Team {
  return {
    id: str(row.id),
    name: str(row.name),
    slug: str(row.slug),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function mapTeamMember(row: Row): TeamMember {
  return {
    id: str(row.id),
    teamId: str(row.team_id),
    userId: str(row.user_id),
    role: str(row.role) as TeamRole,
    createdAt: str(row.created_at),
  };
}

export function mapServer(row: Row): Server {
  return {
    id: str(row.id),
    teamId: str(row.team_id),
    name: str(row.name),
    mode: str(row.mode) as ServerMode,
    host: strOrNull(row.host),
    status: str(row.status) as ServerStatus,
    dockerVersion: strOrNull(row.docker_version),
    lastSeenAt: strOrNull(row.last_seen_at),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function mapProject(row: Row): Project {
  return {
    id: str(row.id),
    teamId: str(row.team_id),
    name: str(row.name),
    slug: str(row.slug),
    description: strOrNull(row.description),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function mapApplication(row: Row): Application {
  return {
    id: str(row.id),
    projectId: str(row.project_id),
    serverId: str(row.server_id),
    name: str(row.name),
    slug: str(row.slug),
    sourceType: str(row.source_type) as AppSourceType,
    repoUrl: strOrNull(row.repo_url),
    repoBranch: str(row.repo_branch),
    repoProvider: str(row.repo_provider) as RepoProvider,
    buildType: str(row.build_type) as BuildType,
    dockerfilePath: str(row.dockerfile_path),
    buildContext: str(row.build_context),
    buildArgs: parseJson<Record<string, string>>(row.build_args, {}),
    installCommand: strOrNull(row.install_command),
    buildCommand: strOrNull(row.build_command),
    startCommand: strOrNull(row.start_command),
    outputDir: strOrNull(row.output_dir),
    internalPort: strOrNull(row.internal_port),
    replicas: int(row.replicas, 1),
    cpuLimit: numOrNull(row.cpu_limit),
    memoryLimitMb: numOrNull(row.memory_limit_mb),
    healthCheckPath: strOrNull(row.health_check_path),
    autoDeploy: toBool(row.auto_deploy),
    status: str(row.status) as Application['status'],
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

/**
 * Map an env var row. The stored `value` is encrypted; the caller passes the
 * decrypted plaintext in via `decryptedValue` so this module stays free of
 * key material.
 */
export function mapEnvVar(row: Row, decryptedValue: string): EnvVar {
  return {
    id: str(row.id),
    applicationId: strOrNull(row.application_id),
    projectId: strOrNull(row.project_id),
    key: str(row.key),
    value: decryptedValue,
    isSecret: toBool(row.is_secret),
    scope: str(row.scope) as EnvScope,
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function mapDomain(row: Row): Domain {
  return {
    id: str(row.id),
    applicationId: str(row.application_id),
    host: str(row.host),
    pathPrefix: str(row.path_prefix),
    port: numOrNull(row.port),
    https: toBool(row.https),
    isPrimary: toBool(row.is_primary),
    status: str(row.status) as DomainStatus,
    certStatus: str(row.cert_status) as CertStatus,
    errorMessage: strOrNull(row.error_message),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function mapService(row: Row, credentials: ServiceCredentials): Service {
  return {
    id: str(row.id),
    projectId: str(row.project_id),
    serverId: str(row.server_id),
    name: str(row.name),
    slug: str(row.slug),
    type: str(row.type) as ServiceType,
    version: str(row.version),
    status: str(row.status) as ServiceStatus,
    internalPort: int(row.internal_port),
    credentials,
    volumeName: strOrNull(row.volume_name),
    cpuLimit: numOrNull(row.cpu_limit),
    memoryLimitMb: numOrNull(row.memory_limit_mb),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function mapDeployment(row: Row): Deployment {
  return {
    id: str(row.id),
    applicationId: str(row.application_id),
    serverId: str(row.server_id),
    status: str(row.status) as DeploymentStatus,
    trigger: str(row.trigger) as DeploymentTrigger,
    commitSha: strOrNull(row.commit_sha),
    commitMessage: strOrNull(row.commit_message),
    commitAuthor: strOrNull(row.commit_author),
    branch: strOrNull(row.branch),
    imageTag: strOrNull(row.image_tag),
    containerIds: parseJson<string[]>(row.container_ids, []),
    logPath: strOrNull(row.log_path),
    errorMessage: strOrNull(row.error_message),
    rollbackOf: strOrNull(row.rollback_of),
    startedAt: str(row.started_at),
    finishedAt: strOrNull(row.finished_at),
    durationMs: numOrNull(row.duration_ms),
    createdBy: strOrNull(row.created_by),
  };
}

export function mapJob(row: Row): Job {
  return {
    id: str(row.id),
    kind: str(row.kind),
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    status: str(row.status) as JobStatus,
    priority: int(row.priority, 100),
    attempts: int(row.attempts),
    maxAttempts: int(row.max_attempts, 3),
    runAt: str(row.run_at),
    startedAt: strOrNull(row.started_at),
    finishedAt: strOrNull(row.finished_at),
    lastError: strOrNull(row.last_error),
    workerId: strOrNull(row.worker_id),
    createdAt: str(row.created_at),
  };
}

export function mapAuditEntry(row: Row): AuditEntry {
  return {
    id: str(row.id),
    teamId: strOrNull(row.team_id),
    userId: strOrNull(row.user_id),
    action: str(row.action),
    resource: str(row.resource),
    resourceId: strOrNull(row.resource_id),
    ip: strOrNull(row.ip),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: str(row.created_at),
  };
}
