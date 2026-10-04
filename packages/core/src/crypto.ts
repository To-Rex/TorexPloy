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
  scryptSync,
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
// Password hashing (scrypt)
// ---------------------------------------------------------------------------

const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1 } as const;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
/** scrypt needs maxmem >= 128 * N * r; give it headroom. */
const SCRYPT_MAXMEM = 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2;

export interface PasswordHash {
  /** Self-describing digest: `scrypt$N$r$p$salt$hash`, both parts base64url. */
  digest: string;
}

export function hashPassword(password: string): string {
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters long');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    ...SCRYPT_PARAMS,
    maxmem: SCRYPT_MAXMEM,
  });
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password: string, digest: string): boolean {
  const parts = digest.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N <= 0 || r <= 0 || p <= 0 || N > 1_048_576) return false;

  const saltPart = parts[4]!;
  const hashPart = parts[5]!;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltPart, 'base64url');
    expected = Buffer.from(hashPart, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = scryptSync(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });
  } catch {
    return false;
  }
  return timingSafeEqual(actual, expected);
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
