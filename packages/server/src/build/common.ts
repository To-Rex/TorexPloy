/**
 * What the external builders (Nixpacks, Railpack, Cloud Native Buildpacks)
 * share: the request they get from the dispatcher, the environment their
 * CLIs run with, output streaming and the mapping of failures to errors.
 *
 * Every CLI reaches the deployment's Docker daemon through `DOCKER_HOST`
 * (the local socket or an SSH tunnel) with an isolated `DOCKER_CONFIG` that
 * carries the team's registry logins, exactly like {@link buildImage} does.
 * Build variables are handed over by name: each CLI reads the value from its
 * own environment, so no secret appears on a command line.
 */
import { join } from 'node:path';
import type { BuildType } from '@ploy/shared';
import { LABEL_APP, LABEL_DEPLOYMENT, LABEL_MANAGED } from '../docker/naming.ts';
import type { CliAuths } from '../docker/registry.ts';
import { AppError } from '../lib/errors.ts';
import { runProcess, type ProcessResult } from '../lib/process.ts';

/** The build settings an external builder may honour. */
export interface ExternalSettings {
  buildType: BuildType;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  /** Buildpacks: the builder image, or the vendor's default when null. */
  buildpackBuilder: string | null;
}

export interface ExternalBuildRequest {
  dockerHost: string;
  contextDir: string;
  /** Scratch directory outside the context for plans, CLI config and caches. */
  scratchDir: string;
  imageTag: string;
  applicationId: string;
  deploymentId: string;
  settings: ExternalSettings;
  buildEnv: Record<string, string>;
  /** The team's registry logins, so builder and base images may be private. */
  registryAuths: CliAuths;
  noCache: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput: (line: string) => void;
}

/** What an external builder produced, in the shape the deployer reads next to TorexBuilder's plans. */
export interface ExternalPlan {
  mode: 'external';
  stack: BuildType;
  /** Human-readable summary for the log, e.g. "Railpack · node 22.23.2". */
  label: string;
  dockerfile: null;
  dockerfilePath: '';
  defaultPort: null;
  startCommand: string | null;
  /** Things worth fixing before deploying. */
  warnings: string[];
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Variables that would change how the CLI itself runs rather than configure the build. */
const RESERVED_ENV_RE = /^(PATH|HOME|TMPDIR|TMP|TEMP|USER|SHELL|NO_COLOR|PACK_HOME|DOCKER_.*|BUILDKIT_.*)$/;

/** The build variables a CLI may be told to read from its environment (`--env NAME`). */
export function envNames(env: Record<string, string>): string[] {
  return Object.keys(env).filter((key) => ENV_NAME_RE.test(key) && !RESERVED_ENV_RE.test(key));
}

/** The environment every builder CLI runs with: the deployment's daemon and CLI config, plain output. */
export function builderEnv(request: Pick<ExternalBuildRequest, 'dockerHost' | 'scratchDir'>): Record<string, string> {
  return {
    DOCKER_HOST: request.dockerHost,
    DOCKER_BUILDKIT: '1',
    BUILDKIT_PROGRESS: 'plain',
    DOCKER_CLI_HINTS: 'false',
    // The CLI must not pick up an operator's personal contexts or config; this one is the deployment's own.
    DOCKER_CONFIG: join(request.scratchDir, 'docker-config'),
    NO_COLOR: '1',
  };
}

/** {@link builderEnv} plus the values of `names` from the build variables (the platform's own keys win). */
export function childEnv(request: Pick<ExternalBuildRequest, 'dockerHost' | 'scratchDir' | 'buildEnv'>, names: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) env[name] = request.buildEnv[name] ?? '';
  return { ...env, ...builderEnv(request) };
}

/** `key=value` labels that mark an image as this deployment's. */
export function imageLabels(request: Pick<ExternalBuildRequest, 'applicationId' | 'deploymentId'>): string[] {
  return [`${LABEL_MANAGED}=true`, `${LABEL_APP}=${request.applicationId}`, `${LABEL_DEPLOYMENT}=${request.deploymentId}`];
}

/** Splits streamed chunks into log lines, holding a partial line until it completes. */
export function lineSplitter(onLine: (line: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim().length > 0) onLine(line.trimEnd());
    },
    flush() {
      if (pending.trim().length > 0) onLine(pending.trimEnd());
      pending = '';
    },
  };
}

/** The last lines of stderr that explain a failure, for the error message. */
export function failureTail(stderr: string, max = 2): string {
  const lines = stderr
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\[output truncated/.test(line));
  const telling = lines.filter((line) => /error|failed|fatal|panic|cannot|could not|unable|not found/i.test(line));
  return (telling.length > 0 ? telling : lines)
    .slice(-max)
    .map((line) => line.replace(/^#\d+\s*/, ''))
    .join(' ');
}

export interface BuilderRun {
  /** Name for messages: "nixpacks", "pack", "docker buildx build". */
  tool: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput: (line: string) => void;
  /** Characters of stdout and stderr kept for parsing and error messages. */
  maxBuffer?: number;
}

/**
 * Run a builder CLI to completion, streaming its output to the log. A missing
 * binary, a cancellation, a timeout and a failure each become the error the
 * deployer records; the result is returned for callers that parse stdout.
 */
export async function runBuilder(command: string, run: BuilderRun): Promise<ProcessResult> {
  const lines = lineSplitter(run.onOutput);
  let result: ProcessResult;
  try {
    result = await runProcess(command, run.args, {
      env: run.env,
      ...(run.cwd === undefined ? {} : { cwd: run.cwd }),
      timeoutMs: run.timeoutMs,
      ...(run.signal === undefined ? {} : { signal: run.signal }),
      maxBuffer: run.maxBuffer ?? 256 * 1024,
      onOutput: (chunk) => lines.push(chunk),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError('docker_unavailable', `${command} is not installed on the control plane`, { params: { reason: 'builder_missing', builder: command } });
    }
    throw error;
  }
  lines.flush();
  if (result.aborted) throw new AppError('bad_request', 'Build cancelled');
  if (result.timedOut) {
    throw new AppError('bad_request', `Build exceeded the ${Math.round(run.timeoutMs / 60_000)} minute limit`, { params: { reason: 'build_timeout' } });
  }
  if (result.code !== 0) {
    const tail = failureTail(result.stderr);
    throw new AppError('bad_request', `${run.tool} failed${tail.length > 0 ? `: ${tail}` : ` (exit code ${result.code ?? 'signal'})`}`, { params: { reason: 'build_failed' } });
  }
  return result;
}
