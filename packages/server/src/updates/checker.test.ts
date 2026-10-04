/**
 * The update checker against a scripted GitHub: what it reports for a newer
 * head, an unchanged one (304), rate limits and outages, and for builds whose
 * commit GitHub does not know. Plus the small pure helpers around it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '../context.ts';
import { createLogger } from '../lib/logger.ts';
import { UpdateChecker } from './checker.ts';
import { imageTag } from './launcher.ts';
import { isContainerId, runsInDocker } from './self.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

interface Script {
  /** Status and body for the branch head request. */
  head?: { status: number; sha?: string; headers?: Record<string, string> };
  /** Status and commits (oldest first) for the compare request. */
  compare?: { status: number; shas?: string[] };
  /** Reject every request (network down). */
  down?: boolean;
}

function githubCommit(sha: string, index: number): unknown {
  return {
    sha,
    html_url: `https://github.com/To-Rex/TorexPloy/commit/${sha}`,
    commit: { message: `Change ${index}\n\nLonger description.`, author: { name: 'Dev', date: `2026-10-0${index + 1}T10:00:00Z` }, committer: { date: `2026-10-0${index + 1}T10:00:00Z` } },
    author: index % 2 === 0 ? { login: 'torex' } : null,
  };
}

/** A `fetch` that plays GitHub from a script and records the requests it saw. */
function github(script: Script, calls: { url: string; headers: Record<string, string> }[]): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
    if (script.down) throw new TypeError('fetch failed: ECONNRESET');
    const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
      new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    if (url.includes('/commits/')) {
      const head = script.head ?? { status: 200, sha: B };
      if (head.status === 304) return json(304, null);
      if (head.status !== 200) return json(head.status, { message: head.status === 403 ? 'API rate limit exceeded for 1.2.3.4.' : 'Not Found' }, head.headers);
      return json(200, githubCommit(head.sha ?? B, 1), { etag: 'W/"etag-1"', ...head.headers });
    }
    if (url.includes('/compare/')) {
      const compare = script.compare ?? { status: 200, shas: [C, B] };
      if (compare.status !== 200) return json(compare.status, { message: 'Not Found' });
      const commits = (compare.shas ?? []).map((sha, index) => githubCommit(sha, index));
      return json(200, { ahead_by: commits.length, behind_by: 0, total_commits: commits.length, status: 'ahead', commits });
    }
    return json(404, { message: `unscripted ${url}` });
  };
}

function checker(script: Script, calls: { url: string; headers: Record<string, string> }[], options: { commit?: string | null; enabled?: boolean } = {}): UpdateChecker {
  const ctx = {
    config: {
      version: '0.1.0',
      commit: options.commit === undefined ? A : options.commit,
      updates: { enabled: options.enabled ?? true, repository: 'To-Rex/TorexPloy', branch: 'main', image: null, container: 'ploy-control', intervalMs: 3_600_000 },
    },
    logger: createLogger({ level: 'error', json: false }),
  } as unknown as Context;
  return new UpdateChecker(ctx, { fetch: github(script, calls), self: { inDocker: false } });
}

test('a newer head is reported with the commits in between, newest first, through GitHub conditional requests', async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const script: Script = { head: { status: 200, sha: B }, compare: { status: 200, shas: [C, B] } };
  const updates = checker(script, calls);
  assert.equal(updates.available, false, 'nothing is known before the first check');

  const result = await updates.check();
  assert.equal(result.checkError, null);
  assert.equal(result.available, true);
  assert.equal(result.latest?.commit, B);
  assert.equal(result.latest?.message, 'Change 1', 'first line of the message');
  assert.equal(result.latest?.url, `https://github.com/To-Rex/TorexPloy/commit/${B}`);
  assert.deepEqual(
    result.commits.map((commit) => [commit.sha, commit.message, commit.author]),
    [
      [B, 'Change 1', 'Dev'],
      [C, 'Change 0', 'torex'],
    ],
    'compare lists oldest first; the dashboard gets newest first; the GitHub login, else the git author',
  );
  assert.ok(result.checkedAt !== null);
  assert.equal(updates.available, true);

  assert.equal(calls[0]?.url, 'https://api.github.com/repos/To-Rex/TorexPloy/commits/main');
  assert.equal(calls[0]?.headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0]?.headers['User-Agent'], 'TorexPloy/0.1.0');
  assert.equal(calls[1]?.url, `https://api.github.com/repos/To-Rex/TorexPloy/compare/${A}...${B}?per_page=100`);

  // Unchanged head: the ETag goes back and the 304 keeps everything, with a fresh checkedAt.
  script.head = { status: 304 };
  const again = await updates.check();
  assert.equal(calls[2]?.headers['If-None-Match'], 'W/"etag-1"');
  assert.equal(calls.length, 3, 'no compare after a 304');
  assert.equal(again.latest?.commit, B);
  assert.equal(again.available, true);
  assert.equal(again.commits.length, 2);
  assert.equal(again.checkError, null);
});

