/**
 * Private container registries a team pulls images from. The password (or
 * access token) is sealed at rest.
 */
import { imageRegistryHost } from '@ploy/shared';
import type { Database } from '../db/database.ts';
import { newId, nowIso } from '../lib/ids.ts';
import type { Secrets } from '../lib/secrets.ts';
import { str, type Row } from './util.ts';

export interface RegistryRecord {
  id: string;
  teamId: string;
  name: string;
  /** Normalized host (`ghcr.io`, `docker.io`, `registry.example.uz:5000`). */
  serverAddress: string;
  username: string;
  password: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegistryInput {
  name: string;
  serverAddress: string;
  username: string;
  password: string;
}

export class RegistryStore {
  private readonly db: Database;
  private readonly secrets: Secrets;

  constructor(db: Database, secrets: Secrets) {
    this.db = db;
    this.secrets = secrets;
  }

  private map(row: Row): RegistryRecord {
    return {
      id: str(row.id),
      teamId: str(row.team_id),
      name: str(row.name),
      serverAddress: str(row.server_address),
      username: str(row.username),
      password: this.secrets.open(str(row.password_sealed), 'registry'),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }

  create(teamId: string, input: RegistryInput): RegistryRecord {
    const id = newId('reg');
    const now = nowIso();
    this.db.run(
      `INSERT INTO registries (id, team_id, name, server_address, username, password_sealed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      teamId,
      input.name,
      input.serverAddress,
      input.username,
      this.secrets.seal(input.password, 'registry'),
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): RegistryRecord | undefined {
    const row = this.db.get('SELECT * FROM registries WHERE id = ?', id);
    return row === undefined ? undefined : this.map(row);
  }

  getForTeam(teamId: string, id: string): RegistryRecord | undefined {
    const row = this.db.get('SELECT * FROM registries WHERE id = ? AND team_id = ?', id, teamId);
    return row === undefined ? undefined : this.map(row);
  }

  listForTeam(teamId: string): RegistryRecord[] {
    return this.db.all('SELECT * FROM registries WHERE team_id = ? ORDER BY created_at', teamId).map((row) => this.map(row));
  }

  getByAddress(teamId: string, serverAddress: string): RegistryRecord | undefined {
    const row = this.db.get('SELECT * FROM registries WHERE team_id = ? AND server_address = ?', teamId, serverAddress);
    return row === undefined ? undefined : this.map(row);
  }

  /** The team's credentials for the registry an image reference pulls from, if it stored any. */
  forImage(teamId: string, image: string): RegistryRecord | undefined {
    return this.getByAddress(teamId, imageRegistryHost(image));
  }

  update(id: string, patch: Partial<RegistryInput>): RegistryRecord {
    const current = this.get(id)!;
    const next = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as RegistryRecord;
    this.db.run(
      'UPDATE registries SET name = ?, server_address = ?, username = ?, password_sealed = ?, updated_at = ? WHERE id = ?',
      next.name,
      next.serverAddress,
      next.username,
      this.secrets.seal(next.password, 'registry'),
      nowIso(),
      id,
    );
    return this.get(id)!;
  }

  delete(id: string): void {
    this.db.run('DELETE FROM registries WHERE id = ?', id);
  }
}
