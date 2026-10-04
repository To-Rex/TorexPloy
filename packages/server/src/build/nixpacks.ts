/**
 * Nixpacks (Railway's first builder) as an external builder.
 *
 * `nixpacks build` detects the stack, writes a Dockerfile to a temporary
 * directory of its own and runs `docker build` itself, so it inherits the
 * deployment's `DOCKER_HOST` and `DOCKER_CONFIG`. It reads `nixpacks.toml`
 * in the repository natively; the panel's install, build and start commands
 * are passed as CLI overrides when set. Variables go as `--env NAME`, read
 * from the child's environment — Nixpacks then writes them into the image as
 * `ENV`, which is how it works by design and worth knowing for secrets.
 */
import { rm } from 'node:fs/promises';
import { prepareCliConfig } from '../docker/cli.ts';
import { AppError } from '../lib/errors.ts';
import { childEnv, envNames, imageLabels, runBuilder, type ExternalBuildRequest, type ExternalPlan, type ExternalSettings } from './common.ts';

export const NIXPACKS_LABEL = 'Nixpacks';

/** `nixpacks plan --format json`: the parts the platform reads. */
export interface NixpacksPlan {
  providers?: string[];
  variables?: Record<string, string>;
  phases?: Record<string, { nixPkgs?: string[]; aptPkgs?: string[]; cmds?: string[] }>;
  start?: { cmd?: string };
}

/** The `--install-cmd`/`--build-cmd`/`--start-cmd` overrides for the commands the user filled in. */
function commandArgs(settings: ExternalSettings): string[] {
  const args: string[] = [];
  if (settings.installCommand !== null) args.push('--install-cmd', settings.installCommand);
  if (settings.buildCommand !== null) args.push('--build-cmd', settings.buildCommand);
  if (settings.startCommand !== null) args.push('--start-cmd', settings.startCommand);
  return args;
}

/** "Nixpacks · node · nodejs_22, npm-9_x" from a plan. */
export function nixpacksLabel(plan: NixpacksPlan): string {
  const providers = plan.providers?.length ? plan.providers : plan.variables?.NIXPACKS_METADATA?.split(',').map((name) => name.trim()).filter(Boolean) ?? [];
  const packages = plan.phases?.setup?.nixPkgs ?? [];
  return [NIXPACKS_LABEL, providers.join(', '), packages.join(', ')].filter((part) => part.length > 0).join(' · ');
}

export async function buildWithNixpacks(request: ExternalBuildRequest): Promise<ExternalPlan> {
  const names = envNames(request.buildEnv);
  const args = ['build', request.contextDir, '--name', request.imageTag, ...commandArgs(request.settings)];
  for (const label of imageLabels(request)) args.push('--label', label);
  for (const name of names) args.push('--env', name);
  if (request.noCache) args.push('--no-cache');

  request.onOutput('Nixpacks reads nixpacks.toml in the repository; commands set in the panel override it. Build variables become ENV in the image.');
  // Nixpacks runs the docker CLI itself: the deployment's config gives it the registry logins and the buildx plugin.
  const env = childEnv(request, names);
  await prepareCliConfig(env.DOCKER_CONFIG!, request.registryAuths);
  try {
    await runBuilder('nixpacks', {
      tool: 'nixpacks build',
      args,
      env,
      timeoutMs: request.timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      onOutput: request.onOutput,
    });
  } finally {
    await rm(env.DOCKER_CONFIG!, { recursive: true, force: true });
  }
  return { mode: 'external', stack: 'nixpacks', label: NIXPACKS_LABEL, dockerfile: null, dockerfilePath: '', defaultPort: null, startCommand: request.settings.startCommand, warnings: [] };
}

export interface NixpacksPlanRequest {
  contextDir: string;
  settings: ExternalSettings;
  buildEnv: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** What `nixpacks build` would do, from `nixpacks plan` (no Docker involved). */
export async function planWithNixpacks(request: NixpacksPlanRequest): Promise<{ plan: NixpacksPlan; label: string; warnings: string[] }> {
  const names = envNames(request.buildEnv);
  const args = ['plan', request.contextDir, '--format', 'json', ...commandArgs(request.settings)];
  for (const name of names) args.push('--env', name);
  const env: Record<string, string> = { NO_COLOR: '1' };
  for (const name of names) env[name] = request.buildEnv[name] ?? '';
  const result = await runBuilder('nixpacks', {
    tool: 'nixpacks plan',
    args,
    env,
    timeoutMs: request.timeoutMs,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    onOutput: () => undefined,
    maxBuffer: 1024 * 1024,
  });
  let plan: NixpacksPlan;
  try {
    plan = JSON.parse(result.stdout) as NixpacksPlan;
  } catch {
    throw new AppError('bad_request', 'nixpacks plan did not return a build plan', { params: { reason: 'build_failed' } });
  }
  if (Object.keys(plan.phases ?? {}).length === 0) {
    throw new AppError('bad_request', 'Nixpacks could not detect how to build this repository', { params: { reason: 'build_failed' } });
  }
  // Providers report recoverable problems on stderr.
  const warnings = result.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (!plan.start?.cmd) warnings.push('No start command was detected; set one in the build settings or add a Procfile');
  return { plan, label: nixpacksLabel(plan), warnings };
}
