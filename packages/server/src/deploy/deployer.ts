/**
 * The deployment pipeline and its queue.
 *
 *   QUEUED → FETCH → BUILD → START → HEALTH → SWITCH → DRAIN → SUCCEEDED
 *
 * Zero downtime is structural: new containers start beside the old ones,
 * must pass a real health check from the proxy's network position, and only
 * then does the proxy configuration switch — atomically — to them. Any
 * failure before the switch leaves the running version untouched; a failure
 * while switching restores the previous route. Old containers keep serving
 * in-flight requests for a drain period before they are stopped gracefully.
 *
 * The queue is the `deployments` table itself (`status = 'queued'`), so it
 * survives restarts. One deployment runs per application at a time; overall
 * concurrency follows the platform's build-concurrency setting. A newer
 * queued deployment supersedes older queued ones for the same application.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isTerminalDeployment, type DeploymentTrigger } from '@ploy/shared';
import { buildImage } from '../build/builder.ts';
import { planBuild, type BuildPlan } from '../build/detect.ts';
import { buildWorkDir, checkout, cloneUrl } from '../build/git.ts';
import { emit, type Context } from '../context.ts';
import type { DockerClient } from '../docker/client.ts';
import { cliAuths, registryAuthHeader } from '../docker/registry.ts';
import {
  appContainer,
  appPrefix,
  imageRepository,
  imageTag as makeImageTag,
  idPart,
  LABEL_APP,
  LABEL_DEPLOYMENT,
  LABEL_MANAGED,
  LABEL_PROJECT,
  LABEL_ROLE,
  LABEL_TEAM,
  projectNetwork,
} from '../docker/naming.ts';
import { AppError, errorMessage, reasonOf } from '../lib/errors.ts';
import { DEFAULT_APP_PORT } from '../proxy/manager.ts';
import type { ApplicationRecord, DeploymentRecord, VolumeRecord } from '../store/index.ts';
import { resolveAppEnv, withPlatformEnv } from './env.ts';
import { LogWriter, logPath, removeLog } from './logs.ts';

/** Capabilities kept for application containers: Docker's default set minus NET_RAW, MKNOD, AUDIT_WRITE and SETFCAP. */
export const APP_CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID', 'SETPCAP', 'NET_BIND_SERVICE', 'SYS_CHROOT'];

const HISTORY_LIMIT = 50;
const WORKER_STABILITY_MS = 10_000;
const PROBE_INTERVAL_MS = 2_000;
const STOP_TIMEOUT_SEC = 30;

export interface EnqueueInput {
  app: ApplicationRecord;
  trigger: DeploymentTrigger;
  createdBy: string | null;
  commitSha?: string | null;
  commitMessage?: string | null;
  commitAuthor?: string | null;
  /** Deploy an existing image instead of building (rollback, redeploy, restart). */
  imageTag?: string | null;
  sourceDeploymentId?: string | null;
  clearCache?: boolean;
}

export interface ContainerSpecInput {
  app: ApplicationRecord;
  deploymentId: string;
  replica: number;
  image: string;
  env: Record<string, string>;
  port: number | null;
  volumes: VolumeRecord[];
  /** Overrides the image's command (only when the user set one and the image did not bake it in). */
  command: string | null;
}

/** The Engine API create body for one application replica. Pure, so it is unit-tested directly. */
export function appContainerSpec(input: ContainerSpecInput): Record<string, unknown> {
  const { app } = input;
  const network = projectNetwork(app.projectId);
  return {
    Image: input.image,
    Env: Object.entries(input.env).map(([key, value]) => `${key}=${value}`),
    Labels: {
      [LABEL_MANAGED]: 'true',
      [LABEL_ROLE]: 'app',
      [LABEL_APP]: app.id,
      [LABEL_DEPLOYMENT]: input.deploymentId,
      [LABEL_PROJECT]: app.projectId,
      [LABEL_TEAM]: app.teamId,
    },
    ...(input.command === null ? {} : { Cmd: ['sh', '-c', input.command], Entrypoint: [] }),
    ...(input.port === null ? {} : { ExposedPorts: { [`${input.port}/tcp`]: {} } }),
    StopTimeout: STOP_TIMEOUT_SEC,
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      Init: true,
      ...(app.memoryLimitMb === null ? {} : { Memory: app.memoryLimitMb * 1024 * 1024, MemorySwap: app.memoryLimitMb * 1024 * 1024 }),
      ...(app.cpuLimit === null ? {} : { NanoCpus: Math.round(app.cpuLimit * 1e9) }),
      PidsLimit: 4096,
      CapDrop: ['ALL'],
      CapAdd: APP_CAPABILITIES,
      SecurityOpt: ['no-new-privileges:true'],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '5' } },
      Mounts: input.volumes.map((volume) => ({ Type: 'volume', Source: volume.dockerVolume, Target: volume.mountPath })),
      NetworkMode: network,
    },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [app.slug] } } },
  };
}

