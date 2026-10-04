/**
 * Update checker: is the tracked branch ahead of the running build?
 *
 * Every few hours (and on demand from the dashboard) the head of
 * `owner/name@branch` is read from the GitHub API. When the running commit is
 * known and differs, the commits in between are listed through the compare
 * endpoint; an install that was built without `PLOY_COMMIT` cannot tell where
 * it stands, so any published head counts as an update for it.
 *
 * The check never throws: a failure is kept as `checkError` next to the last
 * good result. Conditional requests (ETag → 304) keep the periodic polls out
 * of GitHub's rate limit.
 */
import type { UpdateCommitDto } from '@ploy/shared';
import type { Context } from '../context.ts';
import { errorMessage } from '../lib/errors.ts';
import { SelfLocator, type SelfOptions } from './self.ts';

export interface LatestCommit {
  commit: string;
  /** First line of the commit message. */
  message: string;
  date: string;
  url: string;
}

export interface CheckResult {
  latest: LatestCommit | null;
  /** The branch has commits the running build does not (or the running commit is unknown). */
  available: boolean;
  /** Newest first, at most {@link MAX_COMMITS}. */
  commits: UpdateCommitDto[];
  checkedAt: string | null;
  checkError: string | null;
}

export interface CheckerOptions {
  /** Replaces the global `fetch` (tests). */
  fetch?: typeof fetch;
  self?: SelfOptions;
  /** How long after `start()` the first check runs. */
  startDelayMs?: number;
}

const API = 'https://api.github.com';
const MAX_COMMITS = 30;
/** Commits per compare page (GitHub's maximum). */
const PAGE = 100;
const START_DELAY_MS = 20_000;
const TIMEOUT_MS = 10_000;

interface GithubCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name?: string; date?: string } | null; committer: { date?: string } | null };
  author: { login: string } | null;
}

interface GithubCompare {
  ahead_by: number;
  total_commits: number;
  commits: GithubCommit[];
}

class GithubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GithubError';
    this.status = status;
  }
}

function toDto(commit: GithubCommit): UpdateCommitDto {
  return {
    sha: commit.sha,
    message: commit.commit.message.split('\n')[0]?.trim() ?? '',
    date: commit.commit.author?.date ?? commit.commit.committer?.date ?? '',
    author: commit.author?.login ?? commit.commit.author?.name ?? null,
    url: commit.html_url,
  };
}

const EMPTY: CheckResult = { latest: null, available: false, commits: [], checkedAt: null, checkError: null };

export class UpdateChecker {
  /** Where this process runs (its own container, when it has one). */
  readonly self: SelfLocator;
  private readonly ctx: Pick<Context, 'config' | 'logger'>;
  private readonly fetchImpl: typeof fetch;
  private readonly startDelayMs: number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inFlight: Promise<CheckResult> | null = null;
  private etag: string | null = null;
  private current: CheckResult = EMPTY;

  constructor(ctx: Context, options: CheckerOptions = {}) {
    this.ctx = ctx;
    this.self = new SelfLocator(ctx, options.self);
    this.fetchImpl = options.fetch ?? fetch;
    this.startDelayMs = options.startDelayMs ?? START_DELAY_MS;
  }

  get result(): CheckResult {
    return this.current;
  }

  get checking(): boolean {
    return this.inFlight !== null;
  }

  /** True when the last check found a newer commit. */
  get available(): boolean {
    return this.current.available;
  }

