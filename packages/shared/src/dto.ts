/**
 * Response shapes.
 *
 * These are what the API serializes and what the dashboard renders. They are
 * deliberately not the database rows: secrets are absent or masked, booleans
 * are booleans, and related data the UI always needs is embedded so a page
 * renders from one request.
 */
import type {
  AppKind,
  AppStatus,
  BackupStatus,
  BuildType,
  CronRunStatus,
  DeployStrategy,
  DeploymentStatus,
  DeploymentTrigger,
  DnsStatus,
  Locale,
  NotificationEvent,
  NotificationKind,
  ServerKind,
  ServerStatus,
  ServiceStatus,
  ServiceType,
  SourceType,
  TeamRole,
  TemplateCategory,
  Theme,
  TlsStatus,
} from './constants.ts';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface UserDto {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  locale: Locale;
  theme: Theme;
  isInstanceAdmin: boolean;
  twoFactorEnabled: boolean;
  hasPassword: boolean;
  githubLogin: string | null;
  createdAt: string;
}

export interface TeamDto {
  id: string;
  name: string;
  slug: string;
  role: TeamRole;
  memberCount: number;
  createdAt: string;
}

export interface BootstrapDto {
  version: string;
  setupRequired: boolean;
  user: UserDto | null;
  teams: TeamDto[];
  currentTeamId: string | null;
  features: {
    githubLogin: boolean;
  };
}

export interface LoginResultDto {
  twoFactorRequired: boolean;
  ticket?: string;
}

export interface SessionDto {
  id: string;
  current: boolean;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string;
}

export interface TwoFactorSetupDto {
  secret: string;
  otpauthUrl: string;
}

export interface RecoveryCodesDto {
  recoveryCodes: string[];
}

export interface MemberDto {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: TeamRole;
  joinedAt: string;
}

export interface InvitationDto {
  id: string;
  email: string;
  role: TeamRole;
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
  /** Only present in the response that created the invitation. */
  link?: string;
}

export interface InvitationPreviewDto {
  teamName: string;
  email: string;
  role: TeamRole;
  invitedBy: string | null;
  userExists: boolean;
  expiresAt: string;
}

export interface ApiTokenDto {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  /** Only present in the response that created the token. */
  token?: string;
}

