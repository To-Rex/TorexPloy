/**
 * Control-plane entry point.
 */
import { serve, type ServerType } from '@hono/node-server';
import { openDatabase } from './db/database.ts';
import { Deployer } from './deploy/deployer.ts';
import { Reconciler } from './deploy/reconciler.ts';
import { DomainChecker } from './domains/checker.ts';
import { GithubApp } from './github/app.ts';
import { createHttpApp } from './http/app.ts';
import { CronRunner } from './jobs/cron.ts';
import { Maintenance } from './jobs/maintenance.ts';
import { Scheduler } from './jobs/scheduler.ts';
import { loadConfig } from './lib/config.ts';
import { errorMessage } from './lib/errors.ts';
import { createLogger } from './lib/logger.ts';
import { Secrets } from './lib/secrets.ts';
import { MetricsCollector } from './metrics/collector.ts';
import { ProxyManager } from './proxy/manager.ts';
import { EventBus } from './realtime/bus.ts';
import { ConnectionManager } from './servers/connections.ts';
import { ServerManager } from './servers/manager.ts';
import { ServiceManager } from './services/manager.ts';
import { createStores } from './store/index.ts';
import type { Context } from './context.ts';

export async function createContext(overrides: Parameters<typeof loadConfig>[1] = {}): Promise<Context> {
  const config = loadConfig(process.env, overrides);
  const logger = createLogger({ level: config.logLevel, json: config.env === 'production', bindings: { service: 'torexploy' } });
  const db = openDatabase(config.databasePath);
  const secrets = new Secrets(config.secretKey);
  const stores = createStores(db, secrets);
  const bus = new EventBus();
  const connections = new ConnectionManager(config, stores, secrets, logger);
  const proxy = new ProxyManager(config, stores, connections, logger);

  // Collaborators reference each other through the context, so it is assembled in two steps.
  const ctx = { config, logger, stores, secrets, bus, connections, proxy, startedAt: Date.now() } as Context;
  ctx.servers = new ServerManager(ctx);
  ctx.deployer = new Deployer(ctx);
  ctx.reconciler = new Reconciler(ctx);
  ctx.services = new ServiceManager(ctx);
  ctx.github = new GithubApp(ctx);
  ctx.metrics = new MetricsCollector(ctx);
  ctx.domains = new DomainChecker(ctx);
  ctx.cron = new CronRunner(ctx);
  ctx.maintenance = new Maintenance(ctx);
  return ctx;
}

function schedule(ctx: Context): Scheduler {
  const scheduler = new Scheduler(ctx.logger);
  const minute = 60_000;
  scheduler.every('metrics', 15_000, () => ctx.metrics.collect(), 5_000);
  scheduler.every('servers', 30_000, () => ctx.servers.refresh());
  scheduler.every('reconcile', minute, () => ctx.reconciler.reconcileAll(), 20_000);
  scheduler.every('cron', 15_000, () => ctx.cron.tick());
  scheduler.every('backups', 30_000, () => ctx.maintenance.runBackups());
  scheduler.every('domains', 5 * minute, () => ctx.domains.sweep(), 2 * minute);
  scheduler.every('auth-prune', 10 * minute, () => ctx.maintenance.pruneAuth());
  scheduler.every('retention', 60 * minute, () => ctx.maintenance.pruneRetention(), 5 * minute);
  scheduler.every('workspaces', 30 * minute, () => ctx.maintenance.pruneWorkspaces(), 10 * minute);
  scheduler.every('docker-prune', 24 * 60 * minute, () => ctx.maintenance.pruneDocker(), 60 * minute);
  scheduler.every('wal-checkpoint', 30 * minute, () => ctx.stores.db.checkpoint());
  return scheduler;
}

async function start(): Promise<void> {
  const ctx = await createContext();
  const { config, logger, stores } = ctx;

  // Recovery before accepting work: interrupted deployments, runs and backups are closed out.
  ctx.deployer.recover();
  ctx.cron.initialize();
  stores.backups.failInterrupted();

  const app = createHttpApp(ctx);
  const server: ServerType = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    logger.info('TorexPloy is listening', { url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${info.port}`, version: config.version, dataDir: config.dataDir });
  });

  // Bring servers up in the background; the API is usable immediately.
  void (async () => {
    if (stores.users.count() > 0) await ctx.servers.bootstrapLocal().catch(() => undefined);
    for (const record of stores.servers.listAll()) {
      if (record.kind === 'ssh' && record.hostKey !== null) await ctx.servers.verify(record.id).catch(() => undefined);
    }
    for (const record of stores.servers.listAll()) {
      if (stores.servers.get(record.id)?.status === 'ready') ctx.reconciler.watch(record.id);
    }
    await ctx.reconciler.reconcileAll();
  })().catch((error) => logger.warn('Startup reconciliation failed', { error: errorMessage(error) }));

  const scheduler = schedule(ctx);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('Shutting down', { signal });
    scheduler.stop();
    ctx.reconciler.stopAll();
    ctx.domains.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx.cron.stopAll();
    await ctx.deployer.shutdown();
    await ctx.connections.closeAll();
    stores.db.checkpoint();
    stores.db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (error) => logger.error('Unhandled rejection', { error }));
}

if (import.meta.main) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
