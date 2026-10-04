/**
 * A rough severity for a log line, read from the words apps conventionally
 * print and from HTTP status codes in access logs. Good enough to filter a
 * noisy stream down to what went wrong; never used for anything automatic.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'other';

const ERROR_RE = /\b(error|err|fatal|panic|exception|critical|crit|emerg|traceback|unhandled|failed|failure)\b|\s5\d{2}\s/i;
const WARN_RE = /\b(warn|warning|deprecated|retry|retrying|timeout|timed out)\b|\s4\d{2}\s/i;
const INFO_RE = /\b(info|notice|listening|started|ready|success|succeeded)\b|\s[23]\d{2}\s/i;
const DEBUG_RE = /\b(debug|trace|verbose)\b/i;

/** A level the logger itself printed, near the start of the line: `warn:`, `[INFO]`, `level=error`, `"level":"debug"`. */
const EXPLICIT_RE = /(?:^|[\s[("'=:])(error|fatal|critical|crit|emerg|warn|warning|info|notice|debug|trace)(?=[\s\]):"',]|$)/i;

export function logLevel(text: string): LogLevel {
  const explicit = EXPLICIT_RE.exec(text.slice(0, 40))?.[1]?.toLowerCase();
  if (explicit !== undefined) {
    if (explicit.startsWith('warn')) return 'warn';
    if (explicit === 'info' || explicit === 'notice') return 'info';
    if (explicit === 'debug' || explicit === 'trace') return 'debug';
    return 'error';
  }
  if (ERROR_RE.test(text)) return 'error';
  if (WARN_RE.test(text)) return 'warn';
  if (INFO_RE.test(text)) return 'info';
  if (DEBUG_RE.test(text)) return 'debug';
  return 'other';
}
