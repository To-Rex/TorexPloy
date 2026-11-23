/**
 * Files TorexAi can read and write, wherever they live: on a server's host,
 * inside a running container, or in the working copy of an application's
 * source. The tools speak to all three through one interface.
 */
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { DockerClient } from '../docker/client.ts';
import { createTar, readTar } from '../lib/tar.ts';
import type { HostShell } from './host.ts';

/** Something the model got wrong or cannot have: the message is its tool result, and it may try again. */
export class ToolError extends Error {
  override name = 'ToolError';
}

/** The largest file read or written whole. */
export const FILE_MAX = 2 * 1024 * 1024;
const LIST_MAX_LINES = 400;
const SEARCH_MAX_LINES = 200;

export interface FileTarget {
  /** What the place is called in messages: `server Main`, `container api`, `the source of api`. */
  readonly label: string;
  readonly kind: 'server' | 'container' | 'code';
  /** The file's bytes; null when it does not exist. */
  read(path: string): Promise<Buffer | null>;
  write(path: string, content: Buffer): Promise<void>;
  remove(path: string): Promise<void>;
  list(path: string, depth: number): Promise<string>;
  search(pattern: string, path: string, glob: string | undefined): Promise<string>;
}

/** A string as one shell word. */
export const sq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

function clipLines(text: string, max: number): string {
  const lines = text.replace(/\n+$/, '').split('\n');
  if (lines.length <= max) return lines.join('\n');
  return `${lines.slice(0, max).join('\n')}\n… ${lines.length - max} more lines not shown; narrow the path or the pattern`;
}

function absolute(path: string): string {
  if (!path.startsWith('/')) throw new ToolError(`The path must be absolute (start with /): ${path}`);
  if (path.includes('\0')) throw new ToolError('The path contains a NUL byte');
  return path;
}

const LIST_SCRIPT = (path: string, depth: number): string =>
  depth <= 1
    ? `ls -la -- ${sq(path)} 2>&1 | head -n ${LIST_MAX_LINES + 1}`
    : `find ${sq(path)} -maxdepth ${depth} \\( -name .git -o -name node_modules \\) -prune -o -print 2>&1 | head -n ${LIST_MAX_LINES + 1}`;

const SEARCH_SCRIPT = (pattern: string, path: string, glob: string | undefined): string =>
  `grep -rnI --exclude-dir=.git --exclude-dir=node_modules ${glob === undefined ? '' : `--include=${sq(glob)} `}-e ${sq(pattern)} -- ${sq(path)} 2>/dev/null | cut -c1-400 | head -n ${SEARCH_MAX_LINES + 1}`;

// ---------------------------------------------------------------------------
// A server's host
// ---------------------------------------------------------------------------

export function hostFiles(shell: HostShell, serverId: string, name: string): FileTarget {
  const run = async (command: string, stdin?: string): Promise<string> => {
    const result = await shell(serverId, command, { timeoutMs: 60_000, ...(stdin === undefined ? {} : { stdin }) });
    if (result.timedOut) throw new ToolError('The server did not answer in time');
    if (result.code !== 0 && result.stdout.length === 0) throw new ToolError(result.stderr.trim().slice(0, 600) || `The command exited with code ${result.code}`);
    return result.stdout;
  };
  return {
    label: `server ${name}`,
    kind: 'server',
    async read(path) {
      const p = sq(absolute(path));
      // The size first, so a file too large to read whole is refused before any of it is sent.
      const out = await run(`if [ -d ${p} ]; then echo PLOY:DIR; elif [ ! -e ${p} ]; then echo PLOY:MISSING; else printf 'PLOY:FILE %s\\n' "$(wc -c < ${p})"; if [ "$(wc -c < ${p})" -le ${FILE_MAX} ]; then base64 < ${p} | tr -d '\\n'; fi; fi`);
      const newline = out.indexOf('\n');
      const head = (newline === -1 ? out : out.slice(0, newline)).trim();
      if (head === 'PLOY:MISSING') return null;
      if (head === 'PLOY:DIR') throw new ToolError(`${path} is a directory; list it instead`);
      const size = Number(head.replace('PLOY:FILE', '').trim());
      if (!Number.isFinite(size)) throw new ToolError(`Could not read ${path}: ${out.slice(0, 300)}`);
      if (size > FILE_MAX) throw new ToolError(`${path} is ${size} bytes, larger than the ${FILE_MAX} that can be read whole; use the shell tool (head, tail, grep) for a part of it`);
      return Buffer.from(newline === -1 ? '' : out.slice(newline + 1).trim(), 'base64');
    },
    async write(path, content) {
      const p = sq(absolute(path));
      await run(`mkdir -p "$(dirname ${p})" && base64 -d > ${p} && echo PLOY:OK`, content.toString('base64'));
    },
    async remove(path) {
      await run(`rm -f -- ${sq(absolute(path))} && echo PLOY:OK`);
    },
    async list(path, depth) {
      return clipLines(await run(LIST_SCRIPT(absolute(path), depth)), LIST_MAX_LINES);
    },
    async search(pattern, path, glob) {
      const out = await run(`${SEARCH_SCRIPT(pattern, absolute(path), glob)}; true`);
      return out.trim().length === 0 ? 'No matches.' : clipLines(out, SEARCH_MAX_LINES);
    },
  };
}

