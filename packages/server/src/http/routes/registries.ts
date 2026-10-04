/**
 * Private container registries (admin only: they hold registry credentials).
 *
 * Credentials are checked with Docker's own `docker login` call before they
 * are saved, so a typo surfaces here and not as a failed pull mid-deploy.
 */
import type { Hono } from 'hono';
import { createRegistrySchema, updateRegistrySchema, type RegistryTestDto } from '@ploy/shared';
import type { Context } from '../../context.ts';
import { DockerUnavailableError } from '../../docker/client.ts';
import { registryAuthConfig, type RegistryCredentials } from '../../docker/registry.ts';
import { AppError, errorMessage, notFound } from '../../lib/errors.ts';
import type { RegistryRecord } from '../../store/index.ts';
import { audit, body, limit, RateLimiter, requireTeam, type Ctx, type Env } from '../core.ts';
import { registryDto } from '../dto.ts';

export function registerRegistryRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;
  const testLimiter = new RateLimiter(10, 10);

  const load = (c: Ctx): RegistryRecord => {
    const auth = requireTeam(c, 'admin');
    const registry = stores.registries.getForTeam(auth.teamId, c.req.param('id')!);
    if (registry === undefined) throw notFound('Registry');
    return registry;
  };

  const ensureUnique = (teamId: string, serverAddress: string, exceptId: string | null): void => {
    const existing = stores.registries.getByAddress(teamId, serverAddress);
    if (existing !== undefined && existing.id !== exceptId) {
      throw new AppError('registry_exists', `Credentials for ${serverAddress} are already saved as "${existing.name}"`, { params: { serverAddress } });
    }
  };

  /**
   * Log in through the control plane's own Docker; null when the registry
   * accepted the credentials, else its message. Docker itself being
   * unreachable is not a verdict on the credentials, so that throws.
   */
  const verify = async (credentials: RegistryCredentials): Promise<string | null> => {
    const local = stores.servers.getLocal();
    if (local === undefined) throw new AppError('docker_unavailable', 'There is no local Docker to check the credentials with');
    try {
      const docker = await ctx.connections.docker(local.id);
      await docker.auth(registryAuthConfig(credentials));
      return null;
    } catch (error) {
      if (error instanceof DockerUnavailableError) throw new AppError('docker_unavailable', error.message);
      if (error instanceof AppError) throw error;
      return errorMessage(error).slice(0, 400);
    }
  };

  const rejected = (serverAddress: string, failure: string): AppError =>
    new AppError('registry_auth_failed', `${serverAddress} rejected the credentials: ${failure}`, { params: { serverAddress } });

  app.get('/api/registries', (c) => {
    const auth = requireTeam(c, 'developer');
    const teamApps = stores.applications.listForTeam(auth.teamId);
    return c.json(stores.registries.listForTeam(auth.teamId).map((registry) => registryDto(ctx, registry, teamApps)));
  });

  app.post('/api/registries', async (c) => {
    const auth = requireTeam(c, 'admin');
    const input = await body(c, createRegistrySchema);
    ensureUnique(auth.teamId, input.serverAddress, null);
    limit(testLimiter, c, 'registry-test');
    const failure = await verify(input);
    if (failure !== null) throw rejected(input.serverAddress, failure);
    const registry = stores.registries.create(auth.teamId, input);
    audit(ctx, c, 'registry.created', { type: 'registry', id: registry.id, name: registry.name }, { serverAddress: registry.serverAddress, username: registry.username });
    return c.json(registryDto(ctx, registry), 201);
  });

  app.patch('/api/registries/:id', async (c) => {
    const registry = load(c);
    const input = await body(c, updateRegistrySchema);
    const merged = { ...registry, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) } as RegistryRecord;
    if (merged.serverAddress !== registry.serverAddress) ensureUnique(registry.teamId, merged.serverAddress, registry.id);
    const credentialsChanged = merged.serverAddress !== registry.serverAddress || merged.username !== registry.username || merged.password !== registry.password;
    if (credentialsChanged) {
      limit(testLimiter, c, 'registry-test');
      const failure = await verify(merged);
      if (failure !== null) throw rejected(merged.serverAddress, failure);
    }
    const updated = stores.registries.update(registry.id, input);
    audit(ctx, c, 'registry.updated', { type: 'registry', id: registry.id, name: updated.name }, { fields: Object.keys(input) });
    return c.json(registryDto(ctx, updated));
  });

  app.post('/api/registries/:id/test', async (c) => {
    const registry = load(c);
    limit(testLimiter, c, 'registry-test');
    const failure = await verify(registry);
    const result: RegistryTestDto = { ok: failure === null, error: failure };
    return c.json(result);
  });

  app.delete('/api/registries/:id', (c) => {
    const registry = load(c);
    // Applications keep their image reference; later pulls simply go out without these credentials.
    stores.registries.delete(registry.id);
    audit(ctx, c, 'registry.deleted', { type: 'registry', id: registry.id, name: registry.name }, { serverAddress: registry.serverAddress });
    return c.json({ ok: true });
  });
}
