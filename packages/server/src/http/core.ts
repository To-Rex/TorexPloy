/**
 * HTTP plumbing shared by every route: the request environment, auth
 * resolution, CSRF defence, validation, authorization and rate limiting.
 */
import type { HttpBindings } from '@hono/node-server';
import type { Context as HonoContext, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { isIP } from 'node:net';
import type { ZodType } from 'zod';
import { API_TOKEN_PREFIX, roleAtLeast, type TeamRole, type ValidationIssue } from '@ploy/shared';
import type { Context } from '../context.ts';
import { AppError, forbidden, unauthorized } from '../lib/errors.ts';
import type { UserRecord } from '../store/index.ts';

export const SESSION_COOKIE = 'ploy_session';
const SESSION_MAX_AGE_SEC = 30 * 24 * 3_600;

export interface Auth {
  user: UserRecord;
  sessionId: string | null;
  tokenId: string | null;
  /** The team the request acts within, with the caller's role in it. Null only for a user without teams. */
  teamId: string | null;
  role: TeamRole | null;
}

export interface Env {
  Bindings: HttpBindings;
  Variables: {
    requestId: string;
    auth: Auth | null;
    ip: string;
  };
}

export type Ctx = HonoContext<Env>;

// ---------------------------------------------------------------------------
// Client address
// ---------------------------------------------------------------------------

export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return /^f[cd][0-9a-f]{2}:/i.test(ip);
}

/**
 * The client's address. `X-Forwarded-For` is trusted only when the direct peer
 * is a private address (the proxy on the platform network), so a public
 * client cannot spoof its address to dodge rate limits or the audit log.
 */
export function clientIp(c: Ctx): string {
  const peer = c.env.incoming.socket.remoteAddress ?? '0.0.0.0';
  if (isPrivateAddress(peer)) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded !== undefined && isIP(forwarded) !== 0) return forwarded;
  }
  return peer.replace(/^::ffff:/, '');
}

export function isHttps(c: Ctx): boolean {
  if (c.req.header('x-forwarded-proto') === 'https' && isPrivateAddress(c.env.incoming.socket.remoteAddress ?? '')) return true;
  return new URL(c.req.url).protocol === 'https:';
}

/** Origin the browser used, honoring the proxy's forwarded host. */
export function requestOrigin(c: Ctx): string {
  const forwardedHost = isPrivateAddress(c.env.incoming.socket.remoteAddress ?? '') ? c.req.header('x-forwarded-host') : undefined;
  const host = forwardedHost ?? c.req.header('host') ?? new URL(c.req.url).host;
  return `${isHttps(c) ? 'https' : 'http'}://${host}`;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function setSessionCookie(c: Ctx, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SEC,
  });
}

export function clearSessionCookie(c: Ctx): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isHttps(c) });
}

/** Resolve the caller from a session cookie or a bearer API token. Never throws. */
export function authMiddleware(ctx: Context): MiddlewareHandler<Env> {
  return async (c, next) => {
    c.set('ip', clientIp(c));
    c.set('auth', null);
    const { stores } = ctx;

    const header = c.req.header('authorization');
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7).trim();
      if (token.startsWith(API_TOKEN_PREFIX)) {
        const record = stores.tokens.resolve(token);
        const user = record === undefined ? undefined : stores.users.getById(record.userId);
        const role = record === undefined || user === undefined ? undefined : stores.teams.getRole(record.teamId, user.id);
        if (record !== undefined && user !== undefined && role !== undefined) {
          c.set('auth', { user, sessionId: null, tokenId: record.id, teamId: record.teamId, role });
        }
      }
      await next();
      return;
    }

    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie !== undefined) {
      const auth = sessionAuth(ctx, cookie);
      if (auth !== null) c.set('auth', auth);
      else clearSessionCookie(c);
    }
    await next();
  };
}

/** The signed-in user behind a session token, acting within their current team. */
export function sessionAuth(ctx: Context, token: string): Auth | null {
  const { stores } = ctx;
  const session = stores.sessions.resolve(token);
  const user = session === undefined ? undefined : stores.users.getById(session.userId);
  if (session === undefined || user === undefined) return null;
  let teamId = user.currentTeamId;
  let role = teamId === null ? undefined : stores.teams.getRole(teamId, user.id);
  if (role === undefined) {
    // Removed from the current team: fall back to the first team they still belong to.
    const first = stores.teams.listForUser(user.id)[0];
    teamId = first?.team.id ?? null;
    role = first?.role;
    stores.users.update(user.id, { currentTeamId: teamId });
  }
  return { user, sessionId: session.id, tokenId: null, teamId, role: role ?? null };
}

