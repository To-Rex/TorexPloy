/**
 * Caddy JSON configuration, built from desired state.
 *
 * The whole config is regenerated from the database on every change and
 * loaded atomically. There are no incremental edits that could drift: what is
 * in SQLite is what Caddy serves.
 *
 * Layout:
 * - `https` server on :443 — TLS-terminated routes, certificates obtained and
 *   renewed automatically over ACME (HTTP-01 and TLS-ALPN-01).
 * - `http` server on :80 — explicit 308 redirects for HTTPS hosts, plain
 *   routes for hosts that opted out of TLS, and a fallback page.
 * - The admin API listens on the container's own loopback only, so no
 *   application container can reconfigure the proxy.
 */

export interface ProxyRoute {
  host: string;
  /** Path prefix; '/' (the default) routes the whole host. */
  path?: string;
  /** Remove the prefix before proxying (`/api/users` reaches the app as `/users`). */
  stripPath?: boolean;
  https: boolean;
  /** `container:port` dial addresses. Empty means "nothing healthy is serving". */
  upstreams: string[];
  /** Shown on the 503 page when there are no upstreams. */
  label: string;
  /** Redirect-only route: answer 308 to this origin, keeping path and query. */
  redirectTo?: string | null;
  /** Pass bytes through as they arrive (object storage: large uploads and downloads, `Expect: 100-continue`). */
  stream?: boolean;
}

const prefixOf = (route: ProxyRoute): string => route.path ?? '/';

export interface CaddyConfigInput {
  acmeEmail: string | null;
  routes: ProxyRoute[];
  /** Overridable for tests; production always uses 80/443. */
  httpPort?: number;
  httpsPort?: number;
}

