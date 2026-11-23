/**
 * TorexAi end to end, with a scripted model in place of a provider: what
 * runs at once and what waits for the person, that the person's role decides
 * what can be done at all, that secrets stay out of what the model reads,
 * that changes can be undone, and that a long conversation is condensed.
 * The two provider adapters are checked against the wire formats they speak.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HttpBindings } from '@hono/node-server';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_TOKEN_PREFIX, concatZip, createZip, parseAiChart, type AiActionDto, type AiChatDetailDto, type AiChatDto, type AiEvent, type AiMessageDto, type AiSettingsDto, type AiStatusDto, type ProjectDto } from '@ploy/shared';
import { uploadPath, uploadsDir } from '../deploy/uploads.ts';
import { createHttpApp } from '../http/app.ts';
import { generateToken } from '../lib/crypto.ts';
import { createContext } from '../main.ts';
import { API_CATALOG, describeSchema, EXCLUDED, matchApi, searchApi } from './catalog.ts';
import type { HostShell } from './host.ts';
import { AnthropicProvider } from './providers/anthropic.ts';
import { OpenAiProvider } from './providers/openai.ts';
import { classifyCommand, classifyHostWrite } from './risk.ts';
import { compactJson, HIDDEN, maskSecrets } from './tools.ts';
import type { ChatProvider, ChatRequest, ChatResult, PromptPart, ToolCall } from './types.ts';

const BINDINGS = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as unknown as HttpBindings;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

type Step = (request: ChatRequest) => Partial<ChatResult>;

function scripted() {
  const requests: ChatRequest[] = [];
  const steps: Step[] = [];
  /** Assertions that failed inside a step: they end the run, and must end the test too. */
  const failures: unknown[] = [];
  const provider: ChatProvider = {
    family: 'openai',
    async chat(request, onEvent) {
      requests.push(request);
      const step = steps.shift();
      if (step === undefined) throw new Error('The script has no more steps');
      let partial: Partial<ChatResult>;
      try {
        partial = step(request);
      } catch (error) {
        if (error instanceof assert.AssertionError) failures.push(error);
        throw error;
      }
      if (partial.text !== undefined && partial.text.length > 0) onEvent({ type: 'text', text: partial.text });
      return { text: '', calls: [], stop: (partial.calls ?? []).length > 0 ? 'tool' : 'end', usage: { input: 100, output: 10, cached: 0 }, model: request.model, raw: null, ...partial };
    },
    async listModels() {
      return { chat: ['test-model'], image: ['test-image'] };
    },
    async image() {
      return { mime: 'image/png', data: PNG };
    },
  };
  return { requests, steps, provider, failures };
}

let callSeq = 0;
const call = (name: string, input: Record<string, unknown>): ToolCall => ({ id: `call_${(callSeq += 1)}`, name, input });

/** The tool results the model was handed with a request, in order. */
function results(request: ChatRequest): Extract<PromptPart, { type: 'tool_result' }>[] {
  const last = [...request.messages].reverse().find((message) => message.role === 'tool');
  return (last?.parts ?? []).filter((part): part is Extract<PromptPart, { type: 'tool_result' }> => part.type === 'tool_result');
}

async function until<T>(read: () => T | undefined | null | false, what: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** Runs "host" commands on this machine: the file tools' scripts are plain sh. */
const localShell: HostShell = (_serverId, command, options) =>
  new Promise((resolve) => {
    const child = spawn('sh', ['-c', command]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (code) => resolve({ code, stdout, stderr, timedOut: false }));
    child.stdin.end(options.stdin ?? '');
  });

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-ai-'));
  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket: join(dir, 'docker.sock'), logLevel: 'error' });
  const { stores } = ctx;
  const local = stores.servers.ensureLocal('local');
  const team = stores.teams.create('Acme');
  const member = (email: string, role: 'viewer' | 'developer' | 'admin' | 'owner', isInstanceAdmin = false) => {
    const user = stores.users.create({ email, name: email.split('@')[0]!, passwordHash: null, isInstanceAdmin });
    stores.teams.addMember(team.id, user.id, role);
    return { id: user.id, token: stores.tokens.create({ userId: user.id, teamId: team.id, name: 'test', expiresAt: null, tokenPrefix: API_TOKEN_PREFIX }).token };
  };
  const users = { root: member('root@acme.uz', 'owner', true), admin: member('admin@acme.uz', 'admin'), developer: member('dev@acme.uz', 'developer'), viewer: member('viewer@acme.uz', 'viewer') };
  const app = createHttpApp(ctx);
  const script = scripted();
  ctx.ai.settings.useFactory(() => script.provider);
  ctx.ai.useHost(localShell);

  const http = async <T>(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const raw = body instanceof Buffer ? body : body === undefined ? undefined : JSON.stringify(body);
    const response = await app.request(path, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined || body instanceof Buffer ? {} : { 'content-type': 'application/json' }), ...(body instanceof Buffer ? { 'content-length': String(body.length) } : {}) }, ...(raw === undefined ? {} : { body: raw }) }, BINDINGS);
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON: a download.
    }
    return { status: response.status, body: parsed as T };
  };

  const configure = async (patch: Record<string, unknown> = {}): Promise<AiSettingsDto> => {
    const saved = await http<AiSettingsDto>(users.root.token, 'PUT', '/api/ai/settings', { providers: [{ kind: 'custom', name: 'Test', baseUrl: 'http://model.test/v1', apiKey: 'sk-test-1234', models: ['test-model'], imageModel: 'test-image' }], ...patch });
    assert.equal(saved.status, 200);
    return saved.body;
  };

  /** Start a conversation and send one message; resolves when the reply has ended. */
  const converse = async (token: string, text: string, chatId?: string, extra: Record<string, unknown> = {}) => {
    const chat = chatId ?? (await http<AiChatDto>(token, 'POST', '/api/ai/chats', {})).body.id;
    const events: AiEvent[] = [];
    const unsubscribe = ctx.ai.subscribe(chat, (event) => events.push(event));
    const sent = await http<AiMessageDto>(token, 'POST', `/api/ai/chats/${chat}/messages`, { text, ...extra });
    const done = until(() => events.find((event) => event.type === 'done'), 'the reply to end', 15_000)
      .finally(unsubscribe)
      .then((event) => {
        if (script.failures.length > 0) throw script.failures[0];
        return event;
      });
    return { chat, sent, events, done, detail: async () => (await http<AiChatDetailDto>(token, 'GET', `/api/ai/chats/${chat}`)).body };
  };

  const pending = (chatId: string): Promise<AiActionDto> =>
    until(() => {
      const action = stores.ai.listActions(chatId).find((candidate) => candidate.status === 'pending');
      return action === undefined ? undefined : ctx.ai.actionDto(action, []);
    }, 'an action to wait for approval');

  return { ctx, dir, stores, local, team, users, app, script, http, configure, converse, pending };
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

