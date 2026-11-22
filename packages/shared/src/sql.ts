/**
 * SQL helpers shared by the database console's server and browser halves:
 * splitting a script into statements the way psql and the mysql client do,
 * quoting identifiers and literals, and the statements the console's dialogs
 * generate (shown to the person before they run).
 */

/** The two SQL families the console speaks: PostgreSQL, and MySQL with MariaDB. */
export type SqlDialect = 'postgres' | 'mysql';

/** Service types with a database console. */
export const DB_CONSOLE_TYPES = ['postgres', 'mysql', 'mariadb'] as const;
export type DbConsoleType = (typeof DB_CONSOLE_TYPES)[number];

export function hasDbConsole(type: string): type is DbConsoleType {
  return (DB_CONSOLE_TYPES as readonly string[]).includes(type);
}

export function dialectOf(type: DbConsoleType): SqlDialect {
  return type === 'postgres' ? 'postgres' : 'mysql';
}

export interface SqlStatement {
  /** The statement without its terminator, trimmed. */
  text: string;
  /** Offset of `text` in the script (UTF-16 code units). */
  start: number;
  /** Offset just past `text`. */
  end: number;
}

const WORD = /[A-Za-z0-9_$\u0080-￿]/;
const isWordChar = (char: string | undefined): boolean => char !== undefined && WORD.test(char);
const isSpace = (char: string | undefined): boolean => char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';

/**
 * Split a script into statements.
 *
 * PostgreSQL: quotes ('…', E'…', "…"), dollar quoting ($$…$$, $tag$…$tag$),
 * nested block comments, `--` comments, parentheses, and SQL-standard
 * function bodies (`BEGIN ATOMIC … END`).
 *
 * MySQL and MariaDB: quotes ('…', "…", `…`) with backslash escapes, `#`,
 * `-- ` and block comments, the client's `DELIMITER` command, and the
 * `BEGIN … END` bodies of procedures, functions, triggers and events (so a
 * routine pasted without DELIMITER still runs as one statement).
 *
 * Statements that hold only comments are dropped.
 */
