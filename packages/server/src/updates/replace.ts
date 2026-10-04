/**
 * Replace a container with the same configuration on a new image.
 *
 * Everything `docker run` was given is read back from the daemon and handed to
 * the create request: published ports, binds and volumes (anonymous ones
 * included, by name), restart policy, log driver, security options, networks
 * and aliases. Settings that merely came from the old image — its CMD,
 * ENTRYPOINT, ENV, labels, HEALTHCHECK — are left out so the new image's own
 * defaults apply; a build identity (`PLOY_COMMIT`) copied from the old image
 * would otherwise follow the panel forever.
 *
 * The old container is renamed `<name>-old`, stopped only once the
 * replacement exists (a host port can be bound by one of them at a time), and
 * removed when the new one passes its health probe. Otherwise the new one is
 * removed and the old one gets its name and its process back.
 */
import type { ContainerInspect, DockerClient, ImageInspect } from '../docker/client.ts';
import { errorMessage } from '../lib/errors.ts';

export interface ReplaceOptions {
  name: string;
  image: string;
  /** Whether the started replacement answers; called every `intervalMs` until `timeoutMs`. */
  probe: (inspect: ContainerInspect) => Promise<boolean>;
  timeoutMs?: number;
  intervalMs?: number;
  /** Grace period for the old container to stop. */
  stopTimeoutSec?: number;
  log?: (line: string) => void;
}

export interface ReplacementSpec {
  spec: Record<string, unknown>;
  /** Networks beyond the primary one, connected after creation with these aliases. */
  extra: { network: string; aliases: string[] }[];
}

export class ReplaceError extends Error {
  override name = 'ReplaceError';
}

/** Build identity: the new image carries its own. */
const BUILD_ENV = new Set(['PLOY_COMMIT', 'PLOY_BUILT_AT']);
const HEALTH_TIMEOUT_MS = 180_000;
const HEALTH_INTERVAL_MS = 3_000;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Docker's own networks take no aliases. */
function isUserNetwork(network: string): boolean {
  return !['bridge', 'host', 'none'].includes(network);
}

/** Mount target of a `src:dst[:opts]` bind. */
function bindTarget(bind: string): string {
  return bind.split(':')[1] ?? '';
}

