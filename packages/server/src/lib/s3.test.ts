import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDeleteResult, parseListBuckets, parseListObjects, presignV4, S3Client, S3Error, signV4 } from './s3.ts';

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

test('presigned URLs match the AWS reference example (GET object, 24 hours, host as the only signed header)', () => {
  // "Example: Presigned URL" from the AWS S3 documentation on query-string SigV4 authentication.
  const query = presignV4({
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    amzDate: '20130524T000000Z',
    expiresIn: 86400,
  });
  assert.equal(
    query,
    'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
  );
  // The client builds the full link, path-style, with extra parameters folded into the signature.
  const client = new S3Client({ endpoint: 'http://127.0.0.1:8333', region: 'us-east-1', bucket: 'photos', accessKeyId: 'ployroot', secretAccessKey: 'secret', forcePathStyle: true });
  const link = client.presign({ method: 'GET', key: 'a b/ü.png', expiresIn: 60, query: { 'response-content-disposition': 'attachment; filename="ü.png"' }, endpoint: 'https://files.example.uz' });
  const url = new URL(link.url);
  assert.equal(url.origin + url.pathname, 'https://files.example.uz/photos/a%20b/%C3%BC.png');
  assert.equal(url.searchParams.get('response-content-disposition'), 'attachment; filename="ü.png"');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '60');
  assert.match(url.searchParams.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/);
  assert.ok(Date.parse(link.expiresAt) - Date.now() > 50_000 && Date.parse(link.expiresAt) - Date.now() <= 60_000);
});

test('a valueless query flag (?delete) is canonicalized as "delete=", not "delete=/"', () => {
  const header = signV4({ method: 'POST', host: '127.0.0.1:31003', path: '/photos', query: { delete: '' }, headers: { 'content-type': 'application/xml', 'x-amz-content-sha256': 'd1f0c46a6f184997d4f48e8b649f8ed024817016379bcbfb518676556ff52797', 'x-amz-date': '20261004T204605Z' }, payloadHash: 'd1f0c46a6f184997d4f48e8b649f8ed024817016379bcbfb518676556ff52797', region: 'us-east-1', accessKeyId: 'ployrootkey', secretAccessKey: 'rootsecret0123456789abcdefghijklmnopqrstuv', amzDate: '20261004T204605Z' });
  // Signature produced by curl --aws-sigv4 for the same request, accepted by SeaweedFS.
  assert.match(header, /Signature=754caefaedb147b64c7fcc0429958e8d09ca3eb5d8e0ad40058783e82c4469d8$/);
});

