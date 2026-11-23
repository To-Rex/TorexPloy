/**
 * The CLI and MCP page of the dashboard: how to connect, what is connected,
 * what the connected apps did (with undo), and the instance switches.
 *
 * Everyone in a team sees their own connections and activity; an
 * administrator sees the whole team's, and may remove any of them.
 */
import type { Hono } from 'hono';
import {
  API_TOKEN_PREFIX,
  MCP_PATH,
  mcpSettingsSchema,
  mcpTokenSchema,
  roleAtLeast,
  type ApiTokenDto,
  type McpConnectionDto,
  type McpOverviewDto,
} from '@ploy/shared';
import { stat } from 'node:fs/promises';
import type { Context } from '../../context.ts';
import { AppError, forbidden, notFound } from '../../lib/errors.ts';
import { CLI_DIST } from '../../mcp/cli.ts';
import { audit, body, requestOrigin, requireInstanceAdmin, requireTeam, type Ctx, type Env } from '../core.ts';
import { tokenDto } from '../dto.ts';

export function registerMcpRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;

  const overview = async (c: Ctx): Promise<McpOverviewDto> => {
    const auth = requireTeam(c, 'viewer');
    const admin = roleAtLeast(auth.role, 'admin');
    const team = stores.teams.get(auth.teamId);
    const people = new Map<string, string>();
    const person = (id: string): string => {
      if (!people.has(id)) people.set(id, stores.users.getById(id)?.name ?? '—');
      return people.get(id)!;
    };
    const grants = admin ? stores.oauth.listGrants({ teamId: auth.teamId }) : stores.oauth.listGrants({ userId: auth.user.id }).filter((grant) => grant.teamId === auth.teamId);
    const connections: McpConnectionDto[] = grants.map((grant) => {
      const client = stores.oauth.client(grant.clientId);
      let redirectHost: string | null = null;
      try {
        const url = new URL(grant.redirectUri);
        redirectHost = url.host.length > 0 ? url.host : url.protocol;
      } catch {
        redirectHost = null;
      }
      return {
        id: `grant:${grant.id}`,
        kind: 'oauth',
        name: client?.name ?? 'OAuth app',
        redirectHost,
        access: grant.access,
        teamName: team?.name ?? '',
        userName: person(grant.userId),
        mine: grant.userId === auth.user.id,
        createdAt: grant.createdAt,
        lastUsedAt: grant.lastUsedAt,
        expiresAt: grant.refreshExpiresAt,
      };
    });
    for (const token of stores.tokens.listForTeam(auth.teamId)) {
      // Command line sign-ins, and tokens made on this page for an app; plain API tokens have a page of their own.
      if (token.kind === 'oauth' || (token.kind === 'api' && token.client === null)) continue;
      if (!admin && token.userId !== auth.user.id) continue;
      connections.push({
        id: `token:${token.id}`,
        kind: token.kind,
        name: token.client ?? token.name,
        redirectHost: null,
        access: token.access,
        teamName: team?.name ?? '',
        userName: person(token.userId),
        mine: token.userId === auth.user.id,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
        expiresAt: token.expiresAt,
      });
    }
    connections.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const activity = stores.ai.mcpActions({ teamId: auth.teamId, ...(admin ? {} : { userId: auth.user.id }) }, 40).map(({ action, client }) => ({ ...ctx.ai.actionDto(action, []), client }));
    const origin = requestOrigin(c);
    return {
      settings: ctx.mcp.settings(),
      endpoint: `${origin}${MCP_PATH}`,
      origin,
      cliVersion: (await stat(CLI_DIST).catch(() => null)) === null ? null : ctx.config.version,
      connections,
      activity,
      canConnect: roleAtLeast(auth.role, 'developer') && auth.tokenId === null,
    };
  };

  app.get('/api/mcp', async (c) => c.json(await overview(c)));

  app.put('/api/mcp/settings', async (c) => {
    requireInstanceAdmin(c);
    const input = await body(c, mcpSettingsSchema);
    const settings = ctx.mcp.updateSettings(input);
    audit(ctx, c, 'mcp.settings_updated', { type: 'settings', teamId: null }, { ...settings });
    return c.json(settings);
  });

  /** A token to paste into an app that connects with a header rather than by signing in. */
  app.post('/api/mcp/tokens', async (c) => {
    const auth = requireTeam(c, 'developer');
    if (auth.tokenId !== null) throw forbidden('API tokens cannot create other tokens');
    const input = await body(c, mcpTokenSchema);
    const expiresAt = input.expiresInDays === null ? null : new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString();
    const { token, record } = stores.tokens.create({ userId: auth.user.id, teamId: auth.teamId, name: `MCP · ${input.client}`.slice(0, 80), expiresAt, tokenPrefix: API_TOKEN_PREFIX, kind: 'api', access: input.access, client: input.client });
    audit(ctx, c, 'token.created', { type: 'token', id: record.id, name: record.name }, { access: record.access, mcp: true });
    const created: ApiTokenDto = tokenDto(record, token);
    return c.json(created, 201);
  });

  app.delete('/api/mcp/connections/:id', (c) => {
    const auth = requireTeam(c, 'viewer');
    const admin = roleAtLeast(auth.role, 'admin');
    const [kind, id = ''] = c.req.param('id').split(':');
    if (kind === 'grant') {
      const grant = stores.oauth.grant(id);
      if (grant === undefined || grant.teamId !== auth.teamId) throw notFound('Connection');
      if (grant.userId !== auth.user.id && !admin) throw forbidden();
      stores.oauth.deleteGrant(grant.id);
      audit(ctx, c, 'mcp.app_disconnected', { type: 'oauth_grant', id: grant.id, name: stores.oauth.client(grant.clientId)?.name ?? null });
      return c.json({ ok: true });
    }
    if (kind === 'token') {
      const token = stores.tokens.get(id);
      if (token === undefined || token.teamId !== auth.teamId) throw notFound('Connection');
      if (token.userId !== auth.user.id && !admin) throw forbidden();
      stores.tokens.delete(token.id);
      audit(ctx, c, 'token.revoked', { type: 'token', id: token.id, name: token.name });
      return c.json({ ok: true });
    }
    throw notFound('Connection');
  });

  /** Take back a step an app took. Only its owner can: it acted as them. */
  app.post('/api/mcp/activity/:id/undo', async (c) => {
    const auth = requireTeam(c, 'viewer');
    const action = stores.ai.getAction(c.req.param('id'));
    const chat = action === undefined ? undefined : stores.ai.getChat(action.chatId);
    if (action === undefined || chat === undefined || chat.kind !== 'mcp' || chat.teamId !== auth.teamId) throw notFound('Step');
    if (chat.userId !== auth.user.id) throw new AppError('forbidden', 'Only the person the app acted for can undo its steps');
    const undone = await ctx.ai.undo({ userId: auth.user.id, teamId: auth.teamId, sessionId: auth.sessionId, ip: c.get('ip'), origin: requestOrigin(c), chatId: chat.id }, chat, action.id);
    return c.json({ ...ctx.ai.actionDto(undone, []), client: chat.title });
  });
}
