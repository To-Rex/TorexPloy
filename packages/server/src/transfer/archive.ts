/**
 * The `.torexploy` archive: a project's export, encrypted with a passphrase.
 *
 * Layout:
 *
 *   "TOREXPLOY\0" · format version (1 byte) · header length (u32) · header (JSON)
 *   chunk*: plaintext length (u32) · flags (1 byte, bit 0: the last chunk) · ciphertext · GCM tag (16 bytes)
 *
 * The header is plaintext but says nothing about the project: only how to
 * derive the key (scrypt, its salt and cost) and the cipher's nonce prefix.
 * Every chunk is AES-256-GCM with a nonce of that prefix and the chunk's
 * index, and authenticates the header's hash, its index and its flags: a
 * header that was edited, chunks that were reordered, dropped, or cut off
 * after the last one all fail to open. Only the last chunk carries the flag,
 * so an archive that ends early is told from one that is whole.
 *
 * Inside, the plaintext is a run of frames: a type (1 byte), a length (u32)
 * and a JSON payload. An entry frame names a file and its size, and exactly
 * that many bytes follow it; an end frame closes the archive. The first entry
 * is always `manifest.json`, so a quick look reads one chunk or two.
 *
 * Nothing is held in memory beyond one chunk: entries stream in from Docker
 * and the file stores, and stream out into them, at any size.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { open, rm, stat, type FileHandle } from 'node:fs/promises';
import { AppError } from '../lib/errors.ts';

export const MAGIC = Buffer.from('TOREXPLOY\0', 'latin1');
export const ARCHIVE_VERSION = 1;
const HEADER_MAX = 64 * 1024;
export const CHUNK_SIZE = 1024 * 1024;
const TAG_BYTES = 16;
const NONCE_PREFIX_BYTES = 8;
const FINAL = 0x01;

const FRAME_ENTRY = 1;
const FRAME_END = 2;
/** A frame's JSON (an entry's name and details) is small; anything bigger is not an archive of ours. */
const FRAME_MAX = 1024 * 1024;

/** scrypt at N=2^16, r=8: 64 MiB and a fraction of a second, once per archive. */
const KDF_DEFAULT = { n: 1 << 16, r: 8, p: 1 };
/** Costs an archive may ask for when it is opened: at most 128 MiB, so a crafted header cannot exhaust the panel. */
const KDF_LIMITS = { n: 1 << 17, r: 8, p: 4 };

export const MANIFEST_PATH = 'manifest.json';

export type ArchiveErrorReason = 'not_archive' | 'unsupported_version' | 'wrong_passphrase' | 'corrupt' | 'truncated';

export class ArchiveError extends AppError {
  constructor(reason: ArchiveErrorReason, message: string) {
    super('bad_request', message, { params: { reason } });
  }
}

interface ArchiveHeader {
  format: 'torexploy';
  version: number;
  createdAt: string;
  panelVersion: string;
  kdf: { name: 'scrypt'; n: number; r: number; p: number; salt: string };
  cipher: { name: 'aes-256-gcm'; nonce: string; chunkSize: number };
  /** Tells a wrong passphrase from a damaged archive before anything is decrypted. */
  check: string;
}

export interface EntryHeader {
  path: string;
  size: number;
  /** What the reader needs to put the bytes back (content type, the resource they belong to). */
  meta?: Record<string, unknown>;
}

function scrypt(passphrase: string, salt: Buffer, params: { n: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { N: params.n, r: params.r, p: params.p, maxmem: 256 * params.n * params.r + 32 * 1024 * 1024 };
  return new Promise((resolve, reject) => {
    scryptCallback(passphrase.normalize('NFKC'), salt, 64, options, (error, key) => (error === null ? resolve(key) : reject(error)));
  });
}

interface Keys {
  cipher: Buffer;
  check: Buffer;
}

async function deriveKeys(passphrase: string, salt: Buffer, params: { n: number; r: number; p: number }): Promise<Keys> {
  const material = await scrypt(passphrase, salt, params);
  const cipher = Buffer.from(material.subarray(0, 32));
  const check = createHmac('sha256', material.subarray(32)).update('torexploy:passphrase').digest().subarray(0, 16);
  material.fill(0);
  return { cipher, check };
}

function aad(headerHash: Buffer, index: number, flags: number): Buffer {
  const out = Buffer.alloc(headerHash.length + 9);
  headerHash.copy(out, 0);
  out.writeBigUInt64BE(BigInt(index), headerHash.length);
  out.writeUInt8(flags, headerHash.length + 8);
  return out;
}

function nonceFor(prefix: Buffer, index: number): Buffer {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, NONCE_PREFIX_BYTES);
  return nonce;
}

