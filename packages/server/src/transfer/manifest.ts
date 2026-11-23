/**
 * What an export says about its project: the first entry of every archive.
 *
 * It holds everything a new panel needs to rebuild the project (settings,
 * variables, credentials, keys), and names the data entries that follow it.
 * Secrets travel in the clear here, which is why the archive is always
 * encrypted. An import never trusts it: it is checked against this schema
 * before anything is made from it, and again by the same rules the API
 * applies when a person creates each thing by hand.
 */
import { z } from 'zod';
import {
  bucketNameSchema,
  BUILD_TYPES,
  createVolumeSchema,
  DEPLOY_STRATEGIES,
  ENV_KEY_RE,
  HOSTNAME_RE,
  LIMITS,
  SERVICE_DATABASE_RE,
  SERVICE_TYPES,
  SOURCE_TYPES,
  STORAGE_PERMISSIONS,
  type TransferInclude,
  type TransferNoteDto,
} from '@ploy/shared';

export const MANIFEST_FORMAT = 'torexploy-project';
export const MANIFEST_VERSION = 1;
export const SUMMARY_PATH = 'summary.json';

/** What a data entry is, in its `meta.kind`. */
export type EntryKind = 'service-dump' | 'service-files' | 'object' | 'volume' | 'compose-volume' | 'source' | 'image' | 'summary';

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const text = (max: number) => z.string().max(max);
const name = z.string().trim().min(1).max(LIMITS.nameMax);
const port = z.int().min(1).max(65_535);

const variable = z.object({ key: z.string().min(1).max(256).regex(ENV_KEY_RE), value: z.string().max(LIMITS.envValueMax) });
const variables = z.array(variable).max(LIMITS.envVarsMax);

const domain = z.object({
  host: z.string().max(253).regex(HOSTNAME_RE),
  path: z.string().max(255).regex(/^\/[^\s]*$/).default('/'),
  stripPath: z.boolean().default(false),
  https: z.boolean(),
  port: port.nullable(),
  serviceName: z.string().max(63).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/).nullable().default(null),
  redirectTo: z.string().max(2_048).regex(/^https?:\/\/[^\s]+$/).nullable().default(null),
});
export type ManifestDomain = z.infer<typeof domain>;

/**
 * Credentials reach containers through environment variables, connection URLs and quoted shell arguments, so an
 * archive may only bring characters that are safe in all three (the same ones a person may choose by hand).
 */
const secretText = z.string().regex(/^[A-Za-z0-9!#%^*()_+=.,:;~@-]{1,256}$/);
const credentials = z.object({
  username: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).nullable(),
  password: secretText,
  database: z.string().regex(SERVICE_DATABASE_RE).nullable(),
  rootPassword: secretText.optional(),
});

const service = z.object({
  id,
  name,
  slug: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/),
  type: z.enum(SERVICE_TYPES),
  version: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  credentials,
  publicPort: port.nullable(),
  cpuLimit: z.number().min(0.01).max(1_024).nullable(),
  memoryLimitMb: z.int().min(1).max(10_000_000).nullable(),
  backup: z.object({ schedule: z.string().max(120).nullable(), retention: z.int().min(1).max(1_000) }),
  /** How its data travels; null when it does not. */
  data: z
    .object({
      kind: z.enum(['dump', 'files', 'objects']),
      /** The dump's file name in the container on restore (`.dump`, `.sql.gz`). */
      extension: z.string().max(32).regex(/^[a-z0-9.]+$/).optional(),
      gzip: z.boolean().optional(),
    })
    .nullable(),
  domains: z.array(domain).max(100).default([]),
  /** It had a generated address (a file store's public endpoint): the import makes one here. */
  generatedDomain: z.boolean().default(false),
  buckets: z.array(z.object({ name: bucketNameSchema, public: z.boolean() })).max(1_000).default([]),
  keys: z
    .array(
      z.object({
        name,
        accessKeyId: z.string().min(3).max(128).regex(/^[A-Za-z0-9]+$/),
        secretAccessKey: z.string().min(8).max(256).regex(/^[A-Za-z0-9+/=_-]+$/),
        buckets: z.array(bucketNameSchema).max(100).nullable(),
        permission: z.enum(STORAGE_PERMISSIONS),
      }),
    )
    .max(LIMITS.storageKeysMax)
    .default([]),
});
export type ManifestService = z.infer<typeof service>;

const settings = z.object({
  sourceType: z.enum(SOURCE_TYPES),
  repository: text(1_024).nullable(),
  gitUrl: text(2_048).nullable(),
  branch: text(255).nullable(),
  image: text(1_024).nullable(),
  buildType: z.enum(BUILD_TYPES),
  dockerfilePath: text(255),
  rootDirectory: text(255),
  installCommand: text(2_000).nullable(),
  buildCommand: text(2_000).nullable(),
  startCommand: text(2_000).nullable(),
  outputDirectory: text(255).nullable(),
  buildStage: text(100).nullable(),
  buildpackBuilder: text(255).nullable(),
  systemPackages: text(2_000).nullable(),
  port: port.nullable(),
  replicas: z.int().min(1).max(LIMITS.replicasMax),
  cpuLimit: z.number().min(0.01).max(1_024).nullable(),
  memoryLimitMb: z.int().min(1).max(10_000_000).nullable(),
  healthCheckPath: text(255).nullable(),
  healthCheckTimeoutSec: z.int().min(1).max(86_400),
  strategy: z.enum(DEPLOY_STRATEGIES),
  autoDeploy: z.boolean(),
  composeFile: text(LIMITS.composeFileMax).nullable(),
  composePath: text(255),
  previewsEnabled: z.boolean(),
  previewLimit: z.int().min(1).max(1_000),
  templateId: text(128).nullable(),
});
export type ManifestSettings = z.infer<typeof settings>;

