/**
 * An application's code, as one zip: what an export carries so the import can
 * build the application without its repository.
 *
 * For a repository source it is the commit that runs, checked out the way a
 * build checks it out (with submodules) and packed without `.git`; for an
 * uploaded source it is the archive that was uploaded. Either way the result
 * is an ordinary upload archive: the importing panel takes it as the
 * application's upload, within the same bounds as any other.
 */
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdtemp, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { crc32, dosDateTime, LIMITS, ZIP_MAX_BYTES, ZIP_MAX_ENTRIES } from '@ploy/shared';
import type { Context } from '../context.ts';
import { checkout } from '../build/git.ts';
import { inspectArchive, uploadPath } from '../deploy/uploads.ts';
import { AppError, errorMessage } from '../lib/errors.ts';
import type { ApplicationRecord } from '../store/index.ts';

/** Files above this are stored (streamed, no compression) rather than read whole and deflated. */
const DEFLATE_MAX_BYTES = 32 * 1024 * 1024;
const NAME_FLAG_UTF8 = 0x0800;
const FLAG_DESCRIPTOR = 0x0008;

export interface ZipResult {
  size: number;
  files: number;
  bytes: number;
}

/**
 * Pack a directory into a zip at `out`, one file in memory at a time. Symlinks are left out (an upload never
 * creates them either); `skip` leaves out paths (relative, forward slashes) such as `.git`.
 */
export async function zipDirectory(root: string, out: string, options: { skip?: (path: string) => boolean; maxFiles?: number; maxBytes?: number } = {}): Promise<ZipResult> {
  const maxFiles = Math.min(options.maxFiles ?? LIMITS.uploadFilesMax, ZIP_MAX_ENTRIES);
  const maxBytes = options.maxBytes ?? LIMITS.uploadUnpackedMax;
  const handle = await open(out, 'wx', 0o600);
  const central: Buffer[] = [];
  let offset = 0;
  let files = 0;
  let bytes = 0;
  const write = async (buffer: Buffer): Promise<void> => {
    await handle.write(buffer);
    offset += buffer.length;
    if (offset > ZIP_MAX_BYTES) throw new AppError('payload_too_large', 'The code is too large to pack (over 4 GB)', { params: { reason: 'source_too_large' } });
  };

  const walk = async (dir: string): Promise<void> => {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const full = join(dir, name);
      const path = relative(root, full).split(sep).join('/');
      if (options.skip?.(path) === true) continue;
      const info = await lstat(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!info.isFile()) continue;
      files += 1;
      bytes += info.size;
      if (files > maxFiles) throw new AppError('payload_too_large', `The code has more than ${maxFiles} files`, { params: { reason: 'zip_too_many_files' } });
      if (bytes > maxBytes) throw new AppError('payload_too_large', 'The code is larger than an upload may be once unpacked', { params: { reason: 'zip_too_big' } });
      const nameBytes = Buffer.from(path, 'utf8');
      const { date, time } = dosDateTime(info.mtime);
      const mode = (info.mode & 0o111) !== 0 ? 0o100755 : 0o100644;
      const start = offset;
      let method = 0;
      let crc = 0;
      let compressed = 0;
      let flags = NAME_FLAG_UTF8;
      if (info.size <= DEFLATE_MAX_BYTES) {
        const data = await readFile(full);
        crc = crc32(data);
        let payload = data;
        if (data.length >= 64) {
          const deflated = deflateRawSync(data, { level: 6 });
          if (deflated.length < data.length) {
            payload = deflated;
            method = 8;
          }
        }
        compressed = payload.length;
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(flags, 6);
        header.writeUInt16LE(method, 8);
        header.writeUInt16LE(time, 10);
        header.writeUInt16LE(date, 12);
        header.writeUInt32LE(crc, 14);
        header.writeUInt32LE(compressed, 18);
        header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(nameBytes.length, 26);
        header.writeUInt16LE(0, 28);
        await write(Buffer.concat([header, nameBytes]));
        await write(payload);
      } else {
        // Big files stream through stored, with their CRC and sizes in a descriptor after the data.
        flags |= FLAG_DESCRIPTOR;
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(flags, 6);
        header.writeUInt16LE(0, 8);
        header.writeUInt16LE(time, 10);
        header.writeUInt16LE(date, 12);
        header.writeUInt16LE(nameBytes.length, 26);
        await write(Buffer.concat([header, nameBytes]));
        for await (const chunk of createReadStream(full)) {
          const piece = chunk as Buffer;
          crc = crc32(piece, crc);
          compressed += piece.length;
          await write(piece);
        }
        if (compressed !== info.size) throw new AppError('bad_request', `${path} changed while it was packed`);
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(crc, 4);
        descriptor.writeUInt32LE(compressed, 8);
        descriptor.writeUInt32LE(info.size, 12);
        await write(descriptor);
      }
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE((3 << 8) | 20, 4);
      entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(flags, 8);
      entry.writeUInt16LE(method, 10);
      entry.writeUInt16LE(time, 12);
      entry.writeUInt16LE(date, 14);
      entry.writeUInt32LE(crc, 16);
      entry.writeUInt32LE(compressed, 20);
      entry.writeUInt32LE(info.size, 24);
      entry.writeUInt16LE(nameBytes.length, 28);
      entry.writeUInt32LE((mode << 16) >>> 0, 38);
      entry.writeUInt32LE(start, 42);
      central.push(Buffer.concat([entry, nameBytes]));
    }
  };

  try {
    await walk(root);
    if (files === 0) throw new AppError('bad_request', 'There is no code to pack', { params: { reason: 'zip_empty' } });
    const directoryStart = offset;
    for (const entry of central) await write(entry);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - directoryStart, 12);
    end.writeUInt32LE(directoryStart, 16);
    await write(end);
    await handle.close();
    return { size: offset, files, bytes };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(out, { force: true });
    throw error;
  }
}

