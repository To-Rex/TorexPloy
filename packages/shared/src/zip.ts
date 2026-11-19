/**
 * Zip archives, the little the platform needs of them.
 *
 * The dashboard packs a dropped folder into a zip before uploading it, so the
 * control plane receives one file whichever way a site was handed over (a
 * folder, a `.zip` from the file manager, `curl` from CI). This writer builds
 * a plain, widely readable archive: deflate through the platform's
 * `CompressionStream` where that helps, stored otherwise; UTF-8 names; Unix
 * permission bits in the external attributes. The control plane reads
 * archives with its own reader (`lib/zip.ts` in the server) and shares the
 * CRC-32 below with it.
 *
 * Zip64 is deliberately absent: the platform caps uploads far below 4 GB and
 * 65 535 entries, and keeping to the classic format means every tool can
 * open what the dashboard made.
 */

export interface ZipFile {
  /** Path inside the archive, forward slashes, relative. */
  path: string;
  data: Uint8Array;
  /** Unix permission bits (`0o644`, `0o755`), marked as a regular file unless the value already carries a file type. */
  mode?: number;
  mtime?: Date;
}

export interface ZipWriteOptions {
  /** Deflate entries when the platform can; false stores everything (fast, larger). */
  compress?: boolean;
  /** Called after each entry with how many are done. */
  onProgress?: (done: number, total: number) => void;
}

/** The classic format's bounds; an archive beyond them would need Zip64. */
export const ZIP_MAX_ENTRIES = 65_535;
export const ZIP_MAX_BYTES = 0xffff_ffff;

/** Deflated entries that would grow are stored instead; tiny ones are never worth deflating. */
const DEFLATE_MIN_BYTES = 64;

let crcTable: Int32Array | null = null;

function table(): Int32Array {
  if (crcTable !== null) return crcTable;
  const built = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    built[n] = c;
  }
  crcTable = built;
  return built;
}

/** CRC-32 (IEEE 802.3, as zip and gzip use it). Pass the previous value as `seed` to continue over several chunks. */
export function crc32(data: Uint8Array, seed = 0): number {
  const t = table();
  let crc = seed ^ 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = t[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, the only timestamp the classic format carries (2-second resolution, 1980–2107). */
export function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  const dos = {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | Math.max(1, date.getDate()),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
  };
  return dos;
}

type CompressionStreamLike = new (format: 'deflate-raw') => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

/** The platform's streaming compressor, or null where it is missing (very old browsers). */
export function deflateSupported(): boolean {
  return typeof (globalThis as { CompressionStream?: unknown }).CompressionStream === 'function';
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const Compression = (globalThis as { CompressionStream?: CompressionStreamLike }).CompressionStream!;
  // The cast keeps one source compiling against both the DOM and the Node typings of Blob.
  const stream = new Blob([data as unknown as ArrayBuffer]).stream().pipeThrough(new Compression('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

/**
 * Build an archive from in-memory files. The result is the archive in order
 * (entries, then the central directory and its end record) as separate
 * chunks, so a `Blob` can be made without one more copy of a large site.
 */
export async function createZip(files: ZipFile[], options: ZipWriteOptions = {}): Promise<Uint8Array[]> {
  if (files.length > ZIP_MAX_ENTRIES) throw new Error(`A zip archive holds at most ${ZIP_MAX_ENTRIES} entries`);
  const compress = options.compress ?? deflateSupported();
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const [index, file] of files.entries()) {
    const name = encoder.encode(file.path.replace(/\\/g, '/').replace(/^\/+/, ''));
    if (name.length === 0 || name.length > 0xffff) throw new Error(`Invalid path in archive: ${file.path}`);
    if (file.data.length >= ZIP_MAX_BYTES) throw new Error(`${file.path} is too large for a zip archive`);
    const crc = crc32(file.data);
    let method = 0;
    let payload = file.data;
    if (compress && file.data.length >= DEFLATE_MIN_BYTES) {
      const deflated = await deflateRaw(file.data);
      if (deflated.length < file.data.length) {
        method = 8;
        payload = deflated;
      }
    }
    const stamp = dosDateTime(file.mtime ?? new Date());
    const bits = file.mode ?? 0o644;
    const mode = (bits & 0o170000) !== 0 ? bits & 0o177777 : (bits & 0o7777) | 0o100000;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50);
    u16(lv, 4, 20);
    u16(lv, 6, 0x0800); // names are UTF-8
    u16(lv, 8, method);
    u16(lv, 10, stamp.time);
    u16(lv, 12, stamp.date);
    u32(lv, 14, crc);
    u32(lv, 18, payload.length);
    u32(lv, 22, file.data.length);
    u16(lv, 26, name.length);
    u16(lv, 28, 0);
    local.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const ev = new DataView(entry.buffer);
    u32(ev, 0, 0x02014b50);
    u16(ev, 4, 0x031e); // made on Unix (3) by version 3.0: the external attributes carry the mode
    u16(ev, 6, 20);
    u16(ev, 8, 0x0800);
    u16(ev, 10, method);
    u16(ev, 12, stamp.time);
    u16(ev, 14, stamp.date);
    u32(ev, 16, crc);
    u32(ev, 20, payload.length);
    u32(ev, 24, file.data.length);
    u16(ev, 28, name.length);
    u16(ev, 30, 0);
    u16(ev, 32, 0);
    u16(ev, 34, 0);
    u16(ev, 36, 0);
    u32(ev, 38, mode << 16);
    u32(ev, 42, offset);
    entry.set(name, 46);

    chunks.push(local, payload);
    central.push(entry);
    offset += local.length + payload.length;
    if (offset >= ZIP_MAX_BYTES) throw new Error('The archive is too large for the zip format');
    options.onProgress?.(index + 1, files.length);
  }

  const directorySize = central.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  u32(endView, 0, 0x06054b50);
  u16(endView, 4, 0);
  u16(endView, 6, 0);
  u16(endView, 8, files.length);
  u16(endView, 10, files.length);
  u32(endView, 12, directorySize);
  u32(endView, 16, offset);
  u16(endView, 20, 0);
  return [...chunks, ...central, end];
}

/** The chunks of {@link createZip} as one buffer (tests, small archives). */
export function concatZip(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
