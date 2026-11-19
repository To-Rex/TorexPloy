/**
 * Uploaded sources (Netlify Drop style).
 *
 * An application whose source is `upload` is built from an archive kept on
 * the control plane at `<dataDir>/uploads/<app>/<upload id>.zip`. The
 * dashboard packs a dropped folder into a zip; a `.zip` file or `curl` from
 * CI arrives as is. The archive is received in full, its directory is read
 * and checked against the platform's bounds, and only then does it replace
 * the application's current one. Each new upload becomes a deployment; the
 * current archive stays so "Deploy" and "Rebuild without cache" can build it
 * again. Older archives are pruned (rollbacks use images, not archives).
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LIMITS } from '@ploy/shared';
import { AppError } from '../lib/errors.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { checkZipLimits, extractZip, readZipDirectory, summarizeZip, ZipError, type ExtractOptions, type ZipSummary } from '../lib/zip.ts';
import type { UploadInfo } from '../store/index.ts';

export const UPLOAD_LIMITS: ExtractOptions = { maxFiles: LIMITS.uploadFilesMax, maxBytes: LIMITS.uploadUnpackedMax };

/** Unfinished uploads older than this are leftovers of an interrupted request. */
const STALE_PART_MS = 60 * 60 * 1000;

export const uploadsDir = (dataDir: string, applicationId: string): string => join(dataDir, 'uploads', applicationId);
export const uploadPath = (dataDir: string, applicationId: string, uploadId: string): string => join(uploadsDir(dataDir, applicationId), `${uploadId}.zip`);

/** The name an archive is shown under: the file's or the folder's, without path parts or control characters. */
export function uploadName(raw: string | undefined): string {
  const cleaned = (raw ?? '')
    .replace(/[\\/]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, LIMITS.uploadNameMax);
  return cleaned.length > 0 ? cleaned : 'upload.zip';
}

/** `1.2 MB`, for logs. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function zipAppError(error: ZipError): AppError {
  return new AppError('bad_request', error.message, { params: { reason: error.reason } });
}

/** Read an archive's directory and check it against the bounds, without extracting. */
export async function inspectArchive(path: string): Promise<ZipSummary> {
  try {
    const summary = summarizeZip(await readZipDirectory(path));
    checkZipLimits(summary, UPLOAD_LIMITS);
    return summary;
  } catch (error) {
    if (error instanceof ZipError) throw zipAppError(error);
    throw error;
  }
}

/**
 * Receive an archive from a request body. It is written next to the final
 * path, must arrive in full (exactly `declaredSize` bytes) and must parse as
 * a zip within the bounds before it is given its name; anything else leaves
 * nothing behind.
 */
export async function receiveUpload(dataDir: string, applicationId: string, body: Readable | null, declaredSize: number, name: string): Promise<UploadInfo> {
  if (declaredSize <= 0) throw new AppError('bad_request', 'The archive is empty', { params: { reason: 'zip_empty' } });
  if (declaredSize > LIMITS.uploadMax) throw new AppError('payload_too_large', 'The archive is larger than the upload limit', { params: { maximum: LIMITS.uploadMax } });
  if (body === null) throw new AppError('bad_request', 'The request has no body', { params: { reason: 'upload_truncated' } });
  const id = newId('upl');
  await mkdir(uploadsDir(dataDir, applicationId), { recursive: true, mode: 0o700 });
  const final = uploadPath(dataDir, applicationId, id);
  const part = `${final}.part`;
  let written = 0;
  try {
    const cap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        if (written > declaredSize) {
          callback(new AppError('payload_too_large', 'The body is longer than Content-Length announced', { params: { maximum: declaredSize } }));
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(body, cap, createWriteStream(part, { mode: 0o600 }));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('bad_request', 'The upload was interrupted', { params: { reason: 'upload_truncated' } });
    }
    if (written !== declaredSize) throw new AppError('bad_request', 'The upload ended before every byte arrived', { params: { reason: 'upload_truncated' } });
    const summary = await inspectArchive(part);
    await rename(part, final);
    return { id, name, size: declaredSize, files: summary.files, bytes: summary.bytes, uploadedAt: nowIso() };
  } catch (error) {
    await rm(part, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Remove every archive of an application except `keep` (the current one, and whatever a running build still reads); stale partial uploads go too. */
export async function pruneUploads(dataDir: string, applicationId: string, keep: Iterable<string | undefined>): Promise<void> {
  const kept = new Set([...keep].filter((id): id is string => id !== undefined).map((id) => `${id}.zip`));
  const dir = uploadsDir(dataDir, applicationId);
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (kept.has(name)) continue;
    if (name.endsWith('.part')) {
      const info = await stat(join(dir, name)).catch(() => null);
      if (info !== null && Date.now() - info.mtimeMs < STALE_PART_MS) continue;
    }
    await rm(join(dir, name), { force: true }).catch(() => undefined);
  }
}

/** Every trace of an application's uploads (the application is being deleted). */
export async function removeUploads(dataDir: string, applicationId: string): Promise<void> {
  await rm(uploadsDir(dataDir, applicationId), { recursive: true, force: true });
}

export interface UnpackResult extends ZipSummary {
  /** The single top-level folder that was unwrapped, when the archive had one. */
  unwrapped: string | null;
}

/**
 * Unpack an archive into an empty build directory. An archive that is one
 * folder (`site/index.html`, `site/css/…` — what "Compress" makes of a
 * folder) is unwrapped so the project root is the context root, the way
 * every static host treats a dropped folder.
 */
export async function unpackUpload(archive: string, destination: string): Promise<UnpackResult> {
  let summary: ZipSummary;
  try {
    summary = await extractZip(archive, destination, UPLOAD_LIMITS);
  } catch (error) {
    if (error instanceof ZipError) throw new AppError('bad_request', `Could not unpack the uploaded archive: ${error.message}`, { params: { reason: 'upload_invalid' } });
    throw error;
  }
  return { ...summary, unwrapped: await unwrapSingleFolder(destination) };
}

async function unwrapSingleFolder(destination: string): Promise<string | null> {
  const entries = await readdir(destination, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0]!.isDirectory()) return null;
  const name = entries[0]!.name;
  // Through a staging name, since a child may be called like the wrapper itself (`site/site`).
  const staging = join(destination, `.ploy-unwrap-${process.pid}`);
  await rename(join(destination, name), staging);
  for (const child of await readdir(staging)) await rename(join(staging, child), join(destination, child));
  await rmdir(staging);
  return name;
}
