/**
 * MySQL and MariaDB for the console. The text protocol has no bound
 * parameters, so values are written as literals escaped for the session's
 * SQL mode (the server reports NO_BACKSLASH_ESCAPES in every reply), with
 * hex literals for binary columns.
 */
import type { Duplex } from 'node:stream';
import {
  lineOffset,
  quoteIdent,
  type DbColumnMetaDto,
  type DbConsoleType,
  type DbConstraintDto,
  type DbIndexDto,
  type DbObjectDto,
  type DbObjectKind,
  type DbRoleDto,
  type DbRowsInput,
  type DbTableColumnDto,
  type DbTableDto,
  type DbValueKind,
} from '@ploy/shared';
import { inValues, keyFor, likePattern, list, num, StatementError, type Engine, type EngineConnection, type Limits, type Outcome, type Row } from './engine.ts';
import { MysqlConnection, MysqlError, mysqlIsBinary, mysqlTypeName, type MysqlColumn } from './mysql.ts';

const q = (name: string): string => quoteIdent(name, 'mysql');
const table = (database: string, name: string): string => `${q(database)}.${q(name)}`;
const SEP = '\u001f';

export const MYSQL_SYSTEM_DATABASES = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);

/** How a value of a result column is shown. */
function resultKind(column: MysqlColumn): DbValueKind {
  if (column.flags & 0x100) return 'enum';
  if (mysqlIsBinary(column)) return 'binary';
  switch (column.type) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 8:
    case 9:
    case 13:
    case 16:
    case 246:
      return 'number';
    case 10:
    case 14:
      return 'date';
    case 11:
    case 19:
      return 'time';
    case 7:
    case 12:
    case 17:
    case 18:
      return 'datetime';
    case 245:
      return 'json';
    case 255:
    case 242:
      return 'other';
    default:
      return 'text';
  }
}

/** How a table column is shown, from information_schema's DATA_TYPE. */
export function mysqlColumnKind(dataType: string): DbValueKind {
  const type = dataType.toLowerCase();
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|year|bit)$/.test(type)) return 'number';
  if (type === 'bool' || type === 'boolean') return 'boolean';
  if (type === 'date') return 'date';
  if (type === 'time') return 'time';
  if (type === 'datetime' || type === 'timestamp') return 'datetime';
  if (type === 'json') return 'json';
  if (/^(binary|varbinary|tinyblob|blob|mediumblob|longblob)$/.test(type)) return 'binary';
  if (type === 'enum') return 'enum';
  if (type === 'uuid') return 'uuid';
  if (/^(geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection|geomcollection|vector)$/.test(type)) return 'other';
  return 'text';
}

/** The values of an ENUM column type: enum('a','it''s') → [a, it's]. */
export function enumOptions(columnType: string): string[] | null {
  const match = /^(?:enum|set)\((.*)\)$/i.exec(columnType);
  if (match === null) return null;
  const out: string[] = [];
  const body = match[1]!;
  let index = 0;
  while (index < body.length) {
    if (body[index] !== "'") {
      index += 1;
      continue;
    }
    let value = '';
    index += 1;
    while (index < body.length) {
      if (body[index] === "'" && body[index + 1] === "'") {
        value += "'";
        index += 2;
      } else if (body[index] === '\\' && index + 1 < body.length) {
        value += body[index + 1];
        index += 2;
      } else if (body[index] === "'") {
        index += 1;
        break;
      } else {
        value += body[index];
        index += 1;
      }
    }
    out.push(value);
  }
  return out;
}

