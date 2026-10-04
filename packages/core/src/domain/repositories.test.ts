import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.ts';
import type { Database } from '../db/database.ts';
import { createRepositories } from './repositories.ts';
import type { Repositories } from './repositories.ts';
import { AppError } from '../errors.ts';
import { hashPassword, verifyPassword } from '../crypto.ts';

const MASTER_KEY = 'unit-test-master-key-long-enough-for-hkdf-0001';

interface Harness {
  db: Database;
  repos: Repositories;
  close: () => void;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-repo-'));
  const db = openDatabase(join(dir, 'ploy.db'));
  return {
    db,
    repos: createRepositories(db, MASTER_KEY),
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Create a user + team with the user as owner; the common starting point. */
function seed(h: Harness): { userId: string; teamId: string } {
  const user = h.repos.users.create({
    email: 'torex@example.com',
    name: 'Torex',
    passwordHash: hashPassword('password-123'),
  });
  const team = h.repos.teams.create({ name: 'Torex Studio' });
  h.repos.teams.addMember(team.id, user.id, 'owner');
  return { userId: user.id, teamId: team.id };
}

test('a user is created, stored with a verifiable password hash and no plaintext', () => {
  const h = harness();
  try {
    const user = h.repos.users.create({
      email: 'Torex@Example.com',
      name: 'Torex',
      passwordHash: hashPassword('password-123'),
    });

    assert.match(user.id, /^usr_/);
    assert.equal(user.locale, 'uz', 'Uzbek is the default locale');
    assert.equal(user.theme, 'system');
    assert.equal(user.isPlatformAdmin, false);

    const raw = h.db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', user.id);
    assert.ok(raw !== undefined);
    assert.ok(!raw.password_hash.includes('password-123'));
    assert.equal(verifyPassword('password-123', raw.password_hash), true);
  } finally {
    h.close();
  }
});

test('duplicate emails are rejected with a conflict, case-insensitively', () => {
  const h = harness();
  try {
    h.repos.users.create({ email: 'a@b.com', name: 'A', passwordHash: hashPassword('password-123') });
    assert.throws(
      () => h.repos.users.create({ email: 'A@B.COM', name: 'B', passwordHash: hashPassword('password-456') }),
      (error: unknown) => error instanceof AppError && error.code === 'conflict',
    );
  } finally {
    h.close();
  }
});

test('profile updates persist locale and theme independently', () => {
  const h = harness();
  try {
    const user = h.repos.users.create({ email: 'a@b.com', name: 'A', passwordHash: hashPassword('password-123') });
    const updated = h.repos.users.updateProfile(user.id, { locale: 'ru' });
    assert.equal(updated.locale, 'ru');
    assert.equal(updated.theme, 'system', 'untouched fields are preserved');
    assert.equal(updated.name, 'A');

    const themed = h.repos.users.updateProfile(user.id, { theme: 'dark', name: 'Renamed' });
    assert.equal(themed.theme, 'dark');
    assert.equal(themed.locale, 'ru');
    assert.equal(themed.name, 'Renamed');
  } finally {
    h.close();
  }
});

test('team membership grants a role and is unique per user', () => {
  const h = harness();
  try {
    const { userId, teamId } = seed(h);
    assert.equal(h.repos.teams.getRole(teamId, userId), 'owner');

    assert.throws(
      () => h.repos.teams.addMember(teamId, userId, 'viewer'),
      (error: unknown) => error instanceof AppError && error.code === 'conflict',
    );
  } finally {
    h.close();
  }
});

test('listForUser returns only the teams the user belongs to, with roles', () => {
  const h = harness();
  try {
    const { userId } = seed(h);
    const otherUser = h.repos.users.create({ email: 'z@y.com', name: 'Z', passwordHash: hashPassword('password-789') });
    const otherTeam = h.repos.teams.create({ name: 'Other Team' });
    h.repos.teams.addMember(otherTeam.id, otherUser.id, 'owner');

    const memberships = h.repos.teams.listForUser(userId);
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0]!.team.name, 'Torex Studio');
    assert.equal(memberships[0]!.role, 'owner');
  } finally {
    h.close();
  }
});

