/**
 * Teams, memberships, invitations, audit log and platform settings.
 */
import type { TeamRole } from '@ploy/shared';
import type { Database } from '../db/database.ts';
import { generateToken, sha256 } from '../lib/crypto.ts';
import { newId, nowIso, slugify, uniqueSlug } from '../lib/ids.ts';
import { decodeCursor, json, num, str, strOrNull, toPage, type Row } from './util.ts';

export interface TeamRecord {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface MembershipRecord {
  team: TeamRecord;
  role: TeamRole;
  memberCount: number;
}

export interface MemberRecord {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: TeamRole;
  joinedAt: string;
}

export interface InvitationRecord {
  id: string;
  teamId: string;
  email: string;
  role: TeamRole;
  invitedBy: string | null;
  invitedByName: string | null;
  expiresAt: string;
  createdAt: string;
}

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function mapTeam(row: Row): TeamRecord {
  return {
    id: str(row.id),
    name: str(row.name),
    slug: str(row.slug),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function mapInvitation(row: Row): InvitationRecord {
  return {
    id: str(row.id),
    teamId: str(row.team_id),
    email: str(row.email),
    role: str(row.role) as TeamRole,
    invitedBy: strOrNull(row.invited_by),
    invitedByName: strOrNull(row.invited_by_name),
    expiresAt: str(row.expires_at),
    createdAt: str(row.created_at),
  };
}

export class TeamStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(name: string): TeamRecord {
    const id = newId('team');
    const now = nowIso();
    const slug = uniqueSlug(slugify(name, 'team'), (candidate) => this.db.get('SELECT 1 FROM teams WHERE slug = ?', candidate) !== undefined);
    this.db.run('INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, name, slug, now, now);
    return this.get(id)!;
  }

  get(id: string): TeamRecord | undefined {
    const row = this.db.get('SELECT * FROM teams WHERE id = ?', id);
    return row === undefined ? undefined : mapTeam(row);
  }

  rename(id: string, name: string): void {
    this.db.run('UPDATE teams SET name = ?, updated_at = ? WHERE id = ?', name, nowIso(), id);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM teams WHERE id = ?', id);
  }

  listForUser(userId: string): MembershipRecord[] {
    return this.db
      .all(
        `SELECT t.*, m.role,
                (SELECT COUNT(*) FROM team_members x WHERE x.team_id = t.id) AS member_count
           FROM teams t JOIN team_members m ON m.team_id = t.id
          WHERE m.user_id = ?
          ORDER BY t.created_at`,
        userId,
      )
      .map((row) => ({ team: mapTeam(row), role: str(row.role) as TeamRole, memberCount: num(row.member_count) }));
  }

  getRole(teamId: string, userId: string): TeamRole | undefined {
    const role = this.db.scalar<string>('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId);
    return role === undefined ? undefined : (role as TeamRole);
  }

  addMember(teamId: string, userId: string, role: TeamRole): void {
    this.db.run(
      `INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (team_id, user_id) DO UPDATE SET role = excluded.role`,
      teamId,
      userId,
      role,
      nowIso(),
    );
  }

  setRole(teamId: string, userId: string, role: TeamRole): void {
    this.db.run('UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?', role, teamId, userId);
  }

  removeMember(teamId: string, userId: string): void {
    this.db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId);
  }

  countOwners(teamId: string): number {
    return num(this.db.scalar("SELECT COUNT(*) FROM team_members WHERE team_id = ? AND role = 'owner'", teamId));
  }

  listMembers(teamId: string): MemberRecord[] {
    return this.db
      .all(
        `SELECT u.id, u.name, u.email, u.avatar_url, m.role, m.created_at
           FROM team_members m JOIN users u ON u.id = m.user_id
          WHERE m.team_id = ?
          ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'developer' THEN 2 ELSE 3 END, u.name`,
        teamId,
      )
      .map((row) => ({
        userId: str(row.id),
        name: str(row.name),
        email: str(row.email),
        avatarUrl: strOrNull(row.avatar_url),
        role: str(row.role) as TeamRole,
        joinedAt: str(row.created_at),
      }));
  }

  // -- invitations ----------------------------------------------------------

  createInvitation(teamId: string, email: string, role: TeamRole, invitedBy: string): { token: string; invitation: InvitationRecord } {
    const token = generateToken(32);
    const id = newId('inv');
    const now = new Date();
    this.db.transaction(() => {
      // Re-inviting the same address replaces the previous link.
      this.db.run('DELETE FROM invitations WHERE team_id = ? AND email = ?', teamId, email);
      this.db.run(
        `INSERT INTO invitations (id, team_id, email, role, token_hash, invited_by, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        teamId,
        email.toLowerCase(),
        role,
        sha256(token),
        invitedBy,
        new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
        now.toISOString(),
      );
    });
    return { token, invitation: this.getInvitation(id)! };
  }

  getInvitation(id: string): InvitationRecord | undefined {
    const row = this.db.get(
      'SELECT i.*, u.name AS invited_by_name FROM invitations i LEFT JOIN users u ON u.id = i.invited_by WHERE i.id = ?',
      id,
    );
    return row === undefined ? undefined : mapInvitation(row);
  }

  findInvitationByToken(token: string): InvitationRecord | undefined {
    const row = this.db.get(
      `SELECT i.*, u.name AS invited_by_name FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.token_hash = ? AND i.expires_at > ?`,
      sha256(token),
      nowIso(),
    );
    return row === undefined ? undefined : mapInvitation(row);
  }

  listInvitations(teamId: string): InvitationRecord[] {
    return this.db
      .all(
        `SELECT i.*, u.name AS invited_by_name FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
          WHERE i.team_id = ? AND i.expires_at > ? ORDER BY i.created_at DESC`,
        teamId,
        nowIso(),
      )
      .map(mapInvitation);
  }

  deleteInvitation(id: string): void {
    this.db.run('DELETE FROM invitations WHERE id = ?', id);
  }

  pruneInvitations(): number {
    return this.db.run('DELETE FROM invitations WHERE expires_at <= ?', nowIso()).changes;
  }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditRecord {
  id: string;
  teamId: string | null;
  userId: string | null;
  userName: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  targetName: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AuditInput {
  teamId: string | null;
  userId: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  targetName?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

export class AuditStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  record(entry: AuditInput): void {
    this.db.run(
      `INSERT INTO audit_log (id, team_id, user_id, action, target_type, target_id, target_name, ip, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('aud'),
      entry.teamId,
      entry.userId,
      entry.action,
      entry.targetType,
      entry.targetId ?? null,
      entry.targetName ?? null,
      entry.ip ?? null,
      JSON.stringify(entry.metadata ?? {}),
      nowIso(),
    );
  }

  list(teamId: string, cursor: string | undefined, limit: number): { items: AuditRecord[]; nextCursor: string | null } {
    const after = decodeCursor(cursor);
    const rows = after === null
      ? this.db.all(
          `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
            WHERE a.team_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
          teamId,
          limit + 1,
        )
      : this.db.all(
          `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
            WHERE a.team_id = ? AND (a.created_at, a.id) < (?, ?) ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
          teamId,
          after.createdAt,
          after.id,
          limit + 1,
        );
    return toPage(
      rows.map((row) => ({
        id: str(row.id),
        teamId: strOrNull(row.team_id),
        userId: strOrNull(row.user_id),
        userName: strOrNull(row.user_name),
        action: str(row.action),
        targetType: str(row.target_type),
        targetId: strOrNull(row.target_id),
        targetName: strOrNull(row.target_name),
        ip: strOrNull(row.ip),
        metadata: json<Record<string, unknown>>(row.metadata, {}),
        createdAt: str(row.created_at),
      })),
      limit,
    );
  }

  prune(olderThanIso: string): number {
    return this.db.run('DELETE FROM audit_log WHERE created_at < ?', olderThanIso).changes;
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface PlatformSettings {
  platformDomain: string | null;
  appsDomain: string | null;
  acmeEmail: string | null;
  buildConcurrency: number;
  imageRetention: number;
  metricsRetentionDays: number;
  allowGithubSignup: boolean;
}

export const DEFAULT_SETTINGS: PlatformSettings = {
  platformDomain: null,
  appsDomain: null,
  acmeEmail: null,
  buildConcurrency: 2,
  imageRetention: 5,
  metricsRetentionDays: 7,
  allowGithubSignup: false,
};

/** Key/value store. `platform` holds {@link PlatformSettings}; other keys hold internal state. */
export class SettingsStore {
  private readonly db: Database;
  private cache: PlatformSettings | null = null;

  constructor(db: Database) {
    this.db = db;
  }

  getRaw(key: string): string | null {
    return strOrNull(this.db.scalar('SELECT value FROM settings WHERE key = ?', key));
  }

  setRaw(key: string, value: string | null): void {
    if (value === null) {
      this.db.run('DELETE FROM settings WHERE key = ?', key);
      return;
    }
    this.db.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      key,
      value,
      nowIso(),
    );
  }

  platform(): PlatformSettings {
    if (this.cache === null) {
      const stored = json<Partial<PlatformSettings>>(this.getRaw('platform'), {});
      this.cache = { ...DEFAULT_SETTINGS, ...stored };
    }
    return { ...this.cache };
  }

  updatePlatform(patch: Partial<PlatformSettings>): PlatformSettings {
    const next = { ...this.platform(), ...patch };
    this.setRaw('platform', JSON.stringify(next));
    this.cache = next;
    return { ...next };
  }
}
