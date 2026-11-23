/**
 * The command line: its pieces on their own (arguments, ignore rules, event
 * streams, MCP headers), then the real program against a real panel, from
 * signing in to the MCP bridge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { API_TOKEN_PREFIX } from '../../shared/src/constants.ts';
import { createHttpApp } from '../../server/src/http/app.ts';
import { createContext } from '../../server/src/main.ts';
import { parseArgs, seconds } from './args.ts';
import { encodeHeaderValue, headersFor } from './bridge.ts';
import { readSse } from './client.ts';
import { normalizeUrl } from './config.ts';
import { collect, IgnoreRules } from './files.ts';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));

test('the command line is read the way people type it', () => {
  const parsed = parseArgs(['env', 'set', 'A=1', '--app', 'shop/api', '-y', '--deploy', '--no-color', '--tail=50', '--', 'rest', '--x']);
  assert.deepEqual(parsed.words, ['env', 'set', 'A=1']);
  assert.equal(parsed.flags.get('app'), 'shop/api');
  assert.equal(parsed.flags.get('yes'), true);
  assert.equal(parsed.flags.get('deploy'), true);
  assert.equal(parsed.flags.get('color'), 'false');
  assert.equal(parsed.flags.get('tail'), '50');
  assert.deepEqual(parsed.rest, ['rest', '--x']);
  assert.equal(parseArgs(['logs', '-f', '-n', '20']).flags.get('tail'), '20');
  assert.equal(seconds('10m'), 600);
  assert.equal(seconds('2h'), 7_200);
  assert.equal(seconds('45'), 45);
  assert.throws(() => seconds('soon'));
  assert.equal(normalizeUrl('panel.example.com/'), 'https://panel.example.com');
  assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeUrl('https://panel.example.com/dashboard/x'), 'https://panel.example.com');
});

test('torex up leaves out what git leaves out, and secrets that belong in the panel', async () => {
  const rules = new IgnoreRules();
  rules.add('node_modules\n/dist/\n*.log\n!keep.log\ndocs/**/draft.md\n# comment\nbuild');
  assert.equal(rules.ignores('node_modules', true), true);
  assert.equal(rules.ignores('packages/a/node_modules', true), true);
  assert.equal(rules.ignores('dist', true), true);
  assert.equal(rules.ignores('src/dist', true), false, 'a leading slash anchors the pattern');
  assert.equal(rules.ignores('debug.log', false), true);
  assert.equal(rules.ignores('keep.log', false), false, 'a later ! brings a file back');
  assert.equal(rules.ignores('docs/a/b/draft.md', false), true);
  assert.equal(rules.ignores('src/index.ts', false), false);

  const dir = mkdtempSync(join(tmpdir(), 'torex-up-'));
  for (const [path, text] of Object.entries({ '.gitignore': 'dist/\n*.log\n', 'src/index.js': 'x', 'package.json': '{}', '.env': 'S=1', '.env.production': 'S=2', '.env.example': 'S=', 'dist/out.js': 'y', 'app.log': 'z', 'node_modules/m/i.js': 'n', '.git/HEAD': 'h' })) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const found = await collect(dir, { maxBytes: 1_000_000 });
  assert.deepEqual(found.files.map((file) => file.path).sort(), ['.env.example', '.gitignore', 'package.json', 'src/index.js']);
  assert.deepEqual(found.skippedEnv.sort(), ['.env', '.env.production']);
  assert.equal((await collect(dir, { maxBytes: 1_000_000, includeEnv: true })).files.length, 6);
  // .torexignore, when there is one, is used instead of .gitignore.
  writeFileSync(join(dir, '.torexignore'), 'src/\n');
  assert.deepEqual((await collect(dir, { maxBytes: 1_000_000 })).files.map((file) => file.path).sort(), ['.env.example', '.gitignore', '.torexignore', 'app.log', 'dist/out.js', 'package.json']);
  await assert.rejects(collect(dir, { maxBytes: 3 }), /more than 0 MB/);
});

test('event streams are read across chunk boundaries, comments and multi-line data included', async () => {
  const text = ': keep-alive\n\nevent: line\ndata: {"a":1}\n\nevent: line\ndata: first\ndata: second\nid: 7\n\r\ndata: last';
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < text.length; at += 5) controller.enqueue(encoder.encode(text.slice(at, at + 5)));
      controller.close();
    },
  });
  const events = [];
  for await (const event of readSse(body)) events.push(event);
  assert.deepEqual(events, [
    { event: 'line', data: '{"a":1}' },
    { event: 'line', data: 'first\nsecond', id: '7' },
    { event: 'message', data: 'last' },
  ]);
});

test('the MCP bridge puts on each request the headers the HTTP transport mirrors', () => {
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
  assert.deepEqual(headersFor({ method: 'tools/call', params: { name: 'platform_map', _meta: meta } }, null), {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': 'tools/call',
    'mcp-name': 'platform_map',
  });
  assert.equal(headersFor({ method: 'resources/read', params: { uri: 'torexploy://skills/ünïcode', _meta: meta } }, null)['mcp-name'], `=?base64?${Buffer.from('torexploy://skills/ünïcode').toString('base64')}?=`);
  // A legacy client: the version initialize agreed on, and none on initialize itself.
  assert.equal(headersFor({ method: 'tools/list' }, '2025-06-18')['mcp-protocol-version'], '2025-06-18');
  assert.equal(headersFor({ method: 'initialize' }, '2025-06-18')['mcp-protocol-version'], undefined);
  assert.equal(encodeHeaderValue(' padded '), `=?base64?${Buffer.from(' padded ').toString('base64')}?=`);
  assert.equal(encodeHeaderValue('=?base64?x?='), `=?base64?${Buffer.from('=?base64?x?=').toString('base64')}?=`);
});

