/**
 * Cryptographic primitives.
 *
 * Every routine here uses only Node's built-in `node:crypto`, follows current
 * best practice (scrypt for passwords, HKDF-derived per-purpose subkeys, AES-256-GCM
 * with authenticated associated data), and compares secrets in constant time.
 *
 * Purpose separation matters: the master key is never used directly for
 * encryption. It is expanded with HKDF into independent subkeys, so a weakness
 * or misuse in one subsystem cannot weaken another.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';

// ---------------------------------------------------------------------------
// Constant-time comparison
// ---------------------------------------------------------------------------

/**
 * Compare two strings without leaking their contents through timing.
 * Length is compared first, which is safe to leak.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt, async so a login never blocks the event loop)
// ---------------------------------------------------------------------------

const SCRYPT_PARAMS = { N: 32_768, r: 8, p: 1 } as const;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
/** Upper bound on N accepted from a stored digest; a hostile N would be a DoS vector. */
const MAX_N = 1_048_576;

function scryptAsync(password: string, salt: Buffer, keylen: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // scrypt needs maxmem >= 128 * N * r; double it for headroom.
    scrypt(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: 256 * N * r }, (error, key) => {
      if (error !== null) reject(error);
      else resolve(key);
    });
  });
}

/** Self-describing digest: `scrypt$N$r$p$salt$hash` (base64url parts). */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error('Password must be at least 8 characters long');
  const salt = randomBytes(SALT_BYTES);
  const { N, r, p } = SCRYPT_PARAMS;
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, N, r, p);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, digest: string): Promise<boolean> {
  const parts = digest.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every(Number.isInteger) || N <= 1 || r <= 0 || p <= 0 || N > MAX_N || r > 32 || p > 16) return false;

  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.length === 0 || expected.length < 16) return false;

  try {
    const actual = await scryptAsync(password, salt, expected.length, N, r, p);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Whether a digest was produced with weaker parameters than today's and should be re-hashed. */
export function passwordNeedsRehash(digest: string): boolean {
  const [, n] = digest.split('$');
  return Number(n) < SCRYPT_PARAMS.N;
}

/**
 * A digest of a random password. Verifying against it costs the same as a real
 * check, so "unknown email" and "wrong password" take indistinguishable time.
 */
let dummyDigest: Promise<string> | null = null;
export function dummyPasswordDigest(): Promise<string> {
  dummyDigest ??= hashPassword(randomBytes(24).toString('base64url'));
  return dummyDigest;
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) for two-factor authentication
// ---------------------------------------------------------------------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, the size RFC 4226 recommends for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

const TOTP_STEP_SEC = 30;

function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

export function totpCounter(timeMs: number = Date.now()): number {
  return Math.floor(timeMs / 1000 / TOTP_STEP_SEC);
}

export function totpCode(secretBase32: string, timeMs: number = Date.now()): string {
  return hotp(base32Decode(secretBase32), totpCounter(timeMs));
}

/**
 * Verify a 6-digit code within ±1 step of clock drift. Returns the matched
 * counter so the caller can reject replays (a code may be used only once).
 */
export function verifyTotp(secretBase32: string, code: string, lastUsedCounter: number | null, timeMs: number = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpCounter(timeMs);
  for (const counter of [current - 1, current, current + 1]) {
    if (lastUsedCounter !== null && counter <= lastUsedCounter) continue;
    if (constantTimeEqual(hotp(secret, counter), code)) return counter;
  }
  return null;
}

export function totpUri(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: String(TOTP_STEP_SEC) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Tokens and hashing
// ---------------------------------------------------------------------------

/** A high-entropy opaque token (session, API key, webhook secret). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Plain SHA-256, used to store lookup values (session tokens) without the raw secret. */
export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmac(secret: string | Buffer, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyHmac(secret: string | Buffer, payload: string | Buffer, signature: string): boolean {
  const expected = hmac(secret, payload);
  const normalized = signature.trim().replace(/^sha256=/, '');
  return constantTimeEqual(expected, normalized);
}

// ---------------------------------------------------------------------------
// Secret encryption (AES-256-GCM, HKDF-separated subkeys)
// ---------------------------------------------------------------------------

const HKDF_HASH = 'sha256';
const IV_BYTES = 12; // 96-bit nonce, the GCM-recommended size
const TAG_BYTES = 16;

function subkey(masterKey: string, purpose: string): Buffer {
  const derived = hkdfSync(HKDF_HASH, Buffer.from(masterKey, 'utf8'), Buffer.alloc(0), purpose, 32);
  return Buffer.from(derived);
}

export interface SecretBox {
  /** Format: `v1.<purpose>.<iv>.<tag>.<ciphertext>`, all parts base64url. */
  ciphertext: string;
}

/**
 * Encrypt a UTF-8 value. The purpose string is bound into the ciphertext as
 * additional authenticated data, so a value encrypted for one purpose (for
 * example `env`) cannot be silently decrypted as another (for example `oauth`).
 */
export function encryptSecret(plaintext: string, masterKey: string, purpose = 'env'): string {
  const key = subkey(masterKey, purpose);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(purpose, 'utf8'));

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `v1.${purpose}.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(payload: string, masterKey: string, purpose = 'env'): string {
  const parts = payload.split('.');
  if (parts.length !== 5) {
    throw new Error('Malformed encrypted secret: expected 5 segments');
  }
  const [version, embeddedPurpose, ivPart, tagPart, dataPart] = parts as [string, string, string, string, string];
  if (version !== 'v1') {
    throw new Error(`Unsupported secret format version "${version}"`);
  }
  if (embeddedPurpose !== purpose) {
    throw new Error(`Secret was encrypted for purpose "${embeddedPurpose}", not "${purpose}"`);
  }

  const key = subkey(masterKey, purpose);
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Malformed encrypted secret: invalid nonce or auth tag length');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(purpose, 'utf8'));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Never surface the underlying OpenSSL message: it can distinguish
    // tampering from a wrong key, which is information an attacker can use.
    throw new Error('Failed to decrypt secret: authentication failed');
  }
}

/** True when the string looks like a value produced by {@link encryptSecret}. */
export function isEncryptedSecret(value: string): boolean {
  return /^v1\.[a-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(value);
}