class Cancelled extends Error {
  override name = 'Cancelled';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Cancelled('Cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Cancelled('Cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Cancelled('Cancelled');
}

export class Deployer {
  private readonly ctx: Context;
  /** applicationId → running deployment. */
  private readonly running = new Map<string, { deploymentId: string; controller: AbortController }>();
  private stopped = false;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  // ------------------------------------------------------------------ queue

  isRunning(applicationId: string): boolean {
    return this.running.has(applicationId);
  }

  enqueue(input: EnqueueInput): DeploymentRecord {
    const { stores } = this.ctx;
    const { app } = input;
    if (app.sourceType !== 'image' && app.sourceType !== 'raw' && input.imageTag == null && cloneUrl(app).length === 0) {
      throw new AppError('nothing_to_deploy', 'Application has no source configured');
    }

    // Older queued deployments of this app are superseded: only the newest intent matters.
    for (const open of stores.deployments.listOpen()) {
      if (open.applicationId === app.id && open.status === 'queued') {
        stores.deployments.finish(open.id, 'cancelled', 'Superseded by a newer deployment', 'superseded');
        this.emitDeployment(open.id);
      }
    }

    const deployment = stores.deployments.create({
      application: app,
      trigger: input.trigger,
      createdBy: input.createdBy,
      commitSha: input.commitSha ?? null,
      commitMessage: input.commitMessage ?? null,
      commitAuthor: input.commitAuthor ?? null,
      imageTag: input.imageTag ?? null,
      sourceDeploymentId: input.sourceDeploymentId ?? null,
      options: input.clearCache === true ? { clearCache: true } : {},
    });
    if (!this.running.has(app.id)) this.setAppStatus(app.id, 'queued');
    this.emitDeployment(deployment.id);
    queueMicrotask(() => this.tick());
    return deployment;
  }

  /** Cancel a queued or running deployment. */
  cancel(deploymentId: string): boolean {
    const { stores } = this.ctx;
    const deployment = stores.deployments.get(deploymentId);
    if (deployment === undefined || isTerminalDeployment(deployment.status)) return false;
    const running = this.running.get(deployment.applicationId);
    if (running?.deploymentId === deploymentId) {
      running.controller.abort();
      return true;
    }
    stores.deployments.finish(deploymentId, 'cancelled', 'Cancelled before it started', 'cancelled');
    this.restoreAppStatus(deployment.applicationId);
    this.emitDeployment(deploymentId);
    return true;
  }

  /** Start queued deployments while capacity allows. */
  tick(): void {
    if (this.stopped) return;
    const capacity = this.ctx.stores.settings.platform().buildConcurrency;
    for (const deployment of this.ctx.stores.deployments.listOpen()) {
      if (this.running.size >= capacity) break;
      if (deployment.status !== 'queued' || this.running.has(deployment.applicationId)) continue;
      const controller = new AbortController();
      this.running.set(deployment.applicationId, { deploymentId: deployment.id, controller });
      void this.execute(deployment, controller).catch((error) => {
        this.ctx.logger.error('Deployment crashed unexpectedly', { deploymentId: deployment.id, error });
      });
    }
  }

  /**
   * Called once at boot: anything that was mid-flight when the process died
   * is marked failed (its containers are cleaned up by the reconciler), and
   * the queue resumes.
   */
  recover(): void {
    const { stores } = this.ctx;
    for (const deployment of stores.deployments.listOpen()) {
      if (deployment.status === 'queued') continue;
      stores.deployments.finish(deployment.id, 'failed', 'Interrupted: the control plane restarted during this deployment', 'interrupted');
      this.restoreAppStatus(deployment.applicationId);
    }
    this.tick();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const { controller } of this.running.values()) controller.abort();
    const deadline = Date.now() + 15_000;
    while (this.running.size > 0 && Date.now() < deadline) await sleep(100);
  }

  // --------------------------------------------------------------- helpers

  private setAppStatus(applicationId: string, status: ApplicationRecord['status']): void {
    const app = this.ctx.stores.applications.get(applicationId);
    if (app === undefined || app.status === status) return;
    this.ctx.stores.applications.setStatus(applicationId, status);
    emit(this.ctx, app.teamId, { type: 'application.updated', id: app.id, projectId: app.projectId, status });
  }

