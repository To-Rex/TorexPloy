import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalEngine, findFreePort, readProcessMemory } from './local-engine.ts';
import type { ContainerSpec } from './engine.ts';
import { AppError } from '../errors.ts';

interface Harness {
  dir: string;
  engine: LocalEngine;
  cleanup: () => Promise<void>;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-local-'));
  const engine = new LocalEngine({ stateDir: join(dir, 'state') });
  return {
    dir,
    engine,
    cleanup: async () => {
      await engine.removeByPrefix('');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Write a minimal Node app that serves HTTP, so the engine runs something real. */
function writeApp(dir: string, options: { name?: string; start?: boolean; exitCode?: number } = {}): void {
  mkdirSync(dir, { recursive: true });    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(
        {
          name: options.name ?? 'fixture-app',
          version: '1.0.0',
          // `node server.js` rather than a bare path: this mirrors what a real
          // application declares and exercises the shell path the engine uses.
          ...(options.start === false
            ? { scripts: { build: 'node -e "console.log(1)"' } }
            : { scripts: { start: 'node server.js', build: 'node -e "console.log(1)"' } }),
        },
        null,
        2,
      ),
    );
  writeFileSync(
    join(dir, 'server.js'),
    options.exitCode === undefined
      ? `const http = require('node:http');
const port = Number(process.env.PORT || 0);
const host = process.env.HOST || '127.0.0.1';
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, env: process.env.PLOY_TEST_MARKER ?? null, port }));
});
server.listen(port, host, () => console.log('listening'));
process.on('SIGTERM', () => { console.log('shutting down'); server.close(() => process.exit(0)); });
`
      : `console.log('about to fail'); process.exit(${options.exitCode});`,
  );
}

function spec(overrides: Partial<ContainerSpec> & { name: string; appDir: string }): ContainerSpec {
  return {
    imageTag: 'local/test:latest',
    internalPort: 8080,
    address: '',
    env: {},
    limits: { cpus: 1, memoryMb: 256 },
    replicas: 1,
    ...overrides,
  };
}

test('findFreePort returns a usable, non-privileged port', async () => {
  const port = await findFreePort();
  assert.ok(port > 1024 && port < 65536, `unexpected port ${port}`);

  const other = await findFreePort();
  assert.notEqual(port, other, 'consecutive allocations must differ');
});

test('probe reports availability and is honest about isolation limits', async () => {
  const h = harness();
  try {
    const info = await h.engine.probe();
    assert.equal(info.name, 'local');
    assert.equal(info.available, true);
    assert.match(info.detail ?? '', /advisory|isolation/i);
  } finally {
    await h.cleanup();
  }
});

test('ensureVolume creates a real writable directory', async () => {
  const h = harness();
  try {
    const path = await h.engine.ensureVolume('app-data');
    assert.equal(existsSync(path), true);

    writeFileSync(join(path, 'marker.txt'), 'persisted');
    const again = await h.engine.ensureVolume('app-data');
    assert.equal(again, path);
    assert.equal(existsSync(join(again, 'marker.txt')), true, 'data survives a second ensure call');
  } finally {
    await h.cleanup();
  }
});

test('build installs dependencies and runs the build script', async () => {
  const h = harness();
  try {
    const appDir = join(h.dir, 'build-me');
    writeApp(appDir, { start: false });
    // No dependencies: `npm ci` needs a lockfile, so this exercises the
    // `npm install` path and the build script.
    const output: string[] = [];

    const result = await h.engine.build(
      { imageTag: 'local/build:test', contextDir: appDir, dockerfilePath: 'Dockerfile' },
      (chunk) => output.push(chunk),
    );

    assert.equal(result.imageTag, 'local/build:test');
    assert.ok(result.durationMs >= 0);
    const combined = output.join('');
    assert.match(combined, /npm install|npm ci/);
    assert.match(combined, /npm run build/);
  } finally {
    await h.cleanup();
  }
});

test('build rejects a context without a package.json instead of pretending to succeed', async () => {
  const h = harness();
  try {
    const empty = join(h.dir, 'empty');
    mkdirSync(empty, { recursive: true });

    await assert.rejects(
      () => h.engine.build({ imageTag: 'x', contextDir: empty, dockerfilePath: 'Dockerfile' }, () => {}),
      (error: unknown) => error instanceof AppError && error.code === 'build_failed',
    );
  } finally {
    await h.cleanup();
  }
});

test('build skips the build step when there is no build script', async () => {
  const h = harness();
  try {
    const appDir = join(h.dir, 'no-build');
    writeApp(appDir);
    // Remove the build script but keep start.
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'x', scripts: { start: 'server.js' } }));

    const output: string[] = [];
    await h.engine.build({ imageTag: 'x', contextDir: appDir, dockerfilePath: 'Dockerfile' }, (chunk) => output.push(chunk));
    assert.match(output.join(''), /No build script defined/);
  } finally {
    await h.cleanup();
  }
});