export function splitSql(script: string, dialect: SqlDialect): SqlStatement[] {
  const out: SqlStatement[] = [];
  let delimiter = ';';
  let statementStart = 0;
  let depth = 0;
  /** Words seen at the start of the current statement, upper-cased (enough to recognise CREATE … PROCEDURE). */
  let head: string[] = [];
  let blockDepth = 0;
  let previousWord = '';
  let hasCode = false;
  /** Where the statement's first code character is (comments before it are not part of it). */
  let codeStart = 0;
  let i = 0;
  const n = script.length;

  const push = (end: number, next: number): void => {
    if (hasCode) {
      statementStart = Math.max(statementStart, codeStart);
      const raw = script.slice(statementStart, end);
      const leading = raw.length - raw.trimStart().length;
      const text = raw.trim();
      if (text.length > 0) out.push({ text, start: statementStart + leading, end: statementStart + leading + text.length });
    }
    statementStart = next;
    depth = 0;
    head = [];
    blockDepth = 0;
    previousWord = '';
    hasCode = false;
  };

  const routineStatement = (): boolean => {
    if (head[0] !== 'CREATE') return false;
    return head.some((word) => word === 'PROCEDURE' || word === 'FUNCTION' || word === 'TRIGGER' || word === 'EVENT');
  };

  while (i < n) {
    const char = script[i]!;
    const next = script[i + 1];

    // MySQL client command: DELIMITER xx on a line of its own, at a statement boundary.
    if (dialect === 'mysql' && !hasCode && (char === 'D' || char === 'd') && /^delimiter[ \t]/i.test(script.slice(i, i + 10))) {
      let lineEnd = script.indexOf('\n', i);
      if (lineEnd === -1) lineEnd = n;
      const value = script.slice(i + 10, lineEnd).trim();
      if (value.length > 0) delimiter = value;
      i = lineEnd + 1;
      statementStart = i;
      continue;
    }

    // Comments.
    if (char === '-' && next === '-' && (dialect === 'postgres' || isSpace(script[i + 2]) || i + 2 >= n)) {
      const lineEnd = script.indexOf('\n', i);
      i = lineEnd === -1 ? n : lineEnd + 1;
      continue;
    }
    if (dialect === 'mysql' && char === '#') {
      const lineEnd = script.indexOf('\n', i);
      i = lineEnd === -1 ? n : lineEnd + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      // MySQL's executable comments (/*! … */) are code.
      if (dialect === 'mysql' && script[i + 2] === '!' && !hasCode) {
        hasCode = true;
        codeStart = i;
      }
      let level = 1;
      i += 2;
      while (i < n && level > 0) {
        if (script[i] === '*' && script[i + 1] === '/') {
          level -= 1;
          i += 2;
        } else if (dialect === 'postgres' && script[i] === '/' && script[i + 1] === '*') {
          level += 1;
          i += 2;
        } else i += 1;
      }
      continue;
    }

    // Statement terminator.
    if (depth === 0 && blockDepth === 0 && script.startsWith(delimiter, i)) {
      push(i, i + delimiter.length);
      i += delimiter.length;
      continue;
    }

    if (!isSpace(char) && !hasCode) {
      hasCode = true;
      codeStart = i;
    }

    // Quoted text.
    if (char === "'" || char === '"' || (dialect === 'mysql' && char === '`')) {
      const backslashes = dialect === 'mysql' ? char !== '`' : char === "'" && (script[i - 1] === 'E' || script[i - 1] === 'e') && !isWordChar(script[i - 2]);
      i += 1;
      while (i < n) {
        const c = script[i]!;
        if (backslashes && c === '\\') {
          i += 2;
          continue;
        }
        if (c === char) {
          if (script[i + 1] === char) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      previousWord = '';
      continue;
    }

    // PostgreSQL dollar quoting.
    if (dialect === 'postgres' && char === '$' && !isWordChar(script[i - 1])) {
      const match = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(script.slice(i, i + 64));
      if (match !== null) {
        const tag = match[0];
        const close = script.indexOf(tag, i + tag.length);
        i = close === -1 ? n : close + tag.length;
        previousWord = '';
        continue;
      }
    }

    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);

    if (isWordChar(char) && !isWordChar(script[i - 1])) {
      let j = i;
      // A custom delimiter such as $$ may follow a word directly (END$$).
      while (j < n && isWordChar(script[j]) && (delimiter === ';' || !script.startsWith(delimiter, j))) j += 1;
      const word = script.slice(i, j).toUpperCase();
      if (head.length < 8) head.push(word);
      if (dialect === 'postgres') {
        if (word === 'ATOMIC' && previousWord === 'BEGIN') blockDepth += 1;
        else if (blockDepth > 0 && word === 'CASE') blockDepth += 1;
        else if (blockDepth > 0 && word === 'END') blockDepth -= 1;
      } else if (routineStatement()) {
        if (word === 'BEGIN' || (word === 'CASE' && previousWord !== 'END')) blockDepth += 1;
        else if (word === 'END') {
          const after = /^\s*([A-Za-z]+)/.exec(script.slice(j, j + 16))?.[1]?.toUpperCase();
          if (after !== 'IF' && after !== 'LOOP' && after !== 'WHILE' && after !== 'REPEAT') blockDepth = Math.max(0, blockDepth - 1);
        }
      }
      previousWord = word;
      i = j;
      continue;
    }
    i += 1;
  }
  push(n, n);
  return out;
}

/** The statement the caret is in (or just after), for "run current statement". */
export function statementAt(statements: SqlStatement[], offset: number): SqlStatement | null {
  let best: SqlStatement | null = null;
  for (const statement of statements) {
    if (statement.start <= offset) best = statement;
    if (offset >= statement.start && offset <= statement.end) return statement;
  }
  return best ?? statements[0] ?? null;
}

/** Turn a 1-based line number inside `text` into an offset. */
export function lineOffset(text: string, line: number): number {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return offset;
    offset = next + 1;
  }
  return offset;
}

/** PostgreSQL counts error positions in characters; JavaScript strings in UTF-16 units. */
export function codePointOffset(text: string, characters: number): number {
  let units = 0;
  let count = 0;
  while (units < text.length && count < characters) {
    const code = text.codePointAt(units)!;
    units += code > 0xffff ? 2 : 1;
    count += 1;
  }
  return units;
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

export function quoteIdent(name: string, dialect: SqlDialect): string {
  return dialect === 'postgres' ? `"${name.replace(/"/g, '""')}"` : `\`${name.replace(/`/g, '``')}\``;
}

