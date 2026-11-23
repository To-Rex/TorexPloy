/**
 * The `.torexploy` container: what goes in comes out, at any size and across
 * chunk boundaries; a wrong passphrase, an edited byte, a truncated file and
 * reordered chunks are all caught.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveError, ArchiveReader, ArchiveWriter, CHUNK_SIZE, generatePassphrase, inspectArchive, MANIFEST_PATH, readManifest, verifyArchive } from './archive.ts';

const dir = mkdtempSync(join(tmpdir(), 'torexploy-archive-'));
const PASS = 'correct horse battery staple';

async function* pieces(data: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < data.length; offset += size) yield data.subarray(offset, offset + size);
}

async function build(name: string, files: { path: string; data: Buffer }[]): Promise<string> {
  const path = join(dir, name);
  const writer = await ArchiveWriter.create(path, PASS, { panelVersion: '0.0.0-test' });
  await writer.addJson(MANIFEST_PATH, { hello: 'world', files: files.map((file) => file.path) });
  for (const file of files) await writer.add({ path: file.path, size: file.data.length, meta: { kind: 'test' } }, pieces(file.data, 77_777));
  await writer.finish();
  return path;
}

async function readAll(path: string, passphrase = PASS): Promise<Map<string, Buffer>> {
  const archive = await ArchiveReader.open(path, passphrase);
  const out = new Map<string, Buffer>();
  try {
    for await (const entry of archive.entries()) {
      const parts: Buffer[] = [];
      for await (const piece of entry.body) parts.push(piece);
      out.set(entry.path, Buffer.concat(parts));
    }
  } finally {
    await archive.close();
  }
  return out;
}

test('entries come back exactly, across chunk boundaries', async () => {
  const big = randomBytes(CHUNK_SIZE * 2 + 12_345);
  const files = [
    { path: 'databases/a.dump', data: big },
    { path: 'empty', data: Buffer.alloc(0) },
    { path: 'exact', data: randomBytes(CHUNK_SIZE) },
    { path: 'small.txt', data: Buffer.from('hi') },
  ];
  const path = await build('roundtrip.torexploy', files);
  const read = await readAll(path);
  assert.deepEqual(JSON.parse(read.get(MANIFEST_PATH)!.toString()).hello, 'world');
  for (const file of files) assert.ok(read.get(file.path)!.equals(file.data), file.path);
  const { manifest } = await readManifest(path, PASS);
  assert.deepEqual((manifest as { files: string[] }).files, files.map((file) => file.path));
  assert.equal((await verifyArchive(path, PASS)).entries, files.length + 1);
  assert.equal((await inspectArchive(path)).panelVersion, '0.0.0-test');
});

test('entries left unread are skipped', async () => {
  const path = await build('skip.torexploy', [
    { path: 'one', data: randomBytes(300_000) },
    { path: 'two', data: Buffer.from('second') },
  ]);
  const archive = await ArchiveReader.open(path, PASS);
  const seen: string[] = [];
  for await (const entry of archive.entries()) {
    seen.push(entry.path);
    if (entry.path === 'two') {
      const parts: Buffer[] = [];
      for await (const piece of entry.body) parts.push(piece);
      assert.equal(Buffer.concat(parts).toString(), 'second');
    }
  }
  await archive.close();
  assert.deepEqual(seen, [MANIFEST_PATH, 'one', 'two']);
});

test('a wrong passphrase, damage, truncation and a foreign file are told apart', async () => {
  const path = await build('damage.torexploy', [{ path: 'data', data: randomBytes(CHUNK_SIZE + 500) }]);
  await assert.rejects(ArchiveReader.open(path, 'not the passphrase!'), (error: unknown) => error instanceof ArchiveError && (error.params as { reason: string }).reason === 'wrong_passphrase');

  const bytes = readFileSync(path);
  const flipped = Buffer.from(bytes);
  flipped[flipped.length - 100]! ^= 0x01;
  writeFileSync(join(dir, 'flipped.torexploy'), flipped);
  await assert.rejects(readAll(join(dir, 'flipped.torexploy')), (error: unknown) => error instanceof ArchiveError && (error.params as { reason: string }).reason === 'corrupt');

  writeFileSync(join(dir, 'cut.torexploy'), bytes.subarray(0, bytes.length - 5_000));
  await assert.rejects(readAll(join(dir, 'cut.torexploy')), (error: unknown) => error instanceof ArchiveError && ['truncated', 'corrupt'].includes((error.params as { reason: string }).reason));

  // Cut exactly after the first chunk: every remaining chunk is whole, but the last one is missing.
  const headerLength = 15 + bytes.readUInt32BE(11);
  const firstChunk = 5 + bytes.readUInt32BE(headerLength) + 16;
  writeFileSync(join(dir, 'clean-cut.torexploy'), bytes.subarray(0, headerLength + firstChunk));
  await assert.rejects(readAll(join(dir, 'clean-cut.torexploy')), (error: unknown) => error instanceof ArchiveError && (error.params as { reason: string }).reason === 'truncated');

  writeFileSync(join(dir, 'foreign.torexploy'), Buffer.from('PK\x03\x04 not ours'));
  await assert.rejects(inspectArchive(join(dir, 'foreign.torexploy')), (error: unknown) => error instanceof ArchiveError && (error.params as { reason: string }).reason === 'not_archive');

  // The header is authenticated too: changing the panel version breaks every chunk.
  const edited = Buffer.from(bytes.toString('latin1').replace('0.0.0-test', '9.9.9-test'), 'latin1');
  writeFileSync(join(dir, 'edited.torexploy'), edited);
  await assert.rejects(readAll(join(dir, 'edited.torexploy')), (error: unknown) => error instanceof ArchiveError && (error.params as { reason: string }).reason === 'corrupt');
});

test('generated passphrases are long, grouped and unambiguous', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const passphrase = generatePassphrase();
    assert.match(passphrase, /^[a-hjkmnp-z2-9]{5}(-[a-hjkmnp-z2-9]{5}){4}$/);
    seen.add(passphrase);
  }
  assert.equal(seen.size, 200);
});
