/**
 * Keeps every server's `ploy-proxy` (Caddy) in step with the database.
 *
 * `requestSync(serverId)` is the only entry point callers need: it rebuilds
 * the server's full route table from SQLite and loads it atomically. Calls
 * are coalesced — a burst of changes produces at most one in-flight load plus
 * one follow-up — so the pipeline can request a sync after every state change
 * without thinking about cost.
 *
 * The config is handed to Caddy through the Engine API (archive upload +
 * `caddy reload` exec), which works identically for local and SSH servers and
 * keeps Caddy's admin endpoint bound to the proxy container's own loopback.
 */
import { createHash } from 'node:crypto';
import { serviceAlias } from '../compose/transform.ts';
import type { DockerClient } from '../docker/client.ts';
import {
  LABEL_MANAGED,
  LABEL_ROLE,
  PLATFORM_NETWORK,
  PROXY_CONFIG_VOLUME,
  PROXY_CONTAINER,
  PROXY_DATA_VOLUME,
  projectNetwork,
} from '../docker/naming.ts';
import type { AppConfig } from '../lib/config.ts';
import { AppError, errorMessage } from '../lib/errors.ts';
import type { Logger } from '../lib/logger.ts';
import { createTar } from '../lib/tar.ts';
import type { ConnectionManager } from '../servers/connections.ts';
import type { Stores } from '../store/index.ts';
import type { ProxyInfo } from '../store/servers.ts';
import { buildCaddyConfig, type ProxyRoute } from './caddy.ts';

const CONFIG_DIR = '/etc/caddy';
const CONFIG_FILE = `${CONFIG_DIR}/ploy.json`;

/** Default port an application is assumed to listen on when none is configured. */
export const DEFAULT_APP_PORT = 3000;

export class ProxyManager {
  private readonly config: AppConfig;
  private readonly stores: Stores;
  private readonly connections: ConnectionManager;
  private readonly logger: Logger;
  private readonly lastHash = new Map<string, string>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly queued = new Map<string, Promise<void>>();

  constructor(config: AppConfig, stores: Stores, connections: ConnectionManager, logger: Logger) {
    this.config = config;
    this.stores = stores;
    this.connections = connections;
    this.logger = logger.child({ component: 'proxy' });
  }

  /** Routes this server should serve right now, derived from the database. */
  desiredRoutes(serverId: string): { routes: ProxyRoute[]; networks: Set<string> } {
    const routes: ProxyRoute[] = [];
    const networks = new Set<string>();

    for (const domain of this.stores.domains.listForServer(serverId)) {
      const app = this.stores.applications.get(domain.applicationId);
      if (app === undefined) continue;
      networks.add(projectNetwork(app.projectId));
      const base = { host: domain.host, path: domain.path, stripPath: domain.stripPath, https: domain.https, label: app.name };
      if (domain.redirectTo !== null) {
        routes.push({ ...base, upstreams: [], redirectTo: domain.redirectTo });
        continue;
      }
      const active = app.activeDeploymentId === null ? undefined : this.stores.deployments.get(app.activeDeploymentId);
      const serving = app.status !== 'stopped' && active !== undefined && active.containers.length > 0;
      if (app.kind === 'compose') {
        // Compose services are reached by their alias on the project network, whatever their container is called.
        const port = domain.port ?? DEFAULT_APP_PORT;
        routes.push({ ...base, upstreams: serving && domain.serviceName !== null ? [`${serviceAlias(app.slug, domain.serviceName)}:${port}`] : [] });
        continue;
      }
      const port = domain.port ?? active?.port ?? app.port ?? DEFAULT_APP_PORT;
      routes.push({ ...base, upstreams: serving ? active.containers.map((container) => `${container}:${port}`) : [] });
    }

    const local = this.stores.servers.getLocal();
    const { platformDomain } = this.stores.settings.platform();
    if (local?.id === serverId && platformDomain !== null && !routes.some((route) => route.host === platformDomain)) {
      routes.push({ host: platformDomain, https: true, upstreams: [this.config.controlUpstream], label: 'TorexPloy' });
    }
    return { routes, networks };
  }

