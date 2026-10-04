import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVolumeSchema, ENV_KEY_RE, TEMPLATE_CATEGORIES } from '@ploy/shared';
import { resolveAppEnv } from '../deploy/env.ts';
import { AppError } from '../lib/errors.ts';
import { createContext } from '../main.ts';
import { catalogEntry, linkEnv } from '../services/catalog.ts';
import { TEMPLATES, templateSecret, type TemplateContext } from './catalog.ts';
import { installTemplate } from './install.ts';

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const sample: TemplateContext = {
  url: 'https://app.example.uz',
  host: 'app.example.uz',
  https: true,
  email: 'owner@example.uz',
  timezone: 'Asia/Tashkent',
  secret: templateSecret,
};

test('every template is well-formed and every ${reference} resolves', () => {
  const ids = new Set<string>();
  for (const template of TEMPLATES) {
    assert.ok(!ids.has(template.id), `duplicate id ${template.id}`);
    ids.add(template.id);
    assert.ok((TEMPLATE_CATEGORIES as readonly string[]).includes(template.category), template.id);
    assert.match(template.image, /:[A-Za-z0-9._-]+$/, `${template.id} pins a tag`);
    assert.ok(template.port >= 1 && template.port <= 65_535);
    for (const volume of template.volumes) assert.ok(createVolumeSchema.safeParse(volume).success, `${template.id} volume ${volume.mountPath}`);
    assert.equal(new Set(template.services.map((service) => service.prefix)).size, template.services.length, `${template.id} prefixes are distinct`);

    const env = template.env(sample);
    // What the link layer provides: each service's connection variables under its prefix.
    const provided = new Set(Object.keys(env));
    for (const service of template.services) {
      const entry = catalogEntry(service.type);
      if (service.version !== undefined) assert.ok(entry.versions.includes(service.version), `${template.id}: ${service.type} ${service.version} is offered`);
      for (const key of Object.keys(linkEnv(entry, entry.credentials(), 'host', entry.port, service.prefix))) provided.add(key);
    }
    for (const [key, value] of Object.entries(env)) {
      assert.match(key, ENV_KEY_RE, `${template.id}: ${key}`);
      assert.ok(!value.includes('null') && !value.includes('undefined'), `${template.id}: ${key}=${value}`);
      for (const [, name] of value.matchAll(REFERENCE)) assert.ok(provided.has(name!), `${template.id}: ${key} references unknown ${name}`);
    }
    if (template.access.kind === 'login') {
      assert.ok(env[template.access.passwordKey] !== undefined, `${template.id}: password variable exists`);
      if (typeof template.access.user !== 'string') assert.ok(env[template.access.user.key] !== undefined);
    }
    if (template.access.kind === 'key') assert.ok(env[template.access.key] !== undefined);
  }
});