test('a started application really serves HTTP on its allocated port', async () => {
  const h = harness();
  try {
    const appDir = join(h.dir, 'serve-me');
    writeApp(appDir);

    const refs = await h.engine.start([
      spec({ name: 'serve-me-0', appDir, env: { PLOY_TEST_MARKER: 'injected' } }),
    ]);

    assert.equal(refs.length, 1);
    const ref = refs[0]!;
    assert.match(ref.address, /^127\.0\.0\.1:\d+$/);
    assert.ok(ref.hostPort !== null && ref.hostPort > 1024);

    // Wait for the server to accept connections.
    let body: { ok: boolean; env: string | null; port: number } | null = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(`http://${ref.address}/`);
        body = (await response.json()) as { ok: boolean; env: string | null; port: number };
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    assert.ok(body !== null, 'the application must become reachable');
    assert.equal(body.ok, true);
    assert.equal(body.env, 'injected', 'environment variables must reach the process');
    assert.equal(body.port, ref.hostPort, 'PORT must match the allocated address');

    assert.equal(await h.engine.isRunning('serve-me-0'), true);
  } finally {
    await h.cleanup();
  }
});

test('stopping an application releases its port and stops serving', async () => {
  const h = harness();
  try {
    const appDir = join(h.dir, 'stop-me');
    writeApp(appDir);
    const refs = await h.engine.start([spec({ name: 'stop-me-0', appDir })]);
    const address = refs[0]!.address;

    // Confirm it is up before asserting it goes down.
    let up = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await fetch(`http://${address}/`);
        up = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.equal(up, true);

    await h.engine.remove(['stop-me-0']);
    assert.equal(await h.engine.isRunning('stop-me-0'), false);

    await assert.rejects(() => fetch(`http://${address}/`), 'the port must no longer answer');
  } finally {
    await h.cleanup();
  }
});

test('removing a container that was never started is not an error', async () => {
  const h = harness();
  try {
    await assert.doesNotReject(() => h.engine.remove(['never-existed']));
  } finally {
    await h.cleanup();
  }
});

test('list reports managed processes and filters by name prefix', async () => {
  const h = harness();
  try {
    const appDir = join(h.dir, 'multi');
    writeApp(appDir);
    await h.engine.start([
      spec({ name: 'multi-app-0', appDir }),
      spec({ name: 'other-app-0', appDir }),
    ]);

    const all = await h.engine.list();
    assert.equal(all.length, 2);

    const filtered = await h.engine.list({ namePrefix: 'multi-' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.name, 'multi-app-0');
    assert.equal(filtered[0]!.running, true);

    const removed = await h.engine.removeByPrefix('multi-');
    assert.equal(removed, 1);
    assert.equal((await h.engine.list()).length, 1);
  } finally {
    await h.cleanup();
  }
});

test('list filters by label so applications can be correlated', async () => {
  const h = harness();
  try {
    const appDir = join(h.dir, 'labelled');
    writeApp(appDir);
    await h.engine.start([
      spec({ name: 'labelled-a', appDir, labels: { 'ploy.application': 'app_1' } }),
      spec({ name: 'labelled-b', appDir, labels: { 'ploy.application': 'app_2' } }),
    ]);

    const found = await h.engine.list({ label: 'ploy.application=app_1' });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.name, 'labelled-a');
    assert.equal(found[0]!.labels['ploy.application'], 'app_1');
  } finally {
    await h.cleanup();
  }
});

test('stats report real memory usage for a running process', async () => {
  const h = harness();
  try {
    const appDir = join(h.dir, 'stats-me');
    writeApp(appDir);
    await h.engine.start([spec({ name: 'stats-me-0', appDir })]);

    const stats = await h.engine.stats('stats-me-0');
    assert.ok(stats !== null);
    assert.equal(stats.running, true);
    assert.ok(stats.memoryBytes > 0, `expected real memory usage, got ${stats.memoryBytes}`);
    assert.ok(stats.memoryLimitBytes > 0);
  } finally {
    await h.cleanup();
  }
});

