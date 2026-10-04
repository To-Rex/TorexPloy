/**
 * The self-updater: a one-off container the control plane starts to replace itself.
 *
 *   docker run --name ploy-updater --network ploy -v /var/run/docker.sock:/var/run/docker.sock \
 *     -e PLOY_UPDATER_TARGET=ploy-control -e PLOY_UPDATER_MODE=source -e PLOY_UPDATER_REPO=To-Rex/TorexPloy \
 *     -e PLOY_UPDATER_BRANCH=main -e PLOY_UPDATER_COMMIT=<sha> -e PLOY_UPDATER_TAG=torexploy:latest \
 *     torexploy:latest node packages/server/src/updater.ts
 *
 * It builds the new image from the repository (`source`) or pulls a prebuilt
 * one (`image`), recreates the target container from it with the same ports,
 * volumes, restart policy and networks, waits for it to answer `/api/health`,
 * and removes the old one — or puts the old one back when the new one does
 * not come up. It touches no database and no secrets: everything it needs is
 * in its environment and on the Docker socket. Output goes to stdout, where
 * the panel reads it back if the run fails.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerClient, type ContainerInspect } from './docker/client.ts';
import { errorMessage } from './lib/errors.ts';
import { runProcess } from './lib/process.ts';
import { replaceContainer } from './updates/replace.ts';

interface UpdaterEnv {
  target: string;
  mode: 'source' | 'image';
  repository: string;
  branch: string;
  commit: string | null;
  image: string | null;
  tag: string;
  socket: string;
}

const BUILD_TIMEOUT_MS = 30 * 60_000;
const HEALTH_PATH = '/api/health';

function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`);
}

function readEnv(env: NodeJS.ProcessEnv): UpdaterEnv {
  const value = (key: string): string | undefined => {
    const raw = env[key]?.trim();
    return raw === undefined || raw.length === 0 ? undefined : raw;
  };
  const repository = value('PLOY_UPDATER_REPO') ?? 'To-Rex/TorexPloy';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error(`PLOY_UPDATER_REPO is not owner/name: ${repository}`);
  const branch = value('PLOY_UPDATER_BRANCH') ?? 'main';
  if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-') || branch.includes('..')) throw new Error(`PLOY_UPDATER_BRANCH is not a branch name: ${branch}`);
  const commit = value('PLOY_UPDATER_COMMIT')?.toLowerCase() ?? null;
  if (commit !== null && !/^[0-9a-f]{7,40}$/.test(commit)) throw new Error(`PLOY_UPDATER_COMMIT is not a commit hash: ${commit}`);
  const mode = value('PLOY_UPDATER_MODE') === 'image' ? 'image' : 'source';
  const image = value('PLOY_UPDATER_IMAGE') ?? null;
  if (mode === 'image' && image === null) throw new Error('PLOY_UPDATER_IMAGE is required in image mode');
  const tag = value('PLOY_UPDATER_TAG') ?? 'torexploy:latest';
  if (!/^[\w.\-/:]+$/.test(tag)) throw new Error(`PLOY_UPDATER_TAG is not an image tag: ${tag}`);
  return {
    target: value('PLOY_UPDATER_TARGET') ?? 'ploy-control',
    mode,
    repository,
    branch,
    commit,
    image,
    tag,
    socket: (value('DOCKER_HOST') ?? 'unix:///var/run/docker.sock').replace(/^unix:\/\//, ''),
  };
}

/** `repo:tag` split the way Docker reads it (the last colon after the last slash). */
function splitTag(reference: string): { repository: string; tag: string } {
  const colon = reference.lastIndexOf(':');
  if (colon > reference.lastIndexOf('/')) return { repository: reference.slice(0, colon), tag: reference.slice(colon + 1) };
  return { repository: reference, tag: 'latest' };
}

/** Run a command, streaming its output line by line; a non-zero exit is an error carrying the last lines. */
async function run(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<string> {
  log(`$ ${command} ${args.join(' ')}`);
  let pending = '';
  const result = await runProcess(command, args, {
    ...options,
    onOutput: (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim().length > 0) log(`  ${line}`);
    },
  });
  if (pending.trim().length > 0) log(`  ${pending}`);
  if (result.code !== 0) {
    const detail = result.timedOut ? 'timed out' : `exit code ${result.code ?? `signal ${String(result.signal)}`}`;
    const last = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-5).join('\n');
    throw new Error(`${command} ${args[0] ?? ''} failed (${detail})${last.length > 0 ? `:\n${last}` : ''}`);
  }
  return result.stdout.trim();
}

