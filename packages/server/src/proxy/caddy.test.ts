import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCaddyConfig } from './caddy.ts';

/** A real Caddy binary, when available (`PLOY_TEST_CADDY` or PATH). */
function caddyBinary(): string | null {
  const candidates = [process.env.PLOY_TEST_CADDY, 'caddy'].filter((value): value is string => value !== undefined);
  for (const candidate of candidates) {
    if (spawnSync(candidate, ['version']).status === 0) return candidate;
  }
  return null;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });
}

function upstream(name: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.end(`${name} ${req.headers['x-forwarded-host'] ?? ''}`);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
    });
  });
}

/** `fetch` refuses to override Host, so virtual-host routing needs node:http. */
function get(port: number, host: string): Promise<{ status: number; body: string; location: string | null }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/some/path?q=1', headers: { host }, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, location: res.headers.location ?? null }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('generated config is deterministic and routes HTTPS hosts through explicit redirects', () => {
  const routes = [
    { host: 'b.example.com', https: true, upstreams: ['ploy-b-1:3000'], label: 'B' },
    { host: 'a.example.com', https: false, upstreams: [], label: 'A' },
  ];
  const first = buildCaddyConfig({ acmeEmail: 'ops@example.com', routes });
  const second = buildCaddyConfig({ acmeEmail: 'ops@example.com', routes: [...routes].reverse() });
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  const servers = (first.apps as { http: { servers: Record<string, { routes: { match?: { host: string[] }[]; handle: { handler: string; status_code?: number }[] }[] }> } }).http.servers;
  assert.deepEqual(servers.http!.routes[0]!.match, [{ host: ['b.example.com'] }]);
  assert.equal(servers.http!.routes[0]!.handle[0]!.status_code, 308);
  assert.equal(servers.http!.routes[1]!.handle[0]!.status_code, 503, 'an app without upstreams gets the unavailable page');
  assert.ok(servers.https, 'https server exists when a host wants TLS');
  assert.deepEqual((first.apps as { tls: unknown }).tls, {
    automation: { policies: [{ subjects: ['b.example.com'], issuers: [{ module: 'acme', email: 'ops@example.com' }] }] },
  });
});

test('real Caddy accepts the generated config and routes, balances and hot-reloads traffic', async (t) => {
  const binary = caddyBinary();
  if (binary === null) {
    t.skip('caddy binary not available (set PLOY_TEST_CADDY)');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'ploy-caddy-'));
  const one = await upstream('one');
  const two = await upstream('two');
  const [httpPort, httpsPort, adminPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const configPath = join(dir, 'caddy.json');

  const write = (upstreams: string[]): void => {
    const config = buildCaddyConfig({
      acmeEmail: null,
      httpPort,
      httpsPort,
      routes: [
        { host: 'app.test', https: false, upstreams, label: 'App' },
        { host: 'down.test', https: false, upstreams: [], label: 'Down' },
      ],
    });
    (config.admin as { listen: string }).listen = `localhost:${adminPort}`;
    (config.admin as { config: { persist: boolean } }).config.persist = false;
    writeFileSync(configPath, JSON.stringify(config));
  };

  // The full HTTPS config must also pass Caddy's own validation (no ACME traffic is made by validate).
  const httpsConfig = buildCaddyConfig({
    acmeEmail: 'ops@example.com',
    routes: [{ host: 'secure.example.com', https: true, upstreams: ['ploy-x-1:8080'], label: 'X' }],
  });
  writeFileSync(join(dir, 'https.json'), JSON.stringify(httpsConfig));
  const validation = spawnSync(binary, ['validate', '--config', join(dir, 'https.json')], { encoding: 'utf8' });
  assert.equal(validation.status, 0, validation.stderr);

  write([`127.0.0.1:${one.port}`, `127.0.0.1:${two.port}`]);
  const caddy = spawn(binary, ['run', '--config', configPath], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir } });
  let stderr = '';
  caddy.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 50 && !ready; attempt += 1) {
      try {
        await get(httpPort, 'app.test');
        ready = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(ready, `caddy did not start: ${stderr}`);

    const bodies = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const response = await get(httpPort, 'app.test');
      assert.equal(response.status, 200);
      bodies.add(response.body.split(' ')[0]!);
    }
    assert.deepEqual([...bodies].sort(), ['one', 'two'], 'round robin reaches both replicas');

    const down = await get(httpPort, 'down.test');
    assert.equal(down.status, 503);
    assert.match(down.body, /Down is not running/);

    const unknown = await get(httpPort, 'nobody.test');
    assert.equal(unknown.status, 404);

    // Zero-downtime switch: reload with only the second replica, as the deploy pipeline does.
    write([`127.0.0.1:${two.port}`]);
    const reload = spawnSync(binary, ['reload', '--config', configPath, '--address', `localhost:${adminPort}`, '--force'], { encoding: 'utf8' });
    assert.equal(reload.status, 0, reload.stderr);
    for (let i = 0; i < 4; i += 1) {
      assert.match((await get(httpPort, 'app.test')).body, /^two /);
    }

    // An invalid config is rejected by reload and the running config keeps serving.
    writeFileSync(configPath, '{"apps":{"http":{"servers":{"x":{"listen":["not-an-address"]}}}}}');
    const bad = spawnSync(binary, ['reload', '--config', configPath, '--address', `localhost:${adminPort}`, '--force'], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.match((await get(httpPort, 'app.test')).body, /^two /);
  } finally {
    caddy.kill('SIGTERM');
    one.server.close();
    two.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
