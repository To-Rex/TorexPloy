/**
 * Runtime configuration.
 *
 * Configuration is environment driven with production-appropriate defaults.
 * Parsing happens once per `loadConfig()` call so entrypoints and tests each
 * get a consistent, validated snapshot, and invalid values fail fast at
 * startup instead of midway through a deployment.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type NodeEnv = 'development' | 'production' | 'test';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const NODE_ENVS: readonly NodeEnv[] = ['development', 'production', 'test'];

export interface AppConfig {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  logLevel: LogLevel;
  /** Absolute path to the state directory (database, logs, build cache). */
  dataDir: string;
  /** Absolute path to the SQLite database file. */
  databasePath: string;
  host: string;
  port: number;
  /** Public base URL, used for webhook payloads and OAuth callbacks. */
  publicUrl: string | null;
  /** Master key material for AES-256-GCM secret encryption. */
  secretKey: string;
  /** Whether the secret key was generated on first boot (as opposed to provided). */
  secretKeyGenerated: boolean;
  engine: 'docker' | 'local';
  dockerHost: string | null;
  proxy: 'caddy' | 'embedded' | 'external';
  caddyAdminUrl: string;
  /** Maximum simultaneous builds. */
  maxConcurrentBuilds: number;
  maxConcurrentDeployments: number;
  metricsRetentionDays: number;
  /** Grace period before old containers are stopped after a traffic switch. */
  drainTimeoutMs: number;
  /** Total budget for health-checking a new deployment before it is rejected. */
  healthCheckTimeoutMs: number;
  buildTimeoutMs: number;
  gitTimeoutMs: number;
  /** Seconds an agent-signed request remains valid. */
  agentSignatureTtlSeconds: number;
}

export interface ConfigOverrides {
  nodeEnv?: NodeEnv;
  logLevel?: LogLevel;
  dataDir?: string;
  host?: string;
  port?: number;
  publicUrl?: string | null;
  secretKey?: string;
  engine?: 'docker' | 'local';
  proxy?: 'caddy' | 'embedded' | 'external';
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function envString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = envString(env, key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(`${key} must be an integer, received "${raw}"`);
  }
  if (parsed < min || parsed > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max}, received ${parsed}`);
  }
  return parsed;
}

function envEnum<T extends string>(
  env: NodeJS.ProcessEnv,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = envString(env, key);
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ConfigError(`${key} must be one of ${allowed.join(', ')}, received "${raw}"`);
  }
  return raw as T;
}

function absoluteDataDir(input: string): string {
  return isAbsolute(input) ? input : resolve(process.cwd(), input);
}

/**
 * Resolve the secret-encryption master key.
 *
 * Precedence: explicit `PLOY_SECRET_KEY` → `data/secret.key` → freshly generated
 * key written with 0600 permissions. Generating on first boot keeps a fresh
 * self-hosted install zero-config without ever shipping a default key.
 */
function resolveSecretKey(
  dataDir: string,
  provided: string | undefined,
): { key: string; generated: boolean } {
  if (provided !== undefined) {
    if (provided.length < 32) {
      throw new ConfigError('PLOY_SECRET_KEY must be at least 32 characters long');
    }
    return { key: provided, generated: false };
  }

  const keyPath = join(dataDir, 'secret.key');
  if (existsSync(keyPath)) {
    const existing = readFileSync(keyPath, 'utf8').trim();
    if (existing.length < 32) {
      throw new ConfigError(`Secret key at ${keyPath} is corrupt (shorter than 32 characters)`);
    }
    return { key: existing, generated: false };
  }

  const generated = randomBytes(48).toString('base64url');
  writeFileSync(keyPath, `${generated}\n`, { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // Best effort: some filesystems (e.g. mounted volumes) ignore chmod.
  }
  return { key: generated, generated: true };
}

export function loadConfig(overrides: ConfigOverrides = {}, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = overrides.nodeEnv ?? envEnum(env, 'NODE_ENV', NODE_ENVS, 'development');
  const isProduction = nodeEnv === 'production';

  const dataDir = absoluteDataDir(overrides.dataDir ?? envString(env, 'PLOY_DATA_DIR') ?? 'data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const secret = resolveSecretKey(dataDir, overrides.secretKey ?? envString(env, 'PLOY_SECRET_KEY'));

  const port = overrides.port ?? envInt(env, 'PLOY_PORT', 4000, 1, 65535);
  const host = overrides.host ?? envString(env, 'PLOY_HOST') ?? '0.0.0.0';

  const publicUrl = overrides.publicUrl !== undefined
    ? overrides.publicUrl
    : (envString(env, 'PLOY_PUBLIC_URL') ?? null);
  if (publicUrl !== null && !/^https?:\/\//.test(publicUrl)) {
    throw new ConfigError(`PLOY_PUBLIC_URL must start with http:// or https://, received "${publicUrl}"`);
  }

  const engine = overrides.engine ?? envEnum(env, 'PLOY_ENGINE', ['docker', 'local'] as const, 'docker');
  const proxy = overrides.proxy
    ?? envEnum(env, 'PLOY_PROXY', ['caddy', 'embedded', 'external'] as const, 'caddy');

  return {
    nodeEnv,
    isProduction,
    logLevel: overrides.logLevel ?? envEnum(env, 'PLOY_LOG_LEVEL', LOG_LEVELS, isProduction ? 'info' : 'debug'),
    dataDir,
    databasePath: join(dataDir, 'ploy.db'),
    host,
    port,
    publicUrl,
    secretKey: secret.key,
    secretKeyGenerated: secret.generated,
    engine,
    dockerHost: envString(env, 'DOCKER_HOST') ?? null,
    proxy,
    caddyAdminUrl: envString(env, 'PLOY_CADDY_ADMIN_URL') ?? 'http://127.0.0.1:2019',
    maxConcurrentBuilds: envInt(env, 'PLOY_MAX_CONCURRENT_BUILDS', 2, 1, 64),
    maxConcurrentDeployments: envInt(env, 'PLOY_MAX_CONCURRENT_DEPLOYMENTS', 3, 1, 64),
    metricsRetentionDays: envInt(env, 'PLOY_METRICS_RETENTION_DAYS', 7, 1, 365),
    drainTimeoutMs: envInt(env, 'PLOY_DRAIN_TIMEOUT_MS', 10_000, 0, 600_000),
    healthCheckTimeoutMs: envInt(env, 'PLOY_HEALTH_CHECK_TIMEOUT_MS', 120_000, 1_000, 30 * 60_000),
    buildTimeoutMs: envInt(env, 'PLOY_BUILD_TIMEOUT_MS', 20 * 60_000, 1_000, 6 * 60 * 60_000),
    gitTimeoutMs: envInt(env, 'PLOY_GIT_TIMEOUT_MS', 5 * 60_000, 1_000, 60 * 60_000),
    agentSignatureTtlSeconds: envInt(env, 'PLOY_AGENT_SIGNATURE_TTL', 300, 30, 3_600),
  };
}