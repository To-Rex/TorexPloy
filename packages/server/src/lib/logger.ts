/**
 * Structured logger.
 *
 * Emits one line per event: JSON in production (machine parseable, ready for
 * Loki/CloudWatch ingestion) and a compact colourless format in development.
 * Values under sensitive keys are redacted before serialization so credentials
 * never reach log storage.
 */
import { inspect } from 'node:util';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are replaced with a placeholder, matched case-insensitively. */
const REDACTED_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'privatekey',
  'private_key',
  'credential',
  'webhooksecret',
  'webhook_secret',
  'secretkey',
  'secret_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'clientsecret',
  'client_secret',
  'signature',
];

export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Derive a logger that attaches `bindings` to every line. */
  child(bindings: LogContext): Logger;
  /** True when `level` would produce output; avoids building context for dropped lines. */
  isEnabled(level: LogLevel): boolean;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Emit JSON lines instead of the compact development format. */
  json: boolean;
  /** Base fields merged into every record (e.g. service name, pid). */
  bindings?: LogContext;
  /** Destination for a finished line. Defaults to `process.stdout`/`process.stderr`. */
  write?: (line: string, level: LogLevel) => void;
}

function isRedactedKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-.]/g, '_');
  return REDACTED_KEYS.includes(normalized.replace(/_/g, ''));
}

/**
 * Deep-clone a value, replacing sensitive entries. Depth-limited and cycle-safe
 * so a hostile or deeply nested object cannot hang the logger.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8) return '[deep]';
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    };
    if (value.stack !== undefined) out.stack = value.stack;
    if (value.cause !== undefined) out.cause = redact(value.cause, depth + 1, seen);
    return out;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }

  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      out[String(k)] = isRedactedKey(String(k)) ? '[redacted]' : redact(v, depth + 1, seen);
    }
    return out;
  }

  if (value instanceof Set) {
    return [...value].map((item) => redact(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isRedactedKey(key) ? '[redacted]' : redact(val, depth + 1, seen);
  }
  return out;
}

/** Render a value for the compact format without dumping huge objects. */
function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return /\s/.test(value) ? JSON.stringify(value) : value;
  }
  if (value === undefined) return 'undefined';
  return inspect(value, { depth: 3, breakLength: Infinity, compact: true });
}

function defaultWrite(line: string, level: LogLevel): void {
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createLogger(options: LoggerOptions): Logger {
  const { level, json } = options;
  const bindings = options.bindings ?? {};
  const write = options.write ?? defaultWrite;
  const threshold = LEVEL_WEIGHT[level];

  const emit = (logLevel: LogLevel, message: string, context?: LogContext): void => {
    if (LEVEL_WEIGHT[logLevel] < threshold) return;

    const record: Record<string, unknown> = {
      level: logLevel,
      time: new Date().toISOString(),
      ...(redact(bindings) as Record<string, unknown>),
      msg: message,
    };
    if (context !== undefined) {
      Object.assign(record, redact(context) as Record<string, unknown>);
    }

    if (json) {
      let line: string;
      try {
        line = JSON.stringify(record);
      } catch {
        line = JSON.stringify({ level: logLevel, msg: message, context: '[unserializable]' });
      }
      write(line, logLevel);
      return;
    }

    const parts: string[] = [logLevel.toUpperCase().padEnd(5), message];
    for (const [key, value] of Object.entries(record)) {
      if (key === 'level' || key === 'time' || key === 'msg') continue;
      parts.push(`${key}=${formatValue(value)}`);
    }
    write(parts.join(' '), logLevel);
  };

  return {
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
    isEnabled: (candidate) => LEVEL_WEIGHT[candidate] >= threshold,
  };
}

/** Logger that discards everything; useful in tests and as a safe default. */
export function silentLogger(): Logger {
  return createLogger({ level: 'error', json: true, write: () => {} });
}