/** Bytes of one source, whatever shape it comes in. */
async function* bytesOf(source: Buffer | Uint8Array | AsyncIterable<Buffer | Uint8Array | string>): AsyncGenerator<Buffer> {
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    yield Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    return;
  }
  for await (const chunk of source) yield typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

// ---------------------------------------------------------------- writing

export class ArchiveWriter {
  readonly path: string;
  private readonly handle: FileHandle;
  private readonly key: Buffer;
  private readonly noncePrefix: Buffer;
  private readonly headerHash: Buffer;
  private readonly plain = Buffer.allocUnsafe(CHUNK_SIZE);
  private filled = 0;
  private index = 0;
  private entries = 0;
  private closed = false;
  /** Bytes on disk so far. */
  written = 0;

  private constructor(path: string, handle: FileHandle, key: Buffer, noncePrefix: Buffer, headerHash: Buffer, headerBytes: number) {
    this.path = path;
    this.handle = handle;
    this.key = key;
    this.noncePrefix = noncePrefix;
    this.headerHash = headerHash;
    this.written = headerBytes;
  }

  /** Start an archive at `path` (which must not exist), encrypted with `passphrase`. */
  static async create(path: string, passphrase: string, info: { panelVersion: string; createdAt?: string }): Promise<ArchiveWriter> {
    const salt = randomBytes(16);
    const noncePrefix = randomBytes(NONCE_PREFIX_BYTES);
    const keys = await deriveKeys(passphrase, salt, KDF_DEFAULT);
    const header: ArchiveHeader = {
      format: 'torexploy',
      version: ARCHIVE_VERSION,
      createdAt: info.createdAt ?? new Date().toISOString(),
      panelVersion: info.panelVersion,
      kdf: { name: 'scrypt', ...KDF_DEFAULT, salt: salt.toString('base64') },
      cipher: { name: 'aes-256-gcm', nonce: noncePrefix.toString('base64'), chunkSize: CHUNK_SIZE },
      check: keys.check.toString('base64'),
    };
    const json = Buffer.from(JSON.stringify(header), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.length);
    const head = Buffer.concat([MAGIC, Buffer.from([ARCHIVE_VERSION]), length, json]);
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.write(head);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(path, { force: true });
      throw error;
    }
    return new ArchiveWriter(path, handle, keys.cipher, noncePrefix, createHash('sha256').update(head).digest(), head.length);
  }

  private async seal(final: boolean): Promise<void> {
    const flags = final ? FINAL : 0;
    const cipher = createCipheriv('aes-256-gcm', this.key, nonceFor(this.noncePrefix, this.index));
    cipher.setAAD(aad(this.headerHash, this.index, flags));
    const body = Buffer.concat([cipher.update(this.plain.subarray(0, this.filled)), cipher.final()]);
    const prefix = Buffer.alloc(5);
    prefix.writeUInt32BE(this.filled, 0);
    prefix.writeUInt8(flags, 4);
    const record = Buffer.concat([prefix, body, cipher.getAuthTag()]);
    await this.handle.write(record);
    this.written += record.length;
    this.index += 1;
    this.filled = 0;
  }

  private async push(bytes: Buffer): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      // A full chunk is sealed only once more bytes follow, so the last one can carry the final flag.
      if (this.filled === CHUNK_SIZE) await this.seal(false);
      const take = Math.min(CHUNK_SIZE - this.filled, bytes.length - offset);
      bytes.copy(this.plain, this.filled, offset, offset + take);
      this.filled += take;
      offset += take;
    }
  }

  private async frame(type: number, payload: unknown): Promise<void> {
    const json = Buffer.from(JSON.stringify(payload), 'utf8');
    if (json.length > FRAME_MAX) throw new Error('An archive frame is too large');
    const head = Buffer.alloc(5);
    head.writeUInt8(type, 0);
    head.writeUInt32BE(json.length, 1);
    await this.push(Buffer.concat([head, json]));
  }

  /** Add a file of exactly `size` bytes. `onBytes` hears of each piece written (for progress). */
  async add(header: EntryHeader, source: Buffer | Uint8Array | AsyncIterable<Buffer | Uint8Array | string>, onBytes?: (bytes: number) => void): Promise<void> {
    if (this.closed) throw new Error('The archive is closed');
    if (!Number.isSafeInteger(header.size) || header.size < 0) throw new Error(`Invalid size for ${header.path}`);
    await this.frame(FRAME_ENTRY, header);
    let count = 0;
    for await (const chunk of bytesOf(source)) {
      count += chunk.length;
      if (count > header.size) throw new Error(`${header.path} grew while it was being archived`);
      await this.push(chunk);
      onBytes?.(chunk.length);
    }
    if (count !== header.size) throw new Error(`${header.path} ended after ${count} of ${header.size} bytes`);
    this.entries += 1;
  }

  async addJson(path: string, value: unknown): Promise<void> {
    const data = Buffer.from(JSON.stringify(value), 'utf8');
    await this.add({ path, size: data.length, meta: { type: 'application/json' } }, data);
  }

  /** Close the archive: the end frame, the last chunk, and the file flushed to disk. */
  async finish(): Promise<number> {
    if (this.closed) throw new Error('The archive is closed');
    await this.frame(FRAME_END, { entries: this.entries });
    await this.seal(true);
    this.closed = true;
    this.key.fill(0);
    await this.handle.sync();
    await this.handle.close();
    return this.written;
  }

  /** Give up: the half-written file is removed. */
  async abort(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.key.fill(0);
      await this.handle.close().catch(() => undefined);
    }
    await rm(this.path, { force: true });
  }
}

