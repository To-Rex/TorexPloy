import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { checkOnce, healthUrlFor, waitForHealthy } from './health.ts';

interface Fixture {
  server: Server;
  url: string;
  requests: number;
  stop: () => Promise<void>;
}

/** Start a real HTTP server that answers according to `respond`. */
async function fixture(
  respond: (attempt: number) => { status: number; delayMs?: number } | 'hang' | 'destroy',
): Promise<Fixture> {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    const result = respond(requests);
    if (result === 'hang') return; // never respond, forcing a timeout
    if (result === 'destroy') {
      req.socket.destroy();
      return;
    }
    setTimeout(() => {
      res.writeHead(result.status, { 'content-type': 'text/plain' });
      res.end('ok');
    }, result.delayMs ?? 0);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const url = `http://127.0.0.1:${address.port}/health`;

  return {
    server,
    url,
    get requests() {
      return requests;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('a healthy endpoint is reported healthy on the first attempt', async () => {
  const app = await fixture(() => ({ status: 200 }));
  try {
    const result = await waitForHealthy({ url: app.url, timeoutMs: 2_000, totalTimeoutMs: 5_000 });
    assert.equal(result.healthy, true);
    assert.equal(result.status, 200);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.error, null);
  } finally {
    await app.stop();
  }
});

test('a 3xx redirect counts as healthy (many apps redirect to a login page)', async () => {
  const app = await fixture(() => ({ status: 302 }));
  try {
    const result = await waitForHealthy({ url: app.url, timeoutMs: 2_000, totalTimeoutMs: 5_000 });
    assert.equal(result.healthy, true);
    assert.equal(result.status, 302);
  } finally {
    await app.stop();
  }
});

test('a 5xx is unhealthy and is retried', async () => {
  const app = await fixture(() => ({ status: 503 }));
  try {
    const result = await waitForHealthy({ url: app.url, timeoutMs: 2_000, intervalMs: 50, totalTimeoutMs: 400 });
    assert.equal(result.healthy, false);
    assert.ok(result.attempts.length >= 2, 'a server error must be retried');
    assert.match(result.error ?? '', /503/);
  } finally {
    await app.stop();
  }
});

test('recovery mid-flight is detected: unhealthy then healthy', async () => {
  const app = await fixture((attempt) => ({ status: attempt < 3 ? 500 : 200 }));
  try {
    const result = await waitForHealthy({ url: app.url, timeoutMs: 2_000, intervalMs: 50, totalTimeoutMs: 5_000 });
    assert.equal(result.healthy, true, 'a slow-starting app must eventually be accepted');
    assert.equal(result.attempts.length, 3);
    assert.equal(result.attempts[0]!.ok, false);
    assert.equal(result.attempts[2]!.ok, true);
  } finally {
    await app.stop();
  }
});

test('a hanging server is treated as unhealthy after the timeout', async () => {
  const app = await fixture(() => 'hang');
  try {
    const result = await waitForHealthy({ url: app.url, timeoutMs: 200, intervalMs: 50, totalTimeoutMs: 400 });
    assert.equal(result.healthy, false);
    assert.match(result.error ?? '', /Timed out|Aborted/);
  } finally {
    await app.stop();
  }
});

test('a refused connection is unhealthy, not an exception', async () => {
  // Port 1 is privileged and nothing listens there.
  const result = await waitForHealthy({
    url: 'http://127.0.0.1:1/health',
    timeoutMs: 500,
    intervalMs: 50,
    totalTimeoutMs: 400,
  });
  assert.equal(result.healthy, false);
  assert.ok(result.error !== null);
});

test('4xx is accepted by default so an app that answers at all is alive', async () => {
  const app = await fixture(() => ({ status: 404 }));
  try {
    const result = await waitForHealthy({ url: app.url, timeoutMs: 2_000, totalTimeoutMs: 3_000 });
    assert.equal(result.healthy, true);
    assert.equal(result.status, 404);
  } finally {
    await app.stop();
  }
});

test('4xx can be treated as a failure when the application demands a strict path', async () => {
  const app = await fixture(() => ({ status: 404 }));
  try {
    const result = await waitForHealthy({
      url: app.url,
      timeoutMs: 2_000,
      intervalMs: 50,
      totalTimeoutMs: 300,
      allowClientErrors: false,
    });
    assert.equal(result.healthy, false);
  } finally {
    await app.stop();
  }
});

test('a custom accept predicate is honored', async () => {
  const app = await fixture(() => ({ status: 204 }));
  try {
    const result = await waitForHealthy({
      url: app.url,
      timeoutMs: 2_000,
      totalTimeoutMs: 3_000,
      acceptStatus: (status) => status === 200,
    });
    assert.equal(result.healthy, false, 'only 200 was accepted, so 204 must fail');
  } finally {
    await app.stop();
  }
});

test('an abort signal stops the check promptly', async () => {
  const app = await fixture(() => 'hang');
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const startedAt = Date.now();
    const result = await waitForHealthy({
      url: app.url,
      timeoutMs: 5_000,
      intervalMs: 100,
      totalTimeoutMs: 30_000,
      signal: controller.signal,
    });
    assert.equal(result.healthy, false);
    assert.ok(Date.now() - startedAt < 2_000, 'abort must not wait for the full timeout');
  } finally {
    await app.stop();
  }
});

test('attempt progress is reported so the UI can show retries', async () => {
  const app = await fixture((attempt) => ({ status: attempt < 2 ? 500 : 200 }));
  try {
    const seen: number[] = [];
    await waitForHealthy({
      url: app.url,
      timeoutMs: 2_000,
      intervalMs: 50,
      totalTimeoutMs: 5_000,
      onAttempt: (attempt, record) => {
        if (!record.ok) seen.push(attempt);
      },
    });
    assert.deepEqual(seen, [1]);
  } finally {
    await app.stop();
  }
});

test('an invalid URL is reported as unhealthy rather than throwing', async () => {
  const result = await waitForHealthy({ url: 'not-a-url', timeoutMs: 500, intervalMs: 50, totalTimeoutMs: 200 });
  assert.equal(result.healthy, false);
  assert.match(result.error ?? '', /Invalid health check URL/);
});

test('checkOnce performs exactly one request', async () => {
  const app = await fixture(() => ({ status: 200 }));
  try {
    const attempt = await checkOnce(app.url);
    assert.equal(attempt.ok, true);
    assert.equal(attempt.status, 200);
    assert.equal(attempt.attempt, 1);
    assert.equal(app.requests, 1);
  } finally {
    await app.stop();
  }
});

test('healthUrlFor normalizes paths the way applications expect', () => {
  assert.equal(healthUrlFor('app:3000', null), 'http://app:3000/');
  assert.equal(healthUrlFor('app:3000', '/healthz'), 'http://app:3000/healthz');
  assert.equal(healthUrlFor('app:3000', 'healthz'), 'http://app:3000/healthz');
  assert.equal(healthUrlFor('app:3000', ''), 'http://app:3000/');
  assert.equal(healthUrlFor('127.0.0.1:8080', '/api/health', true), 'https://127.0.0.1:8080/api/health');
});