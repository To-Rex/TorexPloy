/**
 * User cron jobs: scheduled one-off containers from an application's image.
 *
 * Each run starts a fresh container from the image of the application's
 * active deployment, with the same variables and project network as the app,
 * runs the command, streams its output to a durable log, and is removed when
 * it exits. A job never overlaps itself; a run that exceeds its timeout is
 * killed and marked failed.
 */
import type { Context } from '../context.ts';
import { emit } from '../context.ts';
import { APP_CAPABILITIES } from '../deploy/deployer.ts';
import { resolveAppEnv, withPlatformEnv } from '../deploy/env.ts';
import { LogWriter, logPath, removeLog } from '../deploy/logs.ts';
import { cronContainer, LABEL_APP, LABEL_MANAGED, LABEL_PROJECT, LABEL_ROLE, projectNetwork } from '../docker/naming.ts';
import { nextRunFor } from '../lib/cron.ts';
import { AppError, errorMessage } from '../lib/errors.ts';
import type { CronJobRecord, CronRunRecord } from '../store/index.ts';

const RUN_HISTORY = 50;

export class CronRunner {
  private readonly ctx: Context;
  private readonly active = new Map<string, AbortController>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** Called every minute by the scheduler. */
  async tick(now: Date = new Date()): Promise<void> {
    const { stores } = this.ctx;
    for (const job of stores.cron.listDue(now.toISOString())) {
      // Advance first, so a slow run or a crash cannot fire the same slot twice.
      stores.cron.update(job.id, { nextRunAt: nextRunFor(job.schedule, now).toISOString() });
      if (this.active.has(job.id) || stores.cron.isRunning(job.id)) continue;
      this.start(job, 'schedule');
    }
  }

  start(job: CronJobRecord, trigger: 'schedule' | 'manual'): CronRunRecord {
    if (this.active.has(job.id)) throw new AppError('conflict', 'This job is already running');
    const run = this.ctx.stores.cron.createRun(job.id, trigger);
    const controller = new AbortController();
    this.active.set(job.id, controller);
    this.emitJob(job);
    void this.execute(job, run, controller).finally(() => {
      this.active.delete(job.id);
      this.emitJob(job);
    });
    return run;
  }

  cancel(jobId: string): boolean {
    const controller = this.active.get(jobId);
    controller?.abort();
    return controller !== undefined;
  }

  private emitJob(job: CronJobRecord): void {
    const app = this.ctx.stores.applications.get(job.applicationId);
    if (app !== undefined) emit(this.ctx, app.teamId, { type: 'cron.updated', id: job.id, applicationId: app.id });
  }

  private async execute(job: CronJobRecord, run: CronRunRecord, controller: AbortController): Promise<void> {
    const { stores, config, connections } = this.ctx;
    const log = await LogWriter.open(logPath(config.dataDir, 'cron', run.id), run.id, this.ctx.bus);
    const name = cronContainer(job.id, run.id);
    let docker: Awaited<ReturnType<typeof connections.docker>> | null = null;
    let exitCode: number | null = null;
    const timeout = setTimeout(() => controller.abort(), job.timeoutSec * 1000);
    try {
      const app = stores.applications.get(job.applicationId);
      if (app === undefined) throw new AppError('not_found', 'Application not found');
      const active = app.activeDeploymentId === null ? undefined : stores.deployments.get(app.activeDeploymentId);
      if (active === undefined || active.imageTag === null) throw new AppError('nothing_to_deploy', 'The application has no successful deployment to run the job from');

      const resolved = resolveAppEnv(stores, app);
      log.mask(resolved.secrets);
      const env = withPlatformEnv(resolved.env, { PLOY_APP: app.slug, PLOY_CRON_JOB: job.name });
      docker = await connections.docker(app.serverId);
      const network = projectNetwork(app.projectId);
      log.info(`$ ${job.command}`);

      await docker.createContainer(name, {
        Image: active.imageTag,
        Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
        Cmd: ['sh', '-c', job.command],
        Entrypoint: [],
        Labels: { [LABEL_MANAGED]: 'true', [LABEL_ROLE]: 'cron', [LABEL_APP]: app.id, [LABEL_PROJECT]: app.projectId },
        HostConfig: {
          RestartPolicy: { Name: 'no' },
          Init: true,
          ...(app.memoryLimitMb === null ? {} : { Memory: app.memoryLimitMb * 1024 * 1024 }),
          ...(app.cpuLimit === null ? {} : { NanoCpus: Math.round(app.cpuLimit * 1e9) }),
          PidsLimit: 2048,
          CapDrop: ['ALL'],
          CapAdd: APP_CAPABILITIES,
          SecurityOpt: ['no-new-privileges:true'],
          LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '1' } },
          Mounts: stores.volumes.listForApplication(app.id).map((volume) => ({ Type: 'volume', Source: volume.dockerVolume, Target: volume.mountPath })),
          NetworkMode: network,
        },
      });
      await docker.startContainer(name);
      const output = await docker.containerLogs(name, { follow: true, tail: 'all', signal: controller.signal });
      const following = (async () => {
        for await (const chunk of output as AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }>) log.write(chunk.text, chunk.stream);
      })().catch(() => undefined);
      exitCode = await docker.waitContainer(name, controller.signal);
      await following;
      log.info(exitCode === 0 ? '✓ Finished' : `✗ Exited with code ${exitCode}`);
      stores.cron.finishRun(run.id, exitCode === 0 ? 'succeeded' : 'failed', exitCode);
    } catch (error) {
      const message = controller.signal.aborted ? `Stopped after exceeding the ${job.timeoutSec}s timeout or by request` : errorMessage(error);
      log.error(`✗ ${message}`);
      stores.cron.finishRun(run.id, 'failed', exitCode);
    } finally {
      clearTimeout(timeout);
      if (docker !== null) await docker.removeContainer(name, { force: true }).catch(() => undefined);
      await log.close();
      for (const id of stores.cron.pruneRuns(job.id, RUN_HISTORY)) await removeLog(logPath(config.dataDir, 'cron', id));
    }
  }

  /** Recompute next runs at boot (schedules may have been missed while the process was down). */
  initialize(): void {
    const { stores } = this.ctx;
    stores.cron.failInterrupted();
    const now = new Date();
    for (const job of stores.db.all('SELECT id FROM cron_jobs WHERE enabled = 1')) {
      const record = stores.cron.get(String(job.id));
      if (record === undefined) continue;
      try {
        stores.cron.update(record.id, { nextRunAt: nextRunFor(record.schedule, now).toISOString() });
      } catch {
        stores.cron.update(record.id, { enabled: false, nextRunAt: null });
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const controller of this.active.values()) controller.abort();
  }
}
