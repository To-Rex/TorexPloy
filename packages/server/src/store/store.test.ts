import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.ts';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../db/schema.ts';
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
  assert.equal(db.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.deepEqual(db.migrate(), { applied: 0, version: LATEST_SCHEMA_VERSION });
  assert.deepEqual(MIGRATIONS.map((migration) => migration.version), MIGRATIONS.map((_, index) => index + 1), 'versions are consecutive');
});

test('an installation on the first schema upgrades in place and keeps its data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-migrate-'));
  const path = join(dir, 'old.db');
  try {
    // A database exactly as release 1 left it.
    const raw = new DatabaseSync(path);
    raw.exec(MIGRATIONS[0]!.sql);
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    raw.exec(`INSERT INTO schema_migrations VALUES (1, 'initial', '2026-01-01T00:00:00.000Z')`);
    raw.exec(`INSERT INTO teams VALUES ('team_existing00001', 'Old team', 'old-team', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
    raw.close();
    const before = openDatabase(path);
    const stores = createStores(before, new Secrets('k'.repeat(48)));
    assert.equal(before.schemaVersion, LATEST_SCHEMA_VERSION);
    const team = stores.teams.get('team_existing00001');
    assert.ok(team, 'rows written before the upgrade are still there');
    const project = stores.projects.create(team.id, 'Legacy', null);
    const local = stores.servers.ensureLocal('local');
    const app = stores.applications.create({
      projectId: project.id,
      teamId: team.id,
      serverId: local.id,
      name: 'Legacy',
      slug: 'legacy',
      kind: 'web',
      sourceType: 'image',
      githubInstallationId: null,
      repository: null,
      gitUrl: null,
      branch: null,
      image: 'nginx:alpine',
      sealedHookToken: 'x',
    });
    assert.equal(app.templateId, null);
    assert.deepEqual(stores.notifications.listForTeam(team.id), []);
    before.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the compose/routing table rebuild keeps every row and every child row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-migrate4-'));
  const path = join(dir, 'v3.db');
  try {
    // A database as release 3 left it, with an app that has deployments, a domain, variables and a volume.
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const migration of MIGRATIONS.slice(0, 3)) {
      raw.exec(migration.sql);
      raw.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(migration.version, migration.name, '2026-01-01T00:00:00.000Z');
    }
    const t = '2026-01-01T00:00:00.000Z';
    raw.exec(`INSERT INTO teams VALUES ('team_a', 'A', 'a', '${t}', '${t}')`);
    raw.exec(`INSERT INTO projects VALUES ('prj_a', 'team_a', 'P', 'p', NULL, '${t}', '${t}')`);
    raw.exec(`INSERT INTO servers (id, team_id, name, kind, status, created_at, updated_at) VALUES ('srv_a', NULL, 'local', 'local', 'ready', '${t}', '${t}')`);
    raw.exec(`INSERT INTO applications (id, project_id, team_id, server_id, name, slug, source_type, image, config_updated_at, created_at, updated_at, template_id)
              VALUES ('app_a', 'prj_a', 'team_a', 'srv_a', 'Web', 'web', 'image', 'nginx:alpine', '${t}', '${t}', '${t}', 'grafana')`);
    raw.exec(`INSERT INTO deployments (id, application_id, project_id, team_id, server_id, status, trigger, created_at) VALUES ('dep_a', 'app_a', 'prj_a', 'team_a', 'srv_a', 'succeeded', 'manual', '${t}')`);
    raw.exec(`UPDATE applications SET active_deployment_id = 'dep_a', status = 'running' WHERE id = 'app_a'`);
    raw.exec(`INSERT INTO domains (id, application_id, team_id, host, created_at, updated_at) VALUES ('dom_a', 'app_a', 'team_a', 'Shop.Example.uz', '${t}', '${t}')`);
    raw.exec(`INSERT INTO env_vars (id, application_id, key, value, created_at, updated_at) VALUES ('env_a', 'app_a', 'K', 'sealed', '${t}', '${t}')`);
    raw.close();

    const db = openDatabase(path);
    assert.equal(db.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.equal(db.get('PRAGMA foreign_keys')!.foreign_keys, 1, 'foreign keys are back on');
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    const app = db.get('SELECT * FROM applications WHERE id = ?', 'app_a')!;
    assert.equal(app.active_deployment_id, 'dep_a');
    assert.equal(app.template_id, 'grafana');
    assert.equal(app.compose_path, 'docker-compose.yml');
    assert.equal(db.all('SELECT id FROM deployments').length, 1, 'no cascade wiped the deployments');
    assert.equal(db.all('SELECT id FROM env_vars').length, 1);
    const domain = db.get('SELECT * FROM domains WHERE id = ?', 'dom_a')!;
    assert.equal(domain.path, '/');
    assert.equal(domain.service_name, null);
    // The same host may now carry several path routes, but not the same path twice (host compared case-insensitively).
    db.run(`INSERT INTO domains (id, application_id, team_id, host, path, created_at, updated_at) VALUES ('dom_b', 'app_a', 'team_a', 'shop.example.uz', '/api', ?, ?)`, t, t);
    assert.throws(() => db.run(`INSERT INTO domains (id, application_id, team_id, host, path, created_at, updated_at) VALUES ('dom_c', 'app_a', 'team_a', 'SHOP.example.uz', '/api', ?, ?)`, t, t), /UNIQUE/);
    // Deleting the app still cascades after the rebuild.
    db.run('DELETE FROM applications WHERE id = ?', 'app_a');
    assert.equal(db.all('SELECT id FROM deployments').length + db.all('SELECT id FROM domains').length, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the preview migration keeps every application, and previews live and die with their parent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-migrate7-'));
  const path = join(dir, 'v6.db');
  try {
    // A database as release 6 left it, with an app that has a deployment, a domain and a variable.
    const raw = new DatabaseSync(path);
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const migration of MIGRATIONS.slice(0, 6)) {
      raw.exec(`PRAGMA foreign_keys = ${migration.rebuildsTables === true ? 'OFF' : 'ON'}`);
      raw.exec(migration.sql);
      raw.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(migration.version, migration.name, '2026-01-01T00:00:00.000Z');
    }
    raw.exec('PRAGMA foreign_keys = ON');
    const t = '2026-01-01T00:00:00.000Z';
    raw.exec(`INSERT INTO teams VALUES ('team_a', 'A', 'a', '${t}', '${t}')`);
    raw.exec(`INSERT INTO projects VALUES ('prj_a', 'team_a', 'P', 'p', NULL, '${t}', '${t}')`);
    raw.exec(`INSERT INTO servers (id, team_id, name, kind, status, created_at, updated_at) VALUES ('srv_a', NULL, 'local', 'local', 'ready', '${t}', '${t}')`);
    raw.exec(`INSERT INTO applications (id, project_id, team_id, server_id, name, slug, source_type, github_installation_id, repository, branch, config_updated_at, created_at, updated_at)
              VALUES ('app_a', 'prj_a', 'team_a', 'srv_a', 'Web', 'web', 'github', 42, 'acme/web', 'main', '${t}', '${t}', '${t}')`);
    raw.exec(`INSERT INTO deployments (id, application_id, project_id, team_id, server_id, status, trigger, created_at) VALUES ('dep_a', 'app_a', 'prj_a', 'team_a', 'srv_a', 'succeeded', 'push', '${t}')`);
    raw.exec(`UPDATE applications SET active_deployment_id = 'dep_a', status = 'running' WHERE id = 'app_a'`);
    raw.exec(`INSERT INTO domains (id, application_id, team_id, host, created_at, updated_at) VALUES ('dom_a', 'app_a', 'team_a', 'web.example.uz', '${t}', '${t}')`);
    raw.exec(`INSERT INTO env_vars (id, application_id, key, value, created_at, updated_at) VALUES ('env_a', 'app_a', 'K', 'sealed', '${t}', '${t}')`);
    raw.close();

    const db = openDatabase(path);
    assert.equal(db.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.ok(LATEST_SCHEMA_VERSION >= 7);
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    const stores = createStores(db, new Secrets('k'.repeat(48)));
    const parent = stores.applications.get('app_a')!;
    assert.deepEqual(
      [parent.activeDeploymentId, parent.status, parent.previewsEnabled, parent.previewLimit, parent.previewEnvSealed, parent.parentApplicationId, parent.previewPrNumber],
      ['dep_a', 'running', false, 3, null, null, null],
    );
    assert.equal(db.all('SELECT id FROM deployments').length + db.all('SELECT id FROM domains').length + db.all('SELECT id FROM env_vars').length, 3);

    const pullRequest = { number: 5, title: 'Add login', url: 'https://github.com/acme/web/pull/5', author: 'aziz', headSha: 'a'.repeat(40) };
    const preview = stores.applications.create({
      ...parent,
      name: 'Web-pr-5',
      slug: stores.projects.uniqueResourceSlug(parent.projectId, 'web-pr-5', 'app'),
      branch: 'login',
      sealedHookToken: 'x',
      preview: { ...pullRequest, parentApplicationId: parent.id },
    });
    assert.deepEqual([preview.parentApplicationId, preview.previewPrNumber, preview.previewPrTitle, preview.previewPrAuthor, preview.previewHeadSha], [parent.id, 5, 'Add login', 'aziz', 'a'.repeat(40)]);
    assert.deepEqual(stores.applications.listForProject('prj_a').map((app) => app.id), ['app_a'], 'previews are not project applications');
    assert.deepEqual(stores.applications.listForTeam('team_a').map((app) => app.id), ['app_a']);
    assert.equal(stores.projects.getWithStats('prj_a')!.applicationCount, 1);
    assert.deepEqual(stores.applications.listPreviews(parent.id).map((app) => app.id), [preview.id]);
    assert.equal(stores.applications.findPreview(parent.id, 5)?.id, preview.id);
    assert.deepEqual(stores.applications.previewsForPullRequest(42, 'ACME/web', 5).map((app) => app.id), [preview.id]);
    assert.throws(() => stores.applications.create({ ...preview, slug: 'web-pr-5-again', sealedHookToken: 'x', preview: { ...pullRequest, parentApplicationId: parent.id } }), /UNIQUE/, 'one preview per pull request');
    assert.throws(() => db.run('UPDATE applications SET preview_pr_number = NULL WHERE id = ?', preview.id), /CHECK/, 'a preview always names its pull request');

    stores.applications.updatePullRequest(preview.id, { ...pullRequest, title: 'Add login (v2)', headSha: 'b'.repeat(40) });
    assert.deepEqual([stores.applications.get(preview.id)!.previewPrTitle, stores.applications.get(preview.id)!.previewHeadSha], ['Add login (v2)', 'b'.repeat(40)]);
    stores.deployments.create({ application: preview, trigger: 'push', createdBy: null, commitSha: 'b'.repeat(40) });

    stores.applications.delete(parent.id);
    assert.equal(db.scalar('SELECT COUNT(*) FROM applications'), 0, 'the preview row goes with its parent');
    assert.equal(db.scalar('SELECT COUNT(*) FROM deployments'), 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the build-type rebuild maps auto to torex and keeps every application, its preview and its child rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-migrate8-'));
  const path = join(dir, 'v7.db');
  try {
    // A database as release 7 left it: an `auto` app with a deployment, a domain, a variable and a preview, and a Dockerfile app.
    const raw = new DatabaseSync(path);
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const migration of MIGRATIONS.slice(0, 7)) {
      raw.exec(`PRAGMA foreign_keys = ${migration.rebuildsTables === true ? 'OFF' : 'ON'}`);
      raw.exec(migration.sql);
      raw.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(migration.version, migration.name, '2026-01-01T00:00:00.000Z');
    }
    raw.exec('PRAGMA foreign_keys = ON');
    const t = '2026-01-01T00:00:00.000Z';
    raw.exec(`INSERT INTO teams VALUES ('team_a', 'A', 'a', '${t}', '${t}')`);
    raw.exec(`INSERT INTO projects VALUES ('prj_a', 'team_a', 'P', 'p', NULL, '${t}', '${t}')`);
    raw.exec(`INSERT INTO servers (id, team_id, name, kind, status, created_at, updated_at) VALUES ('srv_a', NULL, 'local', 'local', 'ready', '${t}', '${t}')`);
    raw.exec(`INSERT INTO applications (id, project_id, team_id, server_id, name, slug, source_type, github_installation_id, repository, branch, config_updated_at, created_at, updated_at)
              VALUES ('app_a', 'prj_a', 'team_a', 'srv_a', 'Web', 'web', 'github', 42, 'acme/web', 'main', '${t}', '${t}', '${t}')`);
    raw.exec(`INSERT INTO applications (id, project_id, team_id, server_id, name, slug, source_type, git_url, branch, build_type, dockerfile_path, config_updated_at, created_at, updated_at)
              VALUES ('app_b', 'prj_a', 'team_a', 'srv_a', 'Api', 'api', 'git', 'https://git.example.uz/api.git', 'main', 'dockerfile', 'docker/Dockerfile', '${t}', '${t}', '${t}')`);
    raw.exec(`INSERT INTO applications (id, project_id, team_id, server_id, name, slug, source_type, github_installation_id, repository, branch, parent_application_id, preview_pr_number, preview_pr_title, config_updated_at, created_at, updated_at)
              VALUES ('app_p', 'prj_a', 'team_a', 'srv_a', 'Web-pr-5', 'web-pr-5', 'github', 42, 'acme/web', 'login', 'app_a', 5, 'Add login', '${t}', '${t}', '${t}')`);
    assert.equal(raw.prepare("SELECT build_type FROM applications WHERE id = 'app_a'").get()!.build_type, 'auto');
    raw.exec(`INSERT INTO deployments (id, application_id, project_id, team_id, server_id, status, trigger, created_at) VALUES ('dep_a', 'app_a', 'prj_a', 'team_a', 'srv_a', 'succeeded', 'push', '${t}')`);
    raw.exec(`INSERT INTO deployments (id, application_id, project_id, team_id, server_id, status, trigger, created_at) VALUES ('dep_p', 'app_p', 'prj_a', 'team_a', 'srv_a', 'succeeded', 'push', '${t}')`);
    raw.exec(`UPDATE applications SET active_deployment_id = 'dep_a', status = 'running' WHERE id = 'app_a'`);
    raw.exec(`INSERT INTO domains (id, application_id, team_id, host, created_at, updated_at) VALUES ('dom_a', 'app_a', 'team_a', 'web.example.uz', '${t}', '${t}')`);
    raw.exec(`INSERT INTO env_vars (id, application_id, key, value, created_at, updated_at) VALUES ('env_a', 'app_a', 'K', 'sealed', '${t}', '${t}')`);
    raw.close();

    const db = openDatabase(path);
    assert.equal(db.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.ok(LATEST_SCHEMA_VERSION >= 8);
    assert.equal(db.get('PRAGMA foreign_keys')!.foreign_keys, 1, 'foreign keys are back on');
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    const stores = createStores(db, new Secrets('k'.repeat(48)));
    const web = stores.applications.get('app_a')!;
    assert.deepEqual([web.buildType, web.buildStage, web.buildpackBuilder, web.systemPackages, web.activeDeploymentId, web.status], ['torex', null, null, null, 'dep_a', 'running']);
    assert.deepEqual([stores.applications.get('app_b')!.buildType, stores.applications.get('app_b')!.dockerfilePath], ['dockerfile', 'docker/Dockerfile']);
    const preview = stores.applications.get('app_p')!;
    assert.deepEqual([preview.parentApplicationId, preview.previewPrNumber, preview.previewPrTitle, preview.buildType], ['app_a', 5, 'Add login', 'torex']);
    assert.equal(db.scalar('SELECT COUNT(*) FROM deployments'), 2, 'no cascade wiped the deployments');
    assert.equal(db.scalar('SELECT COUNT(*) FROM domains'), 1);
    assert.equal(db.scalar('SELECT COUNT(*) FROM env_vars'), 1);
    assert.deepEqual(stores.applications.listPreviews('app_a').map((app) => app.id), ['app_p']);
    const indexes = db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'applications' AND name LIKE 'idx_%'").map((row) => String(row.name)).sort();
    assert.deepEqual(indexes, ['idx_applications_preview', 'idx_applications_repo', 'idx_applications_server', 'idx_applications_team']);

    // The new CHECK: every builder is accepted, `auto` no longer is.
    for (const type of ['dockerfile', 'nixpacks', 'railpack', 'heroku', 'paketo', 'static', 'torex']) db.run('UPDATE applications SET build_type = ? WHERE id = ?', type, 'app_b');
    assert.throws(() => db.run("UPDATE applications SET build_type = 'auto' WHERE id = 'app_b'"), /CHECK/);
    assert.throws(() => db.run("INSERT INTO applications (id, project_id, team_id, server_id, name, slug, source_type, parent_application_id, config_updated_at, created_at, updated_at) VALUES ('app_x', 'prj_a', 'team_a', 'srv_a', 'x', 'x', 'github', 'app_a', ?, ?, ?)", t, t, t), /CHECK/, 'a preview still names its pull request');

    // New applications default to TorexBuilder; the new settings are configuration (a redeploy applies them).
    const created = stores.applications.create({ ...web, name: 'Shop', slug: 'shop', sealedHookToken: 'x' });
    assert.deepEqual([created.buildType, created.buildStage, created.buildpackBuilder, created.systemPackages], ['torex', null, null, null]);
    const tuned = stores.applications.update(created.id, { buildType: 'heroku', buildStage: 'runtime', buildpackBuilder: 'heroku/builder:22', systemPackages: 'ffmpeg imagemagick' });
    assert.deepEqual([tuned.buildType, tuned.buildStage, tuned.buildpackBuilder, tuned.systemPackages], ['heroku', 'runtime', 'heroku/builder:22', 'ffmpeg imagemagick']);
    assert.ok(tuned.configUpdatedAt >= created.configUpdatedAt);
    assert.equal(stores.applications.update(created.id, { systemPackages: null }).systemPackages, null);

    // Deleting the parent still takes the preview and every deployment with it.
    stores.applications.delete('app_a');
    assert.equal(stores.applications.get('app_p'), undefined, 'the preview row goes with its parent');
    assert.equal(db.scalar('SELECT COUNT(*) FROM deployments'), 0);
    assert.equal(db.scalar('SELECT COUNT(*) FROM domains'), 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  // Numbered per application in creation order (rows made in the same millisecond tie on created_at).
  const numbers = [...first.items, ...second.items].map((item) => item.seq);
  assert.equal(new Set(numbers).size, 4);
  assert.ok(numbers.every((number) => number >= 1 && number <= 5));
  assert.equal(stores.deployments.create({ application: app, trigger: 'manual', createdBy: user.id }).seq, 6);

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

/** A second team with its own project and application, for isolation checks. */
function otherTeam(stores: ReturnType<typeof setup>['stores'], serverId: string) {
  const team = stores.teams.create('Rival');
  const project = stores.projects.create(team.id, 'Rival Shop', null);
  const app = stores.applications.create({
    projectId: project.id,
    teamId: team.id,
    serverId,
    name: 'Rival API',
    slug: 'rival-api',
    kind: 'worker',
    sourceType: 'image',
    githubInstallationId: null,
    repository: null,
    gitUrl: null,
    branch: null,
    image: 'ghcr.io/rival/api:1',
    sealedHookToken: 'x',
  });
  return { team, project, app };
}

test('team deployments page newest first, filter by status and never cross teams', () => {
  const { stores, app, team, local, db } = setup();
  const rival = otherTeam(stores, local.id);
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const id = stores.deployments.create({ application: app, trigger: 'manual', createdBy: null }).id;
    // Distinct timestamps: rows created within one millisecond would order by id alone.
    db.run('UPDATE deployments SET created_at = ? WHERE id = ?', `2026-01-0${i + 1}T00:00:00.000Z`, id);
    ids.push(id);
  }
  stores.deployments.create({ application: rival.app, trigger: 'manual', createdBy: null });
  stores.deployments.finish(ids[0]!, 'succeeded');
  stores.deployments.finish(ids[1]!, 'failed', 'boom', 'crash');
  stores.deployments.markStarted(ids[2]!);

  const all: string[] = [];
  let cursor: string | undefined;
  do {
    const page = stores.deployments.pageForTeam(team.id, cursor, 2);
    assert.ok(page.items.length <= 2);
    all.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  assert.deepEqual(all, [...ids].reverse(), 'every deployment of the team, newest first, exactly once');

  assert.deepEqual(stores.deployments.pageForTeam(team.id, undefined, 10, ['failed']).items.map((item) => item.id), [ids[1]]);
  const active = stores.deployments.pageForTeam(team.id, undefined, 10, ['queued', 'building', 'deploying']).items.map((item) => item.id);
  assert.deepEqual(active, [ids[4], ids[3], ids[2]]);
  const firstActive = stores.deployments.pageForTeam(team.id, undefined, 1, ['queued', 'building', 'deploying']);
  assert.deepEqual(stores.deployments.pageForTeam(team.id, firstActive.nextCursor!, 10, ['queued', 'building', 'deploying']).items.map((item) => item.id), [ids[3], ids[2]], 'the cursor and the filter combine');

  assert.deepEqual(stores.deployments.pageForTeam(rival.team.id, undefined, 10).items.map((item) => item.applicationId), [rival.app.id]);
});

test('team cron jobs sort by project, application and name and never cross teams', () => {
  const { stores, app, team, local, project } = setup();
  const rival = otherTeam(stores, local.id);
  const archive = stores.projects.create(team.id, 'archive', null);
  const archiver = stores.applications.create({ ...app, projectId: archive.id, name: 'Archiver', slug: 'archiver', sealedHookToken: 'x' });
  const job = (applicationId: string, name: string) =>
    stores.cron.create({ applicationId, name, schedule: '0 * * * *', command: 'true', enabled: true, timeoutSec: 60, nextRunAt: null });
  job(app.id, 'reports');
  job(app.id, 'Cleanup');
  job(archiver.id, 'nightly');
  job(rival.app.id, 'rival job');

  const jobs = stores.cron.listForTeam(team.id);
  assert.deepEqual(jobs.map((item) => [item.projectName, item.applicationName, item.name]), [
    ['archive', 'Archiver', 'nightly'],
    ['Web Shop', 'API', 'Cleanup'],
    ['Web Shop', 'API', 'reports'],
  ]);
  assert.equal(jobs[1]!.projectId, project.id);
  assert.equal(jobs[1]!.serverName, 'localhost');
  assert.deepEqual(stores.cron.listForTeam(rival.team.id).map((item) => item.name), ['rival job']);
});

test('registry passwords are sealed at rest, one per host per team, matched to images by host', () => {
  const { stores, db, team, local } = setup();
  const rival = otherTeam(stores, local.id);
  const registry = stores.registries.create(team.id, { name: 'GitHub', serverAddress: 'ghcr.io', username: 'robot', password: 'ghp_super_secret_token' });
  assert.equal(registry.password, 'ghp_super_secret_token');
  assert.ok(!String(db.scalar('SELECT password_sealed FROM registries')).includes('super_secret'));
  assert.throws(() => stores.registries.create(team.id, { name: 'Again', serverAddress: 'ghcr.io', username: 'x', password: 'y' }), /UNIQUE/);
  stores.registries.create(rival.team.id, { name: 'Rival GitHub', serverAddress: 'ghcr.io', username: 'rival', password: 'rival-token' });

  assert.equal(stores.registries.forImage(team.id, 'ghcr.io/acme/api:1')?.id, registry.id);
  assert.equal(stores.registries.forImage(rival.team.id, 'ghcr.io/acme/api:1')?.username, 'rival', 'each team signs in with its own login');
  assert.equal(stores.registries.forImage(team.id, 'nginx:alpine'), undefined);
  assert.equal(stores.registries.getForTeam(rival.team.id, registry.id), undefined);

  const updated = stores.registries.update(registry.id, { username: 'robot2', password: undefined });
  assert.equal(updated.username, 'robot2');
  assert.equal(updated.password, 'ghp_super_secret_token', 'an omitted password is kept');

  stores.teams.delete(team.id);
  assert.equal(db.scalar('SELECT COUNT(*) FROM registries'), 1, 'deleting a team removes its registries');
});

test('the file-store migration admits the files type, moves domains onto services, and cascades store-backed destinations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-migrate9-'));
  const path = join(dir, 'v8.db');
  try {
    // A database as release 8 left it: an application with a domain, a database with a backup destination.
    const raw = new DatabaseSync(path);
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const migration of MIGRATIONS.slice(0, 8)) {
      raw.exec(`PRAGMA foreign_keys = ${migration.rebuildsTables === true ? 'OFF' : 'ON'}`);
      raw.exec(migration.sql);
      raw.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(migration.version, migration.name, '2026-01-01T00:00:00.000Z');
    }
    raw.exec('PRAGMA foreign_keys = ON');
    const t = '2026-01-01T00:00:00.000Z';
    raw.exec(`INSERT INTO teams VALUES ('team_a', 'A', 'a', '${t}', '${t}')`);
    raw.exec(`INSERT INTO projects VALUES ('prj_a', 'team_a', 'P', 'p', NULL, '${t}', '${t}')`);
    raw.exec(`INSERT INTO servers (id, team_id, name, kind, status, created_at, updated_at) VALUES ('srv_a', NULL, 'local', 'local', 'ready', '${t}', '${t}')`);
    raw.exec(`INSERT INTO applications (id, project_id, team_id, server_id, name, slug, source_type, image, config_updated_at, created_at, updated_at)
              VALUES ('app_a', 'prj_a', 'team_a', 'srv_a', 'Web', 'web', 'image', 'nginx', '${t}', '${t}', '${t}')`);
    raw.exec(`INSERT INTO domains (id, application_id, team_id, host, path, created_at, updated_at) VALUES ('dom_a', 'app_a', 'team_a', 'web.example.uz', '/', '${t}', '${t}')`);
    raw.exec(`INSERT INTO domains (id, application_id, team_id, host, path, strip_path, created_at, updated_at) VALUES ('dom_b', 'app_a', 'team_a', 'web.example.uz', '/api', 1, '${t}', '${t}')`);
    raw.exec(`INSERT INTO s3_destinations (id, team_id, name, endpoint, region, bucket, access_key_id, secret_access_key, created_at, updated_at)
              VALUES ('s3d_a', 'team_a', 'Offsite', 'https://s3.example.uz', 'auto', 'b', 'k', 'sealed', '${t}', '${t}')`);
    raw.exec(`INSERT INTO services (id, project_id, team_id, server_id, name, slug, type, version, credentials, internal_port, container_name, volume_name, backup_destination_id, created_at, updated_at)
              VALUES ('svc_a', 'prj_a', 'team_a', 'srv_a', 'db', 'db', 'postgres', '17', 'sealed', 5432, 'ploy-db-db', 'ploy-data-db', 's3d_a', '${t}', '${t}')`);
    raw.exec(`INSERT INTO service_links (id, application_id, service_id, created_at) VALUES ('lnk_a', 'app_a', 'svc_a', '${t}')`);
    raw.exec(`INSERT INTO backups (id, service_id, status, trigger, started_at) VALUES ('bak_a', 'svc_a', 'succeeded', 'manual', '${t}')`);
    assert.throws(() => raw.exec(`INSERT INTO services (id, project_id, team_id, server_id, name, slug, type, version, credentials, internal_port, container_name, volume_name, created_at, updated_at) VALUES ('svc_f', 'prj_a', 'team_a', 'srv_a', 'f', 'f', 'files', '4.48', 'x', 8333, 'c', 'v', '${t}', '${t}')`), /CHECK/, 'release 8 did not know the files type');
    raw.close();

    const db = openDatabase(path);
    assert.equal(db.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.ok(LATEST_SCHEMA_VERSION >= 9);
    assert.equal(db.get('PRAGMA foreign_keys')!.foreign_keys, 1, 'foreign keys are back on');
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    const secrets = new Secrets('k'.repeat(48));
    const stores = createStores(db, secrets);

    // Every row survived the rebuilds, with the indexes the proxy and the route lookups rely on.
    assert.deepEqual(stores.domains.listForApplication('app_a').map((domain) => [domain.host, domain.path, domain.stripPath, domain.applicationId, domain.serviceId]), [['web.example.uz', '/', false, 'app_a', null], ['web.example.uz', '/api', true, 'app_a', null]]);
    assert.deepEqual({ ...db.get('SELECT type, backup_destination_id FROM services WHERE id = ?', 'svc_a') }, { type: 'postgres', backup_destination_id: 's3d_a' });
    assert.equal(db.scalar('SELECT COUNT(*) FROM service_links'), 1);
    assert.equal(db.scalar('SELECT COUNT(*) FROM backups'), 1);
    assert.equal(db.scalar('SELECT service_id FROM s3_destinations WHERE id = ?', 's3d_a'), null);
    const indexes = (table: string) => db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name LIKE 'idx_%'", table).map((row) => String(row.name)).sort();
    assert.deepEqual(indexes('domains'), ['idx_domains_app', 'idx_domains_route', 'idx_domains_service']);
    assert.deepEqual(indexes('services'), ['idx_services_server', 'idx_services_team']);
    assert.throws(() => db.run("INSERT INTO domains (id, application_id, team_id, host, path, created_at, updated_at) VALUES ('dom_x', 'app_a', 'team_a', 'WEB.example.uz', '/', ?, ?)", t, t), /UNIQUE/, 'host and path stay unique, case-insensitively');

    // A file store, with a domain of its own, keys, bucket rows and a destination inside it.
    const store = stores.services.create({ id: 'svc_f', projectId: 'prj_a', teamId: 'team_a', serverId: 'srv_a', name: 'Files', slug: 'files', type: 'files', version: '4.48', credentials: { username: 'ployroot', password: 's'.repeat(40), database: null }, internalPort: 8333, containerName: 'ploy-db-files', volumeName: 'ploy-data-files', memoryLimitMb: 512 });
    const domain = stores.domains.create({ serviceId: store.id, teamId: 'team_a', host: 'files.example.uz', https: true, port: null, isGenerated: false });
    assert.deepEqual([domain.applicationId, domain.serviceId], [null, store.id]);
    assert.throws(() => db.run("INSERT INTO domains (id, team_id, host, path, created_at, updated_at) VALUES ('dom_y', 'team_a', 'nobody.example.uz', '/', ?, ?)", t, t), /CHECK/, 'a domain needs exactly one owner');
    assert.throws(() => db.run("INSERT INTO domains (id, application_id, service_id, team_id, host, path, created_at, updated_at) VALUES ('dom_z', 'app_a', 'svc_f', 'team_a', 'both.example.uz', '/', ?, ?)", t, t), /CHECK/);
    assert.deepEqual(stores.domains.listForServer('srv_a').map((item) => item.host), ['files.example.uz', 'web.example.uz', 'web.example.uz'], 'the proxy sees application and service domains alike');
    assert.equal(stores.domains.primaryServiceUrl(store.id), 'https://files.example.uz');

    const key = stores.storageKeys.create({ serviceId: store.id, name: 'backups', accessKeyId: 'ployabc', secretAccessKey: 'very-secret', buckets: ['backups'], permission: 'readwrite', managedBy: 'backups' });
    assert.equal(stores.storageKeys.get(key.id)!.secretAccessKey, 'very-secret');
    assert.ok(!String(db.scalar('SELECT secret_sealed FROM storage_keys WHERE id = ?', key.id)).includes('very-secret'), 'the secret is sealed at rest');
    assert.deepEqual(stores.storageKeys.backupsKey(store.id)?.buckets, ['backups']);
    assert.throws(() => stores.storageKeys.create({ serviceId: store.id, name: 'dup', accessKeyId: 'ployabc', secretAccessKey: 'x', buckets: null, permission: 'read', managedBy: 'user' }), /UNIQUE/, 'access key ids are unique');
    stores.storageBuckets.ensure(store.id, 'photos', { public: true });
    stores.storageBuckets.ensure(store.id, 'photos', { public: false });
    assert.equal(stores.storageBuckets.get(store.id, 'photos')!.public, true, 'ensure keeps an existing row');
    assert.deepEqual(stores.storageBuckets.reconcile(store.id, [{ name: 'backups', createdAt: null }, { name: 'photos', createdAt: null }]).map((bucket) => [bucket.name, bucket.public]), [['backups', false], ['photos', true]]);
    assert.deepEqual(stores.storageBuckets.reconcile(store.id, [{ name: 'photos', createdAt: null }]).map((bucket) => bucket.name), ['photos'], 'a bucket the engine no longer has is dropped');
    const destination = stores.s3.create('team_a', { name: 'Files (fayl ombori)', endpoint: 'http://files:8333', region: 'us-east-1', bucket: 'backups', pathPrefix: '', accessKeyId: 'ployabc', secretAccessKey: 'very-secret', forcePathStyle: true }, store.id);
    assert.equal(stores.s3.findForService(store.id)?.id, destination.id);
    db.run('UPDATE services SET backup_destination_id = ? WHERE id = ?', destination.id, 'svc_a');

    // Destroying the store takes its domain, keys, buckets and destination; the database merely loses its destination.
    stores.services.delete(store.id);
    assert.equal(stores.domains.get(domain.id), undefined);
    assert.equal(stores.storageKeys.get(key.id), undefined);
    assert.deepEqual(stores.storageBuckets.listForService(store.id), []);
    assert.equal(stores.s3.get(destination.id), undefined);
    assert.equal(db.scalar('SELECT backup_destination_id FROM services WHERE id = ?', 'svc_a'), null);
    assert.equal(db.scalar('SELECT name FROM s3_destinations WHERE id = ?', 's3d_a'), 'Offsite', 'ordinary destinations are untouched');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