  /** Create (or repair) the proxy container on a server. Idempotent. */
  async ensureProxy(serverId: string, onProgress?: (line: string) => void): Promise<ProxyInfo> {
    const docker = await this.connections.docker(serverId);
    await docker.ensureNetwork(PLATFORM_NETWORK, { [LABEL_MANAGED]: 'true' });

    const existing = await docker.inspectContainer(PROXY_CONTAINER);
    if (existing !== null && existing.Config.Image === this.config.proxyImage) {
      if (!existing.State.Running) await docker.startContainer(existing.Id);
      const info = await this.describe(docker);
      this.stores.servers.setProxyInfo(serverId, info);
      return info;
    }
    if (existing !== null) {
      // Image changed (platform upgrade): replace the container; certificates live on the data volume.
      onProgress?.(`Replacing proxy (${existing.Config.Image} → ${this.config.proxyImage})`);
      await docker.removeContainer(existing.Id, { force: true });
    }

    if ((await docker.inspectImage(this.config.proxyImage)) === null) {
      onProgress?.(`Pulling ${this.config.proxyImage}`);
      await docker.pullImage(this.config.proxyImage, onProgress);
    }
    await docker.ensureVolume(PROXY_DATA_VOLUME, { [LABEL_MANAGED]: 'true' });
    await docker.ensureVolume(PROXY_CONFIG_VOLUME, { [LABEL_MANAGED]: 'true' });

    const id = await docker.createContainer(PROXY_CONTAINER, {
      Image: this.config.proxyImage,
      Cmd: ['caddy', 'run', '--config', CONFIG_FILE, '--resume'],
      Labels: { [LABEL_MANAGED]: 'true', [LABEL_ROLE]: 'proxy' },
      ExposedPorts: { '80/tcp': {}, '443/tcp': {}, '443/udp': {} },
      HostConfig: {
        RestartPolicy: { Name: 'unless-stopped' },
        PortBindings: {
          '80/tcp': [{ HostPort: '80' }],
          '443/tcp': [{ HostPort: '443' }],
          '443/udp': [{ HostPort: '443' }],
        },
        Mounts: [
          { Type: 'volume', Source: PROXY_DATA_VOLUME, Target: '/data' },
          { Type: 'volume', Source: PROXY_CONFIG_VOLUME, Target: '/config' },
        ],
        SecurityOpt: ['no-new-privileges:true'],
        LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
        NetworkMode: PLATFORM_NETWORK,
      },
      NetworkingConfig: { EndpointsConfig: { [PLATFORM_NETWORK]: {} } },
    });

    // The config file must exist before Caddy starts; on later restarts `--resume` uses the autosave.
    await docker.putArchive(id, CONFIG_DIR, createTar([{ name: 'ploy.json', content: this.render(serverId).json }]));
    try {
      await docker.startContainer(id);
    } catch (error) {
      const message = errorMessage(error);
      await docker.removeContainer(id, { force: true }).catch(() => undefined);
      if (/address already in use|port is already allocated/i.test(message)) {
        throw new AppError('proxy_error', 'Ports 80/443 are already in use on this server. Stop the other web server (nginx, apache, traefik) and retry.', {
          params: { reason: 'ports_in_use' },
        });
      }
      throw new AppError('proxy_error', `Proxy failed to start: ${message}`);
    }
    this.lastHash.delete(serverId);
    const info = await this.describe(docker);
    this.stores.servers.setProxyInfo(serverId, info);
    return info;
  }

  private async describe(docker: DockerClient): Promise<ProxyInfo> {
    const inspect = await docker.inspectContainer(PROXY_CONTAINER);
    if (inspect === null) return { running: false, version: null, containerId: null };
    let version: string | null = null;
    if (inspect.State.Running) {
      const result = await docker.exec(inspect.Id, ['caddy', 'version'], { timeoutMs: 15_000 }).catch(() => null);
      version = result?.stdout.trim().split(' ')[0] ?? null;
    }
    return { running: inspect.State.Running, version, containerId: inspect.Id };
  }

  private render(serverId: string): { json: string; hash: string; networks: Set<string> } {
    const { routes, networks } = this.desiredRoutes(serverId);
    const { acmeEmail } = this.stores.settings.platform();
    const json = JSON.stringify(buildCaddyConfig({ acmeEmail, routes }), null, 2);
    return { json, hash: createHash('sha256').update(json).digest('hex'), networks };
  }

