/**
 * Preparing a user's Compose file for the platform.
 *
 * The file is parsed, validated and rewritten — never string-patched:
 * - every service joins the project network under a stable alias
 *   (`<app>-<service>`), so the proxy can route to it and the project's other
 *   apps and databases can reach it, while compose's own default network keeps
 *   the services talking to each other as before;
 * - every service is labelled as platform-managed and owned by the app;
 * - services without a restart policy get `unless-stopped` (they come back
 *   after a reboot) and services without log settings get rotation (logs
 *   cannot fill the disk);
 * - services that do not set `TZ` get the instance time zone (a `TZ` of the
 *   service's own, literal or `${TZ}`, is left alone).
 *
 * Features that reach past the container into the host (privileged mode, host
 * namespaces, extra capabilities, devices, absolute bind mounts) are reported
 * so the caller can require an administrator's explicit grant.
 */
import { parse, stringify } from 'yaml';
import { AppError } from '../lib/errors.ts';

export interface ComposeServiceInfo {
  name: string;
  image: string | null;
  build: boolean;
  /** Host ports the service publishes directly (bypassing the proxy). */
  publishedPorts: number[];
  /** Network alias on the project network. */
  alias: string;
}

export interface TransformInput {
  source: string;
  /** External project network the services join. */
  projectNetwork: string;
  /** App slug; aliases are `<slug>-<service>`. */
  aliasPrefix: string;
  labels: Record<string, string>;
  /** Instance time zone, given as `TZ` to every service that does not set one. */
  timezone?: string;
}

export interface TransformResult {
  yaml: string;
  services: ComposeServiceInfo[];
  /** Host-reaching features, as human-readable `service: feature` strings. */
  hostAccess: string[];
  /** Whether any service bind-mounts a path relative to the project directory. */
  relativeBinds: boolean;
}

