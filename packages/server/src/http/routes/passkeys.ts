/**
 * Passkeys: registering them from a signed-in browser, and signing in with one.
 *
 * A passkey is bound to the host it was created on, so the first question
 * of every request is whether this address is one passkeys can exist at
 * ({@link passkeyScope}): the panel's own HTTPS domain, or localhost outside
 * production. Anything else (an IP address, plain HTTP, a second hostname)
 * is refused with the reason, which the dashboard turns into "open the
 * panel at …".
 *
 * Both ceremonies are two requests: one asks for options and gets a ticket
 * with a fresh challenge, the other returns the browser's answer under that
 * ticket. A ticket is single use and short lived, and remembers the origin
 * and (for registration) the user it was issued to.
 *
 * Signing in with a passkey does not ask for the TOTP code: the
 * authenticator verified its owner (biometrics or the device PIN), which is
 * possession and a second factor in one step.
 *
 * The same assertion, made on a session that is already signed in, confirms
 * its owner in place of the password (`stepup.ts`): the way in for someone
 * who forgot the password but still holds a passkey.
 */
import type { Hono } from 'hono';
import { isIP } from 'node:net';
import {
  LIMITS,
  passkeyLoginSchema,
  passkeyRegisterOptionsSchema,
  passkeyRegisterSchema,
  renamePasskeySchema,
  type PasskeyCreationOptionsDto,
  type PasskeyDto,
  type PasskeyListDto,
  type PasskeyRequestOptionsDto,
  type PasskeyUnavailableReason,
} from '@ploy/shared';
import type { Context } from '../../context.ts';
import { publicBaseUrl } from '../../github/app.ts';
import { generateToken } from '../../lib/crypto.ts';
import { AppError, notFound } from '../../lib/errors.ts';
import { PASSKEY_ALGORITHMS, toBase64Url, verifyAssertion, verifyRegistration, WebAuthnError } from '../../lib/webauthn.ts';
import type { PasskeyRecord, UserRecord } from '../../store/index.ts';
import { audit, body, limit, RateLimiter, requestOrigin, requireAuth, setSessionCookie, type Auth, type Ctx, type Env } from '../core.ts';
import { confirmOwner } from '../stepup.ts';

export type PasskeyScope = { available: true; rpId: string; origin: string } | { available: false; reason: PasskeyUnavailableReason; origin: string | null };

/**
 * Whether passkeys can be used at the address this request came in on, and
 * the relying party they are bound to there. The trusted origin is what the
 * instance is configured with, never what a request claims: a response made
 * on a look-alike site then fails the origin check instead of defining it.
 */
export function passkeyScope(ctx: Context, c: Ctx): PasskeyScope {
  const here = requestOrigin(c);
  let host = '';
  try {
    host = new URL(here).hostname;
  } catch {
    host = '';
  }
  // Browsers treat http://localhost as a secure context: that is how the panel is developed and tested.
  if (host === 'localhost' && ctx.config.env !== 'production') return { available: true, rpId: 'localhost', origin: here };

  const panel = publicBaseUrl(ctx);
  if (panel === null) return { available: false, reason: 'no_domain', origin: null };
  const url = new URL(panel);
  // A relying party id is a domain; WebAuthn has no notion of an IP address.
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) return { available: false, reason: 'no_domain', origin: null };
  if (url.protocol !== 'https:') return { available: false, reason: 'insecure', origin: null };
  if (here !== url.origin) return { available: false, reason: 'other_origin', origin: url.origin };
  return { available: true, rpId: url.hostname, origin: url.origin };
}

const UNAVAILABLE_TEXT: Record<PasskeyUnavailableReason, string> = {
  no_domain: 'Passkeys need the panel to have a domain with HTTPS. Set the panel domain first.',
  insecure: 'Passkeys need HTTPS: the configured panel address is plain HTTP.',
  other_origin: 'Passkeys work only at the panel domain. Open the panel there.',
};

function requireScope(ctx: Context, c: Ctx): Extract<PasskeyScope, { available: true }> {
  const scope = passkeyScope(ctx, c);
  if (!scope.available) {
    throw new AppError('conflict', UNAVAILABLE_TEXT[scope.reason], { params: { reason: `passkey_${scope.reason}`, ...(scope.origin === null ? {} : { origin: scope.origin }) } });
  }
  return scope;
}

