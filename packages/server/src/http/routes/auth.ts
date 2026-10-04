/**
 * Setup, sign-in (password + TOTP, or GitHub), sign-out and invitations.
 */
import type { Hono } from 'hono';
import { acceptInvitationSchema, loginSchema, setupSchema, twoFactorLoginSchema, type BootstrapDto, type InvitationPreviewDto } from '@ploy/shared';
import { availableBuilders } from '../../build/tools.ts';
import type { Context } from '../../context.ts';
import { dummyPasswordDigest, generateToken, hashPassword, passwordNeedsRehash, sha256, verifyPassword, verifyTotp } from '../../lib/crypto.ts';
import { AppError } from '../../lib/errors.ts';
import { audit, body, clearSessionCookie, limit, RateLimiter, requireAuth, setSessionCookie, type Ctx, type Env } from '../core.ts';
import { teamDto, userDto } from '../dto.ts';

const TICKET_TTL_MS = 5 * 60_000;
const TICKET_ATTEMPTS = 5;

interface LoginTicket {
  userId: string;
  expiresAt: number;
  attempts: number;
}

export function bootstrapDto(ctx: Context, c: Ctx): BootstrapDto {
  const auth = c.get('auth');
  const user = auth?.user ?? null;
  return {
    version: ctx.config.version,
    setupRequired: ctx.stores.users.count() === 0,
    user: user === null ? null : userDto(user, ctx.stores.users.getIdentityLogin(user.id, 'github')),
    teams: user === null ? [] : ctx.stores.teams.listForUser(user.id).map(teamDto),
    currentTeamId: auth?.teamId ?? null,
    features: { githubLogin: ctx.github.credentials() !== null, builders: availableBuilders() },
  };
}