// ---------------------------------------------------------------------------
// A running container
// ---------------------------------------------------------------------------

async function collect(stream: AsyncIterable<Buffer>, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > max) throw new ToolError(`The file is larger than the ${FILE_MAX} bytes that can be read whole`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function containerFiles(docker: DockerClient, container: string, name: string): FileTarget {
  const exec = async (command: string): Promise<string> => {
    const result = await docker.exec(container, ['sh', '-c', command], { timeoutMs: 60_000, maxOutput: 1_000_000 }).catch((error: unknown) => {
      throw new ToolError(`Could not run a command in the container (it may have no shell): ${(error as Error).message}`);
    });
    if (result.exitCode !== 0 && result.stdout.length === 0) throw new ToolError(result.stderr.trim().slice(0, 600) || `The command exited with code ${result.exitCode}`);
    return result.stdout;
  };
  return {
    label: `container ${name}`,
    kind: 'container',
    async read(path) {
      absolute(path);
      // Through the archive endpoint: it needs no program inside the container and is safe for any bytes.
      let response: AsyncIterable<Buffer>;
      try {
        response = (await docker.getArchive(container, path)) as unknown as AsyncIterable<Buffer>;
      } catch (error) {
        if (/no such|not found|could not find/i.test((error as Error).message)) return null;
        throw new ToolError(`Could not read ${path}: ${(error as Error).message}`);
      }
      const files = readTar(await collect(response, FILE_MAX + 64 * 1024));
      if (files.length !== 1) throw new ToolError(`${path} is a directory; list it instead`);
      return files[0]!.content;
    },
    async write(path, content) {
      absolute(path);
      const directory = dirname(path);
      await exec(`mkdir -p ${sq(directory)} && echo ok`).catch(() => undefined);
      try {
        await docker.putArchive(container, directory, createTar([{ name: path.slice(directory.length).replace(/^\/+/, ''), content, mode: 0o644 }]));
      } catch (error) {
        throw new ToolError(`Could not write ${path}: ${(error as Error).message}`);
      }
    },
    async remove(path) {
      await exec(`rm -f -- ${sq(absolute(path))} && echo ok`);
    },
    async list(path, depth) {
      return clipLines(await exec(LIST_SCRIPT(absolute(path), depth)), LIST_MAX_LINES);
    },
    async search(pattern, path, glob) {
      const out = await exec(`${SEARCH_SCRIPT(pattern, absolute(path), glob)}; true`);
      return out.trim().length === 0 ? 'No matches.' : clipLines(out, SEARCH_MAX_LINES);
    },
  };
}

// ---------------------------------------------------------------------------
// A working copy on the control plane
// ---------------------------------------------------------------------------

const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'target', 'vendor', '.venv', '__pycache__', '.cache']);

/** Resolve a path the model named inside `root`, refusing anything that leaves it (`..`, absolute paths, symlinks out). */
export async function confine(root: string, path: string): Promise<string> {
  const cleaned = path.replace(/^\/+/, '');
  const target = resolve(root, cleaned);
  const lexical = relative(root, target);
  if (lexical === '..' || lexical.startsWith(`..${sep}`) || resolve(root, lexical) !== target) throw new ToolError(`${path} is outside the working copy`);
  if (lexical.split(sep)[0] === '.git') throw new ToolError('The .git directory is managed by TorexAi and cannot be read or written');
  // The nearest existing ancestor must still be inside the root once symlinks are followed.
  let existing = target;
  for (;;) {
    const real = await realpath(existing).catch(() => null);
    if (real !== null) {
      const realRoot = await realpath(root);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new ToolError(`${path} leads outside the working copy`);
      break;
    }
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return target;
}

async function walk(root: string, dir: string, depth: number, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= limit) return;
    const full = join(dir, entry.name);
    const shown = relative(root, full).split(sep).join('/');
    if (entry.isDirectory()) {
      if (entry.name === '.git') continue;
      out.push(`${shown}/`);
      if (depth > 1 && !SKIPPED_DIRS.has(entry.name)) await walk(root, full, depth - 1, out, limit);
    } else {
      out.push(shown);
    }
  }
}

