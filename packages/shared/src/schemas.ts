/**
 * Request schemas.
 *
 * The server validates every request body with these. The dashboard runs the
 * same schemas on its forms, so what the UI accepts and what the API accepts
 * cannot drift apart.
 */
import { z } from 'zod';
import {
  APP_KINDS,
  BRANCH_RE,
  APT_PACKAGE_RE,
  BUCKET_RE,
  OBJECT_KEY_RE,
  STORAGE_PERMISSIONS,
  BUILD_TYPES,
  DEPLOY_STRATEGIES,
  DEPLOYMENT_STATUS_FILTERS,
  ENV_KEY_RE,
  HOSTNAME_RE,
  IMAGE_RE,
  imageRegistryHost,
  LIMITS,
  LOCALES,
  MOUNT_PATH_RE,
  normalizeRegistryAddress,
  NOTIFICATION_EVENTS,
  REGISTRY_HOST_RE,
  REPO_FULL_NAME_RE,
  SERVICE_TYPES,
  TEAM_ROLES,
  THEMES,
} from './constants.ts';
import { parseDotenv } from './dotenv.ts';

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export const nameSchema = z.string().trim().min(1).max(LIMITS.nameMax);
export const descriptionSchema = z.string().trim().max(LIMITS.descriptionMax);
export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const passwordSchema = z.string().min(LIMITS.passwordMin).max(LIMITS.passwordMax);
export const hostnameSchema = z.string().trim().toLowerCase().regex(HOSTNAME_RE);
export const branchSchema = z.string().trim().regex(BRANCH_RE);
export const portSchema = z.int().min(1).max(65_535);

/** Repository-relative directory: no absolute paths, no `..` escapes. */
export const relativePathSchema = z
  .string()
  .trim()
  .max(255)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), { message: 'Path must stay inside the repository' });

/** A shell command typed by the user. Bounded, single line. */
const commandSchema = z.string().trim().max(2_000).refine((value) => !/[\r\n]/.test(value), {
  message: 'Command must be a single line',
});

const optionalCommand = commandSchema.nullable().optional();

// ---------------------------------------------------------------------------
// Auth & account
// ---------------------------------------------------------------------------

export const setupSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  teamName: nameSchema,
  locale: z.enum(LOCALES).optional(),
});
export type SetupInput = z.infer<typeof setupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(LIMITS.passwordMax),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const twoFactorLoginSchema = z.object({
  ticket: z.string().min(16).max(128),
  code: z.string().trim().min(6).max(20),
});
export type TwoFactorLoginInput = z.infer<typeof twoFactorLoginSchema>;

