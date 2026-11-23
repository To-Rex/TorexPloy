/**
 * The `torex` command line, as the panel serves it: the program itself and
 * its installers, and the way it signs in.
 *
 * Signing in works like a TV app's: `torex login` asks the panel for a code,
 * opens the dashboard in the browser at a page that shows the code, and waits.
 * The person checks that the code is the one in their terminal, picks a team
 * and a reach, and says yes; the command line then collects its token. The
 * token never passes through the browser.
 */
import { randomInt } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { Hono } from 'hono';
import {
  API_TOKEN_PREFIX,
  cliLoginDecisionSchema,
  cliLoginStartSchema,
  type CliLoginRequestDto,
  type CliLoginResultDto,
  type CliLoginStartDto,
  type TokenAccess,
} from '@ploy/shared';
import type { Context } from '../context.ts';
import { AppError, notFound } from '../lib/errors.ts';
import { generateToken } from '../lib/crypto.ts';
import { publicBaseUrl } from '../github/app.ts';
import { audit, body, limit, RateLimiter, requestOrigin, requireAuth, type Ctx, type Env } from '../http/core.ts';

const LOGIN_TTL_MS = 10 * 60_000;
const LOGINS_MAX = 1_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Where the built command lives: `packages/cli/dist/torex.mjs`, next to this package. */
export const CLI_DIST = fileURLToPath(new URL('../../../cli/dist/torex.mjs', import.meta.url));

interface PendingLogin {
  code: string;
  userCode: string;
  name: string;
  client: string | null;
  ip: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'denied';
  result: CliLoginResultDto | null;
}

/** Eight characters a person can read out and compare: no 0/O or 1/I to mix up. */
function userCode(): string {
  let out = '';
  for (let index = 0; index < 8; index += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export class CliLogins {
  private readonly ctx: Context;
  private readonly logins = new Map<string, PendingLogin>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [code, login] of this.logins) if (login.expiresAt < now) this.logins.delete(code);
  }

  start(input: { name: string; client?: string }, ip: string, origin: string): CliLoginStartDto {
    this.sweep();
    if (this.logins.size >= LOGINS_MAX) throw new AppError('rate_limited', 'Too many sign-ins are waiting; try again in a few minutes');
    const code = generateToken(32);
    let shown = userCode();
    while ([...this.logins.values()].some((login) => login.userCode === shown)) shown = userCode();
    const now = Date.now();
    this.logins.set(code, { code, userCode: shown, name: input.name, client: input.client ?? null, ip, createdAt: now, expiresAt: now + LOGIN_TTL_MS, status: 'pending', result: null });
    return { code, userCode: shown, verificationUri: `${origin}/connect/cli?code=${shown}`, expiresIn: LOGIN_TTL_MS / 1000, interval: 2 };
  }

  private byUserCode(code: string): PendingLogin {
    this.sweep();
    const login = [...this.logins.values()].find((candidate) => candidate.userCode === code);
    if (login === undefined || login.status !== 'pending') throw new AppError('not_found', 'This sign-in code has expired or was already used; run torex login again', { params: { resource: 'cli_login' } });
    return login;
  }

  describe(code: string, userId: string, currentTeamId: string | null): CliLoginRequestDto {
    const login = this.byUserCode(code);
    return {
      userCode: login.userCode,
      name: login.name,
      client: login.client,
      ip: login.ip,
      createdAt: new Date(login.createdAt).toISOString(),
      expiresAt: new Date(login.expiresAt).toISOString(),
      teams: this.ctx.stores.teams.listForUser(userId).map((entry) => ({ id: entry.team.id, name: entry.team.name, role: entry.role })),
      currentTeamId,
    };
  }

  decide(code: string, userId: string, decision: { teamId: string; access: TokenAccess; approve: boolean }): { tokenId: string | null; name: string } {
    const login = this.byUserCode(code);
    if (!decision.approve) {
      login.status = 'denied';
      return { tokenId: null, name: login.name };
    }
    const { stores } = this.ctx;
    const role = stores.teams.getRole(decision.teamId, userId);
    if (role === undefined) throw new AppError('forbidden', 'You are not a member of that team');
    if (role === 'viewer') throw new AppError('forbidden', 'The command line needs the developer role in the team', { params: { reason: 'role' } });
    const user = stores.users.getById(userId)!;
    const team = stores.teams.get(decision.teamId)!;
    const { token, record } = stores.tokens.create({
      userId,
      teamId: decision.teamId,
      name: `torex · ${login.name}`.slice(0, 80),
      // A year: long enough not to be a chore, short enough that a forgotten laptop does not hold a key forever.
      expiresAt: new Date(Date.now() + 365 * 24 * 3_600_000).toISOString(),
      tokenPrefix: API_TOKEN_PREFIX,
      kind: 'cli',
      access: decision.access,
      client: login.client === null ? login.name : `${login.name} (${login.client})`.slice(0, 120),
    });
    login.status = 'approved';
    login.result = { token, user: { id: user.id, name: user.name, email: user.email }, team: { id: team.id, name: team.name }, role, access: decision.access };
    return { tokenId: record.id, name: login.name };
  }

  /** The command line asks whether the person said yes yet. The token is handed over once. */
  poll(code: string): { status: 'pending' } | { status: 'approved'; result: CliLoginResultDto } | { status: 'denied' } | null {
    this.sweep();
    const login = this.logins.get(code);
    if (login === undefined) return null;
    if (login.status === 'pending') return { status: 'pending' };
    this.logins.delete(code);
    return login.status === 'approved' && login.result !== null ? { status: 'approved', result: login.result } : { status: 'denied' };
  }
}

