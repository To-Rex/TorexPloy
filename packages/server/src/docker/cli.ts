/**
 * The docker CLI configuration used for the builds and compose runs the
 * platform starts.
 *
 * It is isolated on purpose — an operator's contexts, credential helpers and
 * CLI hooks must never apply to platform work — but CLI plugins (buildx,
 * compose) are found through the config directory. In the production image
 * they sit in a system directory the CLI always searches; on a developer's
 * Mac they live next to the user's own config (Docker Desktop links them into
 * ~/.docker/cli-plugins, Homebrew installs them under its prefix), so those
 * directories are listed explicitly.
 *
 * The config also carries the registry logins of the team the CLI works for,
 * so a directory belongs to one team's run: callers give each build or
 * compose run its own and remove it when the run ends.
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliAuths } from './registry.ts';

export function pluginDirs(home: string = homedir(), exists: (path: string) => boolean = existsSync): string[] {
  return [
    join(home, '.docker', 'cli-plugins'),
    '/Applications/Docker.app/Contents/Resources/cli-plugins',
    '/opt/homebrew/lib/docker/cli-plugins',
    '/usr/local/lib/docker/cli-plugins',
    '/usr/local/libexec/docker/cli-plugins',
    '/usr/libexec/docker/cli-plugins',
    '/usr/lib/docker/cli-plugins',
  ].filter((dir) => exists(dir));
}

/** Create (or refresh) an isolated CLI config directory and return it, for `DOCKER_CONFIG`. */
export async function prepareCliConfig(dir: string, auths: CliAuths = {}): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'config.json');
  const config = { cliPluginsExtraDirs: pluginDirs(), ...(Object.keys(auths).length === 0 ? {} : { auths }) };
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // `mode` applies only when the file is created; credentials must never sit in a readable one.
  await chmod(file, 0o600);
  return dir;
}
