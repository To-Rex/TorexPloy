/**
 * Python.
 *
 * Dependencies are installed by uv, Poetry, PDM, Pipenv or pip into a
 * virtualenv at /app/.venv inside a build stage (with compilers), and the
 * app directory is copied into a slim runtime image with no build tools.
 * Django, FastAPI/Starlette, Litestar, Sanic and Flask get their production
 * servers; `kind: 'worker'` runs Celery when it is a dependency.
 */
import { join } from 'node:path';
import { AppError } from '../../lib/errors.ts';
import { addUser, cmd, exists, existing, generated, listDir, listDirs, readJson, readText, run, runtimePackages, toolVersions, versionLine, warn, type BuildPlan, type Ctx } from './shared.ts';
import { assetBuild, nodeToolchain, type PackageJson } from './node.ts';

const DEFAULT_PYTHON = '3.13';
const PIP_CACHES = ['/root/.cache/pip', '/root/.cache/uv', '/root/.cache/pypoetry', '/root/.cache/pdm', '/root/.cache/pipenv'];

interface Tool {
  name: 'uv' | 'poetry' | 'pdm' | 'pipenv' | 'pip';
  lockfile: string | null;
  /** Files copied ahead of the sources so the install layer is cached; empty when the install needs the sources. */
  manifests: string[];
  install: string;
}

