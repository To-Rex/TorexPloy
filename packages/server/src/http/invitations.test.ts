/**
 * Invitation links: creating one, issuing a fresh link for a pending
 * invitation (the old token stops working), and who may do it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HttpBindings } from '@hono/node-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_TOKEN_PREFIX, type InvitationDto, type InvitationPreviewDto } from '@ploy/shared';
import { createContext } from '../main.ts';
import { createHttpApp } from './app.ts';

const BINDINGS = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as unknown as HttpBindings;

test('a pending invitation gets a new link on request; the previous link is no longer valid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-inv-'));
  process.env.PLOY_RUN_DIR = join(dir, 'run');
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'test.db'), dockerSocket: join(dir, 'none.sock'), logLevel: 'error' });
  const { stores } = ctx;
  try {
    const team = stores.teams.create('Acme');
    const member = (email: string, role: 'admin' | 'owner' | 'developer'): string => {
      const user = stores.users.create({ email, name: email.split('@')[0]!, passwordHash: null, isInstanceAdmin: false });
      stores.teams.addMember(team.id, user.id, role);
      return stores.tokens.create({ userId: user.id, teamId: team.id, name: 'test', expiresAt: null, tokenPrefix: API_TOKEN_PREFIX }).token;
    };
    const owner = member('owner@acme.uz', 'owner');
    const admin = member('admin@acme.uz', 'admin');
    const developer = member('dev@acme.uz', 'developer');
    const app = createHttpApp(ctx);
    const call = async <T>(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
      const response = await app.request(
        path,
        { method, headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
        BINDINGS,
      );
      return { status: response.status, body: (await response.json()) as T };
    };
    const tokenOf = (link: string): string => link.split('/invite/')[1]!;

    const created = await call<InvitationDto>(admin, 'POST', '/api/team/invitations', { email: 'new@acme.uz', role: 'developer' });
    assert.equal(created.status, 201);
    const first = tokenOf(created.body.link!);
    assert.equal((await call<InvitationPreviewDto>(null, 'GET', `/api/invitations/${first}`)).status, 200);

    // Listing never exposes a link; a fresh one is issued on demand.
    const listed = await call<InvitationDto[]>(admin, 'GET', '/api/team/invitations');
    assert.equal(listed.body[0]!.link, undefined);
    const relinked = await call<InvitationDto>(admin, 'POST', `/api/team/invitations/${created.body.id}/link`);
    assert.equal(relinked.status, 200);
    const second = tokenOf(relinked.body.link!);
    assert.notEqual(second, first);
    assert.equal((await call(null, 'GET', `/api/invitations/${first}`)).status, 410, 'the old link stops working');
    assert.equal((await call(null, 'GET', `/api/invitations/${second}`)).status, 200);
    assert.ok(Date.parse(relinked.body.expiresAt) >= Date.parse(created.body.expiresAt), 'the 7 days start again');

    // Developers cannot; only an owner can re-issue an owner invitation.
    assert.equal((await call(developer, 'POST', `/api/team/invitations/${created.body.id}/link`)).status, 403);
    const ownerInvite = await call<InvitationDto>(owner, 'POST', '/api/team/invitations', { email: 'boss@acme.uz', role: 'owner' });
    assert.equal((await call(admin, 'POST', `/api/team/invitations/${ownerInvite.body.id}/link`)).status, 403);
    assert.equal((await call(owner, 'POST', `/api/team/invitations/${ownerInvite.body.id}/link`)).status, 200);
    assert.equal((await call(admin, 'POST', '/api/team/invitations/inv_missing/link')).status, 404);
  } finally {
    await ctx.notifier.flush();
    stores.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
