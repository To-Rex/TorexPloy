/**
 * Plain static sites: the context (or the output directory) served by Caddy.
 */
import { generated, runtimePackages, staticRuntime, type BuildPlan, type Ctx } from './shared.ts';

export function planStatic(ctx: Ctx): BuildPlan {
  const source = ctx.input.outputDirectory === null || ctx.input.outputDirectory === '' ? '.' : ctx.input.outputDirectory;
  return generated(ctx, {
    stack: 'static',
    label: 'Static site · Caddy',
    defaultPort: 8080,
    startCommand: null,
    lines: staticRuntime(null, source, runtimePackages(ctx, 'alpine')),
  });
}
