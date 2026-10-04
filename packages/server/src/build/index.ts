/**
 * The build dispatcher: one entry point that turns a checked-out source into
 * an image, whichever builder the application chose.
 *
 * - `torex`, `dockerfile`, `static`: TorexBuilder plans ({@link planBuild})
 *   and `docker buildx build` builds ({@link buildImage}).
 * - `nixpacks`, `railpack`, `heroku`, `paketo`: the builder's own CLI; see
 *   the module of each.
 *
 * The deployer only ever sees a {@link DeployPlan}: TorexBuilder's plan, or
 * an external one that carries no Dockerfile and lets the image decide.
 */
import { EXTERNAL_BUILD_TYPES, splitPackages, type BuildType } from '@ploy/shared';
import type { CliAuths } from '../docker/registry.ts';
import { buildImage } from './builder.ts';
import { buildpacksLabel, buildWithBuildpacks } from './buildpacks.ts';
import type { ExternalBuildRequest, ExternalPlan, ExternalSettings } from './common.ts';
import { planBuild, type BuildInput, type BuildPlan } from './detect.ts';
import { buildWithNixpacks, NIXPACKS_LABEL } from './nixpacks.ts';
import { buildWithRailpack, RAILPACK_LABEL } from './railpack.ts';

export type { ExternalPlan } from './common.ts';
export type DeployPlan = BuildPlan | ExternalPlan;

/** The build settings of an application: the columns the dashboard's build form edits. */
export interface BuildSettings extends ExternalSettings {
  kind: 'web' | 'worker';
  dockerfilePath: string;
  outputDirectory: string | null;
  /** Dockerfile builds: the stage to build (`--target`). */
  buildStage: string | null;
  /** TorexBuilder: extra apt packages, as typed. */
  systemPackages: string | null;
}

/** An application's build settings, as the dispatcher reads them. */
export function settingsOf(app: {
  kind: string;
  buildType: BuildType;
  dockerfilePath: string;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputDirectory: string | null;
  buildStage: string | null;
  buildpackBuilder: string | null;
  systemPackages: string | null;
}): BuildSettings {
  return {
    kind: app.kind === 'worker' ? 'worker' : 'web',
    buildType: app.buildType,
    dockerfilePath: app.dockerfilePath,
    installCommand: app.installCommand,
    buildCommand: app.buildCommand,
    startCommand: app.startCommand,
    outputDirectory: app.outputDirectory,
    buildStage: app.buildStage,
    buildpackBuilder: app.buildpackBuilder,
    systemPackages: app.systemPackages,
  };
}

export function isExternal(buildType: BuildType): boolean {
  return EXTERNAL_BUILD_TYPES.includes(buildType);
}

/** TorexBuilder's input for a context and settings (`systemPackages` text → names). */
export function detectInput(contextDir: string, settings: BuildSettings): BuildInput {
  return {
    contextDir,
    buildType: settings.buildType,
    dockerfilePath: settings.dockerfilePath,
    installCommand: settings.installCommand,
    buildCommand: settings.buildCommand,
    startCommand: settings.startCommand,
    outputDirectory: settings.outputDirectory,
    kind: settings.kind,
    systemPackages: splitPackages(settings.systemPackages),
    buildStage: settings.buildStage,
  };
}

/** Settings the chosen builder will ignore, worth telling the user before the build. */
export function settingsWarnings(settings: BuildSettings): string[] {
  const warnings: string[] = [];
  const { buildType } = settings;
  if (settings.buildStage !== null && buildType !== 'dockerfile') warnings.push('The build stage only applies to Dockerfile builds');
  if (settings.buildpackBuilder !== null && buildType !== 'heroku' && buildType !== 'paketo') warnings.push('The builder image only applies to buildpack builds');
  if (settings.systemPackages !== null && splitPackages(settings.systemPackages).length > 0 && buildType !== 'torex') warnings.push('System packages only apply to TorexBuilder builds');
  if (buildType === 'railpack' && settings.installCommand !== null) warnings.push('Railpack has no install command override; set it in railpack.json');
  if ((buildType === 'heroku' || buildType === 'paketo') && (settings.installCommand !== null || settings.buildCommand !== null)) {
    warnings.push('Buildpacks ignore the install and build commands; configure them through project.toml or the builder’s variables');
  }
  return warnings;
}

/** The label of an external builder before it has run (Railpack's gets richer afterwards). */
export function externalLabel(settings: ExternalSettings): string {
  if (settings.buildType === 'nixpacks') return NIXPACKS_LABEL;
  if (settings.buildType === 'railpack') return RAILPACK_LABEL;
  return buildpacksLabel(settings);
}

export interface RunBuildRequest {
  settings: BuildSettings;
  dockerHost: string;
  contextDir: string;
  /** Scratch directory outside the context for generated files, plans and CLI config. */
  scratchDir: string;
  imageTag: string;
  applicationId: string;
  deploymentId: string;
  buildEnv: Record<string, string>;
  registryAuths: CliAuths;
  noCache: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput: (line: string) => void;
  /** Called once the plan is known, before the image is built. */
  onPlan?: (plan: DeployPlan) => void;
}

export async function runBuild(request: RunBuildRequest): Promise<{ plan: DeployPlan; durationMs: number }> {
  const started = Date.now();
  const { settings } = request;
  const note = (warning: string): void => request.onOutput(`Note: ${warning}`);

  if (isExternal(settings.buildType)) {
    const warnings = settingsWarnings(settings);
    const provisional: ExternalPlan = { mode: 'external', stack: settings.buildType, label: externalLabel(settings), dockerfile: null, dockerfilePath: '', defaultPort: null, startCommand: settings.startCommand, warnings };
    request.onPlan?.(provisional);
    for (const warning of warnings) note(warning);
    const external: ExternalBuildRequest = { ...request, settings };
    let plan: ExternalPlan;
    if (settings.buildType === 'nixpacks') plan = await buildWithNixpacks(external);
    else if (settings.buildType === 'railpack') plan = await buildWithRailpack(external);
    else plan = await buildWithBuildpacks(external);
    return { plan: { ...plan, warnings: [...plan.warnings, ...warnings] }, durationMs: Date.now() - started };
  }

  const plan = await planBuild(detectInput(request.contextDir, settings));
  request.onPlan?.(plan);
  for (const warning of [...plan.warnings, ...settingsWarnings(settings)]) note(warning);
  await buildImage({
    dockerHost: request.dockerHost,
    plan,
    contextDir: request.contextDir,
    scratchDir: request.scratchDir,
    imageTag: request.imageTag,
    applicationId: request.applicationId,
    deploymentId: request.deploymentId,
    buildEnv: request.buildEnv,
    registryAuths: request.registryAuths,
    noCache: request.noCache,
    timeoutMs: request.timeoutMs,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    onOutput: request.onOutput,
    buildStage: settings.buildStage,
  });
  return { plan, durationMs: Date.now() - started };
}
