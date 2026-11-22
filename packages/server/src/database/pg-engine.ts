/**
 * PostgreSQL for the console: connections, catalog browsing, row editing,
 * activity and roles. Values the person typed always travel as bound
 * parameters; identifiers are quoted.
 */
import type { Duplex } from 'node:stream';
import {
  quoteIdent,
  qualifiedName,
  type DbColumnMetaDto,
  type DbConstraintKind,
  type DbIndexDto,
  type DbObjectDto,
  type DbObjectKind,
  type DbRoleDto,
  type DbRowsInput,
  type DbSchemaDto,
  type DbTableColumnDto,
  type DbTableDto,
  type DbValueKind,
} from '@ploy/shared';
import { inValues, keyFor, likePattern, list, num, StatementError, type Engine, type EngineConnection, type Limits, type Outcome, type Row } from './engine.ts';
import { PgConnection, PgError, pgCancel } from './postgres.ts';

const q = (name: string): string => quoteIdent(name, 'postgres');

/** A timestamptz as PostgreSQL prints it (ISO date style) to an ISO string. */
export function pgTime(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const iso = value.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
const table = (schema: string | null, name: string): string => qualifiedName(schema ?? 'public', name, 'postgres');

/** Built-in type OIDs: the short name people know and how to show the value. */
const BUILTIN: Record<number, [string, DbValueKind]> = {
  16: ['boolean', 'boolean'], 17: ['bytea', 'binary'], 18: ['"char"', 'text'], 19: ['name', 'text'], 20: ['bigint', 'number'], 21: ['smallint', 'number'],
  23: ['integer', 'number'], 24: ['regproc', 'text'], 25: ['text', 'text'], 26: ['oid', 'number'], 28: ['xid', 'number'], 114: ['json', 'json'],
  142: ['xml', 'text'], 600: ['point', 'other'], 650: ['cidr', 'text'], 700: ['real', 'number'], 701: ['double precision', 'number'],
  705: ['unknown', 'text'], 790: ['money', 'number'], 829: ['macaddr', 'text'], 869: ['inet', 'text'], 1033: ['aclitem', 'text'], 1042: ['char', 'text'],
  1043: ['varchar', 'text'], 1082: ['date', 'date'], 1083: ['time', 'time'], 1114: ['timestamp', 'datetime'], 1184: ['timestamptz', 'datetime'],
  1186: ['interval', 'other'], 1266: ['timetz', 'time'], 1560: ['bit', 'text'], 1562: ['varbit', 'text'], 1700: ['numeric', 'number'],
  2205: ['regclass', 'text'], 2206: ['regtype', 'text'], 2249: ['record', 'other'], 2278: ['void', 'other'], 2950: ['uuid', 'uuid'],
  3220: ['pg_lsn', 'text'], 3614: ['tsvector', 'text'], 3615: ['tsquery', 'text'], 3802: ['jsonb', 'json'], 3904: ['int4range', 'other'],
  3906: ['numrange', 'other'], 3908: ['tsrange', 'other'], 3910: ['tstzrange', 'other'], 3912: ['daterange', 'other'], 3926: ['int8range', 'other'],
  1000: ['boolean[]', 'array'], 1001: ['bytea[]', 'array'], 1005: ['smallint[]', 'array'], 1007: ['integer[]', 'array'], 1009: ['text[]', 'array'],
  1014: ['char[]', 'array'], 1015: ['varchar[]', 'array'], 1016: ['bigint[]', 'array'], 1021: ['real[]', 'array'], 1022: ['double precision[]', 'array'],
  1028: ['oid[]', 'array'], 1115: ['timestamp[]', 'array'], 1182: ['date[]', 'array'], 1185: ['timestamptz[]', 'array'], 1231: ['numeric[]', 'array'],
  199: ['json[]', 'array'], 2951: ['uuid[]', 'array'], 3807: ['jsonb[]', 'array'], 1041: ['inet[]', 'array'],
};

export function pgKind(category: string | null, typname: string | null): DbValueKind {
  switch (typname) {
    case 'json':
    case 'jsonb':
      return 'json';
    case 'uuid':
      return 'uuid';
    case 'bytea':
      return 'binary';
    case 'date':
      return 'date';
    case 'time':
    case 'timetz':
      return 'time';
    case 'timestamp':
    case 'timestamptz':
      return 'datetime';
    case 'bool':
      return 'boolean';
  }
  switch (category) {
    case 'N':
      return 'number';
    case 'B':
      return 'boolean';
    case 'D':
      return 'datetime';
    case 'S':
    case 'I':
    case 'V':
      return 'text';
    case 'A':
      return 'array';
    case 'E':
      return 'enum';
    default:
      return 'other';
  }
}

class PgSession implements EngineConnection {
  readonly dialect = 'postgres' as const;
  database: string;
  readonly pg: PgConnection;

  constructor(pg: PgConnection, database: string) {
    this.pg = pg;
    this.database = database;
  }

  get alive(): boolean {
    return this.pg.alive;
  }

  get transaction() {
    return this.pg.transaction;
  }

  get backendId(): string {
    return String(this.pg.processId);
  }

  async execute(sql: string, limits: Limits): Promise<Outcome[]> {
    try {
      const result = await this.pg.query(sql, [], limits);
      const columns =
        result.fields?.map((field) => {
          const known = BUILTIN[field.typeOid];
          return known === undefined ? { name: field.name, type: `oid ${field.typeOid}`, kind: 'other' as const, oid: field.typeOid } : { name: field.name, type: known[0], kind: known[1] };
        }) ?? null;
      return [{ command: result.command, columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated, clipped: result.clipped, notices: result.notices, insertId: null }];
    } catch (error) {
      throw toStatementError(error);
    }
  }

  async rows(sql: string, params: (string | null)[] = []): Promise<Row[]> {
    try {
      const result = await this.pg.query(sql, params);
      const names = result.fields?.map((field) => field.name) ?? [];
      return result.rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index] ?? null])));
    } catch (error) {
      throw toStatementError(error);
    }
  }

  async each(sql: string, params: (string | null)[], batch: number, onBatch: (columns: string[], rows: (string | null)[][]) => Promise<void>): Promise<number> {
    try {
      return await this.pg.each(sql, params, batch, (fields, rows) => onBatch(fields.map((field) => field.name), rows));
    } catch (error) {
      throw toStatementError(error);
    }
  }

  async setReadOnly(on: boolean): Promise<void> {
    await this.pg.query(`SET SESSION CHARACTERISTICS AS TRANSACTION ${on ? 'READ ONLY' : 'READ WRITE'}`);
  }

  async useDatabase(): Promise<boolean> {
    return false;
  }

  close(): Promise<void> {
    return this.pg.close();
  }

  destroy(): void {
    this.pg.destroy();
  }
}