/** The command a statement runs, for the result header (the text protocol does not say). */
export function commandOf(sql: string): string {
  const words = sql
    .replace(/^(\s|--[^\n]*\n|#[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '')
    .split(/\s+/)
    .slice(0, 4)
    .map((word) => word.toUpperCase().replace(/[^A-Z_]/g, ''));
  const first = words[0] ?? '';
  if (first === 'CREATE' || first === 'ALTER' || first === 'DROP') {
    const rest = words.slice(1).filter((word) => word !== 'OR' && word !== 'REPLACE' && word !== 'TEMPORARY' && word !== 'UNIQUE' && word !== 'IF');
    return `${first} ${rest[0] ?? ''}`.trim();
  }
  return first;
}

class MySession implements EngineConnection {
  readonly dialect = 'mysql' as const;
  database: string;
  readonly my: MysqlConnection;
  private selectLimit: number | null = null;

  constructor(my: MysqlConnection, database: string) {
    this.my = my;
    this.database = database;
  }

  get alive(): boolean {
    return this.my.alive;
  }

  get transaction() {
    return this.my.transaction;
  }

  get backendId(): string {
    return String(this.my.threadId);
  }

  literal(value: string | null): string {
    return this.my.literal(value);
  }

  /** Write `?` placeholders as literals. The catalog queries never contain a literal question mark. */
  private format(sql: string, params: (string | null)[]): string {
    let index = 0;
    return sql.replace(/\?/g, () => this.literal(params[index++] ?? null));
  }

  async execute(sql: string, limits: Limits, onOverflow?: () => void): Promise<Outcome[]> {
    try {
      // Only top-level SELECTs that return rows are limited: subqueries, INSERT … SELECT and routines are not.
      const wanted = limits.maxRows + 1;
      if (this.selectLimit !== wanted) {
        await this.my.query(`SET SESSION sql_select_limit = ${wanted}`);
        this.selectLimit = wanted;
      }
      const results = await this.my.query(sql, { ...limits, ...(onOverflow === undefined ? {} : { onOverflow }) });
      const command = commandOf(sql);
      const outcomes: Outcome[] = [];
      for (const result of results) {
        const notices = result.warnings > 0 ? await this.warnings() : [];
        outcomes.push({
          command: result.columns === null ? command : command || 'SELECT',
          columns: result.columns?.map((column) => ({ name: column.name, type: mysqlTypeName(column), kind: resultKind(column) })) ?? null,
          rows: result.rows,
          rowCount: result.columns !== null ? result.rows.length : num(result.affectedRows),
          truncated: result.truncated,
          clipped: result.clipped,
          notices,
          insertId: result.insertId !== null && result.insertId !== '0' ? result.insertId : null,
        });
      }
      if (/^\s*use\s/i.test(sql)) {
        const [current] = await this.rows('SELECT DATABASE() AS name');
        if (current?.name !== null && current?.name !== undefined) this.database = current.name;
      }
      return outcomes;
    } catch (error) {
      throw toStatementError(error, sql);
    }
  }

  private async warnings(): Promise<{ severity: string; message: string }[]> {
    try {
      const [result] = await this.my.query('SHOW WARNINGS LIMIT 20');
      return (result?.rows ?? []).map((row) => ({ severity: (row[0] ?? 'Warning').toUpperCase(), message: `${row[2] ?? ''}${row[1] === null ? '' : ` (${row[1]})`}` }));
    } catch {
      return [];
    }
  }

  async rows(sql: string, params: (string | null)[] = []): Promise<Row[]> {
    try {
      const [result] = await this.my.query(this.format(sql, params));
      const names = result?.columns?.map((column) => column.name) ?? [];
      return (result?.rows ?? []).map((row) => Object.fromEntries(names.map((name, index) => [name, row[index] ?? null])));
    } catch (error) {
      throw toStatementError(error, sql);
    }
  }

  /** The text protocol has no cursors: page through with LIMIT (the export query is ordered by the key). */
  async each(sql: string, params: (string | null)[], batch: number, onBatch: (columns: string[], rows: (string | null)[][]) => Promise<void>): Promise<number> {
    const base = this.format(sql, params);
    let offset = 0;
    for (;;) {
      let result;
      try {
        [result] = await this.my.query(`${base} LIMIT ${batch} OFFSET ${offset}`);
      } catch (error) {
        throw toStatementError(error, sql);
      }
      const rows = result?.rows ?? [];
      if (rows.length > 0) await onBatch(result?.columns?.map((column) => column.name) ?? [], rows);
      offset += rows.length;
      if (rows.length < batch) return offset;
    }
  }

  async setReadOnly(on: boolean): Promise<void> {
    await this.my.query(`SET SESSION TRANSACTION ${on ? 'READ ONLY' : 'READ WRITE'}`);
  }

  async useDatabase(name: string): Promise<boolean> {
    try {
      await this.my.useDatabase(name);
    } catch (error) {
      throw toStatementError(error, `USE ${name}`);
    }
    this.database = name;
    return true;
  }

  close(): Promise<void> {
    return this.my.close();
  }

  destroy(): void {
    this.my.destroy();
  }
}

/** MySQL points at errors with "near '…' at line N"; turn that into an offset. */
function toStatementError(error: unknown, sql: string): unknown {
  if (!(error instanceof MysqlError)) return error;
  let offset: number | null = null;
  const match = /near '([\s\S]*)' at line (\d+)$/.exec(error.message);
  if (match !== null) {
    const lineStart = lineOffset(sql, Number(match[2]));
    const near = match[1]!.slice(0, 40);
    const found = near.length > 0 ? sql.indexOf(near, lineStart) : -1;
    offset = found === -1 ? (near.length === 0 ? sql.length : lineStart) : found;
  }
  return new StatementError(error.message, { code: String(error.errno), detail: error.sqlState === null ? null : `SQLSTATE ${error.sqlState}`, offset });
}

/** A value for a column, as a literal: hex for bytes, a bare number for BIT, quoted text otherwise. */
function valueLiteral(session: MySession, column: DbTableColumnDto | undefined, value: string | null): string {
  if (value === null) return 'NULL';
  if (column?.kind === 'binary' && /^0x([0-9a-f]{2})*$/i.test(value)) return value.length === 2 ? "''" : `X'${value.slice(2)}'`;
  if (column !== undefined && /^bit/i.test(column.type) && /^\d+$/.test(value)) return value;
  return session.literal(value);
}

function filterSql(session: MySession, filters: DbRowsInput['filters'], columns: Map<string, DbTableColumnDto>): string[] {
  const out: string[] = [];
  for (const filter of filters) {
    const column = columns.get(filter.column);
    if (column === undefined) throw new StatementError(`Unknown column '${filter.column}'`, { code: '1054' });
    const name = q(filter.column);
    const value = (raw: string): string => valueLiteral(session, column, raw);
    switch (filter.op) {
      case 'eq':
        out.push(`${name} = ${value(filter.value)}`);
        break;
      case 'ne':
        out.push(`NOT (${name} <=> ${value(filter.value)})`);
        break;
      case 'lt':
        out.push(`${name} < ${value(filter.value)}`);
        break;
      case 'lte':
        out.push(`${name} <= ${value(filter.value)}`);
        break;
      case 'gt':
        out.push(`${name} > ${value(filter.value)}`);
        break;
      case 'gte':
        out.push(`${name} >= ${value(filter.value)}`);
        break;
      case 'contains':
      case 'starts':
      case 'ends':
        out.push(`CAST(${name} AS CHAR) LIKE ${session.literal(likePattern(filter.value, filter.op))} ESCAPE '!'`);
        break;
      case 'not_contains':
        out.push(`(${name} IS NULL OR CAST(${name} AS CHAR) NOT LIKE ${session.literal(likePattern(filter.value, 'contains'))} ESCAPE '!')`);
        break;
      case 'null':
        out.push(`${name} IS NULL`);
        break;
      case 'not_null':
        out.push(`${name} IS NOT NULL`);
        break;
      case 'empty':
        out.push(`(${name} IS NULL OR CAST(${name} AS CHAR) = '')`);
        break;
      case 'in': {
        const values = inValues(filter.value);
        out.push(values.length === 0 ? 'FALSE' : `${name} IN (${values.map(value).join(', ')})`);
        break;
      }
    }
  }
  return out;
}

function whereClause(session: MySession, view: Pick<DbRowsInput, 'filters' | 'where'>, described: DbTableDto): string {
  const parts = filterSql(session, view.filters, new Map(described.columns.map((column) => [column.name, column])));
  if (view.where.trim().length > 0) parts.push(`(${view.where.trim()})`);
  return parts.length === 0 ? '' : ` WHERE ${parts.join(' AND ')}`;
}

function orderClause(sort: DbRowsInput['sort'], described: DbTableDto): string {
  const columns = new Set(described.columns.map((column) => column.name));
  const order = sort.filter((entry) => columns.has(entry.column)).map((entry) => `${q(entry.column)} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`);
  if (order.length === 0) order.push(...described.keyColumns.map((column) => q(column)));
  return order.length === 0 ? '' : ` ORDER BY ${order.join(', ')}`;
}

function selectList(described: DbTableDto): string {
  return described.columns.length === 0 ? '*' : described.columns.map((column) => q(column.name)).join(', ');
}

/** MySQL prints DATETIME without a zone; the console shows it as written. */
function sqlTime(value: string | null): string | null {
  if (value === null || value === '') return null;
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function mysqlEngine(type: Extract<DbConsoleType, 'mysql' | 'mariadb'>): Engine {
  const engine: Engine = {
    type,
    dialect: 'mysql',
    connectionPerDatabase: false,

    async connect(stream: Duplex, credentials, database) {
      let my: MysqlConnection;
      try {
        my = await MysqlConnection.connect(stream, { user: credentials.user, password: credentials.password, database });
      } catch (error) {
        throw toStatementError(error, '');
      }
      // MySQL 8 caches table statistics for a day by default; the console wants them current.
      if (!my.mariadb) await my.query('SET SESSION information_schema_stats_expiry = 0').catch(() => undefined);
      return new MySession(my, database);
    },

    async cancel(victim, open, credentials) {
      const helper = await MysqlConnection.connect(await open(), { user: credentials.user, password: credentials.password });
      try {
        await helper.query(`KILL QUERY ${Number(victim.backendId)}`);
      } finally {
        await helper.close();
      }
    },

    async overview(conn, primaryDatabase, primaryUser) {
      const [info] = await conn.rows('SELECT VERSION() AS version, CURRENT_USER() AS user, @@max_connections AS max, @@version_comment AS comment');
      const [uptime] = await conn.rows("SHOW GLOBAL STATUS LIKE 'Uptime'");
      const databases = await conn.rows(
        `SELECT s.SCHEMA_NAME AS name, s.DEFAULT_CHARACTER_SET_NAME AS encoding, s.DEFAULT_COLLATION_NAME AS collation, t.size AS size, t.tables AS tables
           FROM information_schema.SCHEMATA s
           LEFT JOIN (SELECT TABLE_SCHEMA AS name, SUM(DATA_LENGTH + INDEX_LENGTH) AS size, COUNT(*) AS tables FROM information_schema.TABLES GROUP BY TABLE_SCHEMA) t
             ON t.name = s.SCHEMA_NAME
          ORDER BY s.SCHEMA_NAME`,
      );
      const connections = await conn.rows('SELECT DB AS name, COUNT(*) AS n FROM information_schema.PROCESSLIST GROUP BY DB').catch(() => [] as Row[]);
      const perDatabase = new Map(connections.map((row) => [row.name ?? '', num(row.n)]));
      const settings = await conn.rows(
        `SHOW VARIABLES WHERE Variable_name IN ('innodb_buffer_pool_size','max_connections','character_set_server','collation_server','time_zone','system_time_zone','sql_mode','default_storage_engine','max_allowed_packet','wait_timeout','long_query_time')`,
      );
      const seconds = num(uptime?.Value);
      return {
        type,
        version: `${(info?.version ?? '').replace(/^5\.5\.5-/, '')}${info?.comment !== null && info?.comment !== undefined && info.comment.length > 0 ? ` (${info.comment})` : ''}`,
        user: info?.user ?? primaryUser,
        defaultDatabase: primaryDatabase,
        startedAt: seconds === null ? null : new Date(Date.now() - seconds * 1000).toISOString(),
        maxConnections: num(info?.max),
        databases: databases.map((row) => ({
          name: row.name!,
          sizeBytes: num(row.size),
          owner: null,
          encoding: row.encoding ?? null,
          collation: row.collation ?? null,
          tables: num(row.tables) ?? 0,
          connections: perDatabase.get(row.name!) ?? 0,
          system: MYSQL_SYSTEM_DATABASES.has(row.name!),
          primary: row.name === primaryDatabase,
        })),
        settings: settings.map((row) => ({ key: row.Variable_name ?? '', value: row.Value ?? '' })),
      };
    },

    async tree(conn, database) {
      const tables = await conn.rows(
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS est, DATA_LENGTH + INDEX_LENGTH AS size, TABLE_COMMENT AS comment
           FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
        [database],
      );
      const routines = await conn.rows(`SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, ROUTINE_COMMENT AS comment FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`, [database]);
      const triggers = await conn.rows(
        `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`,
        [database],
      );
      const events = await conn.rows(`SELECT EVENT_NAME AS name, STATUS AS status FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME`, [database]).catch(() => [] as Row[]);
      const objects: DbObjectDto[] = [
        ...tables.map((row) => {
          const view = row.type === 'VIEW' || row.type === 'SYSTEM VIEW';
          return {
            name: row.name!,
            kind: (view ? 'view' : 'table') as DbObjectKind,
            rows: view ? null : num(row.est),
            sizeBytes: view ? null : num(row.size),
            comment: view || row.comment === '' ? null : row.comment ?? null,
            detail: null,
          };
        }),
        ...routines.map((row) => ({ name: row.name!, kind: (row.type === 'PROCEDURE' ? 'procedure' : 'function') as DbObjectKind, rows: null, sizeBytes: null, comment: row.comment || null, detail: null })),
        ...triggers.map((row) => ({ name: row.name!, kind: 'trigger' as const, rows: null, sizeBytes: null, comment: null, detail: `${row.timing} ${row.event} · ${row.tbl}` })),
        ...events.map((row) => ({ name: row.name!, kind: 'event' as const, rows: null, sizeBytes: null, comment: null, detail: row.status ?? null })),
      ];
      return { database, schemas: [{ name: database, owner: null, system: MYSQL_SYSTEM_DATABASES.has(database), objects }], extensions: [] };
    },

    async table(conn, database, _schema, name) {
      const [info] = await conn.rows(
        `SELECT TABLE_TYPE AS type, ENGINE AS engine, ROW_FORMAT AS row_format, TABLE_ROWS AS est, AVG_ROW_LENGTH AS avg_row_length, DATA_LENGTH AS data_size,
                INDEX_LENGTH AS index_size, DATA_FREE AS free_size, AUTO_INCREMENT AS auto_increment, CREATE_TIME AS created, UPDATE_TIME AS updated,
                TABLE_COLLATION AS collation, TABLE_COMMENT AS comment
           FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [database, name],
      );
      if (info === undefined) throw new StatementError(`Table '${database}.${name}' doesn't exist`, { code: '1146' });
      const view = info.type === 'VIEW' || info.type === 'SYSTEM VIEW';
      const columns = await conn.rows(
        `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, DATA_TYPE AS data_type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, EXTRA AS extra,
                COLUMN_COMMENT AS comment, GENERATION_EXPRESSION AS gen
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [database, name],
      );
      const statistics = await conn.rows(
        `SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, COLUMN_NAME AS col, INDEX_TYPE AS method, NULLABLE AS nullable
           FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
        [database, name],
      );
      const sizes = await conn
        .rows(`SELECT index_name AS name, stat_value * @@innodb_page_size AS size FROM mysql.innodb_index_stats WHERE database_name = ? AND table_name = ? AND stat_name = 'size'`, [database, name])
        .catch(() => [] as Row[]);
      const constraintRows = await conn.rows(`SELECT CONSTRAINT_NAME AS name, CONSTRAINT_TYPE AS type FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [database, name]);
      const foreign = await conn.rows(
        `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS rschema, k.REFERENCED_TABLE_NAME AS rtable, k.REFERENCED_COLUMN_NAME AS rcol
           FROM information_schema.KEY_COLUMN_USAGE k
          WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
        [database, name],
      );
      const rules = await conn.rows(`SELECT CONSTRAINT_NAME AS name, UPDATE_RULE AS upd, DELETE_RULE AS del FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?`, [database, name]);
      const checkNames = constraintRows.filter((row) => row.type === 'CHECK').map((row) => row.name!);
      const checks =
        checkNames.length === 0
          ? []
          : await conn.rows(`SELECT CONSTRAINT_NAME AS name, CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?`, [database]).catch(() => [] as Row[]);
      const referencedBy = await conn.rows(
        `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, CONSTRAINT_NAME AS c, GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR '${SEP}') AS cols
           FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ? GROUP BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME`,
        [database, name],
      );
      const triggers = await conn.rows(
        `SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event, ACTION_STATEMENT AS body FROM information_schema.TRIGGERS
          WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME`,
        [database, name],
      );
      const [create] = await conn.rows(`SHOW CREATE ${view ? 'VIEW' : 'TABLE'} ${table(database, name)}`);
      const ddl = create === undefined ? '' : `${Object.entries(create).find(([key]) => /^Create (Table|View)$/i.test(key))?.[1] ?? ''};`;

      const indexes = new Map<string, DbIndexDto & { nullable: boolean }>();
      const sizeOf = new Map(sizes.map((row) => [row.name!, num(row.size)]));
      for (const row of statistics) {
        const entry = indexes.get(row.name!) ?? {
          name: row.name!,
          columns: [],
          unique: row.non_unique === '0',
          primary: row.name === 'PRIMARY',
          method: row.method ?? null,
          definition: null,
          sizeBytes: sizeOf.get(row.name!) ?? null,
          nullable: false,
        };
        if (row.col !== null && row.col !== undefined) entry.columns.push(row.col);
        if (row.nullable === 'YES') entry.nullable = true;
        indexes.set(row.name!, entry);
      }
      const references = new Map<string, { schema: string | null; table: string; column: string }>();
      const foreignByName = new Map<string, Row[]>();
      for (const row of foreign) foreignByName.set(row.name!, [...(foreignByName.get(row.name!) ?? []), row]);
      // A column links to another table only through a single-column key.
      for (const parts of foreignByName.values()) {
        const only = parts.length === 1 ? parts[0]! : null;
        if (only !== null) references.set(only.col!, { schema: only.rschema ?? null, table: only.rtable!, column: only.rcol! });
      }
      const primary = indexes.get('PRIMARY');
      const primaryColumns = new Set(primary?.columns ?? []);
      const columnDtos: DbTableColumnDto[] = columns.map((row) => {
        const extra = (row.extra ?? '').toLowerCase();
        const generated = /generated|virtual|persistent|stored/.test(extra) && (row.gen ?? '') !== '';
        return {
          name: row.name!,
          type: row.type!,
          kind: row.type!.toLowerCase() === 'tinyint(1)' ? 'boolean' : mysqlColumnKind(row.data_type ?? ''),
          nullable: row.nullable === 'YES',
          defaultValue: generated ? null : row.dflt ?? null,
          primaryKey: primaryColumns.has(row.name!),
          autoIncrement: extra.includes('auto_increment'),
          generated,
          comment: row.comment === '' ? null : row.comment ?? null,
          options: enumOptions(row.type ?? ''),
          references: references.get(row.name!) ?? null,
        };
      });
      const unique = [...indexes.values()].find((index) => index.unique && !index.primary && !index.nullable && index.columns.length > 0);
      const keyColumns = view ? [] : primary !== undefined ? primary.columns : (unique?.columns ?? []);
      const rule = new Map(rules.map((row) => [row.name!, row]));
      const checkClause = new Map(checks.map((row) => [row.name!, row.clause ?? '']));
      const constraints: DbConstraintDto[] = constraintRows.map((row) => {
        const type = row.type ?? '';
        if (type === 'PRIMARY KEY') return { name: row.name!, kind: 'primary_key', definition: `PRIMARY KEY (${(primary?.columns ?? []).map(q).join(', ')})` };
        if (type === 'UNIQUE') return { name: row.name!, kind: 'unique', definition: `UNIQUE (${(indexes.get(row.name!)?.columns ?? []).map(q).join(', ')})` };
        if (type === 'FOREIGN KEY') {
          const parts = foreignByName.get(row.name!) ?? [];
          const target = parts[0];
          const actions = rule.get(row.name!);
          const definition = `FOREIGN KEY (${parts.map((part) => q(part.col!)).join(', ')}) REFERENCES ${target === undefined ? '?' : `${target.rschema === database ? '' : `${q(target.rschema!)}.`}${q(target.rtable!)}`} (${parts
            .map((part) => q(part.rcol!))
            .join(', ')})${actions === undefined ? '' : ` ON UPDATE ${actions.upd} ON DELETE ${actions.del}`}`;
          return { name: row.name!, kind: 'foreign_key', definition };
        }
        if (type === 'CHECK') return { name: row.name!, kind: 'check', definition: `CHECK (${checkClause.get(row.name!) ?? ''})` };
        return { name: row.name!, kind: 'other', definition: type };
      });
      const statKeys = ['engine', 'row_format', 'avg_row_length', 'data_size', 'index_size', 'free_size', 'auto_increment', 'created', 'updated', 'collation'] as const;
      return {
        database,
        schema: null,
        name,
        kind: view ? 'view' : 'table',
        comment: view || info.comment === '' ? null : info.comment ?? null,
        columns: columnDtos,
        keyColumns,
        indexes: [...indexes.values()].map(({ nullable: _nullable, ...index }) => index),
        constraints,
        referencedBy: referencedBy.map((row) => ({ schema: row.s ?? null, table: row.t!, constraint: row.c!, columns: list(row.cols) })),
        triggers: triggers.map((row) => ({
          name: row.name!,
          timing: `${row.timing} ${row.event}`,
          definition: `CREATE TRIGGER ${q(row.name!)} ${row.timing} ${row.event} ON ${q(name)} FOR EACH ROW ${row.body}`,
          enabled: true,
        })),
        stats: statKeys
          .filter((key) => info[key] !== null && info[key] !== undefined)
          .map((key) => ({ key, value: key === 'created' || key === 'updated' ? (sqlTime(info[key]!) ?? info[key]!) : info[key]! })),
        rowEstimate: view ? null : num(info.est),
        sizeBytes: view ? null : (num(info.data_size) ?? 0) + (num(info.index_size) ?? 0),
        ddl,
      };
    },

    async source(conn, database, _schema, name, kind) {
      const keyword: Partial<Record<DbObjectKind, string>> = { view: 'VIEW', function: 'FUNCTION', procedure: 'PROCEDURE', trigger: 'TRIGGER', event: 'EVENT' };
      const word = keyword[kind];
      if (word === undefined) {
        const described = await engine.table(conn, database, null, name);
        return { name, kind: described.kind, ddl: described.ddl };
      }
      const [row] = await conn.rows(`SHOW CREATE ${word} ${table(database, name)}`);
      const ddl = row === undefined ? '' : (Object.entries(row).find(([key]) => /^(Create |SQL Original Statement)/i.test(key))?.[1] ?? '');
      return { name, kind, ddl: ddl === '' ? '' : `${ddl.trimEnd()};` };
    },

    async rows(conn, input, described) {
      const session = conn as MySession;
      const started = performance.now();
      const where = whereClause(session, input, described);
      const from = table(input.database, described.name);
      let page;
      try {
        [page] = await session.my.query(`SELECT ${selectList(described)} FROM ${from}${where}${orderClause(input.sort, described)} LIMIT ${input.limit} OFFSET ${input.offset}`, {
          maxCellBytes: 64 * 1024,
          maxBytes: 24 * 1024 * 1024,
        });
      } catch (error) {
        throw toStatementError(error, where);
      }
      let total: number | null = null;
      const filtered = where.length > 0;
      if (filtered || described.rowEstimate === null || described.rowEstimate < 2_000_000) {
        const count = session.my.mariadb ? `SET STATEMENT max_statement_time = 4 FOR SELECT COUNT(*) FROM ${from}${where}` : `SELECT /*+ MAX_EXECUTION_TIME(4000) */ COUNT(*) FROM ${from}${where}`;
        try {
          const [result] = await session.my.query(count);
          total = num(result?.rows[0]?.[0]);
        } catch (error) {
          if (!(error instanceof MysqlError && (error.errno === 3024 || error.errno === 1969))) throw toStatementError(error, where);
        }
      }
      return {
        columns: described.columns.map((column): DbColumnMetaDto => ({ name: column.name, type: column.type, kind: column.kind })),
        rows: page?.rows ?? [],
        clipped: page?.clipped ?? [],
        total,
        estimate: filtered ? null : described.rowEstimate,
        keyColumns: described.keyColumns,
        durationMs: Math.round(performance.now() - started),
      };
    },

    async changes(conn, input, described) {
      if (described.keyColumns.length === 0 && input.changes.some((change) => change.kind !== 'insert')) {
        throw new StatementError('This table has no primary key or unique key, so its rows cannot be edited here');
      }
      const session = conn as MySession;
      const columns = new Map(described.columns.map((column) => [column.name, column]));
      const from = table(input.database, described.name);
      const result = { inserted: 0, updated: 0, deleted: 0 };
      const run = async (sql: string, index: number | null) => {
        try {
          const [outcome] = await session.my.query(sql);
          return outcome!;
        } catch (error) {
          const failure = toStatementError(error, sql);
          if (index !== null && failure instanceof StatementError) throw new StatementError(`Row ${index + 1}: ${failure.message}`, { code: failure.code });
          throw failure;
        }
      };
      const keyWhere = (key: [string, string | null][]): string =>
        key.map(([column, value]) => (value === null ? `${q(column)} IS NULL` : `${q(column)} = ${valueLiteral(session, columns.get(column), value)}`)).join(' AND ');
      await run('START TRANSACTION', null);
      try {
        for (const [index, change] of input.changes.entries()) {
          if (change.kind === 'insert') {
            const entries = Object.entries(change.values).filter(([column]) => columns.has(column));
            const sql =
              entries.length === 0
                ? `INSERT INTO ${from} () VALUES ()`
                : `INSERT INTO ${from} (${entries.map(([column]) => q(column)).join(', ')}) VALUES (${entries.map(([column, value]) => valueLiteral(session, columns.get(column), value)).join(', ')})`;
            result.inserted += num((await run(sql, index)).affectedRows) ?? 0;
            continue;
          }
          const key = keyFor(change, described.keyColumns);
          if (change.kind === 'update') {
            const entries = Object.entries(change.values).filter(([column]) => columns.has(column));
            if (entries.length === 0) continue;
            const set = entries.map(([column, value]) => `${q(column)} = ${valueLiteral(session, columns.get(column), value)}`).join(', ');
            const outcome = await run(`UPDATE ${from} SET ${set} WHERE ${keyWhere(key)} LIMIT 2`, index);
            const matched = Number(/Rows matched: (\d+)/.exec(outcome.info)?.[1] ?? outcome.affectedRows ?? 0);
            if (matched !== 1) throw new StatementError(`Row ${index + 1} was not found (it may have been changed or deleted meanwhile)`, { code: 'row_missing' });
            result.updated += 1;
          } else {
            const outcome = await run(`DELETE FROM ${from} WHERE ${keyWhere(key)} LIMIT 2`, index);
            if (num(outcome.affectedRows) !== 1) throw new StatementError(`Row ${index + 1} was not found (it may have been deleted meanwhile)`, { code: 'row_missing' });
            result.deleted += 1;
          }
        }
        await run('COMMIT', null);
      } catch (error) {
        await run('ROLLBACK', null).catch(() => undefined);
        throw error;
      }
      return result;
    },

    exportQuery(conn, view, described) {
      const session = conn as MySession;
      return { sql: `SELECT ${selectList(described)} FROM ${table(described.database, described.name)}${whereClause(session, { ...view }, described)}${orderClause(view.sort, described)}`, params: [] };
    },

    async activity(conn) {
      let sessions: Row[];
      try {
        sessions = await conn.rows(
          `SELECT ID AS pid, USER AS user, HOST AS host, DB AS db, COMMAND AS command, TIME AS time, STATE AS state, INFO AS info FROM ${
            (conn as MySession).my.mariadb ? 'information_schema.PROCESSLIST' : 'performance_schema.processlist'
          } WHERE COMMAND NOT IN ('Daemon', 'Binlog Dump') ORDER BY ID`,
        );
      } catch {
        sessions = await conn.rows(
          `SELECT ID AS pid, USER AS user, HOST AS host, DB AS db, COMMAND AS command, TIME AS time, STATE AS state, INFO AS info FROM information_schema.PROCESSLIST WHERE COMMAND NOT IN ('Daemon', 'Binlog Dump') ORDER BY ID`,
        );
      }
      const status = await conn.rows(
        `SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Com_commit','Com_rollback','Questions','Innodb_rows_read','Innodb_rows_inserted','Innodb_rows_updated','Innodb_rows_deleted','Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads','Bytes_received','Bytes_sent')`,
      );
      const value = new Map(status.map((row) => [row.Variable_name ?? '', num(row.Value) ?? 0]));
      const [idle] = await conn.rows(`SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX WHERE trx_query IS NULL`).catch(() => [] as Row[]);
      return {
        sessions: sessions.map((row) => ({
          pid: row.pid!,
          user: row.user ?? null,
          database: row.db ?? null,
          client: row.host ?? null,
          application: null,
          state: row.command === 'Sleep' ? 'idle' : row.command === 'Query' ? 'active' : (row.command ?? '').toLowerCase(),
          query: row.info ?? null,
          durationSec: num(row.time),
          wait: row.state === '' ? null : row.state ?? null,
          startedAt: null,
          own: row.pid === conn.backendId,
        })),
        counters: {
          connections: value.get('Threads_connected') ?? 0,
          active: value.get('Threads_running') ?? 0,
          idleInTransaction: num(idle?.n) ?? 0,
          commits: value.get('Com_commit') ?? 0,
          rollbacks: value.get('Com_rollback') ?? 0,
          queries: value.get('Questions') ?? 0,
          rowsRead: value.get('Innodb_rows_read') ?? 0,
          rowsWritten: (value.get('Innodb_rows_inserted') ?? 0) + (value.get('Innodb_rows_updated') ?? 0) + (value.get('Innodb_rows_deleted') ?? 0),
          cacheHits: Math.max(0, (value.get('Innodb_buffer_pool_read_requests') ?? 0) - (value.get('Innodb_buffer_pool_reads') ?? 0)),
          diskReads: value.get('Innodb_buffer_pool_reads') ?? 0,
          bytesIn: value.get('Bytes_received') ?? null,
          bytesOut: value.get('Bytes_sent') ?? null,
        },
        sampledAt: Date.now(),
      };
    },

    async signal(conn, pid, action) {
      try {
        await (conn as MySession).my.query(`${action === 'cancel' ? 'KILL QUERY' : 'KILL'} ${Number(pid)}`);
        return true;
      } catch (error) {
        if (error instanceof MysqlError && error.errno === 1094) return false;
        throw toStatementError(error, '');
      }
    },

    async roles(conn, primaryUser) {
      const users = await conn.rows('SELECT * FROM mysql.user ORDER BY User, Host');
      const grants = await conn.rows(`SELECT User AS user, Host AS host, Db AS db FROM mysql.db ORDER BY Db`).catch(() => [] as Row[]);
      const databases = new Map<string, string[]>();
      for (const row of grants) {
        const key = `${row.user}@${row.host}`;
        databases.set(key, [...(databases.get(key) ?? []), row.db ?? '']);
      }
      return users
        .filter((row) => !/^(mysql\.|mariadb\.sys$)/.test(row.User ?? '') && row.is_role !== 'Y')
        .map(
          (row): DbRoleDto => ({
            name: row.User ?? '',
            host: row.Host ?? null,
            superuser: row.Super_priv === 'Y' || row.Grant_priv === 'Y',
            canLogin: row.account_locked !== 'Y',
            createDb: row.Create_priv === 'Y',
            createRole: row.Create_user_priv === 'Y',
            memberOf: databases.get(`${row.User}@${row.Host}`) ?? [],
            connectionLimit: num(row.max_user_connections) === 0 ? null : num(row.max_user_connections),
            validUntil: null,
            plugin: row.plugin ?? null,
            primary: row.User === primaryUser,
          }),
        );
    },
  };
  return engine;
}
