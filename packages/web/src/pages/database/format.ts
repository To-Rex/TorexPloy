/** How the console shows values, types and results. */
import type { DbCell, DbColumnMetaDto, DbValueKind } from '@ploy/shared';

/** A short glyph for a column's kind, shown in grid headers and the tree. */
export const KIND_GLYPH: Record<DbValueKind, string> = {
  number: '#',
  boolean: '◐',
  text: 'Aa',
  json: '{}',
  date: '▦',
  time: '◷',
  datetime: '◷',
  binary: '01',
  uuid: 'id',
  array: '[]',
  enum: '≡',
  other: '·',
};

export const isRightAligned = (kind: DbValueKind): boolean => kind === 'number';

/** One line of a value for a grid cell. */
export function cellPreview(value: DbCell, max = 240): string {
  if (value === null) return 'NULL';
  const flat = value.length > max ? `${value.slice(0, max)}…` : value;
  return flat.replace(/\r?\n/g, ' ⏎ ').replace(/\t/g, ' ');
}

/** JSON values pretty-printed for the value viewer; everything else as is. */
export function prettyValue(value: DbCell, kind: DbValueKind): string {
  if (value === null) return '';
  if (kind === 'json') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return value;
}

/** Whether a boolean cell is true, false or something else. */
export function booleanOf(value: DbCell): boolean | null {
  if (value === null) return null;
  if (value === 't' || value === 'true' || value === '1') return true;
  if (value === 'f' || value === 'false' || value === '0') return false;
  return null;
}

const CSV_SPECIAL = /[",\r\n]|^\s|\s$/;

export function toCsv(columns: DbColumnMetaDto[], rows: DbCell[][]): string {
  const cell = (value: DbCell) => (value === null ? '' : CSV_SPECIAL.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return [columns.map((column) => cell(column.name)).join(','), ...rows.map((row) => row.map(cell).join(','))].join('\r\n') + '\r\n';
}

export function toJson(columns: DbColumnMetaDto[], rows: DbCell[][]): string {
  return JSON.stringify(
    rows.map((row) => Object.fromEntries(columns.map((column, index) => [column.name, row[index] ?? null]))),
    null,
    2,
  );
}

/** Tab-separated, for pasting into a spreadsheet. */
export function toTsv(columns: DbColumnMetaDto[], rows: DbCell[][], header = true): string {
  const cell = (value: DbCell) => (value ?? '').replace(/[\t\r\n]+/g, ' ');
  const lines = rows.map((row) => row.map(cell).join('\t'));
  return (header ? [columns.map((column) => column.name).join('\t'), ...lines] : lines).join('\n');
}

/** Width a column starts with: enough for its name and its typical value, within reason. */
export function initialWidth(column: DbColumnMetaDto, rows: DbCell[][], index: number): number {
  let longest = Math.max(column.name.length + 3, column.type.length * 0.8);
  for (let row = 0; row < Math.min(rows.length, 60); row += 1) {
    const value = rows[row]?.[index];
    longest = Math.max(longest, value === null || value === undefined ? 4 : Math.min(value.length, 60));
  }
  return Math.round(Math.min(380, Math.max(column.kind === 'boolean' ? 96 : 92, longest * 7.6 + 26)));
}

/** "12 ms", "1.4 s", "2 min 3 s". */
export function formatMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1_000)} s`;
}
