/**
 * Moving projects between panels: exports, imports, and the transfer links
 * one panel pulls another's export through.
 *
 * An archive carries every secret of its project (variables, credentials,
 * keys, data), so all of this is for team administrators, and a token must
 * have full reach. The one route without a session is the transfer link
 * itself: it answers only to the long random token in its path, only while
 * the link is good, and serves an archive that is useless without its
 * passphrase.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  createExportSchema,
  importLinkSchema,
  importPlanSchema,
  importS3Schema,
  transferListQuerySchema,
  unlockTransferSchema,
  type CreatedExportDto,
  type TransferPassphraseDto,
} from '@ploy/shared';
import type { Context } from '../../context.ts';
import { AppError, notFound } from '../../lib/errors.ts';
import type { TransferRecord } from '../../store/index.ts';
import { ArchiveError } from '../../transfer/archive.ts';
import { audit, body, query, requestOrigin, requireTeam, type Ctx, type Env } from '../core.ts';
import { loadProject } from './projects.ts';

/** Wrong passphrases allowed per import before it waits (each try costs the panel a scrypt). */
const UNLOCK_TRIES = 10;
const UNLOCK_WINDOW_MS = 10 * 60_000;

/** Tokens that only read, or may not destroy, do not move projects: an archive is every secret of one. */
function requireFullReach(c: Ctx): void {
  const token = c.get('auth')?.token;
  if (token !== undefined && token.access !== 'full') {
    throw new AppError('forbidden', 'Moving projects needs a sign-in with full access', { params: { reason: 'token_full_required' } });
  }
}

/** The archive as a download, a byte range of it when asked (a download that broke off carries on). */
async function sendArchive(c: Ctx, path: string, fileName: string): Promise<Response> {
  const { size } = await stat(path);
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = c.req.header('range');
  if (range !== undefined) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match !== null && (match[1] !== '' || match[2] !== '')) {
      if (match[1] === '') {
        start = Math.max(0, size - Number(match[2]));
      } else {
        start = Number(match[1]);
        end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
      }
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      status = 206;
    }
  }
  const safeName = fileName.replace(/["\\\r\n]/g, '_');
  return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, {
    status,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    },
  });
}

