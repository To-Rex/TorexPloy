import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginDirs } from '../docker/cli.ts';
import { gitHead, resolveDockerSocket, updateConfig } from './config.ts';

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

test('update settings: defaults, a GitHub repository, a pinned image, and the bounds on the interval', () => {
  const defaults = updateConfig({});
  assert.deepEqual(defaults, { enabled: true, repository: 'To-Rex/TorexPloy', branch: 'main', image: null, container: 'ploy-control', intervalMs: 6 * 3_600_000 });

  const custom = updateConfig({ PLOY_UPDATE_CHECK: 'false', PLOY_UPDATE_REPO: 'acme/ploy-fork', PLOY_UPDATE_BRANCH: 'release/2026', PLOY_UPDATE_IMAGE: 'ghcr.io/acme/ploy:main', PLOY_CONTAINER: 'panel', PLOY_UPDATE_INTERVAL_SEC: '600' });
  assert.deepEqual(custom, { enabled: false, repository: 'acme/ploy-fork', branch: 'release/2026', image: 'ghcr.io/acme/ploy:main', container: 'panel', intervalMs: 600_000 });

  // Values that would end up on a git or docker command line are checked at startup, not when the updater runs.
  assert.throws(() => updateConfig({ PLOY_UPDATE_REPO: 'https://github.com/acme/ploy' }), /PLOY_UPDATE_REPO/);
  assert.throws(() => updateConfig({ PLOY_UPDATE_BRANCH: '--upload-pack=evil' }), /PLOY_UPDATE_BRANCH/);
  assert.throws(() => updateConfig({ PLOY_UPDATE_BRANCH: 'main..other' }), /PLOY_UPDATE_BRANCH/);
  assert.throws(() => updateConfig({ PLOY_UPDATE_IMAGE: 'ghcr.io/acme/ploy; rm -rf /' }), /PLOY_UPDATE_IMAGE/);
  assert.throws(() => updateConfig({ PLOY_UPDATE_INTERVAL_SEC: '60' }), /PLOY_UPDATE_INTERVAL_SEC/);
  assert.throws(() => updateConfig({ PLOY_UPDATE_CHECK: 'maybe' }), /PLOY_UPDATE_CHECK/);
});

test('the running commit of a checkout is read from .git: a branch ref, a packed ref, a detached head, or nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'ploy-git-'));
  try {
    assert.equal(gitHead(root), null, 'not a checkout');
    const sha = 'a'.repeat(40);
    mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${sha}\n`);
    assert.equal(gitHead(root), sha);

    // After `git gc` the ref lives in packed-refs only.
    rmSync(join(root, '.git', 'refs', 'heads', 'main'));
    writeFileSync(join(root, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${'b'.repeat(40)} refs/heads/dev\n${'c'.repeat(40)} refs/heads/main\n`);
    assert.equal(gitHead(root), 'c'.repeat(40));

    writeFileSync(join(root, '.git', 'HEAD'), `${'d'.repeat(40)}\n`);
    assert.equal(gitHead(root), 'd'.repeat(40), 'detached');

    // A worktree: .git is a file naming the real directory.
    const tree = join(root, 'tree');
    mkdirSync(tree);
    writeFileSync(join(tree, '.git'), `gitdir: ${join(root, '.git')}\n`);
    assert.equal(gitHead(tree), 'd'.repeat(40));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