/** `schema.name`, quoted. MySQL has no schemas inside a database: there the schema is the database. */
export function qualifiedName(schema: string | null, name: string, dialect: SqlDialect): string {
  return schema === null || schema.length === 0 ? quoteIdent(name, dialect) : `${quoteIdent(schema, dialect)}.${quoteIdent(name, dialect)}`;
}

/**
 * A string literal for a statement the person reads before running it.
 * PostgreSQL with standard_conforming_strings (the default since 9.1) takes
 * backslashes literally; MySQL's default SQL mode treats them as escapes.
 */
export function quoteLiteral(value: string | null, dialect: SqlDialect): string {
  if (value === null) return 'NULL';
  if (dialect === 'postgres') return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\0/g, '\\0').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\x1a/g, '\\Z')}'`;
}

/** A name the console accepts for things it creates (databases, roles, tables, columns). */
export const SQL_NAME_PATTERN = /^[^\u0000]{1,63}$/;

// ---------------------------------------------------------------------------
// Statements behind the console's dialogs and menus
// ---------------------------------------------------------------------------

export interface SqlColumnSpec {
  name: string;
  type: string;
  nullable: boolean;
  /** An SQL expression, written as the person typed it; empty for none. */
  defaultValue: string;
  primaryKey: boolean;
}

