import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client, S3Error, signV4 } from './s3.ts';

test('SigV4 matches the AWS reference example (GET object with a Range header)', () => {
  // "Example: GET Object" from the AWS S3 documentation on header-based SigV4 signing.
  const authorization = signV4({
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    headers: {
      Range: 'bytes=0-9',
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'x-amz-date': '20130524T000000Z',
    },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    amzDate: '20130524T000000Z',
  });
  assert.equal(
    authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
});

/** Until the S3 gateway answers HTTP at all (any status), polling with short timeouts. */
async function waitForGateway(endpoint: string, deadlineMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      await fetch(endpoint, { signal: AbortSignal.timeout(2_000) });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  return false;
}

/** A real S3-compatible server (SeaweedFS), when available: `PLOY_TEST_WEED=/path/to/weed`. */
function weedBinary(): string | null {
  const candidate = process.env.PLOY_TEST_WEED;
  if (candidate === undefined) return null;
  return spawnSync(candidate, ['version']).status === 0 ? candidate : null;
}

test('a real S3-compatible store accepts signed uploads, downloads and deletes, and rejects a wrong secret', { timeout: 150_000 }, async (t) => {
  const binary = weedBinary();
  if (binary === null) {
    t.skip('SeaweedFS not available (set PLOY_TEST_WEED)');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'ploy-s3-'));
  const base = 21_000 + Math.floor(Math.random() * 4_000);
  const [master, volume, filer, s3] = [base, base + 1, base + 2, base + 3];
  const accessKeyId = 'PLOYTESTKEY';
  const secretAccessKey = 'ploy-test-secret-0123456789abcdef';
  writeFileSync(join(dir, 's3.json'), JSON.stringify({ identities: [{ name: 'ploy', credentials: [{ accessKey: accessKeyId, secretKey: secretAccessKey }], actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'] }] }));
  const weed = spawn(
    binary,
    ['server', `-dir=${dir}`, '-ip=127.0.0.1', '-ip.bind=127.0.0.1', `-master.port=${master}`, `-volume.port=${volume}`, `-filer.port=${filer}`, '-s3', `-s3.port=${s3}`, `-s3.config=${join(dir, 's3.json')}`, '-volume.max=5', '-s3.port.iceberg=0', '-s3.port.lance=0'],
    { stdio: 'ignore' },
  );
  const target = { endpoint: `http://127.0.0.1:${s3}`, region: 'us-east-1', bucket: 'ploy-backups', accessKeyId, secretAccessKey, forcePathStyle: true };
  const client = new S3Client(target);
  try {
    // SeaweedFS needs a few seconds for master, volume and filer to come up.
    assert.ok(await waitForGateway(target.endpoint), 'the S3 gateway listens');
    let ready = false;
    for (let attempt = 0; attempt < 120 && !ready; attempt += 1) {
      try {
        await client.createBucket();
        ready = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    assert.ok(ready, 'the S3 gateway came up and accepted a signed CreateBucket');

    // A streamed upload of a binary file, byte-exact on the way back.
    const payload = randomBytes(3 * 1024 * 1024 + 17);
    const file = join(dir, 'dump.bin');
    writeFileSync(file, payload);
    const key = 'torexploy/team/postgres/2026-10-04T10-00-00-000Z.dump';
    await client.put(key, createReadStream(file), payload.length);
    const response = await client.get(key);
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(chunk as Buffer);
    assert.ok(Buffer.concat(chunks).equals(payload), 'download equals upload');

    await client.verify('torexploy/team');
    await client.delete(key);
    await assert.rejects(client.get(key), (error: unknown) => error instanceof S3Error && error.status === 404);
    await client.delete(key); // deleting what is gone is fine

    const wrong = new S3Client({ ...target, secretAccessKey: 'not-the-secret-at-all-000000' });
    await assert.rejects(wrong.verify('x'), (error: unknown) => error instanceof S3Error && error.status === 403);
  } finally {
    const exited = new Promise((resolve) => weed.once('exit', resolve));
    weed.kill('SIGKILL');
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
