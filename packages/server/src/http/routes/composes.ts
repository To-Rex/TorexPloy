/**
 * Docker Compose applications: creation, the compose file, host access.
 * Everything else (deployments, domains, variables, logs) is shared with
 * ordinary applications.
 */
import type { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createComposeSchema, roleAtLeast, updateComposeSchema, type ComposeDto } from '@ploy/shared';
import { z } from 'zod';
import { emit, type Context } from '../../context.ts';
import { composeServices, transformCompose } from '../../compose/transform.ts';
import { projectNetwork } from '../../docker/naming.ts';
import { generateToken } from '../../lib/crypto.ts';
import { AppError } from '../../lib/errors.ts';
import { generateKeyPair } from '../../servers/ssh.ts';
import type { ApplicationRecord } from '../../store/index.ts';
import { audit, body, requestOrigin, requireTeam, type Env } from '../core.ts';
import { applicationDto } from '../dto.ts';
import { loadApp } from './applications.ts';
import { loadProject } from './projects.ts';

/** Validate a compose file up front, so mistakes show in the editor instead of failing a deploy. */
function check(content: string, app: { slug: string; projectId: string }): string[] {
  return transformCompose({ source: content, projectNetwork: projectNetwork(app.projectId), aliasPrefix: app.slug, labels: {} }).hostAccess;
}

export function registerComposeRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;

  const loadCompose = (c: Parameters<typeof loadApp>[1], role: 'viewer' | 'developer' | 'admin'): ApplicationRecord => {
    const application = loadApp(ctx, c, role);
    if (application.kind !== 'compose') throw new AppError('not_found', 'Not a compose application', { params: { resource: 'compose' } });
    return application;
  };

  /** The file as the dashboard shows it: stored, or as last checked out from the repository. */
  const currentFile = async (application: ApplicationRecord): Promise<string | null> => {
    if (application.sourceType === 'raw') return application.composeFile;
    return readFile(join(ctx.compose.appDir(application), 'code', application.composePath), 'utf8').catch(() => null);
  };

  app.post('/api/projects/:id/composes', async (c) => {
    const project = loadProject(ctx, c, 'developer');
    const auth = requireTeam(c, 'developer');
    const input = await body(c, createComposeSchema);
    const server = stores.servers.getForTeam(auth.teamId, input.serverId);
    if (server === undefined) throw new AppError('validation_failed', 'Unknown server', { issues: [{ path: 'serverId', code: 'custom', message: 'Unknown server' }] });
    const admin = roleAtLeast(auth.role, 'admin');
    const slug = stores.projects.uniqueResourceSlug(project.id, input.name, 'stack');

    const source = input.source;
    if (source.type === 'raw') {
      const needed = check(source.content, { slug, projectId: project.id });
      if (needed.length > 0 && !(admin && input.allowHostAccess)) {
        throw new AppError('forbidden', `This compose file reaches the host (${needed.join('; ')})`, { params: { reason: 'compose_host_access' } });
      }
    }
    if (source.type === 'github' && stores.installations.get(source.installationId)?.teamId !== auth.teamId) {
      throw new AppError('validation_failed', 'Unknown GitHub installation', { issues: [{ path: 'source.installationId', code: 'custom', message: 'Connect this GitHub account first' }] });
    }

    const application = stores.applications.create({
      projectId: project.id,
      teamId: project.teamId,
      serverId: server.id,
      name: input.name,
      slug,
      kind: 'compose',
      sourceType: source.type,
      githubInstallationId: source.type === 'github' ? source.installationId : null,
      repository: source.type === 'github' ? source.repository : null,
      gitUrl: source.type === 'git' ? source.url : null,
      branch: source.type === 'raw' ? null : source.branch,
      image: null,
      composeFile: source.type === 'raw' ? source.content : null,
      composePath: input.composePath,
      // Compose stacks recreate what changed; there is no rolling swap.
      sealedHookToken: ctx.secrets.seal(generateToken(24), 'hook'),
    });
    stores.applications.update(application.id, { strategy: 'recreate', healthCheckTimeoutSec: 300 });
    if (admin && input.allowHostAccess) stores.applications.setHostAccess(application.id, true);
    if (source.type === 'git' && source.url.startsWith('git@')) {
      const keys = await generateKeyPair(`torexploy-${application.slug}`);
      stores.applications.setDeployKey(application.id, ctx.secrets.seal(keys.privateKey, 'ssh'), keys.publicKey);
    }
    stores.projects.touch(project.id);
    audit(ctx, c, 'compose.created', { type: 'application', id: application.id, name: application.name }, { source: source.type });
    emit(ctx, project.teamId, { type: 'application.updated', id: application.id, projectId: project.id, status: application.status });

    const needsKey = source.type === 'git' && source.url.startsWith('git@');
    const deployment = needsKey ? null : ctx.deployer.enqueue({ app: stores.applications.get(application.id)!, trigger: 'manual', createdBy: auth.user.id });
    return c.json({ application: applicationDto(ctx, stores.applications.get(application.id)!, requestOrigin(c)), deploymentId: deployment?.id ?? null }, 201);
  });

  app.get('/api/applications/:id/compose', async (c) => {
    const application = loadCompose(c, 'viewer');
    const content = await currentFile(application);
    let needed: string[] = [];
    if (content !== null) {
      try {
        needed = check(content, application);
      } catch {
        // An invalid file shows its errors on save or deploy; here it simply has no analysis.
      }
    }
    const dto: ComposeDto = {
      content,
      path: application.sourceType === 'raw' ? null : application.composePath,
      services: content === null ? [] : composeServices(content),
      hostAccess: application.hostAccess,
      hostAccessNeeded: needed,
    };
    return c.json(dto);
  });

  app.put('/api/applications/:id/compose', async (c) => {
    const application = loadCompose(c, 'developer');
    const auth = requireTeam(c, 'developer');
    const input = await body(c, updateComposeSchema);
    if (input.content !== undefined) {
      if (application.sourceType !== 'raw') throw new AppError('bad_request', 'This stack reads its compose file from the repository; edit it there');
      const needed = check(input.content, application);
      if (needed.length > 0 && !application.hostAccess && !roleAtLeast(auth.role, 'admin')) {
        throw new AppError('forbidden', `This compose file reaches the host (${needed.join('; ')})`, { params: { reason: 'compose_host_access' } });
      }
    }
    const updated = stores.applications.update(application.id, {
      ...(input.content === undefined ? {} : { composeFile: input.content }),
      ...(input.composePath === undefined ? {} : { composePath: input.composePath }),
    });
    audit(ctx, c, 'compose.updated', { type: 'application', id: application.id, name: application.name }, { fields: Object.keys(input) });
    emit(ctx, application.teamId, { type: 'application.updated', id: application.id, projectId: application.projectId, status: updated.status });
    return c.json(applicationDto(ctx, stores.applications.get(application.id)!, requestOrigin(c)));
  });

  app.put('/api/applications/:id/host-access', async (c) => {
    const application = loadCompose(c, 'admin');
    const input = await body(c, z.object({ allowed: z.boolean() }));
    stores.applications.setHostAccess(application.id, input.allowed);
    audit(ctx, c, input.allowed ? 'compose.host_access_granted' : 'compose.host_access_revoked', { type: 'application', id: application.id, name: application.name });
    return c.json(applicationDto(ctx, stores.applications.get(application.id)!, requestOrigin(c)));
  });
}