  /** After a deployment ends without succeeding: reflect what is actually serving. */
  private restoreAppStatus(applicationId: string): void {
    const app = this.ctx.stores.applications.get(applicationId);
    if (app === undefined) return;
    if (app.status === 'stopped') return;
    this.setAppStatus(applicationId, app.activeDeploymentId !== null ? 'running' : 'failed');
  }

  private emitDeployment(deploymentId: string): void {
    const deployment = this.ctx.stores.deployments.get(deploymentId);
    if (deployment === undefined) return;
    emit(this.ctx, deployment.teamId, {
      type: 'deployment.updated',
      id: deployment.id,
      applicationId: deployment.applicationId,
      projectId: deployment.projectId,
      status: deployment.status,
    });
  }

  /** Mirror the outcome onto the GitHub commit (check mark / cross next to the commit). */
  private reportCommitStatus(deploymentId: string): void {
    const deployment = this.ctx.stores.deployments.get(deploymentId);
    const app = deployment === undefined ? undefined : this.ctx.stores.applications.get(deployment.applicationId);
    if (deployment === undefined || app === undefined || deployment.commitSha === null || app.sourceType !== 'github' || app.githubInstallationId === null) return;
    if (deployment.trigger !== 'push' && deployment.trigger !== 'manual') return;
    const state = deployment.status === 'succeeded' ? 'success' : deployment.status === 'cancelled' ? 'error' : 'failure';
    void this.ctx.github.commitStatus(app, deployment.commitSha, state, deployment.id).catch(() => undefined);
  }

  private async containerTail(docker: DockerClient, name: string, lines = 40): Promise<string> {
    try {
      const stream = await docker.containerLogs(name, { follow: false, tail: lines });
      let text = '';
      for await (const chunk of stream as AsyncIterable<{ text: string }>) text += chunk.text;
      return text.trim();
    } catch {
      return '';
    }
  }

  private async removeContainers(docker: DockerClient, names: string[]): Promise<void> {
    await Promise.all(names.map((name) => docker.removeContainer(name, { force: true }).catch(() => undefined)));
  }

  private async stopAndRemove(docker: DockerClient, names: string[]): Promise<void> {
    await Promise.all(
      names.map(async (name) => {
        await docker.stopContainer(name, STOP_TIMEOUT_SEC).catch(() => undefined);
        await docker.removeContainer(name, { force: true }).catch(() => undefined);
      }),
    );
  }

  // -------------------------------------------------------------- pipeline