function globToRegex(glob: string): RegExp {
  const source = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`(^|/)${source}$`);
}

export function codeFiles(root: string, name: string): FileTarget {
  return {
    label: `the source of ${name}`,
    kind: 'code',
    async read(path) {
      const target = await confine(root, path);
      const info = await lstat(target).catch(() => null);
      if (info === null) return null;
      if (info.isDirectory()) throw new ToolError(`${path} is a directory; list it instead`);
      if (info.size > FILE_MAX) throw new ToolError(`${path} is ${info.size} bytes, larger than the ${FILE_MAX} that can be read whole`);
      return readFile(target);
    },
    async write(path, content) {
      const target = await confine(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    async remove(path) {
      await rm(await confine(root, path), { force: true });
    },
    async list(path, depth) {
      const start = await confine(root, path.length === 0 ? '.' : path);
      const out: string[] = [];
      await walk(root, start, Math.max(1, depth), out, LIST_MAX_LINES + 1);
      if (out.length === 0) return '(empty)';
      return out.length > LIST_MAX_LINES ? `${out.slice(0, LIST_MAX_LINES).join('\n')}\n… more entries not shown; list a subdirectory` : out.join('\n');
    },
    async search(pattern, path, glob) {
      const start = await confine(root, path.length === 0 ? '.' : path);
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'i');
      } catch {
        regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      }
      const filter = glob === undefined ? null : globToRegex(glob);
      const names: string[] = [];
      await walk(root, start, 12, names, 20_000);
      const hits: string[] = [];
      for (const file of names) {
        if (hits.length > SEARCH_MAX_LINES) break;
        if (file.endsWith('/') || (filter !== null && !filter.test(file))) continue;
        const full = join(root, file);
        const info = await lstat(full).catch(() => null);
        if (info === null || !info.isFile() || info.size > 1_000_000) continue;
        const data = await readFile(full).catch(() => null);
        if (data === null || data.subarray(0, 4_000).includes(0)) continue;
        const lines = data.toString('utf8').split('\n');
        for (let index = 0; index < lines.length && hits.length <= SEARCH_MAX_LINES; index += 1) {
          if (regex.test(lines[index]!)) hits.push(`${file}:${index + 1}:${lines[index]!.slice(0, 300)}`);
        }
      }
      if (hits.length === 0) return 'No matches.';
      return hits.length > SEARCH_MAX_LINES ? `${hits.slice(0, SEARCH_MAX_LINES).join('\n')}\n… more matches not shown; narrow the pattern` : hits.join('\n');
    },
  };
}

// ---------------------------------------------------------------------------
// Showing and editing text
// ---------------------------------------------------------------------------

export function isBinary(data: Buffer): boolean {
  return data.subarray(0, 8_000).includes(0);
}

/** A window of a text file with line numbers, the way an editor shows it. */
export function textWindow(data: Buffer, offset: number, limit: number): string {
  const lines = data.toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const from = Math.max(1, offset);
  const to = Math.min(lines.length, from + limit - 1);
  if (lines.length === 0) return '(empty file)';
  if (from > lines.length) return `The file has ${lines.length} lines.`;
  const width = String(to).length;
  const shown = lines.slice(from - 1, to).map((line, index) => `${String(from + index).padStart(width)}\t${line.length > 600 ? `${line.slice(0, 600)}…` : line}`);
  const more = to < lines.length ? `\n… lines ${to + 1}-${lines.length} not shown (offset=${to + 1})` : '';
  return `${shown.join('\n')}${more}`;
}

/** Replace `old` with `fresh` in a text: exactly once unless `all`. */
export function replaceText(text: string, old: string, fresh: string, all: boolean): { text: string; count: number } {
  if (old.length === 0) throw new ToolError('The text to replace is empty');
  let count = 0;
  let index = text.indexOf(old);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(old, index + old.length);
  }
  if (count === 0) throw new ToolError('The text to replace was not found in the file. Read the file again and copy the text exactly, including indentation.');
  if (count > 1 && !all) throw new ToolError(`The text to replace occurs ${count} times. Include more of the surrounding lines so it is unique, or set all=true.`);
  return { text: all ? text.split(old).join(fresh) : text.replace(old, () => fresh), count };
}