/** The create request that reproduces `inspect` on `image`. `oldImage` tells which settings were only inherited. */
export function replacementSpec(inspect: ContainerInspect, oldImage: ImageInspect | null, image: string): ReplacementSpec {
  const config = inspect.Config;
  const defaults = oldImage?.Config ?? {};
  const shortId = inspect.Id.slice(0, 12);

  const env = (config.Env ?? []).filter((entry) => !BUILD_ENV.has(entry.split('=')[0] ?? '') && !(defaults.Env ?? []).includes(entry));
  const labels = Object.fromEntries(Object.entries(config.Labels ?? {}).filter(([key, value]) => defaults.Labels?.[key] !== value));

  const hostConfig: Record<string, unknown> = { ...inspect.HostConfig };
  // Anonymous volumes (an image VOLUME nobody bound) exist only in `Mounts`; carry them over by name so data survives.
  const binds = [...(inspect.HostConfig.Binds ?? [])];
  const bound = new Set<string>([...binds.map(bindTarget), ...(inspect.HostConfig.Mounts ?? []).map((mount) => String(mount.Target))]);
  for (const mount of inspect.Mounts ?? []) {
    if (mount.Type !== 'volume' || mount.Name === undefined || bound.has(mount.Destination)) continue;
    binds.push(`${mount.Name}:${mount.Destination}${mount.RW === false ? ':ro' : ''}`);
  }
  hostConfig.Binds = binds;

  const networkMode = inspect.HostConfig.NetworkMode ?? 'bridge';
  const endpoints = Object.entries(inspect.NetworkSettings.Networks ?? {}).map(([network, endpoint]) => ({
    network,
    id: endpoint.NetworkID,
    aliases: isUserNetwork(network) ? (endpoint.Aliases ?? []).filter((alias) => alias !== shortId) : [],
  }));
  const primary = endpoints.find((endpoint) => endpoint.network === networkMode || endpoint.id === networkMode) ?? (networkMode === 'default' ? endpoints.find((endpoint) => endpoint.network === 'bridge') : undefined);

  const spec: Record<string, unknown> = {
    Image: image,
    Env: env,
    Labels: labels,
    ...(same(config.Cmd, defaults.Cmd) ? {} : { Cmd: config.Cmd }),
    ...(same(config.Entrypoint, defaults.Entrypoint) ? {} : { Entrypoint: config.Entrypoint }),
    ...(same(config.Healthcheck, defaults.Healthcheck) ? {} : { Healthcheck: config.Healthcheck }),
    ...(config.WorkingDir === undefined || config.WorkingDir === (defaults.WorkingDir ?? '') ? {} : { WorkingDir: config.WorkingDir }),
    ...(config.User === undefined || config.User === (defaults.User ?? '') ? {} : { User: config.User }),
    ...(config.Hostname === undefined || config.Hostname === shortId ? {} : { Hostname: config.Hostname }),
    ...(config.ExposedPorts == null ? {} : { ExposedPorts: config.ExposedPorts }),
    ...(config.StopSignal === undefined ? {} : { StopSignal: config.StopSignal }),
    ...(config.StopTimeout === undefined ? {} : { StopTimeout: config.StopTimeout }),
    HostConfig: hostConfig,
    ...(primary === undefined ? {} : { NetworkingConfig: { EndpointsConfig: { [primary.network]: primary.aliases.length > 0 ? { Aliases: primary.aliases } : {} } } }),
  };
  return { spec, extra: endpoints.filter((endpoint) => endpoint !== primary).map(({ network, aliases }) => ({ network, aliases })) };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function replaceContainer(docker: DockerClient, options: ReplaceOptions): Promise<void> {
  const log = options.log ?? (() => undefined);
  const { name, image } = options;
  const oldName = `${name}-old`;
  const timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? HEALTH_INTERVAL_MS;

  const stale = await docker.inspectContainer(oldName);
  if (stale !== null) {
    log(`Removing ${oldName} left over from an earlier run`);
    await docker.removeContainer(stale.Id, { force: true });
  }
  const current = await docker.inspectContainer(name);
  if (current === null) throw new ReplaceError(`Container ${name} not found`);
  const oldImage = await docker.inspectImage(current.Image).catch(() => null);
  const { spec, extra } = replacementSpec(current, oldImage, image);

  log(`Renaming ${name} → ${oldName}`);
  await docker.renameContainer(current.Id, oldName);
  let created: string | null = null;

  const rollback = async (reason: string): Promise<never> => {
    log(`Rolling back: ${reason}`);
    if (created !== null) await docker.removeContainer(created, { force: true }).catch((error) => log(`Could not remove the new container: ${errorMessage(error)}`));
    await docker.renameContainer(current.Id, name).catch((error) => log(`Could not rename ${oldName} back: ${errorMessage(error)}`));
    await docker.startContainer(current.Id).catch((error) => log(`Could not start ${name} again: ${errorMessage(error)}`));
    log(`${name} is running the previous version again`);
    throw new ReplaceError(reason);
  };

  try {
    created = await docker.createContainer(name, spec);
    for (const { network, aliases } of extra) await docker.connectNetwork(network, created, aliases);
    log(`Stopping ${oldName}`);
    await docker.stopContainer(current.Id, options.stopTimeoutSec ?? 20);
    log(`Starting ${name} from ${image}`);
    await docker.startContainer(created);

    const deadline = Date.now() + timeoutMs;
    let failure: string | null = null;
    let healthy = false;
    while (Date.now() < deadline) {
      const inspect = await docker.inspectContainer(created);
      if (inspect === null) {
        failure = 'the new container disappeared';
        break;
      }
      if (!inspect.State.Running && !inspect.State.Restarting) {
        failure = `the new container exited with code ${inspect.State.ExitCode}`;
        break;
      }
      if (inspect.State.Health?.Status === 'unhealthy') {
        failure = 'Docker reports the new container unhealthy';
        break;
      }
      if (inspect.State.Health?.Status === 'healthy' || (await options.probe(inspect))) {
        healthy = true;
        break;
      }
      await sleep(intervalMs);
    }
    if (!healthy) await rollback(failure ?? `the new container did not become healthy within ${Math.round(timeoutMs / 1000)}s`);
  } catch (error) {
    if (error instanceof ReplaceError) throw error;
    await rollback(errorMessage(error));
  }

  log(`Removing ${oldName}`);
  await docker.removeContainer(current.Id, { force: true });
}
