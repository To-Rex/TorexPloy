/**
 * Everything attached to applications and projects: variables, domains,
 * volumes, database services and their links, cron jobs, backups, GitHub
 * installations and metric samples.
 */
import type { BackupStatus, CronRunStatus, DnsStatus, ServiceStatus, ServiceType, TlsStatus } from '@ploy/shared';
import type { Database } from '../db/database.ts';
import { newId, nowIso } from '../lib/ids.ts';
import type { Secrets } from '../lib/secrets.ts';
import type { Credentials as ServiceCredentials } from '../services/catalog.ts';
import { bool, int01, json, num, numOrNull, str, strOrNull, type Row } from './util.ts';

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

export type EnvOwner = { projectId: string } | { applicationId: string };

export class EnvStore {
  private readonly db: Database;
  private readonly secrets: Secrets;

  constructor(db: Database, secrets: Secrets) {
    this.db = db;
    this.secrets = secrets;
  }

  private where(owner: EnvOwner): [string, string] {
    return 'projectId' in owner ? ['project_id = ?', owner.projectId] : ['application_id = ?', owner.applicationId];
  }

  list(owner: EnvOwner): { key: string; value: string }[] {
    const [clause, id] = this.where(owner);
    return this.db
      .all(`SELECT key, value FROM env_vars WHERE ${clause} ORDER BY position, key`, id)
      .map((row) => ({ key: str(row.key), value: this.secrets.open(str(row.value), 'env') }));
  }

  /** Latest change to the set, for the editor's "last updated" hint. */
  updatedAt(owner: EnvOwner): string | null {
    const [clause, id] = this.where(owner);
    return strOrNull(this.db.scalar(`SELECT MAX(updated_at) FROM env_vars WHERE ${clause}`, id));
  }

