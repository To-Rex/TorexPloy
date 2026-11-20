/**
 * Confirming a session's owner without the password — through the linked
 * GitHub account or one of the account's passkeys — and what that
 * confirmation then stands in for: a new password, a new passkey, turning
 * two-factor off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HttpBindings } from '@hono/node-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_TOKEN_PREFIX, type ApiErrorBody, type LoginResultDto, type PasskeyCreationOptionsDto, type PasskeyDto, type PasskeyRequestOptionsDto, type StepUpDto, type StepUpStartDto } from '@ploy/shared';
import { generateTotpSecret, hashPassword, totpCode } from '../lib/crypto.ts';
import { SoftAuthenticator } from '../lib/webauthn.fixture.ts';
import { createContext } from '../main.ts';
import { createHttpApp } from './app.ts';
import { STEP_UP_TTL_MS } from './stepup.ts';

const BINDINGS = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as unknown as HttpBindings;
const PASSWORD = 'correct horse battery staple';
type Failure = ApiErrorBody;

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-stepup-'));
  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket: join(dir, 'none.sock'), logLevel: 'error' });
  const { stores } = ctx;
  const team = stores.teams.create('Acme');
  const passwordHash = await hashPassword(PASSWORD);
  const user = (email: string) => {
    const created = stores.users.create({ email, name: email.split('@')[0]!, passwordHash, isInstanceAdmin: false });
    stores.teams.addMember(team.id, created.id, 'owner');
    stores.users.update(created.id, { currentTeamId: team.id });
    return created;
  };
  const app = createHttpApp(ctx);
  let addresses = 0;
  const headers = (cookie: string | null | undefined, extra: Record<string, string> = {}): Record<string, string> => {
    addresses += 1;
    return { 'x-forwarded-for': `203.0.113.${(addresses % 250) + 1}`, 'x-ploy-request': '1', ...(cookie ? { cookie } : {}), ...extra };
  };

  const call = async <T>(method: string, path: string, options: { body?: unknown; cookie?: string | null; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T; cookie: string | null }> => {
    const response = await app.request(
      path,
      {
        method,
        headers: headers(options.cookie, { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers }),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      },
      BINDINGS,
    );
    const set = response.headers.getSetCookie().find((value) => value.startsWith('ploy_session=') && !value.startsWith('ploy_session=;'));
    return { status: response.status, body: (await response.json()) as T, cookie: set === undefined ? null : set.split(';')[0]! };
  };

  /** A navigation (the OAuth round trip is made of redirects): where the browser is sent next. */
  const visit = async (path: string, cookie?: string | null, extra: Record<string, string> = {}): Promise<{ status: number; location: string }> => {
    const response = await app.request(path, { method: 'GET', headers: { ...(cookie ? { cookie } : {}), ...extra } }, BINDINGS);
    return { status: response.status, location: response.headers.get('location') ?? '' };
  };

  const signIn = async (email: string, password = PASSWORD): Promise<string> => {
    const reply = await call<LoginResultDto>('POST', '/api/auth/login', { body: { email, password } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.ok(reply.cookie);
    return reply.cookie;
  };
  const sessionId = (cookie: string): string => stores.sessions.resolve(cookie.slice('ploy_session='.length))!.id;
  const status = async (cookie: string): Promise<StepUpDto> => (await call<StepUpDto>('GET', '/api/me/step-up', { cookie })).body;

  /** GitHub, as far as these flows need it: an OAuth app that is configured, and who each `code` turns out to be. */
  const github = {
    configured: true,
    people: new Map<string, { id: string; login: string }>(),
    authorizeUrls: [] as string[],
  };
  ctx.github.credentials = (() => (github.configured ? { baseUrl: 'http://localhost', clientId: 'Iv1.test' } : null)) as typeof ctx.github.credentials;
  ctx.github.oauthUrl = (state, redirectUri, login) => {
    const url = `https://github.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}${login ? `&login=${login}` : ''}`;
    github.authorizeUrls.push(url);
    return url;
  };
  ctx.github.oauthUser = async (code) => {
    const person = github.people.get(code);
    if (person === undefined) throw new Error('GitHub refused the code');
    return { ...person, name: person.login, email: null, avatarUrl: null };
  };
  /** What each browser was handed when it began a confirmation, by the state it began. */
  const browsers = new Map<string, string>();
  /** Begin a confirmation on `cookie`'s session, as the Security page does, and return the state GitHub would carry back. */
  const startConfirm = async (cookie: string, then?: string): Promise<string> => {
    const response = await app.request(
      '/api/me/step-up/github',
      { method: 'POST', headers: headers(cookie, { 'content-type': 'application/json' }), body: JSON.stringify(then === undefined ? {} : { then }) },
      BINDINGS,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const { url } = (await response.json()) as StepUpStartDto;
    assert.match(url, /^https:\/\/github\.test\/authorize\?state=/);
    const state = new URL(url).searchParams.get('state')!;
    const handed = response.headers.getSetCookie().find((value) => value.startsWith('ploy_confirm='));
    assert.ok(handed, 'the browser that begins is handed a one-time value');
    assert.match(handed, /; HttpOnly/i);
    assert.match(handed, /; Path=\/api\/auth\/github/i);
    browsers.set(state, handed.split(';')[0]!);
    return state;
  };
  /** GitHub sends the browser back. `sameBrowser: false` is another browser holding the same cookies otherwise. */
  const comeBack = (code: string, state: string, cookie?: string | null, sameBrowser = true): Promise<{ status: number; location: string }> =>
    visit(`/api/auth/github/callback?code=${code}&state=${state}`, [cookie, sameBrowser ? browsers.get(state) : null].filter((part) => part).join('; ') || null);

  /** Register a passkey the ordinary way, with the password. */
  const register = async (cookie: string, device: SoftAuthenticator): Promise<PasskeyDto> => {
    const options = await call<PasskeyCreationOptionsDto>('POST', '/api/me/passkeys/options', { cookie, body: { password: PASSWORD } });
    assert.equal(options.status, 200, JSON.stringify(options.body));
    const { publicKey, ticket } = options.body;
    const credential = device.create({ challenge: publicKey.challenge, rpId: publicKey.rp.id, origin: 'http://localhost', userHandle: publicKey.user.id });
    const added = await call<PasskeyDto>('POST', '/api/me/passkeys', { cookie, body: { ticket, credential } });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    return added.body;
  };
  /** Confirm the owner of `cookie`'s session with a passkey. */
  const confirmWithPasskey = async (cookie: string, device: SoftAuthenticator, forge?: Parameters<SoftAuthenticator['get']>[1]) => {
    const options = await call<PasskeyRequestOptionsDto>('POST', '/api/me/step-up/passkey/options', { cookie });
    assert.equal(options.status, 200, JSON.stringify(options.body));
    const credential = device.get({ challenge: options.body.publicKey.challenge, rpId: options.body.publicKey.rpId, origin: 'http://localhost' }, forge);
    return { options: options.body, reply: await call<StepUpDto & Failure>('POST', '/api/me/step-up/passkey', { cookie, body: { ticket: options.body.ticket, credential } }) };
  };

  const audits = (action: string): Record<string, unknown>[] =>
    stores.db.all('SELECT metadata FROM audit_log WHERE action = ? ORDER BY rowid', action).map((row) => JSON.parse(String(row.metadata)) as Record<string, unknown>);

  return {
    ctx,
    team,
    user,
    call,
    visit,
    signIn,
    sessionId,
    status,
    github,
    browsers,
    startConfirm,
    comeBack,
    register,
    confirmWithPasskey,
    audits,
    close: async () => {
      await ctx.notifier.flush();
      stores.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a forgotten password: confirming with the linked GitHub account lets this session set a new one', async () => {
  const h = await harness();
  try {
    const { stores } = h.ctx;
    const sardor = h.user('sardor@acme.uz');
    stores.users.linkIdentity(sardor.id, 'github', '1001', 'sardor-gh');
    h.github.people.set('owner', { id: '1001', login: 'sardor-gh' });
    const cookie = await h.signIn('sardor@acme.uz');

    // Nothing confirmed yet; GitHub is a way to, a passkey is not (there is none).
    assert.deepEqual(await h.status(cookie), { active: false, method: null, expiresAt: null, methods: { github: true, passkey: false } });
    // Without the current password a new one is refused, as it always was.
    const refused = await h.call<Failure>('POST', '/api/me/password', { cookie, body: { newPassword: 'a brand new passphrase' } });
    assert.equal(refused.status, 401);
    assert.equal(refused.body.error.code, 'invalid_credentials');
    assert.equal((await h.call('POST', '/api/me/password', { cookie, body: { currentPassword: 'guess', newPassword: 'a brand new passphrase' } })).status, 401);

    // The round trip: the panel sends the browser to GitHub (suggesting the linked account) and takes it back.
    const state = await h.startConfirm(cookie, 'password');
    assert.match(h.github.authorizeUrls.at(-1)!, /&login=sardor-gh$/);
    const back = await h.comeBack('owner', state, cookie);
    assert.deepEqual([back.status, back.location], [302, '/settings/security?confirm=ok&then=password']);

    const confirmed = await h.status(cookie);
    assert.deepEqual([confirmed.active, confirmed.method], [true, 'github']);
    const remaining = Date.parse(confirmed.expiresAt!) - Date.now();
    assert.ok(remaining > STEP_UP_TTL_MS - 5_000 && remaining <= STEP_UP_TTL_MS, 'ten minutes from now');
    assert.deepEqual(h.audits('user.identity_confirmed'), [{ method: 'github' }]);

    // Now the new password is accepted with no current one. Other sessions are signed out, as on any password change.
    const elsewhere = await h.signIn('sardor@acme.uz');
    const changed = await h.call('POST', '/api/me/password', { cookie, body: { newPassword: 'a brand new passphrase' } });
    assert.equal(changed.status, 200);
    assert.deepEqual(h.audits('user.password_changed'), [{ confirmedBy: 'github' }]);
    assert.equal((await h.call('GET', '/api/auth/session', { cookie: elsewhere })).status, 401);
    assert.equal((await h.call('GET', '/api/auth/session', { cookie })).status, 200, 'the session that changed it stays');
    assert.equal((await h.call('POST', '/api/auth/login', { body: { email: 'sardor@acme.uz', password: PASSWORD } })).status, 401, 'the forgotten password is gone');
    await h.signIn('sardor@acme.uz', 'a brand new passphrase');

    // The confirmation was spent on the change: the next one needs the (new) password again.
    assert.equal((await h.status(cookie)).active, false);
    assert.equal((await h.call('POST', '/api/me/password', { cookie, body: { newPassword: 'yet another passphrase' } })).status, 401);
    assert.equal((await h.call('POST', '/api/me/password', { cookie, body: { currentPassword: 'a brand new passphrase', newPassword: 'yet another passphrase' } })).status, 200);
    assert.deepEqual(h.audits('user.password_changed').at(-1), {}, 'a change confirmed by the password says nothing more');
  } finally {
    await h.close();
  }
});

test('a GitHub confirmation lifts only the session that asked, only with the linked account, and only while it is fresh', async () => {
  const h = await harness();
  try {
    const { stores } = h.ctx;
    const sardor = h.user('sardor@acme.uz');
    h.user('aziza@acme.uz');
    stores.users.linkIdentity(sardor.id, 'github', '1001', 'sardor-gh');
    h.github.people.set('owner', { id: '1001', login: 'sardor-gh' });
    h.github.people.set('stranger', { id: '2002', login: 'someone-else' });
    const cookie = await h.signIn('sardor@acme.uz');

    // Another GitHub account, however real, is not this account's.
    const mismatch = await h.comeBack('stranger', await h.startConfirm(cookie, 'passkey'), cookie);
    assert.equal(mismatch.location, '/settings/security?confirm=mismatch&then=passkey');
    assert.equal((await h.status(cookie)).active, false);
    assert.deepEqual(h.audits('user.identity_confirmation_failed'), [{ method: 'github', githubLogin: 'someone-else' }]);

    // GitHub did not accept the code.
    const failed = await h.comeBack('garbage', await h.startConfirm(cookie), cookie);
    assert.equal(failed.location, '/settings/security?confirm=failed');
    assert.equal((await h.status(cookie)).active, false);

    // The answer comes back somewhere else: in another session of the same account, or in none at all.
    const stolen = await h.signIn('sardor@acme.uz');
    const lure = await h.startConfirm(stolen);
    const victim = await h.comeBack('owner', lure, cookie);
    assert.equal(victim.location, '/settings/security?confirm=expired');
    assert.deepEqual([(await h.status(stolen)).active, (await h.status(cookie)).active], [false, false], 'neither session is lifted');
    const anonymous = await h.comeBack('owner', await h.startConfirm(cookie));
    assert.equal(anonymous.location, '/settings/security?confirm=expired');

    // A copied session cookie is the same session in two browsers. Whoever copied it can begin a confirmation and
    // send GitHub's address to the owner, whose browser holds the session too; but not what the beginner was handed.
    const copied = await h.startConfirm(cookie, 'password');
    assert.equal((await h.comeBack('owner', copied, cookie, false)).location, '/settings/security?confirm=expired&then=password');
    assert.equal((await h.status(cookie)).active, false, 'the owner finishing it for them lifts nothing');
    const mine = await h.startConfirm(cookie);
    const theirs = await h.startConfirm(cookie);
    assert.equal((await h.visit(`/api/auth/github/callback?code=owner&state=${mine}`, `${cookie}; ${h.browsers.get(theirs)!}`)).location, '/settings/security?confirm=expired', 'nor does a value handed out for another attempt');
    assert.equal((await h.status(cookie)).active, false);

    // Nor can the owner be made to begin one by following an address: beginning is a write, and a write needs the
    // panel's own page behind it. The sign-in address ignores the request and stays a sign-in.
    const forged = await h.call<Failure>('POST', '/api/me/step-up/github', { cookie, body: {}, headers: { 'x-ploy-request': '' } });
    assert.deepEqual([forged.status, forged.body.error.code], [403, 'csrf_failed']);
    const crossSite = await h.call<Failure>('POST', '/api/me/step-up/github', { cookie, body: {}, headers: { origin: 'https://evil.test' } });
    assert.deepEqual([crossSite.status, crossSite.body.error.code], [403, 'csrf_failed']);
    const link = await h.visit('/api/auth/github/start?mode=confirm&then=password', cookie);
    const linkState = new URL(link.location).searchParams.get('state')!;
    await h.visit(`/api/auth/github/callback?code=owner&state=${linkState}`, cookie);
    assert.equal((await h.status(cookie)).active, false, 'a sign-in through GitHub confirms nothing on the session that was there');

    // A state answers once.
    const once = await h.startConfirm(cookie);
    assert.equal((await h.comeBack('owner', once, cookie)).location, '/settings/security?confirm=ok');
    assert.equal((await h.comeBack('owner', once, cookie)).location, '/login?error=github_expired');
    assert.equal((await h.status(cookie)).active, true);

    // It ends by itself after ten minutes, or when given up, or with the session.
    h.ctx.stepUps.grant(h.sessionId(cookie), 'github', Date.now() - STEP_UP_TTL_MS - 1_000);
    assert.equal((await h.status(cookie)).active, false, 'lapsed');
    h.ctx.stepUps.grant(h.sessionId(cookie), 'github');
    assert.equal((await h.call('DELETE', '/api/me/step-up', { cookie })).status, 200);
    assert.equal((await h.status(cookie)).active, false, 'given up');
    const leaving = h.sessionId(cookie);
    h.ctx.stepUps.grant(leaving, 'github');
    await h.call('POST', '/api/auth/logout', { cookie });
    assert.equal(h.ctx.stepUps.active(leaving), null, 'signed out');

    // Only where it can work: a signed-in browser, a linked account, a configured GitHub app, a purpose the page knows.
    const begin = (options: Parameters<typeof h.call>[2]) => h.call<Failure>('POST', '/api/me/step-up/github', { body: {}, ...options });
    assert.equal((await begin({})).status, 401);
    const token = stores.tokens.create({ userId: sardor.id, teamId: h.team.id, name: 'ci', expiresAt: null, tokenPrefix: API_TOKEN_PREFIX }).token;
    const withToken = await begin({ headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual([withToken.status, withToken.body.error.params?.reason], [403, 'session'], 'an API token is not a browser session');
    const unlinked = await h.signIn('aziza@acme.uz');
    const noAccount = await begin({ cookie: unlinked, body: { then: 'password' } });
    assert.deepEqual([noAccount.status, noAccount.body.error.params?.reason], [409, 'unavailable']);
    assert.equal((await h.status(unlinked)).methods.github, false);
    const again = await h.signIn('sardor@acme.uz');
    assert.equal((await begin({ cookie: again, body: { then: 'https://evil.test' } })).status, 422, 'the return page is one of the known ones');
    h.github.configured = false;
    const noApp = await begin({ cookie: again });
    assert.deepEqual([noApp.status, noApp.body.error.params?.reason], [409, 'unavailable']);
    assert.equal((await h.status(again)).methods.github, false);
  } finally {
    await h.close();
  }
});

test('a passkey confirms its owner too: another passkey, a new password and turning two-factor off then need no password', async () => {
  const h = await harness();
  try {
    const { stores } = h.ctx;
    const sardor = h.user('sardor@acme.uz');
    h.user('aziza@acme.uz');
    const cookie = await h.signIn('sardor@acme.uz');
    const other = await h.signIn('aziza@acme.uz');

    // No passkey: nothing to confirm with.
    assert.equal((await h.status(cookie)).methods.passkey, false);
    const none = await h.call<Failure>('POST', '/api/me/step-up/passkey/options', { cookie });
    assert.deepEqual([none.status, none.body.error.params?.reason], [409, 'passkey_none']);

    const device = new SoftAuthenticator();
    const mine = await h.register(cookie, device);
    const theirs = new SoftAuthenticator();
    await h.register(other, theirs);
    assert.equal((await h.status(cookie)).methods.passkey, true);

    // Someone else's passkey proves someone else: refused, and the options never offered it.
    const wrong = await h.confirmWithPasskey(cookie, theirs);
    assert.deepEqual(wrong.options.publicKey.allowCredentials, [{ type: 'public-key', id: device.id, transports: ['internal', 'hybrid'] }]);
    assert.deepEqual([wrong.reply.status, wrong.reply.body.error.params?.reason], [401, 'passkey_unknown']);
    // A spoiled answer from the right passkey is refused as well.
    const forged = await h.confirmWithPasskey(cookie, device, { origin: 'https://evil.test' });
    assert.deepEqual([forged.reply.status, forged.reply.body.error.params?.reason], [401, 'passkey_invalid']);
    assert.equal((await h.status(cookie)).active, false);
    assert.deepEqual(h.audits('user.identity_confirmation_failed'), [{ method: 'passkey', reason: 'passkey_unknown' }, { method: 'passkey', reason: 'origin' }]);
    // A sign-in challenge is not a confirmation challenge.
    const loginOptions = await h.call<PasskeyRequestOptionsDto>('POST', '/api/auth/passkey/options');
    const crossed = await h.call<Failure>('POST', '/api/me/step-up/passkey', {
      cookie,
      body: { ticket: loginOptions.body.ticket, credential: device.get({ challenge: loginOptions.body.publicKey.challenge, rpId: 'localhost', origin: 'http://localhost' }) },
    });
    assert.deepEqual([crossed.status, crossed.body.error.params?.reason], [400, 'passkey_expired']);

    // The real thing.
    const good = await h.confirmWithPasskey(cookie, device);
    assert.equal(good.reply.status, 200, JSON.stringify(good.reply.body));
    assert.deepEqual([good.reply.body.active, good.reply.body.method], [true, 'passkey']);
    assert.deepEqual(h.audits('user.identity_confirmed'), [{ method: 'passkey', passkeyId: mine.id }]);
    assert.equal((await h.status(other)).active, false, 'another account’s session is not affected');
    assert.ok(stores.passkeys.get(mine.id)!.signCount >= 2, 'the counter moved with the confirmation, so the next sign-in still verifies');

    // 1. Another passkey, with no password asked.
    const options = await h.call<PasskeyCreationOptionsDto>('POST', '/api/me/passkeys/options', { cookie, body: {} });
    assert.equal(options.status, 200);
    // 2. Two-factor off: the code is still required, the password is not.
    const secret = generateTotpSecret();
    stores.users.setTotpPending(sardor.id, h.ctx.secrets.seal(secret, 'totp'));
    stores.users.enableTotp(sardor.id, 0, []);
    assert.equal((await h.call('POST', '/api/me/2fa/disable', { cookie, body: { password: '', code: '000000' } })).status, 401, 'a wrong code is still wrong');
    assert.equal((await h.call('POST', '/api/me/2fa/disable', { cookie, body: { password: '', code: totpCode(secret) } })).status, 200);
    assert.equal(stores.users.getById(sardor.id)!.totpEnabled, false);
    // 3. A new password.
    assert.equal((await h.call('POST', '/api/me/password', { cookie, body: { newPassword: 'set after a passkey check' } })).status, 200);
    assert.deepEqual(h.audits('user.password_changed'), [{ confirmedBy: 'passkey' }]);

    // Lapsed: the password is asked for again, everywhere.
    h.ctx.stepUps.grant(h.sessionId(cookie), 'passkey', Date.now() - STEP_UP_TTL_MS - 1_000);
    assert.equal((await h.call('POST', '/api/me/passkeys/options', { cookie, body: {} })).status, 401);
    assert.equal((await h.call('POST', '/api/me/password', { cookie, body: { newPassword: 'no longer allowed here' } })).status, 401);

    // An API token cannot confirm anything, and reports no way to.
    const token = stores.tokens.create({ userId: sardor.id, teamId: h.team.id, name: 'ci', expiresAt: null, tokenPrefix: API_TOKEN_PREFIX }).token;
    const bearer = { authorization: `Bearer ${token}` };
    const viaToken = await h.call<Failure>('POST', '/api/me/step-up/passkey/options', { headers: bearer });
    assert.deepEqual([viaToken.status, viaToken.body.error.params?.reason], [403, 'passkey_session']);
    assert.deepEqual((await h.call<StepUpDto>('GET', '/api/me/step-up', { headers: bearer })).body.methods, { github: false, passkey: false });
  } finally {
    await h.close();
  }
});
