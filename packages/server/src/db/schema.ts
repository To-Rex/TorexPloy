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
  /**
   * Rebuilds a table (SQLite cannot alter CHECK or UNIQUE constraints in place).
   * Foreign keys are switched off around the transaction, as SQLite's documented
   * procedure requires: otherwise dropping the old table would cascade-delete
   * every child row. Integrity is verified with `foreign_key_check` before commit.
   */
  readonly rebuildsTables?: boolean;
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

/** Compose applications and richer domains (path routing, redirects, compose service targets). */
const COMPOSE_AND_ROUTING = /* sql */ `
CREATE TABLE applications_v4 (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id                  TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  server_id                TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
  name                     TEXT NOT NULL,
  slug                     TEXT NOT NULL,
  description              TEXT,
  kind                     TEXT NOT NULL DEFAULT 'web' CHECK (kind IN ('web','worker','compose')),
  source_type              TEXT NOT NULL CHECK (source_type IN ('github','git','image','raw')),
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
  template_id              TEXT,
  -- Compose: the file itself (raw source) or its path inside the repository.
  compose_file             TEXT,
  compose_path             TEXT NOT NULL DEFAULT 'docker-compose.yml',
  -- Compose features that reach the host (privileged, host network, absolute bind mounts…), granted by an admin.
  host_access              INTEGER NOT NULL DEFAULT 0 CHECK (host_access IN (0,1)),
  UNIQUE (project_id, slug),
  CHECK (kind <> 'compose' OR source_type IN ('github','git','raw')),
  CHECK (source_type <> 'raw' OR (kind = 'compose' AND compose_file IS NOT NULL))
);
INSERT INTO applications_v4 (id, project_id, team_id, server_id, name, slug, description, kind, source_type, github_installation_id, repository, git_url, branch, image, build_type, dockerfile_path, root_directory, install_command, build_command, start_command, output_directory, port, replicas, cpu_limit, memory_limit_mb, health_check_path, health_check_timeout_sec, strategy, auto_deploy, deploy_hook_token, deploy_key, deploy_public_key, status, active_deployment_id, config_updated_at, created_at, updated_at, template_id) SELECT id, project_id, team_id, server_id, name, slug, description, kind, source_type, github_installation_id, repository, git_url, branch, image, build_type, dockerfile_path, root_directory, install_command, build_command, start_command, output_directory, port, replicas, cpu_limit, memory_limit_mb, health_check_path, health_check_timeout_sec, strategy, auto_deploy, deploy_hook_token, deploy_key, deploy_public_key, status, active_deployment_id, config_updated_at, created_at, updated_at, template_id FROM applications;
DROP TABLE applications;
ALTER TABLE applications_v4 RENAME TO applications;
CREATE INDEX idx_applications_team ON applications(team_id);
CREATE INDEX idx_applications_server ON applications(server_id);
CREATE INDEX idx_applications_repo ON applications(repository, branch) WHERE source_type = 'github';

CREATE TABLE domains_v4 (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  team_id        TEXT NOT NULL,
  host           TEXT NOT NULL COLLATE NOCASE,
  -- Path prefix this domain routes ('/' for the whole host).
  path           TEXT NOT NULL DEFAULT '/',
  strip_path     INTEGER NOT NULL DEFAULT 0 CHECK (strip_path IN (0,1)),
  https          INTEGER NOT NULL DEFAULT 1 CHECK (https IN (0,1)),
  port           INTEGER,
  -- Compose: which service receives the traffic.
  service_name   TEXT,
  -- Set for a redirect-only domain: requests are sent to this host (same path and query).
  redirect_to    TEXT,
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
INSERT INTO domains_v4 (id, application_id, team_id, host, https, port, is_generated, dns_status, dns_records, dns_checked_at, tls_status, tls_issuer, tls_expires_at, tls_message, created_at, updated_at) SELECT id, application_id, team_id, host, https, port, is_generated, dns_status, dns_records, dns_checked_at, tls_status, tls_issuer, tls_expires_at, tls_message, created_at, updated_at FROM domains;
DROP TABLE domains;
ALTER TABLE domains_v4 RENAME TO domains;
CREATE INDEX idx_domains_app ON domains(application_id);
CREATE UNIQUE INDEX idx_domains_route ON domains(host COLLATE NOCASE, path);
`;

/**
 * Every build type — TorexBuilder (`torex`, formerly `auto`), Dockerfile,
 * Nixpacks, Railpack, Heroku and Paketo buildpacks, static — plus the
 * per-builder settings. The CHECK on `build_type` can only change with a
 * rebuild; the copy maps `auto` to `torex`, since the new CHECK rejects it.
 */