  private async execute(queued: DeploymentRecord, controller: AbortController): Promise<void> {
    const { stores, config, connections, proxy } = this.ctx;
    const signal = controller.signal;
    const log = await LogWriter.open(logPath(config.dataDir, 'deployments', queued.id), queued.id, this.ctx.bus);
    const workDir = buildWorkDir(config.dataDir, queued.id);
    const scratchDir = `${workDir}.ploy`;

    let app = stores.applications.get(queued.applicationId);
    let docker: DockerClient | null = null;
    let started: string[] = [];
    let switched = false;
    let stoppedPrevious = false;
    let builtImage: string | null = null;
    const previous = app?.activeDeploymentId == null ? undefined : stores.deployments.get(app.activeDeploymentId);

    try {
      if (app === undefined) throw new AppError('not_found', 'Application was deleted');
      stores.deployments.markStarted(queued.id);
      this.setAppStatus(app.id, 'building');
      this.emitDeployment(queued.id);

      const server = stores.servers.get(app.serverId);
      if (server === undefined || server.status !== 'ready') {
        throw new AppError('server_unreachable', `Server ${server?.name ?? app.serverId} is not ready${server?.statusMessage ? `: ${server.statusMessage}` : ''}`);
      }
      log.info(`Deployment ${queued.id} · ${queued.trigger} · ${app.name} on ${server.name}`);
      docker = await connections.docker(app.serverId);

      if (app.kind === 'compose') {
        const { containers } = await this.ctx.compose.deploy({ app, deployment: queued, docker, log, signal });
        throwIfAborted(signal);
        log.stage('switch', 'Routing traffic to the stack');
        stores.deployments.setContainers(queued.id, containers, null);
        stores.applications.setActiveDeployment(app.id, queued.id);
        try {
          await proxy.requestSync(app.serverId);
        } catch (error) {
          throw new AppError('proxy_error', `Could not update routing: ${errorMessage(error)}`);
        }
        stores.deployments.finish(queued.id, 'succeeded');
        this.setAppStatus(app.id, 'running');
        this.emitDeployment(queued.id);
        this.ctx.notifier.deploymentFinished(queued.id);
        log.info(`✓ Deployed in ${Math.round((Date.now() - Date.parse(stores.deployments.get(queued.id)!.startedAt!)) / 1000)}s`);
        return;
      }

      // ---------------------------------------------------------- image
      let image: string;
      let plan: BuildPlan | null = null;
      if (queued.imageTag !== null) {
        image = queued.imageTag;
        if ((await docker.inspectImage(image)) === null) {
          throw new AppError('nothing_to_deploy', `Image ${image} is no longer available on ${server.name}; deploy from source instead`);
        }
        log.stage('build', `Reusing image ${image} — no build needed`);
      } else if (app.sourceType === 'image') {
        // A private image pulls with the team's login for its registry, when one is stored.
        const registry = stores.registries.forImage(app.teamId, app.image!);
        log.stage('fetch', `Pulling ${app.image}${registry === undefined ? '' : ` (signed in to ${registry.serverAddress} as ${registry.username})`}`);
        if (registry !== undefined) log.mask([registry.password]);
        try {
          await docker.pullImage(app.image!, (line) => log.write(line, 'stdout'), registry === undefined ? undefined : registryAuthHeader(registry), signal);
        } catch (error) {
          if (signal.aborted) throw error;
          throw new AppError('bad_request', `Could not pull ${app.image}: ${errorMessage(error)}`, { params: { reason: 'pull_failed' } });
        }
        image = makeImageTag(app, queued.id);
        // Pin the exact pulled image so a later rollback is not affected by the tag moving upstream.
        await docker.tagImage(app.image!, imageRepository(app), idPart(queued.id));
        stores.deployments.setImage(queued.id, image, null);
        builtImage = image;
      } else {
        ({ image, plan } = await this.buildFromSource(app, queued, docker, log, workDir, scratchDir, signal));
        builtImage = image;
      }
      throwIfAborted(signal);
      app = stores.applications.get(app.id)!;

      // -------------------------------------------------------- prepare
      stores.deployments.setStatus(queued.id, 'deploying');
      this.setAppStatus(app.id, 'deploying');
      this.emitDeployment(queued.id);

      const resolved = resolveAppEnv(stores, app);
      log.mask(resolved.secrets);
      const userPort = resolved.env.PORT === undefined ? null : Number(resolved.env.PORT);
      const imageInfo = await docker.inspectImage(image);
      const exposed = Object.keys(imageInfo?.Config.ExposedPorts ?? {})
        .map((key) => Number(key.split('/')[0]))
        .find((port) => Number.isInteger(port) && port > 0);
      const port =
        app.kind === 'worker'
          ? null
          : (app.port ?? (userPort !== null && Number.isInteger(userPort) ? userPort : null) ?? plan?.defaultPort ?? exposed ?? DEFAULT_APP_PORT);
      const primaryDomain = stores.domains.listForApplication(app.id).find((domain) => !domain.isGenerated) ?? stores.domains.listForApplication(app.id)[0];
      const env = withPlatformEnv(resolved.env, {
        ...(port === null ? {} : { PORT: String(port) }),
        HOST: '0.0.0.0',
        PLOY_APP: app.slug,
        PLOY_DEPLOYMENT_ID: queued.id,
        ...(primaryDomain === undefined ? {} : { PLOY_PUBLIC_URL: `${primaryDomain.https ? 'https' : 'http'}://${primaryDomain.host}` }),
        ...(stores.deployments.get(queued.id)?.commitSha ? { PLOY_GIT_COMMIT_SHA: stores.deployments.get(queued.id)!.commitSha! } : {}),
      });

      const network = projectNetwork(app.projectId);
      await docker.ensureNetwork(network, { [LABEL_MANAGED]: 'true', [LABEL_PROJECT]: app.projectId });
      // The proxy must sit on the project network before it can health-check or route.
      if ((await docker.inspectContainer('ploy-proxy')) === null) await proxy.ensureProxy(app.serverId);
      await docker.connectNetwork(network, 'ploy-proxy');
      const volumes = stores.volumes.listForApplication(app.id);
      for (const volume of volumes) await docker.ensureVolume(volume.dockerVolume, { [LABEL_MANAGED]: 'true', [LABEL_APP]: app.id });
      if (volumes.length > 0 && app.replicas > 1) log.info('Note: replicas share the same volumes; make sure the app supports concurrent access');

      // Recreate strategy: the old version stops first (brief downtime, exclusive volume access).
      if (app.strategy === 'recreate' && previous !== undefined && previous.containers.length > 0) {
        log.info(`Stopping ${previous.containers.length} running container(s) first (recreate strategy)`);
        await Promise.all(previous.containers.map((name) => docker!.stopContainer(name, STOP_TIMEOUT_SEC)));
        stoppedPrevious = true;
      }

      // ---------------------------------------------------------- start
      const command = app.startCommand !== null && (plan === null || plan.mode === 'dockerfile') ? app.startCommand : null;
      log.stage('start', `Starting ${app.replicas} replica(s)${port === null ? '' : ` on port ${port}`}`);
      for (let replica = 0; replica < app.replicas; replica += 1) {
        throwIfAborted(signal);
        const name = appContainer(app, queued.id, replica);
        await docker.removeContainer(name, { force: true }); // leftover from an interrupted attempt
        await docker.createContainer(name, appContainerSpec({ app, deploymentId: queued.id, replica, image, env, port, volumes, command }));
        started.push(name);
        await docker.startContainer(name);
      }
      stores.deployments.setContainers(queued.id, started, port);

      // --------------------------------------------------------- health
      await this.waitHealthy(app, docker, started, port, log, signal);
      throwIfAborted(signal);

      // --------------------------------------------------------- switch
      log.stage('switch', 'Switching traffic to the new deployment');
      stores.applications.setActiveDeployment(app.id, queued.id);
      switched = true;
      try {
        await proxy.requestSync(app.serverId);
      } catch (error) {
        throw new AppError('proxy_error', `Could not switch traffic: ${errorMessage(error)}`);
      }
      if (stores.domains.listForApplication(app.id).length > 0) log.info('✓ Traffic switched to the new deployment');
      stores.deployments.finish(queued.id, 'succeeded');
      this.setAppStatus(app.id, 'running');
      this.emitDeployment(queued.id);
      this.ctx.notifier.deploymentFinished(queued.id);
      // A preview announces its address on the pull request; that never affects the deployment.
      if (app.parentApplicationId !== null) void this.ctx.previews.commentDeployed(app.id, queued.id).catch(() => undefined);

      // ---------------------------------------------------------- drain
      if (previous !== undefined && previous.containers.length > 0) {
        log.stage('drain', 'Retiring the previous deployment');
        if (!stoppedPrevious && config.drainMs > 0) {
          log.info(`Draining the previous deployment for ${Math.round(config.drainMs / 1000)}s`);
          await sleep(config.drainMs);
        }
        await this.stopAndRemove(docker, previous.containers);
        log.info('Previous deployment stopped');
      }
      log.info(`✓ Deployed in ${Math.round((Date.now() - Date.parse(stores.deployments.get(queued.id)!.startedAt!)) / 1000)}s`);
      await this.afterSuccess(app, docker).catch((error) => log.error(`Cleanup warning: ${errorMessage(error)}`));
    } catch (error) {
      const cancelled = error instanceof Cancelled || signal.aborted;
      const message = cancelled ? 'Cancelled' : errorMessage(error);
      log.error(cancelled ? '✗ Deployment cancelled' : `✗ ${message}`);

      if (docker !== null && app !== undefined) {
        if (switched) {
          // The route may already point at the new containers; put the previous deployment back first.
          stores.applications.setActiveDeployment(app.id, previous?.id ?? null);
          await proxy.requestSync(app.serverId).catch(() => undefined);
        }
        await this.removeContainers(docker, started);
        if (stoppedPrevious && previous !== undefined) {
          log.info('Restarting the previous deployment');
          await Promise.all(previous.containers.map((name) => docker!.startContainer(name).catch(() => undefined)));
        }
        if (builtImage !== null) {
          await docker.removeImage(builtImage).catch(() => undefined);
          stores.deployments.markImageRemoved(queued.id);
        }
      }
      const current = stores.deployments.get(queued.id);
      if (current !== undefined && !isTerminalDeployment(current.status)) {
        stores.deployments.finish(queued.id, cancelled ? 'cancelled' : 'failed', message, cancelled ? 'cancelled' : reasonOf(error));
      }
      if (app !== undefined) this.restoreAppStatus(app.id);
      this.emitDeployment(queued.id);
      if (!cancelled) this.ctx.notifier.deploymentFinished(queued.id);
    } finally {
      this.reportCommitStatus(queued.id);
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
      await log.close();
      this.running.delete(queued.applicationId);
      this.tick();
    }
  }

