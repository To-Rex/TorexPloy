/**
 * Running Docker Compose applications.
 *
 * Layout per app under the data directory:
 *   compose/<app>/code   the repository checkout or the stored file — replaced on every deploy
 *   compose/<app>/files  persistent: bind-mount `../files/...` for data that must survive deploys
 *
 * `docker compose up` does the work (builds, creates, recreates only what
 * changed, removes orphans); the CLI talks to the server's Docker through
 * DOCKER_HOST, so SSH servers work through the same tunnel as everything
 * else. App variables reach the CLI as its environment, which is exactly what
 * `${NAME}` interpolation in a compose file reads — no env file is written.
 *
 * Lifecycle operations afterwards (stop, start, restart, delete) go through
 * the Engine API by compose's own labels and need no files.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { Context } from '../context.ts';
import { buildWorkDir, checkout, cloneUrl } from '../build/git.ts';
import { prepareCliConfig } from '../docker/cli.ts';
import type { ContainerSummary, DockerClient } from '../docker/client.ts';
import { cliAuths, type CliAuths } from '../docker/registry.ts';
import { idPart, LABEL_APP, LABEL_MANAGED, LABEL_PROJECT, LABEL_ROLE, LABEL_TEAM, projectNetwork } from '../docker/naming.ts';
import { resolveAppEnv } from '../deploy/env.ts';
import type { LogWriter } from '../deploy/logs.ts';
import { AppError, errorMessage } from '../lib/errors.ts';
import { runProcess } from '../lib/process.ts';
import { createTar, type TarEntry } from '../lib/tar.ts';
import type { ApplicationRecord, DeploymentRecord } from '../store/index.ts';
import { transformCompose, type ComposeServiceInfo } from './transform.ts';

export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
export const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const TRANSFORMED_FILE = '.torexploy-compose.yml';
const RAW_FILE = 'docker-compose.yml';
const POLL_MS = 2_000;
/** Everything must look healthy for this long before the deploy counts as done. */
const STABLE_MS = 6_000;
/** Upper bound for syncing a project directory to an SSH server (bind mounts need the files there). */
const SYNC_LIMIT_BYTES = 50 * 1024 * 1024;

export function composeProject(app: { id: string; slug: string }): string {
  return `ploy-${app.slug.slice(0, 30).replace(/-+$/, '')}-${idPart(app.id, 6)}`;
}

export interface ComposeDeployInput {
  app: ApplicationRecord;
  deployment: DeploymentRecord;
  docker: DockerClient;
  log: LogWriter;
  signal: AbortSignal;
}

export interface ComposeContainer {
  name: string;
  service: string;
  state: string;
  health: string | null;
  exitCode: number | null;
  restartCount: number;
  startedAt: string | null;
}

export class ComposeEngine {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  appDir(app: { id: string }): string {
    return join(this.ctx.config.dataDir, 'compose', app.id);
  }

