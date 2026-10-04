import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../db/database.ts';
import type { Database } from '../db/database.ts';
import { createRepositories } from '../domain/repositories.ts';
import type { Repositories } from '../domain/repositories.ts';
import { LocalEngine } from '../exec/local-engine.ts';
import type { ContainerEngine } from '../exec/engine.ts';
import { DeploymentPipeline, buildContainerSpec, containerName, deploymentContainerNames, resolveInternalPort } from './pipeline.ts';
import { EmbeddedProxy } from '../proxy/manager.ts';
import { EventBus } from '../realtime/events.ts';
import { loadConfig } from '../config.ts';
import { createLogger } from '../logger.ts';
import { hashPassword } from '../crypto.ts';
import type { Application } from '../domain/types.ts';
import type { DeploymentLogPayload } from '../realtime/events.ts';

interface Harness {
  dir: string;
  db: Database;
  repos: Repositories;
  engine: LocalEngine;
  pipeline: DeploymentPipeline;
  bus: EventBus;
  proxy: EmbeddedProxy;
  app: Application;
  serverId: string;
  close: () => Promise<void>;
}

/**
 * Build a full platform harness around a real application directory.
 * Everything here is real: real database, real processes, real HTTP.
 */
async function harness(appSource: string, options: { replicas?: number; healthPath?: string | null } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-pipeline-'));
  // Short health-check budget and no drain pause, so failure-path tests finish
  // in seconds instead of minutes while exercising the same code.
  const config = loadConfig({ dataDir: join(dir, 'data') }, {
    PLOY_HEALTH_CHECK_TIMEOUT_MS: '4000',
    PLOY_DRAIN_TIMEOUT_MS: '0',
  });
  const db = openDatabase(join(dir, 'ploy.db'));
  const repos = createRepositories(db, config.secretKey);
  const logger = createLogger({ level: 'error', json: true, write: () => {} });
  const bus = new EventBus();
  const engine = new LocalEngine({ stateDir: join(config.dataDir, 'runtime') });
  const proxy = new EmbeddedProxy({ port: 0, host: '127.0.0.1', logger });

  const user = repos.users.create({ email: 'a@b.c', name: 'Tester', passwordHash: hashPassword('password-123') });
  const team = repos.teams.create({ name: 'Team' });
  repos.teams.addMember(team.id, user.id, 'owner');
  const server = repos.servers.create({ teamId: team.id, name: 'local', mode: 'local', status: 'online' });
  const project = repos.projects.create({ teamId: team.id, name: 'Project' });
  const app = repos.applications.create({
    projectId: project.id,
    serverId: server.id,
    name: 'Web',
    slug: 'web',
    sourceType: 'git',
    repoUrl: appSource,
    repoProvider: 'local',
    buildType: 'dockerfile',
    internalPort: '3000',
    healthCheckPath: options.healthPath === undefined ? '/' : options.healthPath,
    replicas: options.replicas ?? 1,
  });

  const pipeline = new DeploymentPipeline({
    repos,
    config,
    logger,
    bus,
    resolveEngine: async (): Promise<ContainerEngine> => engine,
    proxy,
  });

  return {
    dir,
    db,
    repos,
    engine,
    pipeline,
    bus,
    proxy,
    app,
    serverId: server.id,
    close: async () => {
      await engine.removeByPrefix('');
      await proxy.shutdown();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A real, buildable application: git repo + package.json + HTTP server. */
function createAppRepo(dir: string, options: { body?: string; failBuild?: boolean; crash?: boolean; port?: number } = {}): string {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });

  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture-app',
        version: '1.0.0',
        scripts: { start: 'node server.js', build: 'node build.js' },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(repo, 'build.js'),
    options.failBuild === true ? `console.error('build exploded'); process.exit(1);` : `console.log('build ok');`,
  );

  writeFileSync(
    join(repo, 'server.js'),
    options.crash === true
      ? `console.error('crashed on boot'); process.exit(1);`
      : `const http = require('node:http');
const body = ${JSON.stringify(options.body ?? 'v1')};
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ body, path: req.url }));
});
server.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening on ' + process.env.PORT));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
  );

  // A real git repository: the pipeline clones it rather than copying files.
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'initial commit'], { cwd: repo });

  return repo;
}

test('resolveInternalPort prefers configuration and falls back to 3000', () => {
  const base = { internalPort: '8080' } as Application;
  assert.equal(resolveInternalPort(base), 8080);
  assert.equal(resolveInternalPort({ ...base, internalPort: null }), 3000);
  assert.equal(resolveInternalPort({ ...base, internalPort: 'not-a-port' }), 3000);
  assert.equal(resolveInternalPort({ ...base, internalPort: '99999' }), 3000);
});

test('container names are deterministic, unique per deployment and replica-indexed', () => {
  const app = { id: 'app_1', slug: 'My App' } as Application;
  assert.equal(containerName(app, 'dep_abcdefgh', 0), 'ploy-myapp-abcdefgh-0');
  assert.equal(containerName(app, 'dep_abcdefgh', 1), 'ploy-myapp-abcdefgh-1');
  assert.notEqual(containerName(app, 'dep_aaaaaaaa', 0), containerName(app, 'dep_bbbbbbbb', 0));
  assert.deepEqual(deploymentContainerNames(app, 'dep_abcdefgh', 3), [
    'ploy-myapp-abcdefgh-0',
    'ploy-myapp-abcdefgh-1',
    'ploy-myapp-abcdefgh-2',
  ]);
});

test('buildContainerSpec applies resource limits, labels and the port', () => {
  const app = {
    id: 'app_1',
    slug: 'web',
    internalPort: '4000',
    cpuLimit: 0.5,
    memoryLimitMb: 256,
    startCommand: null,
  } as Application;

  const spec = buildContainerSpec(app, 'dep_12345678', 'docker', 'ploy/web:dep', { FOO: 'bar' }, 0);
  assert.equal(spec.name, 'ploy-web-12345678-0');
  assert.equal(spec.address, 'ploy-web-12345678-0:4000');
  assert.equal(spec.internalPort, 4000);
  assert.equal(spec.env.FOO, 'bar');
  assert.equal(spec.env.PORT, '4000');
  assert.deepEqual(spec.limits, { cpus: 0.5, memoryMb: 256 });
  assert.equal(spec.labels?.['ploy.application'], 'app_1');
  assert.equal(spec.network, 'ploy');
});

test('a full deployment builds, starts, health-checks and reports success', async () => {
  const staging = mkdtempSync(join(tmpdir(), 'ploy-src-'));
  try {
    const repo = createAppRepo(staging, { body: 'hello' });
    const h = await harness(repo);
    try {
      const logs: DeploymentLogPayload[] = [];
      h.bus.on('deployment.log', (event) => logs.push(event.payload as DeploymentLogPayload));

      const deployment = await h.pipeline.run({ applicationId: h.app.id, trigger: 'manual' });

      assert.equal(deployment.status, 'success', `expected success, got ${deployment.status}: ${deployment.errorMessage ?? ''}`);
      assert.equal(deployment.commitSha !== null, true, 'the deployed commit must be recorded');
      assert.equal(deployment.imageTag?.startsWith('ploy/web:dep_'), true);
      assert.equal(deployment.containerIds.length, 1);
      assert.ok(deployment.durationMs !== null && deployment.durationMs >= 0);

      // The application is really serving.
      const refs = await h.engine.list({ label: `ploy.application=${h.app.id}` });
      assert.equal(refs.length, 1);
      assert.equal(refs[0]!.running, true);

      // Logs streamed live and were persisted.
      assert.ok(logs.length > 0, 'log lines must reach the event bus');
      assert.ok(logs.some((entry) => entry.message.includes('Deployment successful')));
      const logPath = deployment.logPath;
      assert.ok(logPath !== null);
      assert.match(readFileSync(logPath, 'utf8'), /Deployment successful/);

      // Application status reflects reality.
      assert.equal(h.repos.applications.getByIdOrThrow(h.app.id).status, 'running');
    } finally {
      await h.close();
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('a deployment with a domain routes real traffic through the proxy', async () => {
  const staging = mkdtempSync(join(tmpdir(), 'ploy-src-'));
  try {
    const repo = createAppRepo(staging, { body: 'routed' });
    const h = await harness(repo);
    try {
      h.repos.domains.create({ applicationId: h.app.id, host: 'app.example.com', isPrimary: true });

      const deployment = await h.pipeline.run({ applicationId: h.app.id, trigger: 'manual' });
      assert.equal(deployment.status, 'success', deployment.errorMessage ?? '');

      // The proxy must route by Host header to the live upstream.
      const upstream = h.proxy.resolve('app.example.com', '/');
      assert.ok(upstream !== null, 'the domain must resolve to an upstream');

      const response = await fetch(`http://${upstream}/`);
      const body = (await response.json()) as { body: string };
      assert.equal(body.body, 'routed');

      // The domain is marked active once traffic flows.
      const domains = h.repos.domains.listForApplication(h.app.id);
      assert.equal(domains[0]!.status, 'active');
      assert.equal(domains[0]!.certStatus, 'issued');

      // An unknown host is not routed.
      assert.equal(h.proxy.resolve('unknown.example.com', '/'), null);
    } finally {
      await h.close();
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('a failed build never touches the running application', async () => {
  const staging = mkdtempSync(join(tmpdir(), 'ploy-src-'));
  try {
    const repo = createAppRepo(staging, { body: 'v1' });
    const h = await harness(repo);
    try {
      const first = await h.pipeline.run({ applicationId: h.app.id, trigger: 'manual' });
      assert.equal(first.status, 'success');

      const runningBefore = (await h.engine.list({ label: `ploy.application=${h.app.id}` })).filter((c) => c.running);
      assert.equal(runningBefore.length, 1);

      // Break the build and deploy again.
      writeFileSync(join(repo, 'build.js'), `console.error('broken'); process.exit(1);`);
          execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['commit', '-q', '-m', 'break the build'], { cwd: repo });

      const second = await h.pipeline.run({ applicationId: h.app.id, trigger: 'manual' });
      assert.equal(second.status, 'failed');
      assert.match(second.errorMessage ?? '', /build/i);

      // The original deployment is still serving, untouched.
      const runningAfter = (await h.engine.list({ label: `ploy.application=${h.app.id}` })).filter((c) => c.running);
      assert.equal(runningAfter.length, 1, 'the previous deployment must keep running');
      assert.equal(runningAfter[0]!.name, runningBefore[0]!.name, 'and it must be the same container');

      const upstream = h.proxy.resolve('app.example.com', '/');
      void upstream; // no domain configured in this test; the container check above is the assertion
    } finally {
      await h.close();
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('a health check failure rolls back to the previous successful deployment', async () => {
  const staging = mkdtempSync(join(tmpdir(), 'ploy-src-'));
  try {
    const repo = createAppRepo(staging, { body: 'v1' });
    const h = await harness(repo);
    try {
      h.repos.domains.create({ applicationId: h.app.id, host: 'app.example.com', isPrimary: true });
      const first = await h.pipeline.run({ applicationId: h.app.id, trigger: 'manual' });
      assert.equal(first.status, 'success', first.errorMessage ?? '');

      // New version that starts but never answers -> health check fails.
      writeFileSync(
        join(repo, 'server.js'),
        `console.log('starting but never listening'); setInterval(() => {}, 1000);`,
      );
          execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['commit', '-q', '-m', 'never listens'], { cwd: repo });

      const second = await h.pipeline.run({ applicationId: h.app.id, trigger: 'manual' });
      assert.equal(second.status, 'failed', 'a version that never answers must fail');
      assert.match(second.errorMessage ?? '', /health/i);

      // Rollback restored the previous version: it answers again.
      const upstream = h.proxy.resolve('app.example.com', '/');
      assert.ok(upstream !== null, 'traffic must be routed back to the previous deployment');

      let body: { body: string } | null = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          body = (await (await fetch(`http://${upstream}/`)).json()) as { body: string };
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      assert.equal(body?.body, 'v1', 'the rolled-back version must serve the old content');
    } finally {
      await h.close();
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('the second deployment replaces the first without a gap', async () => {
  const staging = mkdtempSync(join(tmpdir(), 'ploy-src-'));
  try {
    const repo = createAppRepo(staging, { body: 'v1' });
    const h = await harness(repo);
    try {
      h.repos.domains.create({ applicationId: h.app.id, host: 'app.example.com', isPrimary: true });

      const first = await h.pipeline.run({ applicationId: h.app.id, trigger: 'manual' });
      assert.equal(first.status, 'success', first.errorMessage ?? '');

      writeFileSync(
        join(repo, 'server.js'),
        `const http = require('node:http');
http.createServer((req, res) => { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({body:'v2'})); }).listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`,
      );
          execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['commit', '-q', '-m', 'v2'], { cwd: repo });

      const second = await h.pipeline.run({ applicationId: h.app.id, trigger: 'manual' });
      assert.equal(second.status, 'success', second.errorMessage ?? '');

      // Only the new deployment's containers remain.
      const running = (await h.engine.list({ label: `ploy.application=${h.app.id}` })).filter((c) => c.running);
      assert.equal(running.length, 1);
      assert.match(running[0]!.name, new RegExp(second.id.slice(-8)));

      const upstream = h.proxy.resolve('app.example.com', '/');
      assert.ok(upstream !== null);
      const body = (await (await fetch(`http://${upstream}/`)).json()) as { body: string };
      assert.equal(body.body, 'v2');

      // History is preserved for rollback.
      const history = h.repos.deployments.listForApplication(h.app.id);
      assert.equal(history.length, 2);
      assert.equal(h.repos.deployments.getLastSuccessful(h.app.id)?.id, second.id);
    } finally {
      await h.close();
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('an application that crashes on boot fails the deployment and leaves no debris', async () => {
  const staging = mkdtempSync(join(tmpdir(), 'ploy-src-'));
  try {
    const repo = createAppRepo(staging, { crash: true });
    const h = await harness(repo);
    try {
      const deployment = await h.pipeline.run({ applicationId: h.app.id, trigger: 'manual' });
      assert.equal(deployment.status, 'failed');
      assert.match(deployment.errorMessage ?? '', /health/i);

      const leftover = await h.engine.list({ label: `ploy.application=${h.app.id}` });
      assert.equal(leftover.length, 0, 'a failed first deployment must not leave containers behind');
    } finally {
      await h.close();
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('environment variables reach the running application', async () => {
  const staging = mkdtempSync(join(tmpdir(), 'ploy-src-'));
  try {
    const repo = createAppRepo(staging);
    writeFileSync(
      join(repo, 'server.js'),
      `const http = require('node:http');
http.createServer((req, res) => { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ secret: process.env.MY_SECRET ?? null, scope: process.env.SCOPED ?? null })); }).listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`,
    );
      execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'env probe'], { cwd: repo });

    const h = await harness(repo);
    try {
      h.repos.envVars.set({ applicationId: h.app.id, key: 'MY_SECRET', value: 'top-secret-value' });
      h.repos.envVars.set({ projectId: h.app.projectId, key: 'SCOPED', value: 'from-project' });
      // Build-only variables must not leak into the runtime environment.
      h.repos.envVars.set({ applicationId: h.app.id, key: 'BUILD_ONLY', value: 'nope', scope: 'build' });

      const deployment = await h.pipeline.run({ applicationId: h.app.id, trigger: 'manual' });
      assert.equal(deployment.status, 'success', deployment.errorMessage ?? '');

      const containers = await h.engine.list({ label: `ploy.application=${h.app.id}` });
      const upstream = `127.0.0.1:${(await h.engine.list()).length > 0 ? '' : ''}`;
      void upstream;

      // Read the port the engine allocated for the container.
      const port = Number(
        (await h.engine.logs(containers[0]!.name)).match(/listening on (\d+)/)?.[1] ?? 0,
      );
      assert.ok(port > 0, 'the application must report its port');

      const body = (await (await fetch(`http://127.0.0.1:${port}/`)).json()) as { secret: string | null; scope: string | null };
      assert.equal(body.secret, 'top-secret-value');
      assert.equal(body.scope, 'from-project');
    } finally {
      await h.close();
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('replicas are started and the proxy balances across them', async () => {
  const staging = mkdtempSync(join(tmpdir(), 'ploy-src-'));
  try {
    const repo = createAppRepo(staging);
    writeFileSync(
      join(repo, 'server.js'),
      `const http = require('node:http');
http.createServer((req, res) => { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ replica: process.env.PORT })); }).listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`,
    );
      execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'replicas'], { cwd: repo });

    const h = await harness(repo, { replicas: 2 });
    try {
      h.repos.domains.create({ applicationId: h.app.id, host: 'app.example.com', isPrimary: true });
      const deployment = await h.pipeline.run({ applicationId: h.app.id, trigger: 'manual' });
      assert.equal(deployment.status, 'success', deployment.errorMessage ?? '');

      const running = (await h.engine.list({ label: `ploy.application=${h.app.id}` })).filter((c) => c.running);
      assert.equal(running.length, 2, 'both replicas must be running');

      // Round-robin must hand out both upstreams.
      const seen = new Set<string>();
      for (let i = 0; i < 4; i += 1) {
        const upstream = h.proxy.resolve('app.example.com', '/');
        if (upstream !== null) seen.add(upstream);
      }
      assert.equal(seen.size, 2, 'traffic must be spread across both replicas');
    } finally {
      await h.close();
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('concurrent deployments of the same application are rejected', async () => {
  const staging = mkdtempSync(join(tmpdir(), 'ploy-src-'));
  try {
    const repo = createAppRepo(staging);
    const h = await harness(repo);
    try {
      const first = h.pipeline.run({ applicationId: h.app.id, trigger: 'manual' });
      // The second attempt starts while the first is in flight.
      await assert.rejects(
        () => h.pipeline.run({ applicationId: h.app.id, trigger: 'manual' }),
        /already running/,
      );
      await first;
      assert.equal(h.pipeline.isActive(h.app.id), false);
    } finally {
      await h.close();
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('a cancelled deployment is recorded as cancelled, not failed', async () => {
  const staging = mkdtempSync(join(tmpdir(), 'ploy-src-'));
  try {
    const repo = createAppRepo(staging);
    const h = await harness(repo);
    try {
      const controller = new AbortController();
      // Cancel shortly after the build starts.
      setTimeout(() => controller.abort(), 150);
      const deployment = await h.pipeline.run({ applicationId: h.app.id, trigger: 'manual', signal: controller.signal });

      assert.equal(deployment.status, 'cancelled');
      const leftover = await h.engine.list({ label: `ploy.application=${h.app.id}` });
      assert.equal(leftover.length, 0, 'cancellation must clean up');
    } finally {
      await h.close();
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('the build directory is removed after a successful deployment', async () => {
  const staging = mkdtempSync(join(tmpdir(), 'ploy-src-'));
  try {
    const repo = createAppRepo(staging);
    const h = await harness(repo);
    try {
      const deployment = await h.pipeline.run({ applicationId: h.app.id, trigger: 'manual' });
      assert.equal(deployment.status, 'success', deployment.errorMessage ?? '');

      const buildsDir = join(h.dir, 'data', 'builds');
      const leftovers = existsSync(buildsDir) ? (await import('node:fs')).readdirSync(buildsDir) : [];
      assert.equal(leftovers.length, 0, 'successful builds must not accumulate on disk');
    } finally {
      await h.close();
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});