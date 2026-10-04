import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotificationChannelSchema, notificationConfigSchema } from '@ploy/shared';
import { generateToken } from '../lib/crypto.ts';
import { createContext } from '../main.ts';
import { channelTarget, renderFor } from './notifier.ts';

const message = { title: '❌ <api>: deploy & fail', lines: ['Loyiha: Shop', '@everyone look'], detail: 'Error: health check timed out', path: '/deployments/dep_1' };

test('messages are rendered safely for each channel kind', () => {
  const telegram = renderFor('telegram', message, 'https://panel.example.uz/deployments/dep_1', 'Ochish').body;
  assert.equal(telegram.parse_mode, 'HTML');
  assert.match(String(telegram.text), /^<b>❌ &lt;api&gt;: deploy &amp; fail<\/b>\n/);
  assert.match(String(telegram.text), /<pre>Error: health check timed out<\/pre>/);
  assert.match(String(telegram.text), /<a href="https:\/\/panel\.example\.uz\/deployments\/dep_1">Ochish<\/a>$/);

  const discord = renderFor('discord', { ...message, detail: 'x'.repeat(5_000) }, null, 'Open').body;
  assert.deepEqual(discord.allowed_mentions, { parse: [] }, 'names in messages can never ping a channel');
  assert.ok(String(discord.content).length <= 1_900);

  const slack = renderFor('slack', message, 'https://p.example.uz/x', 'Open').body;
  assert.match(String(slack.text), /<https:\/\/p\.example\.uz\/x\|Open>$/);

  assert.deepEqual(renderFor('webhook', message, null, 'Open').body, { title: message.title, lines: message.lines, detail: message.detail, url: null });
});

