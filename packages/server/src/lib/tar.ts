/**
 * Minimal POSIX ustar writer.
 *
 * Used to hand files to a container through the Engine API's archive endpoint
 * (proxy config, restore dumps). Only regular files are supported, which is
 * all the platform ever needs to upload.
 */

export interface TarEntry {
  /** Path inside the archive, relative, forward slashes. */
  name: string;
  content: Buffer | string;
  mode?: number;
}

const BLOCK = 512;

function writeOctal(header: Buffer, value: number, offset: number, length: number): void {
  // Field is NUL-terminated octal, left-padded with zeros.
  header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
}

function headerFor(name: string, size: number, mode: number, mtime: number): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    // ustar splits long paths into a 155-byte prefix and a 100-byte name at a slash.
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`Path too long for tar: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  header.write(base, 0, 100, 'utf8');
  writeOctal(header, mode, 100, 8);
  writeOctal(header, 0, 108, 8); // uid
  writeOctal(header, 0, 116, 8); // gid
  writeOctal(header, size, 124, 12);
  writeOctal(header, mtime, 136, 12);
  header.fill(' ', 148, 156); // checksum placeholder: spaces while summing
  header.write('0', 156, 1, 'ascii'); // regular file
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

export function createTar(entries: TarEntry[]): Buffer {
  const mtime = Math.floor(Date.now() / 1000);
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    parts.push(headerFor(entry.name.replace(/^\/+/, ''), content.length, entry.mode ?? 0o644, mtime));
    parts.push(content);
    const padding = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (padding > 0) parts.push(Buffer.alloc(padding, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/** Read the regular files out of a tar buffer (used for archives fetched from containers). */
export function readTar(buffer: Buffer): { name: string; content: Buffer }[] {
  const files: { name: string; content: Buffer }[] = [];
  let offset = 0;
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/s, '');
    const size = parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8);
    const type = header.toString('ascii', 156, 157);
    offset += BLOCK;
    if (type === '0' || type === '\0') {
      files.push({ name: prefix.length > 0 ? `${prefix}/${name}` : name, content: buffer.subarray(offset, offset + size) });
    }
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

/**
 * Stream a single file as a tar archive without buffering it (used to upload
 * multi-gigabyte database dumps into a container for restore).
 */
export function tarSingleFile(name: string, size: number, content: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  return (async function* generate() {
    yield headerFor(name.replace(/^\/+/, ''), size, 0o600, Math.floor(Date.now() / 1000));
    let written = 0;
    for await (const chunk of content) {
      written += chunk.length;
      yield chunk;
    }
    if (written !== size) throw new Error(`File size changed while archiving (${written} != ${size})`);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    yield Buffer.alloc(padding + BLOCK * 2, 0);
  })();
}