test('env var values are encrypted at rest and decrypted on read', () => {
  const h = harness();
  try {
    const { teamId } = seed(h);
    const project = h.repos.projects.create({ teamId, name: 'API' });
    const server = h.repos.servers.create({ teamId, name: 'local', mode: 'local' });
    const app = h.repos.applications.create({ projectId: project.id, serverId: server.id, name: 'Web' });

    const secret = 'postgres://user:sup3rs3cret@db:5432/app';
    h.repos.envVars.set({ applicationId: app.id, key: 'DATABASE_URL', value: secret });

    // Stored form must be ciphertext.
    const raw = h.db.get<{ value: string }>('SELECT value FROM env_vars WHERE application_id = ?', app.id);
    assert.ok(raw !== undefined);
    assert.ok(!raw.value.includes('sup3rs3cret'), 'the secret must not be readable in the database file');
    assert.match(raw.value, /^v1\.env\./);

    // Read form must be the plaintext.
    const listed = h.repos.envVars.listForApplication(app.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.value, secret);
  } finally {
    h.close();
  }
});

test('setting the same key twice updates in place rather than duplicating', () => {
  const h = harness();
  try {
    const { teamId } = seed(h);
    const project = h.repos.projects.create({ teamId, name: 'API' });
    const server = h.repos.servers.create({ teamId, name: 'local', mode: 'local' });
    const app = h.repos.applications.create({ projectId: project.id, serverId: server.id, name: 'Web' });

    const first = h.repos.envVars.set({ applicationId: app.id, key: 'LOG_LEVEL', value: 'info' });
    const second = h.repos.envVars.set({ applicationId: app.id, key: 'LOG_LEVEL', value: 'debug', scope: 'both' });

    assert.equal(first.id, second.id);
    assert.equal(second.value, 'debug');
    assert.equal(second.scope, 'both');
    assert.equal(second.createdAt, first.createdAt, 'created_at must not be rewritten by an update');

    const all = h.repos.envVars.listForApplication(app.id);
    assert.equal(all.length, 1);
  } finally {
    h.close();
  }
});

test('invalid environment variable names are rejected before they reach a container', () => {
  const h = harness();
  try {
    const { teamId } = seed(h);
    const project = h.repos.projects.create({ teamId, name: 'API' });

    for (const bad of ['1LEADING_DIGIT', 'has space', 'has-dash', 'has.dot', '']) {
      assert.throws(
        () => h.repos.envVars.set({ projectId: project.id, key: bad, value: 'x' }),
        (error: unknown) => error instanceof AppError && error.code === 'conflict',
        `expected ${JSON.stringify(bad)} to be rejected`,
      );
    }
  } finally {
    h.close();
  }
});

test('resolveForApplication layers project variables under application overrides', () => {
  const h = harness();
  try {
    const { teamId } = seed(h);
    const project = h.repos.projects.create({ teamId, name: 'API' });
    const server = h.repos.servers.create({ teamId, name: 'local', mode: 'local' });
    const app = h.repos.applications.create({ projectId: project.id, serverId: server.id, name: 'Web' });

    h.repos.envVars.set({ projectId: project.id, key: 'SHARED', value: 'from-project' });
    h.repos.envVars.set({ projectId: project.id, key: 'ONLY_PROJECT', value: 'yes' });
    h.repos.envVars.set({ applicationId: app.id, key: 'SHARED', value: 'from-app' });
    h.repos.envVars.set({ applicationId: app.id, key: 'ONLY_APP', value: 'yes' });
    h.repos.envVars.set({ projectId: project.id, key: 'BUILD_ONLY', value: 'yes', scope: 'build' });

    const runtime = h.repos.envVars.resolveForApplication(app.id, project.id, 'runtime');
    assert.equal(runtime.SHARED, 'from-app', 'application scope overrides project scope');
    assert.equal(runtime.ONLY_PROJECT, 'yes');
    assert.equal(runtime.ONLY_APP, 'yes');
    assert.equal(runtime.BUILD_ONLY, undefined, 'build-only vars are not injected at runtime');

    const build = h.repos.envVars.resolveForApplication(app.id, project.id, 'build');
    assert.equal(build.BUILD_ONLY, 'yes');
  } finally {
    h.close();
  }
});

test('domains are globally unique and normalized to lowercase', () => {
  const h = harness();
  try {
    const { teamId } = seed(h);
    const project = h.repos.projects.create({ teamId, name: 'API' });
    const server = h.repos.servers.create({ teamId, name: 'local', mode: 'local' });
    const app = h.repos.applications.create({ projectId: project.id, serverId: server.id, name: 'Web' });

    const domain = h.repos.domains.create({ applicationId: app.id, host: 'App.Example.COM', isPrimary: true });
    assert.equal(domain.host, 'app.example.com');
    assert.equal(domain.status, 'pending');
    assert.equal(domain.certStatus, 'pending');

    assert.throws(
      () => h.repos.domains.create({ applicationId: app.id, host: 'app.example.com' }),
      (error: unknown) => error instanceof AppError && error.code === 'conflict',
    );
  } finally {
    h.close();
  }
});

