/**
 * The signed-in user's own account, and their teams.
 */
import type { Hono } from 'hono';
import {
  API_TOKEN_PREFIX,
  changePasswordSchema,
  createApiTokenSchema,
  createTeamSchema,
  inviteMemberSchema,
  paginationSchema,
  roleAtLeast,
  switchTeamSchema,
  twoFactorCodeSchema,
  twoFactorDisableSchema,
  updateMemberSchema,
  updateProfileSchema,
  updateTeamSchema,
  type SessionDto,
} from '@ploy/shared';
import type { Context } from '../../context.ts';
import { generateTotpSecret, hashPassword, sha256, totpUri, verifyPassword, verifyTotp } from '../../lib/crypto.ts';
import { AppError, forbidden, notFound } from '../../lib/errors.ts';
import { randomId } from '../../lib/ids.ts';
import { audit, body, limit, query, RateLimiter, requestOrigin, requireAuth, requireTeam, type Env } from '../core.ts';
import { auditDto, invitationDto, memberDto, teamDto, tokenDto, userDto } from '../dto.ts';
import { publicBaseUrl } from '../../github/app.ts';

function recoveryCodes(): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: 10 }, () => {
    const raw = randomId(8);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
  return { plain, hashes: plain.map((code) => sha256(code.replace(/-/g, ''))) };
}