export const updateProfileSchema = z.object({
  name: nameSchema.optional(),
  locale: z.enum(LOCALES).optional(),
  theme: z.enum(THEMES).optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(LIMITS.passwordMax),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const twoFactorCodeSchema = z.object({ code: z.string().trim().min(6).max(20) });
export type TwoFactorCodeInput = z.infer<typeof twoFactorCodeSchema>;

export const twoFactorDisableSchema = z.object({
  /** Empty for accounts that sign in with GitHub only (they have no password to confirm). */
  password: z.string().max(LIMITS.passwordMax),
  code: z.string().trim().min(6).max(20),
});
export type TwoFactorDisableInput = z.infer<typeof twoFactorDisableSchema>;

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export const createTeamSchema = z.object({ name: nameSchema });
export type CreateTeamInput = z.infer<typeof createTeamSchema>;

export const updateTeamSchema = z.object({ name: nameSchema });
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;

export const switchTeamSchema = z.object({ teamId: z.string().min(1).max(64) });

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(TEAM_ROLES),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const acceptInvitationSchema = z.object({
  name: nameSchema.optional(),
  password: passwordSchema.optional(),
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export const updateMemberSchema = z.object({ role: z.enum(TEAM_ROLES) });
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export const createApiTokenSchema = z.object({
  name: nameSchema,
  expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)]).nullable(),
});
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

const sshHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .refine((value) => HOSTNAME_RE.test(value) || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || /^[0-9a-f:]+$/.test(value), {
    message: 'Must be a hostname or an IP address',
  });

export const createServerSchema = z.object({
  name: nameSchema,
  host: sshHostSchema,
  port: portSchema.default(22),
  username: z.string().trim().regex(/^[a-z_][a-z0-9_-]{0,31}$/).default('root'),
});
export type CreateServerInput = z.input<typeof createServerSchema>;

export const updateServerSchema = z.object({
  name: nameSchema.optional(),
  host: sshHostSchema.optional(),
  port: portSchema.optional(),
  username: z.string().trim().regex(/^[a-z_][a-z0-9_-]{0,31}$/).optional(),
});
export type UpdateServerInput = z.infer<typeof updateServerSchema>;

// ---------------------------------------------------------------------------
// Projects & variables
// ---------------------------------------------------------------------------

export const createProjectSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = createProjectSchema.partial();
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const envVarSchema = z.object({
  key: z.string().trim().min(1).max(256).regex(ENV_KEY_RE),
  value: z.string().max(LIMITS.envValueMax),
});

export const putVariablesSchema = z.object({
  variables: z
    .array(envVarSchema)
    .max(LIMITS.envVarsMax)
    .superRefine((list, ctx) => {
      const seen = new Set<string>();
      list.forEach((item, index) => {
        if (seen.has(item.key)) {
          ctx.addIssue({ code: 'custom', message: `Duplicate key ${item.key}`, path: [index, 'key'], params: { reason: 'duplicate' } });
        }
        seen.add(item.key);
      });
    }),
});
export type PutVariablesInput = z.infer<typeof putVariablesSchema>;

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

const gitUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => /^https:\/\/[^\s@]+\/[^\s]+$/.test(value) || /^git@[A-Za-z0-9.-]+:[^\s]+$/.test(value), {
    message: 'Use an https:// or git@host:path URL',
  });

export const sourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('github'),
    installationId: z.int().positive(),
    repository: z.string().trim().regex(REPO_FULL_NAME_RE),
    branch: branchSchema,
  }),
  z.object({
    type: z.literal('git'),
    url: gitUrlSchema,
    branch: branchSchema,
  }),
  z.object({
    type: z.literal('image'),
    image: z.string().trim().max(300).regex(IMAGE_RE),
  }),
]);
export type SourceInput = z.infer<typeof sourceSchema>;

/** A Docker Compose file as text; the server parses and validates its structure. */
export const composeFileSchema = z
  .string()
  .max(LIMITS.composeFileMax)
  .refine((value) => value.trim().length > 0, { message: 'The compose file is empty' });

export const composeSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('github'),
    installationId: z.int().positive(),
    repository: z.string().trim().regex(REPO_FULL_NAME_RE),
    branch: branchSchema,
  }),
  z.object({ type: z.literal('git'), url: gitUrlSchema, branch: branchSchema }),
  z.object({ type: z.literal('raw'), content: composeFileSchema }),
]);
export type ComposeSourceInput = z.infer<typeof composeSourceSchema>;

export const createComposeSchema = z.object({
  name: nameSchema,
  serverId: z.string().min(1).max(64),
  source: composeSourceSchema,
  /** Path of the compose file inside the repository (ignored for a raw file). */
  composePath: relativePathSchema.min(1).default('docker-compose.yml'),
  /** Grant host-reaching features (privileged, host network, absolute binds). Admins only. */
  allowHostAccess: z.boolean().default(false),
});
export type CreateComposeInput = z.input<typeof createComposeSchema>;

export const updateComposeSchema = z
  .object({
    /** Replaces the stored file (raw source only). */
    content: composeFileSchema,
    composePath: relativePathSchema.min(1),
  })
  .partial();
export type UpdateComposeInput = z.infer<typeof updateComposeSchema>;

/** A Docker image reference a builder can use (`heroku/builder:24`, `paketobuildpacks/builder-jammy-base`). */
const builderImageSchema = z.string().trim().max(300).regex(IMAGE_RE);

/** Space- or comma-separated apt package names installed into a TorexBuilder image. */
export const systemPackagesSchema = z
  .string()
  .trim()
  .max(2_000)
  .superRefine((value, ctx) => {
    const names = splitPackages(value);
    if (names.length > LIMITS.systemPackagesMax) ctx.addIssue({ code: 'custom', message: `At most ${LIMITS.systemPackagesMax} packages`, params: { reason: 'too_many' } });
    const bad = names.find((name) => !APT_PACKAGE_RE.test(name));
    if (bad !== undefined) ctx.addIssue({ code: 'custom', message: `"${bad}" is not a package name`, params: { reason: 'bad_package', name: bad } });
  });

