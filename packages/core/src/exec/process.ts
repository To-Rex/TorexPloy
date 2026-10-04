/**
 * Child-process execution.
 *
 * Every external command the platform runs (git, docker, npm) goes through
 * {@link runProcess}. Centralizing this gives one place to enforce:
 *
 * - **Timeouts** — a hung `docker build` cannot wedge a worker forever.
 * - **Abort** — deployments are cancellable.
 * - **Streaming output** — build logs reach the UI live, not after the fact.
 * - **No shell** — arguments are passed as an array, so a repository name
 *   containing `; rm -rf /` is inert data rather than a command.
 * - **Bounded buffers** — a runaway process cannot exhaust memory.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when the timeout fired and the process was killed. */
  timedOut: boolean;
  /** True when the caller aborted the run. */
  aborted: boolean;
  durationMs: number;
}

export interface RunProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Hard limit; the process is killed with SIGTERM then SIGKILL. */
  timeoutMs?: number;
  /** Cancel a running process. */
  signal?: AbortSignal;
  /** Called for each chunk of combined stdout/stderr, in arrival order. */
  onOutput?: (chunk: string) => void;
  /** Maximum characters retained per stream. Excess is dropped, not buffered. */
  maxBuffer?: number;
  /** Extra arguments for the command itself (not the child). */
  stdin?: string;
}

export class ProcessError extends Error {
  readonly result: ProcessResult;
  readonly command: string;

  constructor(command: string, result: ProcessResult) {
    super(`Command failed (${result.code ?? 'signal ' + String(result.signal)}): ${command}`);
    this.name = 'ProcessError';
    this.command = command;
    this.result = result;
  }
}

const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;

/**
 * Run a command to completion.
 *
 * Never throws for a non-zero exit — callers decide whether that is an error,
 * because many probes (`docker inspect`, `git rev-parse`) signal "no" via exit
 * code. Use {@link runProcessOrThrow} when failure is exceptional.
 */
export function runProcess(command: string, args: string[], options: RunProcessOptions = {}): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const startedAt = Date.now();
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        // `shell: false` is the default and is load-bearing: it is what makes
        // argument injection impossible.
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutDropped = 0;
    let stderrDropped = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const timeout = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          terminate(child);
        }, options.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      terminate(child);
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    /** SIGTERM first so the process can clean up, then SIGKILL if it ignores us. */
    function terminate(target: ChildProcess): void {
      if (target.exitCode !== null || target.signalCode !== null) return;
      target.kill('SIGTERM');
      const hardKill = setTimeout(() => {
        if (target.exitCode === null && target.signalCode === null) target.kill('SIGKILL');
      }, KILL_GRACE_MS);
      hardKill.unref();
    }

    const append = (stream: 'stdout' | 'stderr', chunk: string): void => {
      if (stream === 'stdout') {
        if (stdout.length < maxBuffer) stdout += chunk;
        else stdoutDropped += chunk.length;
      } else {
        if (stderr.length < maxBuffer) stderr += chunk;
        else stderrDropped += chunk.length;
      }
      options.onOutput?.(chunk);
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: string) => append('stderr', chunk));

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);

      if (stdoutDropped > 0) stdout += `\n[output truncated: ${stdoutDropped} characters dropped]`;
      if (stderrDropped > 0) stderr += `\n[output truncated: ${stderrDropped} characters dropped]`;

      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
      });
    });

    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

/** Run a command and reject with {@link ProcessError} on a non-zero exit. */
export async function runProcessOrThrow(
  command: string,
  args: string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const result = await runProcess(command, args, options);
  if (result.code !== 0) {
    throw new ProcessError(`${command} ${args.join(' ')}`, result);
  }
  return result;
}

/** Resolve the full path of a binary, or null when it is not installed. */
export async function which(binary: string): Promise<string | null> {
  const result = await runProcess(process.platform === 'win32' ? 'where' : 'which', [binary], { timeoutMs: 5_000 });
  if (result.code !== 0) return null;
  const first = result.stdout.split('\n')[0]?.trim();
  return first !== undefined && first.length > 0 ? first : null;
}

/** Check whether a binary exists and is runnable. */
export async function commandExists(binary: string): Promise<boolean> {
  return (await which(binary)) !== null;
}

/** Run a command and return trimmed stdout, or null if it failed. */
export async function runQuiet(command: string, args: string[], options: RunProcessOptions = {}): Promise<string | null> {
  const result = await runProcess(command, args, options);
  if (result.code !== 0) return null;
  return result.stdout.trim();
}