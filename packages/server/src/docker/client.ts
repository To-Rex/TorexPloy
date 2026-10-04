/**
 * Docker Engine API client.
 *
 * Speaks the Engine REST API directly over a unix socket — the daemon's own
 * socket for the local host, or the local end of an SSH `dial-stdio` tunnel
 * for a remote server. There is no CLI output parsing and no per-call process
 * spawn: lifecycle, inspect, stats, logs, exec and events are all structured
 * JSON or framed streams.
 *
 * The API version is negotiated once (`GET /version`) and pinned, the same way
 * the official CLI does it, so behaviour does not shift across daemon upgrades.
 */
import { Agent, request, type IncomingMessage } from 'node:http';
import { Transform, type Duplex, type Readable, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/** Oldest Engine API this client relies on (Docker 20.10). */
const MIN_API_VERSION = '1.41';
/** Newest version this client was written against; newer daemons are pinned down to it. */
const MAX_API_VERSION = '1.47';

export class DockerError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DockerError';
    this.status = status;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  get isNotModified(): boolean {
    return this.status === 304;
  }
}

export class DockerUnavailableError extends Error {
  override name = 'DockerUnavailableError';
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | Record<string, string[]>>;
  body?: unknown;
  /** Raw body (e.g. a tar archive); takes precedence over `body`. */
  raw?: Buffer | Readable;
  contentType?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DockerVersion {
  Version: string;
  ApiVersion: string;
  MinAPIVersion?: string;
  Os: string;
  Arch: string;
  KernelVersion?: string;
}

export interface DockerSystemInfo {
  NCPU: number;
  MemTotal: number;
  OperatingSystem: string;
  Architecture: string;
  ServerVersion: string;
  DockerRootDir: string;
  Swarm?: { LocalNodeState?: string };
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  Labels: Record<string, string>;
  State: string;
  Status: string;
  Created: number;
  Ports?: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[];
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  Created: string;
  RestartCount: number;
  Image: string;
  State: {
    Status: string;
    Running: boolean;
    Restarting: boolean;
    OOMKilled: boolean;
    ExitCode: number;
    Error: string;
    StartedAt: string;
    FinishedAt: string;
    Health?: { Status: string };
  };
  Config: {
    Image: string;
    Labels: Record<string, string>;
    Env: string[] | null;
    // The rest is what the self-updater copies onto a replacement container; absent in older daemons' answers.
    Hostname?: string;
    User?: string;
    WorkingDir?: string;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    ExposedPorts?: Record<string, unknown> | null;
    Healthcheck?: Record<string, unknown> | null;
    StopSignal?: string;
    StopTimeout?: number;
  };
  NetworkSettings: { Networks: Record<string, { IPAddress: string; Aliases: string[] | null; NetworkID: string }> };
  /** Everything `docker run` took, as the daemon stores it; a create request accepts it back verbatim. */
  HostConfig: { Memory: number; NanoCpus: number; NetworkMode?: string; Binds?: string[] | null; PortBindings?: Record<string, { HostIp?: string; HostPort: string }[]> | null; RestartPolicy?: { Name: string; MaximumRetryCount?: number }; Mounts?: Record<string, unknown>[] | null } & Record<string, unknown>;
  /** Resolved mounts, including anonymous volumes that only exist here (not in `HostConfig.Binds`). */
  Mounts?: { Type: string; Name?: string; Source?: string; Destination: string; RW?: boolean }[];
}

export interface ImageInspect {
  Id: string;
  RepoTags: string[] | null;
  Size: number;
  Created: string;
  Config: {
    ExposedPorts?: Record<string, unknown> | null;
    Labels?: Record<string, string> | null;
    Env?: string[] | null;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    Healthcheck?: Record<string, unknown> | null;
    WorkingDir?: string;
    User?: string;
  };
}

export interface ImageSummary {
  Id: string;
  RepoTags: string[] | null;
  Labels: Record<string, string> | null;
  Size: number;
  Created: number;
}

export interface NetworkInspect {
  Id: string;
  Name: string;
  Containers?: Record<string, { Name: string; IPv4Address: string }>;
}

export interface StatsSample {
  read: string;
  cpu_stats: {
    cpu_usage: { total_usage: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  memory_stats: { usage?: number; limit?: number; stats?: Record<string, number> };
  networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
}

export interface SystemDf {
  LayersSize?: number;
  Images?: { Size: number; SharedSize: number; Containers: number }[] | null;
  Containers?: { SizeRw?: number }[] | null;
  Volumes?: { UsageData?: { Size: number; RefCount: number } }[] | null;
  BuildCache?: { Size: number; InUse: boolean }[] | null;
}

/** Registry credentials as the Engine API takes them (`POST /auth`, `X-Registry-Auth`). */
export interface RegistryAuthConfig {
  username: string;
  password: string;
  serveraddress: string;
}

export interface DockerEvent {
  Type: string;
  Action: string;
  Actor: { ID: string; Attributes: Record<string, string> };
  time: number;
  timeNano: number;
}

/** Docker's stream multiplexing for non-TTY attach/logs/exec output. */
export type StreamKind = 'stdout' | 'stderr';

/**
 * Split a multiplexed stream into `{ stream, text }` chunks.
 *
 * Frame: 1 byte stream id (1 = stdout, 2 = stderr), 3 zero bytes, a uint32 BE
 * length, then the payload. Frames may be split or coalesced arbitrarily by
 * the transport, so this buffers until a full frame is available.
 */
export class DockerStreamDemuxer extends Transform {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  /** Raw mode emits `{ stream, data: Buffer }` untouched — required for binary output such as database dumps. */
  private readonly raw: boolean;

  constructor(options: { raw?: boolean } = {}) {
    super({ readableObjectMode: true });
    this.raw = options.raw ?? false;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const kind = this.buffer[0];
      const size = this.buffer.readUInt32BE(4);
      if (kind !== 0 && kind !== 1 && kind !== 2) {
        // Not a multiplexed stream (a TTY container). Pass everything through as stdout.
        this.push(this.raw ? { stream: 'stdout', data: this.buffer } : { stream: 'stdout', text: this.decoders.stdout.write(this.buffer) });
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (this.buffer.length < 8 + size) break;
      const payload = this.buffer.subarray(8, 8 + size);
      this.buffer = this.buffer.subarray(8 + size);
      const stream: StreamKind = kind === 2 ? 'stderr' : 'stdout';
      if (this.raw) {
        // Copy: the backing buffer is reused by later concatenations.
        this.push({ stream, data: Buffer.from(payload) });
        continue;
      }
      const text = this.decoders[stream].write(payload);
      if (text.length > 0) this.push({ stream, text });
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (this.raw) {
      callback();
      return;
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      const rest = this.decoders[stream].end();
      if (rest.length > 0) this.push({ stream, text: rest });
    }
    callback();
  }
}

/** Parse a newline-delimited JSON stream (events, pull progress) into objects. */
export class JsonLinesParser extends Transform {
  private pending = '';
  private readonly decoder = new StringDecoder('utf8');

  constructor() {
    super({ readableObjectMode: true });
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.pending += this.decoder.write(chunk);
    let newline = this.pending.indexOf('\n');
    while (newline !== -1) {
      const line = this.pending.slice(0, newline).trim();
      this.pending = this.pending.slice(newline + 1);
      if (line.length > 0) {
        try {
          this.push(JSON.parse(line));
        } catch {
          // A torn line cannot be recovered; skipping it keeps the stream alive.
        }
      }
      newline = this.pending.indexOf('\n');
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    const line = (this.pending + this.decoder.end()).trim();
    if (line.length > 0) {
      try {
        this.push(JSON.parse(line));
      } catch {
        // ignore trailing garbage
      }
    }
    callback();
  }
}

function compareVersions(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split('.').map(Number);
  const [bMajor = 0, bMinor = 0] = b.split('.').map(Number);
  return aMajor === bMajor ? aMinor - bMinor : aMajor - bMajor;
}

function encodeQuery(query: RequestOptions['query']): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (typeof value === 'object') params.set(key, JSON.stringify(value));
    else params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded.length === 0 ? '' : `?${encoded}`;
}

export class DockerClient {
  readonly socketPath: string;
  private readonly agent: Agent;
  private apiVersion: string | null = null;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
    this.agent = new Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 10_000 });
  }

