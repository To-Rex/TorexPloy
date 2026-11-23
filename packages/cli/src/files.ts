/**
 * What `torex up` uploads: the folder's files, minus what git would leave
 * out (`.gitignore`, or `.torexignore` when there is one), minus what never
 * belongs on a server (`.git`, `node_modules`, and `.env` files, whose
 * values belong in the panel's variables instead).
 */
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createZip, concatZip, ZIP_MAX_ENTRIES, type ZipFile } from '../../shared/src/zip.ts';

interface Rule {
  regex: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

/** A `.gitignore` pattern as a regular expression over a path relative to the folder (forward slashes). */
function compile(pattern: string): Rule | null {
  let text = pattern.replace(/(?<!\\)\s+$/, '');
  if (text.length === 0 || text.startsWith('#')) return null;
  let negate = false;
  if (text.startsWith('!')) {
    negate = true;
    text = text.slice(1);
  }
  text = text.replace(/^\\([#!])/, '$1');
  const dirOnly = text.endsWith('/');
  if (dirOnly) text = text.slice(0, -1);
  const anchored = text.startsWith('/') || text.includes('/');
  if (text.startsWith('/')) text = text.slice(1);
  let source = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '*') {
      if (text[index + 1] === '*') {
        const slash = text[index + 2] === '/';
        source += slash ? '(?:.*/)?' : '.*';
        index += slash ? 2 : 1;
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else if (char === '[') {
      const end = text.indexOf(']', index + 1);
      if (end === -1) source += '\\[';
      else {
        source += `[${text.slice(index + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        index = end;
      }
    } else if (char === '\\' && index + 1 < text.length) {
      index += 1;
      source += text[index]!.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    } else source += char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  // A pattern also covers everything inside what it names.
  const prefix = anchored ? '^' : '^(?:.*/)?';
  return { regex: new RegExp(`${prefix}${source}(?:/.*)?$`), negate, dirOnly };
}

export class IgnoreRules {
  private readonly rules: Rule[] = [];

  add(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const rule = compile(line);
      if (rule !== null) this.rules.push(rule);
    }
  }

  /** Whether a path (relative, forward slashes) is left out. The last rule that matches decides, as in git. */
  ignores(path: string, isDir: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      // A rule for folders only: the walk never enters an ignored folder, so it is only ever tested against folders.
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(path)) ignored = !rule.negate;
    }
    return ignored;
  }
}

/** Never uploaded, whatever the ignore files say. */
const ALWAYS = ['.git/', 'node_modules/', '.DS_Store', 'Thumbs.db', '.torexploy.json'];
/** Left out unless asked for: their values belong in the panel. */
const ENV_FILES = /^(?:.*\/)?\.env(?:\.(?!example$|sample$|template$|dist$)[^/]+)?$/;

export interface Collected {
  files: ZipFile[];
  bytes: number;
  /** `.env` files that were left out. */
  skippedEnv: string[];
}

export async function collect(root: string, options: { includeEnv?: boolean; maxBytes: number }): Promise<Collected> {
  const rules = new IgnoreRules();
  rules.add(ALWAYS.join('\n'));
  const own = await readFile(join(root, '.torexignore'), 'utf8').catch(() => null);
  rules.add(own ?? (await readFile(join(root, '.gitignore'), 'utf8').catch(() => '')));
  const files: ZipFile[] = [];
  const skippedEnv: string[] = [];
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const path = relative(root, full).split(sep).join('/');
      const info = await lstat(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (!rules.ignores(path, true)) await walk(full);
        continue;
      }
      if (!info.isFile() || rules.ignores(path, false)) continue;
      if (!options.includeEnv && ENV_FILES.test(path)) {
        skippedEnv.push(path);
        continue;
      }
      bytes += info.size;
      if (bytes > options.maxBytes) throw new Error(`The folder holds more than ${Math.round(options.maxBytes / 1024 / 1024)} MB to upload; leave build output and large files out with .torexignore`);
      if (files.length >= ZIP_MAX_ENTRIES - 1) throw new Error(`The folder holds more than ${ZIP_MAX_ENTRIES - 1} files to upload; leave some out with .torexignore`);
      files.push({ path, data: new Uint8Array(await readFile(full)), mode: info.mode & 0o777, mtime: info.mtime });
    }
  };
  await walk(root);
  return { files, bytes, skippedEnv };
}

export async function zip(files: ZipFile[]): Promise<Uint8Array> {
  return concatZip(await createZip(files, { compress: true }));
}
