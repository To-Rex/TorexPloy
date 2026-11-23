/**
 * The panel's HTTP API, called in-process for the person TorexAi talks to.
 *
 * The request goes through the application's own middleware and route, so
 * everything that guards a dashboard click guards the assistant too: the
 * person's role in the team (looked up again for every call, so a role taken
 * away mid-conversation is gone at once), validation, and the audit log,
 * where the entry says it came through TorexAi.
 */
import type { Hono } from 'hono';
import type { TeamRole } from '@ploy/shared';
import type { Context } from '../context.ts';
import type { Auth, Env } from '../http/core.ts';
import { AppError } from '../lib/errors.ts';

/** The person a run acts for, as their own request described them. */
export interface Actor {
  userId: string;
  teamId: string;
  /** The session the message came in on; a step-up confirmed in it counts for the assistant's calls too. */
  sessionId: string | null;
  ip: string;
  /** The address the dashboard was opened at, so links the API builds (invitations, hooks) point there. */
  origin: string;
  chatId: string;
  /** Set when an outside agent acts over MCP: the app, and the token it came with (instead of TorexAi). */
  mcp?: { client: string; tokenId: string };
}

export interface ApiResult {
  status: number;
  ok: boolean;
  /** Parsed JSON, or the text of a non-JSON answer. */
  data: unknown;
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class InternalApi {
  private readonly ctx: Context;
  private app: Hono<Env> | null = null;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** The application is created after the context; it is handed over once it exists. */
  attach(app: Hono<Env>): void {
    this.app = app;
  }

  /** Who the actor is right now: the account, and the role they hold in the team at this moment. */
  auth(actor: Actor): Auth & { teamId: string; role: TeamRole } {
    const user = this.ctx.stores.users.getById(actor.userId);
    if (user === undefined) throw new AppError('unauthorized', 'The account no longer exists');
    const role = this.ctx.stores.teams.getRole(actor.teamId, user.id);
    if (role === undefined) throw new AppError('forbidden', 'You are no longer a member of this team');
    if (actor.mcp !== undefined) return { user, sessionId: null, tokenId: actor.mcp.tokenId, teamId: actor.teamId, role, mcp: actor.mcp.client };
    return { user, sessionId: actor.sessionId, tokenId: null, teamId: actor.teamId, role, ai: actor.chatId };
  }

  async call(actor: Actor, method: string, path: string, query: Record<string, string> = {}, body?: unknown, signal?: AbortSignal): Promise<ApiResult> {
    if (this.app === null) throw new AppError('internal_error', 'The API is not ready');
    const auth = this.auth(actor);
    const origin = new URL(actor.origin);
    const url = new URL(path, 'http://ploy.internal');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const upper = method.toUpperCase();
    const hasBody = body !== undefined && upper !== 'GET' && upper !== 'DELETE';
    const request = new Request(url, {
      method: upper,
      headers: {
        host: origin.host,
        'x-forwarded-host': origin.host,
        'x-forwarded-proto': origin.protocol.replace(':', ''),
        'x-ploy-request': '1',
        accept: 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
    const env = {
      incoming: { socket: { remoteAddress: '127.0.0.1' } },
      internalAuth: auth,
      internalIp: actor.ip,
    } as unknown as Env['Bindings'];
    const pending = Promise.resolve(this.app.fetch(request, env));
    const response = signal === undefined ? await pending : await Promise.race([pending, aborted(signal)]);
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('event-stream')) {
      void response.body?.cancel().catch(() => undefined);
      return { status: 400, ok: false, data: { error: { code: 'bad_request', message: 'This endpoint is a live stream and cannot be read this way' } } };
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      return { status: 413, ok: false, data: { error: { code: 'payload_too_large', message: 'The answer is too large to read; narrow the request' } } };
    }
    const text = await response.text();
    let data: unknown = text;
    if (type.includes('json') && text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, ok: response.ok, data };
  }
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
    else signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
}
