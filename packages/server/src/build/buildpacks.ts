/**
 * Cloud Native Buildpacks through `pack`: Heroku's and Paketo's builders.
 *
 * `pack build` runs the lifecycle in containers on the deployment's daemon
 * (`DOCKER_HOST`), pulling the builder with the team's logins from
 * `DOCKER_CONFIG`. Variables go as `--env NAME`, read from the child's
 * environment. `pack` has no `--label`, so the finished image is relabelled
 * through a one-line Dockerfile and the unlabelled staging tag removed. A
 * start command set in the panel is written to a Procfile, which is how both
 * vendors' builders take one (`heroku/procfile`, `paketo-buildpacks/procfile`).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuildType } from '@ploy/shared';
import { prepareCliConfig } from '../docker/cli.ts';
import { runProcess } from '../lib/process.ts';
import { childEnv, envNames, imageLabels, runBuilder, type ExternalBuildRequest, type ExternalPlan, type ExternalSettings } from './common.ts';

export type BuildpackVendor = 'heroku' | 'paketo';

export const DEFAULT_BUILDERS: Readonly<Record<BuildpackVendor, string>> = {
  heroku: 'heroku/builder:24',
  paketo: 'paketobuildpacks/builder-jammy-base',
};

const VENDOR_LABEL: Readonly<Record<BuildpackVendor, string>> = { heroku: 'Heroku Buildpacks', paketo: 'Paketo Buildpacks' };

export function isBuildpackVendor(buildType: BuildType): buildType is BuildpackVendor {
  return buildType === 'heroku' || buildType === 'paketo';
}

/** The builder image a build uses: the user's override or the vendor's default. */
export function builderImage(settings: Pick<ExternalSettings, 'buildType' | 'buildpackBuilder'>): string {
  const vendor: BuildpackVendor = settings.buildType === 'paketo' ? 'paketo' : 'heroku';
  return settings.buildpackBuilder ?? DEFAULT_BUILDERS[vendor];
}

/** "Heroku Buildpacks (heroku/builder:24)". */
export function buildpacksLabel(settings: Pick<ExternalSettings, 'buildType' | 'buildpackBuilder'>): string {
  const vendor: BuildpackVendor = settings.buildType === 'paketo' ? 'paketo' : 'heroku';
  return `${VENDOR_LABEL[vendor]} (${builderImage(settings)})`;
}

export async function buildWithBuildpacks(request: ExternalBuildRequest): Promise<ExternalPlan> {
  const { settings } = request;
  const builder = builderImage(settings);
  const names = envNames(request.buildEnv);
  // pack cannot label; the image is built under a staging tag, then relabelled under the real one.
  const stagingTag = `${request.imageTag}-cnb`;
  const packHome = join(request.scratchDir, 'pack-home');
  const env: Record<string, string> = { ...childEnv(request, names), PACK_HOME: packHome };

  if (settings.startCommand !== null) {
    await writeFile(join(request.contextDir, 'Procfile'), `web: ${settings.startCommand}\n`);
    request.onOutput(`Start command written to Procfile: web: ${settings.startCommand}`);
  }
  const args = ['build', stagingTag, '--path', request.contextDir, '--builder', builder, '--pull-policy', 'if-not-present', '--trust-builder', '--no-color'];
  if (settings.startCommand !== null) args.push('--default-process', 'web');
  for (const name of names) args.push('--env', name);
  if (request.noCache) args.push('--clear-cache');

  await mkdir(packHome, { recursive: true, mode: 0o700 });
  await prepareCliConfig(env.DOCKER_CONFIG!, request.registryAuths);
  try {
    request.onOutput(`Building with ${builder} (${VENDOR_LABEL[settings.buildType === 'paketo' ? 'paketo' : 'heroku']})`);
    await runBuilder('pack', {
      tool: 'pack build',
      args,
      env,
      timeoutMs: request.timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      onOutput: request.onOutput,
    });

    const labelDir = join(request.scratchDir, 'labels');
    await mkdir(labelDir, { recursive: true, mode: 0o700 });
    await writeFile(join(labelDir, 'Dockerfile'), `FROM ${stagingTag}\n`, { mode: 0o600 });
    const relabel = ['buildx', 'build', '--progress=plain', '--load', '--tag', request.imageTag, '--file', join(labelDir, 'Dockerfile')];
    for (const label of imageLabels(request)) relabel.push('--label', label);
    relabel.push(labelDir);
    request.onOutput('Labelling the image');
    try {
      await runBuilder('docker', {
        tool: 'docker buildx build',
        args: relabel,
        env,
        timeoutMs: Math.min(request.timeoutMs, 5 * 60_000),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        onOutput: () => undefined,
      });
    } finally {
      // The staging tag only points at layers the labelled image shares; dropping it leaves nothing dangling.
      await runProcess('docker', ['image', 'rm', stagingTag], { env, timeoutMs: 60_000 }).catch(() => undefined);
    }
  } finally {
    await rm(env.DOCKER_CONFIG!, { recursive: true, force: true });
  }
  return { mode: 'external', stack: settings.buildType, label: buildpacksLabel(settings), dockerfile: null, dockerfilePath: '', defaultPort: null, startCommand: settings.startCommand, warnings: [] };
}