export interface AuditEntryDto {
  id: string;
  actor: { id: string; name: string } | null;
  action: string;
  targetType: string;
  targetId: string | null;
  targetName: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

export interface ServerDto {
  id: string;
  name: string;
  kind: ServerKind;
  host: string | null;
  port: number | null;
  username: string | null;
  status: ServerStatus;
  statusMessage: string | null;
  /** Stable reason code for `statusMessage`, for translation. */
  statusReason: string | null;
  publicIp: string | null;
  /** The key the user must add to `~/.ssh/authorized_keys` (SSH servers only). */
  publicKey: string | null;
  hostKeyFingerprint: string | null;
  docker: { version: string; os: string; arch: string; cpus: number; memoryBytes: number } | null;
  proxy: { running: boolean; version: string | null } | null;
  applicationCount: number;
  serviceCount: number;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface HostMetricPoint {
  t: number;
  cpu: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  load1: number;
}

export interface AppMetricPoint {
  t: number;
  cpu: number;
  mem: number;
  memLimit: number;
  rx: number;
  tx: number;
}

export interface DockerDiskUsageDto {
  images: { count: number; bytes: number; reclaimableBytes: number };
  containers: { count: number; bytes: number };
  volumes: { count: number; bytes: number };
  buildCache: { bytes: number; reclaimableBytes: number };
}

export interface S3DestinationDto {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  pathPrefix: string;
  accessKeyId: string;
  forcePathStyle: boolean;
  /** Services that copy their backups here. */
  services: { id: string; name: string }[];
  createdAt: string;
}

export interface RegistryDto {
  id: string;
  name: string;
  /** Registry host as Docker names it: `ghcr.io`, `registry.gitlab.com`, `docker.io`, `registry.example.uz:5000`. */
  serverAddress: string;
  username: string;
  /** Applications (image source) whose image lives on this registry. */
  applications: { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

/** Result of checking stored credentials against the registry again. */
export interface RegistryTestDto {
  ok: boolean;
  /** The registry's (or Docker's) own message when the check failed. */
  error: string | null;
}

/** Every container on a server, with what owns it. */
export interface ServerContainerDto {
  id: string;
  name: string;
  image: string;
  state: string;
  /** Docker's own summary, e.g. "Up 2 hours". */
  status: string;
  createdAt: string;
  ports: string[];
  owner:
    | { kind: 'application' | 'compose'; id: string; name: string; projectId: string }
    | { kind: 'service'; id: string; name: string; projectId: string }
    | { kind: 'proxy' | 'platform' | 'cron' | 'build' }
    /** Platform-managed, but owned by another team. */
    | { kind: 'other-team' }
    /** Started outside TorexPloy. */
    | { kind: 'external' };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  applicationCount: number;
  serviceCount: number;
  /** Status rollup used by the project card. */
  statusSummary: { running: number; failed: number; building: number; total: number };
  createdAt: string;
  updatedAt: string;
}

export interface EnvVarDto {
  key: string;
  value: string;
}

export interface VariablesDto {
  variables: EnvVarDto[];
  /** Variables injected from linked services; read-only in the editor. */
  inherited: { key: string; source: string }[];
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export type SourceDto =
  | { type: 'github'; installationId: number; repository: string; branch: string }
  | { type: 'git'; url: string; branch: string }
  | { type: 'image'; image: string }
  /** Compose file kept in the panel. */
  | { type: 'raw' };

export interface DeploymentSummaryDto {
  id: string;
  status: DeploymentStatus;
  trigger: DeploymentTrigger;
  commitSha: string | null;
  commitMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ApplicationDto {
  id: string;
  projectId: string;
  serverId: string;
  serverName: string;
  name: string;
  slug: string;
  description: string | null;
  kind: AppKind;
  status: AppStatus;
  source: SourceDto;
  sourceType: SourceType;
  buildType: BuildType;
  dockerfilePath: string;
  rootDirectory: string;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputDirectory: string | null;
  port: number | null;
  replicas: number;
  cpuLimit: number | null;
  memoryLimitMb: number | null;
  healthCheckPath: string | null;
  healthCheckTimeoutSec: number;
  strategy: DeployStrategy;
  autoDeploy: boolean;
  /** Primary public URL, if any domain is attached. */
  url: string | null;
  /** Address other apps in the same project reach this one at (`http://<slug>:<port>`), once it has run. */
  internalUrl: string | null;
  /** The one-click template this app was installed from, if any. */
  templateId: string | null;
  /** Compose apps: the file's path in the repository (null for other kinds). */
  composePath: string | null;
  /** Compose apps: an administrator allowed host-reaching features. */
  hostAccess: boolean;
  activeDeployment: DeploymentSummaryDto | null;
  latestDeployment: DeploymentSummaryDto | null;
  /** Configuration changed since the active deployment started; a redeploy applies it. */
  pendingChanges: boolean;
  deployHookUrl: string | null;
  /** Pull request previews (GitHub web apps): whether pull requests get one, and how many may run at once. */
  previewsEnabled: boolean;
  previewLimit: number;
  /** Set on a preview: the application it previews. */
  parentApplicationId: string | null;
  /** Set on a preview: the pull request it deploys. */
  pullRequest: { number: number; title: string; url: string; author: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/applications/:id/preview-settings`. */
export interface PreviewSettingsDto {
  enabled: boolean;
  limit: number;
  /** Variables applied over the parent's in every preview, as `.env` text. */
  env: string;
  /** GitHub is connected and can reach this panel's webhook URL. */
  webhookReady: boolean;
}

/** One pull request preview of an application. `id` is the preview application's own id. */
export interface PreviewDto {
  id: string;
  number: number;
  title: string;
  /** The pull request on GitHub. */
  url: string;
  author: string | null;
  /** The pull request's head branch, which the preview deploys. */
  branch: string;
  status: AppStatus;
  /** Where the preview is served, when it has an address. */
  appUrl: string | null;
  latestDeployment: DeploymentSummaryDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentDto extends DeploymentSummaryDto {
  applicationId: string;
  projectId: string;
  commitAuthor: string | null;
  branch: string | null;
  imageTag: string | null;
  isActive: boolean;
  errorMessage: string | null;
  /** Stable reason code for `errorMessage`, for translation. */
  errorCode: string | null;
  sourceDeploymentId: string | null;
  createdBy: { id: string; name: string } | null;
  startedAt: string | null;
  buildDurationMs: number | null;
  durationMs: number | null;
  /** True when this deployment's image still exists and it can be rolled back to. */
  canRollback: boolean;
}

/** A deployment in a team-wide list, with the application and project it belongs to. */
export interface TeamDeploymentDto extends DeploymentDto {
  applicationName: string;
  applicationKind: AppKind;
  projectName: string;
}

export interface NotificationChannelDto {
  id: string;
  name: string;
  kind: NotificationKind;
  locale: Locale;
  events: NotificationEvent[];
  enabled: boolean;
  /** Where messages go, with secrets elided (`chat -1001…890`, `hooks.slack.com/…/x7Kq`). */
  target: string;
  lastStatus: 'ok' | 'failed' | null;
  lastError: string | null;
  lastSentAt: string | null;
  createdAt: string;
}

/** How a person gets into a freshly installed template. */
export type TemplateAccess =
  /** The first visit creates the owner account (optionally at `path`). */
  | { kind: 'setup'; path?: string }
  /** Credentials were generated at install time; they live in the app's variables. */
  | { kind: 'login'; user: string | { key: string }; passwordKey: string }
  /** The image seeds a fixed first account that must be changed right away. */
  | { kind: 'default'; user: string; password: string }
  /** An API key, stored in the app's variables. */
  | { kind: 'key'; key: string }
  /** A database client: sign in with a database's own credentials. */
  | { kind: 'database' }
  /** No sign-in at all. */
  | { kind: 'open' };

export interface TemplateDto {
  id: string;
  name: string;
  category: TemplateCategory;
  website: string;
  image: string;
  port: number;
  /** Databases created and linked alongside the app. */
  services: ServiceType[];
  volumes: number;
  needsUrl: boolean;
  memoryMb: number;
  access: TemplateAccess;
}

export interface ComposeDto {
  /** The file: stored (raw source) or as last fetched from the repository; null before the first deploy. */
  content: string | null;
  /** Path in the repository; null for a stored file. */
  path: string | null;
  services: string[];
  hostAccess: boolean;
  /** Host-reaching features the current file uses (`service: feature`). */
  hostAccessNeeded: string[];
}

/** One running replica of an application's active deployment, as Docker reports it. */
export interface ContainerDto {
  replica: number;
  name: string;
  /** Compose service the container belongs to; null for ordinary apps. */
  service: string | null;
  /** Docker state (`running`, `restarting`, `exited`, …), or `missing` when the container is gone. */
  state: string;
  /** Docker health check result when the image defines one. */
  health: string | null;
  startedAt: string | null;
  restartCount: number;
  exitCode: number | null;
  oomKilled: boolean;
}

export interface DomainDto {
  id: string;
  applicationId: string;
  host: string;
  /** Path prefix ('/' for the whole host). */
  path: string;
  stripPath: boolean;
  https: boolean;
  port: number | null;
  /** Compose service receiving the traffic. */
  serviceName: string | null;
  /** Redirect-only domain target origin. */
  redirectTo: string | null;
  isGenerated: boolean;
  dns: { status: DnsStatus; records: string[]; expected: string | null; checkedAt: string | null };
  tls: { status: TlsStatus; issuer: string | null; expiresAt: string | null; message: string | null };
  createdAt: string;
}

export interface VolumeDto {
  id: string;
  applicationId: string;
  name: string;
  mountPath: string;
  createdAt: string;
}

export interface LinkDto {
  id: string;
  applicationId: string;
  serviceId: string;
  serviceName: string;
  serviceType: ServiceType;
  prefix: string;
  /** Variable names this link injects. */
  keys: string[];
  createdAt: string;
}

export interface CronJobDto {
  id: string;
  applicationId: string;
  name: string;
  schedule: string;
  command: string;
  enabled: boolean;
  timeoutSec: number;
  nextRunAt: string | null;
  lastRun: CronRunDto | null;
  createdAt: string;
}

export interface CronRunDto {
  id: string;
  cronJobId: string;
  status: CronRunStatus;
  exitCode: number | null;
  trigger: 'schedule' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

/** A scheduled job in the team-wide list, with where it runs. */
export interface TeamCronJobDto extends CronJobDto {
  applicationName: string;
  projectId: string;
  projectName: string;
  serverName: string;
}

// ---------------------------------------------------------------------------
// Database services
// ---------------------------------------------------------------------------

export interface ServiceCatalogEntryDto {
  type: ServiceType;
  label: string;
  versions: string[];
  defaultVersion: string;
  port: number;
  supportsBackup: boolean;
}

export interface ServiceDto {
  id: string;
  projectId: string;
  serverId: string;
  serverName: string;
  name: string;
  slug: string;
  type: ServiceType;
  version: string;
  status: ServiceStatus;
  statusMessage: string | null;
  statusReason: string | null;
  internalHost: string;
  internalPort: number;
  publicPort: number | null;
  cpuLimit: number | null;
  memoryLimitMb: number | null;
  backupSchedule: string | null;
  backupRetention: number;
  backupDestinationId: string | null;
  linkedApplications: { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface ServiceCredentialsDto {
  username: string | null;
  password: string;
  database: string | null;
  internalUrl: string;
  publicUrl: string | null;
  /** Variables a linked application receives (unprefixed). */
  env: Record<string, string>;
}

export interface BackupDto {
  id: string;
  serviceId: string;
  status: BackupStatus;
  trigger: 'manual' | 'schedule';
  sizeBytes: number | null;
  errorMessage: string | null;
  /** The copy off the server, when one was uploaded. */
  remote: { destinationId: string; destinationName: string | null; key: string } | null;
  /** Whether the file is still on the server (false: only the S3 copy is left). */
  onServer: boolean;
  startedAt: string;
  finishedAt: string | null;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export interface GithubStatusDto {
  configured: boolean;
  app: { id: number; slug: string; name: string; htmlUrl: string; owner: string } | null;
  installations: GithubInstallationDto[];
  /** Base URL GitHub must be able to reach for webhooks; null until configured. */
  webhookUrl: string | null;
  publicUrlReady: boolean;
}

export interface GithubInstallationDto {
  id: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  avatarUrl: string | null;
  repositorySelection: 'all' | 'selected';
  createdAt: string;
}

export interface GithubRepositoryDto {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  updatedAt: string | null;
  language: string | null;
}

export interface GithubManifestDto {
  /** Form action the browser must POST `manifest` to. */
  action: string;
  manifest: string;
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export interface PlatformSettingsDto {
  platformDomain: string | null;
  appsDomain: string | null;
  acmeEmail: string | null;
  buildConcurrency: number;
  imageRetention: number;
  metricsRetentionDays: number;
  allowGithubSignup: boolean;
  publicUrl: string | null;
  publicIp: string | null;
}

export interface OverviewDto {
  projects: number;
  applications: { total: number; running: number; failed: number; building: number };
  services: { total: number; running: number };
  servers: { total: number; ready: number };
  recentDeployments: TeamDeploymentDto[];
}

export interface HealthDto {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSec: number;
  checks: Record<string, { ok: boolean; detail?: string }>;
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

/** One route the proxy on a server serves. */
export interface ProxyRouteDto {
  host: string;
  path: string;
  stripPath: boolean;
  https: boolean;
  /** `container:port` addresses; empty while nothing healthy is serving. */
  upstreams: string[];
  /** Redirect-only route: where requests are sent. */
  redirectTo: string | null;
  /** The application (or the panel) the route belongs to. */
  label: string;
}

/** What the proxy on a server is doing, with the exact configuration it was given. */
export interface ProxyOverviewDto {
  running: boolean;
  version: string | null;
  /** The configuration below is the one the proxy has loaded. */
  inSync: boolean;
  routes: ProxyRouteDto[];
  /** Caddy's JSON configuration, generated from the database (read-only). */
  config: string;
}
