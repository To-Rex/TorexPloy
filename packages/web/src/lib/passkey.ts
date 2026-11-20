/**
 * Passkeys in the browser: the two WebAuthn ceremonies, with their binary
 * options and answers carried as the base64url JSON the API speaks.
 *
 * The answers are serialised by hand rather than with `toJSON()`: password
 * manager extensions replace `navigator.credentials` with their own
 * objects, and not all of them implement the newer method.
 */
import type { PasskeyCreationOptionsDto, PasskeyRequestOptionsDto } from '@ploy/shared';

/** What went wrong on the browser's side of a ceremony, in terms the UI can say something about. */
export type PasskeyFailure = 'cancelled' | 'exists' | 'unsupported' | 'failed';

export class PasskeyError extends Error {
  readonly kind: PasskeyFailure;

  constructor(kind: PasskeyFailure, cause?: unknown) {
    super(kind);
    this.name = 'PasskeyError';
    this.kind = kind;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** WebAuthn exists only in secure contexts (HTTPS, or localhost). */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof window.PublicKeyCredential === 'function' && typeof navigator.credentials?.create === 'function';
}

/** Whether the browser can offer passkeys in the autofill of the email field ("conditional mediation"). */
export async function passkeyAutofillSupported(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  const probe = (window.PublicKeyCredential as unknown as { isConditionalMediationAvailable?: () => Promise<boolean> }).isConditionalMediationAvailable;
  if (typeof probe !== 'function') return false;
  try {
    return await probe.call(window.PublicKeyCredential);
  } catch {
    return false;
  }
}

function decode(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out.buffer;
}

function encode(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function failure(error: unknown): PasskeyError {
  if (error instanceof PasskeyError) return error;
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
  // NotAllowedError covers a dismissed prompt and a timeout alike: browsers do not say which.
  if (name === 'NotAllowedError' || name === 'AbortError') return new PasskeyError('cancelled', error);
  // The authenticator already holds a passkey for this account (it was listed in excludeCredentials).
  if (name === 'InvalidStateError') return new PasskeyError('exists', error);
  if (name === 'NotSupportedError' || name === 'SecurityError' || name === 'ConstraintError') return new PasskeyError('unsupported', error);
  return new PasskeyError('failed', error);
}

export interface PasskeyRegistration {
  id: string;
  type: 'public-key';
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
}

export interface PasskeyAssertion {
  id: string;
  type: 'public-key';
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string | null };
}

/** `navigator.credentials.create()`: the browser asks the device to make a passkey and confirm its owner. */
export async function createPasskey(options: PasskeyCreationOptionsDto['publicKey']): Promise<PasskeyRegistration> {
  if (!passkeysSupported()) throw new PasskeyError('unsupported');
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: decode(options.challenge),
        user: { ...options.user, id: decode(options.user.id) },
        excludeCredentials: options.excludeCredentials.map((item) => ({ type: item.type, id: decode(item.id), ...(item.transports === undefined ? {} : { transports: item.transports as AuthenticatorTransport[] }) })),
      },
    });
  } catch (error) {
    throw failure(error);
  }
  if (credential === null) throw new PasskeyError('cancelled');
  const created = credential as PublicKeyCredential;
  const response = created.response as AuthenticatorAttestationResponse;
  const transports = typeof response.getTransports === 'function' ? response.getTransports() : undefined;
  return {
    id: encode(created.rawId),
    type: 'public-key',
    response: { clientDataJSON: encode(response.clientDataJSON), attestationObject: encode(response.attestationObject), ...(transports === undefined ? {} : { transports }) },
  };
}

/**
 * `navigator.credentials.get()`. With `autofill` the request waits quietly
 * behind the email field's suggestions until a passkey is picked there, or
 * until `signal` aborts it; without, the browser shows its own dialog.
 */
export async function getPasskey(options: PasskeyRequestOptionsDto['publicKey'], extra: { autofill?: boolean; signal?: AbortSignal } = {}): Promise<PasskeyAssertion> {
  if (!passkeysSupported()) throw new PasskeyError('unsupported');
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey: { ...options, challenge: decode(options.challenge), allowCredentials: [] },
      ...(extra.autofill === true ? { mediation: 'conditional' as CredentialMediationRequirement } : {}),
      ...(extra.signal === undefined ? {} : { signal: extra.signal }),
    });
  } catch (error) {
    throw failure(error);
  }
  if (credential === null) throw new PasskeyError('cancelled');
  const picked = credential as PublicKeyCredential;
  const response = picked.response as AuthenticatorAssertionResponse;
  return {
    id: encode(picked.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: encode(response.clientDataJSON),
      authenticatorData: encode(response.authenticatorData),
      signature: encode(response.signature),
      userHandle: response.userHandle === null || response.userHandle.byteLength === 0 ? null : encode(response.userHandle),
    },
  };
}
