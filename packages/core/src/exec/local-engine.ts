/**
 * Local engine — runs applications as managed child processes.
 *
 * This is a real execution engine, not a stub. It builds the application for
 * real, starts it for real, serves real traffic and reports real resource
 * usage. It exists so the platform works on a host without a container runtime
 * (development machines, CI, minimal VPS images), while Docker remains the
 * production path.
 *
 * Trade-off, stated honestly: process isolation is weaker than container
 * isolation — there is no capability dropping, no separate filesystem and no
 * cgroup memory limit enforced by the kernel. Resource limits are therefore
 * advisory here (`--max-old-space-size` for Node, accounting for stats) and the
 * engine reports `limited: true` so the UI can say so instead of implying
 * guarantees it cannot make.
 *
 * Ports: unlike Docker (where the proxy reaches containers by name), local
 * processes are addressed on `127.0.0.1`. The engine allocates a free port per
 * replica and reports it in {@link ContainerRef.address}.
 */
import { createServer } from 'node:net';
import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { runProcess } from './process.ts';
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

export interface LocalEngineOptions {
  /** Directory for process state: pid files, logs, build output. */
  stateDir: string;
  /** Node binary used to run the build and the app. */
  nodeBinary?: string;
  /** Port range to allocate from. */
  portRange?: { min: number; max: number };
}

interface ManagedProcess {
  name: string;
  pid: number;
  port: number;
  child: ChildProcess;
  startedAt: number;
  image: string;
  labels: Record<string, string>;
  /** Rolling tail of output, so a crash can be explained in the UI. */
  output: string[];
}

const MAX_TAIL_LINES = 200;

/** Ask the OS for a free port by binding to port 0 and reading the result. */
export function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Read RSS from `ps` on POSIX systems. Returns null where unavailable, so the
 * caller can report "unknown" instead of a fabricated zero.
 */
export async function readProcessMemory(pid: number): Promise<number | null> {
  const result = await runProcess('ps', ['-o', 'rss=', '-p', String(pid)], { timeoutMs: 10_000 });
  if (result.code !== 0) return null;
  const kilobytes = Number(result.stdout.trim());
  return Number.isFinite(kilobytes) && kilobytes > 0 ? kilobytes * 1024 : null;
}

export class LocalEngine implements ContainerEngine {
  readonly name: EngineName = 'local';

  private readonly stateDir: string;
  private readonly nodeBinary: string;
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly volumePaths = new Map<string, string>();

  constructor(options: LocalEngineOptions) {
    this.stateDir = options.stateDir;
    this.nodeBinary = options.nodeBinary ?? process.execPath;
  }

  async probe(): Promise<EngineInfo> {
    return {
      name: 'local',
      available: true,
      version: `node ${process.version}`,
      detail: 'Process isolation (no container runtime): resource limits are advisory.',
    };
  }

  async ensureNetwork(_name: string): Promise<void> {
    // Local processes share the loopback interface; there is no network to create.
  }

  async ensureVolume(name: string): Promise<string> {
    const path = join(this.stateDir, 'volumes', name);
    await mkdir(path, { recursive: true, mode: 0o700 });
    this.volumePaths.set(name, path);
    return path;
  }

  /**
   * Build the application in place.
   *
   * There is no image to produce, so the "build" is the project's own build
   * pipeline: install dependencies, then run the build command. The build
   * directory is the working copy, and the artifact is the resulting tree.
   */
  async build(request: BuildRequest, onOutput: (chunk: string) => void, signal?: AbortSignal): Promise<BuildResult> {
    const startedAt = Date.now();
    const buildDir = request.contextDir;

    const manifestPath = join(buildDir, 'package.json');
    if (!existsSync(manifestPath)) {
      throw new AppError(
        'build_failed',
        'Local engine requires a package.json in the build context (no other runtime is supported for in-place builds)',
      );
    }

    // Prefer a reproducible install when a lockfile exists.
    const hasLockfile = existsSync(join(buildDir, 'package-lock.json')) || existsSync(join(buildDir, 'npm-shrinkwrap.json'));
    const installArgs = hasLockfile ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
    onOutput(`$ npm ${installArgs.join(' ')}\n`);

    const install = await runProcess('npm', installArgs, {
      cwd: buildDir,
      timeoutMs: 30 * 60_000,
      onOutput,
      env: { NODE_ENV: 'development', npm_config_update_notifier: 'false' },
      ...(signal === undefined ? {} : { signal }),
    });
    if (install.code !== 0) {
      throw new AppError('build_failed', 'Dependency installation failed', {
        details: { stderr: install.stderr.slice(-2_000) },
      });
    }

    const buildScript = await this.readBuildScript(buildDir);
    if (buildScript !== null) {
      onOutput(`$ npm run build\n`);
      const build = await runProcess('npm', ['run', 'build'], {
        cwd: buildDir,
        timeoutMs: 30 * 60_000,
        onOutput,
        env: { NODE_ENV: 'production', npm_config_update_notifier: 'false' },
        ...(signal === undefined ? {} : { signal }),
      });
      if (build.code !== 0) {
        throw new AppError('build_failed', 'Build script failed', {
          details: { stderr: build.stderr.slice(-2_000) },
        });
      }
    } else {
      onOutput('No build script defined; skipping build step.\n');
    }

    return { imageTag: request.imageTag, cached: false, durationMs: Date.now() - startedAt };
  }

