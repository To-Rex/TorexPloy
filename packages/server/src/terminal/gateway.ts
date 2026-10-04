/**
 * Interactive shells in application and service containers.
 *
 * The browser opens a WebSocket at `/api/applications/:id/terminal` or
 * `/api/services/:id/terminal`. The upgrade is authorized before the protocol
 * switch — session cookie, same-origin check, developer role in the owning
 * team — and the container is resolved on the server (a client never names
 * a container). The socket is then bridged to a Docker exec with a TTY over
 * the Engine API's hijacked connection, so it works the same for the local
 * host and for SSH servers.
 *
 * Wire protocol: binary frames carry keystrokes (client → server) and
 * terminal output (server → client). Text frames carry JSON control
 * messages: `{"type":"resize","cols","rows"}` from the client;
 * `{"type":"ready"}`, `{"type":"exit","code"}` and `{"type":"error","code"}`
 * from the server.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { roleAtLeast } from '@ploy/shared';
import type { Context } from '../context.ts';
import { DockerError, DockerUnavailableError } from '../docker/client.ts';
import { errorMessage } from '../lib/errors.ts';
import { isPrivateAddress, SESSION_COOKIE, sessionAuth } from '../http/core.ts';

const PATH = /^\/api\/(applications|services)\/([A-Za-z0-9_-]{1,64})\/terminal$/;
const SHELLS = {
  auto: ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'],
  bash: ['bash'],
  sh: ['sh'],
} as const;
export type TerminalShell = keyof typeof SHELLS;

/** Close a session nobody has typed into for this long. */
const IDLE_MS = 30 * 60_000;
const PING_MS = 25_000;
const MAX_SESSIONS_PER_USER = 8;
/** Pause the container's output while the browser is this far behind. */
const BACKPRESSURE_BYTES = 1_000_000;

interface Target {
  teamId: string;
  userId: string;
  serverId: string;
  container: string;
  kind: 'application' | 'service';
  id: string;
  name: string;
  ip: string;
}

