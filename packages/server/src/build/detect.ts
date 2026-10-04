/**
 * Build planning: from a checked-out repository to a Dockerfile.
 *
 * A repository with its own Dockerfile is built as-is. Otherwise the stack is
 * detected from its manifest files and an optimized Dockerfile is generated:
 * BuildKit cache mounts for package-manager stores, build-time variables
 * injected through a secret mount (so they never land in image layers or
 * history), and a minimal runtime stage where the stack allows it.
 *
 * The generated Dockerfile is plain text written next to the checkout and
 * printed in the deployment log, so nothing about a build is hidden.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuildType } from '@ploy/shared';
import { AppError } from '../lib/errors.ts';

export interface BuildInput {
  /** Absolute path of the build context (repository root + root directory). */
  contextDir: string;
  buildType: BuildType;
  dockerfilePath: string;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputDirectory: string | null;
  kind: 'web' | 'worker';
}

export interface BuildPlan {
  /** `dockerfile` uses the repository's file; `generated` uses {@link dockerfile}. */
  mode: 'dockerfile' | 'generated';
  stack: string;
  /** Human-readable summary for the log, e.g. "Next.js · pnpm · Node 22". */
  label: string;
  dockerfile: string | null;
  /** Dockerfile path relative to the context (repository mode only). */
  dockerfilePath: string;
  /** Port the generated image listens on when the app does not configure one. */
  defaultPort: number | null;
  startCommand: string | null;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  const text = await readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** `web:` / `worker:` entries of a Heroku-style Procfile. */
export async function readProcfile(dir: string): Promise<Record<string, string>> {
  const text = await readText(join(dir, 'Procfile'));
  const entries: Record<string, string> = {};
  if (text === null) return entries;
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.+)$/.exec(line.trim());
    if (match !== null) entries[match[1]!] = match[2]!.trim();
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Dockerfile building blocks
// ---------------------------------------------------------------------------

/** Loads build-time variables from the BuildKit secret, if one was provided. */
const LOAD_ENV = 'set -e; if [ -f /run/secrets/ploy_env ]; then set -a; . /run/secrets/ploy_env; set +a; fi; ';

/** A RUN step in exec form (JSON-quoted, so any command text is safe) with optional cache mounts. */
function run(command: string, caches: string[] = [], withEnv = true): string {
  const mounts = [
    ...(withEnv ? ['--mount=type=secret,id=ploy_env'] : []),
    ...caches.map((target) => `--mount=type=cache,target=${target}`),
  ];
  return `RUN ${mounts.join(' ')}${mounts.length > 0 ? ' ' : ''}${JSON.stringify(['sh', '-c', `${withEnv ? LOAD_ENV : 'set -e; '}${command}`])}`;
}

function cmd(command: string): string {
  return `CMD ${JSON.stringify(['sh', '-c', `exec ${command}`])}`;
}

/** Writes a file inside the image with printf, avoiding Dockerfile heredocs (not in older BuildKit). */
function writeFileStep(path: string, lines: string[]): string {
  const quoted = lines.map((line) => `'${line.replace(/'/g, `'\\''`)}'`).join(' ');
  return run(`mkdir -p "$(dirname ${path})" && printf '%s\\n' ${quoted} > ${path}`, [], false);
}

function staticRuntime(sourceStage: string | null, sourceDir: string): string[] {
  const caddyfile = [
    '{',
    '  admin off',
    '  auto_https off',
    '}',
    ':8080 {',
    '  root * /srv',
    '  encode zstd gzip',
    '  @immutable path /assets/* /_next/static/* /static/*',
    '  header @immutable Cache-Control "public, max-age=31536000, immutable"',
    '  try_files {path} {path}/ {path}.html /index.html',
    '  file_server',
    '}',
  ];
  return [
    'FROM caddy:2.11-alpine',
    writeFileStep('/etc/caddy/Caddyfile', caddyfile),
    sourceStage === null ? `COPY ${sourceDir} /srv` : `COPY --from=${sourceStage} ${sourceDir} /srv`,
    'EXPOSE 8080',
    'CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]',
  ];
}

// ---------------------------------------------------------------------------
// Node.js / Bun
// ---------------------------------------------------------------------------

interface PackageJson {
  name?: string;
  main?: string;
  packageManager?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const STATIC_FRAMEWORKS = ['vite', 'react-scripts', '@angular/core', '@vue/cli-service', 'gatsby', 'parcel'];
const SERVER_FRAMEWORKS = ['next', 'nuxt', '@remix-run/serve', '@react-router/serve', '@sveltejs/adapter-node', '@nestjs/core', 'express', 'fastify', 'hono', 'koa', '@hapi/hapi', '@adonisjs/core', 'astro'];

const DEFAULT_NODE = 24;

/**
 * Node major for the image. An exact pin is respected; a range or a list of
 * acceptable majors resolves to the current LTS when allowed, else the newest
 * even (LTS-line) major it names.
 */
export function nodeMajor(pkg: PackageJson, nvmrc: string | null): number {
  const source = (nvmrc ?? '').split('\n').map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith('#')) ?? pkg.engines?.node ?? '';
  const majors = [...source.matchAll(/(?:^|[^\d.])(\d{2})(?=\b|\.)/g)].map((match) => Number(match[1])).filter((major) => major >= 18 && major <= 30);
  if (majors.length === 0) return DEFAULT_NODE;
  if (/^\s*>=?\s*\d+\D*$/.test(source)) return Math.max(DEFAULT_NODE, majors[0]!);
  if (majors.includes(DEFAULT_NODE) && majors.length > 1) return DEFAULT_NODE;
  const major = Math.max(...majors);
  return major % 2 === 1 ? major + 1 : major; // odd releases are short-lived; use the next LTS line
}

/** First non-comment line of a version file. */
function versionLine(text: string | null): string | null {
  return text?.split('\n').map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith('#')) ?? null;
}

function has(pkg: PackageJson, dependency: string): boolean {
  return pkg.dependencies?.[dependency] !== undefined || pkg.devDependencies?.[dependency] !== undefined;
}

async function planNode(input: BuildInput, pkg: PackageJson, procfile: Record<string, string>): Promise<BuildPlan> {
  const dir = input.contextDir;
  const isBun = (await exists(join(dir, 'bun.lockb'))) || (await exists(join(dir, 'bun.lock'))) || pkg.packageManager?.startsWith('bun@') === true;
  const pm = isBun
    ? 'bun'
    : (await exists(join(dir, 'pnpm-lock.yaml'))) || pkg.packageManager?.startsWith('pnpm@')
      ? 'pnpm'
      : (await exists(join(dir, 'yarn.lock'))) || pkg.packageManager?.startsWith('yarn@')
        ? 'yarn'
        : 'npm';
  const scripts = pkg.scripts ?? {};
  const major = nodeMajor(pkg, (await readText(join(dir, '.nvmrc'))) ?? (await readText(join(dir, '.node-version'))));
  const framework =
    ['next', 'nuxt', 'astro', '@remix-run/serve', '@nestjs/core', 'vite', 'react-scripts', '@angular/core', 'express', 'fastify', 'hono'].find((name) =>
      has(pkg, name),
    ) ?? null;

  const pmVersion = pkg.packageManager?.split('@')[1]?.split('+')[0];
  const yarnBerry = pm === 'yarn' && ((await exists(join(dir, '.yarnrc.yml'))) || (pmVersion !== undefined && Number(pmVersion.split('.')[0]) >= 2));

  const install =
    input.installCommand ??
    {
      npm: (await exists(join(dir, 'package-lock.json'))) ? 'npm ci --include=dev' : 'npm install --include=dev',
      pnpm: `npm install -g pnpm@${pmVersion ?? '10'} >/dev/null && pnpm install --frozen-lockfile --prod=false`,
      yarn: yarnBerry ? 'corepack enable && yarn install --immutable' : 'yarn install --frozen-lockfile --production=false',
      bun: 'bun install --frozen-lockfile',
    }[pm];
  const caches = {
    npm: ['/root/.npm'],
    pnpm: ['/root/.local/share/pnpm/store', '/root/.npm'],
    yarn: ['/usr/local/share/.cache/yarn', '/root/.yarn/berry/cache'],
    bun: ['/root/.bun/install/cache'],
  }[pm];
  const runScript = (name: string): string => (pm === 'npm' ? `npm run ${name}` : `${pm} run ${name}`);
  const build = input.buildCommand ?? (scripts.build !== undefined ? runScript('build') : null);

  // A front-end without a server: build it and serve the output with Caddy.
  const isStaticSite =
    input.buildType === 'static' ||
    (input.startCommand === null &&
      procfile.web === undefined &&
      scripts.start === undefined &&
      STATIC_FRAMEWORKS.some((name) => has(pkg, name)) &&
      !SERVER_FRAMEWORKS.some((name) => has(pkg, name)));

  const base = isBun ? 'oven/bun:1' : `node:${major}-slim`;
  const label = [framework === null ? (isBun ? 'Bun' : 'Node.js') : framework, pm, isBun ? null : `Node ${major}`].filter(Boolean).join(' · ');

  if (isStaticSite) {
    if (build === null) throw new AppError('bad_request', 'Static site has no build script; set a build command', { params: { reason: 'no_build' } });
    const collect = input.outputDirectory !== null
      ? `cp -r ${input.outputDirectory}/. /ploy-out/`
      : 'for d in dist build out public www; do if [ -f "$d/index.html" ]; then cp -r "$d/." /ploy-out/; exit 0; fi; done; echo "No build output with an index.html was found (looked in dist, build, out, public). Set the output directory." >&2; exit 1';
    return {
      mode: 'generated',
      stack: 'static-node',
      label: `${label} → static`,
      defaultPort: 8080,
      startCommand: null,
      dockerfilePath: 'Dockerfile',
      dockerfile: [
        `FROM ${base} AS build`,
        'WORKDIR /app',
        'COPY . .',
        run(install, caches),
        run(build),
        run(`mkdir -p /ploy-out && ${collect}`, [], false),
        '',
        ...staticRuntime('build', '/ploy-out'),
      ].join('\n'),
    };
  }

  const start =
    input.startCommand ??
    (input.kind === 'worker' ? procfile.worker : undefined) ??
    procfile.web ??
    (scripts.start !== undefined ? runScript('start') : null) ??
    (framework === 'next' ? 'npx next start' : null) ??
    (pkg.main !== undefined ? `${isBun ? 'bun' : 'node'} ${pkg.main}` : null) ??
    (await firstExisting(dir, ['server.js', 'index.js', 'app.js', 'main.js', 'dist/index.js', 'build/index.js'], (file) => `${isBun ? 'bun' : 'node'} ${file}`)) ??
    (isBun ? await firstExisting(dir, ['index.ts', 'src/index.ts', 'server.ts'], (file) => `bun ${file}`) : null);
  if (start === null) {
    throw new AppError('bad_request', 'Could not determine how to start the app: add a "start" script, a Procfile, or set a start command', {
      params: { reason: 'no_start' },
    });
  }

  return {
    mode: 'generated',
    stack: isBun ? 'bun' : 'node',
    label,
    defaultPort: null,
    startCommand: start,
    dockerfilePath: 'Dockerfile',
    dockerfile: [
      `FROM ${base}`,
      'WORKDIR /app',
      ...(isBun ? [] : ['RUN apt-get update -qq && apt-get install -y --no-install-recommends ca-certificates dumb-init >/dev/null && rm -rf /var/lib/apt/lists/*']),
      'ENV CI=true NEXT_TELEMETRY_DISABLED=1',
      'COPY . .',
      run(install, caches),
      ...(build === null ? [] : [run(build, framework === 'next' ? ['/app/.next/cache'] : [])]),
      'ENV NODE_ENV=production',
      ...(isBun ? [cmd(start)] : ['ENTRYPOINT ["dumb-init", "--"]', cmd(start)]),
    ].join('\n'),
  };
}

async function firstExisting(dir: string, candidates: string[], format: (file: string) => string): Promise<string | null> {
  for (const candidate of candidates) {
    if (await exists(join(dir, candidate))) return format(candidate);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

async function planPython(input: BuildInput, procfile: Record<string, string>): Promise<BuildPlan> {
  const dir = input.contextDir;
  const requirements = (await readText(join(dir, 'requirements.txt'))) ?? '';
  const pyproject = (await readText(join(dir, 'pyproject.toml'))) ?? '';
  const deps = `${requirements}\n${pyproject}`.toLowerCase();
  const versionFile = versionLine(await readText(join(dir, '.python-version'))) ?? versionLine(await readText(join(dir, 'runtime.txt')))?.replace(/^python-/, '');
  const requires = /requires-python\s*=\s*["'][^"']*?(3\.\d+)/.exec(pyproject)?.[1];
  const version = /^3\.\d+/.exec(versionFile ?? '')?.[0] ?? requires ?? '3.13';

  const tool = (await exists(join(dir, 'uv.lock')))
    ? 'uv'
    : (await exists(join(dir, 'poetry.lock')))
      ? 'poetry'
      : (await exists(join(dir, 'Pipfile')))
        ? 'pipenv'
        : 'pip';
  const install =
    input.installCommand ??
    {
      uv: 'pip install uv >/dev/null && uv sync --frozen --no-dev',
      poetry: 'pip install poetry >/dev/null && poetry config virtualenvs.create false && poetry install --only main --no-root --no-interaction',
      pipenv: 'pip install pipenv >/dev/null && pipenv install --system --deploy',
      pip: requirements.length > 0 ? 'pip install -r requirements.txt' : 'pip install .',
    }[tool];

  let start: string | null = input.startCommand ?? (input.kind === 'worker' ? procfile.worker : undefined) ?? procfile.web ?? null;
  let framework = (await exists(join(dir, 'manage.py'))) ? 'Django' : deps.includes('fastapi') ? 'FastAPI' : deps.includes('flask') ? 'Flask' : 'Python';
  if (start === null && framework === 'Django') {
    const entries = await readdir(dir, { withFileTypes: true });
    let wsgiModule: string | null = null;
    for (const entry of entries) {
      if (entry.isDirectory() && (await exists(join(dir, entry.name, 'wsgi.py')))) wsgiModule = `${entry.name}.wsgi`;
    }
    if (wsgiModule !== null && deps.includes('gunicorn')) start = `gunicorn ${wsgiModule} --bind 0.0.0.0:$PORT --workers 2`;
    else start = 'python manage.py runserver 0.0.0.0:$PORT';
  }
  if (start === null) {
    for (const file of ['main.py', 'app.py', 'server.py', 'src/main.py', 'app/main.py']) {
      const source = await readText(join(dir, file));
      if (source === null) continue;
      const module = file.replace(/\.py$/, '').replace(/\//g, '.');
      if (/FastAPI\s*\(/.test(source) || /Starlette\s*\(/.test(source)) {
        framework = 'FastAPI';
        const variable = /^(\w+)\s*=\s*(?:FastAPI|Starlette)\s*\(/m.exec(source)?.[1] ?? 'app';
        start = `${deps.includes('uvicorn') ? 'uvicorn' : 'python -m uvicorn'} ${module}:${variable} --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips='*'`;
      } else if (/Flask\s*\(/.test(source)) {
        framework = 'Flask';
        const variable = /^(\w+)\s*=\s*Flask\s*\(/m.exec(source)?.[1] ?? 'app';
        start = deps.includes('gunicorn') ? `gunicorn ${module}:${variable} --bind 0.0.0.0:$PORT` : `flask --app ${module} run --host 0.0.0.0 --port $PORT`;
      } else {
        start = `python ${file}`;
      }
      break;
    }
  }
  if (start === null) {
    throw new AppError('bad_request', 'Could not determine how to start the app: add a Procfile or set a start command', { params: { reason: 'no_start' } });
  }

  return {
    mode: 'generated',
    stack: 'python',
    label: `${framework} · ${tool} · Python ${version}`,
    defaultPort: null,
    startCommand: start,
    dockerfilePath: 'Dockerfile',
    dockerfile: [
      `FROM python:${version}-slim`,
      'ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy',
      'WORKDIR /app',
      'COPY . .',
      run(install, ['/root/.cache/pip', '/root/.cache/uv', '/root/.cache/pypoetry']),
      ...(input.buildCommand === null ? [] : [run(input.buildCommand)]),
      ...(tool === 'uv' ? ['ENV PATH="/app/.venv/bin:$PATH"'] : []),
      cmd(start),
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Go, Rust, PHP, Ruby, Deno, Java, static
// ---------------------------------------------------------------------------

async function planGo(input: BuildInput): Promise<BuildPlan> {
  const dir = input.contextDir;
  const gomod = (await readText(join(dir, 'go.mod'))) ?? '';
  const version = /^go\s+(1\.\d+)/m.exec(gomod)?.[1] ?? '1.23';
  let target = '.';
  if (!(await exists(join(dir, 'main.go'))) && (await exists(join(dir, 'cmd')))) {
    const commands = (await readdir(join(dir, 'cmd'), { withFileTypes: true })).filter((entry) => entry.isDirectory());
    if (commands.length >= 1) target = `./cmd/${commands.find((entry) => entry.name === 'server' || entry.name === 'api')?.name ?? commands[0]!.name}`;
  }
  const build = input.buildCommand ?? `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ${target}`;
  const start = input.startCommand ?? '/app/server';
  return {
    mode: 'generated',
    stack: 'go',
    label: `Go ${version}`,
    defaultPort: null,
    startCommand: start,
    dockerfilePath: 'Dockerfile',
    dockerfile: [
      `FROM golang:${version}-alpine AS build`,
      'ENV GOTOOLCHAIN=auto',
      'WORKDIR /src',
      'COPY . .',
      run(`mkdir -p /out && ${build}`, ['/go/pkg/mod', '/root/.cache/go-build']),
      '',
      'FROM alpine:3.21',
      'RUN apk add --no-cache ca-certificates tzdata',
      'WORKDIR /app',
      'COPY --from=build /src /app',
      'COPY --from=build /out/server /app/server',
      cmd(start),
    ].join('\n'),
  };
}

async function planRust(input: BuildInput): Promise<BuildPlan> {
  const cargo = (await readText(join(input.contextDir, 'Cargo.toml'))) ?? '';
  const binName = /\[\[bin\]\][^[]*?name\s*=\s*"([^"]+)"/s.exec(cargo)?.[1] ?? /\[package\][^[]*?name\s*=\s*"([^"]+)"/s.exec(cargo)?.[1] ?? 'app';
  const start = input.startCommand ?? '/app/server';
  return {
    mode: 'generated',
    stack: 'rust',
    label: `Rust · ${binName}`,
    defaultPort: null,
    startCommand: start,
    dockerfilePath: 'Dockerfile',
    dockerfile: [
      'FROM rust:1-slim-bookworm AS build',
      'RUN apt-get update -qq && apt-get install -y --no-install-recommends pkg-config libssl-dev >/dev/null && rm -rf /var/lib/apt/lists/*',
      'WORKDIR /src',
      'COPY . .',
      // The target dir is a cache mount, so the binary must be copied out within the same step.
      run(`${input.buildCommand ?? 'cargo build --release --locked || cargo build --release'} && mkdir -p /out && cp target/release/${binName} /out/server`, [
        '/usr/local/cargo/registry',
        '/src/target',
      ]),
      '',
      'FROM debian:bookworm-slim',
      'RUN apt-get update -qq && apt-get install -y --no-install-recommends ca-certificates libssl3 >/dev/null && rm -rf /var/lib/apt/lists/*',
      'WORKDIR /app',
      'COPY --from=build /out/server /app/server',
      cmd(start),
    ].join('\n'),
  };
}

async function planPhp(input: BuildInput, procfile: Record<string, string>): Promise<BuildPlan> {
  const dir = input.contextDir;
  // Heroku-style `web: heroku-php-apache2 web/` names the document root; otherwise Laravel's `public/` or the repo root.
  const procfileRoot = /heroku-php-(?:apache2|nginx)\s+(\S+)/.exec(procfile.web ?? '')?.[1]?.replace(/\/+$/, '');
  const docroot = procfileRoot !== undefined ? `/var/www/html/${procfileRoot}` : (await exists(join(dir, 'public'))) ? '/var/www/html/public' : '/var/www/html';
  const composer = await readJson<{ require?: Record<string, string> }>(join(dir, 'composer.json'));
  const hasComposer = composer !== null;
  const wanted = /(8\.\d+)/.exec(composer?.require?.php ?? '')?.[1];
  const version = wanted !== undefined && Number(wanted.split('.')[1]) > 3 ? wanted : '8.3';
  return {
    mode: 'generated',
    stack: 'php',
    label: `PHP ${version} · Apache${hasComposer ? ' · Composer' : ''}`,
    defaultPort: 80,
    startCommand: input.startCommand,
    dockerfilePath: 'Dockerfile',
    dockerfile: [
      `FROM php:${version}-apache`,
      'RUN a2enmod rewrite headers >/dev/null && docker-php-ext-install pdo_mysql >/dev/null',
      `ENV APACHE_DOCUMENT_ROOT=${docroot}`,
      "RUN sed -ri -e 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/sites-available/*.conf /etc/apache2/apache2.conf",
      ...(hasComposer ? ['COPY --from=composer:2 /usr/bin/composer /usr/bin/composer'] : []),
      'WORKDIR /var/www/html',
      'COPY . .',
      ...(hasComposer ? [run(input.installCommand ?? 'composer install --no-dev --optimize-autoloader --no-interaction', ['/root/.composer/cache'])] : []),
      ...(input.buildCommand === null ? [] : [run(input.buildCommand)]),
      'RUN chown -R www-data:www-data /var/www/html',
      ...(input.startCommand === null ? [] : [cmd(input.startCommand)]),
    ].join('\n'),
  };
}

async function planRuby(input: BuildInput, procfile: Record<string, string>): Promise<BuildPlan> {
  const dir = input.contextDir;
  const gemfile = (await readText(join(dir, 'Gemfile'))) ?? '';
  // An exact `ruby "3.4.1"` in the Gemfile must match the image; a range (`>= 3.2`) accepts the default.
  const pinned = /^\s*ruby\s+['"](\d+\.\d+)(?:\.\d+)?['"]/m.exec(gemfile)?.[1];
  const version = /(\d+\.\d+)/.exec(versionLine(await readText(join(dir, '.ruby-version'))) ?? '')?.[1] ?? pinned ?? '3.4';
  const isRails = await exists(join(dir, 'config', 'application.rb'));
  const start =
    input.startCommand ??
    (input.kind === 'worker' ? procfile.worker : undefined) ??
    procfile.web ??
    (isRails ? 'bundle exec rails server -b 0.0.0.0 -p $PORT' : (await exists(join(dir, 'config.ru'))) ? 'bundle exec rackup -o 0.0.0.0 -p $PORT' : null);
  if (start === null) throw new AppError('bad_request', 'Could not determine how to start the app: add a Procfile or set a start command', { params: { reason: 'no_start' } });
  return {
    mode: 'generated',
    stack: 'ruby',
    label: `${isRails ? 'Rails' : 'Ruby'} · Ruby ${version}`,
    defaultPort: null,
    startCommand: start,
    dockerfilePath: 'Dockerfile',
    dockerfile: [
      `FROM ruby:${version}-slim`,
      'RUN apt-get update -qq && apt-get install -y --no-install-recommends build-essential libpq-dev libyaml-dev git >/dev/null && rm -rf /var/lib/apt/lists/*',
      'ENV BUNDLE_WITHOUT=development:test BUNDLE_DEPLOYMENT=1 RAILS_ENV=production RAILS_LOG_TO_STDOUT=1 RAILS_SERVE_STATIC_FILES=1',
      'WORKDIR /app',
      'COPY . .',
      run(input.installCommand ?? 'bundle install --jobs 4', ['/usr/local/bundle/cache']),
      ...(input.buildCommand !== null ? [run(input.buildCommand)] : isRails ? [run('SECRET_KEY_BASE_DUMMY=1 bundle exec rails assets:precompile || true')] : []),
      cmd(start),
    ].join('\n'),
  };
}

async function planDeno(input: BuildInput): Promise<BuildPlan> {
  const config = (await readJson<{ tasks?: Record<string, string> }>(join(input.contextDir, 'deno.json'))) ?? {};
  const entry = (await firstExisting(input.contextDir, ['main.ts', 'server.ts', 'mod.ts', 'src/main.ts'], (file) => file)) ?? 'main.ts';
  const start = input.startCommand ?? (config.tasks?.start !== undefined ? 'deno task start' : `deno run --allow-net --allow-env --allow-read ${entry}`);
  return {
    mode: 'generated',
    stack: 'deno',
    label: 'Deno',
    defaultPort: null,
    startCommand: start,
    dockerfilePath: 'Dockerfile',
    dockerfile: [
      'FROM denoland/deno:latest',
      'WORKDIR /app',
      'COPY . .',
      run(input.installCommand ?? `deno cache ${entry} || true`, ['/deno-dir']),
      ...(input.buildCommand === null ? [] : [run(input.buildCommand)]),
      cmd(start),
    ].join('\n'),
  };
}

async function planJava(input: BuildInput, tool: 'maven' | 'gradle'): Promise<BuildPlan> {
  const dir = input.contextDir;
  const build =
    input.buildCommand ??
    (tool === 'maven'
      ? `${(await exists(join(dir, 'mvnw'))) ? './mvnw' : 'mvn'} -B -q -DskipTests package`
      : `${(await exists(join(dir, 'gradlew'))) ? './gradlew' : 'gradle'} --no-daemon -q build -x test`);
  const jarGlob = tool === 'maven' ? 'target/*.jar' : 'build/libs/*.jar';
  const start = input.startCommand ?? 'java $JAVA_OPTS -jar /app/app.jar';
  return {
    mode: 'generated',
    stack: `java-${tool}`,
    label: `Java 21 · ${tool === 'maven' ? 'Maven' : 'Gradle'}`,
    defaultPort: 8080,
    startCommand: start,
    dockerfilePath: 'Dockerfile',
    dockerfile: [
      `FROM ${tool === 'maven' ? 'maven:3-eclipse-temurin-21' : 'gradle:8-jdk21'} AS build`,
      'WORKDIR /src',
      'COPY . .',
      run(`chmod +x mvnw gradlew 2>/dev/null || true; ${build} && mkdir -p /out && cp $(ls ${jarGlob} | grep -v -e '-plain' -e 'original' | head -n1) /out/app.jar`, [
        '/root/.m2',
        '/home/gradle/.gradle',
      ]),
      '',
      'FROM eclipse-temurin:21-jre',
      'WORKDIR /app',
      'COPY --from=build /out/app.jar /app/app.jar',
      'ENV JAVA_OPTS="-XX:MaxRAMPercentage=75"',
      cmd(start),
    ].join('\n'),
  };
}

function planStatic(input: BuildInput): BuildPlan {
  const source = input.outputDirectory === null || input.outputDirectory === '' ? '.' : input.outputDirectory;
  return {
    mode: 'generated',
    stack: 'static',
    label: 'Static site · Caddy',
    defaultPort: 8080,
    startCommand: null,
    dockerfilePath: 'Dockerfile',
    dockerfile: staticRuntime(null, source).join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function planBuild(input: BuildInput): Promise<BuildPlan> {
  const dir = input.contextDir;
  if (!(await exists(dir))) {
    throw new AppError('bad_request', 'The configured root directory does not exist in the repository', { params: { reason: 'root_missing' } });
  }

  if (input.buildType === 'dockerfile' || (input.buildType === 'auto' && (await exists(join(dir, input.dockerfilePath))))) {
    if (!(await exists(join(dir, input.dockerfilePath)))) {
      throw new AppError('bad_request', `${input.dockerfilePath} was not found in the repository`, { params: { reason: 'dockerfile_missing' } });
    }
    return { mode: 'dockerfile', stack: 'dockerfile', label: `Dockerfile (${input.dockerfilePath})`, dockerfile: null, dockerfilePath: input.dockerfilePath, defaultPort: null, startCommand: input.startCommand };
  }

  const procfile = await readProcfile(dir);
  const pkg = await readJson<PackageJson>(join(dir, 'package.json'));

  if (input.buildType === 'static' && pkg === null) return planStatic(input);
  if (pkg !== null) return planNode(input, pkg, procfile);
  if ((await exists(join(dir, 'requirements.txt'))) || (await exists(join(dir, 'pyproject.toml'))) || (await exists(join(dir, 'Pipfile')))) {
    return planPython(input, procfile);
  }
  if (await exists(join(dir, 'go.mod'))) return planGo(input);
  if (await exists(join(dir, 'Cargo.toml'))) return planRust(input);
  if ((await exists(join(dir, 'deno.json'))) || (await exists(join(dir, 'deno.jsonc')))) return planDeno(input);
  if (await exists(join(dir, 'Gemfile'))) return planRuby(input, procfile);
  if ((await exists(join(dir, 'composer.json'))) || (await exists(join(dir, 'index.php')))) return planPhp(input, procfile);
  if (await exists(join(dir, 'pom.xml'))) return planJava(input, 'maven');
  if ((await exists(join(dir, 'build.gradle'))) || (await exists(join(dir, 'build.gradle.kts')))) return planJava(input, 'gradle');
  if (await exists(join(dir, input.outputDirectory ?? '', 'index.html'))) return planStatic(input);

  throw new AppError('bad_request', 'Could not detect how to build this repository. Add a Dockerfile or choose a build type.', {
    params: { reason: 'undetected' },
  });
}

/** Shell-safe `KEY='value'` lines for the build-time secret file. */
export function renderEnvFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}='${value.replace(/'/g, `'\\''`)}'`)
    .join('\n');
}
