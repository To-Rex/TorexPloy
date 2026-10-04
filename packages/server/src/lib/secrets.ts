/**
 * Encryption at rest, bound to the instance master key.
 *
 * Each purpose (`env`, `ssh`, `totp`, …) derives its own subkey and is bound
 * into the ciphertext as associated data, so a value sealed for one subsystem
 * can never be opened as another.
 */
import { decryptSecret, encryptSecret } from './crypto.ts';

export type SecretPurpose = 'env' | 'ssh' | 'totp' | 'service' | 'github' | 'hook' | 'registry';

export class Secrets {
  readonly #key: string;

  constructor(masterKey: string) {
    this.#key = masterKey;
  }

  seal(plaintext: string, purpose: SecretPurpose): string {
    return encryptSecret(plaintext, this.#key, purpose);
  }

  open(ciphertext: string, purpose: SecretPurpose): string {
    return decryptSecret(ciphertext, this.#key, purpose);
  }

  sealJson(value: unknown, purpose: SecretPurpose): string {
    return this.seal(JSON.stringify(value), purpose);
  }

  openJson<T>(ciphertext: string, purpose: SecretPurpose): T {
    return JSON.parse(this.open(ciphertext, purpose)) as T;
  }
}
