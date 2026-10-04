/**
 * Automatic addresses for new web applications.
 *
 * With an apps domain configured (`*.apps.example.uz` pointing at the
 * server) an app gets `<app>-<project>.apps.example.uz` over HTTPS. Without
 * one, a server with a public IPv4 address still gives every app a working
 * address through sslip.io's wildcard DNS (`<app>-<id>.<ip>.sslip.io`),
 * served over plain HTTP: certificates for a shared public suffix would hit
 * Let's Encrypt rate limits.
 *
 * On a developer's own machine (Docker Desktop, OrbStack, Rancher Desktop)
 * the public IP belongs to the router, not to this computer, so apps get
 * `<app>-<id>.localhost` instead: browsers resolve every `*.localhost` name
 * to this machine, where the proxy listens on port 80.
 */
import type { Context } from '../context.ts';
import { idPart } from '../docker/naming.ts';
import type { ApplicationRecord, DomainRecord, ProjectRecord, ServerRecord, ServiceRecord } from '../store/index.ts';

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/** A Docker engine on a workstation: apps are opened on this computer, not reached from the internet. */
export function isDesktopEngine(server: Pick<ServerRecord, 'kind' | 'dockerInfo'> | undefined): boolean {
  return server?.kind === 'local' && /Docker Desktop|OrbStack|Rancher Desktop/i.test(server.dockerInfo?.os ?? '');
}

/** Whether `generateDomain` can produce an address for apps on this server. */
export function canGenerateDomain(ctx: Context, serverId: string): boolean {
  if (ctx.stores.settings.platform().appsDomain !== null) return true;
  const server = ctx.stores.servers.get(serverId);
  if (isDesktopEngine(server)) return true;
  const ip = server?.publicIp;
  return ip != null && IPV4.test(ip);
}

/** The address rules, shared by applications and services: null when no scheme applies or the name is taken. */
function generatedHost(ctx: Context, owner: { id: string; serverId: string }, project: ProjectRecord, label: string): { host: string; https: boolean } | null {
  const { stores } = ctx;
  const { appsDomain } = stores.settings.platform();
  const server = stores.servers.get(owner.serverId);
  let host: string | null = null;
  let https = true;
  if (appsDomain !== null) {
    host = `${`${label}-${project.slug}`.slice(0, 50).replace(/-+$/, '')}.${appsDomain}`;
    if (stores.domains.findByHost(host) !== undefined) host = `${label}-${idPart(owner.id, 6)}.${appsDomain}`;
  } else if (isDesktopEngine(server)) {
    host = `${label}-${idPart(owner.id, 6)}.localhost`;
    https = false;
  } else if (server?.publicIp != null && IPV4.test(server.publicIp)) {
    host = `${label}-${idPart(owner.id, 6)}.${server.publicIp.replace(/\./g, '-')}.sslip.io`;
    https = false;
  }
  if (host === null || stores.domains.findByHost(host) !== undefined) return null;
  return { host, https };
}

/**
 * `label` names the app in the address instead of its slug (previews use
 * `pr-<n>-<parent>` so the pull request is recognisable in the URL).
 */
export function generateDomain(ctx: Context, application: ApplicationRecord, project: ProjectRecord, options: { label?: string } = {}): DomainRecord | null {
  const label = (options.label ?? application.slug).slice(0, 40).replace(/-+$/, '');
  const address = generatedHost(ctx, application, project, label);
  if (address === null) return null;
  const domain = ctx.stores.domains.create({ applicationId: application.id, teamId: application.teamId, ...address, port: null, isGenerated: true });
  ctx.domains.followUp(domain.id);
  return domain;
}

/** The same address scheme for a service that is served by the proxy (a file store's S3 endpoint). */
export function generateServiceDomain(ctx: Context, service: ServiceRecord, project: ProjectRecord): DomainRecord | null {
  const address = generatedHost(ctx, service, project, service.slug.slice(0, 40).replace(/-+$/, ''));
  if (address === null) return null;
  const domain = ctx.stores.domains.create({ serviceId: service.id, teamId: service.teamId, ...address, port: null, isGenerated: true });
  ctx.domains.followUp(domain.id);
  return domain;
}
