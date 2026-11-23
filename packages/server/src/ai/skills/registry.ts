/**
 * Reading a repository of skills from GitHub.
 *
 * One request downloads the repository as a tar.gz; it is read as it
 * arrives, keeping only small text files, and every folder that holds a
 * `SKILL.md` becomes a skill with the files beside it. Nothing is unpacked to
 * disk and nothing from the repository is ever run.
 */
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';
import { AI_SKILL_LIMITS } from '@ploy/shared';
import type { CatalogRecord } from '../../store/index.ts';
import { keepsFile, parseSkill, scanSkill, skillHash, SkillError } from './format.ts';

const BLOCK = 512;
/** What one repository may hold in kept text, and how many entries are walked. */
const KEPT_BYTES_MAX = 80 * 1024 * 1024;
const ENTRIES_MAX = 200_000;
const SKILLS_MAX = 2_000;

export type Fetcher = typeof fetch;

/** Reads exact byte counts out of a stream of chunks. */
class ChunkReader {
  private readonly source: AsyncIterator<Buffer>;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;

  constructor(stream: AsyncIterable<Buffer>) {
    this.source = stream[Symbol.asyncIterator]();
  }

  private async fill(bytes: number): Promise<void> {
    while (this.buffered < bytes && !this.ended) {
      const next = await this.source.next();
      if (next.done === true) this.ended = true;
      else {
        this.chunks.push(next.value);
        this.buffered += next.value.length;
      }
    }
  }

  /** The next `bytes` bytes, or null when the stream ends before them. */
  async read(bytes: number): Promise<Buffer | null> {
    await this.fill(bytes);
    if (this.buffered < bytes) return null;
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    this.chunks = all.length > bytes ? [all.subarray(bytes)] : [];
    this.buffered = all.length - bytes;
    return all.subarray(0, bytes);
  }

  /** Pass over `bytes` bytes without keeping them. */
  async skip(bytes: number): Promise<boolean> {
    let left = bytes;
    while (left > 0) {
      if (this.buffered === 0) {
        await this.fill(1);
        if (this.buffered === 0) return false;
      }
      const head = this.chunks[0]!;
      if (head.length <= left) {
        this.chunks.shift();
        this.buffered -= head.length;
        left -= head.length;
      } else {
        this.chunks[0] = head.subarray(left);
        this.buffered -= left;
        left = 0;
      }
    }
    return true;
  }
}

/** `path=…` out of a pax extended header (`<length> <key>=<value>\n` records). */
function paxPath(data: Buffer): string | null {
  let at = 0;
  let path: string | null = null;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number(data.toString('ascii', at, space));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = data.toString('utf8', space + 1, at + length - 1);
    if (record.startsWith('path=')) path = record.slice(5);
    at += length;
  }
  return path;
}

/**
 * The regular files of a tar stream that `keep` accepts, by path. Long names
 * are followed in all three ways tar writes them (ustar prefix, pax headers,
 * GNU long names): `git archive`, which makes GitHub's tarballs, uses pax.
 */
