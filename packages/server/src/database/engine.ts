/**
 * What the console needs from a database engine, independent of the wire
 * protocol: run a statement for a person, read catalog rows for itself, and
 * the browse, edit and monitor operations built on those.
 */
import type { Duplex } from 'node:stream';
import type {
  DbActivityDto,
  DbChangesInput,
  DbChangesResultDto,
  DbColumnMetaDto,
  DbConsoleType,
  DbFilter,
  DbNoticeDto,
  DbObjectKind,
  DbObjectSourceDto,
  DbOverviewDto,
  DbRoleDto,
  DbRowsDto,
  DbRowsInput,
  DbTableDto,
  DbTransactionState,
  DbTreeDto,
  SqlDialect,
} from '@ploy/shared';

export interface Limits {
  maxRows: number;
  maxCellBytes: number;
  maxBytes: number;
}

/** One result of a statement (a MySQL CALL can give several). */
export interface Outcome {
  command: string;
  columns: (DbColumnMetaDto & { oid?: number })[] | null;
  rows: (string | null)[][];
  rowCount: number | null;
  truncated: boolean;
  clipped: [number, number][];
  notices: DbNoticeDto[];
  insertId: string | null;
}

/** An engine error with what the console shows next to the statement. */
export class StatementError extends Error {
  readonly code: string | null;
  readonly detail: string | null;
  readonly hint: string | null;
  /** Offset inside the statement. */
  readonly offset: number | null;
  readonly notices: DbNoticeDto[];
  readonly fatal: boolean;

  constructor(message: string, options: { code?: string | null; detail?: string | null; hint?: string | null; offset?: number | null; notices?: DbNoticeDto[]; fatal?: boolean } = {}) {
    super(message);
    this.name = 'StatementError';
    this.code = options.code ?? null;
    this.detail = options.detail ?? null;
    this.hint = options.hint ?? null;
    this.offset = options.offset ?? null;
    this.notices = options.notices ?? [];
    this.fatal = options.fatal ?? false;
  }
}

export type Row = Record<string, string | null>;

export interface EngineConnection {
  readonly dialect: SqlDialect;
  readonly alive: boolean;
  readonly transaction: DbTransactionState;
  /** Backend process (PostgreSQL) or thread (MySQL) id, as the activity list shows it. */
  readonly backendId: string;
  /** The database the connection works in. */
  database: string;
  /** Run a statement typed by a person. Throws StatementError. */
  execute(sql: string, limits: Limits, onOverflow?: () => void): Promise<Outcome[]>;
  /** Catalog rows by column name. Parameters are $1… in PostgreSQL and ? in MySQL. */
  rows(sql: string, params?: (string | null)[]): Promise<Row[]>;
  /** Stream rows in batches. */
  each(sql: string, params: (string | null)[], batch: number, onBatch: (columns: string[], rows: (string | null)[][]) => Promise<void>): Promise<number>;
  setReadOnly(on: boolean): Promise<void>;
  /** Switch database without reconnecting, where the engine can (MySQL). */
  useDatabase(name: string): Promise<boolean>;
  close(): Promise<void>;
  destroy(): void;
}

export interface Credentials {
  user: string;
  password: string;
}

/** Everything engine-specific. */
export interface Engine {
  readonly type: DbConsoleType;
  readonly dialect: SqlDialect;
  connect(stream: Duplex, credentials: Credentials, database: string): Promise<EngineConnection>;
  /** Stop what `victim` is running, over a fresh stream from `open`. */
  cancel(victim: EngineConnection, open: () => Promise<Duplex>, credentials: Credentials): Promise<void>;
  /** PostgreSQL databases are separate connections; MySQL ones are not. */
  readonly connectionPerDatabase: boolean;
  overview(conn: EngineConnection, primaryDatabase: string, primaryUser: string): Promise<DbOverviewDto>;
  tree(conn: EngineConnection, database: string): Promise<DbTreeDto>;
  table(conn: EngineConnection, database: string, schema: string | null, name: string): Promise<DbTableDto>;
  source(conn: EngineConnection, database: string, schema: string | null, name: string, kind: DbObjectKind, detail: string | undefined): Promise<DbObjectSourceDto>;
  rows(conn: EngineConnection, input: DbRowsInput, table: DbTableDto): Promise<DbRowsDto>;
  changes(conn: EngineConnection, input: DbChangesInput, table: DbTableDto): Promise<DbChangesResultDto>;
  exportQuery(conn: EngineConnection, view: Pick<DbRowsInput, 'filters' | 'sort' | 'where'>, table: DbTableDto): { sql: string; params: (string | null)[] };
  activity(conn: EngineConnection): Promise<DbActivityDto>;
  signal(conn: EngineConnection, pid: string, action: 'cancel' | 'terminate'): Promise<boolean>;
  roles(conn: EngineConnection, primaryUser: string): Promise<DbRoleDto[]>;
  /** Names and kinds for result columns the engine could only number (PostgreSQL OIDs). */
  describeTypes?(conn: EngineConnection, oids: number[]): Promise<Map<number, { type: string; kind: DbColumnMetaDto['kind'] }>>;
}

export const num = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Values joined with the unit separator by the catalog queries. */
export const list = (value: string | null | undefined): string[] => (value === null || value === undefined || value === '' ? [] : value.split('\u001f'));

/** Escape LIKE wildcards with `!` (an escape character both engines accept in every SQL mode). */
export function likePattern(value: string, op: DbFilter['op']): string {
  const escaped = value.replace(/[!%_]/g, (char) => `!${char}`);
  if (op === 'starts') return `${escaped}%`;
  if (op === 'ends') return `%${escaped}`;
  return `%${escaped}%`;
}

/** Values of an "in" filter: comma or newline separated, at most 200. */
export function inValues(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .slice(0, 200);
}

/** The key a change addresses must name exactly the key columns. */
export function keyFor(change: { key: Record<string, string | null> }, keyColumns: string[]): [string, string | null][] {
  const entries = keyColumns.map((column): [string, string | null] => {
    if (!(column in change.key)) throw new StatementError(`The change does not say which row: ${column} is missing`);
    return [column, change.key[column] ?? null];
  });
  return entries;
}
