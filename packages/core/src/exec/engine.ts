/**
 * Container execution engine.
 *
 * The deployment pipeline is written against this interface and never against
 * Docker directly, which is what makes the platform portable:
 *
 * - `DockerEngine` (see `docker-engine.ts`) — the production path. Drives the
 *   Docker CLI with resource limits, dropped capabilities, no-new-privileges
 *   and BuildKit layer caching.
 * - `LocalEngine` (see `local-engine.ts`) — runs applications as managed child
 *   processes. Not a mock: it really builds, really starts and really serves,
 *   so the platform is usable on a host without a container runtime while
 *   Docker remains the production path.
 *
 * Both honor the same contract, so a deployment that works on a laptop behaves
 * identically on a VPS.
 */

export interface ResourceLimits {
  /** vCPU count, fractional allowed (e.g. 0.5). */
  cpus?: number | null;
  /** Memory ceiling in megabytes. */
  memoryMb?: number | null;
}

export interface EngineInfo {
  /** `docker` or `local`. */
  name: EngineName;
  available: boolean;
  version: string | null;
  /** Human-readable reason when `available` is false. */
  detail: string | null;
}

export type EngineName = 'docker' | 'local';

export interface BuildRequest {
  /** Unique tag for the produced image, e.g. `ploy/app-abc:dep_xyz`. */
  imageTag: string;
  /** Directory containing the build context. */
  contextDir: string;
  /** Dockerfile path relative to the context. */
  dockerfilePath: string;
  /** Build-time variables. */
  buildArgs?: Record<string, string>;
  /** Directory for BuildKit's local cache export. */
  cacheDir?: string | null;
  /** Disable layer caching (used by an explicit "clean rebuild"). */
  noCache?: boolean;
}

export interface BuildResult {
  imageTag: string;
  cached: boolean;
  durationMs: number;
}

export interface ContainerSpec {
  /** Unique container name, e.g. `ploy-app-abc-dep123-0`. */
  name: string;
  imageTag: string;
  /** Port the process listens on inside the container. */
  internalPort: number;
  /**
   * Address the proxy should route to. For Docker this is the container name
   * on the shared network; for the local engine it is `127.0.0.1:<hostPort>`.
   */
  address: string;
  env: Record<string, string>;
  limits: ResourceLimits;
  replicas: number;
  /** Named volume (Docker) or directory (local) for persistent data. */
  volumeName?: string | null;
  volumePath?: string | null;
  network?: string | null;
  labels?: Record<string, string>;
  /** Read-only root filesystem. Off by default: many images write to /tmp. */
  readOnlyRoot?: boolean;
  /** Command to run, overriding the image default (local engine). */
  command?: string | null;
  workingDir?: string | null;
  /** Directory containing the built application (local engine). */
  appDir?: string | null;
}

export interface ContainerRef {
  id: string;
  name: string;
  /** Address the proxy routes to. */
  address: string;
  /** Host port, when one was allocated. */
  hostPort: number | null;
}

export interface ContainerStats {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  running: boolean;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  /** Raw engine status string, e.g. `Up 3 minutes` or `running`. */
  status: string;
  running: boolean;
  labels: Record<string, string>;
}

export interface ContainerEngine {
  readonly name: EngineName;
  /** Verify the engine is usable. Called once at startup and on demand. */
  probe(): Promise<EngineInfo>;
  /** Ensure the shared network exists (no-op for the local engine). */
  ensureNetwork(name: string): Promise<void>;
  /** Ensure a volume (or directory) exists; returns its resolved name/path. */
  ensureVolume(name: string): Promise<string>;
  /** Build an image, streaming output through `onOutput`. */
  build(request: BuildRequest, onOutput: (chunk: string) => void, signal?: AbortSignal): Promise<BuildResult>;
  /** Start one container per spec. */
  start(specs: ContainerSpec[], onOutput?: (chunk: string) => void): Promise<ContainerRef[]>;
  /** Stop and remove containers. Missing containers are not an error. */
  remove(names: string[]): Promise<void>;
  /** Remove every container whose name starts with `prefix`; returns the count. */
  removeByPrefix(prefix: string): Promise<number>;
  /** Inspect running containers, optionally filtered by a label selector. */
  list(options?: { label?: string; namePrefix?: string }): Promise<ContainerInfo[]>;
  /** Whether a specific container is running. */
  isRunning(name: string): Promise<boolean>;
  /** Resource usage for a container. */
  stats(name: string): Promise<ContainerStats | null>;
  /** Tail a container's output; used to surface runtime crashes in the UI. */
  logs(name: string, tail?: number): Promise<string>;
  /** Execute a command inside a running container (used by service setup). */
  exec?(name: string, command: string[]): Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Allocate a free host port for the local engine; Docker returns null. */
  allocatePort(): Promise<number | null>;
}