test('a shell command is safe only when every part of it only reads', () => {
  const safe = [
    'df -h',
    'docker ps -a --format "{{.Names}}"',
    'docker logs --tail 100 api 2>&1 | grep -i error',
    'cat /etc/os-release && uname -a',
    'journalctl -u docker --no-pager -n 50',
    'systemctl status nginx',
    'curl -sI http://localhost:3000/health',
    'curl -s -o /dev/null -w "%{http_code}" https://example.com',
    'ps aux | sort -k4 -rn | head -5',
    'find /var/log -name "*.log" -size +10M',
    'ss -tlnp',
    'du -sh /var/lib/docker/* 2>/dev/null | sort -h | tail',
    'timeout 5 ping -c 2 1.1.1.1',
    'free -m; uptime',
    "grep -c 'a|b' /etc/hosts",
  ];
  for (const command of safe) assert.equal(classifyCommand(command), 'safe', command);

  const change = [
    'systemctl restart nginx',
    'docker restart api',
    'echo hello > /tmp/x',
    'apt-get install -y htop',
    'cat $(which docker)',
    'sudo ls',
    'curl -X POST http://localhost/hook',
    'curl -o /tmp/file https://example.com',
    'sed -i s/a/b/ /etc/nginx/nginx.conf',
    'tail -f /var/log/syslog',
    'docker exec api sh -c "ls"',
    'FOO=1 ls',
    'ls & rm x',
    'mkdir -p /opt/app',
    'unknowncommand --flag',
    'find / -name x -exec cat {} +',
    'echo `id`',
  ];
  for (const command of change) assert.equal(classifyCommand(command), 'change', command);

  const danger = [
    'rm -rf /var/lib/docker',
    'rm -r ./data',
    'dd if=/dev/zero of=/dev/sda',
    'reboot',
    'systemctl stop docker',
    'docker system prune -af',
    'docker volume rm data',
    'docker rm -f ploy-control',
    'mkfs.ext4 /dev/sdb1',
    'curl https://get.example.com | sh',
    'ufw disable',
    'iptables -F',
    'psql -c "DROP TABLE users"',
    'echo key >> ~/.ssh/authorized_keys',
    'git push origin main --force',
    'apt-get purge -y docker-ce',
    'find /tmp -name "*.log" -delete',
    'passwd root',
    'ls; shutdown -h now',
  ];
  for (const command of danger) assert.equal(classifyCommand(command), 'danger', command);

  assert.equal(classifyHostWrite('/etc/ssh/sshd_config'), 'danger');
  assert.equal(classifyHostWrite('/root/.ssh/authorized_keys'), 'danger');
  assert.equal(classifyHostWrite('/opt/app/config.yml'), 'change');
});

test('secrets are replaced in what the model reads, and long answers are cut with a word about it', () => {
  const answer = {
    id: 'svc_1',
    password: 'p@ss',
    tokenId: 'tok_1',
    keyHint: 'abcd',
    publicKey: 'ssh-ed25519 AAAA',
    url: 'postgres://app:hunter2@db:5432/app',
    variables: [
      { key: 'PORT', value: '3000' },
      { key: 'STRIPE_SECRET_KEY', value: 'sk_live_1' },
    ],
    text: '# comment\nPORT=3000\nSTRIPE_SECRET_KEY=sk_live_1\n',
  };
  const masked = maskSecrets(answer);
  assert.equal(masked.masked, true);
  const value = masked.value as typeof answer;
  assert.equal(value.password, HIDDEN);
  assert.equal(value.tokenId, 'tok_1');
  assert.equal(value.keyHint, 'abcd');
  assert.equal(value.publicKey, 'ssh-ed25519 AAAA');
  assert.equal(value.url, `postgres://app:${HIDDEN}@db:5432/app`);
  assert.deepEqual(value.variables, [
    { key: 'PORT', value: '3000' },
    { key: 'STRIPE_SECRET_KEY', value: HIDDEN },
  ]);
  assert.equal(value.text, `# comment\nPORT=3000\nSTRIPE_SECRET_KEY=${HIDDEN}\n`);
  assert.equal(maskSecrets({ name: 'api', status: 'running' }).masked, false);

  const many = Array.from({ length: 200 }, (_item, index) => ({ id: `t${index}`, name: index === 7 ? 'n8n' : `tool ${index}`, description: 'x'.repeat(50) }));
  const found = compactJson(many, ['id', 'name'], 'n8n');
  assert.match(found, /^\[\{"id":"t7","name":"n8n"\}\]/);
  assert.match(compactJson(many, ['id'], undefined), /Showing the first 60 of 200 items/);
});

test('charts in replies are accepted only in the shapes the dashboard draws', () => {
  assert.ok(parseAiChart('{"type":"line","x":["a","b"],"series":[{"name":"CPU","data":[1,2]}]}'));
  assert.ok(parseAiChart('{"type":"pie","slices":[{"name":"images","value":3}]}'));
  assert.ok(parseAiChart('{"type":"metric","target":"app:app_1","metric":"cpu","range":"6h"}'));
  assert.equal(parseAiChart('{"type":"line","x":["a"],"series":[{"name":"CPU","data":[1,2]}]}'), null, 'a series as long as the axis');
  assert.equal(parseAiChart('{"type":"metric","target":"../etc","metric":"cpu"}'), null);
  assert.equal(parseAiChart('not json'), null);
});

test('every route of the API is either in the catalog or left out on purpose, and the catalog names only real routes', async () => {
  const h = await harness();
  const routes = new Set(h.app.routes.filter((route) => route.path.startsWith('/api/') && route.method !== 'ALL' && !route.path.includes('*')).map((route) => `${route.method} ${route.path}`));
  const listed = new Set(API_CATALOG.map((entry) => `${entry.method} ${entry.path}`));
  const unlisted = [...routes].filter((route) => !listed.has(route) && !EXCLUDED.some((rule) => rule.pattern.test(route)));
  assert.deepEqual(unlisted, [], 'a new route must be added to the catalog, or to EXCLUDED with a reason');
  assert.deepEqual([...listed].filter((entry) => !routes.has(entry)), [], 'the catalog names a route that does not exist');
  // What must never be reachable through the assistant.
  for (const forbidden of ['POST /api/ai/actions/:id/decision', 'PUT /api/ai/settings', 'POST /api/me/password', 'POST /api/auth/login', 'DELETE /api/me/sessions']) {
    assert.ok(routes.has(forbidden), `${forbidden} exists`);
    assert.ok(!listed.has(forbidden), `${forbidden} is not in the catalog`);
  }
  assert.equal(matchApi('POST', '/api/ai/actions/aia_1/decision'), null);
  assert.equal(matchApi('post', '/api/applications/app_1/deploy')?.params.id, 'app_1');
  assert.equal(searchApi('attach domain')[0]?.path, '/api/applications/:id/domains');
  const body = describeSchema(API_CATALOG.find((entry) => entry.method === 'POST' && entry.path === '/api/applications/:id/domains')!.body!);
  assert.match(body, /host: string/);
  assert.match(body, /https\?: boolean = true/);
});

