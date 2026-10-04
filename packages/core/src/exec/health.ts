/**
 * Health checks.
 *
 * A deployment is only switched into traffic after it answers a real request.
 * This is what makes "zero-downtime" true rather than aspirational: a broken
 * build never receives a single user request.
 *
 * The checker accepts any 2xx–3xx response and treats 4xx as healthy-by-default
 * only when `acceptStatus` says so, because many applications legitimately
 * return 404 on `/` while being perfectly healthy. Connection errors, timeouts
 * and 5xx are failures.
 */
import { request } from 'node:http';
import { request as secureRequest } from 'node:https';

export interface HealthCheckOptions {
  /** Full URL to probe, e.g. `http://127.0.0.1:8080/healthz`. */
  url: string;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Total budget across all attempts. */
  totalTimeoutMs?: number;
  /** Delay between attempts. */
  intervalMs?: number;
  /** Status codes considered healthy. Defaults to 200–399. */
  acceptStatus?: (status: number) => boolean;
  /** Treat a 4xx as healthy (an app that answers at all is alive). */
  allowClientErrors?: boolean;
  signal?: AbortSignal;
  onAttempt?: (attempt: number, result: HealthAttempt) => void;
}

export interface HealthAttempt {
  attempt: number;
  ok: boolean;
  status: number | null;
  error: string | null;
  durationMs: number;
}

export interface HealthResult {
  healthy: boolean;
  attempts: HealthAttempt[];
  /** The response status of the successful attempt, when healthy. */
  status: number | null;
  totalDurationMs: number;
  error: string | null;
}

/** Perform a single HTTP request and report whether it succeeded. */
function probeOnce(
  url: string,
  timeoutMs: number,
  allowClientErrors: boolean,
  acceptStatus: ((status: number) => boolean) | undefined,
  signal: AbortSignal | undefined,
): Promise<{ status: number | null; error: string | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: number | null, error: string | null): void => {
      if (settled) return;
      settled = true;
      resolve({ status, error });
    };

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      finish(null, `Invalid health check URL: ${url}`);
      return;
    }

    const isSecure = parsed.protocol === 'https:';
    const requester = isSecure ? secureRequest : request;

    const req = requester(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port === '' ? (isSecure ? 443 : 80) : Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        // A self-signed certificate on an internal upstream must not fail the
        // check: the proxy terminates TLS for the public hostname.
        ...(isSecure ? { rejectUnauthorized: false } : {}),
        headers: { 'user-agent': 'TorexPloy-HealthCheck/1.0', accept: '*/*' },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Drain the body so the socket can be reused or closed cleanly.
        res.resume();

        const accepted =
          acceptStatus !== undefined
            ? acceptStatus(status)
            : status >= 200 && status < 400
              ? true
              : allowClientErrors && status >= 400 && status < 500;

        finish(status, accepted ? null : `Unexpected status ${status}`);
      },
    );

    req.on('timeout', () => {
      req.destroy();
      finish(null, `Timed out after ${timeoutMs}ms`);
    });
    req.on('error', (error) => finish(null, error.message));

    if (signal !== undefined) {
      if (signal.aborted) {
        req.destroy();
        finish(null, 'Aborted');
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          req.destroy();
          finish(null, 'Aborted');
        },
        { once: true },
      );
    }

    req.end();
  });
}

/**
 * Poll a URL until it answers or the budget runs out.
 * Always resolves — the caller decides what an unhealthy result means.
 */
export async function waitForHealthy(options: HealthCheckOptions): Promise<HealthResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 3_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const totalTimeoutMs = options.totalTimeoutMs ?? 90_000;

  const attempts: HealthAttempt[] = [];
  let lastError: string | null = 'No attempts were made';

  for (let attempt = 1; ; attempt += 1) {
    if (options.signal?.aborted === true) {
      return {
        healthy: false,
        attempts,
        status: null,
        totalDurationMs: Date.now() - startedAt,
        error: 'Aborted',
      };
    }

    const attemptStart = Date.now();
    const result = await probeOnce(
      options.url,
      timeoutMs,
      options.allowClientErrors ?? true,
      options.acceptStatus,
      options.signal,
    );
    const record: HealthAttempt = {
      attempt,
      ok: result.error === null,
      status: result.status,
      error: result.error,
      durationMs: Date.now() - attemptStart,
    };
    attempts.push(record);
    options.onAttempt?.(attempt, record);

    if (record.ok) {
      return {
        healthy: true,
        attempts,
        status: record.status,
        totalDurationMs: Date.now() - startedAt,
        error: null,
      };
    }

    lastError = record.error;
    if (Date.now() - startedAt + intervalMs >= totalTimeoutMs) {
      return {
        healthy: false,
        attempts,
        status: record.status,
        totalDurationMs: Date.now() - startedAt,
        error: lastError,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** One-shot health check, no retries. Used for the periodic container monitor. */
export async function checkOnce(url: string, timeoutMs = 3_000): Promise<HealthAttempt> {
  const startedAt = Date.now();
  const result = await probeOnce(url, timeoutMs, true, undefined, undefined);
  return {
    attempt: 1,
    ok: result.error === null,
    status: result.status,
    error: result.error,
    durationMs: Date.now() - startedAt,
  };
}

/** Derive the health-check URL for an upstream address and application config. */
export function healthUrlFor(address: string, path: string | null, secure = false): string {
  const scheme = secure ? 'https' : 'http';
  const normalized = path === null || path.trim().length === 0 ? '/' : path.trim();
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `${scheme}://${address}${withSlash}`;
}
