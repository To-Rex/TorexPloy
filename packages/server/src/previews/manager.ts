/**
 * Pull request previews.
 *
 * A preview is an ordinary application, hidden from every list, that deploys
 * one pull request of its parent's repository: the parent's build and runtime
 * settings, variables and linked databases, the parent's preview variables on
 * top, and an address of its own. Because it is an application, builds, logs,
 * deployments, domains, routing, metrics and the terminal all work unchanged.
 *
 * GitHub drives the lifecycle. A pull request that opens, reopens or receives
 * commits creates the preview (while the parent is under its preview limit)
 * or refreshes it from the parent, then deploys its head commit; closing the
 * pull request removes the preview with its containers, images and data.
 * Pull requests from forks are ignored: their code would run with the
 * parent's secrets.
 */
import { BRANCH_RE, LIMITS, parseDotenv } from '@ploy/shared';
import { emit, type Context } from '../context.ts';
import { generateDomain } from '../domains/generate.ts';
import { publicBaseUrl } from '../github/app.ts';
import { generateToken } from '../lib/crypto.ts';
import { errorMessage } from '../lib/errors.ts';
import type { ApplicationRecord, DeploymentRecord, PullRequestInfo } from '../store/index.ts';

/** The parts of a `pull_request` webhook payload previews use. */
interface PullRequestPayload {
  number?: number;
  title?: string;
  html_url?: string;
  user?: { login?: string } | null;
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string; repo?: { full_name?: string } | null };
}

const DEPLOY_ACTIONS = ['opened', 'reopened', 'synchronize'];

export class PreviewManager {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  // --------------------------------------------------------------- webhook

  /** Handle a verified `pull_request` delivery. Returns a short summary for the delivery log. */
  async handlePullRequest(installationId: number | undefined, payload: Record<string, unknown>): Promise<string> {
    const { stores, logger } = this.ctx;
    const action = String(payload.action ?? '');
    const pr = payload.pull_request as PullRequestPayload | undefined;
    const repository = pr?.base?.repo?.full_name ?? '';
    if (installationId === undefined || pr === undefined || !Number.isInteger(pr.number) || repository.length === 0) return 'ignored';
    const number = pr.number!;

    if (action === 'closed') {
      const previews = stores.applications.previewsForPullRequest(installationId, repository, number);
      for (const preview of previews) {
        await this.remove(preview);
        stores.audit.record({
          teamId: preview.teamId,
          userId: null,
          action: 'preview.deleted',
          targetType: 'application',
          targetId: preview.id,
          targetName: preview.name,
          metadata: { parentId: preview.parentApplicationId, pullRequest: number, reason: 'closed' },
        });
      }
      return `removed ${previews.length} preview(s)`;
    }
    if (!DEPLOY_ACTIONS.includes(action)) return 'ignored';

    // Code from a fork must never run with the parent's variables and databases.
    const headRepository = pr.head?.repo?.full_name;
    if (headRepository == null || headRepository.toLowerCase() !== repository.toLowerCase()) return 'ignored: pull request from a fork';
    const branch = pr.head?.ref ?? '';
    const sha = pr.head?.sha ?? '';
    if (!BRANCH_RE.test(branch) || !/^[0-9a-f]{40}$/.test(sha) || pr.base?.ref === undefined) return 'ignored';
    const installation = stores.installations.get(installationId);
    if (installation === undefined) return 'ignored: unknown installation';

    const info: PullRequestInfo = {
      number,
      title: String(pr.title ?? '').slice(0, 500),
      url: String(pr.html_url ?? ''),
      author: pr.user?.login ?? null,
      headSha: sha,
    };
    const sender = (payload.sender as { login?: string } | undefined)?.login ?? info.author;
    let queued = 0;
    let overLimit = 0;
    for (const parent of stores.applications.findForPullRequest(installationId, repository, pr.base.ref)) {
      if (parent.teamId !== installation.teamId) continue;
      try {
        let preview = stores.applications.findPreview(parent.id, number);
        if (preview === undefined) {
          if (stores.applications.listPreviews(parent.id).length >= parent.previewLimit) {
            logger.info('Preview limit reached; pull request not previewed', { applicationId: parent.id, pullRequest: number, limit: parent.previewLimit });
            overLimit += 1;
            continue;
          }
          preview = this.create(parent, info, branch);
        } else {
          stores.applications.updatePullRequest(preview.id, info);
          preview = this.refresh(parent, preview, branch);
        }
        this.ctx.deployer.enqueue({ app: preview, trigger: 'push', createdBy: null, commitSha: sha, commitMessage: info.title, commitAuthor: sender });
        queued += 1;
      } catch (error) {
        logger.warn('Could not deploy a pull request preview', { applicationId: parent.id, pullRequest: number, error: errorMessage(error) });
      }
    }
    return `queued ${queued} preview deployment(s)${overLimit > 0 ? `, ${overLimit} over the preview limit` : ''}`;
  }

