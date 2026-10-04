/**
 * Self-update: what is running, what the tracked branch has, and the one-click updater.
 */
import type { Hono } from 'hono';
import { roleAtLeast, type UpdateMode, type UpdateState, type UpdateStatusDto } from '@ploy/shared';
import type { Context } from '../../context.ts';
import { AppError, forbidden } from '../../lib/errors.ts';
import { launchUpdater, updaterState } from '../../updates/launcher.ts';
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
    if (self !== null) {
      const docker = await updates.self.docker();
      const updater = docker === null ? null : await updaterState(docker).catch(() => null);
      if (updater !== null && updater.state !== 'idle') {
        state = updater.state;
        error = updater.error;
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
      canApply: auth.user.isInstanceAdmin && mode !== 'manual' && check.available && state !== 'updating',
    };
  };

  app.get('/api/updates', async (c) => c.json(await status(requireUpdateViewer(c))));

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
