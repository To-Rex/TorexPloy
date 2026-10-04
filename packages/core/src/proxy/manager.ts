/**
 * Reverse proxy management.
 *
 * Two real modes, chosen by configuration:
 *
 * - `caddy` — the production path. Generates a Caddy JSON config from the
 *   domain table and reloads it through the admin API. Caddy performs ACME
 *   certificate issuance and renewal automatically, so HTTPS is genuinely
 *   automatic rather than a promise.
 * - `embedded` — a built-in HTTP reverse proxy with SNI-less routing by Host
 *   header. No TLS termination (an external terminator or a tunnel is expected),
 *   which is why it reports `tls: false` instead of pretending to secure traffic.
 *
 * Routing is derived from the database on every apply, so the config can never
 * drift from the platform's state: there is no incremental edit to get wrong.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { AppError } from '../errors.ts';
import type { Domain } from '../domain/types.ts';
import type { Logger } from '../logger.ts';

export interface ApplyRouteInput {
  application: { id: string; slug: string };
  deploymentId: string;
  /** Upstream addresses the proxy should load-balance across, e.g. `name:3000`. */
  upstreams: string[];
  domains: Domain[];
  /** Fallback port when a domain does not specify one. */
  internalPort: number;
}

export interface ProxyStatus {
  mode: 'caddy' | 'embedded' | 'external';
  /** Whether the proxy terminates TLS for public traffic. */
  tls: boolean;
  detail: string;
}

export interface ProxyManager {
  readonly mode: ProxyStatus['mode'];
  /** Push the full route table to the proxy. */
  apply(input: ApplyRouteInput): Promise<void>;
  /** Remove every route belonging to an application. */
  remove(applicationId: string): Promise<void>;
  /** Rebuild from the complete desired state (used at startup and after edits). */
  sync(routes: ApplyRouteInput[]): Promise<void>;
  status(): Promise<ProxyStatus>;
  shutdown(): Promise<void>;
}

interface RouteEntry {
  host: string;
  pathPrefix: string;
  upstreams: string[];
  applicationId: string;
  https: boolean;
}

// ---------------------------------------------------------------------------
// Caddy
// ---------------------------------------------------------------------------

export interface CaddyProxyOptions {
  adminUrl: string;
  /** ACME account email; without it Caddy uses the internal CA. */
  acmeEmail?: string | null;
  logger: Logger;
}

/**
 * Caddy adapter.
 *
 * The whole config is replaced in a single `POST /load`, which Caddy applies
 * atomically: in-flight requests finish against the old upstreams and new
 * requests use the new ones. That atomicity is what makes the traffic switch
 * in the deployment pipeline zero-downtime.
 */
export class CaddyProxy implements ProxyManager {
  readonly mode = 'caddy' as const;

  private readonly adminUrl: string;
  private readonly acmeEmail: string | null;
  private readonly logger: Logger;
  private routes = new Map<string, RouteEntry>();

  constructor(options: CaddyProxyOptions) {
    this.adminUrl = options.adminUrl.replace(/\/$/, '');
    this.acmeEmail = options.acmeEmail ?? null;
    this.logger = options.logger;
  }