/** Config file, `.python-version`, `runtime.txt`, `.tool-versions`/`mise.toml`, then `requires-python`'s lower bound. */
async function pythonVersion(ctx: Ctx, pyproject: string): Promise<string> {
  const dir = ctx.dir;
  const tools = await toolVersions(dir);
  const pinned = ctx.runtime.python ?? versionLine(await readText(join(dir, '.python-version'))) ?? versionLine(await readText(join(dir, 'runtime.txt')))?.replace(/^python-/, '') ?? tools.python ?? '';
  const requires = /requires-python\s*=\s*["'][^"']*?(3\.\d+)/.exec(pyproject)?.[1];
  return /^3\.\d+/.exec(pinned)?.[0] ?? requires ?? DEFAULT_PYTHON;
}

async function packagingTool(ctx: Ctx, pyproject: string, requirements: string): Promise<Tool> {
  const dir = ctx.dir;
  const lock = async (file: string): Promise<string | null> => ((await exists(join(dir, file))) ? file : null);
  if ((await lock('uv.lock')) !== null || /\[tool\.uv\]/.test(pyproject)) {
    const lockfile = await lock('uv.lock');
    return { name: 'uv', lockfile, manifests: await existing(dir, ['pyproject.toml', 'uv.lock', '.python-version']), install: `pip install uv >/dev/null && uv sync${lockfile === null ? '' : ' --frozen'} --no-dev` };
  }
  if ((await lock('poetry.lock')) !== null || /\[tool\.poetry\]/.test(pyproject)) {
    return { name: 'poetry', lockfile: await lock('poetry.lock'), manifests: await existing(dir, ['pyproject.toml', 'poetry.lock']), install: 'pip install poetry >/dev/null && poetry install --only main --no-root --no-interaction --no-ansi' };
  }
  if ((await lock('pdm.lock')) !== null || /\[tool\.pdm\]/.test(pyproject)) {
    const lockfile = await lock('pdm.lock');
    return { name: 'pdm', lockfile, manifests: await existing(dir, ['pyproject.toml', 'pdm.lock']), install: `pip install pdm >/dev/null && pdm ${lockfile === null ? 'install' : 'sync'} --prod --no-editable --no-self` };
  }
  if (await exists(join(dir, 'Pipfile'))) {
    const lockfile = await lock('Pipfile.lock');
    return { name: 'pipenv', lockfile, manifests: await existing(dir, ['Pipfile', 'Pipfile.lock']), install: `pip install pipenv >/dev/null && pipenv install${lockfile === null ? '' : ' --deploy'}` };
  }
  if (requirements.length > 0) {
    // `-r other.txt` / `-e .` pull in files beyond requirements.txt: install from the full sources then.
    const selfContained = !/^\s*-[rce]\b/m.test(requirements) && !/^\s*\.\s*$/m.test(requirements);
    if (!/==/.test(requirements)) warn(ctx, 'requirements.txt pins no versions (no "=="), so installs are not reproducible; pin them or use uv/Poetry.');
    return { name: 'pip', lockfile: null, manifests: selfContained ? ['requirements.txt'] : [], install: 'pip install -r requirements.txt' };
  }
  return { name: 'pip', lockfile: null, manifests: [], install: 'pip install .' };
}

/** Django's project package (the directory with wsgi.py) and whether its settings define STATIC_ROOT. */
async function djangoProject(dir: string): Promise<{ module: string | null; asgi: boolean; staticRoot: boolean }> {
  for (const name of await listDirs(dir)) {
    if (!(await exists(join(dir, name, 'wsgi.py')))) continue;
    // Settings live in <project>/settings.py or a <project>/settings/ package (base.py, production.py…).
    const settings = [join(dir, name, 'settings.py'), ...(await listDir(join(dir, name, 'settings'))).map((file) => join(dir, name, 'settings', file))];
    let staticRoot = false;
    for (const file of settings) if (/^\s*STATIC_ROOT\s*=/m.test((await readText(file)) ?? '')) staticRoot = true;
    return { module: name, asgi: await exists(join(dir, name, 'asgi.py')), staticRoot };
  }
  return { module: null, asgi: false, staticRoot: false };
}

/** `celery -A <module>` for the conventional `<project>/celery.py`, `celery.py` or `tasks.py`. */
async function celeryApp(dir: string, djangoModule: string | null): Promise<string | null> {
  if (djangoModule !== null && (await exists(join(dir, djangoModule, 'celery.py')))) return djangoModule;
  for (const name of await listDirs(dir)) if (await exists(join(dir, name, 'celery.py'))) return name;
  for (const file of ['celery.py', 'tasks.py', 'worker.py', 'celery_app.py']) if (await exists(join(dir, file))) return file.replace(/\.py$/, '');
  return null;
}

export async function planPython(ctx: Ctx): Promise<BuildPlan> {
  const { dir, input, procfile } = ctx;
  const requirements = (await readText(join(dir, 'requirements.txt'))) ?? '';
  const pyproject = (await readText(join(dir, 'pyproject.toml'))) ?? '';
  const deps = `${requirements}\n${pyproject}\n${(await readText(join(dir, 'Pipfile'))) ?? ''}`.toLowerCase();
  const version = await pythonVersion(ctx, pyproject);
  const tool = await packagingTool(ctx, pyproject, requirements);
  const isDjango = await exists(join(dir, 'manage.py'));
  const django = isDjango ? await djangoProject(dir) : { module: null, asgi: false, staticRoot: false };
  const needsLibpq = /\bpsycopg2\b(?!-binary)|(?:^|[\s"'])psycopg(?:\[c\]|\s|$|[=<>~])/m.test(deps);
  const uvicorn = deps.includes('uvicorn') ? 'uvicorn' : 'python -m uvicorn';

  let framework = isDjango ? 'Django' : deps.includes('fastapi') ? 'FastAPI' : deps.includes('litestar') ? 'Litestar' : deps.includes('sanic') ? 'Sanic' : deps.includes('starlette') ? 'Starlette' : deps.includes('flask') ? 'Flask' : 'Python';
  let start: string | null = input.startCommand ?? (input.kind === 'worker' ? procfile.worker : undefined) ?? procfile.web ?? null;
  if (start === null && input.kind === 'worker' && deps.includes('celery')) {
    const app = await celeryApp(dir, django.module);
    if (app !== null) start = `celery -A ${app} worker --loglevel=info`;
    else warn(ctx, 'Celery is a dependency but no celery.py/tasks.py was found; set the start command (e.g. "celery -A myapp worker").');
  }
  if (start === null && isDjango) {
    const workers = '--workers ${WEB_CONCURRENCY:-$(nproc)} --access-logfile - --error-logfile -';
    if (django.module !== null && deps.includes('gunicorn')) {
      start = django.asgi && deps.includes('uvicorn') ? `gunicorn ${django.module}.asgi:application -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:$PORT ${workers}` : `gunicorn ${django.module}.wsgi:application --bind 0.0.0.0:$PORT ${workers}`;
    } else {
      start = 'python manage.py runserver 0.0.0.0:$PORT';
      warn(ctx, 'gunicorn is not a dependency, so Django runs under "manage.py runserver", which is not meant for production; add gunicorn.');
    }
    if (!django.staticRoot) warn(ctx, 'Django: STATIC_ROOT is not set, so static files are not collected at build time. Set STATIC_ROOT in settings (and serve it, e.g. with WhiteNoise).');
  }
  if (start === null) {
    for (const file of ['main.py', 'app.py', 'server.py', 'src/main.py', 'app/main.py', 'asgi.py', 'wsgi.py']) {
      const source = await readText(join(dir, file));
      if (source === null) continue;
      const module = file.replace(/\.py$/, '').replace(/\//g, '.');
      const asgi = /^(\w+)\s*=\s*(FastAPI|Starlette|Litestar)\s*\(/m.exec(source);
      const flask = /^(\w+)\s*=\s*Flask\s*\(/m.exec(source);
      const sanic = /^(\w+)\s*=\s*Sanic\s*\(/m.exec(source);
      if (asgi !== null) {
        framework = asgi[2]!;
        start = `${uvicorn} ${module}:${asgi[1]!} --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips='*'`;
      } else if (flask !== null) {
        framework = 'Flask';
        start = deps.includes('gunicorn') ? `gunicorn ${module}:${flask[1]!} --bind 0.0.0.0:$PORT --workers \${WEB_CONCURRENCY:-$(nproc)} --access-logfile -` : `flask --app ${module} run --host 0.0.0.0 --port $PORT`;
      } else if (sanic !== null) {
        framework = 'Sanic';
        start = `sanic ${module}:${sanic[1]!} --host 0.0.0.0 --port $PORT`;
      } else {
        start = `python ${file}`;
        warn(ctx, `Start command guessed as "${start}"; add a Procfile or set a start command to make it explicit.`);
      }
      break;
    }
  }
  if (start === null) {
    throw new AppError('bad_request', 'Could not determine how to start the app: add a Procfile or set a start command', { params: { reason: 'no_start' } });
  }

  // A package.json next to the Python app only builds front-end assets (Tailwind, Vite…) before collectstatic.
  const assets = await assetBuild(ctx, (await readJson<PackageJson>(join(dir, 'package.json'))) ?? {});
  const build = input.buildCommand ?? (isDjango && django.staticRoot ? 'python manage.py collectstatic --noinput' : null);
  const manifestsFirst = input.installCommand === null && tool.manifests.length > 0;
  const install = input.installCommand ?? tool.install;
  return generated(ctx, {
    stack: 'python',
    label: `${framework} · ${tool.name} · Python ${version}`,
    defaultPort: 8000,
    startCommand: start,
    lines: [
      `FROM python:${version}-slim AS build`,
      ...runtimePackages({ ...ctx, packages: [] }, 'debian', ['build-essential', 'ca-certificates', ...(needsLibpq ? ['libpq-dev'] : [])]),
      'ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON=/usr/local/bin/python3 UV_PYTHON_DOWNLOADS=never POETRY_VIRTUALENVS_IN_PROJECT=true PIPENV_VENV_IN_PROJECT=1',
      'WORKDIR /app',
      ...(tool.name === 'uv' ? [] : ['RUN python -m venv /app/.venv']),
      'ENV PATH="/app/.venv/bin:$PATH"',
      ...(assets === null ? [] : nodeToolchain(assets.major)),
      ...(manifestsFirst
        ? [`COPY ${tool.manifests.join(' ')} ./`, run(tool.name === 'uv' ? `${install} --no-install-project` : install, PIP_CACHES), 'COPY . .', ...(tool.name === 'uv' ? [run(install, PIP_CACHES)] : [])]
        : ['COPY . .', run(install, PIP_CACHES)]),
      ...(assets === null ? [] : [run(`${assets.install} && ${assets.build}`, assets.caches)]),
      ...(build === null ? [] : [run(build)]),
      ...(assets === null ? [] : ['RUN rm -rf node_modules']),
      '',
      `FROM python:${version}-slim`,
      ...runtimePackages(ctx, 'debian', ['ca-certificates', ...(needsLibpq ? ['libpq5'] : [])]),
      addUser('debian'),
      'WORKDIR /app',
      'ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH="/app/.venv/bin:$PATH" PORT=8000',
      'COPY --from=build --chown=app:app /app /app',
      'USER app',
      'EXPOSE 8000',
      cmd(start),
    ],
  });
}
