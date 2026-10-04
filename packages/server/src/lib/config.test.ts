import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginDirs } from '../docker/cli.ts';
import { resolveDockerSocket } from './config.ts';

const none = () => false;

test('an explicit socket or a unix DOCKER_HOST wins', () => {
  assert.equal(resolveDockerSocket({ PLOY_DOCKER_SOCKET: '/srv/docker.sock', DOCKER_HOST: 'unix:///other.sock' }, none, '/home/u'), '/srv/docker.sock');
  assert.equal(resolveDockerSocket({ DOCKER_HOST: 'unix:///Users/u/.colima/work/docker.sock' }, none, '/home/u'), '/Users/u/.colima/work/docker.sock');
  // A TCP DOCKER_HOST is not a socket path; detection continues.
  assert.equal(resolveDockerSocket({ DOCKER_HOST: 'tcp://10.0.0.5:2375' }, none, '/home/u'), '/var/run/docker.sock');
});

test('the docker CLI current context is honoured (Docker Desktop on macOS)', () => {
  const home = mkdtempSync(join(tmpdir(), 'ploy-home-'));
  try {
    const socket = join(home, '.docker', 'run', 'docker.sock');
    const meta = join(home, '.docker', 'contexts', 'meta', createHash('sha256').update('desktop-linux').digest('hex'));
    mkdirSync(meta, { recursive: true });
    writeFileSync(join(home, '.docker', 'config.json'), JSON.stringify({ currentContext: 'desktop-linux' }));
    writeFileSync(join(meta, 'meta.json'), JSON.stringify({ Name: 'desktop-linux', Endpoints: { docker: { Host: `unix://${socket}` } } }));
    // /var/run/docker.sock does not exist on this Mac; the context's socket does.
    assert.equal(resolveDockerSocket({}, (path) => path === socket, home), socket);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('without settings, the first socket that exists is used, in a sensible order', () => {
  const home = '/Users/u';
  assert.equal(resolveDockerSocket({}, (path) => path === '/var/run/docker.sock' || path === '/Users/u/.orbstack/run/docker.sock', home), '/var/run/docker.sock');
  assert.equal(resolveDockerSocket({}, (path) => path === '/Users/u/.docker/run/docker.sock', home), '/Users/u/.docker/run/docker.sock');
  assert.equal(resolveDockerSocket({}, (path) => path === '/Users/u/.orbstack/run/docker.sock', home), '/Users/u/.orbstack/run/docker.sock');
  assert.equal(resolveDockerSocket({}, (path) => path === '/Users/u/.colima/default/docker.sock', home), '/Users/u/.colima/default/docker.sock');
  assert.equal(resolveDockerSocket({ XDG_RUNTIME_DIR: '/run/user/1000' }, (path) => path === '/run/user/1000/docker.sock', home), '/run/user/1000/docker.sock');
  assert.equal(resolveDockerSocket({}, none, home), '/var/run/docker.sock', 'nothing found: the conventional path, so the error names it');
});

test('CLI plugin directories are listed only when they exist', () => {
  const dirs = pluginDirs('/Users/u', (path) => path === '/Users/u/.docker/cli-plugins' || path === '/opt/homebrew/lib/docker/cli-plugins');
  assert.deepEqual(dirs, ['/Users/u/.docker/cli-plugins', '/opt/homebrew/lib/docker/cli-plugins']);
});
