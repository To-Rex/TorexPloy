/**
 * Deno: `deno.json` tasks, dependencies vendored into the image's DENO_DIR
 * (a cache mount would leave the runtime without them), and the image's
 * own non-root `deno` user.
 */
import { join } from 'node:path';
import { cmd, firstExisting, generated, readJson, run, runtimePackages, toolVersions, type BuildPlan, type Ctx } from './shared.ts';

interface DenoConfig {
  tasks?: Record<string, string>;
  imports?: Record<string, string>;
}

export async function planDeno(ctx: Ctx): Promise<BuildPlan> {
  const { dir, input } = ctx;
  const config = (await readJson<DenoConfig>(join(dir, 'deno.json'))) ?? {};
  const version = /^\d+\.\d+\.\d+/.exec(ctx.runtime.deno ?? (await toolVersions(dir)).deno ?? '')?.[0] ?? 'latest';
  const entry = (await firstExisting(dir, ['main.ts', 'server.ts', 'mod.ts', 'src/main.ts', 'src/server.ts'], (file) => file)) ?? 'main.ts';
  const fresh = Object.values(config.imports ?? {}).some((specifier) => specifier.includes('fresh'));
  const start = input.startCommand ?? (input.kind === 'worker' ? ctx.procfile.worker : undefined) ?? ctx.procfile.web ?? (config.tasks?.start !== undefined ? 'deno task start' : `deno run --allow-net --allow-env --allow-read ${entry}`);
  const build = input.buildCommand ?? (config.tasks?.build !== undefined ? 'deno task build' : null);
  return generated(ctx, {
    stack: 'deno',
    label: `${fresh ? 'Fresh · ' : ''}Deno ${version}`,
    defaultPort: 8000,
    startCommand: start,
    lines: [
      `FROM denoland/deno:${version}`,
      ...runtimePackages(ctx, 'debian'),
      'WORKDIR /app',
      'COPY --chown=deno:deno . .',
      run(input.installCommand ?? `deno install --entrypoint ${entry} 2>/dev/null || deno cache ${entry}`),
      ...(build === null ? [] : [run(build)]),
      'RUN chown -R deno:deno /deno-dir /app',
      'ENV PORT=8000',
      'USER deno',
      'EXPOSE 8000',
      cmd(start),
    ],
  });
}