const BUILD_TYPES_V8 = /* sql */ `
CREATE TABLE applications_v8 (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id                  TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  server_id                TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
  name                     TEXT NOT NULL,
  slug                     TEXT NOT NULL,
  description              TEXT,
  kind                     TEXT NOT NULL DEFAULT 'web' CHECK (kind IN ('web','worker','compose')),
  source_type              TEXT NOT NULL CHECK (source_type IN ('github','git','image','raw')),
  github_installation_id   INTEGER,
  repository               TEXT,
  git_url                  TEXT,
  branch                   TEXT,
  image                    TEXT,
  build_type               TEXT NOT NULL DEFAULT 'torex' CHECK (build_type IN ('torex','dockerfile','nixpacks','railpack','heroku','paketo','static')),
  dockerfile_path          TEXT NOT NULL DEFAULT 'Dockerfile',
  root_directory           TEXT NOT NULL DEFAULT '',
  install_command          TEXT,
  build_command            TEXT,
  start_command            TEXT,
  output_directory         TEXT,
  -- Dockerfile builds: the stage to build (--target).
  build_stage              TEXT,
  -- Buildpack builds: the builder image instead of the vendor's default.
  buildpack_builder        TEXT,
  -- TorexBuilder: extra apt packages, as typed (space or comma separated).
  system_packages          TEXT,
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
  template_id              TEXT,
  compose_file             TEXT,
  compose_path             TEXT NOT NULL DEFAULT 'docker-compose.yml',
  host_access              INTEGER NOT NULL DEFAULT 0 CHECK (host_access IN (0,1)),
  parent_application_id    TEXT REFERENCES applications(id) ON DELETE CASCADE,
  preview_pr_number        INTEGER CHECK ((parent_application_id IS NULL) = (preview_pr_number IS NULL)),
  preview_pr_title         TEXT,
  preview_pr_url           TEXT,
  preview_pr_author        TEXT,
  preview_head_sha         TEXT,
  preview_comment_id       INTEGER,
  previews_enabled         INTEGER NOT NULL DEFAULT 0 CHECK (previews_enabled IN (0,1)),
  preview_limit            INTEGER NOT NULL DEFAULT 3 CHECK (preview_limit BETWEEN 1 AND 20),
  preview_env_sealed       TEXT,
  UNIQUE (project_id, slug),
  CHECK (kind <> 'compose' OR source_type IN ('github','git','raw')),
  CHECK (source_type <> 'raw' OR (kind = 'compose' AND compose_file IS NOT NULL))
);
INSERT INTO applications_v8 (id, project_id, team_id, server_id, name, slug, description, kind, source_type, github_installation_id, repository, git_url, branch, image, build_type, dockerfile_path, root_directory, install_command, build_command, start_command, output_directory, port, replicas, cpu_limit, memory_limit_mb, health_check_path, health_check_timeout_sec, strategy, auto_deploy, deploy_hook_token, deploy_key, deploy_public_key, status, active_deployment_id, config_updated_at, created_at, updated_at, template_id, compose_file, compose_path, host_access, parent_application_id, preview_pr_number, preview_pr_title, preview_pr_url, preview_pr_author, preview_head_sha, preview_comment_id, previews_enabled, preview_limit, preview_env_sealed) SELECT id, project_id, team_id, server_id, name, slug, description, kind, source_type, github_installation_id, repository, git_url, branch, image, CASE WHEN build_type = 'auto' THEN 'torex' ELSE build_type END, dockerfile_path, root_directory, install_command, build_command, start_command, output_directory, port, replicas, cpu_limit, memory_limit_mb, health_check_path, health_check_timeout_sec, strategy, auto_deploy, deploy_hook_token, deploy_key, deploy_public_key, status, active_deployment_id, config_updated_at, created_at, updated_at, template_id, compose_file, compose_path, host_access, parent_application_id, preview_pr_number, preview_pr_title, preview_pr_url, preview_pr_author, preview_head_sha, preview_comment_id, previews_enabled, preview_limit, preview_env_sealed FROM applications;
DROP TABLE applications;
ALTER TABLE applications_v8 RENAME TO applications;
CREATE INDEX idx_applications_team ON applications(team_id);
CREATE INDEX idx_applications_server ON applications(server_id);
CREATE INDEX idx_applications_repo ON applications(repository, branch) WHERE source_type = 'github';
CREATE UNIQUE INDEX idx_applications_preview ON applications(parent_application_id, preview_pr_number) WHERE parent_application_id IS NOT NULL;
`;

/**
 * The file store: `files` joins the service types (a CHECK, so the table is
 * rebuilt), domains may belong to a service instead of an application (another
 * rebuild), and access keys, bucket metadata and store-backed backup
 * destinations get their rows.
 */
