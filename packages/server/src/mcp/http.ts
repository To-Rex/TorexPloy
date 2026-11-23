/**
 * The MCP endpoint: `POST /mcp`, the Streamable HTTP transport.
 *
 * Every request carries a bearer token: one made by hand, by `torex login`,
 * or for an app connected over OAuth. Without one the answer is 401 with
 * the address of the OAuth metadata, which is how clients like claude.ai and
 * Claude Desktop discover that they can sign the person in.
 *
 * Requests of the stateless revision (2026-07-28) are checked as it requires:
 * the protocol version, the method and the name are mirrored in headers and
 * must match the body. Legacy requests (2025-11-25 and earlier) are answered
 * without a session: this server keeps none, which the legacy transport allows.
 *
 * Most answers are a single JSON object. A tool call that takes more than a
 * moment (a deployment to wait for, a slow command) is answered as a stream
 * instead, so nothing between the client and the panel gives up on an idle
 * connection; the client's progress token, when it sent one, gets progress
 * notifications on it. Closing that stream cancels the call.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { API_TOKEN_PREFIX } from '@ploy/shared';
import type { Context } from '../context.ts';
import { errorMessage } from '../lib/errors.ts';
import { clientIp, RateLimiter, requestOrigin, type Ctx, type Env } from '../http/core.ts';
import type { McpCaller, McpManager, McpRequestContext } from './manager.ts';
import {
  asMessage,
  declaredVersion,
  decodeHeaderValue,
  isLegacyVersion,
  isModernVersion,
  META,
  metaOf,
  NAMED_METHODS,
  nameOf,
  RPC,
  rpcError,
  rpcResult,
  RpcError,
  unsupportedVersion,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './protocol.ts';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** A call that answers within this is answered as plain JSON; a slower one is switched to a stream. */
const JSON_WAIT_MS = 2_500;
const KEEPALIVE_MS = 15_000;
const PROGRESS_MS = 10_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  } catch {
    return false;
  }
}

/** The address a client is told to read the OAuth metadata from. */
export function resourceMetadataUrl(c: Ctx): string {
  return `${requestOrigin(c)}/.well-known/oauth-protected-resource/mcp`;
}

/** The person, team and reach behind a bearer token; null when there is no usable token. */
function resolveCaller(ctx: Context, c: Ctx, token: string): McpCaller | null {
  const { stores } = ctx;
  if (!token.startsWith(API_TOKEN_PREFIX)) return null;
  const record = stores.tokens.resolve(token);
  if (record === undefined) return null;
  const user = stores.users.getById(record.userId);
  if (user === undefined || stores.teams.getRole(record.teamId, user.id) === undefined) return null;
  let client = record.client ?? record.name;
  let connection = `token:${record.id}`;
  if (record.kind === 'oauth') {
    const grant = record.grantId === null ? undefined : stores.oauth.grant(record.grantId);
    if (grant === undefined) return null;
    client = stores.oauth.client(grant.clientId)?.name ?? client;
    connection = `grant:${grant.id}`;
    if (grant.lastUsedAt === null || Date.now() - Date.parse(grant.lastUsedAt) > 60_000) stores.oauth.touchGrant(grant.id);
  }
  return { tokenId: record.id, kind: record.kind, userId: user.id, teamId: record.teamId, access: record.access, client, connection, ip: clientIp(c), origin: requestOrigin(c) };
}

