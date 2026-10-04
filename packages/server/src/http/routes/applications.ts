/**
 * Applications and everything attached to them.
 */
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  createApplicationSchema,
  composeServiceSchema,
  createCronJobSchema,
  createDomainSchema,
  createLinkSchema,
  createVolumeSchema,
  deployRequestSchema,
  LIMITS,
  METRIC_RANGE_WINDOWS,
  paginationSchema,
  portSchema,
  putVariablesSchema,
  updateApplicationSchema,
  updateCronJobSchema,
  updateDomainSchema,
  type ContainerDto,
  type SourceInput,
  type VariablesDto,
} from '@ploy/shared';
import { previewBuildPlan } from '../../build/plan.ts';
import { requireBuilder } from '../../build/tools.ts';
import { emit, type Context } from '../../context.ts';
import { resolveAppEnv } from '../../deploy/env.ts';
import { generateDomain } from '../../domains/generate.ts';
import { logPath, readLog, removeLog } from '../../deploy/logs.ts';
import { appVolume } from '../../docker/naming.ts';
import { generateToken } from '../../lib/crypto.ts';
import { CronError, nextRunFor } from '../../lib/cron.ts';
import { AppError, notFound } from '../../lib/errors.ts';
import { generateKeyPair } from '../../servers/ssh.ts';
import type { ApplicationPatch, ApplicationRecord } from '../../store/index.ts';
import { audit, body, logWindow, query, requireTeam, type Ctx, type Env } from '../core.ts';
import { applicationDto, cronJobDto, cronRunDto, deploymentDto, domainDto, linkDto, teamCronJobDto, volumeDto } from '../dto.ts';
import { loadProject } from './projects.ts';
import { rangeQuery } from './servers.ts';

type Role = 'viewer' | 'developer' | 'admin';

export function loadApp(ctx: Context, c: Ctx, role: Role, id: string = c.req.param('id')!): ApplicationRecord {
  const auth = requireTeam(c, role);
  const app = ctx.stores.applications.getForTeam(auth.teamId, id);
  if (app === undefined) throw notFound('Application');
  return app;
}

function cronSchedule(expression: string): string {
  try {
    return nextRunFor(expression).toISOString();
  } catch (error) {
    throw new AppError('validation_failed', 'Invalid schedule', {
      issues: [{ path: 'schedule', code: 'invalid_format', message: error instanceof CronError ? error.message : 'Invalid schedule', params: { format: 'cron' } }],
    });
  }
}

