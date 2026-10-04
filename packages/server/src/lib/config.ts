/**
 * Process configuration.
 *
 * Only what must be known before the database opens lives here (paths, ports,
 * the master key). Everything an operator tunes at runtime — build
 * concurrency, retention, domains — is a platform setting stored in SQLite and
 * edited from the dashboard.
 *
 * Invalid values fail at startup, not halfway through a deployment.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogLevel } from './logger.ts';

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  logLevel: LogLevel;
  /** State directory: database, logs, SSH keys, backups, build workspaces. */
  dataDir: string;
  databasePath: string;
  host: string;
  port: number;
  /** Explicit public URL of the dashboard. When null it is derived from the platform domain setting. */
  publicUrl: string | null;
  secretKey: string;
  /** Docker Engine socket of the server the control plane runs on. */
  dockerSocket: string;
  /** Address the proxy uses to reach this process on the `ploy` network, e.g. `ploy-control:3000`. */
  controlUpstream: string;
  /** Built dashboard assets. Served when present. */
  webDist: string | null;
  proxyImage: string;
  /** Hard limit for one image build. */
  buildTimeoutMs: number;
  /** How long old containers keep serving in-flight requests after traffic moves to a new deployment. */
  drainMs: number;
  /** Where the host's `/proc` is visible (the container sees host CPU/memory through it). */
  hostProc: string;
  /** IANA time zone handed to template apps that need one. */
  timezone: string;
  version: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function str(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

/**
 * Resolve the master key: `PLOY_SECRET_KEY`, else `<data>/secret.key`, else a
 * freshly generated key written 0600. A fresh install is therefore zero-config
 * and no default key ever ships.
 */
function resolveSecretKey(dataDir: string, provided: string | undefined): string {
  if (provided !== undefined) {
    if (provided.length < 32) throw new ConfigError('PLOY_SECRET_KEY must be at least 32 characters');
    return provided;
  }
  const path = join(dataDir, 'secret.key');
  if (existsSync(path)) {
    const key = readFileSync(path, 'utf8').trim();
    if (key.length < 32) throw new ConfigError(`${path} is corrupt (shorter than 32 characters)`);
    return key;
  }
  const key = randomBytes(48).toString('base64url');
  writeFileSync(path, `${key}\n`, { mode: 0o600, flag: 'wx' });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Some mounted filesystems ignore chmod; the file was created 0600 anyway.
  }
  return key;
}

/** The socket behind the docker CLI's current context (`docker context use …`), if it is a unix socket. */
function contextSocket(home: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const configDir = str(env, 'DOCKER_CONFIG') ?? join(home, '.docker');
    const name = str(env, 'DOCKER_CONTEXT') ?? (JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) as { currentContext?: string }).currentContext;
    if (name === undefined || name === 'default') return null;
    // The CLI stores each context under the SHA-256 of its name.
    const meta = JSON.parse(readFileSync(join(configDir, 'contexts', 'meta', createHash('sha256').update(name).digest('hex'), 'meta.json'), 'utf8')) as {
      Endpoints?: { docker?: { Host?: string } };
    };
    const host = meta.Endpoints?.docker?.Host;
    return host?.startsWith('unix://') === true ? host.slice('unix://'.length) : null;
  } catch {
    return null;
  }
}

/**
 * Where the Docker Engine listens. Explicit settings win (`PLOY_DOCKER_SOCKET`,
 * a unix `DOCKER_HOST`); otherwise the CLI's current context, then the usual
 * places: Linux and Docker Desktop's optional default socket, Docker Desktop's
 * own socket on macOS, OrbStack, Colima, Rancher Desktop and rootless Docker.
 * In production the control plane runs in a container with the host's socket
 * mounted at /var/run/docker.sock, so the first candidate is the answer.
 */
export function resolveDockerSocket(env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync, home: string = homedir()): string {
  const explicit = str(env, 'PLOY_DOCKER_SOCKET');
  if (explicit !== undefined) return explicit;
  const dockerHost = str(env, 'DOCKER_HOST');
  if (dockerHost?.startsWith('unix://') === true) return dockerHost.slice('unix://'.length);
  const fromContext = contextSocket(home, env);
  const runtime = str(env, 'XDG_RUNTIME_DIR');
  const candidates = [
    ...(fromContext === null ? [] : [fromContext]),
    '/var/run/docker.sock',
    join(home, '.docker', 'run', 'docker.sock'),
    join(home, '.orbstack', 'run', 'docker.sock'),
    join(home, '.colima', 'default', 'docker.sock'),
    join(home, '.colima', 'docker.sock'),
    join(home, '.rd', 'docker.sock'),
    ...(runtime === undefined ? [] : [join(runtime, 'docker.sock')]),
  ];
  return candidates.find((candidate) => exists(candidate)) ?? '/var/run/docker.sock';
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const mode = str(env, 'NODE_ENV');
  const runtimeEnv: AppConfig['env'] = mode === 'production' ? 'production' : mode === 'test' ? 'test' : 'development';

  const rawDataDir = overrides.dataDir ?? str(env, 'PLOY_DATA_DIR') ?? (runtimeEnv === 'production' ? '/var/lib/torexploy' : 'data');
  const dataDir = isAbsolute(rawDataDir) ? rawDataDir : resolve(process.cwd(), rawDataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const logLevel = (str(env, 'PLOY_LOG_LEVEL') ?? (runtimeEnv === 'production' ? 'info' : 'debug')) as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) throw new ConfigError(`PLOY_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);

  const publicUrl = str(env, 'PLOY_PUBLIC_URL')?.replace(/\/+$/, '') ?? null;
  if (publicUrl !== null && !/^https?:\/\/[^/\s]+$/.test(publicUrl)) {
    throw new ConfigError('PLOY_PUBLIC_URL must be an origin such as https://deploy.example.com');
  }

  const defaultDist = join(repoRoot, 'packages/web/dist');
  const webDist = str(env, 'PLOY_WEB_DIST') ?? defaultDist;

  return {
    env: runtimeEnv,
    logLevel,
    dataDir,
    databasePath: join(dataDir, 'torexploy.db'),
    host: str(env, 'PLOY_HOST') ?? '0.0.0.0',
    port: int(env, 'PLOY_PORT', 3000, 1, 65_535),
    publicUrl,
    secretKey: resolveSecretKey(dataDir, str(env, 'PLOY_SECRET_KEY')),
    dockerSocket: resolveDockerSocket(env),
    controlUpstream: str(env, 'PLOY_CONTROL_UPSTREAM') ?? 'ploy-control:3000',
    webDist: existsSync(join(webDist, 'index.html')) ? webDist : null,
    proxyImage: str(env, 'PLOY_PROXY_IMAGE') ?? 'caddy:2.11-alpine',
    buildTimeoutMs: int(env, 'PLOY_BUILD_TIMEOUT_MINUTES', 30, 1, 360) * 60_000,
    drainMs: int(env, 'PLOY_DRAIN_SECONDS', 10, 0, 600) * 1000,
    hostProc: str(env, 'PLOY_HOST_PROC') ?? '/proc',
    timezone: str(env, 'PLOY_TIMEZONE') ?? 'Asia/Tashkent',
    version: readVersion(),
    ...overrides,
  };
}
