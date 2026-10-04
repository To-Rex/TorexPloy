/**
 * Pull request previews of an application: their settings, the list, and
 * redeploying or removing one. Previews are applications themselves, so their
 * logs, deployments and domains use the ordinary application routes.
 */
import type { Hono } from 'hono';
import type { PreviewSettingsDto } from '@ploy/shared';
import type { Context } from '../../context.ts';
import { notFound } from '../../lib/errors.ts';
import { audit, requireTeam, type Ctx, type Env } from '../core.ts';
import { deploymentDto, previewDto } from '../dto.ts';
import { loadApp } from './applications.ts';

export function registerPreviewRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;

  const loadPreview = (c: Ctx) => {
    const parent = loadApp(ctx, c, 'developer');
    const preview = stores.applications.getForTeam(requireTeam(c).teamId, c.req.param('previewId')!);
    if (preview === undefined || preview.parentApplicationId !== parent.id) throw notFound('Preview');
    return { parent, preview };
  };

  /** Preview settings are edited with `PATCH /api/applications/:id` (`previewsEnabled`, `previewLimit`, `previewEnv`). */
  app.get('/api/applications/:id/preview-settings', (c) => {
    const application = loadApp(ctx, c, 'developer');
    const settings: PreviewSettingsDto = {
      enabled: application.previewsEnabled,
      limit: application.previewLimit,
      env: application.previewEnvSealed === null ? '' : ctx.secrets.open(application.previewEnvSealed, 'env'),
      webhookReady: ctx.github.webhookReady(),
    };
    return c.json(settings);
  });

  app.get('/api/applications/:id/previews', (c) => {
    const application = loadApp(ctx, c, 'viewer');
    return c.json(stores.applications.listPreviews(application.id).map((preview) => previewDto(ctx, preview)));
  });

  app.post('/api/applications/:id/previews/:previewId/redeploy', (c) => {
    const { preview } = loadPreview(c);
    const deployment = ctx.previews.redeploy(preview, requireTeam(c).user.id);
    audit(ctx, c, 'application.deploy', { type: 'application', id: preview.id, name: preview.name }, { deploymentId: deployment.id, pullRequest: preview.previewPrNumber });
    return c.json(deploymentDto(deployment, stores.applications.get(preview.id)), 202);
  });

  app.delete('/api/applications/:id/previews/:previewId', async (c) => {
    const { parent, preview } = loadPreview(c);
    await ctx.previews.remove(preview);
    audit(ctx, c, 'preview.deleted', { type: 'application', id: preview.id, name: preview.name }, { parentId: parent.id, pullRequest: preview.previewPrNumber });
    return c.json({ ok: true });
  });
}
