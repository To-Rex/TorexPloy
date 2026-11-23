/**
 * Builds `dist/torex.mjs`: the whole command line in one file, with nothing
 * to install beside it but Node.js 20 or newer. The panel serves this file
 * (`/cli/torex.mjs`) and its installers point at it.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist', 'torex.mjs');
mkdirSync(dirname(out), { recursive: true });
await build({
  input: join(here, 'src', 'main.ts'),
  platform: 'node',
  logLevel: 'warn',
  output: {
    file: out,
    format: 'esm',
    banner: '#!/usr/bin/env node',
    codeSplitting: false,
    minify: false,
  },
});
chmodSync(out, 0o755);
console.log(`built ${out}`);
