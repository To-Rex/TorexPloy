/**
 * SSH transport for remote servers.
 *
 * A remote server needs nothing installed but Docker and an authorized key.
 * The control plane reaches its Docker daemon through `docker system
 * dial-stdio` over SSH, exposed locally as a unix socket — so the Engine API
 * client and the BuildKit CLI work against a remote host exactly as they do
 * against the local socket.
 *
 * Security:
 * - One ed25519 key per server, generated here, stored encrypted.
 * - Host keys are trust-on-first-use: recorded on the first successful
 *   connection, enforced strictly afterwards (`StrictHostKeyChecking=yes`).
 * - `-F /dev/null` ignores any ambient SSH config; `BatchMode` forbids prompts.
 * - ControlMaster multiplexes every tunnel connection over one TCP session.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { runProcess, type ProcessResult } from '../lib/process.ts';
import type { Logger } from '../lib/logger.ts';

export interface SshTarget {
  serverId: string;
  host: string;
  port: number;
  username: string;
  privateKey: string;
  /** known_hosts lines recorded on first contact; null until then. */
  hostKey: string | null;
}

/**
 * Short private directory for sockets. Unix socket paths are limited to ~104
 * bytes, which a deep data directory can exceed, so sockets live here instead.
 */
export function runtimeDir(): string {
  const base = process.env.PLOY_RUN_DIR ?? `/tmp/torexploy-${process.getuid?.() ?? 0}`;
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const stat = statSync(base);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Runtime directory ${base} is owned by another user; refusing to use it`);
  }
  chmodSync(base, 0o700);
  return base;
}

/** Generate an ed25519 keypair with ssh-keygen. Returns OpenSSH-format private and public keys. */
export async function generateKeyPair(comment: string): Promise<{ privateKey: string; publicKey: string }> {
  const dir = join(runtimeDir(), `keygen-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { mode: 0o700 });
  const path = join(dir, 'id');
  try {
    const result = await runProcess('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', path], { timeoutMs: 15_000 });
    if (result.code !== 0) throw new Error(`ssh-keygen failed: ${result.stderr.trim()}`);
    return { privateKey: readFileSync(path, 'utf8'), publicKey: readFileSync(`${path}.pub`, 'utf8').trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export class SshSession {
  readonly target: SshTarget;
  private readonly dir: string;
  private readonly logger: Logger;

  constructor(target: SshTarget, logger: Logger) {
    this.target = target;
    this.logger = logger;
    this.dir = join(runtimeDir(), `ssh-${target.serverId.slice(-10)}`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.keyPath, this.target.privateKey.endsWith('\n') ? this.target.privateKey : `${this.target.privateKey}\n`, { mode: 0o600 });
    chmodSync(this.keyPath, 0o600);
    if (target.hostKey !== null) writeFileSync(this.knownHostsPath, `${target.hostKey.trim()}\n`, { mode: 0o600 });
  }

  get keyPath(): string {
    return join(this.dir, 'id');
  }

  get knownHostsPath(): string {
    return join(this.dir, 'known_hosts');
  }

  get controlPath(): string {
    return join(this.dir, 'cm');
  }

  /** Base arguments for every ssh invocation against this target. */
  args(options: { acceptNewHostKey?: boolean } = {}): string[] {
    const { host, port, username } = this.target;
    return [
      '-F', '/dev/null',
      '-i', this.keyPath,
      '-p', String(port),
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'PasswordAuthentication=no',
      '-o', `UserKnownHostsFile=${this.knownHostsPath}`,
      '-o', `StrictHostKeyChecking=${options.acceptNewHostKey === true ? 'accept-new' : 'yes'}`,
      '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${this.controlPath}`,
      '-o', 'ControlPersist=600',
      '-o', 'LogLevel=ERROR',
      `${username}@${host}`,
    ];
  }

  /** Run a command on the remote host through its login shell. */
  exec(command: string, options: { timeoutMs?: number; acceptNewHostKey?: boolean; stdin?: string } = {}): Promise<ProcessResult> {
    return runProcess('ssh', [...this.args(options), '--', command], {
      timeoutMs: options.timeoutMs ?? 60_000,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    });
  }

  /**
   * First contact: accept and record the host key, then return it with its
   * fingerprint for the operator to compare against the server's console.
   */
  async learnHostKey(): Promise<{ hostKey: string; fingerprint: string }> {
    if (existsSync(this.knownHostsPath)) unlinkSync(this.knownHostsPath);
    const result = await this.exec('true', { acceptNewHostKey: true, timeoutMs: 30_000 });
    if (result.code !== 0) throw new SshError(describeSshFailure(result), sshFailureReason(result));
    const hostKey = readFileSync(this.knownHostsPath, 'utf8').trim();
    const fingerprint = await runProcess('ssh-keygen', ['-l', '-E', 'sha256', '-f', this.knownHostsPath], { timeoutMs: 10_000 });
    const line = fingerprint.stdout.trim().split('\n')[0] ?? '';
    // "256 SHA256:abc… host (ED25519)" → "SHA256:abc… (ED25519)"
    const parts = line.split(/\s+/);
    return { hostKey, fingerprint: parts.length >= 2 ? `${parts[1]} ${parts[parts.length - 1]}` : line };
  }

  async closeMaster(): Promise<void> {
    if (!existsSync(this.controlPath)) return;
    await runProcess('ssh', [...this.args(), '-O', 'exit'], { timeoutMs: 10_000 }).catch(() => undefined);
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  get log(): Logger {
    return this.logger;
  }
}

export class SshError extends Error {
  override name = 'SshError';
  readonly reason: string;

  constructor(message: string, reason = 'ssh_error') {
    super(message);
    this.reason = reason;
  }
}

/** A stable reason code for an ssh failure (translated by the dashboard). */
export function sshFailureReason(result: ProcessResult): string {
  const stderr = result.stderr;
  if (result.timedOut) return 'ssh_timeout';
  if (/Permission denied/i.test(stderr)) return 'ssh_auth';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return 'ssh_hostkey';
  if (/Could not resolve hostname/i.test(stderr)) return 'ssh_dns';
  if (/Connection refused/i.test(stderr)) return 'ssh_refused';
  if (/No route to host|Network is unreachable|Connection timed out/i.test(stderr)) return 'ssh_unreachable';
  return 'ssh_error';
}

/** Turn ssh's stderr into an actionable message. */
export function describeSshFailure(result: ProcessResult): string {
  const stderr = result.stderr.trim();
  if (result.timedOut) return 'Connection timed out. Check the address, port and firewall.';
  if (/Permission denied/i.test(stderr)) return 'Permission denied. Add the public key to ~/.ssh/authorized_keys for this user.';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
    return 'Host key mismatch: the server identity changed since it was added. If this is expected, re-verify the server.';
  }
  if (/Could not resolve hostname/i.test(stderr)) return 'The hostname could not be resolved.';
  if (/Connection refused/i.test(stderr)) return 'Connection refused. Is SSH running on that port?';
  if (/No route to host|Network is unreachable/i.test(stderr)) return 'The server is unreachable from this host.';
  return stderr.length > 0 ? stderr.split('\n').slice(-3).join(' ') : `ssh exited with code ${result.code ?? 'signal'}`;
}

/**
 * Local unix socket that forwards each connection to the remote Docker daemon
 * via `ssh … docker system dial-stdio`. HTTP clients and the docker CLI can
 * point at {@link socketPath} and never know the daemon is remote.
 */
export class DockerTunnel {
  readonly socketPath: string;
  private readonly session: SshSession;
  private server: Server | null = null;
  private readonly connections = new Set<Socket>();
  private lastError: string | null = null;

  constructor(session: SshSession) {
    this.session = session;
    this.socketPath = join(runtimeDir(), `docker-${session.target.serverId.slice(-10)}.sock`);
  }

  get error(): string | null {
    return this.lastError;
  }

  async start(): Promise<void> {
    if (this.server !== null) return;
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);

    const server = createServer((socket) => this.forward(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(this.socketPath, 0o600);
    this.server = server;
  }

  private forward(socket: Socket): void {
    this.connections.add(socket);
    const child = spawn('ssh', [...this.session.args(), '--', 'docker', 'system', 'dial-stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4_000) stderr += chunk;
    });
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    child.stdin.on('error', () => socket.destroy());
    child.on('error', (error) => {
      this.lastError = error.message;
      socket.destroy();
    });
    child.on('exit', (code) => {
      if (code !== 0 && stderr.trim().length > 0) {
        this.lastError = describeSshFailure({ code, signal: null, stdout: '', stderr, timedOut: false, aborted: false, durationMs: 0 });
        this.session.log.warn('Docker tunnel connection failed', { serverId: this.session.target.serverId, error: this.lastError });
      }
      socket.end();
    });
    socket.on('error', () => child.kill('SIGTERM'));
    socket.on('close', () => {
      this.connections.delete(socket);
      if (child.exitCode === null) child.kill('SIGTERM');
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    const server = this.server;
    this.server = null;
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
  }
}
