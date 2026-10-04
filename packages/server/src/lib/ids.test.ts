import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLUG_RE } from '@ploy/shared';
import { newId, randomId, slugify, uniqueSlug } from './ids.ts';

test('randomId is lowercase alphanumeric, exact length and unique', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2_000; i += 1) {
    const id = randomId(12);
    assert.match(id, /^[a-z0-9]{12}$/);
    seen.add(id);
  }
  assert.equal(seen.size, 2_000);
});

test('newId carries the entity prefix', () => {
  assert.match(newId('app'), /^app_[a-z0-9]{14}$/);
});

test('slugify produces DNS-safe slugs from real names, including Uzbek and Russian text', () => {
  assert.equal(slugify('My Project'), 'my-project');
  assert.equal(slugify('  TorexPloy__API  '), 'torexploy-api');
  assert.equal(slugify('Café Déjà Vu'), 'cafe-deja-vu');
  assert.equal(slugify('Oʻzbekiston gʻalaba'), 'ozbekiston-galaba');
  assert.equal(slugify('Магазин'), 'app', 'non-latin scripts fall back rather than producing an empty slug');
  assert.equal(slugify('!!!', 'project'), 'project');
  for (const input of ['a'.repeat(100), 'x-'.repeat(40), 'Hello World 2026', '-lead-trail-']) {
    assert.match(slugify(input), SLUG_RE, input);
  }
});

test('uniqueSlug appends the first free counter and stays within the slug limit', () => {
  const taken = new Set(['api', 'api-2']);
  assert.equal(uniqueSlug('api', (s) => taken.has(s)), 'api-3');
  assert.equal(uniqueSlug('web', (s) => taken.has(s)), 'web');
  const long = 'a'.repeat(40);
  const result = uniqueSlug(long, (s) => s === long);
  assert.match(result, SLUG_RE);
  assert.ok(result.endsWith('-2'));
});