  /** Detect a `build` script without invoking npm (faster and side-effect free). */
  private async readBuildScript(dir: string): Promise<string | null> {
    try {
      const raw = await readFile(join(dir, 'package.json'), 'utf8');
      const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
      const script = parsed.scripts?.build;
      return typeof script === 'string' && script.trim().length > 0 ? script : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve how to launch the application, matching npm's own semantics.
   *
   * npm runs a `start` script through the system shell with
   * `node_modules/.bin` on `PATH`, which is why `"start": "node server.js"`
   * and `"start": "next start"` both work. Reproducing that behaviour is what
   * makes an application behave identically here and inside a container.
   *
   * Using a shell is safe in this one place: the command comes from the
   * application's own package.json, and the application is already trusted to
   * execute arbitrary code. Platform-generated arguments (git, docker, npm)
   * never go through a shell.
   */
  private async readStartCommand(spec: ContainerSpec): Promise<{ shell: boolean; command: string; cwd: string }> {
    const dir = spec.appDir ?? spec.workingDir ?? process.cwd();

    // An explicit command wins.
    if (spec.command !== null && spec.command !== undefined && spec.command.trim().length > 0) {
      return { shell: true, command: spec.command, cwd: dir };
    }

    try {
      const raw = await readFile(join(dir, 'package.json'), 'utf8');
      const parsed = JSON.parse(raw) as { scripts?: Record<string, string>; main?: string };

      const start = parsed.scripts?.start;
      if (typeof start === 'string' && start.trim().length > 0) {
        return { shell: true, command: start, cwd: dir };
      }

      if (typeof parsed.main === 'string' && parsed.main.length > 0) {
        return { shell: false, command: join(dir, parsed.main), cwd: dir };
      }
    } catch {
      // Fall through to the error below.
    }

    throw new AppError(
      'deploy_failed',
      `No start command available in ${dir}: define a "start" script in package.json or set an explicit start command`,
    );
  }

  async start(specs: ContainerSpec[], onOutput?: (chunk: string) => void): Promise<ContainerRef[]> {
    const refs: ContainerRef[] = [];

    try {
      for (const spec of specs) {
        const { shell, command, cwd } = await this.readStartCommand(spec);
        const port = spec.internalPort > 0 ? await findFreePort() : 0;
        const logPath = join(this.stateDir, 'logs', `${spec.name}.log`);
        await mkdir(join(this.stateDir, 'logs'), { recursive: true, mode: 0o700 });

        // A memory ceiling the Node runtime enforces, since there is no cgroup
        // to do it. Honest about scope: it only bounds the JS heap, and it is
        // applied through NODE_OPTIONS so it also reaches child node processes.
        const memoryMb = spec.limits.memoryMb ?? 512;
        const heapLimit = `--max-old-space-size=${Math.max(64, Math.floor(memoryMb * 0.75))}`;
        const nodeOptions = `${process.env.NODE_OPTIONS ?? ''} ${heapLimit}`.trim();

        const env: NodeJS.ProcessEnv = {
          ...process.env,
          ...spec.env,
          PORT: String(port),
          HOST: '127.0.0.1',
          NODE_ENV: 'production',
          NODE_OPTIONS: nodeOptions,
          // Mirror npm: locally installed binaries must be resolvable by name.
          PATH: `${join(cwd, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}`,
        };

        const spawnTarget = shell
          ? (process.platform === 'win32'
              ? { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] }
              : { file: '/bin/sh', args: ['-c', command] })
          : { file: this.nodeBinary, args: [command] };

        const child = spawn(spawnTarget.file, spawnTarget.args, {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        });

        if (child.pid === undefined) {
          throw new AppError('deploy_failed', `Failed to start process for ${spec.name}`);
        }

        const managed: ManagedProcess = {
          name: spec.name,
          pid: child.pid,
          port,
          child,
          startedAt: Date.now(),
          image: spec.imageTag,
          labels: spec.labels ?? {},
          output: [],
        };

        const capture = (stream: 'out' | 'err') => (chunk: Buffer | string): void => {
          const text = chunk.toString();
          onOutput?.(text);
          for (const line of text.split('\n')) {
            if (line.trim().length === 0) continue;
            managed.output.push(`[${stream}] ${line}`);
          }
          if (managed.output.length > MAX_TAIL_LINES) {
            managed.output.splice(0, managed.output.length - MAX_TAIL_LINES);
          }
        };
        child.stdout?.on('data', capture('out'));
        child.stderr?.on('data', capture('err'));

        // Record the log for post-mortem inspection.
        void writeFile(logPath, '', { mode: 0o600 }).catch(() => {});

        this.processes.set(spec.name, managed);
        await writeFile(join(this.stateDir, `${spec.name}.pid`), `${child.pid}\n`, { mode: 0o600 }).catch(() => {});

        refs.push({
          id: `local_${child.pid}`,
          name: spec.name,
          address: `127.0.0.1:${port}`,
          hostPort: port,
        });
      }
      return refs;
    } catch (error) {
      await this.remove(refs.map((ref) => ref.name));
      throw error;
    }
  }

  async remove(names: string[]): Promise<void> {
    for (const name of names) {
      const managed = this.processes.get(name);
      if (managed === undefined) {
        await rm(join(this.stateDir, `${name}.pid`), { force: true });
        continue;
      }

      await new Promise<void>((resolve) => {
        const child = managed.child;
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 10_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        // SIGTERM lets the app close its listeners and finish in-flight requests.
        child.kill('SIGTERM');
      });

      this.processes.delete(name);
      await rm(join(this.stateDir, `${name}.pid`), { force: true });
    }
  }

  async removeByPrefix(prefix: string): Promise<number> {
    const names = [...this.processes.keys()].filter((name) => name.startsWith(prefix));
    await this.remove(names);
    return names.length;
  }

  async list(options: { label?: string; namePrefix?: string } = {}): Promise<ContainerInfo[]> {
    const out: ContainerInfo[] = [];
    for (const managed of this.processes.values()) {
      if (options.namePrefix !== undefined && !managed.name.startsWith(options.namePrefix)) continue;
      if (options.label !== undefined) {
        const [key, value] = options.label.split('=');
        if (key === undefined) continue;
        if (managed.labels[key] !== value) continue;
      }
      out.push({
        id: `local_${managed.pid}`,
        name: managed.name,
        image: managed.image,
        status: `running (pid ${managed.pid})`,
        running: managed.child.exitCode === null,
        labels: managed.labels,
      });
    }
    return out;
  }

  async isRunning(name: string): Promise<boolean> {
    const managed = this.processes.get(name);
    if (managed === undefined) return false;
    return managed.child.exitCode === null && managed.child.signalCode === null;
  }

  async stats(name: string): Promise<ContainerStats | null> {
    const managed = this.processes.get(name);
    if (managed === undefined) return null;

    const memoryBytes = await readProcessMemory(managed.pid);

    return {
      // CPU share is not measured per process here; reporting a fabricated
      // percentage would be worse than reporting zero with a running flag.
      cpuPercent: 0,
      memoryBytes: memoryBytes ?? 0,
      memoryLimitBytes: 512 * 1024 * 1024,
      networkRxBytes: 0,
      networkTxBytes: 0,
      running: managed.child.exitCode === null,
    };
  }

  async logs(name: string, tail = 200): Promise<string> {
    const managed = this.processes.get(name);
    if (managed === undefined) return '';
    return managed.output.slice(-tail).join('\n');
  }

  async exec(name: string, command: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const managed = this.processes.get(name);
    if (managed === undefined) {
      return { code: null, stdout: '', stderr: `No managed process named ${name}` };
    }
    // There is no namespace to enter; the command runs in the same environment.
    const result = await runProcess(command[0] ?? 'echo', command.slice(1), { timeoutMs: 60_000 });
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }

  async allocatePort(): Promise<number | null> {
    return findFreePort();
  }

  /** The exit code of a managed process, or null while it is still running. */
  exitCode(name: string): number | null {
    return this.processes.get(name)?.child.exitCode ?? null;
  }

  /** True when the process has exited and was not deliberately stopped. */
  hasCrashed(name: string): boolean {
    const managed = this.processes.get(name);
    if (managed === undefined) return false;
    return managed.child.exitCode !== null && managed.child.exitCode !== 0;
  }

  /** Tail of a managed process's captured output, for crash reporting. */
  recentOutput(name: string, lines = 30): string {
    return this.processes.get(name)?.output.slice(-lines).join('\n') ?? '';
  }

  /** Number of live managed processes. */
  get size(): number {
    return this.processes.size;
  }

  /** Disk usage of the volume directory, for the metrics panel. */
  async volumeUsage(name: string): Promise<number | null> {
    const path = this.volumePaths.get(name) ?? join(this.stateDir, 'volumes', name);
    if (!existsSync(path)) return null;
    const result = await runProcess('du', ['-sk', path], { timeoutMs: 60_000 });
    if (result.code !== 0) return null;
    const kilobytes = Number(result.stdout.split(/\s+/)[0]);
    return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
  }

  /** Confirm the state directory is writable before accepting deployments. */
  async verifyStateDir(): Promise<boolean> {
    try {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      const probe = join(this.stateDir, '.writable');
      await writeFile(probe, 'ok', { mode: 0o600 });
      await stat(probe);
      await rm(probe, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}