/**
 * The external builders and the dispatcher without Docker or the real CLIs:
 * fake `nixpacks`, `railpack`, `pack` and `docker` executables on PATH record
 * how they are invoked (arguments, environment, CLI config) and play the
 * parts that matter — Railpack's plan and info files, exit codes, stderr.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { AppError } from '../lib/errors.ts';
import { buildWithBuildpacks } from './buildpacks.ts';
import type { ExternalBuildRequest } from './common.ts';
import { envNames, failureTail } from './common.ts';
import { runBuild, settingsWarnings, type BuildSettings } from './index.ts';
import { buildWithNixpacks, planWithNixpacks } from './nixpacks.ts';
import { buildWithRailpack, secretsHash } from './railpack.ts';

interface Call {
  cli: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  config: { auths?: Record<string, { auth: string }> } | null;
  files: Record<string, string | null>;
}

/** The fake CLIs: each records its invocation, then behaves as `FAKE_*` variables of the test process say. */
function fakeClis(bin: string, record: string): void {
  // The test narrows PATH to the fakes, so the interpreter is named absolutely.
  const source = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const cli = basename(process.argv[1]);
const args = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(DOCKER_|BUILDKIT_|PACK_HOME|NO_COLOR|DB_PASSWORD|GREETING|NIXPACKS_|RAILPACK_|PATH$)/.test(key)));
const readConfig = () => { try { return JSON.parse(readFileSync(join(process.env.DOCKER_CONFIG ?? '', 'config.json'), 'utf8')); } catch { return null; } };
const files = {};
const fileArg = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
for (const path of [fileArg('--file'), fileArg('-f')]) if (path !== null) files[path] = existsSync(path) ? readFileSync(path, 'utf8') : null;
if (cli === 'pack') { const context = fileArg('--path'); if (context !== null) files.Procfile = existsSync(join(context, 'Procfile')) ? readFileSync(join(context, 'Procfile'), 'utf8') : null; }
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ cli, args, cwd: process.cwd(), env, config: readConfig(), files }) + '\\n');
const exit = Number(process.env['FAKE_' + cli.toUpperCase() + '_EXIT'] ?? 0);
const stderr = process.env['FAKE_' + cli.toUpperCase() + '_STDERR'];
if (cli === 'nixpacks' && args[0] === 'plan') process.stdout.write(process.env.FAKE_NIXPACKS_PLAN ?? '{}');
else process.stdout.write(cli + ' ' + args[0] + ' running\\n');
if (stderr) process.stderr.write(stderr + '\\n');
if (cli === 'railpack' && args[0] === 'prepare') {
  const plan = fileArg('--plan-out');
  const info = fileArg('--info-out');
  if (plan !== null) writeFileSync(plan, JSON.stringify({ secrets: args.filter((a, i) => args[i - 1] === '--env') }));
  if (info !== null) writeFileSync(info, process.env.FAKE_RAILPACK_INFO ?? JSON.stringify({ railpackVersion: '0.40.1', success: true, detectedProviders: ['node'], resolvedPackages: { node: { name: 'node', requestedVersion: '22', resolvedVersion: '22.23.2', source: 'package.json > engines > node' } }, logs: [{ Level: 'suggestion', Msg: 'Add a package-lock.json for more deterministic installs' }, { Level: 'info', Msg: 'Detected Node' }] }));
}
process.exit(exit);
`;
  for (const cli of ['nixpacks', 'railpack', 'pack', 'docker']) {
    writeFileSync(join(bin, cli), source);
    chmodSync(join(bin, cli), 0o755);
  }
}

function harness(clis: string[] = ['nixpacks', 'railpack', 'pack', 'docker']) {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-external-'));
  const bin = join(dir, 'bin');
  const record = join(dir, 'calls.jsonl');
  mkdirSync(bin);
  fakeClis(bin, record);
  for (const cli of ['nixpacks', 'railpack', 'pack', 'docker']) if (!clis.includes(cli)) rmSync(join(bin, cli));
  const contextDir = join(dir, 'src');
  const scratchDir = join(dir, 'scratch');
  mkdirSync(contextDir);
  writeFileSync(join(contextDir, 'package.json'), JSON.stringify({ name: 'app', scripts: { start: 'node server.js' }, engines: { node: '22' } }));
  writeFileSync(join(contextDir, 'server.js'), 'require("http").createServer().listen(3000)');
  const previousPath = process.env.PATH;
  // An empty PATH apart from the fakes: nothing real can be found.
  process.env.PATH = [bin, '/usr/bin', '/bin'].join(delimiter);
  const output: string[] = [];
  const request: ExternalBuildRequest = {
    dockerHost: 'unix:///tmp/ploy-test.sock',
    contextDir,
    scratchDir,
    imageTag: 'ploy/web-abc123:dep456',
    applicationId: 'app_1',
    deploymentId: 'dep_1',
    settings: { buildType: 'nixpacks', installCommand: 'npm ci', buildCommand: 'npm run build', startCommand: 'node server.js', buildpackBuilder: null },
    buildEnv: { DB_PASSWORD: 'hunter2', GREETING: 'salom', PATH: '/evil', DOCKER_HOST: 'unix:///evil.sock', '1BAD': 'x' },
    registryAuths: { 'ghcr.io': { auth: Buffer.from('robot:ghp_secret').toString('base64') } },
    noCache: true,
    timeoutMs: 30_000,
    onOutput: (line) => output.push(line),
  };
  return {
    dir,
    contextDir,
    scratchDir,
    request,
    output,
    calls: (): Call[] => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Call) : []),
    close: () => {
      process.env.PATH = previousPath;
      for (const key of Object.keys(process.env)) if (key.startsWith('FAKE_')) delete process.env[key];
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const LABELS = ['--label', 'ploy.managed=true', '--label', 'ploy.app=app_1', '--label', 'ploy.deployment=dep_1'];

test('variables reach a CLI by name only: reserved and invalid names are left out', () => {
  assert.deepEqual(envNames({ DB_PASSWORD: 'x', GREETING: 'y', PATH: '/evil', HOME: '/', DOCKER_HOST: 'z', BUILDKIT_PROGRESS: 'p', PACK_HOME: 'q', '1BAD': 'b', 'A-B': 'c', NIXPACKS_NODE_VERSION: '22' }), ['DB_PASSWORD', 'GREETING', 'NIXPACKS_NODE_VERSION']);
  assert.equal(failureTail('#8 downloading\n#9 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1\n------\n > [3/5] RUN npm ci:\n'), 'ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1');
  assert.equal(failureTail('plain line one\nplain line two\nplain line three'), 'plain line two plain line three');
  assert.equal(failureTail(''), '');
});

test('nixpacks: build with the panel commands, labels, named variables and no cache; the deployment daemon in the environment', async () => {
  const h = harness();
  try {
    const plan = await buildWithNixpacks(h.request);
    assert.deepEqual(plan, { mode: 'external', stack: 'nixpacks', label: 'Nixpacks', dockerfile: null, dockerfilePath: '', defaultPort: null, startCommand: 'node server.js', warnings: [] });
    const [call] = h.calls();
    assert.ok(call);
    assert.equal(call.cli, 'nixpacks');
    assert.deepEqual(call.args, [
      'build', h.contextDir, '--name', 'ploy/web-abc123:dep456',
      '--install-cmd', 'npm ci', '--build-cmd', 'npm run build', '--start-cmd', 'node server.js',
      ...LABELS,
      '--env', 'DB_PASSWORD', '--env', 'GREETING',
      '--no-cache',
    ]);
    assert.ok(!JSON.stringify(call.args).includes('hunter2'), 'secret values stay off the command line');
    assert.equal(call.env.DB_PASSWORD, 'hunter2', 'the CLI reads the value from its environment');
    assert.equal(call.env.DOCKER_HOST, 'unix:///tmp/ploy-test.sock', 'the app variable cannot redirect the CLI');
    assert.equal(call.env.DOCKER_CONFIG, join(h.scratchDir, 'docker-config'));
    assert.deepEqual(call.config?.auths, { 'ghcr.io': { auth: Buffer.from('robot:ghp_secret').toString('base64') } }, 'the docker CLI nixpacks runs signs in to the team registries');
    assert.equal(existsSync(join(h.scratchDir, 'docker-config')), false, 'the CLI config with the logins is removed afterwards');
    assert.equal(call.env.NO_COLOR, '1');
    assert.ok(call.env.PATH!.startsWith(join(h.dir, 'bin')), 'the app variable cannot change PATH');
    assert.ok(h.output.some((line) => line.includes('nixpacks.toml')), 'the log says Nixpacks reads nixpacks.toml itself');
    assert.ok(h.output.includes('nixpacks build running'), 'CLI output is streamed');
  } finally {
    h.close();
  }
});

test('nixpacks: a failing build reports the last meaningful stderr lines; a missing CLI is a builder_missing', async () => {
  const h = harness();
  try {
    process.env.FAKE_NIXPACKS_EXIT = '1';
    process.env.FAKE_NIXPACKS_STDERR = 'Generating Dockerfile\nError: No start command could be found';
    await assert.rejects(buildWithNixpacks(h.request), (error: unknown) => error instanceof AppError && error.code === 'bad_request' && error.params?.reason === 'build_failed' && /No start command could be found/.test(error.message));
    delete process.env.FAKE_NIXPACKS_EXIT;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(buildWithNixpacks({ ...h.request, signal: controller.signal }), /cancelled/i);
  } finally {
    h.close();
  }
  const bare = harness(['docker']);
  try {
    await assert.rejects(buildWithNixpacks(bare.request), (error: unknown) => error instanceof AppError && error.code === 'docker_unavailable' && error.params?.reason === 'builder_missing' && error.params.builder === 'nixpacks');
    await assert.rejects(buildWithRailpack(bare.request), (error: unknown) => error instanceof AppError && error.params?.reason === 'builder_missing' && error.params.builder === 'railpack');
    await assert.rejects(buildWithBuildpacks({ ...bare.request, settings: { ...bare.request.settings, buildType: 'heroku' } }), (error: unknown) => error instanceof AppError && error.params?.reason === 'builder_missing' && error.params.builder === 'pack');
    assert.equal(bare.calls().length, 0);
  } finally {
    bare.close();
  }
});

test('nixpacks plan: the label comes from providers and packages, warnings from stderr; nothing detected is an error', async () => {
  const h = harness();
  try {
    process.env.FAKE_NIXPACKS_PLAN = JSON.stringify({ providers: [], variables: { NIXPACKS_METADATA: 'node' }, phases: { setup: { nixPkgs: ['nodejs_22', 'npm-9_x'] }, install: { cmds: ['npm i'] } }, start: { cmd: 'node server.js' } });
    process.env.FAKE_NIXPACKS_STDERR = 'warning: no lockfile found';
    const planned = await planWithNixpacks({ contextDir: h.contextDir, settings: h.request.settings, buildEnv: h.request.buildEnv, timeoutMs: 10_000 });
    assert.equal(planned.label, 'Nixpacks · node · nodejs_22, npm-9_x');
    assert.deepEqual(planned.warnings, ['warning: no lockfile found']);
    const [call] = h.calls();
    assert.deepEqual(call!.args, ['plan', h.contextDir, '--format', 'json', '--install-cmd', 'npm ci', '--build-cmd', 'npm run build', '--start-cmd', 'node server.js', '--env', 'DB_PASSWORD', '--env', 'GREETING']);
    assert.equal(call!.env.GREETING, 'salom');

    process.env.FAKE_NIXPACKS_PLAN = JSON.stringify({ providers: ['python'], phases: { setup: {} } });
    delete process.env.FAKE_NIXPACKS_STDERR;
    const bare = await planWithNixpacks({ contextDir: h.contextDir, settings: { ...h.request.settings, startCommand: null }, buildEnv: {}, timeoutMs: 10_000 });
    assert.equal(bare.label, 'Nixpacks · python');
    assert.ok(bare.warnings.some((line) => /No start command/.test(line)));

    process.env.FAKE_NIXPACKS_PLAN = JSON.stringify({ providers: [], phases: {} });
    await assert.rejects(planWithNixpacks({ contextDir: h.contextDir, settings: h.request.settings, buildEnv: {}, timeoutMs: 10_000 }), (error: unknown) => error instanceof AppError && error.params?.reason === 'build_failed' && /could not detect/.test(error.message));
    process.env.FAKE_NIXPACKS_PLAN = 'not json';
    await assert.rejects(planWithNixpacks({ contextDir: h.contextDir, settings: h.request.settings, buildEnv: {}, timeoutMs: 10_000 }), /did not return a build plan/);
  } finally {
    h.close();
  }
});

test('railpack: prepare writes the plan, then BuildKit builds it through the frontend pinned to the CLI version, with secrets from the environment', async () => {
  const h = harness();
  try {
    const plan = await buildWithRailpack({ ...h.request, settings: { ...h.request.settings, buildType: 'railpack' } });
    assert.equal(plan.mode, 'external');
    assert.equal(plan.stack, 'railpack');
    assert.equal(plan.label, 'Railpack · node 22.23.2');
    assert.deepEqual(plan.warnings, ['Add a package-lock.json for more deterministic installs']);
    assert.equal(plan.startCommand, 'node server.js');

    const [prepare, build, ...rest] = h.calls();
    assert.equal(rest.length, 0);
    const planPath = join(h.scratchDir, 'railpack-plan.json');
    assert.equal(prepare!.cli, 'railpack');
    assert.deepEqual(prepare!.args, ['prepare', h.contextDir, '--plan-out', planPath, '--info-out', join(h.scratchDir, 'railpack-info.json'), '--build-cmd', 'npm run build', '--start-cmd', 'node server.js', '--env', 'DB_PASSWORD', '--env', 'GREETING']);
    assert.equal(prepare!.env.DB_PASSWORD, 'hunter2');
    assert.ok(h.output.some((line) => /install command is ignored/.test(line)), 'the install command cannot be passed to Railpack, and the log says so');

    assert.equal(build!.cli, 'docker');
    const hash = secretsHash(h.request.buildEnv, ['DB_PASSWORD', 'GREETING']);
    assert.equal(hash, createHash('sha256').update('DB_PASSWORD=hunter2\nGREETING=salom\n').digest('hex'));
    assert.deepEqual(build!.args, [
      'buildx', 'build', '--progress=plain', '--load', '--tag', 'ploy/web-abc123:dep456', '--file', planPath,
      '--build-arg', 'BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v0.40.1',
      '--build-arg', 'cache-key=app_1',
      '--build-arg', `secrets-hash=${hash}`,
      ...LABELS,
      '--secret', 'id=DB_PASSWORD,env=DB_PASSWORD', '--secret', 'id=GREETING,env=GREETING',
      '--no-cache',
      h.contextDir,
    ]);
    assert.ok(!JSON.stringify(build!.args).includes('hunter2'));
    assert.equal(build!.env.DB_PASSWORD, 'hunter2', 'BuildKit reads each secret from the docker CLI environment');
    assert.equal(build!.env.DOCKER_HOST, 'unix:///tmp/ploy-test.sock');
    assert.deepEqual(build!.config?.auths, { 'ghcr.io': { auth: Buffer.from('robot:ghp_secret').toString('base64') } }, 'the team registry logins are in the build CLI config');
    assert.equal(existsSync(join(h.scratchDir, 'docker-config')), false, 'the CLI config with the logins is removed afterwards');
    assert.deepEqual(JSON.parse(build!.files[planPath]!), { secrets: ['DB_PASSWORD', 'GREETING'] }, 'the plan prepare wrote is what BuildKit builds');
    assert.ok(h.output.some((line) => line.includes('frontend ghcr.io/railwayapp/railpack-frontend:v0.40.1')));
  } finally {
    h.close();
  }
});

test('railpack: a plan that failed (exit 0, success false) stops before Docker with Railpack’s reason', async () => {
  const h = harness();
  try {
    process.env.FAKE_RAILPACK_INFO = JSON.stringify({ railpackVersion: '0.40.1', success: false, logs: [{ Level: 'warn', Msg: 'script start.sh not found' }, { Level: 'error', Msg: 'Railpack could not determine how to build the app.\n\nThe following languages are supported:' }] });
    await assert.rejects(buildWithRailpack({ ...h.request, settings: { ...h.request.settings, buildType: 'railpack' } }), (error: unknown) => error instanceof AppError && error.params?.reason === 'build_failed' && error.message === 'Railpack could not determine how to build the app.');
    assert.deepEqual(h.calls().map((call) => call.cli), ['railpack']);
    process.env.FAKE_RAILPACK_EXIT = '75';
    process.env.FAKE_RAILPACK_STDERR = 'failed to fetch mise registry: connection reset';
    await assert.rejects(buildWithRailpack({ ...h.request, settings: { ...h.request.settings, buildType: 'railpack' } }), /railpack prepare failed: failed to fetch mise registry: connection reset/);
  } finally {
    h.close();
  }
});

test('buildpacks: pack builds a staging tag with the vendor builder, the start command through a Procfile, then the image is labelled and the staging tag dropped', async () => {
  const h = harness();
  try {
    const plan = await buildWithBuildpacks({ ...h.request, settings: { ...h.request.settings, buildType: 'heroku' } });
    assert.equal(plan.label, 'Heroku Buildpacks (heroku/builder:24)');
    assert.equal(plan.stack, 'heroku');
    assert.equal(plan.startCommand, 'node server.js');
    const [pack, relabel, remove, ...rest] = h.calls();
    assert.equal(rest.length, 0);
    assert.equal(pack!.cli, 'pack');
    assert.deepEqual(pack!.args, [
      'build', 'ploy/web-abc123:dep456-cnb', '--path', h.contextDir, '--builder', 'heroku/builder:24', '--pull-policy', 'if-not-present', '--trust-builder', '--no-color',
      '--default-process', 'web',
      '--env', 'DB_PASSWORD', '--env', 'GREETING',
      '--clear-cache',
    ]);
    assert.equal(pack!.env.DB_PASSWORD, 'hunter2');
    assert.equal(pack!.env.PACK_HOME, join(h.scratchDir, 'pack-home'));
    assert.equal(pack!.env.DOCKER_HOST, 'unix:///tmp/ploy-test.sock');
    assert.deepEqual(pack!.config?.auths, { 'ghcr.io': { auth: Buffer.from('robot:ghp_secret').toString('base64') } });
    assert.equal(pack!.files.Procfile, 'web: node server.js\n', 'the start command is a Procfile entry the builder picks up');

    assert.equal(relabel!.cli, 'docker');
    const dockerfile = join(h.scratchDir, 'labels', 'Dockerfile');
    assert.deepEqual(relabel!.args, ['buildx', 'build', '--progress=plain', '--load', '--tag', 'ploy/web-abc123:dep456', '--file', dockerfile, ...LABELS, join(h.scratchDir, 'labels')]);
    assert.equal(relabel!.files[dockerfile], 'FROM ploy/web-abc123:dep456-cnb\n');
    assert.deepEqual(remove!.args, ['image', 'rm', 'ploy/web-abc123:dep456-cnb']);
    assert.equal(existsSync(join(h.scratchDir, 'docker-config')), false);
  } finally {
    h.close();
  }

  const paketo = harness();
  try {
    const plan = await buildWithBuildpacks({ ...paketo.request, noCache: false, settings: { buildType: 'paketo', installCommand: null, buildCommand: null, startCommand: null, buildpackBuilder: 'registry.example.uz/team/builder:1' } });
    assert.equal(plan.label, 'Paketo Buildpacks (registry.example.uz/team/builder:1)');
    const [pack] = paketo.calls();
    assert.deepEqual(pack!.args, ['build', 'ploy/web-abc123:dep456-cnb', '--path', paketo.contextDir, '--builder', 'registry.example.uz/team/builder:1', '--pull-policy', 'if-not-present', '--trust-builder', '--no-color', '--env', 'DB_PASSWORD', '--env', 'GREETING']);
    assert.equal(pack!.files.Procfile, null, 'without a start command the repository decides');
    assert.equal(existsSync(join(paketo.contextDir, 'Procfile')), false);

    // A failed pack build leaves no image behind (pack tags only on success), so nothing is removed either.
    process.env.FAKE_PACK_EXIT = '1';
    process.env.FAKE_PACK_STDERR = 'ERROR: failed to build: executing lifecycle: failed with status code: 51';
    await assert.rejects(buildWithBuildpacks({ ...paketo.request, settings: { ...paketo.request.settings, buildType: 'paketo' } }), (error: unknown) => error instanceof AppError && error.params?.reason === 'build_failed' && /status code: 51/.test(error.message));
    assert.deepEqual(paketo.calls().slice(-2).map((call) => [call.cli, call.args[0]]), [['docker', 'image'], ['pack', 'build']]);
    assert.equal(existsSync(join(paketo.scratchDir, 'docker-config')), false);

    // A failed relabel drops the staging tag, so a half-made image never lingers.
    delete process.env.FAKE_PACK_EXIT;
    delete process.env.FAKE_PACK_STDERR;
    process.env.FAKE_DOCKER_EXIT = '1';
    process.env.FAKE_DOCKER_STDERR = 'ERROR: failed to solve: image not found';
    await assert.rejects(buildWithBuildpacks({ ...paketo.request, settings: { ...paketo.request.settings, buildType: 'paketo' } }), /docker buildx build failed: ERROR: failed to solve: image not found/);
    assert.deepEqual(paketo.calls().slice(-3).map((call) => [call.cli, call.args[0], call.args[1]]), [['pack', 'build', 'ploy/web-abc123:dep456-cnb'], ['docker', 'buildx', 'build'], ['docker', 'image', 'rm']]);
  } finally {
    paketo.close();
  }
});

test('the dispatcher routes by build type, warns about settings a builder ignores, and keeps TorexBuilder on docker buildx', async () => {
  const h = harness();
  const settings = (overrides: Partial<BuildSettings>): BuildSettings => ({
    kind: 'web',
    buildType: 'nixpacks',
    dockerfilePath: 'Dockerfile',
    installCommand: null,
    buildCommand: null,
    startCommand: null,
    outputDirectory: null,
    buildStage: null,
    buildpackBuilder: null,
    systemPackages: null,
    ...overrides,
  });
  try {
    assert.deepEqual(settingsWarnings(settings({ buildType: 'railpack', installCommand: 'npm ci', buildStage: 'runtime', buildpackBuilder: 'x/y:1', systemPackages: 'ffmpeg' })), [
      'The build stage only applies to Dockerfile builds',
      'The builder image only applies to buildpack builds',
      'System packages only apply to TorexBuilder builds',
      'Railpack has no install command override; set it in railpack.json',
    ]);
    assert.deepEqual(settingsWarnings(settings({ buildType: 'heroku', buildCommand: 'make' })), ['Buildpacks ignore the install and build commands; configure them through project.toml or the builder’s variables']);
    assert.deepEqual(settingsWarnings(settings({ buildType: 'torex', systemPackages: 'ffmpeg' })), []);
    assert.deepEqual(settingsWarnings(settings({ buildType: 'dockerfile', buildStage: 'runtime' })), []);

    const plans: string[] = [];
    const base = { ...h.request, buildEnv: { DB_PASSWORD: 'hunter2' }, onPlan: (plan: { label: string; mode: string }) => plans.push(`${plan.mode}:${plan.label}`) };

    // Heroku buildpacks: pack, with the build-stage warning noted before anything runs.
    const heroku = await runBuild({ ...base, settings: settings({ buildType: 'heroku', buildStage: 'runtime' }) });
    assert.equal(heroku.plan.mode, 'external');
    assert.deepEqual(heroku.plan.warnings, ['The build stage only applies to Dockerfile builds']);
    assert.equal(h.calls()[0]!.cli, 'pack');
    assert.ok(h.output.includes('Note: The build stage only applies to Dockerfile builds'));
    assert.deepEqual(plans, ['external:Heroku Buildpacks (heroku/builder:24)']);

    // Repository Dockerfile: docker buildx build with --target and the variable as a named build arg.
    writeFileSync(join(h.contextDir, 'Dockerfile'), 'FROM node:22-alpine AS build\nFROM build AS runtime\nCMD ["node", "server.js"]\n');
    const dockerfile = await runBuild({ ...base, settings: settings({ buildType: 'dockerfile', buildStage: 'runtime' }) });
    assert.equal(dockerfile.plan.mode, 'dockerfile');
    const build = h.calls().at(-1)!;
    assert.equal(build.cli, 'docker');
    assert.deepEqual(build.args, [
      'buildx', 'build', '--progress=plain', '--load', '--tag', 'ploy/web-abc123:dep456', ...LABELS, '--no-cache',
      '--file', join(h.contextDir, 'Dockerfile'), '--target', 'runtime', '--build-arg', 'DB_PASSWORD', h.contextDir,
    ]);
    assert.equal(build.env.DB_PASSWORD, 'hunter2');
    assert.equal(plans.at(-1), 'dockerfile:Dockerfile (Dockerfile)');

    // TorexBuilder: the generated Dockerfile goes to the scratch directory and variables through a secret mount.
    rmSync(join(h.contextDir, 'Dockerfile'));
    const torex = await runBuild({ ...base, settings: settings({ buildType: 'torex', systemPackages: 'ffmpeg' }) });
    assert.equal(torex.plan.mode, 'generated');
    assert.equal(torex.plan.stack, 'node');
    assert.ok(torex.plan.dockerfile?.includes('FROM'));
    const generated = h.calls().at(-1)!;
    assert.equal(generated.cli, 'docker');
    assert.ok(generated.args.includes('--secret'));
    assert.equal(generated.args[generated.args.indexOf('--secret') + 1], `id=ploy_env,src=${join(h.scratchDir, 'build.env')}`);
    assert.equal(generated.args[generated.args.indexOf('--file') + 1], join(h.scratchDir, 'Dockerfile'));
    assert.ok(!generated.args.includes('--target'));
    assert.ok(!generated.args.includes('--build-arg'));
    assert.ok(plans.at(-1)!.startsWith('generated:'));
  } finally {
    h.close();
  }
});