export const sqlScripts = {
  createTable(dialect: SqlDialect, schema: string | null, name: string, columns: SqlColumnSpec[], comment = ''): string {
    const keys = columns.filter((column) => column.primaryKey).map((column) => quoteIdent(column.name, dialect));
    const lines = columns.map((column) => {
      const parts = [quoteIdent(column.name, dialect), column.type.trim()];
      if (!column.nullable && !column.primaryKey) parts.push('NOT NULL');
      if (column.defaultValue.trim().length > 0) parts.push(`DEFAULT ${column.defaultValue.trim()}`);
      return `  ${parts.join(' ')}`;
    });
    if (keys.length > 0) lines.push(`  PRIMARY KEY (${keys.join(', ')})`);
    const table = qualifiedName(schema, name, dialect);
    let sql = `CREATE TABLE ${table} (\n${lines.join(',\n')}\n)`;
    if (comment.trim().length > 0) {
      sql = dialect === 'postgres' ? `${sql};\nCOMMENT ON TABLE ${table} IS ${quoteLiteral(comment.trim(), dialect)}` : `${sql} COMMENT = ${quoteLiteral(comment.trim(), dialect)}`;
    }
    return `${sql};`;
  },

  addColumn(dialect: SqlDialect, schema: string | null, table: string, column: SqlColumnSpec): string {
    const parts = [quoteIdent(column.name, dialect), column.type.trim()];
    if (!column.nullable) parts.push('NOT NULL');
    if (column.defaultValue.trim().length > 0) parts.push(`DEFAULT ${column.defaultValue.trim()}`);
    return `ALTER TABLE ${qualifiedName(schema, table, dialect)} ADD COLUMN ${parts.join(' ')};`;
  },

  dropColumn(dialect: SqlDialect, schema: string | null, table: string, column: string): string {
    return `ALTER TABLE ${qualifiedName(schema, table, dialect)} DROP COLUMN ${quoteIdent(column, dialect)};`;
  },

  renameColumn(dialect: SqlDialect, schema: string | null, table: string, from: string, to: string): string {
    return `ALTER TABLE ${qualifiedName(schema, table, dialect)} RENAME COLUMN ${quoteIdent(from, dialect)} TO ${quoteIdent(to, dialect)};`;
  },

  renameTable(dialect: SqlDialect, schema: string | null, from: string, to: string): string {
    return dialect === 'postgres'
      ? `ALTER TABLE ${qualifiedName(schema, from, dialect)} RENAME TO ${quoteIdent(to, dialect)};`
      : `RENAME TABLE ${qualifiedName(schema, from, dialect)} TO ${qualifiedName(schema, to, dialect)};`;
  },

  createIndex(dialect: SqlDialect, schema: string | null, table: string, name: string, columns: string[], unique: boolean, method = ''): string {
    const list = columns.map((column) => quoteIdent(column, dialect)).join(', ');
    const kind = unique ? 'UNIQUE INDEX' : 'INDEX';
    if (dialect === 'postgres') {
      const using = method.length > 0 && method !== 'btree' ? ` USING ${method}` : '';
      return `CREATE ${kind} ${quoteIdent(name, dialect)} ON ${qualifiedName(schema, table, dialect)}${using} (${list});`;
    }
    return `CREATE ${kind} ${quoteIdent(name, dialect)} ON ${qualifiedName(schema, table, dialect)} (${list});`;
  },

  dropIndex(dialect: SqlDialect, schema: string | null, table: string, name: string): string {
    return dialect === 'postgres' ? `DROP INDEX ${qualifiedName(schema, name, dialect)};` : `DROP INDEX ${quoteIdent(name, dialect)} ON ${qualifiedName(schema, table, dialect)};`;
  },

  dropConstraint(dialect: SqlDialect, schema: string | null, table: string, name: string, kind: string): string {
    if (dialect === 'mysql' && kind === 'foreign_key') return `ALTER TABLE ${qualifiedName(schema, table, dialect)} DROP FOREIGN KEY ${quoteIdent(name, dialect)};`;
    if (dialect === 'mysql' && kind === 'primary_key') return `ALTER TABLE ${qualifiedName(schema, table, dialect)} DROP PRIMARY KEY;`;
    if (dialect === 'mysql' && kind === 'unique') return `ALTER TABLE ${qualifiedName(schema, table, dialect)} DROP INDEX ${quoteIdent(name, dialect)};`;
    if (dialect === 'mysql' && kind === 'check') return `ALTER TABLE ${qualifiedName(schema, table, dialect)} DROP CHECK ${quoteIdent(name, dialect)};`;
    return `ALTER TABLE ${qualifiedName(schema, table, dialect)} DROP CONSTRAINT ${quoteIdent(name, dialect)};`;
  },

  truncate(dialect: SqlDialect, schema: string | null, table: string): string {
    return `TRUNCATE TABLE ${qualifiedName(schema, table, dialect)};`;
  },

  dropObject(dialect: SqlDialect, kind: string, schema: string | null, name: string, signature = ''): string {
    const keyword: Record<string, string> = {
      table: 'TABLE',
      partitioned_table: 'TABLE',
      foreign_table: 'FOREIGN TABLE',
      view: 'VIEW',
      materialized_view: 'MATERIALIZED VIEW',
      sequence: 'SEQUENCE',
      function: 'FUNCTION',
      procedure: 'PROCEDURE',
      trigger: 'TRIGGER',
      event: 'EVENT',
    };
    const target = qualifiedName(schema, name, dialect);
    const args = dialect === 'postgres' && (kind === 'function' || kind === 'procedure') ? `(${signature})` : '';
    return `DROP ${keyword[kind] ?? 'TABLE'} ${target}${args};`;
  },

  select(dialect: SqlDialect, schema: string | null, table: string, columns: string[], limit = 100): string {
    const list = columns.length === 0 ? '*' : columns.map((column) => quoteIdent(column, dialect)).join(', ');
    return `SELECT ${list}\nFROM ${qualifiedName(schema, table, dialect)}\nLIMIT ${limit};`;
  },

  insert(dialect: SqlDialect, schema: string | null, table: string, columns: string[]): string {
    const list = columns.map((column) => quoteIdent(column, dialect)).join(', ');
    const values = columns.map((_column, index) => (dialect === 'postgres' ? `$${index + 1}` : '?')).join(', ');
    return `INSERT INTO ${qualifiedName(schema, table, dialect)} (${list})\nVALUES (${values});`;
  },

  update(dialect: SqlDialect, schema: string | null, table: string, columns: string[], keys: string[]): string {
    const set = columns.map((column) => `${quoteIdent(column, dialect)} = ?`).join(',\n    ');
    const where = (keys.length > 0 ? keys : columns.slice(0, 1)).map((column) => `${quoteIdent(column, dialect)} = ?`).join(' AND ');
    return `UPDATE ${qualifiedName(schema, table, dialect)}\nSET ${set}\nWHERE ${where};`;
  },

  delete(dialect: SqlDialect, schema: string | null, table: string, keys: string[]): string {
    const where = keys.length === 0 ? 'false' : keys.map((column) => `${quoteIdent(column, dialect)} = ?`).join(' AND ');
    return `DELETE FROM ${qualifiedName(schema, table, dialect)}\nWHERE ${where};`;
  },

  createDatabase(dialect: SqlDialect, name: string, options: { owner?: string; encoding?: string; collation?: string } = {}): string {
    if (dialect === 'postgres') {
      const parts = [`CREATE DATABASE ${quoteIdent(name, dialect)}`];
      if (options.owner !== undefined && options.owner.length > 0) parts.push(`OWNER ${quoteIdent(options.owner, dialect)}`);
      if (options.encoding !== undefined && options.encoding.length > 0) parts.push(`ENCODING ${quoteLiteral(options.encoding, dialect)}`);
      return `${parts.join(' ')};`;
    }
    const parts = [`CREATE DATABASE ${quoteIdent(name, dialect)}`];
    if (options.encoding !== undefined && options.encoding.length > 0) parts.push(`CHARACTER SET ${options.encoding}`);
    if (options.collation !== undefined && options.collation.length > 0) parts.push(`COLLATE ${options.collation}`);
    return `${parts.join(' ')};`;
  },

  dropDatabase(dialect: SqlDialect, name: string): string {
    return dialect === 'postgres' ? `DROP DATABASE ${quoteIdent(name, dialect)} WITH (FORCE);` : `DROP DATABASE ${quoteIdent(name, dialect)};`;
  },

  createSchema(dialect: SqlDialect, name: string): string {
    return `CREATE SCHEMA ${quoteIdent(name, dialect)};`;
  },

  dropSchema(dialect: SqlDialect, name: string, cascade: boolean): string {
    return `DROP SCHEMA ${quoteIdent(name, dialect)}${cascade ? ' CASCADE' : ''};`;
  },

  createRole(
    dialect: SqlDialect,
    name: string,
    password: string,
    options: { host?: string; superuser?: boolean; createDb?: boolean; createRole?: boolean; login?: boolean; database?: string | null } = {},
  ): string {
    if (dialect === 'postgres') {
      const attributes = [options.login === false ? 'NOLOGIN' : 'LOGIN'];
      if (options.superuser === true) attributes.push('SUPERUSER');
      if (options.createDb === true) attributes.push('CREATEDB');
      if (options.createRole === true) attributes.push('CREATEROLE');
      const lines = [`CREATE ROLE ${quoteIdent(name, dialect)} WITH ${attributes.join(' ')}${password.length > 0 ? ` PASSWORD ${quoteLiteral(password, dialect)}` : ''};`];
      if (options.database !== undefined && options.database !== null && options.database.length > 0) {
        lines.push(`GRANT ALL PRIVILEGES ON DATABASE ${quoteIdent(options.database, dialect)} TO ${quoteIdent(name, dialect)};`);
      }
      return lines.join('\n');
    }
    const user = `${quoteLiteral(name, dialect)}@${quoteLiteral(options.host ?? '%', dialect)}`;
    const lines = [`CREATE USER ${user} IDENTIFIED BY ${quoteLiteral(password, dialect)};`];
    if (options.superuser === true) lines.push(`GRANT ALL PRIVILEGES ON *.* TO ${user} WITH GRANT OPTION;`);
    else if (options.database !== undefined && options.database !== null && options.database.length > 0) {
      lines.push(`GRANT ALL PRIVILEGES ON ${quoteIdent(options.database, dialect)}.* TO ${user};`);
    }
    return lines.join('\n');
  },

  setPassword(dialect: SqlDialect, name: string, password: string, host = '%'): string {
    return dialect === 'postgres'
      ? `ALTER ROLE ${quoteIdent(name, dialect)} WITH PASSWORD ${quoteLiteral(password, dialect)};`
      : `ALTER USER ${quoteLiteral(name, dialect)}@${quoteLiteral(host, dialect)} IDENTIFIED BY ${quoteLiteral(password, dialect)};`;
  },

  dropRole(dialect: SqlDialect, name: string, host = '%'): string {
    return dialect === 'postgres' ? `DROP ROLE ${quoteIdent(name, dialect)};` : `DROP USER ${quoteLiteral(name, dialect)}@${quoteLiteral(host, dialect)};`;
  },

  maintenance(dialect: SqlDialect, action: 'vacuum' | 'vacuum_full' | 'analyze' | 'reindex' | 'optimize' | 'check', schema: string | null, table: string): string {
    const target = qualifiedName(schema, table, dialect);
    switch (action) {
      case 'vacuum':
        return `VACUUM (ANALYZE) ${target};`;
      case 'vacuum_full':
        return `VACUUM (FULL, ANALYZE) ${target};`;
      case 'analyze':
        return dialect === 'postgres' ? `ANALYZE ${target};` : `ANALYZE TABLE ${target};`;
      case 'reindex':
        return `REINDEX TABLE ${target};`;
      case 'optimize':
        return `OPTIMIZE TABLE ${target};`;
      case 'check':
        return `CHECK TABLE ${target};`;
    }
  },
};

