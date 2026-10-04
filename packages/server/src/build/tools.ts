/**
 * Builder CLIs on the control plane.
 *
 * TorexBuilder, Dockerfile and static builds need only the docker CLI, which
 * the control plane cannot run without. Nixpacks, Railpack and Cloud Native
 * Buildpacks are separate binaries (`nixpacks`, `railpack`, `pack`): the
 * production image ships them, a developer's machine may not. Which ones
 * exist is looked up once at startup — the image is immutable — and reported
 * to the dashboard, so it offers only builders that can actually run here.
 */
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { BUILD_TYPES, EXTERNAL_BUILD_TYPES, type BuildType } from '@ploy/shared';
import { AppError } from '../lib/errors.ts';

/** The CLI each external builder needs (Heroku and Paketo buildpacks share `pack`). */
export const BUILDER_CLI: Readonly<Partial<Record<BuildType, string>>> = { nixpacks: 'nixpacks', railpack: 'railpack', heroku: 'pack', paketo: 'pack' };

const BUILTIN: readonly BuildType[] = BUILD_TYPES.filter((type) => !EXTERNAL_BUILD_TYPES.includes(type));

let detected: readonly BuildType[] | null = null;

/** The first executable file named `cli` on `path`, or null. */
export async function findOnPath(cli: string, path: string | undefined = process.env.PATH): Promise<string | null> {
  for (const dir of (path ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, cli);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory; try the next one.
    }
  }
  return null;
}

/** Look the builder CLIs up on `path` and remember the result for {@link availableBuilders}. */
export async function detectBuilders(path: string | undefined = process.env.PATH): Promise<BuildType[]> {
  const found = new Map<string, boolean>();
  for (const cli of new Set(Object.values(BUILDER_CLI))) found.set(cli, (await findOnPath(cli, path)) !== null);
  detected = BUILD_TYPES.filter((type) => {
    const cli = BUILDER_CLI[type];
    return cli === undefined || found.get(cli) === true;
  });
  return [...detected];
}

/** Builders this control plane can run. Until {@link detectBuilders} has run: the ones that need no CLI. */
export function availableBuilders(): BuildType[] {
  return [...(detected ?? BUILTIN)];
}

/** Reject a build type whose CLI is missing here, as a validation error on `buildType`. */
export function requireBuilder(buildType: BuildType): void {
  if (availableBuilders().includes(buildType)) return;
  throw new AppError('validation_failed', `The ${buildType} builder is not installed on this control plane`, {
    issues: [{ path: 'buildType', code: 'custom', message: `${BUILDER_CLI[buildType] ?? buildType} is not installed`, params: { reason: 'builder_unavailable', builder: buildType } }],
  });
}
