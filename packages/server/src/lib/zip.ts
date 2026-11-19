/**
 * Reading zip archives — the ones people upload as an application's source.
 *
 * Archives come from anywhere (a file manager's "Compress", `zip -r`, the
 * dashboard's own writer, Python, Go…), so the reader follows the central
 * directory the way every tool writes it and tolerates what varies: data
 * descriptors, Zip64 sizes and counts, DOS or Unix attributes, any name
 * encoding treated as UTF-8.
 *
 * It is also the only thing between an untrusted file and the build
 * directory, so it is strict where that matters: every path is normalized
 * and must stay inside the destination, symlinks are never created,
 * declared sizes are enforced while inflating (a zip bomb stops at the cap,
 * not at the disk), CRCs are checked, and modes are reduced to two
 * (`0644`, or `0755` when the entry was executable).
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw, inflateRawSync } from 'node:zlib';
import { crc32 } from '@ploy/shared';

export type ZipErrorReason = 'zip_invalid' | 'zip_unsafe_path' | 'zip_unsupported' | 'zip_too_many_files' | 'zip_too_big' | 'zip_empty';

export class ZipError extends Error {
  override name = 'ZipError';
  readonly reason: ZipErrorReason;

  constructor(reason: ZipErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface ZipEntry {
  /** Normalized path: forward slashes, no leading slash, no `.`/`..` segments, no trailing slash. */
  path: string;
  /** The raw name as written in the archive. */
  rawName: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** Offset of the local file header. */
  headerOffset: number;
  /** Unix mode when the archive recorded one, else null. */
  mode: number | null;
  isDirectory: boolean;
  isSymlink: boolean;
  /** Set for entries the platform never extracts: macOS resource forks, Finder and Explorer metadata. */
  isSystemFile: boolean;
}

export interface ZipSummary {
  /** Regular files that would be extracted. */
  files: number;
  /** Their total size once unpacked. */
  bytes: number;
  /** Entries left out: system files and symlinks. */
  skipped: number;
}

export interface ExtractOptions {
  maxFiles: number;
  maxBytes: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const END_MIN = 22;
const COMMENT_MAX = 0xffff;
/** Entries at most this big (compressed) are inflated in memory; larger ones stream. */
const SYNC_INFLATE_MAX = 8 * 1024 * 1024;
/** A central directory beyond this is not a source archive anyone would upload. */
const DIRECTORY_MAX = 64 * 1024 * 1024;
const PATH_MAX = 1024;
const SYSTEM_DIRS = new Set(['__MACOSX']);
const SYSTEM_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

function safeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('zip_invalid', `${what} is out of range`);
  return Number(value);
}

/**
 * Normalize an entry name into a path that cannot leave the destination.
 * Backslashes count as separators (some Windows tools write them); `.`
 * segments vanish; anything with `..`, a drive letter, a NUL or an
 * over-long name is refused rather than "fixed".
 */
export function safeEntryPath(rawName: string): { path: string; isDirectory: boolean } {
  if (rawName.includes('\0')) throw new ZipError('zip_unsafe_path', 'An entry name contains a NUL character');
  if (Buffer.byteLength(rawName) > PATH_MAX) throw new ZipError('zip_unsafe_path', 'An entry name is longer than 1024 bytes');
  const slashed = rawName.replace(/\\/g, '/');
  const isDirectory = slashed.endsWith('/');
  if (/^[A-Za-z]:/.test(slashed)) throw new ZipError('zip_unsafe_path', `Absolute path in archive: ${rawName}`);
  const segments = slashed.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.includes('..')) throw new ZipError('zip_unsafe_path', `Path escapes the archive: ${rawName}`);
  return { path: segments.join('/'), isDirectory };
}

function isSystemPath(path: string): boolean {
  const segments = path.split('/');
  return SYSTEM_DIRS.has(segments[0]!) || SYSTEM_FILES.has(segments[segments.length - 1]!);
}