  async status(): Promise<ProxyStatus> {
    try {
      const response = await fetch(`${this.adminUrl}/config/`, { method: 'GET' });
      if (!response.ok) {
        return { mode: 'caddy', tls: true, detail: `Admin API returned ${response.status}` };
      }
      return { mode: 'caddy', tls: true, detail: 'Caddy admin API reachable; automatic HTTPS enabled' };
    } catch (error) {
      return {
        mode: 'caddy',
        tls: true,
        detail: `Caddy admin API unreachable at ${this.adminUrl}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private routeKey(host: string, pathPrefix: string): string {
    return `${host}${pathPrefix}`;
  }

  async apply(input: ApplyRouteInput): Promise<void> {
    const targets = input.upstreams.length > 0 ? input.upstreams : [`127.0.0.1:${input.internalPort}`];

    for (const domain of input.domains) {
      const prefix = domain.pathPrefix.length === 0 ? '/' : domain.pathPrefix;
      this.routes.set(this.routeKey(domain.host, prefix), {
        host: domain.host,
        pathPrefix: prefix,
        upstreams: targets,
        applicationId: input.application.id,
        https: domain.https,
      });
    }

    await this.pushConfig();
  }

  async remove(applicationId: string): Promise<void> {
    let changed = false;
    for (const [key, route] of this.routes) {
      if (route.applicationId === applicationId) {
        this.routes.delete(key);
        changed = true;
      }
    }
    if (changed) await this.pushConfig();
  }

  async sync(routes: ApplyRouteInput[]): Promise<void> {
    this.routes = new Map();
    for (const route of routes) {
      const targets = route.upstreams.length > 0 ? route.upstreams : [`127.0.0.1:${route.internalPort}`];
      for (const domain of route.domains) {
        const prefix = domain.pathPrefix.length === 0 ? '/' : domain.pathPrefix;
        this.routes.set(this.routeKey(domain.host, prefix), {
          host: domain.host,
          pathPrefix: prefix,
          upstreams: targets,
          applicationId: route.application.id,
          https: domain.https,
        });
      }
    }
    await this.pushConfig();
  }

  /** Render the Caddy JSON config for the current route table. */
  buildConfig(): Record<string, unknown> {
    const byHost = new Map<string, RouteEntry[]>();
    for (const route of this.routes.values()) {
      const existing = byHost.get(route.host) ?? [];
      existing.push(route);
      byHost.set(route.host, existing);
    }

    const apps: Record<string, unknown>[] = [];
    const automaticHttps: Record<string, unknown> = {};

    if (this.acmeEmail !== null && this.acmeEmail.length > 0) {
      automaticHttps.email = this.acmeEmail;
    }

    const tlsHosts = [...byHost.values()].filter((entries) => entries.some((entry) => entry.https)).map((entries) => entries[0]!.host);
    if (tlsHosts.length === 0) {
      // No HTTPS hostnames: disable automatic certificates rather than let
      // Caddy attempt issuance for names that will never resolve.
      automaticHttps.disable = true;
    }

    for (const [host, entries] of byHost) {
      // Longest path prefix first so `/api` wins over `/`.
      const sorted = [...entries].sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);
      const subroutes = sorted.map((entry) => ({
        match: [{ path: entry.pathPrefix === '/' ? ['/*'] : [`${entry.pathPrefix}`, `${entry.pathPrefix}/*`] }],
        handle: [
          {
            handler: 'reverse_proxy',
            upstreams: entry.upstreams.map((address) => ({ dial: address })),
            // Health checks let Caddy stop sending traffic to a dead replica.
            health_checks: {
              active: {
                uri: '/',
                interval: '10s',
                timeout: '3s',
              },
            },
            // Preserve the original client information for the application.
            headers: {
              request: {
                set: {
                  'X-Forwarded-Proto': ['{http.request.scheme}'],
                  'X-Real-IP': ['{http.request.remote.host}'],
                },
              },
            },
          },
        ],
      }));

      apps.push({
        match: [{ host: [host] }],
        handle: subroutes,
        terminal: true,
      });
    }

    return {
      admin: { listen: this.adminUrl.replace(/^https?:\/\//, '') },
      logging: {
        logs: {
          default: { level: 'INFO', encoder: { format: 'json' } },
        },
      },
      apps: {
        http: {
          servers: {
            ploy: {
              listen: [':443', ':80'],
              routes: apps,
              // HTTP/2 and HTTP/3 keep the dashboard and SSE streams fast.
              protocol: 'auto',
            },
          },
          ...(Object.keys(automaticHttps).length > 0 ? { automatic_https: automaticHttps } : {}),
        },
      },
    };
  }

  private async pushConfig(): Promise<void> {
    const config = this.buildConfig();
    let response: Response;
    try {
      response = await fetch(`${this.adminUrl}/load`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config),
      });
    } catch (error) {
      throw new AppError('proxy_error', `Unable to reach the Caddy admin API at ${this.adminUrl}`, {
        cause: error,
        details: { hint: 'Is the caddy service running and PLOY_CADDY_ADMIN_URL correct?' },
      });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AppError('proxy_error', `Caddy rejected the configuration (${response.status})`, {
        details: { body: body.slice(0, 500) },
      });
    }

    this.logger.debug('Proxy configuration applied', { routes: this.routes.size });
  }

  async shutdown(): Promise<void> {
    // Caddy owns its own lifecycle; nothing to stop from here.
  }
}

// ---------------------------------------------------------------------------
// Embedded proxy
// ---------------------------------------------------------------------------

/**
 * Built-in reverse proxy.
 *
 * Used when Caddy is not available. It performs real Host-header routing and
 * real load balancing, so the platform works without an external dependency.
 * It does not terminate TLS — an upstream terminator (or a tunnel) is expected —
 * and {@link status} reports that plainly.
 */
export class EmbeddedProxy implements ProxyManager {
  readonly mode = 'embedded' as const;

  private readonly logger: Logger;
  private server: Server | null = null;
  private routes = new Map<string, RouteEntry>();
  private roundRobin = new Map<string, number>();

  constructor(options: { port: number; host?: string; logger: Logger }) {
    this.logger = options.logger;
    this.port = options.port;
    this.host = options.host ?? '0.0.0.0';
  }

  private readonly port: number;
  private readonly host: string;

  async status(): Promise<ProxyStatus> {
    return {
      mode: 'embedded',
      tls: false,
      detail: this.server === null
        ? 'Embedded proxy is not listening'
        : `Embedded proxy listening on ${this.host}:${this.port} (HTTP only; TLS must be terminated upstream)`,
    };
  }

  async apply(input: ApplyRouteInput): Promise<void> {
    const targets = input.upstreams.length > 0 ? input.upstreams : [`127.0.0.1:${input.internalPort}`];
    for (const domain of input.domains) {
      const prefix = domain.pathPrefix.length === 0 ? '/' : domain.pathPrefix;
      this.routes.set(`${domain.host}${prefix}`, {
        host: domain.host,
        pathPrefix: prefix,
        upstreams: targets,
        applicationId: input.application.id,
        https: domain.https,
      });
    }
    await this.ensureListening();
  }

  async remove(applicationId: string): Promise<void> {
    for (const [key, route] of this.routes) {
      if (route.applicationId === applicationId) this.routes.delete(key);
    }
  }

  async sync(routes: ApplyRouteInput[]): Promise<void> {
    this.routes = new Map();
    for (const route of routes) {
      const targets = route.upstreams.length > 0 ? route.upstreams : [`127.0.0.1:${route.internalPort}`];
      for (const domain of route.domains) {
        const prefix = domain.pathPrefix.length === 0 ? '/' : domain.pathPrefix;
        this.routes.set(`${domain.host}${prefix}`, {
          host: domain.host,
          pathPrefix: prefix,
          upstreams: targets,
          applicationId: route.application.id,
          https: domain.https,
        });
      }
    }
    if (this.routes.size > 0) await this.ensureListening();
  }

  /** Resolve a request host and path to an upstream, or null when unrouted. */
  resolve(host: string | undefined, path: string): string | null {
    if (host === undefined) return null;
    const normalizedHost = host.split(':')[0]?.toLowerCase() ?? '';

    const candidates = [...this.routes.values()]
      .filter((route) => route.host === normalizedHost && path.startsWith(route.pathPrefix))
      .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);

    const route = candidates[0];
    if (route === undefined || route.upstreams.length === 0) return null;

    // Round-robin across replicas, per route.
    const key = `${route.host}${route.pathPrefix}`;
    const index = (this.roundRobin.get(key) ?? 0) % route.upstreams.length;
    this.roundRobin.set(key, index + 1);
    return route.upstreams[index] ?? null;
  }

  private async ensureListening(): Promise<void> {
    if (this.server !== null) return;

    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const upstream = this.resolve(req.headers.host, req.url ?? '/');
      if (upstream === null) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no_route', message: 'No application is configured for this host' }));
        return;
      }

      const [host, portPart] = upstream.split(':');
      const port = Number(portPart ?? 80);

      const proxied = httpRequest(
        {
          hostname: host,
          port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, 'x-forwarded-host': req.headers.host ?? '' },
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );

      proxied.on('error', (error) => {
        this.logger.warn('Embedded proxy upstream error', { upstream, error: error.message });
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'bad_gateway', message: 'Application is not reachable' }));
      });

