/**
 * Converges what runs on each server with what the database says should run.
 *
 * Runs at boot, every minute, and immediately when Docker reports a relevant
 * container event. It:
 * - restarts containers of the active deployment that someone stopped;
 * - redeploys the active image when its containers are gone (self-healing);
 * - marks applications `crashed` while their containers restart in a loop,
 *   and `running` again once they are stable;
 * - removes debris: containers of failed, cancelled or interrupted
 *   deployments, and of applications that no longer exist;
 * - recreates missing database service containers.
 */
import { emit, type Context } from '../context.ts';
import type { ContainerSummary, DockerClient } from '../docker/client.ts';
import { LABEL_APP, LABEL_DEPLOYMENT, LABEL_MANAGED, LABEL_ROLE, LABEL_SERVICE } from '../docker/naming.ts';
import { errorMessage } from '../lib/errors.ts';
import type { ApplicationRecord } from '../store/index.ts';

export class Reconciler {
  private readonly ctx: Context;
  private readonly restartCounts = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly watchers = new Map<string, AbortController>();
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  async reconcileAll(): Promise<void> {
    for (const server of this.ctx.stores.servers.listAll()) {
      if (server.status !== 'ready') continue;
      await this.reconcileServer(server.id).catch((error) =>
        this.ctx.logger.warn('Reconcile failed', { serverId: server.id, error: errorMessage(error) }),
      );
    }
  }

  reconcileServer(serverId: string): Promise<void> {
    const existing = this.inFlight.get(serverId);
    if (existing !== undefined) return existing;
    const run = this.run(serverId).finally(() => this.inFlight.delete(serverId));
    this.inFlight.set(serverId, run);
    return run;
  }

  private setAppStatus(app: ApplicationRecord, status: ApplicationRecord['status']): void {
    if (app.status === status) return;
    this.ctx.stores.applications.setStatus(app.id, status);
    emit(this.ctx, app.teamId, { type: 'application.updated', id: app.id, projectId: app.projectId, status });
  }

