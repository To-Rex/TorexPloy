/**
 * One-click application templates.
 *
 * A template is an ordinary image-sourced application plus the databases it
 * needs: installing one creates the services, links them with a prefix and
 * writes the app's variables as `${PREFIX_…}` references to the link
 * variables, so credentials are never copied and rotate with the service.
 * Everything a template creates stays editable afterwards like any other app.
 *
 * Images and tags were checked against their registries; ports, volumes and
 * variables follow each project's own container documentation.
 */
import type { ServiceType, TemplateAccess, TemplateCategory } from '@ploy/shared';
import { generateToken } from '../lib/crypto.ts';

export interface TemplateContext {
  /** Public base URL without a trailing slash, or null when the app has no domain. */
  url: string | null;
  host: string | null;
  https: boolean;
  /** Email of the installing user (initial admin account where an image needs one). */
  email: string;
  timezone: string;
  /** A random alphanumeric secret, safe inside URLs and shell-free env values. */
  secret: (length?: number) => string;
}

export interface TemplateService {
  /** Suffix of the service name (`n8n-db`). */
  key: string;
  type: ServiceType;
  version?: string;
  /** Link prefix: the app reads `${DB_PGHOST}` and friends. */
  prefix: string;
}

export interface TemplateDefinition {
  id: string;
  name: string;
  category: TemplateCategory;
  website: string;
  image: string;
  port: number;
  volumes: readonly { name: string; mountPath: string }[];
  services: readonly TemplateService[];
  /** The app needs to know its public URL (absolute links, cookies, webhooks). */
  needsUrl: boolean;
  healthCheckPath: string | null;
  healthCheckTimeoutSec: number;
  /** Memory the app needs to run comfortably, shown before installing. */
  memoryMb: number;
  access: TemplateAccess;
  env: (t: TemplateContext) => Record<string, string>;
}

export function templateSecret(length = 32): string {
  let out = '';
  while (out.length < length) out += generateToken(length).replace(/[^A-Za-z0-9]/g, '');
  return out.slice(0, length);
}

const postgres = (key = 'db', prefix = 'DB_'): TemplateService => ({ key, type: 'postgres', version: '17', prefix });
const pg = {
  host: '${DB_PGHOST}',
  port: '${DB_PGPORT}',
  database: '${DB_PGDATABASE}',
  user: '${DB_PGUSER}',
  password: '${DB_PGPASSWORD}',
  url: '${DB_DATABASE_URL}',
};
const mysql = {
  host: '${DB_MYSQL_HOST}',
  port: '${DB_MYSQL_PORT}',
  database: '${DB_MYSQL_DATABASE}',
  user: '${DB_MYSQL_USER}',
  password: '${DB_MYSQL_PASSWORD}',
};

const defaults = { volumes: [], services: [], needsUrl: false, healthCheckPath: null, healthCheckTimeoutSec: 180 } as const;

