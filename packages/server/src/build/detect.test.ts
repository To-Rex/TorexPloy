import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { nodeMajor, planBuild, renderEnvFile, type BuildInput } from './detect.ts';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-detect-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function input(dir: string, overrides: Partial<BuildInput> = {}): BuildInput {
  return { contextDir: dir, buildType: 'auto', dockerfilePath: 'Dockerfile', installCommand: null, buildCommand: null, startCommand: null, outputDirectory: null, kind: 'web', ...overrides };
}

test('a repository Dockerfile always wins in auto mode', async () => {
  const dir = repo({ Dockerfile: 'FROM scratch', 'package.json': '{}' });
  try {
    const plan = await planBuild(input(dir));
    assert.equal(plan.mode, 'dockerfile');
    await assert.rejects(planBuild(input(dir, { buildType: 'dockerfile', dockerfilePath: 'docker/Prod.Dockerfile' })), /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node: package manager, start script and build caching are detected', async () => {
  const dir = repo({ 'package.json': JSON.stringify({ scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '15' } }), 'pnpm-lock.yaml': '' });
  try {
    const plan = await planBuild(input(dir));
    assert.equal(plan.stack, 'node');
    assert.match(plan.label, /next · pnpm · Node 24/);
    assert.match(plan.dockerfile!, /pnpm install --frozen-lockfile/);
    assert.match(plan.dockerfile!, /--mount=type=cache,target=\/app\/\.next\/cache/);
    assert.match(plan.dockerfile!, /--mount=type=secret,id=ploy_env/);
    assert.match(plan.dockerfile!, /CMD \["sh","-c","exec pnpm run start"\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Node: a Vite SPA without a server becomes a static Caddy image', async () => {
  const dir = repo({ 'package.json': JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { vite: '7' } }), 'package-lock.json': '{}' });
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
  const dir = repo({ 'package.json': JSON.stringify({ dependencies: { express: '5' } }) });
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
