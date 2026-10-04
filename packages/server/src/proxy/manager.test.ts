/**
 * The proxy overview the dashboard shows: routes derived from the database
 * and the exact Caddy configuration, without touching Docker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateToken } from '../lib/crypto.ts';
import { createContext } from '../main.ts';

test('the proxy overview lists every route with its upstreams and the generated configuration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-proxy-'));
  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket: join(dir, 'none.sock'), logLevel: 'error' });
  const { stores } = ctx;
  try {
    const team = stores.teams.create('Ops');
    const server = stores.servers.ensureLocal('local');
    const project = stores.projects.create(team.id, 'Shop', null);
    const app = stores.applications.create({
      projectId: project.id,
      teamId: team.id,
      serverId: server.id,
      name: 'api',
      slug: 'api',
      kind: 'web',
      sourceType: 'image',
      githubInstallationId: null,
      repository: null,
      gitUrl: null,
      branch: null,
      image: 'nginx:1.27',
      sealedHookToken: ctx.secrets.seal(generateToken(), 'hook'),
    });
    stores.domains.create({ applicationId: app.id, teamId: team.id, host: 'API.dokon.uz', https: true, port: null, isGenerated: false });
    stores.domains.create({ applicationId: app.id, teamId: team.id, host: 'www.dokon.uz', https: true, port: null, isGenerated: false, redirectTo: 'https://api.dokon.uz' });

    const overview = ctx.proxy.overview(server.id);
    const route = overview.routes.find((candidate) => candidate.host === 'api.dokon.uz');
    assert.ok(route !== undefined, 'hosts are stored lowercase');
    // Never deployed: the route exists but nothing serves it yet (Caddy answers with the status page).
    assert.deepEqual(route.upstreams, []);
    assert.equal(route.label, 'api');
    const redirect = overview.routes.find((candidate) => candidate.host === 'www.dokon.uz');
    assert.equal(redirect?.redirectTo, 'https://api.dokon.uz');

    const config = JSON.parse(overview.config) as { apps: { http: { servers: Record<string, unknown> } } };
    assert.ok(config.apps.http.servers !== undefined, 'the configuration is Caddy JSON');
    assert.match(overview.config, /api\.dokon\.uz/);
    // Nothing has been pushed to a proxy in this process.
    assert.equal(overview.inSync, false);
  } finally {
    await ctx.notifier.flush();
    stores.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
