/**
 * Backups and their S3 copies against a real S3-compatible store (SeaweedFS,
 * `PLOY_TEST_WEED=/path/to/weed`): upload after a backup, reading back from
 * S3 when the server copy is gone, a failed upload kept as a warning, and
 * deletion on both sides.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client, S3Error } from '../lib/s3.ts';
import { createContext } from '../main.ts';

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

function weedBinary(): string | null {
  const candidate = process.env.PLOY_TEST_WEED;
  return candidate !== undefined && spawnSync(candidate, ['version']).status === 0 ? candidate : null;
}

test('backups are copied to S3, readable from there, and removed from both places', { timeout: 150_000 }, async (t) => {
  const binary = weedBinary();
  if (binary === null) {
    t.skip('SeaweedFS not available (set PLOY_TEST_WEED)');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'ploy-bak-s3-'));
  const base = 25_000 + Math.floor(Math.random() * 4_000);
  const accessKeyId = 'PLOYBACKUPKEY';
  const secretAccessKey = 'ploy-backup-secret-0123456789abc';
  mkdirSync(join(dir, 'weed'));
  writeFileSync(join(dir, 's3.json'), JSON.stringify({ identities: [{ name: 'ploy', credentials: [{ accessKey: accessKeyId, secretKey: secretAccessKey }], actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'] }] }));
  const weed = spawn(
    binary,
    ['server', `-dir=${join(dir, 'weed')}`, '-ip=127.0.0.1', '-ip.bind=127.0.0.1', `-master.port=${base}`, `-volume.port=${base + 1}`, `-filer.port=${base + 2}`, '-s3', `-s3.port=${base + 3}`, `-s3.config=${join(dir, 's3.json')}`, '-volume.max=5', '-volume.minFreeSpace=0', '-s3.port.iceberg=0', '-s3.port.lance=0'],
    { stdio: 'ignore' },
  );
  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket: join(dir, 'none.sock'), logLevel: 'error' });
  const { stores } = ctx;
  try {
    const target = { endpoint: `http://127.0.0.1:${base + 3}`, region: 'us-east-1', bucket: 'ploy-backups', accessKeyId, secretAccessKey, forcePathStyle: true };
    const admin = new S3Client(target);
    assert.ok(await waitForGateway(target.endpoint), 'the S3 gateway listens');
    let ready = false;
    for (let attempt = 0; attempt < 120 && !ready; attempt += 1) {
      try {
        await admin.createBucket();
        ready = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    assert.ok(ready, 'S3 gateway is up');

    const team = stores.teams.create('Ops');
    const server = stores.servers.ensureLocal('local');
    const project = stores.projects.create(team.id, 'Shop', null);
    const service = stores.services.create({
      id: 'svc_backupss3test',
      projectId: project.id,
      teamId: team.id,
      serverId: server.id,
      name: 'postgres',
      slug: 'postgres',
      type: 'postgres',
      version: '17',
      credentials: { username: 'u', password: 'p', database: 'app' },
      internalPort: 5432,
      containerName: 'ploy-db-postgres-backup',
      volumeName: 'ploy-data-backup',
      memoryLimitMb: 512,
    });
    const destination = stores.s3.create(team.id, { name: 'Offsite', ...target, pathPrefix: 'torexploy/' });
    stores.services.update(service.id, { backupDestinationId: destination.id });

    // A finished backup on disk, as runBackup leaves it.
    const record = stores.backups.create(service.id, 'manual');
    const fileName = '2026-10-04T10-00-00-000Z.dump';
    const dump = randomBytes(256 * 1024);
    mkdirSync(ctx.services.backupDir(service.id), { recursive: true });
    writeFileSync(join(ctx.services.backupDir(service.id), fileName), dump);
    stores.backups.finish(record.id, { status: 'succeeded', filePath: fileName, sizeBytes: dump.length });
    const internals = ctx.services as unknown as { uploadBackup: (service: unknown, id: string, path: string, size: number, name: string) => Promise<void> };
    await internals.uploadBackup(stores.services.get(service.id), record.id, join(ctx.services.backupDir(service.id), fileName), dump.length, fileName);

    const uploaded = stores.backups.get(record.id)!;
    assert.equal(uploaded.remoteDestinationId, destination.id);
    assert.equal(uploaded.remoteKey, `torexploy/postgres-${'backupss3test'.slice(0, 6)}/${fileName}`);
    assert.equal(uploaded.errorMessage, null);

    // The server copy is lost: downloads and restores come from S3, byte for byte.
    rmSync(join(ctx.services.backupDir(service.id), fileName));
    const opened = await ctx.services.openBackup(stores.services.get(service.id)!, uploaded);
    assert.ok(opened !== null);
    assert.equal(opened.size, dump.length);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
    assert.ok(Buffer.concat(chunks).equals(dump));

    // Deleting the backup removes the S3 object too.
    await ctx.services.deleteBackup(stores.services.get(service.id)!, uploaded);
    await assert.rejects(admin.get(uploaded.remoteKey!), (error: unknown) => error instanceof S3Error && error.status === 404);

    // A destination with a wrong secret: the backup stays on the server and carries a warning.
    const broken = stores.s3.create(team.id, { name: 'Broken', ...target, secretAccessKey: 'wrong-secret-0000000000000000', pathPrefix: '' });
    stores.services.update(service.id, { backupDestinationId: broken.id });
    const second = stores.backups.create(service.id, 'manual');
    writeFileSync(join(ctx.services.backupDir(service.id), 'second.dump'), dump);
    stores.backups.finish(second.id, { status: 'succeeded', filePath: 'second.dump', sizeBytes: dump.length });
    await internals.uploadBackup(stores.services.get(service.id), second.id, join(ctx.services.backupDir(service.id), 'second.dump'), dump.length, 'second.dump');
    const kept = stores.backups.get(second.id)!;
    assert.equal(kept.status, 'succeeded');
    assert.equal(kept.remoteKey, null);
    assert.match(kept.errorMessage ?? '', /upload to Broken failed/);
    assert.ok(existsSync(join(ctx.services.backupDir(service.id), 'second.dump')));

    // Removing a destination detaches services instead of breaking them.
    stores.s3.delete(broken.id);
    assert.equal(stores.services.get(service.id)!.backupDestinationId, null);
  } finally {
    await ctx.notifier.flush();
    stores.db.close();
    const exited = new Promise((resolve) => weed.once('exit', resolve));
    weed.kill('SIGKILL');
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
