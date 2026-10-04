/**
 * Vocabulary shared by the control plane and the dashboard.
 *
 * Every status, role and kind lives here exactly once. The database CHECK
 * constraints, the API validation and the UI badges are all derived from these
 * arrays, so adding a value is a one-line change that the type checker then
 * propagates everywhere it matters.
 */

export const LOCALES = ['uz', 'ru', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'uz';

export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];

export const TEAM_ROLES = ['viewer', 'developer', 'admin', 'owner'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** Higher = more privilege. Order matches {@link TEAM_ROLES}. */
export function roleRank(role: TeamRole): number {
  return TEAM_ROLES.indexOf(role);
}

export function roleAtLeast(role: TeamRole, required: TeamRole): boolean {
  return roleRank(role) >= roleRank(required);
}

export const SERVER_KINDS = ['local', 'ssh'] as const;
export type ServerKind = (typeof SERVER_KINDS)[number];

export const SERVER_STATUSES = ['pending', 'connecting', 'ready', 'error', 'offline'] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];

export const APP_KINDS = ['web', 'worker'] as const;
export type AppKind = (typeof APP_KINDS)[number];

export const SOURCE_TYPES = ['github', 'git', 'image'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const BUILD_TYPES = ['auto', 'dockerfile', 'static'] as const;
export type BuildType = (typeof BUILD_TYPES)[number];

export const DEPLOY_STRATEGIES = ['rolling', 'recreate'] as const;
export type DeployStrategy = (typeof DEPLOY_STRATEGIES)[number];

export const APP_STATUSES = [
  'idle', // never deployed
  'queued',
  'building',
  'deploying',
  'running',
  'crashed', // active deployment exists but its containers keep exiting
  'failed', // the last deployment failed and there is nothing healthy serving
  'stopped', // stopped by a user
] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

export const DEPLOYMENT_STATUSES = ['queued', 'building', 'deploying', 'succeeded', 'failed', 'cancelled'] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export const TERMINAL_DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = ['succeeded', 'failed', 'cancelled'];
export function isTerminalDeployment(status: DeploymentStatus): boolean {
  return TERMINAL_DEPLOYMENT_STATUSES.includes(status);
}

export const DEPLOYMENT_TRIGGERS = ['manual', 'push', 'rollback', 'redeploy', 'api', 'restart'] as const;
export type DeploymentTrigger = (typeof DEPLOYMENT_TRIGGERS)[number];

export const SERVICE_TYPES = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis', 'rabbitmq', 'minio', 'clickhouse'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SERVICE_STATUSES = ['provisioning', 'running', 'stopped', 'failed', 'restarting'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const DNS_STATUSES = ['pending', 'ok', 'mismatch', 'error'] as const;
export type DnsStatus = (typeof DNS_STATUSES)[number];

export const TLS_STATUSES = ['pending', 'active', 'error', 'disabled'] as const;
export type TlsStatus = (typeof TLS_STATUSES)[number];

export const BACKUP_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

export const CRON_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type CronRunStatus = (typeof CRON_RUN_STATUSES)[number];

export const METRIC_RANGES = ['1h', '6h', '24h', '7d'] as const;
export type MetricRange = (typeof METRIC_RANGES)[number];

/** Range → [window seconds, bucket seconds]. Buckets keep every chart near 120 points. */
export const METRIC_RANGE_WINDOWS: Record<MetricRange, { windowSec: number; bucketSec: number }> = {
  '1h': { windowSec: 3_600, bucketSec: 30 },
  '6h': { windowSec: 6 * 3_600, bucketSec: 180 },
  '24h': { windowSec: 24 * 3_600, bucketSec: 720 },
  '7d': { windowSec: 7 * 24 * 3_600, bucketSec: 5_040 },
};

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

/** DNS-label safe slug: lowercase alphanumerics and single dashes. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Fully qualified hostname (no scheme, no port, no trailing dot). */
export const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** POSIX-portable environment variable name. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `owner/name` as GitHub spells it. */
export const REPO_FULL_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Git ref names we accept for branches (subset of git-check-ref-format, no leading dash). */
export const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]{1,200}(?<!\.lock)(?<![./])$/;

/** Docker image reference, e.g. `nginx:1.27`, `ghcr.io/org/app@sha256:…`. */
export const IMAGE_RE = /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

/** Absolute container path for a volume mount. */
export const MOUNT_PATH_RE = /^\/(?:[A-Za-z0-9._-]+\/?)*$/;

/** Prefix shown before API tokens so leaked ones are recognizable by secret scanners. */
export const API_TOKEN_PREFIX = 'ploy_';

export const LIMITS = {
  nameMax: 64,
  descriptionMax: 500,
  envVarsMax: 500,
  envValueMax: 32_768,
  domainsPerApp: 50,
  replicasMax: 20,
  cpuMax: 64,
  memoryMbMin: 32,
  memoryMbMax: 262_144,
  passwordMin: 10,
  passwordMax: 256,
} as const;