test('setting a primary domain demotes the previous primary', () => {
  const h = harness();
  try {
    const { teamId } = seed(h);
    const project = h.repos.projects.create({ teamId, name: 'API' });
    const server = h.repos.servers.create({ teamId, name: 'local', mode: 'local' });
    const app = h.repos.applications.create({ projectId: project.id, serverId: server.id, name: 'Web' });

    const first = h.repos.domains.create({ applicationId: app.id, host: 'one.example.com', isPrimary: true });
    const second = h.repos.domains.create({ applicationId: app.id, host: 'two.example.com' });
    h.repos.domains.setPrimary(app.id, second.id);

    const list = h.repos.domains.listForApplication(app.id);
    assert.equal(list.filter((d) => d.isPrimary).length, 1, 'exactly one primary at all times');
    assert.equal(list[0]!.id, second.id, 'the primary sorts first');
    assert.equal(list.find((d) => d.id === first.id)?.isPrimary, false);
  } finally {
    h.close();
  }
});

test('http-only domains record certificates as disabled rather than pending', () => {
  const h = harness();
  try {
    const { teamId } = seed(h);
    const project = h.repos.projects.create({ teamId, name: 'API' });
    const server = h.repos.servers.create({ teamId, name: 'local', mode: 'local' });
    const app = h.repos.applications.create({ projectId: project.id, serverId: server.id, name: 'Web' });

    const domain = h.repos.domains.create({ applicationId: app.id, host: 'plain.example.com', https: false });
    assert.equal(domain.https, false);
    assert.equal(domain.certStatus, 'disabled');
  } finally {
    h.close();
  }
});

test('applications carry a unique webhook secret that can be rotated', () => {
  const h = harness();
  try {
    const { teamId } = seed(h);
    const project = h.repos.projects.create({ teamId, name: 'API' });
    const server = h.repos.servers.create({ teamId, name: 'local', mode: 'local' });
    const app = h.repos.applications.create({ projectId: project.id, serverId: server.id, name: 'Web' });

    const original = h.repos.applications.getWebhookSecret(app.id);
    assert.ok(original !== null && original.startsWith('wh_'));

    const found = h.repos.applications.findByWebhookSecret(original);
    assert.equal(found?.id, app.id);

    const rotated = h.repos.applications.rotateWebhookSecret(app.id);
    assert.notEqual(rotated, original);
    assert.equal(h.repos.applications.findByWebhookSecret(original), undefined, 'the old secret stops working');
    assert.equal(h.repos.applications.findByWebhookSecret(rotated)?.id, app.id);
  } finally {
    h.close();
  }
});

test('build args round-trip through JSON storage', () => {
  const h = harness();
  try {
    const { teamId } = seed(h);
    const project = h.repos.projects.create({ teamId, name: 'API' });
    const server = h.repos.servers.create({ teamId, name: 'local', mode: 'local' });
    const app = h.repos.applications.create({
      projectId: project.id,
      serverId: server.id,
      name: 'Web',
      buildArgs: { NODE_ENV: 'production', VITE_API_URL: 'https://api.example.com' },
    });

    const reloaded = h.repos.applications.getByIdOrThrow(app.id);
    assert.deepEqual(reloaded.buildArgs, { NODE_ENV: 'production', VITE_API_URL: 'https://api.example.com' });
  } finally {
    h.close();
  }
});

test('getInTeam enforces tenant scope: another team cannot read the application', () => {
  const h = harness();
  try {
    const { teamId } = seed(h);
    const project = h.repos.projects.create({ teamId, name: 'API' });
    const server = h.repos.servers.create({ teamId, name: 'local', mode: 'local' });
    const app = h.repos.applications.create({ projectId: project.id, serverId: server.id, name: 'Web' });

    const foreign = h.repos.users.create({ email: 'spy@example.com', name: 'Spy', passwordHash: hashPassword('password-123') });
    const foreignTeam = h.repos.teams.create({ name: 'Foreign' });
    h.repos.teams.addMember(foreignTeam.id, foreign.id, 'owner');

    assert.equal(h.repos.applications.getInTeam(teamId, app.id)?.application.id, app.id);
    assert.equal(
      h.repos.applications.getInTeam(foreignTeam.id, app.id),
      undefined,
      'cross-team reads must return nothing, not another team\'s data',
    );
  } finally {
    h.close();
  }
});

