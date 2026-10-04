/**
 * Node.js and Bun.
 *
 * The package manager comes from `packageManager` or the lockfile, the Node
 * major from the usual version files, and the framework from dependencies.
 * Front-ends without a server are built and served by Caddy. Servers get a
 * build stage that installs with cache mounts (manifests first, so installs
 * are cached across source changes) and a runtime stage that ships only
 * production dependencies, or the framework's self-contained output (Next.js
 * standalone, Nuxt).
 */
import { basename, dirname, join, relative } from 'node:path';
import { AppError } from '../../lib/errors.ts';
import { cmd, exists, existing, firstExisting, generated, listDirs, readJson, readText, run, runtimePackages, staticRuntime, toolVersions, warn, type BuildPlan, type Ctx } from './shared.ts';

export interface PackageJson {
  name?: string;
  main?: string;
  packageManager?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

/** Dependency → display name, in detection order: a Next.js app also depends on react, a Remix app on vite. */
const FRAMEWORKS: [string, string][] = [
  ['next', 'Next.js'],
  ['nuxt', 'Nuxt'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['@react-router/serve', 'React Router'],
  ['@remix-run/serve', 'Remix'],
  ['astro', 'Astro'],
  ['@angular/core', 'Angular'],
  ['@nestjs/core', 'NestJS'],
  ['@adonisjs/core', 'AdonisJS'],
  ['gatsby', 'Gatsby'],
  ['@docusaurus/core', 'Docusaurus'],
  ['vitepress', 'VitePress'],
  ['@11ty/eleventy', 'Eleventy'],
  ['react-scripts', 'Create React App'],
  ['@vue/cli-service', 'Vue CLI'],
  ['parcel', 'Parcel'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['hono', 'Hono'],
  ['koa', 'Koa'],
  ['@hapi/hapi', 'Hapi'],
  ['elysia', 'Elysia'],
  ['vite', 'Vite'],
];

/** Dependencies that imply a long-running server (used to tell an app from front-end assets of another stack). */
const SERVER_FRAMEWORKS = ['next', 'nuxt', '@remix-run/serve', '@react-router/serve', '@sveltejs/adapter-node', '@nestjs/core', '@adonisjs/core', 'express', 'fastify', 'hono', 'koa', '@hapi/hapi', 'elysia', '@astrojs/node', '@angular/ssr'];

/** `start` scripts that run a development server: not a way to run in production. */
const DEV_SERVER = /(?:^|\s)(?:vite|react-scripts start|ng serve|vue-cli-service serve|parcel(?!\s+build)|astro dev|next dev|nuxt dev|nuxi dev|gatsby develop|webpack serve|webpack-dev-server|nest start(?!\s+--prod)|tsx watch|nodemon|ts-node-dev)(?:\s|$)/;

/** Binaries a start command may call → the package that provides them, to notice dev-only tools at runtime. */
const BIN_PACKAGES: Record<string, string> = {
  nest: '@nestjs/cli',
  'remix-serve': '@remix-run/serve',
  'react-router-serve': '@react-router/serve',
  tsc: 'typescript',
  dotenv: 'dotenv-cli',
  'babel-node': '@babel/node',
};

const DEFAULT_NODE = 24;
/** Majors at or below this have reached end-of-life (Node 20: April 2026). */
const EOL_NODE = 20;

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

function has(pkg: PackageJson, dependency: string): boolean {
  return pkg.dependencies?.[dependency] !== undefined || pkg.devDependencies?.[dependency] !== undefined;
}

/** Whether a package.json describes a running service rather than front-end assets built for another stack. */
export function isNodeApp(pkg: PackageJson, procfile: Record<string, string>): boolean {
  const start = pkg.scripts?.start;
  return (start !== undefined && !DEV_SERVER.test(start)) || SERVER_FRAMEWORKS.some((name) => has(pkg, name)) || /\b(?:node|npm|pnpm|yarn|bun|npx)\b/.test(procfile.web ?? '');
}

/** The first existing `<name>.{js,mjs,cjs,ts,mts}` config file's text, or "". */
async function configText(dir: string, name: string): Promise<string> {
  const file = await firstExisting(dir, ['js', 'mjs', 'cjs', 'ts', 'mts'].map((ext) => `${name}.${ext}`), (f) => f);
  return file === null ? '' : ((await readText(join(dir, file))) ?? '');
}

// ---------------------------------------------------------------------------
// Package managers
// ---------------------------------------------------------------------------

export interface PackageManager {
  name: 'npm' | 'pnpm' | 'yarn' | 'bun';
  lockfile: string | null;
  /** Config files that must be present for the install (lockfile, .npmrc…). */
  manifests: string[];
  /** Installs everything, dev dependencies included (they are needed to build). */
  install: string;
  /** Drops dev dependencies after the build. */
  prune: string;
  caches: string[];
  run: (script: string) => string;
}

const LOCKFILES = { npm: ['package-lock.json', 'npm-shrinkwrap.json'], pnpm: ['pnpm-lock.yaml'], yarn: ['yarn.lock'], bun: ['bun.lock', 'bun.lockb'] };

/** The package manager named by `packageManager` (corepack), else the one owning the lockfile, else npm. */
export async function packageManager(dir: string, pkg: PackageJson): Promise<PackageManager> {
  const declared = /^(npm|pnpm|yarn|bun)@(\d[^+\s]*)/.exec(pkg.packageManager ?? '');
  const lock = await firstExisting(dir, ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json'], (file) => file);
  const name = (declared?.[1] as PackageManager['name'] | undefined) ?? (lock === null ? 'npm' : lock.startsWith('bun') ? 'bun' : lock === 'pnpm-lock.yaml' ? 'pnpm' : lock === 'yarn.lock' ? 'yarn' : 'npm');
  const version = declared?.[1] === name ? declared[2]! : null;
  const lockfile = await firstExisting(dir, LOCKFILES[name], (file) => file);
  const frozen = lockfile !== null;
  const berry = name === 'yarn' && (version !== null ? Number(version.split('.')[0]) >= 2 : await exists(join(dir, '.yarnrc.yml')));
  // corepack ships with Node up to 24; newer images need it installed.
  const corepack = 'corepack enable 2>/dev/null || npm install -g corepack >/dev/null && corepack enable';
  const manifests = await existing(dir, ['package.json', ...(lockfile === null ? [] : [lockfile]), '.npmrc', '.yarnrc', '.yarnrc.yml', 'pnpm-workspace.yaml', '.pnpmfile.cjs']);
  const common = { name, lockfile, manifests, run: (script: string) => (name === 'npm' ? `npm run ${script}` : `${name} run ${script}`) };
  switch (name) {
    case 'pnpm':
      return { ...common, install: `npm install -g pnpm@${version ?? '10'} >/dev/null && pnpm install ${frozen ? '--frozen-lockfile' : '--no-frozen-lockfile'} --prod=false`, prune: 'pnpm prune --prod', caches: ['/root/.local/share/pnpm/store', '/root/.npm'] };
    case 'yarn':
      return berry
        ? { ...common, install: `${corepack} && yarn install${frozen ? ' --immutable' : ''}`, prune: 'yarn workspaces focus --all --production || echo "yarn workspace-tools plugin missing: dev dependencies kept"', caches: ['/root/.yarn/berry/cache'] }
        : { ...common, install: `yarn install${frozen ? ' --frozen-lockfile' : ''} --production=false`, prune: 'yarn install --production --ignore-scripts --prefer-offline', caches: ['/usr/local/share/.cache/yarn'] };
    case 'bun':
      return { ...common, install: `bun install${frozen ? ' --frozen-lockfile' : ''}`, prune: `bun install --production${frozen ? ' --frozen-lockfile' : ''}`, caches: ['/root/.bun/install/cache'] };
    default:
      return { ...common, install: `${version === null ? '' : `npm install -g npm@${version} >/dev/null && `}${frozen ? 'npm ci' : 'npm install'} --include=dev`, prune: 'npm prune --omit=dev', caches: ['/root/.npm'] };
  }
}

/** Node major from the config file, `.nvmrc`, `.node-version`, `.tool-versions`/`mise.toml` or `engines.node`. */
export async function resolveNodeMajor(ctx: Ctx, pkg: PackageJson): Promise<number> {
  const tools = await toolVersions(ctx.dir);
  const pinned = ctx.runtime.node ?? (await readText(join(ctx.dir, '.nvmrc'))) ?? (await readText(join(ctx.dir, '.node-version'))) ?? tools.nodejs ?? tools.node ?? null;
  const major = nodeMajor(pkg, pinned);
  if (major <= EOL_NODE) warn(ctx, `Node ${major} has reached end-of-life; pin a supported major (22 or 24) in .nvmrc or engines.node.`);
  return major;
}

/** Brings node, npm and corepack into a Debian-based stage of another stack, for its asset build. */
export function nodeToolchain(major: number): string[] {
  return [
    `COPY --from=node:${major}-slim /usr/local/bin/node /usr/local/bin/node`,
    `COPY --from=node:${major}-slim /usr/local/lib/node_modules /usr/local/lib/node_modules`,
    'RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack',
  ];
}

/** Install and build commands for a package.json that only produces assets for another stack (Rails, Django, Laravel). */
export async function assetBuild(ctx: Ctx, pkg: PackageJson): Promise<{ major: number; install: string; build: string; caches: string[] } | null> {
  if (pkg.scripts?.build === undefined) return null;
  const pm = await packageManager(ctx.dir, pkg);
  return { major: await resolveNodeMajor(ctx, pkg), install: pm.install, build: pm.run('build'), caches: pm.caches };
}

// ---------------------------------------------------------------------------
// Monorepos
// ---------------------------------------------------------------------------

/** Workspace package names under `apps/*`-style globs, for the hint in the monorepo warning. */
async function workspaceMembers(root: string, globs: string[]): Promise<string[]> {
  const names: string[] = [];
  for (const glob of globs) {
    const base = glob.endsWith('/*') ? glob.slice(0, -2) : glob.includes('*') ? null : glob;
    if (base === null) continue;
    for (const dir of glob.endsWith('/*') ? await listDirs(join(root, base)) : ['']) {
      const member = await readJson<PackageJson>(join(root, base, dir, 'package.json'));
      if (member?.name !== undefined) names.push(member.name);
    }
  }
  return names;
}

async function workspaceGlobs(root: string, pkg: PackageJson | null): Promise<string[] | null> {
  const pnpm = await readText(join(root, 'pnpm-workspace.yaml'));
  if (pnpm !== null) return [...pnpm.matchAll(/^\s*-\s*['"]?([^'"\s#]+)/gm)].map((match) => match[1]!);
  if (pkg?.workspaces === undefined) return null;
  return Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces.packages ?? []);
}

/** `pnpm --filter x build` and friends, in the workspace's own package manager. */
function workspaceCommand(pm: PackageManager['name'], name: string, script: string): string {
  return pm === 'pnpm' ? `pnpm --filter ${name} ${script}` : pm === 'yarn' ? `yarn workspace ${name} ${script}` : pm === 'bun' ? `bun run --filter ${name} ${script}` : `npm run ${script} -w ${name}`;
}

/**
 * Warns when the context is a monorepo root, or a package inside one (whose
 * workspace dependencies cannot resolve from a context of just that package).
 * Returns whether the context sits inside a workspace.
 */
async function checkWorkspace(ctx: Ctx, pkg: PackageJson, pm: PackageManager): Promise<boolean> {
  const dir = ctx.dir;
  const globs = await workspaceGlobs(dir, pkg);
  if (globs !== null) {
    const tool = (await exists(join(dir, 'turbo.json'))) ? 'Turborepo' : (await exists(join(dir, 'nx.json'))) ? 'Nx' : `${pm.name} workspaces`;
    const members = await workspaceMembers(dir, globs);
    const example = members[0] ?? '<package>';
    warn(ctx, `Monorepo (${tool}) detected and the root package is being built. Set Root Directory to the app's package${members.length > 0 ? ` (${members.slice(0, 8).join(', ')})` : ''}, or keep the root and set the build command to "${workspaceCommand(pm.name, example, 'build')}" and the start command to "${workspaceCommand(pm.name, example, 'start')}".`);
    return false;
  }
  // A package inside a workspace: walk up to the checkout root (the directory holding .git).
  let parent = dirname(dir);
  for (let depth = 0; depth < 3 && parent !== dirname(parent); depth++, parent = dirname(parent)) {
    const parentPkg = await readJson<PackageJson>(join(parent, 'package.json'));
    if ((await workspaceGlobs(parent, parentPkg)) !== null) {
      const rootPm = (await packageManager(parent, parentPkg ?? {})).name;
      const name = pkg.name ?? basename(dir);
      warn(ctx, `This package belongs to a workspace at ${relative(dir, parent)} and the build context is only this directory, so workspace dependencies cannot resolve. Set Root Directory to the repository root with the build command "${workspaceCommand(rootPm, name, 'build')}" and the start command "${workspaceCommand(rootPm, name, 'start')}".`);
      return true;
    }
    if (await exists(join(parent, '.git'))) break;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Frameworks
// ---------------------------------------------------------------------------

interface Shape {
  kind: 'static' | 'server';
  /** A static kind settled by the framework config (`output: 'export'`, adapter-static…), whatever the `start` script says. */
  certain: boolean;
  /** Known build output directory of a static site, else probed at build time. */
  output: string | null;
  /** Next.js `output: 'standalone'`: the runtime copies `.next/standalone` only. */
  standalone: boolean;
  port: number;
  start: string | null;
  buildCaches: string[];
}

/** How a framework is run in production: static output, a self-contained server bundle, or a plain Node start. */
async function frameworkShape(ctx: Ctx, pkg: PackageJson, framework: string | null, pm: PackageManager): Promise<Shape> {
  const dir = ctx.dir;
  const scripts = pkg.scripts ?? {};
  const server = (start: string | null, port = 3000, extra: Partial<Shape> = {}): Shape => ({ kind: 'server', certain: false, output: null, standalone: false, port, start, buildCaches: [], ...extra });
  const site = (output: string | null, certain = false): Shape => ({ kind: 'static', certain, output, standalone: false, port: 8080, start: null, buildCaches: [] });
  switch (framework) {
    case 'next': {
      const config = await configText(dir, 'next.config');
      if (/output\s*:\s*['"]export['"]/.test(config)) return site('out', true);
      const standalone = /output\s*:\s*['"]standalone['"]/.test(config);
      return server(standalone ? 'node server.js' : scripts.start !== undefined ? pm.run('start') : 'npx next start', 3000, { standalone, buildCaches: ['/app/.next/cache'] });
    }
    case 'nuxt':
      return /\b(?:nuxt|nuxi)\s+generate\b/.test(scripts.build ?? '') ? site('.output/public', true) : server('node .output/server/index.mjs');
    case '@sveltejs/kit': {
      const config = await configText(dir, 'svelte.config');
      if (config.includes('adapter-static')) return site('build', true);
      if (!config.includes('adapter-node')) warn(ctx, 'SvelteKit is using adapter-auto, which cannot target a container: install @sveltejs/adapter-node (or adapter-static for a static site).');
      warn(ctx, 'SvelteKit adapter-node: set ORIGIN=https://<your-domain> in the environment so form actions and redirects use the public URL.');
      return server('node build');
    }
    case '@react-router/serve':
      return server(scripts.start !== undefined ? pm.run('start') : 'react-router-serve ./build/server/index.js');
    case '@remix-run/serve':
      return server(scripts.start !== undefined ? pm.run('start') : 'remix-serve ./build/server/index.js');
    case 'astro':
      return has(pkg, '@astrojs/node') ? server('node ./dist/server/entry.mjs', 4321) : site('dist', true);
    case '@angular/core': {
      const angular = await readJson<{ projects?: Record<string, unknown> }>(join(dir, 'angular.json'));
      const project = Object.keys(angular?.projects ?? {})[0] ?? pkg.name ?? 'app';
      return has(pkg, '@angular/ssr') ? server(`node dist/${project}/server/server.mjs`, 4000) : site(`dist/${project}/browser`, true);
    }
    case '@nestjs/core':
      return server(scripts['start:prod'] !== undefined ? pm.run('start:prod') : 'node dist/main.js');
    case 'gatsby':
      return site('public');
    case '@docusaurus/core':
    case 'react-scripts':
      return site('build');
    case '@11ty/eleventy':
      return site('_site');
    case '@vue/cli-service':
    case 'parcel':
    case 'vite':
      return site('dist');
    case 'vitepress':
      return site(null);
    default:
      return server(scripts.start !== undefined ? pm.run('start') : null);
  }
}

/** A dev-only package that the start command runs (tsx, ts-node, the Nest CLI…): pruning would break it. */
function devToolInStart(start: string, pkg: PackageJson): string | null {
  const script = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(\S+)/.exec(start)?.[1];
  const text = (script !== undefined ? pkg.scripts?.[script] : undefined) ?? start;
  const token = text.replace(/^(?:\w+=\S*\s+)+/, '').split(/\s+/)[0] ?? '';
  const dependency = BIN_PACKAGES[token] ?? token;
  return pkg.devDependencies?.[dependency] !== undefined && pkg.dependencies?.[dependency] === undefined ? dependency : null;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planNode(ctx: Ctx, pkg: PackageJson): Promise<BuildPlan> {
  const { dir, input, procfile } = ctx;
  const scripts = pkg.scripts ?? {};
  const pm = await packageManager(dir, pkg);
  const isBun = pm.name === 'bun';
  const tools = await toolVersions(dir);
  const bunVersion = /^\d[\d.]*/.exec(ctx.runtime.bun ?? (await readText(join(dir, '.bun-version')))?.trim() ?? tools.bun ?? /^bun@(\d[\d.]*)/.exec(pkg.packageManager ?? '')?.[1] ?? '')?.[0] ?? '1';
  const major = await resolveNodeMajor(ctx, pkg);
  const framework = FRAMEWORKS.find(([name]) => has(pkg, name)) ?? null;
  const shape = await frameworkShape(ctx, pkg, framework?.[0] ?? null, pm);
  const insideWorkspace = await checkWorkspace(ctx, pkg, pm);
  if (pm.lockfile === null && !insideWorkspace) warn(ctx, `No lockfile found (${LOCKFILES[pm.name][0]}); installs are not reproducible. Commit the lockfile.`);

  const install = input.installCommand ?? pm.install;
  const build = input.buildCommand ?? (scripts.build !== undefined ? pm.run('build') : null);
  // Manifests are copied ahead of the sources so the install layer survives source changes, unless
  // the install needs the sources (lifecycle scripts, workspaces, a custom command, Yarn Berry's .yarn dir).
  const manifestsFirst =
    input.installCommand === null && !['preinstall', 'postinstall', 'prepare'].some((name) => scripts[name] !== undefined) && pkg.workspaces === undefined && !pm.manifests.includes('pnpm-workspace.yaml') && !pm.manifests.includes('.yarnrc.yml');
  const buildStage = [
    `FROM ${isBun ? `oven/bun:${bunVersion}` : `node:${major}-slim`} AS build`,
    'WORKDIR /app',
    'ENV CI=true NEXT_TELEMETRY_DISABLED=1',
    ...(manifestsFirst ? [`COPY ${pm.manifests.join(' ')} ./`, run(install, pm.caches), 'COPY . .'] : ['COPY . .', run(install, pm.caches)]),
    ...(build === null ? [] : [run(build, [...shape.buildCaches, '/app/node_modules/.cache'])]),
  ];
  const label = [`${framework?.[1] ?? (isBun ? 'Bun' : 'Node.js')}${shape.standalone ? ' (standalone)' : ''}`, pm.name, isBun ? `Bun ${bunVersion}` : `Node ${major}`].join(' · ');

  // A front-end without a server: build it and serve the output with Caddy.
  const explicitStart = input.startCommand ?? (input.kind === 'worker' ? procfile.worker : undefined) ?? procfile.web ?? null;
  const devStart = scripts.start !== undefined && DEV_SERVER.test(scripts.start);
  if (input.buildType === 'static' || (explicitStart === null && shape.kind === 'static' && (shape.certain || scripts.start === undefined || devStart))) {
    if (build === null) throw new AppError('bad_request', 'Static site has no build script; set a build command', { params: { reason: 'no_build' } });
    const probe = [shape.output, 'dist', 'build', 'out', 'public', 'www', '_site', '.output/public', 'dist/*/browser', 'dist/*'].filter((d): d is string => d !== null);
    const collect = input.outputDirectory !== null
      ? `cp -r ${input.outputDirectory}/. /ploy-out/`
      : `for d in ${probe.join(' ')}; do if [ -f "$d/index.html" ]; then cp -r "$d/." /ploy-out/; exit 0; fi; done; echo "No build output with an index.html was found (looked in ${probe.join(', ')}). Set the output directory." >&2; exit 1`;
    return generated(ctx, {
      stack: 'static-node',
      label: `${label} → static`,
      defaultPort: 8080,
      startCommand: null,
      lines: [...buildStage, run(`mkdir -p /ploy-out && ${collect}`, [], false), '', ...staticRuntime('build', '/ploy-out', runtimePackages(ctx, 'alpine'))],
    });
  }

  let start = explicitStart ?? shape.start;
  if (start === null) {
    const runtimeBin = isBun ? 'bun' : 'node';
    start =
      (pkg.main !== undefined ? `${runtimeBin} ${pkg.main}` : null) ??
      (await firstExisting(dir, ['server.js', 'index.js', 'app.js', 'main.js', 'dist/index.js', 'dist/main.js', 'build/index.js', 'server.mjs', 'index.mjs'], (file) => `${runtimeBin} ${file}`)) ??
      (isBun ? await firstExisting(dir, ['index.ts', 'src/index.ts', 'server.ts', 'src/server.ts'], (file) => `bun ${file}`) : null);
    if (start === null) {
      throw new AppError('bad_request', 'Could not determine how to start the app: add a "start" script, a Procfile, or set a start command', { params: { reason: 'no_start' } });
    }
    warn(ctx, `Start command guessed as "${start}"; add a "start" script to package.json to make it explicit.`);
  }
  if (devStart && explicitStart === null) warn(ctx, `The "start" script (${scripts.start}) looks like a development server.`);
  const devTool = devToolInStart(start, pkg);
  if (devTool !== null) warn(ctx, `The start command runs ${devTool}, a dev dependency, so dev dependencies are kept in the image; move it to "dependencies" (or start the compiled output) for a slimmer image.`);

  // Runtime stage: the self-contained framework output when there is one, else the pruned app directory.
  const selfContained = shape.standalone ? 'next' : framework?.[0] === 'nuxt' && start === 'node .output/server/index.mjs' ? 'nuxt' : null;
  const user = isBun ? 'bun' : 'node';
  const copyRuntime = {
    next: [...((await exists(join(dir, 'public'))) ? [`COPY --from=build --chown=${user}:${user} /app/public /app/public`] : []), `COPY --from=build --chown=${user}:${user} /app/.next/standalone /app`, `COPY --from=build --chown=${user}:${user} /app/.next/static /app/.next/static`],
    nuxt: [`COPY --from=build --chown=${user}:${user} /app/.output /app/.output`],
  };
  return generated(ctx, {
    stack: isBun ? 'bun' : 'node',
    label,
    defaultPort: shape.port,
    startCommand: start,
    lines: [
      ...buildStage,
      ...(selfContained === null && devTool === null ? [run(pm.prune, pm.caches)] : []),
      '',
      `FROM ${isBun ? `oven/bun:${bunVersion}-slim` : `node:${major}-slim`}`,
      ...runtimePackages(ctx, 'debian', isBun ? ['ca-certificates'] : ['ca-certificates', 'dumb-init']),
      'WORKDIR /app',
      `ENV NODE_ENV=production PORT=${shape.port}${shape.standalone ? ' HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1' : ''}`,
      ...(selfContained === null ? [`COPY --from=build --chown=${user}:${user} /app /app`] : copyRuntime[selfContained]),
      `USER ${user}`,
      `EXPOSE ${shape.port}`,
      ...(isBun ? [] : ['ENTRYPOINT ["dumb-init", "--"]']),
      cmd(start),
    ],
  });
}