const FILE_STORE_V9 = /* sql */ `
CREATE TABLE services_v9 (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id               TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  server_id             TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
  name                  TEXT NOT NULL,
  slug                  TEXT NOT NULL,
  type                  TEXT NOT NULL CHECK (type IN ('postgres','mysql','mariadb','mongo','redis','rabbitmq','minio','clickhouse','files')),
  version               TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning','running','stopped','failed','restarting')),
  status_message        TEXT,
  status_reason         TEXT,
  credentials           TEXT NOT NULL,
  internal_port         INTEGER NOT NULL,
  public_port           INTEGER,
  cpu_limit             REAL,
  memory_limit_mb       INTEGER,
  backup_schedule       TEXT,
  backup_retention      INTEGER NOT NULL DEFAULT 7,
  container_name        TEXT NOT NULL UNIQUE,
  volume_name           TEXT NOT NULL UNIQUE,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  backup_destination_id TEXT REFERENCES s3_destinations(id) ON DELETE SET NULL,
  UNIQUE (project_id, slug)
);
INSERT INTO services_v9 (id, project_id, team_id, server_id, name, slug, type, version, status, status_message, status_reason, credentials, internal_port, public_port, cpu_limit, memory_limit_mb, backup_schedule, backup_retention, container_name, volume_name, created_at, updated_at, backup_destination_id) SELECT id, project_id, team_id, server_id, name, slug, type, version, status, status_message, status_reason, credentials, internal_port, public_port, cpu_limit, memory_limit_mb, backup_schedule, backup_retention, container_name, volume_name, created_at, updated_at, backup_destination_id FROM services;
DROP TABLE services;
ALTER TABLE services_v9 RENAME TO services;
CREATE INDEX idx_services_team ON services(team_id);
CREATE INDEX idx_services_server ON services(server_id);

-- A domain serves an application or a service (the file store's S3 endpoint), never both.
CREATE TABLE domains_v9 (
  id             TEXT PRIMARY KEY,
  application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  service_id     TEXT REFERENCES services(id) ON DELETE CASCADE,
  team_id        TEXT NOT NULL,
  host           TEXT NOT NULL COLLATE NOCASE,
  path           TEXT NOT NULL DEFAULT '/',
  strip_path     INTEGER NOT NULL DEFAULT 0 CHECK (strip_path IN (0,1)),
  https          INTEGER NOT NULL DEFAULT 1 CHECK (https IN (0,1)),
  port           INTEGER,
  service_name   TEXT,
  redirect_to    TEXT,
  is_generated   INTEGER NOT NULL DEFAULT 0 CHECK (is_generated IN (0,1)),
  dns_status     TEXT NOT NULL DEFAULT 'pending' CHECK (dns_status IN ('pending','ok','mismatch','error')),
  dns_records    TEXT NOT NULL DEFAULT '[]',
  dns_checked_at TEXT,
  tls_status     TEXT NOT NULL DEFAULT 'pending' CHECK (tls_status IN ('pending','active','error','disabled')),
  tls_issuer     TEXT,
  tls_expires_at TEXT,
  tls_message    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK ((application_id IS NULL) <> (service_id IS NULL))
);
INSERT INTO domains_v9 (id, application_id, team_id, host, path, strip_path, https, port, service_name, redirect_to, is_generated, dns_status, dns_records, dns_checked_at, tls_status, tls_issuer, tls_expires_at, tls_message, created_at, updated_at) SELECT id, application_id, team_id, host, path, strip_path, https, port, service_name, redirect_to, is_generated, dns_status, dns_records, dns_checked_at, tls_status, tls_issuer, tls_expires_at, tls_message, created_at, updated_at FROM domains;
DROP TABLE domains;
ALTER TABLE domains_v9 RENAME TO domains;
CREATE INDEX idx_domains_app ON domains(application_id);
CREATE INDEX idx_domains_service ON domains(service_id);
CREATE UNIQUE INDEX idx_domains_route ON domains(host COLLATE NOCASE, path);

-- Access keys of a file store. The secret is sealed; SeaweedFS holds the live identity.
CREATE TABLE storage_keys (
  id            TEXT PRIMARY KEY,
  service_id    TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  access_key_id TEXT NOT NULL UNIQUE,
  secret_sealed TEXT NOT NULL,
  -- JSON array of bucket names; NULL means every bucket, including ones created later.
  buckets       TEXT,
  permission    TEXT NOT NULL CHECK (permission IN ('read','readwrite')),
  -- 'backups': made by the panel for a backup destination; revoked with it.
  managed_by    TEXT NOT NULL DEFAULT 'user' CHECK (managed_by IN ('user','backups')),
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
CREATE INDEX idx_storage_keys_service ON storage_keys(service_id);

-- What the panel knows about a bucket beyond the engine's list: whether it is public, and when it was made.
CREATE TABLE storage_buckets (
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  public     INTEGER NOT NULL DEFAULT 0 CHECK (public IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (service_id, name)
);

-- A destination inside one of the team's own file stores goes away with the store.
ALTER TABLE s3_destinations ADD COLUMN service_id TEXT REFERENCES services(id) ON DELETE CASCADE;
CREATE INDEX idx_s3_destinations_service ON s3_destinations(service_id);
`;

/**
 * Uploaded sources (Netlify Drop style): `upload` joins the source types and
 * `upload` joins the deployment triggers — both CHECK-constrained, so both
 * tables are rebuilt. Each table gets an `upload` JSON column: on an
 * application the current archive (id, name, sizes), on a deployment the
 * archive it was built from.
 */
