/**
 * WebAuthn (passkeys), the relying-party half, without a dependency.
 *
 * Two ceremonies are verified here, as the specification's "Registering a
 * New Credential" and "Verifying an Authentication Assertion" lay them out:
 *
 * - Registration: the browser returns `clientDataJSON` and a CBOR
 *   `attestationObject`. The client data must name this ceremony, this
 *   challenge and this origin; the authenticator data inside the attestation
 *   object must be for this relying party, with the user present and
 *   verified, and carry the new credential's id and COSE public key.
 * - Authentication: the browser returns `clientDataJSON`, the authenticator
 *   data and a signature over `authenticatorData || SHA-256(clientDataJSON)`
 *   made with the credential's private key.
 *
 * Attestation statements are not evaluated: the panel asks for `none` and
 * has no policy about authenticator models, so a statement could only be
 * ignored. What makes a passkey trustworthy here is that its owner
 * registered it from a signed-in session after confirming their password.
 *
 * Supported algorithms: ES256 (P-256), EdDSA (Ed25519) and RS256, which is
 * what platform authenticators, security keys and password managers use.
 */
import { createHash, createPublicKey, timingSafeEqual, verify as verifySignature, type KeyObject } from 'node:crypto';

export type WebAuthnFailure =
  | 'malformed'
  | 'type'
  | 'challenge'
  | 'origin'
  | 'rp_id'
  | 'user_presence'
  | 'user_verification'
  | 'credential'
  | 'algorithm'
  | 'signature'
  | 'counter';

export class WebAuthnError extends Error {
  readonly reason: WebAuthnFailure;

  constructor(reason: WebAuthnFailure, message: string) {
    super(message);
    this.name = 'WebAuthnError';
    this.reason = reason;
  }
}

/** COSE algorithm identifiers the panel accepts, in the order it prefers them. */
export const PASSKEY_ALGORITHMS = [-7, -257, -8] as const;
export type PasskeyAlgorithm = (typeof PASSKEY_ALGORITHMS)[number];

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

export function toBase64Url(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64url');
}

/** Strict base64url (no padding, no other alphabet): Buffer.from would quietly skip what it does not know. */
export function fromBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new WebAuthnError('malformed', 'Not base64url');
  return Buffer.from(value, 'base64url');
}

// ---------------------------------------------------------------------------
// CBOR (the subset CTAP2 uses: definite lengths, no tags, no floats)
// ---------------------------------------------------------------------------

export type CborValue = number | bigint | string | boolean | null | Buffer | CborValue[] | Map<CborValue, CborValue>;

const CBOR_MAX_DEPTH = 8;
const CBOR_MAX_ITEMS = 256;