test('generated secrets are alphanumeric and fresh', () => {
  const a = templateSecret(40);
  const b = templateSecret(40);
  assert.match(a, /^[A-Za-z0-9]{40}$/);
  assert.notEqual(a, b);
});

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-tpl-'));
  process.env.PLOY_RUN_DIR = join(dir, 'run');
  // No Docker socket: provisioning and the first deployment fail in the background, which is fine here.
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket: join(dir, 'none.sock'), logLevel: 'error' });
  const { stores } = ctx;
  const user = stores.users.create({ email: 'owner@example.uz', name: 'Owner', passwordHash: null, isInstanceAdmin: true });
  const team = stores.teams.create('Ops');
  stores.teams.addMember(team.id, user.id, 'owner');
  const server = stores.servers.ensureLocal('local');
  const project = stores.projects.create(team.id, 'Automation', null);
  return {
    ctx,
    user,
    server,
    project,
    close: async () => {
      // Let background provisioning (which fails fast without Docker) finish before the database closes.
      for (let i = 0; i < 200 && stores.db.all("SELECT 1 FROM services WHERE status = 'provisioning'").length > 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      ctx.domains.stop();
      await ctx.deployer.shutdown();
      await ctx.connections.closeAll();
      stores.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('installing n8n creates a linked database, a volume, variables, an address and a deployment', async () => {
  const h = await harness();
  try {
    const { stores } = h.ctx;
    stores.servers.setPublicIp(h.server.id, '203.0.113.7');
    const { application, services, deployment } = installTemplate(h.ctx, h.project, h.user, { templateId: 'n8n', serverId: h.server.id });

    assert.equal(application.templateId, 'n8n');
    assert.equal(application.sourceType, 'image');
    assert.equal(application.image, 'n8nio/n8n:stable');
    assert.equal(application.port, 5678);
    assert.equal(application.healthCheckPath, '/healthz');
    assert.equal(deployment.applicationId, application.id);

    assert.equal(services.length, 1);
    assert.equal(services[0]!.type, 'postgres');
    assert.equal(services[0]!.name, 'n8n-db');
    const links = stores.links.listForApplication(application.id);
    assert.deepEqual(links.map((link) => [link.serviceId, link.prefix]), [[services[0]!.id, 'DB_']]);
    assert.deepEqual(stores.volumes.listForApplication(application.id).map((volume) => volume.mountPath), ['/home/node/.n8n']);

    // No apps domain: the server's IP gives an sslip.io address over HTTP, and n8n is told so.
    const [domain] = stores.domains.listForApplication(application.id);
    assert.match(domain!.host, /^n8n-[a-z0-9]{6}\.203-0-113-7\.sslip\.io$/);
    const resolved = resolveAppEnv(stores, stores.applications.get(application.id)!).env;
    assert.equal(resolved.WEBHOOK_URL, `http://${domain!.host}/`);
    assert.equal(resolved.N8N_SECURE_COOKIE, 'false');
    // References resolve to the linked service at deploy time; credentials are never copied into the app.
    assert.equal(resolved.DB_POSTGRESDB_HOST, services[0]!.slug);
    assert.equal(resolved.DB_POSTGRESDB_PASSWORD, services[0]!.credentials.password);
    assert.equal(stores.env.list({ applicationId: application.id }).find((variable) => variable.key === 'DB_POSTGRESDB_PASSWORD')?.value, '${DB_PGPASSWORD}');
    assert.equal(resolved.N8N_ENCRYPTION_KEY!.length, 32);
  } finally {
    await h.close();
  }
});

test('a custom domain is used as given, over HTTPS', async () => {
  const h = await harness();
  try {
    const { application } = installTemplate(h.ctx, h.project, h.user, { templateId: 'ghost', serverId: h.server.id, name: 'Blog', domain: 'blog.example.uz' });
    const { stores } = h.ctx;
    assert.deepEqual(stores.domains.listForApplication(application.id).map((domain) => [domain.host, domain.https, domain.isGenerated]), [['blog.example.uz', true, false]]);
    const resolved = resolveAppEnv(stores, stores.applications.get(application.id)!).env;
    assert.equal(resolved.url, 'https://blog.example.uz');
    assert.equal(stores.services.listForProject(h.project.id).map((service) => service.name).join(), 'Blog-db');
  } finally {
    await h.close();
  }
});

test('a template that needs an address is refused up front when none can be made, leaving nothing behind', async () => {
  const h = await harness();
  try {
    assert.throws(
      () => installTemplate(h.ctx, h.project, h.user, { templateId: 'gitea', serverId: h.server.id }),
      (error: unknown) => error instanceof AppError && error.code === 'validation_failed' && error.issues?.[0]?.path === 'domain',
    );
    assert.equal(h.ctx.stores.applications.listForProject(h.project.id).length, 0);
    assert.equal(h.ctx.stores.services.listForProject(h.project.id).length, 0);

    // Templates that work without an address install fine on the same server.
    const { application } = installTemplate(h.ctx, h.project, h.user, { templateId: 'uptime-kuma', serverId: h.server.id });
    assert.equal(h.ctx.stores.domains.listForApplication(application.id).length, 0);
    assert.throws(() => installTemplate(h.ctx, h.project, h.user, { templateId: 'nope', serverId: h.server.id }), /Unknown template/);
  } finally {
    await h.close();
  }
});