const UPLOAD_SOURCES_V12 = /* sql */ `
CREATE TABLE applications_v12 (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id                  TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  server_id                TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
  name                     TEXT NOT NULL,
  slug                     TEXT NOT NULL,
  description              TEXT,
  kind                     TEXT NOT NULL DEFAULT 'web' CHECK (kind IN ('web','worker','compose')),
  source_type              TEXT NOT NULL CHECK (source_type IN ('github','git','image','raw','upload')),
  github_installation_id   INTEGER,
  repository               TEXT,
  git_url                  TEXT,
  branch                   TEXT,
  image                    TEXT,
  build_type               TEXT NOT NULL DEFAULT 'torex' CHECK (build_type IN ('torex','dockerfile','nixpacks','railpack','heroku','paketo','static')),
  dockerfile_path          TEXT NOT NULL DEFAULT 'Dockerfile',
  root_directory           TEXT NOT NULL DEFAULT '',
  install_command          TEXT,
  build_command            TEXT,
  start_command            TEXT,
  output_directory         TEXT,
  build_stage              TEXT,
  buildpack_builder        TEXT,
  system_packages          TEXT,
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
  template_id              TEXT,
  compose_file             TEXT,
  compose_path             TEXT NOT NULL DEFAULT 'docker-compose.yml',
  host_access              INTEGER NOT NULL DEFAULT 0 CHECK (host_access IN (0,1)),
  parent_application_id    TEXT REFERENCES applications(id) ON DELETE CASCADE,
  preview_pr_number        INTEGER CHECK ((parent_application_id IS NULL) = (preview_pr_number IS NULL)),
  preview_pr_title         TEXT,
  preview_pr_url           TEXT,
  preview_pr_author        TEXT,
  preview_head_sha         TEXT,
  preview_comment_id       INTEGER,
  previews_enabled         INTEGER NOT NULL DEFAULT 0 CHECK (previews_enabled IN (0,1)),
  preview_limit            INTEGER NOT NULL DEFAULT 3 CHECK (preview_limit BETWEEN 1 AND 20),
  preview_env_sealed       TEXT,
  -- Upload sources: the current archive as JSON {id, name, size, files, bytes, uploadedAt}; the file lives under uploads/<app>/<id>.zip.
  upload                   TEXT,
  UNIQUE (project_id, slug),
  CHECK (kind <> 'compose' OR source_type IN ('github','git','raw')),
  CHECK (source_type <> 'raw' OR (kind = 'compose' AND compose_file IS NOT NULL))
);
INSERT INTO applications_v12 (id, project_id, team_id, server_id, name, slug, description, kind, source_type, github_installation_id, repository, git_url, branch, image, build_type, dockerfile_path, root_directory, install_command, build_command, start_command, output_directory, build_stage, buildpack_builder, system_packages, port, replicas, cpu_limit, memory_limit_mb, health_check_path, health_check_timeout_sec, strategy, auto_deploy, deploy_hook_token, deploy_key, deploy_public_key, status, active_deployment_id, config_updated_at, created_at, updated_at, template_id, compose_file, compose_path, host_access, parent_application_id, preview_pr_number, preview_pr_title, preview_pr_url, preview_pr_author, preview_head_sha, preview_comment_id, previews_enabled, preview_limit, preview_env_sealed) SELECT id, project_id, team_id, server_id, name, slug, description, kind, source_type, github_installation_id, repository, git_url, branch, image, build_type, dockerfile_path, root_directory, install_command, build_command, start_command, output_directory, build_stage, buildpack_builder, system_packages, port, replicas, cpu_limit, memory_limit_mb, health_check_path, health_check_timeout_sec, strategy, auto_deploy, deploy_hook_token, deploy_key, deploy_public_key, status, active_deployment_id, config_updated_at, created_at, updated_at, template_id, compose_file, compose_path, host_access, parent_application_id, preview_pr_number, preview_pr_title, preview_pr_url, preview_pr_author, preview_head_sha, preview_comment_id, previews_enabled, preview_limit, preview_env_sealed FROM applications;
DROP TABLE applications;
ALTER TABLE applications_v12 RENAME TO applications;
CREATE INDEX idx_applications_team ON applications(team_id);
CREATE INDEX idx_applications_server ON applications(server_id);
CREATE INDEX idx_applications_repo ON applications(repository, branch) WHERE source_type = 'github';
CREATE UNIQUE INDEX idx_applications_preview ON applications(parent_application_id, preview_pr_number) WHERE parent_application_id IS NOT NULL;

CREATE TABLE deployments_v12 (
  id                   TEXT PRIMARY KEY,
  application_id       TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  project_id           TEXT NOT NULL,
  team_id              TEXT NOT NULL,
  server_id            TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('queued','building','deploying','succeeded','failed','cancelled')),
  trigger              TEXT NOT NULL CHECK (trigger IN ('manual','push','rollback','redeploy','api','restart','upload')),
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
  duration_ms          INTEGER,
  seq                  INTEGER,
  -- The archive an upload-source deployment was built from (JSON, same shape as applications.upload).
  upload               TEXT
);
INSERT INTO deployments_v12 (id, application_id, project_id, team_id, server_id, status, trigger, commit_sha, commit_message, commit_author, branch, image_tag, port, image_removed, containers, source_deployment_id, options, error_message, error_code, created_by, created_at, started_at, build_duration_ms, finished_at, duration_ms, seq) SELECT id, application_id, project_id, team_id, server_id, status, trigger, commit_sha, commit_message, commit_author, branch, image_tag, port, image_removed, containers, source_deployment_id, options, error_message, error_code, created_by, created_at, started_at, build_duration_ms, finished_at, duration_ms, seq FROM deployments;
DROP TABLE deployments;
ALTER TABLE deployments_v12 RENAME TO deployments;
CREATE INDEX idx_deployments_app ON deployments(application_id, created_at DESC);
CREATE INDEX idx_deployments_team ON deployments(team_id, created_at DESC);
CREATE INDEX idx_deployments_open ON deployments(status, created_at) WHERE status IN ('queued','building','deploying');
`;

