/**
 * `.env` text, as people paste it: `KEY=value` lines with optional `export`,
 * quotes and comments. Shared so the dashboard's editor and the API read the
 * same text the same way.
 *
 * The text is more than its variables: comments explain them, and a line
 * commented out (`# DEBUG=1`) is a variable switched off for now. So the
 * text itself is kept (see `mergeDotenv`), and the variables are what it
 * says at the moment.
 */
import { ENV_KEY_RE } from './constants.ts';

export interface DotenvVariable {
  key: string;
  value: string;
}

const ASSIGNMENT_RE = /^(export\s+)?([^=\s]+)\s*=\s*(.*)$/;
/** A comment that would be a variable without its `#`. */
const DISABLED_RE = /^#\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

/** After a closing quote: nothing, or a comment. */
const AFTER_QUOTE_RE = /^\s*(#.*)?$/;

/** The value a `KEY=…` right-hand side stands for. */
function readValue(source: string): string {
  const quote = source[0];
  if (source.length >= 2 && (quote === '"' || quote === "'")) {
    // Where the quote that was opened closes: the first one not escaped (single quotes take no escapes).
    let close = -1;
    for (let index = 1; index < source.length; index += 1) {
      if (quote === '"' && source[index] === '\\') index += 1;
      else if (source[index] === quote) {
        close = index;
        break;
      }
    }
    // `KEY="value" # why` is a quoted value with a comment after it. Anything else that merely starts and ends
    // with the quote (`'it's'`) is taken whole, as it always was.
    const end = close !== -1 && AFTER_QUOTE_RE.test(source.slice(close + 1)) ? close : source.endsWith(quote) ? source.length - 1 : -1;
    if (end !== -1) {
      const inner = source.slice(1, end);
      // Double quotes take escapes; an unknown one keeps its backslash (`\d` stays `\d`).
      return quote === '"' ? inner.replace(/\\(.)/g, (whole, char: string) => ESCAPES[char] ?? whole) : inner;
    }
  }
  return source.replace(/\s+#.*$/, '');
}

/** How a value is written so that reading it back gives the same value. */
function writeValue(value: string): string {
  if (value.length > 0 && !/[\s#"']/.test(value)) return value;
  // Single quotes are literal: nothing inside them needs escaping, as long as it is one line without a quote of its own.
  if (!/['\n\r\t]/.test(value) && value.length > 0) return `'${value}'`;
  return `"${value.replace(/[\\"\n\r\t]/g, (char) => (char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\t' ? '\\t' : `\\${char}`))}"`;
}

/** Parse `.env` text; a repeated key keeps its last value. `badLine` is the first line that is not `KEY=value` (1-based). */
export function parseDotenv(text: string): { variables: DotenvVariable[]; badLine: number | null } {
  const variables: DotenvVariable[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!.trim();
    if (raw.length === 0 || raw.startsWith('#')) continue;
    const match = ASSIGNMENT_RE.exec(raw);
    if (match === null || !ENV_KEY_RE.test(match[2]!)) return { variables, badLine: index + 1 };
    const key = match[2]!;
    const existing = variables.findIndex((variable) => variable.key === key);
    if (existing !== -1) variables.splice(existing, 1);
    variables.push({ key, value: readValue(match[3]!) });
  }
  return { variables, badLine: null };
}

/** Variables as `.env` text that `parseDotenv` reads back to the same variables. */
export function toDotenv(variables: readonly DotenvVariable[]): string {
  return variables.map(({ key, value }) => `${key}=${writeValue(value)}`).join('\n');
}

export type DotenvLineKind = 'blank' | 'comment' | 'disabled' | 'assign' | 'bad';

export interface DotenvLine {
  kind: DotenvLineKind;
  /** The variable an `assign` sets, or the one a `disabled` line would set. */
  key: string | null;
  /** An `assign` whose key is set again further down: this line has no effect. */
  shadowed: boolean;
}

/** What each line of `.env` text is, for an editor to draw and count. */
export function analyzeDotenv(text: string): { lines: DotenvLine[]; variables: number; comments: number; disabled: number; badLine: number | null } {
  const lines: DotenvLine[] = text.split(/\r?\n/).map((source) => {
    const raw = source.trim();
    if (raw.length === 0) return { kind: 'blank', key: null, shadowed: false };
    if (raw.startsWith('#')) {
      const off = DISABLED_RE.exec(raw);
      return off === null ? { kind: 'comment', key: null, shadowed: false } : { kind: 'disabled', key: off[1]!, shadowed: false };
    }
    const match = ASSIGNMENT_RE.exec(raw);
    if (match === null || !ENV_KEY_RE.test(match[2]!)) return { kind: 'bad', key: null, shadowed: false };
    return { kind: 'assign', key: match[2]!, shadowed: false };
  });
  const last = new Map<string, number>();
  lines.forEach((line, index) => {
    if (line.kind === 'assign') last.set(line.key!, index);
  });
  lines.forEach((line, index) => {
    if (line.kind === 'assign' && last.get(line.key!) !== index) line.shadowed = true;
  });
  const bad = lines.findIndex((line) => line.kind === 'bad');
  return {
    lines,
    variables: last.size,
    comments: lines.filter((line) => line.kind === 'comment').length,
    disabled: lines.filter((line) => line.kind === 'disabled').length,
    badLine: bad === -1 ? null : bad + 1,
  };
}

/**
 * Bring `.env` text up to date with a set of variables, keeping everything
 * else it says: comments, blank lines, switched-off variables, the order and
 * the way each untouched line was written. A variable whose value changed
 * has its line rewritten, one that is gone loses its line, and new ones are
 * added at the end. The result parses to exactly `variables` (in the text's
 * order for those it already had).
 */
export function mergeDotenv(text: string, variables: readonly DotenvVariable[]): string {
  const wanted = new Map(variables.map((variable) => [variable.key, variable.value]));
  const source = text.split(/\r?\n/);
  const { lines } = analyzeDotenv(text);
  const kept: string[] = [];
  const written = new Set<string>();
  source.forEach((line, index) => {
    const info = lines[index]!;
    if (info.kind === 'bad') return;
    if (info.kind !== 'assign') {
      kept.push(line);
      return;
    }
    const key = info.key!;
    // A line overridden further down said nothing; a variable that is gone takes its line with it.
    if (info.shadowed || !wanted.has(key)) return;
    const match = ASSIGNMENT_RE.exec(line.trim())!;
    const value = wanted.get(key)!;
    kept.push(readValue(match[3]!) === value ? line : `${match[1] === undefined ? '' : 'export '}${key}=${writeValue(value)}`);
    written.add(key);
  });
  const added = variables.filter((variable) => !written.has(variable.key));
  // New variables go after the text, with no blank line left dangling between.
  while (added.length > 0 && kept.length > 0 && kept[kept.length - 1]!.trim().length === 0) kept.pop();
  for (const variable of added) kept.push(`${variable.key}=${writeValue(variable.value)}`);
  return kept.join('\n');
}

/** Whether two variable lists are the same variables in the same order. */
export function sameVariables(a: readonly DotenvVariable[], b: readonly DotenvVariable[]): boolean {
  return a.length === b.length && a.every((item, index) => item.key === b[index]!.key && item.value === b[index]!.value);
}
