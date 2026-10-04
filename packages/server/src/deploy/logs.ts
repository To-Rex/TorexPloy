/**
 * Durable, live log files for deployments, cron runs and backups.
 *
 * Every line is appended to an NDJSON file *and* published on the event bus.
 * A dashboard that connects late replays the file and then follows the bus,
 * de-duplicating by sequence number, so no line is ever missed or doubled.
 *
 * Known secret values (environment variables, credentials) are masked before
 * a line is written anywhere.
 */
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { DeployStage, LogLine } from '@ploy/shared';
import type { EventBus } from '../realtime/bus.ts';

const MASK = '••••••';
/** Short values (e.g. "1", "true") would mask unrelated text; only mask values with real entropy. */
const MIN_MASK_LENGTH = 6;
const MAX_LINE = 8_000;

export type LogKind = 'deployments' | 'cron' | 'backups';

export function logPath(dataDir: string, kind: LogKind, id: string): string {
  return join(dataDir, 'logs', kind, `${id}.log`);
}

export class LogWriter {
  readonly key: string;
  private readonly stream: WriteStream;
  private readonly bus: EventBus;
  private seq = 0;
  private secrets: string[] = [];
  private closed = false;

  private constructor(key: string, stream: WriteStream, bus: EventBus) {
    this.key = key;
    this.stream = stream;
    this.bus = bus;
  }

  static async open(path: string, key: string, bus: EventBus): Promise<LogWriter> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const stream = createWriteStream(path, { flags: 'a', mode: 0o600 });
    // Swallow write errors (disk full): a failing log must never fail a deployment.
    stream.on('error', () => undefined);
    return new LogWriter(key, stream, bus);
  }

  /** Values to redact from every subsequent line. */
  mask(values: Iterable<string>): void {
    const next = new Set(this.secrets);
    for (const value of values) if (value.length >= MIN_MASK_LENGTH) next.add(value);
    // Longest first so a secret containing another secret is masked whole.
    this.secrets = [...next].sort((a, b) => b.length - a.length);
  }

  private redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) if (out.includes(secret)) out = out.split(secret).join(MASK);
    return out;
  }

  write(text: string, stream: LogLine['stream'] = 'system', stage?: DeployStage): void {
    if (this.closed) return;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      if (line.length === 0) continue;
      this.seq += 1;
      const entry: LogLine = { seq: this.seq, t: Date.now(), stream, text: this.redact(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line) };
      if (stage !== undefined) {
        entry.stage = stage;
        stage = undefined; // only the first line of a multi-line write opens the stage
      }
      this.stream.write(`${JSON.stringify(entry)}\n`);
      this.bus.log(this.key, entry);
    }
  }

  info(text: string): void {
    this.write(text, 'system');
  }

  /** A line that marks the start of a pipeline stage (drives the dashboard's pipeline view). */
  stage(stage: DeployStage, text: string): void {
    this.write(text, 'system', stage);
  }

  error(text: string): void {
    this.write(text, 'stderr');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.bus.log(this.key, null);
    await new Promise<void>((resolve) => this.stream.end(resolve));
  }
}

/** Read a log file back as lines (for replay). Missing files read as empty. */
export async function readLog(path: string, afterSeq = 0, limit = 50_000): Promise<LogLine[]> {
  try {
    await stat(path);
  } catch {
    return [];
  }
  const lines: LogLine[] = [];
  const reader = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const raw of reader) {
    if (raw.length === 0) continue;
    try {
      const line = JSON.parse(raw) as LogLine;
      if (line.seq > afterSeq) lines.push(line);
    } catch {
      // A torn final line (crash mid-write) is skipped.
    }
  }
  return lines.length > limit ? lines.slice(lines.length - limit) : lines;
}

export async function removeLog(path: string): Promise<void> {
  await rm(path, { force: true });
}
