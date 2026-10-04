/**
 * Docker engine — the production execution path.
 *
 * Security decisions, all deliberate:
 *
 * - **Secrets never touch the process list.** Environment variables are written
 *   to a 0600 env file and passed with `--env-file`. Passing them as `-e K=V`
 *   would expose every secret to any user who can run `ps`.
 * - **Least privilege.** Containers run with `--cap-drop ALL` and
 *   `--security-opt no-new-privileges`, so a compromised application cannot
 *   escalate inside the container or gain capabilities it never needed.
 * - **Resource ceilings.** `--cpus` and `--memory` are always applied, so one
 *   runaway application cannot starve the host.
 * - **No published ports.** Applications join a shared Docker network and the
 *   reverse proxy reaches them by container name. Nothing is bound to the host,
 *   so applications are not reachable except through the proxy (which enforces
 *   TLS and routing).
 * - **No shell.** Every command is an argument array.
 *
 * Build caching uses BuildKit inline cache metadata (`BUILDKIT_INLINE_CACHE=1`)
 * combined with `--cache-from`, which is the approach that works with the
 * default Docker driver. Cache exports to a local directory are not supported
 * by that driver, so the platform does not pretend otherwise.
 */
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess, runQuiet, runProcessOrThrow } from './process.ts';
import type {
  BuildRequest,
  BuildResult,
  ContainerEngine,
  ContainerInfo,
  ContainerRef,
  ContainerSpec,
  ContainerStats,
  EngineInfo,
  EngineName,
} from './engine.ts';
import { AppError } from '../errors.ts';

export interface DockerEngineOptions {
  /** Path to the docker binary. */
  binary?: string;
  /** Directory for generated env files (must be private). */
  stateDir: string;
  /** Extra `docker` arguments, e.g. `['--context', 'prod']`. */
  globalArgs?: string[];
}

interface DockerStatsFormat {
  CPUPerc?: string;
  MemUsage?: string;
  MemPerc?: string;
  NetIO?: string;
}

/** Parse Docker's human byte sizes: `12.3MiB`, `1.2kB`, `0B`. */
export function parseDockerBytes(value: string): number {
  const match = /^\s*([0-9.]+)\s*([a-zA-Z]*)\s*$/.exec(value);
  if (match === null) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;

  const unit = (match[2] ?? '').toLowerCase();
  const multiplier: Record<string, number> = {
    b: 1,
    kb: 1_000,
    kib: 1_024,
    mb: 1_000_000,
    mib: 1_048_576,
    gb: 1_000_000_000,
    gib: 1_073_741_824,
    tb: 1_000_000_000_000,
    tib: 1_099_511_627_776,
  };
  return Math.round(amount * (multiplier[unit] ?? 1));
}

/** Parse `12.3MiB / 512MiB` into used and limit bytes. */
export function parseMemoryPair(value: string): { used: number; limit: number } {
  const [usedPart = '0B', limitPart = '0B'] = value.split('/');
  return { used: parseDockerBytes(usedPart), limit: parseDockerBytes(limitPart) };
}

export class DockerEngine implements ContainerEngine {
  readonly name: EngineName = 'docker';

  private readonly binary: string;
  private readonly stateDir: string;
  private readonly globalArgs: string[];
  private cachedInfo: EngineInfo | null = null;

  constructor(options: DockerEngineOptions) {
    this.binary = options.binary ?? 'docker';
    this.stateDir = options.stateDir;
    this.globalArgs = options.globalArgs ?? [];
  }

  private args(...rest: string[]): string[] {
    return [...this.globalArgs, ...rest];
  }

