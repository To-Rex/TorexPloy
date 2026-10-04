/**
 * Realtime event contract (Server-Sent Events).
 *
 * Events are invalidation signals, not state replicas: they name what changed
 * and carry just enough to update a badge instantly. The dashboard refetches
 * the authoritative resource, so a dropped event can never leave the UI wrong
 * for longer than one refetch.
 */
import type { AppStatus, DeploymentStatus, ServerStatus, ServiceStatus } from './constants.ts';

export type PlatformEvent =
  | { type: 'deployment.updated'; id: string; applicationId: string; projectId: string; status: DeploymentStatus }
  | { type: 'application.updated'; id: string; projectId: string; status: AppStatus }
  | { type: 'application.deleted'; id: string; projectId: string }
  | { type: 'service.updated'; id: string; projectId: string; status: ServiceStatus }
  | { type: 'service.deleted'; id: string; projectId: string }
  | { type: 'server.updated'; id: string; status: ServerStatus }
  | { type: 'domain.updated'; id: string; applicationId: string | null; serviceId: string | null }
  | { type: 'project.updated'; id: string }
  | { type: 'project.deleted'; id: string }
  | { type: 'backup.updated'; id: string; serviceId: string }
  | { type: 'cron.updated'; id: string; applicationId: string };

export type PlatformEventType = PlatformEvent['type'];

export const DEPLOY_STAGES = ['fetch', 'build', 'start', 'health', 'switch', 'drain'] as const;
export type DeployStage = (typeof DEPLOY_STAGES)[number];

/** One line of a build/deploy log as streamed to the browser. */
export interface LogLine {
  /** Monotonic within one log; lets the client de-duplicate replay and live tail. */
  seq: number;
  /** Unix epoch milliseconds. */
  t: number;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  /** Set on the line that opens a pipeline stage. */
  stage?: DeployStage;
}

/** Terminal marker for a deployment log stream. */
export interface LogEnd {
  status: DeploymentStatus;
}
