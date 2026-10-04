/**
 * Schema migrations.
 *
 * Each entry runs exactly once, inside a transaction, and is recorded in
 * `schema_migrations`. Migrations are append-only: never edit a shipped
 * migration, add a new one. That is what makes upgrades safe on a live VPS.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Migration 1 — the complete control-plane schema.
 *
 * Design notes:
 * - Ids are prefixed TEXT (e.g. `app_9f2...`) so a row is self-describing in a log line.
 * - Timestamps are ISO-8601 TEXT: sortable, timezone-explicit, readable in `sqlite3`.
 * - Tenant-scoped rows carry `team_id` so authorization is one indexed check.
 * - Statuses use CHECK constraints so a bug cannot persist an unknown state.
 * - `env_vars` is scoped to exactly one of application or project (XOR check).
 */
const INITIAL_SCHEMA = `
CREATE TABLE teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name              TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  locale            TEXT NOT NULL DEFAULT 'uz' CHECK (locale IN ('uz','ru','en')),
  theme             TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')),
  is_platform_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_platform_admin IN (0,1)),
  last_login_at     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE team_members (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner','admin','developer','viewer')),
  created_at TEXT NOT NULL,
  UNIQUE (team_id, user_id)
);
CREATE INDEX idx_team_members_user ON team_members(user_id);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  user_agent   TEXT,
  ip           TEXT,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT '[]',
  expires_at   TEXT,
  last_used_at TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);

CREATE TABLE servers (
  id             TEXT PRIMARY KEY,
  team_id        TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('local','agent')),
  host           TEXT,
  agent_secret   TEXT,
  status         TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','online','offline','error')),
  docker_version TEXT,
  last_seen_at   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (team_id, name)
);
CREATE INDEX idx_servers_team ON servers(team_id);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (team_id, slug)
);

CREATE TABLE applications (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  server_id         TEXT NOT NULL REFERENCES servers(id),
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL,
  source_type       TEXT NOT NULL DEFAULT 'git' CHECK (source_type IN ('git','image')),
  repo_url          TEXT,
  repo_branch       TEXT NOT NULL DEFAULT 'main',
  repo_provider     TEXT NOT NULL DEFAULT 'github' CHECK (repo_provider IN ('github','git','local')),
  git_credential    TEXT,
  source_image      TEXT,
  build_type        TEXT NOT NULL DEFAULT 'dockerfile' CHECK (build_type IN ('dockerfile','nixpacks','static','image')),
  dockerfile_path   TEXT NOT NULL DEFAULT 'Dockerfile',
  build_context     TEXT NOT NULL DEFAULT '.',
  build_args        TEXT NOT NULL DEFAULT '{}',
  install_command   TEXT,
  build_command     TEXT,
  start_command     TEXT,
  output_dir        TEXT,
  internal_port     TEXT,
  replicas          INTEGER NOT NULL DEFAULT 1 CHECK (replicas BETWEEN 1 AND 20),
  cpu_limit         REAL,
  memory_limit_mb   INTEGER,
  health_check_path TEXT,
  auto_deploy       INTEGER NOT NULL DEFAULT 1 CHECK (auto_deploy IN (0,1)),
  webhook_secret    TEXT,
  status            TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','building','deploying','running','failed','stopped')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (project_id, slug)
);
CREATE INDEX idx_applications_project ON applications(project_id);
CREATE INDEX idx_applications_server ON applications(server_id);

CREATE TABLE env_vars (
  id             TEXT PRIMARY KEY,
  application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  project_id     TEXT REFERENCES projects(id) ON DELETE CASCADE,
  key            TEXT NOT NULL,
  value          TEXT NOT NULL,
  is_secret      INTEGER NOT NULL DEFAULT 1 CHECK (is_secret IN (0,1)),
  scope          TEXT NOT NULL DEFAULT 'runtime' CHECK (scope IN ('runtime','build','both')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK ((application_id IS NULL) <> (project_id IS NULL))
);
CREATE UNIQUE INDEX idx_env_vars_app_key ON env_vars(application_id, key) WHERE application_id IS NOT NULL;
CREATE UNIQUE INDEX idx_env_vars_project_key ON env_vars(project_id, key) WHERE project_id IS NOT NULL;

CREATE TABLE domains (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  host           TEXT NOT NULL UNIQUE,
  path_prefix    TEXT NOT NULL DEFAULT '/',
  port           INTEGER,
  https          INTEGER NOT NULL DEFAULT 1 CHECK (https IN (0,1)),
  is_primary     INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','error')),
  cert_status    TEXT NOT NULL DEFAULT 'pending' CHECK (cert_status IN ('pending','issued','error','self_signed','disabled')),
  certificate    TEXT,
  error_message  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_domains_app ON domains(application_id);

CREATE TABLE services (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  server_id       TEXT NOT NULL REFERENCES servers(id),
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('postgres','mysql','mariadb','mongo','redis','clickhouse','rabbitmq','minio')),
  version         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','deploying','running','failed','stopped')),
  internal_port   INTEGER NOT NULL,
  credentials     TEXT NOT NULL DEFAULT '{}',
  volume_name     TEXT,
  cpu_limit       REAL,
  memory_limit_mb INTEGER,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (project_id, slug)
);
CREATE INDEX idx_services_project ON services(project_id);

CREATE TABLE deployments (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  server_id      TEXT NOT NULL REFERENCES servers(id),
  status         TEXT NOT NULL CHECK (status IN ('queued','building','deploying','running','success','failed','cancelled','rolled_back')),
  trigger        TEXT NOT NULL CHECK (trigger IN ('manual','webhook','rollback','cli','redeploy')),
  commit_sha     TEXT,
  commit_message TEXT,
  commit_author  TEXT,
  branch         TEXT,
  image_tag      TEXT,
  container_ids  TEXT NOT NULL DEFAULT '[]',
  log_path       TEXT,
  error_message  TEXT,
  rollback_of    TEXT REFERENCES deployments(id),
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  duration_ms    INTEGER,
  created_by     TEXT
);
CREATE INDEX idx_deployments_app ON deployments(application_id, started_at DESC);
CREATE INDEX idx_deployments_status ON deployments(status);

CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
  priority     INTEGER NOT NULL DEFAULT 100,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_at       TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT,
  last_error   TEXT,
  worker_id    TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_jobs_claim ON jobs(status, run_at, priority);
CREATE INDEX idx_jobs_kind ON jobs(kind, created_at DESC);

CREATE TABLE metrics_samples (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  scope              TEXT NOT NULL CHECK (scope IN ('host','container','application')),
  scope_id           TEXT NOT NULL,
  cpu_percent        REAL NOT NULL DEFAULT 0,
  memory_bytes       INTEGER NOT NULL DEFAULT 0,
  memory_limit_bytes INTEGER NOT NULL DEFAULT 0,
  disk_bytes         INTEGER NOT NULL DEFAULT 0,
  network_rx_bytes   INTEGER NOT NULL DEFAULT 0,
  network_tx_bytes   INTEGER NOT NULL DEFAULT 0,
  recorded_at        TEXT NOT NULL
);
CREATE INDEX idx_metrics_scope ON metrics_samples(scope, scope_id, recorded_at DESC);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  team_id     TEXT,
  user_id     TEXT,
  action      TEXT NOT NULL,
  resource    TEXT NOT NULL,
  resource_id TEXT,
  ip          TEXT,
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_audit_team ON audit_log(team_id, created_at DESC);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial_schema', sql: INITIAL_SCHEMA },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;