  async probe(): Promise<EngineInfo> {
    // `probe` must never throw: it is how the platform decides whether Docker
    // is usable at all. A missing binary or an unreachable daemon is an answer
    // (`available: false`), not an exception — otherwise startup would crash on
    // every host that has no container runtime instead of falling back.
    let version: string | null = null;
    let detail = 'Docker daemon is not reachable. Is the socket mounted and the daemon running?';
    try {
      version = await runQuiet(this.binary, this.args('version', '--format', '{{.Server.Version}}'), {
        timeoutMs: 15_000,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        detail = `Docker binary "${this.binary}" was not found on PATH`;
      } else {
        detail = `Unable to run docker: ${error instanceof Error ? error.message : String(error)}`;
      }
      version = null;
    }

    if (version === null || version.length === 0) {
      const info: EngineInfo = { name: 'docker', available: false, version: null, detail };
      this.cachedInfo = info;
      return info;
    }

    const info: EngineInfo = { name: 'docker', available: true, version, detail: null };
    this.cachedInfo = info;
    return info;
  }

  private async requireAvailable(): Promise<void> {
    const info = this.cachedInfo ?? (await this.probe());
    if (!info.available) {
      throw new AppError('engine_unavailable', info.detail ?? 'Docker is unavailable');
    }
  }

  async ensureNetwork(name: string): Promise<void> {
    await this.requireAvailable();
    const existing = await runQuiet(this.binary, this.args('network', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}'), {
      timeoutMs: 30_000,
    });
    if (existing === name) return;
    await runQuiet(this.binary, this.args('network', 'create', '--attachable', name), { timeoutMs: 30_000 });
  }

  async ensureVolume(name: string): Promise<string> {
    await this.requireAvailable();
    const result = await runProcess(this.binary, this.args('volume', 'create', name), { timeoutMs: 30_000 });
    if (result.code !== 0 && !/already exists/i.test(result.stderr)) {
      throw new AppError('engine_unavailable', `Unable to create volume ${name}`, {
        details: { stderr: result.stderr.slice(0, 300) },
      });
    }
    return name;
  }

  async build(request: BuildRequest, onOutput: (chunk: string) => void, signal?: AbortSignal): Promise<BuildResult> {
    await this.requireAvailable();
    const startedAt = Date.now();

    const args = this.args(
      'build',
      '--tag', request.imageTag,
      '--file', request.dockerfilePath,
      // Inline cache metadata makes the previous image reusable as a cache source.
      '--build-arg', 'BUILDKIT_INLINE_CACHE=1',
      ...(request.noCache === true ? ['--no-cache'] : ['--cache-from', request.imageTag]),
      ...Object.entries(request.buildArgs ?? {}).flatMap(([key, value]) => ['--build-arg', `${key}=${value}`]),
      request.contextDir,
    );

    const result = await runProcess(this.binary, args, {
      env: { DOCKER_BUILDKIT: '1' },
      timeoutMs: 60 * 60_000,
      onOutput,
      ...(signal === undefined ? {} : { signal }),
    });

    if (result.code !== 0) {
      throw new AppError('build_failed', 'Docker build failed', {
        details: {
          exitCode: result.code,
          stderr: result.stderr.slice(-2_000),
          timedOut: result.timedOut,
        },
      });
    }

    const output = `${result.stdout}\n${result.stderr}`;
    // BuildKit reports reuse as `CACHED`; the count is a useful deployment signal.
    const cached = /CACHED/.test(output);

    return { imageTag: request.imageTag, cached, durationMs: Date.now() - startedAt };
  }

