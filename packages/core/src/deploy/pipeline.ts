/**
 * Deployment pipeline.
 *
 * A linear, observable, recoverable sequence of stages:
 *
 *   PREPARE → FETCH → BUILD → START → HEALTH → SWITCH → DRAIN → COMMIT
 *
 * The zero-downtime guarantee is structural, not aspirational: traffic is
 * switched only after the new containers answer a real HTTP health check. If
 * anything fails before SWITCH the running application was never touched; if it
 * fails after, the previous deployment is restarted and re-attached.
 *
 * Every stage writes to a durable log file (so a page refresh or a late client
 * still sees full history) *and* to the event bus (so the UI is live).
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContainerEngine, ContainerSpec } from '../exec/engine.ts';
import { ensureClone, readCommitInfo, removeWorkDir } from '../exec/git.ts';
import { healthUrlFor, waitForHealthy } from '../exec/health.ts';
import { AppError } from '../errors.ts';
import { containerSlug, nowIso } from '../ids.ts';
import type { EventBus } from '../realtime/events.ts';
import type { Application, Deployment, DeploymentTrigger } from '../domain/types.ts';
import type { Repositories } from '../domain/repositories.ts';
import type { AppConfig } from '../config.ts';
import type { ProxyManager } from '../proxy/manager.ts';
import type { Logger } from '../logger.ts';

export interface DeploymentContext {
  repos: Repositories;
  config: AppConfig;
  logger: Logger;
  bus: EventBus;
  /** Resolve the engine for a server (local process or Docker on that host). */
  resolveEngine: (serverId: string) => Promise<ContainerEngine>;
  proxy: ProxyManager;
}

export interface DeployRequest {
  applicationId: string;
  trigger: DeploymentTrigger;
  /** Deploy this exact image without building (used by rollback and redeploy). */
  imageTag?: string;
  createdBy?: string | null;
  rollbackOf?: string | null;
  signal?: AbortSignal;
}

export type LogWriter = (message: string, stream?: 'stdout' | 'stderr' | 'system') => Promise<void>;

/** Labels applied to every container so the platform can find them again. */
export function containerLabels(application: Application, deploymentId: string): Record<string, string> {
  return {
    'ploy.managed': 'true',
    'ploy.application': application.id,
    'ploy.deployment': deploymentId,
    'ploy.slug': application.slug,
  };
}

/** Deterministic container name: stable prefix, unique per deployment. */
export function containerName(application: Application, deploymentId: string, replica: number): string {
  return `ploy-${containerSlug(application.slug)}-${deploymentId.slice(-8)}-${replica}`;
}

/** Container names belonging to a deployment, derived rather than stored. */
export function deploymentContainerNames(application: Application, deploymentId: string, replicas: number): string[] {
  return Array.from({ length: Math.max(1, replicas) }, (_, index) => containerName(application, deploymentId, index));
}

