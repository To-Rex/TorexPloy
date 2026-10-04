/**
 * Managed service catalog.
 *
 * Each entry describes how to run a real database or cache: the image, the port
 * it listens on, where its data lives, the environment it needs, and the
 * connection string an application should use to reach it.
 *
 * Credentials are generated per instance with `generateToken`, never defaulted
 * to a well-known value like `postgres/postgres`, because a service reachable
 * from another container with a guessable password is a breach waiting to happen.
 */
import { generateToken } from '../crypto.ts';
import type { ServiceType } from '../domain/types.ts';

export interface ServiceDefinition {
  type: ServiceType;
  label: string;
  image: string;
  /** Suggested versions, newest first. */
  versions: string[];
  internalPort: number;
  /** Path inside the container that must be backed by a volume. */
  volumePath: string;
  /** Environment required to start the container, derived from credentials. */
  env: (credentials: Record<string, string>) => Record<string, string>;
  /** Connection URL an application uses, with `${host}` replaced at inject time. */
  connectionUrl: (credentials: Record<string, string>, host: string, port: number) => string;
  /** Health command run inside the container to confirm readiness. */
  healthCommand: string[];
}

function randomPassword(): string {
  // 32 base64url characters: ~192 bits of entropy, safe in a URL.
  return generateToken(24);
}

