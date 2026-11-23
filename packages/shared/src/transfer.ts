/**
 * Moving a project from one panel to another.
 *
 * An export packs a whole project into one encrypted `.torexploy` archive:
 * its applications with their settings, variables, domains, volumes and cron
 * jobs; its databases and file stores with their data; and the code each
 * application runs (the deployed commit, or the uploaded archive), so the
 * import works even where the repository cannot be reached. Built images can
 * come along too, to start without building.
 *
 * An import unpacks an archive into a panel as a new project. The archive
 * arrives as a file, from another panel by its transfer link, or from S3; it
 * is opened with its passphrase, looked over (which server, what clashes with
 * this panel, where each application's code comes from), and then put in
 * place step by step, with the data restored and everything deployed.
 */
import { z } from 'zod';
import type { AppKind, ServerStatus, ServiceType, SourceType } from './constants.ts';
import { nameSchema } from './schemas.ts';

export const TRANSFER_KINDS = ['export', 'import'] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];

/**
 * - export: `queued` → `running` → `succeeded` | `failed` | `cancelled`
 * - import: `receiving` → `locked` (waits for its passphrase) → `ready` (waits for a plan) → `queued` → `running` → …
 */
export const TRANSFER_STATUSES = ['receiving', 'locked', 'ready', 'queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

/** Where an archive came from: made here (an export), a file, another panel's transfer link, or S3. */
export const TRANSFER_SOURCES = ['export', 'upload', 'link', 's3'] as const;
export type TransferSource = (typeof TRANSFER_SOURCES)[number];

export const TRANSFER_EXTENSION = '.torexploy';

/** A passphrase chosen by hand is at least this long; the panel's own are longer and random. */
export const TRANSFER_PASSPHRASE_MIN = 12;

/** How long a finished export (and its transfer link) stays on the panel, by default. */
export const TRANSFER_KEEP_DAYS = 7;

/** What an export carries besides the project's settings, which always come. */
export interface TransferInclude {
  /** Databases' data: a dump, or a copy of their files where the engine has no dump. */
  databases: boolean;
  /** Applications' volumes. */
  volumes: boolean;
  /** File stores' buckets, objects and access keys. */
  storage: boolean;
  /** Applications' code (the deployed commit, or the uploaded archive): the import can run without the repository. */
  source: boolean;
  /** Applications' built images: the import starts them without building. Large. */
  images: boolean;
}

export const transferIncludeSchema = z.object({
  databases: z.boolean().default(true),
  volumes: z.boolean().default(true),
  storage: z.boolean().default(true),
  source: z.boolean().default(true),
  images: z.boolean().default(false),
});

export const transferPassphraseSchema = z.string().min(TRANSFER_PASSPHRASE_MIN).max(256);

export const createExportSchema = z.object({
  projectId: z.string().min(1).max(64),
  include: transferIncludeSchema.prefault({}),
  /** Left out: the panel makes a strong one and shows it. */
  passphrase: transferPassphraseSchema.optional(),
  /** Also copy the finished archive to this S3 destination. */
  s3DestinationId: z.string().min(1).max(64).nullable().optional(),
});
export type CreateExportInput = z.input<typeof createExportSchema>;

/** An archive another panel offers through its transfer link (`https://…/api/transfers/pull/…#passphrase`), or that link and the passphrase apart. */
export const importLinkSchema = z.object({
  link: z.string().trim().min(10).max(4_096),
  passphrase: transferPassphraseSchema.optional(),
});
export type ImportLinkInput = z.infer<typeof importLinkSchema>;

export const importS3Schema = z.object({
  destinationId: z.string().min(1).max(64),
  key: z.string().min(1).max(1_024),
  passphrase: transferPassphraseSchema.optional(),
});
export type ImportS3Input = z.infer<typeof importS3Schema>;

export const unlockTransferSchema = z.object({ passphrase: z.string().min(1).max(256) });

/** Where an imported application's code comes from. */
export const IMPORT_SOURCE_CHOICES = ['repository', 'archive', 'image'] as const;
export type ImportSourceChoice = (typeof IMPORT_SOURCE_CHOICES)[number];

export const importPlanSchema = z.object({
  serverId: z.string().min(1).max(64),
  projectName: nameSchema,
  /** Per application (its id in the archive): where its code comes from. Left out: the recommended way. */
  sources: z.record(z.string().max(64), z.enum(IMPORT_SOURCE_CHOICES)).default({}),
  /** Put the data back: databases, volumes, files. */
  restoreData: z.boolean().default(true),
  /** Keep the custom domains (ones another application here already serves are left out either way). */
  domains: z.boolean().default(true),
  /** Keep services' public ports (ones already taken on the server are left out either way). */
  publicPorts: z.boolean().default(true),
  /** Deploy the applications once everything is in place. */
  deploy: z.boolean().default(true),
});
export type ImportPlanInput = z.input<typeof importPlanSchema>;
export type ImportPlan = z.infer<typeof importPlanSchema>;

/** Something worth knowing: shown in the person's language from `code` and `params`; `message` is the English. */
export interface TransferNoteDto {
  code: string;
  params?: Record<string, string | number>;
  message: string;
}

export const TRANSFER_STEP_KINDS = ['receive', 'verify', 'prepare', 'project', 'service', 'database', 'storage', 'volume', 'source', 'image', 'application', 'deploy', 'upload'] as const;
export type TransferStepKind = (typeof TRANSFER_STEP_KINDS)[number];

export const TRANSFER_STEP_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'] as const;
export type TransferStepStatus = (typeof TRANSFER_STEP_STATUSES)[number];

export interface TransferStepDto {
  key: string;
  kind: TransferStepKind;
  /** The resource it is about (an application, a database, a volume), when there is one. */
  name: string | null;
  status: TransferStepStatus;
  /** How far it got, in `unit`s, where that can be counted. */
  done: number | null;
  total: number | null;
  unit: 'bytes' | 'items' | null;
  /** Why it was skipped or failed, or what is left to do by hand. */
  note: TransferNoteDto | null;
}

export interface TransferShareStateDto {
  expiresAt: string;
  downloads: number;
  lastDownloadAt: string | null;
}

export interface TransferS3StateDto {
  destinationId: string;
  destinationName: string;
  key: string;
  status: 'uploading' | 'done' | 'failed';
  error: string | null;
}

export interface TransferDto {
  id: string;
  kind: TransferKind;
  status: TransferStatus;
  source: TransferSource;
  /** export: the project packed; import: the project made, once it exists. */
  projectId: string | null;
  projectName: string | null;
  fileName: string;
  /** The archive's size, once it is whole. */
  sizeBytes: number | null;
  /** An import still arriving: how much is here, of how much (when the sender said). */
  receivedBytes: number;
  expectedBytes: number | null;
  include: TransferInclude | null;
  steps: TransferStepDto[];
  /** 0–100, over every step. */
  percent: number;
  warnings: TransferNoteDto[];
  error: TransferNoteDto | null;
  /** An export offered to other panels through its transfer link. */
  share: TransferShareStateDto | null;
  /** An export copied to S3. */
  s3: TransferS3StateDto | null;
  /** The archive can be downloaded (an export that finished, while it is kept). */
  downloadable: boolean;
  /** The archive is removed from the panel then. */
  expiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CreatedExportDto {
  transfer: TransferDto;
  /** Shown once here, and again on request to administrators. */
  passphrase: string;
}

/** The link another panel imports the export from. It carries the passphrase after `#`, which never travels in a request. */
export interface TransferShareDto {
  link: string;
  /** The link without the passphrase, and the passphrase apart. */
  url: string;
  passphrase: string;
  expiresAt: string;
}

export interface TransferPassphraseDto {
  passphrase: string;
}

/** An archive in an S3 destination that can be imported. */
export interface TransferS3ObjectDto {
  key: string;
  size: number;
  lastModified: string | null;
}

export interface ImportApplicationDto {
  /** Its id in the archive (the key of `ImportPlan.sources`). */
  id: string;
  name: string;
  kind: AppKind;
  sourceType: SourceType;
  repository: string | null;
  branch: string | null;
  image: string | null;
  /** The commit it ran on the old panel. */
  commit: string | null;
  /** The ways it can get its code here, the recommended one first. */
  sources: ImportSourceChoice[];
  /** How this panel reaches its repository, when it can: the GitHub account, GitLab or Bitbucket connection. */
  repositoryAccess: { provider: 'github' | 'gitlab' | 'bitbucket' | 'git'; account: string | null } | null;
  /** The archive holds its code, and how big it is. */
  archiveBytes: number | null;
  /** The archive holds its built image. */
  imageBytes: number | null;
  domains: { host: string; path: string; conflict: boolean }[];
  volumes: number;
  variables: number;
  cron: number;
  /** The services it is linked to, by name. */
  links: string[];
  /** Its builder runs on this panel (one that needs a CLI the panel lacks falls back to TorexBuilder). */
  builderAvailable: boolean;
  /** A compose stack that mounts host paths or the Docker socket. */
  hostAccess: boolean;
}

export interface ImportServiceDto {
  id: string;
  name: string;
  type: ServiceType;
  version: string;
  /** What the archive carries of its data: a dump, its files, or its buckets' objects. */
  data: 'dump' | 'files' | 'objects' | null;
  dataBytes: number | null;
  buckets: number;
  keys: number;
  publicPort: number | null;
  /** The public port is taken on the chosen server. */
  portTaken: boolean;
}

export interface ImportAnalysisDto {
  transferId: string;
  /** When and where the archive was made. */
  createdAt: string;
  panelVersion: string;
  origin: string | null;
  include: TransferInclude;
  project: { name: string; description: string | null; variables: number };
  /** The project's name, made unique in this team. */
  suggestedName: string;
  servers: { id: string; name: string; status: ServerStatus; host: string | null }[];
  /** The server the analysis was made for (the clashes depend on it). */
  serverId: string | null;
  applications: ImportApplicationDto[];
  services: ImportServiceDto[];
  /** Registry logins the archive brings for private images; ones this team already has are kept. */
  registries: { serverAddress: string; username: string; exists: boolean }[];
  warnings: TransferNoteDto[];
}

export const transferListQuerySchema = z.object({
  kind: z.enum(TRANSFER_KINDS).optional(),
  projectId: z.string().max(64).optional(),
});