// ---------------------------------------------------------------------------
// The program and its installers
// ---------------------------------------------------------------------------

/** One file in a tar archive (ustar), for the npm package. */
function tarEntry(path: string, data: Buffer, mode: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

/** The address an installer points at: only a plain origin is written into a script. */
function safeOrigin(ctx: Context, c: Ctx): string {
  const origin = requestOrigin(c);
  if (/^https?:\/\/(\[[0-9a-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/i.test(origin)) return origin;
  const configured = publicBaseUrl(ctx);
  if (configured !== null) return configured;
  throw new AppError('bad_request', 'The address this panel was reached at cannot be put in an installer');
}

function installSh(origin: string, version: string): string {
  return `#!/bin/sh
# Installs torex, the TorexPloy command line, from ${origin} (version ${version}).
# Read it first if you like: curl -fsSL ${origin}/cli/install.sh
set -eu
ORIGIN='${origin}'
DIR="\${TOREX_INSTALL_DIR:-$HOME/.local/bin}"
if ! command -v node >/dev/null 2>&1; then
  echo "torex needs Node.js 20 or newer: https://nodejs.org" >&2
  exit 1
fi
MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 20 ]; then
  echo "torex needs Node.js 20 or newer (this computer has $(node -v))" >&2
  exit 1
fi
mkdir -p "$DIR"
TMP="$(mktemp)"
if command -v curl >/dev/null 2>&1; then curl -fsSL "$ORIGIN/cli/torex.mjs" -o "$TMP"; else wget -qO "$TMP" "$ORIGIN/cli/torex.mjs"; fi
if [ "$(head -c 2 "$TMP")" != "#!" ]; then
  echo "What was downloaded is not the torex command" >&2
  rm -f "$TMP"
  exit 1
fi
mv "$TMP" "$DIR/torex"
chmod 755 "$DIR/torex"
echo "Installed $DIR/torex ($("$DIR/torex" --version))"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo "Add it to your PATH:  export PATH=\\"$DIR:\\$PATH\\"" ;;
esac
echo "Next:  torex login $ORIGIN"
`;
}

function installPs1(origin: string, version: string): string {
  return `# Installs torex, the TorexPloy command line, from ${origin} (version ${version}).
$ErrorActionPreference = 'Stop'
$Origin = '${origin}'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error 'torex needs Node.js 20 or newer: https://nodejs.org'; exit 1 }
$Major = [int](node -p "process.versions.node.split('.')[0]")
if ($Major -lt 20) { Write-Error "torex needs Node.js 20 or newer (this computer has $(node -v))"; exit 1 }
$Dir = Join-Path $env:LOCALAPPDATA 'torexploy\\bin'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri "$Origin/cli/torex.mjs" -OutFile (Join-Path $Dir 'torex.mjs')
Set-Content -Path (Join-Path $Dir 'torex.cmd') -Value '@node "%~dp0torex.mjs" %*' -Encoding ASCII
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($UserPath -split ';') -contains $Dir)) {
  [Environment]::SetEnvironmentVariable('Path', "$UserPath;$Dir", 'User')
  Write-Host "Added $Dir to your PATH: open a new terminal."
}
Write-Host "Installed $Dir\\torex.cmd"
Write-Host "Next:  torex login $Origin"
`;
}

export function registerCliRoutes(app: Hono<Env>, ctx: Context, logins: CliLogins): void {
  const startLimiter = new RateLimiter(10, 5);
  let packed: { version: string; mtime: number; data: Buffer } | null = null;

  const program = async (): Promise<{ data: Buffer; mtime: number } | null> => {
    const info = await stat(CLI_DIST).catch(() => null);
    if (info === null) return null;
    return { data: await readFile(CLI_DIST), mtime: info.mtimeMs };
  };
  const missing = (c: Ctx) => c.text('The torex command has not been built on this panel (npm run build).', 404);

  app.get('/cli/torex.mjs', async (c) => {
    const built = await program();
    if (built === null) return missing(c);
    return c.body(new Uint8Array(built.data), 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Disposition': 'inline; filename="torex.mjs"' });
  });

  app.get('/cli/version.json', async (c) => c.json({ version: ctx.config.version, available: (await stat(CLI_DIST).catch(() => null)) !== null }, 200, { 'Cache-Control': 'no-cache' }));

  app.get('/cli/install.sh', (c) => c.body(installSh(safeOrigin(ctx, c), ctx.config.version), 200, { 'Content-Type': 'text/x-shellscript; charset=utf-8', 'Cache-Control': 'no-cache' }));
  app.get('/cli/install.ps1', (c) => c.body(installPs1(safeOrigin(ctx, c), ctx.config.version), 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }));

  /** `npm install -g <panel>/cli/torexploy-cli.tgz` */
  app.get('/cli/torexploy-cli.tgz', async (c) => {
    const built = await program();
    if (built === null) return missing(c);
    if (packed === null || packed.version !== ctx.config.version || packed.mtime !== built.mtime) {
      const manifest = {
        name: 'torexploy-cli',
        version: ctx.config.version,
        description: 'torex: deploy, logs, variables, TorexAi and an MCP server for TorexPloy, from the terminal',
        type: 'module',
        bin: { torex: 'torex.mjs' },
        engines: { node: '>=20' },
      };
      const tar = Buffer.concat([tarEntry('package/package.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 0o644), tarEntry('package/torex.mjs', built.data, 0o755), Buffer.alloc(1024)]);
      packed = { version: ctx.config.version, mtime: built.mtime, data: gzipSync(tar) };
    }
    return c.body(new Uint8Array(packed.data), 200, { 'Content-Type': 'application/gzip', 'Content-Disposition': 'attachment; filename="torexploy-cli.tgz"', 'Cache-Control': 'no-cache' });
  });

  // ------------------------------------------------------------- signing in

  app.post('/api/cli/login', async (c) => {
    limit(startLimiter, c, 'cli-login');
    const input = await body(c, cliLoginStartSchema);
    return c.json(logins.start(input, c.get('ip'), requestOrigin(c)), 201);
  });

  app.get('/api/cli/login/:code', (c) => {
    const outcome = logins.poll(c.req.param('code'));
    if (outcome === null) throw new AppError('not_found', 'This sign-in has expired; run torex login again', { params: { resource: 'cli_login' } });
    if (outcome.status === 'pending') return c.json({ status: 'pending' }, 202);
    if (outcome.status === 'denied') throw new AppError('forbidden', 'The sign-in was declined in the browser', { params: { reason: 'declined' } });
    return c.json(outcome.result);
  });

  const signedIn = (c: Ctx) => {
    const auth = requireAuth(c);
    if (auth.sessionId === null) throw new AppError('forbidden', 'Sign in to the dashboard to let the command line in');
    return auth;
  };

  app.get('/api/cli/requests/:userCode', (c) => {
    const auth = signedIn(c);
    const code = c.req.param('userCode').toUpperCase();
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) throw notFound('Sign-in');
    return c.json(logins.describe(code, auth.user.id, auth.teamId));
  });

  app.post('/api/cli/requests', async (c) => {
    const auth = signedIn(c);
    const input = await body(c, cliLoginDecisionSchema);
    const outcome = logins.decide(input.userCode, auth.user.id, input);
    if (outcome.tokenId !== null) audit(ctx, c, 'cli.login_approved', { type: 'token', id: outcome.tokenId, name: outcome.name, teamId: input.teamId }, { access: input.access });
    return c.json({ ok: true });
  });
}
