/**
 * Railpack (Railway's current builder) as an external builder.
 *
 * Railpack separates planning from building: `railpack prepare` analyses the
 * source and writes a build plan plus an info file, then BuildKit builds the
 * plan through Railpack's own frontend image — the way Railway runs it in
 * production (https://railpack.com/platforms/running-railpack-in-production).
 * The frontend tag follows the version of the CLI that wrote the plan, which
 * the info file reports.
 *
 * Variables are passed by name only. `prepare --env NAME` lets Railpack read
 * its `RAILPACK_*` configuration and lists the name in the plan's secrets;
 * the build then mounts each one as a BuildKit secret from the environment,
 * so values reach neither a command line nor an image layer. `secrets-hash`
 * keys the layer cache on the values and `cache-key` on the application.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareCliConfig } from '../docker/cli.ts';
import { AppError } from '../lib/errors.ts';
import { childEnv, envNames, imageLabels, runBuilder, type ExternalBuildRequest, type ExternalPlan, type ExternalSettings } from './common.ts';

export const RAILPACK_LABEL = 'Railpack';

/** The BuildKit frontend that builds Railpack plans; its tags are the CLI versions (`v0.40.1`). */
export const RAILPACK_FRONTEND = 'ghcr.io/railwayapp/railpack-frontend';

export function frontendImage(version: string): string {
  return `${RAILPACK_FRONTEND}:v${version}`;
}

/** `railpack prepare --info-out`: what was detected (the fields the platform reads). */
export interface RailpackInfo {
  railpackVersion?: string;
  success?: boolean;
  detectedProviders?: string[];
  resolvedPackages?: Record<string, { name?: string; requestedVersion?: string; resolvedVersion?: string; source?: string }>;
  metadata?: Record<string, string>;
  logs?: { Level?: string; Msg?: string; DocsPath?: string }[];
}

/** "Railpack · node 22.23.2" from the info file. */
export function railpackLabel(info: RailpackInfo): string {
  const packages = Object.values(info.resolvedPackages ?? {})
    .map((pkg) => [pkg.name, pkg.resolvedVersion].filter((part) => part !== undefined && part.length > 0).join(' '))
    .filter((part) => part.length > 0);
  const detail = packages.length > 0 ? packages : (info.detectedProviders ?? []);
  return [RAILPACK_LABEL, ...detail].join(' · ');
}

/** Railpack's warnings, errors and suggestions, one line each. */
export function railpackWarnings(info: RailpackInfo): string[] {
  return (info.logs ?? [])
    .filter((entry) => entry.Level === 'warn' || entry.Level === 'error' || entry.Level === 'suggestion')
    .map((entry) => (entry.Msg ?? '').split('\n')[0]!.trim())
    .filter((line) => line.length > 0);
}

/** sha256 over the sorted `NAME=value` pairs: a different value is a different cache key. */
export function secretsHash(env: Record<string, string>, names: string[]): string {
  const hash = createHash('sha256');
  for (const name of [...names].sort()) hash.update(`${name}=${env[name] ?? ''}\n`);
  return hash.digest('hex');
}

export interface PrepareRequest {
  contextDir: string;
  scratchDir: string;
  settings: ExternalSettings;
  buildEnv: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput: (line: string) => void;
}

/** Run `railpack prepare`; returns the plan's path and the parsed info, or throws when Railpack could not plan. */
export async function prepareRailpack(request: PrepareRequest): Promise<{ planPath: string; info: RailpackInfo }> {
  await mkdir(request.scratchDir, { recursive: true, mode: 0o700 });
  const planPath = join(request.scratchDir, 'railpack-plan.json');
  const infoPath = join(request.scratchDir, 'railpack-info.json');
  const names = envNames(request.buildEnv);
  const args = ['prepare', request.contextDir, '--plan-out', planPath, '--info-out', infoPath];
  if (request.settings.buildCommand !== null) args.push('--build-cmd', request.settings.buildCommand);
  if (request.settings.startCommand !== null) args.push('--start-cmd', request.settings.startCommand);
  for (const name of names) args.push('--env', name);

  const env: Record<string, string> = { NO_COLOR: '1' };
  for (const name of names) env[name] = request.buildEnv[name] ?? '';
  await runBuilder('railpack', {
    tool: 'railpack prepare',
    args,
    env,
    timeoutMs: request.timeoutMs,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    onOutput: request.onOutput,
  });

  let info: RailpackInfo;
  try {
    info = JSON.parse(await readFile(infoPath, 'utf8')) as RailpackInfo;
  } catch {
    throw new AppError('bad_request', 'railpack prepare did not write its info file', { params: { reason: 'build_failed' } });
  }
  // A failed detection still exits 0; the info file says so.
  if (info.success !== true) {
    const message = (info.logs ?? []).find((entry) => entry.Level === 'error')?.Msg?.split('\n')[0]?.trim();
    throw new AppError('bad_request', message || 'Railpack could not determine how to build this repository', { params: { reason: 'build_failed' } });
  }
  return { planPath, info };
}

export async function buildWithRailpack(request: ExternalBuildRequest): Promise<ExternalPlan> {
  if (request.settings.installCommand !== null) request.onOutput('Note: Railpack has no install command override; the install command is ignored (configure it in railpack.json)');
  const { planPath, info } = await prepareRailpack(request);
  const version = info.railpackVersion;
  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new AppError('bad_request', 'railpack prepare did not report its version', { params: { reason: 'build_failed' } });
  }
  const label = railpackLabel(info);
  const warnings = railpackWarnings(info);
  request.onOutput(`Railpack plan: ${label} · frontend ${frontendImage(version)}`);

  const names = envNames(request.buildEnv);
  const env = childEnv(request, names);
  const args = ['buildx', 'build', '--progress=plain', '--load', '--tag', request.imageTag, '--file', planPath];
  args.push('--build-arg', `BUILDKIT_SYNTAX=${frontendImage(version)}`);
  args.push('--build-arg', `cache-key=${request.applicationId}`);
  args.push('--build-arg', `secrets-hash=${secretsHash(request.buildEnv, names)}`);
  for (const label of imageLabels(request)) args.push('--label', label);
  for (const name of names) args.push('--secret', `id=${name},env=${name}`);
  if (request.noCache) args.push('--no-cache');
  args.push(request.contextDir);

  await prepareCliConfig(env.DOCKER_CONFIG!, request.registryAuths);
  try {
    await runBuilder('docker', {
      tool: 'docker buildx build',
      args,
      env,
      timeoutMs: request.timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      onOutput: request.onOutput,
    });
  } finally {
    await rm(env.DOCKER_CONFIG!, { recursive: true, force: true });
  }
  return { mode: 'external', stack: 'railpack', label, dockerfile: null, dockerfilePath: '', defaultPort: null, startCommand: request.settings.startCommand, warnings };
}