// ---------------------------------------------------------------- reading

/** The archive's plaintext header: readable without the passphrase. */
export interface ArchiveInfo {
  createdAt: string;
  panelVersion: string;
  size: number;
}

async function readExactly(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return done === length ? buffer : buffer.subarray(0, done);
}

async function readHeader(handle: FileHandle): Promise<{ header: ArchiveHeader; headerHash: Buffer; offset: number }> {
  const start = await readExactly(handle, 0, MAGIC.length + 5);
  if (start.length < MAGIC.length + 5 || !start.subarray(0, MAGIC.length).equals(MAGIC)) throw new ArchiveError('not_archive', 'This is not a TorexPloy export (.torexploy)');
  const version = start.readUInt8(MAGIC.length);
  if (version !== ARCHIVE_VERSION) throw new ArchiveError('unsupported_version', `This archive was made by a newer TorexPloy (format ${version}); update this panel first`);
  const length = start.readUInt32BE(MAGIC.length + 1);
  if (length === 0 || length > HEADER_MAX) throw new ArchiveError('corrupt', 'The archive header is damaged');
  const json = await readExactly(handle, start.length, length);
  if (json.length !== length) throw new ArchiveError('truncated', 'The archive ends before its header does');
  let header: ArchiveHeader;
  try {
    header = JSON.parse(json.toString('utf8')) as ArchiveHeader;
  } catch {
    throw new ArchiveError('corrupt', 'The archive header is damaged');
  }
  const { kdf, cipher } = header;
  const valid =
    header.format === 'torexploy' &&
    kdf?.name === 'scrypt' &&
    Number.isInteger(kdf.n) && kdf.n >= 1024 && kdf.n <= KDF_LIMITS.n && (kdf.n & (kdf.n - 1)) === 0 &&
    Number.isInteger(kdf.r) && kdf.r >= 1 && kdf.r <= KDF_LIMITS.r &&
    Number.isInteger(kdf.p) && kdf.p >= 1 && kdf.p <= KDF_LIMITS.p &&
    typeof kdf.salt === 'string' &&
    cipher?.name === 'aes-256-gcm' &&
    typeof cipher.nonce === 'string' && Buffer.from(cipher.nonce, 'base64').length === NONCE_PREFIX_BYTES &&
    Number.isInteger(cipher.chunkSize) && cipher.chunkSize >= 1024 && cipher.chunkSize <= 16 * CHUNK_SIZE &&
    typeof header.check === 'string';
  if (!valid) throw new ArchiveError('corrupt', 'The archive header is damaged or of an unknown kind');
  const head = Buffer.concat([start, json]);
  return { header, headerHash: createHash('sha256').update(head).digest(), offset: head.length };
}

/** What the header says, without the passphrase (and whether it is an archive at all). */
export async function inspectArchive(path: string): Promise<ArchiveInfo> {
  const handle = await open(path, 'r');
  try {
    const { header } = await readHeader(handle);
    const { size } = await handle.stat();
    return { createdAt: String(header.createdAt), panelVersion: String(header.panelVersion), size };
  } finally {
    await handle.close();
  }
}

