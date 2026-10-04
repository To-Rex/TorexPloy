/**
 * One-click templates: the catalog and installation into a project.
 */
import type { Hono } from 'hono';
import { installTemplateSchema, type TemplateDto } from '@ploy/shared';
import { emit, type Context } from '../../context.ts';
import { TEMPLATES } from '../../templates/catalog.ts';
import { installTemplate } from '../../templates/install.ts';
import { audit, body, requireAuth, requireTeam, type Env } from '../core.ts';
import { applicationDto } from '../dto.ts';
import { loadProject } from './projects.ts';

const catalog: TemplateDto[] = TEMPLATES.map((template) => ({
  id: template.id,
  name: template.name,
  category: template.category,
  website: template.website,
  image: template.image,
  port: template.port,
  services: template.services.map((service) => service.type),
  volumes: template.volumes.length,
  needsUrl: template.needsUrl,
  memoryMb: template.memoryMb,
  access: template.access,
}));

export function registerTemplateRoutes(app: Hono<Env>, ctx: Context): void {
  app.get('/api/catalog/templates', (c) => {
    requireAuth(c);
    return c.json(catalog);
  });

  app.post('/api/projects/:id/templates', async (c) => {
    const project = loadProject(ctx, c, 'developer');
    const auth = requireTeam(c, 'developer');
    const input = await body(c, installTemplateSchema);
    const installed = installTemplate(ctx, project, auth.user, input);
    const { application, services, deployment } = installed;
    audit(ctx, c, 'template.installed', { type: 'application', id: application.id, name: application.name }, { template: input.templateId, services: services.map((service) => service.name) });
    for (const service of services) emit(ctx, project.teamId, { type: 'service.updated', id: service.id, projectId: project.id, status: service.status });
    emit(ctx, project.teamId, { type: 'application.updated', id: application.id, projectId: project.id, status: application.status });
    return c.json({ application: applicationDto(ctx, application), deploymentId: deployment.id }, 201);
  });
}