export function registerApplicationRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;

  const changed = (application: ApplicationRecord): void => {
    const current = stores.applications.get(application.id) ?? application;
    emit(ctx, current.teamId, { type: 'application.updated', id: current.id, projectId: current.projectId, status: current.status });
  };

  /** Check a source belongs to things this team may use, and normalize it into columns. */
  const sourceColumns = (teamId: string, source: SourceInput): Pick<ApplicationRecord, 'sourceType' | 'githubInstallationId' | 'repository' | 'gitUrl' | 'branch' | 'image'> => {
    if (source.type === 'github') {
      const installation = stores.installations.get(source.installationId);
      if (installation === undefined || installation.teamId !== teamId) {
        throw new AppError('validation_failed', 'Unknown GitHub installation', { issues: [{ path: 'source.installationId', code: 'custom', message: 'Connect this GitHub account first' }] });
      }
      return { sourceType: 'github', githubInstallationId: source.installationId, repository: source.repository, gitUrl: null, branch: source.branch, image: null };
    }
    if (source.type === 'git') return { sourceType: 'git', githubInstallationId: null, repository: null, gitUrl: source.url, branch: source.branch, image: null };
    return { sourceType: 'image', githubInstallationId: null, repository: null, gitUrl: null, branch: null, image: source.image };
  };

  // ------------------------------------------------------------------ CRUD

  app.get('/api/applications', (c) => {
    const auth = requireTeam(c);
    return c.json(stores.applications.listForTeam(auth.teamId).map((application) => applicationDto(ctx, application)));
  });

  app.post('/api/projects/:id/applications', async (c) => {
    const project = loadProject(ctx, c, 'developer');
    const auth = requireTeam(c, 'developer');
    const input = await body(c, createApplicationSchema);
    const server = stores.servers.getForTeam(auth.teamId, input.serverId);
    if (server === undefined) throw new AppError('validation_failed', 'Unknown server', { issues: [{ path: 'serverId', code: 'custom', message: 'Unknown server' }] });

    const source = sourceColumns(auth.teamId, input.source);
    if (input.build?.buildType !== undefined) requireBuilder(input.build.buildType);
    const hookToken = generateToken(24);
    const application = stores.applications.create({
      projectId: project.id,
      teamId: project.teamId,
      serverId: server.id,
      name: input.name,
      slug: stores.projects.uniqueResourceSlug(project.id, input.name, 'app'),
      kind: input.kind,
      ...source,
      ...(input.build ?? {}),
      port: input.port ?? null,
      sealedHookToken: ctx.secrets.seal(hookToken, 'hook'),
    });
    if (source.sourceType === 'git' && source.gitUrl?.startsWith('git@')) {
      const keys = await generateKeyPair(`torexploy-${application.slug}`);
      stores.applications.setDeployKey(application.id, ctx.secrets.seal(keys.privateKey, 'ssh'), keys.publicKey);
    }
    if (application.kind === 'web') generateDomain(ctx, application, project);
    stores.projects.touch(project.id);
    audit(ctx, c, 'application.created', { type: 'application', id: application.id, name: application.name }, { source: source.sourceType });
    changed(application);

    // Deploy right away unless the source is a private git repo whose deploy key the user still has to install.
    const needsKey = source.sourceType === 'git' && source.gitUrl?.startsWith('git@') === true;
    const deployment = needsKey ? null : ctx.deployer.enqueue({ app: stores.applications.get(application.id)!, trigger: 'manual', createdBy: auth.user.id });
    return c.json({ application: applicationDto(ctx, stores.applications.get(application.id)!), deploymentId: deployment?.id ?? null }, 201);
  });

  app.get('/api/applications/:id', (c) => c.json(applicationDto(ctx, loadApp(ctx, c, 'viewer'))));

  app.patch('/api/applications/:id', async (c) => {
    const application = loadApp(ctx, c, 'developer');
    const auth = requireTeam(c, 'developer');
    const input = await body(c, updateApplicationSchema);
    const { source, previewEnv, ...rest } = input;
    const patch: ApplicationPatch = { ...rest };
    if (source !== undefined) Object.assign(patch, sourceColumns(auth.teamId, source));
    // A builder whose CLI is not on this control plane cannot be chosen; the dashboard lists the ones that can.
    if (patch.buildType !== undefined) requireBuilder(patch.buildType);
    // Previews deploy pull requests of a GitHub web application; a preview has none of its own.
    const previewable = application.parentApplicationId === null && (patch.kind ?? application.kind) === 'web' && (patch.sourceType ?? application.sourceType) === 'github';
    if (patch.previewsEnabled === true && !previewable) {
      const reason = application.parentApplicationId !== null ? 'preview' : (patch.kind ?? application.kind) !== 'web' ? 'not_web' : 'not_github';
      throw new AppError('validation_failed', 'Previews need a GitHub web application', {
        issues: [{ path: 'previewsEnabled', code: 'custom', message: 'Only GitHub web applications can have previews', params: { reason } }],
      });
    }
    // Switching to another source or kind turns previews off rather than failing the edit.
    if (!previewable && application.previewsEnabled && patch.previewsEnabled === undefined) patch.previewsEnabled = false;
    if (patch.replicas !== undefined && patch.replicas > 1 && stores.volumes.listForApplication(application.id).length > 0 && application.strategy === 'recreate') {
      // Allowed, but the UI warns; nothing to enforce here.
    }
    const updated = stores.applications.update(application.id, patch);
    if (previewEnv !== undefined) stores.applications.setPreviewEnv(application.id, previewEnv.trim().length === 0 ? null : ctx.secrets.seal(previewEnv, 'env'));
    if (source?.type === 'git' && source.url.startsWith('git@') && updated.deployKey === null) {
      const keys = await generateKeyPair(`torexploy-${updated.slug}`);
      stores.applications.setDeployKey(updated.id, ctx.secrets.seal(keys.privateKey, 'ssh'), keys.publicKey);
    }
    // Routing-relevant changes (port, kind) apply to the live proxy only on the next deployment; names apply now.
    audit(ctx, c, 'application.updated', { type: 'application', id: application.id, name: updated.name }, { fields: Object.keys(input) });
    changed(updated);
    return c.json(applicationDto(ctx, stores.applications.get(application.id)!));
  });

  app.delete('/api/applications/:id', async (c) => {
    const application = loadApp(ctx, c, 'admin');
    const removeData = c.req.query('removeData') === 'true';
    // Its pull request previews go first, containers and all.
    await ctx.deployer.remove(application, removeData);
    audit(ctx, c, 'application.deleted', { type: 'application', id: application.id, name: application.name }, { removeData });
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ lifecycle

  app.post('/api/applications/:id/deploy', async (c) => {
    const application = loadApp(ctx, c, 'developer');
    const auth = requireTeam(c, 'developer');
    const input = await body(c, deployRequestSchema);
    const deployment = ctx.deployer.enqueue({ app: application, trigger: 'manual', createdBy: auth.user.id, clearCache: input.clearCache ?? false });
    audit(ctx, c, 'application.deploy', { type: 'application', id: application.id, name: application.name }, { deploymentId: deployment.id });
    return c.json(deploymentDto(deployment, application), 202);
  });

  app.post('/api/applications/:id/restart', async (c) => {
    const application = loadApp(ctx, c, 'developer');
    const auth = requireTeam(c, 'developer');
    if (application.kind === 'compose') {
      // A stack restarts in place: every container, no rebuild (deploy for that).
      await ctx.compose.restart(application);
      audit(ctx, c, 'application.restart', { type: 'application', id: application.id, name: application.name });
      return c.json(applicationDto(ctx, stores.applications.get(application.id)!), 202);
    }
    const deployment = ctx.deployer.restart(application, auth.user.id);
    audit(ctx, c, 'application.restart', { type: 'application', id: application.id, name: application.name });
    return c.json(deploymentDto(deployment, application), 202);
  });

  app.post('/api/applications/:id/stop', async (c) => {
    const application = loadApp(ctx, c, 'developer');
    await ctx.deployer.stop(application);
    audit(ctx, c, 'application.stop', { type: 'application', id: application.id, name: application.name });
    return c.json(applicationDto(ctx, stores.applications.get(application.id)!));
  });

  app.post('/api/applications/:id/start', async (c) => {
    const application = loadApp(ctx, c, 'developer');
    const auth = requireTeam(c, 'developer');
    const deployment = await ctx.deployer.start(application, auth.user.id);
    audit(ctx, c, 'application.start', { type: 'application', id: application.id, name: application.name });
    return c.json({ application: applicationDto(ctx, stores.applications.get(application.id)!), deploymentId: deployment?.id ?? null });
  });

  app.get('/api/applications/:id/containers', async (c) => {
    const application = loadApp(ctx, c, 'viewer');
    if (application.kind === 'compose') {
      const stack = await ctx.compose.containers(application);
      return c.json(
        stack.map((container, replica): ContainerDto => ({
          replica,
          name: container.name,
          service: container.service,
          state: container.state,
          health: container.health,
          startedAt: container.startedAt,
          restartCount: container.restartCount,
          exitCode: container.exitCode,
          oomKilled: false,
        })),
      );
    }
    const active = application.activeDeploymentId === null ? undefined : stores.deployments.get(application.activeDeploymentId);
    const names = active?.containers ?? [];
    if (names.length === 0) return c.json([]);
    const docker = await ctx.connections.docker(application.serverId);
    const containers: ContainerDto[] = await Promise.all(
      names.map(async (name, replica) => {
        const inspect = await docker.inspectContainer(name);
        if (inspect === null) return { replica, name, service: null, state: 'missing', health: null, startedAt: null, restartCount: 0, exitCode: null, oomKilled: false };
        const running = inspect.State.Running;
        return {
          replica,
          name,
          service: null,
          state: inspect.State.Status,
          health: inspect.State.Health?.Status ?? null,
          startedAt: running && !inspect.State.StartedAt.startsWith('0001') ? inspect.State.StartedAt : null,
          restartCount: inspect.RestartCount,
          exitCode: running ? null : inspect.State.ExitCode,
          oomKilled: inspect.State.OOMKilled,
        };
      }),
    );
    return c.json(containers);
  });

  app.post('/api/applications/:id/hook/rotate', (c) => {
    const application = loadApp(ctx, c, 'admin');
    stores.applications.setHookToken(application.id, ctx.secrets.seal(generateToken(24), 'hook'));
    audit(ctx, c, 'application.hook_rotated', { type: 'application', id: application.id, name: application.name });
    return c.json(applicationDto(ctx, stores.applications.get(application.id)!));
  });

  app.get('/api/applications/:id/deploy-key', (c) => {
    const application = loadApp(ctx, c, 'developer');
    return c.json({ publicKey: application.deployPublicKey });
  });

  /** What a build of the branch head would do (stack, Dockerfile, warnings), without building. */
  app.post('/api/applications/:id/build-plan', async (c) => c.json(await previewBuildPlan(ctx, loadApp(ctx, c, 'developer'))));

  // ------------------------------------------------------------- variables

  app.get('/api/applications/:id/variables', (c) => {
    const application = loadApp(ctx, c, 'developer');
    const resolved = resolveAppEnv(stores, application);
    const variables: VariablesDto = {
      variables: stores.env.list({ applicationId: application.id }),
      inherited: resolved.inherited,
      updatedAt: stores.env.updatedAt({ applicationId: application.id }),
    };
    return c.json(variables);
  });

  app.put('/api/applications/:id/variables', async (c) => {
    const application = loadApp(ctx, c, 'developer');
    const input = await body(c, putVariablesSchema);
    if (stores.env.replace({ applicationId: application.id }, input.variables)) {
      stores.applications.markConfigChanged(application.id);
      audit(ctx, c, 'application.variables_updated', { type: 'application', id: application.id, name: application.name }, { keys: input.variables.map((variable) => variable.key) });
      changed(application);
    }
    const resolved = resolveAppEnv(stores, stores.applications.get(application.id)!);
    return c.json({ variables: stores.env.list({ applicationId: application.id }), inherited: resolved.inherited, updatedAt: stores.env.updatedAt({ applicationId: application.id }) });
  });

  // ----------------------------------------------------------- deployments

  app.get('/api/applications/:id/deployments', (c) => {
    const application = loadApp(ctx, c, 'viewer');
    const { cursor, limit } = query(c, paginationSchema);
    const page = stores.deployments.pageForApplication(application.id, cursor, limit);
    return c.json({ items: page.items.map((deployment) => deploymentDto(deployment, application)), nextCursor: page.nextCursor });
  });

  // --------------------------------------------------------------- domains

  app.get('/api/applications/:id/domains', (c) => {
    const application = loadApp(ctx, c, 'viewer');
    return c.json(stores.domains.listForApplication(application.id).map((domain) => domainDto(ctx, domain)));
  });

  app.post('/api/applications/:id/domains', async (c) => {
    const application = loadApp(ctx, c, 'developer');
    const input = await body(c, createDomainSchema);
    if (stores.domains.listForApplication(application.id).length >= LIMITS.domainsPerApp) throw new AppError('conflict', 'Too many domains for one application');
    // A host belongs to one team: another team may not hang a path off someone else's domain.
    const sameHost = stores.domains.findByHost(input.host);
    if (stores.domains.findRoute(input.host, input.path) !== undefined || (sameHost !== undefined && sameHost.teamId !== application.teamId) || stores.settings.platform().platformDomain === input.host) {
      throw new AppError('domain_taken', 'This domain is already in use', { params: { host: input.host } });
    }
    if (input.serviceName != null && application.kind !== 'compose') throw new AppError('validation_failed', 'Only compose apps route to a service', { issues: [{ path: 'serviceName', code: 'custom', message: 'Compose only' }] });
    const domain = stores.domains.create({
      applicationId: application.id,
      teamId: application.teamId,
      host: input.host,
      https: input.https,
      port: input.port ?? null,
      isGenerated: false,
      path: input.path,
      stripPath: input.stripPath,
      serviceName: input.serviceName ?? null,
      redirectTo: input.redirectTo ?? null,
    });
    await ctx.proxy.requestSync(application.serverId).catch(() => undefined);
    ctx.domains.followUp(domain.id);
    void ctx.domains.check(domain.id);
    audit(ctx, c, 'domain.added', { type: 'domain', id: domain.id, name: domain.host });
    emit(ctx, application.teamId, { type: 'domain.updated', id: domain.id, applicationId: application.id, serviceId: null });
    return c.json(domainDto(ctx, domain), 201);
  });

  app.post('/api/applications/:id/domains/generate', async (c) => {
    const application = loadApp(ctx, c, 'developer');
    const project = stores.projects.get(application.projectId)!;
    // Compose: the address is for one service (and port) of the stack.
    const target = await body(c, z.object({ serviceName: composeServiceSchema.optional(), port: portSchema.nullable().optional() }));
    const before = stores.domains.listForApplication(application.id).length;
    const created = generateDomain(ctx, application, project);
    const after = stores.domains.listForApplication(application.id);
    if (after.length === before || created === null) throw new AppError('conflict', 'Set an apps domain in platform settings to generate domains', { params: { reason: 'no_apps_domain' } });
    if (target.serviceName !== undefined || target.port != null) stores.domains.update(created.id, { serviceName: target.serviceName ?? null, port: target.port ?? null });
    await ctx.proxy.requestSync(application.serverId).catch(() => undefined);
    return c.json(stores.domains.listForApplication(application.id).map((domain) => domainDto(ctx, domain)), 201);
  });

  /** A domain of an application or of a service (file store), with the server it is served from. */
  const loadDomain = (c: Ctx, role: Role) => {
    const auth = requireTeam(c, role);
    const domain = stores.domains.getForTeam(auth.teamId, c.req.param('domainId')!);
    if (domain === undefined) throw notFound('Domain');
    const owner = domain.applicationId !== null ? stores.applications.get(domain.applicationId) : stores.services.get(domain.serviceId!);
    if (owner === undefined) throw notFound('Domain');
    return { domain, serverId: owner.serverId, teamId: owner.teamId };
  };

  app.patch('/api/domains/:domainId', async (c) => {
    const { domain, serverId } = loadDomain(c, 'developer');
    const input = await body(c, updateDomainSchema);
    stores.domains.update(domain.id, input);
    await ctx.proxy.requestSync(serverId).catch(() => undefined);
    ctx.domains.followUp(domain.id);
    audit(ctx, c, 'domain.updated', { type: 'domain', id: domain.id, name: domain.host }, input);
    return c.json(domainDto(ctx, stores.domains.get(domain.id)!));
  });

  app.post('/api/domains/:domainId/verify', async (c) => {
    const { domain } = loadDomain(c, 'viewer');
    const checked = await ctx.domains.check(domain.id);
    return c.json(domainDto(ctx, checked ?? domain));
  });

  app.delete('/api/domains/:domainId', async (c) => {
    const { domain, serverId, teamId } = loadDomain(c, 'developer');
    stores.domains.delete(domain.id);
    await ctx.proxy.requestSync(serverId).catch(() => undefined);
    audit(ctx, c, 'domain.removed', { type: 'domain', id: domain.id, name: domain.host });
    emit(ctx, teamId, { type: 'domain.updated', id: domain.id, applicationId: domain.applicationId, serviceId: domain.serviceId });
    return c.json({ ok: true });
  });

  // --------------------------------------------------------------- volumes

  app.get('/api/applications/:id/volumes', (c) => {
    const application = loadApp(ctx, c, 'viewer');
    return c.json(stores.volumes.listForApplication(application.id).map(volumeDto));
  });

  app.post('/api/applications/:id/volumes', async (c) => {
    const application = loadApp(ctx, c, 'developer');
    const input = await body(c, createVolumeSchema);
    const existing = stores.volumes.listForApplication(application.id);
    if (existing.some((volume) => volume.name === input.name || volume.mountPath === input.mountPath)) {
      throw new AppError('conflict', 'A volume with this name or mount path already exists');
    }
    const volume = stores.volumes.create(application.id, input.name, input.mountPath, appVolume(application, input.name));
    stores.applications.markConfigChanged(application.id);
    audit(ctx, c, 'volume.created', { type: 'volume', id: volume.id, name: volume.name }, { mountPath: volume.mountPath });
    changed(application);
    return c.json(volumeDto(volume), 201);
  });

  app.delete('/api/applications/:id/volumes/:volumeId', async (c) => {
    const application = loadApp(ctx, c, 'admin');
    const volume = stores.volumes.get(c.req.param('volumeId'));
    if (volume === undefined || volume.applicationId !== application.id) throw notFound('Volume');
    stores.volumes.delete(volume.id);
    stores.applications.markConfigChanged(application.id);
    if (c.req.query('removeData') === 'true') {
      // Removal succeeds only once no container uses the volume (after the next deployment).
      const docker = await ctx.connections.docker(application.serverId).catch(() => null);
      await docker?.removeVolume(volume.dockerVolume).catch(() => undefined);
    }
    audit(ctx, c, 'volume.deleted', { type: 'volume', id: volume.id, name: volume.name });
    changed(application);
    return c.json({ ok: true });
  });

  // ----------------------------------------------------------------- links

  app.get('/api/applications/:id/links', (c) => {
    const application = loadApp(ctx, c, 'viewer');
    return c.json(stores.links.listForApplication(application.id).map((link) => linkDto(ctx, link)).filter((link) => link !== null));
  });

  app.post('/api/applications/:id/links', async (c) => {
    const application = loadApp(ctx, c, 'developer');
    const input = await body(c, createLinkSchema);
    const service = stores.services.get(input.serviceId);
    if (service === undefined || service.projectId !== application.projectId) {
      throw new AppError('validation_failed', 'Only services in the same project can be linked', { issues: [{ path: 'serviceId', code: 'custom', message: 'Same project only' }] });
    }
    if (service.serverId !== application.serverId) {
      throw new AppError('validation_failed', 'The service runs on a different server', { issues: [{ path: 'serviceId', code: 'custom', message: 'Different server' }] });
    }
    if (stores.links.find(application.id, service.id) !== undefined) throw new AppError('conflict', 'Already linked');
    const link = stores.links.create(application.id, service.id, input.prefix);
    stores.applications.markConfigChanged(application.id);
    audit(ctx, c, 'link.created', { type: 'application', id: application.id, name: application.name }, { service: service.name, prefix: input.prefix });
    changed(application);
    emit(ctx, application.teamId, { type: 'service.updated', id: service.id, projectId: service.projectId, status: service.status });
    return c.json(linkDto(ctx, link), 201);
  });

  app.delete('/api/applications/:id/links/:linkId', (c) => {
    const application = loadApp(ctx, c, 'developer');
    const link = stores.links.get(c.req.param('linkId'));
    if (link === undefined || link.applicationId !== application.id) throw notFound('Link');
    stores.links.delete(link.id);
    stores.applications.markConfigChanged(application.id);
    audit(ctx, c, 'link.deleted', { type: 'application', id: application.id, name: application.name });
    changed(application);
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ cron

  /** Every scheduled job of the team, by project, application and name. */
  app.get('/api/cron', (c) => {
    const auth = requireTeam(c);
    return c.json(stores.cron.listForTeam(auth.teamId).map((job) => teamCronJobDto(ctx, job)));
  });

  app.get('/api/applications/:id/cron', (c) => {
    const application = loadApp(ctx, c, 'viewer');
    return c.json(stores.cron.listForApplication(application.id).map((job) => cronJobDto(ctx, job)));
  });

  app.post('/api/applications/:id/cron', async (c) => {
    const application = loadApp(ctx, c, 'developer');
    const input = await body(c, createCronJobSchema);
    const nextRunAt = cronSchedule(input.schedule);
    const job = stores.cron.create({
      applicationId: application.id,
      name: input.name,
      schedule: input.schedule,
      command: input.command,
      enabled: input.enabled,
      timeoutSec: input.timeoutSec,
      nextRunAt: input.enabled ? nextRunAt : null,
    });
    audit(ctx, c, 'cron.created', { type: 'cron', id: job.id, name: job.name }, { schedule: job.schedule });
    return c.json(cronJobDto(ctx, job), 201);
  });

  const loadCron = (c: Ctx, role: Role) => {
    const application = loadApp(ctx, c, role);
    const job = stores.cron.get(c.req.param('cronId')!);
    if (job === undefined || job.applicationId !== application.id) throw notFound('Cron job');
    return { application, job };
  };

  app.patch('/api/applications/:id/cron/:cronId', async (c) => {
    const { job } = loadCron(c, 'developer');
    const input = await body(c, updateCronJobSchema);
    const schedule = input.schedule ?? job.schedule;
    const enabled = input.enabled ?? job.enabled;
    const nextRunAt = enabled ? cronSchedule(schedule) : null;
    const updated = stores.cron.update(job.id, { ...input, nextRunAt });
    audit(ctx, c, 'cron.updated', { type: 'cron', id: job.id, name: updated.name });
    return c.json(cronJobDto(ctx, updated));
  });

  app.delete('/api/applications/:id/cron/:cronId', async (c) => {
    const { job } = loadCron(c, 'developer');
    ctx.cron.cancel(job.id);
    const runs = stores.cron.listRuns(job.id, 1_000);
    stores.cron.delete(job.id);
    for (const run of runs) await removeLog(logPath(ctx.config.dataDir, 'cron', run.id));
    audit(ctx, c, 'cron.deleted', { type: 'cron', id: job.id, name: job.name });
    return c.json({ ok: true });
  });

  app.post('/api/applications/:id/cron/:cronId/run', (c) => {
    const { job } = loadCron(c, 'developer');
    const run = ctx.cron.start(job, 'manual');
    audit(ctx, c, 'cron.run', { type: 'cron', id: job.id, name: job.name });
    return c.json(cronRunDto(run), 202);
  });

  app.post('/api/applications/:id/cron/:cronId/cancel', (c) => {
    const { job } = loadCron(c, 'developer');
    return c.json({ cancelled: ctx.cron.cancel(job.id) });
  });

  app.get('/api/applications/:id/cron/:cronId/runs', (c) => {
    const { job } = loadCron(c, 'viewer');
    return c.json(stores.cron.listRuns(job.id, 50).map(cronRunDto));
  });

  app.get('/api/applications/:id/cron/:cronId/runs/:runId/log', async (c) => {
    const { job } = loadCron(c, 'viewer');
    const run = stores.cron.getRun(c.req.param('runId'));
    if (run === undefined || run.cronJobId !== job.id) throw notFound('Run');
    return streamLog(c, ctx, logPath(ctx.config.dataDir, 'cron', run.id), run.id, () => stores.cron.getRun(run.id)?.status !== 'running', () => stores.cron.getRun(run.id)?.status ?? 'failed');
  });

  // --------------------------------------------------------------- metrics

  app.get('/api/applications/:id/metrics', (c) => {
    const application = loadApp(ctx, c, 'viewer');
    const { range } = query(c, rangeQuery);
    const window = METRIC_RANGE_WINDOWS[range];
    return c.json({ range, points: stores.metrics.appSeries(application.id, Date.now() - window.windowSec * 1000, window.bucketSec * 1000) });
  });

  // ---------------------------------------------------------- runtime logs

  app.get('/api/applications/:id/logs', async (c) => {
    const application = loadApp(ctx, c, 'viewer');
    const { tail, since } = logWindow(c.req.query('tail'), c.req.query('since'));
    const active = application.activeDeploymentId === null ? undefined : stores.deployments.get(application.activeDeploymentId);
    // Compose: every container of the stack, labelled with its service (optionally just one service).
    const wanted = c.req.query('service');
    const stack = application.kind === 'compose' ? (await ctx.compose.containers(application)).filter((container) => wanted === undefined || container.service === wanted) : null;
    const containers = stack === null ? (active?.containers ?? []) : stack.map((container) => container.name);
    const sources = stack === null ? null : stack.map((container) => container.service);
    const docker = await ctx.connections.docker(application.serverId);
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      await stream.writeSSE({ event: 'meta', data: JSON.stringify({ deploymentId: active?.id ?? null, replicas: containers.length, sources }) });
      let seq = 0;
      const follows = containers.map(async (name, replica) => {
        try {
          const output = await docker.containerLogs(name, { follow: true, tail, timestamps: true, ...(since === undefined ? {} : { since }), signal: controller.signal });
          for await (const chunk of output as AsyncIterable<{ stream: 'stdout' | 'stderr'; text: string }>) {
            for (const raw of chunk.text.split('\n')) {
              if (raw.length === 0) continue;
              const space = raw.indexOf(' ');
              const t = Date.parse(raw.slice(0, space));
              seq += 1;
              await stream.writeSSE({
                event: 'line',
                data: JSON.stringify({ seq, t: Number.isNaN(t) ? Date.now() : t, stream: chunk.stream, text: Number.isNaN(t) ? raw : raw.slice(space + 1), replica, ...(sources === null ? {} : { source: sources[replica] }) }),
              });
            }
          }
        } catch {
          // Container gone or client disconnected.
        }
      });
      const keepAlive = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }).catch(() => controller.abort()), 25_000);
      await Promise.race([Promise.all(follows), new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }))]);
      clearInterval(keepAlive);
      await stream.writeSSE({ event: 'end', data: '{}' }).catch(() => undefined);
    });
  });
}