export function registerTransferRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;
  const unlockTries = new Map<string, { count: number; since: number }>();

  const load = (c: Ctx, id: string = c.req.param('id')!): TransferRecord => {
    const auth = requireTeam(c, 'admin');
    requireFullReach(c);
    const record = stores.transfers.getForTeam(auth.teamId, id);
    if (record === undefined) throw notFound('Transfer');
    return record;
  };

  // ------------------------------------------------------------- the link other panels pull from (no session)

  const pull = async (c: Ctx): Promise<Response> => {
    const record = ctx.transfers.shared(c.req.param('token') ?? '');
    if (record === null) throw new AppError('not_found', 'This transfer link has expired or was withdrawn', { params: { resource: 'transfer' } });
    const path = ctx.transfers.paths(record.id).archive;
    const range = c.req.header('range');
    if (c.req.method === 'GET' && (range === undefined || /^bytes=0-/.test(range))) {
      ctx.transfers.countDownload(record);
      audit(ctx, c, 'transfer.pulled', { type: 'transfer', id: record.id, name: record.projectName, teamId: record.teamId }, { ip: c.get('ip') });
    }
    return sendArchive(c, path, record.fileName);
  };
  app.get('/api/transfers/pull/:token', pull);
  app.on('HEAD', '/api/transfers/pull/:token', pull);

  // ------------------------------------------------------------- listing

  app.get('/api/transfers', (c) => {
    const auth = requireTeam(c, 'admin');
    requireFullReach(c);
    const filter = query(c, transferListQuerySchema);
    return c.json(stores.transfers.listForTeam(auth.teamId, { ...(filter.kind === undefined ? {} : { kind: filter.kind }), ...(filter.projectId === undefined ? {} : { projectId: filter.projectId }) }).map((record) => ctx.transfers.dto(record)));
  });

  // ------------------------------------------------------------- exports

  app.post('/api/transfers/export', async (c) => {
    const auth = requireTeam(c, 'admin');
    requireFullReach(c);
    const input = await body(c, createExportSchema);
    const project = loadProject(ctx, c, 'admin', input.projectId);
    const { transfer, passphrase } = ctx.transfers.startExport(project, auth.user.id, {
      include: input.include,
      ...(input.passphrase === undefined ? {} : { passphrase: input.passphrase }),
      ...(input.s3DestinationId === undefined ? {} : { s3DestinationId: input.s3DestinationId }),
    });
    audit(ctx, c, 'project.exported', { type: 'project', id: project.id, name: project.name }, { transferId: transfer.id, include: input.include, s3: input.s3DestinationId ?? null });
    const result: CreatedExportDto = { transfer: ctx.transfers.dto(transfer), passphrase };
    return c.json(result, 201);
  });

  app.get('/api/transfers/:id/passphrase', (c) => {
    const record = load(c);
    const passphrase = ctx.transfers.passphrase(record);
    if (passphrase === null) throw new AppError('not_found', 'This transfer has no passphrase kept', { params: { resource: 'passphrase' } });
    audit(ctx, c, 'transfer.passphrase_viewed', { type: 'transfer', id: record.id, name: record.projectName });
    const result: TransferPassphraseDto = { passphrase };
    return c.json(result);
  });

  app.get('/api/transfers/:id/download', async (c) => {
    const record = load(c);
    if (record.kind !== 'export' || record.status !== 'succeeded') throw new AppError('conflict', 'Only a finished export can be downloaded', { params: { reason: 'not_downloadable' } });
    const path = ctx.transfers.paths(record.id).archive;
    if ((await stat(path).catch(() => null)) === null) throw new AppError('not_found', 'The archive is no longer kept on the panel', { params: { resource: 'archive' } });
    const range = c.req.header('range');
    if (range === undefined || /^bytes=0-/.test(range)) audit(ctx, c, 'transfer.downloaded', { type: 'transfer', id: record.id, name: record.projectName });
    return sendArchive(c, path, record.fileName);
  });

  app.post('/api/transfers/:id/share', (c) => {
    const record = load(c);
    const share = ctx.transfers.share(record, requestOrigin(c));
    audit(ctx, c, 'transfer.shared', { type: 'transfer', id: record.id, name: record.projectName }, { expiresAt: share.expiresAt });
    return c.json(share);
  });

  app.delete('/api/transfers/:id/share', (c) => {
    const record = load(c);
    const updated = ctx.transfers.unshare(record);
    audit(ctx, c, 'transfer.unshared', { type: 'transfer', id: record.id, name: record.projectName });
    return c.json(ctx.transfers.dto(updated));
  });

  app.post('/api/transfers/:id/s3', async (c) => {
    const record = load(c);
    const input = await body(c, z.object({ destinationId: z.string().min(1).max(64) }));
    const updated = ctx.transfers.copyToS3(record, input.destinationId);
    audit(ctx, c, 'transfer.copied_to_s3', { type: 'transfer', id: record.id, name: record.projectName }, { destinationId: input.destinationId });
    return c.json(ctx.transfers.dto(updated), 202);
  });

  // ------------------------------------------------------------- imports

  app.post('/api/transfers/import/upload', async (c) => {
    const auth = requireTeam(c, 'admin');
    requireFullReach(c);
    const length = c.req.header('content-length');
    if (length === undefined || !/^\d+$/.test(length)) throw new AppError('bad_request', 'Content-Length is required', { params: { reason: 'length_required' } });
    const name = query(c, z.object({ name: z.string().max(255).optional() })).name ?? 'import.torexploy';
    const raw = c.req.raw.body;
    if (raw === null) throw new AppError('bad_request', 'The request has no body', { params: { reason: 'upload_truncated' } });
    const record = await ctx.transfers.receiveUpload(auth.teamId, auth.user.id, Readable.fromWeb(raw as unknown as WebReadableStream), Number(length), name, null);
    if (record.status === 'failed' || record.status === 'cancelled') {
      const reason = record.error?.code ?? 'upload_failed';
      throw new AppError('bad_request', record.error?.message ?? 'The archive could not be received', { params: { reason } });
    }
    audit(ctx, c, 'transfer.received', { type: 'transfer', id: record.id, name: record.fileName }, { source: 'upload', size: record.sizeBytes });
    return c.json(ctx.transfers.dto(record), 201);
  });

  app.post('/api/transfers/import/link', async (c) => {
    const auth = requireTeam(c, 'admin');
    requireFullReach(c);
    const input = await body(c, importLinkSchema);
    const record = await ctx.transfers.receiveLink(auth.teamId, auth.user.id, input.link, input.passphrase ?? null);
    audit(ctx, c, 'transfer.received', { type: 'transfer', id: record.id, name: record.fileName }, { source: 'link', from: new URL(input.link).host });
    return c.json(ctx.transfers.dto(record), 202);
  });

  app.get('/api/transfers/s3/:destinationId', async (c) => {
    const auth = requireTeam(c, 'admin');
    requireFullReach(c);
    const destination = stores.s3.getForTeam(auth.teamId, c.req.param('destinationId'));
    if (destination === undefined) throw notFound('S3 destination');
    return c.json(await ctx.transfers.listS3(destination));
  });

  app.post('/api/transfers/import/s3', async (c) => {
    const auth = requireTeam(c, 'admin');
    requireFullReach(c);
    const input = await body(c, importS3Schema);
    const destination = stores.s3.getForTeam(auth.teamId, input.destinationId);
    if (destination === undefined) throw new AppError('validation_failed', 'Unknown S3 destination', { issues: [{ path: 'destinationId', code: 'custom', message: 'Unknown destination' }] });
    const record = await ctx.transfers.receiveS3(auth.teamId, auth.user.id, destination, input.key, input.passphrase ?? null);
    audit(ctx, c, 'transfer.received', { type: 'transfer', id: record.id, name: record.fileName }, { source: 's3', destinationId: destination.id, key: input.key });
    return c.json(ctx.transfers.dto(record), 202);
  });

  app.post('/api/transfers/:id/unlock', async (c) => {
    const record = load(c);
    const input = await body(c, unlockTransferSchema);
    const tries = unlockTries.get(record.id);
    if (tries !== undefined && Date.now() - tries.since < UNLOCK_WINDOW_MS && tries.count >= UNLOCK_TRIES) {
      throw new AppError('rate_limited', 'Too many wrong passphrases; try again in a few minutes', { params: { reason: 'too_many_tries' } });
    }
    try {
      const analysis = await ctx.transfers.unlock(record, input.passphrase);
      unlockTries.delete(record.id);
      return c.json(analysis);
    } catch (error) {
      if (error instanceof ArchiveError && error.params?.reason === 'wrong_passphrase') {
        const current = tries === undefined || Date.now() - tries.since >= UNLOCK_WINDOW_MS ? { count: 0, since: Date.now() } : tries;
        current.count += 1;
        unlockTries.set(record.id, current);
      }
      throw error;
    }
  });

  app.get('/api/transfers/:id/analysis', async (c) => {
    const record = load(c);
    const { serverId } = query(c, z.object({ serverId: z.string().max(64).optional() }));
    return c.json(await ctx.transfers.analysis(record, serverId ?? null));
  });

  app.post('/api/transfers/:id/start', async (c) => {
    const record = load(c);
    const plan = await body(c, importPlanSchema);
    const updated = await ctx.transfers.startImport(record, plan);
    audit(ctx, c, 'project.import_started', { type: 'transfer', id: record.id, name: plan.projectName }, { serverId: plan.serverId, restoreData: plan.restoreData, deploy: plan.deploy, source: record.source });
    return c.json(ctx.transfers.dto(updated), 202);
  });

  // ------------------------------------------------------------- either

  app.get('/api/transfers/:id', (c) => c.json(ctx.transfers.dto(load(c))));

  app.post('/api/transfers/:id/cancel', (c) => {
    const record = load(c);
    const updated = ctx.transfers.cancel(record);
    audit(ctx, c, 'transfer.cancelled', { type: 'transfer', id: record.id, name: record.projectName ?? record.fileName });
    return c.json(ctx.transfers.dto(stores.transfers.get(updated.id) ?? updated));
  });

  app.post('/api/transfers/:id/retry', (c) => {
    const record = load(c);
    const updated = ctx.transfers.retry(record);
    audit(ctx, c, 'transfer.retried', { type: 'transfer', id: record.id, name: record.projectName ?? record.fileName });
    return c.json(ctx.transfers.dto(updated), 202);
  });

  app.delete('/api/transfers/:id', async (c) => {
    const record = load(c);
    await ctx.transfers.remove(record);
    audit(ctx, c, 'transfer.deleted', { type: 'transfer', id: record.id, name: record.projectName ?? record.fileName }, { kind: record.kind });
    return c.json({ ok: true });
  });
}