// ---------------------------------------------------------------------------
// Settings and access
// ---------------------------------------------------------------------------

test('TorexAi is set up once by the instance administrator; its keys never come back, and each role sees what it may', async () => {
  const h = await harness();
  const before = await h.http<AiStatusDto>(h.users.developer.token, 'GET', '/api/ai');
  assert.equal(before.body.ready, false);
  assert.equal(before.body.reason, 'not_configured');
  assert.equal((await h.http(h.users.admin.token, 'PUT', '/api/ai/settings', {})).status, 403, 'a team admin is not the instance administrator');
  assert.equal((await h.http(h.users.developer.token, 'POST', '/api/ai/chats', {})).status, 409);

  const saved = await h.configure({ minRole: 'developer' });
  const provider = saved.providers[0]!;
  assert.equal(provider.keyHint, '1234');
  assert.ok(!JSON.stringify(saved).includes('sk-test'));
  assert.ok(!(h.stores.settings.getRaw('ai') ?? '').includes('sk-test'), 'the key is sealed at rest');
  assert.equal(saved.defaultModel, `${provider.id}:test-model`);
  assert.equal(saved.imageModel, `${provider.id}:test-image`);

  // Saving again without a key keeps it; moving the provider to another address drops it.
  const kept = await h.http<AiSettingsDto>(h.users.root.token, 'PUT', '/api/ai/settings', { providers: [{ id: provider.id, kind: 'custom', name: 'Renamed', baseUrl: 'http://model.test/v1', models: ['test-model'] }] });
  assert.equal(kept.body.providers[0]!.keyHint, '1234');
  const moved = await h.http<AiSettingsDto>(h.users.root.token, 'PUT', '/api/ai/settings', { providers: [{ id: provider.id, kind: 'custom', name: 'Renamed', baseUrl: 'http://elsewhere.test/v1', models: ['test-model'] }] });
  assert.equal(moved.body.providers[0]!.keyHint, null);

  const developer = await h.http<AiStatusDto>(h.users.developer.token, 'GET', '/api/ai');
  assert.equal(developer.body.ready, true);
  assert.equal(developer.body.canConfigure, false);
  assert.equal(developer.body.models[0]!.model, 'test-model');
  const viewer = await h.http<AiStatusDto>(h.users.viewer.token, 'GET', '/api/ai');
  assert.equal(viewer.body.reason, 'role');
  assert.equal((await h.http(h.users.viewer.token, 'POST', '/api/ai/chats', {})).status, 403);

  const test = await h.http<{ ok: boolean; models: string[]; imageModels: string[] }>(h.users.root.token, 'POST', '/api/ai/settings/test', { kind: 'custom', baseUrl: 'http://model.test/v1', apiKey: 'sk-x' });
  assert.deepEqual(test.body, { ok: true, models: ['test-model'], imageModels: ['test-image'], error: null });

  await h.http(h.users.root.token, 'PUT', '/api/ai/settings', { enabled: false });
  assert.equal((await h.http<AiStatusDto>(h.users.root.token, 'GET', '/api/ai')).body.reason, 'disabled');
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

test('reading runs at once, a change waits for the person, and what was done can be undone', async () => {
  const h = await harness();
  await h.configure();
  const { script } = h;
  script.steps.push(
    () => ({ text: 'Looking around. ', calls: [call('platform_map', {}), call('api_call', { method: 'POST', path: '/api/projects', body: { name: 'Shop' }, title: 'Create the project Shop' })] }),
    (request) => {
      const [map, created] = results(request);
      assert.match(map!.output, /team: Acme — the person's role: developer/);
      assert.match(created!.output, /"name":"Shop"/);
      assert.match(created!.output, /\(undo id: aia_/);
      return { text: 'The project Shop is ready.' };
    },
  );
  const run = await h.converse(h.users.developer.token, 'Create a project called Shop');
  assert.equal(run.sent.status, 202);

  const waiting = await h.pending(run.chat);
  assert.equal(waiting.tool, 'api_call');
  assert.equal(waiting.title, 'Create the project Shop');
  assert.equal(waiting.detail, 'POST /api/projects');
  assert.equal(waiting.risk, 'change');
  assert.match(waiting.preview ?? '', /"name": "Shop"/);
  // Nothing has happened yet, and the map (a read) already ran.
  assert.equal(h.stores.projects.listForTeam(h.team.id).length, 0);
  assert.equal(h.stores.ai.listActions(run.chat).find((action) => action.tool === 'platform_map')?.status, 'done');
  const list = await h.http<AiChatDto[]>(h.users.developer.token, 'GET', '/api/ai/chats');
  assert.equal(list.body[0]!.waiting, true);
  assert.equal(list.body[0]!.title, 'Create a project called Shop');

  // Someone else cannot answer for them.
  assert.equal((await h.http(h.users.admin.token, 'POST', `/api/ai/actions/${waiting.id}/decision`, { approve: true })).status, 404);
  assert.equal((await h.http(h.users.developer.token, 'POST', `/api/ai/actions/${waiting.id}/decision`, { approve: true })).status, 200);
  assert.equal((await run.done).type, 'done');

  const project = h.stores.projects.listForTeam(h.team.id)[0]!;
  assert.equal(project.name, 'Shop');
  const detail = await run.detail();
  assert.deepEqual(detail.messages.map((message) => message.role), ['user', 'assistant', 'assistant']);
  assert.equal(detail.messages[1]!.blocks.filter((block) => block.type === 'action').length, 2);
  assert.equal(detail.messages[2]!.blocks[0]!.type === 'text' && detail.messages[2]!.blocks[0]!.text, 'The project Shop is ready.');
  const done = detail.actions.find((action) => action.tool === 'api_call')!;
  assert.equal(done.status, 'done');
  assert.equal(done.undoable, true);
  assert.ok(run.events.some((event) => event.type === 'delta' && event.text === 'Looking around. '));
  assert.ok(run.events.some((event) => event.type === 'state' && event.state === 'waiting'));
  // The API call was made as the person, and the audit log says it came through TorexAi.
  const audit = h.stores.audit.list(h.team.id, undefined, 20).items;
  assert.equal(audit.find((entry) => entry.action === 'project.created')?.metadata.viaAi, run.chat);
  assert.ok(audit.some((entry) => entry.action === 'ai.action_approved'));

  // Undo by hand: the project goes, and the model is told with the next message.
  const undone = await h.http<AiActionDto>(h.users.developer.token, 'POST', `/api/ai/actions/${done.id}/undo`);
  assert.equal(undone.status, 409, 'deleting a project needs the admin role: the undo runs with the person\'s own role');
  assert.match(String((undone.body as unknown as { error: { message: string } }).error.message), /Could not undo/);
  h.stores.teams.setRole(h.team.id, h.users.developer.id, 'admin');
  const retried = await h.http<AiActionDto>(h.users.developer.token, 'POST', `/api/ai/actions/${done.id}/undo`);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.undoable, false);
  assert.ok(retried.body.undoneAt !== null);
  assert.equal(h.stores.projects.listForTeam(h.team.id).length, 0);
  assert.equal((await h.http(h.users.developer.token, 'POST', `/api/ai/actions/${done.id}/undo`)).status, 409);

  script.steps.push((request) => {
    const last = request.messages[request.messages.length - 1]!;
    const text = last.parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    assert.match(text, /the person undid the step "Create the project Shop"/);
    assert.match(text, /role in the team: admin/);
    return { text: 'Understood.' };
  });
  await (await h.converse(h.users.developer.token, 'ok', run.chat)).done;
});

test("the person's role is the limit: what they may not do is refused before anyone is asked", async () => {
  const h = await harness();
  await h.configure();
  const { script } = h;
  script.steps.push(
    () => ({
      calls: [
        call('api_call', { method: 'POST', path: '/api/projects', body: { name: 'Nope' } }),
        call('shell', { server: h.local.id, command: 'df -h' }),
        call('api_call', { method: 'PATCH', path: '/api/settings', body: { buildConcurrency: 2 } }),
        call('api_call', { method: 'POST', path: '/api/ai/actions/aia_x/decision', body: { approve: true } }),
        call('api_call', { method: 'POST', path: '/api/me/password', body: { password: 'x' } }),
        call('no_such_tool', {}),
      ],
    }),
    (request) => {
      const [project, shell, settings, self, password, unknown] = results(request).map((result) => result.output);
      assert.match(project!, /needs the developer role in this team; the person you are helping is a viewer/);
      assert.match(shell!, /needs the admin role/);
      assert.match(settings!, /instance administrator only/);
      assert.match(self!, /is not available to you \(its own endpoints/);
      assert.match(password!, /account security/);
      assert.match(unknown!, /There is no tool called "no_such_tool"/);
      assert.ok(results(request).every((result) => result.error));
      return { text: 'You do not have the role for that.' };
    },
  );
  const run = await h.converse(h.users.viewer.token, 'create a project and check the disk');
  await run.done;
  const detail = await run.detail();
  assert.ok(detail.actions.every((action) => action.status === 'failed'), 'nothing waited for approval and nothing ran');
  assert.equal(h.stores.projects.listForTeam(h.team.id).length, 0);

  // An admin of the team is still not the instance administrator, who alone may touch the shared host.
  script.steps.push(
    () => ({ calls: [call('shell', { server: h.local.id, command: 'df -h' })] }),
    (request) => {
      assert.match(results(request)[0]!.output, /only the instance administrator may run commands/);
      return { text: 'Not allowed.' };
    },
  );
  await (await h.converse(h.users.admin.token, 'check the disk')).done;
});

test('a declined action is not run and the model is told; dangerous ones ask even when ordinary changes do not', async () => {
  const h = await harness();
  await h.configure();
  const { script } = h;
  script.steps.push(
    () => ({ calls: [call('api_call', { method: 'POST', path: '/api/projects', body: { name: 'One' }, title: 'Create One' })] }),
    (request) => {
      assert.match(results(request)[0]!.output, /The person declined this action/);
      return { calls: [call('api_call', { method: 'POST', path: '/api/projects', body: { name: 'Two' }, title: 'Create Two' })] };
    },
    () => ({ calls: [call('api_call', { method: 'POST', path: '/api/projects', body: { name: 'Three' }, title: 'Create Three' })] }),
    (request) => {
      const created = JSON.parse(results(request)[0]!.output.split('\n(undo id')[0]!) as ProjectDto;
      return { calls: [call('api_call', { method: 'DELETE', path: `/api/projects/${created.id}`, title: 'Delete Three' })] };
    },
    (request) => {
      assert.match(results(request)[0]!.output, /"ok":true/);
      return { text: 'Done.' };
    },
  );
  const run = await h.converse(h.users.root.token, 'make some projects');
  const first = await h.pending(run.chat);
  await h.http(h.users.root.token, 'POST', `/api/ai/actions/${first.id}/decision`, { approve: false });
  const second = await until(() => h.stores.ai.listActions(run.chat).find((action) => action.status === 'pending' && action.title === 'Create Two'), 'the second request');
  // "Always allow" covers ordinary changes for the rest of the conversation…
  await h.http(h.users.root.token, 'POST', `/api/ai/actions/${second.id}/decision`, { approve: true, always: true });
  // …so Three is created without a question, but deleting it still asks.
  const removal = await until(() => h.stores.ai.listActions(run.chat).find((action) => action.status === 'pending' && action.title === 'Delete Three'), 'the deletion to ask');
  assert.equal(removal.risk, 'danger');
  assert.equal(h.stores.ai.getChat(run.chat)!.autoApprove, true);
  assert.deepEqual(h.stores.projects.listForTeam(h.team.id).map((project) => project.name).sort(), ['Three', 'Two']);
  await h.http(h.users.root.token, 'POST', `/api/ai/actions/${removal.id}/decision`, { approve: true });
  await run.done;
  const statuses = h.stores.ai.listActions(run.chat).map((action) => `${action.title}: ${action.status}`);
  assert.deepEqual(statuses, ['Create One: rejected', 'Create Two: done', 'Create Three: done', 'Delete Three: done']);
  assert.deepEqual(h.stores.projects.listForTeam(h.team.id).map((project) => project.name), ['Two']);
  assert.equal(h.stores.ai.getAction(removal.id)!.undo, null, 'a deletion cannot be undone');
});

test('stopping a reply cancels what was waiting, keeps the transcript whole, and the next message still works', async () => {
  const h = await harness();
  await h.configure();
  const { script } = h;
  script.steps.push(() => ({ text: 'I will create it. ', calls: [call('api_call', { method: 'POST', path: '/api/projects', body: { name: 'Halted' }, title: 'Create Halted' }), call('platform_map', {})] }));
  const run = await h.converse(h.users.root.token, 'create Halted');
  const waiting = await h.pending(run.chat);
  assert.equal((await h.http(h.users.root.token, 'POST', `/api/ai/chats/${run.chat}/messages`, { text: 'hello?' })).status, 409, 'one reply at a time');
  assert.deepEqual((await h.http<{ stopped: boolean }>(h.users.root.token, 'POST', `/api/ai/chats/${run.chat}/stop`)).body, { stopped: true });
  const done = await run.done;
  assert.equal(done.type === 'done' && done.reason, 'stopped');
  assert.equal(h.stores.ai.getAction(waiting.id)!.status, 'cancelled');
  assert.equal(h.stores.projects.listForTeam(h.team.id).length, 0);
  assert.equal((await h.http(h.users.root.token, 'POST', `/api/ai/actions/${waiting.id}/decision`, { approve: true })).status, 409);

  script.steps.push((request) => {
    // Both calls of the interrupted turn have an answer, so every provider accepts the transcript.
    const turn = request.messages.findIndex((message) => message.role === 'assistant' && message.parts.some((part) => part.type === 'tool_call'));
    const answers = request.messages[turn + 1]!;
    assert.equal(answers.role, 'tool');
    assert.equal(answers.parts.length, 2);
    assert.ok(answers.parts.every((part) => part.type === 'tool_result' && part.error));
    return { text: 'Still here.' };
  });
  const next = await h.converse(h.users.root.token, 'are you there?', run.chat);
  await next.done;
  assert.equal((await next.detail()).chat.running, false);
});

test('secret values stay with the person: the model gets placeholders until it asks, and asking needs a yes', async () => {
  const h = await harness();
  await h.configure();
  const project = (await h.http<ProjectDto>(h.users.root.token, 'POST', '/api/projects', { name: 'Shop' })).body;
  const application = h.stores.applications.create({ projectId: project.id, teamId: h.team.id, serverId: h.local.id, name: 'api', slug: 'api', kind: 'web', sourceType: 'image', githubInstallationId: null, repository: null, gitUrl: null, branch: null, image: 'nginx:1.27', sealedHookToken: h.ctx.secrets.seal(generateToken(), 'hook') });
  h.stores.env.replace({ applicationId: application.id }, [{ key: 'PORT', value: '3000' }, { key: 'API_TOKEN', value: 'tok-live-42' }]);
  const { script } = h;
  const path = `/api/applications/${application.id}/variables`;
  script.steps.push(
    () => ({ calls: [call('api_call', { method: 'GET', path })] }),
    (request) => {
      const output = results(request)[0]!.output;
      assert.match(output, /"key":"PORT","value":"3000"/);
      assert.ok(output.includes(HIDDEN) && !output.includes('tok-live-42'));
      // Writing the placeholder back would destroy the value: it is refused.
      return { calls: [call('api_call', { method: 'PUT', path, body: { variables: [{ key: 'PORT', value: '8080' }, { key: 'API_TOKEN', value: HIDDEN }] } })] };
    },
    (request) => {
      assert.match(results(request)[0]!.output, /contains the placeholder \[hidden\]/);
      return { calls: [call('api_call', { method: 'GET', path, reveal: true, title: 'Read the variables with their values' })] };
    },
    (request) => {
      assert.match(results(request)[0]!.output, /tok-live-42/);
      return { calls: [call('api_call', { method: 'PUT', path, body: { variables: [{ key: 'PORT', value: '8080' }, { key: 'API_TOKEN', value: 'tok-live-42' }] }, title: 'Set PORT to 8080' })] };
    },
    () => ({ text: 'PORT is 8080 now.' }),
  );
  const run = await h.converse(h.users.root.token, 'set PORT to 8080');
  const reveal = await h.pending(run.chat);
  assert.equal(reveal.title, 'Read the variables with their values');
  assert.match(reveal.preview ?? '', /secret values/);
  // What the person sees of the first, masked read is their own data, whole.
  const masked = h.stores.ai.listActions(run.chat)[0]!;
  assert.ok(masked.output!.includes(HIDDEN) && masked.display!.includes('tok-live-42'));
  assert.match(JSON.stringify((await h.http(h.users.root.token, 'GET', `/api/ai/actions/${masked.id}/output`)).body), /tok-live-42/);
  await h.http(h.users.root.token, 'POST', `/api/ai/actions/${reveal.id}/decision`, { approve: true });
  const write = await until(() => h.stores.ai.listActions(run.chat).find((action) => action.status === 'pending' && action.title === 'Set PORT to 8080'), 'the write to ask');
  await h.http(h.users.root.token, 'POST', `/api/ai/actions/${write.id}/decision`, { approve: true });
  await run.done;
  assert.deepEqual(h.stores.env.list({ applicationId: application.id }), [{ key: 'PORT', value: '8080' }, { key: 'API_TOKEN', value: 'tok-live-42' }]);
  // Undo puts the earlier set back.
  assert.equal((await h.http(h.users.root.token, 'POST', `/api/ai/actions/${write.id}/undo`)).status, 200);
  assert.deepEqual(h.stores.env.list({ applicationId: application.id }), [{ key: 'PORT', value: '3000' }, { key: 'API_TOKEN', value: 'tok-live-42' }]);
});

test('on a server: reading commands run at once, the rest ask, and an overwritten file can be put back', async () => {
  const h = await harness();
  await h.configure();
  const config = join(h.dir, 'host', 'app.conf');
  mkdirSync(join(h.dir, 'host'), { recursive: true });
  writeFileSync(config, 'workers = 2\nport = 80\n');
  const where = `server:${h.local.id}`;
  const { script } = h;
  script.steps.push(
    () => ({ calls: [call('shell', { server: h.local.id, command: `cat ${config} | grep -c workers` }), call('file_read', { where, path: config })] }),
    (request) => {
      const [count, file] = results(request).map((result) => result.output);
      assert.match(count!, /^exit code 0\n1/);
      assert.equal(file, '1\tworkers = 2\n2\tport = 80');
      return { calls: [call('file_edit', { where, path: config, old: 'workers = 2', new: 'workers = 8', title: 'Raise the worker count' })] };
    },
    (request) => {
      assert.match(results(request)[0]!.output, /Edited .*app\.conf \(1 replacement\)/);
      return { calls: [call('shell', { server: h.local.id, command: `touch ${join(h.dir, 'host', 'restarted')}`, title: 'Restart the service' }), call('file_write', { where, path: join(h.dir, 'host', 'new.txt'), content: 'hello\n', title: 'Add a note' })] };
    },
    () => ({ text: 'Done.' }),
  );
  const run = await h.converse(h.users.root.token, 'raise the workers');
  const edit = await h.pending(run.chat);
  assert.equal(edit.tool, 'file_edit');
  assert.equal(edit.preview, '- workers = 2\n+ workers = 8');
  assert.deepEqual(h.stores.ai.listActions(run.chat).slice(0, 2).map((action) => action.status), ['done', 'done'], 'the reads did not ask');
  await h.http(h.users.root.token, 'POST', `/api/ai/actions/${edit.id}/decision`, { approve: true });
  const touch = await until(() => h.stores.ai.listActions(run.chat).find((action) => action.status === 'pending' && action.tool === 'shell'), 'the command to ask');
  assert.equal(touch.risk, 'change');
  await h.http(h.users.root.token, 'POST', `/api/ai/actions/${touch.id}/decision`, { approve: true });
  const write = await until(() => h.stores.ai.listActions(run.chat).find((action) => action.status === 'pending' && action.tool === 'file_write'), 'the write to ask');
  await h.http(h.users.root.token, 'POST', `/api/ai/actions/${write.id}/decision`, { approve: true });
  await run.done;
  assert.equal(readFileSync(config, 'utf8'), 'workers = 8\nport = 80\n');
  assert.ok(existsSync(join(h.dir, 'host', 'restarted')));
  assert.equal(readFileSync(join(h.dir, 'host', 'new.txt'), 'utf8'), 'hello\n');
  const audit = h.stores.audit.list(h.team.id, undefined, 30).items.map((entry) => entry.action);
  assert.ok(audit.includes('ai.shell') && audit.includes('ai.file_written'));

  const actions = (await run.detail()).actions;
  assert.equal(actions.find((action) => action.id === touch.id)!.undoable, false, 'a command cannot be undone');
  assert.equal((await h.http(h.users.root.token, 'POST', `/api/ai/actions/${edit.id}/undo`)).status, 200);
  assert.equal(readFileSync(config, 'utf8'), 'workers = 2\nport = 80\n');
  assert.equal((await h.http(h.users.root.token, 'POST', `/api/ai/actions/${write.id}/undo`)).status, 200);
  assert.ok(!existsSync(join(h.dir, 'host', 'new.txt')), 'a file that was created is removed');
});

test("an application's source is edited in a working copy, reviewed as a diff and deployed from there", async () => {
  const h = await harness();
  await h.configure();
  const project = (await h.http<ProjectDto>(h.users.root.token, 'POST', '/api/projects', { name: 'Site' })).body;
  const application = h.stores.applications.create({ projectId: project.id, teamId: h.team.id, serverId: h.local.id, name: 'web', slug: 'web', kind: 'web', sourceType: 'upload', githubInstallationId: null, repository: null, gitUrl: null, branch: null, image: null, sealedHookToken: h.ctx.secrets.seal(generateToken(), 'hook') });
  const archive = Buffer.from(concatZip(await createZip([{ path: 'index.html', data: Buffer.from('<h1>Helo</h1>\n') }, { path: 'css/site.css', data: Buffer.from('h1 { color: red }\n') }])));
  const dataDir = h.ctx.config.dataDir;
  mkdirSync(uploadsDir(dataDir, application.id), { recursive: true });
  writeFileSync(uploadPath(dataDir, application.id, 'upl_base'), archive);
  h.stores.applications.setUpload(application.id, { id: 'upl_base', name: 'site.zip', size: archive.length, files: 2, bytes: 31, uploadedAt: new Date().toISOString() });
  const where = `code:${application.id}`;
  const { script } = h;
  let deploymentId = '';
  script.steps.push(
    () => ({ calls: [call('file_read', { where, path: 'index.html' })] }),
    (request) => {
      assert.match(results(request)[0]!.output, /not opened in this conversation yet/);
      return { calls: [call('code', { op: 'open', app: application.id })] };
    },
    (request) => {
      assert.match(results(request)[0]!.output, /Checked out: the uploaded archive site\.zip/);
      assert.match(results(request)[0]!.output, /css\/\ncss\/site\.css\nindex\.html/);
      return {
        calls: [
          call('file_search', { where, pattern: 'Helo' }),
          call('file_edit', { where, path: 'index.html', old: 'Helo', new: 'Hello' }),
          call('file_write', { where, path: '../../escape.txt', content: 'x' }),
          call('file_read', { where, path: '.git/config' }),
          call('code', { op: 'diff', app: application.id }),
        ],
      };
    },
    (request) => {
      const [search, edit, escape, git, diff] = results(request).map((result) => result.output);
      assert.equal(search, 'index.html:1:<h1>Helo</h1>');
      assert.match(edit!, /Edited index\.html/);
      assert.match(escape!, /outside the working copy/);
      assert.match(git!, /\.git directory is managed by TorexAi/);
      assert.match(diff!, /-<h1>Helo<\/h1>\n\+<h1>Hello<\/h1>/);
      return { calls: [call('code', { op: 'deploy', app: application.id, message: 'Fix the heading typo', title: 'Deploy the fixed heading' })] };
    },
    (request) => {
      const output = results(request)[0]!.output;
      deploymentId = /Deployment (dep_\w+)/.exec(output)![1]!;
      assert.match(output, /built from the working copy \(1 changed file\)/);
      return { calls: [call('wait_deployment', { id: deploymentId, timeout: 30 })] };
    },
    (request) => {
      // There is no Docker here, so the deployment cannot run; the model is told how it ended, with the end of its log.
      assert.match(results(request)[0]!.output, new RegExp(`Deployment ${deploymentId} failed`));
      assert.match(results(request)[0]!.output, /Last \d+ of \d+ lines:/);
      return { text: 'Deployed.' };
    },
  );
  const run = await h.converse(h.users.root.token, 'fix the typo on the home page');
  const deploy = await h.pending(run.chat);
  assert.equal(deploy.tool, 'code');
  assert.equal(deploy.risk, 'change');
  assert.match(deploy.preview ?? '', /index\.html \| 2 \+-/);
  // Editing the working copy asked nothing: it is private to the conversation until it is deployed.
  assert.ok(h.stores.ai.listActions(run.chat).filter((action) => action.tool === 'file_edit').every((action) => action.status === 'done' && action.risk === 'safe'));
  await h.http(h.users.root.token, 'POST', `/api/ai/actions/${deploy.id}/decision`, { approve: true });
  await run.done;
  const deployment = h.stores.deployments.get(deploymentId)!;
  assert.equal(deployment.upload?.name, 'TorexAi: Fix the heading typo');
  assert.equal(deployment.commitAuthor, 'TorexAi');
  assert.equal(h.stores.applications.get(application.id)!.upload?.id, deployment.upload?.id, 'an upload application now builds the edited archive');
  assert.ok(existsSync(uploadPath(dataDir, application.id, deployment.upload!.id)));
  assert.ok(!existsSync(join(h.dir, 'escape.txt')));

  // Deleting the conversation removes its working copy and files.
  assert.equal((await h.http(h.users.root.token, 'DELETE', `/api/ai/chats/${run.chat}`)).status, 200);
  assert.ok(!existsSync(join(dataDir, 'ai', 'workspaces', run.chat)));
  assert.equal((await h.http(h.users.root.token, 'GET', `/api/ai/chats/${run.chat}`)).status, 404);
});

test('files: what the person attaches is read by the model, what the model makes can be downloaded, pictures included', async () => {
  const h = await harness();
  await h.configure();
  const chat = (await h.http<AiChatDto>(h.users.developer.token, 'POST', '/api/ai/chats', {})).body.id;
  const attached = await h.http<{ id: string; name: string; mime: string }>(h.users.developer.token, 'POST', `/api/ai/chats/${chat}/files?name=${encodeURIComponent('../notes.txt')}`, Buffer.from('disk is full on srv-2'));
  assert.equal(attached.status, 201);
  assert.equal(attached.body.name, '.._notes.txt'.replace(/^\.+/, ''));
  const picture = await h.http<{ id: string }>(h.users.developer.token, 'POST', `/api/ai/chats/${chat}/files?name=shot.png`, PNG);
  const { script } = h;
  script.steps.push(
    (request) => {
      const parts = request.messages[0]!.parts;
      assert.ok(parts.some((part) => part.type === 'text' && part.text.includes('disk is full on srv-2')));
      assert.ok(parts.some((part) => part.type === 'image' && part.mime === 'image/png' && part.data === PNG.toString('base64')));
      return { calls: [call('create_file', { name: 'report.md', content: '# Report\nAll good.\n' }), call('generate_image', { prompt: 'a small blue square', name: 'logo' })] };
    },
    () => ({ text: 'Here they are.' }),
  );
  const run = await h.converse(h.users.developer.token, 'read these and write a report', chat, { files: [attached.body.id, picture.body.id] });
  await run.done;
  const detail = await run.detail();
  assert.deepEqual(detail.messages[0]!.blocks.map((block) => block.type), ['file', 'file', 'text']);
  const [report, image] = detail.actions.map((action) => action.files[0]!);
  assert.deepEqual([report!.name, report!.kind, image!.name, image!.kind, image!.mime], ['report.md', 'generated', 'logo.png', 'image', 'image/png']);
  const download = await h.app.request(`/api/ai/files/${report!.id}`, { headers: { authorization: `Bearer ${h.users.developer.token}` } }, BINDINGS);
  assert.equal(await download.text(), '# Report\nAll good.\n');
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''report\.md$/);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream', 'nothing but a picture is ever served as its own type');
  const shown = await h.app.request(`/api/ai/files/${image!.id}?inline=1`, { headers: { authorization: `Bearer ${h.users.developer.token}` } }, BINDINGS);
  assert.equal(shown.headers.get('content-type'), 'image/png');
  // Another member of the same team cannot read the conversation or its files.
  assert.equal((await h.http(h.users.admin.token, 'GET', `/api/ai/files/${report!.id}`)).status, 404);
  assert.equal((await h.http(h.users.admin.token, 'GET', `/api/ai/chats/${chat}`)).status, 404);
  assert.equal((await h.http(h.users.developer.token, 'POST', `/api/ai/chats/${chat}/messages`, { text: 'x', files: ['aif_nope'] })).status, 400);
});

test('a long conversation is condensed into a summary, the daily allowance is kept, and usage is counted', async () => {
  const h = await harness();
  await h.configure({ compactAt: 8_000, dailyTokenLimit: 20_000 });
  const { script } = h;
  script.steps.push(
    () => ({ calls: [call('platform_map', {})], usage: { input: 9_000, output: 100, cached: 6_000 } }),
    (request) => {
      // The next request would be over the threshold: the model is first asked for its notes, with the same tools and prompt.
      const last = request.messages[request.messages.length - 1]!;
      assert.match(last.parts[0]!.type === 'text' ? last.parts[0]!.text : '', /about to be condensed/);
      assert.ok(request.tools.length > 10);
      return { text: 'The person wants an overview of the team Acme. Nothing was changed. The map showed one server (local) and no projects yet. Next: answer them.', usage: { input: 9_200, output: 60, cached: 9_000 } };
    },
    (request) => {
      assert.equal(request.messages.length, 1, 'the summary replaced the transcript');
      assert.match(request.messages[0]!.parts[0]!.type === 'text' ? request.messages[0]!.parts[0]!.text : '', /Your notes on it:\n\nThe person wants an overview/);
      return { text: 'You have one server and no projects.', usage: { input: 700, output: 20, cached: 0 } };
    },
  );
  const run = await h.converse(h.users.developer.token, 'what do we have?');
  await run.done;
  const detail = await run.detail();
  assert.deepEqual(detail.messages.map((message) => message.role), ['user', 'assistant', 'summary', 'assistant']);
  assert.deepEqual(detail.chat.tokens, { input: 18_900, output: 180 });
  const status = (await h.http<AiStatusDto>(h.users.developer.token, 'GET', '/api/ai')).body;
  // Cached input counts as a tenth: (9000-6000)+600+100, (9200-9000)+900+60, 700+20.
  assert.deepEqual(status.usage, { today: 3_700 + 1_160 + 720, limit: 20_000 });
  const usage = (await h.http<{ days: { requests: number; input: number }[]; users: { name: string }[] }>(h.users.root.token, 'GET', '/api/ai/usage?days=7')).body;
  assert.equal(usage.days[0]!.requests, 3);
  assert.equal(usage.users[0]!.name, 'dev');
  assert.equal((await h.http(h.users.developer.token, 'GET', '/api/ai/usage')).status, 403);

  await h.http(h.users.root.token, 'PUT', '/api/ai/settings', { dailyTokenLimit: 5_000 });
  const refused = await h.http<{ error: { code: string } }>(h.users.developer.token, 'POST', `/api/ai/chats/${run.chat}/messages`, { text: 'more' });
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error.code, 'ai_limit_reached');
});

test('a provider that fails ends the reply with its own words, and the conversation can go on', async () => {
  const h = await harness();
  await h.configure();
  const { script } = h;
  script.steps.push(() => {
    throw new Error('boom');
  });
  const run = await h.converse(h.users.developer.token, 'hello');
  const done = await run.done;
  assert.equal(done.type === 'done' && done.reason, 'error');
  const detail = await run.detail();
  assert.equal(detail.messages[1]!.error?.message, 'boom');
  assert.equal(detail.chat.running, false);
  script.steps.push((request) => {
    assert.deepEqual(request.messages.map((message) => message.role), ['user', 'user'], 'an empty failed turn is left out of the request');
    return { text: 'Hello.' };
  });
  await (await h.converse(h.users.developer.token, 'hello again', run.chat)).done;
});

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

function sse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const line of lines) controller.enqueue(encoder.encode(line)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}

const baseRequest = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'm-1',
  system: 'You are a test.',
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
  tools: [{ name: 'platform_map', description: 'map', schema: { type: 'object', properties: { query: { type: 'string' } } } }],
  effort: 'auto',
  signal: new AbortController().signal,
  ...overrides,
});

