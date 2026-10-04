/**
 * Users, sessions, API tokens and external identities.
 */
import type { Locale, Theme } from '@ploy/shared';
import type { Database } from '../db/database.ts';
import { generateToken, sha256 } from '../lib/crypto.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { bool, int01, json, num, numOrNull, str, strOrNull, type Row } from './util.ts';

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  avatarUrl: string | null;
  locale: Locale;
  theme: Theme;
  isInstanceAdmin: boolean;
  totpSecret: string | null;
  totpEnabled: boolean;
  totpLastCounter: number | null;
  recoveryCodes: string[];
  currentTeamId: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapUser(row: Row): UserRecord {
  return {
    id: str(row.id),
    email: str(row.email),
    name: str(row.name),
    passwordHash: strOrNull(row.password_hash),
    avatarUrl: strOrNull(row.avatar_url),
    locale: str(row.locale) as Locale,
    theme: str(row.theme) as Theme,
    isInstanceAdmin: bool(row.is_instance_admin),
    totpSecret: strOrNull(row.totp_secret),
    totpEnabled: bool(row.totp_enabled),
    totpLastCounter: numOrNull(row.totp_last_counter),
    recoveryCodes: json<string[]>(row.recovery_codes, []),
    currentTeamId: strOrNull(row.current_team_id),
    lastLoginAt: strOrNull(row.last_login_at),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export class UserStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: {
    email: string;
    name: string;
    passwordHash: string | null;
    locale?: Locale;
    avatarUrl?: string | null;
    isInstanceAdmin?: boolean;
  }): UserRecord {
    const id = newId('usr');
    const now = nowIso();
    this.db.run(
      `INSERT INTO users (id, email, name, password_hash, avatar_url, locale, is_instance_admin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.email.toLowerCase(),
      input.name,
      input.passwordHash,
      input.avatarUrl ?? null,
      input.locale ?? 'uz',
      int01(input.isInstanceAdmin ?? false),
      now,
      now,
    );
    return this.getById(id)!;
  }

  getById(id: string): UserRecord | undefined {
    const row = this.db.get('SELECT * FROM users WHERE id = ?', id);
    return row === undefined ? undefined : mapUser(row);
  }

  getByEmail(email: string): UserRecord | undefined {
    const row = this.db.get('SELECT * FROM users WHERE email = ?', email.toLowerCase());
    return row === undefined ? undefined : mapUser(row);
  }

  count(): number {
    return num(this.db.scalar('SELECT COUNT(*) FROM users'));
  }

  update(id: string, patch: Partial<Pick<UserRecord, 'name' | 'locale' | 'theme' | 'avatarUrl' | 'currentTeamId'>>): void {
    const sets: string[] = [];
    const values: (string | null)[] = [];
    const columns = { name: 'name', locale: 'locale', theme: 'theme', avatarUrl: 'avatar_url', currentTeamId: 'current_team_id' } as const;
    for (const [key, column] of Object.entries(columns) as [keyof typeof columns, string][]) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        values.push(patch[key] ?? null);
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
  }

  setPasswordHash(id: string, hash: string): void {
    this.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, nowIso(), id);
  }

  markLogin(id: string): void {
    this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), id);
  }

  setTotpPending(id: string, sealedSecret: string): void {
    this.db.run('UPDATE users SET totp_secret = ?, totp_enabled = 0, updated_at = ? WHERE id = ?', sealedSecret, nowIso(), id);
  }

  enableTotp(id: string, counter: number, recoveryCodeHashes: string[]): void {
    this.db.run(
      'UPDATE users SET totp_enabled = 1, totp_last_counter = ?, recovery_codes = ?, updated_at = ? WHERE id = ?',
      counter,
      JSON.stringify(recoveryCodeHashes),
      nowIso(),
      id,
    );
  }

  disableTotp(id: string): void {
    this.db.run(
      "UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_counter = NULL, recovery_codes = '[]', updated_at = ? WHERE id = ?",
      nowIso(),
      id,
    );
  }

  setTotpCounter(id: string, counter: number): void {
    this.db.run('UPDATE users SET totp_last_counter = ? WHERE id = ?', counter, id);
  }

  setRecoveryCodes(id: string, hashes: string[]): void {
    this.db.run('UPDATE users SET recovery_codes = ? WHERE id = ?', JSON.stringify(hashes), id);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM users WHERE id = ?', id);
  }

  // -- external identities -------------------------------------------------

  findByIdentity(provider: 'github', providerUserId: string): UserRecord | undefined {
    const row = this.db.get(
      'SELECT u.* FROM users u JOIN user_identities i ON i.user_id = u.id WHERE i.provider = ? AND i.provider_user_id = ?',
      provider,
      providerUserId,
    );
    return row === undefined ? undefined : mapUser(row);
  }

  getIdentityLogin(userId: string, provider: 'github'): string | null {
    return strOrNull(this.db.scalar('SELECT login FROM user_identities WHERE user_id = ? AND provider = ?', userId, provider));
  }

  linkIdentity(userId: string, provider: 'github', providerUserId: string, login: string | null): void {
    this.db.run(
      `INSERT INTO user_identities (id, user_id, provider, provider_user_id, login, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, provider_user_id) DO UPDATE SET login = excluded.login`,
      newId('idn'),
      userId,
      provider,
      providerUserId,
      login,
      nowIso(),
    );
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionRecord {
  id: string;
  userId: string;
  userAgent: string | null;
  ip: string | null;
  expiresAt: string;
  createdAt: string;
  lastUsedAt: string;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding expiry is refreshed at most this often, so reads do not write on every request. */
const SESSION_TOUCH_INTERVAL_MS = 10 * 60 * 1000;

function mapSession(row: Row): SessionRecord {
  return {
    id: str(row.id),
    userId: str(row.user_id),
    userAgent: strOrNull(row.user_agent),
    ip: strOrNull(row.ip),
    expiresAt: str(row.expires_at),
    createdAt: str(row.created_at),
    lastUsedAt: str(row.last_used_at),
  };
}

export class SessionStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Returns the raw token exactly once; only its SHA-256 is stored. */
  create(userId: string, userAgent: string | null, ip: string | null): { token: string; session: SessionRecord } {
    const token = generateToken(32);
    const id = newId('ses');
    const now = new Date();
    this.db.run(
      `INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, expires_at, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      sha256(token),
      userAgent?.slice(0, 300) ?? null,
      ip,
      new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      now.toISOString(),
      now.toISOString(),
    );
    return { token, session: mapSession(this.db.get('SELECT * FROM sessions WHERE id = ?', id)!) };
  }

  /** Resolve a token to a live session, extending its expiry (sliding window). */
  resolve(token: string): SessionRecord | undefined {
    const now = new Date();
    const row = this.db.get('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?', sha256(token), now.toISOString());
    if (row === undefined) return undefined;
    const session = mapSession(row);
    if (now.getTime() - Date.parse(session.lastUsedAt) > SESSION_TOUCH_INTERVAL_MS) {
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
      this.db.run('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?', now.toISOString(), expiresAt, session.id);
      session.lastUsedAt = now.toISOString();
      session.expiresAt = expiresAt;
    }
    return session;
  }

  listForUser(userId: string): SessionRecord[] {
    return this.db
      .all('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_used_at DESC', userId, nowIso())
      .map(mapSession);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM sessions WHERE id = ?', id);
  }

  deleteForUser(userId: string, exceptSessionId?: string): number {
    if (exceptSessionId === undefined) return this.db.run('DELETE FROM sessions WHERE user_id = ?', userId).changes;
    return this.db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', userId, exceptSessionId).changes;
  }

  pruneExpired(): number {
    return this.db.run('DELETE FROM sessions WHERE expires_at <= ?', nowIso()).changes;
  }
}

