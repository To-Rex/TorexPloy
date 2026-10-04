/**
 * Where the control plane runs.
 *
 * Self-update replaces the container this process lives in, so it must find
 * that container through the local Docker socket: by the name the installer
 * gave it (`PLOY_CONTAINER`), else by the container id Docker uses as the
 * hostname. On a developer's machine neither exists and updating stays a
 * `git pull` away (`manual` mode).
 */
import { existsSync } from 'node:fs';
import type { Context } from '../context.ts';
import type { ContainerInspect, DockerClient } from '../docker/client.ts';
import { errorMessage } from '../lib/errors.ts';

export interface SelfOptions {
  /** Overrides detection (tests): whether the process runs in a container, and that container's hostname. */
  inDocker?: boolean;
  hostname?: string;
  /** How long a located container is reused before it is inspected again. */
  cacheMs?: number;
}

export interface SelfContainer {
  id: string;
  name: string;
  /** Image reference the container was created from (`Config.Image`). */
  image: string;
  /** Primary network (`HostConfig.NetworkMode`), where the updater joins to reach us. */
  network: string;
  inspect: ContainerInspect;
}

const CACHE_MS = 10_000;

/** Docker names a container's hostname after its id (12 or 64 hex characters). */
export function isContainerId(value: string | undefined): boolean {
  return value !== undefined && /^(?:[0-9a-f]{12}|[0-9a-f]{64})$/.test(value);
}

export function runsInDocker(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): boolean {
  return exists('/.dockerenv') || isContainerId(env.HOSTNAME);
}

export class SelfLocator {
  readonly inDocker: boolean;
  private readonly ctx: Context;
  private readonly hostname: string | undefined;
  private readonly cacheMs: number;
  private cached: { at: number; value: SelfContainer | null } | null = null;

  constructor(ctx: Context, options: SelfOptions = {}) {
    this.ctx = ctx;
    this.inDocker = options.inDocker ?? runsInDocker();
    this.hostname = options.hostname ?? process.env.HOSTNAME;
    this.cacheMs = options.cacheMs ?? CACHE_MS;
  }

  /** The local server's Docker client, or null before setup created the local server. */
  async docker(): Promise<DockerClient | null> {
    const local = this.ctx.stores.servers.getLocal();
    return local === undefined ? null : this.ctx.connections.docker(local.id);
  }

  /** Our own container, or null when not in Docker or not found. Cached briefly: a status call asks more than once. */
  async locate(): Promise<SelfContainer | null> {
    if (!this.inDocker) return null;
    if (this.cached !== null && Date.now() - this.cached.at < this.cacheMs) return this.cached.value;
    let value: SelfContainer | null = null;
    try {
      const docker = await this.docker();
      if (docker !== null) {
        const name = this.ctx.config.updates.container;
        let inspect = name === null ? null : await docker.inspectContainer(name);
        if (inspect === null && isContainerId(this.hostname)) inspect = await docker.inspectContainer(this.hostname!);
        if (inspect !== null) {
          const mode = inspect.HostConfig.NetworkMode ?? 'bridge';
          value = { id: inspect.Id, name: inspect.Name.replace(/^\//, ''), image: inspect.Config.Image, network: mode === 'default' ? 'bridge' : mode, inspect };
        }
      }
    } catch (error) {
      this.ctx.logger.debug('Could not locate the control-plane container', { error: errorMessage(error) });
    }
    this.cached = { at: Date.now(), value };
    return value;
  }
}
