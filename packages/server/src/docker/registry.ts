/**
 * Registry credentials in the shapes Docker consumes them: the body of
 * `POST /auth`, the `X-Registry-Auth` header of an Engine API pull, and the
 * `auths` section of a CLI config (builds and compose runs).
 */
import { DOCKER_HUB } from '@ploy/shared';
import type { RegistryAuthConfig } from './client.ts';

export interface RegistryCredentials {
  serverAddress: string;
  username: string;
  password: string;
}

/** `auths` of a CLI `config.json`: `base64(username:password)` per registry key. */
export type CliAuths = Record<string, { auth: string }>;

/** Docker keys Docker Hub logins by its legacy v1 index URL and every other registry by its host. */
export function dockerConfigKey(serverAddress: string): string {
  return serverAddress === DOCKER_HUB ? 'https://index.docker.io/v1/' : serverAddress;
}

export function registryAuthConfig(credentials: RegistryCredentials): RegistryAuthConfig {
  return { username: credentials.username, password: credentials.password, serveraddress: dockerConfigKey(credentials.serverAddress) };
}

/** The `X-Registry-Auth` header value: base64url-encoded JSON, as the Engine API specifies it. */
export function registryAuthHeader(credentials: RegistryCredentials): string {
  return Buffer.from(JSON.stringify(registryAuthConfig(credentials)), 'utf8').toString('base64url');
}

export function cliAuths(registries: readonly RegistryCredentials[]): CliAuths {
  return Object.fromEntries(
    registries.map((registry) => [dockerConfigKey(registry.serverAddress), { auth: Buffer.from(`${registry.username}:${registry.password}`, 'utf8').toString('base64') }]),
  );
}