// ---------------------------------------------------------------------------
// Editor support
// ---------------------------------------------------------------------------

/** Keywords the editor colours and offers while typing. */
export const SQL_KEYWORDS = [
  'ADD', 'ALL', 'ALTER', 'ANALYZE', 'AND', 'ANY', 'AS', 'ASC', 'BEGIN', 'BETWEEN', 'BY', 'CASCADE', 'CASE', 'CAST', 'CHECK', 'COLUMN', 'COMMENT',
  'COMMIT', 'CONSTRAINT', 'CREATE', 'CROSS', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'DATABASE', 'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'ELSE',
  'END', 'ESCAPE', 'EXCEPT', 'EXISTS', 'EXPLAIN', 'FALSE', 'FETCH', 'FOREIGN', 'FROM', 'FULL', 'FUNCTION', 'GRANT', 'GROUP', 'HAVING', 'IF', 'ILIKE',
  'IN', 'INDEX', 'INNER', 'INSERT', 'INTERSECT', 'INTO', 'IS', 'JOIN', 'KEY', 'LATERAL', 'LEFT', 'LIKE', 'LIMIT', 'NOT', 'NULL', 'NULLS', 'OFFSET',
  'ON', 'OR', 'ORDER', 'OUTER', 'OVER', 'PARTITION', 'PRIMARY', 'PROCEDURE', 'REFERENCES', 'RENAME', 'REPLACE', 'RETURNING', 'REVOKE', 'RIGHT',
  'ROLLBACK', 'SCHEMA', 'SELECT', 'SET', 'SHOW', 'TABLE', 'THEN', 'TO', 'TRIGGER', 'TRUE', 'TRUNCATE', 'UNION', 'UNIQUE', 'UPDATE', 'USE', 'USING',
  'VALUES', 'VIEW', 'WHEN', 'WHERE', 'WINDOW', 'WITH',
] as const;

