/**
 * Periodic resource sampling.
 *
 * Every 15 seconds, for each ready server: one host reading and one stats
 * sample per running platform container. Container samples are summed per
 * application (across replicas) or service. CPU and network rates are derived
 * from consecutive cumulative counters, which is why the Engine API's
 * `one-shot` mode (no built-in 1s wait) is enough.
 */
import type { Context } from '../context.ts';
import { cpuPercent, memoryUsage, networkTotals, type StatsSample } from '../docker/client.ts';
import { LABEL_APP, LABEL_MANAGED, LABEL_ROLE, LABEL_SERVICE } from '../docker/naming.ts';
import { errorMessage } from '../lib/errors.ts';
import type { AppSample } from '../store/index.ts';

interface Previous {
  sample: StatsSample;
  at: number;
  rx: number;
  tx: number;
}

const STATS_CONCURRENCY = 6;

export class MetricsCollector {
  private readonly ctx: Context;
  private readonly previous = new Map<string, Previous>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  async collect(): Promise<void> {
    for (const server of this.ctx.stores.servers.listAll()) {
      if (server.status !== 'ready') continue;
      await this.collectServer(server.id).catch((error) =>
        this.ctx.logger.debug('Metrics collection failed', { serverId: server.id, error: errorMessage(error) }),
      );
    }
  }

  private async collectServer(serverId: string): Promise<void> {
    const { stores } = this.ctx;
    const server = stores.servers.get(serverId);
    if (server === undefined) return;
    const now = Date.now();

    const host = await this.ctx.servers.hostReading(server).catch(() => null);
    if (host !== null) {
      stores.metrics.insertHost({
        serverId,
        t: now,
        cpu: Math.round(host.cpu * 10) / 10,
        memUsed: host.reading.memTotal - host.reading.memAvailable,
        memTotal: host.reading.memTotal,
        diskUsed: host.reading.diskUsed,
        diskTotal: host.reading.diskTotal,
        load1: host.reading.load1,
      });
    }

    const docker = await this.ctx.connections.docker(serverId);
    const containers = await docker.listContainers({ label: [`${LABEL_MANAGED}=true`], status: ['running'] }, false);
    const totals = new Map<string, AppSample>();
    const seen = new Set<string>();

    const queue = containers.filter((container) => container.Labels[LABEL_ROLE] === 'app' || container.Labels[LABEL_ROLE] === 'service');
    const work = async (): Promise<void> => {
      for (let container = queue.shift(); container !== undefined; container = queue.shift()) {
        const owner = container.Labels[LABEL_ROLE] === 'app' ? container.Labels[LABEL_APP] : container.Labels[LABEL_SERVICE];
        if (owner === undefined) continue;
        const sample = await docker.containerStats(container.Id).catch(() => null);
        if (sample === null || sample.cpu_stats === undefined) continue;
        seen.add(container.Id);
        const net = networkTotals(sample);
        const previous = this.previous.get(container.Id);
        this.previous.set(container.Id, { sample, at: now, rx: net.rx, tx: net.tx });
        const seconds = previous === undefined ? 0 : (now - previous.at) / 1000;
        const total = totals.get(owner) ?? { ownerId: owner, t: now, cpu: 0, mem: 0, memLimit: 0, rx: 0, tx: 0 };
        total.cpu += previous === undefined ? 0 : cpuPercent(previous.sample, sample);
        total.mem += memoryUsage(sample);
        total.memLimit += sample.memory_stats.limit ?? 0;
        if (previous !== undefined && seconds > 0) {
          total.rx += Math.max(0, (net.rx - previous.rx) / seconds);
          total.tx += Math.max(0, (net.tx - previous.tx) / seconds);
        }
        totals.set(owner, total);
      }
    };
    await Promise.all(Array.from({ length: STATS_CONCURRENCY }, work));

    for (const id of this.previous.keys()) if (!seen.has(id) && !containers.some((container) => container.Id === id)) this.previous.delete(id);
    stores.metrics.insertApps(
      [...totals.values()].map((sample) => ({ ...sample, cpu: Math.round(sample.cpu * 10) / 10, rx: Math.round(sample.rx), tx: Math.round(sample.tx) })),
    );
  }

  prune(): number {
    const days = this.ctx.stores.settings.platform().metricsRetentionDays;
    return this.ctx.stores.metrics.prune(Date.now() - days * 24 * 3_600_000);
  }
}
