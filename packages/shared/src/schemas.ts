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
  BUILD_TYPES,
  DEPLOY_STRATEGIES,
  ENV_KEY_RE,
  HOSTNAME_RE,
  IMAGE_RE,
  LIMITS,
  LOCALES,
  MOUNT_PATH_RE,
  REPO_FULL_NAME_RE,
  SERVICE_TYPES,
  TEAM_ROLES,
  THEMES,
} from './constants.ts';

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

export const buildSettingsSchema = z.object({
  buildType: z.enum(BUILD_TYPES),
  dockerfilePath: relativePathSchema.min(1),
  rootDirectory: relativePathSchema,
  installCommand: optionalCommand,
  buildCommand: optionalCommand,
  startCommand: optionalCommand,
  outputDirectory: relativePathSchema.nullable().optional(),
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

export const updateApplicationSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.nullable(),
    source: sourceSchema,
  })
  .extend(buildSettingsSchema.shape)
  .extend(runtimeSettingsSchema.shape)
  .partial();
export type UpdateApplicationInput = z.infer<typeof updateApplicationSchema>;

export const deployRequestSchema = z.object({
  clearCache: z.boolean().optional(),
});
export type DeployRequestInput = z.infer<typeof deployRequestSchema>;

export const createDomainSchema = z.object({
  host: hostnameSchema,
  https: z.boolean().default(true),
  port: portSchema.nullable().optional(),
});
export type CreateDomainInput = z.input<typeof createDomainSchema>;

export const updateDomainSchema = z.object({
  https: z.boolean().optional(),
  port: portSchema.nullable().optional(),
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

export const createServiceSchema = z.object({
  type: z.enum(SERVICE_TYPES),
  name: nameSchema,
  version: z.string().trim().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
  serverId: z.string().min(1).max(64),
});
export type CreateServiceInput = z.infer<typeof createServiceSchema>;

export const updateServiceSchema = z
  .object({
    name: nameSchema,
    publicPort: portSchema.nullable(),
    cpuLimit: z.number().min(0.05).max(LIMITS.cpuMax).nullable(),
    memoryLimitMb: z.int().min(LIMITS.memoryMbMin).max(LIMITS.memoryMbMax).nullable(),
    backupSchedule: z.string().trim().min(9).max(120).nullable(),
    backupRetention: z.int().min(1).max(365),
  })
  .partial();
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;

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

export const platformSettingsSchema = z
  .object({
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