/** `systemPackages` text → package names. */
export function splitPackages(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

export const buildSettingsSchema = z.object({
  buildType: z.enum(BUILD_TYPES),
  dockerfilePath: relativePathSchema.min(1),
  rootDirectory: relativePathSchema,
  installCommand: optionalCommand,
  buildCommand: optionalCommand,
  startCommand: optionalCommand,
  outputDirectory: relativePathSchema.nullable().optional(),
  /** Dockerfile builds: the stage to build (`--target`). */
  buildStage: z.string().trim().max(100).regex(/^[A-Za-z0-9_.-]+$/).nullable().optional(),
  /** Buildpack builds: a builder image other than the vendor's default. */
  buildpackBuilder: builderImageSchema.nullable().optional(),
  /** TorexBuilder: extra apt packages for the image (ImageMagick, ffmpeg…). */
  systemPackages: systemPackagesSchema.nullable().optional(),
});

export const runtimeSettingsSchema = z.object({
  kind: z.enum(APP_KINDS),
  port: portSchema.nullable(),
  replicas: z.int().min(1).max(LIMITS.replicasMax),
  cpuLimit: z.number().min(0.05).max(LIMITS.cpuMax).nullable(),
  memoryLimitMb: z.int().min(LIMITS.memoryMbMin).max(LIMITS.memoryMbMax).nullable(),
  healthCheckPath: z
    .string()
    .trim()
    .max(255)
    .regex(/^\/[^\s]*$/)
    .nullable(),
  healthCheckTimeoutSec: z.int().min(5).max(1_800),
  strategy: z.enum(DEPLOY_STRATEGIES),
  autoDeploy: z.boolean(),
});

export const createApplicationSchema = z.object({
  name: nameSchema,
  serverId: z.string().min(1).max(64),
  kind: z.enum(APP_KINDS).default('web'),
  source: sourceSchema,
  build: buildSettingsSchema.partial().optional(),
  port: portSchema.nullable().optional(),
});
export type CreateApplicationInput = z.input<typeof createApplicationSchema>;

/** Variables for pull request previews, as `.env` text (may be empty). */
export const previewEnvSchema = z
  .string()
  .max(LIMITS.previewEnvMax)
  .superRefine((value, ctx) => {
    const { badLine } = parseDotenv(value);
    if (badLine !== null) ctx.addIssue({ code: 'custom', message: `Line ${badLine} is not KEY=value`, params: { reason: 'invalid_line', line: badLine } });
  });

/** Pull request previews of a GitHub web application. */
export const previewSettingsSchema = z.object({
  previewsEnabled: z.boolean(),
  /** Previews that may run at once; further pull requests wait until one closes. */
  previewLimit: z.int().min(1).max(LIMITS.previewsMax),
  /** Applied over the parent's variables in every preview. */
  previewEnv: previewEnvSchema,
});

export const updateApplicationSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.nullable(),
    source: sourceSchema,
  })
  .extend(buildSettingsSchema.shape)
  .extend(runtimeSettingsSchema.shape)
  .extend(previewSettingsSchema.shape)
  .partial();
export type UpdateApplicationInput = z.infer<typeof updateApplicationSchema>;

export const deployRequestSchema = z.object({
  clearCache: z.boolean().optional(),
});
export type DeployRequestInput = z.infer<typeof deployRequestSchema>;

/** A URL path prefix: `/`, `/api`, `/docs/v2` (no trailing slash, no wildcards or queries). */
export const routePathSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^\/(?:[A-Za-z0-9._~%!$&'()+,;=:@-]+(?:\/[A-Za-z0-9._~%!$&'()+,;=:@-]+)*)?$/);

/** Compose service names follow the Compose spec: lowercase letters, digits, `_`, `-`, `.`. */
export const composeServiceSchema = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/);

/** Where a redirect domain sends requests: an origin, without a path. */
export const redirectTargetSchema = z
  .string()
  .trim()
  .max(260)
  .regex(/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i);

