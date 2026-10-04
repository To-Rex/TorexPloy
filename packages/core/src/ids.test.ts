import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  containerSlug,
  isValidHost,
  isValidHostname,
  isValidSlug,
  newId,
  randomId,
  sanitizeContainerName,
  slugify,
  uuid,
} from './ids.ts';

test('randomId is URL-safe, lowercase and unique enough to be usable as a token', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 500; i += 1) {
    const id = randomId(16);
    assert.equal(id.length, 16);
    assert.match(id, /^[a-z0-9]+$/);
    ids.add(id);
  }
  assert.equal(ids.size, 500, 'no collisions across 500 generated ids');
});

test('newId is prefixed with the entity type', () => {
  const id = newId('app');
  assert.match(id, /^app_[a-z0-9]{12}$/);
});

test('uuid returns a v4 identifier', () => {
  assert.match(uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('slugify normalizes real-world repository and project names', () => {
  assert.equal(slugify('My Project'), 'my-project');
  // CamelCase is flattened, not split: this matches GitHub/Vercel slug behaviour.
  assert.equal(slugify('  TorexPloy__API  '), 'torexploy-api');
  assert.equal(slugify('Café Déjà Vu'), 'cafe-deja-vu');
  assert.equal(slugify('a---b'), 'a-b');
  assert.equal(slugify('!!!'), 'item');
  assert.equal(slugify('Ünïcödé/Repo', 'fallback'), 'unicode-repo');
  assert.equal(slugify(''), 'item');
  assert.equal(slugify('x'.repeat(200)).length, 48);
});

test('containerSlug produces a docker/network-safe fragment', () => {
  assert.equal(containerSlug('My Cool App'), 'mycoolapp');
  assert.equal(containerSlug('!!!'), 'app');
  assert.ok(containerSlug('a'.repeat(100)).length <= 24);
});

test('isValidSlug accepts DNS-style names and rejects the rest', () => {
  assert.equal(isValidSlug('my-app'), true);
  assert.equal(isValidSlug('app2'), true);
  assert.equal(isValidSlug('a'), true);
  assert.equal(isValidSlug('-leading'), false);
  assert.equal(isValidSlug('trailing-'), false);
  assert.equal(isValidSlug('Uppercase'), false);
  assert.equal(isValidSlug('has space'), false);
  assert.equal(isValidSlug(''), false);
  assert.equal(isValidSlug('a'.repeat(49)), false);
});

test('isValidHostname enforces DNS rules for custom domains', () => {
  assert.equal(isValidHostname('app.example.com'), true);
  assert.equal(isValidHostname('a.b.co'), true);
  assert.equal(isValidHostname('deep.sub.domain.example.io'), true);
  assert.equal(isValidHostname('example'), false, 'bare labels are not public hostnames');
  assert.equal(isValidHostname('http://example.com'), false);
  assert.equal(isValidHostname('example.com/path'), false);
  assert.equal(isValidHostname('example..com'), false);
  assert.equal(isValidHostname('-bad.com'), false);
  assert.equal(isValidHostname('bad-.com'), false);
  assert.equal(isValidHostname(`${'a'.repeat(64)}.com`), false);
});

test('isValidHost accepts IPv4, IPv6 and localhost for server addresses', () => {
  assert.equal(isValidHost('127.0.0.1'), true);
  assert.equal(isValidHost('10.0.0.5'), true);
  assert.equal(isValidHost('localhost'), true);
  assert.equal(isValidHost('vps.example.com'), true);
  assert.equal(isValidHost('::1'), true);
  assert.equal(isValidHost('2001:db8::1'), true);
  assert.equal(isValidHost('256.1.1.1'), false);
  assert.equal(isValidHost('999.999.999.999'), false);
  assert.equal(isValidHost('host with space'), false);
  assert.equal(isValidHost(''), false);
});

test('sanitizeContainerName always yields a name Docker will accept', () => {
  assert.equal(sanitizeContainerName('app/../etc'), 'app-..-etc');
  assert.equal(sanitizeContainerName('My App!'), 'My-App-');
  assert.equal(sanitizeContainerName('--bad'), 'bad');
  assert.equal(sanitizeContainerName('!!!'), 'container');
  assert.ok(sanitizeContainerName('a'.repeat(200)).length <= 63);
});