test('rate limits and outages leave the previous result in place and explain themselves', async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const script: Script = {};
  const updates = checker(script, calls);
  const good = await updates.check();
  assert.equal(good.available, true);

  script.head = { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1760000000' } };
  const limited = await updates.check();
  assert.match(limited.checkError ?? '', /rate limit reached until \d\d:\d\d UTC/);
  assert.equal(limited.latest?.commit, B, 'the last good answer is kept');
  assert.equal(limited.available, true);
  assert.equal(limited.commits.length, 2);

  script.head = undefined;
  script.down = true;
  const offline = await updates.check();
  assert.match(offline.checkError ?? '', /^GitHub is unreachable: /);
  assert.equal(offline.latest?.commit, B);
  assert.equal(offline.available, true);

  script.down = false;
  script.head = { status: 404 };
  const missing = await updates.check();
  assert.equal(missing.checkError, 'To-Rex/TorexPloy@main was not found on GitHub');
  assert.equal(missing.available, true);
});

test('a build without a known commit treats any published head as an update, and one at the head is up to date', async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const unknown = await checker({}, calls, { commit: null }).check();
  assert.equal(unknown.available, true);
  assert.deepEqual(unknown.commits, []);
  assert.equal(unknown.latest?.commit, B);
  assert.equal(calls.length, 1, 'nothing to compare against');

  calls.length = 0;
  const current = await checker({ head: { status: 200, sha: A } }, calls, { commit: A }).check();
  assert.equal(current.available, false);
  assert.deepEqual(current.commits, []);
  assert.equal(current.latest?.commit, A);
  assert.equal(calls.length, 1, 'the head is the running commit: no compare');

  // A short PLOY_COMMIT (a build arg from `git rev-parse --short`) still matches its head.
  calls.length = 0;
  const short = await checker({ head: { status: 200, sha: A } }, calls, { commit: A.slice(0, 7) }).check();
  assert.equal(short.available, false);
});

test('a running commit GitHub never saw (a local build) differs without a commit list; a disabled checker never goes online', async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const local = await checker({ compare: { status: 404 } }, calls).check();
  assert.equal(local.available, true);
  assert.deepEqual(local.commits, []);
  assert.equal(local.checkError, null);
  assert.equal(local.latest?.commit, B);

  calls.length = 0;
  const off = checker({}, calls, { enabled: false });
  off.start();
  const result = await off.check();
  off.stop();
  assert.equal(calls.length, 0);
  assert.equal(result.available, false);
  assert.equal(result.checkError, null);
  assert.equal(result.latest, null);
});

test('concurrent checks share one round of requests', async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const updates = checker({}, calls);
  const [first, second] = await Promise.all([updates.check(), updates.check()]);
  assert.equal(first, second);
  assert.equal(calls.length, 2, 'one head request and one compare');
});

test('container detection: Docker hostnames, /.dockerenv, and the tag the new image gets', () => {
  assert.equal(isContainerId('c0ffee000001'), true);
  assert.equal(isContainerId('c'.repeat(64)), true);
  assert.equal(isContainerId('my-laptop'), false);
  assert.equal(isContainerId('C0FFEE000001'), false);
  assert.equal(runsInDocker({ HOSTNAME: 'my-laptop' }, () => false), false);
  assert.equal(runsInDocker({ HOSTNAME: 'my-laptop' }, (path) => path === '/.dockerenv'), true);
  assert.equal(runsInDocker({ HOSTNAME: 'c0ffee000001' }, () => false), true);

  assert.equal(imageTag('torexploy:latest'), 'torexploy:latest');
  assert.equal(imageTag('torexploy'), 'torexploy:latest');
  assert.equal(imageTag('ghcr.io/to-rex/torexploy:main'), 'ghcr.io/to-rex/torexploy:main');
  assert.equal(imageTag('ghcr.io/to-rex/torexploy:main@sha256:' + 'd'.repeat(64)), 'ghcr.io/to-rex/torexploy:main');
  assert.equal(imageTag('localhost:5000/torexploy'), 'localhost:5000/torexploy:latest');
  assert.equal(imageTag('sha256:' + 'd'.repeat(64)), 'torexploy:latest');
});
