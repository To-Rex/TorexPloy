/**
 * The file store (`files` services): overview, buckets, objects, presigned
 * links, access keys, a backup destination inside the store, and the
 * store's own domains. Viewers read, developers write, admins manage keys.
 */
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  bucketNameSchema,
  createBucketSchema,
  createFolderSchema,
  createStorageKeySchema,
  deleteObjectsSchema,
  hostnameSchema,
  LIMITS,
  listObjectsQuerySchema,
  objectKeySchema,
  presignSchema,
  updateBucketSchema,
  type StorageKeyCreatedDto,
  type StorageOverviewDto,
} from '@ploy/shared';
import { emit, type Context } from '../../context.ts';
import { generateServiceDomain } from '../../domains/generate.ts';
import { AppError, notFound } from '../../lib/errors.ts';
import { STORAGE_REGION, type BucketStats } from '../../storage/manager.ts';
import { internalEndpoint } from '../../storage/reach.ts';
import type { ServiceRecord } from '../../store/index.ts';
import { audit, body, query, requireTeam, validate, type Ctx, type Env } from '../core.ts';
import { domainDto, s3DestinationDto, storageBucketDto, storageKeyDto, storageListingDto, storageObjectDto } from '../dto.ts';

type Role = 'viewer' | 'developer' | 'admin';

/** A domain for the store: a host of the team's own, or a generated address. */
const serviceDomainSchema = z.object({
  host: hostnameSchema.optional(),
  https: z.boolean().default(true),
  generate: z.boolean().default(false),
});

