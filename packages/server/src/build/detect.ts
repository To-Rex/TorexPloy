/**
 * TorexBuilder: from a checked-out repository to a Dockerfile.
 *
 * A repository with its own Dockerfile is built as-is. Otherwise the stack is
 * detected from its manifest files and an optimized Dockerfile is generated:
 * dependency manifests copied ahead of the sources so installs are cached,
 * BuildKit cache mounts for package-manager stores, build-time variables
 * injected through a secret mount (so they never land in image layers or
 * history), and a slim non-root runtime stage where the stack allows it.
 *
 * An optional `torexploy.json` in the context sets commands, system packages
 * and runtime versions; panel settings take precedence over it. The plan
 * carries `warnings` for things worth fixing that did not stop the build.
 *
 * The generated Dockerfile is plain text written next to the checkout and
 * printed in the deployment log, so nothing about a build is hidden.
 * Stack planners live under ./torex/.
 */
import { join } from 'node:path';
import { AppError } from '../lib/errors.ts';
import { planElixir, planGleam } from './torex/beam.ts';
import { planDeno } from './torex/deno.ts';
import { dotnetProjects, planDotnet } from './torex/dotnet.ts';
import { planGo } from './torex/go.ts';
import { planClojure, planJava } from './torex/jvm.ts';
import { planCrystal, planDart, planHaskell, planNim, planSwift } from './torex/native.ts';
import { isNodeApp, planNode, type PackageJson } from './torex/node.ts';
import { planPhp } from './torex/php.ts';
import { planPython } from './torex/python.ts';
import { planRuby } from './torex/ruby.ts';
import { planRust } from './torex/rust.ts';
import { createContext, exists, listDir, readJson, type BuildInput, type BuildPlan, type Ctx } from './torex/shared.ts';
import { planStatic } from './torex/static.ts';

export type { BuildInput, BuildPlan, TorexConfig } from './torex/shared.ts';
export { readProcfile } from './torex/shared.ts';
export { nodeMajor } from './torex/node.ts';

/** The planner for the first back-end manifest found, in detection order; null when there is none. */
async function detectBackend(ctx: Ctx): Promise<(() => Promise<BuildPlan>) | null> {
  const files = await listDir(ctx.dir);
  const any = (...names: string[]): boolean => names.some((name) => files.includes(name));
  if (any('requirements.txt', 'pyproject.toml', 'Pipfile', 'uv.lock', 'pdm.lock')) return () => planPython(ctx);
  if (any('go.mod')) return () => planGo(ctx);
  if (any('Cargo.toml')) return () => planRust(ctx);
  if (any('mix.exs')) return () => planElixir(ctx);
  if (any('gleam.toml')) return () => planGleam(ctx);
  if (any('Gemfile')) return () => planRuby(ctx);
  if (any('composer.json', 'index.php', 'artisan')) return () => planPhp(ctx);
  if ((await dotnetProjects(ctx.dir)).length > 0) return () => planDotnet(ctx);
  if (any('pubspec.yaml')) return () => planDart(ctx);
  if (any('Package.swift')) return () => planSwift(ctx);
  if (any('shard.yml')) return () => planCrystal(ctx);
  const nimble = files.find((name) => name.endsWith('.nimble'));
  if (nimble !== undefined) return () => planNim(ctx, nimble);
  if (any('stack.yaml') || files.some((name) => name.endsWith('.cabal'))) return () => planHaskell(ctx);
  if (any('pom.xml')) return () => planJava(ctx, 'maven');
  if (any('build.gradle', 'build.gradle.kts')) return () => planJava(ctx, 'gradle');
  if (any('project.clj', 'deps.edn')) return () => planClojure(ctx);
  return null;
}

export async function planBuild(input: BuildInput): Promise<BuildPlan> {
  const dir = input.contextDir;
  if (!(await exists(dir))) {
    throw new AppError('bad_request', 'The configured root directory does not exist in the repository', { params: { reason: 'root_missing' } });
  }

  // A repository Dockerfile is always used as-is: in `torex` mode when present, in `dockerfile` mode unconditionally.
  const hasDockerfile = await exists(join(dir, input.dockerfilePath));
  if (input.buildType === 'dockerfile' || (input.buildType === 'torex' && hasDockerfile)) {
    if (!hasDockerfile) {
      throw new AppError('bad_request', `${input.dockerfilePath} was not found in the repository`, { params: { reason: 'dockerfile_missing' } });
    }
    return {
      mode: 'dockerfile',
      stack: 'dockerfile',
      label: `Dockerfile (${input.dockerfilePath})${input.buildType === 'torex' ? ' · found in the repository, used as-is' : ''}`,
      dockerfile: null,
      dockerfilePath: input.dockerfilePath,
      defaultPort: null,
      startCommand: input.startCommand,
      buildStage: input.buildStage,
      warnings: [],
    };
  }

  const ctx = await createContext(input);
  const pkg = await readJson<PackageJson>(join(dir, 'package.json'));
  if (input.buildType === 'static' && pkg === null) return planStatic(ctx);
  if ((await exists(join(dir, 'deno.json'))) || (await exists(join(dir, 'deno.jsonc')))) return planDeno(ctx);

  // A package.json next to a back-end manifest usually only builds its front-end assets (Laravel + Vite,
  // Rails + jsbundling, Django + Tailwind): the back-end wins unless the package is itself a server.
  const backend = await detectBackend(ctx);
  if (pkg !== null && (backend === null || input.buildType === 'static' || isNodeApp(pkg, ctx.procfile))) return planNode(ctx, pkg);
  if (backend !== null) return backend();
  if (await exists(join(dir, input.outputDirectory ?? '', 'index.html'))) return planStatic(ctx);

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