  private async buildFromSource(
    app: ApplicationRecord,
    deployment: DeploymentRecord,
    docker: DockerClient,
    log: LogWriter,
    workDir: string,
    scratchDir: string,
    signal: AbortSignal,
  ): Promise<{ image: string; plan: BuildPlan }> {
    const { stores, config, secrets } = this.ctx;
    const branch = app.branch ?? 'main';
    const url = cloneUrl(app);
    log.stage('fetch', `Cloning ${app.repository ?? url} (${branch}${deployment.commitSha ? ` @ ${deployment.commitSha.slice(0, 7)}` : ''})`);

    const githubToken = app.sourceType === 'github' && app.githubInstallationId !== null
      ? await this.ctx.github.installationToken(app.githubInstallationId)
      : null;
    if (githubToken !== null) log.mask([githubToken]);
    await mkdir(workDir, { recursive: true });
    const commit = await checkout({
      url,
      branch,
      commitSha: deployment.commitSha,
      workDir,
      githubToken,
      deployKey: app.deployKey === null ? null : secrets.open(app.deployKey, 'ssh'),
      timeoutMs: 5 * 60_000,
      signal,
      onOutput: (line) => log.write(line, 'stdout'),
    });
    stores.deployments.setCommit(deployment.id, { ...commit, branch });
    this.emitDeployment(deployment.id);
    log.info(`Commit ${commit.sha.slice(0, 7)} — ${commit.message} (${commit.author})`);
    if (app.sourceType === 'github' && app.githubInstallationId !== null) {
      void this.ctx.github.commitStatus(app, commit.sha, 'pending', deployment.id).catch(() => undefined);
    }

    const contextDir = app.rootDirectory.length > 0 ? join(workDir, app.rootDirectory) : workDir;
    const plan = await planBuild({
      contextDir,
      buildType: app.buildType,
      dockerfilePath: app.dockerfilePath,
      installCommand: app.installCommand,
      buildCommand: app.buildCommand,
      startCommand: app.startCommand,
      outputDirectory: app.outputDirectory,
      kind: app.kind === 'worker' ? 'worker' : 'web',
    });
    log.stage('build', `Build plan: ${plan.label}`);
    if (plan.dockerfile !== null) {
      log.info('Generated Dockerfile:');
      for (const line of plan.dockerfile.split('\n')) log.write(`  ${line}`, 'stdout');
    }

    const image = makeImageTag(app, deployment.id);
    const resolved = resolveAppEnv(stores, app);
    log.mask(resolved.secrets);
    // `FROM` may name private images: the build signs in to the team's registries.
    const registries = stores.registries.listForTeam(app.teamId);
    log.mask(registries.map((registry) => registry.password));
    log.info(`Building ${image}${deployment.options.clearCache === true ? ' (without cache)' : ''}`);
    stores.deployments.setStatus(deployment.id, 'building');
    const { durationMs } = await buildImage({
      dockerHost: docker.dockerHost,
      plan,
      contextDir,
      scratchDir,
      imageTag: image,
      applicationId: app.id,
      deploymentId: deployment.id,
      buildEnv: resolved.env,
      registryAuths: cliAuths(registries),
      noCache: deployment.options.clearCache === true,
      timeoutMs: config.buildTimeoutMs,
      signal,
      onOutput: (line) => log.write(line, 'stdout'),
    });
    stores.deployments.setImage(deployment.id, image, durationMs);
    log.info(`✓ Built in ${(durationMs / 1000).toFixed(1)}s`);
    return { image, plan };
  }