  private cliEnv(docker: DockerClient, configDir: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...extra,
      DOCKER_HOST: docker.dockerHost,
      DOCKER_CLI_HINTS: 'false',
      // The CLI must not pick up an operator's personal contexts or config.
      DOCKER_CONFIG: configDir,
      COMPOSE_ANSI: 'never',
      COMPOSE_PROGRESS: 'plain',
      BUILDKIT_PROGRESS: 'plain',
    };
  }

  /** Run `docker compose`, streaming its output into the deployment log. */
  private async compose(
    args: string[],
    options: { docker: DockerClient; env: Record<string, string>; cwd: string; log: LogWriter; signal: AbortSignal; timeoutMs: number; cli: { dir: string; auths: CliAuths } },
  ): Promise<void> {
    // The config carries the team's registry logins: it belongs to this run alone and is removed right after it.
    await prepareCliConfig(options.cli.dir, options.cli.auths);
    let pending = '';
    const result = await runProcess('docker', ['compose', ...args], {
      cwd: options.cwd,
      env: this.cliEnv(options.docker, options.cli.dir, options.env),
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      maxBuffer: 256 * 1024,
      onOutput: (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) if (line.trim().length > 0) options.log.write(line.trimEnd(), 'stdout');
      },
    })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') throw new AppError('docker_unavailable', 'The docker CLI is not installed on the control plane');
        throw error;
      })
      .finally(() => rm(options.cli.dir, { recursive: true, force: true }));
    if (pending.trim().length > 0) options.log.write(pending.trimEnd(), 'stdout');
    if (result.aborted) throw new AppError('bad_request', 'Cancelled');
    if (result.timedOut) throw new AppError('bad_request', `docker compose took longer than ${Math.round(options.timeoutMs / 60_000)} minutes`, { params: { reason: 'build_timeout' } });
    if (result.code !== 0) {
      if (/'compose' is not a docker command|unknown command: docker compose/i.test(result.stderr)) {
        throw new AppError('docker_unavailable', 'The docker compose plugin is not installed on the control plane', { params: { reason: 'compose_missing_plugin' } });
      }
      const tail = result.stderr.trim().split('\n').filter((line) => line.trim().length > 0).slice(-3).join(' ').slice(0, 600);
      throw new AppError('bad_request', `docker compose failed${tail.length > 0 ? `: ${tail}` : ''}`, { params: { reason: 'compose_failed' } });
    }
  }

  /** Fetch the source, rewrite the file, bring the stack up and wait for it. Returns the running container names. */
  async deploy(input: ComposeDeployInput): Promise<{ containers: string[]; services: ComposeServiceInfo[] }> {
    const { app, deployment, docker, log, signal } = input;
    const { stores, secrets, config, proxy } = this.ctx;
    const root = this.appDir(app);
    const codeDir = join(root, 'code');
    await mkdir(join(root, 'files'), { recursive: true });
    await rm(codeDir, { recursive: true, force: true });
    await mkdir(codeDir, { recursive: true });

    // ---------------------------------------------------------- source
    let composePath = app.composePath;
    if (app.sourceType === 'raw') {
      log.stage('fetch', 'Using the compose file stored in the panel');
      composePath = RAW_FILE;
      await writeFile(join(codeDir, RAW_FILE), app.composeFile ?? '', { mode: 0o600 });
    } else {
      const branch = app.branch ?? 'main';
      log.stage('fetch', `Cloning ${app.repository ?? cloneUrl(app)} (${branch}${deployment.commitSha ? ` @ ${deployment.commitSha.slice(0, 7)}` : ''})`);
      const githubToken = app.sourceType === 'github' && app.githubInstallationId !== null ? await this.ctx.github.installationToken(app.githubInstallationId) : null;
      if (githubToken !== null) log.mask([githubToken]);
      const commit = await checkout({
        url: cloneUrl(app),
        branch,
        commitSha: deployment.commitSha,
        workDir: codeDir,
        githubToken,
        deployKey: app.deployKey === null ? null : secrets.open(app.deployKey, 'ssh'),
        timeoutMs: 5 * 60_000,
        signal,
        onOutput: (line) => log.write(line, 'stdout'),
      });
      stores.deployments.setCommit(deployment.id, { ...commit, branch });
      log.info(`Commit ${commit.sha.slice(0, 7)} — ${commit.message} (${commit.author})`);
      if (app.sourceType === 'github' && app.githubInstallationId !== null) void this.ctx.github.commitStatus(app, commit.sha, 'pending', deployment.id).catch(() => undefined);
    }

    const sourcePath = join(codeDir, composePath);
    if (relative(codeDir, sourcePath).startsWith('..')) throw new AppError('validation_failed', 'The compose path must stay inside the repository');
    const source = await readFile(sourcePath, 'utf8').catch(() => null);
    if (source === null) throw new AppError('bad_request', `Compose file ${composePath} was not found in the repository`, { params: { reason: 'compose_missing' } });

    // --------------------------------------------------------- prepare
    const network = projectNetwork(app.projectId);
    const result = transformCompose({
      source,
      projectNetwork: network,
      aliasPrefix: app.slug,
      labels: { [LABEL_MANAGED]: 'true', [LABEL_ROLE]: 'compose', [LABEL_APP]: app.id, [LABEL_PROJECT]: app.projectId, [LABEL_TEAM]: app.teamId },
    });
    const fresh = stores.applications.get(app.id) ?? app;
    if (result.hostAccess.length > 0 && !fresh.hostAccess) {
      throw new AppError('forbidden', `This compose file reaches the host (${result.hostAccess.join('; ')}). An administrator must allow host access in the app settings.`, {
        params: { reason: 'compose_host_access' },
      });
    }
    log.info(`Services: ${result.services.map((service) => `${service.name} (${service.alias})`).join(', ')}`);
    for (const service of result.services) if (service.publishedPorts.length > 0) log.info(`Note: ${service.name} publishes host port(s) ${service.publishedPorts.join(', ')} directly, bypassing the proxy`);

    const projectDir = dirname(sourcePath);
    const file = join(projectDir, TRANSFORMED_FILE);
    await writeFile(file, result.yaml, { mode: 0o600 });

    await docker.ensureNetwork(network, { [LABEL_MANAGED]: 'true', [LABEL_PROJECT]: app.projectId });
    if ((await docker.inspectContainer('ploy-proxy')) === null) await proxy.ensureProxy(app.serverId);
    await docker.connectNetwork(network, 'ploy-proxy');

    const server = stores.servers.get(app.serverId);
    if (server?.kind === 'ssh' && result.relativeBinds) await this.syncToServer(app, root, log);

    const resolved = resolveAppEnv(stores, fresh);
    log.mask(resolved.secrets);
    const primary = stores.domains.listForApplication(app.id).find((domain) => !domain.isGenerated && domain.redirectTo === null) ?? stores.domains.listForApplication(app.id)[0];
    const env = {
      ...resolved.env,
      PLOY_APP: app.slug,
      PLOY_DEPLOYMENT_ID: deployment.id,
      ...(primary === undefined ? {} : { PLOY_PUBLIC_URL: `${primary.https ? 'https' : 'http'}://${primary.host}` }),
    };
    const project = composeProject(app);
    const common = ['--project-name', project, '--project-directory', projectDir, '--file', file];
    const timeoutMs = config.buildTimeoutMs;
    // Private images pull with the team's registry logins, from a CLI config inside the deployment's own scratch directory.
    const registries = stores.registries.listForTeam(app.teamId);
    log.mask(registries.map((registry) => registry.password));
    const cli = { dir: join(`${buildWorkDir(config.dataDir, deployment.id)}.ploy`, 'docker-config'), auths: cliAuths(registries) };

    // -------------------------------------------------------- build/up
    stores.deployments.setStatus(deployment.id, 'building');
    if (deployment.options.clearCache === true) {
      log.stage('build', 'Building images without cache');
      await this.compose([...common, 'build', '--no-cache', '--pull'], { docker, env, cwd: projectDir, log, signal, timeoutMs, cli });
    }
    log.stage('start', `docker compose up (${project})`);
    stores.deployments.setStatus(deployment.id, 'deploying');
    await this.compose([...common, 'up', '--detach', '--build', '--remove-orphans'], { docker, env, cwd: projectDir, log, signal, timeoutMs, cli });

    // ---------------------------------------------------------- health
    log.stage('health', `Waiting for ${result.services.length} service(s) to settle`);
    const containers = await this.waitSettled(app, docker, result.services.map((service) => service.name), log, signal);
    return { containers, services: result.services };
  }

  /** Poll until every service runs (healthy when it has a check) or exited 0 as a one-shot job, steadily. */
  private async waitSettled(app: ApplicationRecord, docker: DockerClient, services: string[], log: LogWriter, signal: AbortSignal): Promise<string[]> {
    const deadline = Date.now() + Math.max(30, app.healthCheckTimeoutSec) * 1000;
    let stableSince: number | null = null;
    let lastProblem = '';
    while (Date.now() < deadline) {
      if (signal.aborted) throw new AppError('bad_request', 'Cancelled');
      const current = await this.containers(app, docker);
      const problems: string[] = [];
      for (const service of services) {
        const mine = current.filter((container) => container.service === service);
        if (mine.length === 0) {
          problems.push(`${service}: no container yet`);
          continue;
        }
        for (const container of mine) {
          if (container.state === 'exited' && container.exitCode === 0) continue; // a completed one-shot job (migrations)
          if (container.state === 'exited' || container.state === 'dead') {
            const tail = await this.tail(docker, container.name);
            throw new AppError('bad_request', `Service ${service} exited with code ${container.exitCode ?? '?'}${tail.length > 0 ? `: ${tail}` : ''}`, { params: { reason: 'crash' } });
          }
          if (container.state === 'restarting' || container.restartCount > 0) problems.push(`${service}: restarting`);
          else if (container.state !== 'running') problems.push(`${service}: ${container.state}`);
          else if (container.health === 'starting') problems.push(`${service}: health check starting`);
          else if (container.health === 'unhealthy') problems.push(`${service}: unhealthy`);
        }
      }
      if (problems.length === 0) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= STABLE_MS) {
          for (const container of current) log.info(`✓ ${container.service}: ${container.state}${container.health === null ? '' : ` (${container.health})`}`);
          return current.filter((container) => container.state === 'running').map((container) => container.name);
        }
      } else {
        stableSince = null;
        const summary = problems.join(', ');
        if (summary !== lastProblem) log.info(`Waiting: ${summary}`);
        lastProblem = summary;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    throw new AppError('bad_request', `The stack did not settle within ${app.healthCheckTimeoutSec}s (${lastProblem})`, { params: { reason: 'health_timeout' } });
  }

  private async tail(docker: DockerClient, name: string): Promise<string> {
    try {
      const stream = await docker.containerLogs(name, { follow: false, tail: 15 });
      let text = '';
      for await (const chunk of stream as AsyncIterable<{ text: string }>) text += chunk.text;
      return text.trim().split('\n').slice(-5).join(' | ').slice(0, 500);
    } catch {
      return '';
    }
  }

  /** Copy the project directory to an SSH server at the same path, so relative bind mounts resolve there. */
  private async syncToServer(app: ApplicationRecord, root: string, log: LogWriter): Promise<void> {
    const entries: TarEntry[] = [];
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) {
          const info = await stat(path);
          total += info.size;
          if (total > SYNC_LIMIT_BYTES) throw new AppError('bad_request', `The project is larger than ${SYNC_LIMIT_BYTES / 1024 / 1024} MB; use named volumes instead of relative bind mounts on remote servers`);
          entries.push({ name: relative(root, path), content: await readFile(path), mode: info.mode & 0o777 });
        }
      }
    };
    await walk(join(root, 'code'));
    log.info(`Copying ${entries.length} file(s) to the server for bind mounts`);
    const quoted = `'${root.replace(/'/g, `'\\''`)}'`;
    const archive = createTar(entries).toString('base64');
    const upload = await this.ctx.connections.shellWithInput(app.serverId, `mkdir -p ${quoted}/files && rm -rf ${quoted}/code && mkdir -p ${quoted} && base64 -d | tar -x -C ${quoted}`, archive, 300_000);
    if (upload !== null && upload.code !== 0) throw new AppError('server_unreachable', `Could not copy files to the server: ${upload.stderr.trim().slice(0, 300)}`);
  }

  // -------------------------------------------------------------- runtime

  async containers(app: ApplicationRecord, docker?: DockerClient): Promise<ComposeContainer[]> {
    const client = docker ?? (await this.ctx.connections.docker(app.serverId));
    const list = await client.listContainers({ label: [`${COMPOSE_PROJECT_LABEL}=${composeProject(app)}`] });
    const out: ComposeContainer[] = [];
    for (const container of list.sort((a, b) => (a.Names[0] ?? '').localeCompare(b.Names[0] ?? ''))) {
      const inspect = await client.inspectContainer(container.Id);
      if (inspect === null) continue;
      out.push({
        name: inspect.Name.replace(/^\//, ''),
        service: container.Labels[COMPOSE_SERVICE_LABEL] ?? '',
        state: inspect.State.Status,
        health: inspect.State.Health?.Status ?? null,
        exitCode: inspect.State.Running ? null : inspect.State.ExitCode,
        restartCount: inspect.RestartCount,
        startedAt: inspect.State.Running && !inspect.State.StartedAt.startsWith('0001') ? inspect.State.StartedAt : null,
      });
    }
    return out;
  }

  private async summaries(app: ApplicationRecord): Promise<{ docker: DockerClient; list: ContainerSummary[] }> {
    const docker = await this.ctx.connections.docker(app.serverId);
    return { docker, list: await docker.listContainers({ label: [`${COMPOSE_PROJECT_LABEL}=${composeProject(app)}`] }) };
  }

  async stop(app: ApplicationRecord): Promise<void> {
    const { docker, list } = await this.summaries(app);
    await Promise.all(list.map((container) => docker.stopContainer(container.Id, 30)));
  }

  /** Start the stack's existing containers; false when there are none (it must be deployed). */
  async start(app: ApplicationRecord): Promise<boolean> {
    const { docker, list } = await this.summaries(app);
    if (list.length === 0) return false;
    await Promise.all(list.map((container) => docker.startContainer(container.Id)));
    return true;
  }

  async restart(app: ApplicationRecord): Promise<void> {
    const { docker, list } = await this.summaries(app);
    if (list.length === 0) throw new AppError('nothing_to_deploy', 'The stack has no containers; deploy it first');
    await Promise.all(list.map((container) => docker.restartContainer(container.Id, 30)));
  }

  /** Remove the stack's containers, networks and images; its volumes and files too when asked. */
  async destroy(app: ApplicationRecord, removeData: boolean): Promise<void> {
    const project = composeProject(app);
    const filter = `${COMPOSE_PROJECT_LABEL}=${project}`;
    try {
      const { docker, list } = await this.summaries(app);
      await Promise.all(list.map((container) => docker.removeContainer(container.Id, { force: true })));
      for (const network of await docker.listNetworks(filter)) await docker.removeNetwork(network.Name).catch(() => undefined);
      for (const image of await docker.listImages(filter)) for (const tag of image.RepoTags ?? []) await docker.removeImage(tag).catch(() => false);
      if (removeData) for (const volume of await docker.listVolumes(filter)) await docker.removeVolume(volume.Name).catch(() => undefined);
    } catch (error) {
      this.ctx.logger.warn('Could not clean up compose stack', { applicationId: app.id, error: errorMessage(error) });
    }
    await rm(join(this.appDir(app), 'code'), { recursive: true, force: true });
    if (removeData) await rm(this.appDir(app), { recursive: true, force: true });
  }
}
