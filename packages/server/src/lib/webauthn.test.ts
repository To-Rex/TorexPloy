/**
 * The WebAuthn verifier against a software authenticator: every accepted
 * algorithm end to end, and each way a response can be wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCbor, SoftAuthenticator } from './webauthn.fixture.ts';
import { coseToPublicKey, decodeCbor, fromBase64Url, parseAuthenticatorData, toBase64Url, verifyAssertion, verifyRegistration, WebAuthnError, type WebAuthnFailure } from './webauthn.ts';

const ceremony = (challenge = 'Y2hhbGxlbmdlLWZvci10aGUtdGVzdHM') => ({ challenge, rpId: 'deploy.example.uz', origin: 'https://deploy.example.uz' });

const fails = (run: () => unknown, reason: WebAuthnFailure, message?: string): void => {
  assert.throws(run, (error: unknown) => error instanceof WebAuthnError && error.reason === reason, message ?? `expected a "${reason}" failure`);
};

test('CBOR: the CTAP2 subset decodes with exact offsets; indefinite lengths, floats, tags and duplicates are refused', () => {
  const value = new Map<unknown, unknown>([
    [1, 2],
    [3, -7],
    [-1, 1],
    ['text', 'salom'],
    ['bytes', Buffer.from([1, 2, 3])],
    ['list', [0, 23, 24, 255, 256, 65_535, 65_536, -1, -24, -25, true, false, null]],
    ['nested', new Map([['k', Buffer.alloc(300, 7)]])],
  ]);
  const encoded = encodeCbor(value);
  const decoded = decodeCbor(Buffer.concat([encoded, Buffer.from('trailing')]));
  assert.equal(decoded.offset, encoded.length, 'the decoder stops exactly after the item');
  const map = decoded.value as Map<unknown, unknown>;
  assert.equal(map.get(3), -7);
  assert.equal(map.get('text'), 'salom');
  assert.deepEqual(map.get('bytes'), Buffer.from([1, 2, 3]));
  assert.deepEqual(map.get('list'), [0, 23, 24, 255, 256, 65_535, 65_536, -1, -24, -25, true, false, null]);
  assert.equal(((map.get('nested') as Map<unknown, unknown>).get('k') as Buffer).length, 300);
  // 64-bit arguments: small ones stay numbers, large ones become bigints.
  assert.equal(decodeCbor(Buffer.from('1b0000000100000000', 'hex')).value, 4_294_967_296);
  assert.equal(decodeCbor(Buffer.from('1bffffffffffffffff', 'hex')).value, 18_446_744_073_709_551_615n);

  fails(() => decodeCbor(Buffer.from('5f', 'hex')), 'malformed', 'indefinite-length byte string');
  fails(() => decodeCbor(Buffer.from('9f01ff', 'hex')), 'malformed', 'indefinite-length array');
  fails(() => decodeCbor(Buffer.from('fb3ff0000000000000', 'hex')), 'malformed', 'floats');
  fails(() => decodeCbor(Buffer.from('c074', 'hex')), 'malformed', 'tags');
  fails(() => decodeCbor(Buffer.from('4401', 'hex')), 'malformed', 'a byte string longer than the input');
  fails(() => decodeCbor(Buffer.from('a201010102', 'hex')), 'malformed', 'a repeated map key');
  fails(() => decodeCbor(Buffer.from('a1410101', 'hex')), 'malformed', 'a byte-string map key');
  fails(() => decodeCbor(Buffer.alloc(0)), 'malformed', 'nothing at all');
  fails(() => decodeCbor(Buffer.from(`${'81'.repeat(12)}00`, 'hex')), 'malformed', 'nesting past the limit');

  assert.equal(toBase64Url(fromBase64Url('AQID')), 'AQID');
  fails(() => fromBase64Url('AQI='), 'malformed', 'padding');
  fails(() => fromBase64Url('AQ+D'), 'malformed', 'the base64 alphabet instead of base64url');
  fails(() => fromBase64Url('A'), 'malformed', 'an impossible length');
});

test('a passkey registers and signs in with each accepted algorithm; a device-bound one must advance its counter', () => {
  for (const algorithm of [-7, -8, -257] as const) {
    const device = new SoftAuthenticator({ algorithm, aaguid: 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd' });
    const registered = verifyRegistration(device.create(ceremony('cmVnaXN0ZXI')).response, ceremony('cmVnaXN0ZXI'));
    assert.equal(registered.credentialId, device.id);
    assert.equal(registered.publicKey.algorithm, algorithm);
    assert.equal(registered.aaguid, 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd');
    assert.equal(registered.signCount, 1);
    assert.equal(registered.backupEligible, false);
    assert.equal(registered.backedUp, false);
    // The stored key is plain JSON: it survives a round trip through the database.
    const stored = { publicKey: JSON.parse(JSON.stringify(registered.publicKey)) as typeof registered.publicKey, signCount: registered.signCount };

    const first = verifyAssertion(device.get(ceremony('Zmlyc3Q')).response, ceremony('Zmlyc3Q'), stored);
    assert.equal(first.signCount, 2, `algorithm ${algorithm}: the counter advanced`);
    const second = verifyAssertion(device.get(ceremony('c2Vjb25k')).response, ceremony('c2Vjb25k'), { ...stored, signCount: first.signCount });
    assert.equal(second.signCount, 3);

    // The same counter again means the key lives in two places.
    device.rewindCounter();
    fails(() => verifyAssertion(device.get(ceremony('dGhpcmQ')).response, ceremony('dGhpcmQ'), { ...stored, signCount: second.signCount }), 'counter');
  }
});

test('a synced passkey reports backup flags and a counter that stays at zero, which is not a clone', () => {
  const device = new SoftAuthenticator({ synced: true });
  const registered = verifyRegistration(device.create(ceremony()).response, ceremony());
  assert.equal(registered.signCount, 0);
  assert.equal(registered.backupEligible, true);
  assert.equal(registered.backedUp, true);
  for (const challenge of ['b25l', 'dHdv', 'dGhyZWU']) {
    const verified = verifyAssertion(device.get(ceremony(challenge)).response, ceremony(challenge), { publicKey: registered.publicKey, signCount: 0 });
    assert.equal(verified.signCount, 0);
    assert.equal(verified.backedUp, true);
  }
  // "Backed up" without "eligible" cannot be: such data is rejected rather than trusted halfway.
  const authData = Buffer.concat([Buffer.alloc(32), Buffer.from([0x01 | 0x04 | 0x10]), Buffer.alloc(4)]);
  fails(() => parseAuthenticatorData(authData), 'malformed');
});

test('registration refuses another ceremony, challenge, origin or relying party, an unverified owner, and a missing credential', () => {
  const device = new SoftAuthenticator();
  const good = ceremony();
  assert.doesNotThrow(() => verifyRegistration(device.create(good).response, good));
  // Extensions after the key are tolerated: the key is read by its own length.
  assert.doesNotThrow(() => verifyRegistration(device.create(good, { extensions: true }).response, good));

  fails(() => verifyRegistration(device.create(good, { type: 'webauthn.get' }).response, good), 'type');
  fails(() => verifyRegistration(device.create(good, { challenge: 'YW5vdGhlcg' }).response, good), 'challenge');
  fails(() => verifyRegistration(device.create(good, { origin: 'https://deploy.example.uz.evil.test' }).response, good), 'origin');
  fails(() => verifyRegistration(device.create(good, { origin: 'http://deploy.example.uz' }).response, good), 'origin', 'the scheme is part of the origin');
  fails(() => verifyRegistration(device.create(good, { crossOrigin: true }).response, good), 'origin', 'a cross-origin frame');
  fails(() => verifyRegistration(device.create(good, { rpId: 'evil.test' }).response, good), 'rp_id');
  fails(() => verifyRegistration(device.create(good, { userPresent: false }).response, good), 'user_presence');
  fails(() => verifyRegistration(device.create(good, { userVerified: false }).response, good), 'user_verification');

  // An assertion-shaped authenticator data (no attested credential) is not a registration.
  const assertion = device.get(good);
  const noCredential = encodeCbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', fromBase64Url(assertion.response.authenticatorData)]]));
  const createClientData = device.create(good).response.clientDataJSON;
  fails(() => verifyRegistration({ clientDataJSON: createClientData, attestationObject: noCredential.toString('base64url') }, good), 'credential');
  fails(() => verifyRegistration({ clientDataJSON: createClientData, attestationObject: encodeCbor('not a map').toString('base64url') }, good), 'malformed');
  fails(() => verifyRegistration({ clientDataJSON: Buffer.from('not json').toString('base64url'), attestationObject: noCredential.toString('base64url') }, good), 'malformed');
  fails(() => verifyRegistration({ clientDataJSON: Buffer.from('null').toString('base64url'), attestationObject: noCredential.toString('base64url') }, good), 'malformed');
});

test('assertions refuse a wrong key, a tampered payload, another site and an unverified owner', () => {
  const device = new SoftAuthenticator();
  const other = new SoftAuthenticator();
  const good = ceremony();
  const stored = { publicKey: verifyRegistration(device.create(good).response, good).publicKey, signCount: 0 };
  const strangerKey = { publicKey: verifyRegistration(other.create(good).response, good).publicKey, signCount: 0 };

  assert.doesNotThrow(() => verifyAssertion(device.get(good).response, good, stored));
  fails(() => verifyAssertion(device.get(good).response, good, strangerKey), 'signature', 'signed by another passkey');
  fails(() => verifyAssertion(device.get(good, { corruptSignature: true }).response, good, stored), 'signature');
  fails(() => verifyAssertion(device.get(good, { type: 'webauthn.create' }).response, good, stored), 'type');
  fails(() => verifyAssertion(device.get(good, { challenge: 'cmVwbGF5ZWQ' }).response, good, stored), 'challenge', 'an answer to an older challenge');
  fails(() => verifyAssertion(device.get(good, { origin: 'https://evil.test' }).response, good, stored), 'origin');
  fails(() => verifyAssertion(device.get(good, { crossOrigin: true }).response, good, stored), 'origin');
  fails(() => verifyAssertion(device.get(good, { rpId: 'evil.test' }).response, good, stored), 'rp_id');
  fails(() => verifyAssertion(device.get(good, { userPresent: false }).response, good, stored), 'user_presence');
  fails(() => verifyAssertion(device.get(good, { userVerified: false }).response, good, stored), 'user_verification');

  // Client data swapped after signing: the signature covers its hash.
  const signed = device.get(good);
  const swapped = device.get({ ...good, challenge: good.challenge });
  fails(() => verifyAssertion({ ...signed.response, authenticatorData: swapped.response.authenticatorData }, good, stored), 'signature');
  fails(() => verifyAssertion({ ...signed.response, signature: 'AAAA' }, good, stored), 'signature', 'a signature that is not even well formed');
  fails(() => verifyAssertion({ ...signed.response, authenticatorData: 'AAAA' }, good, stored), 'malformed');
  // A stored key that is not a key at all (a damaged row) fails closed.
  fails(() => verifyAssertion(device.get(good).response, good, { publicKey: { algorithm: -7, jwk: { kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' } }, signCount: 0 }), 'credential');
});

test('keys outside the accepted set are refused: other curves, short RSA, unknown algorithms, malformed points', () => {
  const good = ceremony();
  const p384 = new SoftAuthenticator({ curve: 'P-384' });
  fails(() => verifyRegistration(p384.create(good).response, good), 'algorithm', 'ES256 on P-384');
  const weak = new SoftAuthenticator({ algorithm: -257, rsaBits: 1024 });
  fails(() => verifyRegistration(weak.create(good).response, good), 'algorithm', 'RSA-1024');

  const device = new SoftAuthenticator();
  fails(() => verifyRegistration(device.create(good, {}, device.coseKey({ 3: -35 })).response, good), 'algorithm', 'ES384');
  fails(() => verifyRegistration(device.create(good, {}, device.coseKey({ 1: 3 })).response, good), 'algorithm', 'a key type that contradicts the algorithm');
  fails(() => verifyRegistration(device.create(good, {}, device.coseKey({ [-2]: Buffer.alloc(31) })).response, good), 'credential', 'a short coordinate');
  fails(() => verifyRegistration(device.create(good, {}, device.coseKey({ [-3]: 'text' })).response, good), 'credential', 'a coordinate that is not bytes');
  fails(() => coseToPublicKey('not a map'), 'credential');
  const ed = new SoftAuthenticator({ algorithm: -8 });
  fails(() => verifyRegistration(ed.create(good, {}, ed.coseKey({ [-1]: 7 })).response, good), 'algorithm', 'Ed448');
  // A point of the right size that is not on the curve is caught when the key is imported.
  fails(() => verifyRegistration(device.create(good, {}, device.coseKey({ [-2]: Buffer.alloc(32, 1), [-3]: Buffer.alloc(32, 1) })).response, good), 'credential', 'a point off the curve');
});
