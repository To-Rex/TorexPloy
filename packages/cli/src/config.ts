/**
 * Where the command line keeps its sign-ins (profiles: a panel, a token, the
 * team it acts in) and how a folder remembers the application it deploys to.
 *
 * The config file holds tokens, so it is written for the owner alone (0600,
 * in a 0700 folder). CI can skip it: TOREX_URL and TOREX_TOKEN sign in for
 * one run without writing anything.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { TokenAccess } from '../../shared/src/mcp.ts';

export interface Profile {
  url: string;
  token: string;
  user?: string;
  email?: string;
  team?: string;
  teamId?: string;
  role?: string;
  access?: TokenAccess;
}

export interface ConfigFile {
  current: string | null;
  profiles: Record<string, Profile>;
}

/** What a folder linked with `torex link` remembers. */
export interface Link {
  url: string;
  application: string;
  name: string;
  project?: string;
}

export const LINK_FILE = '.torexploy.json';

export function configDir(): string {
  if (process.env.TOREX_CONFIG_DIR !== undefined && process.env.TOREX_CONFIG_DIR.length > 0) return process.env.TOREX_CONFIG_DIR;
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'torexploy');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'torexploy');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export function readConfig(): ConfigFile {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<ConfigFile>;
    return { current: typeof parsed.current === 'string' ? parsed.current : null, profiles: typeof parsed.profiles === 'object' && parsed.profiles !== null ? parsed.profiles : {} };
  } catch {
    return { current: null, profiles: {} };
  }
}

export function writeConfig(config: ConfigFile): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = configPath();
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows keeps its own permissions.
  }
}

/** `panel.example.com` → `https://panel.example.com`; trailing slashes and paths after the host are dropped. */
export function normalizeUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `${/^(localhost|127\.|\[::1\])/.test(trimmed) ? 'http' : 'https'}://${trimmed}`;
  const url = new URL(withScheme);
  return `${url.protocol}//${url.host}`;
}

export interface Selected {
  name: string;
  profile: Profile;
  /** It came from TOREX_URL and TOREX_TOKEN, not from the config file. */
  fromEnv: boolean;
}

/** The sign-in to use: the environment first (CI), then `--profile` or TOREX_PROFILE, then the current profile. */
export function selectProfile(options: { profile?: string; url?: string; token?: string }): Selected | null {
  const envUrl = options.url ?? process.env.TOREX_URL;
  const envToken = options.token ?? process.env.TOREX_TOKEN;
  if (envUrl !== undefined && envUrl.length > 0 && envToken !== undefined && envToken.length > 0) return { name: 'env', profile: { url: normalizeUrl(envUrl), token: envToken }, fromEnv: true };
  const config = readConfig();
  const name = options.profile ?? process.env.TOREX_PROFILE ?? config.current;
  if (name === null || name === undefined) return null;
  const profile = config.profiles[name];
  if (profile === undefined) return null;
  return { name, profile: { ...profile, ...(options.url === undefined ? {} : { url: normalizeUrl(options.url) }) }, fromEnv: false };
}

export function saveProfile(name: string, profile: Profile, makeCurrent = true): void {
  const config = readConfig();
  config.profiles[name] = profile;
  if (makeCurrent || config.current === null) config.current = name;
  writeConfig(config);
}

export function removeProfile(name: string): boolean {
  const config = readConfig();
  if (config.profiles[name] === undefined) return false;
  delete config.profiles[name];
  if (config.current === name) config.current = Object.keys(config.profiles)[0] ?? null;
  writeConfig(config);
  return true;
}

/** A profile name for a panel: its host, unless one is given. */
export function profileName(url: string): string {
  return new URL(url).host.replace(/[^A-Za-z0-9.-]/g, '-');
}

// ------------------------------------------------------------------ links

/** The link of this folder or the nearest folder above it. */
export function findLink(from = process.cwd()): { link: Link; path: string } | null {
  let dir = resolve(from);
  for (;;) {
    const path = join(dir, LINK_FILE);
    if (existsSync(path)) {
      try {
        const link = JSON.parse(readFileSync(path, 'utf8')) as Partial<Link>;
        if (typeof link.application === 'string' && typeof link.url === 'string') return { link: { url: link.url, application: link.application, name: link.name ?? link.application, ...(link.project === undefined ? {} : { project: link.project }) }, path };
      } catch {
        // A broken link file is as good as none.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function writeLink(dir: string, link: Link): string {
  const path = join(dir, LINK_FILE);
  writeFileSync(path, `${JSON.stringify(link, null, 2)}\n`);
  return path;
}