  /** What a server's proxy serves, and the exact configuration it is (or will be) given. */
  overview(serverId: string): { routes: ProxyRoute[]; config: string; inSync: boolean } {
    const { json, hash } = this.render(serverId);
    return { routes: this.desiredRoutes(serverId).routes, config: json, inSync: this.lastHash.get(serverId) === hash };
  }

  /** Load the configuration again even when nothing changed (after the proxy was restarted or edited by hand). */
  async reload(serverId: string): Promise<void> {
    this.lastHash.delete(serverId);
    await this.requestSync(serverId);
  }

  /** Bring a server's proxy in line with the database. Coalesces concurrent requests. */
  requestSync(serverId: string): Promise<void> {
    const queued = this.queued.get(serverId);
    if (queued !== undefined) return queued;
    const running = this.running.get(serverId);
    if (running === undefined) return this.start(serverId);
    const next = running
      .catch(() => undefined)
      .then(() => {
        this.queued.delete(serverId);
        return this.start(serverId);
      });
    this.queued.set(serverId, next);
    return next;
  }

  private start(serverId: string): Promise<void> {
    const run = this.sync(serverId).finally(() => {
      if (this.running.get(serverId) === run) this.running.delete(serverId);
    });
    this.running.set(serverId, run);
    return run;
  }

  private async sync(serverId: string): Promise<void> {
    const server = this.stores.servers.get(serverId);
    if (server === undefined || server.status !== 'ready') return;
    const docker = await this.connections.docker(serverId);
    const { json, hash, networks } = this.render(serverId);

    let proxy = await docker.inspectContainer(PROXY_CONTAINER);
    if (proxy === null || !proxy.State.Running) {
      await this.ensureProxy(serverId);
      proxy = await docker.inspectContainer(PROXY_CONTAINER);
      if (proxy === null) throw new AppError('proxy_error', 'Proxy container is missing');
    }

    // The proxy must share a network with every application it routes to.
    const attached = new Set(Object.keys(proxy.NetworkSettings.Networks));
    for (const network of networks) {
      if (attached.has(network)) continue;
      await docker.ensureNetwork(network, { [LABEL_MANAGED]: 'true' });
      await docker.connectNetwork(network, proxy.Id);
    }

    if (this.lastHash.get(serverId) === hash) return;
    await docker.putArchive(proxy.Id, CONFIG_DIR, createTar([{ name: 'ploy.json', content: json }]));
    const result = await docker.exec(proxy.Id, ['caddy', 'reload', '--config', CONFIG_FILE, '--force'], { timeoutMs: 60_000 });
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ');
      this.logger.error('Proxy reload failed', { serverId, detail });
      throw new AppError('proxy_error', `Proxy rejected the configuration: ${detail}`);
    }
    this.lastHash.set(serverId, hash);
    this.logger.debug('Proxy configuration loaded', { serverId, hash: hash.slice(0, 12) });
  }

  /**
   * Probe an upstream from inside the proxy container — the same network
   * vantage point real traffic has. Works for local and remote servers alike.
   *
   * With a path: healthy when the first response is 2xx/3xx.
   * Without a path: healthy as soon as anything answers HTTP on the port.
   */
  async probe(serverId: string, target: string, path: string | null, timeoutSec = 5): Promise<{ healthy: boolean; detail: string }> {
    const docker = await this.connections.docker(serverId);
    const url = `http://${target}${path ?? '/'}`;
    const result = await docker.exec(PROXY_CONTAINER, ['wget', '-q', '-S', '-O', '/dev/null', '-T', String(timeoutSec), url], {
      timeoutMs: (timeoutSec + 10) * 1000,
    });
    const output = `${result.stderr}\n${result.stdout}`;
    const status = /HTTP\/[\d.]+\s+(\d{3})/.exec(output);
    if (status !== null) {
      const code = Number(status[1]);
      if (path === null) return { healthy: true, detail: `HTTP ${code}` };
      return { healthy: code >= 200 && code < 400, detail: `HTTP ${code}` };
    }
    if (result.exitCode === 0) return { healthy: true, detail: 'OK' };
    const line = output.split('\n').map((value) => value.replace(/^wget:\s*/, '').trim()).find((value) => value.length > 0);
    return { healthy: false, detail: line ?? `wget exited with ${result.exitCode}` };
  }
}