/** Build the credential set for a new instance of a service type. */
export function generateCredentials(type: ServiceType): Record<string, string> {
  const password = randomPassword();

  switch (type) {
    case 'postgres':
      return { POSTGRES_USER: 'ploy', POSTGRES_PASSWORD: password, POSTGRES_DB: 'app' };
    case 'mysql':
    case 'mariadb':
      return { MYSQL_USER: 'ploy', MYSQL_PASSWORD: password, MYSQL_DATABASE: 'app', MYSQL_ROOT_PASSWORD: randomPassword() };
    case 'mongo':
      return { MONGO_INITDB_ROOT_USERNAME: 'ploy', MONGO_INITDB_ROOT_PASSWORD: password, MONGO_INITDB_DATABASE: 'app' };
    case 'redis':
      return { REDIS_PASSWORD: password };
    case 'clickhouse':
      return { CLICKHOUSE_USER: 'ploy', CLICKHOUSE_PASSWORD: password, CLICKHOUSE_DB: 'app', CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1' };
    case 'rabbitmq':
      return { RABBITMQ_DEFAULT_USER: 'ploy', RABBITMQ_DEFAULT_PASS: password };
    case 'minio':
      return { MINIO_ROOT_USER: 'ploy', MINIO_ROOT_PASSWORD: password };
  }
}

export const SERVICE_CATALOG: Record<ServiceType, ServiceDefinition> = {
  postgres: {
    type: 'postgres',
    label: 'PostgreSQL',
    image: 'postgres',
    versions: ['17', '16', '15'],
    internalPort: 5432,
    volumePath: '/var/lib/postgresql/data',
    env: (credentials) => credentials,
    connectionUrl: (credentials, host, port) =>
      `postgresql://${credentials.POSTGRES_USER}:${encodeURIComponent(credentials.POSTGRES_PASSWORD ?? '')}@${host}:${port}/${credentials.POSTGRES_DB}`,
    healthCommand: ['pg_isready', '-U', 'ploy'],
  },
  mysql: {
    type: 'mysql',
    label: 'MySQL',
    image: 'mysql',
    versions: ['8.4', '8.0'],
    internalPort: 3306,
    volumePath: '/var/lib/mysql',
    env: (credentials) => credentials,
    connectionUrl: (credentials, host, port) =>
      `mysql://${credentials.MYSQL_USER}:${encodeURIComponent(credentials.MYSQL_PASSWORD ?? '')}@${host}:${port}/${credentials.MYSQL_DATABASE}`,
    healthCommand: ['mysqladmin', 'ping', '-h', '127.0.0.1'],
  },
  mariadb: {
    type: 'mariadb',
    label: 'MariaDB',
    image: 'mariadb',
    versions: ['11', '10.11'],
    internalPort: 3306,
    volumePath: '/var/lib/mysql',
    env: (credentials) => credentials,
    connectionUrl: (credentials, host, port) =>
      `mysql://${credentials.MYSQL_USER}:${encodeURIComponent(credentials.MYSQL_PASSWORD ?? '')}@${host}:${port}/${credentials.MYSQL_DATABASE}`,
    healthCommand: ['mariadb-admin', 'ping', '-h', '127.0.0.1'],
  },
  mongo: {
    type: 'mongo',
    label: 'MongoDB',
    image: 'mongo',
    versions: ['8', '7'],
    internalPort: 27017,
    volumePath: '/data/db',
    env: (credentials) => credentials,
    connectionUrl: (credentials, host, port) =>
      `mongodb://${credentials.MONGO_INITDB_ROOT_USERNAME}:${encodeURIComponent(credentials.MONGO_INITDB_ROOT_PASSWORD ?? '')}@${host}:${port}/${credentials.MONGO_INITDB_DATABASE}?authSource=admin`,
    healthCommand: ['mongosh', '--quiet', '--eval', 'db.runCommand({ ping: 1 }).ok'],
  },
  redis: {
    type: 'redis',
    label: 'Redis',
    image: 'redis',
    versions: ['7', '6'],
    internalPort: 6379,
    volumePath: '/data',
    // `--requirepass` is essential: a Redis without auth on a shared network is
    // an open data store.
    env: () => ({}),
    connectionUrl: (credentials, host, port) =>
      `redis://:${encodeURIComponent(credentials.REDIS_PASSWORD ?? '')}@${host}:${port}`,
    healthCommand: ['redis-cli', 'ping'],
  },
  clickhouse: {
    type: 'clickhouse',
    label: 'ClickHouse',
    image: 'clickhouse/clickhouse-server',
    versions: ['24', '23'],
    internalPort: 8123,
    volumePath: '/var/lib/clickhouse',
    env: (credentials) => credentials,
    connectionUrl: (credentials, host, port) =>
      `http://${credentials.CLICKHOUSE_USER}:${encodeURIComponent(credentials.CLICKHOUSE_PASSWORD ?? '')}@${host}:${port}`,
    healthCommand: ['wget', '--spider', '-q', 'http://127.0.0.1:8123/ping'],
  },
  rabbitmq: {
    type: 'rabbitmq',
    label: 'RabbitMQ',
    image: 'rabbitmq',
    versions: ['3.13-management', '3.12-management'],
    internalPort: 5672,
    volumePath: '/var/lib/rabbitmq',
    env: (credentials) => credentials,
    connectionUrl: (credentials, host, port) =>
      `amqp://${credentials.RABBITMQ_DEFAULT_USER}:${encodeURIComponent(credentials.RABBITMQ_DEFAULT_PASS ?? '')}@${host}:${port}`,
    healthCommand: ['rabbitmq-diagnostics', '-q', 'ping'],
  },
  minio: {
    type: 'minio',
    label: 'MinIO (S3)',
    image: 'minio/minio',
    versions: ['latest'],
    internalPort: 9000,
    volumePath: '/data',
    env: (credentials) => credentials,
    connectionUrl: (_credentials, host, port) => `http://${host}:${port}`,
    healthCommand: ['mc', 'ready', 'local'],
  },
};

export function serviceDefinition(type: ServiceType): ServiceDefinition {
  return SERVICE_CATALOG[type];
}

/** Extra arguments a service's container needs beyond its image defaults. */
export function serviceCommand(type: ServiceType, credentials: Record<string, string>): string[] | null {
  if (type === 'redis') {
    // Redis takes its password as an argument, not an environment variable.
    return ['redis-server', '--requirepass', credentials.REDIS_PASSWORD ?? '', '--appendonly', 'yes'];
  }
  if (type === 'minio') {
    return ['server', '/data', '--console-address', ':9001'];
  }
  return null;
}

/** Environment variables injected into an application that uses a service. */
export function serviceEnvForApplication(
  type: ServiceType,
  credentials: Record<string, string>,
  host: string,
  port: number,
): Record<string, string> {
  const definition = serviceDefinition(type);
  const url = definition.connectionUrl(credentials, host, port);

  const common: Record<string, string> = { DATABASE_URL: url };

  switch (type) {
    case 'postgres':
      return { ...common, POSTGRES_URL: url, POSTGRES_HOST: host, POSTGRES_PORT: String(port), POSTGRES_USER: credentials.POSTGRES_USER ?? '', POSTGRES_PASSWORD: credentials.POSTGRES_PASSWORD ?? '', POSTGRES_DB: credentials.POSTGRES_DB ?? '' };
    case 'mysql':
    case 'mariadb':
      return { ...common, MYSQL_URL: url, MYSQL_HOST: host, MYSQL_PORT: String(port), MYSQL_USER: credentials.MYSQL_USER ?? '', MYSQL_PASSWORD: credentials.MYSQL_PASSWORD ?? '', MYSQL_DATABASE: credentials.MYSQL_DATABASE ?? '' };
    case 'mongo':
      return { ...common, MONGO_URL: url, MONGO_HOST: host, MONGO_PORT: String(port) };
    case 'redis':
      return { REDIS_URL: url, REDIS_HOST: host, REDIS_PORT: String(port), REDIS_PASSWORD: credentials.REDIS_PASSWORD ?? '' };
    case 'clickhouse':
      return { ...common, CLICKHOUSE_URL: url, CLICKHOUSE_HOST: host, CLICKHOUSE_PORT: String(port), CLICKHOUSE_USER: credentials.CLICKHOUSE_USER ?? '', CLICKHOUSE_PASSWORD: credentials.CLICKHOUSE_PASSWORD ?? '' };
    case 'rabbitmq':
      return { AMQP_URL: url, RABBITMQ_URL: url, RABBITMQ_HOST: host, RABBITMQ_PORT: String(port) };
    case 'minio':
      return { S3_ENDPOINT: url, S3_ACCESS_KEY: credentials.MINIO_ROOT_USER ?? '', S3_SECRET_KEY: credentials.MINIO_ROOT_PASSWORD ?? '' };
  }
}

export const SERVICE_TYPES: ServiceType[] = Object.keys(SERVICE_CATALOG) as ServiceType[];