/** Clone the branch, pin it to the approved commit, build and tag the image. Returns the built commit. */
async function buildFromSource(env: UpdaterEnv): Promise<string> {
  const dir = join(tmpdir(), 'src');
  rmSync(dir, { recursive: true, force: true });
  const git = { GIT_TERMINAL_PROMPT: '0' };
  await run('git', ['clone', '--depth', '1', '--branch', env.branch, `https://github.com/${env.repository}.git`, dir], { env: git, timeoutMs: 5 * 60_000 });
  let head = await run('git', ['-C', dir, 'rev-parse', 'HEAD'], { env: git });
  if (env.commit !== null && !head.startsWith(env.commit)) {
    // The branch moved on since the administrator approved this commit: build what was approved, not what is newest.
    log(`${env.branch} is now at ${head.slice(0, 7)}; fetching the approved commit ${env.commit.slice(0, 7)}`);
    await run('git', ['-C', dir, 'fetch', '--depth', '1', 'origin', env.commit], { env: git, timeoutMs: 5 * 60_000 });
    await run('git', ['-C', dir, 'checkout', '--detach', 'FETCH_HEAD'], { env: git });
    head = await run('git', ['-C', dir, 'rev-parse', 'HEAD'], { env: git });
    if (!head.startsWith(env.commit)) throw new Error(`Checked out ${head.slice(0, 7)} but ${env.commit.slice(0, 7)} was requested`);
  }
  log(`Building ${env.tag} from ${env.repository}@${head.slice(0, 7)}`);
  await run(
    'docker',
    [
      'buildx',
      'build',
      '--load',
      '--progress',
      'plain',
      '--tag',
      env.tag,
      '--tag',
      `${splitTag(env.tag).repository}:${head.slice(0, 7)}`,
      '--build-arg',
      `PLOY_COMMIT=${head}`,
      '--build-arg',
      `PLOY_BUILT_AT=${new Date().toISOString()}`,
      dir,
    ],
    { env: { DOCKER_HOST: `unix://${env.socket}`, DOCKER_BUILDKIT: '1' }, timeoutMs: BUILD_TIMEOUT_MS },
  );
  rmSync(dir, { recursive: true, force: true });
  return head;
}

/** Pull the prebuilt image and give it the installer's tag. Returns the commit its OCI label names, if any. */
async function pullImage(docker: DockerClient, env: UpdaterEnv): Promise<string | null> {
  const image = env.image!;
  log(`Pulling ${image}`);
  await docker.pullImage(image, (line) => log(`  ${line}`));
  const { repository, tag } = splitTag(env.tag);
  await docker.tagImage(image, repository, tag);
  const inspect = await docker.inspectImage(image);
  const revision = inspect?.Config.Labels?.['org.opencontainers.image.revision'] ?? null;
  log(`Tagged ${image} as ${env.tag}${revision === null ? '' : ` (commit ${revision.slice(0, 7)})`}`);
  return revision;
}

/** `PLOY_PORT` of the target, as its environment sets it. */
function portOf(inspect: ContainerInspect): number {
  const entry = (inspect.Config.Env ?? []).find((item) => item.startsWith('PLOY_PORT='));
  const port = Number(entry?.slice('PLOY_PORT='.length));
  return Number.isInteger(port) && port > 0 ? port : 3000;
}

/** Ask the new container's `/api/health` by address on the shared network, then by name (user-defined networks resolve it). */
async function probeHealth(name: string, inspect: ContainerInspect): Promise<boolean> {
  const port = portOf(inspect);
  const hosts = [...Object.values(inspect.NetworkSettings.Networks ?? {}).map((network) => network.IPAddress).filter((ip) => ip.length > 0), name];
  for (const host of hosts) {
    try {
      const response = await fetch(`http://${host}:${port}${HEALTH_PATH}`, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return true;
    } catch {
      // Not up yet, or not reachable this way; the next candidate or the next round will tell.
    }
  }
  return false;
}

async function main(): Promise<void> {
  const env = readEnv(process.env);
  log(`TorexPloy updater: ${env.mode} mode, target ${env.target}, ${env.mode === 'source' ? `${env.repository}@${env.branch}` : env.image}`);
  const docker = new DockerClient(env.socket);
  try {
    const version = await docker.negotiate();
    log(`Docker ${version.Version} (API ${version.ApiVersion})`);
    const built = env.mode === 'source' ? await buildFromSource(env) : await pullImage(docker, env);
    await replaceContainer(docker, { name: env.target, image: env.tag, probe: (inspect) => probeHealth(env.target, inspect), log });
    log(`✓ Updated to ${built ?? env.tag}`);
  } finally {
    docker.close();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    log(`✗ Update failed: ${errorMessage(error)}`);
    process.exit(1);
  },
);
