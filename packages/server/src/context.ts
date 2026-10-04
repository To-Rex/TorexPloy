/**
 * The process-wide dependency graph.
 *
 * Built once in `main.ts`. Modules receive the whole context and reach their
 * collaborators through it lazily, which keeps construction order simple
 * (the deployer needs GitHub tokens; the GitHub webhook needs the deployer).
 */
import type { PlatformEvent } from '@ploy/shared';
import type { ComposeEngine } from './compose/engine.ts';
import type { Deployer } from './deploy/deployer.ts';
import type { Reconciler } from './deploy/reconciler.ts';
import type { DomainChecker } from './domains/checker.ts';
import type { GithubApp } from './github/app.ts';
import type { CronRunner } from './jobs/cron.ts';
import type { Maintenance } from './jobs/maintenance.ts';
import type { AppConfig } from './lib/config.ts';
import type { Logger } from './lib/logger.ts';
import type { Secrets } from './lib/secrets.ts';
import type { MetricsCollector } from './metrics/collector.ts';
import type { Notifier } from './notifications/notifier.ts';
import type { PreviewManager } from './previews/manager.ts';
import type { ProxyManager } from './proxy/manager.ts';
import type { EventBus } from './realtime/bus.ts';
import type { ConnectionManager } from './servers/connections.ts';
import type { ServerManager } from './servers/manager.ts';
import type { ServiceManager } from './services/manager.ts';
import type { Stores } from './store/index.ts';

export interface Context {
  config: AppConfig;
  logger: Logger;
  stores: Stores;
  secrets: Secrets;
  bus: EventBus;
  connections: ConnectionManager;
  proxy: ProxyManager;
  servers: ServerManager;
  deployer: Deployer;
  compose: ComposeEngine;
  reconciler: Reconciler;
  services: ServiceManager;
  github: GithubApp;
  metrics: MetricsCollector;
  domains: DomainChecker;
  cron: CronRunner;
  maintenance: Maintenance;
  notifier: Notifier;
  previews: PreviewManager;
  startedAt: number;
}

/** Publish to every team that can see a resource. `null` broadcasts (server events on the shared host). */
export function emit(ctx: Context, teamId: string | null, event: PlatformEvent): void {
  if (teamId !== null) {
    ctx.bus.emit(teamId, event);
    return;
  }
  for (const team of ctx.stores.db.all('SELECT id FROM teams')) ctx.bus.emit(String(team.id), event);
}
