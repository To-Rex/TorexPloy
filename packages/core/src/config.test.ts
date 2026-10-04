import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from './config.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ploy-config-'));
}

test('loadConfig applies defaults and creates the data directory', () => {
  const dir = tempDir();
  try {
    const config = loadConfig({ dataDir: dir }, {});
    assert.equal(config.port, 4000);
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.nodeEnv, 'development');
    assert.equal(config.logLevel, 'debug');
    assert.equal(config.engine, 'docker');
    assert.equal(config.proxy, 'caddy');
    assert.equal(config.databasePath, join(dir, 'ploy.db'));
    assert.equal(statSync(dir).isDirectory(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('production defaults to info logging', () => {
  const dir = tempDir();
  try {
    const config = loadConfig({ dataDir: dir, nodeEnv: 'production' }, {});
    assert.equal(config.isProduction, true);
    assert.equal(config.logLevel, 'info');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generates a persistent secret key on first boot with 0600 permissions', () => {
  const dir = tempDir();
  try {
    const first = loadConfig({ dataDir: dir }, {});
    assert.equal(first.secretKeyGenerated, true);
    assert.ok(first.secretKey.length >= 32);

    const keyPath = join(dir, 'secret.key');
    assert.equal(readFileSync(keyPath, 'utf8').trim(), first.secretKey);

    // Permissions are enforced where the filesystem supports it.
    if (process.platform !== 'win32') {
      assert.equal(statSync(keyPath).mode & 0o777, 0o600);
    }

    const second = loadConfig({ dataDir: dir }, {});
    assert.equal(second.secretKeyGenerated, false);
    assert.equal(second.secretKey, first.secretKey, 'key must be stable across restarts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit secret key takes precedence and is not written to disk', () => {
  const dir = tempDir();
  try {
    const key = 'x'.repeat(40);
    const config = loadConfig({ dataDir: dir, secretKey: key }, {});
    assert.equal(config.secretKey, key);
    assert.equal(config.secretKeyGenerated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects a short secret key', () => {
  const dir = tempDir();
  try {
    assert.throws(() => loadConfig({ dataDir: dir, secretKey: 'too-short' }, {}), ConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reads and validates values from the environment', () => {
  const dir = tempDir();
  try {
    const config = loadConfig({ dataDir: dir }, {
      PLOY_PORT: '8080',
      PLOY_HOST: '127.0.0.1',
      PLOY_PUBLIC_URL: 'https://ploy.example.com',
      PLOY_ENGINE: 'local',
      PLOY_PROXY: 'embedded',
      PLOY_MAX_CONCURRENT_BUILDS: '4',
      NODE_ENV: 'production',
    });
    assert.equal(config.port, 8080);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.publicUrl, 'https://ploy.example.com');
    assert.equal(config.engine, 'local');
    assert.equal(config.proxy, 'embedded');
    assert.equal(config.maxConcurrentBuilds, 4);
    assert.equal(config.isProduction, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects malformed environment values instead of silently falling back', () => {
  const dir = tempDir();
  try {
    assert.throws(() => loadConfig({ dataDir: dir }, { PLOY_PORT: 'not-a-port' }), ConfigError);
    assert.throws(() => loadConfig({ dataDir: dir }, { PLOY_PORT: '70000' }), ConfigError);
    assert.throws(() => loadConfig({ dataDir: dir }, { PLOY_ENGINE: 'kubernetes' }), ConfigError);
    assert.throws(() => loadConfig({ dataDir: dir }, { PLOY_PUBLIC_URL: 'example.com' }), ConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty environment string is treated as unset', () => {
  const dir = tempDir();
  try {
    const config = loadConfig({ dataDir: dir }, { PLOY_PORT: '   ' });
    assert.equal(config.port, 4000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});