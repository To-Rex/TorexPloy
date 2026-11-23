/**
 * TorexPloy as an MCP server, end to end: both eras of the protocol on one
 * endpoint, what each reach of a connection may do, how a destructive step
 * waits for the user's yes, OAuth from registration to refresh, the command
 * line's sign-in, and what a token's reach means for the REST API.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { API_TOKEN_PREFIX, type ConnectRequestDto, type McpOverviewDto, type ProjectDto, type TokenAccess } from '@ploy/shared';
import type { HostShell } from '../ai/host.ts';
import { createHttpApp } from '../http/app.ts';
import { SESSION_COOKIE } from '../http/core.ts';
import { createContext } from '../main.ts';
import { encodeHeaderValue } from './protocol.ts';

const BINDINGS = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as unknown as HttpBindings;
const MODERN = '2026-07-28';
const ORIGIN = 'http://localhost';

/** Runs "host" commands here, slowly when asked to. */
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
  const dir = mkdtempSync(join(tmpdir(), 'ploy-mcp-'));
  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket: join(dir, 'docker.sock'), logLevel: 'error' });
  const { stores } = ctx;
  const local = stores.servers.ensureLocal('local');
  const team = stores.teams.create('Acme');
  ctx.ai.useHost(localShell);
  ctx.ai.skills.useFetcher(async () => new Response('{}', { status: 404 }));
  const member = (email: string, role: 'viewer' | 'developer' | 'admin' | 'owner', isInstanceAdmin = false) => {
    const user = stores.users.create({ email, name: email.split('@')[0]!, passwordHash: null, isInstanceAdmin });
    stores.teams.addMember(team.id, user.id, role);
    const token = (access: TokenAccess = 'full', client = 'Test client') => stores.tokens.create({ userId: user.id, teamId: team.id, name: 'test', expiresAt: null, tokenPrefix: API_TOKEN_PREFIX, access, client }).token;
    const session = stores.sessions.create(user.id, 'test', '127.0.0.1').token;
    return { id: user.id, token, cookie: `${SESSION_COOKIE}=${session}` };
  };
  const users = { root: member('root@acme.uz', 'owner', true), developer: member('dev@acme.uz', 'developer'), viewer: member('viewer@acme.uz', 'viewer') };
  const app = createHttpApp(ctx);

  const raw = async (method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<Response> =>
    app.request(`${ORIGIN}${path}`, { method, headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: init.body }) }, BINDINGS);

  /** A legacy request: no `_meta` version, the negotiated version in the header. */
  const legacy = async (token: string, method: string, params: Record<string, unknown> = {}, id: number | null = 1, version = '2025-06-18') => {
    const response = await raw('POST', '/mcp', {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(method === 'initialize' ? {} : { 'mcp-protocol-version': version }) },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }),
    });
    return { status: response.status, body: response.status === 202 ? null : ((await response.json()) as Record<string, any>), headers: response.headers };
  };

  /** A modern request: everything a 2026-07-28 client sends. */
  const modern = async (token: string, method: string, params: Record<string, unknown> = {}, options: { capabilities?: Record<string, unknown>; headers?: Record<string, string>; accept?: string } = {}) => {
    const name = method === 'tools/call' || method === 'prompts/get' ? params.name : method === 'resources/read' ? params.uri : undefined;
    const response = await raw('POST', '/mcp', {
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: options.accept ?? 'application/json, text/event-stream',
        'mcp-protocol-version': MODERN,
        'mcp-method': method,
        ...(typeof name === 'string' ? { 'mcp-name': encodeHeaderValue(name) } : {}),
        ...options.headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method,
        params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': { name: 'Test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': options.capabilities ?? {} } },
      }),
    });
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      const text = await response.text();
      const events = text.split('\n\n').filter((block) => block.includes('data:')).map((block) => JSON.parse(block.split('\n').find((line) => line.startsWith('data:'))!.slice(5)) as Record<string, any>);
      return { status: response.status, stream: true, events, body: events[events.length - 1]! };
    }
    return { status: response.status, stream: false, events: [], body: (await response.json()) as Record<string, any> };
  };

  const call = (token: string, name: string, args: Record<string, unknown>, options: { capabilities?: Record<string, unknown> } = {}) => modern(token, 'tools/call', { name, arguments: args }, options);
  const text = (result: Record<string, any>): string => (result.result?.content ?? []).map((part: { text: string }) => part.text).join('\n');

  const http = async <T>(auth: { token?: string; cookie?: string }, method: string, path: string, body?: unknown) => {
    const response = await raw(method, path, {
      headers: {
        ...(auth.token === undefined ? {} : { authorization: `Bearer ${auth.token}` }),
        ...(auth.cookie === undefined ? {} : { cookie: auth.cookie, 'x-ploy-request': '1' }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.text();
    let parsed: unknown = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      // Not JSON.
    }
    return { status: response.status, body: parsed as T, headers: response.headers };
  };

  return { ctx, stores, app, local, team, users, raw, legacy, modern, call, text, http };
}

test('without a token the endpoint says how to sign in, and the OAuth metadata describes this panel', async () => {
  const h = await harness();
  const none = await h.raw('POST', '/mcp', { headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(none.status, 401);
  assert.equal(none.headers.get('www-authenticate'), `Bearer realm="TorexPloy", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
  const bad = await h.raw('POST', '/mcp', { headers: { authorization: 'Bearer ploy_nope', 'content-type': 'application/json' }, body: '{}' });
  assert.match(bad.headers.get('www-authenticate') ?? '', /error="invalid_token"/);

  const resource = (await h.http<Record<string, unknown>>({}, 'GET', '/.well-known/oauth-protected-resource/mcp')).body;
  assert.equal(resource.resource, `${ORIGIN}/mcp`);
  assert.deepEqual(resource.authorization_servers, [ORIGIN]);
  const server = (await h.http<Record<string, unknown>>({}, 'GET', '/.well-known/oauth-authorization-server')).body;
  assert.equal(server.issuer, ORIGIN);
  assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
  assert.equal(server.client_id_metadata_document_supported, true);
  assert.equal(server.authorization_response_iss_parameter_supported, true);
  assert.equal(server.registration_endpoint, `${ORIGIN}/oauth/register`);

  // A browser page elsewhere may not use the endpoint; GET and DELETE are not offered.
  assert.equal((await h.raw('POST', '/mcp', { headers: { origin: 'https://evil.example', authorization: `Bearer ${h.users.root.token()}` }, body: '{}' })).status, 403);
  assert.equal((await h.raw('GET', '/mcp')).status, 405);
  assert.equal((await h.raw('DELETE', '/mcp')).status, 405);

  // Switched off, nothing answers; OAuth can be switched off on its own.
  h.ctx.mcp.updateSettings({ oauth: false });
  assert.equal((await h.http({}, 'GET', '/.well-known/oauth-authorization-server')).status, 404);
  const plain = await h.raw('POST', '/mcp', { headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(plain.headers.get('www-authenticate'), 'Bearer realm="TorexPloy"');
  h.ctx.mcp.updateSettings({ enabled: false });
  assert.equal((await h.legacy(h.users.root.token(), 'tools/list')).status, 503);
});

test('a legacy client opens with initialize and is served without a session; batches of 2025-03-26 work too', async () => {
  const h = await harness();
  const token = h.users.root.token();
  const init = await h.legacy(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Claude Code', version: '9' } });
  assert.equal(init.status, 200);
  assert.equal(init.body!.result.protocolVersion, '2025-06-18');
  assert.equal(init.body!.result.serverInfo.name, 'torexploy');
  assert.deepEqual(Object.keys(init.body!.result.capabilities).sort(), ['prompts', 'resources', 'tools']);
  assert.match(init.body!.result.instructions, /Start with platform_map/);
  assert.equal(init.headers.get('mcp-session-id'), null, 'no session is minted');
  // A version this server does not know is answered with its newest legacy one.
  assert.equal((await h.legacy(token, 'initialize', { protocolVersion: '2030-01-01', capabilities: {} })).body!.result.protocolVersion, '2025-11-25');
  assert.equal((await h.legacy(token, 'notifications/initialized', {}, null)).status, 202);
  assert.deepEqual((await h.legacy(token, 'ping')).body!.result, {});

  const tools = (await h.legacy(token, 'tools/list')).body!.result.tools as { name: string; annotations: Record<string, unknown>; inputSchema: { properties: Record<string, unknown> } }[];
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['platform_map', 'api_docs', 'api_get', 'api_call', 'logs', 'wait_deployment', 'shell', 'exec', 'file_read', 'file_list', 'file_search', 'file_write', 'file_edit', 'code', 'read_output', 'undo', 'skill'],
  );
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get('api_get')!.annotations.readOnlyHint, true);
  assert.equal(byName.get('api_get')!.inputSchema.properties.method, undefined, 'api_get fixes the method');
  assert.equal(byName.get('api_call')!.annotations.destructiveHint, true);
  assert.ok('confirm' in byName.get('api_call')!.inputSchema.properties);
  assert.equal((await h.legacy(token, 'tools/list')).body!.result.ttlMs, undefined, 'modern-only fields stay out of legacy answers');

  const map = await h.legacy(token, 'tools/call', { name: 'platform_map', arguments: {} });
  assert.match(map.body!.result.content[0].text, /team: Acme/);
  assert.equal(map.body!.result.isError, undefined);

  const unknown = await h.legacy(token, 'tools/call', { name: 'no_such_tool', arguments: {} });
  assert.equal(unknown.body!.error.code, -32602);
  assert.equal((await h.legacy(token, 'completion/complete')).body!.error.code, -32601);
  assert.equal((await h.legacy(token, 'tools/list', {}, 1, '1999-01-01')).status, 400);

  const prompts = (await h.legacy(token, 'prompts/list')).body!.result.prompts as { name: string; title: string }[];
  assert.ok(prompts.length >= 18);
  assert.equal(prompts.find((prompt) => prompt.name === 'intrusion-check')?.title, 'Intrusion check');
  const prompt = (await h.legacy(token, 'prompts/get', { name: 'intrusion-check', arguments: { task: 'check srv_1' } })).body!.result;
  assert.match(prompt.messages[0].content.text, /The task: check srv_1/);
  assert.match(prompt.messages[0].content.text, /# Intrusion check/);
  const resources = (await h.legacy(token, 'resources/list')).body!.result.resources as { uri: string }[];
  assert.equal(resources[0]!.uri, 'torexploy://platform');
  assert.match((await h.legacy(token, 'resources/read', { uri: 'torexploy://platform' })).body!.result.contents[0].text, /team: Acme/);
  assert.equal((await h.legacy(token, 'resources/read', { uri: 'torexploy://nothing' })).body!.error.code, -32002);
  assert.equal((await h.legacy(token, 'resources/templates/list')).body!.result.resourceTemplates.length, 3);

  // 2025-03-26 clients could batch.
  const batch = await h.raw('POST', '/mcp', {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'mcp-protocol-version': '2025-03-26' },
    body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]),
  });
  const answers = (await batch.json()) as { id: number }[];
  assert.deepEqual(answers.map((answer) => answer.id), [1, 2]);
});

test('a modern request carries its version and is checked against its headers; the server can be discovered', async () => {
  const h = await harness();
  const token = h.users.root.token();
  const discover = await h.modern(token, 'server/discover');
  assert.equal(discover.status, 200);
  assert.deepEqual(discover.body.result.supportedVersions, ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
  assert.equal(discover.body.result.resultType, 'complete');
  assert.equal(discover.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'torexploy');
  assert.equal(discover.body.result.cacheScope, 'private');

  const listed = await h.modern(token, 'tools/list');
  assert.equal(listed.body.result.resultType, 'complete');
  assert.equal(listed.body.result.ttlMs, 600_000);

  const mismatch = await h.modern(token, 'tools/list', {}, { headers: { 'mcp-method': 'prompts/list' } });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.code, -32020);
  const noName = await h.modern(token, 'tools/call', { name: 'platform_map', arguments: {} }, { headers: { 'mcp-name': 'api_docs' } });
  assert.equal(noName.body.error.code, -32020);
  const header = await h.modern(token, 'tools/list', {}, { headers: { 'mcp-protocol-version': '2025-06-18' } });
  assert.equal(header.body.error.code, -32020);
  // A name that is not plain ASCII travels base64-encoded, and is decoded before it is compared.
  assert.equal((await h.modern(token, 'prompts/get', { name: 'ünknown' })).body.error.code, -32602);

  const old = await h.raw('POST', '/mcp', {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'tools/list' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
  });
  assert.equal(old.status, 400);
  const oldBody = (await old.json()) as { error: { code: number; data: { supported: string[]; requested: string } } };
  assert.equal(oldBody.error.code, -32022);
  assert.equal(oldBody.error.data.requested, '2099-01-01');

  const missing = await h.raw('POST', '/mcp', {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } } }),
  });
  assert.equal(missing.status, 400);
  assert.equal(((await missing.json()) as { error: { code: number } }).error.code, -32602);
  const unknown = await h.modern(token, 'subscriptions/listen');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, -32601);
  assert.equal((await h.modern(token, 'ping')).status, 404, 'ping is gone in the stateless revision');
});

test('what a step may do depends on the reach of the connection, and destroying needs the user’s explicit yes', async () => {
  const h = await harness();
  const project = (await h.http<ProjectDto>({ token: h.users.root.token() }, 'POST', '/api/projects', { name: 'Shop' })).body;
  const full = h.users.developer.token('full', 'Claude Code');

  // A change runs (the client asked its user before calling) and can be undone.
  const created = await h.call(full, 'api_call', { method: 'POST', path: '/api/projects', body: { name: 'Blog' } });
  assert.match(h.text(created.body), /"name":"Blog"/);
  const undoId = /undo id: (aia_\w+)/.exec(h.text(created.body))?.[1];
  assert.ok(undoId !== undefined);

  // The developer may not delete projects at all: their role is the limit, whatever the reach or the yes.
  const denied = await h.call(full, 'api_call', { method: 'DELETE', path: `/api/projects/${project.id}`, confirm: true });
  assert.match(h.text(denied.body), /needs the admin role/);

  // Deleting waits for the user's yes: the model is told what would happen.
  const root = h.users.root.token('full', 'Cursor');
  const first = await h.call(root, 'api_call', { method: 'DELETE', path: `/api/projects/${project.id}` });
  assert.equal(first.body.result.isError, true);
  assert.match(h.text(first.body), /Not run yet: this step needs the user's explicit approval/);
  assert.match(h.text(first.body), new RegExp(`DELETE /api/projects/${project.id}`));
  assert.equal(h.stores.projects.get(project.id)?.name, 'Shop');
  const deleted = await h.call(root, 'api_call', { method: 'DELETE', path: `/api/projects/${project.id}`, confirm: true });
  assert.equal(deleted.body.result.isError, undefined, h.text(deleted.body));
  assert.equal(h.stores.projects.get(project.id), undefined);

  // A client that can show its own dialog is asked to, and a confirm written by the model does not count.
  const other = (await h.http<ProjectDto>({ token: h.users.root.token() }, 'POST', '/api/projects', { name: 'Old' })).body;
  const elicitation = { elicitation: { form: {} } };
  const asked = await h.call(root, 'api_call', { method: 'DELETE', path: `/api/projects/${other.id}`, confirm: true }, { capabilities: elicitation });
  assert.equal(asked.body.result.resultType, 'input_required');
  const request = asked.body.result.inputRequests.confirm;
  assert.equal(request.method, 'elicitation/create');
  assert.match(request.params.message, /TorexPloy asks before this step/);
  const state = asked.body.result.requestState as string;
  const retry = (answer: Record<string, unknown>, args: Record<string, unknown> = { method: 'DELETE', path: `/api/projects/${other.id}` }) =>
    h.modern(root, 'tools/call', { name: 'api_call', arguments: args, inputResponses: { confirm: answer }, requestState: state }, { capabilities: elicitation });
  // The answer is bound to the very call it was asked for.
  assert.equal((await retry({ action: 'accept', content: { confirm: true } }, { method: 'DELETE', path: '/api/projects/prj_other' })).body.result.resultType, 'input_required');
  const declined = await retry({ action: 'decline' });
  assert.match(h.text(declined.body), /The user declined this step/);
  assert.ok(h.stores.projects.get(other.id) !== undefined);
  const accepted = await retry({ action: 'accept', content: { confirm: true } });
  assert.equal(accepted.body.result.resultType, 'complete');
  assert.equal(h.stores.projects.get(other.id), undefined);

  // A read-only connection is offered only what reads, and refuses changes even when asked.
  const reader = h.users.root.token('read', 'Viewer app');
  const names = ((await h.modern(reader, 'tools/list')).body.result.tools as { name: string }[]).map((tool) => tool.name);
  assert.ok(!names.includes('api_call') && !names.includes('file_write') && !names.includes('undo'));
  assert.ok(names.includes('api_get') && names.includes('shell'));
  const read = await h.call(reader, 'api_get', { path: '/api/projects' });
  assert.match(h.text(read.body), /Blog/);
  const command = await h.call(reader, 'shell', { server: h.local.id, command: 'touch /tmp/should-not-exist' });
  assert.match(h.text(command.body), /Not run: this connection can only read/);
  assert.equal((await h.call(reader, 'api_call', { method: 'POST', path: '/api/projects', body: { name: 'X' } })).body.error.code, -32602);

  // A connection that may write refuses to destroy, with or without a yes.
  const writer = h.users.root.token('write', 'Writer app');
  const blog = h.stores.projects.listForTeam(h.team.id).find((candidate) => candidate.name === 'Blog')!;
  const refused = await h.call(writer, 'api_call', { method: 'DELETE', path: `/api/projects/${blog.id}`, confirm: true });
  assert.match(h.text(refused.body), /may change things but not delete or destroy them/);

  // Undo works over MCP, with the person's role: taking a project back means deleting it, which a developer may not.
  const notMine = await h.call(full, 'undo', { action: undoId });
  assert.match(h.text(notMine.body), /admin role/);
  const temp = await h.call(root, 'api_call', { method: 'POST', path: '/api/projects', body: { name: 'Temp' } });
  const tempUndo = /undo id: (aia_\w+)/.exec(h.text(temp.body))![1]!;
  // Undo ids are per connection: another app cannot take back this one's steps.
  assert.match(h.text((await h.call(full, 'undo', { action: tempUndo })).body), /No step/);
  const undone = await h.call(root, 'undo', { action: tempUndo });
  assert.equal(undone.body.result.isError, undefined, h.text(undone.body));
  assert.equal(h.stores.projects.listForTeam(h.team.id).some((candidate) => candidate.name === 'Temp'), false);
  const overview = (await h.http<McpOverviewDto>({ cookie: h.users.root.cookie }, 'GET', '/api/mcp')).body;
  assert.ok(overview.activity.some((step) => step.client === 'Claude Code' && step.tool === 'api_call'));
  assert.ok(overview.activity.some((step) => step.client === 'Viewer app' && step.status === 'rejected'));
  // The audit log says which app it was.
  const entry = h.stores.audit.list(h.team.id, undefined, 50).items.find((item) => item.action === 'project.created' && item.metadata.viaMcp === 'Claude Code');
  assert.ok(entry !== undefined);
  // The steps are not conversations: they never show among TorexAi's.
  assert.equal(h.stores.ai.listChats(h.users.developer.id, h.team.id, undefined).length, 0);
});

test('a call that takes a while is answered as a stream, with progress for clients that asked for it', async () => {
  const h = await harness();
  const token = h.users.root.token();
  const started = Date.now();
  const slow = await h.call(token, 'shell', { server: h.local.id, command: 'sleep 3 && echo done-sleeping' });
  assert.ok(Date.now() - started >= 2_500);
  assert.equal(slow.stream, true);
  assert.match(h.text(slow.body), /done-sleeping/);
  // Without text/event-stream in Accept the answer waits and comes as JSON.
  const plain = await h.modern(token, 'tools/call', { name: 'shell', arguments: { server: h.local.id, command: 'sleep 3 && echo plain' } }, { accept: 'application/json' });
  assert.equal(plain.stream, false);
  assert.match(h.text(plain.body), /plain/);
});

test('OAuth: an app registers, the person says yes in the dashboard, and the app trades a code for tokens it refreshes', async () => {
  const h = await harness();
  const register = await h.http<Record<string, any>>({}, 'POST', '/oauth/register', { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
  assert.equal(register.status, 201);
  const clientId = register.body.client_id as string;
  assert.equal(register.body.token_endpoint_auth_method, 'none');
  for (const bad of [['javascript:alert(1)'], ['http://evil.example/cb'], ['https://x.example/cb#frag'], []]) {
    assert.equal((await h.http({}, 'POST', '/oauth/register', { redirect_uris: bad })).status, 400, JSON.stringify(bad));
  }

  const verifier = 'v'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = (params: Record<string, string>) => h.raw('GET', `/oauth/authorize?${new URLSearchParams(params).toString()}`);
  const good = { response_type: 'code', client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: `${ORIGIN}/mcp` };
  assert.equal((await authorize({ ...good, redirect_uri: 'https://evil.example/cb' })).headers.get('location'), '/connect/invalid?reason=redirect');
  assert.equal((await authorize({ ...good, code_challenge_method: 'plain' })).headers.get('location'), '/connect/invalid?reason=pkce');
  const started = await authorize(good);
  const consent = started.headers.get('location')!;
  assert.match(consent, /^\/connect\/\w+$/);
  const requestId = consent.split('/').pop()!;

  // Only a person signed in to the dashboard sees and answers it; a token cannot.
  assert.equal((await h.http({}, 'GET', `/api/connect/${requestId}`)).status, 401);
  assert.equal((await h.http({ token: h.users.root.token() }, 'GET', `/api/connect/${requestId}`)).status, 403);
  const described = (await h.http<ConnectRequestDto>({ cookie: h.users.developer.cookie }, 'GET', `/api/connect/${requestId}`)).body;
  assert.equal(described.client.name, 'Claude');
  assert.equal(described.redirectHost, 'claude.ai');
  assert.deepEqual(described.teams.map((team) => team.name), ['Acme']);
  // A viewer cannot connect apps.
  assert.equal((await h.http({ cookie: h.users.viewer.cookie }, 'POST', `/api/connect/${requestId}/approve`, { teamId: h.team.id, access: 'read' })).status, 403);
  const approved = await h.http<{ redirect: string }>({ cookie: h.users.developer.cookie }, 'POST', `/api/connect/${requestId}/approve`, { teamId: h.team.id, access: 'write' });
  assert.equal(approved.status, 200);
  const back = new URL(approved.body.redirect);
  assert.equal(back.origin + back.pathname, 'https://claude.ai/api/mcp/auth_callback');
  assert.equal(back.searchParams.get('state'), 'xyz');
  assert.equal(back.searchParams.get('iss'), ORIGIN);
  const code = back.searchParams.get('code')!;

  const token = (form: Record<string, string>) =>
    h.raw('POST', '/oauth/token', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() }).then(async (response) => ({ status: response.status, body: (await response.json()) as Record<string, any> }));
  const wrong = await token({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: good.redirect_uri, code_verifier: 'w'.repeat(64) });
  assert.equal(wrong.body.error, 'invalid_grant');
  // A failed attempt used the code up, and a wrong verifier revoked the grant: the person has to say yes again.
  assert.equal((await token({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: good.redirect_uri, code_verifier: verifier })).body.error, 'invalid_grant');

  const second = (await authorize(good)).headers.get('location')!.split('/').pop()!;
  const code2 = new URL((await h.http<{ redirect: string }>({ cookie: h.users.developer.cookie }, 'POST', `/api/connect/${second}/approve`, { teamId: h.team.id, access: 'write' })).body.redirect).searchParams.get('code')!;
  const issued = await token({ grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: good.redirect_uri, code_verifier: verifier, resource: `${ORIGIN}/mcp` });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.equal(issued.body.token_type, 'Bearer');
  assert.equal(issued.body.expires_in, 3600);
  const access = issued.body.access_token as string;

  // The token is for the MCP endpoint only, and acts with the reach the person chose.
  const init = await h.legacy(access, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal(init.status, 200);
  assert.equal((await h.http({ token: access }, 'GET', '/api/projects')).status, 401);
  const names = ((await h.legacy(access, 'tools/list')).body!.result.tools as { name: string }[]).map((tool) => tool.name);
  assert.ok(names.includes('api_call'));
  const made = await h.legacy(access, 'tools/call', { name: 'api_call', arguments: { method: 'POST', path: '/api/projects', body: { name: 'Via Claude' } } });
  assert.match(made.body!.result.content[0].text, /Via Claude/);

  // Refreshing replaces the refresh token; the old one stops working at once.
  const refreshed = await token({ grant_type: 'refresh_token', refresh_token: issued.body.refresh_token, client_id: clientId });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.body.refresh_token, issued.body.refresh_token);
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: issued.body.refresh_token, client_id: clientId })).body.error, 'invalid_grant');
  assert.equal((await h.legacy(refreshed.body.access_token, 'tools/list')).status, 200);

  // The person sees the connection and removes it; its tokens stop working.
  const overview = (await h.http<McpOverviewDto>({ cookie: h.users.developer.cookie }, 'GET', '/api/mcp')).body;
  const connection = overview.connections.find((entry) => entry.kind === 'oauth')!;
  assert.equal(connection.name, 'Claude');
  assert.equal(connection.redirectHost, 'claude.ai');
  assert.equal(connection.access, 'write');
  assert.ok(overview.activity.some((step) => step.client === 'Claude'));
  assert.equal((await h.http({ cookie: h.users.developer.cookie }, 'DELETE', `/api/mcp/connections/${connection.id}`)).status, 200);
  assert.equal((await h.legacy(refreshed.body.access_token, 'tools/list')).status, 401);
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: refreshed.body.refresh_token, client_id: clientId })).body.error, 'invalid_grant');

  // Saying no sends the app an error, at the address it registered.
  const third = (await authorize(good)).headers.get('location')!.split('/').pop()!;
  const denied = await h.http<{ redirect: string }>({ cookie: h.users.developer.cookie }, 'POST', `/api/connect/${third}/deny`);
  assert.equal(new URL(denied.body.redirect).searchParams.get('error'), 'access_denied');
});

test('OAuth: an app known by the address of its own description is fetched only from public addresses', async () => {
  const h = await harness();
  const documentUrl = 'https://app.example.com/oauth/client.json';
  const fetched: string[] = [];
  h.ctx.mcp.oauth.useNetwork(
    async (input) => {
      fetched.push(String(input));
      return new Response(JSON.stringify({ client_id: documentUrl, client_name: 'Example IDE', redirect_uris: ['http://127.0.0.1:33418/callback'], token_endpoint_auth_method: 'none' }), { status: 200 });
    },
    async (hostname) => (hostname === 'app.example.com' ? ['203.0.113.7'] : ['10.0.0.5']),
  );
  const verifier = 'q'.repeat(50);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  // A native app listens on whatever port is free: any port matches a loopback address.
  const location = (await h.raw('GET', `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: documentUrl, redirect_uri: 'http://127.0.0.1:50123/callback', code_challenge: challenge, code_challenge_method: 'S256' }).toString()}`)).headers.get('location')!;
  const id = location.split('/').pop()!;
  assert.equal(fetched.length, 0, 'nothing is fetched before a person who is signed in looks');
  const described = await h.http<ConnectRequestDto>({ cookie: h.users.root.cookie }, 'GET', `/api/connect/${id}`);
  assert.equal(described.body.client.name, 'Example IDE');
  assert.equal(described.body.client.kind, 'cimd');
  assert.deepEqual(described.body.warnings, ['localhost']);
  const approved = await h.http<{ redirect: string }>({ cookie: h.users.root.cookie }, 'POST', `/api/connect/${id}/approve`, { teamId: h.team.id, access: 'read' });
  const code = new URL(approved.body.redirect).searchParams.get('code')!;
  const issued = await h.raw('POST', '/oauth/token', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: documentUrl, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:50123/callback' }).toString() });
  assert.equal(issued.status, 200);

  const internal = 'https://internal.example/client.json';
  const id2 = (await h.raw('GET', `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: internal, redirect_uri: 'http://127.0.0.1:1/cb', code_challenge: challenge, code_challenge_method: 'S256' }).toString()}`)).headers.get('location')!.split('/').pop()!;
  const blocked = await h.http<{ error: { message: string } }>({ cookie: h.users.root.cookie }, 'GET', `/api/connect/${id2}`);
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error.message, /not a public address/);
  assert.ok(!fetched.includes(internal));
});

test('torex login: the command line shows a code, the person approves it in the browser, the token is collected once', async () => {
  const h = await harness();
  const started = await h.http<{ code: string; userCode: string; verificationUri: string }>({}, 'POST', '/api/cli/login', { name: 'macbook', client: 'torex 0.9.0' });
  assert.equal(started.status, 201);
  assert.match(started.body.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(started.body.verificationUri, `${ORIGIN}/connect/cli?code=${started.body.userCode}`);
  assert.equal((await h.http({}, 'GET', `/api/cli/login/${started.body.code}`)).status, 202);

  const described = await h.http<{ name: string; ip: string }>({ cookie: h.users.developer.cookie }, 'GET', `/api/cli/requests/${started.body.userCode}`);
  assert.equal(described.body.name, 'macbook');
  assert.equal((await h.http({ cookie: h.users.viewer.cookie }, 'POST', '/api/cli/requests', { userCode: started.body.userCode, teamId: h.team.id, access: 'full', approve: true })).status, 403);
  // The code may be typed in lower case and without the dash.
  const decided = await h.http({ cookie: h.users.developer.cookie }, 'POST', '/api/cli/requests', { userCode: started.body.userCode.replace('-', '').toLowerCase(), teamId: h.team.id, access: 'full', approve: true });
  assert.equal(decided.status, 200);
  const collected = await h.http<{ token: string; team: { name: string }; role: string }>({}, 'GET', `/api/cli/login/${started.body.code}`);
  assert.equal(collected.status, 200);
  assert.equal(collected.body.team.name, 'Acme');
  assert.equal(collected.body.role, 'developer');
  assert.equal((await h.http({}, 'GET', `/api/cli/login/${started.body.code}`)).status, 404, 'handed over once');
  const me = await h.http<{ email: string }>({ token: collected.body.token }, 'GET', '/api/me');
  assert.equal(me.status, 200);
  const record = h.stores.tokens.listForTeam(h.team.id).find((token) => token.kind === 'cli')!;
  assert.equal(record.name, 'torex · macbook');

  const declined = await h.http<{ code: string; userCode: string }>({}, 'POST', '/api/cli/login', { name: 'stranger' });
  await h.http({ cookie: h.users.developer.cookie }, 'POST', '/api/cli/requests', { userCode: declined.body.userCode, teamId: h.team.id, access: 'full', approve: false });
  assert.equal((await h.http({}, 'GET', `/api/cli/login/${declined.body.code}`)).status, 403);

  // The installers point at this panel.
  const script = await h.http<string>({}, 'GET', '/cli/install.sh');
  assert.match(script.body, /ORIGIN='http:\/\/localhost'/);
  assert.match((await h.http<string>({}, 'GET', '/cli/install.ps1')).body, /\$Origin = 'http:\/\/localhost'/);
});

test("a token's reach holds on the REST API too: read only reads, write never destroys", async () => {
  const h = await harness();
  const project = (await h.http<ProjectDto>({ token: h.users.root.token() }, 'POST', '/api/projects', { name: 'Shop' })).body;
  const reader = h.users.root.token('read');
  assert.equal((await h.http({ token: reader }, 'GET', '/api/projects')).status, 200);
  const refused = await h.http<{ error: { params: { reason: string } } }>({ token: reader }, 'POST', '/api/projects', { name: 'Nope' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.params.reason, 'token_read_only');
  const writer = h.users.root.token('write');
  assert.equal((await h.http({ token: writer }, 'POST', '/api/projects', { name: 'Allowed' })).status, 201);
  const destroy = await h.http<{ error: { params: { reason: string } } }>({ token: writer }, 'DELETE', `/api/projects/${project.id}`);
  assert.equal(destroy.status, 403);
  assert.equal(destroy.body.error.params.reason, 'token_no_destroy');
  assert.equal((await h.http({ token: h.users.root.token('full') }, 'DELETE', `/api/projects/${project.id}`)).status, 200);
  // Tokens made by hand say how far they reach.
  const made = await h.http<{ access: string; kind: string }>({ cookie: h.users.root.cookie }, 'POST', '/api/tokens', { name: 'ci', expiresInDays: 30, access: 'write' });
  assert.equal(made.body.access, 'write');
  assert.equal(made.body.kind, 'api');
});
