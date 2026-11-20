#!/usr/bin/env node
/**
 * Raise the version everywhere it is written: the root package.json (which
 * the panel reads and shows), every package under packages/, and the lock
 * file.
 *
 *   node scripts/bump-version.mjs patch      a fix:            0.2.0 → 0.2.1
 *   node scripts/bump-version.mjs minor      something new:    0.2.1 → 0.3.0
 *   node scripts/bump-version.mjs major      a breaking change: 0.3.0 → 1.0.0
 *   node scripts/bump-version.mjs 1.4.0      exactly this
 *
 * The panel finds updates by comparing commits, not this number; the number
 * is for people, so they can tell at a glance what they are running.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_RE = /^\d+\.\d+\.\d+$/;

const current = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const [major, minor, patch] = String(current).split('.').map(Number);
const how = process.argv[2];
const next = how === 'patch' ? `${major}.${minor}.${patch + 1}` : how === 'minor' ? `${major}.${minor + 1}.0` : how === 'major' ? `${major + 1}.0.0` : how;
if (!VERSION_RE.test(String(current)) || next === undefined || !VERSION_RE.test(next)) {
  console.error('usage: node scripts/bump-version.mjs <patch|minor|major|x.y.z>');
  process.exit(1);
}

/** Only the package's own `"version"` line changes; the rest of the file is left exactly as written. */
function rewrite(file) {
  const text = readFileSync(file, 'utf8');
  const updated = text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${next}$2`);
  if (updated !== text) writeFileSync(file, updated);
}

rewrite(join(root, 'package.json'));
const packages = readdirSync(join(root, 'packages')).filter((name) => existsSync(join(root, 'packages', name, 'package.json')));
for (const name of packages) rewrite(join(root, 'packages', name, 'package.json'));

// The lock file names the root twice and each workspace once.
const lockPath = join(root, 'package-lock.json');
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.version = next;
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === '' || packages.some((name) => path === `packages/${name}`)) entry.version = next;
  }
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

console.log(`${current} → ${next}`);
