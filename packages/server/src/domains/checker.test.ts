/**
 * Checking a host that is not a domain row (the panel domain): DNS first,
 * then the certificate, and the detour through the proxy when the server
 * cannot reach its own public address.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainChecker, type checkDns, type checkTls } from './checker.ts';
import type { Context } from '../context.ts';

type Dns = Awaited<ReturnType<typeof checkDns>>;
type Tls = Awaited<ReturnType<typeof checkTls>>;

const checker = new DomainChecker({} as Context);
const HOST = '203-0-113-7.sslip.io';
const ACTIVE: Tls = { status: 'active', issuer: 'ZeroSSL', expiresAt: '2027-02-18T00:00:00.000Z', message: null };
const TIMED_OUT: Tls = { status: 'pending', issuer: null, expiresAt: null, message: 'TLS handshake timed out' };
const INTERIM: Tls = { status: 'pending', issuer: 'Caddy Local Authority', expiresAt: '2026-11-21T00:00:00.000Z', message: 'Waiting for the certificate authority' };

function probes(dns: Dns, answers: Record<string, Tls>) {
  const calls: string[] = [];
  return {
    calls,
    probes: {
      dns: async (host: string, expected: string | null) => {
        calls.push(`dns ${host} ${expected}`);
        return dns;
      },
      tls: async (host: string, _timeout?: number, via?: string) => {
        calls.push(`tls ${host}${via === undefined ? '' : ` via ${via}`}`);
        return answers[via ?? 'public']!;
      },
    },
  };
}

test('a name that does not resolve has no certificate to look at', async () => {
  for (const status of ['pending', 'error'] as const) {
    const p = probes({ status, records: [] }, { public: ACTIVE });
    assert.deepEqual(await checker.checkHost(HOST, '203.0.113.7', { tlsVia: 'ploy-proxy', probes: p.probes }), { dns: { status, records: [] }, tls: null });
    assert.deepEqual(p.calls, [`dns ${HOST} 203.0.113.7`], 'no handshake is attempted');
  }
});

test('the certificate is judged where a visitor finds it; the proxy is asked only when the public address cannot be reached', async () => {
  const ok: Dns = { status: 'ok', records: ['203.0.113.7'] };

  // Reachable from here: one handshake, its verdict stands.
  const direct = probes(ok, { public: ACTIVE, 'ploy-proxy': TIMED_OUT });
  assert.deepEqual((await checker.checkHost(HOST, '203.0.113.7', { tlsVia: 'ploy-proxy', probes: direct.probes })).tls, ACTIVE);
  assert.deepEqual(direct.calls, [`dns ${HOST} 203.0.113.7`, `tls ${HOST}`]);

  // No hairpin NAT: the public handshake times out, the proxy shows the real certificate.
  const hairpin = probes(ok, { public: TIMED_OUT, 'ploy-proxy': ACTIVE });
  assert.deepEqual((await checker.checkHost(HOST, '203.0.113.7', { tlsVia: 'ploy-proxy', probes: hairpin.probes })).tls, ACTIVE);
  assert.deepEqual(hairpin.calls, [`dns ${HOST} 203.0.113.7`, `tls ${HOST}`, `tls ${HOST} via ploy-proxy`]);

  // ...or the certificate still on its way: "pending", but now with what the proxy is serving meanwhile.
  const waiting = probes(ok, { public: TIMED_OUT, 'ploy-proxy': INTERIM });
  assert.deepEqual((await checker.checkHost(HOST, '203.0.113.7', { tlsVia: 'ploy-proxy', probes: waiting.probes })).tls, INTERIM);

  // The proxy cannot be reached either (it is down): the public verdict is kept.
  const down = probes(ok, { public: TIMED_OUT, 'ploy-proxy': { ...TIMED_OUT, message: 'getaddrinfo ENOTFOUND ploy-proxy' } });
  assert.deepEqual((await checker.checkHost(HOST, '203.0.113.7', { tlsVia: 'ploy-proxy', probes: down.probes })).tls, TIMED_OUT);

  // A certificate was seen in public, even an interim or a wrong one: that is what visitors get, so it is not second-guessed.
  for (const seen of [INTERIM, { status: 'error', issuer: 'Some CA', expiresAt: null, message: 'CERT_HAS_EXPIRED' } as Tls]) {
    const verdict = probes(ok, { public: seen, 'ploy-proxy': ACTIVE });
    assert.deepEqual((await checker.checkHost(HOST, '203.0.113.7', { tlsVia: 'ploy-proxy', probes: verdict.probes })).tls, seen);
    assert.equal(verdict.calls.length, 2);
  }

  // A name that resolves elsewhere (behind a CDN) is still checked; and without a proxy to ask there is no detour.
  const elsewhere = probes({ status: 'mismatch', records: ['198.51.100.9'] }, { public: TIMED_OUT, 'ploy-proxy': ACTIVE });
  assert.deepEqual((await checker.checkHost(HOST, '203.0.113.7', { probes: elsewhere.probes })).tls, TIMED_OUT);
  assert.deepEqual(elsewhere.calls, [`dns ${HOST} 203.0.113.7`, `tls ${HOST}`]);
});