/** `Content-Disposition` for a download: an ASCII fallback plus the UTF-8 name. */
function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function registerStorageRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores, storage } = ctx;

  const load = (c: Ctx, role: Role): ServiceRecord => {
    const auth = requireTeam(c, role);
    const service = stores.services.getForTeam(auth.teamId, c.req.param('id')!);
    if (service === undefined) throw notFound('Service');
    storage.ensureStore(service);
    return service;
  };
  const bucketOf = (c: Ctx): string => validate(bucketNameSchema, c.req.param('bucket'));
  const keyOf = (c: Ctx): string => validate(objectKeySchema, c.req.param('key'));
  const statsOf = (service: ServiceRecord, buckets: string[]): Promise<Map<string, BucketStats>> =>
    storage.bucketStats(service, buckets).catch((): Map<string, BucketStats> => new Map());

  // ---------------------------------------------------------------- overview

  app.get('/api/services/:id/storage', async (c) => {
    const service = load(c, 'viewer');
    let buckets = stores.storageBuckets.listForService(service.id);
    let usage: StorageOverviewDto['usage'] = null;
    if (service.status === 'running') {
      // The page must render even while the engine is unreachable; counts then come from the panel's rows.
      try {
        buckets = await storage.listBuckets(service);
        usage = { objects: 0, bytes: 0 };
        for (const stats of (await storage.bucketStats(service, buckets.map((bucket) => bucket.name))).values()) {
          usage.objects += stats.objects;
          usage.bytes += stats.bytes;
        }
      } catch {
        usage = null;
      }
    }
    const overview: StorageOverviewDto = {
      endpoint: storage.publicEndpoint(service),
      internalEndpoint: internalEndpoint(service),
      region: STORAGE_REGION,
      forcePathStyle: true,
      rootAccessKeyId: service.credentials.username ?? '',
      buckets: buckets.length,
      keys: stores.storageKeys.listForService(service.id).length,
      backupDestinationId: stores.s3.findForService(service.id)?.id ?? null,
      usage,
    };
    return c.json(overview);
  });

  // ----------------------------------------------------------------- buckets

  app.get('/api/services/:id/storage/buckets', async (c) => {
    const service = load(c, 'viewer');
    const buckets = await storage.listBuckets(service);
    const stats = await statsOf(service, buckets.map((bucket) => bucket.name));
    return c.json(buckets.map((bucket) => storageBucketDto(bucket, stats.get(bucket.name))));
  });

  app.post('/api/services/:id/storage/buckets', async (c) => {
    const service = load(c, 'developer');
    const input = await body(c, createBucketSchema);
    const bucket = await storage.createBucket(service, input.name, input.public);
    audit(ctx, c, 'storage.bucket_created', { type: 'service', id: service.id, name: service.name }, { bucket: input.name, public: input.public });
    return c.json(storageBucketDto(bucket, { objects: 0, bytes: 0 }), 201);
  });

  app.patch('/api/services/:id/storage/buckets/:bucket', async (c) => {
    const service = load(c, 'developer');
    const name = bucketOf(c);
    const input = await body(c, updateBucketSchema);
    if (stores.storageBuckets.get(service.id, name) === undefined) await storage.listBuckets(service);
    if (stores.storageBuckets.get(service.id, name) === undefined) throw notFound('Bucket');
    const bucket = await storage.setBucketPublic(service, name, input.public);
    audit(ctx, c, 'storage.bucket_updated', { type: 'service', id: service.id, name: service.name }, { bucket: name, public: input.public });
    const stats = await statsOf(service, [name]);
    return c.json(storageBucketDto(bucket, stats.get(name)));
  });

  app.delete('/api/services/:id/storage/buckets/:bucket', async (c) => {
    const service = load(c, 'developer');
    const name = bucketOf(c);
    const force = c.req.query('force') === 'true';
    await storage.deleteBucket(service, name, force);
    audit(ctx, c, 'storage.bucket_deleted', { type: 'service', id: service.id, name: service.name }, { bucket: name, force });
    return c.json({ ok: true });
  });

  // ----------------------------------------------------------------- objects

  app.get('/api/services/:id/storage/buckets/:bucket/objects', async (c) => {
    const service = load(c, 'viewer');
    const bucket = bucketOf(c);
    const input = query(c, listObjectsQuerySchema);
    const listing = await storage.listObjects(service, bucket, { prefix: input.prefix, limit: input.limit, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
    return c.json(storageListingDto(bucket, input.prefix, listing));
  });

  /** A raw upload, streamed straight into the store. `Content-Length` is required; `Content-Type` is kept. */
  app.put('/api/services/:id/storage/buckets/:bucket/objects/:key{.+}', async (c) => {
    const service = load(c, 'developer');
    const bucket = bucketOf(c);
    const key = keyOf(c);
    if (key.endsWith('/')) throw new AppError('validation_failed', 'An object key cannot end with a slash', { issues: [{ path: 'key', code: 'custom', message: 'Folders are created through /folders' }] });
    const length = c.req.header('content-length');
    if (length === undefined || !/^\d+$/.test(length)) throw new AppError('bad_request', 'Content-Length is required', { params: { reason: 'length_required' } });
    const size = Number(length);
    if (size > LIMITS.storageUploadMax) throw new AppError('payload_too_large', 'The object is larger than the upload limit', { params: { maximum: LIMITS.storageUploadMax } });
    const contentType = c.req.header('content-type') ?? 'application/octet-stream';
    const raw = c.req.raw.body;
    const stream = raw === null || size === 0 ? Buffer.alloc(0) : Readable.fromWeb(raw as unknown as WebReadableStream);
    const head = await storage.putObject(service, bucket, key, stream, size, contentType);
    return c.json(storageObjectDto(key, head), 201);
  });

  /** The object itself (`?download=1` for an attachment); byte ranges pass through. */
  app.get('/api/services/:id/storage/buckets/:bucket/objects/:key{.+}', async (c) => {
    const service = load(c, 'viewer');
    const bucket = bucketOf(c);
    const key = keyOf(c);
    const range = c.req.header('range');
    const response = await storage.getObject(service, bucket, key, range);
    const headers = new Headers({ 'Cache-Control': 'private, no-store' });
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = response.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    if (c.req.query('download') === '1') headers.set('Content-Disposition', attachment(key.split('/').pop() ?? key));
    return new Response(Readable.toWeb(response) as ReadableStream, { status: response.statusCode ?? 200, headers });
  });

  app.post('/api/services/:id/storage/buckets/:bucket/delete', async (c) => {
    const service = load(c, 'developer');
    const bucket = bucketOf(c);
    const input = await body(c, deleteObjectsSchema);
    for (const key of input.keys) validate(objectKeySchema, key);
    const deleted = await storage.deleteKeys(service, bucket, input.keys);
    audit(ctx, c, 'storage.objects_deleted', { type: 'service', id: service.id, name: service.name }, { bucket, keys: input.keys.length, deleted });
    return c.json({ deleted });
  });

  app.post('/api/services/:id/storage/buckets/:bucket/folders', async (c) => {
    const service = load(c, 'developer');
    const bucket = bucketOf(c);
    const input = await body(c, createFolderSchema);
    await storage.createFolder(service, bucket, input.prefix);
    return c.json({ prefix: input.prefix }, 201);
  });

  app.post('/api/services/:id/storage/buckets/:bucket/presign', async (c) => {
    const input = await body(c, presignSchema);
    const service = load(c, input.method === 'put' ? 'developer' : 'viewer');
    const bucket = bucketOf(c);
    return c.json(storage.presign(service, bucket, { key: input.key, method: input.method, expiresIn: input.expiresIn, download: c.req.query('download') === '1' }));
  });

  // -------------------------------------------------------------------- keys

  app.get('/api/services/:id/storage/keys', (c) => {
    const service = load(c, 'viewer');
    return c.json(stores.storageKeys.listForService(service.id).map(storageKeyDto));
  });

  app.post('/api/services/:id/storage/keys', async (c) => {
    const service = load(c, 'admin');
    const input = await body(c, createStorageKeySchema);
    if (input.buckets !== null) {
      const known = new Set((await storage.listBuckets(service)).map((bucket) => bucket.name));
      const unknown = input.buckets.filter((bucket) => !known.has(bucket));
      if (unknown.length > 0) throw new AppError('validation_failed', `Unknown bucket: ${unknown.join(', ')}`, { issues: [{ path: 'buckets', code: 'custom', message: 'Unknown bucket', params: { bucket: unknown[0]! } }] });
    }
    const key = await storage.createKey(service, { name: input.name, buckets: input.buckets, permission: input.permission });
    audit(ctx, c, 'storage.key_created', { type: 'service', id: service.id, name: service.name }, { keyId: key.id, name: key.name, permission: key.permission, buckets: key.buckets });
    const created: StorageKeyCreatedDto = { ...storageKeyDto(key), secretAccessKey: key.secretAccessKey };
    return c.json(created, 201);
  });

  app.delete('/api/services/:id/storage/keys/:keyId', async (c) => {
    const service = load(c, 'admin');
    const key = stores.storageKeys.get(c.req.param('keyId')!);
    if (key === undefined || key.serviceId !== service.id) throw notFound('Access key');
    if (key.managedBy === 'backups' && stores.s3.findForService(service.id) !== undefined) {
      throw new AppError('conflict', 'This key belongs to the backup destination; remove the destination instead', { params: { reason: 'managed_key' } });
    }
    await storage.revokeKey(service, key);
    audit(ctx, c, 'storage.key_revoked', { type: 'service', id: service.id, name: service.name }, { keyId: key.id, name: key.name });
    return c.json({ ok: true });
  });

  // ----------------------------------------------------------------- backups

  app.post('/api/services/:id/storage/backup-destination', async (c) => {
    const service = load(c, 'admin');
    const existing = stores.s3.findForService(service.id);
    const destination = await storage.ensureBackupDestination(service);
    if (existing === undefined) audit(ctx, c, 'storage.backup_destination_created', { type: 'service', id: service.id, name: service.name }, { destinationId: destination.id });
    return c.json(s3DestinationDto(ctx, destination), existing === undefined ? 201 : 200);
  });

  // ----------------------------------------------------------------- domains

  app.get('/api/services/:id/domains', (c) => {
    const service = load(c, 'viewer');
    return c.json(stores.domains.listForService(service.id).map((domain) => domainDto(ctx, domain)));
  });

  app.post('/api/services/:id/domains', async (c) => {
    const service = load(c, 'developer');
    const input = await body(c, serviceDomainSchema);
    if (stores.domains.listForService(service.id).length >= LIMITS.domainsPerApp) throw new AppError('conflict', 'Too many domains for one service');
    let domain;
    if (input.generate) {
      domain = generateServiceDomain(ctx, service, stores.projects.get(service.projectId)!);
      if (domain === null) throw new AppError('conflict', 'Set an apps domain in platform settings to generate domains', { params: { reason: 'no_apps_domain' } });
    } else {
      if (input.host === undefined) throw new AppError('validation_failed', 'A host is required', { issues: [{ path: 'host', code: 'invalid_type', message: 'Required' }] });
      // A host belongs to one team: another team may not hang a path off someone else's domain.
      const sameHost = stores.domains.findByHost(input.host);
      if (stores.domains.findRoute(input.host, '/') !== undefined || (sameHost !== undefined && sameHost.teamId !== service.teamId) || stores.settings.platform().platformDomain === input.host) {
        throw new AppError('domain_taken', 'This domain is already in use', { params: { host: input.host } });
      }
      domain = stores.domains.create({ serviceId: service.id, teamId: service.teamId, host: input.host, https: input.https, port: null, isGenerated: false });
    }
    await ctx.proxy.requestSync(service.serverId).catch(() => undefined);
    ctx.domains.followUp(domain.id);
    void ctx.domains.check(domain.id);
    audit(ctx, c, 'domain.added', { type: 'domain', id: domain.id, name: domain.host }, { serviceId: service.id });
    emit(ctx, service.teamId, { type: 'domain.updated', id: domain.id, applicationId: null, serviceId: service.id });
    return c.json(domainDto(ctx, domain), 201);
  });
}
