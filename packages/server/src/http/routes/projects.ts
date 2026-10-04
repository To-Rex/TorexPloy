/**
 * Projects, their shared variables and the team overview.
 */
import type { Hono } from 'hono';
import { createProjectSchema, putVariablesSchema, updateProjectSchema, type OverviewDto, type VariablesDto } from '@ploy/shared';
import { emit, type Context } from '../../context.ts';
import { projectNetwork } from '../../docker/naming.ts';
import { notFound } from '../../lib/errors.ts';
import type { ProjectRecord } from '../../store/index.ts';
import { audit, body, requireTeam, type Ctx, type Env } from '../core.ts';
import { applicationDto, projectDto, serviceDto, teamDeploymentDtos } from '../dto.ts';

export function loadProject(ctx: Context, c: Ctx, role: 'viewer' | 'developer' | 'admin', id: string = c.req.param('id')!): ProjectRecord {
  const auth = requireTeam(c, role);
  const project = ctx.stores.projects.get(id);
  if (project === undefined || project.teamId !== auth.teamId) throw notFound('Project');
  return project;
}

export function registerProjectRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;

  app.get('/api/overview', (c) => {
    const auth = requireTeam(c);
    const apps = stores.applications.listForTeam(auth.teamId);
    const services = stores.services.listForTeam(auth.teamId);
    const servers = stores.servers.listForTeam(auth.teamId);
    const projects = stores.projects.listForTeam(auth.teamId);
    const overview: OverviewDto = {
      projects: projects.length,
      applications: {
        total: apps.length,
        running: apps.filter((application) => application.status === 'running').length,
        failed: apps.filter((application) => application.status === 'failed' || application.status === 'crashed').length,
        building: apps.filter((application) => ['queued', 'building', 'deploying'].includes(application.status)).length,
      },
      services: { total: services.length, running: services.filter((service) => service.status === 'running').length },
      servers: { total: servers.length, ready: servers.filter((server) => server.status === 'ready').length },
      recentDeployments: teamDeploymentDtos(ctx, stores.deployments.recentForTeam(auth.teamId, 12)),
    };
    return c.json(overview);
  });

  app.get('/api/projects', (c) => {
    const auth = requireTeam(c);
    return c.json(stores.projects.listForTeam(auth.teamId).map(projectDto));
  });

  app.post('/api/projects', async (c) => {
    const auth = requireTeam(c, 'developer');
    const input = await body(c, createProjectSchema);
    const project = stores.projects.create(auth.teamId, input.name, input.description ?? null);
    audit(ctx, c, 'project.created', { type: 'project', id: project.id, name: project.name });
    emit(ctx, auth.teamId, { type: 'project.updated', id: project.id });
    return c.json(projectDto(stores.projects.getWithStats(project.id)!), 201);
  });

  app.get('/api/projects/:id', (c) => {
    const project = loadProject(ctx, c, 'viewer');
    return c.json({
      project: projectDto(stores.projects.getWithStats(project.id)!),
      applications: stores.applications.listForProject(project.id).map((application) => applicationDto(ctx, application)),
      services: stores.services.listForProject(project.id).map((service) => serviceDto(ctx, service)),
    });
  });

  app.patch('/api/projects/:id', async (c) => {
    const project = loadProject(ctx, c, 'developer');
    const input = await body(c, updateProjectSchema);
    stores.projects.update(project.id, input);
    audit(ctx, c, 'project.updated', { type: 'project', id: project.id, name: input.name ?? project.name });
    emit(ctx, project.teamId, { type: 'project.updated', id: project.id });
    return c.json(projectDto(stores.projects.getWithStats(project.id)!));
  });

  app.delete('/api/projects/:id', async (c) => {
    const project = loadProject(ctx, c, 'admin');
    const removeData = c.req.query('removeData') === 'true';
    const servers = new Set<string>();
    for (const application of stores.applications.listForProject(project.id)) {
      servers.add(application.serverId);
      // Previews first: the cascade would delete their rows but leave their containers running.
      for (const preview of stores.applications.listPreviews(application.id)) {
        await ctx.deployer.destroy(preview, true);
        stores.metrics.deleteOwner(preview.id);
      }
      await ctx.deployer.destroy(application, removeData);
      stores.metrics.deleteOwner(application.id);
    }
    for (const service of stores.services.listForProject(project.id)) {
      servers.add(service.serverId);
      await ctx.services.destroy(service, removeData);
      stores.metrics.deleteOwner(service.id);
    }
    stores.projects.delete(project.id);
    for (const serverId of servers) {
      await ctx.proxy.requestSync(serverId).catch(() => undefined);
      const docker = await ctx.connections.docker(serverId).catch(() => null);
      if (docker !== null) {
        // The proxy must leave the network before Docker lets it be removed.
        await docker.call('POST', `/networks/${projectNetwork(project.id)}/disconnect`, { body: { Container: 'ploy-proxy', Force: true } }).catch(() => undefined);
        await docker.removeNetwork(projectNetwork(project.id)).catch(() => undefined);
      }
    }
    audit(ctx, c, 'project.deleted', { type: 'project', id: project.id, name: project.name }, { removeData });
    emit(ctx, project.teamId, { type: 'project.deleted', id: project.id });
    return c.json({ ok: true });
  });

  app.get('/api/projects/:id/variables', (c) => {
    const project = loadProject(ctx, c, 'developer');
    const variables: VariablesDto = {
      variables: stores.env.list({ projectId: project.id }),
      inherited: [],
      updatedAt: stores.env.updatedAt({ projectId: project.id }),
    };
    return c.json(variables);
  });

  app.put('/api/projects/:id/variables', async (c) => {
    const project = loadProject(ctx, c, 'developer');
    const input = await body(c, putVariablesSchema);
    if (stores.env.replace({ projectId: project.id }, input.variables)) {
      stores.applications.markConfigChangedForProject(project.id);
      audit(ctx, c, 'project.variables_updated', { type: 'project', id: project.id, name: project.name }, { count: input.variables.length });
      for (const application of stores.applications.listForProject(project.id)) {
        emit(ctx, project.teamId, { type: 'application.updated', id: application.id, projectId: project.id, status: application.status });
      }
    }
    return c.json({ variables: stores.env.list({ projectId: project.id }), inherited: [], updatedAt: stores.env.updatedAt({ projectId: project.id }) });
  });
}