export const TEMPLATES: readonly TemplateDefinition[] = [
  {
    ...defaults,
    id: 'n8n',
    name: 'n8n',
    category: 'automation',
    website: 'https://n8n.io',
    image: 'n8nio/n8n:stable',
    port: 5678,
    volumes: [{ name: 'n8n', mountPath: '/home/node/.n8n' }],
    services: [postgres()],
    needsUrl: true,
    healthCheckPath: '/healthz',
    healthCheckTimeoutSec: 300,
    memoryMb: 512,
    access: { kind: 'setup' },
    env: (t) => ({
      DB_TYPE: 'postgresdb',
      DB_POSTGRESDB_HOST: pg.host,
      DB_POSTGRESDB_PORT: pg.port,
      DB_POSTGRESDB_DATABASE: pg.database,
      DB_POSTGRESDB_USER: pg.user,
      DB_POSTGRESDB_PASSWORD: pg.password,
      N8N_ENCRYPTION_KEY: t.secret(32),
      N8N_HOST: t.host ?? '',
      N8N_PORT: '5678',
      N8N_PROTOCOL: t.https ? 'https' : 'http',
      WEBHOOK_URL: `${t.url}/`,
      N8N_PROXY_HOPS: '1',
      // n8n refuses to set its session cookie over plain HTTP unless told otherwise.
      N8N_SECURE_COOKIE: String(t.https),
      N8N_RUNNERS_ENABLED: 'true',
      N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'true',
      GENERIC_TIMEZONE: t.timezone,
      TZ: t.timezone,
    }),
  },
  {
    ...defaults,
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    category: 'monitoring',
    website: 'https://uptime.kuma.pet',
    image: 'louislam/uptime-kuma:2',
    port: 3001,
    volumes: [{ name: 'data', mountPath: '/app/data' }],
    memoryMb: 256,
    access: { kind: 'setup' },
    env: (t) => ({ TZ: t.timezone }),
  },
  {
    ...defaults,
    id: 'grafana',
    name: 'Grafana',
    category: 'monitoring',
    website: 'https://grafana.com/oss/grafana',
    image: 'grafana/grafana:latest',
    port: 3000,
    volumes: [{ name: 'data', mountPath: '/var/lib/grafana' }],
    healthCheckPath: '/api/health',
    memoryMb: 256,
    access: { kind: 'login', user: 'admin', passwordKey: 'GF_SECURITY_ADMIN_PASSWORD' },
    env: (t) => ({
      GF_SECURITY_ADMIN_USER: 'admin',
      GF_SECURITY_ADMIN_PASSWORD: t.secret(20),
      ...(t.url === null ? {} : { GF_SERVER_ROOT_URL: t.url }),
      GF_ANALYTICS_REPORTING_ENABLED: 'false',
    }),
  },
  {
    ...defaults,
    id: 'umami',
    name: 'Umami',
    category: 'analytics',
    website: 'https://umami.is',
    image: 'ghcr.io/umami-software/umami:3',
    port: 3000,
    services: [postgres()],
    healthCheckPath: '/api/heartbeat',
    healthCheckTimeoutSec: 300,
    memoryMb: 512,
    // Umami seeds a fixed first account; the UI tells the user to change it at once.
    access: { kind: 'default', user: 'admin', password: 'umami' },
    env: (t) => ({ DATABASE_URL: pg.url, APP_SECRET: t.secret(48) }),
  },
  {
    ...defaults,
    id: 'metabase',
    name: 'Metabase',
    category: 'analytics',
    website: 'https://www.metabase.com',
    image: 'metabase/metabase:latest',
    port: 3000,
    services: [postgres()],
    healthCheckPath: '/api/health',
    // The JVM and the first migration run take a while on small servers.
    healthCheckTimeoutSec: 600,
    memoryMb: 1536,
    access: { kind: 'setup' },
    env: (t) => ({
      MB_DB_TYPE: 'postgres',
      MB_DB_HOST: pg.host,
      MB_DB_PORT: pg.port,
      MB_DB_DBNAME: pg.database,
      MB_DB_USER: pg.user,
      MB_DB_PASS: pg.password,
      ...(t.url === null ? {} : { MB_SITE_URL: t.url }),
      JAVA_TIMEZONE: t.timezone,
    }),
  },
  {
    ...defaults,
    id: 'vaultwarden',
    name: 'Vaultwarden',
    category: 'security',
    website: 'https://github.com/dani-garcia/vaultwarden',
    image: 'vaultwarden/server:latest',
    port: 80,
    volumes: [{ name: 'data', mountPath: '/data' }],
    needsUrl: true,
    healthCheckPath: '/alive',
    memoryMb: 128,
    access: { kind: 'setup' },
    env: (t) => ({ DOMAIN: t.url ?? '', SIGNUPS_ALLOWED: 'true' }),
  },
  {
    ...defaults,
    id: 'gitea',
    name: 'Gitea',
    category: 'developer',
    website: 'https://about.gitea.com',
    image: 'gitea/gitea:latest',
    port: 3000,
    volumes: [{ name: 'data', mountPath: '/data' }],
    services: [postgres()],
    needsUrl: true,
    healthCheckPath: '/api/healthz',
    healthCheckTimeoutSec: 300,
    memoryMb: 512,
    access: { kind: 'setup' },
    env: (t) => ({
      USER_UID: '1000',
      USER_GID: '1000',
      GITEA__database__DB_TYPE: 'postgres',
      GITEA__database__HOST: `${pg.host}:${pg.port}`,
      GITEA__database__NAME: pg.database,
      GITEA__database__USER: pg.user,
      GITEA__database__PASSWD: pg.password,
      GITEA__server__DOMAIN: t.host ?? '',
      GITEA__server__ROOT_URL: `${t.url}/`,
      // Only HTTP(S) is routed to apps; Git over SSH would need a published port.
      GITEA__server__DISABLE_SSH: 'true',
    }),
  },
  {
    ...defaults,
    id: 'wordpress',
    name: 'WordPress',
    category: 'cms',
    website: 'https://wordpress.org',
    image: 'wordpress:6-apache',
    port: 80,
    volumes: [{ name: 'html', mountPath: '/var/www/html' }],
    services: [{ key: 'db', type: 'mariadb', version: '11.8', prefix: 'DB_' }],
    memoryMb: 512,
    access: { kind: 'setup' },
    // The image's wp-config honours X-Forwarded-Proto, so HTTPS behind the proxy works as is.
    env: () => ({
      WORDPRESS_DB_HOST: `${mysql.host}:${mysql.port}`,
      WORDPRESS_DB_USER: mysql.user,
      WORDPRESS_DB_PASSWORD: mysql.password,
      WORDPRESS_DB_NAME: mysql.database,
    }),
  },
  {
    ...defaults,
    id: 'ghost',
    name: 'Ghost',
    category: 'cms',
    website: 'https://ghost.org',
    image: 'ghost:6-alpine',
    port: 2368,
    volumes: [{ name: 'content', mountPath: '/var/lib/ghost/content' }],
    services: [{ key: 'db', type: 'mysql', version: '8.4', prefix: 'DB_' }],
    needsUrl: true,
    healthCheckTimeoutSec: 300,
    memoryMb: 512,
    access: { kind: 'setup', path: '/ghost' },
    env: (t) => ({
      url: t.url ?? '',
      database__client: 'mysql',
      database__connection__host: mysql.host,
      database__connection__port: mysql.port,
      database__connection__user: mysql.user,
      database__connection__password: mysql.password,
      database__connection__database: mysql.database,
    }),
  },
  {
    ...defaults,
    id: 'directus',
    name: 'Directus',
    category: 'cms',
    website: 'https://directus.io',
    image: 'directus/directus:11',
    port: 8055,
    volumes: [{ name: 'uploads', mountPath: '/directus/uploads' }],
    services: [postgres()],
    needsUrl: true,
    healthCheckPath: '/server/health',
    healthCheckTimeoutSec: 300,
    memoryMb: 512,
    access: { kind: 'login', user: { key: 'ADMIN_EMAIL' }, passwordKey: 'ADMIN_PASSWORD' },
    env: (t) => ({
      SECRET: t.secret(48),
      ADMIN_EMAIL: t.email,
      ADMIN_PASSWORD: t.secret(20),
      DB_CLIENT: 'pg',
      DB_HOST: pg.host,
      DB_PORT: pg.port,
      DB_DATABASE: pg.database,
      DB_USER: pg.user,
      DB_PASSWORD: pg.password,
      PUBLIC_URL: t.url ?? '',
    }),
  },
  {
    ...defaults,
    id: 'nocodb',
    name: 'NocoDB',
    category: 'productivity',
    website: 'https://nocodb.com',
    image: 'nocodb/nocodb:latest',
    port: 8080,
    volumes: [{ name: 'data', mountPath: '/usr/app/data' }],
    services: [postgres()],
    healthCheckPath: '/api/v1/health',
    healthCheckTimeoutSec: 300,
    memoryMb: 512,
    access: { kind: 'setup' },
    env: (t) => ({
      NC_DB: `pg://${pg.host}:${pg.port}?u=${pg.user}&p=${pg.password}&d=${pg.database}`,
      NC_AUTH_JWT_SECRET: t.secret(48),
      ...(t.url === null ? {} : { NC_PUBLIC_URL: t.url }),
    }),
  },
  {
    ...defaults,
    id: 'docmost',
    name: 'Docmost',
    category: 'productivity',
    website: 'https://docmost.com',
    image: 'docmost/docmost:latest',
    port: 3000,
    volumes: [{ name: 'storage', mountPath: '/app/data/storage' }],
    services: [postgres(), { key: 'redis', type: 'redis', version: '8', prefix: 'CACHE_' }],
    needsUrl: true,
    healthCheckTimeoutSec: 300,
    memoryMb: 512,
    access: { kind: 'setup' },
    env: (t) => ({ APP_URL: t.url ?? '', APP_SECRET: t.secret(48), DATABASE_URL: pg.url, REDIS_URL: '${CACHE_REDIS_URL}' }),
  },
  {
    ...defaults,
    id: 'meilisearch',
    name: 'Meilisearch',
    category: 'developer',
    website: 'https://www.meilisearch.com',
    image: 'getmeili/meilisearch:latest',
    port: 7700,
    volumes: [{ name: 'data', mountPath: '/meili_data' }],
    healthCheckPath: '/health',
    memoryMb: 512,
    access: { kind: 'key', key: 'MEILI_MASTER_KEY' },
    env: (t) => ({ MEILI_MASTER_KEY: t.secret(32), MEILI_ENV: 'production', MEILI_NO_ANALYTICS: 'true' }),
  },
  {
    ...defaults,
    id: 'mailpit',
    name: 'Mailpit',
    category: 'developer',
    website: 'https://mailpit.axllent.org',
    image: 'axllent/mailpit:latest',
    port: 8025,
    volumes: [{ name: 'data', mountPath: '/data' }],
    memoryMb: 64,
    access: { kind: 'login', user: 'admin', passwordKey: 'MAILPIT_PASSWORD' },
    env: (t) => {
      const password = t.secret(20);
      return {
        MAILPIT_PASSWORD: password,
        // The web UI is public through the proxy, so it gets basic auth; SMTP (1025) stays on the project network.
        MP_UI_AUTH: 'admin:${MAILPIT_PASSWORD}',
        MP_DATABASE: '/data/mailpit.db',
        MP_SMTP_AUTH_ACCEPT_ANY: '1',
        MP_SMTP_AUTH_ALLOW_INSECURE: '1',
      };
    },
  },
  {
    ...defaults,
    id: 'pgadmin',
    name: 'pgAdmin',
    category: 'database',
    website: 'https://www.pgadmin.org',
    image: 'dpage/pgadmin4:latest',
    port: 5050,
    volumes: [{ name: 'data', mountPath: '/var/lib/pgadmin' }],
    healthCheckPath: '/misc/ping',
    healthCheckTimeoutSec: 300,
    memoryMb: 256,
    access: { kind: 'login', user: { key: 'PGADMIN_DEFAULT_EMAIL' }, passwordKey: 'PGADMIN_DEFAULT_PASSWORD' },
    env: (t) => ({ PGADMIN_DEFAULT_EMAIL: t.email, PGADMIN_DEFAULT_PASSWORD: t.secret(20), PGADMIN_LISTEN_PORT: '5050' }),
  },
  {
    ...defaults,
    id: 'adminer',
    name: 'Adminer',
    category: 'database',
    website: 'https://www.adminer.org',
    image: 'adminer:latest',
    port: 8080,
    memoryMb: 64,
    access: { kind: 'database' },
    env: () => ({}),
  },
  {
    ...defaults,
    id: 'it-tools',
    name: 'IT Tools',
    category: 'developer',
    website: 'https://it-tools.tech',
    image: 'corentinth/it-tools:latest',
    port: 80,
    memoryMb: 32,
    access: { kind: 'open' },
    env: () => ({}),
  },
  {
    ...defaults,
    id: 'excalidraw',
    name: 'Excalidraw',
    category: 'productivity',
    website: 'https://excalidraw.com',
    image: 'excalidraw/excalidraw:latest',
    port: 80,
    memoryMb: 32,
    access: { kind: 'open' },
    env: () => ({}),
  },
  {
    ...defaults,
    id: 'stirling-pdf',
    name: 'Stirling PDF',
    category: 'productivity',
    website: 'https://www.stirlingpdf.com',
    image: 'stirlingtools/stirling-pdf:latest',
    port: 8080,
    healthCheckTimeoutSec: 300,
    memoryMb: 1024,
    access: { kind: 'open' },
    env: () => ({}),
  },
];

export function findTemplate(id: string): TemplateDefinition | undefined {
  return TEMPLATES.find((template) => template.id === id);
}