export interface SourceSnapshot {
  path: string;
  name: string;
  size: number;
  files: number;
  bytes: number;
  origin: 'commit' | 'upload';
}

/**
 * The code an application runs, as a zip in `workDir`, or null when it has none to take (an image, a compose
 * file kept in the panel). Failures are thrown with a reason the export reports as a warning.
 */
export async function snapshotSource(ctx: Context, app: ApplicationRecord, workDir: string, signal?: AbortSignal): Promise<SourceSnapshot | null> {
  if (app.sourceType === 'image' || app.sourceType === 'raw') return null;
  const out = join(workDir, `${app.id}-source.zip`);
  const active = app.activeDeploymentId === null ? undefined : ctx.stores.deployments.get(app.activeDeploymentId);

  if (app.sourceType === 'upload') {
    // What runs, when its archive is still here; else the current one.
    const candidates = [active?.upload, app.upload].filter((upload): upload is NonNullable<typeof upload> => upload !== null && upload !== undefined);
    for (const upload of candidates) {
      const file = uploadPath(ctx.config.dataDir, app.id, upload.id);
      if ((await stat(file).catch(() => null)) === null) continue;
      await copyFile(file, out);
      const summary = await inspectArchive(out);
      return { path: out, name: upload.name, size: (await stat(out)).size, files: summary.files, bytes: summary.bytes, origin: 'upload' };
    }
    throw new AppError('bad_request', 'The uploaded archive is no longer on this panel', { params: { reason: 'upload_missing' } });
  }

  const checkoutDir = await mkdtemp(join(workDir, 'checkout-'));
  try {
    const access = await ctx.gitProviders.access(app);
    await checkout({
      url: access.url,
      branch: app.branch ?? 'main',
      commitSha: active?.commitSha ?? null,
      workDir: checkoutDir,
      httpAuth: access.httpAuth,
      deployKey: app.deployKey === null ? null : ctx.secrets.open(app.deployKey, 'ssh'),
      timeoutMs: 10 * 60_000,
      ...(signal === undefined ? {} : { signal }),
      onOutput: () => undefined,
    });
    const result = await zipDirectory(checkoutDir, out, { skip: (path) => path === '.git' || path.endsWith('/.git') });
    if (result.size > LIMITS.uploadMax) {
      await rm(out, { force: true });
      throw new AppError('payload_too_large', 'The code is larger than an upload may be', { params: { reason: 'source_too_large' } });
    }
    const label = `${(app.repository ?? app.gitUrl ?? app.name).replace(/^.*[/:]/, '').replace(/\.git$/, '')}${active?.commitSha ? `-${active.commitSha.slice(0, 7)}` : ''}.zip`;
    return { path: out, name: label, size: result.size, files: result.files, bytes: result.bytes, origin: 'commit' };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('bad_request', `The code could not be fetched: ${errorMessage(error)}`, { params: { reason: 'source_unreachable' } });
  } finally {
    await rm(checkoutDir, { recursive: true, force: true });
  }
}