const application = z.object({
  id,
  name,
  /** Other applications and services reach it by this name on the project's network. */
  slug: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/),
  description: text(LIMITS.descriptionMax).nullable(),
  kind: z.enum(['web', 'worker', 'compose']),
  settings,
  hostAccess: z.boolean(),
  previewEnv: text(LIMITS.previewEnvMax).nullable(),
  deployKey: z.object({ privateKey: text(16_384), publicKey: text(4_096) }).nullable(),
  /** The account or connection the repository was reached through on the old panel (shown, and matched by kind). */
  repositoryAccount: text(255).nullable(),
  gitProvider: z.object({ kind: z.enum(['gitlab', 'bitbucket']), baseUrl: text(2_048), workspace: text(255).nullable() }).nullable(),
  /** The commit that ran. */
  commit: z.string().max(64).regex(/^[0-9a-f]*$/).nullable(),
  variables,
  variablesText: text(LIMITS.envTextMax).nullable(),
  volumes: z
    .array(
      z.object({
        id,
        name: createVolumeSchema.shape.name,
        mountPath: createVolumeSchema.shape.mountPath,
        backupSchedule: z.string().max(120).nullable(),
        backupRetention: z.int().min(1).max(1_000),
        backupPause: z.boolean(),
        /** Its files are in the archive. */
        data: z.boolean(),
      }),
    )
    .max(100),
  /** A compose stack's named volumes whose files are in the archive. */
  composeVolumes: z.array(z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)).max(100).default([]),
  domains: z.array(domain).max(200),
  /** It had a generated address: the import makes one under this panel's domain. */
  generatedDomain: z.boolean().default(false),
  links: z.array(z.object({ serviceId: id, prefix: z.string().max(32).regex(/^(?:[A-Z][A-Z0-9_]{0,30}_)?$/) })).max(100),
  cron: z
    .array(
      z.object({
        name,
        schedule: z.string().min(1).max(120),
        command: z.string().min(1).max(2_000),
        enabled: z.boolean(),
        timeoutSec: z.int().min(10).max(86_400),
      }),
    )
    .max(100),
  /** Its code is in the archive: the deployed commit, or the uploaded archive. */
  source: z.object({ name: text(255), size: z.int().min(0), files: z.int().min(0), bytes: z.int().min(0), origin: z.enum(['commit', 'upload']) }).nullable(),
  /** Its built image is in the archive, under this tag. */
  image: z.object({ tag: text(512) }).nullable(),
});
export type ManifestApplication = z.infer<typeof application>;

const note = z.object({ code: z.string().max(64), params: z.record(z.string(), z.union([z.string().max(2_000), z.number()])).optional(), message: z.string().max(4_000) });

export const manifestSchema = z.object({
  format: z.literal(MANIFEST_FORMAT),
  version: z.literal(MANIFEST_VERSION),
  createdAt: z.string().max(64),
  panel: z.object({ version: z.string().max(64), origin: z.string().max(2_048).nullable() }),
  include: z.object({ databases: z.boolean(), volumes: z.boolean(), storage: z.boolean(), source: z.boolean(), images: z.boolean() }),
  project: z.object({ id, name, description: text(LIMITS.descriptionMax).nullable(), variables, variablesText: text(LIMITS.envTextMax).nullable() }),
  services: z.array(service).max(500),
  applications: z.array(application).max(500),
  registries: z.array(z.object({ name, serverAddress: z.string().min(1).max(255), username: z.string().min(1).max(255), password: z.string().min(1).max(4_096) })).max(50),
  warnings: z.array(note).max(1_000),
});
export type Manifest = z.infer<typeof manifestSchema>;

export interface ManifestSummary {
  finishedAt: string;
  entries: number;
  bytes: number;
  warnings: TransferNoteDto[];
}

/** Check an archive's manifest; anything off is a damaged or foreign archive, not a crash. */
export function parseManifest(value: unknown): Manifest {
  const result = manifestSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined ? '' : ` (${issue.path.join('.')}: ${issue.message})`;
    throw Object.assign(new Error(`The archive's manifest is not one this panel can read${where}`), { issue });
  }
  // Every reference must point inside the archive.
  const services = new Set(result.data.services.map((item) => item.id));
  for (const app of result.data.applications) {
    for (const link of app.links) if (!services.has(link.serviceId)) throw new Error(`The archive's manifest links ${app.name} to a service it does not have`);
  }
  return result.data;
}

export function emptyInclude(): TransferInclude {
  return { databases: false, volumes: false, storage: false, source: false, images: false };
}

/** Entry paths, one place for both sides. */
export const ENTRY = {
  serviceDump: (serviceId: string) => `services/${serviceId}/dump`,
  serviceFiles: (serviceId: string) => `services/${serviceId}/files.tar.gz`,
  object: (serviceId: string, bucket: string, key: string) => `storage/${serviceId}/${bucket}/${key}`,
  volume: (applicationId: string, volumeId: string) => `applications/${applicationId}/volumes/${volumeId}.tar.gz`,
  composeVolume: (applicationId: string, name: string) => `applications/${applicationId}/compose-volumes/${name}.tar.gz`,
  source: (applicationId: string) => `applications/${applicationId}/source.zip`,
  image: (applicationId: string) => `applications/${applicationId}/image.tar.gz`,
};