  // ------------------------------------------------------------- lifecycle

  /** A new preview of `parent` for one pull request, with its own generated address. */
  private create(parent: ApplicationRecord, pullRequest: PullRequestInfo, branch: string): ApplicationRecord {
    const { stores } = this.ctx;
    const project = stores.projects.get(parent.projectId)!;
    const suffix = `-pr-${pullRequest.number}`;
    const preview = stores.db.transaction(() => {
      const created = stores.applications.create({
        projectId: parent.projectId,
        teamId: parent.teamId,
        serverId: parent.serverId,
        name: `${parent.name.slice(0, LIMITS.nameMax - suffix.length)}${suffix}`,
        slug: stores.projects.uniqueResourceSlug(parent.projectId, `${parent.slug.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`, 'app'),
        kind: 'web',
        sourceType: 'github',
        githubInstallationId: parent.githubInstallationId,
        repository: parent.repository,
        gitUrl: null,
        branch,
        image: null,
        sealedHookToken: this.ctx.secrets.seal(generateToken(24), 'hook'),
        preview: { ...pullRequest, parentApplicationId: parent.id },
      });
      const copied = this.refresh(parent, created);
      // Without an apps domain or a public IP no address can be made; the preview still deploys.
      generateDomain(this.ctx, copied, project, { label: `pr-${pullRequest.number}-${parent.slug}` });
      stores.audit.record({
        teamId: parent.teamId,
        userId: null,
        action: 'preview.created',
        targetType: 'application',
        targetId: copied.id,
        targetName: copied.name,
        metadata: { parentId: parent.id, pullRequest: pullRequest.number, branch },
      });
      return copied;
    });
    this.changed(preview);
    this.changed(parent);
    return preview;
  }

  /**
   * Bring a preview in line with its parent: build and runtime settings (one
   * replica, rolling, never deployed by pushes), the parent's variables with
   * the preview variables over them, and the same linked databases. Runs on
   * every deployment, so settings changed on the parent apply on the next push.
   */
  refresh(parent: ApplicationRecord, preview: ApplicationRecord, branch?: string): ApplicationRecord {
    const { stores, secrets } = this.ctx;
    return stores.db.transaction(() => {
      stores.applications.update(preview.id, {
        ...(branch === undefined ? {} : { branch }),
        buildType: parent.buildType,
        dockerfilePath: parent.dockerfilePath,
        rootDirectory: parent.rootDirectory,
        installCommand: parent.installCommand,
        buildCommand: parent.buildCommand,
        startCommand: parent.startCommand,
        outputDirectory: parent.outputDirectory,
        buildStage: parent.buildStage,
        buildpackBuilder: parent.buildpackBuilder,
        systemPackages: parent.systemPackages,
        port: parent.port,
        replicas: 1,
        cpuLimit: parent.cpuLimit,
        memoryLimitMb: parent.memoryLimitMb,
        healthCheckPath: parent.healthCheckPath,
        healthCheckTimeoutSec: parent.healthCheckTimeoutSec,
        strategy: 'rolling',
        autoDeploy: false,
      });

      const variables = stores.env.list({ applicationId: parent.id });
      const overrides = parent.previewEnvSealed === null ? [] : parseDotenv(secrets.open(parent.previewEnvSealed, 'env')).variables;
      for (const variable of overrides) {
        const index = variables.findIndex((existing) => existing.key === variable.key);
        if (index === -1) variables.push(variable);
        else variables[index] = variable;
      }
      stores.env.replace({ applicationId: preview.id }, variables);

      const wanted = stores.links.listForApplication(parent.id);
      const current = stores.links.listForApplication(preview.id);
      for (const link of current) {
        if (!wanted.some((other) => other.serviceId === link.serviceId && other.prefix === link.prefix)) stores.links.delete(link.id);
      }
      for (const link of wanted) {
        if (!current.some((other) => other.serviceId === link.serviceId && other.prefix === link.prefix)) stores.links.create(preview.id, link.serviceId, link.prefix);
      }
      return stores.applications.get(preview.id)!;
    });
  }

