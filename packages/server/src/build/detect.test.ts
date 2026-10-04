import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppError } from '../lib/errors.ts';
import { nodeMajor, planBuild, renderEnvFile, type BuildInput, type BuildPlan } from './detect.ts';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-detect-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function input(dir: string, overrides: Partial<BuildInput> = {}): BuildInput {
  return { contextDir: dir, buildType: 'torex', dockerfilePath: 'Dockerfile', installCommand: null, buildCommand: null, startCommand: null, outputDirectory: null, systemPackages: [], buildStage: null, kind: 'web', ...overrides };
}

/** Plans a throwaway repository; `root` points the context at a sub-directory (the panel's Root Directory). */
async function plan(files: Record<string, string>, overrides: Partial<BuildInput> = {}, root = ''): Promise<BuildPlan> {
  const dir = repo(files);
  try {
    return await planBuild(input(join(dir, root), overrides));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const reason = (expected: string) => (error: unknown): boolean => error instanceof AppError && error.params?.reason === expected;
const pkg = (fields: Record<string, unknown>): string => JSON.stringify(fields);

// ---------------------------------------------------------------------------
// Existing behaviour
// ---------------------------------------------------------------------------

test('a repository Dockerfile always wins in torex mode', async () => {
  const dir = repo({ Dockerfile: 'FROM scratch', 'package.json': '{}' });
  try {
    const plan = await planBuild(input(dir, { buildStage: 'runtime' }));
    assert.equal(plan.mode, 'dockerfile');
    assert.equal(plan.buildStage, 'runtime');
    assert.match(plan.label, /found in the repository/);
    assert.deepEqual(plan.warnings, []);
    await assert.rejects(planBuild(input(dir, { buildType: 'dockerfile', dockerfilePath: 'docker/Prod.Dockerfile' })), /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node: package manager, start script and build caching are detected', async () => {
  const dir = repo({ 'package.json': pkg({ scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '15' } }), 'pnpm-lock.yaml': '' });
  try {
    const plan = await planBuild(input(dir));
    assert.equal(plan.stack, 'node');
    assert.match(plan.label, /Next\.js · pnpm · Node 24/);
    assert.match(plan.dockerfile!, /pnpm install --frozen-lockfile/);
    assert.match(plan.dockerfile!, /--mount=type=cache,target=\/app\/\.next\/cache/);
    assert.match(plan.dockerfile!, /--mount=type=secret,id=ploy_env/);
    assert.match(plan.dockerfile!, /CMD \["sh","-c","exec pnpm run start"\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node: a Vite SPA without a server becomes a static Caddy image', async () => {
  const dir = repo({ 'package.json': pkg({ scripts: { build: 'vite build' }, devDependencies: { vite: '7' } }), 'package-lock.json': '{}' });
  try {
    const plan = await planBuild(input(dir));
    assert.equal(plan.stack, 'static-node');
    assert.equal(plan.defaultPort, 8080);
    assert.match(plan.dockerfile!, /FROM caddy:2\.11-alpine/);
    assert.match(plan.dockerfile!, /npm ci --include=dev/);
    assert.match(plan.dockerfile!, /try_files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node: an app with no way to start fails with an actionable error', async () => {
  const dir = repo({ 'package.json': pkg({ dependencies: { express: '5' } }) });
  try {
    await assert.rejects(planBuild(input(dir)), /"start" script, a Procfile, or set a start command/);
    const plan = await planBuild(input(dir, { startCommand: 'node server.mjs' }));
    assert.match(plan.dockerfile!, /exec node server\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nodeMajor honors pins and resolves ranges to an LTS line', () => {
  assert.equal(nodeMajor({ engines: { node: '20.x' } }, null), 20);
  assert.equal(nodeMajor({ engines: { node: '>=18' } }, null), 24);
  assert.equal(nodeMajor({ engines: { node: '22.x || 24.x || 26.x' } }, null), 24);
  assert.equal(nodeMajor({}, 'v23.4.0\n'), 24);
  assert.equal(nodeMajor({}, '# comment\n22'), 22);
  assert.equal(nodeMajor({}, null), 24);
});

test('Python: FastAPI entrypoint and the pinned interpreter are detected', async () => {
  const dir = repo({
    'requirements.txt': 'fastapi\nuvicorn[standard]\n',
    'main.py': 'from fastapi import FastAPI\napi = FastAPI()\n',
    '.python-version': '# pinned\n3.13\n',
  });
  try {
    const plan = await planBuild(input(dir));
    assert.match(plan.label, /FastAPI · pip · Python 3\.13/);
    assert.equal(plan.startCommand, "uvicorn main:api --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips='*'");
    assert.match(plan.dockerfile!, /FROM python:3\.13-slim/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Python: uv projects use the lockfile and the virtualenv on PATH', async () => {
  const dir = repo({ 'pyproject.toml': '[project]\nrequires-python = ">=3.12"\n', 'uv.lock': '', Procfile: 'web: python -m app\n' });
  try {
    const plan = await planBuild(input(dir));
    assert.match(plan.dockerfile!, /uv sync --frozen --no-dev/);
    assert.match(plan.dockerfile!, /ENV PATH="\/app\/\.venv\/bin:\$PATH"/);
    assert.equal(plan.startCommand, 'python -m app');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Go, Rust, PHP and plain static sites get dedicated plans', async () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ 'go.mod': 'module x\n\ngo 1.24\n', 'cmd/api/main.go': 'package main' }, /go build .* \.\/cmd\/api/],
    [{ 'Cargo.toml': '[package]\nname = "svc"\n' }, /cp target\/release\/svc \/out\/server/],
    [{ 'composer.json': '{"require":{"php":"^8.4"}}', 'public/index.php': '' }, /FROM php:8\.4-apache[\s\S]*\/var\/www\/html\/public/],
    [{ 'index.html': '<h1>hi</h1>' }, /COPY \. \/srv/],
  ];
  for (const [files, expected] of cases) {
    const dir = repo(files);
    try {
      assert.match((await planBuild(input(dir))).dockerfile!, expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('an unrecognizable repository is rejected rather than guessed', async () => {
  const dir = repo({ 'README.md': '# nothing to run' });
  try {
    await assert.rejects(planBuild(input(dir)), /Could not detect/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderEnvFile produces shell-safe assignments for hostile values', () => {
  const text = renderEnvFile({ A: "it's", B: '$(rm -rf /)', C: 'line1\nline2' });
  assert.equal(text, "A='it'\\''s'\nB='$(rm -rf /)'\nC='line1\nline2'");
});

// ---------------------------------------------------------------------------
// Cross-cutting: runtime stage shape, config file, system packages
// ---------------------------------------------------------------------------

test('generated images label the runtime stage, expose a port and run as a non-root user', async () => {
  const node = await plan({ 'package.json': pkg({ scripts: { start: 'node server.js' } }), 'package-lock.json': '{}' });
  assert.match(node.dockerfile!, /FROM node:24-slim\nLABEL torexploy\.builder=torex torexploy\.stack=node\n/);
  assert.match(node.dockerfile!, /ENV NODE_ENV=production PORT=3000\n/);
  assert.match(node.dockerfile!, /\nUSER node\nEXPOSE 3000\n/);
  assert.match(node.dockerfile!, /COPY --from=build --chown=node:node \/app \/app/);
  assert.match(node.dockerfile!, /npm prune --omit=dev/);
  assert.equal(node.defaultPort, 3000);

  const python = await plan({ 'requirements.txt': 'flask==3\ngunicorn\n', 'app.py': 'from flask import Flask\napp = Flask(__name__)\n' });
  assert.match(python.dockerfile!, /FROM python:3\.13-slim AS build[\s\S]*FROM python:3\.13-slim\nLABEL torexploy\.builder=torex torexploy\.stack=python/);
  assert.match(python.dockerfile!, /useradd --system --uid 10001[\s\S]*COPY --from=build --chown=app:app \/app \/app\nUSER app\nEXPOSE 8000/);
  assert.match(python.startCommand!, /^gunicorn app:app --bind 0\.0\.0\.0:\$PORT --workers \$\{WEB_CONCURRENCY:-\$\(nproc\)\}/);
});

test('Node: manifests are copied before the sources so the install layer is cached', async () => {
  const cached = await plan({ 'package.json': pkg({ scripts: { start: 'node index.js' } }), 'package-lock.json': '{}', '.npmrc': 'fund=false' });
  assert.match(cached.dockerfile!, /COPY package\.json package-lock\.json \.npmrc \.\/\nRUN [^\n]*npm ci --include=dev[^\n]*\nCOPY \. \./);
  // A postinstall script needs the sources, so everything is copied first.
  const lifecycle = await plan({ 'package.json': pkg({ scripts: { start: 'node index.js', postinstall: 'prisma generate' } }), 'package-lock.json': '{}' });
  assert.match(lifecycle.dockerfile!, /WORKDIR \/app\nENV [^\n]*\nCOPY \. \.\nRUN [^\n]*npm ci/);
});

test('torexploy.json fills in commands, packages and runtimes, and panel settings win over it', async () => {
  const files = {
    'package.json': pkg({ scripts: { start: 'node a.js', build: 'tsc', 'build:prod': 'tsc -p prod' }, dependencies: { express: '5' } }),
    'package-lock.json': '{}',
    'torexploy.json': JSON.stringify({ startCommand: 'node file.js', buildCommand: 'npm run build:prod', systemPackages: ['libvips42'], runtime: { node: 22 }, unknownKey: true }),
  };
  const fromFile = await plan(files);
  assert.match(fromFile.dockerfile!, /exec node file\.js/);
  assert.match(fromFile.dockerfile!, /npm run build:prod/);
  assert.match(fromFile.dockerfile!, /apt-get install -y --no-install-recommends ca-certificates dumb-init libvips42/);
  assert.match(fromFile.label, /Node 22/);
  const fromPanel = await plan(files, { startCommand: 'node panel.js', systemPackages: ['ffmpeg'] });
  assert.match(fromPanel.dockerfile!, /exec node panel\.js/);
  assert.match(fromPanel.dockerfile!, /dumb-init ffmpeg libvips42/);
});

test('a malformed torexploy.json is rejected with a stable reason', async () => {
  const base = { 'package.json': pkg({ scripts: { start: 'node a.js' } }) };
  await assert.rejects(plan({ ...base, 'torexploy.json': '{ not json' }), reason('config_invalid'));
  await assert.rejects(plan({ ...base, 'torexploy.json': '[]' }), reason('config_invalid'));
  await assert.rejects(plan({ ...base, 'torexploy.json': '{"startCommand": 42}' }), reason('config_invalid'));
  await assert.rejects(plan({ ...base, 'torexploy.json': '{"systemPackages": ["ok", "rm -rf /"]}' }), reason('config_invalid'));
  await assert.rejects(plan(base, { systemPackages: ['bad name'] }), reason('system_package_invalid'));
});

test('systemPackages install with apt on Debian images and apk on Alpine ones', async () => {
  const go = await plan({ 'go.mod': 'module x\n\ngo 1.24\n', 'go.sum': '', 'main.go': '' }, { systemPackages: ['imagemagick'] });
  assert.match(go.dockerfile!, /FROM alpine:3\.21\nLABEL [^\n]*\nRUN apk add --no-cache ca-certificates tzdata imagemagick/);
  const site = await plan({ 'index.html': '' }, { systemPackages: ['curl'] });
  assert.match(site.dockerfile!, /FROM caddy:2\.11-alpine\nLABEL [^\n]*\nRUN apk add --no-cache curl/);
  const php = await plan({ 'index.php': '' }, { systemPackages: ['ghostscript'] });
  assert.match(php.dockerfile!, /apt-get install -y --no-install-recommends ghostscript/);
});

// ---------------------------------------------------------------------------
// Node frameworks
// ---------------------------------------------------------------------------

test('Next.js standalone output ships only the standalone bundle, static files and public/', async () => {
  const files = {
    'package.json': pkg({ scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '15', react: '19' } }),
    'package-lock.json': '{}',
    'next.config.mjs': "export default { output: 'standalone' };\n",
    '.nvmrc': '22\n',
    'public/robots.txt': '',
  };
  const standalone = await plan(files);
  assert.equal(standalone.label, 'Next.js (standalone) · npm · Node 22');
  assert.equal(standalone.startCommand, 'node server.js');
  assert.match(standalone.dockerfile!, /COPY --from=build --chown=node:node \/app\/public \/app\/public\nCOPY --from=build --chown=node:node \/app\/\.next\/standalone \/app\nCOPY --from=build --chown=node:node \/app\/\.next\/static \/app\/\.next\/static/);
  assert.match(standalone.dockerfile!, /HOSTNAME=0\.0\.0\.0/);
  assert.doesNotMatch(standalone.dockerfile!, /npm prune/);
  const exported = await plan({ ...files, 'next.config.mjs': "export default { output: 'export' };\n" });
  assert.equal(exported.stack, 'static-node');
  assert.match(exported.dockerfile!, /for d in out dist build/);
});

test('Nuxt, SvelteKit, Remix/React Router, Astro, Angular and NestJS get their production entrypoints', async () => {
  const nuxt = await plan({ 'package.json': pkg({ scripts: { build: 'nuxt build' }, dependencies: { nuxt: '3' } }), 'package-lock.json': '{}' });
  assert.equal(nuxt.startCommand, 'node .output/server/index.mjs');
  assert.match(nuxt.dockerfile!, /COPY --from=build --chown=node:node \/app\/\.output \/app\/\.output/);
  assert.doesNotMatch(nuxt.dockerfile!, /COPY --from=build --chown=node:node \/app \/app/);

  const kit = { 'package.json': pkg({ scripts: { build: 'vite build' }, devDependencies: { '@sveltejs/kit': '2', '@sveltejs/adapter-node': '5', vite: '6' } }), 'package-lock.json': '{}' };
  const kitNode = await plan({ ...kit, 'svelte.config.js': "import adapter from '@sveltejs/adapter-node';\nexport default { kit: { adapter: adapter() } };\n" });
  assert.equal(kitNode.startCommand, 'node build');
  assert.ok(kitNode.warnings.some((w) => w.includes('ORIGIN')));
  const kitStatic = await plan({ ...kit, 'svelte.config.js': "import adapter from '@sveltejs/adapter-static';\nexport default { kit: { adapter: adapter() } };\n" });
  assert.equal(kitStatic.stack, 'static-node');
  const kitAuto = await plan({ ...kit, 'svelte.config.js': "import adapter from '@sveltejs/adapter-auto';\n" });
  assert.ok(kitAuto.warnings.some((w) => w.includes('adapter-auto')));

  const rr = await plan({ 'package.json': pkg({ scripts: { build: 'react-router build' }, dependencies: { '@react-router/serve': '7' } }), 'package-lock.json': '{}' });
  assert.equal(rr.startCommand, 'react-router-serve ./build/server/index.js');
  assert.match(rr.label, /^React Router · npm/);
  const remix = await plan({ 'package.json': pkg({ scripts: { build: 'remix vite:build', start: 'remix-serve ./build/server/index.js' }, dependencies: { '@remix-run/serve': '2' } }), 'package-lock.json': '{}' });
  assert.equal(remix.startCommand, 'npm run start');

  const astroBase = { 'package.json': pkg({ scripts: { build: 'astro build' }, dependencies: { astro: '5' } }), 'package-lock.json': '{}' };
  assert.equal((await plan(astroBase)).stack, 'static-node');
  const astroNode = await plan({ 'package.json': pkg({ scripts: { build: 'astro build' }, dependencies: { astro: '5', '@astrojs/node': '9' } }), 'package-lock.json': '{}' });
  assert.equal(astroNode.startCommand, 'node ./dist/server/entry.mjs');
  assert.equal(astroNode.defaultPort, 4321);

  const angularBase = { 'angular.json': JSON.stringify({ projects: { shop: {} } }), 'package-lock.json': '{}' };
  const angularStatic = await plan({ ...angularBase, 'package.json': pkg({ scripts: { build: 'ng build', start: 'ng serve' }, dependencies: { '@angular/core': '19' } }) });
  assert.equal(angularStatic.stack, 'static-node');
  assert.match(angularStatic.dockerfile!, /for d in dist\/shop\/browser/);
  const angularSsr = await plan({ ...angularBase, 'package.json': pkg({ scripts: { build: 'ng build' }, dependencies: { '@angular/core': '19', '@angular/ssr': '19' } }) });
  assert.equal(angularSsr.startCommand, 'node dist/shop/server/server.mjs');
  assert.equal(angularSsr.defaultPort, 4000);

  const nest = await plan({ 'package.json': pkg({ scripts: { build: 'nest build', start: 'nest start', 'start:prod': 'node dist/main' }, dependencies: { '@nestjs/core': '11' }, devDependencies: { '@nestjs/cli': '11' } }), 'package-lock.json': '{}' });
  assert.equal(nest.startCommand, 'npm run start:prod');
  assert.match(nest.dockerfile!, /npm prune --omit=dev/);
  const nestBare = await plan({ 'package.json': pkg({ scripts: { build: 'nest build' }, dependencies: { '@nestjs/core': '11' } }), 'package-lock.json': '{}' });
  assert.equal(nestBare.startCommand, 'node dist/main.js');
});

test('Node: a start command that runs a dev dependency keeps dev dependencies and warns', async () => {
  const plan1 = await plan({ 'package.json': pkg({ scripts: { start: 'tsx src/index.ts' }, dependencies: { hono: '4' }, devDependencies: { tsx: '4' } }), 'package-lock.json': '{}' });
  assert.doesNotMatch(plan1.dockerfile!, /npm prune/);
  assert.ok(plan1.warnings.some((w) => w.includes('runs tsx, a dev dependency')));
  const plan2 = await plan({ 'package.json': pkg({ scripts: { start: 'node dist/index.js' }, dependencies: { hono: '4' }, devDependencies: { tsx: '4' } }), 'package-lock.json': '{}' });
  assert.match(plan2.dockerfile!, /npm prune --omit=dev/);
});

test('Node: packageManager, Yarn Berry and Bun versions are respected exactly', async () => {
  const pnpm = await plan({ 'package.json': pkg({ packageManager: 'pnpm@9.12.0', scripts: { start: 'node index.js' } }), 'pnpm-lock.yaml': '' });
  assert.match(pnpm.dockerfile!, /npm install -g pnpm@9\.12\.0 >\/dev\/null && pnpm install --frozen-lockfile --prod=false/);
  assert.match(pnpm.dockerfile!, /pnpm prune --prod/);
  const berry = await plan({ 'package.json': pkg({ packageManager: 'yarn@4.5.0', scripts: { start: 'node index.js' } }), 'yarn.lock': '' });
  assert.match(berry.dockerfile!, /corepack enable[^\n]*yarn install --immutable/);
  assert.match(berry.dockerfile!, /yarn workspaces focus --all --production/);
  const classic = await plan({ 'package.json': pkg({ scripts: { start: 'node index.js' } }), 'yarn.lock': '' });
  assert.match(classic.dockerfile!, /yarn install --frozen-lockfile --production=false/);
  const bun = await plan({ 'package.json': pkg({ scripts: { start: 'bun run src/index.ts' } }), 'bun.lock': '', '.bun-version': '1.1.30\n' });
  assert.equal(bun.label, 'Bun · bun · Bun 1.1.30');
  assert.match(bun.dockerfile!, /FROM oven\/bun:1\.1\.30 AS build[\s\S]*FROM oven\/bun:1\.1\.30-slim[\s\S]*USER bun/);
  assert.equal(bun.stack, 'bun');
});

test('Node: version files are honored and end-of-life majors are flagged', async () => {
  const asdf = await plan({ 'package.json': pkg({ scripts: { start: 'node index.js' } }), 'package-lock.json': '{}', '.tool-versions': 'nodejs 22.3.0\npython 3.12.1\n' });
  assert.match(asdf.label, /Node 22/);
  const mise = await plan({ 'package.json': pkg({ scripts: { start: 'node index.js' } }), 'package-lock.json': '{}', 'mise.toml': '[tools]\nnode = "20"\n' });
  assert.match(mise.dockerfile!, /FROM node:20-slim AS build/);
  assert.ok(mise.warnings.some((w) => w.includes('Node 20 has reached end-of-life')));
  const noLock = await plan({ 'package.json': pkg({ scripts: { start: 'node index.js' }, engines: { node: '18' } }) });
  assert.ok(noLock.warnings.some((w) => w.includes('No lockfile found (package-lock.json)')));
  assert.ok(noLock.warnings.some((w) => w.includes('Node 18')));
  assert.match(noLock.dockerfile!, /npm install --include=dev/);
});

test('Node: monorepos are detected at the root and from inside a workspace package', async () => {
  const files = {
    'package.json': pkg({ name: 'root', private: true, scripts: { build: 'turbo run build', start: 'node x.js' } }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
    'pnpm-lock.yaml': '',
    'turbo.json': '{}',
    'apps/web/package.json': pkg({ name: '@acme/web', scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '15' } }),
  };
  const root = await plan(files);
  assert.ok(root.warnings.some((w) => w.includes('Monorepo (Turborepo)') && w.includes('@acme/web') && w.includes('pnpm --filter @acme/web build')));
  assert.match(root.dockerfile!, /WORKDIR \/app\nENV [^\n]*\nCOPY \. \.\n/); // workspaces need every package.json for the install
  const member = await plan(files, {}, 'apps/web');
  assert.ok(member.warnings.some((w) => w.includes('belongs to a workspace at ../..') && w.includes('pnpm --filter @acme/web start')));
  const guessed = await plan({ 'package.json': pkg({ main: 'lib/app.js' }), 'package-lock.json': '{}' });
  assert.equal(guessed.startCommand, 'node lib/app.js');
  assert.ok(guessed.warnings.some((w) => w.startsWith('Start command guessed')));
});

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

test('Python: Django gets gunicorn, collectstatic when STATIC_ROOT is set, and a Celery worker', async () => {
  const files = {
    'requirements.txt': 'Django==5.1\ngunicorn==23\ncelery==5\npsycopg2==2.9\n',
    'manage.py': '',
    'mysite/wsgi.py': '',
    'mysite/celery.py': "app = Celery('mysite')\n",
    'mysite/settings.py': "STATIC_ROOT = BASE_DIR / 'staticfiles'\n",
  };
  const web = await plan(files);
  assert.equal(web.label, 'Django · pip · Python 3.13');
  assert.equal(web.startCommand, 'gunicorn mysite.wsgi:application --bind 0.0.0.0:$PORT --workers ${WEB_CONCURRENCY:-$(nproc)} --access-logfile - --error-logfile -');
  assert.match(web.dockerfile!, /python manage\.py collectstatic --noinput/);
  assert.match(web.dockerfile!, /build-essential ca-certificates libpq-dev[\s\S]*ca-certificates libpq5/);
  assert.match(web.dockerfile!, /COPY requirements\.txt \.\/\nRUN [^\n]*pip install -r requirements\.txt[^\n]*\nCOPY \. \./);
  assert.ok(!web.warnings.some((w) => w.includes('STATIC_ROOT')));
  const worker = await plan(files, { kind: 'worker' });
  assert.equal(worker.startCommand, 'celery -A mysite worker --loglevel=info');
  const bare = await plan({ 'requirements.txt': 'Django\n', 'manage.py': '', 'mysite/wsgi.py': '', 'mysite/settings.py': '' });
  assert.equal(bare.startCommand, 'python manage.py runserver 0.0.0.0:$PORT');
  assert.ok(bare.warnings.some((w) => w.includes('STATIC_ROOT is not set')));
  assert.ok(bare.warnings.some((w) => w.includes('gunicorn is not a dependency')));
  assert.ok(bare.warnings.some((w) => w.includes('pins no versions')));
});

test('Python: Poetry, PDM, Pipenv and version files', async () => {
  const poetry = await plan({ 'pyproject.toml': '[tool.poetry]\nname = "x"\n', 'poetry.lock': '', '.tool-versions': 'python 3.12.4\n', Procfile: 'web: python -m x\n' });
  assert.match(poetry.label, /poetry · Python 3\.12/);
  assert.match(poetry.dockerfile!, /RUN python -m venv \/app\/\.venv[\s\S]*COPY pyproject\.toml poetry\.lock \.\/[\s\S]*poetry install --only main --no-root/);
  const pdm = await plan({ 'pyproject.toml': '[tool.pdm]\n', 'pdm.lock': '', 'runtime.txt': 'python-3.11.9\n', Procfile: 'web: python -m x\n' });
  assert.match(pdm.dockerfile!, /FROM python:3\.11-slim AS build[\s\S]*pdm sync --prod --no-editable --no-self/);
  const pipenv = await plan({ Pipfile: '[packages]\nflask = "*"\n', 'Pipfile.lock': '{}', 'app.py': 'from flask import Flask\napp = Flask(__name__)\n' });
  assert.match(pipenv.dockerfile!, /pipenv install --deploy/);
  assert.equal(pipenv.startCommand, 'flask --app app run --host 0.0.0.0 --port $PORT');
  const uvConfig = await plan({ 'pyproject.toml': '[project]\nname = "x"\n', 'uv.lock': '', 'torexploy.json': '{"runtime": {"python": "3.12"}}', Procfile: 'web: python -m x\n' });
  assert.match(uvConfig.dockerfile!, /FROM python:3\.12-slim AS build[\s\S]*uv sync --frozen --no-dev --no-install-project[\s\S]*COPY \. \.\nRUN [^\n]*uv sync --frozen --no-dev/);
});

test('Python: Litestar, Sanic and guessed entrypoints', async () => {
  const litestar = await plan({ 'requirements.txt': 'litestar==2\nuvicorn\n', 'app/main.py': 'from litestar import Litestar\napp = Litestar()\n' });
  assert.equal(litestar.startCommand, "uvicorn app.main:app --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips='*'");
  assert.match(litestar.label, /^Litestar/);
  const sanic = await plan({ 'requirements.txt': 'sanic==24\n', 'server.py': 'from sanic import Sanic\napp = Sanic("x")\n' });
  assert.equal(sanic.startCommand, 'sanic server:app --host 0.0.0.0 --port $PORT');
  const guessed = await plan({ 'requirements.txt': 'requests==2\n', 'main.py': 'print(1)\n' });
  assert.equal(guessed.startCommand, 'python main.py');
  assert.ok(guessed.warnings.some((w) => w.startsWith('Start command guessed')));
});

test('a package.json next to a back-end only builds its assets', async () => {
  const django = await plan({
    'requirements.txt': 'Django==5\ngunicorn==23\n',
    'manage.py': '',
    'mysite/wsgi.py': '',
    'mysite/settings.py': 'STATIC_ROOT = "static"\n',
    'package.json': pkg({ scripts: { build: 'tailwindcss -o static/app.css', dev: 'vite' }, devDependencies: { tailwindcss: '4' } }),
    'package-lock.json': '{}',
  });
  assert.equal(django.stack, 'python');
  assert.match(django.dockerfile!, /COPY --from=node:24-slim \/usr\/local\/bin\/node[\s\S]*npm ci --include=dev && npm run build[\s\S]*collectstatic[\s\S]*rm -rf node_modules/);
  // A real Node server next to a requirements.txt is still a Node app.
  const node = await plan({ 'requirements.txt': 'x\n', 'package.json': pkg({ scripts: { start: 'node server.js' } }) });
  assert.equal(node.stack, 'node');
});

// ---------------------------------------------------------------------------
// Go, Rust, PHP, Ruby
// ---------------------------------------------------------------------------

test('Go: toolchain version, a cached module download layer and an Alpine runtime user', async () => {
  const go = await plan({ 'go.mod': 'module x\n\ngo 1.22\n\ntoolchain go1.23.4\n', 'go.sum': '', 'main.go': 'package main' });
  assert.equal(go.label, 'Go 1.23');
  assert.match(go.dockerfile!, /FROM golang:1\.23-alpine AS build[\s\S]*COPY go\.mod go\.sum \.\/\nRUN [^\n]*go mod download[^\n]*\nCOPY \. \.\nRUN [^\n]*CGO_ENABLED=0 go build -trimpath -ldflags=[^\n]* -o \/out\/server \."\]/);
  assert.match(go.dockerfile!, /adduser -S -D -H -u 10001 app[\s\S]*USER app\nEXPOSE 8080/);
  const vendored = await plan({ 'go.mod': 'module x\n\ngo 1.24\n', 'vendor/modules.txt': '', 'cmd/server/main.go': '', 'cmd/migrate/main.go': '' });
  assert.doesNotMatch(vendored.dockerfile!, /go mod download/);
  assert.match(vendored.dockerfile!, /-o \/out\/server \.\/cmd\/server/);
  assert.ok(vendored.warnings.some((w) => w.includes('Several commands under cmd/')));
  assert.ok(!vendored.warnings.some((w) => w.includes('go.sum')));
});

test('Rust: the toolchain channel and workspace binaries are detected', async () => {
  const pinned = await plan({ 'Cargo.toml': '[package]\nname = "svc"\n', 'Cargo.lock': '', 'rust-toolchain.toml': '[toolchain]\nchannel = "1.82.0"\n' });
  assert.match(pinned.dockerfile!, /FROM rust:1\.82-slim-bookworm AS build[\s\S]*cargo build --release --locked && mkdir -p \/out && cp target\/release\/svc \/out\/server/);
  assert.match(pinned.dockerfile!, /useradd[\s\S]*USER app/);
  const workspace = await plan({
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
    'crates/core/Cargo.toml': '[package]\nname = "core"\n',
    'crates/server/Cargo.toml': '[package]\nname = "server"\n',
    'crates/server/src/main.rs': '',
  });
  assert.match(workspace.dockerfile!, /cargo build --release -p server && mkdir -p \/out && cp target\/release\/server/);
  assert.ok(workspace.warnings.some((w) => w.includes('Cargo.lock')));
  assert.equal((await plan({ 'Cargo.toml': '[package]\nname = "x"\n', 'rust-toolchain': 'nightly\n' })).dockerfile!.split('\n')[0], 'FROM rustlang/rust:nightly-slim AS build');
});

test('PHP: Laravel gets extensions, .htaccess support, a Vite assets stage and warmed caches at start', async () => {
  const laravel = await plan({
    'composer.json': '{"require":{"php":"^8.2","laravel/framework":"^11"}}',
    artisan: '',
    'public/index.php': '',
    '.php-version': '8.3\n',
    'package.json': pkg({ scripts: { build: 'vite build', dev: 'vite' }, devDependencies: { vite: '6' } }),
    'package-lock.json': '{}',
  });
  assert.equal(laravel.stack, 'php');
  assert.equal(laravel.label, 'Laravel · PHP 8.3 · Apache · Composer');
  assert.match(laravel.dockerfile!, /FROM node:24-slim AS assets[\s\S]*npm run build[\s\S]*FROM php:8\.3-apache/);
  assert.match(laravel.dockerfile!, /install-php-extensions pdo_mysql pdo_pgsql opcache bcmath intl zip pcntl/);
  assert.match(laravel.dockerfile!, /AllowOverride None\/AllowOverride All/);
  assert.match(laravel.dockerfile!, /COPY --from=assets \/app\/public\/build \/var\/www\/html\/public\/build/);
  assert.match(laravel.dockerfile!, /chown -R www-data:www-data storage bootstrap\/cache/);
  assert.match(laravel.dockerfile!, /php artisan optimize \|\| true[\s\S]*exec apache2-foreground[\s\S]*exec \/usr\/local\/bin\/torex-start/);
  assert.equal(laravel.defaultPort, 80);
  const plain = await plan({ 'index.php': '<?php echo 1;' });
  assert.match(plain.dockerfile!, /FROM php:8\.4-apache/);
  assert.doesNotMatch(plain.dockerfile!, /CMD/);
});

test('Ruby: Rails is built in a stage with compilers and runs from a slim image', async () => {
  const rails = await plan({
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\ngem "bootsnap"\ngem "pg"\n',
    'Gemfile.lock': 'GEM\n',
    '.ruby-version': 'ruby-3.3.4\n',
    'config/application.rb': '',
    'app/assets/stylesheets/app.css': '',
    'package.json': pkg({ scripts: { build: 'esbuild app/javascript/*.* --bundle --outdir=app/assets/builds' } }),
    'yarn.lock': '',
  });
  assert.equal(rails.label, 'Rails · Ruby 3.3');
  assert.equal(rails.startCommand, 'bundle exec rails server -b 0.0.0.0 -p $PORT');
  assert.match(rails.dockerfile!, /FROM ruby:3\.3-slim AS build[\s\S]*build-essential[\s\S]*COPY --from=node:24-slim[\s\S]*COPY Gemfile Gemfile\.lock \.ruby-version \.\/\nRUN [^\n]*bundle install --jobs 4[\s\S]*yarn install[\s\S]*SECRET_KEY_BASE_DUMMY=1 bundle exec rails assets:precompile[\s\S]*bootsnap precompile/);
  assert.match(rails.dockerfile!, /FROM ruby:3\.3-slim\nLABEL[\s\S]*libpq5[\s\S]*COPY --from=build \/usr\/local\/bundle \/usr\/local\/bundle\nCOPY --from=build --chown=app:app \/app \/app\nUSER app\nEXPOSE 3000/);
  assert.match(rails.dockerfile!, /BUNDLE_DEPLOYMENT=1/);
  const rack = await plan({ Gemfile: 'gem "sinatra"\n', 'config.ru': '' });
  assert.equal(rack.startCommand, 'bundle exec rackup -o 0.0.0.0 -p $PORT');
  assert.doesNotMatch(rack.dockerfile!, /BUNDLE_DEPLOYMENT/);
  assert.ok(rack.warnings.some((w) => w.includes('Gemfile.lock')));
});

// ---------------------------------------------------------------------------
// JVM, .NET, BEAM, native, Deno
// ---------------------------------------------------------------------------

test('Java: the JDK comes from the build file or version files; Spring Boot gets its port flag', async () => {
  const spring = await plan({ 'pom.xml': '<project><properties><java.version>17</java.version></properties><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>' });
  assert.equal(spring.label, 'Spring Boot · Java 17 · Maven');
  assert.equal(spring.startCommand, 'java $JAVA_OPTS -jar /app/app.jar --server.port=$PORT');
  assert.match(spring.dockerfile!, /FROM maven:3-eclipse-temurin-17 AS build[\s\S]*FROM eclipse-temurin:17-jre\nLABEL[\s\S]*useradd[\s\S]*USER app/);
  const gradle = await plan({ 'build.gradle.kts': 'java { toolchain { languageVersion.set(JavaLanguageVersion.of(21)) } }\n', gradlew: '' });
  assert.match(gradle.dockerfile!, /FROM eclipse-temurin:21-jdk AS build[\s\S]*\.\/gradlew --no-daemon -q build -x test/);
  const sdkman = await plan({ 'pom.xml': '<project/>', '.sdkmanrc': 'java=21.0.2-tem\n' });
  assert.match(sdkman.label, /Java 21/);
  const nonLts = await plan({ 'pom.xml': '<project/>', '.java-version': '19\n' });
  assert.match(nonLts.label, /Java 21/);
  assert.ok(nonLts.warnings.some((w) => w.includes('JDK 19 is not an LTS')));
  const quarkus = await plan({ 'pom.xml': '<project><artifactId>quarkus-bom</artifactId></project>' });
  assert.equal(quarkus.startCommand, 'java $JAVA_OPTS -Dquarkus.http.port=$PORT -jar /app/quarkus-run.jar');
  assert.match(quarkus.dockerfile!, /cp -r target\/quarkus-app\/\. \/out\//);
});

test('Clojure: Leiningen and tools.deps uberjars', async () => {
  const lein = await plan({ 'project.clj': '(defproject x "1")' });
  assert.match(lein.dockerfile!, /FROM clojure:temurin-21-lein AS build[\s\S]*COPY project\.clj \.\/\nRUN [^\n]*lein deps[\s\S]*lein uberjar[\s\S]*FROM eclipse-temurin:21-jre/);
  assert.equal(lein.startCommand, 'java $JAVA_OPTS -jar /app/app.jar');
  const deps = await plan({ 'deps.edn': '{:aliases {:build {:deps {io.github.clojure/tools.build {:mvn/version "0.10.5"}}}}}' });
  assert.match(deps.dockerfile!, /clojure -T:build uber/);
  assert.ok((await plan({ 'deps.edn': '{}' })).warnings.some((w) => w.includes(':build')));
});

test('.NET: the SDK from global.json, the web project, a restore layer and --urls', async () => {
  const api = await plan({ 'global.json': '{"sdk":{"version":"8.0.100"}}', 'Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>' });
  assert.equal(api.label, 'ASP.NET Core 8.0 · Api');
  assert.equal(api.startCommand, 'dotnet /app/Api.dll --urls http://0.0.0.0:$PORT');
  assert.match(api.dockerfile!, /FROM mcr\.microsoft\.com\/dotnet\/sdk:8\.0 AS build[\s\S]*COPY Api\.csproj global\.json \.\/\nRUN [^\n]*dotnet restore [^\n]*Api\.csproj[\s\S]*COPY \. \.\nRUN [^\n]*dotnet publish [^\n]*Api\.csproj[^\n]* -c Release -o \/out --nologo --no-restore/);
  assert.match(api.dockerfile!, /FROM mcr\.microsoft\.com\/dotnet\/aspnet:8\.0\nLABEL[\s\S]*USER app\nEXPOSE 8080/);
  const nested = await plan({ 'app.sln': '', 'src/Worker/Worker.csproj': '<Project Sdk="Microsoft.NET.Sdk.Worker"><PropertyGroup><TargetFramework>net9.0</TargetFramework><AssemblyName>Jobs</AssemblyName></PropertyGroup></Project>', 'src/Lib/Lib.csproj': '<Project Sdk="Microsoft.NET.Sdk"/>' });
  assert.equal(nested.startCommand, 'dotnet /app/Jobs.dll');
  assert.match(nested.dockerfile!, /FROM mcr\.microsoft\.com\/dotnet\/runtime:9\.0/);
  assert.doesNotMatch(nested.dockerfile!, /dotnet restore/);
  assert.ok(nested.warnings.some((w) => w.includes('Several .NET projects')));
});

test('Elixir: Phoenix releases with the Elixir/OTP pair from .tool-versions', async () => {
  const phoenix = await plan({
    'mix.exs': 'defmodule Shop.MixProject do\n  def project, do: [app: :shop, elixir: "~> 1.15", aliases: ["assets.deploy": ["esbuild default --minify"]]]\n  defp deps, do: [{:phoenix, "~> 1.7"}]\nend\n',
    'mix.lock': '%{}',
    'config/config.exs': '',
    '.tool-versions': 'elixir 1.17.3-otp-27\nerlang 27.1\n',
  });
  assert.equal(phoenix.label, 'Phoenix · Elixir 1.17 · OTP 27');
  assert.equal(phoenix.startCommand, '/app/bin/shop start');
  assert.equal(phoenix.defaultPort, 4000);
  assert.match(phoenix.dockerfile!, /FROM elixir:1\.17-otp-27-slim AS build[\s\S]*mix local\.hex --force[\s\S]*COPY mix\.exs mix\.lock \.\/\nCOPY config config\nRUN [^\n]*mix deps\.get --only prod && mix deps\.compile[\s\S]*COPY \. \.\nRUN [^\n]*mix compile && mix assets\.deploy && mix release shop --overwrite/);
  assert.match(phoenix.dockerfile!, /FROM debian:bookworm-slim\nLABEL[\s\S]*libstdc\+\+6 openssl libncurses6[\s\S]*PHX_SERVER=true[\s\S]*COPY --from=build --chown=app:app \/app\/_build\/prod\/rel\/shop \/app\nUSER app\nEXPOSE 4000/);
  const bare = await plan({ 'mix.exs': 'def project, do: [app: :svc, elixir: "~> 1.18"]\n' });
  assert.equal(bare.label, 'Elixir · Elixir 1.18 · OTP 27');
  assert.ok(bare.warnings.some((w) => w.includes('mix.lock')));
});

test('Gleam: an Erlang shipment on the release image named by the gleam.toml bound', async () => {
  const gleam = await plan({ 'gleam.toml': 'name = "web"\ngleam = ">= 1.6.0"\n', 'manifest.toml': '' });
  assert.equal(gleam.label, 'Gleam 1.6.0 · web · OTP 27');
  assert.match(gleam.dockerfile!, /FROM ghcr\.io\/gleam-lang\/gleam:v1\.6\.0-erlang-alpine AS build[\s\S]*gleam deps download[\s\S]*gleam export erlang-shipment[\s\S]*FROM erlang:27-alpine[\s\S]*COPY --from=build --chown=app:app \/app\/build\/erlang-shipment \/app/);
  assert.equal(gleam.startCommand, '/app/entrypoint.sh run');
});

test('Dart servers compile to a binary and Flutter apps become static web builds', async () => {
  const dart = await plan({ 'pubspec.yaml': 'name: api\nenvironment:\n  sdk: ^3.5.0\n', 'pubspec.lock': '', 'bin/server.dart': '' });
  assert.equal(dart.label, 'Dart 3.5 · api');
  assert.match(dart.dockerfile!, /FROM dart:3\.5 AS build[\s\S]*COPY pubspec\.yaml pubspec\.lock \.\/\nRUN [^\n]*dart pub get[\s\S]*dart compile exe bin\/server\.dart -o \/out\/server[\s\S]*FROM debian:bookworm-slim[\s\S]*USER app/);
  const flutter = await plan({ 'pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n', 'pubspec.lock': '' });
  assert.equal(flutter.stack, 'static-flutter');
  assert.match(flutter.dockerfile!, /FROM ghcr\.io\/cirruslabs\/flutter:stable AS build[\s\S]*flutter build web --release[\s\S]*COPY --from=build \/app\/build\/web \/srv/);
});

test('Swift (Vapor), Crystal, Nim and Haskell build single binaries into minimal runtimes', async () => {
  const vapor = await plan({ 'Package.swift': '// swift-tools-version:6.0\nlet package = Package(dependencies: [.package(url: "https://github.com/vapor/vapor.git", from: "4.0.0")], targets: [.executableTarget(name: "App")])\n', 'Package.resolved': '{}' });
  assert.equal(vapor.label, 'Vapor · Swift 6.0 · App');
  assert.equal(vapor.startCommand, '/app/server serve --env production --hostname 0.0.0.0 --port $PORT');
  assert.match(vapor.dockerfile!, /FROM swift:6\.0-noble AS build[\s\S]*swift package resolve[\s\S]*swift build -c release --product App --static-swift-stdlib[\s\S]*FROM swift:6\.0-noble-slim[\s\S]*USER app/);

  const crystal = await plan({ 'shard.yml': 'name: shop\ncrystal: 1.14.0\ndependencies:\n  kemal:\n    github: kemalcr/kemal\ntargets:\n  shop:\n    main: src/shop.cr\n', 'shard.lock': '' });
  assert.equal(crystal.label, 'Kemal · Crystal 1.14.0 · shop');
  assert.match(crystal.dockerfile!, /FROM crystallang\/crystal:1\.14\.0-alpine AS build[\s\S]*shards install --production[\s\S]*shards build shop --release --static --production[\s\S]*FROM alpine:3\.21/);

  const nim = await plan({ 'app.nimble': 'bin = @["app"]\nsrcDir = "src"\n', 'src/app.nim': '' });
  assert.match(nim.dockerfile!, /FROM nimlang\/nim:alpine AS build[\s\S]*nimble install -d -y[\s\S]*nim c -d:release --opt:speed -o:\/out\/server src\/app\.nim/);

  const stack = await plan({ 'stack.yaml': 'resolver: lts-22.0\n', 'package.yaml': 'name: web\nexecutables:\n  web-exe:\n    main: Main.hs\n' });
  assert.equal(stack.label, 'Haskell · Stack · GHC 9.6');
  assert.match(stack.dockerfile!, /FROM haskell:9\.6 AS build[\s\S]*stack build --copy-bins --local-bin-path \/out && mv \/out\/web-exe \/out\/server[\s\S]*libgmp10/);
  const cabal = await plan({ 'web.cabal': 'name: web\nexecutable web\n  main-is: Main.hs\n' });
  assert.match(cabal.dockerfile!, /cabal install exe:web --install-method=copy --installdir=\/out/);
});

test('Deno: tasks, a pinned version and the image user', async () => {
  const deno = await plan({ 'deno.json': JSON.stringify({ tasks: { start: 'deno run -A main.ts', build: 'deno task gen' } }), 'main.ts': '', 'package.json': pkg({ scripts: { start: 'deno task start' } }) });
  assert.equal(deno.stack, 'deno');
  assert.equal(deno.startCommand, 'deno task start');
  assert.match(deno.dockerfile!, /FROM denoland\/deno:latest\nLABEL[\s\S]*deno install --entrypoint main\.ts[\s\S]*deno task build[\s\S]*USER deno\nEXPOSE 8000/);
  assert.doesNotMatch(deno.dockerfile!, /type=cache,target=\/deno-dir/);
  const pinned = await plan({ 'deno.json': '{}', 'server.ts': '', '.tool-versions': 'deno 2.1.4\n' });
  assert.match(pinned.dockerfile!, /FROM denoland\/deno:2\.1\.4/);
  assert.equal(pinned.startCommand, 'deno run --allow-net --allow-env --allow-read server.ts');
});
