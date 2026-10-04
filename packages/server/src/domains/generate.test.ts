import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateToken } from '../lib/crypto.ts';
import { createContext } from '../main.ts';
import { canGenerateDomain, generateDomain, isDesktopEngine } from './generate.ts';

test('a desktop Docker engine gets .localhost addresses; a server keeps sslip.io', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-gen-'));
  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket: join(dir, 'none.sock'), logLevel: 'error' });
  const { stores } = ctx;
  try {
    const team = stores.teams.create('Ops');
    const local = stores.servers.ensureLocal('local');
    const project = stores.projects.create(team.id, 'Shop', null);
    const app = (name: string) =>
      stores.applications.create({
        projectId: project.id,
        teamId: team.id,
        serverId: local.id,
        name,
        slug: name,
        kind: 'web',
        sourceType: 'image',
        githubInstallationId: null,
        repository: null,
        gitUrl: null,
        branch: null,
        image: 'nginx:alpine',
        sealedHookToken: ctx.secrets.seal(generateToken(), 'hook'),
      });

    // A Mac with Docker Desktop behind a home router: the public IP is the router's.
    stores.servers.setPublicIp(local.id, '144.124.192.247');
    stores.servers.setDockerInfo(local.id, { version: '29.8.1', apiVersion: '1.56', os: 'Docker Desktop', arch: 'aarch64', cpus: 8, memoryBytes: 4e9 });
    assert.ok(isDesktopEngine(stores.servers.get(local.id)));
    const onMac = generateDomain(ctx, app('web'), project)!;
    assert.match(onMac.host, /^web-[a-z0-9]{6}\.localhost$/);
    assert.equal(onMac.https, false);
    await ctx.domains.check(onMac.id);
    assert.equal(stores.domains.get(onMac.id)!.dnsStatus, 'ok', 'no DNS lookup for .localhost');

    // The same code on a Linux server: sslip.io on the public IP.
    stores.servers.setDockerInfo(local.id, { version: '29.8.1', apiVersion: '1.56', os: 'Ubuntu 24.04.3 LTS', arch: 'x86_64', cpus: 4, memoryBytes: 8e9 });
    const onServer = generateDomain(ctx, app('api'), project)!;
    assert.match(onServer.host, /^api-[a-z0-9]{6}\.144-124-192-247\.sslip\.io$/);

    // An apps domain always wins.
    stores.settings.updatePlatform({ appsDomain: 'apps.example.uz' });
    assert.ok(canGenerateDomain(ctx, local.id));
    assert.equal(generateDomain(ctx, app('admin'), project)!.host, 'admin-shop.apps.example.uz');
  } finally {
    ctx.domains.stop();
    stores.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