  /** Write secrets to a private file so they never appear in `ps`. */
  private async writeEnvFile(containerName: string, env: Record<string, string>): Promise<string> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const path = join(this.stateDir, `${containerName}.env`);
    const body = Object.entries(env)
      // Docker's env-file format does not support quoting or escapes, so a
      // value containing a newline cannot be represented safely. Reject it
      // loudly rather than silently deploying a corrupted secret.
      .map(([key, value]) => {
        if (/[\r\n]/.test(value)) {
          throw new AppError('bad_request', `Environment variable ${key} contains a line break, which Docker cannot pass safely`);
        }
        return `${key}=${value}`;
      })
      .join('\n');
    await writeFile(path, `${body}\n`, { mode: 0o600 });
    return path;
  }

  async start(specs: ContainerSpec[], onOutput?: (chunk: string) => void): Promise<ContainerRef[]> {
    await this.requireAvailable();
    const refs: ContainerRef[] = [];

    try {
      for (const spec of specs) {
        const envFile = await this.writeEnvFile(spec.name, spec.env);
        const args = this.args(
          'run',
          '--detach',
          '--name', spec.name,
          '--restart', 'unless-stopped',
          // Resource ceilings: never unbounded.
          '--cpus', String(spec.limits.cpus ?? 1),
          '--memory', `${spec.limits.memoryMb ?? 512}m`,
          // Least privilege.
          '--cap-drop', 'ALL',
          '--security-opt', 'no-new-privileges',
          ...(spec.readOnlyRoot === true ? ['--read-only', '--tmpfs', '/tmp'] : []),
          '--env-file', envFile,
          ...(spec.network !== null && spec.network !== undefined ? ['--network', spec.network] : []),
          ...(spec.volumeName !== null && spec.volumeName !== undefined && spec.volumePath !== null && spec.volumePath !== undefined
            ? ['--volume', `${spec.volumeName}:${spec.volumePath}`]
            : []),
          ...Object.entries(spec.labels ?? {}).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
          // The container port is reachable on the shared network by name; it is
          // deliberately not published to the host.
          '--expose', String(spec.internalPort),
          spec.imageTag,
        );

        const result = await runProcess(this.binary, args, { timeoutMs: 120_000, onOutput: onOutput ?? (() => {}) });
        if (result.code !== 0) {
          throw new AppError('deploy_failed', `Failed to start container ${spec.name}`, {
            details: { stderr: result.stderr.slice(0, 1_000) },
          });
        }

        const id = result.stdout.trim().slice(0, 12);
        refs.push({ id, name: spec.name, address: spec.address, hostPort: null });

        // The env file has been consumed by the daemon; remove it from disk.
        await rm(envFile, { force: true });
      }
      return refs;
    } catch (error) {
      // Roll back partially started replicas so a failed deploy leaves no debris.
      await this.remove(refs.map((ref) => ref.name));
      throw error;
    }
  }

  async remove(names: string[]): Promise<void> {
    if (names.length === 0) return;
    await runProcess(this.binary, this.args('rm', '--force', '--volumes', ...names), { timeoutMs: 60_000 });
  }

  async removeByPrefix(prefix: string): Promise<number> {
    const containers = await this.list({ namePrefix: prefix });
    if (containers.length === 0) return 0;
    await this.remove(containers.map((container) => container.name));
    return containers.length;
  }

  async list(options: { label?: string; namePrefix?: string } = {}): Promise<ContainerInfo[]> {
    const args = this.args('ps', '--all', '--no-trunc', '--format', '{{json .}}');
    if (options.label !== undefined) args.push('--filter', `label=${options.label}`);
    if (options.namePrefix !== undefined) args.push('--filter', `name=^${options.namePrefix}`);

    const result = await runProcess(this.binary, args, { timeoutMs: 30_000 });
    if (result.code !== 0) return [];

    const containers: ContainerInfo[] = [];
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as { ID?: string; Names?: string; Image?: string; State?: string; Status?: string; Labels?: string };
        const labels: Record<string, string> = {};
        for (const pair of (parsed.Labels ?? '').split(',')) {
          const [key, ...rest] = pair.split('=');
          if (key !== undefined && key.length > 0) labels[key] = rest.join('=');
        }
        containers.push({
          id: parsed.ID ?? '',
          name: parsed.Names ?? '',
          image: parsed.Image ?? '',
          status: parsed.Status ?? parsed.State ?? '',
          running: (parsed.State ?? '').toLowerCase() === 'running',
          labels,
        });
      } catch {
        // A malformed line from the daemon must not break the whole listing.
      }
    }
    return containers;
  }

  async isRunning(name: string): Promise<boolean> {
    const state = await runQuiet(this.binary, this.args('inspect', '--format', '{{.State.Running}}', name), {
      timeoutMs: 15_000,
    });
    return state === 'true';
  }

  async stats(name: string): Promise<ContainerStats | null> {
    const result = await runProcess(
      this.binary,
      this.args('stats', '--no-stream', '--format', '{{json .}}', name),
      { timeoutMs: 30_000 },
    );
    if (result.code !== 0) return null;

    try {
      const parsed = JSON.parse(result.stdout.trim()) as DockerStatsFormat;
      const memory = parseMemoryPair(parsed.MemUsage ?? '0B / 0B');
      const [rx = '0B', tx = '0B'] = (parsed.NetIO ?? '0B / 0B').split('/');
      return {
        cpuPercent: Number((parsed.CPUPerc ?? '0%').replace('%', '')) || 0,
        memoryBytes: memory.used,
        memoryLimitBytes: memory.limit,
        networkRxBytes: parseDockerBytes(rx),
        networkTxBytes: parseDockerBytes(tx),
        running: true,
      };
    } catch {
      return null;
    }
  }

  async logs(name: string, tail = 200): Promise<string> {
    const result = await runProcess(this.binary, this.args('logs', '--tail', String(tail), name), { timeoutMs: 30_000 });
    return `${result.stdout}${result.stderr}`;
  }

  async exec(name: string, command: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const result = await runProcess(this.binary, this.args('exec', name, ...command), { timeoutMs: 60_000 });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }

  /** Docker reaches containers by name on the shared network; no host port needed. */
  async allocatePort(): Promise<number | null> {
    return null;
  }

  /**
   * Import a prebuilt image from a tarball (`docker load`).
   * Used when a deployment was built elsewhere, e.g. by a remote builder.
   */
  async loadImage(tarballPath: string): Promise<string | null> {
    const result = await runProcess(this.binary, this.args('load', '--input', tarballPath), { timeoutMs: 600_000 });
    if (result.code !== 0) return null;
    return /Loaded image: (\S+)/.exec(result.stdout)?.[1] ?? null;
  }

  /** Read the last few lines of a container's output for a crash report. */
  async tailLogs(name: string, lines = 50): Promise<string> {
    try {
      return await this.logs(name, lines);
    } catch {
      return '';
    }
  }

  /** Current disk usage of images and volumes, for the host metrics panel. */
  async diskUsage(): Promise<string | null> {
    return runQuiet(this.binary, this.args('system', 'df', '--format', '{{json .}}'), { timeoutMs: 60_000 });
  }

  /** Prune dangling images older than the given age. */
  async pruneImages(untilHours = 168): Promise<number> {
    const result = await runProcess(
      this.binary,
      this.args('image', 'prune', '--force', '--filter', `until=${untilHours}h`),
      { timeoutMs: 300_000 },
    );
    if (result.code !== 0) return 0;
    const match = /Total reclaimed space: (\S+)/.exec(result.stdout);
    return match === null ? 0 : parseDockerBytes(match[1]!);
  }

  /** Remove a named volume. Used when a service is deleted. */
  async removeVolume(name: string): Promise<void> {
    await runProcess(this.binary, this.args('volume', 'rm', '--force', name), { timeoutMs: 60_000 });
  }

  /** Read a file from inside a container, e.g. a generated database password. */
  async readFileFromContainer(name: string, path: string): Promise<string | null> {
    const result = await runProcess(this.binary, this.args('exec', name, 'cat', path), { timeoutMs: 30_000 });
    return result.code === 0 ? result.stdout : null;
  }

  /** Ensure the image exists locally, pulling it when missing. */
  async ensureImage(image: string): Promise<void> {
    const present = await runQuiet(this.binary, this.args('image', 'inspect', '--format', '{{.Id}}', image), {
      timeoutMs: 30_000,
    });
    if (present !== null) return;

    const pull = await runProcessOrThrow(this.binary, this.args('pull', image), { timeoutMs: 900_000 });
    if (pull.code !== 0) {
      throw new AppError('engine_unavailable', `Unable to pull image ${image}`);
    }
  }

  /** Read a local file (used by tests and diagnostics). */
  async readLocalFile(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  }
}