/** Password managers and platforms by the AAGUID they register with: a first name for the passkey, which its owner can change. */
const PROVIDERS: Record<string, string> = {
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome (macOS)',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud Keychain',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
};

/** "Chrome, macOS" from a User-Agent: enough to tell one's own devices apart. */
function describeAgent(agent: string | undefined): string | null {
  if (agent === undefined || agent.length === 0) return null;
  const browser = /Edg\//.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chrome' : /Firefox\//.test(agent) ? 'Firefox' : /Safari\//.test(agent) ? 'Safari' : null;
  const os = /iPhone|iPad/.test(agent) ? 'iOS' : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'macOS' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : null;
  if (browser === null) return os;
  return os === null ? browser : `${browser}, ${os}`;
}

/** The handle an authenticator stores with the credential and returns at sign-in: the user id, not the email. */
const userHandle = (user: UserRecord): string => toBase64Url(Buffer.from(user.id, 'utf8'));

interface Ceremony {
  /** `confirm` is a sign-in assertion asked of an account that is already signed in. */
  kind: 'register' | 'login' | 'confirm';
  challenge: string;
  rpId: string;
  origin: string;
  /** Registration and confirmation: who asked. */
  userId: string | null;
  expiresAt: number;
}

const CEREMONY_TTL_MS = 5 * 60_000;
const CEREMONIES_MAX = 20_000;

