/**
 * Passkeys through the real HTTP stack, with a software authenticator in
 * place of a phone: registering from a signed-in browser, signing in with
 * no password, every refusal, and where passkeys may exist at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HttpBindings } from '@hono/node-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_TOKEN_PREFIX, LIMITS, type ApiErrorBody, type BootstrapDto, type LoginResultDto, type PasskeyCreationOptionsDto, type PasskeyDto, type PasskeyListDto, type PasskeyRequestOptionsDto } from '@ploy/shared';
import type { AppConfig } from '../lib/config.ts';
import { generateTotpSecret, hashPassword } from '../lib/crypto.ts';
import { SoftAuthenticator } from '../lib/webauthn.fixture.ts';
import { createContext } from '../main.ts';
import { createHttpApp } from './app.ts';

const BINDINGS = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as unknown as HttpBindings;
const PASSWORD = 'correct horse battery staple';
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

type Reply<T> = { status: number; body: T; cookie: string | null };
type Failure = ApiErrorBody;

async function harness(config: Partial<AppConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-passkey-'));
  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket: join(dir, 'none.sock'), logLevel: 'error', ...config });
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

  /**
   * A browser request: the anti-CSRF header, a session cookie when there is
   * one, and a fresh client address so the rate limiters (which these tests
   * are not about) never interfere. `site` puts the request behind the
   * proxy at the panel's HTTPS domain.
   */
  const call = async <T>(method: string, path: string, options: { body?: unknown; cookie?: string | null; headers?: Record<string, string>; site?: string; bare?: boolean } = {}): Promise<Reply<T>> => {
    addresses += 1;
    const response = await app.request(
      path,
      {
        method,
        headers: {
          'user-agent': CHROME_MAC,
          'x-forwarded-for': `203.0.113.${(addresses % 250) + 1}`,
          ...(options.bare === true ? {} : { 'x-ploy-request': '1' }),
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...(options.site === undefined ? {} : { 'x-forwarded-host': options.site, 'x-forwarded-proto': 'https', origin: `https://${options.site}` }),
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      },
      BINDINGS,
    );
    const set = response.headers.getSetCookie().find((value) => value.startsWith('ploy_session=') && !value.startsWith('ploy_session=;'));
    return { status: response.status, body: (await response.json()) as T, cookie: set === undefined ? null : set.split(';')[0]! };
  };

  const signIn = async (email: string, site?: string): Promise<string> => {
    const reply = await call<LoginResultDto>('POST', '/api/auth/login', { body: { email, password: PASSWORD }, ...(site === undefined ? {} : { site }) });
    assert.equal(reply.status, 200);
    assert.ok(reply.cookie, 'a session cookie is set');
    return reply.cookie;
  };

  /** The whole registration as a browser does it: options (with the password), the authenticator, the answer. */
  const register = async (cookie: string, device: SoftAuthenticator, site?: string, name?: string): Promise<Reply<PasskeyDto & Failure>> => {
    const where = site === undefined ? {} : { site };
    const options = await call<PasskeyCreationOptionsDto>('POST', '/api/me/passkeys/options', { cookie, body: { password: PASSWORD }, ...where });
    assert.equal(options.status, 200, JSON.stringify(options.body));
    const { publicKey, ticket } = options.body;
    const origin = site === undefined ? 'http://localhost' : `https://${site}`;
    const credential = device.create({ challenge: publicKey.challenge, rpId: publicKey.rp.id, origin, userHandle: publicKey.user.id });
    return call<PasskeyDto & Failure>('POST', '/api/me/passkeys', { cookie, body: { ticket, credential, ...(name === undefined ? {} : { name }) }, ...where });
  };

  /** The whole sign-in: a challenge, the authenticator's answer (which `forge` may spoil), the verdict. */
  const passkeySignIn = async (device: SoftAuthenticator, options: { site?: string; forge?: Parameters<SoftAuthenticator['get']>[1]; mutate?: (credential: ReturnType<SoftAuthenticator['get']>) => unknown } = {}): Promise<Reply<{ ok?: boolean } & Failure>> => {
    const where = options.site === undefined ? {} : { site: options.site };
    const request = await call<PasskeyRequestOptionsDto>('POST', '/api/auth/passkey/options', where);
    assert.equal(request.status, 200, JSON.stringify(request.body));
    const origin = options.site === undefined ? 'http://localhost' : `https://${options.site}`;
    const credential = device.get({ challenge: request.body.publicKey.challenge, rpId: request.body.publicKey.rpId, origin }, options.forge);
    return call('POST', '/api/auth/passkey', { body: { ticket: request.body.ticket, credential: options.mutate?.(credential) ?? credential }, ...where });
  };

  const audits = (action: string): { metadata: Record<string, unknown>; userId: string | null }[] =>
    stores.db
      .all('SELECT user_id, metadata FROM audit_log WHERE action = ? ORDER BY rowid', action)
      .map((row) => ({ userId: row.user_id === null ? null : String(row.user_id), metadata: JSON.parse(String(row.metadata)) as Record<string, unknown> }));

  return {
    ctx,
    team,
    user,
    call,
    signIn,
    register,
    passkeySignIn,
    audits,
    close: async () => {
      await ctx.notifier.flush();
      stores.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('passkeys: registered from a signed-in browser after the password is confirmed, then signs in with no password and no TOTP code', async () => {
  const h = await harness();
  try {
    const { stores } = h.ctx;
    const sardor = h.user('sardor@acme.uz');
    const cookie = await h.signIn('sardor@acme.uz');

    // Localhost outside production is a place passkeys can exist; the bootstrap says so before anyone signs in.
    const boot = await h.call<BootstrapDto>('GET', '/api/bootstrap');
    assert.equal(boot.body.features.passkeys, true);
    const empty = await h.call<PasskeyListDto>('GET', '/api/me/passkeys', { cookie });
    assert.deepEqual(empty.body, { available: true, reason: null, origin: null, limit: LIMITS.passkeysMax, items: [] });

    // Options are handed out only against the account's password: a stolen session cannot plant a passkey.
    const noPassword = await h.call<Failure>('POST', '/api/me/passkeys/options', { cookie, body: {} });
    assert.equal(noPassword.status, 401);
    assert.equal(noPassword.body.error.code, 'invalid_credentials');
    assert.equal((await h.call('POST', '/api/me/passkeys/options', { cookie, body: { password: 'wrong' } })).status, 401);
    assert.equal((await h.call('POST', '/api/me/passkeys/options', { body: { password: PASSWORD } })).status, 401, 'no session, no options');

    const options = await h.call<PasskeyCreationOptionsDto>('POST', '/api/me/passkeys/options', { cookie, body: { password: PASSWORD } });
    assert.equal(options.status, 200);
    const { publicKey, ticket } = options.body;
    assert.deepEqual(publicKey.rp, { id: 'localhost', name: 'TorexPloy' });
    assert.equal(Buffer.from(publicKey.user.id, 'base64url').toString('utf8'), sardor.id, 'the user handle is the account id, not the email');
    assert.equal(publicKey.user.name, 'sardor@acme.uz');
    assert.deepEqual(publicKey.pubKeyCredParams.map((param) => param.alg), [-7, -257, -8]);
    assert.deepEqual(publicKey.authenticatorSelection, { residentKey: 'required', requireResidentKey: true, userVerification: 'required' });
    assert.equal(publicKey.attestation, 'none');
    assert.deepEqual(publicKey.excludeCredentials, []);
    assert.ok(Buffer.from(publicKey.challenge, 'base64url').length >= 32, 'the challenge carries at least 32 random bytes');

    const phone = new SoftAuthenticator({ synced: true, aaguid: 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd' });
    const credential = phone.create({ challenge: publicKey.challenge, rpId: 'localhost', origin: 'http://localhost', userHandle: publicKey.user.id });
    const added = await h.call<PasskeyDto>('POST', '/api/me/passkeys', { cookie, body: { ticket, credential } });
    assert.equal(added.status, 201);
    assert.equal(added.body.name, 'iCloud Keychain', 'a known provider names the passkey');
    assert.equal(added.body.synced, true);
    assert.equal(added.body.usableHere, true);
    assert.equal(added.body.rpId, 'localhost');
    assert.equal(added.body.lastUsedAt, null);
    assert.equal(Object.hasOwn(added.body, 'publicKey'), false, 'key material stays on the server');
    assert.deepEqual(h.audits('user.passkey_added').map((entry) => entry.metadata), [{ passkeyId: added.body.id, synced: true }]);

    // A ticket answers once; the same credential cannot be registered twice.
    const replay = await h.call<Failure>('POST', '/api/me/passkeys', { cookie, body: { ticket, credential } });
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error.params?.reason, 'passkey_expired');
    const again = await h.call<PasskeyCreationOptionsDto>('POST', '/api/me/passkeys/options', { cookie, body: { password: PASSWORD } });
    assert.deepEqual(again.body.publicKey.excludeCredentials, [{ type: 'public-key', id: phone.id, transports: ['internal', 'hybrid'] }], 'the authenticator is told what it already holds');
    const duplicate = await h.call<Failure>('POST', '/api/me/passkeys', {
      cookie,
      body: { ticket: again.body.ticket, credential: phone.create({ challenge: again.body.publicKey.challenge, rpId: 'localhost', origin: 'http://localhost' }) },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.params?.reason, 'passkey_exists');

    // A second device without a known provider is named after the browser, or as its owner says.
    const laptop = await h.register(cookie, new SoftAuthenticator({ algorithm: -257 }));
    assert.equal(laptop.body.name, 'Chrome, macOS');
    assert.equal(laptop.body.synced, false);
    const key = await h.register(cookie, new SoftAuthenticator({ algorithm: -8 }), undefined, '  YubiKey 5C  ');
    assert.equal(key.body.name, 'YubiKey 5C');

    // Signing in: no email, no password. The session it opens is a full one.
    const signedIn = await h.passkeySignIn(phone);
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    assert.deepEqual(signedIn.body, { ok: true });
    assert.ok(signedIn.cookie);
    assert.notEqual(signedIn.cookie, cookie, 'a new session, not the old one');
    const session = await h.call<{ userId: string }>('GET', '/api/auth/session', { cookie: signedIn.cookie });
    assert.equal(session.body.userId, sardor.id);
    const listed = await h.call<PasskeyListDto>('GET', '/api/me/passkeys', { cookie: signedIn.cookie });
    assert.deepEqual(listed.body.items.map((item) => item.name), ['iCloud Keychain', 'Chrome, macOS', 'YubiKey 5C']);
    assert.ok(listed.body.items[0]!.lastUsedAt, 'the passkey remembers when it last signed in');
    assert.equal(listed.body.items[1]!.lastUsedAt, null);
    assert.deepEqual(h.audits('auth.login').at(-1)?.metadata, { method: 'passkey', passkeyId: added.body.id });

    // With TOTP on, the password alone is not enough; the passkey still is (its owner was verified by the device).
    stores.users.setTotpPending(sardor.id, h.ctx.secrets.seal(generateTotpSecret(), 'totp'));
    stores.users.enableTotp(sardor.id, 0, []);
    const byPassword = await h.call<LoginResultDto>('POST', '/api/auth/login', { body: { email: 'sardor@acme.uz', password: PASSWORD } });
    assert.equal(byPassword.body.twoFactorRequired, true);
    assert.equal(byPassword.cookie, null);
    const byPasskey = await h.passkeySignIn(phone);
    assert.equal(byPasskey.status, 200);
    assert.ok(byPasskey.cookie);
  } finally {
    await h.close();
  }
});

test('passkey sign-in refuses what it cannot verify: unknown credentials, other sites, used tickets, clones, cross-site posts', async () => {
  const h = await harness();
  try {
    const sardor = h.user('sardor@acme.uz');
    h.user('aziza@acme.uz');
    const cookie = await h.signIn('sardor@acme.uz');
    const device = new SoftAuthenticator();
    assert.equal((await h.register(cookie, device)).status, 201);

    const refused = async (reply: Promise<{ status: number; body: Failure; cookie: string | null }>, reason: string): Promise<void> => {
      const result = await reply;
      assert.equal(result.status, 401, JSON.stringify(result.body));
      assert.equal(result.body.error.code, 'unauthorized');
      assert.equal(result.body.error.params?.reason, reason);
      assert.equal(result.cookie, null, 'no session on a refusal');
    };

    await refused(h.passkeySignIn(new SoftAuthenticator()), 'passkey_unknown');
    await refused(h.passkeySignIn(device, { forge: { origin: 'https://localhost.evil.test' } }), 'passkey_invalid');
    await refused(h.passkeySignIn(device, { forge: { rpId: 'evil.test' } }), 'passkey_invalid');
    await refused(h.passkeySignIn(device, { forge: { userVerified: false } }), 'passkey_invalid');
    await refused(h.passkeySignIn(device, { forge: { corruptSignature: true } }), 'passkey_invalid');
    await refused(h.passkeySignIn(device, { forge: { challenge: 'c29tZS1vdGhlci1jaGFsbGVuZ2U' } }), 'passkey_invalid');
    // The handle the authenticator returns must be the account the credential was registered to.
    await refused(h.passkeySignIn(device, { mutate: (credential) => ({ ...credential, response: { ...credential.response, userHandle: Buffer.from('usr_someoneelse').toString('base64url') } }) }), 'passkey_invalid');
    // Fields that pass the shape check but cannot be decoded are a refusal like any other, never a server error.
    await refused(h.passkeySignIn(device, { mutate: (credential) => ({ ...credential, response: { ...credential.response, userHandle: 'AAAAA' } }) }), 'passkey_invalid');
    await refused(h.passkeySignIn(device, { mutate: (credential) => ({ ...credential, response: { ...credential.response, signature: 'AAAAA' } }) }), 'passkey_invalid');
    await refused(h.passkeySignIn(device, { mutate: (credential) => ({ ...credential, response: { ...credential.response, authenticatorData: 'AAAAA' } }) }), 'passkey_invalid');
    assert.deepEqual(
      h.audits('auth.login_failed').slice(0, 7).map((entry) => [entry.userId === sardor.id, entry.metadata.reason]),
      [[false, 'passkey_unknown'], [true, 'origin'], [true, 'rp_id'], [true, 'user_verification'], [true, 'signature'], [true, 'challenge'], [true, 'user_handle']],
      'each refusal is in the audit log with what was wrong',
    );

    // A good answer, then the same ticket again: a challenge is spent by its first answer, right or wrong.
    const request = await h.call<PasskeyRequestOptionsDto>('POST', '/api/auth/passkey/options');
    const credential = device.get({ challenge: request.body.publicKey.challenge, rpId: 'localhost', origin: 'http://localhost' });
    assert.equal((await h.call('POST', '/api/auth/passkey', { body: { ticket: request.body.ticket, credential } })).status, 200);
    const reused = await h.call<Failure>('POST', '/api/auth/passkey', { body: { ticket: request.body.ticket, credential } });
    assert.equal(reused.status, 400);
    assert.equal(reused.body.error.params?.reason, 'passkey_expired');
    // A registration ticket is not a sign-in ticket.
    const registration = await h.call<PasskeyCreationOptionsDto>('POST', '/api/me/passkeys/options', { cookie, body: { password: PASSWORD } });
    const crossed = await h.call<Failure>('POST', '/api/auth/passkey', { body: { ticket: registration.body.ticket, credential: device.get({ challenge: registration.body.publicKey.challenge, rpId: 'localhost', origin: 'http://localhost' }) } });
    assert.equal(crossed.body.error.params?.reason, 'passkey_expired');

    // The counter went 1 (registration), then up with every assertion; an answer that does not advance it is a copy of the key.
    device.rewindCounter();
    device.rewindCounter();
    await refused(h.passkeySignIn(device), 'passkey_counter');

    // Another site cannot drive the sign-in endpoints: no custom header, or the wrong Origin.
    for (const path of ['/api/auth/passkey/options', '/api/auth/passkey']) {
      const bare = await h.call<Failure>('POST', path, { bare: true, body: {} });
      assert.equal(bare.status, 403);
      assert.equal(bare.body.error.code, 'csrf_failed');
      assert.equal((await h.call<Failure>('POST', path, { body: {}, headers: { origin: 'https://evil.test' } })).body.error.code, 'csrf_failed');
    }
    // Malformed input is a validation error, not a crash.
    const malformed = await h.call<Failure>('POST', '/api/auth/passkey', { body: { ticket: request.body.ticket, credential: { id: 'not base64url!', type: 'public-key', response: {} } } });
    assert.equal(malformed.status, 422);
  } finally {
    await h.close();
  }
});

test('in production passkeys exist only at the panel domain over HTTPS, and a passkey is bound to the host it was made on', async () => {
  const h = await harness({ env: 'production' });
  try {
    const { stores } = h.ctx;
    h.user('sardor@acme.uz');
    const SITE = 'deploy.example.uz';

    // No domain: the panel is reached by IP, where browsers offer no passkeys.
    const cookie = await h.signIn('sardor@acme.uz');
    assert.equal((await h.call<BootstrapDto>('GET', '/api/bootstrap')).body.features.passkeys, false);
    const none = await h.call<PasskeyListDto>('GET', '/api/me/passkeys', { cookie });
    assert.deepEqual([none.body.available, none.body.reason, none.body.origin], [false, 'no_domain', null]);
    const noOptions = await h.call<Failure>('POST', '/api/me/passkeys/options', { cookie, body: { password: PASSWORD } });
    assert.equal(noOptions.status, 409);
    assert.equal(noOptions.body.error.params?.reason, 'passkey_no_domain');
    const noLogin = await h.call<Failure>('POST', '/api/auth/passkey/options');
    assert.equal(noLogin.status, 409);
    assert.equal(noLogin.body.error.params?.reason, 'passkey_no_domain');

    // With a panel domain: available there, and elsewhere the answer says where.
    stores.settings.updatePlatform({ platformDomain: SITE });
    const elsewhere = await h.call<PasskeyListDto>('GET', '/api/me/passkeys', { cookie });
    assert.deepEqual([elsewhere.body.available, elsewhere.body.reason, elsewhere.body.origin], [false, 'other_origin', `https://${SITE}`]);
    const wrongPlace = await h.call<Failure>('POST', '/api/auth/passkey/options');
    assert.deepEqual([wrongPlace.body.error.params?.reason, wrongPlace.body.error.params?.origin], ['passkey_other_origin', `https://${SITE}`]);
    // Another hostname that reaches the same panel is not the panel domain either.
    assert.equal((await h.call<BootstrapDto>('GET', '/api/bootstrap', { site: 'alias.example.uz' })).body.features.passkeys, false);

    assert.equal((await h.call<BootstrapDto>('GET', '/api/bootstrap', { site: SITE })).body.features.passkeys, true);
    const there = await h.signIn('sardor@acme.uz', SITE);
    const device = new SoftAuthenticator();
    const added = await h.register(there, device, SITE);
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.rpId, SITE);
    assert.equal(added.body.usableHere, true);
    const signedIn = await h.passkeySignIn(device, { site: SITE });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    assert.match(String(signedIn.cookie), /^ploy_session=/);

    // Seen from the IP address the passkey is listed, but marked as unusable there.
    const fromIp = await h.call<PasskeyListDto>('GET', '/api/me/passkeys', { cookie });
    assert.deepEqual(fromIp.body.items.map((item) => [item.rpId, item.usableHere]), [[SITE, false]]);

    // The panel moves to a new domain: the old passkey belongs to the old host and no longer signs in.
    stores.settings.updatePlatform({ platformDomain: 'panel.example.uz' });
    const moved = await h.passkeySignIn(device, { site: 'panel.example.uz' });
    assert.equal(moved.status, 401);
    assert.equal(moved.body.error.params?.reason, 'passkey_unknown');
    const afterMove = await h.call<PasskeyListDto>('GET', '/api/me/passkeys', { cookie: there, site: 'panel.example.uz' });
    assert.deepEqual([afterMove.body.available, afterMove.body.items[0]!.usableHere], [true, false]);
  } finally {
    await h.close();
  }
});

test('an explicit public URL decides too: plain HTTP and IP addresses cannot hold passkeys', async () => {
  for (const [publicUrl, reason] of [
    ['http://deploy.example.uz', 'insecure'],
    ['https://203.0.113.7', 'no_domain'],
    ['http://203.0.113.7:3000', 'no_domain'],
  ] as const) {
    const h = await harness({ env: 'production', publicUrl });
    try {
      h.user('sardor@acme.uz');
      const cookie = await h.signIn('sardor@acme.uz');
      const list = await h.call<PasskeyListDto>('GET', '/api/me/passkeys', { cookie });
      assert.deepEqual([list.body.available, list.body.reason], [false, reason], publicUrl);
    } finally {
      await h.close();
    }
  }
});

test('passkeys belong to one account: renaming and removing touch only one’s own, API tokens cannot manage them, ten is the limit', async () => {
  const h = await harness();
  try {
    const { stores } = h.ctx;
    const sardor = h.user('sardor@acme.uz');
    const aziza = h.user('aziza@acme.uz');
    const cookie = await h.signIn('sardor@acme.uz');
    const other = await h.signIn('aziza@acme.uz');
    const device = new SoftAuthenticator();
    const mine = (await h.register(cookie, device)).body;
    const theirs = (await h.register(other, new SoftAuthenticator())).body;

    const renamed = await h.call<PasskeyDto>('PATCH', `/api/me/passkeys/${mine.id}`, { cookie, body: { name: 'Ish noutbuki' } });
    assert.equal(renamed.body.name, 'Ish noutbuki');
    assert.equal((await h.call('PATCH', `/api/me/passkeys/${mine.id}`, { cookie, body: { name: '   ' } })).status, 422);
    assert.equal((await h.call('PATCH', `/api/me/passkeys/${mine.id}`, { cookie, body: { name: 'x'.repeat(LIMITS.passkeyNameMax + 1) } })).status, 422);
    // Someone else's passkey does not exist as far as this account can tell.
    assert.equal((await h.call('PATCH', `/api/me/passkeys/${theirs.id}`, { cookie, body: { name: 'mine now' } })).status, 404);
    assert.equal((await h.call('DELETE', `/api/me/passkeys/${theirs.id}`, { cookie })).status, 404);
    assert.equal(stores.passkeys.get(theirs.id)?.name, theirs.name);
    assert.deepEqual((await h.call<PasskeyListDto>('GET', '/api/me/passkeys', { cookie })).body.items.map((item) => item.id), [mine.id]);

    // An API token acts for automation; it may look, but not change how the account is entered.
    const token = stores.tokens.create({ userId: sardor.id, teamId: h.team.id, name: 'ci', expiresAt: null, tokenPrefix: API_TOKEN_PREFIX }).token;
    const bearer = { authorization: `Bearer ${token}` };
    assert.equal((await h.call<PasskeyListDto>('GET', '/api/me/passkeys', { headers: bearer })).body.items.length, 1);
    for (const [method, path, body] of [
      ['POST', '/api/me/passkeys/options', { password: PASSWORD }],
      ['POST', '/api/me/passkeys', {}],
      ['PATCH', `/api/me/passkeys/${mine.id}`, { name: 'x' }],
      ['DELETE', `/api/me/passkeys/${mine.id}`, undefined],
    ] as const) {
      const reply = await h.call<Failure>(method, path, { headers: bearer, ...(body === undefined ? {} : { body }) });
      assert.equal(reply.status, 403, `${method} ${path}`);
      assert.equal(reply.body.error.params?.reason, 'passkey_session');
    }

    // Ten passkeys per account.
    for (let index = 1; index < LIMITS.passkeysMax; index += 1) {
      stores.passkeys.create({ userId: sardor.id, credentialId: `filler-${index}`, publicKey: { algorithm: -7, jwk: {} }, signCount: 0, transports: [], aaguid: null, rpId: 'localhost', backupEligible: false, backedUp: false, name: `Filler ${index}` });
    }
    const full = await h.call<Failure>('POST', '/api/me/passkeys/options', { cookie, body: { password: PASSWORD } });
    assert.equal(full.status, 409);
    assert.deepEqual([full.body.error.params?.reason, full.body.error.params?.maximum], ['passkey_limit', LIMITS.passkeysMax]);

    // Removing a passkey ends its sign-ins at once; the others keep working.
    assert.equal((await h.call('DELETE', `/api/me/passkeys/${mine.id}`, { cookie })).status, 200);
    assert.deepEqual(h.audits('user.passkey_removed').map((entry) => entry.metadata), [{ passkeyId: mine.id }]);
    const gone = await h.passkeySignIn(device);
    assert.equal(gone.status, 401);
    assert.equal(gone.body.error.params?.reason, 'passkey_unknown');

    // Deleting the account takes its passkeys with it.
    stores.users.delete(aziza.id);
    assert.equal(stores.passkeys.get(theirs.id), undefined);
  } finally {
    await h.close();
  }
});
