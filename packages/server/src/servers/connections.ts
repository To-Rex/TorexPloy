/**
 * One live Docker connection per server.
 *
 * Local server → the daemon socket. SSH server → a {@link DockerTunnel}.
 * Callers ask for `docker(serverId)` and never care which it is.
 */
import { DockerClient } from '../docker/client.ts';
import type { AppConfig } from '../lib/config.ts';
import { AppError } from '../lib/errors.ts';
import type { Logger } from '../lib/logger.ts';
import type { ProcessResult } from '../lib/process.ts';
import type { Secrets } from '../lib/secrets.ts';
import type { ServerRecord } from '../store/servers.ts';
import type { Stores } from '../store/index.ts';
import { DockerTunnel, SshSession } from './ssh.ts';

interface Connection {
  server: ServerRecord;
  docker: DockerClient;
  session: SshSession | null;
  tunnel: DockerTunnel | null;
}

export class ConnectionManager {
  private readonly config: AppConfig;
  private readonly stores: Stores;
  private readonly secrets: Secrets;
  private readonly logger: Logger;
  private readonly connections = new Map<string, Promise<Connection>>();

  constructor(config: AppConfig, stores: Stores, secrets: Secrets, logger: Logger) {
    this.config = config;
    this.stores = stores;
    this.secrets = secrets;
    this.logger = logger.child({ component: 'connections' });
  }

  private requireServer(serverId: string): ServerRecord {
    const server = this.stores.servers.get(serverId);
    if (server === undefined) throw new AppError('not_found', 'Server not found', { params: { resource: 'server' } });
    return server;
  }

  /** Build an SSH session for a server, decrypting its key. */
  sessionFor(server: ServerRecord): SshSession {
    if (server.kind !== 'ssh' || server.host === null || server.sshPrivateKey === null) {
      throw new AppError('bad_request', 'Server is not reachable over SSH');
    }
    return new SshSession(
      {
        serverId: server.id,
        host: server.host,
        port: server.port ?? 22,
        username: server.username ?? 'root',
        privateKey: this.secrets.open(server.sshPrivateKey, 'ssh'),
        hostKey: server.hostKey,
      },
      this.logger,
    );
  }

  private async open(serverId: string): Promise<Connection> {
    const server = this.requireServer(serverId);
    if (server.kind === 'local') {
      return { server, docker: new DockerClient(this.config.dockerSocket), session: null, tunnel: null };
    }
    if (server.hostKey === null) {
      throw new AppError('server_unreachable', 'Server has not been verified yet', { params: { server: server.name } });
    }
    const session = this.sessionFor(server);
    const tunnel = new DockerTunnel(session);
    await tunnel.start();
    return { server, docker: new DockerClient(tunnel.socketPath), session, tunnel };
  }

  private connection(serverId: string): Promise<Connection> {
    let existing = this.connections.get(serverId);
    if (existing === undefined) {
      existing = this.open(serverId);
      this.connections.set(serverId, existing);
      existing.catch(() => this.connections.delete(serverId));
    }
    return existing;
  }

  async docker(serverId: string): Promise<DockerClient> {
    return (await this.connection(serverId)).docker;
  }

  /** Run a shell command on an SSH server's host. Returns null for the local server. */
  async shell(serverId: string, command: string, timeoutMs = 60_000): Promise<ProcessResult | null> {
    const connection = await this.connection(serverId);
    if (connection.session === null) return null;
    return connection.session.exec(command, { timeoutMs });
  }

  /** Drop a cached connection (server edited, deleted or re-verified). */
  async invalidate(serverId: string): Promise<void> {
    const pending = this.connections.get(serverId);
    this.connections.delete(serverId);
    if (pending === undefined) return;
    try {
      const connection = await pending;
      connection.docker.close();
      await connection.tunnel?.stop();
      await connection.session?.closeMaster();
      connection.session?.dispose();
    } catch {
      // The connection never opened; nothing to tear down.
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((serverId) => this.invalidate(serverId)));
  }
}
