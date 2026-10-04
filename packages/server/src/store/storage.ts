/**
 * The file store's own rows: access keys (secret sealed at rest; SeaweedFS
 * holds the live identity) and bucket metadata the engine does not keep
 * (public flag, creation time).
 */
import type { StoragePermission } from '@ploy/shared';
import type { Database } from '../db/database.ts';
import { newId, nowIso } from '../lib/ids.ts';
import type { Secrets } from '../lib/secrets.ts';
import { bool, int01, json, str, strOrNull, type Row } from './util.ts';

export interface StorageKeyRecord {
  id: string;
  serviceId: string;
  name: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** null: every bucket, including ones created later. */
  buckets: string[] | null;
  permission: StoragePermission;
  managedBy: 'user' | 'backups';
  createdAt: string;
  lastUsedAt: string | null;
}

export class StorageKeyStore {
  private readonly db: Database;
  private readonly secrets: Secrets;

  constructor(db: Database, secrets: Secrets) {
    this.db = db;
    this.secrets = secrets;
  }

  private map(row: Row): StorageKeyRecord {
    return {
      id: str(row.id),
      serviceId: str(row.service_id),
      name: str(row.name),
      accessKeyId: str(row.access_key_id),
      secretAccessKey: this.secrets.open(str(row.secret_sealed), 'storage'),
      buckets: row.buckets === null || row.buckets === undefined ? null : json<string[]>(row.buckets, []),
      permission: str(row.permission) as StoragePermission,
      managedBy: str(row.managed_by) as 'user' | 'backups',
      createdAt: str(row.created_at),
      lastUsedAt: strOrNull(row.last_used_at),
    };
  }

  create(input: { serviceId: string; name: string; accessKeyId: string; secretAccessKey: string; buckets: string[] | null; permission: StoragePermission; managedBy: 'user' | 'backups' }): StorageKeyRecord {
    const id = newId('sk');
    this.db.run(
      `INSERT INTO storage_keys (id, service_id, name, access_key_id, secret_sealed, buckets, permission, managed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.serviceId,
      input.name,
      input.accessKeyId,
      this.secrets.seal(input.secretAccessKey, 'storage'),
      input.buckets === null ? null : JSON.stringify(input.buckets),
      input.permission,
      input.managedBy,
      nowIso(),
    );
    return this.get(id)!;
  }

  get(id: string): StorageKeyRecord | undefined {
    const row = this.db.get('SELECT * FROM storage_keys WHERE id = ?', id);
    return row === undefined ? undefined : this.map(row);
  }

  listForService(serviceId: string): StorageKeyRecord[] {
    return this.db.all('SELECT * FROM storage_keys WHERE service_id = ? ORDER BY created_at', serviceId).map((row) => this.map(row));
  }

  /** The key the panel made for backups into this store, if any. */
  backupsKey(serviceId: string): StorageKeyRecord | undefined {
    const row = this.db.get("SELECT * FROM storage_keys WHERE service_id = ? AND managed_by = 'backups' LIMIT 1", serviceId);
    return row === undefined ? undefined : this.map(row);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM storage_keys WHERE id = ?', id);
  }
}

export interface StorageBucketRecord {
  serviceId: string;
  name: string;
  public: boolean;
  createdAt: string;
}

function mapBucket(row: Row): StorageBucketRecord {
  return { serviceId: str(row.service_id), name: str(row.name), public: bool(row.public), createdAt: str(row.created_at) };
}

export class StorageBucketStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Record a bucket the panel created or discovered in the engine; an existing row keeps its flag. */
  ensure(serviceId: string, name: string, options: { public?: boolean; createdAt?: string | null } = {}): StorageBucketRecord {
    this.db.run(
      'INSERT INTO storage_buckets (service_id, name, public, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (service_id, name) DO NOTHING',
      serviceId,
      name,
      int01(options.public ?? false),
      options.createdAt ?? nowIso(),
    );
    return this.get(serviceId, name)!;
  }

  get(serviceId: string, name: string): StorageBucketRecord | undefined {
    const row = this.db.get('SELECT * FROM storage_buckets WHERE service_id = ? AND name = ?', serviceId, name);
    return row === undefined ? undefined : mapBucket(row);
  }

  listForService(serviceId: string): StorageBucketRecord[] {
    return this.db.all('SELECT * FROM storage_buckets WHERE service_id = ? ORDER BY name', serviceId).map(mapBucket);
  }

  setPublic(serviceId: string, name: string, value: boolean): void {
    this.db.run('UPDATE storage_buckets SET public = ? WHERE service_id = ? AND name = ?', int01(value), serviceId, name);
  }

  delete(serviceId: string, name: string): void {
    this.db.run('DELETE FROM storage_buckets WHERE service_id = ? AND name = ?', serviceId, name);
  }

  /** Bring the rows in line with what the engine lists: new buckets appear (private), vanished ones go. */
  reconcile(serviceId: string, buckets: { name: string; createdAt: string | null }[]): StorageBucketRecord[] {
    const names = new Set(buckets.map((bucket) => bucket.name));
    this.db.transaction(() => {
      for (const bucket of buckets) this.ensure(serviceId, bucket.name, { createdAt: bucket.createdAt });
      for (const row of this.listForService(serviceId)) if (!names.has(row.name)) this.delete(serviceId, row.name);
    });
    return this.listForService(serviceId);
  }
}
