/**
 * Installing a template: the services, the app, its links, volumes,
 * variables and address, then the first deployment — as one operation that
 * leaves nothing half-made when validation fails.
 */
import type { InstallTemplateInput } from '@ploy/shared';
import type { Context } from '../context.ts';
import { canGenerateDomain, generateDomain } from '../domains/generate.ts';
import { appVolume } from '../docker/naming.ts';
import { generateToken } from '../lib/crypto.ts';
import { AppError } from '../lib/errors.ts';
import type { ApplicationRecord, DeploymentRecord, ProjectRecord, ServiceRecord, UserRecord } from '../store/index.ts';
import { findTemplate, templateSecret } from './catalog.ts';

export interface InstalledTemplate {
  application: ApplicationRecord;
  services: ServiceRecord[];
  deployment: DeploymentRecord;
}

export function installTemplate(ctx: Context, project: ProjectRecord, user: UserRecord, input: InstallTemplateInput): InstalledTemplate {
  const { stores } = ctx;
  const template = findTemplate(input.templateId);
  if (template === undefined) throw new AppError('not_found', 'Unknown template', { params: { resource: 'template' } });
  const server = stores.servers.getForTeam(project.teamId, input.serverId);
  if (server === undefined) throw new AppError('validation_failed', 'Unknown server', { issues: [{ path: 'serverId', code: 'custom', message: 'Unknown server' }] });
  if (input.domain !== undefined && stores.domains.findByHost(input.domain) !== undefined) {
    throw new AppError('domain_taken', 'This domain is already in use', { params: { host: input.domain } });
  }
  if (template.needsUrl && input.domain === undefined && !canGenerateDomain(ctx, server.id)) {
    throw new AppError('validation_failed', 'This template needs a domain', {
      issues: [{ path: 'domain', code: 'custom', message: 'A domain is required', params: { reason: 'domain_required' } }],
    });
  }

  const name = (input.name ?? template.name).slice(0, 48);
  return stores.db.transaction(() => {
    const created = stores.applications.create({
      projectId: project.id,
      teamId: project.teamId,
      serverId: server.id,
      name,
      slug: stores.projects.uniqueResourceSlug(project.id, name, 'app'),
      kind: 'web',
      sourceType: 'image',
      githubInstallationId: null,
      repository: null,
      gitUrl: null,
      branch: null,
      image: template.image,
      port: template.port,
      templateId: template.id,
      sealedHookToken: ctx.secrets.seal(generateToken(24), 'hook'),
    });
    const application = stores.applications.update(created.id, { healthCheckPath: template.healthCheckPath, healthCheckTimeoutSec: template.healthCheckTimeoutSec });

    const domain =
      input.domain === undefined
        ? generateDomain(ctx, application, project)
        : stores.domains.create({ applicationId: application.id, teamId: application.teamId, host: input.domain, https: true, port: null, isGenerated: false });
    if (input.domain !== undefined && domain !== null) ctx.domains.followUp(domain.id);

    const services = template.services.map((spec) => {
      const service = ctx.services.create(project, { type: spec.type, version: spec.version, name: `${name}-${spec.key}`, serverId: server.id });
      stores.links.create(application.id, service.id, spec.prefix);
      return service;
    });
    for (const volume of template.volumes) stores.volumes.create(application.id, volume.name, volume.mountPath, appVolume(application, volume.name));

    const env = template.env({
      url: domain === null ? null : `${domain.https ? 'https' : 'http'}://${domain.host}`,
      host: domain?.host ?? null,
      https: domain?.https ?? false,
      email: user.email,
      timezone: ctx.config.timezone,
      secret: templateSecret,
    });
    stores.env.replace({ applicationId: application.id }, Object.entries(env).map(([key, value]) => ({ key, value })));
    stores.projects.touch(project.id);

    const deployment = ctx.deployer.enqueue({ app: stores.applications.get(application.id)!, trigger: 'manual', createdBy: user.id });
    return { application: stores.applications.get(application.id)!, services, deployment };
  });
}
