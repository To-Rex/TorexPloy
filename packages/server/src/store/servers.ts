/**
 * Servers: the local host and SSH-managed machines.
 */
import type { ServerKind, ServerStatus } from '@ploy/shared';
import type { Database } from '../db/database.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { json, num, numOrNull, str, strOrNull, type Row } from './util.ts';

export interface DockerInfo {
  version: string;
  apiVersion: string;
  os: string;
  arch: string;
  cpus: number;
  memoryBytes: number;
}

export interface ProxyInfo {
  running: boolean;
  version: string | null;
  containerId: string | null;
}

export interface ServerRecord {
  id: string;
  teamId: string | null;
  name: string;
  kind: ServerKind;
  host: string | null;
  port: number | null;
  username: string | null;
  sshPrivateKey: string | null;
  sshPublicKey: string | null;
  hostKey: string | null;
  hostKeyFingerprint: string | null;
  status: ServerStatus;
  statusMessage: string | null;
  /** Stable reason code for the status (translated in the dashboard). */
  statusReason: string | null;
  publicIp: string | null;
  dockerInfo: DockerInfo | null;
  proxyInfo: ProxyInfo | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapServer(row: Row): ServerRecord {
  return {
    id: str(row.id),
    teamId: strOrNull(row.team_id),
    name: str(row.name),
    kind: str(row.kind) as ServerKind,
    host: strOrNull(row.host),
    port: numOrNull(row.port),
    username: strOrNull(row.username),
    sshPrivateKey: strOrNull(row.ssh_private_key),
    sshPublicKey: strOrNull(row.ssh_public_key),
    hostKey: strOrNull(row.host_key),
    hostKeyFingerprint: strOrNull(row.host_key_fingerprint),
    status: str(row.status) as ServerStatus,
    statusMessage: strOrNull(row.status_message),
    statusReason: strOrNull(row.status_reason),
    publicIp: strOrNull(row.public_ip),
    dockerInfo: json<DockerInfo | null>(row.docker_info, null),
    proxyInfo: json<ProxyInfo | null>(row.proxy_info, null),
    lastSeenAt: strOrNull(row.last_seen_at),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export class ServerStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** The control plane's own host. Created once, at setup. */
  ensureLocal(name: string): ServerRecord {
    const existing = this.getLocal();
    if (existing !== undefined) return existing;
    const id = newId('srv');
    const now = nowIso();
    this.db.run(
      "INSERT INTO servers (id, team_id, name, kind, status, created_at, updated_at) VALUES (?, NULL, ?, 'local', 'pending', ?, ?)",
      id,
      name,
      now,
      now,
    );
    return this.get(id)!;
  }

  getLocal(): ServerRecord | undefined {
    const row = this.db.get("SELECT * FROM servers WHERE kind = 'local'");
    return row === undefined ? undefined : mapServer(row);
  }

  createSsh(input: {
    teamId: string;
    name: string;
    host: string;
    port: number;
    username: string;
    sealedPrivateKey: string;
    publicKey: string;
  }): ServerRecord {
    const id = newId('srv');
    const now = nowIso();
    this.db.run(
      `INSERT INTO servers (id, team_id, name, kind, host, port, username, ssh_private_key, ssh_public_key, status, created_at, updated_at)
       VALUES (?, ?, ?, 'ssh', ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      input.teamId,
      input.name,
      input.host,
      input.port,
      input.username,
      input.sealedPrivateKey,
      input.publicKey,
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): ServerRecord | undefined {
    const row = this.db.get('SELECT * FROM servers WHERE id = ?', id);
    return row === undefined ? undefined : mapServer(row);
  }

  /** A server a team may use: its own SSH servers plus the shared local host. */
  getForTeam(teamId: string, id: string): ServerRecord | undefined {
    const row = this.db.get('SELECT * FROM servers WHERE id = ? AND (team_id = ? OR team_id IS NULL)', id, teamId);
    return row === undefined ? undefined : mapServer(row);
  }

  listForTeam(teamId: string): ServerRecord[] {
    return this.db
      .all("SELECT * FROM servers WHERE team_id = ? OR team_id IS NULL ORDER BY kind = 'local' DESC, created_at", teamId)
      .map(mapServer);
  }

  listAll(): ServerRecord[] {
    return this.db.all('SELECT * FROM servers ORDER BY created_at').map(mapServer);
  }

  update(id: string, patch: { name?: string; host?: string; port?: number; username?: string }): void {
    const current = this.get(id);
    if (current === undefined) return;
    const connectionChanged =
      (patch.host !== undefined && patch.host !== current.host) ||
      (patch.port !== undefined && patch.port !== current.port) ||
      (patch.username !== undefined && patch.username !== current.username);
    this.db.run(
      `UPDATE servers SET name = ?, host = ?, port = ?, username = ?, updated_at = ?,
              host_key = CASE WHEN ? THEN NULL ELSE host_key END,
              host_key_fingerprint = CASE WHEN ? THEN NULL ELSE host_key_fingerprint END,
              status = CASE WHEN ? THEN 'pending' ELSE status END
        WHERE id = ?`,
      patch.name ?? current.name,
      patch.host ?? current.host,
      patch.port ?? current.port,
      patch.username ?? current.username,
      nowIso(),
      connectionChanged ? 1 : 0,
      connectionChanged ? 1 : 0,
      connectionChanged ? 1 : 0,
      id,
    );
  }

  setStatus(id: string, status: ServerStatus, message: string | null, reason: string | null = null): void {
    const seen = status === 'ready' ? nowIso() : null;
    this.db.run(
      'UPDATE servers SET status = ?, status_message = ?, status_reason = ?, last_seen_at = COALESCE(?, last_seen_at), updated_at = ? WHERE id = ?',
      status,
      message,
      message === null ? null : reason,
      seen,
      nowIso(),
      id,
    );
  }

  setHostKey(id: string, hostKey: string, fingerprint: string): void {
    this.db.run('UPDATE servers SET host_key = ?, host_key_fingerprint = ? WHERE id = ?', hostKey, fingerprint, id);
  }

  setDockerInfo(id: string, info: DockerInfo): void {
    this.db.run('UPDATE servers SET docker_info = ? WHERE id = ?', JSON.stringify(info), id);
  }

  setProxyInfo(id: string, info: ProxyInfo): void {
    this.db.run('UPDATE servers SET proxy_info = ? WHERE id = ?', JSON.stringify(info), id);
  }

  setPublicIp(id: string, ip: string | null): void {
    this.db.run('UPDATE servers SET public_ip = ? WHERE id = ?', ip, id);
  }

  usage(id: string): { applications: number; services: number } {
    return {
      applications: num(this.db.scalar('SELECT COUNT(*) FROM applications WHERE server_id = ?', id)),
      services: num(this.db.scalar('SELECT COUNT(*) FROM services WHERE server_id = ?', id)),
    };
  }

  delete(id: string): void {
    this.db.run('DELETE FROM servers WHERE id = ?', id);
  }
}
