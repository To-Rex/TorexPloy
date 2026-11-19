/**
 * Shared building blocks for the TorexBuilder stack planners: the plan
 * contract, file and version-file helpers, the optional `torexploy.json`
 * config file, and the Dockerfile fragments every generated image is
 * assembled from (secret-mounted RUN steps, package installs, non-root
 * users, the Caddy static runtime).
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuildType } from '@ploy/shared';
import { AppError } from '../../lib/errors.ts';

export interface BuildInput {
  /** Absolute path of the build context (repository root + root directory). */
  contextDir: string;
  buildType: BuildType;
  dockerfilePath: string;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputDirectory: string | null;
  /** apt/apk package names to install into the runtime image. */
  systemPackages: readonly string[];
  /** Dockerfile `--target` stage (repository Dockerfile mode only). */
  buildStage: string | null;
  kind: 'web' | 'worker';
}

export interface BuildPlan {
  /** `dockerfile` uses the repository's file; `generated` uses {@link dockerfile}. */
  mode: 'dockerfile' | 'generated';
  stack: string;
  /** Human-readable summary for the log, e.g. "Next.js · pnpm · Node 22". */
  label: string;
  dockerfile: string | null;
  /** Dockerfile path relative to the context (repository mode only). */
  dockerfilePath: string;
  /** Port the generated image listens on when the app does not configure one. */
  defaultPort: number | null;
  startCommand: string | null;
  /** `--target` for the builder (repository Dockerfile mode only). */
  buildStage: string | null;
  /** Things worth fixing that did not stop the build, for the deployment log. */
  warnings: string[];
}

/** What a stack planner works from: the effective settings plus the repository. */
export interface Ctx {
  dir: string;
  /** Panel settings first, then `torexploy.json`, then null. */
  input: BuildInput;
  procfile: Record<string, string>;
  /** Interpreter versions requested in `torexploy.json` (`runtime`), by language, e.g. `{ node: '22' }`. */
  runtime: Record<string, string>;
  /** System packages requested by the panel and the config file, validated. */
  packages: string[];
  warnings: string[];
}

export function warn(ctx: Ctx, message: string): void {
  if (!ctx.warnings.includes(message)) ctx.warnings.push(message);
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  const text = await readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Entry names of a directory, or none when it cannot be read. */
export async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/** Sub-directories of a directory, or none when it cannot be read. */
export async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/** First non-comment line of a version file. */
export function versionLine(text: string | null): string | null {
  return text?.split('\n').map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith('#')) ?? null;
}

export async function firstExisting(dir: string, candidates: string[], format: (file: string) => string): Promise<string | null> {
  for (const candidate of candidates) {
    if (await exists(join(dir, candidate))) return format(candidate);
  }
  return null;
}

/** The candidates that exist, in order: for a `COPY` of manifests ahead of the sources. */
export async function existing(dir: string, candidates: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of candidates) if (await exists(join(dir, candidate))) found.push(candidate);
  return found;
}

/** `web:` / `worker:` entries of a Heroku-style Procfile. */
export async function readProcfile(dir: string): Promise<Record<string, string>> {
  const text = await readText(join(dir, 'Procfile'));
  const entries: Record<string, string> = {};
  if (text === null) return entries;
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.+)$/.exec(line.trim());
    if (match !== null) entries[match[1]!] = match[2]!.trim();
  }
  return entries;
}

/**
 * Tool versions pinned by asdf (`.tool-versions`) or mise (`mise.toml`,
 * `.mise.toml`), keyed by tool name, e.g. `{ nodejs: '22.11.0', python: '3.12.4' }`.
 */