const GIT_PROVIDERS_V16 = /* sql */ `
-- A GitLab or Bitbucket account connected with an access token (sealed with the token's account email, if any).
CREATE TABLE git_providers (
  id              TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('gitlab','bitbucket')),
  name            TEXT NOT NULL,
  base_url        TEXT NOT NULL,
  account_login   TEXT NOT NULL,
  account_name    TEXT,
  avatar_url      TEXT,
  workspace       TEXT,
  credentials     TEXT NOT NULL,
  -- What webhooks from this account are verified with (GitLab: X-Gitlab-Token; Bitbucket: the HMAC signature).
  webhook_secret  TEXT NOT NULL,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_git_providers_team ON git_providers(team_id);

-- The webhook the panel set up on a repository (one per repository and connection, whatever uses it).
CREATE TABLE git_hooks (
  provider_id  TEXT NOT NULL REFERENCES git_providers(id) ON DELETE CASCADE,
  repository   TEXT NOT NULL COLLATE NOCASE,
  hook_id      TEXT,
  status       TEXT NOT NULL CHECK (status IN ('ok','failed')),
  reason       TEXT,
  message      TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (provider_id, repository)
);

CREATE TABLE applications_v16 (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id                  TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  server_id                TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
  name                     TEXT NOT NULL,
  slug                     TEXT NOT NULL,
  description              TEXT,
  kind                     TEXT NOT NULL DEFAULT 'web' CHECK (kind IN ('web','worker','compose')),
  source_type              TEXT NOT NULL CHECK (source_type IN ('github','gitlab','bitbucket','git','image','raw','upload')),
  github_installation_id   INTEGER,
  -- A GitLab or Bitbucket connection (source_type gitlab/bitbucket); the repository is its path there.
  git_provider_id          TEXT REFERENCES git_providers(id) ON DELETE SET NULL,
  repository               TEXT,
  git_url                  TEXT,
  branch                   TEXT,
  image                    TEXT,
  build_type               TEXT NOT NULL DEFAULT 'torex' CHECK (build_type IN ('torex','dockerfile','nixpacks','railpack','heroku','paketo','static')),
  dockerfile_path          TEXT NOT NULL DEFAULT 'Dockerfile',
  root_directory           TEXT NOT NULL DEFAULT '',
  install_command          TEXT,
  build_command            TEXT,
  start_command            TEXT,
  output_directory         TEXT,
  build_stage              TEXT,
  buildpack_builder        TEXT,
  system_packages          TEXT,
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
  template_id              TEXT,
  compose_file             TEXT,
  compose_path             TEXT NOT NULL DEFAULT 'docker-compose.yml',
  host_access              INTEGER NOT NULL DEFAULT 0 CHECK (host_access IN (0,1)),
  parent_application_id    TEXT REFERENCES applications(id) ON DELETE CASCADE,
  preview_pr_number        INTEGER CHECK ((parent_application_id IS NULL) = (preview_pr_number IS NULL)),
  preview_pr_title         TEXT,
  preview_pr_url           TEXT,
  preview_pr_author        TEXT,
  preview_head_sha         TEXT,
  preview_comment_id       INTEGER,
  previews_enabled         INTEGER NOT NULL DEFAULT 0 CHECK (previews_enabled IN (0,1)),
  preview_limit            INTEGER NOT NULL DEFAULT 3 CHECK (preview_limit BETWEEN 1 AND 20),
  preview_env_sealed       TEXT,
  -- Upload sources: the current archive as JSON {id, name, size, files, bytes, uploadedAt}; the file lives under uploads/<app>/<id>.zip.
  upload                   TEXT,
  UNIQUE (project_id, slug),
  CHECK (kind <> 'compose' OR source_type IN ('github','gitlab','bitbucket','git','raw')),
  CHECK (source_type <> 'raw' OR (kind = 'compose' AND compose_file IS NOT NULL))
);
INSERT INTO applications_v16 (id, project_id, team_id, server_id, name, slug, description, kind, source_type, github_installation_id, repository, git_url, branch, image, build_type, dockerfile_path, root_directory, install_command, build_command, start_command, output_directory, build_stage, buildpack_builder, system_packages, port, replicas, cpu_limit, memory_limit_mb, health_check_path, health_check_timeout_sec, strategy, auto_deploy, deploy_hook_token, deploy_key, deploy_public_key, status, active_deployment_id, config_updated_at, created_at, updated_at, template_id, compose_file, compose_path, host_access, parent_application_id, preview_pr_number, preview_pr_title, preview_pr_url, preview_pr_author, preview_head_sha, preview_comment_id, previews_enabled, preview_limit, preview_env_sealed, upload) SELECT id, project_id, team_id, server_id, name, slug, description, kind, source_type, github_installation_id, repository, git_url, branch, image, build_type, dockerfile_path, root_directory, install_command, build_command, start_command, output_directory, build_stage, buildpack_builder, system_packages, port, replicas, cpu_limit, memory_limit_mb, health_check_path, health_check_timeout_sec, strategy, auto_deploy, deploy_hook_token, deploy_key, deploy_public_key, status, active_deployment_id, config_updated_at, created_at, updated_at, template_id, compose_file, compose_path, host_access, parent_application_id, preview_pr_number, preview_pr_title, preview_pr_url, preview_pr_author, preview_head_sha, preview_comment_id, previews_enabled, preview_limit, preview_env_sealed, upload FROM applications;
DROP TABLE applications;
ALTER TABLE applications_v16 RENAME TO applications;
CREATE INDEX idx_applications_team ON applications(team_id);
CREATE INDEX idx_applications_server ON applications(server_id);
CREATE INDEX idx_applications_repo ON applications(repository, branch) WHERE source_type = 'github';
CREATE INDEX idx_applications_provider_repo ON applications(git_provider_id, repository, branch) WHERE git_provider_id IS NOT NULL;
CREATE UNIQUE INDEX idx_applications_preview ON applications(parent_application_id, preview_pr_number) WHERE parent_application_id IS NOT NULL;
`;