async function readAt(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, offset + done);
    if (bytesRead === 0) throw new ZipError('zip_invalid', 'The archive ends unexpectedly');
    done += bytesRead;
  }
  return buffer;
}

interface EndRecord {
  entries: number;
  directorySize: number;
  directoryOffset: number;
}

/** Find the end-of-central-directory record, following the Zip64 locator when the classic fields overflow. */
async function readEndRecord(handle: FileHandle, fileSize: number): Promise<EndRecord> {
  if (fileSize < END_MIN) throw new ZipError('zip_invalid', 'The file is not a zip archive');
  const tailLength = Math.min(fileSize, END_MIN + COMMENT_MAX);
  const tailOffset = fileSize - tailLength;
  const tail = await readAt(handle, tailOffset, tailLength);
  let at = -1;
  for (let i = tailLength - END_MIN; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== SIG_END) continue;
    const commentLength = tail.readUInt16LE(i + 20);
    if (i + END_MIN + commentLength === tailLength) {
      at = i;
      break;
    }
  }
  if (at === -1) throw new ZipError('zip_invalid', 'The file is not a zip archive (no end record)');
  if (tail.readUInt16LE(at + 4) !== 0 || tail.readUInt16LE(at + 6) !== 0) throw new ZipError('zip_unsupported', 'Multi-disk archives are not supported');
  let entries = tail.readUInt16LE(at + 10);
  let directorySize = tail.readUInt32LE(at + 12);
  let directoryOffset = tail.readUInt32LE(at + 16);
  const needs64 = entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff;
  const endOffset = tailOffset + at;
  if (needs64 || endOffset >= 20) {
    const locatorOffset = endOffset - 20;
    const locator = locatorOffset >= 0 ? await readAt(handle, locatorOffset, 20) : null;
    if (locator !== null && locator.readUInt32LE(0) === SIG_LOCATOR64) {
      const end64Offset = safeNumber(locator.readBigUInt64LE(8), 'Zip64 end record offset');
      if (end64Offset + 56 > fileSize) throw new ZipError('zip_invalid', 'The Zip64 end record is out of range');
      const end64 = await readAt(handle, end64Offset, 56);
      if (end64.readUInt32LE(0) !== SIG_END64) throw new ZipError('zip_invalid', 'The Zip64 end record is corrupt');
      entries = safeNumber(end64.readBigUInt64LE(32), 'Entry count');
      directorySize = safeNumber(end64.readBigUInt64LE(40), 'Central directory size');
      directoryOffset = safeNumber(end64.readBigUInt64LE(48), 'Central directory offset');
    } else if (needs64) {
      throw new ZipError('zip_invalid', 'The archive needs Zip64 records it does not have');
    }
  }
  if (directorySize > DIRECTORY_MAX) throw new ZipError('zip_too_many_files', 'The archive lists too many entries');
  if (directoryOffset + directorySize > fileSize) throw new ZipError('zip_invalid', 'The central directory is out of range');
  return { entries, directorySize, directoryOffset };
}

/** The Zip64 extra field: 8-byte replacements for whichever classic fields were saturated, in a fixed order. */
function readZip64Extra(extra: Buffer, sizes: { size: number; compressedSize: number; headerOffset: number }): void {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    const body = extra.subarray(at + 4, at + 4 + length);
    if (id === 0x0001) {
      let cursor = 0;
      const next = (what: string): number => {
        if (cursor + 8 > body.length) throw new ZipError('zip_invalid', 'The Zip64 extra field is truncated');
        const value = safeNumber(body.readBigUInt64LE(cursor), what);
        cursor += 8;
        return value;
      };
      if (sizes.size === 0xffffffff) sizes.size = next('Entry size');
      if (sizes.compressedSize === 0xffffffff) sizes.compressedSize = next('Compressed size');
      if (sizes.headerOffset === 0xffffffff) sizes.headerOffset = next('Header offset');
      return;
    }
    at += 4 + length;
  }
}

