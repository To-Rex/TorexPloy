/**
 * Realtime: one EventSource per tab, turning platform events into precise
 * cache invalidations. The browser reconnects automatically; the connection
 * state is exposed for the "live" indicator.
 */
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { PlatformEvent } from '@ploy/shared';
import { keys } from './queries.ts';

export type LiveState = 'connecting' | 'open' | 'reconnecting';

export function applyEvent(client: QueryClient, event: PlatformEvent): void {
  const invalidate = (queryKey: readonly unknown[]) => void client.invalidateQueries({ queryKey });
  switch (event.type) {
    case 'deployment.updated':
      invalidate(keys.deployment(event.id));
      invalidate(keys.app(event.applicationId));
      invalidate(keys.project(event.projectId));
      invalidate(keys.overview);
      break;
    case 'application.updated':
      invalidate(keys.app(event.id));
      invalidate(keys.project(event.projectId));
      invalidate(keys.projects);
      invalidate(keys.apps);
      invalidate(keys.overview);
      break;
    case 'application.deleted':
      client.removeQueries({ queryKey: keys.app(event.id) });
      invalidate(keys.project(event.projectId));
      invalidate(keys.projects);
      invalidate(keys.apps);
      break;
    case 'service.updated':
      invalidate(keys.service(event.id));
      invalidate(keys.project(event.projectId));
      invalidate(keys.projects);
      invalidate(keys.overview);
      break;
    case 'service.deleted':
      client.removeQueries({ queryKey: keys.service(event.id) });
      invalidate(keys.project(event.projectId));
      invalidate(keys.projects);
      break;
    case 'server.updated':
      invalidate(keys.servers);
      invalidate(keys.server(event.id));
      invalidate(keys.overview);
      break;
    case 'domain.updated':
      invalidate(keys.appPart(event.applicationId, 'domains'));
      invalidate(keys.app(event.applicationId));
      break;
    case 'project.updated':
    case 'project.deleted':
      invalidate(keys.projects);
      invalidate(keys.project(event.id));
      break;
    case 'backup.updated':
      invalidate(keys.servicePart(event.serviceId, 'backups'));
      break;
    case 'cron.updated':
      invalidate(keys.appPart(event.applicationId, 'cron'));
      break;
  }
}

export function useRealtime(teamId: string | null): LiveState {
  const client = useQueryClient();
  const [state, setState] = useState<LiveState>('connecting');

  useEffect(() => {
    if (teamId === null) return;
    const source = new EventSource('/api/events');
    source.addEventListener('ready', () => setState('open'));
    source.addEventListener('event', (message) => {
      try {
        applyEvent(client, JSON.parse((message as MessageEvent<string>).data) as PlatformEvent);
      } catch {
        // malformed event: ignore
      }
    });
    source.onerror = () => {
      setState('reconnecting');
      // After a reconnect anything may have changed; refetch what is on screen.
      source.addEventListener('ready', () => void client.invalidateQueries(), { once: true });
    };
    return () => source.close();
  }, [client, teamId]);

  return state;
}
