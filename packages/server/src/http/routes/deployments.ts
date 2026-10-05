/**
 * Deployments: the team-wide list, and individual ones (detail, live log,
 * cancel, redeploy/rollback).
 */
import type { Hono } from 'hono';
import { ACTIVE_DEPLOYMENT_STATUSES, deploymentListQuerySchema, isTerminalDeployment, type DeploymentCleanupDto, type Page, type TeamDeploymentDto } from '@ploy/shared';
import type { Context } from '../../context.ts';
import { logPath, readLog } from '../../deploy/logs.ts';
import { notFound } from '../../lib/errors.ts';
import { audit, query, requireTeam, type Ctx, type Env } from '../core.ts';
import { deploymentDto, teamDeploymentDtos } from '../dto.ts';
import { loadApp, streamLog } from './applications.ts';

export function registerDeploymentRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;

  const load = (c: Ctx, role: 'viewer' | 'developer') => {
    const auth = requireTeam(c, role);
    const deployment = stores.deployments.getForTeam(auth.teamId, c.req.param('id')!);
    if (deployment === undefined) throw notFound('Deployment');
    return { auth, deployment, application: stores.applications.get(deployment.applicationId) };
  };

  /** Every deployment of the team, newest first. `status=active` matches the ones still in flight. */
  app.get('/api/deployments', (c) => {
    const auth = requireTeam(c);
    const { cursor, limit, status } = query(c, deploymentListQuerySchema);
    const statuses = status === undefined ? [] : status === 'active' ? ACTIVE_DEPLOYMENT_STATUSES : [status];
    const page = stores.deployments.pageForTeam(auth.teamId, cursor, limit, statuses);
    const body: Page<TeamDeploymentDto> = { items: teamDeploymentDtos(ctx, page.items), nextCursor: page.nextCursor };
    return c.json(body);
  });

  app.get('/api/deployments/:id', (c) => {
    const { deployment } = load(c, 'viewer');
    return c.json(teamDeploymentDtos(ctx, [deployment])[0]!);
  });

  /** Live log as Server-Sent Events: full replay, then follow until the deployment finishes. */
  app.get('/api/deployments/:id/log', (c) => {
    const { deployment } = load(c, 'viewer');
    const path = logPath(ctx.config.dataDir, 'deployments', deployment.id);
    return streamLog(
      c,
      ctx,
      path,
      deployment.id,
      () => {
        const current = stores.deployments.get(deployment.id);
        return current === undefined || (isTerminalDeployment(current.status) && !ctx.deployer.isRunning(current.applicationId));
      },
      () => stores.deployments.get(deployment.id)?.status ?? 'failed',
    );
  });

  /** Plain-text download of the complete log. */
  app.get('/api/deployments/:id/log.txt', async (c) => {
    const { deployment } = load(c, 'viewer');
    const lines = await readLog(logPath(ctx.config.dataDir, 'deployments', deployment.id));
    const text = lines.map((line) => `${new Date(line.t).toISOString()} ${line.text}`).join('\n');
    return c.body(`${text}\n`, 200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${deployment.id}.log"`,
    });
  });

  app.post('/api/deployments/:id/cancel', (c) => {
    const { deployment, application } = load(c, 'developer');
    const cancelled = ctx.deployer.cancel(deployment.id);
    if (cancelled) audit(ctx, c, 'deployment.cancelled', { type: 'deployment', id: deployment.id, name: application?.name ?? null });
    return c.json({ cancelled });
  });

  app.post('/api/deployments/:id/redeploy', (c) => {
    const { auth, deployment, application } = load(c, 'developer');
    if (application === undefined) throw notFound('Application');
    const next = ctx.deployer.redeploy(application, deployment, auth.user.id);
    audit(ctx, c, next.trigger === 'rollback' ? 'deployment.rollback' : 'deployment.redeploy', { type: 'deployment', id: next.id, name: application.name }, { from: deployment.id });
    return c.json(deploymentDto(next, application), 202);
  });

  /** Delete one finished, non-active deployment: its log, its containers and (when nothing else uses it) its image. */
  app.delete('/api/deployments/:id', async (c) => {
    const { deployment, application } = load(c, 'developer');
    if (application === undefined) throw notFound('Application');
    const result = await ctx.deployer.deleteDeployment(application, deployment);
    audit(ctx, c, 'deployment.deleted', { type: 'deployment', id: deployment.id, name: application.name }, { number: deployment.seq, imageRemoved: result.imageRemoved });
    return c.json({ deleted: true, ...result });
  });

  /** What a clean-up would remove: every finished deployment except the active one and the newest. */
  app.get('/api/applications/:id/deployments/cleanup', (c) => {
    const application = loadApp(ctx, c, 'viewer');
    const plan = ctx.deployer.cleanupPlan(application);
    const body: DeploymentCleanupDto = { removable: plan.removable.length, keptActive: plan.active?.seq ?? null, keptNewest: plan.newest?.seq ?? null };
    return c.json(body);
  });

  app.post('/api/applications/:id/deployments/cleanup', async (c) => {
    const application = loadApp(ctx, c, 'developer');
    const result = await ctx.deployer.cleanupHistory(application);
    audit(ctx, c, 'deployment.cleanup', { type: 'application', id: application.id, name: application.name }, result);
    return c.json(result);
  });
}
