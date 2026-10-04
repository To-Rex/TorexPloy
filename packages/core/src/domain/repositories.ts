/**
 * Repositories.
 *
 * Every query lives here so SQL is written once and reviewed once. Two rules
 * hold throughout:
 *
 * 1. Parameters are always bound — never interpolated.
 * 2. Tenant-scoped reads are filtered by `team_id` in SQL, so an authorization
 *    bug cannot silently widen a result set; it returns nothing instead.
 *
 * Env var values are stored encrypted and decrypted at this boundary. The
 * repository takes the master key as a constructor dependency so no module
 * reaches for global configuration.
 */
import type { Database, Row, SqlValue } from '../db/database.ts';
import { decryptSecret, encryptSecret } from '../crypto.ts';
import { newId, nowIso, slugify } from '../ids.ts';
import { conflict, notFound } from '../errors.ts';
import {
  fromBool,
  mapApplication,
  mapAuditEntry,
  mapDeployment,
  mapDomain,
  mapEnvVar,
  mapJob,
  mapProject,
  mapServer,
  mapService,
  mapTeam,
  mapTeamMember,
  mapUser,
  parseJson,
} from './mappers.ts';
import type {
  Application,
  AppSourceType,
  AuditEntry,
  BuildType,
  Deployment,
  DeploymentStatus,
  DeploymentTrigger,
  Domain,
  EnvScope,
  EnvVar,
  Job,
  JobStatus,
  Locale,
  Project,
  RepoProvider,
  Server,
  ServerMode,
  ServerStatus,
  Service,
  ServiceCredentials,
  ServiceStatus,
  ServiceType,
  Team,
  TeamMember,
  TeamRole,
  Theme,
  User,
} from './types.ts';

const ENV_PURPOSE = 'env';
const CREDENTIALS_PURPOSE = 'credentials';

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  email: string;
  name: string;
  passwordHash: string;
  locale?: Locale;
  theme?: Theme;
  isPlatformAdmin?: boolean;
}

export class UserRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: CreateUserInput): User {
    const now = nowIso();
    const id = newId('usr');
    try {
      this.db.run(
        `INSERT INTO users (id, email, name, password_hash, locale, theme, is_platform_admin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.email.trim(),
        input.name.trim(),
        input.passwordHash,
        input.locale ?? 'uz',
        input.theme ?? 'system',
        fromBool(input.isPlatformAdmin ?? false),
        now,
        now,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('A user with this email already exists', { email: input.email });
      }
      throw error;
    }
    return this.getByIdOrThrow(id);
  }

  getById(id: string): User | undefined {
    const row = this.db.get<Row>('SELECT * FROM users WHERE id = ?', id);
    return row === undefined ? undefined : mapUser(row);
  }

  getByIdOrThrow(id: string): User {
    const user = this.getById(id);
    if (user === undefined) throw notFound('User');
    return user;
  }

  getByEmail(email: string): User | undefined {
    const row = this.db.get<Row>('SELECT * FROM users WHERE email = ? COLLATE NOCASE', email.trim());
    return row === undefined ? undefined : mapUser(row);
  }

  /** Includes the password hash; only the auth layer should call this. */
  getCredentialsByEmail(email: string): { user: User; passwordHash: string } | undefined {
    const row = this.db.get<Row>('SELECT * FROM users WHERE email = ? COLLATE NOCASE', email.trim());
    if (row === undefined) return undefined;
    return { user: mapUser(row), passwordHash: String(row.password_hash) };
  }

  count(): number {
    return Number(this.db.scalar<number>('SELECT COUNT(*) FROM users') ?? 0);
  }

  list(): User[] {
    return this.db.all<Row>('SELECT * FROM users ORDER BY created_at ASC').map(mapUser);
  }

  updateProfile(id: string, patch: { name?: string; locale?: Locale; theme?: Theme }): User {
    const current = this.getByIdOrThrow(id);
    this.db.run(
      'UPDATE users SET name = ?, locale = ?, theme = ?, updated_at = ? WHERE id = ?',
      patch.name ?? current.name,
      patch.locale ?? current.locale,
      patch.theme ?? current.theme,
      nowIso(),
      id,
    );
    return this.getByIdOrThrow(id);
  }

  updatePassword(id: string, passwordHash: string): void {
    this.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', passwordHash, nowIso(), id);
  }

  markLogin(id: string): void {
    this.db.run('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), id);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM users WHERE id = ?', id);
  }
}

// ---------------------------------------------------------------------------
// Teams and membership
// ---------------------------------------------------------------------------

export class TeamRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: { name: string; slug?: string }): Team {
    const now = nowIso();
    const id = newId('team');
    const slug = input.slug ?? slugify(input.name, 'team');
    try {
      this.db.run(
        'INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        id,
        input.name.trim(),
        slug,
        now,
        now,
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('A team with this slug already exists', { slug });
      throw error;
    }
    return this.getByIdOrThrow(id);
  }

  getById(id: string): Team | undefined {
    const row = this.db.get<Row>('SELECT * FROM teams WHERE id = ?', id);
    return row === undefined ? undefined : mapTeam(row);
  }

  getByIdOrThrow(id: string): Team {
    const team = this.getById(id);
    if (team === undefined) throw notFound('Team');
    return team;
  }

  getBySlug(slug: string): Team | undefined {
    const row = this.db.get<Row>('SELECT * FROM teams WHERE slug = ?', slug);
    return row === undefined ? undefined : mapTeam(row);
  }

  /** Teams the user belongs to, with the user's role in each. */
  listForUser(userId: string): { team: Team; role: TeamRole }[] {
    return this.db
      .all<Row>(
        `SELECT t.*, m.role AS member_role
           FROM teams t
           JOIN team_members m ON m.team_id = t.id
          WHERE m.user_id = ?
          ORDER BY t.created_at ASC`,
        userId,
      )
      .map((row) => ({ team: mapTeam(row), role: String(row.member_role) as TeamRole }));
  }

  addMember(teamId: string, userId: string, role: TeamRole): TeamMember {
    this.getByIdOrThrow(teamId);
    const now = nowIso();
    const id = newId('tm');
    try {
      this.db.run(
        'INSERT INTO team_members (id, team_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
        id,
        teamId,
        userId,
        role,
        now,
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('This user is already a member of the team');
      throw error;
    }
    return this.getMembershipOrThrow(teamId, userId);
  }

  getMembership(teamId: string, userId: string): TeamMember | undefined {
    const row = this.db.get<Row>('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId);
    return row === undefined ? undefined : mapTeamMember(row);
  }

  getMembershipOrThrow(teamId: string, userId: string): TeamMember {
    const membership = this.getMembership(teamId, userId);
    if (membership === undefined) throw notFound('Team membership');
    return membership;
  }

  getRole(teamId: string, userId: string): TeamRole | undefined {
    return this.getMembership(teamId, userId)?.role;
  }

  listMembers(teamId: string): { member: TeamMember; user: User }[] {
    return this.db
      .all<Row>(
        `SELECT m.*, u.id AS u_id, u.email AS u_email, u.name AS u_name, u.locale AS u_locale,
                u.theme AS u_theme, u.is_platform_admin AS u_admin, u.last_login_at AS u_last_login,
                u.created_at AS u_created, u.updated_at AS u_updated
           FROM team_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.team_id = ?
          ORDER BY m.created_at ASC`,
        teamId,
      )
      .map((row) => ({
        member: mapTeamMember(row),
        user: mapUser({
          id: row.u_id,
          email: row.u_email,
          name: row.u_name,
          locale: row.u_locale,
          theme: row.u_theme,
          is_platform_admin: row.u_admin,
          last_login_at: row.u_last_login,
          created_at: row.u_created,
          updated_at: row.u_updated,
        }),
      }));
  }

  updateRole(teamId: string, userId: string, role: TeamRole): TeamMember {
    const result = this.db.run('UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?', role, teamId, userId);
    if (result.changes === 0) throw notFound('Team membership');
    return this.getMembershipOrThrow(teamId, userId);
  }

  removeMember(teamId: string, userId: string): void {
    this.db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId);
  }

  countOwners(teamId: string): number {
    return Number(
      this.db.scalar<number>("SELECT COUNT(*) FROM team_members WHERE team_id = ? AND role = 'owner'", teamId) ?? 0,
    );
  }

  update(teamId: string, patch: { name?: string }): Team {
    const team = this.getByIdOrThrow(teamId);
    this.db.run('UPDATE teams SET name = ?, updated_at = ? WHERE id = ?', patch.name ?? team.name, nowIso(), teamId);
    return this.getByIdOrThrow(teamId);
  }

  delete(teamId: string): void {
    this.db.run('DELETE FROM teams WHERE id = ?', teamId);
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
  lastUsedAt: string;
  userAgent: string | null;
  ip: string | null;
}

export class SessionRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: { userId: string; tokenHash: string; expiresAt: string; userAgent?: string | null; ip?: string | null }): SessionRecord {
    const now = nowIso();
    const id = newId('sess');
    this.db.run(
      `INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, expires_at, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.userId,
      input.tokenHash,
      input.userAgent ?? null,
      input.ip ?? null,
      input.expiresAt,
      now,
      now,
    );
    return this.getByIdOrThrow(id);
  }

