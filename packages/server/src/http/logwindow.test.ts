import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logWindow } from './core.ts';

test('the log window parses tail and since the way the dashboard sends them', () => {
  assert.deepEqual(logWindow(undefined, undefined), { tail: 300 });
  assert.deepEqual(logWindow('1000', undefined), { tail: 1000 });
  assert.deepEqual(logWindow('all', undefined), { tail: 'all' });
  // Bounded on both ends; garbage falls back to the default.
  assert.deepEqual(logWindow('999999', undefined), { tail: 10_000 });
  assert.deepEqual(logWindow('1', undefined), { tail: 10 });
  assert.deepEqual(logWindow('lots', undefined), { tail: 300 });

  const before = Math.floor(Date.now() / 1000);
  const { since } = logWindow('300', '3600');
  assert.ok(since !== undefined && since >= before - 3600 - 1 && since <= before - 3600 + 1, 'since is a unix timestamp an hour ago');
  assert.equal(logWindow('300', '0').since, undefined);
  assert.equal(logWindow('300', '-5').since, undefined);
  assert.equal(logWindow('300', 'yesterday').since, undefined);
  // Never further back than Docker keeps logs anyway.
  assert.ok(logWindow('300', String(365 * 24 * 3600)).since! >= before - 30 * 24 * 3600 - 1);
});
