/**
 * Server lifecycle: add, verify, bootstrap, monitor, remove.
 *
 * "Verify" is the one idempotent operation that takes a server from any state
 * to ready: it checks SSH (recording the host key on first contact), checks
 * Docker, creates the platform network and starts or repairs the proxy. It is
 * safe to run at any time — the dashboard's "Reconnect" button runs it.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { hostname } from 'node:os';
import { emit, type Context } from '../context.ts';
import { DockerUnavailableError } from '../docker/client.ts';
import { LABEL_MANAGED, PLATFORM_NETWORK } from '../docker/naming.ts';
import { AppError, errorMessage, reasonOf } from '../lib/errors.ts';
import { cpuBusyPercent, parseRemoteProbe, readLocalHost, REMOTE_PROBE, type CpuTimes, type HostReading } from '../metrics/host.ts';
import type { ServerRecord } from '../store/servers.ts';
import { describeSshFailure, generateKeyPair, SshError, sshFailureReason } from './ssh.ts';

const PUBLIC_IP_ENDPOINTS = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];

export class ServerManager {
  private readonly ctx: Context;
  private readonly verifying = new Map<string, Promise<ServerRecord>>();
  private readonly lastCpu = new Map<string, CpuTimes>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  private setStatus(server: ServerRecord, status: ServerRecord['status'], message: string | null, reason: string | null = null): void {
    this.ctx.stores.servers.setStatus(server.id, status, message, reason);
    if (server.status !== status || server.statusMessage !== message) {
      emit(this.ctx, server.teamId, { type: 'server.updated', id: server.id, status });
    }
  }

  async createSsh(teamId: string, input: { name: string; host: string; port: number; username: string }): Promise<ServerRecord> {
    const keys = await generateKeyPair(`torexploy-${input.name.replace(/\s+/g, '-').toLowerCase()}`);
    return this.ctx.stores.servers.createSsh({
      teamId,
      ...input,
      sealedPrivateKey: this.ctx.secrets.seal(keys.privateKey, 'ssh'),
      publicKey: keys.publicKey,
    });
  }

  /** Bring a server to `ready`. Concurrent calls for one server share a single run. */
  verify(serverId: string): Promise<ServerRecord> {
    const existing = this.verifying.get(serverId);
    if (existing !== undefined) return existing;
    const run = this.runVerify(serverId).finally(() => this.verifying.delete(serverId));
    this.verifying.set(serverId, run);
    return run;
  }

  private async runVerify(serverId: string): Promise<ServerRecord> {
    const { stores, connections, proxy } = this.ctx;
    const server = stores.servers.get(serverId);
    if (server === undefined) throw new AppError('not_found', 'Server not found', { params: { resource: 'server' } });
    this.setStatus(server, 'connecting', null);

    try {
      if (server.kind === 'ssh') {
        const session = connections.sessionFor(server);
        try {
          if (server.hostKey === null) {
            const learned = await session.learnHostKey();
            stores.servers.setHostKey(server.id, learned.hostKey, learned.fingerprint);
          }
          const probe = await session.exec('command -v docker >/dev/null 2>&1 && docker info --format "{{.ServerVersion}}" 2>&1 || echo __NO_DOCKER__', { timeoutMs: 30_000 });
          if (probe.code !== 0) throw new AppError('server_unreachable', describeSshFailure(probe), { params: { reason: sshFailureReason(probe) } });
          if (probe.stdout.includes('__NO_DOCKER__')) {
            throw new AppError('docker_unavailable', 'Docker is not installed on this server. Use “Install Docker”, or install it manually.', { params: { reason: 'docker_missing' } });
          }
          if (/permission denied/i.test(probe.stdout)) {
            throw new AppError('docker_unavailable', `User ${server.username} cannot access Docker. Add it to the docker group or connect as root.`, { params: { reason: 'docker_permission' } });
          }
        } finally {
          await session.closeMaster();
          session.dispose();
        }
      }

      await connections.invalidate(server.id);
      const docker = await connections.docker(server.id);
      const version = await docker.negotiate();
      const info = await docker.info();
      stores.servers.setDockerInfo(server.id, {
        version: version.Version,
        apiVersion: version.ApiVersion,
        os: info.OperatingSystem,
        arch: info.Architecture,
        cpus: info.NCPU,
        memoryBytes: info.MemTotal,
      });

      await docker.ensureNetwork(PLATFORM_NETWORK, { [LABEL_MANAGED]: 'true' });
      if (server.kind === 'local') await this.attachSelf();
      await proxy.ensureProxy(server.id);

      if (server.publicIp === null) stores.servers.setPublicIp(server.id, await this.detectPublicIp(server));
      this.setStatus(stores.servers.get(server.id)!, 'ready', null);
      await proxy.requestSync(server.id).catch((error) => this.ctx.logger.warn('Initial proxy sync failed', { serverId, error: errorMessage(error) }));
      // Anything that was waiting on this server can run now.
      this.ctx.deployer.tick();
      void this.ctx.reconciler.reconcileServer(server.id).catch(() => undefined);
    } catch (error) {
      const message =
        error instanceof DockerUnavailableError
          ? server.kind === 'local'
            ? `Docker is not reachable at ${this.ctx.config.dockerSocket}. Mount the Docker socket into the control-plane container.`
            : error.message
          : errorMessage(error);
      const reason = error instanceof SshError ? error.reason : reasonOf(error);
      this.setStatus(stores.servers.get(server.id)!, 'error', message, reason);
      this.ctx.logger.warn('Server verification failed', { serverId, error: message, reason });
    }
    return stores.servers.get(server.id)!;
  }

  /**
   * When the control plane runs as a container, join the platform network so
   * the proxy can reach the dashboard by name. A no-op outside Docker.
   */
  private async attachSelf(): Promise<void> {
    const local = this.ctx.stores.servers.getLocal();
    if (local === undefined) return;
    const docker = await this.ctx.connections.docker(local.id);
    const self = await docker.inspectContainer(hostname());
    if (self === null) return;
    const alias = this.ctx.config.controlUpstream.split(':')[0]!;
    if (self.NetworkSettings.Networks[PLATFORM_NETWORK] === undefined) await docker.connectNetwork(PLATFORM_NETWORK, self.Id, [alias]);
  }

  private async detectPublicIp(server: ServerRecord): Promise<string | null> {
    if (server.kind === 'ssh' && server.host !== null) {
      if (isIP(server.host) !== 0) return server.host;
      try {
        return (await lookup(server.host, { family: 4 })).address;
      } catch {
        return null;
      }
    }
    for (const endpoint of PUBLIC_IP_ENDPOINTS) {
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(4_000) });
        const text = (await response.text()).trim();
        if (response.ok && isIP(text) !== 0) return text;
      } catch {
        // try the next endpoint
      }
    }
    return null;
  }

  /** Create the shared local server on first boot and verify it. */
  async bootstrapLocal(): Promise<void> {
    if (this.ctx.stores.servers.getLocal() === undefined) this.ctx.stores.servers.ensureLocal(process.env.PLOY_SERVER_NAME?.trim() || 'main');
    await this.verify(this.ctx.stores.servers.getLocal()!.id);
  }

  /** Install Docker on an SSH server with the official convenience script (root or passwordless sudo). */
  async installDocker(serverId: string): Promise<{ ok: boolean; output: string }> {
    const server = this.ctx.stores.servers.get(serverId);
    if (server === undefined || server.kind !== 'ssh') throw new AppError('bad_request', 'Only SSH servers can be provisioned');
    const session = this.ctx.connections.sessionFor(server);
    try {
      if (server.hostKey === null) {
        const learned = await session.learnHostKey();
        this.ctx.stores.servers.setHostKey(server.id, learned.hostKey, learned.fingerprint);
      }
      const script = 'set -e; SUDO=""; if [ "$(id -u)" != "0" ]; then SUDO="sudo -n"; fi; curl -fsSL https://get.docker.com | $SUDO sh; $SUDO systemctl enable --now docker >/dev/null 2>&1 || true; if [ -n "$SUDO" ]; then $SUDO usermod -aG docker "$(id -un)"; fi';
      const result = await session.exec(script, { timeoutMs: 15 * 60_000 });
      return { ok: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-40).join('\n') };
    } finally {
      await session.closeMaster();
      session.dispose();
    }
  }

  /** Periodic liveness: a ready server that stops answering goes offline, and comes back by itself. */
  async refresh(): Promise<void> {
    for (const server of this.ctx.stores.servers.listAll()) {
      if (server.status === 'pending' || server.status === 'connecting') continue;
      if (server.status === 'error' && server.hostKey === null && server.kind === 'ssh') continue;
      let alive = false;
      try {
        alive = await (await this.ctx.connections.docker(server.id)).ping();
      } catch {
        alive = false;
      }
      if (alive && server.status !== 'ready') {
        const wasOffline = server.status === 'offline';
        void this.verify(server.id)
          .then((verified) => {
            if (wasOffline && verified.status === 'ready') this.ctx.notifier.serverRecovered(verified);
          })
          .catch(() => undefined);
      } else if (!alive && server.status === 'ready') {
        await this.ctx.connections.invalidate(server.id);
        this.setStatus(server, 'offline', 'The server stopped responding', 'not_responding');
        this.ctx.notifier.serverOffline(server, null);
      } else if (alive) {
        this.ctx.stores.servers.setStatus(server.id, 'ready', null);
      }
    }
  }

  async hostReading(server: ServerRecord): Promise<{ cpu: number; reading: HostReading } | null> {
    let reading: HostReading | null;
    if (server.kind === 'local') {
      reading = await readLocalHost(this.ctx.config.hostProc, this.ctx.config.dataDir);
    } else {
      const result = await this.ctx.connections.shell(server.id, REMOTE_PROBE, 20_000);
      reading = result !== null && result.code === 0 ? parseRemoteProbe(result.stdout) : null;
    }
    if (reading === null) return null;
    const previous = this.lastCpu.get(server.id);
    if (reading.cpu !== null) this.lastCpu.set(server.id, reading.cpu);
    const cpu = previous !== undefined && reading.cpu !== null ? cpuBusyPercent(previous, reading.cpu) : 0;
    return { cpu, reading };
  }

  async remove(server: ServerRecord): Promise<void> {
    const usage = this.ctx.stores.servers.usage(server.id);
    if (usage.applications > 0 || usage.services > 0) {
      throw new AppError('conflict', 'Move or delete the applications and databases on this server first', { params: { reason: 'in_use' } });
    }
    if (server.kind === 'local') throw new AppError('bad_request', 'The control-plane host cannot be removed');
    await this.ctx.connections.invalidate(server.id);
    this.ctx.stores.servers.delete(server.id);
  }
}
