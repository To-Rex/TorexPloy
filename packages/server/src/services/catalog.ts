/**
 * Database and infrastructure service catalog.
 *
 * Each entry knows how to run its official image safely, how to tell when it
 * is healthy (a native Docker HEALTHCHECK), what a linked application needs
 * to connect, and — where the engine supports it — how to stream a backup out
 * and restore one in.
 *
 * Credentials are never placed on a command line: they reach the server
 * process through environment variables, so they do not show up in `ps` on
 * the host.
 */
import type { ServiceCredentialField, ServiceType } from '@ploy/shared';
import { generateToken } from '../lib/crypto.ts';
import { randomId } from '../lib/ids.ts';

export interface Credentials {
  username: string | null;
  password: string;
  database: string | null;
  /** Separate superuser password for engines that distinguish it (MySQL, MariaDB). */
  rootPassword?: string;
}

/** A file written into the container before its first start (configuration the engine reads from disk). */
export interface SeedFile {
  /** Directory inside the container; created when missing. */
  dir: string;
  name: string;
  content: string;
  mode?: number;
}

export interface ContainerTemplate {
  image: string;
  env: Record<string, string>;
  /** Replaces the image's entrypoint when its wrapper script would add flags of its own. */
  entrypoint?: string[];
  cmd?: string[];
  mountPath: string;
  healthcheck: string[];
  files?: SeedFile[];
}

export interface BackupSpec {
  /** File extension of the produced artifact (gzip is applied by the platform when `gzip` is true). */
  extension: string;
  gzip: boolean;
  /** Command whose stdout is the backup. */
  dump: (credentials: Credentials) => string[];
  /** Command that restores from `path` inside the container; null when restore is not supported. */
  restore: ((credentials: Credentials, path: string) => string[]) | null;
}

export interface CatalogEntry {
  type: ServiceType;
  label: string;
  versions: string[];
  defaultVersion: string;
  port: number;
  /** Default memory ceiling for a new service, in MB. */
  memoryMb: number;
  credentials: () => Credentials;
  container: (version: string, credentials: Credentials) => ContainerTemplate;
  /** Variables a linked application receives, given the in-network host and port. */
  connection: (credentials: Credentials, host: string, port: number) => { url: string; env: Record<string, string> };
  backup: BackupSpec | null;
}

const password = (): string => generateToken(24).replace(/[-_]/g, 'x');
/** 40 characters, the length of an AWS secret access key. */
const secretKey = (): string => generateToken(30).replace(/[-_]/g, 'x');
const encode = encodeURIComponent;

/** Actions SeaweedFS grants the root identity of a file store (everything, on every bucket). */
export const STORAGE_ROOT_ACTIONS = ['Admin', 'Read', 'Write', 'List', 'Tagging'];

/** The static identity file the S3 gateway starts with; dynamic identities (keys, public buckets) are merged in by `weed shell`. */
export function storageIdentityFile(credentials: Credentials): string {
  return JSON.stringify({ identities: [{ name: 'root', credentials: [{ accessKey: credentials.username, secretKey: credentials.password }], actions: STORAGE_ROOT_ACTIONS }] });
}

/**
 * SeaweedFS gives every bucket its own collection and, by default, grows a
 * collection by seven volumes at a time; with 1 GB volumes a handful of
 * buckets would reserve the whole disk. One volume at a time keeps a bucket's
 * footprint proportional to its contents.
 */
const STORAGE_MASTER_TOML = ['[master.volume_growth]', 'copy_1 = 1', 'copy_2 = 1', 'copy_3 = 1', 'copy_other = 1', ''].join('\n');

/** Run a command through `sh -c` so it can read credentials from the container's environment. */
const sh = (script: string): string[] => ['sh', '-c', script];