/**
 * CSRF defence for cookie-authenticated writes. Browsers will not send a
 * custom header cross-origin without a CORS preflight (which this API never
 * approves), and the Origin check rejects cross-site form posts outright.
 */
export function csrfMiddleware(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const method = c.req.method;
    const auth = c.get('auth');
    const cookieAuthenticated = auth !== null && auth.sessionId !== null;
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && (cookieAuthenticated || getCookie(c, SESSION_COOKIE) !== undefined)) {
      if (c.req.header('x-ploy-request') !== '1') throw new AppError('csrf_failed', 'Missing request header');
      const origin = c.req.header('origin');
      if (origin !== undefined && origin !== requestOrigin(c)) throw new AppError('csrf_failed', 'Cross-origin request rejected');
    }
    await next();
  };
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

export function requireAuth(c: Ctx): Auth {
  const auth = c.get('auth');
  if (auth === null) throw unauthorized();
  return auth;
}

/** The caller, acting within a team, with at least `role` in it. */
export function requireTeam(c: Ctx, role: TeamRole = 'viewer'): Auth & { teamId: string; role: TeamRole } {
  const auth = requireAuth(c);
  if (auth.teamId === null || auth.role === null) throw forbidden('You are not a member of any team');
  if (!roleAtLeast(auth.role, role)) throw forbidden(`This action requires the ${role} role`);
  return auth as Auth & { teamId: string; role: TeamRole };
}

export function requireInstanceAdmin(c: Ctx): Auth {
  const auth = requireAuth(c);
  if (!auth.user.isInstanceAdmin) throw forbidden('Only the instance administrator can do this');
  return auth;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function toIssues(error: { issues: readonly { path: readonly PropertyKey[]; code: string; message: string }[] }): ValidationIssue[] {
  return error.issues.map((issue) => {
    const params: Record<string, string | number> = {};
    const fields = issue as unknown as Record<string, unknown>;
    for (const key of ['minimum', 'maximum', 'format', 'origin', 'expected']) {
      const value = fields[key];
      if (typeof value === 'number' || typeof value === 'string') params[key] = value;
      if (typeof value === 'bigint') params[key] = Number(value);
    }
    const reason = (fields.params as { reason?: string } | undefined)?.reason;
    if (reason !== undefined) params.reason = reason;
    return {
      path: issue.path.map(String).join('.'),
      code: issue.code,
      message: issue.message,
      ...(Object.keys(params).length > 0 ? { params } : {}),
    };
  });
}

export function validate<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('validation_failed', 'Request validation failed', { issues: toIssues(result.error) });
  return result.data;
}

export async function body<T>(c: Ctx, schema: ZodType<T>): Promise<T> {
  let value: unknown = {};
  const text = await c.req.text();
  if (text.length > 0) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new AppError('bad_request', 'Body must be valid JSON');
    }
  }
  return validate(schema, value);
}

export function query<T>(c: Ctx, schema: ZodType<T>): T {
  return validate(schema, c.req.query());
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export function audit(
  ctx: Context,
  c: Ctx,
  action: string,
  target: { type: string; id?: string | null; name?: string | null; teamId?: string | null },
  metadata: Record<string, unknown> = {},
): void {
  const auth = c.get('auth');
  ctx.stores.audit.record({
    teamId: target.teamId !== undefined ? target.teamId : (auth?.teamId ?? null),
    userId: auth?.user.id ?? null,
    action,
    targetType: target.type,
    targetId: target.id ?? null,
    targetName: target.name ?? null,
    ip: c.get('ip'),
    metadata: auth?.tokenId === null || auth === null ? metadata : { ...metadata, viaToken: auth.tokenId },
  });
}

// ---------------------------------------------------------------------------
// Rate limiting (token bucket, in memory)
// ---------------------------------------------------------------------------

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly capacity: number;
  private readonly refillPerMs: number;

  constructor(capacity: number, perMinute: number) {
    this.capacity = capacity;
    this.refillPerMs = perMinute / 60_000;
  }

  /** Consume one token for `key`; false when the bucket is empty. */
  take(key: string, now: number = Date.now()): boolean {
    if (this.buckets.size > 50_000) this.sweep(now);
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updated: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.updated) * this.refillPerMs);
    bucket.updated = now;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) if (now - bucket.updated > 3_600_000) this.buckets.delete(key);
  }
}

export function limit(limiter: RateLimiter, c: Ctx, scope: string): void {
  if (!limiter.take(`${scope}:${c.get('ip')}`)) throw new AppError('rate_limited', 'Too many attempts. Wait a minute and try again.');
}
