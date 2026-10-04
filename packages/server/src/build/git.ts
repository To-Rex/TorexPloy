/**
 * Source checkout.
 *
 * Shallow, single-branch clones keep fetches fast regardless of repository
 * history. Credentials never appear on a command line:
 * - GitHub App tokens travel as an `http.extraHeader` injected through
 *   `GIT_CONFIG_*` environment variables;
 * - deploy keys are written to a private file referenced by `GIT_SSH_COMMAND`.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../lib/errors.ts';
import { runProcess } from '../lib/process.ts';

export interface CheckoutRequest {
  url: string;
  branch: string;
  /** Exact commit to build (from a push webhook); falls back to the branch head. */
  commitSha?: string | null;
  workDir: string;
  /** GitHub installation access token for https://github.com URLs. */
  githubToken?: string | null;
  /** OpenSSH private key for git@ URLs. */
  deployKey?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput: (line: string) => void;
}

export interface CommitInfo {
  sha: string;
  author: string;
  message: string;
}

function gitEnv(request: CheckoutRequest, keyPath: string | null): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    GIT_LFS_SKIP_SMUDGE: '1',
    LC_ALL: 'C',
  };
  let index = 0;
  const config = (key: string, value: string): void => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
    index += 1;
  };
  config('advice.detachedHead', 'false');
  config('init.defaultBranch', 'main');
  if (request.githubToken) {
    const basic = Buffer.from(`x-access-token:${request.githubToken}`).toString('base64');
    config('http.https://github.com/.extraheader', `AUTHORIZATION: basic ${basic}`);
  }
  env.GIT_CONFIG_COUNT = String(index);
  if (keyPath !== null) {
    env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${keyPath}.known_hosts -F /dev/null`;
  }
  return env;
}

/** Remove credentials and noise from git's progress output before it reaches a log. */
function scrub(text: string): string {
  return text.replace(/(https?:\/\/)[^@\s/]+@/g, '$1***@').replace(/x-access-token:[^@\s]+/g, 'x-access-token:***');
}

async function git(args: string[], cwd: string | undefined, request: CheckoutRequest, env: Record<string, string>): Promise<string> {
  const result = await runProcess('git', args, {
    ...(cwd === undefined ? {} : { cwd }),
    env,
    timeoutMs: request.timeoutMs,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    onOutput: (chunk) => {
      for (const line of scrub(chunk).split(/\r?\n|\r/)) {
        const trimmed = line.trim();
        // Percentage ticks ("Receiving objects: 42%") are noise once the step completes.
        if (trimmed.length > 0 && !/^(remote: )?(Counting|Compressing|Receiving|Resolving|Enumerating) objects:\s+\d+%/.test(trimmed)) {
          request.onOutput(trimmed);
        }
      }
    },
  });
  if (result.aborted) throw new AppError('git_error', 'Checkout cancelled');
  if (result.timedOut) throw new AppError('git_error', 'git timed out');
  if (result.code !== 0) {
    const detail = scrub(result.stderr.trim()).split('\n').slice(-3).join(' ');
    if (/Authentication failed|could not read Username|Permission denied|Repository not found/i.test(detail)) {
      throw new AppError('git_error', `Repository access denied. ${detail}`, { params: { reason: 'git_auth' } });
    }
    if (/Remote branch .* not found|couldn't find remote ref/i.test(detail)) {
      throw new AppError('git_error', `Branch "${request.branch}" does not exist`, { params: { reason: 'git_branch' } });
    }
    throw new AppError('git_error', `git ${args[0]} failed: ${detail}`);
  }
  return result.stdout;
}

export async function checkout(request: CheckoutRequest): Promise<CommitInfo> {
  await rm(request.workDir, { recursive: true, force: true });
  await mkdir(request.workDir, { recursive: true, mode: 0o700 });

  let keyPath: string | null = null;
  if (request.deployKey) {
    keyPath = `${request.workDir}.key`;
    await writeFile(keyPath, request.deployKey.endsWith('\n') ? request.deployKey : `${request.deployKey}\n`, { mode: 0o600 });
  }
  const env = gitEnv(request, keyPath);

  try {
    if (request.commitSha) {
      // Fetch exactly the pushed commit so a fast follow-up push cannot change what is built.
      await git(['init', '--quiet', request.workDir], undefined, request, env);
      await git(['remote', 'add', 'origin', request.url], request.workDir, request, env);
      try {
        await git(['fetch', '--depth', '1', '--no-tags', '--progress', 'origin', request.commitSha], request.workDir, request, env);
      } catch (error) {
        // Some servers refuse fetching by SHA; fall back to the branch head.
        request.onOutput(`Fetching ${request.commitSha.slice(0, 7)} directly is not supported by this remote; using ${request.branch} head`);
        await git(['fetch', '--depth', '1', '--no-tags', '--progress', 'origin', request.branch], request.workDir, request, env).catch(() => {
          throw error;
        });
      }
      await git(['checkout', '--quiet', 'FETCH_HEAD'], request.workDir, request, env);
    } else {
      await git(
        ['clone', '--depth', '1', '--single-branch', '--no-tags', '--progress', '--branch', request.branch, request.url, request.workDir],
        undefined,
        request,
        env,
      );
    }

    // Submodules are fetched shallowly with the same credentials; a repo without them costs nothing.
    await git(['submodule', 'update', '--init', '--recursive', '--depth', '1'], request.workDir, request, env);

    const log = await git(['log', '-1', '--format=%H%x1f%an%x1f%s'], request.workDir, request, env);
    const [sha = '', author = '', message = ''] = log.trim().split('\x1f');
    return { sha, author, message };
  } finally {
    if (keyPath !== null) {
      await rm(keyPath, { force: true });
      await rm(`${keyPath}.known_hosts`, { force: true });
    }
  }
}

/** The remote URL to clone for an application source. */
export function cloneUrl(source: { sourceType: string; repository: string | null; gitUrl: string | null }): string {
  if (source.sourceType === 'github' && source.repository !== null) return `https://github.com/${source.repository}.git`;
  if (source.gitUrl !== null) return source.gitUrl;
  throw new AppError('bad_request', 'Application has no repository configured');
}

export async function removeWorkDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export const buildWorkDir = (dataDir: string, deploymentId: string): string => join(dataDir, 'builds', deploymentId);
