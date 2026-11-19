/**
 * The zip reader against archives the shared writer makes — and against
 * hand-mangled ones: Zip64 end records, hostile paths, symlinks, system
 * files, lying sizes and bad checksums.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { concatZip, crc32, createZip, type ZipFile } from '@ploy/shared';
import { unpackUpload } from '../deploy/uploads.ts';
import { extractZip, readZipDirectory, safeEntryPath, summarizeZip, ZipError } from './zip.ts';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

async function archive(dir: string, name: string, files: ZipFile[], options: { compress?: boolean } = {}): Promise<string> {
  const path = join(dir, name);
  writeFileSync(path, concatZip(await createZip(files, options)));
  return path;
}

/** Rewrite the end record of a classic archive as a Zip64 one (locator + 64-bit record + saturated classic fields). */
function toZip64(buffer: Buffer): Buffer {
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  const entries = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(entries), 24);
  record.writeBigUInt64LE(BigInt(entries), 32);
  record.writeBigUInt64LE(BigInt(directorySize), 40);
  record.writeBigUInt64LE(BigInt(directoryOffset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(end), 8);
  locator.writeUInt32LE(1, 16);
  const classic = Buffer.from(buffer.subarray(end));
  classic.writeUInt16LE(0xffff, 8);
  classic.writeUInt16LE(0xffff, 10);
  classic.writeUInt32LE(0xffffffff, 12);
  classic.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([buffer.subarray(0, end), record, locator, classic]);
}

