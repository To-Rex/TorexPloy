/**
 * Domain types.
 *
 * These mirror the database rows but are the contract used across the platform.
 * Timestamps are ISO-8601 strings; booleans are real booleans (converted from
 * SQLite's 0/1 at the repository boundary) so callers never juggle integers.
 */

export type Locale = 'uz' | 'ru' | 'en';
export type Theme = 'light' | 'dark' | 'system';

export type TeamRole = 'owner' | 'admin' | 'developer' | 'viewer';

/** Higher number = more privilege. Used by {@link roleAtLeast}. */
export const ROLE_LEVEL: Record<TeamRole, number> = {
  viewer: 1,
  developer: 2,
  admin: 3,
  owner: 4,
};

export function roleAtLeast(role: TeamRole, required: TeamRole): boolean {
  return ROLE_LEVEL[role] >= ROLE_LEVEL[required];
}

export interface User {
  id: string;
  email: string;
  name: string;
  locale: Locale;
  theme: Theme;
  isPlatformAdmin: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Team {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMember {
  id: string;
  teamId: string;
  userId: string;
  role: TeamRole;
  createdAt: string;
}

export interface TeamMembership {
  team: Team;
  role: TeamRole;
}

export type ServerMode = 'local' | 'agent';
export type ServerStatus = 'unknown' | 'online' | 'offline' | 'error';

export interface Server {
  id: string;
  teamId: string;
  name: string;
  mode: ServerMode;
  host: string | null;
  status: ServerStatus;
  dockerVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  teamId: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AppSourceType = 'git' | 'image';
export type RepoProvider = 'github' | 'git' | 'local';
export type BuildType = 'dockerfile' | 'nixpacks' | 'static' | 'image';
export type AppStatus = 'idle' | 'building' | 'deploying' | 'running' | 'failed' | 'stopped';

export interface Application {
  id: string;
  projectId: string;
  serverId: string;
  name: string;
  slug: string;
  sourceType: AppSourceType;
  repoUrl: string | null;
  repoBranch: string;
  repoProvider: RepoProvider;
  buildType: BuildType;
  dockerfilePath: string;
  buildContext: string;
  buildArgs: Record<string, string>;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputDir: string | null;
  internalPort: string | null;
  replicas: number;
  cpuLimit: number | null;
  memoryLimitMb: number | null;
  healthCheckPath: string | null;
  autoDeploy: boolean;
  status: AppStatus;
  createdAt: string;
  updatedAt: string;
}

export type EnvScope = 'runtime' | 'build' | 'both';

export interface EnvVar {
  id: string;
  applicationId: string | null;
  projectId: string | null;
  key: string;
  /** Always the decrypted value at the repository boundary. */
  value: string;
  isSecret: boolean;
  scope: EnvScope;
  createdAt: string;
  updatedAt: string;
}

export type DomainStatus = 'pending' | 'active' | 'error';
export type CertStatus = 'pending' | 'issued' | 'error' | 'self_signed' | 'disabled';

export interface Domain {
  id: string;
  applicationId: string;
  host: string;
  pathPrefix: string;
  port: number | null;
  https: boolean;
  isPrimary: boolean;
  status: DomainStatus;
  certStatus: CertStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ServiceType =
  | 'postgres'
  | 'mysql'
  | 'mariadb'
  | 'mongo'
  | 'redis'
  | 'clickhouse'
  | 'rabbitmq'
  | 'minio';

export type ServiceStatus = 'idle' | 'deploying' | 'running' | 'failed' | 'stopped';

export interface ServiceCredentials {
  [key: string]: string;
}

export interface Service {
  id: string;
  projectId: string;
  serverId: string;
  name: string;
  slug: string;
  type: ServiceType;
  version: string;
  status: ServiceStatus;
  internalPort: number;
  credentials: ServiceCredentials;
  volumeName: string | null;
  cpuLimit: number | null;
  memoryLimitMb: number | null;
  createdAt: string;
  updatedAt: string;
}

export type DeploymentStatus =
  | 'queued'
  | 'building'
  | 'deploying'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'rolled_back';

export type DeploymentTrigger = 'manual' | 'webhook' | 'rollback' | 'cli' | 'redeploy';

export interface Deployment {
  id: string;
  applicationId: string;
  serverId: string;
  status: DeploymentStatus;
  trigger: DeploymentTrigger;
  commitSha: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  branch: string | null;
  imageTag: string | null;
  containerIds: string[];
  logPath: string | null;
  errorMessage: string | null;
  rollbackOf: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  createdBy: string | null;
}

/** Terminal states: a deployment in one of these will not change again. */
export const TERMINAL_DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = [
  'success',
  'failed',
  'cancelled',
  'rolled_back',
];

export function isTerminalDeployment(status: DeploymentStatus): boolean {
  return TERMINAL_DEPLOYMENT_STATUSES.includes(status);
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  workerId: string | null;
  createdAt: string;
}

export interface MetricSample {
  scope: 'host' | 'container' | 'application';
  scopeId: string;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  diskBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  recordedAt: string;
}

export interface AuditEntry {
  id: string;
  teamId: string | null;
  userId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** The authenticated principal for a request, whether session or API token. */
export interface Principal {
  kind: 'session' | 'api_token';
  userId: string;
  /** Present for API tokens, which are bound to one team. */
  tokenId?: string;
  /** Team the request is acting within. */
  teamId: string | null;
  role: TeamRole | null;
  /** API token scopes; sessions implicitly hold `*`. */
  scopes: string[];
  isPlatformAdmin: boolean;
}