export const createDomainSchema = z.object({
  host: hostnameSchema,
  https: z.boolean().default(true),
  port: portSchema.nullable().optional(),
  path: routePathSchema.default('/'),
  stripPath: z.boolean().default(false),
  serviceName: composeServiceSchema.nullable().optional(),
  redirectTo: redirectTargetSchema.nullable().optional(),
});
export type CreateDomainInput = z.input<typeof createDomainSchema>;

export const updateDomainSchema = z.object({
  https: z.boolean().optional(),
  port: portSchema.nullable().optional(),
  stripPath: z.boolean().optional(),
  serviceName: composeServiceSchema.nullable().optional(),
  redirectTo: redirectTargetSchema.nullable().optional(),
});
export type UpdateDomainInput = z.infer<typeof updateDomainSchema>;

export const createVolumeSchema = z.object({
  name: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/),
  mountPath: z
    .string()
    .trim()
    .max(255)
    .regex(MOUNT_PATH_RE)
    .refine((value) => !['/', '/proc', '/sys', '/dev', '/etc', '/bin', '/usr', '/lib'].includes(value.replace(/\/$/, '') || '/'), {
      message: 'This path cannot be used as a mount point',
    }),
});
export type CreateVolumeInput = z.infer<typeof createVolumeSchema>;

export const createCronJobSchema = z.object({
  name: nameSchema,
  schedule: z.string().trim().min(9).max(120),
  command: commandSchema.min(1),
  enabled: z.boolean().default(true),
  timeoutSec: z.int().min(10).max(86_400).default(3_600),
});
export type CreateCronJobInput = z.input<typeof createCronJobSchema>;

export const updateCronJobSchema = z.object({
  name: nameSchema,
  schedule: z.string().trim().min(9).max(120),
  command: commandSchema.min(1),
  enabled: z.boolean(),
  timeoutSec: z.int().min(10).max(86_400),
}).partial();
export type UpdateCronJobInput = z.infer<typeof updateCronJobSchema>;

// ---------------------------------------------------------------------------
// Database services
// ---------------------------------------------------------------------------

