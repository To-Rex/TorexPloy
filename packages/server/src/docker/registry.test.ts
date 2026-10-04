import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCliConfig } from './cli.ts';
import { cliAuths, registryAuthHeader } from './registry.ts';

test('the X-Registry-Auth header is base64url JSON, with Docker Hub under its v1 index URL', () => {
  const decode = (header: string) => JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, string>;
  const header = registryAuthHeader({ serverAddress: 'ghcr.io', username: 'robot', password: 'p/a+s?s' });
  assert.match(header, /^[A-Za-z0-9_-]+$/, 'url-safe alphabet, no padding');
  assert.deepEqual(decode(header), { username: 'robot', password: 'p/a+s?s', serveraddress: 'ghcr.io' });
  assert.equal(decode(registryAuthHeader({ serverAddress: 'docker.io', username: 'u', password: 'p' })).serveraddress, 'https://index.docker.io/v1/');
});

test('CLI auths are keyed the way the docker CLI looks them up', () => {
  assert.deepEqual(
    cliAuths([
      { serverAddress: 'ghcr.io', username: 'robot', password: 'secret' },
      { serverAddress: 'docker.io', username: 'hub', password: 'tok' },
      { serverAddress: 'registry.example.uz:5000', username: 'ci', password: 'pw:with:colons' },
    ]),
    {
      'ghcr.io': { auth: Buffer.from('robot:secret').toString('base64') },
      'https://index.docker.io/v1/': { auth: Buffer.from('hub:tok').toString('base64') },
      'registry.example.uz:5000': { auth: Buffer.from('ci:pw:with:colons').toString('base64') },
    },
  );
  assert.deepEqual(cliAuths([]), {});
});

test('the CLI config carries the given logins only, in a file only the platform can read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-cli-config-'));
  try {
    const plain = await prepareCliConfig(join(dir, 'plain'));
    const plainConfig = JSON.parse(readFileSync(join(plain, 'config.json'), 'utf8')) as Record<string, unknown>;
    assert.ok(Array.isArray(plainConfig.cliPluginsExtraDirs));
    assert.equal(plainConfig.auths, undefined, 'no logins, no auths section');

    const withAuths = await prepareCliConfig(join(dir, 'team'), cliAuths([{ serverAddress: 'ghcr.io', username: 'robot', password: 'secret' }]));
    const config = JSON.parse(readFileSync(join(withAuths, 'config.json'), 'utf8')) as { auths: Record<string, { auth: string }> };
    assert.deepEqual(Object.keys(config.auths), ['ghcr.io']);
    assert.equal(statSync(join(withAuths, 'config.json')).mode & 0o777, 0o600);
    assert.equal(statSync(withAuths).mode & 0o077, 0, 'the directory is private too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