test('crc32 matches the reference values and continues across chunks', () => {
  assert.equal(crc32(text('')), 0);
  assert.equal(crc32(text('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  assert.equal(crc32(text('123456789')), 0xcbf43926);
  const whole = crc32(text('hello, world'));
  assert.equal(crc32(text(' world'), crc32(text('hello,'))), whole);
});

test('the writer makes archives the reader extracts byte for byte, with modes, nested folders and UTF-8 names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-zip-'));
  try {
    const big = new Uint8Array(300_000);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
    const files: ZipFile[] = [
      { path: 'index.html', data: text('<h1>Salom</h1>') },
      { path: 'css/style.css', data: text('body { margin: 0 }'.repeat(50)) },
      { path: 'bin/run.sh', data: text('#!/bin/sh\necho ok\n'), mode: 0o755 },
      { path: 'assets/ðŸ“ Tashkent/kecha.txt', data: text('ok') },
      { path: 'data/big.bin', data: big },
      { path: 'empty.txt', data: new Uint8Array(0) },
    ];
    for (const compress of [true, false]) {
      const path = await archive(dir, `site-${compress}.zip`, files, { compress });
      const entries = await readZipDirectory(path);
      assert.deepEqual(entries.map((entry) => entry.path), files.map((file) => file.path));
      assert.equal(entries.find((entry) => entry.path === 'css/style.css')!.method, compress ? 8 : 0, 'repetitive text deflates when allowed');
      assert.equal(entries.find((entry) => entry.path === 'empty.txt')!.method, 0, 'tiny entries are stored');
      assert.deepEqual(summarizeZip(entries), { files: 6, bytes: files.reduce((sum, file) => sum + file.data.length, 0), skipped: 0 });

      const out = join(dir, `out-${compress}`);
      const summary = await extractZip(path, out, { maxFiles: 100, maxBytes: 10_000_000 });
      assert.equal(summary.files, 6);
      for (const file of files) assert.deepEqual(new Uint8Array(readFileSync(join(out, file.path))), file.data, file.path);
      assert.equal(statSync(join(out, 'bin/run.sh')).mode & 0o777, 0o755);
      assert.equal(statSync(join(out, 'index.html')).mode & 0o777, 0o644);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('large entries stream through zlib and are checked the same way', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-zip-'));
  try {
    // Above the in-memory threshold once compressed: incompressible bytes.
    const data = new Uint8Array(9 * 1024 * 1024);
    let seed = 7;
    for (let i = 0; i < data.length; i += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      data[i] = seed >>> 24;
    }
    const path = await archive(dir, 'big.zip', [{ path: 'blob.bin', data }], { compress: false });
    const out = join(dir, 'out');
    await extractZip(path, out, { maxFiles: 10, maxBytes: 20 * 1024 * 1024 });
    assert.equal(crc32(new Uint8Array(readFileSync(join(out, 'blob.bin')))), crc32(data));

    // Flip a byte in the middle of the data: the streamed CRC catches it.
    const corrupt = readFileSync(path);
    corrupt[1_000_000] = corrupt[1_000_000]! ^ 0xff;
    writeFileSync(join(dir, 'corrupt.zip'), corrupt);
    await assert.rejects(extractZip(join(dir, 'corrupt.zip'), join(dir, 'out2'), { maxFiles: 10, maxBytes: 20 * 1024 * 1024 }), (error: unknown) => error instanceof ZipError && error.reason === 'zip_invalid' && /checksum/.test(error.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Zip64 end records are followed; the classic fields may be saturated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-zip-'));
  try {
    const files: ZipFile[] = [{ path: 'a.txt', data: text('a') }, { path: 'b/c.txt', data: text('c') }];
    const classic = concatZip(await createZip(files));
    const path = join(dir, 'zip64.zip');
    writeFileSync(path, toZip64(Buffer.from(classic)));
    const entries = await readZipDirectory(path);
    assert.deepEqual(entries.map((entry) => entry.path), ['a.txt', 'b/c.txt']);
    await extractZip(path, join(dir, 'out'), { maxFiles: 10, maxBytes: 1000 });
    assert.equal(readFileSync(join(dir, 'out/b/c.txt'), 'utf8'), 'c');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paths are normalized and anything that could leave the destination is refused', () => {
  assert.deepEqual(safeEntryPath('site/index.html'), { path: 'site/index.html', isDirectory: false });
  assert.deepEqual(safeEntryPath('./site//css/'), { path: 'site/css', isDirectory: true });
  assert.deepEqual(safeEntryPath('/abs/file'), { path: 'abs/file', isDirectory: false });
  assert.deepEqual(safeEntryPath('win\\style\\path.txt'), { path: 'win/style/path.txt', isDirectory: false });
  for (const bad of ['../etc/passwd', 'a/../../b', 'C:\\Windows\\x', 'nul\0byte', 'x'.repeat(1025)]) {
    assert.throws(() => safeEntryPath(bad), (error: unknown) => error instanceof ZipError && error.reason === 'zip_unsafe_path', bad);
  }
});

test('symlinks and system files are skipped, directories made, and a hostile archive extracts nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-zip-'));
  try {
    const path = await archive(dir, 'mixed.zip', [
      { path: 'site/index.html', data: text('hi') },
      { path: 'site/link', data: text('../../etc/passwd'), mode: 0o120777 },
      { path: '__MACOSX/site/._index.html', data: text('fork') },
      { path: 'site/.DS_Store', data: text('finder') },
      { path: 'site/images/.keep', data: new Uint8Array(0) },
    ]);
    const entries = await readZipDirectory(path);
    assert.equal(entries.find((entry) => entry.path === 'site/link')!.isSymlink, true);
    assert.deepEqual(summarizeZip(entries), { files: 2, bytes: 2, skipped: 3 }, "the symlink, the resource fork and .DS_Store are skipped");
    const out = join(dir, 'out');
    await extractZip(path, out, { maxFiles: 10, maxBytes: 1000 });
    assert.deepEqual(readdirSync(out).sort(), ['site']);
    assert.deepEqual(readdirSync(join(out, 'site')).sort(), ['images', 'index.html']);

    const hostile = await archive(dir, 'hostile.zip', [{ path: 'ok.txt', data: text('ok') }, { path: '../escape.txt', data: text('no') }]);
    await assert.rejects(extractZip(hostile, join(dir, 'out2'), { maxFiles: 10, maxBytes: 1000 }), (error: unknown) => error instanceof ZipError && error.reason === 'zip_unsafe_path');
    assert.equal(statSync(join(dir, 'out2'), { throwIfNoEntry: false }), undefined, 'nothing is written before the directory is checked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bounds: empty, too many files, too big, lying sizes, and files that are not archives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-zip-'));
  try {
    const one = await archive(dir, 'one.zip', [{ path: 'a.txt', data: text('a'.repeat(100)) }]);
    const limits = (maxFiles: number, maxBytes: number) => ({ maxFiles, maxBytes });
    await assert.rejects(extractZip(one, join(dir, 'o1'), limits(0, 1000)), (error: unknown) => error instanceof ZipError && error.reason === 'zip_too_many_files');
    await assert.rejects(extractZip(one, join(dir, 'o2'), limits(10, 50)), (error: unknown) => error instanceof ZipError && error.reason === 'zip_too_big');
    const empty = await archive(dir, 'empty.zip', [{ path: 'only/.DS_Store', data: text('x') }]);
    await assert.rejects(extractZip(empty, join(dir, 'o3'), limits(10, 1000)), (error: unknown) => error instanceof ZipError && error.reason === 'zip_empty');

    // A directory that claims a smaller size than the data inflates to: refused, not written.
    const lying = readFileSync(one);
    const end = lying.length - 22;
    const directoryOffset = lying.readUInt32LE(end + 16);
    lying.writeUInt32LE(10, directoryOffset + 24); // uncompressed size
    writeFileSync(join(dir, 'lying.zip'), lying);
    await assert.rejects(extractZip(join(dir, 'lying.zip'), join(dir, 'o4'), limits(10, 1000)), (error: unknown) => error instanceof ZipError && error.reason === 'zip_invalid');

    writeFileSync(join(dir, 'not.zip'), 'PK but not really a zip file at all, just text');
    await assert.rejects(readZipDirectory(join(dir, 'not.zip')), (error: unknown) => error instanceof ZipError && error.reason === 'zip_invalid');
    writeFileSync(join(dir, 'tiny.zip'), 'PK');
    await assert.rejects(readZipDirectory(join(dir, 'tiny.zip')), (error: unknown) => error instanceof ZipError && error.reason === 'zip_invalid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unpackUpload unwraps a single top-level folder, even one holding a namesake', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-zip-'));
  try {
    const wrapped = await archive(dir, 'wrapped.zip', [
      { path: 'site/index.html', data: text('root') },
      { path: 'site/site/index.html', data: text('nested') },
      { path: 'site/css/a.css', data: text('a') },
    ]);
    const out = join(dir, 'out');
    const result = await unpackUpload(wrapped, out);
    assert.equal(result.unwrapped, 'site');
    assert.deepEqual(readdirSync(out).sort(), ['css', 'index.html', 'site']);
    assert.equal(readFileSync(join(out, 'index.html'), 'utf8'), 'root');
    assert.equal(readFileSync(join(out, 'site/index.html'), 'utf8'), 'nested');

    const flat = await archive(dir, 'flat.zip', [{ path: 'index.html', data: text('x') }, { path: 'about.html', data: text('y') }]);
    const out2 = join(dir, 'out2');
    assert.equal((await unpackUpload(flat, out2)).unwrapped, null);
    assert.deepEqual(readdirSync(out2).sort(), ['about.html', 'index.html']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
