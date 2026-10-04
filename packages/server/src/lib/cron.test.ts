import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CronError, nextRunFor, parseCron } from './cron.ts';

const at = (iso: string): Date => new Date(iso);
const next = (expr: string, from: string): string => nextRunFor(expr, at(from)).toISOString();

test('common schedules resolve to the right next minute (UTC)', () => {
  assert.equal(next('*/15 * * * *', '2026-10-03T10:07:30Z'), '2026-10-03T10:15:00.000Z');
  assert.equal(next('0 * * * *', '2026-10-03T10:00:00Z'), '2026-10-03T11:00:00.000Z', 'strictly after');
  assert.equal(next('@daily', '2026-10-03T23:59:00Z'), '2026-10-04T00:00:00.000Z');
  assert.equal(next('30 2 * * mon-fri', '2026-10-03T12:00:00Z'), '2026-10-05T02:30:00.000Z', 'Oct 3 2026 is a Saturday');
  assert.equal(next('0 9 1 jan,jul *', '2026-10-03T00:00:00Z'), '2027-01-01T09:00:00.000Z');
  assert.equal(next('0 0 29 2 *', '2026-03-01T00:00:00Z'), '2028-02-29T00:00:00.000Z', 'leap day');
  assert.equal(next('5-10/5 4 * * 7', '2026-10-03T00:00:00Z'), '2026-10-04T04:05:00.000Z', '7 means Sunday');
});

test('day-of-month and day-of-week combine with OR when both are set', () => {
  // The 13th, or any Friday: from Thu Oct 8 2026 the next is Fri Oct 9.
  assert.equal(next('0 0 13 * fri', '2026-10-08T00:00:00Z'), '2026-10-09T00:00:00.000Z');
});

test('invalid expressions are rejected with a clear error', () => {
  for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '*/0 * * * *', '5-1 * * * *', 'a b c d e']) {
    assert.throws(() => parseCron(bad), CronError, bad);
  }
});