test('stats for an unknown container return null rather than fabricated data', async () => {
  const h = harness();
  try {
    assert.equal(await h.engine.stats('nope'), null);
    assert.equal(await h.engine.logs('nope'), '');
    assert.equal(await h.engine.isRunning('nope'), false);
  } finally {
    await h.cleanup();
  }
});

test('runtime output is captured and available for crash diagnosis', async () => {
  const h = harness();
  try {
    const appDir = join(h.dir, 'chatty');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'chatty', scripts: { start: 'node server.js' } }));
    writeFileSync(
      join(appDir, 'server.js'),
      `console.log('booting'); console.error('warning: low disk'); setInterval(() => {}, 1000);`,
    );


    await h.engine.start([spec({ name: 'chatty-0', appDir })]);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const logs = await h.engine.logs('chatty-0');
    assert.match(logs, /booting/);
    assert.match(logs, /warning: low disk/);
    assert.match(h.engine.recentOutput('chatty-0'), /booting/);
  } finally {
    await h.cleanup();
  }
});

test('a crashed process is detected as not running and reports its exit code', async () => {
  const h = harness();
  try {
    const appDir = join(h.dir, 'crasher');
    writeApp(appDir, { exitCode: 7 });
    await h.engine.start([spec({ name: 'crasher-0', appDir })]);

    // Wait for the immediate exit.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (h.engine.exitCode('crasher-0') !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal(await h.engine.isRunning('crasher-0'), false);
    assert.equal(h.engine.exitCode('crasher-0'), 7);
    assert.equal(h.engine.hasCrashed('crasher-0'), true);
  } finally {
    await h.cleanup();
  }
});

test('an application without a start command fails loudly', async () => {
  const h = harness();
  try {
    const appDir = join(h.dir, 'no-start');
    writeApp(appDir, { start: false });
    // package.json has neither a start script nor a main entry.
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'no-start' }));

    await assert.rejects(
      () => h.engine.start([spec({ name: 'no-start-0', appDir })]),
      (error: unknown) => error instanceof AppError && error.code === 'deploy_failed',
    );
  } finally {
    await h.cleanup();
  }
});

test('an explicit command overrides the package.json start script', async () => {
  const h = harness();
  try {
    const appDir = join(h.dir, 'explicit');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'explicit', scripts: { start: 'server.js' } }));
    writeFileSync(join(appDir, 'server.js'), `require('node:http').createServer((_q,r)=>r.end('from-script')).listen(process.env.PORT, process.env.HOST);`);

    const refs = await h.engine.start([
      spec({
        name: 'explicit-0',
        appDir,
        command: `node -e "require('node:http').createServer((_q,r)=>r.end('from-command')).listen(process.env.PORT, process.env.HOST);"`,
      }),
    ]);

    let body = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        body = await (await fetch(`http://${refs[0]!.address}/`)).text();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.equal(body, 'from-command');
  } finally {
    await h.cleanup();
  }
});

test('a failed replica start rolls back the replicas that did start', async () => {
  const h = harness();
  try {
    const goodDir = join(h.dir, 'good');
    const badDir = join(h.dir, 'bad');
    writeApp(goodDir);
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'package.json'), JSON.stringify({ name: 'bad' }));

    await assert.rejects(() =>
      h.engine.start([
        spec({ name: 'rollback-good', appDir: goodDir }),
        spec({ name: 'rollback-bad', appDir: badDir }),
      ]),
    );

    assert.equal(await h.engine.isRunning('rollback-good'), false, 'the successfully started replica must be cleaned up');
    assert.equal((await h.engine.list()).length, 0, 'no debris is left behind');
  } finally {
    await h.cleanup();
  }
});

test('readProcessMemory reads real usage for the current process', async () => {
  const bytes = await readProcessMemory(process.pid);
  assert.ok(bytes !== null && bytes > 0, `expected real RSS for pid ${process.pid}, got ${bytes}`);
});

test('readProcessMemory returns null for a pid that does not exist', async () => {
  assert.equal(await readProcessMemory(999_999), null);
});

test('verifyStateDir confirms the engine can write its state', async () => {
  const h = harness();
  try {
    assert.equal(await h.engine.verifyStateDir(), true);
  } finally {
    await h.cleanup();
  }
});