  /** `unix://…` form for the docker CLI (`DOCKER_HOST`). */
  get dockerHost(): string {
    return `unix://${this.socketPath}`;
  }

  close(): void {
    this.agent.destroy();
  }

  private send(method: string, path: string, options: RequestOptions, versioned: boolean): Promise<IncomingMessage> {
    const prefix = versioned && this.apiVersion !== null ? `/v${this.apiVersion}` : '';
    const headers: Record<string, string> = { Host: 'docker', ...options.headers };
    let payload: Buffer | Readable | undefined;
    if (options.raw !== undefined) {
      payload = options.raw;
      headers['Content-Type'] = options.contentType ?? 'application/x-tar';
    } else if (options.body !== undefined) {
      payload = Buffer.from(JSON.stringify(options.body), 'utf8');
      headers['Content-Type'] = 'application/json';
    }
    if (Buffer.isBuffer(payload)) headers['Content-Length'] = String(payload.length);

    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          agent: this.agent,
          method,
          path: `${prefix}${path}${encodeQuery(options.query)}`,
          headers,
          signal: options.signal,
        },
        resolve,
      );
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'EACCES') {
          reject(new DockerUnavailableError(`Docker is not reachable at ${this.socketPath} (${error.code})`));
        } else {
          reject(error);
        }
      });
      if (options.timeoutMs !== undefined) {
        req.setTimeout(options.timeoutMs, () => req.destroy(new Error(`Docker request timed out: ${method} ${path}`)));
      }
      if (payload === undefined) req.end();
      else if (Buffer.isBuffer(payload)) req.end(payload);
      else payload.pipe(req);
    });
  }

  private async readBody(response: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  private async fail(response: IncomingMessage): Promise<never> {
    const body = (await this.readBody(response)).toString('utf8');
    let message = body.trim();
    try {
      message = (JSON.parse(body) as { message?: string }).message ?? message;
    } catch {
      // plain-text error body
    }
    throw new DockerError(response.statusCode ?? 0, message.length > 0 ? message : `Docker API error ${response.statusCode}`);
  }

  /** Negotiate the API version once; subsequent calls are pinned to it. */
  async negotiate(): Promise<DockerVersion> {
    const response = await this.send('GET', '/version', { timeoutMs: 10_000 }, false);
    if ((response.statusCode ?? 500) >= 400) await this.fail(response);
    const version = JSON.parse((await this.readBody(response)).toString('utf8')) as DockerVersion;
    if (compareVersions(version.ApiVersion, MIN_API_VERSION) < 0) {
      throw new DockerUnavailableError(`Docker ${version.Version} (API ${version.ApiVersion}) is too old; API ${MIN_API_VERSION}+ is required`);
    }
    this.apiVersion = compareVersions(version.ApiVersion, MAX_API_VERSION) > 0 ? MAX_API_VERSION : version.ApiVersion;
    return version;
  }

  private async ensureVersion(): Promise<void> {
    if (this.apiVersion === null) await this.negotiate();
  }

  /** Issue a request and return the parsed JSON body (or null for empty 2xx/304 responses). */
  async call<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    await this.ensureVersion();
    const response = await this.send(method, path, { timeoutMs: 120_000, ...options }, true);
    const status = response.statusCode ?? 500;
    if (status === 304) {
      response.resume();
      throw new DockerError(304, 'Not modified');
    }
    if (status >= 400) await this.fail(response);
    const body = await this.readBody(response);
    if (body.length === 0) return null as T;
    const text = body.toString('utf8');
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  /** Issue a request and return the live response stream (logs, events, exec, archives). */
  async stream(method: string, path: string, options: RequestOptions = {}): Promise<IncomingMessage> {
    await this.ensureVersion();
    const response = await this.send(method, path, options, true);
    if ((response.statusCode ?? 500) >= 400) await this.fail(response);
    return response;
  }

  // ---------------------------------------------------------------- system

  async ping(): Promise<boolean> {
    try {
      const response = await this.send('GET', '/_ping', { timeoutMs: 5_000 }, false);
      const body = (await this.readBody(response)).toString('utf8');
      return response.statusCode === 200 && body.trim() === 'OK';
    } catch {
      return false;
    }
  }

  info(): Promise<DockerSystemInfo> {
    return this.call<DockerSystemInfo>('GET', '/info', { timeoutMs: 15_000 });
  }

  systemDf(): Promise<SystemDf> {
    return this.call<SystemDf>('GET', '/system/df', { timeoutMs: 120_000 });
  }

  /** Prune build cache that has not been used for `untilHours`. Returns bytes reclaimed. */
  async pruneBuildCache(untilHours: number): Promise<number> {
    const result = await this.call<{ SpaceReclaimed?: number }>('POST', '/build/prune', {
      query: { filters: { until: [`${untilHours}h`] } },
      timeoutMs: 600_000,
    });
    return result?.SpaceReclaimed ?? 0;
  }

  async pruneDanglingImages(): Promise<number> {
    const result = await this.call<{ SpaceReclaimed?: number }>('POST', '/images/prune', {
      query: { filters: { dangling: ['true'] } },
      timeoutMs: 600_000,
    });
    return result?.SpaceReclaimed ?? 0;
  }

  // -------------------------------------------------------------- networks

  async ensureNetwork(name: string, labels: Record<string, string>): Promise<string> {
    const existing = await this.call<NetworkInspect[]>('GET', '/networks', { query: { filters: { name: [name] } } });
    const match = existing.find((network) => network.Name === name);
    if (match !== undefined) return match.Id;
    try {
      const created = await this.call<{ Id: string }>('POST', '/networks/create', {
        body: { Name: name, Driver: 'bridge', Attachable: true, CheckDuplicate: true, Labels: labels },
      });
      return created.Id;
    } catch (error) {
      // Lost a race with a concurrent creator: the network now exists, which is what we wanted.
      if (error instanceof DockerError && error.isConflict) return this.ensureNetwork(name, labels);
      throw error;
    }
  }

  /** Networks carrying a label (`key=value`). */
  listNetworks(label: string): Promise<NetworkInspect[]> {
    return this.call<NetworkInspect[]>('GET', '/networks', { query: { filters: { label: [label] } } });
  }

  /** Volumes carrying a label (`key=value`). */
  async listVolumes(label: string): Promise<{ Name: string; Labels: Record<string, string> | null }[]> {
    const result = await this.call<{ Volumes: { Name: string; Labels: Record<string, string> | null }[] | null }>('GET', '/volumes', { query: { filters: { label: [label] } } });
    return result.Volumes ?? [];
  }

  inspectNetwork(name: string): Promise<NetworkInspect> {
    return this.call<NetworkInspect>('GET', `/networks/${encodeURIComponent(name)}`);
  }

  async connectNetwork(network: string, container: string, aliases: string[] = []): Promise<void> {
    try {
      await this.call('POST', `/networks/${encodeURIComponent(network)}/connect`, {
        body: { Container: container, EndpointConfig: aliases.length > 0 ? { Aliases: aliases } : {} },
      });
    } catch (error) {
      // Already connected is the desired end state.
      if (error instanceof DockerError && (error.status === 403 || /already exists|already attached/i.test(error.message))) return;
      throw error;
    }
  }

  async removeNetwork(name: string): Promise<void> {
    try {
      await this.call('DELETE', `/networks/${encodeURIComponent(name)}`);
    } catch (error) {
      if (error instanceof DockerError && error.isNotFound) return;
      throw error;
    }
  }

  // --------------------------------------------------------------- volumes

  async ensureVolume(name: string, labels: Record<string, string>): Promise<void> {
    await this.call('POST', '/volumes/create', { body: { Name: name, Labels: labels } });
  }

  async removeVolume(name: string): Promise<void> {
    try {
      await this.call('DELETE', `/volumes/${encodeURIComponent(name)}`, { query: { force: true } });
    } catch (error) {
      if (error instanceof DockerError && error.isNotFound) return;
      throw error;
    }
  }

  // ---------------------------------------------------------------- images

  async inspectImage(name: string): Promise<ImageInspect | null> {
    try {
      return await this.call<ImageInspect>('GET', `/images/${encodeURIComponent(name)}/json`);
    } catch (error) {
      if (error instanceof DockerError && error.isNotFound) return null;
      throw error;
    }
  }

  listImages(label: string): Promise<ImageSummary[]> {
    return this.call<ImageSummary[]>('GET', '/images/json', { query: { filters: { label: [label] } } });
  }

  /**
   * Check registry credentials the way `docker login` does, without storing
   * anything on the daemon. A rejected login is a DockerError carrying the
   * registry's own message.
   */
  async auth(credentials: RegistryAuthConfig): Promise<void> {
    await this.call('POST', '/auth', { body: credentials, timeoutMs: 30_000 });
  }

  /**
   * Pull an image. Docker reports pull failures *inside* a 200 response as an
   * `error` record in the progress stream, so the stream must be read to the end.
   */
  async pullImage(reference: string, onProgress?: (line: string) => void, registryAuth?: string, signal?: AbortSignal): Promise<void> {
    const at = reference.lastIndexOf('@');
    const colon = reference.lastIndexOf(':');
    const slash = reference.lastIndexOf('/');
    const [fromImage, tag] =
      at !== -1
        ? [reference, undefined]
        : colon > slash
          ? [reference.slice(0, colon), reference.slice(colon + 1)]
          : [reference, 'latest'];
    const response = await this.stream('POST', '/images/create', {
      query: { fromImage, tag },
      headers: registryAuth === undefined ? {} : { 'X-Registry-Auth': registryAuth },
      ...(signal === undefined ? {} : { signal }),
    });
    const parser = response.pipe(new JsonLinesParser());
    let lastStatus = '';
    for await (const record of parser as AsyncIterable<{ status?: string; id?: string; error?: string; errorDetail?: { message?: string } }>) {
      if (record.error !== undefined || record.errorDetail !== undefined) {
        throw new DockerError(500, record.errorDetail?.message ?? record.error ?? 'Image pull failed');
      }
      // Per-layer "Downloading" ticks are noise in a deployment log; report state changes only.
      const line = `${record.id === undefined ? '' : `${record.id}: `}${record.status ?? ''}`;
      if (record.status !== undefined && !/^(Downloading|Extracting|Waiting|Verifying Checksum)/.test(record.status) && line !== lastStatus) {
        onProgress?.(line);
        lastStatus = line;
      }
    }
  }

  /** Add `repo:tag` to an existing image (pins a pulled image so later pulls cannot change a rollback target). */
  async tagImage(source: string, repo: string, tag: string): Promise<void> {
    await this.call('POST', `/images/${encodeURIComponent(source)}/tag`, { query: { repo, tag } });
  }

  async removeImage(name: string): Promise<boolean> {
    try {
      await this.call('DELETE', `/images/${encodeURIComponent(name)}`, { query: { force: false, noprune: false } });
      return true;
    } catch (error) {
      if (error instanceof DockerError && (error.isNotFound || error.isConflict)) return false;
      throw error;
    }
  }

  // ------------------------------------------------------------ containers

  async createContainer(name: string, spec: Record<string, unknown>): Promise<string> {
    const created = await this.call<{ Id: string; Warnings?: string[] }>('POST', '/containers/create', {
      query: { name },
      body: spec,
    });
    return created.Id;
  }

  async startContainer(id: string): Promise<void> {
    try {
      await this.call('POST', `/containers/${encodeURIComponent(id)}/start`);
    } catch (error) {
      if (error instanceof DockerError && error.isNotModified) return; // already running
      throw error;
    }
  }

  async stopContainer(id: string, timeoutSec = 10): Promise<void> {
    try {
      await this.call('POST', `/containers/${encodeURIComponent(id)}/stop`, {
        query: { t: timeoutSec },
        timeoutMs: (timeoutSec + 30) * 1000,
      });
    } catch (error) {
      if (error instanceof DockerError && (error.isNotModified || error.isNotFound)) return;
      throw error;
    }
  }

  async restartContainer(id: string, timeoutSec = 10): Promise<void> {
    await this.call('POST', `/containers/${encodeURIComponent(id)}/restart`, { query: { t: timeoutSec }, timeoutMs: (timeoutSec + 60) * 1000 });
  }

  /** Rename a container (running or not); its networks and aliases stay attached. */
  async renameContainer(id: string, name: string): Promise<void> {
    await this.call('POST', `/containers/${encodeURIComponent(id)}/rename`, { query: { name }, timeoutMs: 30_000 });
  }

  async removeContainer(id: string, options: { force?: boolean; volumes?: boolean } = {}): Promise<void> {
    try {
      await this.call('DELETE', `/containers/${encodeURIComponent(id)}`, {
        query: { force: options.force ?? true, v: options.volumes ?? false },
        timeoutMs: 120_000,
      });
    } catch (error) {
      // Gone already, or removal already in progress: both converge on "absent".
      if (error instanceof DockerError && (error.isNotFound || (error.isConflict && /in progress/i.test(error.message)))) return;
      throw error;
    }
  }

  async inspectContainer(id: string): Promise<ContainerInspect | null> {
    try {
      return await this.call<ContainerInspect>('GET', `/containers/${encodeURIComponent(id)}/json`, { timeoutMs: 30_000 });
    } catch (error) {
      if (error instanceof DockerError && error.isNotFound) return null;
      throw error;
    }
  }

  listContainers(filters: Record<string, string[]>, all = true): Promise<ContainerSummary[]> {
    return this.call<ContainerSummary[]>('GET', '/containers/json', { query: { all, filters }, timeoutMs: 30_000 });
  }

  /** One stats sample without the daemon's built-in 1s wait (`one-shot`). */
  async containerStats(id: string): Promise<StatsSample | null> {
    try {
      return await this.call<StatsSample>('GET', `/containers/${encodeURIComponent(id)}/stats`, {
        query: { stream: false, 'one-shot': true },
        timeoutMs: 20_000,
      });
    } catch (error) {
      if (error instanceof DockerError && (error.isNotFound || error.isConflict)) return null;
      throw error;
    }
  }

  /** Container output as a demultiplexed object stream of `{ stream, text }`. */
  async containerLogs(
    id: string,
    options: { follow: boolean; tail: number | 'all'; timestamps?: boolean; since?: number; signal?: AbortSignal },
  ): Promise<DockerStreamDemuxer> {
    const response = await this.stream('GET', `/containers/${encodeURIComponent(id)}/logs`, {
      query: {
        stdout: true,
        stderr: true,
        follow: options.follow,
        tail: options.tail,
        timestamps: options.timestamps ?? false,
        since: options.since,
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const demux = new DockerStreamDemuxer();
    response.on('error', (error) => demux.destroy(error));
    return response.pipe(demux);
  }

  /** Wait for a container to stop; resolves with its exit code. */
  async waitContainer(id: string, signal?: AbortSignal): Promise<number> {
    const result = await this.call<{ StatusCode: number }>('POST', `/containers/${encodeURIComponent(id)}/wait`, {
      query: { condition: 'not-running' },
      timeoutMs: 7 * 24 * 3_600_000,
      ...(signal === undefined ? {} : { signal }),
    });
    return result.StatusCode;
  }

  /** Upload a tar archive and extract it at `path` inside the container. */
  async putArchive(id: string, path: string, tar: Buffer | Readable): Promise<void> {
    await this.call('PUT', `/containers/${encodeURIComponent(id)}/archive`, {
      query: { path },
      raw: tar,
      contentType: 'application/x-tar',
      timeoutMs: 600_000,
    });
  }

  /** Download `path` from a container as a tar stream. */
  getArchive(id: string, path: string, signal?: AbortSignal): Promise<IncomingMessage> {
    return this.stream('GET', `/containers/${encodeURIComponent(id)}/archive`, {
      query: { path },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /**
   * Run a command inside a container and collect its output. Output is capped
   * so a chatty command cannot exhaust memory; `onOutput` sees all of it.
   */
  async exec(
    id: string,
    cmd: string[],
    options: { env?: string[]; user?: string; timeoutMs?: number; maxOutput?: number; onOutput?: (stream: StreamKind, text: string) => void; signal?: AbortSignal } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const created = await this.call<{ Id: string }>('POST', `/containers/${encodeURIComponent(id)}/exec`, {
      body: {
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Cmd: cmd,
        ...(options.env === undefined ? {} : { Env: options.env }),
        ...(options.user === undefined ? {} : { User: options.user }),
      },
    });
    const response = await this.stream('POST', `/exec/${created.Id}/start`, {
      body: { Detach: false, Tty: false },
      timeoutMs: options.timeoutMs ?? 120_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const max = options.maxOutput ?? 1_000_000;
    let stdout = '';
    let stderr = '';
    const demux = response.pipe(new DockerStreamDemuxer());
    for await (const chunk of demux as AsyncIterable<{ stream: StreamKind; text: string }>) {
      options.onOutput?.(chunk.stream, chunk.text);
      if (chunk.stream === 'stdout' && stdout.length < max) stdout += chunk.text;
      if (chunk.stream === 'stderr' && stderr.length < max) stderr += chunk.text;
    }
    const inspect = await this.call<{ ExitCode: number | null; Running: boolean }>('GET', `/exec/${created.Id}/json`);
    return { exitCode: inspect.ExitCode ?? -1, stdout, stderr };
  }

  /** Raw (binary-safe) exec output stream of `{ stream, data }` chunks — used to stream a database dump to disk. */
  async execStream(id: string, cmd: string[], env?: string[], signal?: AbortSignal): Promise<{ execId: string; output: DockerStreamDemuxer }> {
    const created = await this.call<{ Id: string }>('POST', `/containers/${encodeURIComponent(id)}/exec`, {
      body: { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: cmd, ...(env === undefined ? {} : { Env: env }) },
    });
    const response = await this.stream('POST', `/exec/${created.Id}/start`, {
      body: { Detach: false, Tty: false },
      ...(signal === undefined ? {} : { signal }),
    });
    const demux = new DockerStreamDemuxer({ raw: true });
    response.on('error', (error) => demux.destroy(error));
    return { execId: created.Id, output: response.pipe(demux) };
  }

  async execExitCode(execId: string): Promise<number> {
    const inspect = await this.call<{ ExitCode: number | null }>('GET', `/exec/${execId}/json`);
    return inspect.ExitCode ?? -1;
  }

  /**
   * Start an interactive process with a TTY and return the hijacked connection.
   * Docker answers `101 UPGRADED` and turns the HTTP connection into a raw
   * byte pipe: writes reach the process's stdin, reads are its terminal output
   * (a TTY is not multiplexed).
   */
  async execTty(id: string, cmd: string[], options: { cols: number; rows: number; env?: string[] }): Promise<{ execId: string; socket: Duplex }> {
    const created = await this.call<{ Id: string }>('POST', `/containers/${encodeURIComponent(id)}/exec`, {
      body: { AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: cmd, Env: options.env ?? [] },
    });
    const socket = await this.upgrade(`/exec/${created.Id}/start`, { Detach: false, Tty: true });
    await this.resizeExec(created.Id, options.cols, options.rows);
    return { execId: created.Id, socket };
  }

  /** Resize an exec's TTY. A process that already exited cannot be resized, which is harmless. */
  async resizeExec(execId: string, cols: number, rows: number): Promise<void> {
    try {
      await this.call('POST', `/exec/${execId}/resize`, { query: { h: rows, w: cols }, timeoutMs: 10_000 });
    } catch (error) {
      if (error instanceof DockerError) return;
      throw error;
    }
  }

  /** POST with `Upgrade: tcp` and resolve with the raw socket once the daemon switches protocols. */
  private async upgrade(path: string, body: unknown): Promise<Duplex> {
    await this.ensureVersion();
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath: this.socketPath,
        // A hijacked connection never returns to a pool.
        agent: false,
        method: 'POST',
        path: `/v${this.apiVersion}${path}`,
        headers: { Host: 'docker', 'Content-Type': 'application/json', 'Content-Length': String(payload.length), Connection: 'Upgrade', Upgrade: 'tcp' },
      });
      req.setTimeout(30_000, () => req.destroy(new Error(`Docker request timed out: POST ${path}`)));
      req.on('upgrade', (_response, socket, head) => {
        req.setTimeout(0);
        socket.setTimeout(0);
        if (head.length > 0) socket.unshift(head);
        resolve(socket);
      });
      req.on('response', (response) => {
        // No upgrade: the daemon refused (container stopped, exec gone).
        this.fail(response).catch(reject);
      });
      req.on('error', (error: NodeJS.ErrnoException) => {
        reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'EACCES' ? new DockerUnavailableError(`Docker is not reachable at ${this.socketPath} (${error.code})`) : error);
      });
      req.end(payload);
    });
  }

  /** Live daemon events filtered to containers managed by the platform. */
  async events(filters: Record<string, string[]>, signal: AbortSignal): Promise<AsyncIterable<DockerEvent>> {
    const response = await this.stream('GET', '/events', { query: { filters }, signal });
    const parser = new JsonLinesParser();
    response.on('error', (error) => parser.destroy(error));
    return response.pipe(parser) as AsyncIterable<DockerEvent>;
  }
}

/** CPU% from two cumulative samples, scaled to the number of online CPUs (100% = one full core). */
export function cpuPercent(previous: StatsSample, current: StatsSample): number {
  const cpuDelta = current.cpu_stats.cpu_usage.total_usage - previous.cpu_stats.cpu_usage.total_usage;
  const systemDelta = (current.cpu_stats.system_cpu_usage ?? 0) - (previous.cpu_stats.system_cpu_usage ?? 0);
  const cpus = current.cpu_stats.online_cpus ?? 1;
  if (cpuDelta <= 0 || systemDelta <= 0) return 0;
  return (cpuDelta / systemDelta) * cpus * 100;
}

/** Working-set memory, matching `docker stats` (cache excluded; cgroup v1 and v2). */
export function memoryUsage(sample: StatsSample): number {
  const usage = sample.memory_stats.usage ?? 0;
  const stats = sample.memory_stats.stats ?? {};
  const cache = stats.inactive_file ?? stats.total_inactive_file ?? 0;
  return Math.max(0, usage - cache);
}

export function networkTotals(sample: StatsSample): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const network of Object.values(sample.networks ?? {})) {
    rx += network.rx_bytes;
    tx += network.tx_bytes;
  }
  return { rx, tx };
}