/** Identifiers every engine accepts (MySQL caps user names at 32 characters). */
export const SERVICE_USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
export const SERVICE_DATABASE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
/** Passwords travel through environment variables, URLs and quoted shell arguments, so quotes, spaces, `$`, backticks and backslashes stay out. */
export const SERVICE_PASSWORD_RE = /^[A-Za-z0-9!#%^*()_+=.,:;~@-]{8,128}$/;

/** Credentials chosen by hand; anything left out is generated. Fields an engine lacks (a Redis user name) are refused. */
export const serviceCredentialsInputSchema = z
  .object({
    username: z.string().trim().regex(SERVICE_USERNAME_RE),
    password: z.string().regex(SERVICE_PASSWORD_RE),
    database: z.string().trim().regex(SERVICE_DATABASE_RE),
    rootPassword: z.string().regex(SERVICE_PASSWORD_RE),
  })
  .partial();
export type ServiceCredentialsInput = z.infer<typeof serviceCredentialsInputSchema>;

export const createServiceSchema = z.object({
  type: z.enum(SERVICE_TYPES),
  name: nameSchema,
  version: z.string().trim().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
  serverId: z.string().min(1).max(64),
  credentials: serviceCredentialsInputSchema.optional(),
  /** Server port opened to the outside from the start; omitted keeps the service private. */
  publicPort: portSchema.optional(),
  memoryLimitMb: z.int().min(LIMITS.memoryMbMin).max(LIMITS.memoryMbMax).optional(),
});
export type CreateServiceInput = z.infer<typeof createServiceSchema>;

// ---------------------------------------------------------------------------
// File store
// ---------------------------------------------------------------------------

export const bucketNameSchema = z.string().trim().min(3).max(63).regex(BUCKET_RE);
export const objectKeySchema = z.string().regex(OBJECT_KEY_RE);
/** A folder prefix: empty for the root, otherwise segments ending with `/`. */
export const objectPrefixSchema = z.string().max(1024).regex(/^(?:[^\x00-\x1f\x7f/]+\/)*$/);

export const createBucketSchema = z.object({
  name: bucketNameSchema,
  public: z.boolean().default(false),
});
export type CreateBucketInput = z.input<typeof createBucketSchema>;

export const updateBucketSchema = z.object({ public: z.boolean() });

export const listObjectsQuerySchema = z.object({
  prefix: objectPrefixSchema.default(''),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export const deleteObjectsSchema = z.object({
  /** Object keys and/or folder prefixes (ending with `/`, every object below is removed). */
  keys: z.array(z.string().max(1024)).min(1).max(1000),
});

export const createFolderSchema = z.object({ prefix: objectPrefixSchema.min(2) });

/** A temporary link to download (`get`) or upload (`put`) one object without credentials. */
export const presignSchema = z.object({
  key: objectKeySchema,
  method: z.enum(['get', 'put']).default('get'),
  /** Seconds the link stays valid. */
  expiresIn: z.int().min(60).max(7 * 24 * 3600).default(3600),
});

export const createStorageKeySchema = z.object({
  name: nameSchema,
  /** null: every bucket, including ones created later. */
  buckets: z.array(bucketNameSchema).min(1).max(100).nullable().default(null),
  permission: z.enum(STORAGE_PERMISSIONS).default('readwrite'),
});
export type CreateStorageKeyInput = z.input<typeof createStorageKeySchema>;

export const updateServiceSchema = z
  .object({
    name: nameSchema,
    publicPort: portSchema.nullable(),
    cpuLimit: z.number().min(0.05).max(LIMITS.cpuMax).nullable(),
    memoryLimitMb: z.int().min(LIMITS.memoryMbMin).max(LIMITS.memoryMbMax).nullable(),
    backupSchedule: z.string().trim().min(9).max(120).nullable(),
    backupRetention: z.int().min(1).max(365),
    /** S3 destination that receives a copy of every backup; null keeps them on the server only. */
    backupDestinationId: z.string().min(1).max(64).nullable(),
  })
  .partial();
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;

// ---------------------------------------------------------------------------
// S3 backup destinations
// ---------------------------------------------------------------------------

export const createS3DestinationSchema = z.object({
  name: nameSchema,
  endpoint: z.string().trim().max(300).pipe(z.url({ protocol: /^https?$/ })),
  /** `us-east-1`, `eu-central-1`; Cloudflare R2 uses `auto`. */
  region: z.string().trim().min(1).max(64).regex(/^[a-z0-9-]+$/),
  bucket: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  pathPrefix: z.string().trim().max(200).regex(/^[A-Za-z0-9!_.*'()/-]*$/).default(''),
  accessKeyId: z.string().trim().min(1).max(256),
  secretAccessKey: z.string().min(1).max(512),
  forcePathStyle: z.boolean().default(false),
});
export type CreateS3DestinationInput = z.input<typeof createS3DestinationSchema>;

/** Every field optional; an omitted secret keeps the stored one. */
export const updateS3DestinationSchema = createS3DestinationSchema.partial();
export type UpdateS3DestinationInput = z.infer<typeof updateS3DestinationSchema>;

export const installTemplateSchema = z.object({
  templateId: z.string().trim().min(1).max(64),
  name: nameSchema.optional(),
  serverId: z.string().min(1).max(64),
  /** A domain the user already pointed at the server; otherwise one is generated. */
  domain: hostnameSchema.optional(),
});
export type InstallTemplateInput = z.infer<typeof installTemplateSchema>;

// ---------------------------------------------------------------------------
// Container registries
// ---------------------------------------------------------------------------

/**
 * A registry host as Docker names it (`ghcr.io`, `registry.example.uz:5000`).
 * A pasted `https://…/` is stripped and Docker Hub aliases become `docker.io`.
 * Only hosts an image reference can actually name are accepted: a bare word
 * such as `myregistry` would be read by Docker as a Docker Hub namespace.
 */
export const registryAddressSchema = z
  .string()
  .max(300)
  .transform(normalizeRegistryAddress)
  .pipe(
    z
      .string()
      .min(1)
      .max(260)
      .regex(REGISTRY_HOST_RE)
      .refine((host) => imageRegistryHost(`${host}/image`) === host, { message: 'Use a registry host such as ghcr.io or registry.example.uz:5000' }),
  );

export const createRegistrySchema = z.object({
  name: nameSchema,
  serverAddress: registryAddressSchema,
  username: z.string().trim().min(1).max(200),
  /** A password or an access token. */
  password: z.string().min(1).max(4_096),
});
export type CreateRegistryInput = z.input<typeof createRegistrySchema>;

/** Every field optional; an omitted password keeps the stored one. */
export const updateRegistrySchema = createRegistrySchema.partial();
export type UpdateRegistryInput = z.infer<typeof updateRegistrySchema>;

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const httpsUrl = (hosts: RegExp) =>
  z
    .string()
    .trim()
    .max(500)
    .pipe(z.url({ protocol: /^https$/, hostname: hosts }));

export const notificationConfigSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('telegram'),
    /** From @BotFather: `123456789:AA…`. */
    botToken: z.string().trim().regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/),
    /** A user or group id (groups are negative) or a public channel `@name`. */
    chatId: z.string().trim().regex(/^(-?\d{3,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/),
  }),
  z.object({ kind: z.literal('discord'), url: httpsUrl(/^(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)$/) }),
  z.object({ kind: z.literal('slack'), url: httpsUrl(/^hooks\.slack\.com$/) }),
  z.object({
    kind: z.literal('webhook'),
    url: z.string().trim().max(500).pipe(z.url({ protocol: /^https?$/ })),
    /** Optional shared secret: requests carry `X-Ploy-Signature: sha256=<hmac>`. */
    secret: z.string().trim().min(16).max(200).optional(),
  }),
]);
export type NotificationConfigInput = z.infer<typeof notificationConfigSchema>;

export const createNotificationChannelSchema = z.object({
  name: nameSchema,
  locale: z.enum(LOCALES).default('uz'),
  events: z.array(z.enum(NOTIFICATION_EVENTS)).min(1).max(NOTIFICATION_EVENTS.length),
  config: notificationConfigSchema,
});
export type CreateNotificationChannelInput = z.input<typeof createNotificationChannelSchema>;

export const updateNotificationChannelSchema = z
  .object({
    name: nameSchema,
    locale: z.enum(LOCALES),
    events: z.array(z.enum(NOTIFICATION_EVENTS)).min(1).max(NOTIFICATION_EVENTS.length),
    enabled: z.boolean(),
    /** Replaces the whole config; omitted keeps the stored (secret) one. */
    config: notificationConfigSchema,
  })
  .partial();
export type UpdateNotificationChannelInput = z.infer<typeof updateNotificationChannelSchema>;

export const createLinkSchema = z.object({
  serviceId: z.string().min(1).max(64),
  prefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^(?:[A-Z][A-Z0-9_]{0,30}_)?$/)
    .default(''),
});
export type CreateLinkInput = z.input<typeof createLinkSchema>;

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/** An IANA time zone the runtime knows (`Asia/Tashkent`, `Europe/Berlin`, `UTC`). */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
export const timezoneSchema = z.string().trim().min(1).max(64).refine(isValidTimeZone, { message: 'Unknown time zone' });

export const platformSettingsSchema = z
  .object({
    timezone: timezoneSchema,
    platformDomain: hostnameSchema.nullable(),
    appsDomain: hostnameSchema.nullable(),
    acmeEmail: emailSchema.nullable(),
    buildConcurrency: z.int().min(1).max(16),
    imageRetention: z.int().min(1).max(50),
    metricsRetentionDays: z.int().min(1).max(90),
    allowGithubSignup: z.boolean(),
  })
  .partial();
export type PlatformSettingsInput = z.infer<typeof platformSettingsSchema>;

export const githubManifestSchema = z.object({
  organization: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/)
    .nullable()
    .optional(),
});
export type GithubManifestInput = z.infer<typeof githubManifestSchema>;

export const paginationSchema = z.object({
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** `GET /api/deployments`: a page of the team's deployments, optionally narrowed by status (empty: all). */
export const deploymentListQuerySchema = paginationSchema.extend({
  status: z.preprocess((value) => (value === '' ? undefined : value), z.enum(DEPLOYMENT_STATUS_FILTERS).optional()),
});
export type DeploymentListQuery = z.infer<typeof deploymentListQuerySchema>;
