/**
 * The database console's wire format: what the browser asks for and what the
 * server answers with when someone browses, queries and edits a PostgreSQL,
 * MySQL or MariaDB service.
 *
 * Values travel as text (or null) exactly as the database printed them, so
 * nothing is lost to JavaScript numbers: a bigint, a numeric(40,20) or a
 * timestamp with microseconds arrives as written. `kind` says how to show it.
 */
import { z } from 'zod';
import type { DbConsoleType } from './sql.ts';

/** How a value is shown and edited. */
export type DbValueKind = 'number' | 'boolean' | 'text' | 'json' | 'date' | 'time' | 'datetime' | 'binary' | 'uuid' | 'array' | 'enum' | 'other';

export interface DbColumnMetaDto {
  name: string;
  /** Type as the engine names it (int4, varchar(255), timestamp with time zone, DECIMAL(10,2) …). */
  type: string;
  kind: DbValueKind;
}

export type DbCell = string | null;

export interface DbNoticeDto {
  severity: string;
  message: string;
}

export interface DbStatementResultDto {
  /** Position of the statement in the script. */
  index: number;
  start: number;
  end: number;
  /** SELECT, INSERT, CREATE TABLE … */
  command: string;
  /** Null for statements that return no rows. */
  columns: DbColumnMetaDto[] | null;
  rows: DbCell[][];
  /** Rows affected (INSERT, UPDATE, DELETE) or returned. */
  rowCount: number | null;
  /** More rows exist than were returned. */
  truncated: boolean;
  /** Cells shortened to keep the response small, as [row, column]. */
  clipped: [number, number][];
  durationMs: number;
  notices: DbNoticeDto[];
  /** MySQL: rows the statement inserted with an AUTO_INCREMENT value. */
  insertId: string | null;
}

export interface DbErrorDto {
  message: string;
  /** SQLSTATE (PostgreSQL) or the error number (MySQL). */
  code: string | null;
  detail: string | null;
  hint: string | null;
  /** Offset in the script the error points at. */
  position: number | null;
  /** Which statement failed. */
  statement: number;
  /** Notices the statement raised before it failed. */
  notices: DbNoticeDto[];
}

export type DbTransactionState = 'idle' | 'open' | 'failed';

export interface DbRunResultDto {
  results: DbStatementResultDto[];
  error: DbErrorDto | null;
  transaction: DbTransactionState;
  durationMs: number;
  /** The run opened a new connection (the previous one had expired or never existed). */
  newSession: boolean;
  /** The run was stopped by a cancel request or the time limit. */
  cancelled: boolean;
  /** The current database after the run (USE in MySQL changes it). */
  database: string;
}

export interface DbDatabaseDto {
  name: string;
  sizeBytes: number | null;
  owner: string | null;
  encoding: string | null;
  collation: string | null;
  tables: number | null;
  connections: number | null;
  /** Engine-owned (mysql, sys, information_schema …); hidden unless asked for. */
  system: boolean;
  /** The database the service was created with. */
  primary: boolean;
}

export interface DbStatDto {
  key: string;
  value: string;
}

export interface DbOverviewDto {
  type: DbConsoleType;
  version: string;
  user: string;
  defaultDatabase: string;
  databases: DbDatabaseDto[];
  /** Started at, ISO; null when the engine does not say. */
  startedAt: string | null;
  maxConnections: number | null;
  settings: DbStatDto[];
}

export type DbObjectKind = 'table' | 'partitioned_table' | 'foreign_table' | 'view' | 'materialized_view' | 'sequence' | 'function' | 'procedure' | 'trigger' | 'event';

export interface DbObjectDto {
  name: string;
  kind: DbObjectKind;
  /** Estimated rows (statistics, not a count). */
  rows: number | null;
  sizeBytes: number | null;
  comment: string | null;
  /** Functions: argument list; triggers: the table. */
  detail: string | null;
}

export interface DbSchemaDto {
  name: string;
  owner: string | null;
  system: boolean;
  objects: DbObjectDto[];
}

export interface DbTreeDto {
  database: string;
  schemas: DbSchemaDto[];
  /** PostgreSQL extensions installed in the database. */
  extensions: { name: string; version: string; schema: string | null }[];
}

export interface DbTableColumnDto {
  name: string;
  type: string;
  kind: DbValueKind;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
  /** Identity, serial or AUTO_INCREMENT: the database fills it in. */
  autoIncrement: boolean;
  generated: boolean;
  comment: string | null;
  /** Allowed values of an ENUM column. */
  options: string[] | null;
  references: { schema: string | null; table: string; column: string } | null;
}

export interface DbIndexDto {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  method: string | null;
  definition: string | null;
  sizeBytes: number | null;
}

export type DbConstraintKind = 'primary_key' | 'foreign_key' | 'unique' | 'check' | 'exclusion' | 'other';

export interface DbConstraintDto {
  name: string;
  kind: DbConstraintKind;
  definition: string;
}

export interface DbTriggerDto {
  name: string;
  timing: string;
  definition: string;
  enabled: boolean;
}

export interface DbTableDto {
  database: string;
  schema: string | null;
  name: string;
  kind: DbObjectKind;
  comment: string | null;
  columns: DbTableColumnDto[];
  /** Columns that identify a row: the primary key, else a unique key with no nullable column. Empty means rows cannot be edited. */
  keyColumns: string[];
  indexes: DbIndexDto[];
  constraints: DbConstraintDto[];
  /** Foreign keys of other tables pointing here. */
  referencedBy: { schema: string | null; table: string; constraint: string; columns: string[] }[];
  triggers: DbTriggerDto[];
  stats: DbStatDto[];
  rowEstimate: number | null;
  sizeBytes: number | null;
  ddl: string;
}