  /** Atomically replace the whole set. Returns true when anything changed. */
  replace(owner: EnvOwner, variables: { key: string; value: string }[]): boolean {
    const before = this.list(owner);
    const same =
      before.length === variables.length && before.every((item, index) => item.key === variables[index]!.key && item.value === variables[index]!.value);
    if (same) return false;

    const [clause, id] = this.where(owner);
    const now = nowIso();
    this.db.transaction(() => {
      this.db.run(`DELETE FROM env_vars WHERE ${clause}`, id);
      variables.forEach((variable, position) => {
        this.db.run(
          'INSERT INTO env_vars (id, project_id, application_id, key, value, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          newId('env'),
          'projectId' in owner ? owner.projectId : null,
          'applicationId' in owner ? owner.applicationId : null,
          variable.key,
          this.secrets.seal(variable.value, 'env'),
          position,
          now,
          now,
        );
      });
    });
    return true;
  }
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export interface DomainRecord {
  id: string;
  applicationId: string;
  teamId: string;
  host: string;
  /** Path prefix routed by this domain; '/' is the whole host. */
  path: string;
  /** Remove the prefix before the request reaches the app. */
  stripPath: boolean;
  https: boolean;
  port: number | null;
  /** Compose: the service that receives the traffic. */
  serviceName: string | null;
  /** Redirect-only domain: the origin requests are sent to (`https://example.uz`). */
  redirectTo: string | null;
  isGenerated: boolean;
  dnsStatus: DnsStatus;
  dnsRecords: string[];
  dnsCheckedAt: string | null;
  tlsStatus: TlsStatus;
  tlsIssuer: string | null;
  tlsExpiresAt: string | null;
  tlsMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapDomain(row: Row): DomainRecord {
  return {
    id: str(row.id),
    applicationId: str(row.application_id),
    teamId: str(row.team_id),
    host: str(row.host),
    path: str(row.path),
    stripPath: bool(row.strip_path),
    https: bool(row.https),
    port: numOrNull(row.port),
    serviceName: strOrNull(row.service_name),
    redirectTo: strOrNull(row.redirect_to),
    isGenerated: bool(row.is_generated),
    dnsStatus: str(row.dns_status) as DnsStatus,
    dnsRecords: json<string[]>(row.dns_records, []),
    dnsCheckedAt: strOrNull(row.dns_checked_at),
    tlsStatus: str(row.tls_status) as TlsStatus,
    tlsIssuer: strOrNull(row.tls_issuer),
    tlsExpiresAt: strOrNull(row.tls_expires_at),
    tlsMessage: strOrNull(row.tls_message),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export class DomainStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: {
    applicationId: string;
    teamId: string;
    host: string;
    https: boolean;
    port: number | null;
    isGenerated: boolean;
    path?: string;
    stripPath?: boolean;
    serviceName?: string | null;
    redirectTo?: string | null;
  }): DomainRecord {
    const id = newId('dom');
    const now = nowIso();
    this.db.run(
      `INSERT INTO domains (id, application_id, team_id, host, path, strip_path, https, port, service_name, redirect_to, is_generated, tls_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.applicationId,
      input.teamId,
      input.host.toLowerCase(),
      input.path ?? '/',
      int01(input.stripPath ?? false),
      int01(input.https),
      input.port,
      input.serviceName ?? null,
      input.redirectTo ?? null,
      int01(input.isGenerated),
      input.https ? 'pending' : 'disabled',
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): DomainRecord | undefined {
    const row = this.db.get('SELECT * FROM domains WHERE id = ?', id);
    return row === undefined ? undefined : mapDomain(row);
  }

  getForTeam(teamId: string, id: string): DomainRecord | undefined {
    const row = this.db.get('SELECT * FROM domains WHERE id = ? AND team_id = ?', id, teamId);
    return row === undefined ? undefined : mapDomain(row);
  }

  /** Any route on this host (any path). */
  findByHost(host: string): DomainRecord | undefined {
    const row = this.db.get('SELECT * FROM domains WHERE host = ? ORDER BY path', host.toLowerCase());
    return row === undefined ? undefined : mapDomain(row);
  }

  /** The route for exactly this host and path prefix. */
  findRoute(host: string, path: string): DomainRecord | undefined {
    const row = this.db.get('SELECT * FROM domains WHERE host = ? AND path = ?', host.toLowerCase(), path);
    return row === undefined ? undefined : mapDomain(row);
  }

  listForApplication(applicationId: string): DomainRecord[] {
    return this.db
      .all('SELECT * FROM domains WHERE application_id = ? ORDER BY is_generated, created_at', applicationId)
      .map(mapDomain);
  }

  listForServer(serverId: string): DomainRecord[] {
    return this.db
      .all('SELECT d.* FROM domains d JOIN applications a ON a.id = d.application_id WHERE a.server_id = ? ORDER BY d.host, d.path', serverId)
      .map(mapDomain);
  }

  /** The address an application is opened at: its first own domain, else a generated one. */
  primaryUrl(applicationId: string): string | null {
    const domains = this.listForApplication(applicationId);
    const primary = domains.find((domain) => !domain.isGenerated) ?? domains[0];
    return primary === undefined ? null : `${primary.https ? 'https' : 'http'}://${primary.host}`;
  }

  listAll(): DomainRecord[] {
    return this.db.all('SELECT * FROM domains ORDER BY host').map(mapDomain);
  }

  update(id: string, patch: { https?: boolean; port?: number | null; stripPath?: boolean; serviceName?: string | null; redirectTo?: string | null }): void {
    const current = this.get(id);
    if (current === undefined) return;
    const https = patch.https ?? current.https;
    this.db.run(
      `UPDATE domains SET https = ?, port = ?, strip_path = ?, service_name = ?, redirect_to = ?, updated_at = ?,
              tls_status = CASE WHEN ? = 0 THEN 'disabled' WHEN tls_status = 'disabled' THEN 'pending' ELSE tls_status END
        WHERE id = ?`,
      int01(https),
      patch.port === undefined ? current.port : patch.port,
      int01(patch.stripPath ?? current.stripPath),
      patch.serviceName === undefined ? current.serviceName : patch.serviceName,
      patch.redirectTo === undefined ? current.redirectTo : patch.redirectTo,
      nowIso(),
      int01(https),
      id,
    );
  }

  setDns(id: string, status: DnsStatus, records: string[]): void {
    this.db.run(
      'UPDATE domains SET dns_status = ?, dns_records = ?, dns_checked_at = ?, updated_at = ? WHERE id = ?',
      status,
      JSON.stringify(records),
      nowIso(),
      nowIso(),
      id,
    );
  }

  setTls(id: string, status: TlsStatus, details: { issuer?: string | null; expiresAt?: string | null; message?: string | null }): void {
    this.db.run(
      'UPDATE domains SET tls_status = ?, tls_issuer = ?, tls_expires_at = ?, tls_message = ?, updated_at = ? WHERE id = ?',
      status,
      details.issuer ?? null,
      details.expiresAt ?? null,
      details.message ?? null,
      nowIso(),
      id,
    );
  }

  delete(id: string): void {
    this.db.run('DELETE FROM domains WHERE id = ?', id);
  }
}

// ---------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------

export interface VolumeRecord {
  id: string;
  applicationId: string;
  name: string;
  mountPath: string;
  dockerVolume: string;
  createdAt: string;
}

function mapVolume(row: Row): VolumeRecord {
  return {
    id: str(row.id),
    applicationId: str(row.application_id),
    name: str(row.name),
    mountPath: str(row.mount_path),
    dockerVolume: str(row.docker_volume),
    createdAt: str(row.created_at),
  };
}

export class VolumeStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(applicationId: string, name: string, mountPath: string, dockerVolume: string): VolumeRecord {
    const id = newId('vol');
    this.db.run(
      'INSERT INTO volumes (id, application_id, name, mount_path, docker_volume, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      applicationId,
      name,
      mountPath,
      dockerVolume,
      nowIso(),
    );
    return this.get(id)!;
  }

  get(id: string): VolumeRecord | undefined {
    const row = this.db.get('SELECT * FROM volumes WHERE id = ?', id);
    return row === undefined ? undefined : mapVolume(row);
  }

  listForApplication(applicationId: string): VolumeRecord[] {
    return this.db.all('SELECT * FROM volumes WHERE application_id = ? ORDER BY created_at', applicationId).map(mapVolume);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM volumes WHERE id = ?', id);
  }
}

// ---------------------------------------------------------------------------
// Database services and links
// ---------------------------------------------------------------------------

export type { ServiceCredentials };


export interface ServiceRecord {
  id: string;
  projectId: string;
  teamId: string;
  serverId: string;
  name: string;
  slug: string;
  type: ServiceType;
  version: string;
  status: ServiceStatus;
  statusMessage: string | null;
  statusReason: string | null;
  credentials: ServiceCredentials;
  internalPort: number;
  publicPort: number | null;
  cpuLimit: number | null;
  memoryLimitMb: number | null;
  backupSchedule: string | null;
  backupRetention: number;
  backupDestinationId: string | null;
  containerName: string;
  volumeName: string;
  createdAt: string;
  updatedAt: string;
}

export class ServiceStore {
  private readonly db: Database;
  private readonly secrets: Secrets;

  constructor(db: Database, secrets: Secrets) {
    this.db = db;
    this.secrets = secrets;
  }

  private map(row: Row): ServiceRecord {
    return {
      id: str(row.id),
      projectId: str(row.project_id),
      teamId: str(row.team_id),
      serverId: str(row.server_id),
      name: str(row.name),
      slug: str(row.slug),
      type: str(row.type) as ServiceType,
      version: str(row.version),
      status: str(row.status) as ServiceStatus,
      statusMessage: strOrNull(row.status_message),
      statusReason: strOrNull(row.status_reason),
      credentials: this.secrets.openJson<ServiceCredentials>(str(row.credentials), 'service'),
      internalPort: num(row.internal_port),
      publicPort: numOrNull(row.public_port),
      cpuLimit: numOrNull(row.cpu_limit),
      memoryLimitMb: numOrNull(row.memory_limit_mb),
      backupSchedule: strOrNull(row.backup_schedule),
      backupRetention: num(row.backup_retention),
      backupDestinationId: strOrNull(row.backup_destination_id),
      containerName: str(row.container_name),
      volumeName: str(row.volume_name),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }

  create(input: {
    id: string;
    projectId: string;
    teamId: string;
    serverId: string;
    name: string;
    slug: string;
    type: ServiceType;
    version: string;
    credentials: ServiceCredentials;
    internalPort: number;
    containerName: string;
    volumeName: string;
    memoryLimitMb: number | null;
  }): ServiceRecord {
    const now = nowIso();
    this.db.run(
      `INSERT INTO services (id, project_id, team_id, server_id, name, slug, type, version, credentials, internal_port,
         memory_limit_mb, container_name, volume_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.projectId,
      input.teamId,
      input.serverId,
      input.name,
      input.slug,
      input.type,
      input.version,
      this.secrets.sealJson(input.credentials, 'service'),
      input.internalPort,
      input.memoryLimitMb,
      input.containerName,
      input.volumeName,
      now,
      now,
    );
    return this.get(input.id)!;
  }

  get(id: string): ServiceRecord | undefined {
    const row = this.db.get('SELECT * FROM services WHERE id = ?', id);
    return row === undefined ? undefined : this.map(row);
  }

  getForTeam(teamId: string, id: string): ServiceRecord | undefined {
    const row = this.db.get('SELECT * FROM services WHERE id = ? AND team_id = ?', id, teamId);
    return row === undefined ? undefined : this.map(row);
  }

  listForProject(projectId: string): ServiceRecord[] {
    return this.db.all('SELECT * FROM services WHERE project_id = ? ORDER BY created_at', projectId).map((row) => this.map(row));
  }

  listForTeam(teamId: string): ServiceRecord[] {
    return this.db.all('SELECT * FROM services WHERE team_id = ? ORDER BY name', teamId).map((row) => this.map(row));
  }

  listAll(): ServiceRecord[] {
    return this.db.all('SELECT * FROM services').map((row) => this.map(row));
  }

  listForServer(serverId: string): ServiceRecord[] {
    return this.db.all('SELECT * FROM services WHERE server_id = ?', serverId).map((row) => this.map(row));
  }

  listWithBackupSchedule(): ServiceRecord[] {
    return this.db.all('SELECT * FROM services WHERE backup_schedule IS NOT NULL').map((row) => this.map(row));
  }

  isPublicPortTaken(serverId: string, port: number, exceptId: string): boolean {
    return this.db.get('SELECT 1 FROM services WHERE server_id = ? AND public_port = ? AND id <> ?', serverId, port, exceptId) !== undefined;
  }

  update(
    id: string,
    patch: Partial<Pick<ServiceRecord, 'name' | 'publicPort' | 'cpuLimit' | 'memoryLimitMb' | 'backupSchedule' | 'backupRetention' | 'backupDestinationId'>>,
  ): ServiceRecord {
    const current = this.get(id)!;
    const pick = <K extends keyof typeof patch>(key: K): ServiceRecord[K] => (patch[key] === undefined ? current[key] : (patch[key] as ServiceRecord[K]));
    this.db.run(
      `UPDATE services SET name = ?, public_port = ?, cpu_limit = ?, memory_limit_mb = ?, backup_schedule = ?, backup_retention = ?, backup_destination_id = ?, updated_at = ?
        WHERE id = ?`,
      pick('name'),
      pick('publicPort'),
      pick('cpuLimit'),
      pick('memoryLimitMb'),
      pick('backupSchedule'),
      pick('backupRetention'),
      pick('backupDestinationId'),
      nowIso(),
      id,
    );
    return this.get(id)!;
  }

  setStatus(id: string, status: ServiceStatus, message: string | null = null, reason: string | null = null): void {
    this.db.run(
      'UPDATE services SET status = ?, status_message = ?, status_reason = ?, updated_at = ? WHERE id = ?',
      status,
      message,
      message === null ? null : reason,
      nowIso(),
      id,
    );
  }

  delete(id: string): void {
    this.db.run('DELETE FROM services WHERE id = ?', id);
  }
}

export interface LinkRecord {
  id: string;
  applicationId: string;
  serviceId: string;
  prefix: string;
  createdAt: string;
}

function mapLink(row: Row): LinkRecord {
  return {
    id: str(row.id),
    applicationId: str(row.application_id),
    serviceId: str(row.service_id),
    prefix: str(row.prefix),
    createdAt: str(row.created_at),
  };
}

export class LinkStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(applicationId: string, serviceId: string, prefix: string): LinkRecord {
    const id = newId('lnk');
    this.db.run(
      'INSERT INTO service_links (id, application_id, service_id, prefix, created_at) VALUES (?, ?, ?, ?, ?)',
      id,
      applicationId,
      serviceId,
      prefix,
      nowIso(),
    );
    return this.get(id)!;
  }

  get(id: string): LinkRecord | undefined {
    const row = this.db.get('SELECT * FROM service_links WHERE id = ?', id);
    return row === undefined ? undefined : mapLink(row);
  }

  find(applicationId: string, serviceId: string): LinkRecord | undefined {
    const row = this.db.get('SELECT * FROM service_links WHERE application_id = ? AND service_id = ?', applicationId, serviceId);
    return row === undefined ? undefined : mapLink(row);
  }

  listForApplication(applicationId: string): LinkRecord[] {
    return this.db.all('SELECT * FROM service_links WHERE application_id = ? ORDER BY created_at', applicationId).map(mapLink);
  }

  listForService(serviceId: string): LinkRecord[] {
    return this.db.all('SELECT * FROM service_links WHERE service_id = ? ORDER BY created_at', serviceId).map(mapLink);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM service_links WHERE id = ?', id);
  }
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export interface BackupRecord {
  id: string;
  serviceId: string;
  status: BackupStatus;
  trigger: 'manual' | 'schedule';
  filePath: string | null;
  sizeBytes: number | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  remoteDestinationId: string | null;
  remoteKey: string | null;
}

function mapBackup(row: Row): BackupRecord {
  return {
    id: str(row.id),
    serviceId: str(row.service_id),
    status: str(row.status) as BackupStatus,
    trigger: str(row.trigger) as 'manual' | 'schedule',
    filePath: strOrNull(row.file_path),
    sizeBytes: numOrNull(row.size_bytes),
    errorMessage: strOrNull(row.error_message),
    startedAt: str(row.started_at),
    finishedAt: strOrNull(row.finished_at),
    remoteDestinationId: strOrNull(row.remote_destination_id),
    remoteKey: strOrNull(row.remote_key),
  };
}

export class BackupStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(serviceId: string, trigger: 'manual' | 'schedule'): BackupRecord {
    const id = newId('bak');
    this.db.run(
      "INSERT INTO backups (id, service_id, status, trigger, started_at) VALUES (?, ?, 'running', ?, ?)",
      id,
      serviceId,
      trigger,
      nowIso(),
    );
    return this.get(id)!;
  }

  get(id: string): BackupRecord | undefined {
    const row = this.db.get('SELECT * FROM backups WHERE id = ?', id);
    return row === undefined ? undefined : mapBackup(row);
  }

  listForService(serviceId: string): BackupRecord[] {
    return this.db.all('SELECT * FROM backups WHERE service_id = ? ORDER BY started_at DESC', serviceId).map(mapBackup);
  }

  isRunning(serviceId: string): boolean {
    return this.db.get("SELECT 1 FROM backups WHERE service_id = ? AND status = 'running'", serviceId) !== undefined;
  }

  finish(id: string, result: { status: 'succeeded' | 'failed'; filePath?: string | null; sizeBytes?: number | null; error?: string | null }): void {
    this.db.run(
      'UPDATE backups SET status = ?, file_path = ?, size_bytes = ?, error_message = ?, finished_at = ? WHERE id = ?',
      result.status,
      result.filePath ?? null,
      result.sizeBytes ?? null,
      result.error?.slice(0, 2_000) ?? null,
      nowIso(),
      id,
    );
  }

  failInterrupted(): number {
    return this.db.run(
      "UPDATE backups SET status = 'failed', error_message = 'Interrupted by a control-plane restart', finished_at = ? WHERE status = 'running'",
      nowIso(),
    ).changes;
  }

  delete(id: string): void {
    this.db.run('DELETE FROM backups WHERE id = ?', id);
  }

  setRemote(id: string, destinationId: string, key: string): void {
    this.db.run('UPDATE backups SET remote_destination_id = ?, remote_key = ? WHERE id = ?', destinationId, key, id);
  }

  /** A backup that succeeded on the server but carries a problem worth showing (a failed upload). */
  setWarning(id: string, message: string): void {
    this.db.run('UPDATE backups SET error_message = ? WHERE id = ?', message.slice(0, 2_000), id);
  }
}

// ---------------------------------------------------------------------------
// Cron jobs
// ---------------------------------------------------------------------------

export interface CronJobRecord {
  id: string;
  applicationId: string;
  name: string;
  schedule: string;
  command: string;
  enabled: boolean;
  timeoutSec: number;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A cron job with the application, project and server it belongs to (team-wide lists). */
export interface TeamCronJobRecord extends CronJobRecord {
  applicationName: string;
  projectId: string;
  projectName: string;
  serverName: string | null;
}

export interface CronRunRecord {
  id: string;
  cronJobId: string;
  status: CronRunStatus;
  trigger: 'schedule' | 'manual';
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

function mapCron(row: Row): CronJobRecord {
  return {
    id: str(row.id),
    applicationId: str(row.application_id),
    name: str(row.name),
    schedule: str(row.schedule),
    command: str(row.command),
    enabled: bool(row.enabled),
    timeoutSec: num(row.timeout_sec),
    nextRunAt: strOrNull(row.next_run_at),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function mapRun(row: Row): CronRunRecord {
  return {
    id: str(row.id),
    cronJobId: str(row.cron_job_id),
    status: str(row.status) as CronRunStatus,
    trigger: str(row.trigger) as 'schedule' | 'manual',
    exitCode: numOrNull(row.exit_code),
    startedAt: str(row.started_at),
    finishedAt: strOrNull(row.finished_at),
    durationMs: numOrNull(row.duration_ms),
  };
}

export class CronStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: Omit<CronJobRecord, 'id' | 'createdAt' | 'updatedAt'>): CronJobRecord {
    const id = newId('cron');
    const now = nowIso();
    this.db.run(
      `INSERT INTO cron_jobs (id, application_id, name, schedule, command, enabled, timeout_sec, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.applicationId,
      input.name,
      input.schedule,
      input.command,
      int01(input.enabled),
      input.timeoutSec,
      input.nextRunAt,
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): CronJobRecord | undefined {
    const row = this.db.get('SELECT * FROM cron_jobs WHERE id = ?', id);
    return row === undefined ? undefined : mapCron(row);
  }

  listForApplication(applicationId: string): CronJobRecord[] {
    return this.db.all('SELECT * FROM cron_jobs WHERE application_id = ? ORDER BY created_at', applicationId).map(mapCron);
  }

  /** Every cron job of a team, ordered by project, application and job name. */
  listForTeam(teamId: string): TeamCronJobRecord[] {
    return this.db
      .all(
        `SELECT j.*, a.name AS application_name, a.project_id, p.name AS project_name, s.name AS server_name
           FROM cron_jobs j
           JOIN applications a ON a.id = j.application_id
           JOIN projects p ON p.id = a.project_id
           LEFT JOIN servers s ON s.id = a.server_id
          WHERE a.team_id = ?
          ORDER BY p.name COLLATE NOCASE, a.name COLLATE NOCASE, j.name COLLATE NOCASE, j.created_at`,
        teamId,
      )
      .map((row) => ({
        ...mapCron(row),
        applicationName: str(row.application_name),
        projectId: str(row.project_id),
        projectName: str(row.project_name),
        serverName: strOrNull(row.server_name),
      }));
  }

  listDue(nowIsoValue: string): CronJobRecord[] {
    return this.db
      .all('SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?', nowIsoValue)
      .map(mapCron);
  }

  update(id: string, patch: Partial<Pick<CronJobRecord, 'name' | 'schedule' | 'command' | 'enabled' | 'timeoutSec' | 'nextRunAt'>>): CronJobRecord {
    const current = this.get(id)!;
    const next = { ...current, ...patch };
    this.db.run(
      'UPDATE cron_jobs SET name = ?, schedule = ?, command = ?, enabled = ?, timeout_sec = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
      next.name,
      next.schedule,
      next.command,
      int01(next.enabled),
      next.timeoutSec,
      next.nextRunAt,
      nowIso(),
      id,
    );
    return this.get(id)!;
  }

  delete(id: string): void {
    this.db.run('DELETE FROM cron_jobs WHERE id = ?', id);
  }

  createRun(cronJobId: string, trigger: 'schedule' | 'manual'): CronRunRecord {
    const id = newId('run');
    this.db.run(
      "INSERT INTO cron_runs (id, cron_job_id, status, trigger, started_at) VALUES (?, ?, 'running', ?, ?)",
      id,
      cronJobId,
      trigger,
      nowIso(),
    );
    return this.getRun(id)!;
  }

  getRun(id: string): CronRunRecord | undefined {
    const row = this.db.get('SELECT * FROM cron_runs WHERE id = ?', id);
    return row === undefined ? undefined : mapRun(row);
  }

  isRunning(cronJobId: string): boolean {
    return this.db.get("SELECT 1 FROM cron_runs WHERE cron_job_id = ? AND status = 'running'", cronJobId) !== undefined;
  }

  lastRun(cronJobId: string): CronRunRecord | undefined {
    const row = this.db.get('SELECT * FROM cron_runs WHERE cron_job_id = ? ORDER BY started_at DESC LIMIT 1', cronJobId);
    return row === undefined ? undefined : mapRun(row);
  }

  listRuns(cronJobId: string, limit: number): CronRunRecord[] {
    return this.db.all('SELECT * FROM cron_runs WHERE cron_job_id = ? ORDER BY started_at DESC LIMIT ?', cronJobId, limit).map(mapRun);
  }

  finishRun(id: string, status: 'succeeded' | 'failed', exitCode: number | null): void {
    const run = this.getRun(id);
    if (run === undefined) return;
    const finished = new Date();
    this.db.run(
      'UPDATE cron_runs SET status = ?, exit_code = ?, finished_at = ?, duration_ms = ? WHERE id = ?',
      status,
      exitCode,
      finished.toISOString(),
      finished.getTime() - Date.parse(run.startedAt),
      id,
    );
  }

  failInterrupted(): number {
    return this.db.run("UPDATE cron_runs SET status = 'failed', finished_at = ? WHERE status = 'running'", nowIso()).changes;
  }

  /** Keep the newest `keep` runs per job; returns pruned ids (for log cleanup). */
  pruneRuns(cronJobId: string, keep: number): string[] {
    const ids = this.db
      .all('SELECT id FROM cron_runs WHERE cron_job_id = ? ORDER BY started_at DESC LIMIT -1 OFFSET ?', cronJobId, keep)
      .map((row) => str(row.id));
    for (const id of ids) this.db.run('DELETE FROM cron_runs WHERE id = ?', id);
    return ids;
  }
}

// ---------------------------------------------------------------------------
// GitHub installations
// ---------------------------------------------------------------------------

export interface InstallationRecord {
  id: number;
  teamId: string;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  avatarUrl: string | null;
  repositorySelection: 'all' | 'selected';
  createdAt: string;
}

function mapInstallation(row: Row): InstallationRecord {
  return {
    id: num(row.id),
    teamId: str(row.team_id),
    accountLogin: str(row.account_login),
    accountType: str(row.account_type) as 'User' | 'Organization',
    avatarUrl: strOrNull(row.avatar_url),
    repositorySelection: str(row.repository_selection) as 'all' | 'selected',
    createdAt: str(row.created_at),
  };
}

export class InstallationStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  upsert(input: Omit<InstallationRecord, 'createdAt'>): InstallationRecord {
    const now = nowIso();
    this.db.run(
      `INSERT INTO github_installations (id, team_id, account_login, account_type, avatar_url, repository_selection, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET account_login = excluded.account_login, account_type = excluded.account_type,
         avatar_url = excluded.avatar_url, repository_selection = excluded.repository_selection, updated_at = excluded.updated_at`,
      input.id,
      input.teamId,
      input.accountLogin,
      input.accountType,
      input.avatarUrl,
      input.repositorySelection,
      now,
      now,
    );
    return this.get(input.id)!;
  }

  get(id: number): InstallationRecord | undefined {
    const row = this.db.get('SELECT * FROM github_installations WHERE id = ?', id);
    return row === undefined ? undefined : mapInstallation(row);
  }

  listForTeam(teamId: string): InstallationRecord[] {
    return this.db.all('SELECT * FROM github_installations WHERE team_id = ? ORDER BY account_login', teamId).map(mapInstallation);
  }

  setSelection(id: number, selection: 'all' | 'selected'): void {
    this.db.run('UPDATE github_installations SET repository_selection = ?, updated_at = ? WHERE id = ?', selection, nowIso(), id);
  }

  delete(id: number): void {
    this.db.run('DELETE FROM github_installations WHERE id = ?', id);
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface HostSample {
  serverId: string;
  t: number;
  cpu: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
  load1: number;
}

export interface AppSample {
  ownerId: string;
  t: number;
  cpu: number;
  mem: number;
  memLimit: number;
  rx: number;
  tx: number;
}

export class MetricStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  insertHost(sample: HostSample): void {
    this.db.run(
      `INSERT OR REPLACE INTO metrics_host (server_id, t, cpu, mem_used, mem_total, disk_used, disk_total, load1)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      sample.serverId,
      sample.t,
      sample.cpu,
      sample.memUsed,
      sample.memTotal,
      sample.diskUsed,
      sample.diskTotal,
      sample.load1,
    );
  }

  insertApps(samples: AppSample[]): void {
    if (samples.length === 0) return;
    this.db.transaction(() => {
      for (const sample of samples) {
        this.db.run(
          'INSERT OR REPLACE INTO metrics_app (owner_id, t, cpu, mem, mem_limit, rx, tx) VALUES (?, ?, ?, ?, ?, ?, ?)',
          sample.ownerId,
          sample.t,
          sample.cpu,
          sample.mem,
          sample.memLimit,
          sample.rx,
          sample.tx,
        );
      }
    });
  }

  /** Bucketed averages; rates (rx/tx) are bytes per second averaged over each bucket. */
  hostSeries(serverId: string, sinceMs: number, bucketMs: number) {
    return this.db
      .all(
        `SELECT (t / ?) * ? AS bucket, AVG(cpu) AS cpu, AVG(mem_used) AS mem_used, MAX(mem_total) AS mem_total,
                AVG(disk_used) AS disk_used, MAX(disk_total) AS disk_total, AVG(load1) AS load1
           FROM metrics_host WHERE server_id = ? AND t >= ? GROUP BY bucket ORDER BY bucket`,
        bucketMs,
        bucketMs,
        serverId,
        sinceMs,
      )
      .map((row) => ({
        t: num(row.bucket),
        cpu: Math.round(num(row.cpu) * 10) / 10,
        memUsed: Math.round(num(row.mem_used)),
        memTotal: num(row.mem_total),
        diskUsed: Math.round(num(row.disk_used)),
        diskTotal: num(row.disk_total),
        load1: Math.round(num(row.load1) * 100) / 100,
      }));
  }

  appSeries(ownerId: string, sinceMs: number, bucketMs: number) {
    return this.db
      .all(
        `SELECT (t / ?) * ? AS bucket, AVG(cpu) AS cpu, AVG(mem) AS mem, MAX(mem_limit) AS mem_limit, AVG(rx) AS rx, AVG(tx) AS tx
           FROM metrics_app WHERE owner_id = ? AND t >= ? GROUP BY bucket ORDER BY bucket`,
        bucketMs,
        bucketMs,
        ownerId,
        sinceMs,
      )
      .map((row) => ({
        t: num(row.bucket),
        cpu: Math.round(num(row.cpu) * 10) / 10,
        mem: Math.round(num(row.mem)),
        memLimit: num(row.mem_limit),
        rx: Math.round(num(row.rx)),
        tx: Math.round(num(row.tx)),
      }));
  }

  latestHost(serverId: string): HostSample | undefined {
    const row = this.db.get('SELECT * FROM metrics_host WHERE server_id = ? ORDER BY t DESC LIMIT 1', serverId);
    if (row === undefined) return undefined;
    return {
      serverId,
      t: num(row.t),
      cpu: num(row.cpu),
      memUsed: num(row.mem_used),
      memTotal: num(row.mem_total),
      diskUsed: num(row.disk_used),
      diskTotal: num(row.disk_total),
      load1: num(row.load1),
    };
  }

  prune(beforeMs: number): number {
    return (
      this.db.run('DELETE FROM metrics_host WHERE t < ?', beforeMs).changes +
      this.db.run('DELETE FROM metrics_app WHERE t < ?', beforeMs).changes
    );
  }

  deleteOwner(ownerId: string): void {
    this.db.run('DELETE FROM metrics_app WHERE owner_id = ?', ownerId);
  }
}
