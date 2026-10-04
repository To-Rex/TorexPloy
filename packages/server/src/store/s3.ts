/**
 * S3 destinations for off-server backup copies. The secret key is sealed at rest.
 */
import type { Database } from '../db/database.ts';
import { newId, nowIso } from '../lib/ids.ts';
import type { S3Target } from '../lib/s3.ts';
import type { Secrets } from '../lib/secrets.ts';
import { bool, int01, str, strOrNull, type Row } from './util.ts';

export interface S3DestinationRecord extends S3Target {
  id: string;
  teamId: string;
  name: string;
  pathPrefix: string;
  /** The team's own file store this destination writes into; its endpoint is resolved again at use time. */
  serviceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface S3DestinationInput {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  pathPrefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export class S3DestinationStore {
  private readonly db: Database;
  private readonly secrets: Secrets;

  constructor(db: Database, secrets: Secrets) {
    this.db = db;
    this.secrets = secrets;
  }

  private map(row: Row): S3DestinationRecord {
    return {
      id: str(row.id),
      teamId: str(row.team_id),
      name: str(row.name),
      endpoint: str(row.endpoint),
      region: str(row.region),
      bucket: str(row.bucket),
      pathPrefix: str(row.path_prefix),
      accessKeyId: str(row.access_key_id),
      secretAccessKey: this.secrets.open(str(row.secret_access_key), 's3'),
      forcePathStyle: bool(row.force_path_style),
      serviceId: strOrNull(row.service_id),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }

  create(teamId: string, input: S3DestinationInput, serviceId: string | null = null): S3DestinationRecord {
    const id = newId('s3d');
    const now = nowIso();
    this.db.run(
      `INSERT INTO s3_destinations (id, team_id, name, endpoint, region, bucket, path_prefix, access_key_id, secret_access_key, force_path_style, service_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      teamId,
      input.name,
      input.endpoint.replace(/\/+$/, ''),
      input.region,
      input.bucket,
      input.pathPrefix.replace(/^\/+|\/+$/g, ''),
      input.accessKeyId,
      this.secrets.seal(input.secretAccessKey, 's3'),
      int01(input.forcePathStyle),
      serviceId,
      now,
      now,
    );
    return this.get(id)!;
  }

  /** The destination that writes into a file store, if one was set up. */
  findForService(serviceId: string): S3DestinationRecord | undefined {
    const row = this.db.get('SELECT * FROM s3_destinations WHERE service_id = ? LIMIT 1', serviceId);
    return row === undefined ? undefined : this.map(row);
  }

  get(id: string): S3DestinationRecord | undefined {
    const row = this.db.get('SELECT * FROM s3_destinations WHERE id = ?', id);
    return row === undefined ? undefined : this.map(row);
  }

  getForTeam(teamId: string, id: string): S3DestinationRecord | undefined {
    const row = this.db.get('SELECT * FROM s3_destinations WHERE id = ? AND team_id = ?', id, teamId);
    return row === undefined ? undefined : this.map(row);
  }

  listForTeam(teamId: string): S3DestinationRecord[] {
    return this.db.all('SELECT * FROM s3_destinations WHERE team_id = ? ORDER BY created_at', teamId).map((row) => this.map(row));
  }

  update(id: string, patch: Partial<S3DestinationInput>): S3DestinationRecord {
    const current = this.get(id)!;
    const next = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as S3DestinationRecord;
    this.db.run(
      `UPDATE s3_destinations SET name = ?, endpoint = ?, region = ?, bucket = ?, path_prefix = ?, access_key_id = ?, secret_access_key = ?, force_path_style = ?, updated_at = ? WHERE id = ?`,
      next.name,
      next.endpoint.replace(/\/+$/, ''),
      next.region,
      next.bucket,
      next.pathPrefix.replace(/^\/+|\/+$/g, ''),
      next.accessKeyId,
      this.secrets.seal(next.secretAccessKey, 's3'),
      int01(next.forcePathStyle),
      nowIso(),
      id,
    );
    return this.get(id)!;
  }

  delete(id: string): void {
    this.db.run('DELETE FROM s3_destinations WHERE id = ?', id);
  }
}
