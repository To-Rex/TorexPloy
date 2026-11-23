/**
 * Commands on a server's host.
 *
 * An SSH server runs them over the panel's SSH session. The local host has
 * no such session (the control plane is itself a container on it), so there
 * a short-lived privileged container enters the host's namespaces and runs
 * the command as the host would: the same technique `docker run --privileged
 * --pid=host` gives an administrator at a terminal, and nothing an
 * administrator of the Docker socket could not already do.
 *
 * The container is attached to rather than logged, so a command's output
 * never lands in a log file on the host, and it is removed as soon as the
 * command ends.
 */
import type { Duplex } from 'node:stream';
import type { Context } from '../context.ts';
import { DockerStreamDemuxer } from '../docker/client.ts';
import { LABEL_MANAGED, LABEL_ROLE } from '../docker/naming.ts';
import { AppError, errorMessage } from '../lib/errors.ts';
import { randomId } from '../lib/ids.ts';

export interface ShellResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ShellOptions {
  /** Text fed to the command's standard input. */
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Runs a shell command on a server's host. Tests pass one that answers from a script. */
export type HostShell = (serverId: string, command: string, options: ShellOptions) => Promise<ShellResult>;

export const SHELL_ROLE = 'ai-shell';
const MAX_OUTPUT = 2_000_000;

/** `nsenter` into the host where the image has it, a chroot into the mounted root where it does not. */
const ENTER = 'if command -v nsenter >/dev/null 2>&1; then exec nsenter -t 1 -m -u -i -n -p -- sh -c "$PLOY_AI_CMD"; else exec chroot /host sh -c "$PLOY_AI_CMD"; fi';

export function dockerHostShell(ctx: Context): HostShell {
  return async (serverId, command, options) => {
    const server = ctx.stores.servers.get(serverId);
    if (server === undefined) throw new AppError('not_found', 'Server not found', { params: { resource: 'server' } });
    if (server.kind === 'ssh') {
      const result = options.stdin === undefined ? await ctx.connections.shell(serverId, command, options.timeoutMs) : await ctx.connections.shellWithInput(serverId, command, options.stdin, options.timeoutMs);
      if (result === null) throw new AppError('server_unreachable', 'The server has no SSH session', { params: { server: server.name } });
      return { code: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
    }

    const docker = await ctx.connections.docker(serverId);
    const image = ctx.config.proxyImage;
    if ((await docker.inspectImage(image)) === null) await docker.pullImage(image);
    const name = `ploy-ai-shell-${randomId(10).toLowerCase()}`;
    const withInput = options.stdin !== undefined;
    const id = await docker.createContainer(name, {
      Image: image,
      Entrypoint: ['sh', '-c'],
      Cmd: [ENTER],
      Env: [`PLOY_AI_CMD=${command}`, 'HOME=/root', 'TERM=dumb'],
      AttachStdin: withInput,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: withInput,
      StdinOnce: withInput,
      Tty: false,
      Labels: { [LABEL_MANAGED]: 'true', [LABEL_ROLE]: SHELL_ROLE },
      HostConfig: {
        Privileged: true,
        PidMode: 'host',
        NetworkMode: 'host',
        Binds: ['/:/host'],
        AutoRemove: false,
        LogConfig: { Type: 'none', Config: {} },
      },
    });
    const remove = (): Promise<void> => docker.removeContainer(id, { force: true }).catch((error: unknown) => {
      if (!/no such container|not found|already in progress/i.test(errorMessage(error))) ctx.logger.warn('Could not remove a shell container', { container: name, error: errorMessage(error) });
    });

    let socket: Duplex | null = null;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const stop = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      stop.abort();
    }, options.timeoutMs);
    const onAbort = (): void => stop.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      socket = await docker.attach(id);
      const demux = new DockerStreamDemuxer({ raw: true });
      socket.pipe(demux);
      socket.on('error', () => undefined);
      demux.on('data', (chunk: { stream: 'stdout' | 'stderr'; data: Buffer }) => {
        if (chunk.stream === 'stdout') {
          if (stdout.length < MAX_OUTPUT) stdout += chunk.data.toString('utf8');
        } else if (stderr.length < MAX_OUTPUT) stderr += chunk.data.toString('utf8');
      });
      const drained = new Promise<void>((resolve) => {
        demux.on('end', resolve);
        demux.on('close', resolve);
        demux.on('error', () => resolve());
      });
      await docker.startContainer(id);
      if (withInput) socket.end(options.stdin);
      const code = await docker.waitContainer(id, stop.signal).catch((error: unknown) => {
        if (stop.signal.aborted) return null;
        throw error;
      });
      if (code !== null) await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (options.signal?.aborted === true && !timedOut) throw new DOMException('Aborted', 'AbortError');
      return { code, stdout, stderr, timedOut };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      socket?.destroy();
      await remove();
    }
  };
}

/** Remove shell containers a previous run of the panel left behind. */
export async function sweepShells(ctx: Context): Promise<void> {
  for (const server of ctx.stores.servers.listAll()) {
    if (server.kind !== 'local' || server.status !== 'ready') continue;
    try {
      const docker = await ctx.connections.docker(server.id);
      const stale = await docker.listContainers({ label: [`${LABEL_ROLE}=${SHELL_ROLE}`] });
      for (const container of stale) await docker.removeContainer(container.Id, { force: true }).catch(() => undefined);
    } catch (error) {
      ctx.logger.debug('Could not sweep shell containers', { error: errorMessage(error) });
    }
  }
}