test('channel configs are validated, and only official hook hosts are accepted', () => {
  const ok = (config: unknown) => notificationConfigSchema.safeParse(config).success;
  assert.ok(ok({ kind: 'telegram', botToken: '123456789:AAEhBP0av28o7D1YbXfr9wX8Ywb8h0mJ6Zk', chatId: '-1001234567890' }));
  assert.ok(ok({ kind: 'telegram', botToken: '123456789:AAEhBP0av28o7D1YbXfr9wX8Ywb8h0mJ6Zk', chatId: '@torex_alerts' }));
  assert.ok(!ok({ kind: 'telegram', botToken: 'not-a-token', chatId: '42' }));
  assert.ok(ok({ kind: 'discord', url: 'https://discord.com/api/webhooks/1/abc' }));
  assert.ok(!ok({ kind: 'discord', url: 'https://discord.com.evil.example/api/webhooks/1/abc' }));
  assert.ok(!ok({ kind: 'discord', url: 'http://discord.com/api/webhooks/1/abc' }));
  assert.ok(ok({ kind: 'slack', url: 'https://hooks.slack.com/services/T0/B0/xyz' }));
  assert.ok(!ok({ kind: 'slack', url: 'https://example.com/services/T0/B0/xyz' }));
  assert.ok(ok({ kind: 'webhook', url: 'http://10.0.0.5:8080/hook' }));
  assert.ok(!ok({ kind: 'webhook', url: 'ftp://example.com/hook' }));
  assert.ok(!createNotificationChannelSchema.safeParse({ name: 'x', events: [], config: { kind: 'webhook', url: 'https://example.com' } }).success, 'at least one event');
  assert.equal(channelTarget({ config: { kind: 'slack', url: 'https://hooks.slack.com/services/T0/B0/secretpart' } }), 'hooks.slack.com/…/part');
  assert.equal(channelTarget({ config: { kind: 'telegram', botToken: 'x', chatId: '-100123' } }), 'chat -100123');
});

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function harness(status = 200) {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-ntf-'));
  const received: Received[] = [];
  let reply = status;
  const hook: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.statusCode = reply;
      res.end();
    });
  });
  await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(hook.address() as { port: number }).port}/hook`;
  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket: join(dir, 'none.sock'), logLevel: 'error' });
  const team = ctx.stores.teams.create('Ops');
  return {
    ctx,
    team,
    url,
    received,
    setReply: (value: number) => {
      reply = value;
    },
    close: async () => {
      await ctx.notifier.flush();
      ctx.stores.db.close();
      hook.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a webhook channel receives signed JSON, and the result is recorded on the channel', async () => {
  const h = await harness();
  try {
    const secret = 'a-shared-secret-of-some-length';
    const channel = h.ctx.stores.notifications.create(h.team.id, { name: 'CI', locale: 'en', events: ['deployment.failed'], config: { kind: 'webhook', url: h.url, secret } });
    // The destination is sealed at rest.
    assert.ok(!String(h.ctx.stores.db.get('SELECT config FROM notification_channels')!.config).includes(secret));

    assert.equal(await h.ctx.notifier.test(channel), null);
    const [request] = h.received;
    assert.equal(request!.headers['x-ploy-event'], 'test');
    assert.equal(request!.headers['x-ploy-signature'], `sha256=${createHmac('sha256', secret).update(request!.body).digest('hex')}`);
    const payload = JSON.parse(request!.body) as { event: string; title: string };
    assert.equal(payload.event, 'test');
    assert.equal(payload.title, '🔔 TorexPloy: test message');
    assert.equal(h.ctx.stores.notifications.get(channel.id)!.lastStatus, 'ok');

    h.setReply(500);
    assert.equal(await h.ctx.notifier.test(channel), 'HTTP 500');
    const failed = h.ctx.stores.notifications.get(channel.id)!;
    assert.equal(failed.lastStatus, 'failed');
    assert.equal(failed.lastError, 'HTTP 500');
  } finally {
    await h.close();
  }
});

test('events reach only subscribed, enabled channels, in their language; crash alarms are not repeated', async () => {
  const h = await harness();
  try {
    const { stores } = h.ctx;
    stores.notifications.create(h.team.id, { name: 'Ops', locale: 'uz', events: ['application.crashed', 'deployment.failed'], config: { kind: 'webhook', url: h.url } });
    stores.notifications.create(h.team.id, { name: 'Releases', locale: 'en', events: ['deployment.succeeded'], config: { kind: 'webhook', url: h.url } });
    const muted = stores.notifications.create(h.team.id, { name: 'Muted', locale: 'en', events: ['application.crashed'], config: { kind: 'webhook', url: h.url } });
    stores.notifications.update(muted.id, { enabled: false });

    const server = stores.servers.ensureLocal('local');
    const project = stores.projects.create(h.team.id, 'Doʻkon', null);
    const app = stores.applications.create({
      projectId: project.id,
      teamId: h.team.id,
      serverId: server.id,
      name: 'api',
      slug: 'api',
      kind: 'web',
      sourceType: 'image',
      githubInstallationId: null,
      repository: null,
      gitUrl: null,
      branch: null,
      image: 'nginx:alpine',
      sealedHookToken: h.ctx.secrets.seal(generateToken(), 'hook'),
    });

    h.ctx.notifier.appCrashed(app);
    h.ctx.notifier.appCrashed(app);
    await h.ctx.notifier.flush();
    assert.equal(h.received.length, 1, 'one channel subscribed and enabled; the repeat is collapsed');
    const crash = JSON.parse(h.received[0]!.body) as { event: string; title: string; lines: string[] };
    assert.equal(crash.event, 'application.crashed');
    assert.equal(crash.title, '⚠️ api: konteyner qayta-qayta toʻxtab qolmoqda');
    assert.deepEqual(crash.lines, ['Loyiha: Doʻkon', 'Sababini ilova loglarida koʻring.']);

    const deployment = stores.deployments.create({ application: app, trigger: 'push', createdBy: null, commitSha: 'a1b2c3d4e5', commitMessage: 'Fix login\n\nlong body' });
    stores.deployments.finish(deployment.id, 'failed', 'Health check timed out after 120s', 'health_timeout');
    h.ctx.notifier.deploymentFinished(deployment.id);
    await h.ctx.notifier.flush();
    const failed = JSON.parse(h.received[1]!.body) as { title: string; lines: string[]; detail: string };
    assert.equal(failed.title, '❌ api: joylashtirish muvaffaqiyatsiz tugadi');
    assert.deepEqual(failed.lines, ['Loyiha: Doʻkon', 'a1b2c3d Fix login', 'Ilova belgilangan vaqtda javob bermadi.']);
    assert.equal(failed.detail, 'Health check timed out after 120s');
    assert.equal(h.received.length, 2, 'the English release channel did not hear about a failure');
  } finally {
    await h.close();
  }
});
