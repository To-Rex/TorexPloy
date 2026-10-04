/**
 * How the control plane finds a file store's S3 gateway: through its HTTPS
 * domain, by joining the project network (the panel in Docker on the local
 * server), on loopback (a developer's machine), or — on a remote server —
 * through a domain or the public port.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectNetwork } from '../docker/naming.ts';
import { AppError } from '../lib/errors.ts';
import { createContext } from '../main.ts';
import type { ServiceRecord } from '../store/index.ts';
import { internalEndpoint, publicEndpoint, resolveReach, type ReachDeps } from './reach.ts';

test('reach resolution prefers an active HTTPS domain, then the local network, loopback or the public port, else fails as store_unreachable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-reach-'));
  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket: join(dir, 'none.sock'), logLevel: 'error' });
  const { stores } = ctx;
  try {
    const team = stores.teams.create('Ops');
    const local = stores.servers.ensureLocal('local');
    const remote = stores.servers.createSsh({ teamId: team.id, name: 'vps', host: '203.0.113.9', port: 22, username: 'root', sealedPrivateKey: 'x', publicKey: 'y' });
    const project = stores.projects.create(team.id, 'Shop', null);
    const store = (serverId: string, id: string, slug: string): ServiceRecord =>
      stores.services.create({
        id,
        projectId: project.id,
        teamId: team.id,
        serverId,
        name: slug,
        slug,
        type: 'files',
        version: '4.48',
        credentials: { username: 'ployroot', password: 's'.repeat(40), database: null },
        internalPort: 8333,
        containerName: `ploy-db-${slug}`,
        volumeName: `ploy-data-${slug}`,
        memoryLimitMb: 512,
      });
    const onLocal = store(local.id, 'svc_reachlocal00001', 'media');
    const onRemote = store(remote.id, 'svc_reachremote0001', 'files');
    const connected: [string, string][] = [];
    const deps = (self: { id: string } | null): ReachDeps => ({ self: async () => self, connect: async (network, id) => void connected.push([network, id]) });
    const reason = async (promise: Promise<unknown>): Promise<string> => {
      try {
        await promise;
        return 'resolved';
      } catch (error) {
        return error instanceof AppError && error.status === 422 ? String(error.params?.reason) : 'other';
      }
    };

    assert.equal(internalEndpoint(onLocal), 'http://media:8333');
    assert.equal(publicEndpoint(ctx, onLocal), null, 'no domain, no public port: nothing to show');

    // Local server, the panel outside Docker: only a public port gives a loopback route.
    assert.equal(await reason(resolveReach(ctx, onLocal, deps(null))), 'store_unreachable');
    stores.services.update(onLocal.id, { publicPort: 18333 });
    assert.deepEqual(await resolveReach(ctx, stores.services.get(onLocal.id)!, deps(null)), { endpoint: 'http://127.0.0.1:18333', via: 'loopback' });
    assert.equal(publicEndpoint(ctx, stores.services.get(onLocal.id)!), null, 'the local server has no public address to advertise');

    // The panel in Docker joins the project network and uses the slug, whatever the public port.
    assert.deepEqual(await resolveReach(ctx, stores.services.get(onLocal.id)!, deps({ id: 'c0ffee' })), { endpoint: 'http://media:8333', via: 'network' });
    assert.deepEqual(connected, [[projectNetwork(project.id), 'c0ffee']]);

    // An HTTPS domain wins once its certificate is live; before that it is ignored.
    const domain = stores.domains.create({ serviceId: onLocal.id, teamId: team.id, host: 'files.example.uz', https: true, port: null, isGenerated: false });
    assert.equal(publicEndpoint(ctx, stores.services.get(onLocal.id)!), 'https://files.example.uz');
    assert.equal((await resolveReach(ctx, stores.services.get(onLocal.id)!, deps({ id: 'c0ffee' }))).via, 'network');
    stores.domains.setTls(domain.id, 'active', { issuer: "Let's Encrypt" });
    assert.deepEqual(await resolveReach(ctx, stores.services.get(onLocal.id)!, deps(null)), { endpoint: 'https://files.example.uz', via: 'domain' });

    // Remote server: a plain domain, else the public port on the server's public address, else nothing.
    assert.equal(await reason(resolveReach(ctx, onRemote, deps({ id: 'c0ffee' }))), 'store_unreachable');
    stores.services.update(onRemote.id, { publicPort: 8333 });
    assert.equal(await reason(resolveReach(ctx, stores.services.get(onRemote.id)!, deps(null))), 'store_unreachable', 'without a known public IP the port is useless');
    stores.servers.setPublicIp(remote.id, '203.0.113.9');
    assert.deepEqual(await resolveReach(ctx, stores.services.get(onRemote.id)!, deps(null)), { endpoint: 'http://203.0.113.9:8333', via: 'public_port' });
    assert.equal(publicEndpoint(ctx, stores.services.get(onRemote.id)!), 'http://203.0.113.9:8333');
    stores.domains.create({ serviceId: onRemote.id, teamId: team.id, host: 'cdn.example.uz', https: false, port: null, isGenerated: false });
    assert.deepEqual(await resolveReach(ctx, stores.services.get(onRemote.id)!, deps(null)), { endpoint: 'http://cdn.example.uz', via: 'domain' });
    assert.equal(publicEndpoint(ctx, stores.services.get(onRemote.id)!), 'http://cdn.example.uz', 'a domain is advertised over a bare port');
    assert.equal(connected.length, 2, 'remote servers never involve the panel container');
  } finally {
    await ctx.notifier.flush();
    stores.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
