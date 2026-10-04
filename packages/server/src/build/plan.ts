/**
 * `POST /api/applications/:id/build-plan`: what a build of the branch head
 * would do, without building anything.
 *
 * The source is checked out exactly as a deployment checks it out (same
 * credentials, same shallow clone), the chosen builder plans it — TorexBuilder
 * in process, Nixpacks and Railpack through their own planning commands,
 * buildpacks by name only, since `pack` cannot plan without building — and
 * the checkout is removed. One plan per application at a time.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuildPlanDto } from '@ploy/shared';
import type { Context } from '../context.ts';
import { resolveAppEnv } from '../deploy/env.ts';
import { AppError } from '../lib/errors.ts';
import type { ApplicationRecord } from '../store/index.ts';
import { buildpacksLabel } from './buildpacks.ts';
import { planBuild } from './detect.ts';
import { buildWorkDir, checkout, cloneUrl, removeWorkDir } from './git.ts';
import { detectInput, isExternal, settingsOf, settingsWarnings } from './index.ts';
import { planWithNixpacks } from './nixpacks.ts';
import { prepareRailpack, railpackLabel, railpackWarnings } from './railpack.ts';
import { requireBuilder } from './tools.ts';

const CHECKOUT_TIMEOUT_MS = 3 * 60_000;
const PLAN_TIMEOUT_MS = 60_000;

/** Applications whose plan is being prepared right now. */
const inFlight = new Set<string>();

/** Whether a Dockerfile declares a stage named `stage` (`FROM … AS stage`). */
export function hasStage(dockerfile: string, stage: string): boolean {
  return dockerfile.split('\n').some((line) => {
    const match = /^\s*FROM\s+(?:--\S+\s+)*\S+\s+AS\s+(\S+)/i.exec(line);
    return match !== null && match[1]!.toLowerCase() === stage.toLowerCase();
  });
}

export async function previewBuildPlan(ctx: Context, app: ApplicationRecord): Promise<BuildPlanDto> {
  if (app.kind === 'compose' || app.sourceType === 'image' || app.sourceType === 'raw') {
    throw new AppError('validation_failed', 'Only applications built from a repository have a build plan', {
      issues: [{ path: 'source', code: 'custom', message: 'Not built from source', params: { reason: 'not_built' } }],
    });
  }
  requireBuilder(app.buildType);
  if (inFlight.has(app.id)) throw new AppError('conflict', 'A build plan for this application is already being prepared', { params: { reason: 'plan_in_progress' } });
  inFlight.add(app.id);

  const workDir = buildWorkDir(ctx.config.dataDir, `plan-${app.id}`);
  const scratchDir = `${workDir}.ploy`;
  try {
    const url = cloneUrl(app);
    const githubToken = app.sourceType === 'github' && app.githubInstallationId !== null ? await ctx.github.installationToken(app.githubInstallationId) : null;
    await mkdir(workDir, { recursive: true });
    const commit = await checkout({
      url,
      branch: app.branch ?? 'main',
      workDir,
      githubToken,
      deployKey: app.deployKey === null ? null : ctx.secrets.open(app.deployKey, 'ssh'),
      timeoutMs: CHECKOUT_TIMEOUT_MS,
      onOutput: () => undefined,
    });
    const contextDir = app.rootDirectory.length > 0 ? join(workDir, app.rootDirectory) : workDir;
    const settings = settingsOf(app);
    const warnings = settingsWarnings(settings);
    const base = { builder: app.buildType, commit: { sha: commit.sha, message: commit.message } };

    if (!isExternal(app.buildType)) {
      const plan = await planBuild(detectInput(contextDir, settings));
      const dockerfile = plan.dockerfile ?? (await readFile(join(contextDir, plan.dockerfilePath), 'utf8').catch(() => null));
      if (plan.mode === 'dockerfile' && settings.buildStage !== null && dockerfile !== null && !hasStage(dockerfile, settings.buildStage)) {
        warnings.push(`Stage "${settings.buildStage}" was not found in ${plan.dockerfilePath}`);
      }
      return { ...base, mode: plan.mode, stack: plan.stack, label: plan.label, dockerfile, warnings: [...plan.warnings, ...warnings] };
    }

    // The builders' own detection reads their configuration variables (NIXPACKS_*, RAILPACK_*).
    const buildEnv = resolveAppEnv(ctx.stores, app).env;
    if (app.buildType === 'nixpacks') {
      const planned = await planWithNixpacks({ contextDir, settings, buildEnv, timeoutMs: PLAN_TIMEOUT_MS });
      return { ...base, mode: 'external', stack: 'nixpacks', label: planned.label, dockerfile: null, warnings: [...planned.warnings, ...warnings] };
    }
    if (app.buildType === 'railpack') {
      const { info } = await prepareRailpack({ contextDir, scratchDir, settings, buildEnv, timeoutMs: PLAN_TIMEOUT_MS, onOutput: () => undefined });
      return { ...base, mode: 'external', stack: 'railpack', label: railpackLabel(info), dockerfile: null, warnings: [...railpackWarnings(info), ...warnings] };
    }
    return { ...base, mode: 'external', stack: app.buildType, label: buildpacksLabel(settings), dockerfile: null, warnings };
  } finally {
    inFlight.delete(app.id);
    await removeWorkDir(workDir);
    await removeWorkDir(scratchDir);
  }
}