  /** Deploy the pull request head GitHub last reported, with the parent's current settings. */
  redeploy(preview: ApplicationRecord, userId: string | null): DeploymentRecord {
    const parent = this.ctx.stores.applications.get(preview.parentApplicationId ?? '');
    const current = parent === undefined ? preview : this.refresh(parent, preview);
    return this.ctx.deployer.enqueue({ app: current, trigger: 'manual', createdBy: userId, commitSha: preview.previewHeadSha });
  }

  /** Remove a preview with its containers, images, data, logs and metrics. */
  async remove(preview: ApplicationRecord): Promise<void> {
    await this.ctx.deployer.remove(preview, true);
    const parent = preview.parentApplicationId === null ? undefined : this.ctx.stores.applications.get(preview.parentApplicationId);
    if (parent !== undefined) this.changed(parent);
  }

  private changed(application: ApplicationRecord): void {
    const current = this.ctx.stores.applications.get(application.id) ?? application;
    emit(this.ctx, current.teamId, { type: 'application.updated', id: current.id, projectId: current.projectId, status: current.status });
  }

  // ---------------------------------------------------------- pull request

  /**
   * After a successful deployment: post the preview's address on the pull
   * request, or update the comment posted before. Best effort — a missing
   * permission or an unreachable GitHub never affects the deployment.
   */
  async commentDeployed(previewId: string, deploymentId: string): Promise<void> {
    const { stores, github, logger } = this.ctx;
    const preview = stores.applications.get(previewId);
    if (preview?.parentApplicationId == null || preview.previewPrNumber === null || preview.githubInstallationId === null || preview.repository === null) return;
    if (github.credentials() === null) return;
    const parent = stores.applications.get(preview.parentApplicationId);
    const deployment = stores.deployments.get(deploymentId);
    const url = stores.domains.primaryUrl(preview.id);
    const base = publicBaseUrl(this.ctx) ?? github.credentials()?.baseUrl ?? null;
    const sha = deployment?.commitSha ?? preview.previewHeadSha;
    const rows = [
      `| Preview | ${url ?? 'no public address (set an apps domain in TorexPloy)'} |`,
      ...(sha === null ? [] : [`| Commit | \`${sha.slice(0, 7)}\` |`]),
      ...(base === null ? [] : [`| Deployment | [Logs](${base}/deployments/${deploymentId}) |`]),
    ];
    const body = [
      `**TorexPloy preview of ${parent?.name ?? preview.name} is ready**`,
      '',
      '| | |',
      '|---|---|',
      ...rows,
      '',
      '<sub>Redeployed on every push to this pull request and removed when it closes.</sub>',
    ].join('\n');
    try {
      const commentId = await github.upsertIssueComment(preview.githubInstallationId, preview.repository, preview.previewPrNumber, preview.previewCommentId, body);
      if (commentId !== preview.previewCommentId) stores.applications.setPreviewComment(preview.id, commentId);
    } catch (error) {
      logger.warn('Could not comment on the pull request', { applicationId: preview.id, pullRequest: preview.previewPrNumber, error: errorMessage(error) });
    }
  }
}