export const CATALOG: Record<ServiceType, CatalogEntry> = {
  postgres: {
    type: 'postgres',
    label: 'PostgreSQL',
    versions: ['18', '17', '16', '15'],
    defaultVersion: '17',
    port: 5432,
    memoryMb: 1024,
    credentials: () => ({ username: `u${randomId(8)}`, password: password(), database: 'app' }),
    container: (version, c) => ({
      image: `postgres:${version}-alpine`,
      env: { POSTGRES_USER: c.username!, POSTGRES_PASSWORD: c.password, POSTGRES_DB: c.database! },
      // PostgreSQL 18 images declare the volume one level up; mounting anywhere else would hide data in an anonymous volume.
      mountPath: Number(version) >= 18 ? '/var/lib/postgresql' : '/var/lib/postgresql/data',
      healthcheck: sh('pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" -h 127.0.0.1'),
    }),
    connection: (c, host, port) => {
      const url = `postgresql://${encode(c.username!)}:${encode(c.password)}@${host}:${port}/${encode(c.database!)}`;
      return {
        url,
        env: { DATABASE_URL: url, PGHOST: host, PGPORT: String(port), PGUSER: c.username!, PGPASSWORD: c.password, PGDATABASE: c.database! },
      };
    },
    backup: {
      extension: 'dump',
      gzip: false,
      dump: () => sh('pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6 --no-owner'),
      restore: (_c, path) => sh(`pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction "${path}"`),
    },
  },

  mysql: {
    type: 'mysql',
    label: 'MySQL',
    versions: ['8.4', '9.4'],
    defaultVersion: '8.4',
    port: 3306,
    memoryMb: 1024,
    credentials: () => ({ username: `u${randomId(8)}`, password: password(), database: 'app', rootPassword: password() }),
    container: (version, c) => ({
      image: `mysql:${version}`,
      env: { MYSQL_ROOT_PASSWORD: c.rootPassword!, MYSQL_DATABASE: c.database!, MYSQL_USER: c.username!, MYSQL_PASSWORD: c.password },
      mountPath: '/var/lib/mysql',
      healthcheck: sh('MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqladmin ping -h 127.0.0.1 -uroot --silent'),
    }),
    connection: (c, host, port) => {
      const url = `mysql://${encode(c.username!)}:${encode(c.password)}@${host}:${port}/${encode(c.database!)}`;
      return {
        url,
        env: { DATABASE_URL: url, MYSQL_HOST: host, MYSQL_PORT: String(port), MYSQL_USER: c.username!, MYSQL_PASSWORD: c.password, MYSQL_DATABASE: c.database! },
      };
    },
    backup: {
      extension: 'sql',
      gzip: true,
      dump: () => sh('MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -uroot --single-transaction --routines --triggers --no-tablespaces "$MYSQL_DATABASE"'),
      restore: (_c, path) => sh(`gunzip -c "${path}" | MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot "$MYSQL_DATABASE"`),
    },
  },

  mariadb: {
    type: 'mariadb',
    label: 'MariaDB',
    versions: ['11.8', '11.4', '10.11'],
    defaultVersion: '11.8',
    port: 3306,
    memoryMb: 1024,
    credentials: () => ({ username: `u${randomId(8)}`, password: password(), database: 'app', rootPassword: password() }),
    container: (version, c) => ({
      image: `mariadb:${version}`,
      env: { MARIADB_ROOT_PASSWORD: c.rootPassword!, MARIADB_DATABASE: c.database!, MARIADB_USER: c.username!, MARIADB_PASSWORD: c.password },
      mountPath: '/var/lib/mysql',
      healthcheck: ['healthcheck.sh', '--connect', '--innodb_initialized'],
    }),
    connection: (c, host, port) => {
      const url = `mysql://${encode(c.username!)}:${encode(c.password)}@${host}:${port}/${encode(c.database!)}`;
      return {
        url,
        env: { DATABASE_URL: url, MYSQL_HOST: host, MYSQL_PORT: String(port), MYSQL_USER: c.username!, MYSQL_PASSWORD: c.password, MYSQL_DATABASE: c.database! },
      };
    },
    backup: {
      extension: 'sql',
      gzip: true,
      dump: () => sh('MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb-dump -uroot --single-transaction --routines --triggers "$MARIADB_DATABASE"'),
      restore: (_c, path) => sh(`gunzip -c "${path}" | MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb -uroot "$MARIADB_DATABASE"`),
    },
  },

  mongo: {
    type: 'mongo',
    label: 'MongoDB',
    versions: ['8.0', '7.0'],
    defaultVersion: '8.0',
    port: 27017,
    memoryMb: 1024,
    credentials: () => ({ username: `u${randomId(8)}`, password: password(), database: 'app' }),
    container: (version, c) => ({
      image: `mongo:${version}`,
      env: { MONGO_INITDB_ROOT_USERNAME: c.username!, MONGO_INITDB_ROOT_PASSWORD: c.password, MONGO_INITDB_DATABASE: c.database! },
      mountPath: '/data/db',
      healthcheck: sh(`mongosh --quiet --eval "db.adminCommand('ping').ok" | grep -q 1`),
    }),
    connection: (c, host, port) => {
      const url = `mongodb://${encode(c.username!)}:${encode(c.password)}@${host}:${port}/${encode(c.database!)}?authSource=admin`;
      return { url, env: { MONGO_URL: url, MONGODB_URI: url, DATABASE_URL: url } };
    },
    backup: {
      extension: 'archive.gz',
      gzip: false,
      dump: () => sh('mongodump --quiet --archive --gzip -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'),
      restore: (_c, path) =>
        sh(`mongorestore --quiet --drop --archive="${path}" --gzip -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin`),
    },
  },

  redis: {
    type: 'redis',
    label: 'Redis',
    versions: ['8', '7.4'],
    defaultVersion: '8',
    port: 6379,
    memoryMb: 512,
    credentials: () => ({ username: null, password: password(), database: null }),
    container: (version, c) => ({
      image: `redis:${version}-alpine`,
      env: { REDIS_PASSWORD: c.password },
      cmd: sh('exec redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes --save 60 1000 --dir /data'),
      mountPath: '/data',
      healthcheck: sh('redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping | grep -q PONG'),
    }),
    connection: (c, host, port) => {
      const url = `redis://default:${encode(c.password)}@${host}:${port}`;
      return { url, env: { REDIS_URL: url, REDIS_HOST: host, REDIS_PORT: String(port), REDIS_PASSWORD: c.password } };
    },
    backup: {
      extension: 'rdb',
      gzip: true,
      dump: () => sh('redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --rdb /tmp/ploy-backup.rdb >/dev/null && cat /tmp/ploy-backup.rdb && rm -f /tmp/ploy-backup.rdb'),
      restore: null,
    },
  },

  rabbitmq: {
    type: 'rabbitmq',
    label: 'RabbitMQ',
    versions: ['4.1', '3.13'],
    defaultVersion: '4.1',
    port: 5672,
    memoryMb: 512,
    credentials: () => ({ username: `u${randomId(8)}`, password: password(), database: null }),
    container: (version, c) => ({
      image: `rabbitmq:${version}-management-alpine`,
      env: { RABBITMQ_DEFAULT_USER: c.username!, RABBITMQ_DEFAULT_PASS: c.password },
      mountPath: '/var/lib/rabbitmq',
      healthcheck: ['rabbitmq-diagnostics', '-q', 'ping'],
    }),
    connection: (c, host, port) => {
      const url = `amqp://${encode(c.username!)}:${encode(c.password)}@${host}:${port}`;
      return { url, env: { AMQP_URL: url, RABBITMQ_URL: url } };
    },
    backup: null,
  },

  minio: {
    type: 'minio',
    label: 'MinIO (S3)',
    versions: ['latest'],
    defaultVersion: 'latest',
    port: 9000,
    memoryMb: 512,
    credentials: () => ({ username: `ploy${randomId(10)}`, password: password(), database: null }),
    container: (version, c) => ({
      // MinIO Inc. stopped publishing community images (Docker Hub and Quay); pgsty/minio is the maintained drop-in fork.
      // It ships curl but not mc, so the health check uses MinIO's own liveness endpoint.
      image: `pgsty/minio:${version}`,
      env: { MINIO_ROOT_USER: c.username!, MINIO_ROOT_PASSWORD: c.password },
      cmd: ['server', '/data', '--console-address', ':9001'],
      mountPath: '/data',
      healthcheck: ['curl', '-fsS', '-o', '/dev/null', 'http://127.0.0.1:9000/minio/health/live'],
    }),
    connection: (c, host, port) => {
      const url = `http://${host}:${port}`;
      return {
        url,
        env: {
          S3_ENDPOINT: url,
          S3_ACCESS_KEY_ID: c.username!,
          S3_SECRET_ACCESS_KEY: c.password,
          AWS_ACCESS_KEY_ID: c.username!,
          AWS_SECRET_ACCESS_KEY: c.password,
          AWS_ENDPOINT_URL_S3: url,
          AWS_REGION: 'us-east-1',
        },
      };
    },
    backup: null,
  },

  clickhouse: {
    type: 'clickhouse',
    label: 'ClickHouse',
    versions: ['25.8', '24.8'],
    defaultVersion: '25.8',
    port: 8123,
    memoryMb: 2048,
    credentials: () => ({ username: `u${randomId(8)}`, password: password(), database: 'app' }),
    container: (version, c) => ({
      image: `clickhouse/clickhouse-server:${version}-alpine`,
      env: { CLICKHOUSE_USER: c.username!, CLICKHOUSE_PASSWORD: c.password, CLICKHOUSE_DB: c.database!, CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1' },
      mountPath: '/var/lib/clickhouse',
      healthcheck: sh('wget -q --spider http://127.0.0.1:8123/ping'),
    }),
    connection: (c, host, port) => {
      const url = `http://${encode(c.username!)}:${encode(c.password)}@${host}:${port}/${encode(c.database!)}`;
      return { url, env: { CLICKHOUSE_URL: url, CLICKHOUSE_HOST: host, CLICKHOUSE_USER: c.username!, CLICKHOUSE_PASSWORD: c.password, CLICKHOUSE_DATABASE: c.database! } };
    },
    backup: null,
  },

  files: {
    type: 'files',
    label: 'File store (S3)',
    versions: ['4.48'],
    defaultVersion: '4.48',
    port: 8333,
    memoryMb: 512,
    credentials: () => ({ username: `ploy${randomId(12)}`, password: secretKey(), database: null }),
    container: (version, c) => ({
      // SeaweedFS: master, volume server, filer and S3 gateway in one process. Only the S3 port is reachable
      // from the project network; master, filer and volume server listen on the container's loopback, where
      // the health check, `weed shell` (identities) and usage queries find them.
      image: `chrislusf/seaweedfs:${version}`,
      env: {},
      // The image's entrypoint appends flags of its own (volume preallocation among them); call the binary directly.
      entrypoint: ['/usr/bin/weed'],
      cmd: [
        'server',
        '-dir=/data',
        '-ip=127.0.0.1',
        '-ip.bind=127.0.0.1',
        '-s3.ip.bind=0.0.0.0',
        '-master.volumeSizeLimitMB=1024',
        '-volume.max=0',
        '-filer',
        '-s3',
        '-s3.port=8333',
        '-s3.port.iceberg=0',
        '-s3.port.lance=0',
        '-s3.allowDeleteBucketNotEmpty=false',
        '-s3.autoCreateBucket=false',
        '-s3.config=/data/s3.json',
        '-metricsPort=9327',
      ],
      mountPath: '/data',
      healthcheck: sh('wget -qO- http://127.0.0.1:9333/cluster/status'),
      files: [
        { dir: '/data', name: 's3.json', content: storageIdentityFile(c), mode: 0o600 },
        { dir: '/etc/seaweedfs', name: 'master.toml', content: STORAGE_MASTER_TOML },
      ],
    }),
    connection: (c, host, port) => {
      const url = `http://${host}:${port}`;
      return {
        url,
        env: {
          S3_ENDPOINT: url,
          S3_ACCESS_KEY_ID: c.username!,
          S3_SECRET_ACCESS_KEY: c.password,
          S3_REGION: 'us-east-1',
          S3_FORCE_PATH_STYLE: 'true',
          S3_BUCKET: '',
          AWS_ENDPOINT_URL: url,
          AWS_ACCESS_KEY_ID: c.username!,
          AWS_SECRET_ACCESS_KEY: c.password,
          AWS_REGION: 'us-east-1',
        },
      };
    },
    // The engine's data lives on its volume; backups of other services can be written into the store instead.
    backup: null,
  },
};

export function catalogEntry(type: ServiceType): CatalogEntry {
  return CATALOG[type];
}

/** The credential fields an engine actually has (Redis has no user name or database; MySQL adds a root password). */
export function credentialFields(type: ServiceType): ServiceCredentialField[] {
  const sample = CATALOG[type].credentials();
  const fields: ServiceCredentialField[] = [];
  if (sample.username !== null) fields.push('username');
  fields.push('password');
  if (sample.database !== null) fields.push('database');
  if (sample.rootPassword !== undefined) fields.push('rootPassword');
  return fields;
}

/** Variables injected into an application linked to a service, with an optional prefix (`CACHE_` → `CACHE_REDIS_URL`). */
export function linkEnv(entry: CatalogEntry, credentials: Credentials, host: string, port: number, prefix: string): Record<string, string> {
  const { env } = entry.connection(credentials, host, port);
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [`${prefix}${key}`, value]));
}
