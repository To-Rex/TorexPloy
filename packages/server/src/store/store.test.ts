import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db/database.ts';
import { Secrets } from '../lib/secrets.ts';
import { createStores } from './index.ts';

function setup() {
  const db = openDatabase(':memory:');
  const stores = createStores(db, new Secrets('k'.repeat(48)));
  const user = stores.users.create({ email: 'Owner@Example.uz', name: 'Owner', passwordHash: null, isInstanceAdmin: true });
  const team = stores.teams.create('Acme Team');
  stores.teams.addMember(team.id, user.id, 'owner');
  const local = stores.servers.ensureLocal('localhost');
  const project = stores.projects.create(team.id, 'Web Shop', null);
  const app = stores.applications.create({
    projectId: project.id,
    teamId: team.id,
    serverId: local.id,
    name: 'API',
    slug: stores.projects.uniqueResourceSlug(project.id, 'API', 'app'),
    kind: 'web',
    sourceType: 'github',
    githubInstallationId: 42,
    repository: 'acme/api',
    gitUrl: null,
    branch: 'main',
    image: null,
    sealedHookToken: 'x',
  });
  return { db, stores, user, team, local, project, app };
}

test('migrations apply cleanly and are idempotent', () => {
  const { db } = setup();
  assert.equal(db.schemaVersion, 1);
  assert.deepEqual(db.migrate(), { applied: 0, version: 1 });
});

test('emails are case-insensitive and teams get unique slugs', () => {
  const { stores } = setup();
  assert.ok(stores.users.getByEmail('owner@example.uz'));
  const second = stores.teams.create('Acme Team');
  assert.equal(second.slug, 'acme-team-2');
});

test('only one local server can exist', () => {
  const { stores, db } = setup();
  assert.equal(stores.servers.ensureLocal('again').name, 'localhost');
  assert.throws(() => db.run("INSERT INTO servers (id, name, kind, created_at, updated_at) VALUES ('srv_x', 'x', 'local', 'n', 'n')"));
});

test('application and service slugs share one namespace per project', () => {
  const { stores, project } = setup();
  assert.equal(stores.projects.uniqueResourceSlug(project.id, 'api', 'app'), 'api-2');
});

test('config edits bump config_updated_at; cosmetic edits do not', async () => {
  const { stores, app } = setup();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const renamed = stores.applications.update(app.id, { name: 'Public API' });
  assert.equal(renamed.configUpdatedAt, app.configUpdatedAt);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const resized = stores.applications.update(app.id, { replicas: 3, autoDeploy: false });
  assert.notEqual(resized.configUpdatedAt, app.configUpdatedAt);
  assert.equal(resized.replicas, 3);
  assert.equal(resized.autoDeploy, false);
});

test('environment variables are encrypted at rest and replaced atomically', () => {
  const { stores, db, app } = setup();
  const owner = { applicationId: app.id };
  assert.equal(stores.env.replace(owner, [{ key: 'DATABASE_URL', value: 'postgres://u:secret@db/x' }, { key: 'A', value: '1' }]), true);
  const raw = db.all('SELECT value FROM env_vars');
  assert.ok(raw.every((row) => !String(row.value).includes('secret')));
  assert.deepEqual(stores.env.list(owner), [{ key: 'DATABASE_URL', value: 'postgres://u:secret@db/x' }, { key: 'A', value: '1' }]);
  assert.equal(stores.env.replace(owner, stores.env.list(owner)), false, 'an identical set is a no-op');
});

test('deployments paginate by keyset cursor and deleting an app cascades', () => {
  const { stores, app, user, db } = setup();
  for (let i = 0; i < 5; i += 1) stores.deployments.create({ application: app, trigger: 'manual', createdBy: user.id });
  const first = stores.deployments.pageForApplication(app.id, undefined, 2);
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const second = stores.deployments.pageForApplication(app.id, first.nextCursor!, 2);
  assert.equal(second.items.length, 2);
  assert.ok(second.items.every((item) => !first.items.some((other) => other.id === item.id)));
  assert.equal(first.items[0]!.createdByName, 'Owner');

  stores.applications.setActiveDeployment(app.id, first.items[0]!.id);
  stores.applications.delete(app.id);
  assert.equal(db.scalar('SELECT COUNT(*) FROM deployments'), 0);
});

test('sessions resolve by token only, never by hash, and expire', () => {
  const { stores, user, db } = setup();
  const { token, session } = stores.sessions.create(user.id, 'test', '127.0.0.1');
  assert.equal(stores.sessions.resolve(token)?.id, session.id);
  assert.equal(stores.sessions.resolve(String(db.scalar('SELECT token_hash FROM sessions'))), undefined);
  db.run("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'");
  assert.equal(stores.sessions.resolve(token), undefined);
});