const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
/** Key under which the project network is added; unlikely to collide with a user's own. */
const NETWORK_KEY = 'torexploy_project';
/** Capabilities a normal service may add; anything else is host-level power. */
const SAFE_CAPABILITIES = new Set(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID', 'SETPCAP', 'NET_BIND_SERVICE', 'SYS_CHROOT', 'MKNOD', 'AUDIT_WRITE']);
/** The proxy owns these on every server. */
const RESERVED_HOST_PORTS = new Set([80, 443]);

type Json = Record<string, unknown>;

function invalid(message: string, reason = 'compose_invalid'): AppError {
  return new AppError('validation_failed', message, { issues: [{ path: 'content', code: 'custom', message, params: { reason } }] });
}

const isMap = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export function serviceAlias(prefix: string, service: string): string {
  return `${prefix}-${service}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}

/** Host port of a `ports:` entry, or null when Docker picks one. */
function publishedPort(entry: unknown): number | null {
  if (isMap(entry)) {
    const published = entry.published;
    const port = typeof published === 'number' ? published : typeof published === 'string' ? Number(published.split('-')[0]) : NaN;
    return Number.isInteger(port) ? port : null;
  }
  if (typeof entry === 'number') return null;
  if (typeof entry !== 'string') return null;
  const spec = entry.split('/')[0]!;
  // [ip:]host:container — an IPv6 host address is bracketed, so splitting on ':' after removing it is safe.
  const parts = spec.replace(/^\[[^\]]*\]:/, '').split(':');
  if (parts.length < 2) return null;
  const host = Number(parts[parts.length - 2]!.split('-')[0]);
  return Number.isInteger(host) && host > 0 ? host : null;
}

/** Source of a bind mount, or null for named volumes, tmpfs and anonymous volumes. */
function bindSource(entry: unknown): string | null {
  if (isMap(entry)) return entry.type === 'bind' && typeof entry.source === 'string' ? entry.source : null;
  if (typeof entry !== 'string') return null;
  const source = entry.split(':')[0]!;
  return source.startsWith('/') || source.startsWith('.') || source.startsWith('~') ? source : null;
}

/** `TZ` added to a service's environment (map or `KEY=value` list) unless the service sets one. */
function withTimeZone(environment: unknown, timezone: string): unknown {
  if (Array.isArray(environment)) {
    return environment.some((item) => typeof item === 'string' && /^TZ(=|$)/.test(item)) ? environment : [...environment, `TZ=${timezone}`];
  }
  if (isMap(environment)) return 'TZ' in environment ? environment : { ...environment, TZ: timezone };
  return environment == null ? { TZ: timezone } : environment;
}

function normalizeLabels(value: unknown): Json {
  if (isMap(value)) return { ...value };
  if (Array.isArray(value)) {
    const out: Json = {};
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const index = item.indexOf('=');
      if (index === -1) out[item] = '';
      else out[item.slice(0, index)] = item.slice(index + 1);
    }
    return out;
  }
  return {};
}

export function transformCompose(input: TransformInput): TransformResult {
  let document: unknown;
  try {
    // `merge` resolves `<<: *defaults` keys, which compose files use for shared settings.
    document = parse(input.source, { maxAliasCount: 100, merge: true });
  } catch (error) {
    throw invalid(`The compose file is not valid YAML: ${(error as Error).message.split('\n')[0]}`);
  }
  if (!isMap(document)) throw invalid('The compose file must be a mapping with a "services" section');
  const services = document.services;
  if (!isMap(services) || Object.keys(services).length === 0) throw invalid('The compose file defines no services');

  const hostAccess: string[] = [];
  const info: ComposeServiceInfo[] = [];
  let relativeBinds = false;

  for (const [name, raw] of Object.entries(services)) {
    if (!SERVICE_NAME.test(name)) throw invalid(`Service name "${name}" is not valid`);
    if (!isMap(raw)) throw invalid(`Service "${name}" must be a mapping`);
    const service = raw;
    if (service.image === undefined && service.build === undefined) throw invalid(`Service "${name}" needs an image or a build section`);

    // ------------------------------------------------ host-level features
    if (service.privileged === true) hostAccess.push(`${name}: privileged`);
    for (const key of ['network_mode', 'pid', 'ipc', 'userns_mode', 'uts', 'cgroup'] as const) {
      if (service[key] === 'host') hostAccess.push(`${name}: ${key}: host`);
    }
    for (const capability of Array.isArray(service.cap_add) ? service.cap_add : []) {
      const cap = String(capability).toUpperCase().replace(/^CAP_/, '');
      if (!SAFE_CAPABILITIES.has(cap)) hostAccess.push(`${name}: cap_add ${cap}`);
    }
    if (Array.isArray(service.devices) && service.devices.length > 0) hostAccess.push(`${name}: devices`);
    for (const option of Array.isArray(service.security_opt) ? service.security_opt : []) {
      if (/unconfined|label[:=]disable/i.test(String(option))) hostAccess.push(`${name}: security_opt ${String(option)}`);
    }
    for (const volume of Array.isArray(service.volumes) ? service.volumes : []) {
      const source = bindSource(volume);
      if (source === null) continue;
      if (source.startsWith('.')) relativeBinds = true;
      else hostAccess.push(`${name}: mounts ${source}`);
    }

    const ports: number[] = [];
    for (const entry of Array.isArray(service.ports) ? service.ports : []) {
      const port = publishedPort(entry);
      if (port === null) continue;
      if (RESERVED_HOST_PORTS.has(port)) throw invalid(`Service "${name}" publishes port ${port}, which the platform proxy uses. Add a domain instead.`, 'compose_port_reserved');
      ports.push(port);
    }

    // ------------------------------------------------------ rewriting
    const alias = serviceAlias(input.aliasPrefix, name);
    if (service.network_mode === undefined) {
      const networks: Json = {};
      if (Array.isArray(service.networks)) for (const network of service.networks) networks[String(network)] = null;
      else if (isMap(service.networks)) Object.assign(networks, service.networks);
      // Listing networks removes the implicit default one; keep it so the services still see each other.
      if (Object.keys(networks).length === 0) networks.default = null;
      networks[NETWORK_KEY] = { aliases: [alias] };
      service.networks = networks;
    }
    service.labels = { ...normalizeLabels(service.labels), ...input.labels };
    if (input.timezone !== undefined) service.environment = withTimeZone(service.environment, input.timezone);
    const restartPolicy = isMap(service.deploy) ? service.deploy.restart_policy : undefined;
    if (service.restart === undefined && restartPolicy === undefined) service.restart = 'unless-stopped';
    if (service.logging === undefined) service.logging = { driver: 'json-file', options: { 'max-size': '20m', 'max-file': '5' } };

    info.push({ name, image: typeof service.image === 'string' ? service.image : null, build: service.build !== undefined, publishedPorts: ports, alias });
  }

  const topNetworks: Json = isMap(document.networks) ? { ...document.networks } : {};
  topNetworks[NETWORK_KEY] = { name: input.projectNetwork, external: true };
  document.networks = topNetworks;

  return { yaml: stringify(document, { lineWidth: 0 }), services: info, hostAccess, relativeBinds };
}

/** Service names from a compose file without rewriting it (for the dashboard); empty when unparsable. */
export function composeServices(source: string): string[] {
  try {
    const document = parse(source, { maxAliasCount: 100, merge: true }) as unknown;
    return isMap(document) && isMap(document.services) ? Object.keys(document.services) : [];
  } catch {
    return [];
  }
}
