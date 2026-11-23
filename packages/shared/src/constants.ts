/**
 * Vocabulary shared by the control plane and the dashboard.
 *
 * Every status, role and kind lives here exactly once. The database CHECK
 * constraints, the API validation and the UI badges are all derived from these
 * arrays, so adding a value is a one-line change that the type checker then
 * propagates everywhere it matters.
 */

/**
 * Interface languages, in the order they are offered. Uzbek comes in three alphabets: the Latin one the interface
 * is written in (`uz`), the 2021 Latin alphabet (`uz-new`) and Cyrillic (`uz-cyrl`), both derived from it.
 */
export const LOCALES = ['uz-new', 'uz', 'uz-cyrl', 'kaa', 'ru', 'en', 'ky', 'tg', 'kk', 'tk'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'uz';

export interface LocaleInfo {
  /** The language as its speakers write it. */
  name: string;
  /** Which alphabet, where a language is offered in more than one. */
  variant: string | null;
  /** The language's English name: search, and a hint for anyone who reads neither alphabet. */
  english: string;
  /** BCP 47 tag: `<html lang>`, spell checking, screen readers, Intl where it knows the language. */
  tag: string;
  script: 'Latn' | 'Cyrl';
}

export const LOCALE_INFO: Record<Locale, LocaleInfo> = {
  'uz-new': { name: 'Ōzbekça', variant: 'yangi lotin', english: 'Uzbek (new Latin)', tag: 'uz-Latn', script: 'Latn' },
  uz: { name: 'Oʻzbekcha', variant: 'lotin', english: 'Uzbek (Latin)', tag: 'uz-Latn', script: 'Latn' },
  'uz-cyrl': { name: 'Ўзбекча', variant: 'кирилл', english: 'Uzbek (Cyrillic)', tag: 'uz-Cyrl', script: 'Cyrl' },
  kaa: { name: 'Qaraqalpaqsha', variant: null, english: 'Karakalpak', tag: 'kaa', script: 'Latn' },
  ru: { name: 'Русский', variant: null, english: 'Russian', tag: 'ru', script: 'Cyrl' },
  en: { name: 'English', variant: null, english: 'English', tag: 'en', script: 'Latn' },
  ky: { name: 'Кыргызча', variant: null, english: 'Kyrgyz', tag: 'ky', script: 'Cyrl' },
  tg: { name: 'Тоҷикӣ', variant: null, english: 'Tajik', tag: 'tg', script: 'Cyrl' },
  kk: { name: 'Қазақша', variant: null, english: 'Kazakh', tag: 'kk', script: 'Cyrl' },
  tk: { name: 'Türkmençe', variant: null, english: 'Turkmen', tag: 'tk', script: 'Latn' },
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** A stored or requested language this build may not know (an older or newer panel wrote it): the default then. */
export function localeOr(value: unknown, fallback: Locale = DEFAULT_LOCALE): Locale {
  return isLocale(value) ? value : fallback;
}

/**
 * The language a browser asks for, when the interface has it. `uz-Cyrl` means Uzbek in Cyrillic; English is never
 * chosen for someone (many people here run English systems without wanting an English panel).
 */
export function localeFromBrowser(languages: readonly string[]): Locale {
  for (const raw of languages) {
    const tag = raw.toLowerCase();
    if (tag.startsWith('uz')) return tag.includes('cyrl') ? 'uz-cyrl' : 'uz';
    const base = tag.split('-')[0];
    if (base === 'ru' || base === 'kaa' || base === 'ky' || base === 'tg' || base === 'kk' || base === 'tk') return base;
  }
  return DEFAULT_LOCALE;
}

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

/** Kinds created from the "new application" flow; `compose` apps have their own. */
export const APP_KINDS = ['web', 'worker'] as const;
export type AppKind = (typeof APP_KINDS)[number] | 'compose';

/**
 * `raw`: a compose file kept in the panel instead of a repository.
 * `upload`: a folder or zip archive uploaded from the browser (or with the API), Netlify Drop style.
 */
export const SOURCE_TYPES = ['github', 'gitlab', 'bitbucket', 'git', 'image', 'raw', 'upload'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * How a repository becomes an image.
 * - `torex`: TorexBuilder — the stack is detected and an optimized Dockerfile is generated.
 * - `dockerfile`: the repository's own Dockerfile.
 * - `nixpacks`, `railpack`: Railway's builders, run as CLIs on the control plane.
 * - `heroku`, `paketo`: Cloud Native Buildpacks through `pack` with that vendor's builder.
 * - `static`: files served by Caddy, optionally after a build step.
 */
export const BUILD_TYPES = ['torex', 'dockerfile', 'nixpacks', 'railpack', 'heroku', 'paketo', 'static'] as const;
export type BuildType = (typeof BUILD_TYPES)[number];
export const DEFAULT_BUILD_TYPE: BuildType = 'torex';

/** Builders that need a CLI on the control plane (reported in `BootstrapDto.features.builders`). */
export const EXTERNAL_BUILD_TYPES: readonly BuildType[] = ['nixpacks', 'railpack', 'heroku', 'paketo'];

/** Debian/Ubuntu package names, as `apt-get install` accepts them. */
export const APT_PACKAGE_RE = /^[a-z0-9][a-z0-9+.-]{0,99}$/;

/** Steps of a self-update, in order: get the new build, make the image, swap the container, see it answer. */
export const UPDATE_STAGES = ['fetch', 'build', 'replace', 'health', 'done'] as const;
export type UpdateStage = (typeof UPDATE_STAGES)[number];

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

/** Deployments still in flight: what the `active` list filter matches. */
export const ACTIVE_DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = ['queued', 'building', 'deploying'];

/** Values the deployment list accepts as `?status=`: a status, or `active` for any in-flight one. */
export const DEPLOYMENT_STATUS_FILTERS = [...DEPLOYMENT_STATUSES, 'active'] as const;
export type DeploymentStatusFilter = (typeof DEPLOYMENT_STATUS_FILTERS)[number];

/** `upload`: a new archive was uploaded for an upload-source application. */
export const DEPLOYMENT_TRIGGERS = ['manual', 'push', 'rollback', 'redeploy', 'api', 'restart', 'upload'] as const;
export type DeploymentTrigger = (typeof DEPLOYMENT_TRIGGERS)[number];

/** `files` is the file store (S3-compatible object storage, SeaweedFS); the rest are databases and queues. */
export const SERVICE_TYPES = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis', 'rabbitmq', 'minio', 'clickhouse', 'files'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SERVICE_STATUSES = ['provisioning', 'running', 'stopped', 'failed', 'restarting'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

/** What an access key of the file store may do with its buckets. */
export const STORAGE_PERMISSIONS = ['read', 'readwrite'] as const;
export type StoragePermission = (typeof STORAGE_PERMISSIONS)[number];

/** S3 bucket names: 3–63 lowercase letters, digits, dots and dashes, starting and ending alphanumeric. */
export const BUCKET_RE = /^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$/;
/** Object keys: slash-separated path segments without `..` or control characters. */
export const OBJECT_KEY_RE = /^(?!.*(?:^|\/)\.\.(?:\/|$))[^\x00-\x1f\x7f]{1,1024}$/;

export const DNS_STATUSES = ['pending', 'ok', 'mismatch', 'error'] as const;
export type DnsStatus = (typeof DNS_STATUSES)[number];

export const TLS_STATUSES = ['pending', 'active', 'error', 'disabled'] as const;
export type TlsStatus = (typeof TLS_STATUSES)[number];

export const BACKUP_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

export const CRON_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type CronRunStatus = (typeof CRON_RUN_STATUSES)[number];

export const TEMPLATE_CATEGORIES = ['automation', 'monitoring', 'analytics', 'cms', 'productivity', 'business', 'communication', 'developer', 'database', 'ai', 'media', 'storage', 'security', 'tools'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const NOTIFICATION_KINDS = ['telegram', 'discord', 'slack', 'webhook'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Events a notification channel can subscribe to. */
export const NOTIFICATION_EVENTS = ['deployment.failed', 'deployment.succeeded', 'application.crashed', 'backup.failed', 'server.offline'] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

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

/** Git hosts connected with an access token (GitHub connects through its App instead). */
export const GIT_PROVIDER_KINDS = ['gitlab', 'bitbucket'] as const;
export type GitProviderKind = (typeof GIT_PROVIDER_KINDS)[number];

/** A GitLab project path: a namespace (groups and subgroups) and the project, `group/sub/project`. */
export const GITLAB_PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}){1,20}$/;

/** A Bitbucket repository, `workspace/repo-slug`. */
export const BITBUCKET_REPO_RE = /^[A-Za-z0-9_.-]{1,62}\/[A-Za-z0-9_.-]{1,100}$/;

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

/** Ways a signed-in session can prove its owner again without the password ("step-up"). */
export const STEP_UP_METHODS = ['github', 'passkey'] as const;
export type StepUpMethod = (typeof STEP_UP_METHODS)[number];

/** Where the dashboard returns to after confirming with GitHub: the thing the owner set out to do. */
export const STEP_UP_PURPOSES = ['password', 'passkey', '2fa'] as const;
export type StepUpPurpose = (typeof STEP_UP_PURPOSES)[number];

/**
 * Wildcard DNS services: `<anything>.<ip-with-dashes>.sslip.io` resolves to
 * that IP, so a server has a working hostname without owning a domain. They
 * are not on the Public Suffix List, which means every user of the service
 * shares one Let's Encrypt quota (50 certificates a week for all of
 * sslip.io); certificates for these names come from ZeroSSL first.
 */
export const WILDCARD_DNS_SUFFIXES = ['sslip.io', 'nip.io'] as const;

/** Whether `host` is a name under one of the wildcard DNS services. */
export function isWildcardDnsHost(host: string): boolean {
  const name = host.toLowerCase();
  return WILDCARD_DNS_SUFFIXES.some((suffix) => name.endsWith(`.${suffix}`));
}

/** The hostname a wildcard DNS service gives an IPv4 address: `203.0.113.7` → `203-0-113-7.sslip.io`. Null for anything else. */
export function wildcardDnsHost(ip: string | null | undefined): string | null {
  if (ip == null || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
  const parts = ip.split('.').map(Number);
  if (parts.some((part) => part > 255)) return null;
  const [a, b] = parts as [number, number, number, number];
  // Addresses nobody outside can reach would give a name that only looks public.
  if (a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return null;
  return `${parts.join('-')}.${WILDCARD_DNS_SUFFIXES[0]}`;
}

export const LIMITS = {
  nameMax: 64,
  descriptionMax: 500,
  envVarsMax: 500,
  envValueMax: 32_768,
  /** A set of variables kept as `.env` text (with its comments); a longer text is not kept, only its variables. */
  envTextMax: 400_000,
  domainsPerApp: 50,
  replicasMax: 20,
  cpuMax: 64,
  memoryMbMin: 32,
  memoryMbMax: 262_144,
  passwordMin: 8,
  passwordMax: 256,
  /** Passkeys one account may register: a phone, a laptop, a password manager, a couple of security keys. */
  passkeysMax: 10,
  passkeyNameMax: 60,
  /** A pasted SSH private key (the largest common ones, 4096-bit RSA, are ~3.3 KB). */
  sshKeyMax: 16_384,
  composeFileMax: 256 * 1024,
  /** Pull request previews one application may run at once. */
  previewsMax: 20,
  /** Preview variables, as `.env` text. */
  previewEnvMax: 32 * 1024,
  systemPackagesMax: 50,
  storageKeysMax: 50,
  storageUploadMax: 5 * 1024 * 1024 * 1024,
  /** An uploaded source archive (zip), as sent. */
  uploadMax: 512 * 1024 * 1024,
  /** What that archive may unpack to, and how many files it may hold. */
  uploadUnpackedMax: 2 * 1024 * 1024 * 1024,
  uploadFilesMax: 50_000,
  /** The name an upload is shown under (the zip file's or the folder's). */
  uploadNameMax: 200,
} as const;

// ---------------------------------------------------------------------------
// Container registries
// ---------------------------------------------------------------------------

/** Docker Hub, as image references and registry records name it. */
export const DOCKER_HUB = 'docker.io';

/** Other spellings of Docker Hub that turn up in docs and old CLI configs. */
const DOCKER_HUB_ALIASES = ['index.docker.io', 'registry-1.docker.io', 'registry.hub.docker.com', 'hub.docker.com'];

/** A registry host with an optional port: `ghcr.io`, `localhost:5000`, `10.0.0.5:5000`. */
export const REGISTRY_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[0-9]{1,5})?$/;

/**
 * A registry address as Docker names it: lowercase, without a scheme, a
 * trailing slash or an API path (`https://index.docker.io/v1/`), and with
 * every Docker Hub alias folded into `docker.io`.
 */
export function normalizeRegistryAddress(value: string): string {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .replace(/\/v[12]$/, '');
  return DOCKER_HUB_ALIASES.includes(host) ? DOCKER_HUB : host;
}

/**
 * The registry an image reference pulls from, by Docker's own rule: the first
 * path component is a registry host only when it contains `.` or `:`, is
 * `localhost`, or has uppercase letters. Everything else (`nginx`,
 * `bitnami/redis`) lives on Docker Hub.
 */
export function imageRegistryHost(image: string): string {
  const slash = image.indexOf('/');
  if (slash === -1) return DOCKER_HUB;
  const first = image.slice(0, slash);
  if (!/[.:]/.test(first) && first !== 'localhost' && first === first.toLowerCase()) return DOCKER_HUB;
  return normalizeRegistryAddress(first);
}