test('the OpenAI-format adapter streams text, joins fragmented tool calls, reads usage and drops an option the endpoint refuses', async () => {
  const bodies: Record<string, unknown>[] = [];
  const chunk = (delta: unknown, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ model: 'm-1-0613', choices: [{ delta, ...extra }] })}\n\n`;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    assert.equal(String(url), 'https://api.example.com/v1/chat/completions');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer sk-1');
    if ('stream_options' in body) return new Response(JSON.stringify({ error: { message: 'Unknown parameter: stream_options' } }), { status: 400 });
    return sse([
      chunk({ role: 'assistant', content: 'Hel' }),
      chunk({ content: 'lo' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'platform_map', arguments: '{"que' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ry":"shop"}' } }, { index: 1, id: 'call_b', function: { name: 'api_docs', arguments: 'not json' } }] }),
      chunk({}, { finish_reason: 'tool_calls' }),
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } } })}\n\n`,
      'data: [DONE]\n\n',
    ]);
  }) as typeof fetch;
  const provider = new OpenAiProvider({ kind: 'custom', baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-1', fetch: fetcher });
  const seen: string[] = [];
  const request = baseRequest({
    effort: 'low',
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'look' }, { type: 'image', mime: 'image/png', data: 'AAAA' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'ok' }, { type: 'tool_call', id: 'call_0', name: 'platform_map', input: {} }] },
      { role: 'tool', parts: [{ type: 'tool_result', id: 'call_0', output: 'map', error: false }] },
    ],
  });
  const result = await provider.chat(request, (event) => seen.push(event.type === 'text' ? event.text : `${event.type}:${event.type === 'tool' ? event.name : ''}`));
  assert.equal(bodies.length, 2, 'asked again without the refused option');
  assert.ok(!('stream_options' in bodies[1]!));
  assert.equal(bodies[1]!.reasoning_effort, 'low');
  const wire = bodies[1]!.messages as { role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }[];
  assert.deepEqual(wire.map((message) => message.role), ['system', 'user', 'assistant', 'tool']);
  assert.deepEqual(wire[1]!.content, [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
  assert.deepEqual(wire[2]!.tool_calls, [{ id: 'call_0', type: 'function', function: { name: 'platform_map', arguments: '{}' } }]);
  assert.equal(wire[3]!.tool_call_id, 'call_0');
  assert.deepEqual(seen, ['Hel', 'lo', 'tool:platform_map', 'tool:api_docs']);
  assert.equal(result.text, 'Hello');
  assert.equal(result.stop, 'tool');
  assert.equal(result.model, 'm-1-0613');
  assert.deepEqual(result.usage, { input: 120, output: 30, cached: 100 });
  assert.deepEqual(result.calls[0], { id: 'call_a', name: 'platform_map', input: { query: 'shop' }, invalid: undefined });
  assert.equal(result.calls[1]!.invalid, 'not json', 'arguments that are not JSON are reported, not run');

  // The option stays dropped for the next request, and an outright refusal carries the provider's words.
  const again = new OpenAiProvider({ kind: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'bad', fetch: (async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 })) as typeof fetch });
  await assert.rejects(() => again.chat(baseRequest(), () => undefined), /401: Incorrect API key provided/);

  const models = new OpenAiProvider({ kind: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'k', fetch: (async () => new Response(JSON.stringify({ data: [{ id: 'gpt-old', created: 1 }, { id: 'gpt-new', created: 9 }, { id: 'text-embedding-3', created: 5 }, { id: 'gpt-image-2', created: 7 }, { id: 'whisper-1', created: 2 }] }))) as typeof fetch });
  assert.deepEqual(await models.listModels(), { chat: ['gpt-new', 'gpt-old'], image: ['gpt-image-2'] });
  const picture = new OpenAiProvider({ kind: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'k', fetch: (async (_url: unknown, init?: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { model: 'gpt-image-2', prompt: 'a square', n: 1, size: '1536x1024' });
    return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  }) as typeof fetch });
  assert.equal((await picture.image!('gpt-image-2', 'a square', 'landscape', new AbortController().signal)).mime, 'image/png');
});

