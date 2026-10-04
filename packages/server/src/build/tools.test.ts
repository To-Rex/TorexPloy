import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { AppError } from '../lib/errors.ts';
import { availableBuilders, detectBuilders, findOnPath, requireBuilder } from './tools.ts';

/** A directory holding executable stubs named `names`. */
function stubs(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-tools-'));
  for (const name of names) {
    writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

test('builders follow the CLIs on PATH: nixpacks, railpack, and pack for both buildpack vendors', async () => {
  const empty = stubs([]);
  const withNixpacks = stubs(['nixpacks']);
  const withPack = stubs(['pack', 'railpack']);
  // Neither a directory nor a file without the execute bit counts as a CLI.
  mkdirSync(join(empty, 'pack'));
  writeFileSync(join(empty, 'railpack'), '');
  chmodSync(join(empty, 'railpack'), 0o644);
  try {
    assert.deepEqual(await detectBuilders(empty), ['torex', 'dockerfile', 'static']);
    assert.deepEqual(availableBuilders(), ['torex', 'dockerfile', 'static']);
    assert.equal(await findOnPath('pack', empty), null);
    assert.equal(await findOnPath('railpack', empty), null);
    assert.equal(await findOnPath('pack', [empty, withPack].join(delimiter)), join(withPack, 'pack'));

    assert.deepEqual(await detectBuilders([withNixpacks, empty].join(delimiter)), ['torex', 'dockerfile', 'nixpacks', 'static']);
    assert.deepEqual(await detectBuilders([empty, withNixpacks, withPack].join(delimiter)), ['torex', 'dockerfile', 'nixpacks', 'railpack', 'heroku', 'paketo', 'static']);
    assert.deepEqual(await detectBuilders(''), ['torex', 'dockerfile', 'static']);

    await detectBuilders(withNixpacks);
    assert.doesNotThrow(() => requireBuilder('nixpacks'));
    assert.doesNotThrow(() => requireBuilder('torex'));
    assert.throws(
      () => requireBuilder('railpack'),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'validation_failed' &&
        error.status === 422 &&
        error.issues?.[0]?.path === 'buildType' &&
        error.issues[0].params?.reason === 'builder_unavailable' &&
        error.issues[0].message === 'railpack is not installed',
    );
    assert.throws(() => requireBuilder('heroku'), (error: unknown) => error instanceof AppError && error.issues?.[0]?.message === 'pack is not installed');
  } finally {
    await detectBuilders(process.env.PATH);
    for (const dir of [empty, withNixpacks, withPack]) rmSync(dir, { recursive: true, force: true });
  }
});
