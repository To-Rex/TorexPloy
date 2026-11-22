/**
 * Table exports: CSV for spreadsheets, JSON for programs and SQL INSERT
 * statements for moving rows into another database of the same engine.
 */
import { qualifiedName, quoteIdent, quoteLiteral, type DbTableDto, type DbValueKind, type SqlDialect } from '@ploy/shared';

export type ExportFormat = 'csv' | 'json' | 'sql';

export function csvCell(value: string | null): string {
  if (value === null) return '';
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const NUMBER = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** A value as JSON: numbers stay numbers while JavaScript can hold them exactly, JSON columns are embedded. */
export function jsonValue(value: string | null, kind: DbValueKind): unknown {
  if (value === null) return null;
  if (kind === 'number' && NUMBER.test(value)) {
    const parsed = Number(value);
    // Keep a value as text when a JavaScript number would round it (bigint, numeric(30,20)).
    const digits = value.replace(/^-/, '').replace(/e.*$/i, '').replace('.', '').replace(/^0+/, '').length;
    if (Number.isFinite(parsed) && (Number.isInteger(parsed) ? Number.isSafeInteger(parsed) : digits <= 15)) return parsed;
    return value;
  }
  if (kind === 'boolean') {
    if (value === 't' || value === 'true' || value === '1') return true;
    if (value === 'f' || value === 'false' || value === '0') return false;
  }
  if (kind === 'json') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

export function sqlValue(value: string | null, kind: DbValueKind, dialect: SqlDialect): string {
  if (value === null) return 'NULL';
  if (kind === 'number' && NUMBER.test(value)) return value;
  if (kind === 'boolean' && dialect === 'postgres') return value === 't' || value === 'true' ? 'TRUE' : value === 'f' || value === 'false' ? 'FALSE' : quoteLiteral(value, dialect);
  if (kind === 'binary' && dialect === 'mysql' && /^0x([0-9a-f]{2})*$/i.test(value)) return value.length === 2 ? "''" : `X'${value.slice(2)}'`;
  return quoteLiteral(value, dialect);
}

export interface ExportWriter {
  head(): string;
  rows(columns: string[], rows: (string | null)[][]): string;
  tail(): string;
}

export function exportWriter(format: ExportFormat, table: DbTableDto, dialect: SqlDialect): ExportWriter {
  const kinds = new Map(table.columns.map((column) => [column.name, column.kind]));
  if (format === 'csv') {
    return {
      head: () => `${table.columns.map((column) => csvCell(column.name)).join(',')}\r\n`,
      rows: (_columns, rows) => rows.map((row) => `${row.map(csvCell).join(',')}\r\n`).join(''),
      tail: () => '',
    };
  }
  if (format === 'json') {
    let first = true;
    return {
      head: () => '[',
      rows: (columns, rows) =>
        rows
          .map((row) => {
            const entry = Object.fromEntries(columns.map((column, index) => [column, jsonValue(row[index] ?? null, kinds.get(column) ?? 'text')]));
            const text = `${first ? '\n' : ',\n'}  ${JSON.stringify(entry)}`;
            first = false;
            return text;
          })
          .join(''),
      tail: () => (first ? ']\n' : '\n]\n'),
    };
  }
  const target = dialect === 'postgres' ? qualifiedName(table.schema, table.name, dialect) : quoteIdent(table.name, dialect);
  return {
    head: () => `-- ${table.name}: exported by TorexPloy ${new Date().toISOString()}\n`,
    rows: (columns, rows) => {
      const list = columns.map((column) => quoteIdent(column, dialect)).join(', ');
      return rows.map((row) => `INSERT INTO ${target} (${list}) VALUES (${row.map((value, index) => sqlValue(value, kinds.get(columns[index]!) ?? 'text', dialect)).join(', ')});\n`).join('');
    },
    tail: () => '',
  };
}
