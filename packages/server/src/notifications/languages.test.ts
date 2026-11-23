/**
 * Ten interface languages on the server's side: a person's language is kept
 * (any of the ten, and nothing else), a language this build does not know is
 * read as the default rather than breaking the account, and a notification
 * channel speaks every one of them with the same placeholders as the Uzbek.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { API_TOKEN_PREFIX, LOCALES, type UserDto } from '@ploy/shared';
import { createHttpApp } from '../http/app.ts';
import { createContext } from '../main.ts';
import { fill, MESSAGES } from './messages.ts';

const BINDINGS = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as unknown as HttpBindings;

test('notification texts exist in every language, with the Uzbek placeholders', () => {
  const placeholders = (text: string): string => (text.match(/\{\w+\}/g) ?? []).sort().join(' ');
  const source = MESSAGES.uz;
  for (const locale of LOCALES) {
    const texts = MESSAGES[locale];
    assert.ok(texts !== undefined, locale);
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string') {
        const translated = texts[key as keyof typeof texts] as string;
        assert.ok(translated.trim().length > 0, `${locale}.${key}`);
        assert.equal(placeholders(translated), placeholders(value), `${locale}.${key}`);
      }
    }
    assert.deepEqual(Object.keys(texts.reasons).sort(), Object.keys(source.reasons).sort(), `${locale}.reasons`);
  }
  assert.equal(fill(MESSAGES['uz-cyrl'].deploySucceeded, { app: 'web' }), '✅ web: янги версия ишга тушди');
  assert.equal(MESSAGES['uz-new'].open, 'Panelda oçiş');
});

test('a person keeps any of the ten languages, and only those', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-languages-'));
  const ctx = await createContext({ dataDir: join(dir, 'data'), databasePath: join(dir, 'data', 'panel.db'), logLevel: 'error' });
  const { stores } = ctx;
  const team = stores.teams.create('Acme');
  const user = stores.users.create({ email: 'admin@example.com', name: 'Admin', passwordHash: null, isInstanceAdmin: false });
  stores.teams.addMember(team.id, user.id, 'owner');
  const token = stores.tokens.create({ userId: user.id, teamId: team.id, name: 'test', expiresAt: null, tokenPrefix: API_TOKEN_PREFIX }).token;
  const app = createHttpApp(ctx);
  const patch = (locale: string) => app.request('/api/me', { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ locale }) }, BINDINGS);

  for (const locale of LOCALES) {
    const response = await patch(locale);
    assert.equal(response.status, 200, locale);
    assert.equal(((await response.json()) as UserDto).locale, locale);
    assert.equal(stores.users.getById(user.id)!.locale, locale);
  }
  assert.equal((await patch('fr')).status, 422, 'a language the interface does not have');

  // Written by a newer panel, then read by this one: the default, not a broken account.
  stores.db.run("UPDATE users SET locale = 'fr' WHERE id = ?", user.id);
  assert.equal(stores.users.getById(user.id)!.locale, 'uz');
  // The table no longer holds the old three-language CHECK.
  assert.doesNotMatch(String(stores.db.scalar("SELECT sql FROM sqlite_master WHERE name = 'users'")), /locale IN/);

  const channel = stores.notifications.create(team.id, { name: 'Ops', locale: 'kk', events: ['deployment.failed'], config: { kind: 'webhook', url: 'https://hooks.example.com/x' } });
  assert.equal(stores.notifications.get(channel.id)!.locale, 'kk');
});