/** Decode one CBOR item starting at `offset`; returns it with the offset just past it. */
export function decodeCbor(data: Buffer, offset = 0, depth = 0): { value: CborValue; offset: number } {
  if (depth > CBOR_MAX_DEPTH) throw new WebAuthnError('malformed', 'CBOR is nested too deeply');
  const need = (count: number): void => {
    if (offset + count > data.length) throw new WebAuthnError('malformed', 'CBOR ends early');
  };
  need(1);
  const initial = data[offset]!;
  offset += 1;
  const major = initial >> 5;
  const info = initial & 0x1f;

  let argument: number | bigint;
  if (info < 24) argument = info;
  else if (info === 24) {
    need(1);
    argument = data[offset]!;
    offset += 1;
  } else if (info === 25) {
    need(2);
    argument = data.readUInt16BE(offset);
    offset += 2;
  } else if (info === 26) {
    need(4);
    argument = data.readUInt32BE(offset);
    offset += 4;
  } else if (info === 27) {
    need(8);
    const wide = data.readBigUInt64BE(offset);
    argument = wide <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(wide) : wide;
    offset += 8;
  } else throw new WebAuthnError('malformed', 'Indefinite-length CBOR is not allowed');

  const length = (): number => {
    if (typeof argument !== 'number') throw new WebAuthnError('malformed', 'CBOR length is too large');
    return argument;
  };

  switch (major) {
    case 0:
      return { value: argument, offset };
    case 1:
      return { value: typeof argument === 'number' ? -1 - argument : -1n - argument, offset };
    case 2: {
      const size = length();
      need(size);
      return { value: Buffer.from(data.subarray(offset, offset + size)), offset: offset + size };
    }
    case 3: {
      const size = length();
      need(size);
      return { value: data.subarray(offset, offset + size).toString('utf8'), offset: offset + size };
    }
    case 4: {
      const count = length();
      if (count > CBOR_MAX_ITEMS) throw new WebAuthnError('malformed', 'CBOR array is too long');
      const items: CborValue[] = [];
      for (let index = 0; index < count; index += 1) {
        const item = decodeCbor(data, offset, depth + 1);
        items.push(item.value);
        offset = item.offset;
      }
      return { value: items, offset };
    }
    case 5: {
      const count = length();
      if (count > CBOR_MAX_ITEMS) throw new WebAuthnError('malformed', 'CBOR map is too long');
      const map = new Map<CborValue, CborValue>();
      for (let index = 0; index < count; index += 1) {
        const key = decodeCbor(data, offset, depth + 1);
        if (typeof key.value !== 'number' && typeof key.value !== 'string') throw new WebAuthnError('malformed', 'CBOR map key must be an integer or a string');
        const item = decodeCbor(data, key.offset, depth + 1);
        if (map.has(key.value)) throw new WebAuthnError('malformed', 'CBOR map repeats a key');
        map.set(key.value, item.value);
        offset = item.offset;
      }
      return { value: map, offset };
    }
    case 7:
      if (info === 20) return { value: false, offset };
      if (info === 21) return { value: true, offset };
      if (info === 22 || info === 23) return { value: null, offset };
      throw new WebAuthnError('malformed', 'Unsupported CBOR simple value');
    default:
      throw new WebAuthnError('malformed', 'Unsupported CBOR type');
  }
}

// ---------------------------------------------------------------------------
// COSE keys
// ---------------------------------------------------------------------------

/** The public half of a passkey as a JWK: an EC point, an Ed25519 point or an RSA modulus and exponent. */
export interface PublicJwk {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
}

export interface PasskeyPublicKey {
  algorithm: PasskeyAlgorithm;
  jwk: PublicJwk;
}

const bytes = (map: Map<CborValue, CborValue>, label: number, size?: number): Buffer => {
  const value = map.get(label);
  if (!Buffer.isBuffer(value) || value.length === 0 || (size !== undefined && value.length !== size)) throw new WebAuthnError('credential', 'The public key is malformed');
  return value;
};

/** A COSE_Key as authenticators send it, as a JWK Node can import. Only the three accepted algorithms pass. */
export function coseToPublicKey(cose: CborValue): PasskeyPublicKey {
  if (!(cose instanceof Map)) throw new WebAuthnError('credential', 'The public key is malformed');
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (alg === -7 && kty === 2) {
    if (cose.get(-1) !== 1) throw new WebAuthnError('algorithm', 'ES256 keys must be on the P-256 curve');
    return { algorithm: -7, jwk: { kty: 'EC', crv: 'P-256', x: bytes(cose, -2, 32).toString('base64url'), y: bytes(cose, -3, 32).toString('base64url') } };
  }
  if (alg === -8 && kty === 1) {
    if (cose.get(-1) !== 6) throw new WebAuthnError('algorithm', 'EdDSA keys must be Ed25519');
    return { algorithm: -8, jwk: { kty: 'OKP', crv: 'Ed25519', x: bytes(cose, -2, 32).toString('base64url') } };
  }
  if (alg === -257 && kty === 3) {
    const modulus = bytes(cose, -1);
    if (modulus.length < 256) throw new WebAuthnError('algorithm', 'RSA keys must be at least 2048 bits');
    return { algorithm: -257, jwk: { kty: 'RSA', n: modulus.toString('base64url'), e: bytes(cose, -2).toString('base64url') } };
  }
  throw new WebAuthnError('algorithm', 'This passkey uses an algorithm the panel does not accept');
}

