/**
 * Exports and imports as work the panel does in the background.
 *
 * An export is queued, run (two transfers at a time at most), and its archive
 * kept for a week: downloaded from the dashboard or the command line, copied
 * to S3, or pulled by another panel through a transfer link. An import's
 * archive arrives first (an upload, a transfer link, S3), is opened with its
 * passphrase and looked over, and runs once a person has said how.
 *
 * A restart of the panel never leaves a transfer pretending to run: queued
 * ones wait again, running ones fail with the reason and can be retried (an
 * import carries on from where it stopped), and containers a copy had frozen
 * are thawed.
 */
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  TRANSFER_EXTENSION,
  TRANSFER_KEEP_DAYS,
  type ImportAnalysisDto,
  type ImportPlan,
  type TransferDto,
  type TransferInclude,
  type TransferNoteDto,
  type TransferS3ObjectDto,
  type TransferShareDto,
} from '@ploy/shared';
import { emit, type Context } from '../context.ts';
import { generateToken, sha256 } from '../lib/crypto.ts';
import { AppError, errorMessage, reasonOf } from '../lib/errors.ts';
import { nowIso } from '../lib/ids.ts';
import { S3Client } from '../lib/s3.ts';
import type { ImportState, ProjectRecord, S3DestinationRecord, TransferRecord, TransferState } from '../store/index.ts';
import { ArchiveError, generatePassphrase, inspectArchive, MAGIC, readManifest, type ArchiveInfo } from './archive.ts';
import { runExport, transferPaths, type TransferPaths } from './exporter.ts';
import { analyzeImport, emptyImportState, githubAccess, runImport } from './importer.ts';
import { parseManifest, type Manifest } from './manifest.ts';
import { note, Progress } from './progress.ts';

/** Transfers running at once; the rest wait their turn. */
const CONCURRENCY = 2;
/** A transfer link works this long after it is made (or until the export is removed, if sooner). */
const SHARE_TTL_MS = 24 * 3_600_000;
/** Kept free on the disk beyond what a transfer is expected to need. */
const DISK_MARGIN_BYTES = 512 * 1024 * 1024;
const DAY_MS = 24 * 3_600_000;
/** Where exports land inside an S3 destination. */
const S3_FOLDER = 'torexploy-exports';

export class TransferManager {
  private readonly ctx: Context;
  private readonly running = new Map<string, AbortController>();
  private readonly receiving = new Map<string, AbortController>();
  private readonly manifests = new Map<string, { manifest: Manifest; info: ArchiveInfo }>();
  private readonly github = new Map<string, { at: number; matches: Map<string, { installationId: number; account: string }> }>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  get dir(): string {
    return join(this.ctx.config.dataDir, 'transfers');
  }

  paths(id: string): TransferPaths {
    return transferPaths(this.ctx.config.dataDir, id);
  }

  private changed(record: TransferRecord): void {
    emit(this.ctx, record.teamId, { type: 'transfer.updated', id: record.id, kind: record.kind, status: record.status });
  }

  private update(id: string, patch: Parameters<Context['stores']['transfers']['update']>[1]): TransferRecord {
    const record = this.ctx.stores.transfers.update(id, patch);
    this.changed(record);
    return record;
  }

  dto(record: TransferRecord): TransferDto {
    const now = Date.now();
    const shared = record.shareHash !== null && record.shareExpiresAt !== null && Date.parse(record.shareExpiresAt) > now;
    const downloadable = record.kind === 'export' && record.status === 'succeeded' && existsSync(this.paths(record.id).archive);
    return {
      id: record.id,
      kind: record.kind,
      status: record.status,
      source: record.source,
      projectId: record.projectId,
      projectName: record.projectName,
      fileName: record.fileName,
      sizeBytes: record.sizeBytes,
      receivedBytes: record.receivedBytes,
      expectedBytes: record.expectedBytes,
      include: record.include,
      steps: record.steps,
      percent: record.status === 'succeeded' ? 100 : record.percent,
      warnings: record.warnings,
      error: record.error,
      share: shared && downloadable ? { expiresAt: record.shareExpiresAt!, downloads: record.shareDownloads, lastDownloadAt: record.shareLastAt } : null,
      s3: record.s3,
      downloadable,
      expiresAt: record.expiresAt,
      createdBy: record.createdByName,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
    };
  }