type Json = Record<string, unknown>;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/** Self-contained status page (no external assets: it is served when things are already wrong). */
export function statusPage(code: number, title: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${code} · ${escapeHtml(title)}</title><style>
:root{color-scheme:light dark;--bg:#f6f6f3;--fg:#17181a;--muted:#6b6e73;--line:#e2e2dc}
@media (prefers-color-scheme:dark){:root{--bg:#0f1012;--fg:#ececea;--muted:#8d9096;--line:#26282c}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
main{max-width:420px}b{font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);letter-spacing:.04em}
h1{font-size:22px;letter-spacing:-.01em;margin:10px 0 6px}p{margin:0;color:var(--muted)}hr{border:0;border-top:1px solid var(--line);margin:22px 0 12px}
small{color:var(--muted);font-size:12px}</style></head><body><main><b>${code}</b><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>
<hr><small>TorexPloy</small></main></body></html>`;
}

function hostMatch(hosts: string[]): Json[] {
  return [{ host: hosts }];
}

function routeMatch(route: ProxyRoute): Json[] {
  const prefix = prefixOf(route);
  return prefix === '/' ? hostMatch([route.host]) : [{ host: [route.host], path: [prefix, `${prefix}/*`] }];
}

function proxyHandler(upstreams: string[], stream = false): Json {
  return {
    handler: 'reverse_proxy',
    upstreams: upstreams.map((dial) => ({ dial })),
    // Request bodies are never buffered; streamed routes also flush every response chunk at once.
    ...(stream ? { flush_interval: -1 } : {}),
    load_balancing: {
      selection_policy: { policy: 'round_robin' },
      // During a replica swap a request may land on a container that just
      // stopped; retrying another upstream hides that from the client.
      try_duration: '5s',
      try_interval: '250ms',
      retries: 2,
    },
    health_checks: { passive: { fail_duration: '10s', max_fails: 2, unhealthy_status: [502, 503, 504] } },
    transport: { protocol: 'http', dial_timeout: '5s', keep_alive: { enabled: true, idle_timeout: '60s' } },
  };
}

function unavailableHandler(label: string): Json {
  return {
    handler: 'static_response',
    status_code: 503,
    headers: { 'Content-Type': ['text/html; charset=utf-8'], 'Retry-After': ['15'], 'Cache-Control': ['no-store'] },
    body: statusPage(503, `${label} is not running`, 'The application has no healthy deployment right now. If you own it, check its deployments in the dashboard.'),
  };
}

function routeFor(route: ProxyRoute): Json {
  const hsts = route.https ? [{ handler: 'headers', response: { set: { 'Strict-Transport-Security': ['max-age=31536000'] } } }] : [];
  if (route.redirectTo != null) {
    return {
      match: routeMatch(route),
      handle: [...hsts, { handler: 'static_response', status_code: 308, headers: { Location: [`${route.redirectTo}{http.request.uri}`] } }],
      terminal: true,
    };
  }
  const prefix = prefixOf(route);
  return {
    match: routeMatch(route),
    handle: [
      ...hsts,
      ...(route.stripPath === true && prefix !== '/' && route.upstreams.length > 0 ? [{ handler: 'rewrite', strip_path_prefix: prefix }] : []),
      route.upstreams.length > 0 ? proxyHandler(route.upstreams, route.stream === true) : unavailableHandler(route.label),
    ],
    terminal: true,
  };
}

const NOT_FOUND = {
  handle: [
    {
      handler: 'static_response',
      status_code: 404,
      headers: { 'Content-Type': ['text/html; charset=utf-8'], 'Cache-Control': ['no-store'] },
      body: statusPage(404, 'No application here', 'This domain is not connected to any application on this server.'),
    },
  ],
  terminal: true,
};

export function buildCaddyConfig(input: CaddyConfigInput): Json {
  // Stable ordering keeps the generated JSON (and its hash) deterministic; within a host the
  // most specific path prefix must come first, because routes are terminal.
  const routes = [...input.routes].sort((a, b) => a.host.localeCompare(b.host) || prefixOf(b).length - prefixOf(a).length || prefixOf(a).localeCompare(prefixOf(b)));
  const httpsRoutes = routes.filter((route) => route.https);
  const httpRoutes = routes.filter((route) => !route.https);
  const httpsHosts = [...new Set(httpsRoutes.map((route) => route.host))];

  const redirects = httpsRoutes.length === 0
    ? []
    : [
        {
          match: hostMatch(httpsHosts),
          handle: [
            {
              handler: 'static_response',
              status_code: 308,
              headers: { Location: ['https://{http.request.host}{http.request.uri}'], Connection: ['close'] },
            },
          ],
          terminal: true,
        },
      ];

  const httpsPort = input.httpsPort ?? 443;
  const location = httpsPort === 443 ? 'https://{http.request.host}{http.request.uri}' : `https://{http.request.host}:${httpsPort}{http.request.uri}`;
  for (const redirect of redirects) {
    (redirect.handle[0]!.headers as Record<string, string[]>).Location = [location];
  }

  const servers: Json = {
    http: {
      listen: [`:${input.httpPort ?? 80}`],
      routes: [...redirects, ...httpRoutes.map(routeFor), NOT_FOUND],
      automatic_https: { disable: true },
    },
  };

  if (httpsRoutes.length > 0) {
    servers.https = {
      listen: [`:${input.httpsPort ?? 443}`],
      routes: [...httpsRoutes.map(routeFor), NOT_FOUND],
      protocols: ['h1', 'h2', 'h3'],
      // We emit our own redirects on :80 so their order relative to other routes is explicit.
      automatic_https: { disable_redirects: true },
    };
  }

  const config: Json = {
    admin: { listen: 'localhost:2019', config: { persist: true } },
    logging: { logs: { default: { level: 'WARN' } } },
    apps: { http: { servers } },
  };

  if (httpsRoutes.length > 0 && input.acmeEmail !== null) {
    (config.apps as Json).tls = {
      automation: {
        policies: [{ subjects: httpsHosts, issuers: [{ module: 'acme', email: input.acmeEmail }] }],
      },
    };
  }

  return config;
}
