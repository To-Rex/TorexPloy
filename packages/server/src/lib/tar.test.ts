import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTar, readTar } from './tar.ts';

test('createTar output is readable by the system tar and round-trips through readTar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-tar-'));
  try {
    const long = `${'nested/'.repeat(20)}config.json`;
    const archive = createTar([
      { name: 'caddy.json', content: '{"apps":{}}' },
      { name: 'bin/run.sh', content: '#!/bin/sh\necho hi\n', mode: 0o755 },
      { name: long, content: Buffer.alloc(1025, 7) },
    ]);
    assert.equal(archive.length % 512, 0);
    writeFileSync(join(dir, 'a.tar'), archive);
    const result = spawnSync('tar', ['-xf', 'a.tar'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(readFileSync(join(dir, 'caddy.json'), 'utf8'), '{"apps":{}}');
    assert.equal(readFileSync(join(dir, 'bin/run.sh'), 'utf8'), '#!/bin/sh\necho hi\n');
    assert.equal(readFileSync(join(dir, long)).length, 1025);

    const files = readTar(archive);
    assert.deepEqual(files.map((file) => file.name), ['caddy.json', 'bin/run.sh', long]);
    assert.equal(files[2]!.content.length, 1025);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
