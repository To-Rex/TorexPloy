import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  constantTimeEqual,
  decryptSecret,
  encryptSecret,
  generateToken,
  hashPassword,
  hmac,
  isEncryptedSecret,
  sha256,
  verifyHmac,
  verifyPassword,
} from './crypto.ts';

const MASTER_KEY = 'test-master-key-that-is-definitely-long-enough-1234';

test('hashPassword produces a self-describing scrypt digest with a unique salt', () => {
  const a = hashPassword('correct horse battery staple');
  const b = hashPassword('correct horse battery staple');

  assert.match(a, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.notEqual(a, b, 'each hash must use a fresh salt');
  assert.ok(!a.includes('correct horse'), 'the plaintext must never appear in the digest');
});

test('verifyPassword accepts the right password and rejects everything else', () => {
  const digest = hashPassword('s3cret-password');
  assert.equal(verifyPassword('s3cret-password', digest), true);
  assert.equal(verifyPassword('s3cret-passwore', digest), false);
  assert.equal(verifyPassword('', digest), false);
  assert.equal(verifyPassword('S3cret-Password', digest), false, 'comparison is case sensitive');
});

test('verifyPassword normalizes Unicode so the same password matches across input methods', () => {
  const digest = hashPassword('pa\u0301ssword'); // decomposed "á"
  assert.equal(verifyPassword('p\u00e1ssword', digest), true); // precomposed
});

test('verifyPassword rejects malformed or hostile digests instead of throwing', () => {
  for (const bad of ['', 'not-a-hash', 'scrypt$x$y$z$a$b', 'scrypt$16384$8$1$onlyfive', 'bcrypt$1$2$3$4$5']) {
    assert.equal(verifyPassword('whatever', bad), false, `expected rejection for ${JSON.stringify(bad)}`);
  }
  // A hostile N would otherwise be an easy denial-of-service vector.
  assert.equal(verifyPassword('x', 'scrypt$99999999999$8$1$AAAA$AAAA'), false);
});

test('hashPassword refuses trivially short passwords', () => {
  assert.throws(() => hashPassword('short'), /at least 8 characters/);
});

test('constantTimeEqual compares correctly, including empty and multi-byte values', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual('', 'a'), false);
  assert.equal(constantTimeEqual('ünïcödé', 'ünïcödé'), true);
});

test('generateToken returns high-entropy URL-safe tokens', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const token = generateToken();
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.ok(token.length >= 40);
    seen.add(token);
  }
  assert.equal(seen.size, 200);
});

test('sha256 is stable and hex encoded', () => {
  assert.equal(sha256('hello'), sha256('hello'));
  assert.match(sha256('hello'), /^[0-9a-f]{64}$/);
  assert.notEqual(sha256('hello'), sha256('hello '));
});

test('verifyHmac accepts GitHub-style sha256= prefixed signatures', () => {
  const secret = 'webhook-secret';
  const payload = JSON.stringify({ action: 'push' });
  const signature = hmac(secret, payload);

  assert.equal(verifyHmac(secret, payload, signature), true);
  assert.equal(verifyHmac(secret, payload, `sha256=${signature}`), true);
  assert.equal(verifyHmac(secret, payload, 'sha256=deadbeef'), false);
  assert.equal(verifyHmac('other-secret', payload, signature), false);
  assert.equal(verifyHmac(secret, `${payload} `, signature), false, 'payload tampering must fail');
});

test('encryptSecret round-trips arbitrary UTF-8 values', () => {
  for (const value of ['', 'simple', 'with spaces and "quotes"', 'ünïcödé 🔐', 'multi\nline\nvalue']) {
    const encrypted = encryptSecret(value, MASTER_KEY);
    assert.equal(decryptSecret(encrypted, MASTER_KEY), value);
  }
});

test('encryptSecret never produces the same ciphertext twice (fresh nonce)', () => {
  const a = encryptSecret('same-value', MASTER_KEY);
  const b = encryptSecret('same-value', MASTER_KEY);
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a, MASTER_KEY), 'same-value');
  assert.equal(decryptSecret(b, MASTER_KEY), 'same-value');
});

test('ciphertext is opaque: the plaintext does not appear in the stored value', () => {
  const encrypted = encryptSecret('postgres://user:pw@host/db', MASTER_KEY);
  assert.ok(!encrypted.includes('postgres'));
  assert.ok(!encrypted.includes('user'));
  assert.equal(isEncryptedSecret(encrypted), true);
  assert.equal(isEncryptedSecret('postgres://user:pw@host/db'), false);
});

test('tampering with any ciphertext segment is detected', () => {
  const encrypted = encryptSecret('sensitive', MASTER_KEY);
  const parts = encrypted.split('.');

  // Flip the payload.
  const badData = [...parts];
  badData[4] = Buffer.from('tampered!!').toString('base64url');
  assert.throws(() => decryptSecret(badData.join('.'), MASTER_KEY), /authentication failed/);

  // Flip the auth tag.
  const badTag = [...parts];
  badTag[3] = Buffer.from('0123456789abcdef').toString('base64url');
  assert.throws(() => decryptSecret(badTag.join('.'), MASTER_KEY), /authentication failed/);

  // Truncate the ciphertext entirely.
  const emptyData = [...parts];
  emptyData[4] = '';
  assert.throws(() => decryptSecret(emptyData.join('.'), MASTER_KEY));
});

test('a different master key cannot decrypt the value', () => {
  const encrypted = encryptSecret('secret', MASTER_KEY);
  assert.throws(
    () => decryptSecret(encrypted, 'a-completely-different-master-key-000000'),
    /authentication failed/,
  );
});

test('purpose separation prevents cross-subsystem decryption', () => {
  const forEnv = encryptSecret('db-password', MASTER_KEY, 'env');
  assert.equal(decryptSecret(forEnv, MASTER_KEY, 'env'), 'db-password');
  assert.throws(() => decryptSecret(forEnv, MASTER_KEY, 'oauth'), /purpose/);
});

test('malformed payloads are rejected with a clear error', () => {
  assert.throws(() => decryptSecret('v1.env.only.three', MASTER_KEY), /expected 5 segments/);
  assert.throws(() => decryptSecret('v2.env.a.b.c', MASTER_KEY), /Unsupported secret format version/);
  assert.throws(() => decryptSecret('v1.env.short.short.short', MASTER_KEY), /invalid nonce or auth tag/);
});