  start(): void {
    const { updates } = this.ctx.config;
    if (!updates.enabled) {
      this.ctx.logger.info('Update checks are disabled (PLOY_UPDATE_CHECK=false)');
      return;
    }
    this.ctx.logger.debug('Update checks enabled', { repository: updates.repository, branch: updates.branch, intervalMs: updates.intervalMs });
    this.schedule(this.startDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check().finally(() => this.schedule(this.ctx.config.updates.intervalMs));
    }, delayMs);
    this.timer.unref();
  }

  /** Run a check now (a check already running is shared, not duplicated). */
  check(): Promise<CheckResult> {
    if (this.inFlight === null) {
      this.inFlight = this.run().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async run(): Promise<CheckResult> {
    const { updates, commit } = this.ctx.config;
    if (!updates.enabled) {
      this.current = { ...EMPTY, checkedAt: new Date().toISOString() };
      return this.current;
    }
    const previous = this.current;
    try {
      const head = await this.head();
      if (head === null) {
        // 304: nothing moved since the last successful check.
        this.current = { ...previous, checkedAt: new Date().toISOString(), checkError: null };
        return this.current;
      }
      const { available, commits } = await this.ahead(commit, head.commit);
      this.current = { latest: head, available, commits, checkedAt: new Date().toISOString(), checkError: null };
      if (available && (previous.latest?.commit !== head.commit || !previous.available)) {
        this.ctx.logger.info('A newer TorexPloy is available', { commit: head.commit.slice(0, 7), running: commit?.slice(0, 7) ?? 'unknown', commits: commits.length });
      }
    } catch (error) {
      const message = errorMessage(error);
      this.ctx.logger.warn('Update check failed', { error: message });
      this.current = { ...previous, checkedAt: new Date().toISOString(), checkError: message };
    }
    return this.current;
  }

  /** The branch head, or null when GitHub says it has not changed since the last answer. */
  private async head(): Promise<LatestCommit | null> {
    const { repository, branch } = this.ctx.config.updates;
    const response = await this.github(`/repos/${repository}/commits/${encodeURIComponent(branch)}`, this.etag === null ? {} : { 'If-None-Match': this.etag });
    if (response.status === 304) return null;
    const data = (await response.json()) as GithubCommit;
    this.etag = response.headers.get('etag');
    const dto = toDto(data);
    return { commit: dto.sha, message: dto.message, date: dto.date, url: dto.url };
  }

  /** What `latest` has over the running commit. */
  private async ahead(running: string | null, latest: string): Promise<{ available: boolean; commits: UpdateCommitDto[] }> {
    if (running === null) return { available: true, commits: [] };
    if (latest.startsWith(running)) return { available: false, commits: [] };
    const { repository } = this.ctx.config.updates;
    const path = `/repos/${repository}/compare/${running}...${latest}`;
    let first: GithubCompare;
    try {
      first = (await (await this.github(`${path}?per_page=${PAGE}`)).json()) as GithubCompare;
    } catch (error) {
      // A commit GitHub never saw (a local build, a rewritten branch): it differs, that is all we know.
      if (error instanceof GithubError && error.status === 404) return { available: true, commits: [] };
      throw error;
    }
    let commits = first.commits;
    if (first.total_commits > commits.length) {
      // The range is paginated oldest first; the newest commits sit on the last pages.
      const lastPage = Math.ceil(first.total_commits / PAGE);
      for (const page of lastPage > 2 ? [lastPage - 1, lastPage] : [lastPage]) {
        commits = commits.concat(((await (await this.github(`${path}?per_page=${PAGE}&page=${page}`)).json()) as GithubCompare).commits);
      }
    }
    return { available: first.ahead_by > 0, commits: commits.reverse().slice(0, MAX_COMMITS).map(toDto) };
  }

  private async github(path: string, headers: Record<string, string> = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${API}${path}`, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': `TorexPloy/${this.ctx.config.version}`, ...headers },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new GithubError(0, `GitHub is unreachable: ${errorMessage(error)}`);
    }
    if (response.ok || response.status === 304) return response;
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    if ((response.status === 403 || response.status === 429) && (response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(body.message ?? ''))) {
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const until = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` : '';
      throw new GithubError(response.status, `GitHub API rate limit reached${until}; the check is retried later`);
    }
    if (response.status === 404) {
      const { repository, branch } = this.ctx.config.updates;
      throw new GithubError(404, `${repository}@${branch} was not found on GitHub`);
    }
    throw new GithubError(response.status, `GitHub API ${response.status}: ${body.message ?? response.statusText}`);
  }
}
