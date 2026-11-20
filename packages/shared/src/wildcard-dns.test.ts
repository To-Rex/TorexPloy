/** Wildcard DNS names: which hosts are under sslip.io or nip.io, and the name a server's address gets. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWildcardDnsHost, wildcardDnsHost } from './constants.ts';

test('wildcard DNS hosts are recognised by suffix, whatever the case, and nothing else is', () => {
  for (const host of ['203-0-113-7.sslip.io', '203.0.113.7.sslip.io', 'app.203-0-113-7.sslip.io', 'APP.203-0-113-7.SSLIP.IO', 'api.10-0-0-1.nip.io']) {
    assert.equal(isWildcardDnsHost(host), true, host);
  }
  for (const host of ['sslip.io', 'nip.io', 'notsslip.io', 'sslip.io.example.uz', 'deploy.example.uz', 'xnip.io', '']) {
    assert.equal(isWildcardDnsHost(host), false, host);
  }
});

test('a public IPv4 address gets its sslip.io name; private, reserved and malformed addresses get none', () => {
  assert.equal(wildcardDnsHost('203.0.113.7'), '203-0-113-7.sslip.io');
  assert.equal(wildcardDnsHost('169.58.230.136'), '169-58-230-136.sslip.io', '169.58 is public; only 169.254 is link-local');
  assert.equal(wildcardDnsHost('100.63.255.255'), '100-63-255-255.sslip.io');
  assert.equal(wildcardDnsHost('172.32.0.1'), '172-32-0-1.sslip.io');
  for (const ip of ['10.1.2.3', '127.0.0.1', '0.0.0.0', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.10.10', '100.64.0.1', '100.127.255.255', '224.0.0.1', '255.255.255.255']) {
    assert.equal(wildcardDnsHost(ip), null, ip);
  }
  for (const ip of [null, undefined, '', '203.0.113', '203.0.113.7.1', '203.0.113.256', '2001:db8::1', 'deploy.example.uz', ' 203.0.113.7']) {
    assert.equal(wildcardDnsHost(ip), null, String(ip));
  }
  // The name it produces is one of the hosts it recognises.
  assert.equal(isWildcardDnsHost(wildcardDnsHost('203.0.113.7')!), true);
});