/** Parse the central directory: every entry with its normalized path and what kind of thing it is. */
export async function readZipDirectory(path: string): Promise<ZipEntry[]> {
  const handle = await open(path, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    const end = await readEndRecord(handle, fileSize);
    const directory = await readAt(handle, end.directoryOffset, end.directorySize);
    const entries: ZipEntry[] = [];
    let at = 0;
    while (at + 46 <= directory.length && entries.length < end.entries) {
      if (directory.readUInt32LE(at) !== SIG_CENTRAL) throw new ZipError('zip_invalid', 'The central directory is corrupt');
      const madeBy = directory.readUInt16LE(at + 4) >>> 8;
      const flags = directory.readUInt16LE(at + 8);
      const method = directory.readUInt16LE(at + 10);
      const crc = directory.readUInt32LE(at + 16);
      const sizes = { compressedSize: directory.readUInt32LE(at + 20), size: directory.readUInt32LE(at + 24), headerOffset: directory.readUInt32LE(at + 42) };
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const externalAttributes = directory.readUInt32LE(at + 38);
      const nameStart = at + 46;
      if (nameStart + nameLength + extraLength + commentLength > directory.length) throw new ZipError('zip_invalid', 'The central directory is truncated');
      const rawName = directory.toString('utf8', nameStart, nameStart + nameLength);
      readZip64Extra(directory.subarray(nameStart + nameLength, nameStart + nameLength + extraLength), sizes);
      at = nameStart + nameLength + extraLength + commentLength;

      if ((flags & 0x0001) !== 0) throw new ZipError('zip_unsupported', `${rawName} is encrypted`);
      const { path: entryPath, isDirectory: slashDirectory } = safeEntryPath(rawName);
      // Unix attributes (made-by host 3) carry a mode in the high half; MS-DOS attributes mark directories with bit 4.
      const unixMode = madeBy === 3 && externalAttributes >>> 16 !== 0 ? externalAttributes >>> 16 : null;
      // Some writers record permission bits without a file type; those still count as regular files.
      const type = unixMode === null ? null : unixMode & S_IFMT;
      const mode = unixMode !== null && (type === 0 || type === S_IFREG || type === S_IFDIR || type === S_IFLNK) ? unixMode : null;
      const isDirectory = slashDirectory || type === S_IFDIR || ((externalAttributes & 0x10) !== 0 && (type === null || type === 0));
      const isSymlink = type === S_IFLNK;
      if (!isDirectory && !isSymlink && method !== 0 && method !== 8) throw new ZipError('zip_unsupported', `${rawName} uses an unsupported compression method (${method})`);
      if (sizes.headerOffset + 30 > fileSize) throw new ZipError('zip_invalid', `${rawName} points outside the file`);
      entries.push({
        path: entryPath,
        rawName,
        method,
        crc,
        compressedSize: sizes.compressedSize,
        size: sizes.size,
        headerOffset: sizes.headerOffset,
        mode,
        isDirectory,
        isSymlink,
        isSystemFile: entryPath.length > 0 && isSystemPath(entryPath),
      });
    }
    if (entries.length !== end.entries) throw new ZipError('zip_invalid', 'The central directory is incomplete');
    return entries;
  } finally {
    await handle.close();
  }
}

/** What extracting would produce. */
export function summarizeZip(entries: ZipEntry[]): ZipSummary {
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.isSymlink || entry.isSystemFile) {
      skipped += 1;
      continue;
    }
    files += 1;
    bytes += entry.size;
  }
  return { files, bytes, skipped };
}