// ---------------------------------------------------------------------------
// API tokens
// ---------------------------------------------------------------------------

export interface ApiTokenRecord {
  id: string;
  userId: string;
  teamId: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

function mapToken(row: Row): ApiTokenRecord {
  return {
    id: str(row.id),
    userId: str(row.user_id),
    teamId: str(row.team_id),
    name: str(row.name),
    prefix: str(row.prefix),
    lastUsedAt: strOrNull(row.last_used_at),
    expiresAt: strOrNull(row.expires_at),
    createdAt: str(row.created_at),
  };
}

export class ApiTokenStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: { userId: string; teamId: string; name: string; expiresAt: string | null; tokenPrefix: string }): {
    token: string;
    record: ApiTokenRecord;
  } {
    const token = `${input.tokenPrefix}${generateToken(30)}`;
    const id = newId('tok');
    this.db.run(
      `INSERT INTO api_tokens (id, user_id, team_id, name, token_hash, prefix, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.userId,
      input.teamId,
      input.name,
      sha256(token),
      token.slice(0, input.tokenPrefix.length + 6),
      input.expiresAt,
      nowIso(),
    );
    return { token, record: mapToken(this.db.get('SELECT * FROM api_tokens WHERE id = ?', id)!) };
  }

  resolve(token: string): ApiTokenRecord | undefined {
    const row = this.db.get(
      'SELECT * FROM api_tokens WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > ?)',
      sha256(token),
      nowIso(),
    );
    if (row === undefined) return undefined;
    const record = mapToken(row);
    // Coarse last-used tracking: one write per token per minute at most.
    if (record.lastUsedAt === null || Date.now() - Date.parse(record.lastUsedAt) > 60_000) {
      this.db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', nowIso(), record.id);
    }
    return record;
  }

  listForTeam(teamId: string): ApiTokenRecord[] {
    return this.db.all('SELECT * FROM api_tokens WHERE team_id = ? ORDER BY created_at DESC', teamId).map(mapToken);
  }

  get(id: string): ApiTokenRecord | undefined {
    const row = this.db.get('SELECT * FROM api_tokens WHERE id = ?', id);
    return row === undefined ? undefined : mapToken(row);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM api_tokens WHERE id = ?', id);
  }
}
