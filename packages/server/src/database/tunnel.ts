/**
 * A byte pipe to a database inside a project network.
 *
 * Service containers publish no port unless asked, and the panel may manage
 * a server over SSH, so the console cannot simply dial the database. Instead
 * each connection gets a tiny container from the proxy image on the
 * project's network, running busybox `nc` to the database: the console
 * attaches to its stdin and stdout through the Docker API (the same channel
 * the terminal uses) and speaks the database protocol through it.
 *
 * The container lives exactly as long as the connection. It runs as nobody
 * with no capabilities, a read-only filesystem and no logging driver (its
 * stdout is the database's replies, which must not land in a log file).
 */
import { Duplex } from 'node:stream';
import type { Context } from '../context.ts';
import { DockerStreamDemuxer, type DockerClient } from '../docker/client.ts';
import { idPart, LABEL_MANAGED, LABEL_ROLE, LABEL_SERVICE } from '../docker/naming.ts';
import { errorMessage } from '../lib/errors.ts';
import { randomId } from '../lib/ids.ts';

export const TUNNEL_ROLE = 'db-tunnel';

export interface DbTarget {
  serviceId: string;
  serverId: string;
  network: string;
  host: string;
  port: number;
}

/** Opens a stream to a database. Tests pass one that dials a local server. */
export type DbConnector = (target: DbTarget) => Promise<Duplex>;

/** The tunnel as a plain duplex: database bytes in and out, `nc`'s complaints turned into an error. */
class TunnelStream extends Duplex {
  private readonly socket: Duplex;
  private readonly cleanup: () => Promise<void>;
  private stderr = '';
  private received = false;
  private cleaned = false;

  constructor(socket: Duplex, cleanup: () => Promise<void>) {
    super();
    this.socket = socket;
    this.cleanup = cleanup;
    const demux = new DockerStreamDemuxer({ raw: true });
    socket.pipe(demux);
    demux.on('data', (chunk: { stream: 'stdout' | 'stderr'; data: Buffer }) => {
      if (chunk.stream === 'stderr') {
        if (this.stderr.length < 2_000) this.stderr += chunk.data.toString('utf8');
        return;
      }
      this.received = true;
      if (!this.push(chunk.data)) socket.pause();
    });
    demux.on('end', () => {
      const complaint = this.stderr.trim();
      if (!this.received && complaint.length > 0) this.destroy(new Error(`Could not reach the database: ${complaint}`));
      else this.push(null);
    });
    socket.on('error', (error: Error) => this.destroy(error));
    socket.on('close', () => {
      if (!this.destroyed) this.push(null);
      void this.release();
    });
  }

  override _read(): void {
    this.socket.resume();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.socket.destroyed) {
      callback(new Error('The database tunnel is closed'));
      return;
    }
    this.socket.write(chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    // Closing stdin makes nc hang up; the container then exits and removes itself.
    this.socket.end();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.socket.destroy();
    void this.release();
    callback(error);
  }

  private async release(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    await this.cleanup();
  }
}

export function tunnelName(serviceId: string): string {
  return `ploy-dbtunnel-${idPart(serviceId, 10)}-${randomId(8).toLowerCase()}`;
}

/** The production connector: a tunnel container per connection. */
export function dockerConnector(ctx: Context): DbConnector {
  // Every connection waits for its server's sweep, so a sweep never removes a tunnel opened alongside it.
  const sweeps = new Map<string, Promise<void>>();
  return async (target) => {
    const docker = await ctx.connections.docker(target.serverId);
    let sweep = sweeps.get(target.serverId);
    if (sweep === undefined) {
      sweep = sweepTunnels(ctx, docker);
      sweeps.set(target.serverId, sweep);
    }
    await sweep;
    const image = ctx.config.proxyImage;
    if ((await docker.inspectImage(image)) === null) await docker.pullImage(image);
    const name = tunnelName(target.serviceId);
    const id = await docker.createContainer(name, {
      Image: image,
      Entrypoint: ['nc'],
      Cmd: [target.host, String(target.port)],
      User: '65534:65534',
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: true,
      StdinOnce: true,
      Tty: false,
      Labels: { [LABEL_MANAGED]: 'true', [LABEL_ROLE]: TUNNEL_ROLE, [LABEL_SERVICE]: target.serviceId },
      HostConfig: {
        NetworkMode: target.network,
        AutoRemove: true,
        Memory: 32 * 1024 * 1024,
        PidsLimit: 8,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        ReadonlyRootfs: true,
        LogConfig: { Type: 'none', Config: {} },
      },
    });
    const remove = async (): Promise<void> => {
      await docker.removeContainer(id, { force: true }).catch((error: unknown) => {
        if (!/no such container|not found|is already in progress/i.test(errorMessage(error))) ctx.logger.warn('Could not remove a database tunnel', { container: name, error: errorMessage(error) });
      });
    };
    let socket: Duplex | null = null;
    try {
      socket = await docker.attach(id);
      await docker.startContainer(id);
    } catch (error) {
      socket?.destroy();
      await remove();
      throw error;
    }
    return new TunnelStream(socket, remove);
  };
}

/** Remove tunnels left by an earlier run of the panel (their connections died with it). */
async function sweepTunnels(ctx: Context, docker: DockerClient): Promise<void> {
  try {
    const stale = await docker.listContainers({ label: [`${LABEL_ROLE}=${TUNNEL_ROLE}`] });
    for (const container of stale) await docker.removeContainer(container.Id, { force: true }).catch(() => undefined);
  } catch (error) {
    ctx.logger.warn('Could not sweep old database tunnels', { error: errorMessage(error) });
  }
}
