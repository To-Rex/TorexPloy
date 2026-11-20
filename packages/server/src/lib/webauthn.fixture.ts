/**
 * A software authenticator for the tests: it does what a phone or a security
 * key does on `navigator.credentials.create()` and `.get()` — makes a key
 * pair, builds authenticator data, encodes the attestation object in CBOR
 * and signs assertions — with knobs to produce the wrong answers a hostile
 * or broken client could send.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/** CBOR for what an authenticator emits: integers, byte and text strings, arrays, maps, booleans. */
export function encodeCbor(value: unknown): Buffer {
  const head = (major: number, argument: number): Buffer => {
    if (argument < 24) return Buffer.from([(major << 5) | argument]);
    if (argument < 0x100) return Buffer.from([(major << 5) | 24, argument]);
    if (argument < 0x10000) {
      const out = Buffer.alloc(3);
      out[0] = (major << 5) | 25;
      out.writeUInt16BE(argument, 1);
      return out;
    }
    const out = Buffer.alloc(5);
    out[0] = (major << 5) | 26;
    out.writeUInt32BE(argument, 1);
    return out;
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'boolean') return Buffer.from([value ? 0xf5 : 0xf4]);
  if (value === null) return Buffer.from([0xf6]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, text.length), text]);
  }
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encodeCbor)]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [encodeCbor(key), encodeCbor(item)])]);
  throw new Error('encodeCbor: unsupported value');
}

export type SoftAlgorithm = -7 | -8 | -257;

export interface CeremonyInput {
  challenge: string;
  rpId: string;
  origin: string;
}

export interface CeremonyOverrides {
  /** What `clientDataJSON` claims; defaults to the truth. */
  type?: string;
  origin?: string;
  challenge?: string;
  crossOrigin?: boolean;
  /** The relying party the authenticator data is hashed for. */
  rpId?: string;
  userPresent?: boolean;
  userVerified?: boolean;
  /** Flip a bit of the signature, or sign with another key. */
  corruptSignature?: boolean;
  /** Append an extensions map after the key (the ED flag). */
  extensions?: boolean;
}

export interface RegistrationJson {
  id: string;
  type: 'public-key';
  response: { clientDataJSON: string; attestationObject: string; transports: string[] };
}

export interface AssertionJson {
  id: string;
  type: 'public-key';
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string | null };
}

const b64u = (data: Buffer): string => data.toString('base64url');
const sha256 = (data: Buffer | string): Buffer => createHash('sha256').update(data).digest();

export class SoftAuthenticator {
  readonly algorithm: SoftAlgorithm;
  readonly credentialId: Buffer;
  readonly aaguid: Buffer;
  /** A synced passkey reports backup flags and keeps its counter at zero. */
  readonly synced: boolean;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private counter = 0;
  private handle: string | null = null;

  constructor(options: { algorithm?: SoftAlgorithm; synced?: boolean; aaguid?: string; rsaBits?: number; curve?: string } = {}) {
    this.algorithm = options.algorithm ?? -7;
    this.synced = options.synced ?? false;
    this.credentialId = randomBytes(32);
    this.aaguid = Buffer.from((options.aaguid ?? '00000000-0000-0000-0000-000000000000').replace(/-/g, ''), 'hex');
    const pair =
      this.algorithm === -7
        ? generateKeyPairSync('ec', { namedCurve: options.curve ?? 'P-256' })
        : this.algorithm === -8
          ? generateKeyPairSync('ed25519')
          : generateKeyPairSync('rsa', { modulusLength: options.rsaBits ?? 2048 });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  /** The COSE_Key this authenticator registers with; `claim` overrides labels to forge an unsupported key. */
  coseKey(claim: Record<number, unknown> = {}): Map<number, unknown> {
    const jwk = this.publicKey.export({ format: 'jwk' }) as { x?: string; y?: string; n?: string; e?: string; crv?: string };
    const part = (value: string | undefined): Buffer => Buffer.from(value ?? '', 'base64url');
    const key =
      this.algorithm === -7
        ? new Map<number, unknown>([[1, 2], [3, -7], [-1, jwk.crv === 'P-256' ? 1 : 2], [-2, part(jwk.x)], [-3, part(jwk.y)]])
        : this.algorithm === -8
          ? new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, part(jwk.x)]])
          : new Map<number, unknown>([[1, 3], [3, -257], [-1, part(jwk.n)], [-2, part(jwk.e)]]);
    for (const [label, value] of Object.entries(claim)) key.set(Number(label), value);
    return key;
  }

  private authenticatorData(rpId: string, overrides: CeremonyOverrides, attested: Buffer | null): Buffer {
    let flags = 0;
    if (overrides.userPresent ?? true) flags |= 0x01;
    if (overrides.userVerified ?? true) flags |= 0x04;
    if (this.synced) flags |= 0x08 | 0x10;
    if (attested !== null) flags |= 0x40;
    if (overrides.extensions === true) flags |= 0x80;
    const counter = Buffer.alloc(4);
    if (!this.synced) this.counter += 1;
    counter.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(overrides.rpId ?? rpId), Buffer.from([flags]), counter, attested ?? Buffer.alloc(0), overrides.extensions === true ? encodeCbor(new Map([['credProtect', 2]])) : Buffer.alloc(0)]);
  }

  private clientData(type: string, input: CeremonyInput, overrides: CeremonyOverrides): Buffer {
    return Buffer.from(
      JSON.stringify({
        type: overrides.type ?? type,
        challenge: overrides.challenge ?? input.challenge,
        origin: overrides.origin ?? input.origin,
        crossOrigin: overrides.crossOrigin ?? false,
      }),
      'utf8',
    );
  }

  /** `navigator.credentials.create()`. `userHandle` is what the relying party passed as `user.id` (base64url). */
  create(input: CeremonyInput & { userHandle?: string }, overrides: CeremonyOverrides = {}, key: Map<number, unknown> = this.coseKey()): RegistrationJson {
    this.handle = input.userHandle ?? null;
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([this.aaguid, idLength, this.credentialId, encodeCbor(key)]);
    const authData = this.authenticatorData(input.rpId, overrides, attested);
    const attestationObject = encodeCbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64u(this.clientData('webauthn.create', input, overrides)), attestationObject: b64u(attestationObject), transports: ['internal', 'hybrid'] },
    };
  }

  /** `navigator.credentials.get()`. */
  get(input: CeremonyInput, overrides: CeremonyOverrides = {}): AssertionJson {
    const authData = this.authenticatorData(input.rpId, overrides, null);
    const clientData = this.clientData('webauthn.get', input, overrides);
    const signed = Buffer.concat([authData, sha256(clientData)]);
    const signature = sign(this.algorithm === -8 ? null : 'sha256', signed, this.privateKey);
    if (overrides.corruptSignature === true) signature[signature.length - 1]! ^= 0x01;
    return {
      id: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: this.handle },
    };
  }

  /** Pretend the key was copied: the next assertion reports a counter that was already seen. */
  rewindCounter(): void {
    this.counter = Math.max(0, this.counter - 1);
  }
}
