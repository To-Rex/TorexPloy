import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, redact, silentLogger } from './logger.ts';
import type { LogLevel } from './config.ts';

interface Captured {
  line: string;
  level: LogLevel;
}

function captureLogger(level: LogLevel = 'debug', json = true, bindings?: Record<string, unknown>) {
  const lines: Captured[] = [];
  const logger = createLogger({
    level,
    json,
    ...(bindings === undefined ? {} : { bindings }),
    write: (line, lvl) => lines.push({ line, level: lvl }),
  });
  return { logger, lines };
}

test('emits parseable JSON lines with level, time and message', () => {
  const { logger, lines } = captureLogger();
  logger.info('deployment started', { deploymentId: 'dep_1' });

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!.line) as Record<string, unknown>;
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'deployment started');
  assert.equal(parsed.deploymentId, 'dep_1');
  assert.ok(typeof parsed.time === 'string' && !Number.isNaN(Date.parse(parsed.time as string)));
});

test('drops records below the configured level', () => {
  const { logger, lines } = captureLogger('warn');
  logger.debug('dropped');
  logger.info('dropped');
  logger.warn('kept');
  logger.error('kept too');

  assert.deepEqual(lines.map((l) => l.level), ['warn', 'error']);
  assert.equal(logger.isEnabled('debug'), false);
  assert.equal(logger.isEnabled('error'), true);
});

test('redacts sensitive values at any nesting depth', () => {
  const { logger, lines } = captureLogger();
  logger.info('github oauth', {
    user: 'torex',
    accessToken: 'gho_supersecret',
    nested: { webhookSecret: 'whsec_1', ok: true },
    list: [{ password: 'p' }],
  });

  const parsed = JSON.parse(lines[0]!.line) as Record<string, unknown>;
  assert.equal(parsed.accessToken, '[redacted]');
  assert.deepEqual(parsed.nested, { webhookSecret: '[redacted]', ok: true });
  assert.deepEqual(parsed.list, [{ password: '[redacted]' }]);
  assert.ok(!lines[0]!.line.includes('gho_supersecret'), 'secret must not appear in the raw line');
  assert.ok(!lines[0]!.line.includes('whsec_1'), 'secret must not appear in the raw line');
});

test('redacts case-insensitively and across separator styles', () => {
  const redacted = redact({
    Authorization: 'Bearer abc',
    'api-key': 'k',
    API_KEY: 'k2',
    client_secret: 'cs',
    harmless: 'visible',
  }) as Record<string, unknown>;

  assert.equal(redacted.Authorization, '[redacted]');
  assert.equal(redacted['api-key'], '[redacted]');
  assert.equal(redacted.API_KEY, '[redacted]');
  assert.equal(redacted.client_secret, '[redacted]');
  assert.equal(redacted.harmless, 'visible');
});

test('redaction survives circular references and deep nesting', () => {
  const circular: Record<string, unknown> = { name: 'root' };
  circular.self = circular;

  const result = redact(circular) as Record<string, unknown>;
  assert.equal(result.name, 'root');
  assert.equal(result.self, '[circular]');

  let deep: Record<string, unknown> = { token: 'secret' };
  for (let i = 0; i < 20; i += 1) deep = { child: deep };
  assert.doesNotThrow(() => redact(deep));
});

test('redact serializes Error instances with their cause', () => {
  const cause = new Error('root cause');
  const error = new Error('wrapper', { cause });
  const result = redact({ err: error }) as { err: Record<string, unknown> };

  assert.equal(result.err.name, 'Error');
  assert.equal(result.err.message, 'wrapper');
  assert.deepEqual(result.err.cause, {
    name: 'Error',
    message: 'root cause',
    stack: (cause.stack ?? '') as string,
  });
});

test('child loggers merge bindings and inherit the parent level', () => {
  const { logger, lines } = captureLogger('info', true, { service: 'ploy-server' });
  const child = logger.child({ deploymentId: 'dep_9' });
  child.info('built');

  const parsed = JSON.parse(lines[0]!.line) as Record<string, unknown>;
  assert.equal(parsed.service, 'ploy-server');
  assert.equal(parsed.deploymentId, 'dep_9');
  assert.equal(child.isEnabled('debug'), false);
});

test('the compact format stays single-line and readable', () => {
  const { logger, lines } = captureLogger('debug', false);
  logger.warn('build slow', { seconds: 42, note: 'two words' });

  assert.equal(lines.length, 1);
  const line = lines[0]!.line;
  assert.ok(!line.includes('\n'));
  assert.ok(line.startsWith('WARN '));
  assert.ok(line.includes('build slow'));
  assert.ok(line.includes('seconds=42'));
  assert.ok(line.includes('note="two words"'));
});

test('silentLogger produces no output and never throws', () => {
  const logger = silentLogger();
  assert.doesNotThrow(() => {
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
  });
});

test('unserializable context falls back to a valid JSON line', () => {
  const { logger, lines } = captureLogger();
  const context: Record<string, unknown> = {};
  context.big = 10n; // BigInt cannot be JSON.stringify-ed
  logger.info('edge case', context);

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!.line) as Record<string, unknown>;
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'edge case');
  assert.equal(parsed.context, '[unserializable]');
});