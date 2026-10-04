/**
 * Names of every Docker object the platform owns.
 *
 * Names are derived, never stored, so the platform can always find its own
 * objects again — including after a crash. They are DNS-safe (no
 * underscores, each label under 63 bytes) because containers are addressed by
 * name on project networks.
 */

/** The random part of a prefixed id (`app_k3m9…` → `k3m9…`). */
export function idPart(id: string, length = 14): string {
  return id.slice(id.indexOf('_') + 1).slice(0, length);
}

export const PLATFORM_NETWORK = 'ploy';
export const PROXY_CONTAINER = 'ploy-proxy';
export const PROXY_DATA_VOLUME = 'ploy-proxy-data';
export const PROXY_CONFIG_VOLUME = 'ploy-proxy-config';

export const LABEL_MANAGED = 'ploy.managed';
export const LABEL_ROLE = 'ploy.role';
export const LABEL_APP = 'ploy.app';
export const LABEL_DEPLOYMENT = 'ploy.deployment';
export const LABEL_SERVICE = 'ploy.service';
export const LABEL_PROJECT = 'ploy.project';
export const LABEL_TEAM = 'ploy.team';

export function projectNetwork(projectId: string): string {
  return `ploy-net-${idPart(projectId)}`;
}

export function appPrefix(app: { id: string; slug: string }): string {
  return `ploy-${app.slug.slice(0, 24).replace(/-+$/, '')}-${idPart(app.id, 6)}`;
}

export function appContainer(app: { id: string; slug: string }, deploymentId: string, replica: number): string {
  return `${appPrefix(app)}-${idPart(deploymentId, 8)}-${replica}`;
}

export function imageRepository(app: { id: string; slug: string }): string {
  return `ploy/${app.slug.slice(0, 24).replace(/-+$/, '')}-${idPart(app.id, 6)}`;
}

export function imageTag(app: { id: string; slug: string }, deploymentId: string): string {
  return `${imageRepository(app)}:${idPart(deploymentId)}`;
}

export function appVolume(app: { id: string }, name: string): string {
  return `ploy-vol-${idPart(app.id, 8)}-${name}`;
}

export function serviceContainer(service: { id: string; slug: string }): string {
  return `ploy-db-${service.slug.slice(0, 24).replace(/-+$/, '')}-${idPart(service.id, 6)}`;
}

export function serviceVolume(service: { id: string }): string {
  return `ploy-data-${idPart(service.id)}`;
}

export function cronContainer(cronJobId: string, runId: string): string {
  return `ploy-cron-${idPart(cronJobId, 8)}-${idPart(runId, 8)}`;
}
