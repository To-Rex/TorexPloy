/**
 * How the control plane reaches a file store's S3 gateway.
 *
 * Applications reach the store by its slug on the project network. The
 * control plane lives on the `ploy` network instead, so it either goes
 * through the store's HTTPS domain (any machine), joins the project network
 * itself (the local server, when the panel runs in Docker), uses the loopback
 * public port (a developer's machine), or — for a remote server — needs a
 * domain or a public port. The answer is computed every time it is needed:
 * domains and ports change after a destination was created.
 */
import type { Context } from '../context.ts';
import { projectNetwork } from '../docker/naming.ts';
import { AppError } from '../lib/errors.ts';
import type { ServiceRecord } from '../store/index.ts';

export interface StoreReach {
  endpoint: string;
  via: 'domain' | 'network' | 'loopback' | 'public_port';
}

export interface ReachDeps {
  /** The control-plane container on the local engine, or null when the process runs outside Docker. */
  self: () => Promise<{ id: string } | null>;
  /** Join a container to a project network (idempotent). */
  connect: (network: string, containerId: string) => Promise<void>;
}

/** The address of the S3 gateway inside the project network, as linked applications use it. */
export function internalEndpoint(service: Pick<ServiceRecord, 'slug' | 'internalPort'>): string {
  return `http://${service.slug}:${service.internalPort}`;
}

/** The address external clients use: a domain (HTTPS preferred), else the server's public port; null without either. */
export function publicEndpoint(ctx: Pick<Context, 'stores'>, service: ServiceRecord): string | null {
  const url = ctx.stores.domains.primaryServiceUrl(service.id);
  if (url !== null) return url;
  if (service.publicPort === null) return null;
  const server = ctx.stores.servers.get(service.serverId);
  const host = server?.publicIp ?? server?.host ?? null;
  return host === null ? null : `http://${host}:${service.publicPort}`;
}

export async function resolveReach(ctx: Pick<Context, 'stores'>, service: ServiceRecord, deps: ReachDeps): Promise<StoreReach> {
  const domains = ctx.stores.domains.listForService(service.id);
  // A certificate that is still being issued would only produce handshake errors; the other paths are tried first.
  const secure = domains.find((domain) => domain.https && domain.tlsStatus === 'active');
  if (secure !== undefined) return { endpoint: `https://${secure.host}`, via: 'domain' };
  const server = ctx.stores.servers.get(service.serverId);
  if (server?.kind === 'local') {
    const self = await deps.self();
    if (self !== null) {
      await deps.connect(projectNetwork(service.projectId), self.id);
      return { endpoint: internalEndpoint(service), via: 'network' };
    }
    if (service.publicPort !== null) return { endpoint: `http://127.0.0.1:${service.publicPort}`, via: 'loopback' };
  } else {
    const plain = domains.find((domain) => !domain.https);
    if (plain !== undefined) return { endpoint: `http://${plain.host}`, via: 'domain' };
    if (service.publicPort !== null && server?.publicIp != null) return { endpoint: `http://${server.publicIp}:${service.publicPort}`, via: 'public_port' };
  }
  throw new AppError('validation_failed', 'The control plane cannot reach this file store: give it a domain or a public port', {
    params: { reason: 'store_unreachable' },
    issues: [{ path: 'endpoint', code: 'custom', message: 'No route from the control plane to the store', params: { reason: 'store_unreachable' } }],
  });
}
