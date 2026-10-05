/**
 * Self-update: what is running, what the tracked branch has, and the one-click updater.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { roleAtLeast, type UpdateMode, type UpdateProgressDto, type UpdateState, type UpdateStatusDto } from '@ploy/shared';
import type { Context } from '../../context.ts';
import { AppError, forbidden, notFound } from '../../lib/errors.ts';
import { launchUpdater, UPDATER_CONTAINER, updaterState } from '../../updates/launcher.ts';
import { parseProgress, stripTimestamps } from '../../updates/progress.ts';
import { audit, requireAuth, requireInstanceAdmin, type Auth, type Ctx, type Env } from '../core.ts';

/** Administrators see update state: the instance administrator, or an admin/owner of the current team. */
export function canSeeUpdates(auth: Auth | null): boolean {
  return auth !== null && (auth.user.isInstanceAdmin || (auth.role !== null && roleAtLeast(auth.role, 'admin')));
}

function requireUpdateViewer(c: Ctx): Auth {
  const auth = requireAuth(c);
  if (!canSeeUpdates(auth)) throw forbidden('Only administrators can see updates');
  return auth;
}

export function registerUpdateRoutes(app: Hono<Env>, ctx: Context): void {
  const status = async (auth: Auth): Promise<UpdateStatusDto> => {
    const { config, updates } = ctx;
    const check = updates.result;
    const self = await updates.self.locate();
    const mode: UpdateMode = self === null ? 'manual' : config.updates.image === null ? 'source' : 'image';
    let state: UpdateState = updates.checking ? 'checking' : 'idle';
    let error: string | null = null;
    let progress: UpdateProgressDto | null = null;
    if (self !== null) {
      const docker = await updates.self.docker();
      const updater = docker === null ? null : await updaterState(docker).catch(() => null);
      if (updater !== null && updater.state !== 'idle') {
        state = updater.state;
        error = updater.error;
        progress = updater.progress;
      }
    }
    return {
      current: { version: config.version, commit: config.commit, builtAt: config.builtAt },
      latest: check.latest,
      available: check.available,
      checkedAt: check.checkedAt,
      checkError: check.checkError,
      commits: check.commits,
      mode,
      repository: config.updates.repository,
      branch: config.updates.branch,
      image: config.updates.image,
      state,
      error,
      progress,
      canApply: auth.user.isInstanceAdmin && mode !== 'manual' && check.available && state !== 'updating',
    };
  };

  app.get('/api/updates', async (c) => c.json(await status(requireUpdateViewer(c))));

  /**
   * The updater's output as it happens: every line, with the progress markers
   * turned into structured fields. The stream ends with the updater's outcome;
   * while the panel itself is being replaced the connection drops and the
   * dashboard reconnects to whichever control plane answers next.
   */
  app.get('/api/updates/log', async (c) => {
    requireUpdateViewer(c);
    const docker = await ctx.updates.self.docker();
    const inspect = docker === null ? null : await docker.inspectContainer(UPDATER_CONTAINER);
    if (docker === null || inspect === null) throw notFound('Updater');
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      const keepAlive = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }).catch(() => controller.abort()), 25_000);
      let seq = 0;
      await stream.writeSSE({ event: 'meta', data: JSON.stringify({ updater: inspect.Id.slice(0, 12) }) });
      try {
        const output = await docker.containerLogs(inspect.Id, { follow: true, tail: 'all', timestamps: true, signal: controller.signal });
        for await (const chunk of output as AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }>) {
          for (const raw of chunk.text.split('\n')) {
            if (raw.length === 0) continue;
            const space = raw.indexOf(' ');
            const t = Date.parse(raw.slice(0, space));
            const text = stripTimestamps(raw);
            const progress = parseProgress(text);
            seq += 1;
            await stream.writeSSE({
              event: 'line',
              data: JSON.stringify({ seq, t: Number.isNaN(t) ? Date.now() : t, stream: chunk.stream, text: progress === null ? text : `▸ ${progress.message}`, ...(progress === null ? {} : { progress }) }),
            });
          }
        }
      } catch {
        // Container gone or client disconnected.
      }
      clearInterval(keepAlive);
      const final = await docker.inspectContainer(inspect.Id).catch(() => null);
      const status = final === null ? 'succeeded' : final.State.Running || final.State.Restarting ? 'running' : final.State.ExitCode === 0 ? 'succeeded' : 'failed';
      await stream.writeSSE({ event: 'end', data: JSON.stringify({ status }) }).catch(() => undefined);
    });
  });

  app.post('/api/updates/check', async (c) => {
    const auth = requireUpdateViewer(c);
    const result = await ctx.updates.check();
    audit(ctx, c, 'platform.update_checked', { type: 'platform', teamId: null }, { available: result.available, latest: result.latest?.commit ?? null, error: result.checkError });
    return c.json(await status(auth));
  });

  app.post('/api/updates/apply', async (c) => {
    requireInstanceAdmin(c);
    const { updates, config } = ctx;
    const self = await updates.self.locate();
    if (self === null) {
      throw new AppError('update_unsupported', 'The panel does not run in Docker or its container was not found; update it with deploy/install.sh', {
        params: { reason: updates.self.inDocker ? 'container_not_found' : 'not_in_docker' },
      });
    }
    const docker = (await updates.self.docker())!;
    if ((await updaterState(docker)).state === 'updating') throw new AppError('update_in_progress', 'An update is already running');
    const check = updates.result;
    if (!check.available || check.latest === null) throw new AppError('bad_request', 'Already up to date', { params: { reason: 'up_to_date' } });

    const mode = config.updates.image === null ? 'source' : 'image';
    const id = await launchUpdater(docker, self, config, check.latest.commit);
    audit(ctx, c, 'platform.update_started', { type: 'platform', teamId: null }, { commit: check.latest.commit, mode, repository: config.updates.repository, branch: config.updates.branch, image: config.updates.image });
    ctx.logger.info('Update started', { commit: check.latest.commit.slice(0, 7), mode, updater: id.slice(0, 12), target: self.name });
    return c.json({ ok: true }, 202);
  });
}