  /** The passphrase an export was made with, or an import was opened with. */
  passphrase(record: TransferRecord): string | null {
    return record.passphraseSealed === null ? null : this.ctx.secrets.open(record.passphraseSealed, 'transfer');
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Refuse work the disk cannot hold. */
  private async checkSpace(needed: number): Promise<void> {
    await this.ensureDir();
    try {
      const info = await statfs(this.dir);
      const free = Number(info.bavail) * Number(info.bsize);
      if (free < needed + DISK_MARGIN_BYTES) {
        throw new AppError('conflict', `Not enough free disk space on the panel (${Math.round(free / 1024 / 1024)} MB free)`, { params: { reason: 'disk_full' } });
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
    }
  }

  // ---------------------------------------------------------------- exports

  startExport(project: ProjectRecord, userId: string | null, input: { include: TransferInclude; passphrase?: string | undefined; s3DestinationId?: string | null | undefined }): { transfer: TransferRecord; passphrase: string } {
    const { stores, secrets } = this.ctx;
    let destination: S3DestinationRecord | undefined;
    if (input.s3DestinationId != null) {
      destination = stores.s3.getForTeam(project.teamId, input.s3DestinationId);
      if (destination === undefined) throw new AppError('validation_failed', 'Unknown S3 destination', { issues: [{ path: 's3DestinationId', code: 'custom', message: 'Unknown destination' }] });
    }
    const passphrase = input.passphrase ?? generatePassphrase();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const record = stores.transfers.create({
      teamId: project.teamId,
      kind: 'export',
      status: 'queued',
      source: 'export',
      projectId: project.id,
      projectName: project.name,
      fileName: `${project.slug}-${stamp}${TRANSFER_EXTENSION}`,
      include: input.include,
      passphraseSealed: secrets.seal(passphrase, 'transfer'),
      createdBy: userId,
    });
    const transfer =
      destination === undefined
        ? record
        : stores.transfers.update(record.id, { s3: { destinationId: destination.id, destinationName: destination.name, key: '', status: 'uploading', error: null } });
    this.changed(transfer);
    queueMicrotask(() => this.tick());
    return { transfer, passphrase };
  }

  // ---------------------------------------------------------------- the queue

  private tick(): void {
    if (this.running.size >= CONCURRENCY) return;
    for (const record of this.ctx.stores.transfers.listByStatus(['queued'])) {
      if (this.running.size >= CONCURRENCY) return;
      if (this.running.has(record.id)) continue;
      const controller = new AbortController();
      this.running.set(record.id, controller);
      void this.run(record, controller).finally(() => {
        this.running.delete(record.id);
        this.tick();
      });
    }
  }

  private progressFor(record: TransferRecord): Progress {
    return new Progress({ steps: record.steps, warnings: record.warnings }, (snapshot) => {
      const current = this.ctx.stores.transfers.get(record.id);
      if (current === undefined) return;
      this.update(record.id, snapshot);
    });
  }

  private saveState(id: string, patch: Partial<TransferState>): void {
    const current = this.ctx.stores.transfers.get(id);
    if (current === undefined) return;
    this.ctx.stores.transfers.update(id, { state: { ...(current.state ?? {}), ...patch } });
  }

  private async run(record: TransferRecord, controller: AbortController): Promise<void> {
    const started = this.update(record.id, { status: 'running', startedAt: nowIso(), finishedAt: null, error: null });
    const progress = this.progressFor(started);
    try {
      if (record.kind === 'export') await this.runExport(started, progress, controller.signal);
      else await this.runImport(started, progress, controller.signal);
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const failure: TransferNoteDto = cancelled ? note('cancelled', 'Cancelled') : note(reasonOf(error, 'failed'), errorMessage(error));
      progress.failRunning(failure);
      progress.flush();
      if (record.kind === 'export') {
        const paths = this.paths(record.id);
        await rm(paths.part, { force: true });
        await rm(paths.work, { recursive: true, force: true });
      }
      if (!cancelled) this.ctx.logger.warn(`Project ${record.kind} failed`, { transferId: record.id, error: errorMessage(error) });
      // A failed import keeps its archive for a retry, for as long as an export would be kept.
      this.update(record.id, {
        status: cancelled ? 'cancelled' : 'failed',
        error: failure,
        finishedAt: nowIso(),
        expiresAt: new Date(Date.now() + TRANSFER_KEEP_DAYS * DAY_MS).toISOString(),
      });
    }
  }

  private async runExport(record: TransferRecord, progress: Progress, signal: AbortSignal): Promise<void> {
    const passphrase = this.passphrase(record);
    if (passphrase === null) throw new AppError('bad_request', 'The export has no passphrase');
    await this.checkSpace(0);
    const { size } = await runExport(this.ctx, {
      transfer: record,
      passphrase,
      progress,
      signal,
      paused: (containers) => this.saveState(record.id, { paused: containers }),
    });
    const paths = this.paths(record.id);
    await rename(paths.part, paths.archive);
    let current = this.update(record.id, { sizeBytes: size });
    if (current.s3 !== null) {
      progress.add('upload', 'upload', current.s3.destinationName, { weight: 3 });
      progress.start('upload', size, 'bytes');
      const key = await this.uploadToS3(current, current.s3.destinationId, (bytes) => progress.advance('upload', bytes)).catch((error: unknown) => {
        const warning = note('s3_failed', `The copy to S3 failed: ${errorMessage(error)}`);
        progress.fail('upload', warning);
        progress.warn(warning);
        return null;
      });
      if (key !== null) progress.done('upload');
    }
    progress.flush();
    current = this.update(record.id, {
      status: 'succeeded',
      finishedAt: nowIso(),
      percent: 100,
      expiresAt: new Date(Date.now() + TRANSFER_KEEP_DAYS * DAY_MS).toISOString(),
    });
  }

  private async uploadToS3(record: TransferRecord, destinationId: string, onBytes?: (bytes: number) => void): Promise<string> {
    const { stores } = this.ctx;
    const destination = stores.s3.getForTeam(record.teamId, destinationId);
    if (destination === undefined) throw new AppError('not_found', 'The S3 destination was removed', { params: { resource: 's3_destination' } });
    const archive = this.paths(record.id).archive;
    const { size } = await stat(archive);
    const key = [destination.pathPrefix.replace(/^\/+|\/+$/g, ''), S3_FOLDER, record.fileName].filter((part) => part.length > 0).join('/');
    stores.transfers.update(record.id, { s3: { destinationId: destination.id, destinationName: destination.name, key, status: 'uploading', error: null } });
    try {
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          onBytes?.(chunk.length);
          callback(null, chunk);
        },
      });
      await new S3Client(await this.ctx.storage.destinationTarget(destination)).put(key, createReadStream(archive).pipe(counter), size, 'application/octet-stream');
      this.update(record.id, { s3: { destinationId: destination.id, destinationName: destination.name, key, status: 'done', error: null } });
      return key;
    } catch (error) {
      this.update(record.id, { s3: { destinationId: destination.id, destinationName: destination.name, key, status: 'failed', error: errorMessage(error).slice(0, 500) } });
      throw error;
    }
  }

  /** Copy a finished export to S3 afterwards, in the background (its `s3` state says how it goes). */
  copyToS3(record: TransferRecord, destinationId: string): TransferRecord {
    if (record.kind !== 'export' || record.status !== 'succeeded' || !existsSync(this.paths(record.id).archive)) throw new AppError('conflict', 'Only a finished export that is still kept can be copied', { params: { reason: 'not_downloadable' } });
    const destination = this.ctx.stores.s3.getForTeam(record.teamId, destinationId);
    if (destination === undefined) throw new AppError('validation_failed', 'Unknown S3 destination', { issues: [{ path: 'destinationId', code: 'custom', message: 'Unknown destination' }] });
    if (record.s3?.status === 'uploading') throw new AppError('conflict', 'A copy to S3 is already under way', { params: { reason: 'upload_running' } });
    const updated = this.update(record.id, { s3: { destinationId: destination.id, destinationName: destination.name, key: '', status: 'uploading', error: null } });
    void this.uploadToS3(updated, destination.id).catch((error: unknown) => this.ctx.logger.warn('An export could not be copied to S3', { transferId: record.id, error: errorMessage(error) }));
    return updated;
  }

  private async runImport(record: TransferRecord, progress: Progress, signal: AbortSignal): Promise<void> {
    const passphrase = this.passphrase(record);
    if (passphrase === null || record.plan === null) throw new AppError('bad_request', 'The import has not been opened and planned yet');
    const { manifest } = await this.manifest(record);
    const state: ImportState = { ...emptyImportState(), ...(record.state?.import ?? {}) };
    const github = await this.githubMatches(record, manifest, true);
    const result = await runImport(this.ctx, {
      transfer: record,
      archivePath: this.paths(record.id).archive,
      passphrase,
      manifest,
      plan: record.plan,
      progress,
      signal,
      userId: record.createdBy,
      state,
      verified: record.state?.verified === true,
      github,
      save: (next, extra = {}) => {
        this.saveState(record.id, { import: next, ...(extra.verified === true ? { verified: true } : {}) });
        if (extra.projectId !== undefined) this.update(record.id, { projectId: extra.projectId, projectName: extra.projectName ?? record.projectName });
      },
    });
    progress.flush();
    // The archive has done its work: its space goes back.
    await rm(this.paths(record.id).archive, { force: true });
    this.manifests.delete(record.id);
    const current = this.update(record.id, { status: 'succeeded', projectId: result.projectId, finishedAt: nowIso(), percent: 100, expiresAt: null });
    this.ctx.stores.audit.record({
      teamId: record.teamId,
      userId: record.createdBy,
      action: 'project.imported',
      targetType: 'project',
      targetId: result.projectId,
      targetName: this.ctx.stores.projects.get(result.projectId)?.name ?? record.projectName,
      ip: null,
      metadata: { transferId: record.id, source: record.source, warnings: current.warnings.length },
    });
  }

  cancel(record: TransferRecord): TransferRecord {
    const controller = this.running.get(record.id) ?? this.receiving.get(record.id);
    if (controller !== undefined) {
      controller.abort();
      return record;
    }
    if (record.status === 'queued' || record.status === 'receiving' || record.status === 'locked' || record.status === 'ready') {
      return this.update(record.id, { status: 'cancelled', finishedAt: nowIso(), error: note('cancelled', 'Cancelled'), expiresAt: new Date(Date.now() + DAY_MS).toISOString() });
    }
    throw new AppError('conflict', 'This transfer is not running', { params: { reason: 'not_running' } });
  }

  /** Run a failed or cancelled transfer again: an import carries on where it stopped, an export starts over. */
  retry(record: TransferRecord): TransferRecord {
    if (record.status !== 'failed' && record.status !== 'cancelled') throw new AppError('conflict', 'Only a failed or cancelled transfer can be retried', { params: { reason: 'not_failed' } });
    if (record.kind === 'import') {
      if (!existsSync(this.paths(record.id).archive)) throw new AppError('conflict', 'The archive is no longer on the panel; import it again', { params: { reason: 'archive_missing' } });
      if (record.plan === null) {
        // Never started: back to waiting for its passphrase or plan.
        return this.update(record.id, { status: record.passphraseSealed === null ? 'locked' : 'ready', error: null, finishedAt: null, expiresAt: null });
      }
    }
    const steps = record.kind === 'export' ? [] : record.steps.map((step) => (step.status === 'failed' || step.status === 'running' ? { ...step, status: 'pending' as const, note: null } : step));
    const updated = this.update(record.id, { status: 'queued', error: null, finishedAt: null, expiresAt: null, steps, percent: record.kind === 'export' ? 0 : record.percent, ...(record.kind === 'export' ? { warnings: [] } : {}) });
    queueMicrotask(() => this.tick());
    return updated;
  }

  async remove(record: TransferRecord): Promise<void> {
    this.running.get(record.id)?.abort();
    this.receiving.get(record.id)?.abort();
    const paths = this.paths(record.id);
    await rm(paths.archive, { force: true });
    await rm(paths.part, { force: true });
    await rm(paths.work, { recursive: true, force: true });
    this.manifests.delete(record.id);
    this.ctx.stores.transfers.delete(record.id);
    emit(this.ctx, record.teamId, { type: 'transfer.deleted', id: record.id });
  }

  // ---------------------------------------------------------------- receiving

  private newImport(teamId: string, userId: string | null, source: 'upload' | 'link' | 's3', fileName: string, expectedBytes: number | null): TransferRecord {
    const record = this.ctx.stores.transfers.create({
      teamId,
      kind: 'import',
      status: 'receiving',
      source,
      fileName: fileName.replace(/[\\/\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200) || `import${TRANSFER_EXTENSION}`,
      expectedBytes,
      createdBy: userId,
    });
    this.changed(record);
    return record;
  }

  /** Write an incoming archive next to its final path, counting it, and make it the import's once whole. */
  private async receive(record: TransferRecord, body: Readable, expected: number | null, signal: AbortSignal): Promise<number> {
    await this.ensureDir();
    const paths = this.paths(record.id);
    let received = 0;
    let reported = 0;
    let head = Buffer.alloc(0);
    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        // Not an archive of ours: stop at its first bytes instead of storing all of it.
        if (head.length < MAGIC.length) {
          head = Buffer.concat([head, chunk.subarray(0, MAGIC.length - head.length)]);
          if (!MAGIC.subarray(0, head.length).equals(head)) {
            callback(new ArchiveError('not_archive', 'This is not a TorexPloy export (.torexploy)'));
            return;
          }
        }
        received += chunk.length;
        if (expected !== null && received > expected) {
          callback(new AppError('payload_too_large', 'The archive is longer than announced', { params: { reason: 'upload_too_long' } }));
          return;
        }
        if (received - reported > 8 * 1024 * 1024) {
          reported = received;
          this.update(record.id, { receivedBytes: received });
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(body, counter, createWriteStream(paths.part, { mode: 0o600 }), { signal });
    } catch (error) {
      await rm(paths.part, { force: true });
      if (error instanceof AppError) throw error;
      throw new AppError('bad_request', signal.aborted ? 'Cancelled' : `The archive did not arrive whole: ${errorMessage(error)}`, { params: { reason: signal.aborted ? 'cancelled' : 'upload_truncated' } });
    }
    if (expected !== null && received !== expected) {
      await rm(paths.part, { force: true });
      throw new AppError('bad_request', 'The archive ended before every byte arrived', { params: { reason: 'upload_truncated' } });
    }
    try {
      await inspectArchive(paths.part);
    } catch (error) {
      await rm(paths.part, { force: true });
      throw error;
    }
    await rename(paths.part, paths.archive);
    return received;
  }

  /**
   * The archive came whole. With a passphrase at hand (a transfer link carries one) it is opened straight away, so
   * nobody watching ever sees it wait for one; otherwise, or when that passphrase does not open it, it waits.
   */
  private async received(record: TransferRecord, size: number, passphrase: string | null): Promise<TransferRecord> {
    const kept = { sizeBytes: size, receivedBytes: size, expiresAt: new Date(Date.now() + TRANSFER_KEEP_DAYS * DAY_MS).toISOString() };
    if (passphrase !== null) {
      try {
        const { manifest } = await this.manifest(record, passphrase);
        return this.update(record.id, {
          ...kept,
          status: 'ready',
          passphraseSealed: this.ctx.secrets.seal(passphrase, 'transfer'),
          projectName: manifest.project.name,
          include: manifest.include,
          warnings: manifest.warnings,
        });
      } catch (error) {
        if (!(error instanceof ArchiveError)) throw error;
      }
    }
    return this.update(record.id, { ...kept, status: 'locked' });
  }

  private failReceive(record: TransferRecord, error: unknown): TransferRecord {
    const cancelled = reasonOf(error) === 'cancelled';
    return this.update(record.id, {
      status: cancelled ? 'cancelled' : 'failed',
      error: note(reasonOf(error, 'upload_failed'), errorMessage(error)),
      finishedAt: nowIso(),
      expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
    });
  }

  /** An archive uploaded in the request body (the dashboard, `torex import`). */
  async receiveUpload(teamId: string, userId: string | null, body: Readable, size: number, name: string, passphrase: string | null): Promise<TransferRecord> {
    if (size <= 0) throw new AppError('bad_request', 'The archive is empty', { params: { reason: 'zip_empty' } });
    await this.checkSpace(size);
    const record = this.newImport(teamId, userId, 'upload', name, size);
    const controller = new AbortController();
    this.receiving.set(record.id, controller);
    try {
      const received = await this.receive(record, body, size, controller.signal);
      return await this.received(record, received, passphrase);
    } catch (error) {
      return this.failReceive(record, error);
    } finally {
      this.receiving.delete(record.id);
    }
  }

  /** An archive another panel offers through its transfer link; fetched in the background. */
  async receiveLink(teamId: string, userId: string | null, link: string, passphrase: string | null): Promise<TransferRecord> {
    const parsed = parseTransferLink(link);
    const key = passphrase ?? parsed.passphrase;
    const record = this.newImport(teamId, userId, 'link', `${new URL(parsed.url).host}${TRANSFER_EXTENSION}`, null);
    const controller = new AbortController();
    this.receiving.set(record.id, controller);
    void (async () => {
      try {
        const response = await fetch(parsed.url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': `TorexPloy/${this.ctx.config.version}` } });
        if (response.status === 404 || response.status === 410) throw new AppError('not_found', 'The transfer link has expired, was withdrawn, or its export was removed', { params: { reason: 'link_expired' } });
        if (!response.ok || response.body === null) throw new AppError('bad_request', `The other panel answered ${response.status}`, { params: { reason: 'link_failed' } });
        const length = Number(response.headers.get('content-length'));
        const expected = Number.isSafeInteger(length) && length > 0 ? length : null;
        const disposition = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1];
        this.update(record.id, { expectedBytes: expected, ...(disposition === undefined ? {} : { fileName: disposition.replace(/[\\/\x00-\x1f\x7f]+/g, ' ').slice(0, 200) }) });
        await this.checkSpace(expected ?? 0);
        const received = await this.receive(record, Readable.fromWeb(response.body as unknown as WebReadableStream), expected, controller.signal);
        await this.received(this.ctx.stores.transfers.get(record.id)!, received, key);
      } catch (error) {
        const reason = controller.signal.aborted ? new AppError('bad_request', 'Cancelled', { params: { reason: 'cancelled' } }) : error;
        if (!(error instanceof AppError)) this.ctx.logger.warn('A transfer link could not be fetched', { transferId: record.id, error: errorMessage(error) });
        this.failReceive(this.ctx.stores.transfers.get(record.id) ?? record, error instanceof AppError ? reason : new AppError('bad_request', `The other panel could not be reached: ${errorMessage(error)}`, { params: { reason: 'link_unreachable' } }));
      } finally {
        this.receiving.delete(record.id);
      }
    })();
    return record;
  }

  /** An archive in one of the team's S3 destinations; fetched in the background. */
  async receiveS3(teamId: string, userId: string | null, destination: S3DestinationRecord, key: string, passphrase: string | null): Promise<TransferRecord> {
    const record = this.newImport(teamId, userId, 's3', key.split('/').pop() ?? key, null);
    const controller = new AbortController();
    this.receiving.set(record.id, controller);
    void (async () => {
      try {
        const response = await new S3Client(await this.ctx.storage.destinationTarget(destination)).get(key);
        const length = Number(response.headers['content-length']);
        const expected = Number.isSafeInteger(length) && length > 0 ? length : null;
        this.update(record.id, { expectedBytes: expected });
        await this.checkSpace(expected ?? 0);
        const received = await this.receive(record, response, expected, controller.signal);
        await this.received(this.ctx.stores.transfers.get(record.id)!, received, passphrase);
      } catch (error) {
        this.failReceive(this.ctx.stores.transfers.get(record.id) ?? record, controller.signal.aborted ? new AppError('bad_request', 'Cancelled', { params: { reason: 'cancelled' } }) : error);
      } finally {
        this.receiving.delete(record.id);
      }
    })();
    return record;
  }

  async listS3(destination: S3DestinationRecord): Promise<TransferS3ObjectDto[]> {
    const client = new S3Client(await this.ctx.storage.destinationTarget(destination));
    const prefix = destination.pathPrefix.replace(/^\/+|\/+$/g, '');
    const found: TransferS3ObjectDto[] = [];
    let token: string | undefined;
    for (let page = 0; page < 20 && found.length < 500; page += 1) {
      const listing = await client.listObjects({ ...(prefix.length === 0 ? {} : { prefix: `${prefix}/` }), maxKeys: 1000, ...(token === undefined ? {} : { continuationToken: token }) });
      for (const object of listing.objects) if (object.key.endsWith(TRANSFER_EXTENSION)) found.push({ key: object.key, size: object.size, lastModified: object.lastModified || null });
      if (!listing.truncated || listing.nextContinuationToken === null) break;
      token = listing.nextContinuationToken;
    }
    return found.sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? ''));
  }

  // ---------------------------------------------------------------- opening and planning

  private async manifest(record: TransferRecord, passphrase?: string): Promise<{ manifest: Manifest; info: ArchiveInfo }> {
    const cached = this.manifests.get(record.id);
    if (cached !== undefined && passphrase === undefined) return cached;
    const key = passphrase ?? this.passphrase(record);
    if (key === null) throw new AppError('conflict', 'Open the archive with its passphrase first', { params: { reason: 'locked' } });
    const path = this.paths(record.id).archive;
    if (!existsSync(path)) throw new AppError('conflict', 'The archive is no longer on the panel', { params: { reason: 'archive_missing' } });
    const { info, manifest: raw } = await readManifest(path, key);
    let manifest: Manifest;
    try {
      manifest = parseManifest(raw);
    } catch (error) {
      throw new ArchiveError('corrupt', errorMessage(error));
    }
    const value = { manifest, info };
    this.manifests.set(record.id, value);
    if (this.manifests.size > 20) this.manifests.delete(this.manifests.keys().next().value!);
    return value;
  }

  private async githubMatches(record: TransferRecord, manifest: Manifest, fresh = false): Promise<Map<string, { installationId: number; account: string }>> {
    const cached = this.github.get(record.id);
    if (!fresh && cached !== undefined && Date.now() - cached.at < 2 * 60_000) return cached.matches;
    const repositories = manifest.applications.filter((app) => app.settings.sourceType === 'github' && app.settings.repository !== null).map((app) => app.settings.repository!);
    const matches = await githubAccess(this.ctx, record.teamId, repositories);
    this.github.set(record.id, { at: Date.now(), matches });
    return matches;
  }

  /** Open an import's archive with its passphrase: what it holds, against this panel. */
  async unlock(record: TransferRecord, passphrase: string): Promise<ImportAnalysisDto> {
    if (record.kind !== 'import' || !['locked', 'ready'].includes(record.status)) throw new AppError('conflict', 'This import is not waiting to be opened', { params: { reason: 'not_locked' } });
    const { manifest, info } = await this.manifest(record, passphrase);
    const updated = this.update(record.id, {
      status: 'ready',
      passphraseSealed: this.ctx.secrets.seal(passphrase, 'transfer'),
      projectName: manifest.project.name,
      include: manifest.include,
      warnings: manifest.warnings,
    });
    return analyzeImport(this.ctx, updated, manifest, info, null, await this.githubMatches(updated, manifest));
  }

  async analysis(record: TransferRecord, serverId: string | null): Promise<ImportAnalysisDto> {
    if (record.kind !== 'import' || record.passphraseSealed === null) throw new AppError('conflict', 'Open the archive with its passphrase first', { params: { reason: 'locked' } });
    const { manifest, info } = await this.manifest(record);
    return analyzeImport(this.ctx, record, manifest, info, serverId, await this.githubMatches(record, manifest));
  }

  async startImport(record: TransferRecord, plan: ImportPlan): Promise<TransferRecord> {
    if (record.kind !== 'import' || record.status !== 'ready') throw new AppError('conflict', 'This import is not ready to start', { params: { reason: 'not_ready' } });
    if (this.ctx.stores.servers.getForTeam(record.teamId, plan.serverId) === undefined) {
      throw new AppError('validation_failed', 'Unknown server', { issues: [{ path: 'serverId', code: 'custom', message: 'Unknown server' }] });
    }
    const { manifest } = await this.manifest(record);
    for (const appId of Object.keys(plan.sources)) {
      if (!manifest.applications.some((app) => app.id === appId)) throw new AppError('validation_failed', 'Unknown application in the plan', { issues: [{ path: `sources.${appId}`, code: 'custom', message: 'Not in the archive' }] });
    }
    // The disk must hold what the archive unpacks into on top of the archive itself (a rough upper bound: its size again).
    await this.checkSpace(record.sizeBytes ?? 0);
    const updated = this.update(record.id, { status: 'queued', plan, projectName: plan.projectName, steps: [], percent: 0, error: null, expiresAt: null });
    queueMicrotask(() => this.tick());
    return updated;
  }

  // ---------------------------------------------------------------- transfer links

  share(record: TransferRecord, origin: string): TransferShareDto {
    if (record.kind !== 'export' || record.status !== 'succeeded' || !existsSync(this.paths(record.id).archive)) {
      throw new AppError('conflict', 'Only a finished export that is still kept can be shared', { params: { reason: 'not_downloadable' } });
    }
    const passphrase = this.passphrase(record);
    if (passphrase === null) throw new AppError('conflict', 'The export has no passphrase');
    const token = generateToken(32);
    const expiresAt = new Date(Math.min(Date.now() + SHARE_TTL_MS, record.expiresAt === null ? Infinity : Date.parse(record.expiresAt))).toISOString();
    this.update(record.id, { shareHash: sha256(token), shareExpiresAt: expiresAt });
    const url = `${(this.ctx.config.publicUrl ?? origin).replace(/\/+$/, '')}/api/transfers/pull/${token}`;
    return { link: `${url}#${encodeURIComponent(passphrase)}`, url, passphrase, expiresAt };
  }

  unshare(record: TransferRecord): TransferRecord {
    return this.update(record.id, { shareHash: null, shareExpiresAt: null });
  }

  /** The export a transfer link names, while the link is good and the archive kept. */
  shared(token: string): TransferRecord | null {
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
    const record = this.ctx.stores.transfers.findByShareHash(sha256(token));
    if (record === undefined || record.kind !== 'export' || record.status !== 'succeeded') return null;
    if (record.shareExpiresAt === null || Date.parse(record.shareExpiresAt) <= Date.now()) return null;
    if (!existsSync(this.paths(record.id).archive)) return null;
    return record;
  }

  countDownload(record: TransferRecord): void {
    this.ctx.stores.transfers.countDownload(record.id);
    this.changed(this.ctx.stores.transfers.get(record.id)!);
  }

  // ---------------------------------------------------------------- lifecycle

  /** At start: queued work waits again, interrupted work fails with the reason, frozen containers thaw, leftovers go. */
  async recover(): Promise<void> {
    const { stores } = this.ctx;
    for (const record of stores.transfers.listByStatus(['running', 'receiving'])) {
      const paths = this.paths(record.id);
      await rm(paths.part, { force: true });
      await rm(paths.work, { recursive: true, force: true });
      stores.transfers.update(record.id, {
        status: 'failed',
        error: note('interrupted', record.kind === 'import' && record.status === 'running' ? 'The panel restarted during the import; retry to carry on where it stopped' : 'The panel restarted while this was under way; start it again'),
        finishedAt: nowIso(),
        expiresAt: new Date(Date.now() + TRANSFER_KEEP_DAYS * DAY_MS).toISOString(),
      });
    }
    for (const record of stores.transfers.listByStatus(['failed', 'succeeded', 'cancelled', 'queued'])) {
      const paused = record.state?.paused ?? [];
      if (paused.length === 0) continue;
      for (const { serverId, container } of paused) {
        try {
          const docker = await this.ctx.connections.docker(serverId);
          await docker.unpauseContainer(container);
        } catch (error) {
          this.ctx.logger.warn('Could not resume a container an export had paused', { transferId: record.id, container, error: errorMessage(error) });
        }
      }
      this.saveState(record.id, { paused: [] });
    }
    queueMicrotask(() => this.tick());
  }

  /** Archives past keeping are removed (the row stays, as history); leftovers of nothing are too. */
  async prune(): Promise<void> {
    const { stores } = this.ctx;
    for (const record of stores.transfers.listExpired(nowIso())) {
      if (this.running.has(record.id) || this.receiving.has(record.id)) continue;
      const paths = this.paths(record.id);
      await rm(paths.archive, { force: true });
      await rm(paths.part, { force: true });
      this.manifests.delete(record.id);
      const patch: Parameters<Context['stores']['transfers']['update']>[1] = { expiresAt: null, shareHash: null, shareExpiresAt: null };
      // An import that never ran has nothing left to run from.
      if (record.kind === 'import' && ['locked', 'ready', 'failed', 'cancelled'].includes(record.status)) {
        patch.status = record.status === 'locked' || record.status === 'ready' ? 'cancelled' : record.status;
        patch.passphraseSealed = null;
      }
      this.update(record.id, patch);
    }
    let entries: string[] = [];
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const id = entry.replace(/\.torexploy(\.part)?$|\.work$/, '');
      if (stores.transfers.get(id) !== undefined || this.running.has(id) || this.receiving.has(id)) continue;
      const path = join(this.dir, entry);
      const info = await stat(path).catch(() => null);
      if (info !== null && Date.now() - info.mtimeMs > DAY_MS) await rm(path, { recursive: true, force: true });
    }
  }
}

/** A transfer link: `https://panel/api/transfers/pull/<token>`, with the passphrase after `#` when it carries one. */
export function parseTransferLink(link: string): { url: string; passphrase: string | null } {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new AppError('validation_failed', 'This is not a transfer link', { issues: [{ path: 'link', code: 'custom', message: 'Paste the whole link the other panel gave', params: { reason: 'link_invalid' } }] });
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '' || !/^\/api\/transfers\/pull\/[A-Za-z0-9_-]{20,128}$/.test(url.pathname)) {
    throw new AppError('validation_failed', 'This is not a transfer link', { issues: [{ path: 'link', code: 'custom', message: 'Paste the whole link the other panel gave', params: { reason: 'link_invalid' } }] });
  }
  let passphrase: string | null = null;
  if (url.hash.length > 1) {
    try {
      passphrase = decodeURIComponent(url.hash.slice(1));
    } catch {
      passphrase = url.hash.slice(1);
    }
  }
  url.hash = '';
  url.search = '';
  return { url: url.toString(), passphrase };
}