/** Function names the editor offers and colours. */
export const SQL_FUNCTIONS = [
  'avg', 'coalesce', 'concat', 'count', 'date_trunc', 'extract', 'greatest', 'least', 'length', 'lower', 'max', 'min', 'now', 'nullif', 'round',
  'row_number', 'string_agg', 'group_concat', 'json_agg', 'jsonb_build_object', 'json_object', 'substring', 'sum', 'trim', 'upper',
] as const;

export type SqlTokenKind = 'keyword' | 'string' | 'number' | 'comment' | 'identifier' | 'quoted' | 'operator' | 'function' | 'param' | 'space' | 'word';

export interface SqlToken {
  kind: SqlTokenKind;
  text: string;
}

const KEYWORD_SET = new Set<string>(SQL_KEYWORDS);
const EXTRA_KEYWORDS = new Set([
  'ABORT', 'ACTION', 'ADMIN', 'AFTER', 'AGGREGATE', 'ALWAYS', 'ARRAY', 'ATOMIC', 'AUTO_INCREMENT', 'BEFORE', 'BIGINT', 'BIGSERIAL', 'BINARY', 'BLOB', 'BOOLEAN',
  'BOTH', 'BUFFERS', 'CALL', 'CHAR', 'CHARACTER', 'CHARSET', 'CLUSTER', 'COLLATE', 'CONCURRENTLY', 'CONFLICT', 'COPY', 'COSTS', 'CURRENT', 'CURSOR',
  'CYCLE', 'DATE', 'DATETIME', 'DECIMAL', 'DECLARE', 'DEFERRABLE', 'DELIMITER', 'DO', 'DOUBLE', 'DUPLICATE', 'EACH', 'ENGINE', 'ENUM', 'EVENT', 'EXCLUDE',
  'EXECUTE', 'EXTENSION', 'FILTER', 'FIRST', 'FLOAT', 'FOLLOWING', 'FOR', 'FORMAT', 'GENERATED', 'IDENTITY', 'IGNORE', 'INCREMENT', 'INHERITS', 'INT',
  'INTEGER', 'INTERVAL', 'JSON', 'JSONB', 'LANGUAGE', 'LAST', 'LEVEL', 'LOCAL', 'LOCK', 'LONGTEXT', 'MATERIALIZED', 'MODIFY', 'NATURAL', 'NEXT', 'NO',
  'NOTHING', 'NUMERIC', 'OF', 'ONLY', 'OPTIMIZE', 'OWNED', 'OWNER', 'PASSWORD', 'PLAN', 'POLICY', 'PRECEDING', 'PRIVILEGES', 'RANGE', 'REAL', 'RECURSIVE',
  'REFRESH', 'REINDEX', 'RELEASE', 'RESTRICT', 'RETURN', 'RETURNS', 'ROLE', 'ROW', 'ROWS', 'SAVEPOINT', 'SEQUENCE', 'SERIAL', 'SESSION', 'SIGNED', 'SMALLINT',
  'START', 'STATEMENT', 'STORED', 'TABLES', 'TEMP', 'TEMPORARY', 'TEXT', 'TIES', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'TINYINT', 'TRANSACTION', 'TYPE',
  'UNBOUNDED', 'UNSIGNED', 'USER', 'UUID', 'VACUUM', 'VARCHAR', 'VERBOSE', 'VIRTUAL', 'WITHOUT', 'WORK', 'ZONE',
]);
const FUNCTION_SET = new Set<string>(SQL_FUNCTIONS);

