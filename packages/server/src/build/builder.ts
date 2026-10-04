/**
 * Image builds through BuildKit (`docker buildx build`).
 *
 * The CLI is used here, and only here, because BuildKit's session protocol
 * (context upload, secrets, cache mounts, cancellation) is what the CLI
 * implements; re-implementing it over the raw API would be fragile. The CLI
 * talks to the same socket as the API client — the local daemon or an SSH
 * tunnel — so remote builds run on the target server's own BuildKit cache.
 *
 * Variables:
 * - User Dockerfiles receive build variables as `--build-arg NAME` with the
 *   value supplied through the child's environment, never on the command line.
 * - Generated Dockerfiles read them from a BuildKit secret mount, so they are
 *   absent from image layers and `docker history` entirely.
 */
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LABEL_APP, LABEL_DEPLOYMENT, LABEL_MANAGED } from '../docker/naming.ts';
import { AppError } from '../lib/errors.ts';
import { runProcess } from '../lib/process.ts';
import { renderEnvFile, type BuildPlan } from './detect.ts';

export interface BuildRequest {
  dockerHost: string;
  plan: BuildPlan;
  contextDir: string;
  /** Scratch directory outside the context for the generated Dockerfile and secret file. */
  scratchDir: string;
  imageTag: string;
  applicationId: string;
  deploymentId: string;
  buildEnv: Record<string, string>;
  noCache: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput: (line: string) => void;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** BuildKit plain progress lines worth keeping; the rest is timing noise. */
function keepLine(line: string): boolean {
  if (line.length === 0) return false;
  if (/^#\d+ (sha256:|extracting sha256|\[internal\] load (metadata|\.dockerignore))/.test(line)) return false;
  return true;
}

export async function buildImage(request: BuildRequest): Promise<{ durationMs: number }> {
  const started = Date.now();
  await mkdir(request.scratchDir, { recursive: true, mode: 0o700 });
  const secretPath = join(request.scratchDir, 'build.env');

  const args = ['buildx', 'build', '--progress=plain', '--load', '--tag', request.imageTag];
  args.push('--label', `${LABEL_MANAGED}=true`, '--label', `${LABEL_APP}=${request.applicationId}`, '--label', `${LABEL_DEPLOYMENT}=${request.deploymentId}`);
  if (request.noCache) args.push('--no-cache');

  const env: Record<string, string> = {
    DOCKER_HOST: request.dockerHost,
    DOCKER_BUILDKIT: '1',
    BUILDKIT_PROGRESS: 'plain',
    DOCKER_CLI_HINTS: 'false',
    // The CLI must not pick up an operator's personal contexts or config.
    DOCKER_CONFIG: join(request.scratchDir, 'docker-config'),
  };

  if (request.plan.mode === 'generated') {
    const dockerfile = join(request.scratchDir, 'Dockerfile');
    await writeFile(dockerfile, `${request.plan.dockerfile}\n`, { mode: 0o600 });
    // A Dockerfile-specific ignore file: the repository's rules plus VCS metadata.
    const repoIgnore = await readFile(join(request.contextDir, '.dockerignore'), 'utf8').catch(() => '');
    await writeFile(`${dockerfile}.dockerignore`, `${repoIgnore}\n.git\n`, { mode: 0o600 });
    await writeFile(secretPath, `${renderEnvFile(request.buildEnv)}\n`, { mode: 0o600 });
    args.push('--file', dockerfile, '--secret', `id=ploy_env,src=${secretPath}`);
  } else {
    args.push('--file', join(request.contextDir, request.plan.dockerfilePath));
    for (const [key, value] of Object.entries(request.buildEnv)) {
      if (!ENV_NAME_RE.test(key)) continue;
      args.push('--build-arg', key);
      env[key] = value;
    }
  }
  args.push(request.contextDir);

  await mkdir(env.DOCKER_CONFIG!, { recursive: true, mode: 0o700 });
  await mkdir(dirname(secretPath), { recursive: true });

  let pending = '';
  try {
    const result = await runProcess('docker', args, {
      env,
      timeoutMs: request.timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      maxBuffer: 256 * 1024,
      onOutput: (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) if (keepLine(line.trimEnd())) request.onOutput(line.trimEnd());
      },
    });
    if (pending.trim().length > 0) request.onOutput(pending.trimEnd());

    if (result.aborted) throw new AppError('bad_request', 'Build cancelled');
    if (result.timedOut) {
      throw new AppError('bad_request', `Build exceeded the ${Math.round(request.timeoutMs / 60_000)} minute limit`, { params: { reason: 'build_timeout' } });
    }
    if (result.code !== 0) {
      if (/unknown command: docker buildx|'buildx' is not a docker command/i.test(result.stderr)) {
        throw new AppError('docker_unavailable', 'docker buildx is not installed on the control plane', { params: { reason: 'buildx_missing' } });
      }
      const tail = result.stderr.trim().split('\n').filter((line) => /ERROR|error:|failed/i.test(line)).slice(-2).join(' ');
      throw new AppError('bad_request', `Build failed${tail.length > 0 ? `: ${tail.replace(/^#\d+\s*/, '')}` : ''}`, { params: { reason: 'build_failed' } });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError('docker_unavailable', 'The docker CLI is not installed on the control plane');
    }
    throw error;
  } finally {
    await rm(secretPath, { force: true });
  }
  return { durationMs: Date.now() - started };
}
