/**
 * The one-off updater container: how it is started and how its outcome is read.
 *
 * The control plane cannot replace itself from inside (its own process would
 * die halfway), so it starts `ploy-updater` from its own image — which already
 * carries node, git, the docker CLI and buildx — and that container does the
 * work (`updater.ts`). Only configuration reaches it: no database, no secrets.
 */
import type { UpdateProgressDto } from '@ploy/shared';
import type { DockerClient } from '../docker/client.ts';
import { LABEL_MANAGED, LABEL_ROLE } from '../docker/naming.ts';
import type { AppConfig } from '../lib/config.ts';
import { latestProgress } from './progress.ts';
import type { SelfContainer } from './self.ts';

export const UPDATER_CONTAINER = 'ploy-updater';
/** What the updater tags the new image as when the running image has no usable tag. */
const DEFAULT_TAG = 'torexploy:latest';
/** Lines of updater output shown when it failed. */
const ERROR_TAIL = 15;
/** Lines searched for the latest progress marker. */
const PROGRESS_TAIL = 120;

export interface UpdaterState {
  state: 'idle' | 'updating' | 'failed';
  error: string | null;
  /** The last step the updater reported, while it runs or where it stopped. */
  progress: UpdateProgressDto | null;
}

/** Docker's own networks take no aliases and need no endpoint config. */
function isUserNetwork(network: string): boolean {
  return !['bridge', 'default', 'host', 'none'].includes(network) && !network.startsWith('container:');
}

/**
 * The tag the new image gets: the running image's reference without its
 * digest, with `:latest` when it has no tag. An image known only by id
 * (`sha256:…`) gives the installer's default.
 */
export function imageTag(reference: string): string {
  if (reference.startsWith('sha256:')) return DEFAULT_TAG;
  const at = reference.indexOf('@');
  const named = at === -1 ? reference : reference.slice(0, at);
  if (named.length === 0) return DEFAULT_TAG;
  const colon = named.lastIndexOf(':');
  return colon > named.lastIndexOf('/') ? named : `${named}:latest`;
}

export function updaterSpec(self: SelfContainer, config: AppConfig, commit: string): Record<string, unknown> {
  const { updates } = config;
  return {
    Image: self.image,
    Cmd: ['node', 'packages/server/src/updater.ts'],
    Env: [
      `PLOY_UPDATER_TARGET=${self.name}`,
      `PLOY_UPDATER_MODE=${updates.image === null ? 'source' : 'image'}`,
      `PLOY_UPDATER_REPO=${updates.repository}`,
      `PLOY_UPDATER_BRANCH=${updates.branch}`,
      `PLOY_UPDATER_COMMIT=${commit}`,
      `PLOY_UPDATER_IMAGE=${updates.image ?? ''}`,
      `PLOY_UPDATER_TAG=${imageTag(self.image)}`,
      'DOCKER_HOST=unix:///var/run/docker.sock',
    ],
    Labels: { [LABEL_MANAGED]: 'true', [LABEL_ROLE]: 'updater' },
    HostConfig: {
      Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
      AutoRemove: false,
      NetworkMode: self.network,
      LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '2' } },
    },
    ...(isUserNetwork(self.network) ? { NetworkingConfig: { EndpointsConfig: { [self.network]: {} } } } : {}),
  };
}

async function tail(docker: DockerClient, id: string, lines: number): Promise<string> {
  const demux = await docker.containerLogs(id, { follow: false, tail: lines });
  let text = '';
  for await (const chunk of demux as AsyncIterable<{ text: string }>) text += chunk.text;
  return text.trim().split('\n').slice(-lines).join('\n');
}

/**
 * What the updater is doing. A finished updater that succeeded is removed
 * here (the control plane it started is the one asking); a failed one is kept
 * so its output stays readable until the next attempt replaces it.
 */
export async function updaterState(docker: DockerClient): Promise<UpdaterState> {
  const inspect = await docker.inspectContainer(UPDATER_CONTAINER);
  if (inspect === null) return { state: 'idle', error: null, progress: null };
  if (inspect.State.Running || inspect.State.Restarting || inspect.State.Status === 'created') {
    const output = await tail(docker, inspect.Id, PROGRESS_TAIL).catch(() => '');
    return { state: 'updating', error: null, progress: latestProgress(output) };
  }
  if (inspect.State.ExitCode !== 0) {
    const output = await tail(docker, inspect.Id, PROGRESS_TAIL).catch(() => '');
    const shown = output
      .split('\n')
      .filter((line) => !line.includes('::progress '))
      .slice(-ERROR_TAIL)
      .join('\n');
    return { state: 'failed', error: shown.length > 0 ? shown : `The updater exited with code ${inspect.State.ExitCode}`, progress: latestProgress(output) };
  }
  void docker.removeContainer(inspect.Id, { force: true }).catch(() => undefined);
  return { state: 'idle', error: null, progress: null };
}

/** Start the updater for `commit`, replacing a finished one. Returns the container id. */
export async function launchUpdater(docker: DockerClient, self: SelfContainer, config: AppConfig, commit: string): Promise<string> {
  const existing = await docker.inspectContainer(UPDATER_CONTAINER);
  if (existing !== null) await docker.removeContainer(existing.Id, { force: true });
  const id = await docker.createContainer(UPDATER_CONTAINER, updaterSpec(self, config, commit));
  try {
    await docker.startContainer(id);
  } catch (error) {
    await docker.removeContainer(id, { force: true }).catch(() => undefined);
    throw error;
  }
  return id;
}