export function registerAccountRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;
  const sensitive = new RateLimiter(10, 10);

  // ---------------------------------------------------------------- profile

  app.get('/api/me', (c) => {
    const { user } = requireAuth(c);
    return c.json(userDto(user, stores.users.getIdentityLogin(user.id, 'github')));
  });

  app.patch('/api/me', async (c) => {
    const { user } = requireAuth(c);
    const input = await body(c, updateProfileSchema);
    stores.users.update(user.id, input);
    const updated = stores.users.getById(user.id)!;
    return c.json(userDto(updated, stores.users.getIdentityLogin(user.id, 'github')));
  });

  app.post('/api/me/password', async (c) => {
    limit(sensitive, c, 'password');
    const auth = requireAuth(c);
    const input = await body(c, changePasswordSchema);
    if (auth.user.passwordHash !== null && !(await verifyPassword(input.currentPassword, auth.user.passwordHash))) {
      throw new AppError('invalid_credentials', 'Current password is incorrect');
    }
    stores.users.setPasswordHash(auth.user.id, await hashPassword(input.newPassword));
    // Every other session is signed out: a password change is often a response to compromise.
    if (auth.sessionId !== null) stores.sessions.deleteForUser(auth.user.id, auth.sessionId);
    audit(ctx, c, 'user.password_changed', { type: 'user', id: auth.user.id });
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------- 2FA

  app.post('/api/me/2fa/setup', (c) => {
    const { user } = requireAuth(c);
    if (user.totpEnabled) throw new AppError('conflict', 'Two-factor authentication is already enabled');
    const secret = generateTotpSecret();
    stores.users.setTotpPending(user.id, ctx.secrets.seal(secret, 'totp'));
    return c.json({ secret, otpauthUrl: totpUri(secret, user.email, 'TorexPloy') });
  });

  app.post('/api/me/2fa/enable', async (c) => {
    limit(sensitive, c, '2fa');
    const auth = requireAuth(c);
    const input = await body(c, twoFactorCodeSchema);
    const user = stores.users.getById(auth.user.id)!;
    if (user.totpSecret === null || user.totpEnabled) throw new AppError('bad_request', 'Start two-factor setup first');
    const counter = verifyTotp(ctx.secrets.open(user.totpSecret, 'totp'), input.code.replace(/\s/g, ''), null);
    if (counter === null) throw new AppError('invalid_two_factor_code', 'The code is incorrect');
    const codes = recoveryCodes();
    stores.users.enableTotp(user.id, counter, codes.hashes);
    audit(ctx, c, 'user.2fa_enabled', { type: 'user', id: user.id });
    return c.json({ recoveryCodes: codes.plain });
  });

  app.post('/api/me/2fa/disable', async (c) => {
    limit(sensitive, c, '2fa');
    const auth = requireAuth(c);
    const input = await body(c, twoFactorDisableSchema);
    const user = stores.users.getById(auth.user.id)!;
    if (!user.totpEnabled || user.totpSecret === null) throw new AppError('bad_request', 'Two-factor authentication is not enabled');
    if (user.passwordHash !== null && !(await verifyPassword(input.password, user.passwordHash))) {
      throw new AppError('invalid_credentials', 'Password is incorrect');
    }
    if (verifyTotp(ctx.secrets.open(user.totpSecret, 'totp'), input.code.replace(/\s/g, ''), user.totpLastCounter) === null) {
      throw new AppError('invalid_two_factor_code', 'The code is incorrect');
    }
    stores.users.disableTotp(user.id);
    audit(ctx, c, 'user.2fa_disabled', { type: 'user', id: user.id });
    return c.json({ ok: true });
  });

  app.post('/api/me/2fa/recovery-codes', async (c) => {
    limit(sensitive, c, '2fa');
    const auth = requireAuth(c);
    const input = await body(c, twoFactorCodeSchema);
    const user = stores.users.getById(auth.user.id)!;
    if (!user.totpEnabled || user.totpSecret === null) throw new AppError('bad_request', 'Two-factor authentication is not enabled');
    const counter = verifyTotp(ctx.secrets.open(user.totpSecret, 'totp'), input.code.replace(/\s/g, ''), user.totpLastCounter);
    if (counter === null) throw new AppError('invalid_two_factor_code', 'The code is incorrect');
    stores.users.setTotpCounter(user.id, counter);
    const codes = recoveryCodes();
    stores.users.setRecoveryCodes(user.id, codes.hashes);
    audit(ctx, c, 'user.recovery_codes_regenerated', { type: 'user', id: user.id });
    return c.json({ recoveryCodes: codes.plain });
  });

  // -------------------------------------------------------------- sessions

  app.get('/api/me/sessions', (c) => {
    const auth = requireAuth(c);
    const sessions: SessionDto[] = stores.sessions.listForUser(auth.user.id).map((session) => ({
      id: session.id,
      current: session.id === auth.sessionId,
      userAgent: session.userAgent,
      ip: session.ip,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
    }));
    return c.json(sessions);
  });

  app.delete('/api/me/sessions/:id', (c) => {
    const auth = requireAuth(c);
    const session = stores.sessions.listForUser(auth.user.id).find((candidate) => candidate.id === c.req.param('id'));
    if (session === undefined) throw notFound('Session');
    stores.sessions.delete(session.id);
    return c.json({ ok: true });
  });

  app.delete('/api/me/sessions', (c) => {
    const auth = requireAuth(c);
    const removed = stores.sessions.deleteForUser(auth.user.id, auth.sessionId ?? undefined);
    audit(ctx, c, 'user.sessions_revoked', { type: 'user', id: auth.user.id }, { count: removed });
    return c.json({ removed });
  });

  app.post('/api/me/team', async (c) => {
    const auth = requireAuth(c);
    if (auth.tokenId !== null) throw forbidden('API tokens are bound to one team');
    const input = await body(c, switchTeamSchema);
    if (stores.teams.getRole(input.teamId, auth.user.id) === undefined) throw notFound('Team');
    stores.users.update(auth.user.id, { currentTeamId: input.teamId });
    return c.json({ ok: true });
  });

  // ----------------------------------------------------------------- teams

  app.get('/api/teams', (c) => {
    const { user } = requireAuth(c);
    return c.json(stores.teams.listForUser(user.id).map(teamDto));
  });

  app.post('/api/teams', async (c) => {
    const auth = requireAuth(c);
    const input = await body(c, createTeamSchema);
    const team = stores.db.transaction(() => {
      const created = stores.teams.create(input.name);
      stores.teams.addMember(created.id, auth.user.id, 'owner');
      stores.users.update(auth.user.id, { currentTeamId: created.id });
      return created;
    });
    audit(ctx, c, 'team.created', { type: 'team', id: team.id, name: team.name, teamId: team.id });
    return c.json(teamDto(stores.teams.listForUser(auth.user.id).find((membership) => membership.team.id === team.id)!), 201);
  });

  app.get('/api/team', (c) => {
    const auth = requireTeam(c);
    const membership = stores.teams.listForUser(auth.user.id).find((candidate) => candidate.team.id === auth.teamId)!;
    return c.json(teamDto(membership));
  });

  app.patch('/api/team', async (c) => {
    const auth = requireTeam(c, 'admin');
    const input = await body(c, updateTeamSchema);
    stores.teams.rename(auth.teamId, input.name);
    audit(ctx, c, 'team.renamed', { type: 'team', id: auth.teamId, name: input.name });
    return c.json(teamDto(stores.teams.listForUser(auth.user.id).find((candidate) => candidate.team.id === auth.teamId)!));
  });

  app.delete('/api/team', async (c) => {
    const auth = requireTeam(c, 'owner');
    const projects = stores.projects.listForTeam(auth.teamId);
    if (projects.length > 0) throw new AppError('conflict', 'Delete every project of this team first', { params: { reason: 'has_projects' } });
    for (const server of stores.servers.listForTeam(auth.teamId)) {
      if (server.teamId === auth.teamId) await ctx.servers.remove(server);
    }
    stores.teams.delete(auth.teamId);
    stores.audit.record({ teamId: null, userId: auth.user.id, action: 'team.deleted', targetType: 'team', targetId: auth.teamId, ip: c.get('ip') });
    return c.json({ ok: true });
  });

  // --------------------------------------------------------------- members

  app.get('/api/team/members', (c) => {
    const auth = requireTeam(c);
    return c.json(stores.teams.listMembers(auth.teamId).map(memberDto));
  });

  app.patch('/api/team/members/:userId', async (c) => {
    const auth = requireTeam(c, 'admin');
    const input = await body(c, updateMemberSchema);
    const userId = c.req.param('userId');
    const current = stores.teams.getRole(auth.teamId, userId);
    if (current === undefined) throw notFound('Member');
    // Only owners may create or demote owners.
    if ((input.role === 'owner' || current === 'owner') && auth.role !== 'owner') throw forbidden('Only an owner can change owner roles');
    if (current === 'owner' && input.role !== 'owner' && stores.teams.countOwners(auth.teamId) <= 1) {
      throw new AppError('last_owner', 'A team must keep at least one owner');
    }
    stores.teams.setRole(auth.teamId, userId, input.role);
    audit(ctx, c, 'team.member_role_changed', { type: 'user', id: userId }, { from: current, to: input.role });
    return c.json({ ok: true });
  });

  app.delete('/api/team/members/:userId', (c) => {
    const userId = c.req.param('userId');
    const auth = requireTeam(c, 'viewer');
    const leavingSelf = userId === auth.user.id;
    if (!leavingSelf && !roleAtLeast(auth.role, 'admin')) throw forbidden();
    const current = stores.teams.getRole(auth.teamId, userId);
    if (current === undefined) throw notFound('Member');
    if (current === 'owner' && !leavingSelf && auth.role !== 'owner') throw forbidden('Only an owner can remove an owner');
    if (current === 'owner' && stores.teams.countOwners(auth.teamId) <= 1) throw new AppError('last_owner', 'A team must keep at least one owner');
    stores.teams.removeMember(auth.teamId, userId);
    audit(ctx, c, leavingSelf ? 'team.member_left' : 'team.member_removed', { type: 'user', id: userId });
    return c.json({ ok: true });
  });

  // ----------------------------------------------------------- invitations

  app.get('/api/team/invitations', (c) => {
    const auth = requireTeam(c, 'admin');
    return c.json(stores.teams.listInvitations(auth.teamId).map((invitation) => invitationDto(invitation)));
  });

  app.post('/api/team/invitations', async (c) => {
    const auth = requireTeam(c, 'admin');
    const input = await body(c, inviteMemberSchema);
    if (input.role === 'owner' && auth.role !== 'owner') throw forbidden('Only an owner can invite owners');
    const existing = stores.users.getByEmail(input.email);
    if (existing !== undefined && stores.teams.getRole(auth.teamId, existing.id) !== undefined) {
      throw new AppError('conflict', 'This person is already a member', { params: { reason: 'already_member' } });
    }
    const { token, invitation } = stores.teams.createInvitation(auth.teamId, input.email, input.role, auth.user.id);
    const base = publicBaseUrl(ctx) ?? requestOrigin(c);
    audit(ctx, c, 'team.member_invited', { type: 'invitation', id: invitation.id, name: input.email }, { role: input.role });
    return c.json(invitationDto(invitation, `${base}/invite/${token}`), 201);
  });

  // The token is stored hashed, so showing the link again means issuing a new one.
  app.post('/api/team/invitations/:id/link', (c) => {
    const auth = requireTeam(c, 'admin');
    const invitation = stores.teams.getInvitation(c.req.param('id'));
    if (invitation === undefined || invitation.teamId !== auth.teamId) throw notFound('Invitation');
    if (invitation.role === 'owner' && auth.role !== 'owner') throw forbidden('Only an owner can issue links for owner invitations');
    const { token, invitation: rotated } = stores.teams.rotateInvitationToken(invitation.id);
    const base = publicBaseUrl(ctx) ?? requestOrigin(c);
    audit(ctx, c, 'team.invitation_relinked', { type: 'invitation', id: invitation.id, name: invitation.email });
    return c.json(invitationDto(rotated, `${base}/invite/${token}`));
  });

  app.delete('/api/team/invitations/:id', (c) => {
    const auth = requireTeam(c, 'admin');
    const invitation = stores.teams.getInvitation(c.req.param('id'));
    if (invitation === undefined || invitation.teamId !== auth.teamId) throw notFound('Invitation');
    stores.teams.deleteInvitation(invitation.id);
    audit(ctx, c, 'team.invitation_revoked', { type: 'invitation', id: invitation.id, name: invitation.email });
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ API tokens

  app.get('/api/tokens', (c) => {
    const auth = requireTeam(c, 'developer');
    return c.json(stores.tokens.listForTeam(auth.teamId).filter((token) => token.userId === auth.user.id || roleAtLeast(auth.role, 'admin')).map((token) => tokenDto(token)));
  });

  app.post('/api/tokens', async (c) => {
    const auth = requireTeam(c, 'developer');
    if (auth.tokenId !== null) throw forbidden('API tokens cannot create other tokens');
    const input = await body(c, createApiTokenSchema);
    const expiresAt = input.expiresInDays === null ? null : new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString();
    const { token, record } = stores.tokens.create({ userId: auth.user.id, teamId: auth.teamId, name: input.name, expiresAt, tokenPrefix: API_TOKEN_PREFIX });
    audit(ctx, c, 'token.created', { type: 'token', id: record.id, name: record.name });
    return c.json(tokenDto(record, token), 201);
  });

  app.delete('/api/tokens/:id', (c) => {
    const auth = requireTeam(c, 'developer');
    const token = stores.tokens.get(c.req.param('id'));
    if (token === undefined || token.teamId !== auth.teamId) throw notFound('Token');
    if (token.userId !== auth.user.id && !roleAtLeast(auth.role, 'admin')) throw forbidden();
    stores.tokens.delete(token.id);
    audit(ctx, c, 'token.revoked', { type: 'token', id: token.id, name: token.name });
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------- audit log

  app.get('/api/audit', (c) => {
    const auth = requireTeam(c, 'admin');
    const { cursor, limit: size } = query(c, paginationSchema);
    const page = stores.audit.list(auth.teamId, cursor, size);
    return c.json({ items: page.items.map(auditDto), nextCursor: page.nextCursor });
  });
}