/** Normalize a recovery code as typed (`ABCD-1234`, `abcd1234`) before hashing. */
function recoveryHash(code: string): string {
  return sha256(code.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

export function registerAuthRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;
  const tickets = new Map<string, LoginTicket>();
  const loginLimiter = new RateLimiter(10, 10);
  const emailLimiter = new RateLimiter(8, 4);

  const startSession = (c: Ctx, userId: string): void => {
    const { token } = stores.sessions.create(userId, c.req.header('user-agent') ?? null, c.get('ip'));
    stores.users.markLogin(userId);
    setSessionCookie(c, token);
  };

  app.get('/api/bootstrap', (c) => c.json(bootstrapDto(ctx, c)));

  // ------------------------------------------------------------------ setup

  app.post('/api/setup', async (c) => {
    limit(loginLimiter, c, 'setup');
    const input = await body(c, setupSchema);
    const passwordHash = await hashPassword(input.password);
    const user = stores.db.transaction(() => {
      if (stores.users.count() > 0) throw new AppError('already_setup', 'This instance is already set up');
      const created = stores.users.create({ email: input.email, name: input.name, passwordHash, locale: input.locale ?? 'uz', isInstanceAdmin: true });
      const team = stores.teams.create(input.teamName);
      stores.teams.addMember(team.id, created.id, 'owner');
      stores.users.update(created.id, { currentTeamId: team.id });
      return created;
    });
    startSession(c, user.id);
    stores.audit.record({ teamId: stores.users.getById(user.id)!.currentTeamId, userId: user.id, action: 'instance.setup', targetType: 'user', targetId: user.id, targetName: user.email, ip: c.get('ip') });
    // The control plane's own host becomes the first server.
    void ctx.servers.bootstrapLocal().catch(() => undefined);
    return c.json({ ok: true }, 201);
  });

  // ------------------------------------------------------------------ login

  app.post('/api/auth/login', async (c) => {
    limit(loginLimiter, c, 'login');
    const input = await body(c, loginSchema);
    if (!emailLimiter.take(`email:${input.email}`)) throw new AppError('rate_limited', 'Too many attempts for this account. Wait a few minutes.');

    const user = stores.users.getByEmail(input.email);
    // Same cost whether or not the account exists, so timing reveals nothing.
    const valid = await verifyPassword(input.password, user?.passwordHash ?? (await dummyPasswordDigest()));
    if (user === undefined || user.passwordHash === null || !valid) {
      stores.audit.record({ teamId: null, userId: user?.id ?? null, action: 'auth.login_failed', targetType: 'user', targetName: input.email, ip: c.get('ip') });
      throw new AppError('invalid_credentials', 'Email or password is incorrect');
    }
    if (passwordNeedsRehash(user.passwordHash)) stores.users.setPasswordHash(user.id, await hashPassword(input.password));

    if (user.totpEnabled) {
      const ticket = generateToken(24);
      tickets.set(ticket, { userId: user.id, expiresAt: Date.now() + TICKET_TTL_MS, attempts: 0 });
      return c.json({ twoFactorRequired: true, ticket });
    }
    startSession(c, user.id);
    stores.audit.record({ teamId: user.currentTeamId, userId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, ip: c.get('ip') });
    return c.json({ twoFactorRequired: false });
  });

  app.post('/api/auth/login/2fa', async (c) => {
    limit(loginLimiter, c, 'login-2fa');
    const input = await body(c, twoFactorLoginSchema);
    const ticket = tickets.get(input.ticket);
    if (ticket === undefined || ticket.expiresAt < Date.now()) {
      tickets.delete(input.ticket);
      throw new AppError('unauthorized', 'Sign-in session expired. Enter your password again.');
    }
    ticket.attempts += 1;
    if (ticket.attempts > TICKET_ATTEMPTS) {
      tickets.delete(input.ticket);
      throw new AppError('rate_limited', 'Too many incorrect codes. Sign in again.');
    }
    const user = stores.users.getById(ticket.userId);
    if (user === undefined || !user.totpEnabled || user.totpSecret === null) throw new AppError('unauthorized', 'Sign in again');

    const code = input.code.replace(/\s/g, '');
    let ok = false;
    if (/^\d{6}$/.test(code)) {
      const counter = verifyTotp(ctx.secrets.open(user.totpSecret, 'totp'), code, user.totpLastCounter);
      if (counter !== null) {
        stores.users.setTotpCounter(user.id, counter);
        ok = true;
      }
    } else {
      const hash = recoveryHash(code);
      if (user.recoveryCodes.includes(hash)) {
        stores.users.setRecoveryCodes(user.id, user.recoveryCodes.filter((candidate) => candidate !== hash));
        ok = true;
        stores.audit.record({ teamId: user.currentTeamId, userId: user.id, action: 'auth.recovery_code_used', targetType: 'user', targetId: user.id, ip: c.get('ip') });
      }
    }
    if (!ok) throw new AppError('invalid_two_factor_code', 'The code is incorrect');
    tickets.delete(input.ticket);
    startSession(c, user.id);
    stores.audit.record({ teamId: user.currentTeamId, userId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, ip: c.get('ip'), metadata: { twoFactor: true } });
    return c.json({ twoFactorRequired: false });
  });

  app.post('/api/auth/logout', (c) => {
    const auth = c.get('auth');
    if (auth?.sessionId) stores.sessions.delete(auth.sessionId);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------- GitHub OAuth

  const oauthRedirect = (c: Ctx): string => `${ctx.github.credentials()?.baseUrl ?? new URL(c.req.url).origin}/api/auth/github/callback`;

  app.get('/api/auth/github/start', (c) => {
    if (ctx.github.credentials() === null) return c.redirect('/login?error=github_not_configured');
    const mode = c.req.query('mode') === 'link' ? 'link' : 'login';
    const auth = c.get('auth');
    if (mode === 'link' && auth === null) return c.redirect('/login');
    const state = ctx.github.createState({ kind: mode, teamId: null, userId: auth?.user.id ?? null });
    return c.redirect(ctx.github.oauthUrl(state, oauthRedirect(c)));
  });

  app.get('/api/auth/github/callback', async (c) => {
    const code = c.req.query('code');
    const stateToken = c.req.query('state');
    if (code === undefined || stateToken === undefined) return c.redirect('/login?error=github_failed');
    let mode: 'login' | 'link';
    let linkUserId: string | null;
    try {
      const state = ctx.github.consumeState(stateToken, ['login', 'link']);
      mode = state.kind === 'link' ? 'link' : 'login';
      linkUserId = state.userId;
    } catch {
      return c.redirect('/login?error=github_expired');
    }

    let profile: Awaited<ReturnType<typeof ctx.github.oauthUser>>;
    try {
      profile = await ctx.github.oauthUser(code, oauthRedirect(c));
    } catch {
      return c.redirect(mode === 'link' ? '/settings/profile?github=failed' : '/login?error=github_failed');
    }

    if (mode === 'link') {
      const owner = stores.users.findByIdentity('github', profile.id);
      if (owner !== undefined && owner.id !== linkUserId) return c.redirect('/settings/profile?github=taken');
      if (linkUserId !== null) stores.users.linkIdentity(linkUserId, 'github', profile.id, profile.login);
      return c.redirect('/settings/profile?github=linked');
    }

    let user = stores.users.findByIdentity('github', profile.id);
    if (user === undefined && profile.email !== null) {
      // A verified GitHub email that matches an existing account signs into that account.
      user = stores.users.getByEmail(profile.email);
      if (user !== undefined) stores.users.linkIdentity(user.id, 'github', profile.id, profile.login);
    }
    if (user === undefined) {
      if (!stores.settings.platform().allowGithubSignup || profile.email === null || stores.users.count() === 0) {
        return c.redirect('/login?error=github_no_account');
      }
      const created = stores.db.transaction(() => {
        const newUser = stores.users.create({ email: profile.email!, name: profile.name, passwordHash: null, avatarUrl: profile.avatarUrl });
        const team = stores.teams.create(`${profile.name}`);
        stores.teams.addMember(team.id, newUser.id, 'owner');
        stores.users.update(newUser.id, { currentTeamId: team.id });
        stores.users.linkIdentity(newUser.id, 'github', profile.id, profile.login);
        return newUser;
      });
      user = created;
    }
    if (user.totpEnabled) {
      // GitHub proves the identity, not possession of the second factor.
      const ticket = generateToken(24);
      tickets.set(ticket, { userId: user.id, expiresAt: Date.now() + TICKET_TTL_MS, attempts: 0 });
      return c.redirect(`/login?ticket=${encodeURIComponent(ticket)}`);
    }
    if (user.avatarUrl === null && profile.avatarUrl !== null) stores.users.update(user.id, { avatarUrl: profile.avatarUrl });
    startSession(c, user.id);
    stores.audit.record({ teamId: user.currentTeamId, userId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, ip: c.get('ip'), metadata: { provider: 'github' } });
    return c.redirect('/');
  });

  // ------------------------------------------------------------ invitations

  app.get('/api/invitations/:token', (c) => {
    const invitation = stores.teams.findInvitationByToken(c.req.param('token'));
    if (invitation === undefined) throw new AppError('invitation_invalid', 'This invitation is invalid or has expired');
    const team = stores.teams.get(invitation.teamId)!;
    const preview: InvitationPreviewDto = {
      teamName: team.name,
      email: invitation.email,
      role: invitation.role,
      invitedBy: invitation.invitedByName,
      userExists: stores.users.getByEmail(invitation.email) !== undefined,
      expiresAt: invitation.expiresAt,
    };
    return c.json(preview);
  });

  app.post('/api/invitations/:token/accept', async (c) => {
    limit(loginLimiter, c, 'invite');
    const invitation = stores.teams.findInvitationByToken(c.req.param('token'));
    if (invitation === undefined) throw new AppError('invitation_invalid', 'This invitation is invalid or has expired');
    const input = await body(c, acceptInvitationSchema);
    const auth = c.get('auth');

    let userId: string;
    if (auth !== null) {
      if (auth.user.email.toLowerCase() !== invitation.email.toLowerCase()) {
        throw new AppError('forbidden', `This invitation was sent to ${invitation.email}`, { params: { email: invitation.email } });
      }
      userId = auth.user.id;
    } else {
      if (stores.users.getByEmail(invitation.email) !== undefined) {
        throw new AppError('unauthorized', 'Sign in to accept this invitation', { params: { reason: 'sign_in' } });
      }
      if (input.name === undefined || input.password === undefined) {
        throw new AppError('validation_failed', 'Name and password are required', {
          issues: [
            ...(input.name === undefined ? [{ path: 'name', code: 'invalid_type', message: 'Required' }] : []),
            ...(input.password === undefined ? [{ path: 'password', code: 'invalid_type', message: 'Required' }] : []),
          ],
        });
      }
      const passwordHash = await hashPassword(input.password);
      userId = stores.users.create({ email: invitation.email, name: input.name, passwordHash }).id;
    }

    stores.db.transaction(() => {
      stores.teams.addMember(invitation.teamId, userId, invitation.role);
      stores.teams.deleteInvitation(invitation.id);
      stores.users.update(userId, { currentTeamId: invitation.teamId });
    });
    if (auth === null) startSession(c, userId);
    audit(ctx, c, 'team.member_joined', { type: 'user', id: userId, name: invitation.email, teamId: invitation.teamId }, { role: invitation.role });
    return c.json({ ok: true });
  });

  /** Lightweight session probe for the dashboard. */
  app.get('/api/auth/session', (c) => {
    const auth = requireAuth(c);
    return c.json({ userId: auth.user.id, teamId: auth.teamId });
  });
}

export { recoveryHash };