function importKey(key: PasskeyPublicKey): KeyObject {
  try {
    return createPublicKey({ key: key.jwk, format: 'jwk' });
  } catch {
    throw new WebAuthnError('credential', 'The stored public key cannot be read');
  }
}

// ---------------------------------------------------------------------------
// Authenticator data
// ---------------------------------------------------------------------------

export interface AuthenticatorData {
  rpIdHash: Buffer;
  userPresent: boolean;
  userVerified: boolean;
  /** The credential may be synced to the owner's other devices (a multi-device passkey). */
  backupEligible: boolean;
  /** It is synced right now. */
  backedUp: boolean;
  signCount: number;
  credential: { aaguid: string; id: Buffer; publicKey: PasskeyPublicKey } | null;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
/** WebAuthn caps credential ids at 1023 bytes. */
const CREDENTIAL_ID_MAX = 1023;

const uuid = (raw: Buffer): string => {
  const hex = raw.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export function parseAuthenticatorData(data: Buffer): AuthenticatorData {
  if (data.length < 37) throw new WebAuthnError('malformed', 'Authenticator data is too short');
  const flags = data[32]!;
  const backupEligible = (flags & FLAG_BE) !== 0;
  const backedUp = (flags & FLAG_BS) !== 0;
  // A credential that cannot be backed up cannot be backed up right now either.
  if (backedUp && !backupEligible) throw new WebAuthnError('malformed', 'Authenticator data has inconsistent backup flags');
  let credential: AuthenticatorData['credential'] = null;
  if ((flags & FLAG_AT) !== 0) {
    if (data.length < 55) throw new WebAuthnError('malformed', 'Attested credential data is too short');
    const idLength = data.readUInt16BE(53);
    if (idLength === 0 || idLength > CREDENTIAL_ID_MAX || data.length < 55 + idLength) throw new WebAuthnError('malformed', 'Credential id has an invalid length');
    const id = Buffer.from(data.subarray(55, 55 + idLength));
    // Extensions may follow the key; they are not used, so whatever is left after it is not read.
    const key = decodeCbor(data, 55 + idLength);
    credential = { aaguid: uuid(data.subarray(37, 53)), id, publicKey: coseToPublicKey(key.value) };
  }
  return {
    rpIdHash: Buffer.from(data.subarray(0, 32)),
    userPresent: (flags & FLAG_UP) !== 0,
    userVerified: (flags & FLAG_UV) !== 0,
    backupEligible,
    backedUp,
    signCount: data.readUInt32BE(33),
    credential,
  };
}

// ---------------------------------------------------------------------------
// The two ceremonies
// ---------------------------------------------------------------------------

export interface CeremonyExpectation {
  /** The challenge handed out for this ceremony, base64url. */
  challenge: string;
  /** The exact origin the browser must have been on, e.g. `https://deploy.example.uz`. */
  origin: string;
  /** The relying party id the credential is scoped to: the origin's host. */
  rpId: string;
}

const sha256 = (data: Buffer): Buffer => createHash('sha256').update(data).digest();

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function checkClientData(raw: Buffer, type: 'webauthn.create' | 'webauthn.get', expected: CeremonyExpectation): void {
  let client: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    client = JSON.parse(raw.toString('utf8')) as typeof client;
  } catch {
    throw new WebAuthnError('malformed', 'Client data is not JSON');
  }
  if (client === null || typeof client !== 'object') throw new WebAuthnError('malformed', 'Client data is not an object');
  if (client.type !== type) throw new WebAuthnError('type', 'The response belongs to another kind of ceremony');
  if (typeof client.challenge !== 'string' || !sameText(client.challenge, expected.challenge)) throw new WebAuthnError('challenge', 'The response answers another challenge');
  if (typeof client.origin !== 'string' || client.origin !== expected.origin) throw new WebAuthnError('origin', 'The response was made on another site');
  // An embedding site could otherwise frame the panel and ask in its name.
  if (client.crossOrigin === true) throw new WebAuthnError('origin', 'The response was made inside a cross-origin frame');
}

function checkAuthenticatorData(data: AuthenticatorData, expected: CeremonyExpectation): void {
  if (!data.rpIdHash.equals(sha256(Buffer.from(expected.rpId, 'utf8')))) throw new WebAuthnError('rp_id', 'The passkey belongs to another site');
  if (!data.userPresent) throw new WebAuthnError('user_presence', 'The authenticator did not confirm that someone was there');
  // Verification (biometrics or the device PIN) is what makes a passkey two factors in one.
  if (!data.userVerified) throw new WebAuthnError('user_verification', 'The authenticator did not verify its owner');
}

export interface RegisteredPasskey {
  credentialId: string;
  publicKey: PasskeyPublicKey;
  signCount: number;
  aaguid: string;
  backupEligible: boolean;
  backedUp: boolean;
}

/** Verify the answer to `navigator.credentials.create()`. `clientDataJSON` and `attestationObject` are base64url. */
export function verifyRegistration(response: { clientDataJSON: string; attestationObject: string }, expected: CeremonyExpectation): RegisteredPasskey {
  checkClientData(fromBase64Url(response.clientDataJSON), 'webauthn.create', expected);
  const attestation = decodeCbor(fromBase64Url(response.attestationObject)).value;
  if (!(attestation instanceof Map)) throw new WebAuthnError('malformed', 'The attestation object is not a map');
  const authData = attestation.get('authData');
  if (!Buffer.isBuffer(authData)) throw new WebAuthnError('malformed', 'The attestation object has no authenticator data');
  const data = parseAuthenticatorData(authData);
  checkAuthenticatorData(data, expected);
  if (data.credential === null) throw new WebAuthnError('credential', 'The authenticator returned no credential');
  // Importing proves the key is one Node can verify with later, before it is stored.
  importKey(data.credential.publicKey);
  return {
    credentialId: toBase64Url(data.credential.id),
    publicKey: data.credential.publicKey,
    signCount: data.signCount,
    aaguid: data.credential.aaguid,
    backupEligible: data.backupEligible,
    backedUp: data.backedUp,
  };
}

export interface VerifiedAssertion {
  signCount: number;
  backupEligible: boolean;
  backedUp: boolean;
}

/**
 * Verify the answer to `navigator.credentials.get()` against a stored
 * credential. A signature counter that fails to advance means the private
 * key exists in two places (a cloned authenticator); synced passkeys keep
 * the counter at zero and are not subject to the check.
 */
export function verifyAssertion(
  response: { clientDataJSON: string; authenticatorData: string; signature: string },
  expected: CeremonyExpectation,
  stored: { publicKey: PasskeyPublicKey; signCount: number },
): VerifiedAssertion {
  const clientData = fromBase64Url(response.clientDataJSON);
  checkClientData(clientData, 'webauthn.get', expected);
  const authData = fromBase64Url(response.authenticatorData);
  const data = parseAuthenticatorData(authData);
  checkAuthenticatorData(data, expected);

  const key = importKey(stored.publicKey);
  const signed = Buffer.concat([authData, sha256(clientData)]);
  const signature = fromBase64Url(response.signature);
  let valid = false;
  try {
    // Ed25519 hashes internally; ECDSA signatures arrive DER-encoded and RSA ones as PKCS#1 v1.5, which are Node's defaults.
    valid = verifySignature(stored.publicKey.algorithm === -8 ? null : 'sha256', signed, key, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new WebAuthnError('signature', 'The signature does not match the passkey');

  if ((data.signCount !== 0 || stored.signCount !== 0) && data.signCount <= stored.signCount) {
    throw new WebAuthnError('counter', 'The passkey was used somewhere else since it was last seen here');
  }
  return { signCount: data.signCount, backupEligible: data.backupEligible, backedUp: data.backedUp };
}