  private async waitHealthy(
    app: ApplicationRecord,
    docker: DockerClient,
    containers: string[],
    port: number | null,
    log: LogWriter,
    signal: AbortSignal,
  ): Promise<void> {
    const crashCheck = async (name: string): Promise<void> => {
      const inspect = await docker.inspectContainer(name);
      if (inspect === null) throw new AppError('bad_request', `Container ${name} disappeared`);
      if (!inspect.State.Running || inspect.RestartCount > 0 || inspect.State.Restarting) {
        const tail = await this.containerTail(docker, name);
        if (tail.length > 0) {
          log.error('Application output:');
          for (const line of tail.split('\n')) log.write(`  ${line}`, 'stderr');
        }
        const reason = inspect.State.OOMKilled
          ? `ran out of memory${app.memoryLimitMb === null ? '' : ` (limit ${app.memoryLimitMb} MB)`}`
          : `exited with code ${inspect.State.ExitCode}`;
        throw new AppError('bad_request', `The application ${reason} during startup`, { params: { reason: inspect.State.OOMKilled ? 'oom' : 'crash' } });
      }
    };

    if (app.kind === 'worker' || port === null) {
      log.stage('health', `Waiting ${WORKER_STABILITY_MS / 1000}s to confirm the worker stays up`);
      await sleep(WORKER_STABILITY_MS, signal);
      for (const name of containers) await crashCheck(name);
      log.info('✓ Worker is running');
      return;
    }

    const path = app.healthCheckPath;
    log.stage('health', path === null ? `Waiting for the app to accept connections on port ${port}` : `Health check: GET ${path} on port ${port}`);
    const deadline = Date.now() + app.healthCheckTimeoutSec * 1000;
    const pending = new Set(containers);
    let attempt = 0;
    let lastDetail = '';
    while (pending.size > 0) {
      throwIfAborted(signal);
      for (const name of [...pending]) {
        await crashCheck(name);
        const result = await this.ctx.proxy.probe(app.serverId, `${name}:${port}`, path);
        if (result.healthy) {
          pending.delete(name);
          log.info(`✓ ${name} is healthy (${result.detail})`);
        } else {
          lastDetail = result.detail;
        }
      }
      if (pending.size === 0) break;
      if (Date.now() > deadline) {
        const name = [...pending][0]!;
        const tail = await this.containerTail(docker, name);
        if (tail.length > 0) {
          log.error('Application output:');
          for (const line of tail.split('\n')) log.write(`  ${line}`, 'stderr');
        }
        throw new AppError('bad_request', `Health check timed out after ${app.healthCheckTimeoutSec}s (${lastDetail}). Is the app listening on 0.0.0.0:${port}?`, {
          params: { reason: 'health_timeout' },
        });
      }
      if (attempt % 5 === 4) log.info(`  still waiting… (${lastDetail})`);
      attempt += 1;
      await sleep(PROBE_INTERVAL_MS, signal);
    }
  }