/**
 * Replay a log file, then follow it live until `finished()` reports the
 * producer is done. Lines are de-duplicated by sequence number across the
 * replay/live boundary.
 */
export function streamLog(
  c: Ctx,
  ctx: Context,
  path: string,
  key: string,
  finished: () => boolean,
  finalStatus: () => string,
): Response {
  return streamSSE(c, async (stream) => {
    let lastSeq = Number(c.req.header('last-event-id') ?? 0) || 0;
    const queue: { seq: number; t: number; stream: string; text: string }[] = [];
    let ended = false;
    let wake: (() => void) | null = null;
    const unsubscribe = ctx.bus.onLog(key, (line) => {
      if (line === null) ended = true;
      else queue.push(line);
      wake?.();
    });
    stream.onAbort(() => {
      ended = true;
      wake?.();
    });
    try {
      const fromFile = await readLog(path, lastSeq);
      const seen = new Set(fromFile.map((line) => line.seq));
      const replay = [...fromFile, ...ctx.bus.recentLines(key).filter((line) => line.seq > lastSeq && !seen.has(line.seq))].sort((a, b) => a.seq - b.seq);
      for (const line of replay) {
        await stream.writeSSE({ event: 'line', id: String(line.seq), data: JSON.stringify(line) });
        lastSeq = line.seq;
      }
      if (finished()) ended = true;
      while (!ended || queue.length > 0) {
        const line = queue.shift();
        if (line === undefined) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 20_000);
          });
          wake = null;
          if (queue.length === 0 && !ended) {
            if (finished()) ended = true;
            else await stream.writeSSE({ event: 'ping', data: '' });
          }
          continue;
        }
        if (line.seq <= lastSeq) continue;
        lastSeq = line.seq;
        await stream.writeSSE({ event: 'line', id: String(line.seq), data: JSON.stringify(line) });
      }
      if (!stream.aborted) await stream.writeSSE({ event: 'end', data: JSON.stringify({ status: finalStatus() }) });
    } finally {
      unsubscribe();
    }
  });
}