// ---------------------------------------------------------------------------
// The program, against a real panel
// ---------------------------------------------------------------------------

async function panel() {
  const dir = mkdtempSync(join(tmpdir(), 'torex-e2e-'));
  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket: join(dir, 'docker.sock'), logLevel: 'error' });
  const { stores } = ctx;
  const server = stores.servers.ensureLocal('local');
  const team = stores.teams.create('Acme');
  const user = stores.users.create({ email: 'dev@acme.uz', name: 'Dev', passwordHash: null, isInstanceAdmin: true });
  stores.teams.addMember(team.id, user.id, 'owner');
  const project = stores.projects.create(team.id, 'Shop', null);
  stores.applications.create({ projectId: project.id, teamId: team.id, serverId: server.id, name: 'api', slug: 'api', kind: 'web', sourceType: 'image', githubInstallationId: null, repository: null, gitUrl: null, branch: null, image: 'nginx:1.27', sealedHookToken: ctx.secrets.seal('x', 'hook') });
  const token = stores.tokens.create({ userId: user.id, teamId: team.id, name: 'e2e', expiresAt: null, tokenPrefix: API_TOKEN_PREFIX }).token;
  const app = createHttpApp(ctx);
  const listening = await new Promise<{ close: () => void; port: number }>((resolve) => {
    const http = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => resolve({ close: () => http.close(), port: info.port }));
  });
  const config = join(dir, 'config');
  const run = (args: string[], input?: string, cwd = dir): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [MAIN, ...args], { cwd, env: { ...process.env, TOREX_CONFIG_DIR: config, TOREX_MAIN: '1', NO_COLOR: '1', TOREX_URL: '', TOREX_TOKEN: '' } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input ?? '');
    });
  return { ctx, dir, url: `http://127.0.0.1:${listening.port}`, token, run, close: listening.close, team };
}

test('the program signs in, finds its application, changes variables, and serves MCP over stdio', async () => {
  const p = await panel();
  try {
    const signedOut = await p.run(['status']);
    assert.equal(signedOut.code, 1);
    assert.match(signedOut.stderr, /Not signed in/);

    const login = await p.run(['login', p.url, '--token', p.token]);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stderr, /Signed in to Acme as Dev/);
    const config = JSON.parse(readFileSync(join(p.dir, 'config', 'config.json'), 'utf8')) as { current: string; profiles: Record<string, { token: string }> };
    assert.equal(config.profiles[config.current]!.token, p.token);

    const me = await p.run(['whoami', '--json']);
    assert.equal((JSON.parse(me.stdout) as { team: { name: string } }).team.name, 'Acme');
    const apps = await p.run(['apps', '--json']);
    assert.deepEqual((JSON.parse(apps.stdout) as { name: string }[]).map((app) => app.name), ['api']);

    // The only application is the one meant; variables are set, hidden when listed, written to .env.
    assert.equal((await p.run(['env', 'set', 'PORT=3000', 'TOKEN=abc'])).code, 0);
    const listed = await p.run(['env']);
    assert.match(listed.stdout, /PORT=••••••/);
    assert.doesNotMatch(listed.stdout, /abc/);
    assert.equal((await p.run(['env', 'pull', '-y'])).code, 0);
    assert.equal(readFileSync(join(p.dir, '.env'), 'utf8'), 'PORT=3000\nTOKEN=abc\n');
    const missing = await p.run(['info', 'nope']);
    assert.match(missing.stderr, /No application "nope"\. These exist: Shop\/api/);

    // A folder linked to it remembers it.
    assert.equal((await p.run(['link', 'shop/api'])).code, 0);
    assert.match(readFileSync(join(p.dir, '.torexploy.json'), 'utf8'), /"name": "api"/);

    // The MCP bridge: what an MCP client writes on stdin comes back on stdout, and nothing else does.
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'api_get', arguments: { path: '/api/applications', pick: ['name'] } } },
    ];
    const bridged = await p.run(['mcp'], `${JSON.stringify(lines[0])}\n`);
    const first = bridged.stdout.trim().split('\n').map((line) => JSON.parse(line) as { id: number; result: { protocolVersion: string } });
    assert.equal(first[0]!.result.protocolVersion, '2025-11-25');
    const all = await p.run(['mcp'], `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const answers = new Map(all.stdout.trim().split('\n').map((line) => { const message = JSON.parse(line) as { id: number; result: Record<string, any> }; return [message.id, message.result]; }));
    assert.equal(answers.get(2)!.tools.length, 17);
    assert.match(answers.get(3)!.content[0].text, /"name":"api"/);
    const setup = await p.run(['mcp', 'setup', 'codex']);
    assert.match(setup.stdout, /\[mcp_servers\.torexploy\]/);

    // Signing out revokes nothing that is not a command-line sign-in, but forgets the profile.
    assert.equal((await p.run(['logout'])).code, 0);
    assert.match((await p.run(['status'])).stderr, /Not signed in/);
  } finally {
    p.close();
  }
});
