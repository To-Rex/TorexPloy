/**
 * The file store: SeaweedFS behind the ordinary service machinery, driven
 * through its S3 API (buckets, objects, presigned links) and through
 * `weed shell` inside the container (identities — access keys and public
 * buckets — and usage).
 *
 * Identities are the engine's: the static root identity comes from the
 * `s3.json` seeded into the data volume, dynamic ones are applied with
 * `s3.configure` and persist in the filer. The panel keeps its own rows for
 * what the engine does not record (sealed secrets, names, the public flag)
 * and reconciles its bucket list with the engine's on every listing.
 */
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { LIMITS, type StoragePermission } from '@ploy/shared';
import type { Context } from '../context.ts';
import { generateToken } from '../lib/crypto.ts';
import { AppError, errorMessage, notFound } from '../lib/errors.ts';
import { randomId } from '../lib/ids.ts';
import { DELETE_BATCH, S3Client, S3Error, type S3Listing, type S3ObjectHead } from '../lib/s3.ts';
import type { S3DestinationRecord, ServiceRecord, StorageBucketRecord, StorageKeyRecord } from '../store/index.ts';
import { publicEndpoint, resolveReach, type StoreReach } from './reach.ts';

export const STORAGE_REGION = 'us-east-1';
/** The bucket backups of other services are written into. */
export const BACKUPS_BUCKET = 'backups';
const STATS_TTL_MS = 20_000;
/** Pages of 1000 keys one request removes before giving up (a folder, or a forced bucket delete). */
const DELETE_PAGES_MAX = 50;
/** `weed shell` output lines that carry usage: `fs.du` totals and `fs.tree` summaries. */
const STATS_LINE = '^block:|^[0-9]+ directories, [0-9]+ files$';

export interface BucketStats {
  objects: number;
  bytes: number;
}

export class StorageManager {
  private readonly ctx: Context;
  private readonly stats = new Map<string, { at: number; value: Map<string, BucketStats> }>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** Every file-store operation needs a `files` service. */
  ensureStore(service: ServiceRecord): void {
    if (service.type !== 'files') throw new AppError('bad_request', 'This service is not a file store', { params: { reason: 'not_file_store' } });
  }

  // ------------------------------------------------------------- reaching it

  reach(service: ServiceRecord): Promise<StoreReach> {
    return resolveReach(this.ctx, service, {
      self: () => this.ctx.updates.self.locate(),
      connect: async (network, containerId) => {
        const docker = await this.ctx.connections.docker(service.serverId);
        await docker.connectNetwork(network, containerId);
      },
    });
  }

  publicEndpoint(service: ServiceRecord): string | null {
    return publicEndpoint(this.ctx, service);
  }

  /** An S3 client with the root identity, through whatever path the control plane has to the store. */
  async client(service: ServiceRecord, bucket = ''): Promise<S3Client> {
    if (service.status !== 'running') throw new AppError('storage_unavailable', 'The file store is not running', { params: { reason: 'not_running' } });
    const { endpoint } = await this.reach(service);
    return new S3Client({ endpoint, region: STORAGE_REGION, bucket, accessKeyId: service.credentials.username!, secretAccessKey: service.credentials.password, forcePathStyle: true });
  }

  /** A destination's connection details as they are right now (store-backed ones are resolved again). */
  async destinationTarget(destination: S3DestinationRecord): Promise<S3DestinationRecord> {
    if (destination.serviceId === null) return destination;
    const service = this.ctx.stores.services.get(destination.serviceId);
    if (service === undefined) return destination;
    const { endpoint } = await this.reach(service);
    return { ...destination, endpoint };
  }

