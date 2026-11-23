/**
 * What the command line looks like: colour when a person is watching (never
 * in a pipe, never with NO_COLOR), tables that fit the terminal, a spinner on
 * stderr, and questions answered on the keyboard.
 */
import { createInterface } from 'node:readline/promises';

let colour = process.stdout.isTTY === true && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';

export function setColour(on: boolean): void {
  colour = on;
}

const paint =
  (open: number, close: number) =>
  (text: string): string =>
    colour ? `\x1b[${open}m${text}\x1b[${close}m` : text;

export const c = {
  bold: paint(1, 22),
  dim: paint(2, 22),
  red: paint(31, 39),
  green: paint(32, 39),
  yellow: paint(33, 39),
  blue: paint(34, 39),
  magenta: paint(35, 39),
  cyan: paint(36, 39),
  gray: paint(90, 39),
};

/** Ends with a status a person reads at a glance. */
export function status(value: string): string {
  if (['running', 'succeeded', 'ready', 'active', 'done', 'ok'].includes(value)) return c.green(value);
  if (['failed', 'error', 'crashed', 'offline', 'cancelled', 'rejected'].includes(value)) return c.red(value);
  if (['building', 'deploying', 'queued', 'provisioning', 'restarting', 'connecting', 'pending', 'running…'].includes(value)) return c.yellow(value);
  return c.gray(value);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export function visibleLength(text: string): number {
  return text.replace(ANSI, '').length;
}

function fit(text: string, width: number): string {
  const plain = text.replace(ANSI, '');
  if (plain.length <= width) return text + ' '.repeat(width - plain.length);
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

/** Rows under headers, columns as wide as they need to be; the last column gives way when the terminal is narrow. */
export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths = headers.map((header, column) => Math.max(visibleLength(header), ...rows.map((row) => visibleLength(row[column] ?? ''))));
  const total = process.stdout.columns ?? 120;
  const used = widths.slice(0, -1).reduce((sum, width) => sum + width + 2, 0);
  widths[widths.length - 1] = Math.max(8, Math.min(widths[widths.length - 1]!, total - used));
  const line = (cells: string[]) =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? (visibleLength(cell) > widths[column]! ? fit(cell, widths[column]!) : cell) : fit(cell, widths[column]!)))
      .join('  ')
      .trimEnd();
  return [line(headers.map((header) => c.dim(header))), ...rows.map(line)].join('\n');
}

export function relative(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return '—';
  const ago = seconds >= 0;
  const s = Math.abs(seconds);
  const text = s < 60 ? `${s}s` : s < 3_600 ? `${Math.round(s / 60)}m` : s < 86_400 ? `${Math.round(s / 3_600)}h` : `${Math.round(s / 86_400)}d`;
  return ago ? `${text} ago` : `in ${text}`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** A spinner on stderr while something takes a moment; nothing at all when stderr is not a terminal. */
export function spinner(text: string): { update: (next: string) => void; stop: (final?: string) => void } {
  if (process.stderr.isTTY !== true) {
    return { update: () => undefined, stop: (final) => (final === undefined ? undefined : void process.stderr.write(`${final}\n`)) };
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let index = 0;
  let current = text;
  const draw = () => process.stderr.write(`\r\x1b[2K${c.cyan(frames[index % frames.length]!)} ${current}`);
  draw();
  const timer = setInterval(() => {
    index += 1;
    draw();
  }, 90);
  return {
    update: (next) => {
      current = next;
      draw();
    },
    stop: (final) => {
      clearInterval(timer);
      process.stderr.write('\r\x1b[2K');
      if (final !== undefined) process.stderr.write(`${final}\n`);
    },
  };
}

export function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export async function ask(question: string, fallback = ''): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await reader.question(question)).trim();
    return answer.length > 0 ? answer : fallback;
  } finally {
    reader.close();
  }
}

export async function confirm(question: string, fallback = false): Promise<boolean> {
  if (!interactive()) return fallback;
  const answer = (await ask(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  if (answer.length === 0) return fallback;
  return answer === 'y' || answer === 'yes' || answer === 'ha';
}

/** Pick one of a few things by number. */
export async function choose<T>(question: string, options: { label: string; value: T }[]): Promise<T> {
  if (options.length === 1) return options[0]!.value;
  process.stderr.write(`${question}\n`);
  options.forEach((option, index) => process.stderr.write(`  ${c.cyan(String(index + 1).padStart(2))}  ${option.label}\n`));
  for (;;) {
    const answer = Number(await ask(`Number (1-${options.length}): `));
    if (Number.isInteger(answer) && answer >= 1 && answer <= options.length) return options[answer - 1]!.value;
  }
}

export function out(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function note(text: string): void {
  process.stderr.write(`${text}\n`);
}

export function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** A failure the person can act on: printed without a stack trace, with an exit code. */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}
