import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerEngine, parseDockerBytes, parseMemoryPair } from './docker-engine.ts';
import { AppError } from '../errors.ts';

function engineWithBinary(binary: string): { engine: DockerEngine; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-docker-'));
  return {
    engine: new DockerEngine({ binary, stateDir: join(dir, 'state') }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('parseDockerBytes converts every unit Docker emits', () => {
  assert.equal(parseDockerBytes('0B'), 0);
  assert.equal(parseDockerBytes('512B'), 512);
  assert.equal(parseDockerBytes('1kB'), 1_000);
  assert.equal(parseDockerBytes('1KiB'), 1_024);
  assert.equal(parseDockerBytes('12.5MiB'), 13_107_200);
  assert.equal(parseDockerBytes('1GiB'), 1_073_741_824);
  assert.equal(parseDockerBytes('2TiB'), 2_199_023_255_552);
});

test('parseDockerBytes tolerates malformed input instead of producing NaN', () => {
  assert.equal(parseDockerBytes(''), 0);
  assert.equal(parseDockerBytes('garbage'), 0);
  assert.equal(parseDockerBytes('  2.5GiB  '), 2_684_354_560);
});

test('parseMemoryPair splits the "used / limit" format Docker reports', () => {
  const pair = parseMemoryPair('64.5MiB / 512MiB');
  assert.equal(pair.used, 67_633_152);
  assert.equal(pair.limit, 536_870_912);

  assert.deepEqual(parseMemoryPair('0B / 0B'), { used: 0, limit: 0 });
  assert.deepEqual(parseMemoryPair('no separator'), { used: 0, limit: 0 });
});

test('probe reports unavailability instead of throwing when the docker binary is missing', async () => {
  const { engine, cleanup } = engineWithBinary('definitely-not-a-real-docker-binary');
  try {
    const info = await engine.probe();
    assert.equal(info.name, 'docker');
    assert.equal(info.available, false);
    assert.equal(info.version, null);
    assert.match(info.detail ?? '', /not found on PATH/i);
  } finally {
    cleanup();
  }
});

test('an unavailable engine fails operations with engine_unavailable, not a raw crash', async () => {
  const { engine, cleanup } = engineWithBinary('definitely-not-a-real-docker-binary');
  try {
    await engine.probe();

    await assert.rejects(
      () => engine.ensureNetwork('ploy'),
      (error: unknown) => error instanceof AppError && error.code === 'engine_unavailable',
    );
    await assert.rejects(
      () => engine.ensureVolume('data'),
      (error: unknown) => error instanceof AppError && error.code === 'engine_unavailable',
    );
    await assert.rejects(
      () => engine.build({ imageTag: 'x', contextDir: '/tmp', dockerfilePath: 'Dockerfile' }, () => {}),
      (error: unknown) => error instanceof AppError && error.code === 'engine_unavailable',
    );
    await assert.rejects(
      () => engine.start([], () => {}),
      (error: unknown) => error instanceof AppError && error.code === 'engine_unavailable',
    );
  } finally {
    cleanup();
  }
});

test('a fake docker binary proves the CLI arguments and the secrets handling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-docker-fake-'));
  const logPath = join(dir, 'invocations.log');
  const binaryPath = join(dir, 'fake-docker');

  // A real executable that records its argv, so the engine's command line can
  // be asserted without a Docker daemon.
  const script = `#!/bin/sh
echo "$@" >> ${logPath}
case "$1" in
  version) echo "27.0.0" ;;
  build) echo "#1 DONE" ;;
  run) echo "abcdef1234567890" ;;
  inspect) echo "true" ;;
  network) echo "ploy" ;;
  volume) echo "data" ;;
  image) echo "sha256:abc" ;;
  *) echo "" ;;
esac
`;
  const { writeFileSync } = await import('node:fs');
  const { chmodSync } = await import('node:fs');
  writeFileSync(binaryPath, script, { mode: 0o755 });
  chmodSync(binaryPath, 0o755);

  const engine = new DockerEngine({ binary: binaryPath, stateDir: join(dir, 'state') });
  try {
    const info = await engine.probe();
    assert.equal(info.available, true);
    assert.equal(info.version, '27.0.0');

    // Build must request inline cache metadata so the previous image is reusable.
    const buildResult = await engine.build(
      { imageTag: 'ploy/app:dep_1', contextDir: dir, dockerfilePath: 'Dockerfile', buildArgs: { NODE_ENV: 'production' } },
      () => {},
    );
    assert.equal(buildResult.imageTag, 'ploy/app:dep_1');

    // Start a container with secrets and resource limits.
    const refs = await engine.start([
      {
        name: 'ploy-app-dep_1-0',
        imageTag: 'ploy/app:dep_1',
        internalPort: 3000,
        address: 'ploy-app-dep_1-0:3000',
        env: { DATABASE_URL: 'postgres://u:supersecret@db/app', NODE_ENV: 'production' },
        limits: { cpus: 0.5, memoryMb: 256 },
        replicas: 1,
        network: 'ploy',
        labels: { 'ploy.application': 'app_1', 'ploy.deployment': 'dep_1' },
      },
    ]);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.name, 'ploy-app-dep_1-0');
    assert.equal(refs[0]!.address, 'ploy-app-dep_1-0:3000');

    const invocations = (await import('node:fs')).readFileSync(logPath, 'utf8');

    // The build must be cache-aware.
    assert.match(invocations, /build --tag ploy\/app:dep_1/);
    assert.match(invocations, /--build-arg BUILDKIT_INLINE_CACHE=1/);
    assert.match(invocations, /--cache-from ploy\/app:dep_1/);
    assert.match(invocations, /--build-arg NODE_ENV=production/);

    // Security posture: least privilege, ceilings, and no host port published.
    assert.match(invocations, /--cap-drop ALL/);
    assert.match(invocations, /--security-opt no-new-privileges/);
    assert.match(invocations, /--cpus 0.5/);
    assert.match(invocations, /--memory 256m/);
    assert.match(invocations, /--expose 3000/);
    assert.ok(!/-p 3000:/.test(invocations), 'containers must not publish ports on the host');
    assert.match(invocations, /--network ploy/);
    assert.match(invocations, /--label ploy.application=app_1/);

    // Secrets must go through a private env file, never the argument list.
    assert.match(invocations, /--env-file/);
    assert.ok(
      !invocations.includes('supersecret'),
      'a secret must never appear in a docker invocation (it would be visible in `ps`)',
    );

    // Stats parsing against a real docker-shaped line.
    assert.equal(await engine.isRunning('ploy-app-dep_1-0'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the env file is removed after the container starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-docker-envfile-'));
  const binaryPath = join(dir, 'fake-docker');
  const { writeFileSync, existsSync, chmodSync } = await import('node:fs');
  writeFileSync(
    binaryPath,
    `#!/bin/sh
case "$1" in
  version) echo "27.0.0" ;;
  run) echo "abcdef1234567890" ;;
  *) echo "" ;;
esac
`,
    { mode: 0o755 },
  );
  chmodSync(binaryPath, 0o755);

  const stateDir = join(dir, 'state');
  const engine = new DockerEngine({ binary: binaryPath, stateDir });
  try {
    await engine.probe();
    await engine.start([
      {
        name: 'envfile-check',
        imageTag: 'x',
        internalPort: 80,
        address: 'envfile-check:80',
        env: { SECRET: 'value' },
        limits: { cpus: 1, memoryMb: 128 },
        replicas: 1,
      },
    ]);

    assert.equal(existsSync(join(stateDir, 'envfile-check.env')), false, 'the secret file must not linger on disk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a value containing a line break is rejected rather than silently corrupted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-docker-newline-'));
  const binaryPath = join(dir, 'fake-docker');
  const { writeFileSync, chmodSync } = await import('node:fs');
  writeFileSync(binaryPath, `#!/bin/sh\ncase "$1" in\n  version) echo "27.0.0" ;;\n  run) echo "abc" ;;\n  *) echo "" ;;\nesac\n`, { mode: 0o755 });
  chmodSync(binaryPath, 0o755);

  const engine = new DockerEngine({ binary: binaryPath, stateDir: join(dir, 'state') });
  try {
    await engine.probe();
    await assert.rejects(
      () =>
        engine.start([
          {
            name: 'newline-check',
            imageTag: 'x',
            internalPort: 80,
            address: 'a:80',
            env: { MULTILINE: 'line1\nline2' },
            limits: { cpus: 1, memoryMb: 128 },
            replicas: 1,
          },
        ]),
      (error: unknown) => error instanceof AppError && error.code === 'bad_request',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});