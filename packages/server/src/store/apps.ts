/**
 * Projects, applications and deployments.
 */
import {
  DEFAULT_BUILD_TYPE,
  type AppKind,
  type AppStatus,
  type BuildType,
  type DeployStrategy,
  type DeploymentStatus,
  type DeploymentTrigger,
  type SourceType,
} from '@ploy/shared';
import type { Database } from '../db/database.ts';
import { newId, nowIso, slugify, uniqueSlug } from '../lib/ids.ts';
import { bool, decodeCursor, int01, json, num, numOrNull, str, strOrNull, toPage, type Row } from './util.ts';

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectRecord {
  id: string;
  teamId: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWithStats extends ProjectRecord {
  applicationCount: number;
  serviceCount: number;
  running: number;
  failed: number;
  building: number;
}

function mapProject(row: Row): ProjectRecord {
  return {
    id: str(row.id),
    teamId: str(row.team_id),
    name: str(row.name),
    slug: str(row.slug),
    description: strOrNull(row.description),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

/** Pull request previews are not counted: they belong to their parent application. */
const PROJECT_STATS = `
  (SELECT COUNT(*) FROM applications a WHERE a.project_id = p.id AND a.parent_application_id IS NULL) AS app_count,
  (SELECT COUNT(*) FROM services s WHERE s.project_id = p.id) AS service_count,
  (SELECT COUNT(*) FROM applications a WHERE a.project_id = p.id AND a.parent_application_id IS NULL AND a.status = 'running')
    + (SELECT COUNT(*) FROM services s WHERE s.project_id = p.id AND s.status = 'running') AS running,
  (SELECT COUNT(*) FROM applications a WHERE a.project_id = p.id AND a.parent_application_id IS NULL AND a.status IN ('failed','crashed'))
    + (SELECT COUNT(*) FROM services s WHERE s.project_id = p.id AND s.status = 'failed') AS failed,
  (SELECT COUNT(*) FROM applications a WHERE a.project_id = p.id AND a.parent_application_id IS NULL AND a.status IN ('queued','building','deploying')) AS building`;

function mapProjectStats(row: Row): ProjectWithStats {
  return {
    ...mapProject(row),
    applicationCount: num(row.app_count),
    serviceCount: num(row.service_count),
    running: num(row.running),
    failed: num(row.failed),
    building: num(row.building),
  };
}

export class ProjectStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(teamId: string, name: string, description: string | null): ProjectRecord {
    const id = newId('prj');
    const now = nowIso();
    const slug = uniqueSlug(slugify(name, 'project'), (candidate) =>
      this.db.get('SELECT 1 FROM projects WHERE team_id = ? AND slug = ?', teamId, candidate) !== undefined,
    );
    this.db.run(
      'INSERT INTO projects (id, team_id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      teamId,
      name,
      slug,
      description,
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): ProjectRecord | undefined {
    const row = this.db.get('SELECT * FROM projects WHERE id = ?', id);
    return row === undefined ? undefined : mapProject(row);
  }

  getWithStats(id: string): ProjectWithStats | undefined {
    const row = this.db.get(`SELECT p.*, ${PROJECT_STATS} FROM projects p WHERE p.id = ?`, id);
    return row === undefined ? undefined : mapProjectStats(row);
  }

  listForTeam(teamId: string): ProjectWithStats[] {
    return this.db
      .all(`SELECT p.*, ${PROJECT_STATS} FROM projects p WHERE p.team_id = ? ORDER BY p.updated_at DESC`, teamId)
      .map(mapProjectStats);
  }

  update(id: string, patch: { name?: string; description?: string | null }): void {
    const current = this.get(id);
    if (current === undefined) return;
    this.db.run(
      'UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?',
      patch.name ?? current.name,
      patch.description === undefined ? current.description : patch.description,
      nowIso(),
      id,
    );
  }

  touch(id: string): void {
    this.db.run('UPDATE projects SET updated_at = ? WHERE id = ?', nowIso(), id);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM projects WHERE id = ?', id);
  }

  /**
   * Applications and services share one DNS namespace inside a project network
   * (each is reachable by its slug), so a slug must be unique across both.
   */
  uniqueResourceSlug(projectId: string, name: string, fallback: string): string {
    return uniqueSlug(slugify(name, fallback), (candidate) =>
      this.db.get(
        'SELECT 1 FROM applications WHERE project_id = ? AND slug = ? UNION ALL SELECT 1 FROM services WHERE project_id = ? AND slug = ?',
        projectId,
        candidate,
        projectId,
        candidate,
      ) !== undefined,
    );
  }
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export interface ApplicationRecord {
  id: string;
  projectId: string;
  teamId: string;
  serverId: string;
  name: string;
  slug: string;
  description: string | null;
  kind: AppKind;
  sourceType: SourceType;
  githubInstallationId: number | null;
  repository: string | null;
  gitUrl: string | null;
  branch: string | null;
  image: string | null;
  buildType: BuildType;
  dockerfilePath: string;
  rootDirectory: string;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputDirectory: string | null;
  /** Dockerfile builds: the stage to build (`--target`). */
  buildStage: string | null;
  /** Buildpack builds: the builder image, or the vendor's default when null. */
  buildpackBuilder: string | null;
  /** TorexBuilder: extra apt packages, as typed. */
  systemPackages: string | null;
  port: number | null;
  replicas: number;
  cpuLimit: number | null;
  memoryLimitMb: number | null;
  healthCheckPath: string | null;
  healthCheckTimeoutSec: number;
  strategy: DeployStrategy;
  autoDeploy: boolean;
  deployHookToken: string | null;
  /** Sealed private key used to clone `git@` repositories; the public half is shown to the user. */
  deployKey: string | null;
  deployPublicKey: string | null;
  /** One-click template the app was installed from. */
  templateId: string | null;
  /** Compose: the stored file (raw source). */
  composeFile: string | null;
  /** Compose: the file's path in the repository. */
  composePath: string;
  /** Compose: an admin allowed host-reaching features (privileged, host network, absolute binds). */
  hostAccess: boolean;
  /** Preview: the application whose pull request this one deploys. Previews are hidden from every list. */
  parentApplicationId: string | null;
  /** Preview: the pull request, and the head commit GitHub last reported for it. */
  previewPrNumber: number | null;
  previewPrTitle: string | null;
  previewPrUrl: string | null;
  previewPrAuthor: string | null;
  previewHeadSha: string | null;
  /** Preview: the pull request comment that carries its address. */
  previewCommentId: number | null;
  /** Parent: pull requests get previews, at most `previewLimit` at once, with `previewEnvSealed` (dotenv text) over its variables. */
  previewsEnabled: boolean;
  previewLimit: number;
  previewEnvSealed: string | null;
  status: AppStatus;
  activeDeploymentId: string | null;
  configUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

function mapApplication(row: Row): ApplicationRecord {
  return {
    id: str(row.id),
    projectId: str(row.project_id),
    teamId: str(row.team_id),
    serverId: str(row.server_id),
    name: str(row.name),
    slug: str(row.slug),
    description: strOrNull(row.description),
    kind: str(row.kind) as AppKind,
    sourceType: str(row.source_type) as SourceType,
    githubInstallationId: numOrNull(row.github_installation_id),
    repository: strOrNull(row.repository),
    gitUrl: strOrNull(row.git_url),
    branch: strOrNull(row.branch),
    image: strOrNull(row.image),
    buildType: str(row.build_type) as BuildType,
    dockerfilePath: str(row.dockerfile_path),
    rootDirectory: str(row.root_directory),
    installCommand: strOrNull(row.install_command),
    buildCommand: strOrNull(row.build_command),
    startCommand: strOrNull(row.start_command),
    outputDirectory: strOrNull(row.output_directory),
    buildStage: strOrNull(row.build_stage),
    buildpackBuilder: strOrNull(row.buildpack_builder),
    systemPackages: strOrNull(row.system_packages),
    port: numOrNull(row.port),
    replicas: num(row.replicas),
    cpuLimit: numOrNull(row.cpu_limit),
    memoryLimitMb: numOrNull(row.memory_limit_mb),
    healthCheckPath: strOrNull(row.health_check_path),
    healthCheckTimeoutSec: num(row.health_check_timeout_sec),
    strategy: str(row.strategy) as DeployStrategy,
    autoDeploy: bool(row.auto_deploy),
    deployHookToken: strOrNull(row.deploy_hook_token),
    deployKey: strOrNull(row.deploy_key),
    deployPublicKey: strOrNull(row.deploy_public_key),
    templateId: strOrNull(row.template_id),
    composeFile: strOrNull(row.compose_file),
    composePath: str(row.compose_path),
    hostAccess: bool(row.host_access),
    parentApplicationId: strOrNull(row.parent_application_id),
    previewPrNumber: numOrNull(row.preview_pr_number),
    previewPrTitle: strOrNull(row.preview_pr_title),
    previewPrUrl: strOrNull(row.preview_pr_url),
    previewPrAuthor: strOrNull(row.preview_pr_author),
    previewHeadSha: strOrNull(row.preview_head_sha),
    previewCommentId: numOrNull(row.preview_comment_id),
    previewsEnabled: bool(row.previews_enabled),
    previewLimit: num(row.preview_limit),
    previewEnvSealed: strOrNull(row.preview_env_sealed),
    status: str(row.status) as AppStatus,
    activeDeploymentId: strOrNull(row.active_deployment_id),
    configUpdatedAt: str(row.config_updated_at),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

/** Columns a user may edit, mapped to SQL. `config` marks those a running deployment depends on. */
const APP_COLUMNS = {
  name: { column: 'name', config: false },
  description: { column: 'description', config: false },
  kind: { column: 'kind', config: true },
  sourceType: { column: 'source_type', config: true },
  githubInstallationId: { column: 'github_installation_id', config: true },
  repository: { column: 'repository', config: true },
  gitUrl: { column: 'git_url', config: true },
  branch: { column: 'branch', config: true },
  image: { column: 'image', config: true },
  buildType: { column: 'build_type', config: true },
  dockerfilePath: { column: 'dockerfile_path', config: true },
  rootDirectory: { column: 'root_directory', config: true },
  installCommand: { column: 'install_command', config: true },
  buildCommand: { column: 'build_command', config: true },
  startCommand: { column: 'start_command', config: true },
  outputDirectory: { column: 'output_directory', config: true },
  buildStage: { column: 'build_stage', config: true },
  buildpackBuilder: { column: 'buildpack_builder', config: true },
  systemPackages: { column: 'system_packages', config: true },
  port: { column: 'port', config: true },
  replicas: { column: 'replicas', config: true },
  cpuLimit: { column: 'cpu_limit', config: true },
  memoryLimitMb: { column: 'memory_limit_mb', config: true },
  healthCheckPath: { column: 'health_check_path', config: true },
  healthCheckTimeoutSec: { column: 'health_check_timeout_sec', config: false },
  strategy: { column: 'strategy', config: false },
  autoDeploy: { column: 'auto_deploy', config: false },
  composeFile: { column: 'compose_file', config: true },
  composePath: { column: 'compose_path', config: true },
  previewsEnabled: { column: 'previews_enabled', config: false },
  previewLimit: { column: 'preview_limit', config: false },
} as const;

export type ApplicationPatch = Partial<Pick<ApplicationRecord, keyof typeof APP_COLUMNS>>;

/** The pull request a preview deploys, as the webhook describes it. */
export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  author: string | null;
  headSha: string;
}

export type NewApplication = Pick<
  ApplicationRecord,
  'projectId' | 'teamId' | 'serverId' | 'name' | 'kind' | 'sourceType' | 'githubInstallationId' | 'repository' | 'gitUrl' | 'branch' | 'image'
> &
  Partial<
    Pick<
      ApplicationRecord,
      'buildType' | 'dockerfilePath' | 'rootDirectory' | 'installCommand' | 'buildCommand' | 'startCommand' | 'outputDirectory' | 'buildStage' | 'buildpackBuilder' | 'systemPackages' | 'port' | 'templateId' | 'composeFile' | 'composePath'
    >
  > & {
    slug: string;
    sealedHookToken: string;
    /** Creates a pull request preview of `parentApplicationId`. */
    preview?: PullRequestInfo & { parentApplicationId: string };
  };

export class ApplicationStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: NewApplication): ApplicationRecord {
    const id = newId('app');
    const now = nowIso();
    this.db.run(
      `INSERT INTO applications (
         id, project_id, team_id, server_id, name, slug, kind, source_type, github_installation_id, repository, git_url, branch, image,
         build_type, dockerfile_path, root_directory, install_command, build_command, start_command, output_directory,
         build_stage, buildpack_builder, system_packages, port,
         deploy_hook_token, template_id, compose_file, compose_path, parent_application_id, preview_pr_number, preview_pr_title,
         preview_pr_url, preview_pr_author, preview_head_sha, config_updated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.projectId,
      input.teamId,
      input.serverId,
      input.name,
      input.slug,
      input.kind,
      input.sourceType,
      input.githubInstallationId,
      input.repository,
      input.gitUrl,
      input.branch,
      input.image,
      input.buildType ?? DEFAULT_BUILD_TYPE,
      input.dockerfilePath ?? 'Dockerfile',
      input.rootDirectory ?? '',
      input.installCommand ?? null,
      input.buildCommand ?? null,
      input.startCommand ?? null,
      input.outputDirectory ?? null,
      input.buildStage ?? null,
      input.buildpackBuilder ?? null,
      input.systemPackages ?? null,
      input.port ?? null,
      input.sealedHookToken,
      input.templateId ?? null,
      input.composeFile ?? null,
      input.composePath ?? 'docker-compose.yml',
      input.preview?.parentApplicationId ?? null,
      input.preview?.number ?? null,
      input.preview?.title ?? null,
      input.preview?.url ?? null,
      input.preview?.author ?? null,
      input.preview?.headSha ?? null,
      now,
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): ApplicationRecord | undefined {
    const row = this.db.get('SELECT * FROM applications WHERE id = ?', id);
    return row === undefined ? undefined : mapApplication(row);
  }

  getForTeam(teamId: string, id: string): ApplicationRecord | undefined {
    const row = this.db.get('SELECT * FROM applications WHERE id = ? AND team_id = ?', id, teamId);
    return row === undefined ? undefined : mapApplication(row);
  }

  /** The project's applications, without pull request previews (those are listed under their parent). */
  listForProject(projectId: string): ApplicationRecord[] {
    return this.db.all('SELECT * FROM applications WHERE project_id = ? AND parent_application_id IS NULL ORDER BY created_at', projectId).map(mapApplication);
  }

  /** The team's applications, without pull request previews. */
  listForTeam(teamId: string): ApplicationRecord[] {
    return this.db.all('SELECT * FROM applications WHERE team_id = ? AND parent_application_id IS NULL ORDER BY name', teamId).map(mapApplication);
  }

  /** Pull request previews of an application, newest first. */
  listPreviews(parentId: string): ApplicationRecord[] {
    return this.db.all('SELECT * FROM applications WHERE parent_application_id = ? ORDER BY created_at DESC, id DESC', parentId).map(mapApplication);
  }

  findPreview(parentId: string, pullRequest: number): ApplicationRecord | undefined {
    const row = this.db.get('SELECT * FROM applications WHERE parent_application_id = ? AND preview_pr_number = ?', parentId, pullRequest);
    return row === undefined ? undefined : mapApplication(row);
  }

  /** Every preview of pull request `number` of `repository`, whichever parent made it. */
  previewsForPullRequest(installationId: number, repository: string, number: number): ApplicationRecord[] {
    return this.db
      .all(
        `SELECT * FROM applications
          WHERE parent_application_id IS NOT NULL AND github_installation_id = ? AND lower(repository) = lower(?) AND preview_pr_number = ?`,
        installationId,
        repository,
        number,
      )
      .map(mapApplication);
  }

  listForServer(serverId: string): ApplicationRecord[] {
    return this.db.all('SELECT * FROM applications WHERE server_id = ?', serverId).map(mapApplication);
  }

  listAll(): ApplicationRecord[] {
    return this.db.all('SELECT * FROM applications').map(mapApplication);
  }

  /** Applications that deploy automatically on a push to `repository@branch`. Previews deploy from pull request events instead. */
  findForPush(installationId: number, repository: string, branch: string): ApplicationRecord[] {
    return this.db
      .all(
        `SELECT * FROM applications
          WHERE source_type = 'github' AND github_installation_id = ? AND lower(repository) = lower(?) AND branch = ? AND auto_deploy = 1
            AND parent_application_id IS NULL`,
        installationId,
        repository,
        branch,
      )
      .map(mapApplication);
  }

  /** Web applications that preview pull requests into `repository@baseBranch`. */
  findForPullRequest(installationId: number, repository: string, baseBranch: string): ApplicationRecord[] {
    return this.db
      .all(
        `SELECT * FROM applications
          WHERE source_type = 'github' AND github_installation_id = ? AND lower(repository) = lower(?) AND branch = ? AND kind = 'web'
            AND previews_enabled = 1 AND parent_application_id IS NULL`,
        installationId,
        repository,
        baseBranch,
      )
      .map(mapApplication);
  }

  update(id: string, patch: ApplicationPatch): ApplicationRecord {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    let configChanged = false;
    for (const [key, spec] of Object.entries(APP_COLUMNS) as [keyof typeof APP_COLUMNS, (typeof APP_COLUMNS)[keyof typeof APP_COLUMNS]][]) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${spec.column} = ?`);
      values.push(typeof value === 'boolean' ? int01(value) : value);
      if (spec.config) configChanged = true;
    }
    if (sets.length > 0) {
      const now = nowIso();
      if (configChanged) {
        sets.push('config_updated_at = ?');
        values.push(now);
      }
      this.db.prepare(`UPDATE applications SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, now, id);
    }
    return this.get(id)!;
  }

  /** Record that something outside the row (variables, links, volumes) changed the runtime config. */
  markConfigChanged(id: string): void {
    this.db.run('UPDATE applications SET config_updated_at = ? WHERE id = ?', nowIso(), id);
  }

  markConfigChangedForService(serviceId: string): void {
    this.db.run(
      'UPDATE applications SET config_updated_at = ? WHERE id IN (SELECT application_id FROM service_links WHERE service_id = ?)',
      nowIso(),
      serviceId,
    );
  }

  markConfigChangedForProject(projectId: string): void {
    this.db.run('UPDATE applications SET config_updated_at = ? WHERE project_id = ?', nowIso(), projectId);
  }

  setHostAccess(id: string, allowed: boolean): void {
    this.db.run('UPDATE applications SET host_access = ?, updated_at = ? WHERE id = ?', int01(allowed), nowIso(), id);
  }

  setStatus(id: string, status: AppStatus): void {
    this.db.run('UPDATE applications SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id);
  }

  setActiveDeployment(id: string, deploymentId: string | null): void {
    this.db.run('UPDATE applications SET active_deployment_id = ?, updated_at = ? WHERE id = ?', deploymentId, nowIso(), id);
  }

  setDeployKey(id: string, sealedPrivateKey: string | null, publicKey: string | null): void {
    this.db.run('UPDATE applications SET deploy_key = ?, deploy_public_key = ? WHERE id = ?', sealedPrivateKey, publicKey, id);
  }

  setHookToken(id: string, sealed: string): void {
    this.db.run('UPDATE applications SET deploy_hook_token = ? WHERE id = ?', sealed, id);
  }

  /** Sealed `.env` text applied to every preview of this application; null for none. */
  setPreviewEnv(id: string, sealed: string | null): void {
    this.db.run('UPDATE applications SET preview_env_sealed = ?, updated_at = ? WHERE id = ?', sealed, nowIso(), id);
  }

  /** A preview's pull request changed (new commits, retitled). */
  updatePullRequest(id: string, pullRequest: PullRequestInfo): void {
    this.db.run(
      'UPDATE applications SET preview_pr_title = ?, preview_pr_url = ?, preview_pr_author = ?, preview_head_sha = ?, updated_at = ? WHERE id = ?',
      pullRequest.title,
      pullRequest.url,
      pullRequest.author,
      pullRequest.headSha,
      nowIso(),
      id,
    );
  }

  setPreviewComment(id: string, commentId: number | null): void {
    this.db.run('UPDATE applications SET preview_comment_id = ? WHERE id = ?', commentId, id);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM applications WHERE id = ?', id);
  }
}

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

export interface DeploymentOptions {
  clearCache?: boolean;
}

export interface DeploymentRecord {
  id: string;
  applicationId: string;
  projectId: string;
  teamId: string;
  serverId: string;
  status: DeploymentStatus;
  trigger: DeploymentTrigger;
  commitSha: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  branch: string | null;
  imageTag: string | null;
  /** Port the containers of this deployment listen on (resolved at deploy time). */
  port: number | null;
  imageRemoved: boolean;
  containers: string[];
  sourceDeploymentId: string | null;
  options: DeploymentOptions;
  errorMessage: string | null;
  /** Stable reason code for a failure (translated in the dashboard). */
  errorCode: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  startedAt: string | null;
  buildDurationMs: number | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Per-application sequence number (#1, #2, …); stable across pruning. */
  seq: number;
}

function mapDeployment(row: Row): DeploymentRecord {
  return {
    id: str(row.id),
    applicationId: str(row.application_id),
    projectId: str(row.project_id),
    teamId: str(row.team_id),
    serverId: str(row.server_id),
    status: str(row.status) as DeploymentStatus,
    trigger: str(row.trigger) as DeploymentTrigger,
    commitSha: strOrNull(row.commit_sha),
    commitMessage: strOrNull(row.commit_message),
    commitAuthor: strOrNull(row.commit_author),
    branch: strOrNull(row.branch),
    imageTag: strOrNull(row.image_tag),
    port: numOrNull(row.port),
    imageRemoved: bool(row.image_removed),
    containers: json<string[]>(row.containers, []),
    sourceDeploymentId: strOrNull(row.source_deployment_id),
    options: json<DeploymentOptions>(row.options, {}),
    errorMessage: strOrNull(row.error_message),
    errorCode: strOrNull(row.error_code),
    createdBy: strOrNull(row.created_by),
    createdByName: strOrNull(row.created_by_name),
    createdAt: str(row.created_at),
    startedAt: strOrNull(row.started_at),
    buildDurationMs: numOrNull(row.build_duration_ms),
    finishedAt: strOrNull(row.finished_at),
    durationMs: numOrNull(row.duration_ms),
    seq: numOrNull(row.seq) ?? 0,
  };
}

const DEPLOYMENT_SELECT = 'SELECT d.*, u.name AS created_by_name FROM deployments d LEFT JOIN users u ON u.id = d.created_by';

export class DeploymentStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: {
    application: ApplicationRecord;
    trigger: DeploymentTrigger;
    createdBy: string | null;
    commitSha?: string | null;
    commitMessage?: string | null;
    commitAuthor?: string | null;
    imageTag?: string | null;
    sourceDeploymentId?: string | null;
    options?: DeploymentOptions;
  }): DeploymentRecord {
    const id = newId('dep');
    const app = input.application;
    this.db.run(
      `INSERT INTO deployments (id, application_id, project_id, team_id, server_id, status, trigger, commit_sha, commit_message,
         commit_author, branch, image_tag, source_deployment_id, options, created_by, created_at, seq)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM deployments WHERE application_id = ?))`,
      id,
      app.id,
      app.projectId,
      app.teamId,
      app.serverId,
      input.trigger,
      input.commitSha ?? null,
      input.commitMessage ?? null,
      input.commitAuthor ?? null,
      app.branch,
      input.imageTag ?? null,
      input.sourceDeploymentId ?? null,
      JSON.stringify(input.options ?? {}),
      input.createdBy,
      nowIso(),
      app.id,
    );
    return this.get(id)!;
  }

  get(id: string): DeploymentRecord | undefined {
    const row = this.db.get(`${DEPLOYMENT_SELECT} WHERE d.id = ?`, id);
    return row === undefined ? undefined : mapDeployment(row);
  }

  getForTeam(teamId: string, id: string): DeploymentRecord | undefined {
    const row = this.db.get(`${DEPLOYMENT_SELECT} WHERE d.id = ? AND d.team_id = ?`, id, teamId);
    return row === undefined ? undefined : mapDeployment(row);
  }

  pageForApplication(applicationId: string, cursor: string | undefined, limit: number): { items: DeploymentRecord[]; nextCursor: string | null } {
    const after = decodeCursor(cursor);
    const rows = after === null
      ? this.db.all(`${DEPLOYMENT_SELECT} WHERE d.application_id = ? ORDER BY d.created_at DESC, d.id DESC LIMIT ?`, applicationId, limit + 1)
      : this.db.all(
          `${DEPLOYMENT_SELECT} WHERE d.application_id = ? AND (d.created_at, d.id) < (?, ?) ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
          applicationId,
          after.createdAt,
          after.id,
          limit + 1,
        );
    return toPage(rows.map(mapDeployment), limit);
  }

  /** Every deployment of a team, newest first; `statuses` narrows the list (empty: all). */
  pageForTeam(
    teamId: string,
    cursor: string | undefined,
    limit: number,
    statuses: readonly DeploymentStatus[] = [],
  ): { items: DeploymentRecord[]; nextCursor: string | null } {
    const after = decodeCursor(cursor);
    const where = ['d.team_id = ?'];
    const params: (string | number)[] = [teamId];
    if (statuses.length > 0) {
      where.push(`d.status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (after !== null) {
      where.push('(d.created_at, d.id) < (?, ?)');
      params.push(after.createdAt, after.id);
    }
    const rows = this.db.all(`${DEPLOYMENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC, d.id DESC LIMIT ?`, ...params, limit + 1);
    return toPage(rows.map(mapDeployment), limit);
  }

  latestForApplication(applicationId: string): DeploymentRecord | undefined {
    const row = this.db.get(`${DEPLOYMENT_SELECT} WHERE d.application_id = ? ORDER BY d.created_at DESC LIMIT 1`, applicationId);
    return row === undefined ? undefined : mapDeployment(row);
  }

  recentForTeam(teamId: string, limit: number): DeploymentRecord[] {
    return this.db.all(`${DEPLOYMENT_SELECT} WHERE d.team_id = ? ORDER BY d.created_at DESC LIMIT ?`, teamId, limit).map(mapDeployment);
  }

  /** Non-terminal deployments, oldest first — the queue. */
  listOpen(): DeploymentRecord[] {
    return this.db
      .all(`${DEPLOYMENT_SELECT} WHERE d.status IN ('queued','building','deploying') ORDER BY d.created_at`)
      .map(mapDeployment);
  }

  /** Successful deployments whose images are still present, newest first. */
  listWithImages(applicationId: string): DeploymentRecord[] {
    return this.db
      .all(
        `${DEPLOYMENT_SELECT} WHERE d.application_id = ? AND d.image_tag IS NOT NULL AND d.image_removed = 0 AND d.status = 'succeeded'
          ORDER BY d.created_at DESC`,
        applicationId,
      )
      .map(mapDeployment);
  }

  markStarted(id: string): void {
    this.db.run("UPDATE deployments SET status = 'building', started_at = ? WHERE id = ?", nowIso(), id);
  }

  setStatus(id: string, status: DeploymentStatus): void {
    this.db.run('UPDATE deployments SET status = ? WHERE id = ?', status, id);
  }

  setCommit(id: string, commit: { sha: string; message: string; author: string; branch: string | null }): void {
    this.db.run(
      'UPDATE deployments SET commit_sha = ?, commit_message = ?, commit_author = ?, branch = COALESCE(?, branch) WHERE id = ?',
      commit.sha,
      commit.message.slice(0, 500),
      commit.author.slice(0, 200),
      commit.branch,
      id,
    );
  }

  setImage(id: string, imageTag: string, buildDurationMs: number | null): void {
    this.db.run('UPDATE deployments SET image_tag = ?, build_duration_ms = ? WHERE id = ?', imageTag, buildDurationMs, id);
  }

  setContainers(id: string, containers: string[], port: number | null): void {
    this.db.run('UPDATE deployments SET containers = ?, port = ? WHERE id = ?', JSON.stringify(containers), port, id);
  }

  finish(id: string, status: Extract<DeploymentStatus, 'succeeded' | 'failed' | 'cancelled'>, errorMessage: string | null = null, errorCode: string | null = null): void {
    const deployment = this.get(id);
    if (deployment === undefined) return;
    const finishedAt = new Date();
    const startedAt = deployment.startedAt ?? deployment.createdAt;
    this.db.run(
      'UPDATE deployments SET status = ?, error_message = ?, error_code = ?, finished_at = ?, duration_ms = ? WHERE id = ?',
      status,
      errorMessage === null ? null : errorMessage.slice(0, 2_000),
      errorMessage === null ? null : (errorCode ?? 'unknown'),
      finishedAt.toISOString(),
      finishedAt.getTime() - Date.parse(startedAt),
      id,
    );
  }

  markImageRemoved(id: string): void {
    this.db.run('UPDATE deployments SET image_removed = 1 WHERE id = ?', id);
  }

  /** Delete all but the newest `keep` deployments of an application; returns removed ids (for log cleanup). */
  pruneHistory(applicationId: string, keep: number, protectedIds: string[]): string[] {
    const rows = this.db.all(
      `SELECT id FROM deployments WHERE application_id = ? AND status IN ('succeeded','failed','cancelled')
        ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
      applicationId,
      keep,
    );
    const ids = rows.map((row) => str(row.id)).filter((id) => !protectedIds.includes(id));
    for (const id of ids) this.db.run('DELETE FROM deployments WHERE id = ?', id);
    return ids;
  }
}