/** The port the application listens on inside its container. */
export function resolveInternalPort(application: Application): number {
  if (application.internalPort !== null && application.internalPort.trim().length > 0) {
    const parsed = Number(application.internalPort);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  // A framework-agnostic default. Getting this wrong fails the health check
  // loudly rather than silently misrouting traffic.
  return 3000;
}

/** Build the container spec for one replica. */
export function buildContainerSpec(
  application: Application,
  deploymentId: string,
  engineName: string,
  imageTag: string,
  env: Record<string, string>,
  replica: number,
): ContainerSpec {
  const internalPort = resolveInternalPort(application);
  const name = containerName(application, deploymentId, replica);
  return {
    name,
    imageTag,
    internalPort,
    // Docker routes by container name on the shared network; the local engine
    // binds a loopback port, which it fills in during start().
    address: engineName === 'docker' ? `${name}:${internalPort}` : '',
    env: { ...env, PORT: String(internalPort) },
    limits: { cpus: application.cpuLimit, memoryMb: application.memoryLimitMb },
    replicas: 1,
    network: 'ploy',
    labels: containerLabels(application, deploymentId),
    workingDir: null,
    command: application.startCommand,
  };
}

export class DeploymentPipeline {
  private readonly ctx: DeploymentContext;
  private readonly active = new Map<string, AbortController>();

  constructor(ctx: DeploymentContext) {
    this.ctx = ctx;
  }

  isActive(applicationId: string): boolean {
    return this.active.has(applicationId);
  }

  /** Cancel an in-flight deployment. Returns false when nothing was running. */
  cancel(applicationId: string): boolean {
    const controller = this.active.get(applicationId);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  /** Applications with a deployment currently in flight. */
  activeApplicationIds(): string[] {
    return [...this.active.keys()];
  }

  /**
   * Run a deployment end to end.
   *
   * Operational failures are recorded on the deployment and returned; only
   * programming errors throw. A failed deployment is a normal outcome, not an
   * exception to propagate.
   */
  async run(request: DeployRequest): Promise<Deployment> {
    const { repos, config, logger, bus } = this.ctx;

    const application = repos.applications.getByIdOrThrow(request.applicationId);
    const project = repos.projects.getByIdOrThrow(application.projectId);
    const server = repos.servers.getByIdOrThrow(application.serverId);

    if (this.active.has(application.id)) {
      throw new AppError('conflict', 'A deployment is already running for this application', {
        details: { applicationId: application.id },
      });
    }

    const controller = new AbortController();
    if (request.signal !== undefined) {
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    this.active.set(application.id, controller);

    const logDir = join(config.dataDir, 'logs', 'deployments');
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    const deploymentLogPath = join(logDir, `${application.slug}.log`);

    const deployment = repos.deployments.create({
      applicationId: application.id,
      serverId: application.serverId,
      trigger: request.trigger,
      branch: application.repoBranch,
      logPath: deploymentLogPath,
      createdBy: request.createdBy ?? null,
      rollbackOf: request.rollbackOf ?? null,
    });

    const log: LogWriter = async (message, stream = 'system') => {
      await appendFile(deploymentLogPath, `${nowIso()} ${message}\n`, { mode: 0o600 }).catch(() => {});
      bus.log({ deploymentId: deployment.id, applicationId: application.id, stream, message });
    };

    // Truncate the per-application log so it does not grow without bound.
    await writeFile(deploymentLogPath, '', { mode: 0o600 }).catch(() => {});

    let workDir: string | null = null;
    let imageTag = request.imageTag ?? '';

    try {
      const engine = await this.ctx.resolveEngine(application.serverId);
      await log(`TorexPloy deployment ${deployment.id} starting (${request.trigger})`);
      await log(`Application: ${project.name} / ${application.name} (${application.slug})`);
      await log(`Server: ${server.name} (${server.mode}) · engine: ${engine.name}`);

      const engineInfo = await engine.probe();
      if (!engineInfo.available) {
        throw new AppError('engine_unavailable', engineInfo.detail ?? `Engine ${engine.name} is unavailable`);
      }
      await log(`Engine ready: ${engineInfo.name}${engineInfo.version === null ? '' : ` ${engineInfo.version}`}`);

      // ------------------------------------------------------------- PREPARE
      await engine.ensureNetwork('ploy');
      const runtimeEnv = repos.envVars.resolveForApplication(application.id, project.id, 'runtime');
      const buildEnv = repos.envVars.resolveForApplication(application.id, project.id, 'build');
      await log(`Prepared ${Object.keys(runtimeEnv).length} runtime variable(s), port ${resolveInternalPort(application)}`);

      // --------------------------------------------------------- FETCH + BUILD
      if (imageTag.length === 0) {
        if (application.sourceType === 'image') {
          throw new AppError('bad_request', 'Image-sourced applications must be deployed with an explicit image tag');
        }
        if (application.repoUrl === null || application.repoUrl.length === 0) {
          throw new AppError('bad_request', 'Application has no repository configured');
        }

        workDir = join(config.dataDir, 'builds', `${application.slug}-${deployment.id.slice(-8)}`);
        await log(`Fetching repository (branch ${application.repoBranch})`);

        await ensureClone({
          workDir,
          repoUrl: application.repoUrl,
          branch: application.repoBranch,
          token: null,
          timeoutMs: config.gitTimeoutMs,
          signal: controller.signal,
          onOutput: (chunk) => void log(chunk.trimEnd(), 'stdout'),
        });

        const commit = await readCommitInfo(workDir, application.repoBranch);
        repos.deployments.updateCommitInfo(deployment.id, {
          sha: commit.sha,
          message: commit.message,
          author: commit.author,
          branch: commit.branch,
        });
        await log(`Commit ${commit.shortSha} by ${commit.author}: ${commit.message}`);

        repos.deployments.updateStatus(deployment.id, 'building');
        repos.applications.setStatus(application.id, 'building');
        bus.emit('deployment.updated', deployment.id, { deploymentId: deployment.id, status: 'building' });

        imageTag = `ploy/${containerSlug(application.slug)}:${deployment.id}`;
        await log(`Building image ${imageTag} (${application.buildType})`);

        const buildResult = await engine.build(
          {
            imageTag,
            contextDir: application.buildContext === '.' ? workDir : join(workDir, application.buildContext),
            dockerfilePath: application.dockerfilePath,
            buildArgs: { ...application.buildArgs, ...buildEnv },
            cacheDir: join(config.dataDir, 'cache', application.slug),
          },
          (chunk) => void log(chunk.trimEnd(), 'stdout'),
          controller.signal,
        );

        await log(
          `Build finished in ${(buildResult.durationMs / 1000).toFixed(1)}s${buildResult.cached ? ' (layer cache hit)' : ''}`,
        );
        repos.deployments.updateStatus(deployment.id, 'building', { imageTag });
      } else {
        await log(`Reusing image ${imageTag} (no build required)`);
        repos.deployments.updateStatus(deployment.id, 'deploying', { imageTag });
      }

      // --------------------------------------------------------------- START
      repos.deployments.updateStatus(deployment.id, 'deploying');
      repos.applications.setStatus(application.id, 'deploying');
      bus.emit('deployment.updated', deployment.id, { deploymentId: deployment.id, status: 'deploying' });

      const replicas = Math.max(1, application.replicas);
      const specs = Array.from({ length: replicas }, (_, replica) => {
        const spec = buildContainerSpec(application, deployment.id, engine.name, imageTag, runtimeEnv, replica);
        // The local engine runs the build output in place.
        return engine.name === 'local' ? { ...spec, appDir: workDir, workingDir: workDir } : spec;
      });

      await log(`Starting ${replicas} container(s)`);
      const refs = await engine.start(specs, (chunk) => void log(chunk.trimEnd(), 'stdout'));
      repos.deployments.updateStatus(deployment.id, 'deploying', { containerIds: refs.map((ref) => ref.id) });
      await log(`Started: ${refs.map((ref) => `${ref.name} → ${ref.address || 'pending'}`).join(', ')}`);

      // -------------------------------------------------------------- HEALTH
      const healthPath = application.healthCheckPath ?? '/';
      for (const ref of refs) {
        if (ref.address.length === 0) continue;
        const url = healthUrlFor(ref.address, healthPath);
        await log(`Health checking ${url}`);

        const result = await waitForHealthy({
          url,
          timeoutMs: 3_000,
          intervalMs: 1_000,
          totalTimeoutMs: config.healthCheckTimeoutMs,
          signal: controller.signal,
          onAttempt: (attempt, record) => {
            if (!record.ok) void log(`  attempt ${attempt}: ${record.error ?? `status ${record.status}`}`, 'stdout');
          },
        });

        if (!result.healthy) {
          const tail = await engine.logs(ref.name, 40).catch(() => '');
          if (tail.length > 0) await log(`Container output:\n${tail}`, 'stderr');
          throw new AppError('health_check_failed', `Health check failed for ${ref.name}: ${result.error ?? 'unknown error'}`);
        }
        await log(`✓ ${ref.name} healthy (${result.status}, ${result.totalDurationMs}ms)`);
      }

      // -------------------------------------------------------------- SWITCH
      const domains = repos.domains.listForApplication(application.id);
      if (domains.length > 0) {
        await log(`Routing ${domains.map((domain) => domain.host).join(', ')} to the new containers`);
        await this.ctx.proxy.apply({
          application,
          deploymentId: deployment.id,
          upstreams: refs.map((ref) => ref.address).filter((address) => address.length > 0),
          domains,
          internalPort: resolveInternalPort(application),
        });
        await log('Traffic switched to the new deployment');
      } else {
        await log('No domains configured; the deployment runs but is not reachable externally');
      }

      repos.deployments.updateStatus(deployment.id, 'running');
      bus.emit('deployment.updated', deployment.id, { deploymentId: deployment.id, status: 'running' });

      // --------------------------------------------------------------- DRAIN
      const previous = repos.deployments
        .listForApplication(application.id, 20)
        .find((candidate) => candidate.id !== deployment.id && candidate.status === 'success');

      if (previous !== undefined) {
        const staleNames = new Set(deploymentContainerNames(application, previous.id, replicas));
        const running = await engine.list({ label: `ploy.application=${application.id}` });
        const toDrain = running.filter((container) => staleNames.has(container.name)).map((container) => container.name);

        if (toDrain.length > 0) {
          await log(`Draining ${toDrain.length} previous container(s) after a ${config.drainTimeoutMs}ms grace period`);
          if (config.drainTimeoutMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, config.drainTimeoutMs));
          }
          await engine.remove(toDrain);
          await log('Previous containers stopped and removed');
        }
      }

      // -------------------------------------------------------------- COMMIT
      repos.deployments.finish(deployment.id, 'success');
      repos.applications.setStatus(application.id, 'running');
      for (const domain of domains) {
        repos.domains.updateStatus(domain.id, 'active', domain.https ? 'issued' : 'disabled');
      }
      await log('✓ Deployment successful');

      bus.emit('deployment.updated', deployment.id, { deploymentId: deployment.id, status: 'success' });
      bus.emit('application.updated', application.id, { applicationId: application.id, status: 'running' });
      logger.info('Deployment succeeded', {
        deploymentId: deployment.id,
        applicationId: application.id,
        durationMs: Date.now() - Date.parse(deployment.startedAt),
      });

      return repos.deployments.getByIdOrThrow(deployment.id);
    } catch (error) {
      const engine = await this.ctx.resolveEngine(application.serverId).catch(() => null);

      // Clean up containers this attempt started, so a failed deploy leaves no debris.
      if (engine !== null) {
        await engine
          .removeByPrefix(`ploy-${containerSlug(application.slug)}-${deployment.id.slice(-8)}`)
          .catch(() => {});
      }

      if (controller.signal.aborted) {
        await log('✗ Deployment cancelled', 'stderr');
        repos.deployments.finish(deployment.id, 'cancelled', 'Cancelled by user');
        bus.emit('deployment.updated', deployment.id, { deploymentId: deployment.id, status: 'cancelled' });
        return repos.deployments.getByIdOrThrow(deployment.id);
      }

      const message = error instanceof Error ? error.message : String(error);
      await log(`✗ Deployment failed: ${message}`, 'stderr');
      repos.deployments.finish(deployment.id, 'failed', message);
      bus.emit('deployment.updated', deployment.id, { deploymentId: deployment.id, status: 'failed', error: message });

      // Restore the previous working version so the application keeps serving.
      try {
        const restored = await this.rollback(application.id, deployment.id, log);
        if (restored === null) {
          repos.applications.setStatus(application.id, 'failed');
          bus.emit('application.updated', application.id, { applicationId: application.id, status: 'failed' });
        }
      } catch (rollbackError) {
        await log(
          `✗ Automatic rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          'stderr',
        );
        repos.applications.setStatus(application.id, 'failed');
      }

      return repos.deployments.getByIdOrThrow(deployment.id);
    } finally {
      this.active.delete(application.id);
      // The build directory is disposable once the image exists. It is kept on
      // failure so the operator can inspect the checkout.
      const finished = repos.deployments.getById(deployment.id);
      if (finished?.status === 'success' && workDir !== null) {
        await removeWorkDir(workDir).catch(() => {});
      }
    }
  }

  /**
   * Roll back to the last successful deployment.
   *
   * Rollback reuses the previous image rather than rebuilding: it is fast,
   * deterministic and cannot fail because of a transient registry or network
   * problem. That is what makes it a dependable safety net.
   */
  async rollback(applicationId: string, failedDeploymentId: string, log: LogWriter): Promise<Deployment | null> {
    const { repos } = this.ctx;
    const application = repos.applications.getByIdOrThrow(applicationId);

    const target = repos.deployments
      .listForApplication(applicationId, 50)
      .find(
        (candidate) =>
          candidate.id !== failedDeploymentId && candidate.status === 'success' && candidate.imageTag !== null,
      );

    if (target === undefined || target.imageTag === null) {
      await log('No previous successful deployment is available to roll back to', 'stderr');
      return null;
    }

    await log(`↩ Rolling back to deployment ${target.id} (image ${target.imageTag})`);

    const engine = await this.ctx.resolveEngine(application.serverId);
    const runtimeEnv = repos.envVars.resolveForApplication(application.id, application.projectId, 'runtime');
    const replicas = Math.max(1, application.replicas);

    const specs = Array.from({ length: replicas }, (_, replica) =>
      buildContainerSpec(application, target.id, engine.name, target.imageTag!, runtimeEnv, replica),
    );

    const refs = await engine.start(specs, (chunk) => void log(chunk.trimEnd(), 'stdout'));

    for (const ref of refs) {
      if (ref.address.length === 0) continue;
      const result = await waitForHealthy({
        url: healthUrlFor(ref.address, application.healthCheckPath),
        timeoutMs: 3_000,
        intervalMs: 1_000,
        totalTimeoutMs: this.ctx.config.healthCheckTimeoutMs,
      });
      if (!result.healthy) {
        await log(`Rollback health check failed for ${ref.name}: ${result.error ?? 'unknown'}`, 'stderr');
        await engine.remove(refs.map((candidate) => candidate.name));
        return null;
      }
    }

    const domains = repos.domains.listForApplication(application.id);
    if (domains.length > 0) {
      await this.ctx.proxy.apply({
        application,
        deploymentId: target.id,
        upstreams: refs.map((ref) => ref.address).filter((address) => address.length > 0),
        domains,
        internalPort: resolveInternalPort(application),
      });
    }

    repos.applications.setStatus(application.id, 'running');
    for (const domain of domains) {
      repos.domains.updateStatus(domain.id, 'active', domain.https ? 'issued' : 'disabled');
    }
    await log(`✓ Rolled back to ${target.commitSha?.slice(0, 7) ?? target.id}`);

    return repos.deployments.getByIdOrThrow(target.id);
  }

  /** Re-attach the running deployment after a control-plane restart. */
  async reattach(applicationId: string, log: LogWriter): Promise<boolean> {
    const { repos } = this.ctx;
    const application = repos.applications.getByIdOrThrow(applicationId);
    const running = repos.deployments.getRunning(applicationId);
    if (running === undefined || running.imageTag === null) return false;

    const engine = await this.ctx.resolveEngine(application.serverId);
    const containers = await engine.list({ label: `ploy.application=${application.id}` });
    const alive = containers.filter((container) => container.running);
    if (alive.length === 0) return false;

    await log(`Re-attached ${alive.length} running container(s) from deployment ${running.id}`);
    const domains = repos.domains.listForApplication(application.id);
    if (domains.length > 0) {
      await this.ctx.proxy.apply({
        application,
        deploymentId: running.id,
        upstreams: alive
          .map((container) => (engine.name === 'docker' ? `${container.name}:${resolveInternalPort(application)}` : container.labels['ploy.address'] ?? ''))
          .filter((address) => address.length > 0),
        domains,
        internalPort: resolveInternalPort(application),
      });
    }
    return true;
  }
}