function toStatementError(error: unknown): unknown {
  if (error instanceof PgError) {
    const notices = (error as PgError & { notices?: { severity: string; message: string }[] }).notices ?? [];
    return new StatementError(error.message, {
      code: error.code,
      detail: error.detail,
      hint: error.hint,
      offset: error.position === null ? null : error.position - 1,
      notices,
      fatal: error.fatal,
    });
  }
  return error;
}

const RELKIND: Record<string, DbObjectKind> = { r: 'table', p: 'partitioned_table', f: 'foreign_table', v: 'view', m: 'materialized_view', S: 'sequence' };
const CONTYPE: Record<string, DbConstraintKind> = { p: 'primary_key', f: 'foreign_key', u: 'unique', c: 'check', x: 'exclusion' };

/** Look a relation up by schema and name. */
async function relation(conn: EngineConnection, schema: string, name: string): Promise<Row> {
  const [row] = await conn.rows(
    `SELECT c.oid::text AS oid, c.relkind AS kind, obj_description(c.oid, 'pg_class') AS comment, c.reltuples::bigint AS estimate,
            pg_total_relation_size(c.oid) AS size
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, name],
  );
  if (row === undefined) throw new StatementError(`relation "${schema}.${name}" does not exist`, { code: '42P01' });
  return row;
}

function filterSql(filters: DbRowsInput['filters'], columns: Map<string, DbTableColumnDto>, params: (string | null)[]): string[] {
  const out: string[] = [];
  const bind = (value: string | null): string => {
    params.push(value);
    return `$${params.length}`;
  };
  for (const filter of filters) {
    if (!columns.has(filter.column)) throw new StatementError(`column "${filter.column}" does not exist`, { code: '42703' });
    const column = q(filter.column);
    switch (filter.op) {
      case 'eq':
        out.push(`${column} = ${bind(filter.value)}`);
        break;
      case 'ne':
        out.push(`${column} IS DISTINCT FROM ${bind(filter.value)}`);
        break;
      case 'lt':
        out.push(`${column} < ${bind(filter.value)}`);
        break;
      case 'lte':
        out.push(`${column} <= ${bind(filter.value)}`);
        break;
      case 'gt':
        out.push(`${column} > ${bind(filter.value)}`);
        break;
      case 'gte':
        out.push(`${column} >= ${bind(filter.value)}`);
        break;
      case 'contains':
      case 'starts':
      case 'ends':
        out.push(`${column}::text ILIKE ${bind(likePattern(filter.value, filter.op))} ESCAPE '!'`);
        break;
      case 'not_contains':
        out.push(`(${column} IS NULL OR ${column}::text NOT ILIKE ${bind(likePattern(filter.value, 'contains'))} ESCAPE '!')`);
        break;
      case 'null':
        out.push(`${column} IS NULL`);
        break;
      case 'not_null':
        out.push(`${column} IS NOT NULL`);
        break;
      case 'empty':
        out.push(`(${column} IS NULL OR ${column}::text = '')`);
        break;
      case 'in': {
        const values = inValues(filter.value);
        out.push(values.length === 0 ? 'false' : `${column} IN (${values.map((value) => bind(value)).join(', ')})`);
        break;
      }
    }
  }
  return out;
}

function whereClause(view: Pick<DbRowsInput, 'filters' | 'where'>, table: DbTableDto, params: (string | null)[]): string {
  const columns = new Map(table.columns.map((column) => [column.name, column]));
  const parts = filterSql(view.filters, columns, params);
  if (view.where.trim().length > 0) parts.push(`(${view.where.trim()})`);
  return parts.length === 0 ? '' : ` WHERE ${parts.join(' AND ')}`;
}

function orderClause(sort: DbRowsInput['sort'], table: DbTableDto): string {
  const columns = new Set(table.columns.map((column) => column.name));
  const order = sort.filter((entry) => columns.has(entry.column)).map((entry) => `${q(entry.column)} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`);
  if (order.length === 0) order.push(...table.keyColumns.map((column) => q(column)));
  return order.length === 0 ? '' : ` ORDER BY ${order.join(', ')}`;
}

function selectList(table: DbTableDto): string {
  return table.columns.length === 0 ? '*' : table.columns.map((column) => q(column.name)).join(', ');
}

function columnMeta(table: DbTableDto): DbColumnMetaDto[] {
  return table.columns.map((column) => ({ name: column.name, type: column.type, kind: column.kind }));
}

function triggerTiming(definition: string): string {
  return /\b(BEFORE|AFTER|INSTEAD OF)\s+(.+?)\s+ON\s/i.exec(definition)?.slice(1, 3).join(' ') ?? '';
}

export const postgresEngine: Engine = {
  type: 'postgres',
  dialect: 'postgres',
  connectionPerDatabase: true,

  async connect(stream: Duplex, credentials, database) {
    try {
      const pg = await PgConnection.connect(stream, { user: credentials.user, password: credentials.password, database });
      return new PgSession(pg, database);
    } catch (error) {
      throw toStatementError(error);
    }
  },

  async cancel(victim, open) {
    const session = victim as PgSession;
    await pgCancel(await open(), session.pg.processId, session.pg.secretKey);
  },

  async overview(conn, primaryDatabase, primaryUser) {
    const [info] = await conn.rows(
      `SELECT current_setting('server_version') AS version, current_user AS "user", pg_postmaster_start_time() AS started, current_setting('max_connections') AS max`,
    );
    const databases = await conn.rows(
      `SELECT d.datname AS name, CASE WHEN has_database_privilege(d.datname, 'CONNECT') THEN pg_database_size(d.datname) END AS size,
              pg_get_userbyid(d.datdba) AS owner, pg_encoding_to_char(d.encoding) AS encoding, d.datcollate AS collation,
              (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname) AS connections
         FROM pg_database d WHERE NOT d.datistemplate ORDER BY d.datname`,
    );
    const settings = await conn.rows(
      `SELECT name AS key, current_setting(name) AS value FROM pg_settings
        WHERE name = ANY('{shared_buffers,effective_cache_size,work_mem,maintenance_work_mem,max_connections,TimeZone,server_encoding,wal_level,max_wal_size,random_page_cost,autovacuum}'::text[])
        ORDER BY name`,
    );
    return {
      type: 'postgres',
      version: info?.version ?? '',
      user: info?.user ?? primaryUser,
      defaultDatabase: primaryDatabase,
      startedAt: pgTime(info?.started),
      maxConnections: num(info?.max),
      databases: databases.map((row) => ({
        name: row.name!,
        sizeBytes: num(row.size),
        owner: row.owner ?? null,
        encoding: row.encoding ?? null,
        collation: row.collation ?? null,
        tables: null,
        connections: num(row.connections),
        system: false,
        primary: row.name === primaryDatabase,
      })),
      settings: settings.map((row) => ({ key: row.key!, value: row.value ?? '' })),
    };
  },

  async tree(conn, database) {
    const schemas = await conn.rows(
      `SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner FROM pg_namespace n
        WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        ORDER BY n.nspname <> 'public', n.nspname`,
    );
    const relations = await conn.rows(
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS rows,
              CASE WHEN c.relkind IN ('r','p','m','S') THEN pg_total_relation_size(c.oid) END AS size, obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p','f','v','m','S') AND NOT c.relispartition
          AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        ORDER BY c.relname`,
    );
    const routines = await conn.rows(
      `SELECT n.nspname AS schema, p.proname AS name, p.prokind AS kind, pg_get_function_identity_arguments(p.oid) AS args, obj_description(p.oid, 'pg_proc') AS comment
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prokind IN ('f','p') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
        ORDER BY p.proname`,
    );
    const extensions = await conn.rows(
      `SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY e.extname`,
    );
    const bySchema = new Map<string, DbSchemaDto>(schemas.map((row) => [row.name!, { name: row.name!, owner: row.owner ?? null, system: false, objects: [] as DbObjectDto[] }]));
    for (const row of relations) {
      bySchema.get(row.schema!)?.objects.push({ name: row.name!, kind: RELKIND[row.kind!] ?? 'table', rows: num(row.rows), sizeBytes: num(row.size), comment: row.comment ?? null, detail: null });
    }
    for (const row of routines) {
      bySchema.get(row.schema!)?.objects.push({ name: row.name!, kind: row.kind === 'p' ? 'procedure' : 'function', rows: null, sizeBytes: null, comment: row.comment ?? null, detail: row.args ?? null });
    }
    return {
      database,
      schemas: [...bySchema.values()],
      extensions: extensions.map((row) => ({ name: row.name!, version: row.version ?? '', schema: row.schema ?? null })),
    };
  },

  async table(conn, database, schemaName, name) {
    const schema = schemaName ?? 'public';
    const rel = await relation(conn, schema, name);
    const oid = rel.oid!;
    const columns = await conn.rows(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, COALESCE(bt.typcategory, t.typcategory) AS category,
              COALESCE(bt.typname, t.typname) AS typname, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS "default",
              a.attidentity AS identity, a.attgenerated AS generated, col_description(a.attrelid, a.attnum) AS comment,
              CASE WHEN t.typtype = 'e' THEN (SELECT string_agg(e.enumlabel, E'\\x1f' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid) END AS options
         FROM pg_attribute a
         JOIN pg_type t ON t.oid = a.atttypid
         LEFT JOIN pg_type bt ON bt.oid = t.typbasetype AND t.typtype = 'd'
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [oid],
    );
    const indexes = await conn.rows(
      `SELECT ic.relname AS name, i.indisprimary AS "primary", i.indisunique AS "unique", am.amname AS method, pg_get_indexdef(i.indexrelid) AS definition,
              pg_relation_size(i.indexrelid) AS size, (i.indpred IS NULL AND i.indexprs IS NULL) AS plain,
              (SELECT string_agg(a.attname, E'\\x1f' ORDER BY k.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS columns,
              EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid AND c.conrelid = i.indrelid) AS constraint
         FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam
        WHERE i.indrelid = $1::oid
        ORDER BY i.indisprimary DESC, ic.relname`,
      [oid],
    );
    const constraints = await conn.rows(
      `SELECT c.conname AS name, c.contype AS type, pg_get_constraintdef(c.oid, true) AS definition FROM pg_constraint c
        WHERE c.conrelid = $1::oid AND c.contype IN ('p','f','u','c','x') ORDER BY c.contype = 'p' DESC, c.contype, c.conname`,
      [oid],
    );
    const references = await conn.rows(
      `SELECT a.attname AS "column", rn.nspname AS ref_schema, rc.relname AS ref_table, ra.attname AS ref_column
         FROM pg_constraint c, unnest(c.conkey, c.confkey) AS k(attnum, refnum),
              pg_attribute a, pg_class rc, pg_namespace rn, pg_attribute ra
        WHERE c.conrelid = $1::oid AND c.contype = 'f' AND array_length(c.conkey, 1) = 1
          AND a.attrelid = c.conrelid AND a.attnum = k.attnum
          AND rc.oid = c.confrelid AND rn.oid = rc.relnamespace
          AND ra.attrelid = c.confrelid AND ra.attnum = k.refnum`,
      [oid],
    );
    const referencedBy = await conn.rows(
      `SELECT n.nspname AS schema, cl.relname AS "table", c.conname AS "constraint",
              (SELECT string_agg(a.attname, E'\\x1f') FROM unnest(c.conkey) AS k(attnum) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns
         FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE c.confrelid = $1::oid AND c.contype = 'f' ORDER BY 2, 3`,
      [oid],
    );
    const triggers = await conn.rows(
      `SELECT t.tgname AS name, pg_get_triggerdef(t.oid, true) AS definition, t.tgenabled <> 'D' AS enabled
         FROM pg_trigger t WHERE t.tgrelid = $1::oid AND NOT t.tgisinternal ORDER BY t.tgname`,
      [oid],
    );
    const [stats] = await conn.rows(
      `SELECT pg_relation_size($1::oid) AS data_size, pg_indexes_size($1::oid) AS index_size, pg_total_relation_size($1::oid) AS total_size,
              s.n_live_tup AS live_rows, s.n_dead_tup AS dead_rows, s.seq_scan AS seq_scans, s.idx_scan AS index_scans,
              s.n_tup_ins AS rows_inserted, s.n_tup_upd AS rows_updated, s.n_tup_del AS rows_deleted,
              GREATEST(s.last_vacuum, s.last_autovacuum) AS last_vacuum, GREATEST(s.last_analyze, s.last_autoanalyze) AS last_analyze
         FROM (SELECT 1) AS one LEFT JOIN pg_stat_all_tables s ON s.relid = $1::oid`,
      [oid],
    );

    const refs = new Map(references.map((row) => [row.column!, { schema: row.ref_schema ?? null, table: row.ref_table!, column: row.ref_column! }]));
    const primary = indexes.find((row) => row.primary === 't');
    const primaryColumns = new Set(list(primary?.columns));
    const columnDtos: DbTableColumnDto[] = columns.map((row) => ({
      name: row.name!,
      type: row.type!,
      kind: pgKind(row.category ?? null, row.typname ?? null),
      nullable: row.nullable === 't',
      defaultValue: row.generated === 's' ? null : row.default ?? null,
      primaryKey: primaryColumns.has(row.name!),
      autoIncrement: (row.identity ?? '') !== '' || /^nextval\(/.test(row.default ?? ''),
      generated: row.generated === 's',
      comment: row.comment ?? null,
      options: row.options === null ? null : list(row.options),
      references: refs.get(row.name!) ?? null,
    }));
    const notNull = new Set(columnDtos.filter((column) => !column.nullable).map((column) => column.name));
    const uniqueKey = indexes.find((row) => row.unique === 't' && row.plain === 't' && list(row.columns).length > 0 && list(row.columns).every((column) => notNull.has(column)));
    const keyColumns = primary !== undefined ? list(primary.columns) : uniqueKey !== undefined ? list(uniqueKey.columns) : [];
    const kind = RELKIND[rel.kind!] ?? 'table';

    const indexDtos: DbIndexDto[] = indexes.map((row) => ({
      name: row.name!,
      columns: list(row.columns),
      unique: row.unique === 't',
      primary: row.primary === 't',
      method: row.method ?? null,
      definition: row.definition ?? null,
      sizeBytes: num(row.size),
    }));
    const qualified = table(schema, name);
    let ddl: string;
    if (kind === 'view' || kind === 'materialized_view') {
      const [view] = await conn.rows(`SELECT pg_get_viewdef($1::oid, true) AS definition`, [oid]);
      ddl = `CREATE ${kind === 'view' ? 'OR REPLACE VIEW' : 'MATERIALIZED VIEW'} ${qualified} AS\n${(view?.definition ?? '').trimEnd().replace(/;$/, '')};`;
    } else if (kind === 'sequence') {
      ddl = (await sequenceDdl(conn, schema, name)) ?? '';
    } else {
      const lines = columns.map((row) => {
        const parts = [`  ${q(row.name!)} ${row.type}`];
        if (row.identity === 'a') parts.push('GENERATED ALWAYS AS IDENTITY');
        else if (row.identity === 'd') parts.push('GENERATED BY DEFAULT AS IDENTITY');
        else if (row.generated === 's') parts.push(`GENERATED ALWAYS AS (${row.default}) STORED`);
        else if (row.default !== null) parts.push(`DEFAULT ${row.default}`);
        if (row.nullable !== 't') parts.push('NOT NULL');
        return parts.join(' ');
      });
      for (const row of constraints) lines.push(`  CONSTRAINT ${q(row.name!)} ${row.definition}`);
      const statements = [`CREATE ${kind === 'foreign_table' ? 'FOREIGN TABLE' : 'TABLE'} ${qualified} (\n${lines.join(',\n')}\n)`];
      if (kind === 'partitioned_table') {
        const [part] = await conn.rows(`SELECT pg_get_partkeydef($1::oid) AS key`, [oid]);
        statements[0] += ` PARTITION BY ${part?.key ?? ''}`;
      }
      statements[0] += ';';
      for (const row of indexes) if (row.constraint !== 't') statements.push(`${row.definition};`);
      if (rel.comment !== null) statements.push(`COMMENT ON TABLE ${qualified} IS '${rel.comment!.replace(/'/g, "''")}';`);
      for (const row of columns) if (row.comment !== null) statements.push(`COMMENT ON COLUMN ${qualified}.${q(row.name!)} IS '${row.comment!.replace(/'/g, "''")}';`);
      for (const row of triggers) statements.push(`${row.definition};`);
      ddl = statements.join('\n\n');
    }

    const statEntries = Object.entries(stats ?? {})
      .filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== undefined)
      .map(([key, value]): [string, string] => [key, key.startsWith('last_') ? (pgTime(value) ?? value) : value]);
    return {
      database,
      schema,
      name,
      kind,
      comment: rel.comment ?? null,
      columns: columnDtos,
      keyColumns: kind === 'table' || kind === 'partitioned_table' ? keyColumns : [],
      indexes: indexDtos,
      constraints: constraints.map((row) => ({ name: row.name!, kind: CONTYPE[row.type!] ?? 'other', definition: row.definition ?? '' })),
      referencedBy: referencedBy.map((row) => ({ schema: row.schema ?? null, table: row.table!, constraint: row.constraint!, columns: list(row.columns) })),
      triggers: triggers.map((row) => ({ name: row.name!, timing: triggerTiming(row.definition ?? ''), definition: row.definition ?? '', enabled: row.enabled === 't' })),
      stats: statEntries.map(([key, value]) => ({ key, value })),
      rowEstimate: num(rel.estimate) !== null && num(rel.estimate)! >= 0 ? num(rel.estimate) : null,
      sizeBytes: num(rel.size),
      ddl,
    };
  },

  async source(conn, _database, schemaName, name, kind, detail) {
    const schema = schemaName ?? 'public';
    if (kind === 'function' || kind === 'procedure') {
      const rows = await conn.rows(
        `SELECT pg_get_functiondef(p.oid) AS ddl, pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1 AND p.proname = $2`,
        [schema, name],
      );
      const match = rows.find((row) => detail === undefined || row.args === detail) ?? rows[0];
      if (match === undefined) throw new StatementError(`function "${schema}.${name}" does not exist`, { code: '42883' });
      return { name, kind, ddl: `${(match.ddl ?? '').trimEnd()};` };
    }
    if (kind === 'sequence') return { name, kind, ddl: (await sequenceDdl(conn, schema, name)) ?? '' };
    const described = await postgresEngine.table(conn, conn.database, schema, name);
    return { name, kind: described.kind, ddl: described.ddl };
  },

  async rows(conn, input, described) {
    const started = performance.now();
    const params: (string | null)[] = [];
    const where = whereClause(input, described, params);
    const from = table(described.schema, described.name);
    const sql = `SELECT ${selectList(described)} FROM ${from}${where}${orderClause(input.sort, described)} LIMIT ${input.limit} OFFSET ${input.offset}`;
    const session = conn as PgSession;
    let result;
    try {
      result = await session.pg.query(sql, params, { maxRows: input.limit, maxCellBytes: 64 * 1024, maxBytes: 24 * 1024 * 1024 });
    } catch (error) {
      throw toStatementError(error);
    }
    let total: number | null = null;
    const estimate = described.rowEstimate;
    const filtered = where.length > 0;
    if (filtered || estimate === null || estimate < 2_000_000) {
      try {
        await session.pg.query(`SET statement_timeout = 4000`);
        const [count] = await conn.rows(`SELECT count(*) AS n FROM ${from}${where}`, params);
        total = num(count?.n);
      } catch (error) {
        if (!(error instanceof StatementError && error.code === '57014')) throw error;
      } finally {
        await session.pg.query(`SET statement_timeout = 0`).catch(() => undefined);
      }
    }
    return {
      columns: columnMeta(described),
      rows: result.rows,
      clipped: result.clipped,
      total,
      estimate: filtered ? null : estimate,
      keyColumns: described.keyColumns,
      durationMs: Math.round(performance.now() - started),
    };
  },

  async changes(conn, input, described) {
    if (described.keyColumns.length === 0 && input.changes.some((change) => change.kind !== 'insert')) {
      throw new StatementError('This table has no primary key or unique key, so its rows cannot be edited here');
    }
    const session = conn as PgSession;
    const columns = new Set(described.columns.map((column) => column.name));
    const from = table(described.schema, described.name);
    const result = { inserted: 0, updated: 0, deleted: 0 };
    const run = async (sql: string, params: (string | null)[]): Promise<number> => {
      try {
        return (await session.pg.query(sql, params)).rowCount ?? 0;
      } catch (error) {
        throw toStatementError(error);
      }
    };
    const keyWhere = (key: [string, string | null][], params: (string | null)[]): string =>
      key
        .map(([column, value]) => {
          if (value === null) return `${q(column)} IS NULL`;
          params.push(value);
          return `${q(column)} = $${params.length}`;
        })
        .join(' AND ');
    await run('BEGIN', []);
    try {
      for (const [index, change] of input.changes.entries()) {
        const params: (string | null)[] = [];
        if (change.kind === 'insert') {
          const entries = Object.entries(change.values).filter(([column]) => columns.has(column));
          const sql =
            entries.length === 0
              ? `INSERT INTO ${from} DEFAULT VALUES`
              : `INSERT INTO ${from} (${entries.map(([column]) => q(column)).join(', ')}) VALUES (${entries
                  .map(([, value]) => {
                    params.push(value);
                    return `$${params.length}`;
                  })
                  .join(', ')})`;
          result.inserted += await run(sql, params).catch((error: unknown) => {
            throw withChange(error, index);
          });
          continue;
        }
        const key = keyFor(change, described.keyColumns);
        if (change.kind === 'update') {
          const entries = Object.entries(change.values).filter(([column]) => columns.has(column));
          if (entries.length === 0) continue;
          const set = entries
            .map(([column, value]) => {
              params.push(value);
              return `${q(column)} = $${params.length}`;
            })
            .join(', ');
          const count = await run(`UPDATE ${from} SET ${set} WHERE ${keyWhere(key, params)}`, params).catch((error: unknown) => {
            throw withChange(error, index);
          });
          if (count !== 1) throw new StatementError(`Row ${index + 1} was not found (it may have been changed or deleted meanwhile)`, { code: 'row_missing' });
          result.updated += 1;
        } else {
          const count = await run(`DELETE FROM ${from} WHERE ${keyWhere(key, params)}`, params).catch((error: unknown) => {
            throw withChange(error, index);
          });
          if (count !== 1) throw new StatementError(`Row ${index + 1} was not found (it may have been deleted meanwhile)`, { code: 'row_missing' });
          result.deleted += 1;
        }
      }
      await run('COMMIT', []);
    } catch (error) {
      await run('ROLLBACK', []).catch(() => undefined);
      throw error;
    }
    return result;
  },

  exportQuery(_conn, view, described) {
    const params: (string | null)[] = [];
    const where = whereClause(view, described, params);
    return { sql: `SELECT ${selectList(described)} FROM ${table(described.schema, described.name)}${where}${orderClause(view.sort, described)}`, params };
  },

  async activity(conn) {
    const sessions = await conn.rows(
      `SELECT pid::text AS pid, usename AS "user", datname AS database, COALESCE(host(client_addr), CASE WHEN client_port = -1 THEN 'local' END) AS client,
              application_name AS application, state, query,
              EXTRACT(EPOCH FROM (now() - COALESCE(CASE WHEN state = 'active' THEN query_start END, state_change, backend_start)))::bigint AS duration,
              CASE WHEN wait_event IS NOT NULL THEN wait_event_type || ': ' || wait_event END AS wait, backend_start AS started
         FROM pg_stat_activity WHERE backend_type = 'client backend' ORDER BY backend_start`,
    );
    const [counters] = await conn.rows(
      `SELECT (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend') AS connections,
              (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND state = 'active') AS active,
              (SELECT count(*) FROM pg_stat_activity WHERE state LIKE 'idle in transaction%') AS idle_tx,
              sum(xact_commit) AS commits, sum(xact_rollback) AS rollbacks, sum(tup_returned) AS rows_read,
              sum(tup_inserted + tup_updated + tup_deleted) AS rows_written, sum(blks_hit) AS hits, sum(blks_read) AS reads
         FROM pg_stat_database`,
    );
    return {
      sessions: sessions.map((row) => ({
        pid: row.pid!,
        user: row.user ?? null,
        database: row.database ?? null,
        client: row.client ?? null,
        application: row.application === '' ? null : row.application ?? null,
        state: row.state ?? null,
        query: row.query === '' ? null : row.query ?? null,
        durationSec: num(row.duration),
        wait: row.wait ?? null,
        startedAt: pgTime(row.started),
        own: row.pid === conn.backendId,
      })),
      counters: {
        connections: num(counters?.connections) ?? 0,
        active: num(counters?.active) ?? 0,
        idleInTransaction: num(counters?.idle_tx) ?? 0,
        commits: num(counters?.commits) ?? 0,
        rollbacks: num(counters?.rollbacks) ?? 0,
        queries: null,
        rowsRead: num(counters?.rows_read) ?? 0,
        rowsWritten: num(counters?.rows_written) ?? 0,
        cacheHits: num(counters?.hits) ?? 0,
        diskReads: num(counters?.reads) ?? 0,
        bytesIn: null,
        bytesOut: null,
      },
      sampledAt: Date.now(),
    };
  },

  async signal(conn, pid, action) {
    const [row] = await conn.rows(`SELECT ${action === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend'}($1::int) AS ok`, [pid]);
    return row?.ok === 't';
  },

  async roles(conn, primaryUser) {
    const rows = await conn.rows(
      `SELECT r.rolname AS name, r.rolsuper AS superuser, r.rolcanlogin AS login, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole,
              r.rolconnlimit AS connlimit, r.rolvaliduntil AS valid_until,
              (SELECT string_agg(b.rolname, E'\\x1f' ORDER BY b.rolname) FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid) AS member_of
         FROM pg_roles r WHERE r.rolname !~ '^pg_' ORDER BY r.rolname`,
    );
    return rows.map(
      (row): DbRoleDto => ({
        name: row.name!,
        host: null,
        superuser: row.superuser === 't',
        canLogin: row.login === 't',
        createDb: row.createdb === 't',
        createRole: row.createrole === 't',
        memberOf: list(row.member_of),
        connectionLimit: num(row.connlimit) === -1 ? null : num(row.connlimit),
        validUntil: row.valid_until ?? null,
        plugin: null,
        primary: row.name === primaryUser,
      }),
    );
  },

  async describeTypes(conn, oids) {
    const out = new Map<number, { type: string; kind: DbValueKind }>();
    if (oids.length === 0) return out;
    const rows = await conn.rows(
      `SELECT t.oid::text AS oid, format_type(t.oid, NULL) AS name, COALESCE(bt.typcategory, t.typcategory) AS category, COALESCE(bt.typname, t.typname) AS typname
         FROM pg_type t LEFT JOIN pg_type bt ON bt.oid = t.typbasetype AND t.typtype = 'd'
        WHERE t.oid = ANY($1::oid[])`,
      [`{${oids.join(',')}}`],
    );
    for (const row of rows) out.set(Number(row.oid), { type: row.name ?? 'unknown', kind: pgKind(row.category ?? null, row.typname ?? null) });
    return out;
  },
};

function withChange(error: unknown, index: number): unknown {
  if (error instanceof StatementError) return new StatementError(`Row ${index + 1}: ${error.message}`, { code: error.code, detail: error.detail, hint: error.hint });
  return error;
}

async function sequenceDdl(conn: EngineConnection, schema: string, name: string): Promise<string | null> {
  const [row] = await conn.rows(
    `SELECT data_type, start_value, min_value, max_value, increment_by, cycle, cache_size, last_value FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2`,
    [schema, name],
  );
  if (row === undefined) return null;
  return [
    `CREATE SEQUENCE ${table(schema, name)}`,
    `  AS ${row.data_type}`,
    `  INCREMENT BY ${row.increment_by}`,
    `  MINVALUE ${row.min_value}`,
    `  MAXVALUE ${row.max_value}`,
    `  START WITH ${row.start_value}`,
    `  CACHE ${row.cache_size}${row.cycle === 't' ? '\n  CYCLE' : ''};`,
    row.last_value === null ? '' : `\n-- last value: ${row.last_value}`,
  ]
    .join('\n')
    .trimEnd();
}
