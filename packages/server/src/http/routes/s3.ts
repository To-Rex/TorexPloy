/**
 * S3 destinations for off-server backup copies (admin only: they hold storage credentials).
 */
import type { Hono } from 'hono';
import { createS3DestinationSchema, updateS3DestinationSchema, type S3DestinationDto } from '@ploy/shared';
import type { Context } from '../../context.ts';
import { AppError, errorMessage, notFound } from '../../lib/errors.ts';
import { S3Client } from '../../lib/s3.ts';
import type { S3DestinationRecord } from '../../store/index.ts';
import { audit, body, limit, RateLimiter, requireTeam, type Ctx, type Env } from '../core.ts';

export function registerS3Routes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;
  const testLimiter = new RateLimiter(10, 10);

  const dto = (destination: S3DestinationRecord): S3DestinationDto => ({
    id: destination.id,
    name: destination.name,
    endpoint: destination.endpoint,
    region: destination.region,
    bucket: destination.bucket,
    pathPrefix: destination.pathPrefix,
    accessKeyId: destination.accessKeyId,
    forcePathStyle: destination.forcePathStyle,
    services: stores.db
      .all('SELECT id, name FROM services WHERE backup_destination_id = ? ORDER BY name', destination.id)
      .map((row) => ({ id: String(row.id), name: String(row.name) })),
    createdAt: destination.createdAt,
  });

  const load = (c: Ctx): S3DestinationRecord => {
    const auth = requireTeam(c, 'admin');
    const destination = stores.s3.getForTeam(auth.teamId, c.req.param('id')!);
    if (destination === undefined) throw notFound('S3 destination');
    return destination;
  };

  /** Prove the credentials and the bucket work before anything depends on them. */
  const probe = async (destination: Pick<S3DestinationRecord, 'endpoint' | 'region' | 'bucket' | 'accessKeyId' | 'secretAccessKey' | 'forcePathStyle' | 'pathPrefix'>): Promise<string | null> => {
    try {
      await new S3Client(destination).verify(destination.pathPrefix);
      return null;
    } catch (error) {
      return errorMessage(error).slice(0, 400);
    }
  };

  app.get('/api/s3-destinations', (c) => {
    const auth = requireTeam(c, 'developer');
    return c.json(stores.s3.listForTeam(auth.teamId).map(dto));
  });

  app.post('/api/s3-destinations', async (c) => {
    const auth = requireTeam(c, 'admin');
    const input = await body(c, createS3DestinationSchema);
    limit(testLimiter, c, 's3-test');
    const failure = await probe(input);
    if (failure !== null) throw new AppError('bad_request', `The bucket could not be written: ${failure}`, { params: { reason: 's3_unreachable' } });
    const destination = stores.s3.create(auth.teamId, input);
    audit(ctx, c, 's3.created', { type: 's3', id: destination.id, name: destination.name }, { endpoint: destination.endpoint, bucket: destination.bucket });
    return c.json(dto(destination), 201);
  });

  app.patch('/api/s3-destinations/:id', async (c) => {
    const destination = load(c);
    const input = await body(c, updateS3DestinationSchema);
    const merged = { ...destination, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) } as S3DestinationRecord;
    const connectionChanged = ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey', 'forcePathStyle', 'pathPrefix'].some((key) => (input as Record<string, unknown>)[key] !== undefined);
    if (connectionChanged) {
      limit(testLimiter, c, 's3-test');
      const failure = await probe(merged);
      if (failure !== null) throw new AppError('bad_request', `The bucket could not be written: ${failure}`, { params: { reason: 's3_unreachable' } });
    }
    const updated = stores.s3.update(destination.id, input);
    audit(ctx, c, 's3.updated', { type: 's3', id: destination.id, name: updated.name }, { fields: Object.keys(input) });
    return c.json(dto(updated));
  });

  app.post('/api/s3-destinations/:id/test', async (c) => {
    const destination = load(c);
    limit(testLimiter, c, 's3-test');
    const failure = await probe(destination);
    return c.json({ ok: failure === null, error: failure });
  });

  app.delete('/api/s3-destinations/:id', (c) => {
    const destination = load(c);
    // Services fall back to server-only backups (ON DELETE SET NULL); uploaded copies stay in the bucket.
    stores.s3.delete(destination.id);
    audit(ctx, c, 's3.deleted', { type: 's3', id: destination.id, name: destination.name });
    return c.json({ ok: true });
  });
}