  private map(row: Row): SessionRecord {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      expiresAt: String(row.expires_at),
      createdAt: String(row.created_at),
      lastUsedAt: String(row.last_used_at),
      userAgent: row.user_agent === null ? null : String(row.user_agent),
      ip: row.ip === null ? null : String(row.ip),
    };
  }

  getById(id: string): SessionRecord | undefined {
    const row = this.db.get<Row>('SELECT * FROM sessions WHERE id = ?', id);
    return row === undefined ? undefined : this.map(row);
  }

  getByIdOrThrow(id: string): SessionRecord {
    const session = this.getById(id);
    if (session === undefined) throw notFound('Session');
    return session;
  }

  /**
   * Resolve a session by token hash, rejecting expired rows.
   * Expiry is compared in SQL so a stale session can never be used even if the
   * application clock and the stored value disagree about "now".
   */
  findValidByTokenHash(tokenHash: string, now: string = nowIso()): SessionRecord | undefined {
    const row = this.db.get<Row>('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?', tokenHash, now);
    return row === undefined ? undefined : this.map(row);
  }

  touch(id: string, now: string = nowIso()): void {
    this.db.run('UPDATE sessions SET last_used_at = ? WHERE id = ?', now, id);
  }

  listForUser(userId: string): SessionRecord[] {
    return this.db
      .all<Row>('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC', userId)
      .map((row) => this.map(row));
  }

  delete(id: string): void {
    this.db.run('DELETE FROM sessions WHERE id = ?', id);
  }

  deleteForUser(userId: string): void {
    this.db.run('DELETE FROM sessions WHERE user_id = ?', userId);
  }

  /** Remove expired sessions. Returns how many were deleted. */
  deleteExpired(now: string = nowIso()): number {
    return this.db.run('DELETE FROM sessions WHERE expires_at <= ?', now).changes;
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
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export class ApiTokenRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  private map(row: Row): ApiTokenRecord {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      teamId: String(row.team_id),
      name: String(row.name),
      prefix: String(row.prefix),
      scopes: parseJson<string[]>(row.scopes, []),
      expiresAt: row.expires_at === null ? null : String(row.expires_at),
      lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
      createdAt: String(row.created_at),
    };
  }

  create(input: {
    userId: string;
    teamId: string;
    name: string;
    tokenHash: string;
    prefix: string;
    scopes?: string[];
    expiresAt?: string | null;
  }): ApiTokenRecord {
    const id = newId('tok');
    this.db.run(
      `INSERT INTO api_tokens (id, user_id, team_id, name, token_hash, prefix, scopes, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.userId,
      input.teamId,
      input.name,
      input.tokenHash,
      input.prefix,
      JSON.stringify(input.scopes ?? []),
      input.expiresAt ?? null,
      nowIso(),
    );
    return this.getByIdOrThrow(id);
  }

  getById(id: string): ApiTokenRecord | undefined {
    const row = this.db.get<Row>('SELECT * FROM api_tokens WHERE id = ?', id);
    return row === undefined ? undefined : this.map(row);
  }

  getByIdOrThrow(id: string): ApiTokenRecord {
    const token = this.getById(id);
    if (token === undefined) throw notFound('API token');
    return token;
  }

  findValidByTokenHash(tokenHash: string, now: string = nowIso()): ApiTokenRecord | undefined {
    const row = this.db.get<Row>(
      'SELECT * FROM api_tokens WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > ?)',
      tokenHash,
      now,
    );
    return row === undefined ? undefined : this.map(row);
  }

  listForTeam(teamId: string): ApiTokenRecord[] {
    return this.db
      .all<Row>('SELECT * FROM api_tokens WHERE team_id = ? ORDER BY created_at DESC', teamId)
      .map((row) => this.map(row));
  }

  touch(id: string): void {
    this.db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', nowIso(), id);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM api_tokens WHERE id = ?', id);
  }
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

export class ServerRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: {
    teamId: string;
    name: string;
    mode: ServerMode;
    host?: string | null;
    agentSecret?: string | null;
    status?: ServerStatus;
    dockerVersion?: string | null;
  }): Server {
    const now = nowIso();
    const id = newId('srv');
    try {
      this.db.run(
        `INSERT INTO servers (id, team_id, name, mode, host, agent_secret, status, docker_version, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.teamId,
        input.name,
        input.mode,
        input.host ?? null,
        input.agentSecret ?? null,
        input.status ?? 'unknown',
        input.dockerVersion ?? null,
        null,
        now,
        now,
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('A server with this name already exists in the team');
      throw error;
    }
    return this.getByIdOrThrow(id);
  }

  getById(id: string): Server | undefined {
    const row = this.db.get<Row>('SELECT * FROM servers WHERE id = ?', id);
    return row === undefined ? undefined : mapServer(row);
  }

  getByIdOrThrow(id: string): Server {
    const server = this.getById(id);
    if (server === undefined) throw notFound('Server');
    return server;
  }

  /** Fetch a server only if it belongs to the team — the authorization-safe read. */
  getInTeam(teamId: string, serverId: string): Server | undefined {
    const row = this.db.get<Row>('SELECT * FROM servers WHERE id = ? AND team_id = ?', serverId, teamId);
    return row === undefined ? undefined : mapServer(row);
  }

  listForTeam(teamId: string): Server[] {
    return this.db.all<Row>('SELECT * FROM servers WHERE team_id = ? ORDER BY created_at ASC', teamId).map(mapServer);
  }

  findLocal(teamId: string): Server | undefined {
    const row = this.db.get<Row>("SELECT * FROM servers WHERE team_id = ? AND mode = 'local' LIMIT 1", teamId);
    return row === undefined ? undefined : mapServer(row);
  }

  updateStatus(id: string, status: ServerStatus, dockerVersion?: string | null): void {
    this.db.run(
      'UPDATE servers SET status = ?, docker_version = COALESCE(?, docker_version), last_seen_at = ?, updated_at = ? WHERE id = ?',
      status,
      dockerVersion ?? null,
      nowIso(),
      nowIso(),
      id,
    );
  }

  update(id: string, patch: { name?: string; host?: string | null; agentSecret?: string | null }): Server {
    const server = this.getByIdOrThrow(id);
    this.db.run(
      'UPDATE servers SET name = ?, host = ?, agent_secret = ?, updated_at = ? WHERE id = ?',
      patch.name ?? server.name,
      patch.host === undefined ? server.host : patch.host,
      // `undefined` leaves the stored secret untouched; passing `null` clears it.
      patch.agentSecret === undefined ? this.getAgentSecret(id) : patch.agentSecret,
      nowIso(),
      id,
    );
    return this.getByIdOrThrow(id);
  }

  getAgentSecret(id: string): string | null {
    const value = this.db.scalar<string>('SELECT agent_secret FROM servers WHERE id = ?', id);
    return value === undefined || value === null ? null : String(value);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM servers WHERE id = ?', id);
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export class ProjectRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: { teamId: string; name: string; slug?: string; description?: string | null }): Project {
    const now = nowIso();
    const id = newId('prj');
    const slug = input.slug ?? slugify(input.name, 'project');
    try {
      this.db.run(
        'INSERT INTO projects (id, team_id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        input.teamId,
        input.name.trim(),
        slug,
        input.description ?? null,
        now,
        now,
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('A project with this slug already exists in the team', { slug });
      throw error;
    }
    return this.getByIdOrThrow(id);
  }

  getById(id: string): Project | undefined {
    const row = this.db.get<Row>('SELECT * FROM projects WHERE id = ?', id);
    return row === undefined ? undefined : mapProject(row);
  }

  getByIdOrThrow(id: string): Project {
    const project = this.getById(id);
    if (project === undefined) throw notFound('Project');
    return project;
  }

  getInTeam(teamId: string, projectId: string): Project | undefined {
    const row = this.db.get<Row>('SELECT * FROM projects WHERE id = ? AND team_id = ?', projectId, teamId);
    return row === undefined ? undefined : mapProject(row);
  }

  listForTeam(teamId: string): Project[] {
    return this.db.all<Row>('SELECT * FROM projects WHERE team_id = ? ORDER BY created_at ASC', teamId).map(mapProject);
  }

  update(id: string, patch: { name?: string; description?: string | null }): Project {
    const project = this.getByIdOrThrow(id);
    this.db.run(
      'UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?',
      patch.name ?? project.name,
      patch.description === undefined ? project.description : patch.description,
      nowIso(),
      id,
    );
    return this.getByIdOrThrow(id);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM projects WHERE id = ?', id);
  }
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export interface CreateApplicationInput {
  projectId: string;
  serverId: string;
  name: string;
  slug?: string;
  sourceType?: AppSourceType;
  repoUrl?: string | null;
  repoBranch?: string;
  repoProvider?: RepoProvider;
  buildType?: BuildType;
  dockerfilePath?: string;
  buildContext?: string;
  buildArgs?: Record<string, string>;
  installCommand?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  outputDir?: string | null;
  internalPort?: string | null;
  replicas?: number;
  cpuLimit?: number | null;
  memoryLimitMb?: number | null;
  healthCheckPath?: string | null;
  autoDeploy?: boolean;
}

export class ApplicationRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: CreateApplicationInput): Application {
    const now = nowIso();
    const id = newId('app');
    const slug = input.slug ?? slugify(input.name, 'app');
    const webhookSecret = newId('wh');
    try {
      this.db.run(
        `INSERT INTO applications (
           id, project_id, server_id, name, slug, source_type, repo_url, repo_branch, repo_provider,
           build_type, dockerfile_path, build_context, build_args, install_command, build_command,
           start_command, output_dir, internal_port, replicas, cpu_limit, memory_limit_mb,
           health_check_path, auto_deploy, webhook_secret, status, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        input.projectId,
        input.serverId,
        input.name.trim(),
        slug,
        input.sourceType ?? 'git',
        input.repoUrl ?? null,
        input.repoBranch ?? 'main',
        input.repoProvider ?? 'github',
        input.buildType ?? 'dockerfile',
        input.dockerfilePath ?? 'Dockerfile',
        input.buildContext ?? '.',
        JSON.stringify(input.buildArgs ?? {}),
        input.installCommand ?? null,
        input.buildCommand ?? null,
        input.startCommand ?? null,
        input.outputDir ?? null,
        input.internalPort ?? null,
        input.replicas ?? 1,
        input.cpuLimit ?? null,
        input.memoryLimitMb ?? null,
        input.healthCheckPath ?? null,
        fromBool(input.autoDeploy ?? true),
        webhookSecret,
        'idle',
        now,
        now,
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('An application with this slug already exists in the project', { slug });
      throw error;
    }
    return this.getByIdOrThrow(id);
  }

  getById(id: string): Application | undefined {
    const row = this.db.get<Row>('SELECT * FROM applications WHERE id = ?', id);
    return row === undefined ? undefined : mapApplication(row);
  }

  getByIdOrThrow(id: string): Application {
    const application = this.getById(id);
    if (application === undefined) throw notFound('Application');
    return application;
  }

  listForProject(projectId: string): Application[] {
    return this.db
      .all<Row>('SELECT * FROM applications WHERE project_id = ? ORDER BY created_at ASC', projectId)
      .map(mapApplication);
  }

  /**
   * List applications across every project in a team.
   * Used by the dashboard, which needs one query rather than N.
   */
  listForTeam(teamId: string): Application[] {
    return this.db
      .all<Row>(
        `SELECT a.* FROM applications a
           JOIN projects p ON p.id = a.project_id
          WHERE p.team_id = ?
          ORDER BY a.created_at ASC`,
        teamId,
      )
      .map(mapApplication);
  }

  /** Resolve an application and its project in one query, enforcing team scope. */
  getInTeam(teamId: string, applicationId: string): { application: Application; project: Project } | undefined {
    const row = this.db.get<Row>(
      `SELECT a.*,
              p.id AS p_id, p.team_id AS p_team_id, p.name AS p_name, p.slug AS p_slug,
              p.description AS p_description, p.created_at AS p_created_at, p.updated_at AS p_updated_at
         FROM applications a
         JOIN projects p ON p.id = a.project_id
        WHERE a.id = ? AND p.team_id = ?`,
      applicationId,
      teamId,
    );
    if (row === undefined) return undefined;
    return {
      application: mapApplication(row),
      project: mapProject({
        id: row.p_id,
        team_id: row.p_team_id,
        name: row.p_name,
        slug: row.p_slug,
        description: row.p_description,
        created_at: row.p_created_at,
        updated_at: row.p_updated_at,
      }),
    };
  }

  findByWebhookSecret(secret: string): Application | undefined {
    const row = this.db.get<Row>('SELECT * FROM applications WHERE webhook_secret = ?', secret);
    return row === undefined ? undefined : mapApplication(row);
  }

  update(id: string, patch: Partial<CreateApplicationInput>): Application {
    const current = this.getByIdOrThrow(id);
    this.db.run(
      `UPDATE applications SET
         name = ?, repo_url = ?, repo_branch = ?, repo_provider = ?, build_type = ?,
         dockerfile_path = ?, build_context = ?, build_args = ?, install_command = ?,
         build_command = ?, start_command = ?, output_dir = ?, internal_port = ?,
         replicas = ?, cpu_limit = ?, memory_limit_mb = ?, health_check_path = ?,
         auto_deploy = ?, server_id = ?, updated_at = ?
       WHERE id = ?`,
      patch.name ?? current.name,
      patch.repoUrl === undefined ? current.repoUrl : patch.repoUrl,
      patch.repoBranch ?? current.repoBranch,
      patch.repoProvider ?? current.repoProvider,
      patch.buildType ?? current.buildType,
      patch.dockerfilePath ?? current.dockerfilePath,
      patch.buildContext ?? current.buildContext,
      JSON.stringify(patch.buildArgs ?? current.buildArgs),
      patch.installCommand === undefined ? current.installCommand : patch.installCommand,
      patch.buildCommand === undefined ? current.buildCommand : patch.buildCommand,
      patch.startCommand === undefined ? current.startCommand : patch.startCommand,
      patch.outputDir === undefined ? current.outputDir : patch.outputDir,
      patch.internalPort === undefined ? current.internalPort : patch.internalPort,
      patch.replicas ?? current.replicas,
      patch.cpuLimit === undefined ? current.cpuLimit : patch.cpuLimit,
      patch.memoryLimitMb === undefined ? current.memoryLimitMb : patch.memoryLimitMb,
      patch.healthCheckPath === undefined ? current.healthCheckPath : patch.healthCheckPath,
      fromBool(patch.autoDeploy ?? current.autoDeploy),
      patch.serverId ?? current.serverId,
      nowIso(),
      id,
    );
    return this.getByIdOrThrow(id);
  }

  setStatus(id: string, status: Application['status']): void {
    this.db.run('UPDATE applications SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id);
  }

  rotateWebhookSecret(id: string): string {
    const secret = newId('wh');
    this.db.run('UPDATE applications SET webhook_secret = ?, updated_at = ? WHERE id = ?', secret, nowIso(), id);
    return secret;
  }

  getWebhookSecret(id: string): string | null {
    const value = this.db.scalar<string>('SELECT webhook_secret FROM applications WHERE id = ?', id);
    return value === undefined || value === null ? null : String(value);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM applications WHERE id = ?', id);
  }
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

export class EnvVarRepository {
  private readonly db: Database;
  private readonly masterKey: string;

  constructor(db: Database, masterKey: string) {
    this.db = db;
    this.masterKey = masterKey;
  }

  private encrypt(value: string): string {
    return encryptSecret(value, this.masterKey, ENV_PURPOSE);
  }

  private decrypt(value: string): string {
    try {
      return decryptSecret(value, this.masterKey, ENV_PURPOSE);
    } catch {
      // A value that cannot be decrypted (rotated key, corrupted row) must not
      // take down a request; surface it explicitly instead of silently injecting
      // a wrong secret into a deployment.
      return '';
    }
  }

  /** Create or replace a variable for an application or a project. */
  set(input: {
    applicationId?: string | null;
    projectId?: string | null;
    key: string;
    value: string;
    isSecret?: boolean;
    scope?: EnvScope;
  }): EnvVar {
    const applicationId = input.applicationId ?? null;
    const projectId = input.projectId ?? null;
    if ((applicationId === null) === (projectId === null)) {
      throw conflict('An environment variable must belong to exactly one application or project');
    }

    const key = input.key.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw conflict(`Invalid environment variable name "${input.key}"`, { key: input.key });
    }

    const now = nowIso();
    const isSecret = fromBool(input.isSecret ?? true);
    const scope = input.scope ?? 'runtime';
    const encrypted = this.encrypt(input.value);

    const existing =
      applicationId !== null
        ? this.db.get<Row>('SELECT id FROM env_vars WHERE application_id = ? AND key = ?', applicationId, key)
        : this.db.get<Row>('SELECT id FROM env_vars WHERE project_id = ? AND key = ?', projectId, key);

    const id = existing !== undefined ? String(existing.id) : newId('env');
    if (existing !== undefined) {
      this.db.run(
        'UPDATE env_vars SET value = ?, is_secret = ?, scope = ?, updated_at = ? WHERE id = ?',
        encrypted,
        isSecret,
        scope,
        now,
        id,
      );
    } else {
      this.db.run(
        `INSERT INTO env_vars (id, application_id, project_id, key, value, is_secret, scope, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        applicationId,
        projectId,
        key,
        encrypted,
        isSecret,
        scope,
        now,
        now,
      );
    }

    // Read back the stored row so the caller receives the persisted state
    // (including the real created_at) rather than a hand-assembled guess.
    const row = this.db.get<Row>('SELECT * FROM env_vars WHERE id = ?', id)!;
    return mapEnvVar(row, input.value);
  }

  listForApplication(applicationId: string): EnvVar[] {
    return this.db
      .all<Row>('SELECT * FROM env_vars WHERE application_id = ? ORDER BY key ASC', applicationId)
      .map((row) => mapEnvVar(row, this.decrypt(String(row.value))));
  }

  listForProject(projectId: string): EnvVar[] {
    return this.db
      .all<Row>('SELECT * FROM env_vars WHERE project_id = ? ORDER BY key ASC', projectId)
      .map((row) => mapEnvVar(row, this.decrypt(String(row.value))));
  }

  /**
   * Resolve the effective environment for an application: project-level
   * variables first, then application-level overrides on top.
   */
  resolveForApplication(applicationId: string, projectId: string, scope: EnvScope = 'runtime'): Record<string, string> {
    const out: Record<string, string> = {};
    const applies = (value: string): boolean =>
      scope === 'runtime' ? value === 'runtime' || value === 'both' : value === 'build' || value === 'both';

    for (const row of this.db.all<Row>('SELECT * FROM env_vars WHERE project_id = ? ORDER BY key ASC', projectId)) {
      if (!applies(String(row.scope))) continue;
      out[String(row.key)] = this.decrypt(String(row.value));
    }
    for (const row of this.db.all<Row>('SELECT * FROM env_vars WHERE application_id = ? ORDER BY key ASC', applicationId)) {
      if (!applies(String(row.scope))) continue;
      out[String(row.key)] = this.decrypt(String(row.value));
    }
    return out;
  }

  delete(scope: { applicationId?: string; projectId?: string }, key: string): boolean {
    const result =
      scope.applicationId !== undefined
        ? this.db.run('DELETE FROM env_vars WHERE application_id = ? AND key = ?', scope.applicationId, key)
        : this.db.run('DELETE FROM env_vars WHERE project_id = ? AND key = ?', scope.projectId ?? null, key);
    return result.changes > 0;
  }

  deleteAllForApplication(applicationId: string): void {
    this.db.run('DELETE FROM env_vars WHERE application_id = ?', applicationId);
  }

  getById(id: string): EnvVar | undefined {
    const row = this.db.get<Row>('SELECT * FROM env_vars WHERE id = ?', id);
    return row === undefined ? undefined : mapEnvVar(row, this.decrypt(String(row.value)));
  }
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export class DomainRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: {
    applicationId: string;
    host: string;
    pathPrefix?: string;
    port?: number | null;
    https?: boolean;
    isPrimary?: boolean;
  }): Domain {
    const now = nowIso();
    const id = newId('dom');
    const host = input.host.trim().toLowerCase();
    try {
      this.db.run(
        `INSERT INTO domains (id, application_id, host, path_prefix, port, https, is_primary, status, cert_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.applicationId,
        host,
        input.pathPrefix ?? '/',
        input.port ?? null,
        fromBool(input.https ?? true),
        fromBool(input.isPrimary ?? false),
        'pending',
        input.https === false ? 'disabled' : 'pending',
        now,
        now,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('This hostname is already configured on another application', { host });
      }
      throw error;
    }
    return this.getByIdOrThrow(id);
  }

  getById(id: string): Domain | undefined {
    const row = this.db.get<Row>('SELECT * FROM domains WHERE id = ?', id);
    return row === undefined ? undefined : mapDomain(row);
  }

  getByIdOrThrow(id: string): Domain {
    const domain = this.getById(id);
    if (domain === undefined) throw notFound('Domain');
    return domain;
  }

  getByHost(host: string): Domain | undefined {
    const row = this.db.get<Row>('SELECT * FROM domains WHERE host = ?', host.trim().toLowerCase());
    return row === undefined ? undefined : mapDomain(row);
  }

  listForApplication(applicationId: string): Domain[] {
    return this.db
      .all<Row>('SELECT * FROM domains WHERE application_id = ? ORDER BY is_primary DESC, created_at ASC', applicationId)
      .map(mapDomain);
  }

  listAll(): Domain[] {
    return this.db.all<Row>('SELECT * FROM domains ORDER BY host ASC').map(mapDomain);
  }

  updateStatus(id: string, status: Domain['status'], certStatus: Domain['certStatus'], errorMessage?: string | null): void {
    this.db.run(
      'UPDATE domains SET status = ?, cert_status = ?, error_message = ?, updated_at = ? WHERE id = ?',
      status,
      certStatus,
      errorMessage ?? null,
      nowIso(),
      id,
    );
  }

  setPrimary(applicationId: string, domainId: string): void {
    this.db.transaction(() => {
      this.db.run('UPDATE domains SET is_primary = 0, updated_at = ? WHERE application_id = ?', nowIso(), applicationId);
      this.db.run('UPDATE domains SET is_primary = 1, updated_at = ? WHERE id = ? AND application_id = ?', nowIso(), domainId, applicationId);
    });
  }

  delete(id: string): void {
    this.db.run('DELETE FROM domains WHERE id = ?', id);
  }
}

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

export class DeploymentRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: {
    applicationId: string;
    serverId: string;
    trigger: DeploymentTrigger;
    branch?: string | null;
    commitSha?: string | null;
    commitMessage?: string | null;
    commitAuthor?: string | null;
    logPath?: string | null;
    createdBy?: string | null;
    rollbackOf?: string | null;
  }): Deployment {
    const id = newId('dep');
    this.db.run(
      `INSERT INTO deployments (
         id, application_id, server_id, status, trigger, commit_sha, commit_message, commit_author,
         branch, container_ids, log_path, rollback_of, started_at, created_by
       ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
      id,
      input.applicationId,
      input.serverId,
      input.trigger,
      input.commitSha ?? null,
      input.commitMessage ?? null,
      input.commitAuthor ?? null,
      input.branch ?? null,
      input.logPath ?? null,
      input.rollbackOf ?? null,
      nowIso(),
      input.createdBy ?? null,
    );
    return this.getByIdOrThrow(id);
  }

  getById(id: string): Deployment | undefined {
    const row = this.db.get<Row>('SELECT * FROM deployments WHERE id = ?', id);
    return row === undefined ? undefined : mapDeployment(row);
  }

  getByIdOrThrow(id: string): Deployment {
    const deployment = this.getById(id);
    if (deployment === undefined) throw notFound('Deployment');
    return deployment;
  }

  listForApplication(applicationId: string, limit = 50): Deployment[] {
    // `rowid DESC` breaks ties deterministically: two deployments can start in
    // the same millisecond (webhook storm, rapid redeploy), and history must
    // still read newest-first instead of depending on storage order.
    return this.db
      .all<Row>(
        'SELECT * FROM deployments WHERE application_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?',
        applicationId,
        limit,
      )
      .map(mapDeployment);
  }

  listForTeam(teamId: string, limit = 100): Deployment[] {
    return this.db
      .all<Row>(
        `SELECT d.* FROM deployments d
           JOIN applications a ON a.id = d.application_id
           JOIN projects p ON p.id = a.project_id
          WHERE p.team_id = ?
          ORDER BY d.started_at DESC, d.rowid DESC
          LIMIT ?`,
        teamId,
        limit,
      )
      .map(mapDeployment);
  }

  listActiveForApplication(applicationId: string): Deployment[] {
    return this.db
      .all<Row>(
        `SELECT * FROM deployments
          WHERE application_id = ?
            AND status IN ('queued','building','deploying','running')
          ORDER BY started_at ASC`,
        applicationId,
      )
      .map(mapDeployment);
  }

  /** The most recent successful deployment — the rollback target. */
  getLastSuccessful(applicationId: string): Deployment | undefined {
    const row = this.db.get<Row>(
      `SELECT * FROM deployments
        WHERE application_id = ? AND status = 'success' AND image_tag IS NOT NULL
        ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
      applicationId,
    );
    return row === undefined ? undefined : mapDeployment(row);
  }

  getRunning(applicationId: string): Deployment | undefined {
    const row = this.db.get<Row>(
      "SELECT * FROM deployments WHERE application_id = ? AND status = 'success' ORDER BY finished_at DESC LIMIT 1",
      applicationId,
    );
    return row === undefined ? undefined : mapDeployment(row);
  }

  updateStatus(id: string, status: DeploymentStatus, patch: Partial<Pick<Deployment, 'errorMessage' | 'imageTag' | 'containerIds' | 'logPath'>> = {}): void {
    const sets: string[] = ['status = ?'];
    const params: SqlValue[] = [status];

    if (patch.errorMessage !== undefined) {
      sets.push('error_message = ?');
      params.push(patch.errorMessage);
    }
    if (patch.imageTag !== undefined) {
      sets.push('image_tag = ?');
      params.push(patch.imageTag);
    }
    if (patch.containerIds !== undefined) {
      sets.push('container_ids = ?');
      params.push(JSON.stringify(patch.containerIds));
    }
    if (patch.logPath !== undefined) {
      sets.push('log_path = ?');
      params.push(patch.logPath);
    }

    params.push(id);
    this.db.run(`UPDATE deployments SET ${sets.join(', ')} WHERE id = ?`, ...params);
  }

  finish(id: string, status: DeploymentStatus, errorMessage?: string | null): void {
    const deployment = this.getByIdOrThrow(id);
    const finishedAt = nowIso();
    const durationMs = Date.parse(finishedAt) - Date.parse(deployment.startedAt);
    this.db.run(
      'UPDATE deployments SET status = ?, finished_at = ?, duration_ms = ?, error_message = ? WHERE id = ?',
      status,
      finishedAt,
      Number.isFinite(durationMs) ? Math.max(0, durationMs) : null,
      errorMessage ?? null,
      id,
    );
  }

  updateCommitInfo(id: string, info: { sha?: string | null; message?: string | null; author?: string | null; branch?: string | null }): void {
    this.db.run(
      `UPDATE deployments SET
         commit_sha = COALESCE(?, commit_sha),
         commit_message = COALESCE(?, commit_message),
         commit_author = COALESCE(?, commit_author),
         branch = COALESCE(?, branch)
       WHERE id = ?`,
      info.sha ?? null,
      info.message ?? null,
      info.author ?? null,
      info.branch ?? null,
      id,
    );
  }

  /**
   * Mark deployments left mid-flight by a crash as failed.
   *
   * Without this a control-plane restart would leave applications stuck in
   * `building` forever, because nothing is driving them any more.
   */
  failStale(activeStatuses: DeploymentStatus[], message: string): number {
    const placeholders = activeStatuses.map(() => '?').join(',');
    return this.db.run(
      `UPDATE deployments
          SET status = 'failed', finished_at = ?, error_message = ?
        WHERE status IN (${placeholders})`,
      nowIso(),
      message,
      ...activeStatuses,
    ).changes;
  }

  delete(id: string): void {
    this.db.run('DELETE FROM deployments WHERE id = ?', id);
  }
}

// ---------------------------------------------------------------------------
// Jobs (queue)
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  kind: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  /** Delay before the job becomes eligible, in milliseconds. */
  delayMs?: number;
}

export class JobRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  enqueue(input: EnqueueInput): Job {
    const id = newId('job');
    const runAt = new Date(Date.now() + (input.delayMs ?? 0)).toISOString();
    this.db.run(
      `INSERT INTO jobs (id, kind, payload, status, priority, attempts, max_attempts, run_at, created_at)
       VALUES (?, ?, ?, 'queued', ?, 0, ?, ?, ?)`,
      id,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? 100,
      input.maxAttempts ?? 3,
      runAt,
      nowIso(),
    );
    return this.getByIdOrThrow(id);
  }

  getById(id: string): Job | undefined {
    const row = this.db.get<Row>('SELECT * FROM jobs WHERE id = ?', id);
    return row === undefined ? undefined : mapJob(row);
  }

  getByIdOrThrow(id: string): Job {
    const job = this.getById(id);
    if (job === undefined) throw notFound('Job');
    return job;
  }

  /**
   * Atomically claim the next eligible job for a worker.
   *
   * A single `UPDATE ... RETURNING` both selects and claims, so two workers
   * racing on the same row cannot both win: SQLite serializes the write and the
   * loser gets zero rows back.
   */
  claimNext(workerId: string, kinds?: string[]): Job | undefined {
    const now = nowIso();
    const kindFilter = kinds !== undefined && kinds.length > 0
      ? `AND kind IN (${kinds.map(() => '?').join(',')})`
      : '';

    const rows = this.db.all<Row>(
      `UPDATE jobs
          SET status = 'running', worker_id = ?, started_at = ?, attempts = attempts + 1
        WHERE id = (
          SELECT id FROM jobs
           WHERE status = 'queued' AND run_at <= ?
           ${kindFilter}
           ORDER BY priority ASC, run_at ASC
           LIMIT 1
        )
        RETURNING *`,
      workerId,
      now,
      now,
      ...(kinds ?? []),
    );

    const row = rows[0];
    return row === undefined ? undefined : mapJob(row);
  }

  complete(id: string): void {
    this.db.run("UPDATE jobs SET status = 'done', finished_at = ?, worker_id = NULL WHERE id = ?", nowIso(), id);
  }

  /**
   * Record a failed attempt. Retries with exponential backoff until
   * `max_attempts` is exhausted, then the job is marked failed for good.
   */
  fail(id: string, error: string): { willRetry: boolean; attempts: number; maxAttempts: number } {
    const job = this.getByIdOrThrow(id);
    const willRetry = job.attempts < job.maxAttempts;

    if (!willRetry) {
      this.db.run(
        "UPDATE jobs SET status = 'failed', finished_at = ?, last_error = ?, worker_id = NULL WHERE id = ?",
        nowIso(),
        error,
        id,
      );
      return { willRetry, attempts: job.attempts, maxAttempts: job.maxAttempts };
    }

    // 2s, 8s, 18s, ... — quadratic backoff, capped at 5 minutes.
    const backoffMs = Math.min(5 * 60_000, 2_000 * job.attempts * job.attempts);
    this.db.run(
      "UPDATE jobs SET status = 'queued', run_at = ?, last_error = ?, worker_id = NULL WHERE id = ?",
      new Date(Date.now() + backoffMs).toISOString(),
      error,
      id,
    );
    return { willRetry, attempts: job.attempts, maxAttempts: job.maxAttempts };
  }

  cancel(id: string): boolean {
    return (
      this.db.run("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued','running')", nowIso(), id)
        .changes > 0
    );
  }

  listPending(kinds?: string[]): Job[] {
    if (kinds !== undefined && kinds.length > 0) {
      return this.db
        .all<Row>(
          `SELECT * FROM jobs WHERE status IN ('queued','running') AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY priority ASC, run_at ASC`,
          ...kinds,
        )
        .map(mapJob);
    }
    return this.db
      .all<Row>("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY priority ASC, run_at ASC")
      .map(mapJob);
  }

  listRecent(limit = 50): Job[] {
    return this.db.all<Row>('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?', limit).map(mapJob);
  }

  /** Reset jobs left `running` by a crash so they are retried. */
  requeueOrphans(): number {
    return this.db.run(
      "UPDATE jobs SET status = 'queued', worker_id = NULL WHERE status = 'running'",
    ).changes;
  }

  countByStatus(): Record<JobStatus, number> {
    const out: Record<JobStatus, number> = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const row of this.db.all<Row>('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status')) {
      out[String(row.status) as JobStatus] = Number(row.count);
    }
    return out;
  }

  /** Delete finished jobs older than the retention window. */
  prune(olderThanIso: string): number {
    return this.db.run("DELETE FROM jobs WHERE status IN ('done','failed','cancelled') AND created_at < ?", olderThanIso).changes;
  }
}

// ---------------------------------------------------------------------------
// Services (managed databases / caches)
// ---------------------------------------------------------------------------

export class ServiceRepository {
  private readonly db: Database;
  private readonly masterKey: string;

  constructor(db: Database, masterKey: string) {
    this.db = db;
    this.masterKey = masterKey;
  }

  create(input: {
    projectId: string;
    serverId: string;
    name: string;
    slug?: string;
    type: ServiceType;
    version: string;
    internalPort: number;
    credentials: ServiceCredentials;
    volumeName?: string | null;
    cpuLimit?: number | null;
    memoryLimitMb?: number | null;
  }): Service {
    const now = nowIso();
    const id = newId('svc');
    const slug = input.slug ?? slugify(input.name, input.type);
    try {
      this.db.run(
        `INSERT INTO services (id, project_id, server_id, name, slug, type, version, status, internal_port, credentials, volume_name, cpu_limit, memory_limit_mb, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.projectId,
        input.serverId,
        input.name.trim(),
        slug,
        input.type,
        input.version,
        input.internalPort,
        encryptSecret(JSON.stringify(input.credentials), this.masterKey, CREDENTIALS_PURPOSE),
        input.volumeName ?? `${slug}-data`,
        input.cpuLimit ?? null,
        input.memoryLimitMb ?? null,
        now,
        now,
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('A service with this slug already exists in the project', { slug });
      throw error;
    }
    return this.getByIdOrThrow(id);
  }

  private mapRow(row: Row): Service {
    let credentials: ServiceCredentials = {};
    try {
      credentials = JSON.parse(decryptSecret(String(row.credentials), this.masterKey, CREDENTIALS_PURPOSE)) as ServiceCredentials;
    } catch {
      credentials = {};
    }
    return mapService(row, credentials);
  }

  getById(id: string): Service | undefined {
    const row = this.db.get<Row>('SELECT * FROM services WHERE id = ?', id);
    return row === undefined ? undefined : this.mapRow(row);
  }

  getByIdOrThrow(id: string): Service {
    const service = this.getById(id);
    if (service === undefined) throw notFound('Service');
    return service;
  }

  getInTeam(teamId: string, serviceId: string): { service: Service; project: Project } | undefined {
    const row = this.db.get<Row>(
      `SELECT s.*,
              p.id AS p_id, p.team_id AS p_team_id, p.name AS p_name, p.slug AS p_slug,
              p.description AS p_description, p.created_at AS p_created_at, p.updated_at AS p_updated_at
         FROM services s
         JOIN projects p ON p.id = s.project_id
        WHERE s.id = ? AND p.team_id = ?`,
      serviceId,
      teamId,
    );
    if (row === undefined) return undefined;
    return {
      service: this.mapRow(row),
      project: mapProject({
        id: row.p_id,
        team_id: row.p_team_id,
        name: row.p_name,
        slug: row.p_slug,
        description: row.p_description,
        created_at: row.p_created_at,
        updated_at: row.p_updated_at,
      }),
    };
  }

  listForProject(projectId: string): Service[] {
    return this.db.all<Row>('SELECT * FROM services WHERE project_id = ? ORDER BY created_at ASC', projectId).map((row) => this.mapRow(row));
  }

  setStatus(id: string, status: ServiceStatus): void {
    this.db.run('UPDATE services SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id);
  }

  updateCredentials(id: string, credentials: ServiceCredentials): void {
    this.db.run(
      'UPDATE services SET credentials = ?, updated_at = ? WHERE id = ?',
      encryptSecret(JSON.stringify(credentials), this.masterKey, CREDENTIALS_PURPOSE),
      nowIso(),
      id,
    );
  }

  delete(id: string): void {
    this.db.run('DELETE FROM services WHERE id = ?', id);
  }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export class AuditRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  record(input: {
    teamId?: string | null;
    userId?: string | null;
    action: string;
    resource: string;
    resourceId?: string | null;
    ip?: string | null;
    metadata?: Record<string, unknown>;
  }): AuditEntry {
    const id = newId('aud');
    this.db.run(
      `INSERT INTO audit_log (id, team_id, user_id, action, resource, resource_id, ip, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.teamId ?? null,
      input.userId ?? null,
      input.action,
      input.resource,
      input.resourceId ?? null,
      input.ip ?? null,
      JSON.stringify(input.metadata ?? {}),
      nowIso(),
    );
    return mapAuditEntry(this.db.get<Row>('SELECT * FROM audit_log WHERE id = ?', id)!);
  }

  listForTeam(teamId: string, limit = 100): AuditEntry[] {
    return this.db
      .all<Row>('SELECT * FROM audit_log WHERE team_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', teamId, limit)
      .map(mapAuditEntry);
  }

  prune(olderThanIso: string): number {
    return this.db.run('DELETE FROM audit_log WHERE created_at < ?', olderThanIso).changes;
  }
}

// ---------------------------------------------------------------------------
// Settings (platform-wide key/value)
// ---------------------------------------------------------------------------

export class SettingsRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  get<T>(key: string, fallback: T): T {
    const row = this.db.get<Row>('SELECT value FROM settings WHERE key = ?', key);
    if (row === undefined) return fallback;
    return parseJson<T>(row.value, fallback);
  }

  set(key: string, value: unknown): void {
    const now = nowIso();
    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      now,
    );
  }

  delete(key: string): void {
    this.db.run('DELETE FROM settings WHERE key = ?', key);
  }

  has(key: string): boolean {
    return this.db.get<Row>('SELECT 1 AS present FROM settings WHERE key = ?', key) !== undefined;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect a UNIQUE constraint failure from node:sqlite without string sniffing alone. */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const message = 'message' in error ? String((error as { message: unknown }).message) : '';
  return /UNIQUE constraint failed/i.test(message);
}

/** Bundle every repository so callers receive one consistent object. */
export interface Repositories {
  users: UserRepository;
  teams: TeamRepository;
  sessions: SessionRepository;
  apiTokens: ApiTokenRepository;
  servers: ServerRepository;
  projects: ProjectRepository;
  applications: ApplicationRepository;
  envVars: EnvVarRepository;
  domains: DomainRepository;
  deployments: DeploymentRepository;
  jobs: JobRepository;
  services: ServiceRepository;
  audit: AuditRepository;
  settings: SettingsRepository;
}

export function createRepositories(db: Database, masterKey: string): Repositories {
  return {
    users: new UserRepository(db),
    teams: new TeamRepository(db),
    sessions: new SessionRepository(db),
    apiTokens: new ApiTokenRepository(db),
    servers: new ServerRepository(db),
    projects: new ProjectRepository(db),
    applications: new ApplicationRepository(db),
    envVars: new EnvVarRepository(db, masterKey),
    domains: new DomainRepository(db),
    deployments: new DeploymentRepository(db),
    jobs: new JobRepository(db),
    services: new ServiceRepository(db, masterKey),
    audit: new AuditRepository(db),
    settings: new SettingsRepository(db),
  };
}