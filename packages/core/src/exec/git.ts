/**
 * Git operations.
 *
 * Deployments build from a real commit, so the platform needs to clone, fetch
 * and read commit metadata. Two safety properties matter here:
 *
 * 1. **No credential leakage.** Tokens are never placed in the clone URL that
 *    ends up in `.git/config` or in a log line. They are injected through a
 *    per-invocation `http.extraHeader`, which git keeps out of the repo.
 * 2. **No shell.** Every invocation passes an argument array.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess, runProcessOrThrow, runQuiet } from './process.ts';
import { AppError } from '../errors.ts';

export interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  branch: string;
  committedAt: string;
}

export interface GitContext {
  /** Absolute directory that will contain the checkout. */
  workDir: string;
  repoUrl: string;
  branch: string;
  /** Token for private repositories; never persisted to disk. */
  token?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
}

/**
 * Build the argument list that authenticates a request without persisting the
 * credential. `-c http.extraHeader=...` applies to a single git invocation.
 */
function authArgs(url: string, token: string | null | undefined): string[] {
  if (token === null || token === undefined || token.length === 0) return [];
  if (!url.startsWith('https://')) return [];

  // GitHub accepts a token as the HTTP basic password with any username.
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return ['-c', `http.https://${new URL(url).host}/.extraHeader=Authorization: Basic ${basic}`];
}

/** Strip credentials that may be embedded in a URL so they never reach a log. */
export function sanitizeRepoUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Reject repository URLs that would let git execute a local program.
 *
 * Applied at the API boundary, where the URL is untrusted input from a user.
 * It is deliberately *not* applied inside the git operations themselves: the
 * `local` source type legitimately deploys from a directory on the server, and
 * the platform must be able to build its own test fixtures and self-deploys.
 */
export function assertPublicRepoUrl(url: string): void {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    throw new AppError('bad_request', 'Repository URL is required');
  }
  if (/^(ext|file|ssh|git):/i.test(trimmed) || trimmed.startsWith('/')) {
    throw new AppError('bad_request', 'Repository URL must use https:// (git, ssh, file and ext transports are not allowed)', {
      details: { url: sanitizeRepoUrl(trimmed) },
    });
  }
  if (!/^https:\/\//.test(trimmed)) {
    throw new AppError('bad_request', 'Repository URL must use https://', {
      details: { url: sanitizeRepoUrl(trimmed) },
    });
  }
}

/** Ensure the checkout directory exists and contains a clone of the branch. */
export async function ensureClone(context: GitContext): Promise<void> {
  if (context.repoUrl.trim().length === 0) {
    throw new AppError('bad_request', 'Repository URL is required');
  }
  const timeoutMs = context.timeoutMs ?? 300_000;
  const gitDir = join(context.workDir, '.git');

  // The directory must exist before git runs with it as `cwd`: spawning with a
  // missing working directory fails with ENOENT, which is indistinguishable
  // from a missing git binary and would break every first deployment.
  await mkdir(context.workDir, { recursive: true });

  const exists = await runQuiet('git', ['rev-parse', '--git-dir'], { cwd: context.workDir, timeoutMs: 15_000 });

  if (exists === null) {
    // A partial checkout from a previous failed run would break the clone.
    await rm(gitDir, { recursive: true, force: true });

    const args = [
      ...authArgs(context.repoUrl, context.token),
      'clone',
      '--depth',
      '1',
      '--branch',
      context.branch,
      '--single-branch',
      '--no-tags',
      context.repoUrl,
      context.workDir,
    ];
    await runProcessOrThrow('git', args, {
      timeoutMs,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.onOutput === undefined ? {} : { onOutput: context.onOutput }),
    });
    return;
  }

  await fetchAndReset(context);
}

/** Update an existing checkout to the tip of the configured branch. */
export async function fetchAndReset(context: GitContext): Promise<void> {
  const timeoutMs = context.timeoutMs ?? 300_000;
  const base = authArgs(context.repoUrl, context.token);
  const runOptions = {
    cwd: context.workDir,
    timeoutMs,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.onOutput === undefined ? {} : { onOutput: context.onOutput }),
  };

  await runProcessOrThrow('git', [...base, 'fetch', '--depth', '1', 'origin', context.branch], runOptions);
  // `reset --hard` rather than `pull`: the build directory is disposable, and a
  // merge conflict must never be able to fail a deployment.
  await runProcessOrThrow('git', ['reset', '--hard', 'FETCH_HEAD'], runOptions);
  await runProcessOrThrow('git', ['clean', '-ffdx', '-e', 'node_modules'], runOptions);
}

/** Read the commit currently checked out. */
export async function readCommitInfo(workDir: string, branch: string): Promise<CommitInfo> {
  // Unit separator (\x1f) keeps multi-line commit messages parseable.
  const format = '%H%x1f%h%x1f%s%x1f%an%x1f%aI';
  const output = await runQuiet('git', ['log', '-1', `--format=${format}`], { cwd: workDir, timeoutMs: 15_000 });
  if (output === null) {
    throw new AppError('git_error', 'Unable to read commit information from the checkout', { details: { workDir } });
  }

  const [sha = '', shortSha = '', message = '', author = '', committedAt = ''] = output.split('\x1f');
  return { sha, shortSha, message, author, committedAt, branch };
}

/** Current branch name, or null for a detached HEAD. */
export async function currentBranch(workDir: string): Promise<string | null> {
  const result = await runQuiet('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workDir, timeoutMs: 15_000 });
  return result === null || result === 'HEAD' ? null : result;
}

/** List remote branches. Used by the dashboard to offer a branch picker. */
export async function listRemoteBranches(repoUrl: string, token?: string | null, timeoutMs = 60_000): Promise<string[]> {
  const result = await runProcess('git', [...authArgs(repoUrl, token), 'ls-remote', '--heads', repoUrl], { timeoutMs });
  if (result.code !== 0) {
    throw new AppError('git_error', 'Unable to list branches for the repository', {
      details: { url: sanitizeRepoUrl(repoUrl), stderr: result.stderr.slice(0, 500) },
    });
  }

  return result.stdout
    .split('\n')
    .map((line) => line.split('refs/heads/')[1]?.trim())
    .filter((name): name is string => name !== undefined && name.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

/** Verify a repository is reachable and the branch exists. */
export async function verifyRepository(
  repoUrl: string,
  branch: string,
  token?: string | null,
  timeoutMs = 60_000,
): Promise<{ ok: true; branches: string[] } | { ok: false; error: string }> {
  try {
    const branches = await listRemoteBranches(repoUrl, token, timeoutMs);
    if (branches.length === 0) return { ok: false, error: 'Repository has no branches' };
    if (!branches.includes(branch)) {
      return { ok: false, error: `Branch "${branch}" was not found (available: ${branches.slice(0, 10).join(', ')})` };
    }
    return { ok: true, branches };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Remove a checkout directory. Failures are tolerated: it is disposable state. */
export async function removeWorkDir(workDir: string): Promise<void> {
  await rm(workDir, { recursive: true, force: true });
}