/** Append-only. Never edit a released migration; add a new one. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', sql: INITIAL },
  { version: 2, name: 'application-templates', sql: 'ALTER TABLE applications ADD COLUMN template_id TEXT;' },
  {
    version: 3,
    name: 'notification-channels',
    sql: `
CREATE TABLE notification_channels (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('telegram','discord','slack','webhook')),
  config       TEXT NOT NULL,
  locale       TEXT NOT NULL DEFAULT 'uz',
  events       TEXT NOT NULL DEFAULT '[]',
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  last_status  TEXT CHECK (last_status IN ('ok','failed')),
  last_error   TEXT,
  last_sent_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_notification_channels_team ON notification_channels(team_id);
`,
  },
  { version: 4, name: 'compose-and-routing', sql: COMPOSE_AND_ROUTING, rebuildsTables: true },
  {
    version: 5,
    name: 's3-backup-destinations',
    sql: `
CREATE TABLE s3_destinations (
  id                TEXT PRIMARY KEY,
  team_id           TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  endpoint          TEXT NOT NULL,
  region            TEXT NOT NULL,
  bucket            TEXT NOT NULL,
  path_prefix       TEXT NOT NULL DEFAULT '',
  access_key_id     TEXT NOT NULL,
  secret_access_key TEXT NOT NULL,
  force_path_style  INTEGER NOT NULL DEFAULT 0 CHECK (force_path_style IN (0,1)),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_s3_destinations_team ON s3_destinations(team_id);
ALTER TABLE services ADD COLUMN backup_destination_id TEXT REFERENCES s3_destinations(id) ON DELETE SET NULL;
-- Where the copy of a backup lives off the server (null: on the server only).
ALTER TABLE backups ADD COLUMN remote_destination_id TEXT;
ALTER TABLE backups ADD COLUMN remote_key TEXT;
`,
  },
  {
    version: 6,
    name: 'container-registries',
    sql: `
CREATE TABLE registries (
  id              TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- Host as Docker names it: ghcr.io, docker.io, registry.example.uz:5000.
  server_address  TEXT NOT NULL,
  username        TEXT NOT NULL,
  password_sealed TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (team_id, server_address)
);
`,
  },
  {
    version: 7,
    name: 'preview-deployments',
    sql: `
-- A preview is a hidden child application deployed from one pull request of its parent's repository.
ALTER TABLE applications ADD COLUMN parent_application_id TEXT REFERENCES applications(id) ON DELETE CASCADE;
ALTER TABLE applications ADD COLUMN preview_pr_number INTEGER CHECK ((parent_application_id IS NULL) = (preview_pr_number IS NULL));
ALTER TABLE applications ADD COLUMN preview_pr_title TEXT;
ALTER TABLE applications ADD COLUMN preview_pr_url TEXT;
ALTER TABLE applications ADD COLUMN preview_pr_author TEXT;
-- Head commit GitHub last reported for the pull request.
ALTER TABLE applications ADD COLUMN preview_head_sha TEXT;
-- The pull request comment carrying the preview address, updated after each deployment.
ALTER TABLE applications ADD COLUMN preview_comment_id INTEGER;
-- Parent settings: whether pull requests get previews, how many at once, and their extra variables (sealed dotenv text).
ALTER TABLE applications ADD COLUMN previews_enabled INTEGER NOT NULL DEFAULT 0 CHECK (previews_enabled IN (0,1));
ALTER TABLE applications ADD COLUMN preview_limit INTEGER NOT NULL DEFAULT 3 CHECK (preview_limit BETWEEN 1 AND 20);
ALTER TABLE applications ADD COLUMN preview_env_sealed TEXT;
CREATE UNIQUE INDEX idx_applications_preview ON applications(parent_application_id, preview_pr_number) WHERE parent_application_id IS NOT NULL;
`,
  },
  { version: 8, name: 'build-types', sql: BUILD_TYPES_V8, rebuildsTables: true },
  { version: 9, name: 'file-store', sql: FILE_STORE_V9, rebuildsTables: true },
  // A stable per-application number for each deployment (#1, #2, …), kept when old rows are pruned.
  {
    version: 10,
    name: 'deployment-numbers',
    sql: `
ALTER TABLE deployments ADD COLUMN seq INTEGER;
UPDATE deployments SET seq = (
  SELECT COUNT(*) FROM deployments x
  WHERE x.application_id = deployments.application_id
    AND (x.created_at < deployments.created_at OR (x.created_at = deployments.created_at AND x.id <= deployments.id))
);
`,
  },
  // GitHub installations nobody claimed through the panel (an organization owner approved an install request after
  // the link expired, or the app was installed straight from GitHub): kept until an administrator attaches them to a team.
  {
    version: 11,
    name: 'github-pending-installations',
    sql: `
CREATE TABLE github_pending_installations (
  id                   INTEGER PRIMARY KEY,
  account_login        TEXT NOT NULL,
  account_type         TEXT NOT NULL,
  avatar_url           TEXT,
  repository_selection TEXT NOT NULL DEFAULT 'selected',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
`,
  },
  { version: 12, name: 'upload-sources', sql: UPLOAD_SOURCES_V12, rebuildsTables: true },
  {
    version: 13,
    name: 'passkeys',
    sql: `
-- WebAuthn credentials a user signs in with. The private key never leaves the authenticator:
-- what is stored is the credential id it answers to and the public key that checks its signatures.
CREATE TABLE passkeys (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- base64url; unique across users, so one credential signs into exactly one account.
  credential_id   TEXT NOT NULL UNIQUE,
  -- JWK, public part only.
  public_key      TEXT NOT NULL,
  -- COSE algorithm: -7 ES256, -8 EdDSA, -257 RS256.
  algorithm       INTEGER NOT NULL CHECK (algorithm IN (-7, -8, -257)),
  sign_count      INTEGER NOT NULL DEFAULT 0,
  transports      TEXT NOT NULL DEFAULT '[]',
  aaguid          TEXT,
  -- The host the passkey is scoped to; it stops working when the panel moves to another domain.
  rp_id           TEXT NOT NULL,
  backup_eligible INTEGER NOT NULL DEFAULT 0 CHECK (backup_eligible IN (0,1)),
  backed_up       INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0,1)),
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT
);
CREATE INDEX idx_passkeys_user ON passkeys(user_id, created_at);
`,
  },
  {
    version: 14,
    name: 'env-texts',
    sql: `
-- A set of variables as the .env text it was last saved as (encrypted like the values): the comments,
-- the blank lines and the variables switched off with a '#'. The variables themselves stay in env_vars;
-- this is only how they were written.
CREATE TABLE env_texts (
  id             TEXT PRIMARY KEY,
  project_id     TEXT REFERENCES projects(id) ON DELETE CASCADE,
  application_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
  text           TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK ((project_id IS NULL) <> (application_id IS NULL))
);
CREATE UNIQUE INDEX idx_env_text_app ON env_texts(application_id) WHERE application_id IS NOT NULL;
CREATE UNIQUE INDEX idx_env_text_project ON env_texts(project_id) WHERE project_id IS NOT NULL;
`,
  },
  {
    version: 15,
    name: 'volume-backups',
    sql: `
-- How an application's volume is backed up: a cron schedule in the instance time zone (null: by hand only),
-- how many copies to keep, an S3 destination for an off-server copy, and whether the application is paused
-- while the copy is taken (a consistent snapshot of files being written, such as SQLite, at the cost of a pause).
ALTER TABLE volumes ADD COLUMN backup_schedule TEXT;
ALTER TABLE volumes ADD COLUMN backup_retention INTEGER NOT NULL DEFAULT 7;
ALTER TABLE volumes ADD COLUMN backup_destination_id TEXT REFERENCES s3_destinations(id) ON DELETE SET NULL;
ALTER TABLE volumes ADD COLUMN backup_pause INTEGER NOT NULL DEFAULT 0 CHECK (backup_pause IN (0,1));

-- A copy of a volume's files: a .tar.gz under backups/volumes/<volume>/ on the control plane, and perhaps in S3.
CREATE TABLE volume_backups (
  id                    TEXT PRIMARY KEY,
  volume_id             TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
  application_id        TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  status                TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  -- before_restore: taken by a restore just before it replaces the files, so the restore can be undone.
  trigger               TEXT NOT NULL CHECK (trigger IN ('manual','schedule','before_restore')),
  file_path             TEXT,
  size_bytes            INTEGER,
  raw_bytes             INTEGER,
  error_message         TEXT,
  remote_destination_id TEXT,
  remote_key            TEXT,
  -- The containers paused for this copy (JSON array), while they are paused: a restart finds and resumes them.
  paused_containers     TEXT,
  started_at            TEXT NOT NULL,
  finished_at           TEXT
);
CREATE INDEX idx_volume_backups_volume ON volume_backups(volume_id, started_at DESC);
CREATE INDEX idx_volume_backups_app ON volume_backups(application_id);
`,
  },
  { version: 16, name: 'git-providers', sql: GIT_PROVIDERS_V16, rebuildsTables: true },
  {
    version: 17,
    name: 'torex-ai',
    sql: `
-- A conversation with TorexAi. It belongs to one person and acts within one team (with that person's role in it).
CREATE TABLE ai_chats (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT '',
  -- '<provider id>:<model>' the next reply is written by.
  model         TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  -- Ordinary changes run without asking in this conversation (dangerous ones always ask).
  auto_approve  INTEGER NOT NULL DEFAULT 0 CHECK (auto_approve IN (0,1)),
  -- Things the model is told with the person's next message (JSON array): an action they undid by hand.
  notes         TEXT NOT NULL DEFAULT '[]',
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_ai_chats_owner ON ai_chats(user_id, team_id, updated_at DESC);

-- The transcript, append-only. 'tool' rows carry the results of the calls in the assistant row before them;
-- a 'summary' row replaces everything before it for the model (the conversation was condensed there).
CREATE TABLE ai_messages (
  id            TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('user','assistant','tool','summary')),
  -- Provider-neutral blocks (JSON): text, attached files, tool calls, tool results.
  blocks        TEXT NOT NULL,
  -- An assistant turn exactly as its provider returned it, replayed unchanged to the same kind of provider.
  raw           TEXT,
  provider      TEXT,
  model         TEXT,
  stop          TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  error         TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_ai_messages_seq ON ai_messages(chat_id, seq);

-- One tool call of the assistant: what it asked to do, whether it was allowed, what came of it and how to take it back.
CREATE TABLE ai_actions (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
  call_id     TEXT NOT NULL,
  tool        TEXT NOT NULL,
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  preview     TEXT,
  input       TEXT NOT NULL,
  risk        TEXT NOT NULL CHECK (risk IN ('safe','change','danger')),
  status      TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','rejected','cancelled')),
  summary     TEXT,
  -- What the model was given back.
  output      TEXT,
  -- What the person is shown instead, when it differs: the same answer with the secrets the model's copy hides.
  display     TEXT,
  -- How to take the action back (JSON), when it can be.
  undo        TEXT,
  undone_at   TEXT,
  undo_error  TEXT,
  created_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_ai_actions_chat ON ai_actions(chat_id, created_at);

-- Files of a conversation, kept under ai/files/<chat>/<id>: what the person attached, what the assistant made for
-- download, pictures it generated, and the earlier contents of files it overwrote (so the write can be undone).
CREATE TABLE ai_files (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
  action_id  TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('upload','generated','image','snapshot')),
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_files_chat ON ai_files(chat_id);

-- Tokens used, per day, person and model: the daily limit is checked against it and the usage chart is drawn from it.
CREATE TABLE ai_usage (
  day           TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  team_id       TEXT NOT NULL,
  model         TEXT NOT NULL,
  requests      INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, team_id, model)
);
`,
  },
  {
    version: 18,
    name: 'torex-ai-skills',
    sql: `
-- Skills TorexAi can load: playbooks in the Agent Skills format. A built-in skill keeps only its state here (its text
-- ships with the panel); a registry or custom skill is kept whole, pinned to the text that was installed.
CREATE TABLE ai_skills (
  name         TEXT PRIMARY KEY,
  description  TEXT NOT NULL,
  body         TEXT NOT NULL,
  -- Reference files that came with it: JSON object, path to text.
  files        TEXT NOT NULL DEFAULT '{}',
  metadata     TEXT NOT NULL DEFAULT '{}',
  source       TEXT NOT NULL CHECK (source IN ('builtin','registry','custom')),
  -- 'owner/repo:path/in/repo' for a registry skill.
  origin       TEXT,
  hash         TEXT NOT NULL,
  flags        TEXT NOT NULL DEFAULT '[]',
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  -- Installed by TorexAi itself while answering someone (1), or by a person (0).
  auto         INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0,1)),
  installed_by TEXT,
  uses         INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Public GitHub repositories of skills the instance administrator trusts.
CREATE TABLE ai_skill_sources (
  id         TEXT PRIMARY KEY,
  repo       TEXT NOT NULL UNIQUE,
  ref        TEXT,
  commit_sha TEXT,
  synced_at  TEXT,
  error      TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO ai_skill_sources (id, repo, created_at) VALUES ('aik_anthropic', 'anthropics/skills', datetime('now'));
INSERT INTO ai_skill_sources (id, repo, created_at) VALUES ('aik_trailofbits', 'trailofbits/skills', datetime('now'));

-- What those repositories hold, as last read: searched when TorexAi looks for a skill.
CREATE TABLE ai_skill_catalog (
  source_id   TEXT NOT NULL REFERENCES ai_skill_sources(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  path        TEXT NOT NULL,
  body        TEXT NOT NULL,
  files       TEXT NOT NULL DEFAULT '{}',
  metadata    TEXT NOT NULL DEFAULT '{}',
  hash        TEXT NOT NULL,
  flags       TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (source_id, name)
);
`,
  },
  {
    version: 19,
    name: 'mcp-and-cli',
    sql: `
-- A token remembers how it was made (by hand, by \`torex login\`, for an app connected over OAuth) and how far it
-- reaches: read, write (no destroying), or full. Tokens made before this keep reaching everything they did.
ALTER TABLE api_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'api';
ALTER TABLE api_tokens ADD COLUMN access TEXT NOT NULL DEFAULT 'full';
-- The app or computer it was made for, as the person will recognise it.
ALTER TABLE api_tokens ADD COLUMN client TEXT;
-- An OAuth token belongs to a grant: the app keeps the grant and trades its refresh token for new tokens.
ALTER TABLE api_tokens ADD COLUMN grant_id TEXT;
CREATE INDEX idx_api_tokens_grant ON api_tokens(grant_id);

-- What an MCP connection did is kept as a TorexAi conversation of its own (never listed among the conversations),
-- so its steps are recorded, shown and undone the same way.
ALTER TABLE ai_chats ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE ai_chats ADD COLUMN connection TEXT;
CREATE UNIQUE INDEX idx_ai_chats_connection ON ai_chats(connection);

-- Apps that may ask people to connect over OAuth: registered by themselves (dcr), or known by the address of their
-- own description (cimd, the address is the id).
CREATE TABLE oauth_clients (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('dcr','cimd')),
  name          TEXT NOT NULL,
  uri           TEXT,
  redirect_uris TEXT NOT NULL,
  -- Confidential clients only (client_secret_post / client_secret_basic); public clients prove themselves with PKCE.
  secret_hash   TEXT,
  auth_method   TEXT NOT NULL DEFAULT 'none',
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);

-- A person's yes to an app: the team and reach it acts in, and the refresh token it trades for access tokens.
CREATE TABLE oauth_grants (
  id                 TEXT PRIMARY KEY,
  client_id          TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id            TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  access             TEXT NOT NULL,
  redirect_uri       TEXT NOT NULL,
  resource           TEXT,
  refresh_hash       TEXT UNIQUE,
  refresh_expires_at TEXT,
  created_at         TEXT NOT NULL,
  last_used_at       TEXT
);
CREATE INDEX idx_oauth_grants_user ON oauth_grants(user_id);
CREATE INDEX idx_oauth_grants_team ON oauth_grants(team_id);
`,
  },
  {
    version: 20,
    name: 'project-transfers',
    sql: `
-- Projects moving between panels: exports (an encrypted archive made here) and imports (one unpacked here).
-- The archive itself is a file under <dataDir>/transfers; this row is its story. The project is not a foreign key:
-- an export outlives the project it was made from, and an import names the project only once it has made it.
CREATE TABLE transfers (
  id                TEXT PRIMARY KEY,
  team_id           TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('export','import')),
  status            TEXT NOT NULL,
  source            TEXT NOT NULL,
  project_id        TEXT,
  project_name      TEXT,
  file_name         TEXT NOT NULL,
  size_bytes        INTEGER,
  received_bytes    INTEGER NOT NULL DEFAULT 0,
  expected_bytes    INTEGER,
  include           TEXT,
  -- Sealed: an export's passphrase (shown again to administrators, carried by its transfer link); an import's once
  -- it opened the archive (the work that follows reads it again).
  passphrase_sealed TEXT,
  plan              TEXT,
  steps             TEXT NOT NULL DEFAULT '[]',
  percent           REAL NOT NULL DEFAULT 0,
  warnings          TEXT NOT NULL DEFAULT '[]',
  error             TEXT,
  -- An import's progress in ids (what it made, which entries it put back), so a retry carries on where it stopped.
  state             TEXT,
  -- The transfer link other panels pull an export through: only its hash is kept.
  share_hash        TEXT UNIQUE,
  share_expires_at  TEXT,
  share_downloads   INTEGER NOT NULL DEFAULT 0,
  share_last_at     TEXT,
  s3                TEXT,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  expires_at        TEXT
);
CREATE INDEX idx_transfers_team ON transfers(team_id, created_at);
`,
  },
  {
    version: 21,
    name: 'interface-languages',
    rebuildsTables: true,
    sql: `
-- Ten interface languages instead of three. The list is checked by the API (and read leniently), so it can grow
-- without rebuilding this table again; this rebuild only drops the old CHECK on users.locale.
CREATE TABLE users_v21 (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name              TEXT NOT NULL,
  password_hash     TEXT,
  avatar_url        TEXT,
  locale            TEXT NOT NULL DEFAULT 'uz',
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
INSERT INTO users_v21 (id, email, name, password_hash, avatar_url, locale, theme, is_instance_admin, totp_secret, totp_enabled, totp_last_counter, recovery_codes, current_team_id, last_login_at, created_at, updated_at)
  SELECT id, email, name, password_hash, avatar_url, locale, theme, is_instance_admin, totp_secret, totp_enabled, totp_last_counter, recovery_codes, current_team_id, last_login_at, created_at, updated_at FROM users;
DROP TABLE users;
ALTER TABLE users_v21 RENAME TO users;
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