export async function toolVersions(dir: string): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const file of ['mise.toml', '.mise.toml']) {
    const tools = ((await readText(join(dir, file))) ?? '').split(/^\[tools\]\s*$/m)[1]?.split(/^\[/m)[0] ?? '';
    for (const match of tools.matchAll(/^\s*"?([\w.-]+)"?\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)"|\[\s*"([^"]+)")/gm)) {
      versions[match[1]!] = (match[2] ?? match[3] ?? match[4])!;
    }
  }
  for (const line of ((await readText(join(dir, '.tool-versions'))) ?? '').split('\n')) {
    const match = /^\s*([\w.-]+)\s+(\S+)/.exec(line.replace(/#.*/, ''));
    if (match !== null) versions[match[1]!] = match[2]!;
  }
  return versions;
}

// ---------------------------------------------------------------------------
// torexploy.json
// ---------------------------------------------------------------------------

export interface TorexConfig {
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputDirectory: string | null;
  systemPackages: string[];
  runtime: Record<string, string>;
}

/** apt/apk package names, optionally pinned (`libvips42`, `imagemagick=8:6.9.11*`), and nothing a shell would interpret. */
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9+._:~=*-]*$/;

function configError(reason: string): AppError {
  return new AppError('bad_request', `torexploy.json ${reason}`, { params: { reason: 'config_invalid' } });
}

/** The optional per-repository config; unknown keys are ignored, wrong types are rejected. */
export async function readConfig(dir: string): Promise<TorexConfig | null> {
  const text = await readText(join(dir, 'torexploy.json'));
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw configError('is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw configError('must be a JSON object');
  const record = raw as Record<string, unknown>;
  const string = (key: string): string | null => {
    const value = record[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw configError(`"${key}" must be a string`);
    return value.trim() === '' ? null : value.trim();
  };
  const packages = record.systemPackages ?? [];
  if (!Array.isArray(packages) || packages.some((name) => typeof name !== 'string' || !PACKAGE_NAME.test(name))) {
    throw configError('"systemPackages" must be an array of package names');
  }
  const runtime = record.runtime ?? {};
  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime)) throw configError('"runtime" must be an object');
  const versions: Record<string, string> = {};
  for (const [language, version] of Object.entries(runtime as Record<string, unknown>)) {
    if (typeof version !== 'string' && typeof version !== 'number') throw configError(`"runtime.${language}" must be a version string`);
    versions[language] = String(version);
  }
  return { installCommand: string('installCommand'), buildCommand: string('buildCommand'), startCommand: string('startCommand'), outputDirectory: string('outputDirectory'), systemPackages: packages as string[], runtime: versions };
}

/** Merges the panel settings (which win) with the config file into a planning context. */
export async function createContext(input: BuildInput): Promise<Ctx> {
  const dir = input.contextDir;
  const config = await readConfig(dir);
  for (const name of input.systemPackages) {
    if (!PACKAGE_NAME.test(name)) throw new AppError('bad_request', `Invalid system package name: ${name}`, { params: { reason: 'system_package_invalid' } });
  }
  const pick = (panel: string | null, file: string | null): string | null => (panel !== null && panel.trim() !== '' ? panel : file);
  return {
    dir,
    input: {
      ...input,
      installCommand: pick(input.installCommand, config?.installCommand ?? null),
      buildCommand: pick(input.buildCommand, config?.buildCommand ?? null),
      startCommand: pick(input.startCommand, config?.startCommand ?? null),
      outputDirectory: pick(input.outputDirectory, config?.outputDirectory ?? null),
    },
    procfile: await readProcfile(dir),
    runtime: config?.runtime ?? {},
    packages: [...new Set([...input.systemPackages, ...(config?.systemPackages ?? [])])],
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Dockerfile building blocks
// ---------------------------------------------------------------------------

/** Loads build-time variables from the BuildKit secret, if one was provided. */
const LOAD_ENV = 'set -e; if [ -f /run/secrets/ploy_env ]; then set -a; . /run/secrets/ploy_env; set +a; fi; ';

/** A RUN step in exec form (JSON-quoted, so any command text is safe) with optional cache mounts. */
export function run(command: string, caches: string[] = [], withEnv = true): string {
  const mounts = [
    ...(withEnv ? ['--mount=type=secret,id=ploy_env'] : []),
    ...caches.map((target) => `--mount=type=cache,target=${target}`),
  ];
  return `RUN ${mounts.join(' ')}${mounts.length > 0 ? ' ' : ''}${JSON.stringify(['sh', '-c', `${withEnv ? LOAD_ENV : 'set -e; '}${command}`])}`;
}

export function cmd(command: string): string {
  return `CMD ${JSON.stringify(['sh', '-c', `exec ${command}`])}`;
}

/** Writes a file inside the image with printf, avoiding Dockerfile heredocs (not in older BuildKit). */
export function writeFileStep(path: string, lines: string[]): string {
  const quoted = lines.map((line) => `'${line.replace(/'/g, `'\\''`)}'`).join(' ');
  return run(`mkdir -p "$(dirname ${path})" && printf '%s\\n' ${quoted} > ${path}`, [], false);
}

/** Package-manager family of a base image: what installs system packages and creates users. */
export type ImageFamily = 'debian' | 'alpine';

export function installPackages(family: ImageFamily, packages: string[]): string[] {
  const list = [...new Set(packages)].join(' ');
  if (list === '') return [];
  return family === 'alpine'
    ? [`RUN apk add --no-cache ${list}`]
    : [`RUN apt-get update -qq && apt-get install -y --no-install-recommends ${list} >/dev/null && rm -rf /var/lib/apt/lists/*`];
}

/** The stack's own runtime packages plus the user's `systemPackages`, in one layer. */
export function runtimePackages(ctx: Ctx, family: ImageFamily, required: string[] = []): string[] {
  return installPackages(family, [...required, ...ctx.packages]);
}

/** A system user for the runtime stage (uid 10001, no login shell). */
export function addUser(family: ImageFamily, name = 'app'): string {
  return family === 'alpine'
    ? `RUN adduser -S -D -H -u 10001 ${name}`
    : `RUN useradd --system --uid 10001 --create-home --home-dir /home/${name} --shell /usr/sbin/nologin ${name}`;
}

/**
 * Caching for static sites, Netlify style: every file is revalidated on each
 * visit (an ETag round trip, so a new deployment shows at once), except build
 * output whose name carries a content hash — that never changes under its
 * name and may be kept for a year.
 *
 * Directories where a framework guarantees hashed names are trusted as a
 * whole. Under `/assets` and `/static`, which hand-written sites use for
 * plain `style.css` too, a file counts as hashed only when its name ends in
 * a hash-like run of eight or more characters that includes a digit
 * (`index-BxzU3Ks9.js`, `main.3f2a91c0.css`), so `assets/my-component.js`
 * is revalidated like everything else.
 */
export const IMMUTABLE_DIRS = ['/_next/static/*', '/_app/immutable/*', '/_astro/*'];
export const HASHED_DIRS = ['/assets/*', '/static/*'];
/** One hash character. The run is spelled out rather than `{8,}`: a Caddyfile token with curly braces is not worth the doubt. */
const HASH_CHAR = '[A-Za-z0-9_-]';
/** The file name ends in `-` or `.`, then at least eight hash characters, then the extension. */
export const HASHED_NAME_RE = String.raw`[.-]${HASH_CHAR.repeat(7)}${HASH_CHAR}+\.[a-z0-9]+$`;
/** Paths without a single digit are human-named, however long. */
export const DIGITLESS_PATH_RE = String.raw`^/[^0-9]*$`;

/** Whether a request path gets the one-year immutable cache header under the rules above (the Caddyfile's logic, for tests). */
export function isImmutablePath(path: string): boolean {
  const glob = (pattern: string) => path.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase());
  if (IMMUTABLE_DIRS.some(glob)) return true;
  return HASHED_DIRS.some(glob) && new RegExp(HASHED_NAME_RE).test(path) && !new RegExp(DIGITLESS_PATH_RE).test(path);
}

/** A Caddy image serving `sourceDir` (from `sourceStage`, or the context) with SPA fallback and the caching rules above. */
export function staticRuntime(sourceStage: string | null, sourceDir: string, extra: string[] = []): string[] {
  const caddyfile = [
    '{',
    '  admin off',
    '  auto_https off',
    '}',
    ':8080 {',
    '  root * /srv',
    '  encode zstd gzip',
    `  @immutable path ${IMMUTABLE_DIRS.join(' ')}`,
    '  @hashed {',
    `    path ${HASHED_DIRS.join(' ')}`,
    `    path_regexp ${HASHED_NAME_RE}`,
    `    not path_regexp ${DIGITLESS_PATH_RE}`,
    '  }',
    '  header @immutable Cache-Control "public, max-age=31536000, immutable"',
    '  header @hashed Cache-Control "public, max-age=31536000, immutable"',
    // `?` sets a default (deferred, so it never overrides the two above, whatever order Caddy runs them in).
    '  header ?Cache-Control "public, max-age=0, must-revalidate"',
    '  try_files {path} {path}/ {path}.html /index.html',
    '  file_server',
    '}',
  ];
  return [
    'FROM caddy:2.11-alpine',
    ...extra,
    writeFileStep('/etc/caddy/Caddyfile', caddyfile),
    sourceStage === null ? `COPY ${sourceDir} /srv` : `COPY --from=${sourceStage} ${sourceDir} /srv`,
    'ENV PORT=8080',
    'EXPOSE 8080',
    'CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]',
  ];
}

export interface Draft {
  stack: string;
  label: string;
  lines: string[];
  defaultPort: number | null;
  startCommand: string | null;
}

/** Finishes a generated plan: labels the runtime stage and attaches the warnings collected so far. */
export function generated(ctx: Ctx, draft: Draft): BuildPlan {
  const lines = [...draft.lines];
  const runtimeStage = lines.findLastIndex((line) => line.startsWith('FROM '));
  lines.splice(runtimeStage + 1, 0, `LABEL torexploy.builder=torex torexploy.stack=${draft.stack}`);
  return {
    mode: 'generated',
    stack: draft.stack,
    label: draft.label,
    dockerfile: lines.join('\n'),
    dockerfilePath: 'Dockerfile',
    defaultPort: draft.defaultPort,
    startCommand: draft.startCommand,
    buildStage: null,
    warnings: ctx.warnings,
  };
}

/** Pushes an "x.y" version up to the first entry of `known` that is not older, e.g. a JDK 19 request to 21. */
export function roundUp(requested: number, known: number[]): number {
  return known.find((version) => version >= requested) ?? known[known.length - 1]!;
}

/** Newest "1.x" style version among candidates, or null. */
export function newest(...candidates: (string | null | undefined)[]): string | null {
  const versions = candidates.filter((version): version is string => typeof version === 'string' && /^\d+\.\d+/.test(version));
  if (versions.length === 0) return null;
  return versions.sort((a, b) => Number(b.split('.')[0]) - Number(a.split('.')[0]) || Number(b.split('.')[1]) - Number(a.split('.')[1]))[0]!;
}