export async function readTarStream(stream: AsyncIterable<Buffer>, keep: (path: string, size: number) => boolean): Promise<Map<string, Buffer>> {
  const reader = new ChunkReader(stream);
  const files = new Map<string, Buffer>();
  let override: string | null = null;
  let kept = 0;
  for (let entries = 0; entries < ENTRIES_MAX; entries += 1) {
    const header = await reader.read(BLOCK);
    if (header === null || header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new SkillError('The archive is corrupt');
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const type = header.toString('ascii', 156, 157);
    if (type === 'x' || type === 'L') {
      // The real path of the entry that follows.
      const data = await reader.read(padded);
      if (data === null) break;
      override = type === 'x' ? paxPath(data.subarray(0, size)) : data.subarray(0, size).toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (type === 'g') {
      if (!(await reader.skip(padded))) break;
      continue;
    }
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/s, '');
    const path = override ?? (prefix.length > 0 ? `${prefix}/${name}` : name);
    override = null;
    if ((type === '0' || type === '\0') && keep(path, size) && kept + size <= KEPT_BYTES_MAX) {
      const data = await reader.read(padded);
      if (data === null) break;
      files.set(path, Buffer.from(data.subarray(0, size)));
      kept += size;
    } else if (!(await reader.skip(padded))) break;
  }
  return files;
}

export interface RepositorySkills {
  /** The commit the archive was made from, when its top folder names one. */
  commit: string | null;
  skills: Omit<CatalogRecord, 'sourceId'>[];
  /** Folders with a `SKILL.md` that could not be read as a skill. */
  skipped: number;
}

/** The skills among the files of a repository archive (paths still carry the archive's top folder). */
export function skillsFromFiles(files: Map<string, Buffer>): RepositorySkills {
  const paths = [...files.keys()].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const first = paths[0] ?? '';
  const root = first.includes('/') ? first.slice(0, first.indexOf('/') + 1) : '';
  // `owner-repo-<sha>/`: the short commit id is the last part.
  const commit = /-([0-9a-f]{7,40})\/$/.exec(root)?.[1] ?? null;
  const manifests = paths.filter((path) => path === `${root}SKILL.md` || path.endsWith('/SKILL.md'));
  const folders = manifests.map((path) => path.slice(0, path.length - 'SKILL.md'.length));
  const skills: Omit<CatalogRecord, 'sourceId'>[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const [index, manifest] of manifests.entries()) {
    if (skills.length >= SKILLS_MAX) break;
    const folder = folders[index]!;
    let parsed;
    try {
      parsed = parseSkill(files.get(manifest)!.toString('utf8'), folder.replace(/\/$/, '').split('/').pop());
    } catch {
      skipped += 1;
      continue;
    }
    // Two skills of one name in a repository: the one nearer the top is the one meant.
    if (seen.has(parsed.name)) continue;
    seen.add(parsed.name);
    const own: Record<string, string> = {};
    let bytes = 0;
    for (const path of paths) {
      if (!path.startsWith(folder) || path === manifest) continue;
      // A skill nested inside this one keeps its own files.
      if (folders.some((other) => other !== folder && other.startsWith(folder) && path.startsWith(other))) continue;
      const data = files.get(path)!;
      if (Object.keys(own).length >= AI_SKILL_LIMITS.filesMax || bytes + data.length > AI_SKILL_LIMITS.filesBytesMax) continue;
      if (data.subarray(0, 4_000).includes(0)) continue;
      own[path.slice(folder.length)] = data.toString('utf8');
      bytes += data.length;
    }
    skills.push({
      name: parsed.name,
      description: parsed.description,
      path: folder.slice(root.length).replace(/\/$/, ''),
      body: parsed.body,
      files: own,
      metadata: parsed.metadata,
      hash: skillHash(parsed.body, own),
      flags: scanSkill(parsed.body, own),
    });
  }
  return { commit, skills, skipped };
}

/** Download a public GitHub repository and read the skills in it. */
export async function fetchRepositorySkills(repo: string, ref: string | null, userAgent: string, fetcher: Fetcher = fetch): Promise<RepositorySkills> {
  const url = `https://api.github.com/repos/${repo}/tarball${ref === null ? '' : `/${encodeURIComponent(ref)}`}`;
  let response: Response;
  try {
    response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': userAgent }, redirect: 'follow', signal: AbortSignal.timeout(180_000) });
  } catch (error) {
    throw new SkillError(`Could not reach GitHub: ${(error as Error).message}`);
  }
  if (!response.ok || response.body === null) {
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 404) throw new SkillError(`${repo} was not found (it must be a public repository${ref === null ? '' : `, with a branch or tag ${ref}`})`);
    if (response.status === 403 || response.status === 429) throw new SkillError('GitHub is limiting requests from this server; it will be tried again later');
    throw new SkillError(`GitHub answered ${response.status}`);
  }
  const unzip = createGunzip();
  const source = Readable.fromWeb(response.body as unknown as WebReadableStream);
  source.on('error', (error) => unzip.destroy(error));
  let files: Map<string, Buffer>;
  try {
    files = await readTarStream(source.pipe(unzip) as AsyncIterable<Buffer>, keepsFile);
  } catch (error) {
    throw error instanceof SkillError ? error : new SkillError(`The archive could not be read: ${(error as Error).message}`);
  } finally {
    source.destroy();
    unzip.destroy();
  }
  return skillsFromFiles(files);
}