test('the Claude adapter caches the stable prefix, opts into fallback and preserved thinking, replays a turn as it was written and never runs the calls of a refused reply', async () => {
  const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let stopReason = 'tool_use';
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/v1/models/')) {
      return new Response(JSON.stringify({ id: 'claude-test', type: 'model', display_name: 'Claude Test', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities: { thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } }, effort: { supported: true } } }), { headers: { 'content-type': 'application/json' } });
    }
    sent.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return sse([
      event('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 } } }),
      event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }),
      event('content_block_stop', { index: 0 }),
      event('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Checking. ' } }),
      event('content_block_stop', { index: 1 }),
      event('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'platform_map', input: {} } }),
      event('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"query":' } }),
      event('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '"shop"}' } }),
      event('content_block_stop', { index: 2 }),
      event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 42 } }),
      event('message_stop', {}),
    ]);
  }) as typeof fetch;
  const provider = new AnthropicProvider({ apiKey: 'sk-ant-test', fetch: fetcher });
  const seen: string[] = [];
  const first = await provider.chat(baseRequest({ model: 'claude-test', effort: 'high' }), (event) => seen.push(event.type === 'text' ? event.text : event.type));
  assert.deepEqual(seen, ['thinking', 'Checking. ', 'tool']);
  assert.equal(first.text, 'Checking. ');
  assert.equal(first.stop, 'tool');
  assert.deepEqual(first.calls, [{ id: 'toolu_1', name: 'platform_map', input: { query: 'shop' } }]);
  assert.deepEqual(first.usage, { input: 920, output: 42, cached: 900 });

  const request = sent[0]!;
  assert.match(request.url, /\/v1\/messages/);
  assert.ok(request.headers.get('x-api-key') === 'sk-ant-test' || request.headers.get('authorization') === 'Bearer sk-ant-test', 'the key travels in a header');
  const betas = (request.headers.get('anthropic-beta') ?? '').split(',').map((value) => value.trim());
  assert.ok(betas.includes('server-side-fallback-2026-07-01') && betas.includes('thinking-binding-controls-2026-08-01'));
  assert.equal(request.body.fallbacks, 'default');
  assert.equal(request.body.stream, true);
  assert.deepEqual(request.body.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  assert.deepEqual(request.body.output_config, { effort: 'high' });
  assert.deepEqual(request.body.system, [{ type: 'text', text: 'You are a test.', cache_control: { type: 'ephemeral' } }]);
  assert.equal((request.body.tools as { eager_input_streaming: boolean }[])[0]!.eager_input_streaming, true);
  assert.deepEqual(request.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }]);

  // The turn goes back exactly as Claude wrote it (thinking and its signature included), with the results after it.
  await provider.chat(
    baseRequest({
      model: 'claude-test',
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'Checking. ' }, { type: 'tool_call', id: 'toolu_1', name: 'platform_map', input: { query: 'shop' } }], raw: { family: 'anthropic', content: first.raw } },
        { role: 'tool', parts: [{ type: 'tool_result', id: 'toolu_1', output: 'the map', error: false }] },
      ],
    }),
    () => undefined,
  );
  const replay = sent[1]!.body.messages as { role: string; content: { type: string; signature?: string; cache_control?: unknown; tool_use_id?: string }[] }[];
  assert.deepEqual(replay.map((message) => message.role), ['user', 'assistant', 'user']);
  assert.deepEqual(replay[1]!.content.map((block) => block.type), ['thinking', 'text', 'tool_use']);
  assert.equal(replay[1]!.content[0]!.signature, 'sig-abc');
  assert.equal(replay[0]!.content[0]!.cache_control, undefined, 'the breakpoint moved to the newest message');
  assert.deepEqual(replay[2]!.content, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'the map', cache_control: { type: 'ephemeral' } }]);
  assert.equal(sent[1]!.body.output_config, undefined, 'no effort is sent unless one was chosen');

  stopReason = 'refusal';
  const refused = await provider.chat(baseRequest({ model: 'claude-test' }), () => undefined);
  assert.equal(refused.stop, 'refusal');
  assert.deepEqual(refused.calls, []);
  assert.equal(refused.raw, null, 'a turn with calls that were not run is kept as text only');
  stopReason = 'max_tokens';
  assert.equal((await provider.chat(baseRequest({ model: 'claude-test' }), () => undefined)).stop, 'length');
});