  private async run(serverId: string): Promise<void> {
    const { stores, deployer } = this.ctx;
    const server = stores.servers.get(serverId);
    if (server === undefined || server.status !== 'ready') return;
    const docker = await this.ctx.connections.docker(serverId);
    const containers = await docker.listContainers({ label: [`${LABEL_MANAGED}=true`] });
    const byName = new Map(containers.map((container) => [container.Names[0]?.replace(/^\//, '') ?? '', container]));

    // ------------------------------------------------------- applications
    const apps = stores.applications.listForServer(serverId);
    const appIds = new Set(apps.map((app) => app.id));
    for (const app of apps) {
      if (deployer.isRunning(app.id)) continue;
      const open = stores.deployments.listOpen().some((deployment) => deployment.applicationId === app.id);
      const active = app.activeDeploymentId === null ? undefined : stores.deployments.get(app.activeDeploymentId);
      const keep = new Set(active?.containers ?? []);

      // Debris from deployments that are not active.
      for (const container of containers) {
        if (container.Labels[LABEL_APP] !== app.id || container.Labels[LABEL_ROLE] !== 'app') continue;
        const name = container.Names[0]?.replace(/^\//, '') ?? '';
        if (!keep.has(name) && !open) {
          await docker.removeContainer(container.Id, { force: true }).catch(() => undefined);
        }
      }

      if (active === undefined || app.status === 'stopped' || open) continue;
      const present = active.containers.map((name) => byName.get(name));
      if (present.some((container) => container === undefined)) {
        if (active.imageTag !== null && !active.imageRemoved) {
          this.ctx.logger.info('Self-healing: active containers missing, redeploying', { applicationId: app.id });
          deployer.enqueue({ app, trigger: 'restart', createdBy: null, imageTag: active.imageTag, sourceDeploymentId: active.id });
        } else {
          this.setAppStatus(app, 'failed');
        }
        continue;
      }

      let crashing = false;
      for (const container of present as ContainerSummary[]) {
        if (container.State === 'exited' || container.State === 'created') {
          // Stopped outside the platform (e.g. `docker stop`); the restart policy will not revive it.
          await docker.startContainer(container.Id).catch(() => undefined);
        }
        const inspect = await docker.inspectContainer(container.Id);
        if (inspect === null) continue;
        const previous = this.restartCounts.get(container.Id);
        this.restartCounts.set(container.Id, inspect.RestartCount);
        if (inspect.State.Restarting || (previous !== undefined && inspect.RestartCount > previous) || !inspect.State.Running) crashing = true;
      }
      this.setAppStatus(app, crashing ? 'crashed' : 'running');
    }

    // ------------------------------------------------------------ services
    const services = stores.services.listForServer(serverId);
    const serviceIds = new Set(services.map((service) => service.id));
    for (const service of services) {
      if (service.status === 'provisioning' || service.status === 'restarting') continue;
      const container = byName.get(service.containerName);
      if (service.status === 'stopped') continue;
      if (container === undefined) {
        void this.ctx.services.provision(service.id);
        continue;
      }
      if (container.State === 'exited' || container.State === 'created') await docker.startContainer(container.Id).catch(() => undefined);
      const inspect = await docker.inspectContainer(container.Id);
      const health = inspect?.State.Health?.Status;
      const status = health === 'unhealthy' || inspect?.State.Restarting ? 'failed' : health === 'starting' ? service.status : 'running';
      if (status !== service.status) {
        stores.services.setStatus(service.id, status, status === 'failed' ? 'The service is unhealthy or restarting' : null, status === 'failed' ? 'unhealthy' : null);
        emit(this.ctx, service.teamId, { type: 'service.updated', id: service.id, projectId: service.projectId, status });
      }
    }

    // --------------------------------------------- orphans of deleted resources
    for (const container of containers) {
      const role = container.Labels[LABEL_ROLE];
      const orphanApp = role === 'app' && !appIds.has(container.Labels[LABEL_APP] ?? '');
      const orphanService = role === 'service' && !serviceIds.has(container.Labels[LABEL_SERVICE] ?? '');
      const finishedCron = role === 'cron' && container.State === 'exited' && Date.now() / 1000 - container.Created > 3_600;
      if (orphanApp || orphanService || finishedCron) await docker.removeContainer(container.Id, { force: true }).catch(() => undefined);
    }
    for (const id of this.restartCounts.keys()) if (!containers.some((container) => container.Id === id)) this.restartCounts.delete(id);

    await this.ctx.proxy.requestSync(serverId).catch((error) => this.ctx.logger.warn('Proxy sync failed', { serverId, error: errorMessage(error) }));
  }

  // --------------------------------------------------------------- events

  /** Follow Docker events for platform containers and reconcile promptly on crashes and restarts. */
  watch(serverId: string): void {
    if (this.watchers.has(serverId)) return;
    const controller = new AbortController();
    this.watchers.set(serverId, controller);
    void this.follow(serverId, controller.signal);
  }

  unwatch(serverId: string): void {
    this.watchers.get(serverId)?.abort();
    this.watchers.delete(serverId);
  }

  stopAll(): void {
    for (const controller of this.watchers.values()) controller.abort();
    this.watchers.clear();
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  private async follow(serverId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const server = this.ctx.stores.servers.get(serverId);
        if (server === undefined) return;
        if (server.status !== 'ready') {
          await new Promise((resolve) => setTimeout(resolve, 15_000));
          continue;
        }
        const docker: DockerClient = await this.ctx.connections.docker(serverId);
        const events = await docker.events({ type: ['container'], label: [`${LABEL_MANAGED}=true`], event: ['die', 'start', 'oom', 'health_status', 'destroy'] }, signal);
        for await (const event of events) {
          if (event.Actor.Attributes[LABEL_DEPLOYMENT] === undefined && event.Actor.Attributes[LABEL_SERVICE] === undefined) continue;
          this.schedule(serverId);
        }
      } catch {
        if (signal.aborted) return;
      }
      // Stream ended (daemon restart, network blip): reconnect after a pause.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }

  /** Debounce bursts of events (a crash loop emits die/start pairs rapidly). */
  private schedule(serverId: string): void {
    if (this.pending.has(serverId)) return;
    this.pending.set(
      serverId,
      setTimeout(() => {
        this.pending.delete(serverId);
        void this.reconcileServer(serverId).catch(() => undefined);
      }, 3_000),
    );
  }
}