/** Enforce the platform's bounds on a parsed archive. */
export function checkZipLimits(summary: ZipSummary, options: ExtractOptions): void {
  if (summary.files === 0) throw new ZipError('zip_empty', 'The archive has no files');
  if (summary.files > options.maxFiles) throw new ZipError('zip_too_many_files', `The archive has ${summary.files} files; at most ${options.maxFiles} are allowed`);
  if (summary.bytes > options.maxBytes) throw new ZipError('zip_too_big', `The archive unpacks to ${summary.bytes} bytes; at most ${options.maxBytes} are allowed`);
}

async function dataOffset(handle: FileHandle, entry: ZipEntry): Promise<number> {
  const header = await readAt(handle, entry.headerOffset, 30);
  if (header.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError('zip_invalid', `${entry.rawName}: local header is corrupt`);
  return entry.headerOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
}

function verify(entry: ZipEntry, size: number, crc: number): void {
  if (size !== entry.size) throw new ZipError('zip_invalid', `${entry.rawName}: size does not match the archive's directory`);
  if (crc !== entry.crc) throw new ZipError('zip_invalid', `${entry.rawName}: checksum mismatch`);
}

function fileMode(entry: ZipEntry): number {
  return entry.mode !== null && (entry.mode & 0o111) !== 0 ? 0o755 : 0o644;
}

/** Inflate a small entry in memory; zlib stops at the declared size, so a lying header cannot fill the disk. */
async function extractBuffered(handle: FileHandle, entry: ZipEntry, start: number, destination: string): Promise<void> {
  const raw = await readAt(handle, start, entry.compressedSize);
  let data: Buffer;
  if (entry.method === 0) data = raw;
  else {
    try {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
    } catch (error) {
      throw new ZipError('zip_invalid', `${entry.rawName}: could not inflate (${(error as Error).message})`);
    }
  }
  verify(entry, data.length, crc32(data));
  await writeFile(destination, data, { mode: fileMode(entry) });
}

/** Stream a large entry through zlib, counting and checksumming on the way; one byte past the declared size is an error. */
async function extractStreamed(path: string, entry: ZipEntry, start: number, destination: string): Promise<void> {
  let size = 0;
  let crc = 0;
  const limit = entry.size;
  const check = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > limit) {
        callback(new ZipError('zip_invalid', `${entry.rawName}: larger than the archive's directory says`));
        return;
      }
      crc = crc32(chunk, crc);
      callback(null, chunk);
    },
  });
  const source = createReadStream(path, { start, end: start + entry.compressedSize - 1 });
  const sink = createWriteStream(destination, { mode: fileMode(entry) });
  try {
    if (entry.method === 0) await pipeline(source, check, sink);
    else await pipeline(source, createInflateRaw(), check, sink);
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError('zip_invalid', `${entry.rawName}: could not inflate (${(error as Error).message})`);
  }
  verify(entry, size, crc);
}

/**
 * Extract an archive into `destination` (created if needed). Returns what
 * was written. Symlinks and system files are skipped, never created; the
 * bounds are checked against the directory before a byte is written.
 */
export async function extractZip(path: string, destination: string, options: ExtractOptions): Promise<ZipSummary> {
  const entries = await readZipDirectory(path);
  const summary = summarizeZip(entries);
  checkZipLimits(summary, options);
  await mkdir(destination, { recursive: true });
  const root = destination.endsWith(sep) ? destination : destination + sep;
  const handle = await open(path, 'r');
  try {
    for (const entry of entries) {
      if (entry.isSymlink || entry.isSystemFile || entry.path.length === 0) continue;
      const target = join(destination, ...entry.path.split('/'));
      if (!target.startsWith(root)) throw new ZipError('zip_unsafe_path', `Path escapes the archive: ${entry.rawName}`);
      if (entry.isDirectory) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      const start = await dataOffset(handle, entry);
      if (entry.compressedSize <= SYNC_INFLATE_MAX) await extractBuffered(handle, entry, start, target);
      else await extractStreamed(path, entry, start, target);
    }
  } finally {
    await handle.close();
  }
  return summary;
}
