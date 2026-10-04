/**
 * Domain verification: DNS and TLS, checked for real.
 *
 * DNS is "ok" when the host resolves to the server's public address. TLS is
 * "active" only after a real handshake against the host returns a trusted
 * certificate that covers it — not when the proxy merely has the route. The
 * dashboard therefore shows what a visitor would actually experience.
 */
import { Resolver } from 'node:dns/promises';
import { connect, type PeerCertificate } from 'node:tls';
import type { DnsStatus, TlsStatus } from '@ploy/shared';
import { emit, type Context } from '../context.ts';
import { errorMessage } from '../lib/errors.ts';
import type { DomainRecord } from '../store/index.ts';

export async function checkDns(host: string, expectedIp: string | null): Promise<{ status: DnsStatus; records: string[] }> {
  const resolver = new Resolver({ timeout: 4_000, tries: 2 });
  const records: string[] = [];
  let failure: NodeJS.ErrnoException | null = null;
  for (const family of ['resolve4', 'resolve6'] as const) {
    try {
      records.push(...(await resolver[family](host)));
    } catch (error) {
      failure = error as NodeJS.ErrnoException;
    }
  }
  if (records.length === 0) {
    return { status: failure?.code === 'ENOTFOUND' || failure?.code === 'ENODATA' ? 'pending' : 'error', records };
  }
  if (expectedIp === null) return { status: 'ok', records };
  return { status: records.includes(expectedIp) ? 'ok' : 'mismatch', records };
}

export function checkTls(host: string, timeoutMs = 8_000): Promise<{ status: TlsStatus; issuer: string | null; expiresAt: string | null; message: string | null }> {
  return new Promise((resolve) => {
    const socket = connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: timeoutMs, ALPNProtocols: ['http/1.1'] });
    const done = (result: { status: TlsStatus; issuer: string | null; expiresAt: string | null; message: string | null }): void => {
      socket.destroy();
      resolve(result);
    };
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate() as PeerCertificate | Record<string, never>;
      if (!('valid_to' in cert)) {
        done({ status: 'pending', issuer: null, expiresAt: null, message: 'No certificate presented yet' });
        return;
      }
      const issuer = first(cert.issuer?.O) ?? first(cert.issuer?.CN);
      const expiresAt = new Date(cert.valid_to).toISOString();
      if (socket.authorized) {
        done({ status: 'active', issuer, expiresAt, message: null });
        return;
      }
      const reason = String(socket.authorizationError ?? 'untrusted');
      // Caddy serves its internal CA until the public certificate arrives; that is "not yet", not "broken".
      const interim = /self.signed|unable to get local issuer|SELF_SIGNED|UNABLE_TO_GET_ISSUER/i.test(reason) || /Caddy Local Authority/i.test(issuer ?? '');
      done({ status: interim ? 'pending' : 'error', issuer, expiresAt, message: interim ? 'Waiting for the certificate authority' : reason });
    });
    socket.once('timeout', () => done({ status: 'pending', issuer: null, expiresAt: null, message: 'TLS handshake timed out' }));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      const pendingCodes = ['ECONNREFUSED', 'ECONNRESET', 'EPROTO', 'ENOTFOUND', 'EAI_AGAIN'];
      done({ status: pendingCodes.includes(error.code ?? '') ? 'pending' : 'error', issuer: null, expiresAt: null, message: error.message });
    });
  });
}

function first(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

const FOLLOW_UPS_MS = [8_000, 30_000, 90_000, 5 * 60_000, 15 * 60_000];

export class DomainChecker {
  private readonly ctx: Context;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  async check(domainId: string): Promise<DomainRecord | undefined> {
    const { stores } = this.ctx;
    const domain = stores.domains.get(domainId);
    if (domain === undefined) return undefined;
    const app = stores.applications.get(domain.applicationId);
    const server = app === undefined ? undefined : stores.servers.get(app.serverId);
    try {
      // `*.localhost` never leaves the machine: browsers resolve it to loopback, so there is no DNS to check.
      if (domain.host.endsWith('.localhost')) {
        stores.domains.setDns(domain.id, 'ok', ['127.0.0.1']);
        if (!domain.https) stores.domains.setTls(domain.id, 'disabled', {});
        emit(this.ctx, domain.teamId, { type: 'domain.updated', id: domain.id, applicationId: domain.applicationId });
        return stores.domains.get(domain.id);
      }
      const dns = await checkDns(domain.host, server?.publicIp ?? null);
      stores.domains.setDns(domain.id, dns.status, dns.records);
      if (domain.https && dns.status !== 'pending' && dns.status !== 'error') {
        const tls = await checkTls(domain.host);
        stores.domains.setTls(domain.id, tls.status, tls);
      } else if (!domain.https) {
        stores.domains.setTls(domain.id, 'disabled', {});
      }
    } catch (error) {
      this.ctx.logger.debug('Domain check failed', { domainId, error: errorMessage(error) });
    }
    emit(this.ctx, domain.teamId, { type: 'domain.updated', id: domain.id, applicationId: domain.applicationId });
    return stores.domains.get(domain.id);
  }

  /** After a domain is added or a deployment goes live, certificates take a minute; check a few times. */
  followUp(domainId: string): void {
    for (const delay of FOLLOW_UPS_MS) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        const domain = this.ctx.stores.domains.get(domainId);
        if (domain === undefined) return;
        if (domain.dnsStatus === 'ok' && (domain.tlsStatus === 'active' || domain.tlsStatus === 'disabled')) return;
        void this.check(domainId);
      }, delay);
      timer.unref();
      this.timers.add(timer);
    }
  }

  /** Periodic sweep: unresolved domains often, healthy ones daily (catches expiry and DNS changes). */
  async sweep(): Promise<void> {
    const day = 24 * 3_600_000;
    for (const domain of this.ctx.stores.domains.listAll()) {
      const healthy = domain.dnsStatus === 'ok' && (domain.tlsStatus === 'active' || domain.tlsStatus === 'disabled');
      const age = domain.dnsCheckedAt === null ? Infinity : Date.now() - Date.parse(domain.dnsCheckedAt);
      if ((healthy && age > day) || (!healthy && age > 10 * 60_000)) await this.check(domain.id);
    }
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