  /** Image retention and history pruning after a successful deployment. */
  private async afterSuccess(app: ApplicationRecord, docker: DockerClient): Promise<void> {
    const { stores, config } = this.ctx;
    const keep = stores.settings.platform().imageRetention;
    const current = stores.applications.get(app.id);
    let kept = 0;
    for (const deployment of stores.deployments.listWithImages(app.id)) {
      if (deployment.id === current?.activeDeploymentId || kept < keep) {
        kept += 1;
        continue;
      }
      if (deployment.imageTag !== null && deployment.imageTag.startsWith(`${imageRepository(app)}:`)) {
        await docker.removeImage(deployment.imageTag).catch(() => false);
      }
      stores.deployments.markImageRemoved(deployment.id);
    }
    const pruned = stores.deployments.pruneHistory(app.id, HISTORY_LIMIT, current?.activeDeploymentId ? [current.activeDeploymentId] : []);
    for (const id of pruned) await removeLog(logPath(config.dataDir, 'deployments', id));
  }

  // ------------------------------------------------------- app operations

  /** Stop serving: containers are stopped (kept for a fast start) and the proxy shows the unavailable page. */
  async stop(app: ApplicationRecord): Promise<void> {
    if (this.running.has(app.id)) throw new AppError('deployment_in_progress', 'A deployment is in progress');
    if (app.kind === 'compose') {
      this.setAppStatus(app.id, 'stopped');
      await this.ctx.proxy.requestSync(app.serverId).catch(() => undefined);
      await this.ctx.compose.stop(app);
      return;
    }
    const docker = await this.ctx.connections.docker(app.serverId);
    const active = app.activeDeploymentId === null ? undefined : this.ctx.stores.deployments.get(app.activeDeploymentId);
    this.setAppStatus(app.id, 'stopped');
    await this.ctx.proxy.requestSync(app.serverId).catch(() => undefined);
    if (active !== undefined) await Promise.all(active.containers.map((name) => docker.stopContainer(name, STOP_TIMEOUT_SEC)));
  }

  /** Start a stopped application from its active deployment, or redeploy it if its containers are gone. */
  async start(app: ApplicationRecord, userId: string | null): Promise<DeploymentRecord | null> {
    if (this.running.has(app.id)) throw new AppError('deployment_in_progress', 'A deployment is in progress');
    if (app.kind === 'compose') {
      if (!(await this.ctx.compose.start(app))) return this.enqueue({ app, trigger: 'manual', createdBy: userId });
      this.setAppStatus(app.id, 'running');
      await this.ctx.proxy.requestSync(app.serverId);
      return null;
    }
    const active = app.activeDeploymentId === null ? undefined : this.ctx.stores.deployments.get(app.activeDeploymentId);
    if (active === undefined || active.imageTag === null) {
      return this.enqueue({ app, trigger: 'manual', createdBy: userId });
    }
    const docker = await this.ctx.connections.docker(app.serverId);
    const missing = (await Promise.all(active.containers.map((name) => docker.inspectContainer(name)))).some((inspect) => inspect === null);
    if (missing) return this.enqueue({ app, trigger: 'restart', createdBy: userId, imageTag: active.imageTag, sourceDeploymentId: active.id });
    await Promise.all(active.containers.map((name) => docker.startContainer(name)));
    this.setAppStatus(app.id, 'running');
    await this.ctx.proxy.requestSync(app.serverId);
    return null;
  }