/** The request body as text, refused past the limit even when no length was announced. */
async function readBody(c: Ctx): Promise<string | null> {
  const announced = Number(c.req.header('content-length') ?? NaN);
  if (Number.isFinite(announced) && announced > MAX_BODY_BYTES) return null;
  const stream = c.req.raw.body;
  if (stream === null) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function idOf(value: unknown): string | number | null {
  if (!isObject(value)) return null;
  return typeof value.id === 'string' || typeof value.id === 'number' ? value.id : null;
}

function errorResponse(id: string | number | null, error: unknown, modern: boolean): { status: number; body: JsonRpcResponse } {
  if (error instanceof RpcError) return { status: error.status, body: rpcError(id, error.code, error.message, error.data) };
  return { status: modern ? 500 : 200, body: rpcError(id, RPC.internalError, `Internal error: ${errorMessage(error)}`) };
}

export function registerMcpEndpoint(app: Hono<Env>, ctx: Context, mcp: McpManager): void {
  const limiter = new RateLimiter(240, 600);

  const unauthorized = (c: Ctx, presented: boolean) => {
    const challenge = ['realm="TorexPloy"'];
    if (mcp.settings().oauth) challenge.push(`resource_metadata="${resourceMetadataUrl(c)}"`);
    if (presented) challenge.push('error="invalid_token"', 'error_description="The token is invalid, has expired or was revoked"');
    return c.json(
      { error: presented ? 'invalid_token' : 'unauthorized', error_description: presented ? 'The token is invalid, has expired or was revoked' : 'Connect this app to TorexPloy first: sign in when it asks, or give it a token from Settings → CLI and MCP' },
      401,
      { 'WWW-Authenticate': `Bearer ${challenge.join(', ')}`, 'Cache-Control': 'no-store' },
    );
  };

  /** One message: era checks, then the answer as JSON, or as a stream when it takes a while. */
  const answer = async (c: Ctx, caller: McpCaller, message: JsonRpcRequest, allowStream: boolean): Promise<Response> => {
    const declared = declaredVersion(message);
    const headerVersion = c.req.header('mcp-protocol-version');
    const modern = declared !== null;
    const fail = (error: RpcError) => c.json(rpcError(message.id ?? null, error.code, error.message, error.data), error.status as 400);

    let context: Omit<McpRequestContext, 'signal'>;
    if (modern) {
      if (!isModernVersion(declared)) return fail(unsupportedVersion(declared));
      if (headerVersion === undefined || headerVersion !== declared) return fail(new RpcError(RPC.headerMismatch, `Header mismatch: MCP-Protocol-Version is ${headerVersion === undefined ? 'missing' : `'${headerVersion}'`}, the body says '${declared}'`, { status: 400 }));
      const methodHeader = c.req.header('mcp-method');
      if (methodHeader !== message.method) return fail(new RpcError(RPC.headerMismatch, `Header mismatch: Mcp-Method is ${methodHeader === undefined ? 'missing' : `'${methodHeader}'`}, the body says '${message.method}'`, { status: 400 }));
      if (NAMED_METHODS.has(message.method)) {
        const nameHeader = c.req.header('mcp-name');
        const decoded = nameHeader === undefined ? null : decodeHeaderValue(nameHeader);
        if (decoded === null || decoded !== nameOf(message)) return fail(new RpcError(RPC.headerMismatch, `Header mismatch: Mcp-Name ${nameHeader === undefined ? 'is missing' : 'does not match the body'}`, { status: 400 }));
      }
      const capabilities = metaOf(message)?.[META.clientCapabilities];
      if (!isObject(capabilities)) return fail(new RpcError(RPC.invalidParams, `A request must carry _meta "${META.clientCapabilities}"`, { status: 400 }));
      context = { caller, era: 'modern', version: declared, capabilities };
    } else {
      if (headerVersion !== undefined && isModernVersion(headerVersion)) {
        return fail(new RpcError(RPC.invalidParams, `A request for protocol version ${headerVersion} must carry _meta "${META.protocolVersion}" and "${META.clientCapabilities}"`, { status: 400 }));
      }
      if (headerVersion !== undefined && !isLegacyVersion(headerVersion)) return fail(unsupportedVersion(headerVersion));
      const params = message.params ?? {};
      const version = message.method === 'initialize' && typeof params.protocolVersion === 'string' ? params.protocolVersion : (headerVersion ?? '2025-03-26');
      context = { caller, era: 'legacy', version, capabilities: message.method === 'initialize' && isObject(params.capabilities) ? params.capabilities : {} };
    }

    if (message.id === undefined) {
      mcp.notify(caller, message);
      return c.body(null, 202);
    }
    const id = message.id;
    const tracked = mcp.track(caller, id, c.req.raw.signal);
    const work = mcp.handle(message, { ...context, signal: tracked.signal }).then(
      (result) => ({ status: 200, body: rpcResult(id, result) }),
      (error: unknown) => errorResponse(id, error, modern),
    );

    const streamable = allowStream && message.method === 'tools/call' && (c.req.header('accept') ?? '').includes('text/event-stream');
    if (!streamable) {
      const outcome = await work.finally(tracked.done);
      return c.json(outcome.body, outcome.status as 200);
    }
    const early = await Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), JSON_WAIT_MS))]);
    if (early !== null) {
      tracked.done();
      return c.json(early.body, early.status as 200);
    }

    // Still running: answer as a stream, so the connection is not idle while the call works.
    const progressToken = metaOf(message)?.progressToken;
    const started = Date.now();
    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache');
    return streamSSE(c, async (stream) => {
      let open = true;
      stream.onAbort(() => {
        open = false;
        // The client went away: that is how it cancels a streamed call.
        tracked.abort();
      });
      const keepalive = setInterval(() => {
        if (open) void stream.write(':\n\n').catch(() => undefined);
      }, KEEPALIVE_MS);
      const progress =
        typeof progressToken === 'string' || typeof progressToken === 'number'
          ? setInterval(() => {
              if (!open) return;
              const seconds = Math.round((Date.now() - started) / 1000);
              const note = { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: seconds, message: `Still working (${seconds} s)` } };
              void stream.writeSSE({ event: 'message', data: JSON.stringify(note) }).catch(() => undefined);
            }, PROGRESS_MS)
          : null;
      try {
        const outcome = await work;
        if (open) await stream.writeSSE({ event: 'message', data: JSON.stringify(outcome.body) });
      } finally {
        clearInterval(keepalive);
        if (progress !== null) clearInterval(progress);
        tracked.done();
      }
    });
  };

  app.post('/mcp', async (c) => {
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== requestOrigin(c) && !isLoopbackOrigin(origin)) {
      return c.json(rpcError(null, RPC.invalidRequest, 'This origin may not use the MCP endpoint'), 403);
    }
    if (!mcp.settings().enabled) return c.json(rpcError(null, RPC.invalidRequest, 'The MCP server is switched off on this TorexPloy (Settings → CLI and MCP)'), 503);
    const header = c.req.header('authorization');
    const presented = header !== undefined && /^bearer\s+\S/i.test(header);
    const caller = presented ? resolveCaller(ctx, c, header.replace(/^bearer\s+/i, '').trim()) : null;
    if (caller === null) return unauthorized(c, presented);
    if (!limiter.take(`mcp:${caller.tokenId}`)) return c.json(rpcError(null, RPC.invalidRequest, 'Too many requests: slow down a little'), 429);

    const raw = await readBody(c);
    if (raw === null) return c.json(rpcError(null, RPC.invalidRequest, 'The request is too large'), 413);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.json(rpcError(null, RPC.parseError, 'Parse error: the body is not JSON'), 400);
    }

    // A batch: only the 2025-03-26 revision allowed them; each message is answered in turn, as JSON.
    if (Array.isArray(parsed)) {
      if (parsed.length === 0 || parsed.length > 50) return c.json(rpcError(null, RPC.invalidRequest, 'A batch must hold between 1 and 50 messages'), 400);
      const responses: unknown[] = [];
      for (const item of parsed) {
        const message = asMessage(item);
        if (message === null) {
          responses.push(rpcError(idOf(item), RPC.invalidRequest, 'Not a JSON-RPC request'));
          continue;
        }
        if (declaredVersion(message) !== null) {
          responses.push(rpcError(message.id ?? null, RPC.invalidRequest, 'The stateless protocol does not batch requests'));
          continue;
        }
        const response = await answer(c, caller, message, false);
        if (response.status !== 202) responses.push(await response.json());
      }
      return responses.length === 0 ? c.body(null, 202) : c.json(responses);
    }

    const message = asMessage(parsed);
    if (message === null) return c.json(rpcError(idOf(parsed), RPC.invalidRequest, 'Not a JSON-RPC request or notification (a client never sends responses here)'), 400);
    return answer(c, caller, message, true);
  });

  // No standalone event stream and no sessions to end: both eras allow a server to say so.
  const notAllowed = (c: Ctx) => c.body(null, 405, { Allow: 'POST' });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
  app.on(['PUT', 'PATCH'], '/mcp', notAllowed);
  app.options('/mcp', (c) => c.body(null, 204, { Allow: 'POST' }));
}