test('S3 XML is parsed: listings with folders and pages, bucket lists, delete results, and encoded entities', () => {
  const listing = parseListObjects(
    `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>photos</Name><Prefix>a/</Prefix><MaxKeys>2</MaxKeys><Delimiter>/</Delimiter><IsTruncated>true</IsTruncated><Contents><Key>a/one &amp; two.txt</Key><ETag>&#34;f97c5d29941bfb1b2fdab0874906ab82&#34;</ETag><Size>3</Size><StorageClass>STANDARD</StorageClass><LastModified>2026-10-04T20:37:28Z</LastModified></Contents><CommonPrefixes><Prefix>a/b/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>a/c/</Prefix></CommonPrefixes><NextContinuationToken>a/c/</NextContinuationToken><KeyCount>3</KeyCount></ListBucketResult>`,
  );
  assert.deepEqual(listing, {
    prefixes: ['a/b/', 'a/c/'],
    objects: [{ key: 'a/one & two.txt', size: 3, lastModified: '2026-10-04T20:37:28Z', etag: 'f97c5d29941bfb1b2fdab0874906ab82' }],
    truncated: true,
    nextContinuationToken: 'a/c/',
  });
  assert.deepEqual(parseListObjects('<ListBucketResult><Name>e</Name><Prefix></Prefix><IsTruncated>false</IsTruncated><KeyCount>0</KeyCount></ListBucketResult>'), { prefixes: [], objects: [], truncated: false, nextContinuationToken: null });
  assert.deepEqual(parseListBuckets('<ListAllMyBucketsResult><Owner><ID>root</ID></Owner><Buckets><Bucket><Name>other</Name><CreationDate>2026-10-04T20:37:28Z</CreationDate></Bucket><Bucket><Name>photos</Name><CreationDate>2026-10-04T20:37:28Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>'), [
    { name: 'other', createdAt: '2026-10-04T20:37:28Z' },
    { name: 'photos', createdAt: '2026-10-04T20:37:28Z' },
  ]);
  assert.deepEqual(parseListBuckets('<ListAllMyBucketsResult><Buckets/></ListAllMyBucketsResult>'), []);
  assert.deepEqual(parseDeleteResult('<DeleteResult><Deleted><Key>a/one.txt</Key></Deleted><Deleted><Key>nope.txt</Key></Deleted><Error><Key>locked/x</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error></DeleteResult>'), {
    deleted: ['a/one.txt', 'nope.txt'],
    errors: [{ key: 'locked/x', code: 'AccessDenied', message: 'Access Denied' }],
  });
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
    ['server', `-dir=${dir}`, '-ip=127.0.0.1', '-ip.bind=127.0.0.1', `-master.port=${master}`, `-volume.port=${volume}`, `-filer.port=${filer}`, '-s3', `-s3.port=${s3}`, `-s3.config=${join(dir, 's3.json')}`, '-volume.max=5', '-volume.minFreeSpace=0', '-s3.port.iceberg=0', '-s3.port.lance=0', '-s3.allowDeleteBucketNotEmpty=false'],
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

    // The file store's operations: listing with folders and pages, metadata, ranges, presigned links, multi-delete, bucket removal.
    assert.ok((await client.listBuckets()).some((bucket) => bucket.name === 'ploy-backups'));
    // SeaweedFS keeps the directories of a deleted object; each goes through its own key once empty, deepest first.
    assert.deepEqual((await client.listObjects({ delimiter: '/' })).prefixes, ['torexploy/']);
    await client.deleteObjects(['torexploy/team/postgres/', 'torexploy/team/', 'torexploy/']);
    assert.deepEqual((await client.listObjects({ delimiter: '/' })).prefixes, []);
    for (const [name, content] of [['a/one.txt', 'one'], ['a/b/two.txt', 'two'], ['three.txt', 'three'], ['sp ace/ü+plus&amp.txt', 'x']] as const) await client.put(name, Buffer.from(content), content.length, 'text/plain');
    await client.put('folder/', Buffer.alloc(0), 0, 'application/x-directory');
    const root = await client.listObjects({ delimiter: '/' });
    assert.deepEqual(root.prefixes, ['a/', 'folder/', 'sp ace/']);
    assert.deepEqual(root.objects.map((object) => [object.key, object.size]), [['three.txt', 5]]);
    const inner = await client.listObjects({ prefix: 'a/', delimiter: '/' });
    assert.deepEqual([inner.prefixes, inner.objects.map((object) => object.key)], [['a/b/'], ['a/one.txt']]);
    const page = await client.listObjects({ maxKeys: 2 });
    assert.equal(page.truncated, true);
    assert.ok(page.nextContinuationToken);
    const next = await client.listObjects({ maxKeys: 2, continuationToken: page.nextContinuationToken! });
    assert.ok(next.objects.every((object) => !page.objects.some((seen) => seen.key === object.key)), 'the second page continues after the first');
    assert.deepEqual(await client.headObject('three.txt').then((head) => [head?.size, head?.contentType, head?.etag]), [5, 'text/plain', '35d6d33467aae9a2e3dccb4b6b027878']);
    assert.equal(await client.headObject('missing.txt'), null);
    assert.equal((await client.listObjects({ prefix: 'sp ace/' })).objects[0]?.key, 'sp ace/ü+plus&amp.txt', 'keys round-trip through the XML');
    const partial = await client.get('three.txt', { range: 'bytes=1-3' });
    const bytes: Buffer[] = [];
    for await (const chunk of partial) bytes.push(chunk as Buffer);
    assert.deepEqual([partial.statusCode, partial.headers['content-range'], Buffer.concat(bytes).toString()], [206, 'bytes 1-3/5', 'hre']);
    const link = client.presign({ method: 'GET', key: 'three.txt', expiresIn: 120, query: { 'response-content-disposition': 'attachment; filename="t.txt"' } });
    const fetched = await fetch(link.url);
    assert.deepEqual([fetched.status, fetched.headers.get('content-disposition'), await fetched.text()], [200, 'attachment; filename="t.txt"', 'three']);
    const upload = client.presign({ method: 'PUT', key: 'via/presign.txt', expiresIn: 120 });
    assert.equal((await fetch(upload.url, { method: 'PUT', body: 'uploaded' })).status, 200);
    assert.equal((await client.headObject('via/presign.txt'))?.size, 8);
    const stale = client.presign({ method: 'GET', key: 'three.txt', expiresIn: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal((await fetch(stale.url)).status, 403, 'an expired link is refused');
    const removed = await client.deleteObjects(['a/one.txt', 'a/b/two.txt', 'nope.txt', 'sp ace/ü+plus&amp.txt', 'via/presign.txt']);
    assert.deepEqual(removed.deleted.sort(), ['a/b/two.txt', 'a/one.txt', 'nope.txt', 'sp ace/ü+plus&amp.txt', 'via/presign.txt']);
    assert.deepEqual(removed.errors, []);
    await assert.rejects(client.deleteBucket(), (error: unknown) => error instanceof S3Error && error.status === 409 && error.code === 'BucketNotEmpty');
    await client.deleteObjects(['three.txt', 'folder/']);
    await client.deleteBucket();
    assert.ok(!(await client.listBuckets()).some((bucket) => bucket.name === 'ploy-backups'));
  } finally {
    const exited = new Promise((resolve) => weed.once('exit', resolve));
    weed.kill('SIGKILL');
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
