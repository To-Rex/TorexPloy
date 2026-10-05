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
  assert.throws(() => nextRunFor('0 0 * * *', at('2026-10-03T00:00:00Z'), 'Mars/Olympus'), CronError, 'unknown zone');
});

const inZone = (expr: string, from: string, zone: string): string => nextRunFor(expr, at(from), zone).toISOString();

test('schedules are evaluated on the wall clock of the instance time zone', () => {
  // 09:00 in Tashkent (UTC+5, no DST) is 04:00Z; the same expression in UTC fires five hours later.
  assert.equal(inZone('0 9 * * *', '2026-10-03T10:00:00Z', 'Asia/Tashkent'), '2026-10-04T04:00:00.000Z');
  assert.equal(inZone('0 9 * * *', '2026-10-03T10:00:00Z', 'UTC'), '2026-10-04T09:00:00.000Z');
  assert.equal(inZone('0 9 * * *', '2026-10-03T03:30:00Z', 'Asia/Tashkent'), '2026-10-03T04:00:00.000Z', 'later the same local day');
  assert.equal(nextRunFor('*/15 * * * *', at('2026-10-03T10:07:30Z')).toISOString(), inZone('*/15 * * * *', '2026-10-03T10:07:30Z', 'UTC'), 'omitted means UTC');

  // Weekdays are local: Monday 01:00 in Auckland (NZDT, +13) is still Sunday in UTC.
  assert.equal(inZone('0 1 * * mon', '2026-10-03T00:00:00Z', 'Pacific/Auckland'), '2026-10-04T12:00:00.000Z');
  assert.equal(inZone('30 2 * * mon-fri', '2026-10-03T12:00:00Z', 'Asia/Tashkent'), '2026-10-04T21:30:00.000Z', 'Mon Oct 5 02:30 +05');

  // Months: the 1st at midnight in New York during DST (EDT, -4), and strictly after a run that is exactly on the boundary.
  assert.equal(inZone('@monthly', '2026-10-03T00:00:00Z', 'America/New_York'), '2026-11-01T04:00:00.000Z');
  assert.equal(inZone('0 0 1 * *', '2026-10-31T18:59:00Z', 'Asia/Tashkent'), '2026-10-31T19:00:00.000Z');
  assert.equal(inZone('0 0 1 * *', '2026-10-31T19:00:00Z', 'Asia/Tashkent'), '2026-11-30T19:00:00.000Z');
  assert.equal(inZone('0 9 1 jan,jul *', '2026-10-03T00:00:00Z', 'Asia/Tashkent'), '2027-01-01T04:00:00.000Z');
  assert.equal(inZone('0 0 29 2 *', '2026-03-01T00:00:00Z', 'Asia/Tashkent'), '2028-02-28T19:00:00.000Z', 'leap day');

  // Vixie's rule: a minute or hour field that starts with `*` makes the job "wild" (it keeps its rhythm through DST changes).
  for (const expression of ['*/5 * * * *', '0 * * * *', '0 */2 * * *', '* 2 * * *', '@hourly']) assert.equal(parseCron(expression).frequent, true, expression);
  for (const expression of ['30 2 * * *', '0 0,12 * * *', '0 0 1 * *']) assert.equal(parseCron(expression).frequent, false, expression);
});

test('DST (Europe/Berlin): a fixed-time job runs right after a spring-forward gap and once in a fall-back hour', () => {
  const berlin = (expr: string, from: string): string => inZone(expr, from, 'Europe/Berlin');

  // 29 Mar 2026, 02:00 CET → 03:00 CEST (01:00Z): 02:30 never happens, so the job runs at 03:00 CEST, then at 02:30 CEST the next day.
  assert.equal(berlin('30 2 * * *', '2026-03-28T12:00:00Z'), '2026-03-29T01:00:00.000Z');
  assert.equal(berlin('30 2 * * *', '2026-03-29T00:30:00Z'), '2026-03-29T01:00:00.000Z', 'from 01:30 CET, through the minute steps');
  assert.equal(berlin('30 2 * * *', '2026-03-29T01:00:00Z'), '2026-03-30T00:30:00.000Z');
  assert.equal(berlin('0 4 * * *', '2026-03-29T00:30:00Z'), '2026-03-29T02:00:00.000Z', 'a job after the gap is unaffected');

  // 25 Oct 2026, 03:00 CEST → 02:00 CET (01:00Z): 02:30 happens twice; the job runs at the first one (00:30Z) and next at 02:30 CET the day after.
  assert.equal(berlin('30 2 * * *', '2026-10-24T12:00:00Z'), '2026-10-25T00:30:00.000Z');
  assert.equal(berlin('30 2 * * *', '2026-10-25T00:30:00Z'), '2026-10-26T01:30:00.000Z');
  assert.equal(berlin('59 2 * * *', '2026-10-25T00:59:00Z'), '2026-10-26T01:59:00.000Z', 'the last minute before the change does not slip into the repeat');
  assert.equal(berlin('30 3 * * *', '2026-10-25T00:30:00Z'), '2026-10-25T02:30:00.000Z', '03:30 CET follows the repeated hour');
  assert.equal(berlin('0 2 * * *', '2026-10-25T00:10:00Z'), '2026-10-26T01:00:00.000Z', 'a restart inside the first 02:00 hour does not rerun it');

  // Frequent jobs keep their rhythm: every 30 minutes ticks through the repeated hour and simply skips the missing one.
  assert.equal(berlin('*/30 * * * *', '2026-10-25T00:30:00Z'), '2026-10-25T01:00:00.000Z');
  assert.equal(berlin('*/30 * * * *', '2026-10-25T01:00:00Z'), '2026-10-25T01:30:00.000Z');
  assert.equal(berlin('@hourly', '2026-10-25T00:00:00Z'), '2026-10-25T01:00:00.000Z', 'hourly runs in both 02:00s');
  assert.equal(berlin('*/30 * * * *', '2026-03-29T00:30:00Z'), '2026-03-29T01:00:00.000Z');
  assert.equal(berlin('* 2 * * *', '2026-03-29T00:59:00Z'), '2026-03-30T00:00:00.000Z', 'every minute of a skipped hour: nothing to run until tomorrow');
});