  /** Zero-downtime restart: a fresh deployment of the active image. */
  restart(app: ApplicationRecord, userId: string | null): DeploymentRecord {
    const active = app.activeDeploymentId === null ? undefined : this.ctx.stores.deployments.get(app.activeDeploymentId);
    if (active === undefined || active.imageTag === null || active.imageRemoved) {
      throw new AppError('nothing_to_deploy', 'The application has no running deployment to restart');
    }
    return this.enqueue({ app, trigger: 'restart', createdBy: userId, imageTag: active.imageTag, sourceDeploymentId: active.id });
  }

  /** Redeploy (or roll back to) the image of a previous deployment. */
  redeploy(app: ApplicationRecord, source: DeploymentRecord, userId: string | null): DeploymentRecord {
    if (source.imageTag === null || source.imageRemoved || source.status !== 'succeeded') {
      throw new AppError('nothing_to_deploy', 'That deployment has no image to redeploy');
    }
    const trigger = source.id === app.activeDeploymentId ? 'redeploy' : 'rollback';
    return this.enqueue({
      app,
      trigger,
      createdBy: userId,
      imageTag: source.imageTag,
      sourceDeploymentId: source.id,
      commitSha: source.commitSha,
      commitMessage: source.commitMessage,
      commitAuthor: source.commitAuthor,
    });
  }

  /** Remove every runtime trace of an application. Database rows are deleted by the caller. */
  async destroy(app: ApplicationRecord, removeVolumes: boolean): Promise<void> {
    const running = this.running.get(app.id);
    running?.controller.abort();
    for (const open of this.ctx.stores.deployments.listOpen()) {
      if (open.applicationId === app.id && open.status === 'queued') this.ctx.stores.deployments.finish(open.id, 'cancelled', 'Application deleted', 'cancelled');
    }
    if (app.kind === 'compose') {
      await this.ctx.compose.destroy(app, removeVolumes);
      return;
    }
    try {
      const docker = await this.ctx.connections.docker(app.serverId);
      const containers = await docker.listContainers({ label: [`${LABEL_APP}=${app.id}`] });
      await this.removeContainers(docker, containers.map((container) => container.Id));
      for (const image of await docker.listImages(`${LABEL_APP}=${app.id}`)) {
        for (const tag of image.RepoTags ?? []) await docker.removeImage(tag).catch(() => false);
      }
      for (const tag of this.ctx.stores.deployments.listWithImages(app.id).map((deployment) => deployment.imageTag)) {
        if (tag !== null && tag.startsWith(`${imageRepository(app)}:`)) await docker.removeImage(tag).catch(() => false);
      }
      if (removeVolumes) {
        for (const volume of this.ctx.stores.volumes.listForApplication(app.id)) await docker.removeVolume(volume.dockerVolume).catch(() => undefined);
      }
    } catch (error) {
      // The server may be gone; the database cleanup must still happen.
      this.ctx.logger.warn('Could not clean up application containers', { applicationId: app.id, error: errorMessage(error) });
    }
  }

  /**
   * Delete an application for good: its pull request previews first (each
   * through this same path — the database cascade alone would leave their
   * containers running), then its containers, images, rows, logs and metrics.
   */
  async remove(app: ApplicationRecord, removeVolumes: boolean): Promise<void> {
    const { stores, config } = this.ctx;
    for (const preview of stores.applications.listPreviews(app.id)) await this.remove(preview, true);
    await this.destroy(app, removeVolumes);
    const deploymentIds = stores.db.all('SELECT id FROM deployments WHERE application_id = ?', app.id).map((row) => String(row.id));
    const runIds = stores.db
      .all('SELECT r.id FROM cron_runs r JOIN cron_jobs j ON j.id = r.cron_job_id WHERE j.application_id = ?', app.id)
      .map((row) => String(row.id));
    stores.applications.delete(app.id);
    stores.metrics.deleteOwner(app.id);
    for (const id of deploymentIds) await removeLog(logPath(config.dataDir, 'deployments', id));
    for (const id of runIds) await removeLog(logPath(config.dataDir, 'cron', id));
    await this.ctx.proxy.requestSync(app.serverId).catch(() => undefined);
    emit(this.ctx, app.teamId, { type: 'application.deleted', id: app.id, projectId: app.projectId });
  }

  /** Name prefix of every container of an application (used by the reconciler). */
  static prefix(app: ApplicationRecord): string {
    return appPrefix(app);
  }
}