/** Colour a line of SQL. Unterminated quotes and comments run to the end of the text. */
export function tokenizeSql(text: string, dialect: SqlDialect): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  const n = text.length;
  const push = (kind: SqlTokenKind, end: number): void => {
    tokens.push({ kind, text: text.slice(i, end) });
    i = end;
  };
  while (i < n) {
    const char = text[i]!;
    const next = text[i + 1];
    if (isSpace(char)) {
      let j = i;
      while (j < n && isSpace(text[j])) j += 1;
      push('space', j);
    } else if ((char === '-' && next === '-') || (dialect === 'mysql' && char === '#')) {
      const end = text.indexOf('\n', i);
      push('comment', end === -1 ? n : end);
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      push('comment', end === -1 ? n : end + 2);
    } else if (char === "'" || (dialect === 'mysql' && char === '"')) {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\' && dialect === 'mysql') j += 2;
        else if (text[j] === char && text[j + 1] === char) j += 2;
        else if (text[j] === char) {
          j += 1;
          break;
        } else j += 1;
      }
      push('string', Math.min(j, n));
    } else if (char === '"' || char === '`') {
      const end = text.indexOf(char, i + 1);
      push('quoted', end === -1 ? n : end + 1);
    } else if (dialect === 'postgres' && char === '$' && /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.test(text.slice(i, i + 64))) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64))![0];
      const end = text.indexOf(tag, i + tag.length);
      push('string', end === -1 ? n : end + tag.length);
    } else if ((char === '$' && /[0-9]/.test(next ?? '')) || (char === '?' && dialect === 'mysql') || (char === ':' && /[A-Za-z_]/.test(next ?? '') && text[i - 1] !== ':')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(text[j]!)) j += 1;
      push('param', j);
    } else if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(next ?? ''))) {
      let j = i;
      while (j < n && /[0-9a-fA-FxX._eE]/.test(text[j]!)) j += 1;
      push('number', j);
    } else if (isWordChar(char)) {
      let j = i;
      while (j < n && isWordChar(text[j])) j += 1;
      const word = text.slice(i, j);
      const upper = word.toUpperCase();
      let k = j;
      while (k < n && text[k] === ' ') k += 1;
      if (KEYWORD_SET.has(upper) || EXTRA_KEYWORDS.has(upper)) push('keyword', j);
      else if (text[j] === '(' || (text[k] === '(' && FUNCTION_SET.has(word.toLowerCase()))) push('function', j);
      else push('word', j);
    } else {
      push('operator', i + 1);
    }
  }
  return tokens;
}
