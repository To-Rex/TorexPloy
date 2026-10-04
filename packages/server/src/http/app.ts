/**
 * The HTTP application: middleware, routes, the dashboard's static files and
 * error mapping.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import type { ApiErrorBody } from '@ploy/shared';
import type { Context } from '../context.ts';
import { randomId } from '../lib/ids.ts';
import { DockerUnavailableError } from '../docker/client.ts';
import { AppError, isAppError } from '../lib/errors.ts';
import { authMiddleware, csrfMiddleware, isHttps, requestOrigin, type Env } from './core.ts';
import { registerAccountRoutes } from './routes/account.ts';
import { registerApplicationRoutes } from './routes/applications.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerComposeRoutes } from './routes/composes.ts';
import { registerDeploymentRoutes } from './routes/deployments.ts';
import { registerGithubRoutes } from './routes/github.ts';
import { registerPlatformRoutes } from './routes/platform.ts';
import { registerNotificationRoutes } from './routes/notifications.ts';
import { registerPreviewRoutes } from './routes/previews.ts';
import { registerProjectRoutes } from './routes/projects.ts';
import { registerRegistryRoutes } from './routes/registries.ts';
import { registerS3Routes } from './routes/s3.ts';
import { registerServerRoutes } from './routes/servers.ts';
import { registerServiceRoutes } from './routes/services.ts';
import { registerTemplateRoutes } from './routes/templates.ts';
import { registerUpdateRoutes } from './routes/updates.ts';

const MAX_JSON_BYTES = 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** Strict CSP: everything is self-hosted, inline scripts are not allowed (the theme bootstrap is a file). */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self' https://github.com",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

export function createHttpApp(ctx: Context): Hono<Env> {
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    const requestId = randomId(10);
    c.set('requestId', requestId);
    const started = performance.now();
    await next();
    c.header('X-Request-Id', requestId);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('X-Frame-Options', 'DENY');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (isHttps(c)) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // 'self' covers same-origin WebSockets in current browsers; the explicit ws(s) origin keeps older Safari working for the terminal.
    if (!c.req.path.startsWith('/api/')) c.header('Content-Security-Policy', CSP.replace("connect-src 'self'", `connect-src 'self' ${requestOrigin(c).replace(/^http/, 'ws')}`));
    const ms = Math.round(performance.now() - started);
    const contentType = c.res.headers.get('content-type') ?? '';
    if (!contentType.includes('event-stream') && c.req.path.startsWith('/api/') && c.req.path !== '/api/health') {
      ctx.logger.debug('request', { method: c.req.method, path: c.req.path, status: c.res.status, ms, requestId });
    }
  });

  app.use('/api/*', async (c, next) => {
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > MAX_JSON_BYTES && !c.req.path.startsWith('/api/webhooks/')) throw new AppError('payload_too_large', 'Request body too large');
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('/api/*', authMiddleware(ctx));
  app.use('/api/*', csrfMiddleware());

  registerAuthRoutes(app, ctx);
  registerAccountRoutes(app, ctx);
  registerPlatformRoutes(app, ctx);
  registerUpdateRoutes(app, ctx);
  registerServerRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerApplicationRoutes(app, ctx);
  registerPreviewRoutes(app, ctx);
  registerComposeRoutes(app, ctx);
  registerDeploymentRoutes(app, ctx);
  registerServiceRoutes(app, ctx);
  registerTemplateRoutes(app, ctx);
  registerNotificationRoutes(app, ctx);
  registerS3Routes(app, ctx);
  registerRegistryRoutes(app, ctx);
  registerGithubRoutes(app, ctx);

  app.all('/api/*', () => {
    throw new AppError('not_found', 'No such endpoint', { params: { resource: 'endpoint' } });
  });

  // ------------------------------------------------------------- dashboard

  const dist = ctx.config.webDist;
  app.get('*', async (c) => {
    if (dist === null) {
      return c.text('TorexPloy API is running. The dashboard has not been built (npm run build).', 503);
    }
    const requested = normalize(decodeURIComponent(c.req.path)).replace(/^([/\\])+/, '');
    let file = join(dist, requested);
    if (!file.startsWith(dist + sep) && file !== dist) return c.text('Not found', 404);
    let info = await stat(file).catch(() => null);
    const isAsset = requested.startsWith('assets/');
    if (info === null || info.isDirectory()) {
      if (isAsset || extname(requested) !== '') return c.text('Not found', 404);
      // Client-side routes all render the SPA shell.
      file = join(dist, 'index.html');
      info = await stat(file).catch(() => null);
      if (info === null) return c.text('Not found', 404);
    }
    const headers: Record<string, string> = {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Content-Length': String(info.size),
      // Hashed assets never change; the shell must always be revalidated to pick up a new release.
      'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers });
  });

  // ---------------------------------------------------------------- errors

  app.onError((caught, c) => {
    const requestId = c.get('requestId');
    // A server whose Docker daemon is down is an expected state, not a bug: report it as such.
    const error = caught instanceof DockerUnavailableError ? new AppError('docker_unavailable', caught.message) : caught;
    if (isAppError(error)) {
      if (error.status >= 500) ctx.logger.error(error.message, { requestId, code: error.code, cause: error.cause });
      const payload: ApiErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.params === undefined ? {} : { params: error.params }),
          ...(error.issues === undefined ? {} : { issues: error.issues }),
          requestId,
        },
      };
      return c.json(payload, error.status as 400);
    }
    ctx.logger.error('Unhandled error', { requestId, method: c.req.method, path: c.req.path, error });
    const payload: ApiErrorBody = { error: { code: 'internal_error', message: 'Something went wrong. The error was logged.', requestId } };
    return c.json(payload, 500);
  });

  return app;
}