  /** Engine errors as the API reports them: S3 errors keep their meaning, anything else is the store being unavailable. */
  private failure(error: unknown): AppError {
    if (error instanceof AppError) return error;
    if (error instanceof S3Error) {
      if (error.code === 'NoSuchBucket') return notFound('Bucket');
      if (error.code === 'NoSuchKey') return notFound('Object');
      if (error.code === 'BucketNotEmpty') return new AppError('bucket_not_empty', 'The bucket still has objects');
      if (error.code === 'BucketAlreadyExists' || error.code === 'BucketAlreadyOwnedByYou') return new AppError('conflict', 'A bucket with this name already exists', { params: { reason: 'bucket_exists' } });
      if (error.status === 403) return new AppError('storage_unavailable', `The file store rejected the root identity: ${error.message}`, { params: { reason: 'credentials' } });
      if (error.status >= 500) return new AppError('storage_unavailable', `The file store failed: ${error.message}`, { params: { reason: 'engine' } });
      return new AppError('bad_request', error.message, { params: { reason: 's3_error', code: error.code } });
    }
    return new AppError('storage_unavailable', `The file store did not answer: ${errorMessage(error)}`, { params: { reason: 'store_unreachable' } });
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw this.failure(error);
    }
  }

  // --------------------------------------------------------------- weed shell

  /**
   * Run `weed shell` commands inside the container. They travel through the
   * exec environment and stdin, so secrets never appear on a command line.
   * `keep` limits the output to matching lines, filtered in the container
   * (a directory tree can be millions of lines).
   */
  async shell(service: ServiceRecord, commands: string[], keep?: string): Promise<string> {
    const docker = await this.ctx.connections.docker(service.serverId);
    const filter = keep === undefined ? '' : ` | (grep -E '${keep}' || true)`;
    const script = `printf '%s\\n' "$PLOY_WEED_COMMANDS" | weed shell -master=127.0.0.1:9333 -filer=127.0.0.1:8888 2>&1${filter}`;
    const result = await docker.exec(service.containerName, ['sh', '-c', script], { env: [`PLOY_WEED_COMMANDS=${commands.join('\n')}`], timeoutMs: 5 * 60_000, maxOutput: 4_000_000 });
    const lines = `${result.stdout}\n${result.stderr}`.split('\n').filter((line) => line.length > 0 && !/^[IWEF]\d{4} \d\d:\d\d:\d\d/.test(line));
    if (result.exitCode !== 0) {
      const detail = lines.find((line) => /error/i.test(line)) ?? lines.at(-1) ?? `exit ${result.exitCode}`;
      throw new AppError('storage_unavailable', `The file store rejected the command: ${detail.slice(0, 300)}`, { params: { reason: 'engine' } });
    }
    return lines.join('\n');
  }

  private async configureIdentity(service: ServiceRecord, identity: { name: string; accessKeyId: string; secretAccessKey: string; buckets: string[] | null; permission: StoragePermission }): Promise<void> {
    const actions = identity.permission === 'read' ? 'Read,List' : 'Read,List,Write,Tagging';
    const scope = identity.buckets === null ? '' : ` -buckets=${identity.buckets.join(',')}`;
    await this.shell(service, [`s3.configure -user=${identity.name} -access_key=${identity.accessKeyId} -secret_key=${identity.secretAccessKey}${scope} -actions=${actions} -apply`]);
  }

  private async deleteIdentity(service: ServiceRecord, name: string): Promise<void> {
    await this.shell(service, [`s3.configure -user=${name} -delete -apply`]).catch((error: unknown) => {
      if (!/not found/i.test(errorMessage(error))) throw error;
    });
  }

  /** Public buckets are one `anonymous` identity with `Read,List` scoped to each of them. */
  private async setPublic(service: ServiceRecord, bucket: string, value: boolean): Promise<void> {
    const command = `s3.configure -user=anonymous -buckets=${bucket} -actions=Read,List${value ? '' : ' -delete'} -apply`;
    await this.shell(service, [command]).catch((error: unknown) => {
      if (value || !/not found/i.test(errorMessage(error))) throw error;
    });
  }

  // ------------------------------------------------------------------- usage

  /** Objects and logical bytes per bucket, from the filer (cached briefly: a listing asks for every bucket at once). */
  async bucketStats(service: ServiceRecord, buckets: string[]): Promise<Map<string, BucketStats>> {
    const cached = this.stats.get(service.id);
    if (cached !== undefined && Date.now() - cached.at < STATS_TTL_MS && buckets.every((bucket) => cached.value.has(bucket))) return cached.value;
    const value = new Map<string, BucketStats>();
    if (buckets.length > 0) {
      const output = await this.shell(service, buckets.flatMap((bucket) => [`fs.tree /buckets/${bucket}`, `fs.du /buckets/${bucket}`]), STATS_LINE);
      let index = 0;
      for (const line of output.split('\n')) {
        const summary = /^(\d+) directories, (\d+) files$/.exec(line);
        if (summary !== null) {
          // One summary per `fs.tree`, in command order.
          const bucket = buckets[index];
          index += 1;
          if (bucket !== undefined) value.set(bucket, { objects: Number(summary[2]), bytes: value.get(bucket)?.bytes ?? 0 });
          continue;
        }
        const usage = /^block:\s*\d+\s+logical size:\s*(\d+)\s+\/buckets\/([^/\s]+)$/.exec(line);
        if (usage !== null) value.set(usage[2]!, { objects: value.get(usage[2]!)?.objects ?? 0, bytes: Number(usage[1]) });
      }
    }
    this.stats.set(service.id, { at: Date.now(), value });
    return value;
  }

  forgetStats(serviceId: string): void {
    this.stats.delete(serviceId);
  }

  // ----------------------------------------------------------------- buckets

  /** The engine's buckets, reconciled into the panel's rows (new ones private, vanished ones dropped). */
  async listBuckets(service: ServiceRecord): Promise<StorageBucketRecord[]> {
    const client = await this.client(service);
    const buckets = await this.run(() => client.listBuckets());
    return this.ctx.stores.storageBuckets.reconcile(service.id, buckets);
  }

  async createBucket(service: ServiceRecord, name: string, isPublic: boolean): Promise<StorageBucketRecord> {
    const client = await this.client(service, name);
    await this.run(() => client.createBucket());
    const record = this.ctx.stores.storageBuckets.ensure(service.id, name, { public: false });
    if (isPublic) await this.setBucketPublic(service, name, true);
    this.forgetStats(service.id);
    return this.ctx.stores.storageBuckets.get(service.id, name) ?? record;
  }

  async setBucketPublic(service: ServiceRecord, name: string, value: boolean): Promise<StorageBucketRecord> {
    if (service.status !== 'running') throw new AppError('storage_unavailable', 'The file store is not running', { params: { reason: 'not_running' } });
    await this.setPublic(service, name, value);
    this.ctx.stores.storageBuckets.setPublic(service.id, name, value);
    return this.ctx.stores.storageBuckets.get(service.id, name)!;
  }

  /** Without `force` a bucket with objects stays (409); with it every object goes first, page by page. */
  async deleteBucket(service: ServiceRecord, name: string, force: boolean): Promise<void> {
    const client = await this.client(service, name);
    await this.run(async () => {
      if (!force && (await client.listObjects({ maxKeys: 1 })).objects.length > 0) throw new S3Error(409, 'BucketNotEmpty', 'The bucket still has objects');
      // Empty folders the engine kept would still count as contents.
      await this.deletePrefix(client, '');
      await client.deleteBucket();
    });
    const record = this.ctx.stores.storageBuckets.get(service.id, name);
    if (record?.public === true) await this.setPublic(service, name, false).catch(() => undefined);
    this.ctx.stores.storageBuckets.delete(service.id, name);
    this.forgetStats(service.id);
  }

  // ----------------------------------------------------------------- objects

  async listObjects(service: ServiceRecord, bucket: string, options: { prefix: string; cursor?: string; limit: number }): Promise<S3Listing> {
    const client = await this.client(service, bucket);
    const listing = await this.run(() => client.listObjects({ prefix: options.prefix, delimiter: '/', maxKeys: options.limit, ...(options.cursor === undefined ? {} : { continuationToken: options.cursor }) }));
    // The folder's own marker object is the folder, not something in it.
    return { ...listing, objects: listing.objects.filter((object) => object.key !== options.prefix) };
  }

  async putObject(service: ServiceRecord, bucket: string, key: string, body: Readable | Buffer, size: number, contentType: string): Promise<S3ObjectHead> {
    const client = await this.client(service, bucket);
    return this.run(async () => {
      await client.put(key, body, size, contentType);
      this.forgetStats(service.id);
      return (await client.headObject(key)) ?? { size, contentType, lastModified: new Date().toISOString(), etag: null };
    });
  }

  async headObject(service: ServiceRecord, bucket: string, key: string): Promise<S3ObjectHead> {
    const client = await this.client(service, bucket);
    const head = await this.run(() => client.headObject(key));
    if (head === null) throw notFound('Object');
    return head;
  }

  /** The object's bytes as the engine streams them (206 and `Content-Range` for a byte range). */
  async getObject(service: ServiceRecord, bucket: string, key: string, range?: string): Promise<IncomingMessage> {
    const client = await this.client(service, bucket);
    return this.run(() => client.get(key, range === undefined ? {} : { range }));
  }

  /** Remove keys and whole folders (`prefix/`). Bounded: a huge folder is removed over several requests. */
  async deleteKeys(service: ServiceRecord, bucket: string, keys: string[]): Promise<number> {
    const client = await this.client(service, bucket);
    return this.run(async () => {
      let deleted = 0;
      const plain = keys.filter((key) => !key.endsWith('/'));
      for (let start = 0; start < plain.length; start += DELETE_BATCH) deleted += (await client.deleteObjects(plain.slice(start, start + DELETE_BATCH))).deleted.length;
      for (const prefix of keys.filter((key) => key.endsWith('/'))) deleted += await this.deletePrefix(client, prefix);
      this.forgetStats(service.id);
      return deleted;
    });
  }

  /**
   * Remove every object under `prefix`, then the folders. S3 proper has no
   * folders, but SeaweedFS keeps a directory after its last file is gone and
   * removes it only through its own key, once empty — so they go deepest
   * first, the prefix itself last.
   */
  private async deletePrefix(client: S3Client, prefix: string): Promise<number> {
    const budget = { pages: 0 };
    const page = async (options: Parameters<S3Client['listObjects']>[0], deleted: number) => {
      if (budget.pages >= DELETE_PAGES_MAX) throw new AppError('conflict', `Removed ${deleted} objects; more remain — run the delete again`, { params: { reason: 'too_many_objects', deleted } });
      budget.pages += 1;
      return client.listObjects({ ...options, maxKeys: DELETE_BATCH });
    };
    let deleted = 0;
    for (;;) {
      const listing = await page({ prefix }, deleted);
      if (listing.objects.length > 0) deleted += (await client.deleteObjects(listing.objects.map((object) => object.key))).deleted.length;
      if (!listing.truncated) break;
    }
    const folders: string[] = [];
    const queue = [prefix];
    while (queue.length > 0) {
      const current = queue.shift()!;
      let token: string | undefined;
      do {
        const listing = await page({ prefix: current, delimiter: '/', ...(token === undefined ? {} : { continuationToken: token }) }, deleted);
        for (const folder of listing.prefixes) {
          folders.push(folder);
          queue.push(folder);
        }
        token = listing.truncated ? (listing.nextContinuationToken ?? undefined) : undefined;
      } while (token !== undefined);
    }
    if (prefix.length > 0) folders.push(prefix);
    folders.sort((a, b) => b.split('/').length - a.split('/').length || b.length - a.length);
    for (let start = 0; start < folders.length; start += DELETE_BATCH) await client.deleteObjects(folders.slice(start, start + DELETE_BATCH));
    return deleted;
  }

  /** An empty folder is a zero-byte object named `prefix/`, so the listing shows it. */
  async createFolder(service: ServiceRecord, bucket: string, prefix: string): Promise<void> {
    const client = await this.client(service, bucket);
    await this.run(() => client.put(prefix, Buffer.alloc(0), 0, 'application/x-directory'));
  }

  /** A temporary link for a browser, through the store's public address. */
  presign(service: ServiceRecord, bucket: string, input: { key: string; method: 'get' | 'put'; expiresIn: number; download: boolean }): { url: string; expiresAt: string } {
    const endpoint = this.publicEndpoint(service);
    if (endpoint === null) {
      throw new AppError('validation_failed', 'Presigned links need a domain or a public port on the file store', {
        params: { reason: 'no_public_endpoint' },
        issues: [{ path: 'key', code: 'custom', message: 'The store has no public address', params: { reason: 'no_public_endpoint' } }],
      });
    }
    const client = new S3Client({ endpoint, region: STORAGE_REGION, bucket, accessKeyId: service.credentials.username!, secretAccessKey: service.credentials.password, forcePathStyle: true });
    const name = input.key.split('/').pop() ?? input.key;
    const query: Record<string, string> = input.method === 'get' && input.download ? { 'response-content-disposition': `attachment; filename="${name.replace(/["\\\r\n]/g, '_')}"` } : {};
    return client.presign({ method: input.method === 'put' ? 'PUT' : 'GET', key: input.key, expiresIn: input.expiresIn, query });
  }

  // -------------------------------------------------------------------- keys

  async createKey(service: ServiceRecord, input: { name: string; buckets: string[] | null; permission: StoragePermission }, managedBy: 'user' | 'backups' = 'user'): Promise<StorageKeyRecord> {
    const { stores } = this.ctx;
    if (stores.storageKeys.listForService(service.id).length >= LIMITS.storageKeysMax) {
      throw new AppError('conflict', `A file store may have at most ${LIMITS.storageKeysMax} access keys`, { params: { reason: 'limit', maximum: LIMITS.storageKeysMax } });
    }
    if (service.status !== 'running') throw new AppError('storage_unavailable', 'The file store is not running', { params: { reason: 'not_running' } });
    const record = stores.storageKeys.create({
      serviceId: service.id,
      name: input.name,
      accessKeyId: `ploy${randomId(16)}`,
      secretAccessKey: generateToken(30).replace(/[-_]/g, 'x'),
      buckets: input.buckets,
      permission: input.permission,
      managedBy,
    });
    try {
      // The row's id names the identity in the engine: stable, unique, and free of user-chosen characters.
      await this.configureIdentity(service, { name: record.id, accessKeyId: record.accessKeyId, secretAccessKey: record.secretAccessKey, buckets: record.buckets, permission: record.permission });
    } catch (error) {
      stores.storageKeys.delete(record.id);
      throw error;
    }
    return record;
  }

  /** Remove the identity from the engine (when it runs) and the row. */
  async revokeKey(service: ServiceRecord, key: StorageKeyRecord): Promise<void> {
    if (service.status === 'running') await this.deleteIdentity(service, key.id);
    this.ctx.stores.storageKeys.delete(key.id);
  }

  // ---------------------------------------------------------------- backups

  /**
   * A backup destination inside the store: the private `backups` bucket, a
   * key that may only use it, and an S3 destination record that services can
   * pick. Idempotent — the existing destination is returned.
   */
  async ensureBackupDestination(service: ServiceRecord): Promise<S3DestinationRecord> {
    const { stores } = this.ctx;
    const existing = stores.s3.findForService(service.id);
    if (existing !== undefined) return existing;
    const reach = await this.reach(service);
    const client = await this.client(service, BACKUPS_BUCKET);
    await this.run(() =>
      client.createBucket().catch((error: unknown) => {
        if (!(error instanceof S3Error && (error.code === 'BucketAlreadyOwnedByYou' || error.code === 'BucketAlreadyExists'))) throw error;
      }),
    );
    stores.storageBuckets.ensure(service.id, BACKUPS_BUCKET);
    const key = stores.storageKeys.backupsKey(service.id) ?? (await this.createKey(service, { name: 'backups', buckets: [BACKUPS_BUCKET], permission: 'readwrite' }, 'backups'));
    const target = { endpoint: reach.endpoint, region: STORAGE_REGION, bucket: BACKUPS_BUCKET, accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, forcePathStyle: true };
    // The identity takes a moment to reach the gateway; prove the key writes before anything depends on it.
    await this.run(async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          await new S3Client(target).verify('');
          return;
        } catch (error) {
          lastError = error;
          if (!(error instanceof S3Error && error.status === 403)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      throw lastError;
    });
    return stores.s3.create(service.teamId, { name: `${service.name} (fayl ombori)`, ...target, pathPrefix: '' }, service.id);
  }

  /** The key a store-backed destination used goes with the destination. */
  async revokeDestinationKey(destination: S3DestinationRecord): Promise<void> {
    if (destination.serviceId === null) return;
    const service = this.ctx.stores.services.get(destination.serviceId);
    const key = this.ctx.stores.storageKeys.backupsKey(destination.serviceId);
    if (service === undefined || key === undefined) return;
    await this.revokeKey(service, key).catch((error: unknown) => this.ctx.logger.warn('Could not revoke the backup key of a file store', { serviceId: service.id, error: errorMessage(error) }));
  }
}