test('deleting a project cascades to its applications and their env vars', () => {
  const h = harness();
  try {
    const { teamId } = seed(h);
    const project = h.repos.projects.create({ teamId, name: 'API' });
    const server = h.repos.servers.create({ teamId, name: 'local', mode: 'local' });
    const app = h.repos.applications.create({ projectId: project.id, serverId: server.id, name: 'Web' });
    h.repos.envVars.set({ applicationId: app.id, key: 'K', value: 'v' });

    h.repos.projects.delete(project.id);

    assert.equal(h.repos.applications.getById(app.id), undefined);
    assert.equal(Number(h.db.scalar('SELECT COUNT(*) FROM env_vars')), 0, 'cascade removes orphaned env vars');
  } finally {
    h.close();
  }
});

test('sessions expire: an expired token no longer resolves', () => {
  const h = harness();
  try {
    const { userId } = seed(h);
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    h.repos.sessions.create({ userId, tokenHash: 'expired-hash', expiresAt: past });
    h.repos.sessions.create({ userId, tokenHash: 'valid-hash', expiresAt: future });

    assert.equal(h.repos.sessions.findValidByTokenHash('expired-hash'), undefined);
    assert.ok(h.repos.sessions.findValidByTokenHash('valid-hash') !== undefined);

    const removed = h.repos.sessions.deleteExpired();
    assert.equal(removed, 1);
  } finally {
    h.close();
  }
});

