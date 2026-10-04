/**
 * Schema migrations — append-only. Never edit a shipped migration; add a new
 * one. Each runs once inside a transaction and is recorded in
 * `schema_migrations`, which is what makes in-place upgrades on a live VPS safe.
 *
 * Conventions:
 * - Ids are prefixed TEXT (`app_…`), timestamps ISO-8601 TEXT, metrics epoch-ms INTEGER.
 * - Tenant rows carry `team_id` so every authorization check is one indexed lookup.
 * - Enumerations are CHECK-constrained so a bug cannot persist an unknown state.
 * - Secrets (env values, SSH keys, credentials, TOTP seeds) are stored encrypted.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const INITIAL = /* sql */ `
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
  password_hash     TEXT,
  avatar_url        TEXT,
  locale            TEXT NOT NULL DEFAULT 'uz' CHECK (locale IN ('uz','ru','en')),
  theme             TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')),
  is_instance_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_instance_admin IN (0,1)),
  totp_secret       TEXT,
  totp_enabled      INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0,1)),
  totp_last_counter INTEGER,
  recovery_codes    TEXT NOT NULL DEFAULT '[]',
  current_team_id   TEXT REFERENCES teams(id) ON DELETE SET NULL,
  last_login_at     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE user_identities (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK (provider IN ('github')),
  provider_user_id TEXT NOT NULL,
  login            TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE (provider, provider_user_id),
  UNIQUE (user_id, provider)
);

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

CREATE TABLE team_members (
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('viewer','developer','admin','owner')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX idx_team_members_user ON team_members(user_id);

CREATE TABLE invitations (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email       TEXT NOT NULL COLLATE NOCASE,
  role        TEXT NOT NULL CHECK (role IN ('viewer','developer','admin','owner')),
  token_hash  TEXT NOT NULL UNIQUE,
  invited_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_invitations_team ON invitations(team_id);

CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_api_tokens_team ON api_tokens(team_id);

-- team_id NULL marks the host the control plane itself runs on, shared by every team.
CREATE TABLE servers (
  id                   TEXT PRIMARY KEY,
  team_id              TEXT REFERENCES teams(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('local','ssh')),
  host                 TEXT,
  port                 INTEGER,
  username             TEXT,
  ssh_private_key      TEXT,
  ssh_public_key       TEXT,
  host_key             TEXT,
  host_key_fingerprint TEXT,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','connecting','ready','error','offline')),
  status_message       TEXT,
  status_reason        TEXT,
  public_ip            TEXT,
  docker_info          TEXT,
  proxy_info           TEXT,
  last_seen_at         TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK ((kind = 'local') = (team_id IS NULL))
);
CREATE UNIQUE INDEX idx_servers_single_local ON servers(kind) WHERE kind = 'local';
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
  id                       TEXT PRIMARY KEY,
  project_id               TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id                  TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  server_id                TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
  name                     TEXT NOT NULL,
  slug                     TEXT NOT NULL,
  description              TEXT,
  kind                     TEXT NOT NULL DEFAULT 'web' CHECK (kind IN ('web','worker')),
  source_type              TEXT NOT NULL CHECK (source_type IN ('github','git','image')),
  github_installation_id   INTEGER,
  repository               TEXT,
  git_url                  TEXT,
  branch                   TEXT,
  image                    TEXT,
  build_type               TEXT NOT NULL DEFAULT 'auto' CHECK (build_type IN ('auto','dockerfile','static')),
  dockerfile_path          TEXT NOT NULL DEFAULT 'Dockerfile',
  root_directory           TEXT NOT NULL DEFAULT '',
  install_command          TEXT,
  build_command            TEXT,
  start_command            TEXT,
  output_directory         TEXT,
  port                     INTEGER,
  replicas                 INTEGER NOT NULL DEFAULT 1 CHECK (replicas BETWEEN 1 AND 20),
  cpu_limit                REAL,
  memory_limit_mb          INTEGER,
  health_check_path        TEXT,
  health_check_timeout_sec INTEGER NOT NULL DEFAULT 120,
  strategy                 TEXT NOT NULL DEFAULT 'rolling' CHECK (strategy IN ('rolling','recreate')),
  auto_deploy              INTEGER NOT NULL DEFAULT 1 CHECK (auto_deploy IN (0,1)),
  deploy_hook_token        TEXT,
  deploy_key               TEXT,
  deploy_public_key        TEXT,
  status                   TEXT NOT NULL DEFAULT 'idle'
                           CHECK (status IN ('idle','queued','building','deploying','running','crashed','failed','stopped')),
  active_deployment_id     TEXT REFERENCES deployments(id) ON DELETE SET NULL,
  config_updated_at        TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (project_id, slug)
);
CREATE INDEX idx_applications_team ON applications(team_id);
CREATE INDEX idx_applications_server ON applications(server_id);
CREATE INDEX idx_applications_repo ON applications(repository, branch) WHERE source_type = 'github';

CREATE TABLE deployments (
  id                   TEXT PRIMARY KEY,
  application_id       TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  project_id           TEXT NOT NULL,
  team_id              TEXT NOT NULL,
  server_id            TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('queued','building','deploying','succeeded','failed','cancelled')),
  trigger              TEXT NOT NULL CHECK (trigger IN ('manual','push','rollback','redeploy','api','restart')),
  commit_sha           TEXT,
  commit_message       TEXT,
  commit_author        TEXT,
  branch               TEXT,
  image_tag            TEXT,
  port                 INTEGER,
  image_removed        INTEGER NOT NULL DEFAULT 0 CHECK (image_removed IN (0,1)),
  containers           TEXT NOT NULL DEFAULT '[]',
  source_deployment_id TEXT,
  options              TEXT NOT NULL DEFAULT '{}',
  error_message        TEXT,
  error_code           TEXT,
  created_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  started_at           TEXT,
  build_duration_ms    INTEGER,
  finished_at          TEXT,
  duration_ms          INTEGER
);
CREATE INDEX idx_deployments_app ON deployments(application_id, created_at DESC);
CREATE INDEX idx_deployments_team ON deployments(team_id, created_at DESC);
CREATE INDEX idx_deployments_open ON deployments(status, created_at) WHERE status IN ('queued','building','deploying');

CREATE TABLE env_vars (
  id             TEXT PRIMARY KEY,
  project_id     TEXT REFERENCES projects(id) ON DELETE CASCADE,
  application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  key            TEXT NOT NULL,
  value          TEXT NOT NULL,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK ((project_id IS NULL) <> (application_id IS NULL))
);
CREATE UNIQUE INDEX idx_env_app_key ON env_vars(application_id, key) WHERE application_id IS NOT NULL;
CREATE UNIQUE INDEX idx_env_project_key ON env_vars(project_id, key) WHERE project_id IS NOT NULL;

CREATE TABLE domains (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  team_id        TEXT NOT NULL,
  host           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  https          INTEGER NOT NULL DEFAULT 1 CHECK (https IN (0,1)),
  port           INTEGER,
  is_generated   INTEGER NOT NULL DEFAULT 0 CHECK (is_generated IN (0,1)),
  dns_status     TEXT NOT NULL DEFAULT 'pending' CHECK (dns_status IN ('pending','ok','mismatch','error')),
  dns_records    TEXT NOT NULL DEFAULT '[]',
  dns_checked_at TEXT,
  tls_status     TEXT NOT NULL DEFAULT 'pending' CHECK (tls_status IN ('pending','active','error','disabled')),
  tls_issuer     TEXT,
  tls_expires_at TEXT,
  tls_message    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_domains_app ON domains(application_id);

CREATE TABLE volumes (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  mount_path     TEXT NOT NULL,
  docker_volume  TEXT NOT NULL UNIQUE,
  created_at     TEXT NOT NULL,
  UNIQUE (application_id, name),
  UNIQUE (application_id, mount_path)
);

CREATE TABLE services (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id          TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  server_id        TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('postgres','mysql','mariadb','mongo','redis','rabbitmq','minio','clickhouse')),
  version          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning','running','stopped','failed','restarting')),
  status_message   TEXT,
  status_reason    TEXT,
  credentials      TEXT NOT NULL,
  internal_port    INTEGER NOT NULL,
  public_port      INTEGER,
  cpu_limit        REAL,
  memory_limit_mb  INTEGER,
  backup_schedule  TEXT,
  backup_retention INTEGER NOT NULL DEFAULT 7,
  container_name   TEXT NOT NULL UNIQUE,
  volume_name      TEXT NOT NULL UNIQUE,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (project_id, slug)
);
CREATE INDEX idx_services_team ON services(team_id);
CREATE INDEX idx_services_server ON services(server_id);

CREATE TABLE service_links (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  service_id     TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  prefix         TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  UNIQUE (application_id, service_id)
);
CREATE INDEX idx_links_service ON service_links(service_id);

CREATE TABLE backups (
  id            TEXT PRIMARY KEY,
  service_id    TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  trigger       TEXT NOT NULL CHECK (trigger IN ('manual','schedule')),
  file_path     TEXT,
  size_bytes    INTEGER,
  error_message TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX idx_backups_service ON backups(service_id, started_at DESC);

CREATE TABLE cron_jobs (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  schedule       TEXT NOT NULL,
  command        TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  timeout_sec    INTEGER NOT NULL DEFAULT 3600,
  next_run_at    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_cron_due ON cron_jobs(enabled, next_run_at);

CREATE TABLE cron_runs (
  id          TEXT PRIMARY KEY,
  cron_job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  trigger     TEXT NOT NULL CHECK (trigger IN ('schedule','manual')),
  exit_code   INTEGER,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER
);
CREATE INDEX idx_cron_runs_job ON cron_runs(cron_job_id, started_at DESC);

CREATE TABLE github_installations (
  id                   INTEGER PRIMARY KEY,
  team_id              TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  account_login        TEXT NOT NULL,
  account_type         TEXT NOT NULL,
  avatar_url           TEXT,
  repository_selection TEXT NOT NULL DEFAULT 'selected',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_github_installations_team ON github_installations(team_id);

CREATE TABLE metrics_host (
  server_id  TEXT NOT NULL,
  t          INTEGER NOT NULL,
  cpu        REAL NOT NULL,
  mem_used   INTEGER NOT NULL,
  mem_total  INTEGER NOT NULL,
  disk_used  INTEGER NOT NULL,
  disk_total INTEGER NOT NULL,
  load1      REAL NOT NULL,
  PRIMARY KEY (server_id, t)
) WITHOUT ROWID;

-- owner_id is an application or a database service id.
CREATE TABLE metrics_app (
  owner_id  TEXT NOT NULL,
  t         INTEGER NOT NULL,
  cpu       REAL NOT NULL,
  mem       INTEGER NOT NULL,
  mem_limit INTEGER NOT NULL,
  rx        INTEGER NOT NULL,
  tx        INTEGER NOT NULL,
  PRIMARY KEY (owner_id, t)
) WITHOUT ROWID;

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  team_id     TEXT,
  user_id     TEXT,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT,
  target_name TEXT,
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

export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'initial', sql: INITIAL }];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