/** Plaintext pieces of the archive in order, each checked, ending only where the archive says it ends. */
async function* plaintext(handle: FileHandle, offset: number, header: ArchiveHeader, headerHash: Buffer, key: Buffer, onRead: (position: number) => void): AsyncGenerator<Buffer> {
  const prefix = Buffer.from(header.cipher.nonce, 'base64');
  const { size } = await handle.stat();
  let position = offset;
  for (let index = 0; ; index += 1) {
    if (position >= size) throw new ArchiveError('truncated', 'The archive is incomplete: it ends before its last part (was the download or upload cut short?)');
    const head = await readExactly(handle, position, 5);
    if (head.length < 5) throw new ArchiveError('truncated', 'The archive is incomplete');
    const length = head.readUInt32BE(0);
    const flags = head.readUInt8(4);
    if (length > header.cipher.chunkSize || (flags & ~FINAL) !== 0) throw new ArchiveError('corrupt', 'The archive is damaged');
    const body = await readExactly(handle, position + 5, length + TAG_BYTES);
    if (body.length < length + TAG_BYTES) throw new ArchiveError('truncated', 'The archive is incomplete');
    const decipher = createDecipheriv('aes-256-gcm', key, nonceFor(prefix, index));
    decipher.setAAD(aad(headerHash, index, flags));
    decipher.setAuthTag(body.subarray(length));
    let plain: Buffer;
    try {
      plain = Buffer.concat([decipher.update(body.subarray(0, length)), decipher.final()]);
    } catch {
      throw new ArchiveError('corrupt', `The archive is damaged (part ${index + 1} does not check out)`);
    }
    position += 5 + length + TAG_BYTES;
    onRead(position);
    if (plain.length > 0) yield plain;
    if ((flags & FINAL) !== 0) {
      if (position !== size) throw new ArchiveError('corrupt', 'The archive has data after its end');
      return;
    }
  }
}

/** Exact reads over the plaintext pieces. */
class PlainReader {
  private readonly source: AsyncGenerator<Buffer>;
  private current: Buffer = Buffer.alloc(0);
  private offset = 0;

  constructor(source: AsyncGenerator<Buffer>) {
    this.source = source;
  }

  private async fill(): Promise<boolean> {
    while (this.offset >= this.current.length) {
      const next = await this.source.next();
      if (next.done === true) return false;
      this.current = next.value;
      this.offset = 0;
    }
    return true;
  }

  async exact(length: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let need = length;
    while (need > 0) {
      if (!(await this.fill())) throw new ArchiveError('truncated', 'The archive ends in the middle of a file');
      const take = Math.min(need, this.current.length - this.offset);
      parts.push(this.current.subarray(this.offset, this.offset + take));
      this.offset += take;
      need -= take;
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
  }

  /** Up to `max` bytes as they come (at most one piece). */
  async some(max: number): Promise<Buffer> {
    if (!(await this.fill())) throw new ArchiveError('truncated', 'The archive ends in the middle of a file');
    const take = Math.min(max, this.current.length - this.offset);
    const out = this.current.subarray(this.offset, this.offset + take);
    this.offset += take;
    return out;
  }

  /** Nothing may follow the end frame. */
  async atEnd(): Promise<boolean> {
    return !(await this.fill());
  }
}

export interface ArchiveEntry extends EntryHeader {
  /** The bytes; read them once, before asking for the next entry (whatever is left unread is skipped). */
  body: AsyncIterable<Buffer>;
}

export class ArchiveReader {
  readonly info: ArchiveInfo;
  private readonly handle: FileHandle;
  private readonly reader: PlainReader;
  /** How far into the file reading has got, for progress. */
  position = 0;
  private closed = false;

  private constructor(info: ArchiveInfo, handle: FileHandle, reader: PlainReader) {
    this.info = info;
    this.handle = handle;
    this.reader = reader;
  }