export interface DbObjectSourceDto {
  name: string;
  kind: DbObjectKind;
  ddl: string;
}

export interface DbRowsDto {
  columns: DbColumnMetaDto[];
  rows: DbCell[][];
  clipped: [number, number][];
  /** Rows matching the filter; null when counting took too long. */
  total: number | null;
  /** Statistics-based guess, given when the exact count was skipped. */
  estimate: number | null;
  keyColumns: string[];
  durationMs: number;
}

export interface DbChangesResultDto {
  inserted: number;
  updated: number;
  deleted: number;
}

export interface DbSessionDto {
  pid: string;
  user: string | null;
  database: string | null;
  client: string | null;
  application: string | null;
  state: string | null;
  query: string | null;
  /** Seconds the current query (or state) has lasted. */
  durationSec: number | null;
  wait: string | null;
  startedAt: string | null;
  /** The console's own connection: cancelling it would cut the branch the console sits on. */
  own: boolean;
}

export interface DbActivityDto {
  sessions: DbSessionDto[];
  /** Cumulative counters, sampled now; the browser turns two samples into rates. */
  counters: {
    connections: number;
    active: number;
    idleInTransaction: number;
    commits: number;
    rollbacks: number;
    /** Statements run (MySQL's Questions); PostgreSQL counts transactions instead. */
    queries: number | null;
    rowsRead: number;
    rowsWritten: number;
    cacheHits: number;
    diskReads: number;
    bytesIn: number | null;
    bytesOut: number | null;
  };
  sampledAt: number;
}

export interface DbRoleDto {
  name: string;
  host: string | null;
  superuser: boolean;
  canLogin: boolean;
  createDb: boolean;
  createRole: boolean;
  /** Roles this one is a member of (PostgreSQL) or a short summary of grants (MySQL). */
  memberOf: string[];
  connectionLimit: number | null;
  validUntil: string | null;
  plugin: string | null;
  /** The account the service runs its applications with. */
  primary: boolean;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const identifier = z.string().min(1).max(128);
/** The schema (PostgreSQL) a table lives in; ignored by MySQL, where the database is the schema. */
const schemaName = z.string().max(128).nullable();
const cell = z.string().max(16_000_000).nullable();

/** One console tab's connection, chosen by the browser. */
export const dbSessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const dbRunSchema = z.object({
  database: identifier,
  session: dbSessionIdSchema,
  sql: z.string().min(1).max(2_000_000),
  /** Rows kept per statement. */
  limit: z.int().min(1).max(10_000).default(1_000),
  readOnly: z.boolean().default(false),
  /** Seconds before the server cancels the run. */
  timeoutSec: z.int().min(1).max(3_600).default(300),
});
export type DbRunInput = z.infer<typeof dbRunSchema>;

export const dbSessionSchema = z.object({ session: dbSessionIdSchema });

export const dbTableQuerySchema = z.object({ database: identifier, schema: z.string().max(128).optional(), name: identifier });

export const dbObjectQuerySchema = dbTableQuerySchema.extend({
  kind: z.enum(['table', 'partitioned_table', 'foreign_table', 'view', 'materialized_view', 'sequence', 'function', 'procedure', 'trigger', 'event']),
  detail: z.string().max(4_000).optional(),
});

export const DB_FILTER_OPERATORS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'not_contains', 'starts', 'ends', 'null', 'not_null', 'in', 'empty'] as const;
export type DbFilterOperator = (typeof DB_FILTER_OPERATORS)[number];

export const dbFilterSchema = z.object({ column: identifier, op: z.enum(DB_FILTER_OPERATORS), value: z.string().max(10_000).default('') });
export type DbFilter = z.infer<typeof dbFilterSchema>;

export const dbSortSchema = z.object({ column: identifier, direction: z.enum(['asc', 'desc']) });
export type DbSort = z.infer<typeof dbSortSchema>;

export const dbRowsSchema = z.object({
  database: identifier,
  schema: schemaName,
  table: identifier,
  offset: z.int().min(0).max(1_000_000_000).default(0),
  limit: z.int().min(1).max(1_000).default(100),
  sort: z.array(dbSortSchema).max(5).default([]),
  filters: z.array(dbFilterSchema).max(20).default([]),
  /** A condition written in SQL, ANDed with the filters. */
  where: z.string().max(8_000).default(''),
});
export type DbRowsInput = z.infer<typeof dbRowsSchema>;

const keyValues = z.record(z.string().max(128), cell);

export const dbChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('update'), key: keyValues, values: keyValues }),
  z.object({ kind: z.literal('insert'), values: keyValues }),
  z.object({ kind: z.literal('delete'), key: keyValues }),
]);
export type DbChange = z.infer<typeof dbChangeSchema>;

export const dbChangesSchema = z.object({
  database: identifier,
  schema: schemaName,
  table: identifier,
  changes: z.array(dbChangeSchema).min(1).max(5_000),
});
export type DbChangesInput = z.infer<typeof dbChangesSchema>;

export const dbExportQuerySchema = z.object({
  database: identifier,
  schema: z.string().max(128).optional(),
  table: identifier,
  format: z.enum(['csv', 'json', 'sql']).default('csv'),
  /** JSON-encoded filters, sort and where, as in a rows request. */
  view: z.string().max(40_000).optional(),
});

export const dbActivityActionSchema = z.object({ pid: z.string().regex(/^[0-9]{1,20}$/), action: z.enum(['cancel', 'terminate']) });