test('API tokens are stored hashed and respect expiry', () => {
  const h = harness();
  try {
    const { userId, teamId } = seed(h);
    const token = h.repos.apiTokens.create({
      userId,
      teamId,
      name: 'CI',
      tokenHash: 'sha256-of-the-token',
      prefix: 'ploy_abc123',
      scopes: ['deploy'],
    });

    assert.deepEqual(token.scopes, ['deploy']);
    const raw = h.db.get<{ token_hash: string }>('SELECT token_hash FROM api_tokens WHERE id = ?', token.id);
    assert.equal(raw?.token_hash, 'sha256-of-the-token', 'only the hash is stored');

    const valid = h.repos.apiTokens.findValidByTokenHash('sha256-of-the-token');
    assert.equal(valid?.id, token.id);

    const expired = h.repos.apiTokens.create({
      userId,
      teamId,
      name: 'Old',
      tokenHash: 'expired-token-hash',
      prefix: 'ploy_old',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(h.repos.apiTokens.findValidByTokenHash('expired-token-hash'), undefined);
    assert.ok(expired.expiresAt !== null);
  } finally {
    h.close();
  }
});

test('the job queue claims the highest priority eligible job exactly once', () => {
  const h = harness();
  try {
    h.repos.jobs.enqueue({ kind: 'cleanup', priority: 200 });
    const urgent = h.repos.jobs.enqueue({ kind: 'deploy', priority: 10 });
    h.repos.jobs.enqueue({ kind: 'deploy', priority: 100 });

    const claimed = h.repos.jobs.claimNext('worker-1');
    assert.equal(claimed?.id, urgent.id, 'lowest priority number wins');

    const claimedAgain = h.repos.jobs.claimNext('worker-2');
    assert.equal(claimedAgain?.kind, 'deploy');
    assert.notEqual(claimedAgain?.id, urgent.id, 'a claimed job is never handed out twice');

    const third = h.repos.jobs.claimNext('worker-3');
    assert.equal(third?.kind, 'cleanup');
    assert.equal(h.repos.jobs.claimNext('worker-4'), undefined, 'queue is drained');
  } finally {
    h.close();
  }
});

test('jobs scheduled in the future are not claimable yet', () => {
  const h = harness();
  try {
    h.repos.jobs.enqueue({ kind: 'retry-me', delayMs: 60_000 });
    assert.equal(h.repos.jobs.claimNext('worker-1'), undefined);
    assert.equal(h.repos.jobs.listPending().length, 1);
  } finally {
    h.close();
  }
});

test('claimNext can be restricted to specific job kinds', () => {
  const h = harness();
  try {
    h.repos.jobs.enqueue({ kind: 'metrics', priority: 1 });
    const deploy = h.repos.jobs.enqueue({ kind: 'deploy', priority: 50 });

    const claimed = h.repos.jobs.claimNext('worker-1', ['deploy']);
    assert.equal(claimed?.id, deploy.id, 'a higher-priority job of another kind is skipped');
  } finally {
    h.close();
  }
});

test('a failing job retries with backoff and eventually gives up', () => {
  const h = harness();
  try {
    const job = h.repos.jobs.enqueue({ kind: 'flaky', maxAttempts: 2 });

    const first = h.repos.jobs.claimNext('w1');
    assert.equal(first?.id, job.id);
    assert.equal(first?.attempts, 1);

    const retry = h.repos.jobs.fail(job.id, 'transient failure');
    assert.equal(retry.willRetry, true);
    assert.equal(h.repos.jobs.getById(job.id)?.status, 'queued');
    assert.equal(h.repos.jobs.getById(job.id)?.lastError, 'transient failure');
    assert.equal(h.repos.jobs.claimNext('w2'), undefined, 'backoff keeps the job ineligible immediately');

    // Force eligibility rather than waiting out the backoff.
    h.db.run("UPDATE jobs SET run_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", job.id);

    const second = h.repos.jobs.claimNext('w3');
    assert.equal(second?.attempts, 2);
    const giveUp = h.repos.jobs.fail(job.id, 'permanent failure');
    assert.equal(giveUp.willRetry, false);
    assert.equal(h.repos.jobs.getById(job.id)?.status, 'failed');
  } finally {
    h.close();
  }
});

test('orphaned running jobs are requeued after a crash', () => {
  const h = harness();
  try {
    const job = h.repos.jobs.enqueue({ kind: 'deploy' });
    h.repos.jobs.claimNext('worker-that-crashed');
    assert.equal(h.repos.jobs.getById(job.id)?.status, 'running');

    const requeued = h.repos.jobs.requeueOrphans();
    assert.equal(requeued, 1);
    assert.equal(h.repos.jobs.getById(job.id)?.status, 'queued');
    assert.equal(h.repos.jobs.claimNext('fresh-worker')?.id, job.id);
  } finally {
    h.close();
  }
});

test('deployments track lifecycle timestamps and expose the rollback target', () => {
  const h = harness();
  try {
    const { teamId } = seed(h);
    const project = h.repos.projects.create({ teamId, name: 'API' });
    const server = h.repos.servers.create({ teamId, name: 'local', mode: 'local' });
    const app = h.repos.applications.create({ projectId: project.id, serverId: server.id, name: 'Web' });

    const good = h.repos.deployments.create({ applicationId: app.id, serverId: server.id, trigger: 'manual' });
    h.repos.deployments.updateStatus(good.id, 'success', { imageTag: 'web:dep1', containerIds: ['c1', 'c2'] });
    h.repos.deployments.finish(good.id, 'success');

    const finished = h.repos.deployments.getByIdOrThrow(good.id);
    assert.equal(finished.status, 'success');
    assert.equal(finished.imageTag, 'web:dep1');
    assert.deepEqual(finished.containerIds, ['c1', 'c2']);
    assert.ok(finished.finishedAt !== null);
    assert.ok(typeof finished.durationMs === 'number' && finished.durationMs >= 0);

    const failed = h.repos.deployments.create({ applicationId: app.id, serverId: server.id, trigger: 'webhook' });
    h.repos.deployments.finish(failed.id, 'failed', 'build error');

    const target = h.repos.deployments.getLastSuccessful(app.id);
    assert.equal(target?.id, good.id, 'rollback targets the last deployment that actually worked');

    const list = h.repos.deployments.listForApplication(app.id);
    assert.equal(list.length, 2);
    assert.equal(list[0]!.id, failed.id, 'newest first');
  } finally {
    h.close();
  }
});

test('interrupted deployments are failed on startup instead of staying stuck', () => {
  const h = harness();
  try {
    const { teamId } = seed(h);
    const project = h.repos.projects.create({ teamId, name: 'API' });
    const server = h.repos.servers.create({ teamId, name: 'local', mode: 'local' });
    const app = h.repos.applications.create({ projectId: project.id, serverId: server.id, name: 'Web' });

    const building = h.repos.deployments.create({ applicationId: app.id, serverId: server.id, trigger: 'manual' });
    h.repos.deployments.updateStatus(building.id, 'building');
    const done = h.repos.deployments.create({ applicationId: app.id, serverId: server.id, trigger: 'manual' });
    h.repos.deployments.finish(done.id, 'success');

    const changed = h.repos.deployments.failStale(['queued', 'building', 'deploying', 'running'], 'Interrupted by restart');
    assert.equal(changed, 1);
    assert.equal(h.repos.deployments.getById(building.id)?.status, 'failed');
    assert.equal(h.repos.deployments.getById(done.id)?.status, 'success', 'completed deployments are untouched');
  } finally {
    h.close();
  }
});

test('service credentials are encrypted at rest and scoped to a team', () => {
  const h = harness();
  try {
    const { teamId } = seed(h);
    const project = h.repos.projects.create({ teamId, name: 'API' });
    const server = h.repos.servers.create({ teamId, name: 'local', mode: 'local' });

    const service = h.repos.services.create({
      projectId: project.id,
      serverId: server.id,
      name: 'Main DB',
      type: 'postgres',
      version: '16',
      internalPort: 5432,
      credentials: { POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'generated-password' },
    });

    const raw = h.db.get<{ credentials: string }>('SELECT credentials FROM services WHERE id = ?', service.id);
    assert.ok(!raw?.credentials.includes('generated-password'), 'database passwords must not be stored in plaintext');

    const reloaded = h.repos.services.getByIdOrThrow(service.id);
    assert.equal(reloaded.credentials.POSTGRES_PASSWORD, 'generated-password');
    assert.equal(reloaded.internalPort, 5432);

    const foreignTeam = h.repos.teams.create({ name: 'Foreign' });
    assert.equal(h.repos.services.getInTeam(foreignTeam.id, service.id), undefined);
    assert.equal(h.repos.services.getInTeam(teamId, service.id)?.service.id, service.id);
  } finally {
    h.close();
  }
});

test('audit entries record who did what, and survive as history', () => {
  const h = harness();
  try {
    const { userId, teamId } = seed(h);
    h.repos.audit.record({
      teamId,
      userId,
      action: 'application.created',
      resource: 'application',
      resourceId: 'app_1',
      ip: '203.0.113.9',
      metadata: { name: 'Web' },
    });

    const entries = h.repos.audit.listForTeam(teamId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.action, 'application.created');
    assert.equal(entries[0]!.ip, '203.0.113.9');
    assert.deepEqual(entries[0]!.metadata, { name: 'Web' });
  } finally {
    h.close();
  }
});

test('settings round-trip arbitrary JSON values', () => {
  const h = harness();
  try {
    assert.equal(h.repos.settings.has('setup_complete'), false);
    assert.equal(h.repos.settings.get('missing', 'fallback'), 'fallback');

    h.repos.settings.set('setup_complete', true);
    assert.equal(h.repos.settings.get('setup_complete', false), true);
    assert.equal(h.repos.settings.has('setup_complete'), true);

    h.repos.settings.set('setup_complete', false);
    assert.equal(h.repos.settings.get('setup_complete', true), false, 'upsert overwrites the previous value');
  } finally {
    h.close();
  }
});

test('the local server is discoverable per team', () => {
  const h = harness();
  try {
    const { teamId } = seed(h);
    assert.equal(h.repos.servers.findLocal(teamId), undefined);

    const local = h.repos.servers.create({ teamId, name: 'This server', mode: 'local', status: 'online' });
    assert.equal(h.repos.servers.findLocal(teamId)?.id, local.id);

    h.repos.servers.updateStatus(local.id, 'offline');
    assert.equal(h.repos.servers.getByIdOrThrow(local.id).status, 'offline');
  } finally {
    h.close();
  }
});

test('team deletion cascades through projects, applications and services', () => {
  const h = harness();
  try {
    const { teamId } = seed(h);
    const project = h.repos.projects.create({ teamId, name: 'API' });
    const server = h.repos.servers.create({ teamId, name: 'local', mode: 'local' });
    h.repos.applications.create({ projectId: project.id, serverId: server.id, name: 'Web' });
    h.repos.services.create({
      projectId: project.id,
      serverId: server.id,
      name: 'Cache',
      type: 'redis',
      version: '7',
      internalPort: 6379,
      credentials: {},
    });

    h.repos.teams.delete(teamId);

    assert.equal(Number(h.db.scalar('SELECT COUNT(*) FROM projects')), 0);
    assert.equal(Number(h.db.scalar('SELECT COUNT(*) FROM applications')), 0);
    assert.equal(Number(h.db.scalar('SELECT COUNT(*) FROM services')), 0);
  } finally {
    h.close();
  }
});