  /** Open an archive with its passphrase; a wrong one is told apart from a damaged archive. */
  static async open(path: string, passphrase: string): Promise<ArchiveReader> {
    const handle = await open(path, 'r');
    try {
      const { header, headerHash, offset } = await readHeader(handle);
      const keys = await deriveKeys(passphrase, Buffer.from(header.kdf.salt, 'base64'), header.kdf);
      const expected = Buffer.from(header.check, 'base64');
      if (expected.length !== keys.check.length || !timingSafeEqual(expected, keys.check)) throw new ArchiveError('wrong_passphrase', 'The passphrase does not open this archive');
      const { size } = await handle.stat();
      const info: ArchiveInfo = { createdAt: String(header.createdAt), panelVersion: String(header.panelVersion), size };
      let archive: ArchiveReader | null = null;
      const source = plaintext(handle, offset, header, headerHash, keys.cipher, (position) => {
        if (archive !== null) archive.position = position;
      });
      archive = new ArchiveReader(info, handle, new PlainReader(source));
      archive.position = offset;
      return archive;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  /** The entries in order. The archive is checked to its very end when the last one has been read. */
  async *entries(): AsyncGenerator<ArchiveEntry> {
    for (;;) {
      const head = await this.reader.exact(5);
      const type = head.readUInt8(0);
      const length = head.readUInt32BE(1);
      if (length > FRAME_MAX) throw new ArchiveError('corrupt', 'The archive is damaged');
      let payload: unknown;
      try {
        payload = JSON.parse((await this.reader.exact(length)).toString('utf8'));
      } catch (error) {
        if (error instanceof ArchiveError) throw error;
        throw new ArchiveError('corrupt', 'The archive is damaged');
      }
      if (type === FRAME_END) {
        if (!(await this.reader.atEnd())) throw new ArchiveError('corrupt', 'The archive has data after its end');
        return;
      }
      const header = payload as EntryHeader;
      if (type !== FRAME_ENTRY || typeof header?.path !== 'string' || !Number.isSafeInteger(header.size) || header.size < 0) throw new ArchiveError('corrupt', 'The archive is damaged');
      let left = header.size;
      const reader = this.reader;
      const body = (async function* read(): AsyncGenerator<Buffer> {
        while (left > 0) {
          const piece = await reader.some(Math.min(left, CHUNK_SIZE));
          left -= piece.length;
          yield piece;
        }
      })();
      yield { path: header.path, size: header.size, ...(header.meta === undefined ? {} : { meta: header.meta }), body };
      // Whatever the consumer left unread is skipped, so the next frame starts where it should.
      while (left > 0) left -= (await reader.some(Math.min(left, CHUNK_SIZE))).length;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close().catch(() => undefined);
  }
}

/** Read the first entry (the manifest) as JSON. */
export async function readManifest(path: string, passphrase: string, maxBytes = 32 * 1024 * 1024): Promise<{ info: ArchiveInfo; manifest: unknown }> {
  const archive = await ArchiveReader.open(path, passphrase);
  try {
    for await (const entry of archive.entries()) {
      if (entry.path !== MANIFEST_PATH || entry.size > maxBytes) throw new ArchiveError('corrupt', 'The archive does not start with its manifest');
      const parts: Buffer[] = [];
      for await (const piece of entry.body) parts.push(piece);
      try {
        return { info: archive.info, manifest: JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown };
      } catch {
        throw new ArchiveError('corrupt', 'The archive manifest is damaged');
      }
    }
    throw new ArchiveError('corrupt', 'The archive is empty');
  } finally {
    await archive.close();
  }
}

/** Read the whole archive and check every part, without unpacking anything. */
export async function verifyArchive(path: string, passphrase: string, onProgress?: (position: number, size: number) => void, signal?: AbortSignal): Promise<{ entries: number }> {
  const archive = await ArchiveReader.open(path, passphrase);
  let entries = 0;
  let last = 0;
  try {
    for await (const entry of archive.entries()) {
      for await (const piece of entry.body) {
        void piece;
        if (archive.position - last > 8 * CHUNK_SIZE) {
          last = archive.position;
          onProgress?.(archive.position, archive.info.size);
          signal?.throwIfAborted();
        }
      }
      entries += 1;
    }
    onProgress?.(archive.info.size, archive.info.size);
    return { entries };
  } finally {
    await archive.close();
  }
}

/** A passphrase the panel makes: 25 characters in five groups, about 124 bits, nothing that reads alike. */
export function generatePassphrase(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const groups: string[] = [];
  let group = '';
  while (groups.length < 5) {
    for (const byte of randomBytes(32)) {
      // 248 is the largest multiple of 31 below 256: no bias.
      if (byte >= 248) continue;
      group += alphabet[byte % 31];
      if (group.length === 5) {
        groups.push(group);
        group = '';
        if (groups.length === 5) break;
      }
    }
  }
  return groups.join('-');
}

export async function archiveSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
