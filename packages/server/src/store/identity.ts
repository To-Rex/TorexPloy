/**
 * Users, sessions, passkeys, API tokens and external identities.
 */
import { TOKEN_ACCESS, TOKEN_KINDS, type TokenAccess, type TokenKind } from '@ploy/shared';
import { localeOr, type Locale, type Theme } from '@ploy/shared';
import type { Database } from '../db/database.ts';
import { generateToken, sha256 } from '../lib/crypto.ts';
import type { PasskeyPublicKey } from '../lib/webauthn.ts';
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
    locale: localeOr(row.locale),
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

  /** Whether an account is linked to an external identity (its login may be unknown, the link is what matters). */
  hasIdentity(userId: string, provider: 'github'): boolean {
    return this.db.get('SELECT 1 AS found FROM user_identities WHERE user_id = ? AND provider = ?', userId, provider) !== undefined;
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
// Passkeys (WebAuthn credentials)
// ---------------------------------------------------------------------------

export interface PasskeyRecord {
  id: string;
  userId: string;
  /** base64url of the credential id the authenticator answers to. */
  credentialId: string;
  publicKey: PasskeyPublicKey;
  signCount: number;
  /** How the authenticator can be reached (`internal`, `hybrid`, `usb`…), as the browser reported at registration. */
  transports: string[];
  aaguid: string | null;
  rpId: string;
  backupEligible: boolean;
  backedUp: boolean;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function mapPasskey(row: Row): PasskeyRecord {
  return {
    id: str(row.id),
    userId: str(row.user_id),
    credentialId: str(row.credential_id),
    publicKey: { algorithm: num(row.algorithm) as PasskeyPublicKey['algorithm'], jwk: json<PasskeyPublicKey['jwk']>(row.public_key, {}) },
    signCount: num(row.sign_count),
    transports: json<string[]>(row.transports, []),
    aaguid: strOrNull(row.aaguid),
    rpId: str(row.rp_id),
    backupEligible: bool(row.backup_eligible),
    backedUp: bool(row.backed_up),
    name: str(row.name),
    createdAt: str(row.created_at),
    lastUsedAt: strOrNull(row.last_used_at),
  };
}

export class PasskeyStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: Omit<PasskeyRecord, 'id' | 'createdAt' | 'lastUsedAt'>): PasskeyRecord {
    const id = newId('pk');
    this.db.run(
      `INSERT INTO passkeys (id, user_id, credential_id, public_key, algorithm, sign_count, transports, aaguid, rp_id, backup_eligible, backed_up, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.userId,
      input.credentialId,
      JSON.stringify(input.publicKey.jwk),
      input.publicKey.algorithm,
      input.signCount,
      JSON.stringify(input.transports),
      input.aaguid,
      input.rpId,
      int01(input.backupEligible),
      int01(input.backedUp),
      input.name,
      nowIso(),
    );
    return this.get(id)!;
  }

  get(id: string): PasskeyRecord | undefined {
    const row = this.db.get('SELECT * FROM passkeys WHERE id = ?', id);
    return row === undefined ? undefined : mapPasskey(row);
  }

  getByCredentialId(credentialId: string): PasskeyRecord | undefined {
    const row = this.db.get('SELECT * FROM passkeys WHERE credential_id = ?', credentialId);
    return row === undefined ? undefined : mapPasskey(row);
  }

  listForUser(userId: string): PasskeyRecord[] {
    return this.db.all('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at, id', userId).map(mapPasskey);
  }

  countForUser(userId: string): number {
    return num(this.db.get('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?', userId)!.n);
  }

  /** How many passkeys (of every account) are bound to a host: what a change of the panel domain would strand. */
  countForHost(rpId: string): number {
    return num(this.db.get('SELECT COUNT(*) AS n FROM passkeys WHERE rp_id = ?', rpId)!.n);
  }

  rename(id: string, name: string): void {
    this.db.run('UPDATE passkeys SET name = ? WHERE id = ?', name, id);
  }

  /** A successful sign-in: the counter the authenticator reported, whether the key is synced now, and when. */
  markUsed(id: string, signCount: number, backedUp: boolean): void {
    this.db.run('UPDATE passkeys SET sign_count = ?, backed_up = ?, last_used_at = ? WHERE id = ?', signCount, int01(backedUp), nowIso(), id);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM passkeys WHERE id = ?', id);
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
  kind: TokenKind;
  access: TokenAccess;
  /** The app or computer it was made for. */
  client: string | null;
  /** The OAuth grant an app's token belongs to. */
  grantId: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

function mapToken(row: Row): ApiTokenRecord {
  const kind = str(row.kind);
  const access = str(row.access);
  return {
    id: str(row.id),
    userId: str(row.user_id),
    teamId: str(row.team_id),
    name: str(row.name),
    prefix: str(row.prefix),
    kind: (TOKEN_KINDS as readonly string[]).includes(kind) ? (kind as TokenKind) : 'api',
    access: (TOKEN_ACCESS as readonly string[]).includes(access) ? (access as TokenAccess) : 'read',
    client: strOrNull(row.client),
    grantId: strOrNull(row.grant_id),
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

  create(input: {
    userId: string;
    teamId: string;
    name: string;
    expiresAt: string | null;
    tokenPrefix: string;
    kind?: TokenKind;
    access?: TokenAccess;
    client?: string | null;
    grantId?: string | null;
  }): {
    token: string;
    record: ApiTokenRecord;
  } {
    const token = `${input.tokenPrefix}${generateToken(30)}`;
    const id = newId('tok');
    this.db.run(
      `INSERT INTO api_tokens (id, user_id, team_id, name, token_hash, prefix, kind, access, client, grant_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.userId,
      input.teamId,
      input.name,
      sha256(token),
      token.slice(0, input.tokenPrefix.length + 6),
      input.kind ?? 'api',
      input.access ?? 'full',
      input.client ?? null,
      input.grantId ?? null,
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

  /** Every token of an OAuth grant (an app keeps at most a couple alive while it trades them in). */
  listForGrant(grantId: string): ApiTokenRecord[] {
    return this.db.all('SELECT * FROM api_tokens WHERE grant_id = ? ORDER BY created_at DESC', grantId).map(mapToken);
  }

  deleteForGrant(grantId: string, except?: string): void {
    if (except === undefined) this.db.run('DELETE FROM api_tokens WHERE grant_id = ?', grantId);
    else this.db.run('DELETE FROM api_tokens WHERE grant_id = ? AND id <> ?', grantId, except);
  }

  /** Tokens that have run out: kept a week for the record, then removed. */
  pruneExpired(before: string): number {
    return this.db.run('DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at < ?', before).changes;
  }
}