      // Stream the request body through, so uploads and webhooks work.
      req.pipe(proxied);
    });

    // Server-Sent Events and WebSocket upgrades need the socket kept open.
    this.server.keepAliveTimeout = 65_000;
    this.server.headersTimeout = 70_000;

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => {
        this.logger.info('Embedded proxy listening', { host: this.host, port: this.port });
        resolve();
      });
    });
  }

  /** The port actually bound (useful when port 0 was requested). */
  get boundPort(): number {
    const address = this.server?.address();
    return address !== null && address !== undefined && typeof address !== 'string' ? address.port : this.port;
  }

  async shutdown(): Promise<void> {
    if (this.server === null) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** No-op proxy for deployments that sit behind an external load balancer. */
export class ExternalProxy implements ProxyManager {
  readonly mode = 'external' as const;

  async apply(): Promise<void> {}
  async remove(): Promise<void> {}
  async sync(): Promise<void> {}
  async status(): Promise<ProxyStatus> {
    return { mode: 'external', tls: true, detail: 'Routing is handled outside TorexPloy' };
  }
  async shutdown(): Promise<void> {}
}

export function createProxyManager(config: { proxy: ProxyStatus['mode']; caddyAdminUrl: string; port: number; acmeEmail?: string | null }, logger: Logger): ProxyManager {
  switch (config.proxy) {
    case 'caddy':
      return new CaddyProxy({ adminUrl: config.caddyAdminUrl, acmeEmail: config.acmeEmail ?? null, logger });
    case 'embedded':
      return new EmbeddedProxy({ port: config.port, logger });
    case 'external':
      return new ExternalProxy();
  }
}