class Rejection extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (header(req, 'cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index !== -1 && part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** The origin the browser used, by the same rules as the HTTP API (forwarded headers only from the proxy). */
function expectedOrigin(req: IncomingMessage): string {
  const trusted = isPrivateAddress(req.socket.remoteAddress ?? '');
  const https = trusted && header(req, 'x-forwarded-proto') === 'https';
  const host = (trusted ? header(req, 'x-forwarded-host') : undefined) ?? header(req, 'host') ?? '';
  return `${https ? 'https' : 'http'}://${host}`;
}

function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? '0.0.0.0';
  const forwarded = isPrivateAddress(peer) ? header(req, 'x-forwarded-for')?.split(',')[0]?.trim() : undefined;
  return (forwarded !== undefined && forwarded.length > 0 ? forwarded : peer).replace(/^::ffff:/, '');
}

function refuse(socket: Duplex, status: number, message: string): void {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : status === 429 ? 'Too Many Requests' : 'Bad Request';
  const body = JSON.stringify({ error: { message } });
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

function clamp(value: string | null, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export class TerminalGateway {
  private readonly ctx: Context;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  private readonly perUser = new Map<string, number>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** Take over WebSocket upgrades for terminal paths; anything else is refused. */
  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on('error', () => socket.destroy());
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        refuse(socket, 400, 'Bad request');
        return;
      }
      const match = PATH.exec(url.pathname);
      if (match === null) {
        refuse(socket, 404, 'Not found');
        return;
      }
      const shellParam = url.searchParams.get('shell') ?? 'auto';
      const shell: TerminalShell = shellParam in SHELLS ? (shellParam as TerminalShell) : 'auto';
      const cols = clamp(url.searchParams.get('cols'), 20, 500, 120);
      const rows = clamp(url.searchParams.get('rows'), 5, 200, 32);
      void (async () => {
        let target: Target;
        try {
          target = await this.authorize(req, match[1] === 'services' ? 'service' : 'application', match[2]!, url.searchParams);
        } catch (error) {
          refuse(socket, error instanceof Rejection ? error.status : 400, errorMessage(error));
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => void this.bridge(ws, target, shell, cols, rows));
      })();
    });
  }

  private async authorize(req: IncomingMessage, kind: Target['kind'], id: string, params: URLSearchParams): Promise<Target> {
    const origin = header(req, 'origin');
    if (origin === undefined || origin !== expectedOrigin(req)) throw new Rejection(403, 'Cross-origin terminal rejected');
    const token = cookie(req, SESSION_COOKIE);
    const auth = token === undefined ? null : sessionAuth(this.ctx, token);
    if (auth === null) throw new Rejection(401, 'Sign in to open a terminal');
    if (auth.teamId === null || auth.role === null || !roleAtLeast(auth.role, 'developer')) throw new Rejection(403, 'Opening a terminal requires the developer role');
    if ((this.perUser.get(auth.user.id) ?? 0) >= MAX_SESSIONS_PER_USER) throw new Rejection(429, 'Too many open terminals');
    const { stores } = this.ctx;
    const base = { teamId: auth.teamId, userId: auth.user.id, kind, id, ip: clientIp(req) };

    if (kind === 'service') {
      const service = stores.services.getForTeam(auth.teamId, id);
      if (service === undefined) throw new Rejection(404, 'Service not found');
      return { ...base, serverId: service.serverId, container: service.containerName, name: service.name };
    }
    const app = stores.applications.getForTeam(auth.teamId, id);
    if (app === undefined) throw new Rejection(404, 'Application not found');
    if (app.kind === 'compose') {
      // The container is looked up by its compose service on the server; the client never names it.
      const service = params.get('service');
      const stack = await this.ctx.compose.containers(app).catch(() => []);
      const container = stack.find((candidate) => candidate.state === 'running' && (service === null || candidate.service === service));
      if (container === undefined) throw new Rejection(404, 'No running container for this service');
      return { ...base, serverId: app.serverId, container: container.name, name: `${app.name}/${container.service}` };
    }
    const active = app.activeDeploymentId === null ? undefined : stores.deployments.get(app.activeDeploymentId);
    const containers = active?.containers ?? [];
    const replica = clamp(params.get('replica'), 0, Math.max(0, containers.length - 1), 0);
    const container = containers[replica];
    if (container === undefined) throw new Rejection(404, 'The application has no running containers');
    return { ...base, serverId: app.serverId, container, name: app.name };
  }

  private control(ws: WebSocket, message: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  private async bridge(ws: WebSocket, target: Target, shell: TerminalShell, cols: number, rows: number): Promise<void> {
    const { logger, stores } = this.ctx;
    this.perUser.set(target.userId, (this.perUser.get(target.userId) ?? 0) + 1);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const open = (this.perUser.get(target.userId) ?? 1) - 1;
      if (open <= 0) this.perUser.delete(target.userId);
      else this.perUser.set(target.userId, open);
    };
    ws.once('close', release);

    let exec: { execId: string; socket: Duplex };
    try {
      const docker = await this.ctx.connections.docker(target.serverId);
      exec = await docker.execTty(target.container, [...SHELLS[shell]], { cols, rows, env: ['TERM=xterm-256color', 'COLORTERM=truecolor'] });
    } catch (error) {
      const code = error instanceof DockerUnavailableError ? 'server_unavailable' : error instanceof DockerError && (error.isConflict || error.isNotFound) ? 'not_running' : 'failed';
      this.control(ws, { type: 'error', code, message: errorMessage(error) });
      ws.close(1011, code);
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      exec.socket.destroy();
      return;
    }

    const { execId, socket } = exec;
    stores.audit.record({
      teamId: target.teamId,
      userId: target.userId,
      action: 'terminal.opened',
      targetType: target.kind,
      targetId: target.id,
      targetName: target.name,
      ip: target.ip,
      metadata: { container: target.container, shell },
    });
    this.control(ws, { type: 'ready', container: target.container });

    let lastInput = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - lastInput > IDLE_MS) {
        this.control(ws, { type: 'error', code: 'idle' });
        ws.close(1000, 'idle');
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, PING_MS);

    socket.on('data', (chunk: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(chunk, { binary: true }, () => {
        if (socket.isPaused() && ws.bufferedAmount < BACKPRESSURE_BYTES / 2) socket.resume();
      });
      if (ws.bufferedAmount > BACKPRESSURE_BYTES) socket.pause();
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clearInterval(timer);
      void (async () => {
        let code: number | null = null;
        try {
          const docker = await this.ctx.connections.docker(target.serverId);
          code = await docker.execExitCode(execId);
        } catch {
          // The container may be gone; the session still ends cleanly.
        }
        this.control(ws, { type: 'exit', code });
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'exit');
      })();
    });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary) {
        lastInput = Date.now();
        socket.write(buffer);
        return;
      }
      let message: { type?: unknown; cols?: unknown; rows?: unknown };
      try {
        message = JSON.parse(buffer.toString('utf8')) as typeof message;
      } catch {
        return;
      }
      if (message.type === 'resize' && typeof message.cols === 'number' && typeof message.rows === 'number') {
        const nextCols = clamp(String(message.cols), 20, 500, cols);
        const nextRows = clamp(String(message.rows), 5, 200, rows);
        void this.ctx.connections
          .docker(target.serverId)
          .then((docker) => docker.resizeExec(execId, nextCols, nextRows))
          .catch((error: unknown) => logger.debug('Terminal resize failed', { error: errorMessage(error) }));
      }
    });
    ws.on('close', () => {
      clearInterval(timer);
      // Closing the hijacked connection closes the shell's stdin; the shell exits.
      socket.destroy();
    });
    ws.on('error', () => ws.terminate());
  }

  close(): void {
    for (const client of this.wss.clients) client.close(1001, 'shutdown');
    this.wss.close();
  }
}