export function registerPasskeyRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;
  const ceremonies = new Map<string, Ceremony>();
  const optionsLimiter = new RateLimiter(30, 30);
  const loginLimiter = new RateLimiter(10, 10);
  const sensitive = new RateLimiter(10, 10);

  const openCeremony = (ceremony: Omit<Ceremony, 'expiresAt' | 'challenge'>): { ticket: string; challenge: string } => {
    const now = Date.now();
    if (ceremonies.size >= CEREMONIES_MAX / 2) for (const [key, value] of ceremonies) if (value.expiresAt < now) ceremonies.delete(key);
    // Still full of live tickets: someone is flooding the endpoint. Refusing new ones beats growing without bound.
    if (ceremonies.size >= CEREMONIES_MAX) throw new AppError('rate_limited', 'Too many sign-in attempts are in flight. Try again in a minute.');
    const ticket = generateToken(24);
    const challenge = generateToken(32);
    ceremonies.set(ticket, { ...ceremony, challenge, expiresAt: now + CEREMONY_TTL_MS });
    return { ticket, challenge };
  };

  /** A ticket answers once, whatever the outcome: a wrong answer cannot be retried against the same challenge. */
  const takeCeremony = (ticket: string, kind: Ceremony['kind']): Ceremony => {
    const ceremony = ceremonies.get(ticket);
    ceremonies.delete(ticket);
    if (ceremony === undefined || ceremony.kind !== kind || ceremony.expiresAt < Date.now()) {
      throw new AppError('bad_request', 'The passkey request expired. Try again.', { params: { reason: 'passkey_expired' } });
    }
    return ceremony;
  };

  /** Passkeys change how an account is entered: that takes a signed-in browser, not an API token. */
  const requireSession = (c: Ctx): Auth => {
    const auth = requireAuth(c);
    if (auth.sessionId === null) throw new AppError('forbidden', 'Passkeys are managed from a signed-in browser, not with an API token', { params: { reason: 'passkey_session' } });
    return auth;
  };

  /**
   * The sign-in endpoints carry no session, so the CSRF middleware has
   * nothing to protect; without this check another site could still post a
   * passkey answer of its own and sign the visitor into the wrong account.
   */
  const requireSameSite = (c: Ctx): void => {
    if (c.req.header('x-ploy-request') !== '1') throw new AppError('csrf_failed', 'Missing request header');
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== requestOrigin(c)) throw new AppError('csrf_failed', 'Cross-origin request rejected');
  };

  const toDto = (passkey: PasskeyRecord, scope: PasskeyScope): PasskeyDto => ({
    id: passkey.id,
    name: passkey.name,
    rpId: passkey.rpId,
    usableHere: scope.available && scope.rpId === passkey.rpId,
    synced: passkey.backedUp,
    createdAt: passkey.createdAt,
    lastUsedAt: passkey.lastUsedAt,
  });

  const ownPasskey = (c: Ctx, auth: Auth): PasskeyRecord => {
    const passkey = stores.passkeys.get(c.req.param('id') ?? '');
    if (passkey === undefined || passkey.userId !== auth.user.id) throw notFound('Passkey');
    return passkey;
  };

  // ------------------------------------------------------------ management

  app.get('/api/me/passkeys', (c) => {
    const auth = requireAuth(c);
    const scope = passkeyScope(ctx, c);
    const list: PasskeyListDto = {
      available: scope.available,
      reason: scope.available ? null : scope.reason,
      origin: scope.available ? null : scope.origin,
      limit: LIMITS.passkeysMax,
      items: stores.passkeys.listForUser(auth.user.id).map((passkey) => toDto(passkey, scope)),
    };
    return c.json(list);
  });

  app.post('/api/me/passkeys/options', async (c) => {
    limit(sensitive, c, 'passkey');
    const auth = requireSession(c);
    const scope = requireScope(ctx, c);
    const input = await body(c, passkeyRegisterOptionsSchema);
    const user = stores.users.getById(auth.user.id)!;
    // A stolen session must not be enough to plant a way back in that survives a password change:
    // the password, or a confirmation of the owner made on this session a moment ago.
    await confirmOwner(ctx, auth, input.password);
    const existing = stores.passkeys.listForUser(user.id);
    if (existing.length >= LIMITS.passkeysMax) {
      throw new AppError('conflict', `An account can have at most ${LIMITS.passkeysMax} passkeys. Remove one first.`, { params: { reason: 'passkey_limit', maximum: LIMITS.passkeysMax } });
    }
    const { ticket, challenge } = openCeremony({ kind: 'register', rpId: scope.rpId, origin: scope.origin, userId: user.id });
    const options: PasskeyCreationOptionsDto = {
      ticket,
      publicKey: {
        rp: { id: scope.rpId, name: 'TorexPloy' },
        user: { id: userHandle(user), name: user.email, displayName: user.name },
        challenge,
        pubKeyCredParams: PASSKEY_ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
        timeout: 120_000,
        attestation: 'none',
        // The authenticator refuses to create a second passkey for this account on itself.
        excludeCredentials: existing.filter((passkey) => passkey.rpId === scope.rpId).map((passkey) => ({ type: 'public-key', id: passkey.credentialId, ...(passkey.transports.length > 0 ? { transports: passkey.transports } : {}) })),
        // Discoverable, so signing in needs no email; verified, so it needs no second factor.
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      },
    };
    return c.json(options);
  });

  app.post('/api/me/passkeys', async (c) => {
    limit(sensitive, c, 'passkey');
    const auth = requireSession(c);
    const scope = requireScope(ctx, c);
    const input = await body(c, passkeyRegisterSchema);
    const ceremony = takeCeremony(input.ticket, 'register');
    if (ceremony.userId !== auth.user.id || ceremony.rpId !== scope.rpId) {
      throw new AppError('bad_request', 'The passkey request expired. Try again.', { params: { reason: 'passkey_expired' } });
    }

    let registered: ReturnType<typeof verifyRegistration>;
    try {
      registered = verifyRegistration(input.credential.response, ceremony);
    } catch (error) {
      if (!(error instanceof WebAuthnError)) throw error;
      throw new AppError('bad_request', `The passkey could not be verified: ${error.message}`, { params: { reason: 'passkey_invalid', detail: error.reason } });
    }
    if (registered.credentialId !== input.credential.id) {
      throw new AppError('bad_request', 'The passkey could not be verified: the credential id does not match', { params: { reason: 'passkey_invalid', detail: 'credential' } });
    }
    if (stores.passkeys.getByCredentialId(registered.credentialId) !== undefined) {
      throw new AppError('conflict', 'This passkey is already registered', { params: { reason: 'passkey_exists' } });
    }
    if (stores.passkeys.countForUser(auth.user.id) >= LIMITS.passkeysMax) {
      throw new AppError('conflict', `An account can have at most ${LIMITS.passkeysMax} passkeys. Remove one first.`, { params: { reason: 'passkey_limit', maximum: LIMITS.passkeysMax } });
    }

    const passkey = stores.passkeys.create({
      userId: auth.user.id,
      credentialId: registered.credentialId,
      publicKey: registered.publicKey,
      signCount: registered.signCount,
      transports: [...new Set(input.credential.response.transports ?? [])],
      aaguid: registered.aaguid,
      rpId: scope.rpId,
      backupEligible: registered.backupEligible,
      backedUp: registered.backedUp,
      name: input.name ?? PROVIDERS[registered.aaguid] ?? describeAgent(c.req.header('user-agent')) ?? 'Passkey',
    });
    audit(ctx, c, 'user.passkey_added', { type: 'user', id: auth.user.id, name: passkey.name }, { passkeyId: passkey.id, synced: passkey.backedUp });
    return c.json(toDto(passkey, scope), 201);
  });

  app.patch('/api/me/passkeys/:id', async (c) => {
    const auth = requireSession(c);
    const passkey = ownPasskey(c, auth);
    const input = await body(c, renamePasskeySchema);
    stores.passkeys.rename(passkey.id, input.name);
    return c.json(toDto(stores.passkeys.get(passkey.id)!, passkeyScope(ctx, c)));
  });

  app.delete('/api/me/passkeys/:id', (c) => {
    const auth = requireSession(c);
    const passkey = ownPasskey(c, auth);
    stores.passkeys.delete(passkey.id);
    audit(ctx, c, 'user.passkey_removed', { type: 'user', id: auth.user.id, name: passkey.name }, { passkeyId: passkey.id });
    return c.json({ ok: true });
  });

  // ------------------------------------------------ assertions (shared)

  type Refusal = 'passkey_unknown' | 'passkey_invalid' | 'passkey_counter';

  /**
   * Check an answer to `navigator.credentials.get()` against the stored
   * credential it names and record the use. Returns the passkey and its
   * owner, or why it was refused (with the account, when the credential is
   * known, for the audit log). `expectedUser` narrows it to one account.
   */
  const checkAssertion = (
    credential: { id: string; response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null | undefined } },
    ceremony: Ceremony,
    scope: Extract<PasskeyScope, { available: true }>,
    expectedUser?: string,
  ): { ok: true; passkey: PasskeyRecord; user: UserRecord } | { ok: false; reason: Refusal; detail: string; user: UserRecord | undefined } => {
    const passkey = stores.passkeys.getByCredentialId(credential.id);
    const user = passkey === undefined ? undefined : stores.users.getById(passkey.userId);
    if (passkey === undefined || user === undefined || passkey.rpId !== scope.rpId || ceremony.rpId !== scope.rpId || (expectedUser !== undefined && user.id !== expectedUser)) {
      return { ok: false, reason: 'passkey_unknown', detail: 'passkey_unknown', user: expectedUser === undefined || user?.id === expectedUser ? user : undefined };
    }
    // The handle the authenticator stored must be the account the credential belongs to (compared in the canonical encoding it was issued in).
    const handle = credential.response.userHandle;
    if (handle !== undefined && handle !== null && handle !== userHandle(user)) return { ok: false, reason: 'passkey_invalid', detail: 'user_handle', user };
    try {
      const verified = verifyAssertion(credential.response, ceremony, passkey);
      stores.passkeys.markUsed(passkey.id, verified.signCount, verified.backedUp);
      return { ok: true, passkey, user };
    } catch (error) {
      if (!(error instanceof WebAuthnError)) throw error;
      return { ok: false, reason: error.reason === 'counter' ? 'passkey_counter' : 'passkey_invalid', detail: error.reason, user };
    }
  };

  const REFUSAL_TEXT: Record<Refusal, string> = {
    passkey_unknown: 'This passkey is not registered here. It may have been removed.',
    passkey_invalid: 'The passkey could not be verified',
    passkey_counter: 'This passkey was used somewhere else since it was last seen here. Remove it and register it again.',
  };

  // --------------------------------------------------------------- sign-in

  app.post('/api/auth/passkey/options', (c) => {
    requireSameSite(c);
    limit(optionsLimiter, c, 'passkey-options');
    const scope = requireScope(ctx, c);
    const { ticket, challenge } = openCeremony({ kind: 'login', rpId: scope.rpId, origin: scope.origin, userId: null });
    const options: PasskeyRequestOptionsDto = { ticket, publicKey: { rpId: scope.rpId, challenge, timeout: 120_000, userVerification: 'required' } };
    return c.json(options);
  });

  app.post('/api/auth/passkey', async (c) => {
    requireSameSite(c);
    limit(loginLimiter, c, 'passkey-login');
    const scope = requireScope(ctx, c);
    const input = await body(c, passkeyLoginSchema);
    const ceremony = takeCeremony(input.ticket, 'login');

    const result = checkAssertion(input.credential, ceremony, scope);
    if (!result.ok) {
      stores.audit.record({
        teamId: null,
        userId: result.user?.id ?? null,
        action: 'auth.login_failed',
        targetType: 'user',
        targetName: result.user?.email ?? null,
        ip: c.get('ip'),
        metadata: { method: 'passkey', reason: result.detail },
      });
      throw new AppError('unauthorized', REFUSAL_TEXT[result.reason], { params: { reason: result.reason } });
    }
    const { user, passkey } = result;
    const { token } = stores.sessions.create(user.id, c.req.header('user-agent') ?? null, c.get('ip'));
    stores.users.markLogin(user.id);
    setSessionCookie(c, token);
    stores.audit.record({ teamId: user.currentTeamId, userId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, ip: c.get('ip'), metadata: { method: 'passkey', passkeyId: passkey.id } });
    return c.json({ ok: true });
  });

  // ------------------------------------------- confirming a session's owner

  app.post('/api/me/step-up/passkey/options', (c) => {
    limit(sensitive, c, 'step-up');
    const auth = requireSession(c);
    const scope = requireScope(ctx, c);
    const own = stores.passkeys.listForUser(auth.user.id).filter((passkey) => passkey.rpId === scope.rpId);
    if (own.length === 0) throw new AppError('conflict', 'This account has no passkey for this address', { params: { reason: 'passkey_none' } });
    const { ticket, challenge } = openCeremony({ kind: 'confirm', rpId: scope.rpId, origin: scope.origin, userId: auth.user.id });
    const options: PasskeyRequestOptionsDto = {
      ticket,
      publicKey: {
        rpId: scope.rpId,
        challenge,
        timeout: 120_000,
        userVerification: 'required',
        // The account is known here, so the browser offers its passkeys and no one else's.
        allowCredentials: own.map((passkey) => ({ type: 'public-key', id: passkey.credentialId, ...(passkey.transports.length > 0 ? { transports: passkey.transports } : {}) })),
      },
    };
    return c.json(options);
  });

  app.post('/api/me/step-up/passkey', async (c) => {
    limit(sensitive, c, 'step-up');
    const auth = requireSession(c);
    const scope = requireScope(ctx, c);
    const input = await body(c, passkeyLoginSchema);
    const ceremony = takeCeremony(input.ticket, 'confirm');
    if (ceremony.userId !== auth.user.id) throw new AppError('bad_request', 'The passkey request expired. Try again.', { params: { reason: 'passkey_expired' } });

    const result = checkAssertion(input.credential, ceremony, scope, auth.user.id);
    if (!result.ok) {
      audit(ctx, c, 'user.identity_confirmation_failed', { type: 'user', id: auth.user.id }, { method: 'passkey', reason: result.detail });
      throw new AppError('unauthorized', REFUSAL_TEXT[result.reason], { params: { reason: result.reason } });
    }
    const grant = ctx.stepUps.grant(auth.sessionId!, 'passkey');
    audit(ctx, c, 'user.identity_confirmed', { type: 'user', id: auth.user.id }, { method: 'passkey', passkeyId: result.passkey.id });
    return c.json({ active: true, method: grant.method, expiresAt: new Date(grant.until).toISOString() });
  });
}
