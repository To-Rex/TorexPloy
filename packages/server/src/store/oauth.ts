/**
 * Apps that connect to TorexPloy over OAuth (claude.ai, Claude Desktop,
 * Cursor, VS Code and other MCP clients), and the grants people gave them.
 *
 * A grant is one person's yes to one app, in one team, with one reach. The app
 * holds a refresh token for it and trades it for short-lived access tokens
 * (ordinary API tokens of kind `oauth`); every trade replaces the refresh
 * token, so a stolen one stops working the moment the app uses its own.
 */
import { TOKEN_ACCESS, type TokenAccess } from '@ploy/shared';
import type { Database } from '../db/database.ts';
import { sha256 } from '../lib/crypto.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { json, str, strOrNull, type Row } from './util.ts';

export type OAuthClientKind = 'dcr' | 'cimd';
export type OAuthAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export interface OAuthClientRecord {
  id: string;
  kind: OAuthClientKind;
  name: string;
  uri: string | null;
  redirectUris: string[];
  secretHash: string | null;
  authMethod: OAuthAuthMethod;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface OAuthGrantRecord {
  id: string;
  clientId: string;
  userId: string;
  teamId: string;
  access: TokenAccess;
  redirectUri: string;
  resource: string | null;
  refreshExpiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

function mapClient(row: Row): OAuthClientRecord {
  const method = str(row.auth_method);
  return {
    id: str(row.id),
    kind: str(row.kind) === 'cimd' ? 'cimd' : 'dcr',
    name: str(row.name),
    uri: strOrNull(row.uri),
    redirectUris: json<string[]>(row.redirect_uris, []),
    secretHash: strOrNull(row.secret_hash),
    authMethod: method === 'client_secret_post' || method === 'client_secret_basic' ? method : 'none',
    createdAt: str(row.created_at),
    lastUsedAt: strOrNull(row.last_used_at),
  };
}

function mapGrant(row: Row): OAuthGrantRecord {
  const access = str(row.access);
  return {
    id: str(row.id),
    clientId: str(row.client_id),
    userId: str(row.user_id),
    teamId: str(row.team_id),
    access: (TOKEN_ACCESS as readonly string[]).includes(access) ? (access as TokenAccess) : 'read',
    redirectUri: str(row.redirect_uri),
    resource: strOrNull(row.resource),
    refreshExpiresAt: strOrNull(row.refresh_expires_at),
    createdAt: str(row.created_at),
    lastUsedAt: strOrNull(row.last_used_at),
  };
}

export class OAuthStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // ---------------------------------------------------------------- clients

  createClient(input: { id?: string; kind: OAuthClientKind; name: string; uri: string | null; redirectUris: string[]; secret: string | null; authMethod: OAuthAuthMethod }): OAuthClientRecord {
    const id = input.id ?? newId('ocl');
    this.db.run(
      `INSERT INTO oauth_clients (id, kind, name, uri, redirect_uris, secret_hash, auth_method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, uri = excluded.uri, redirect_uris = excluded.redirect_uris`,
      id,
      input.kind,
      input.name,
      input.uri,
      JSON.stringify(input.redirectUris),
      input.secret === null ? null : sha256(input.secret),
      input.authMethod,
      nowIso(),
    );
    return this.client(id)!;
  }

  client(id: string): OAuthClientRecord | undefined {
    const row = this.db.get('SELECT * FROM oauth_clients WHERE id = ?', id);
    return row === undefined ? undefined : mapClient(row);
  }

  touchClient(id: string): void {
    this.db.run('UPDATE oauth_clients SET last_used_at = ? WHERE id = ?', nowIso(), id);
  }

  countClients(): number {
    return Number(this.db.scalar('SELECT COUNT(*) FROM oauth_clients') ?? 0);
  }

  /** Self-registered apps nobody ever connected, after a while: registration is open, so it must not pile up. */
  pruneClients(before: string): number {
    return this.db.run(`DELETE FROM oauth_clients WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id)`, before).changes;
  }

  // ----------------------------------------------------------------- grants

  createGrant(input: { clientId: string; userId: string; teamId: string; access: TokenAccess; redirectUri: string; resource: string | null }): OAuthGrantRecord {
    const id = newId('ogr');
    const now = nowIso();
    this.db.run(
      'INSERT INTO oauth_grants (id, client_id, user_id, team_id, access, redirect_uri, resource, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      input.clientId,
      input.userId,
      input.teamId,
      input.access,
      input.redirectUri,
      input.resource,
      now,
    );
    return this.grant(id)!;
  }

  grant(id: string): OAuthGrantRecord | undefined {
    const row = this.db.get('SELECT * FROM oauth_grants WHERE id = ?', id);
    return row === undefined ? undefined : mapGrant(row);
  }

  /** The grant a refresh token belongs to, while that token is the current one and has not run out. */
  grantByRefresh(token: string): OAuthGrantRecord | undefined {
    const row = this.db.get('SELECT * FROM oauth_grants WHERE refresh_hash = ? AND (refresh_expires_at IS NULL OR refresh_expires_at > ?)', sha256(token), nowIso());
    return row === undefined ? undefined : mapGrant(row);
  }

  setRefresh(id: string, token: string, expiresAt: string): void {
    this.db.run('UPDATE oauth_grants SET refresh_hash = ?, refresh_expires_at = ?, last_used_at = ? WHERE id = ?', sha256(token), expiresAt, nowIso(), id);
  }

  touchGrant(id: string): void {
    this.db.run('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?', nowIso(), id);
  }

  listGrants(filter: { userId?: string; teamId?: string }): OAuthGrantRecord[] {
    if (filter.userId !== undefined) return this.db.all('SELECT * FROM oauth_grants WHERE user_id = ? ORDER BY created_at DESC', filter.userId).map(mapGrant);
    if (filter.teamId !== undefined) return this.db.all('SELECT * FROM oauth_grants WHERE team_id = ? ORDER BY created_at DESC', filter.teamId).map(mapGrant);
    return [];
  }

  deleteGrant(id: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM api_tokens WHERE grant_id = ?', id);
      this.db.run('DELETE FROM oauth_grants WHERE id = ?', id);
    });
  }

  /** Grants whose refresh token ran out long ago: the app can no longer use them. */
  pruneGrants(before: string): number {
    const stale = this.db.all('SELECT id FROM oauth_grants WHERE refresh_expires_at IS NOT NULL AND refresh_expires_at < ?', before).map((row) => str(row.id));
    for (const id of stale) this.deleteGrant(id);
    return stale.length;
  }
}
