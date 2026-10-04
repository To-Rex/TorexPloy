/**
 * BEAM languages: Elixir (Phoenix) as a `mix release`, and Gleam as an
 * Erlang shipment. Both build in the language image and run in a minimal
 * image with just the Erlang runtime's system libraries.
 */
import { join } from 'node:path';
import { addUser, cmd, exists, existing, generated, readText, run, runtimePackages, toolVersions, versionLine, warn, type BuildPlan, type Ctx } from './shared.ts';

const DEFAULT_ELIXIR = '1.17';
const DEFAULT_GLEAM = '1.6.1';
const HEX_CACHES = ['/root/.hex', '/root/.mix', '/root/.cache'];

/** OTP major an Elixir minor is released against, when nothing pins it. */
function otpFor(elixir: string): number {
  const minor = Number(elixir.split('.')[1]);
  return minor >= 19 ? 28 : minor >= 17 ? 27 : 26;
}

export async function planElixir(ctx: Ctx): Promise<BuildPlan> {
  const { dir, input } = ctx;
  const mix = (await readText(join(dir, 'mix.exs'))) ?? '';
  const tools = await toolVersions(dir);
  const pinned = ctx.runtime.elixir ?? tools.elixir ?? versionLine(await readText(join(dir, '.elixir-version'))) ?? '';
  const requirement = /elixir:\s*"~>\s*(\d+\.\d+)/.exec(mix)?.[1];
  const elixir = /^\d+\.\d+/.exec(pinned)?.[0] ?? (requirement !== undefined && Number(requirement.split('.')[1]) > Number(DEFAULT_ELIXIR.split('.')[1]) ? requirement : DEFAULT_ELIXIR);
  const otp = /^\d+/.exec(ctx.runtime.erlang ?? tools.erlang ?? /-otp-(\d+)/.exec(pinned)?.[1] ?? '')?.[0] ?? String(otpFor(elixir));
  const app = /\bapp:\s*:(\w+)/.exec(mix)?.[1] ?? 'app';
  const release = /\breleases:\s*\[\s*(\w+):/.exec(mix)?.[1] ?? app;
  const phoenix = /\{:phoenix\b/.test(mix);
  const assetsDeploy = /"assets\.deploy"/.test(mix);
  if (!(await exists(join(dir, 'mix.lock')))) warn(ctx, 'No mix.lock found; dependency versions are not reproducible. Commit mix.lock.');

  const build = input.buildCommand ?? `mix compile${assetsDeploy ? ' && mix assets.deploy' : ''} && mix release ${release} --overwrite`;
  const start = input.startCommand ?? (input.kind === 'worker' ? ctx.procfile.worker : undefined) ?? ctx.procfile.web ?? `/app/bin/${release} start`;
  const manifests = await existing(dir, ['mix.exs', 'mix.lock']);
  return generated(ctx, {
    stack: 'elixir',
    label: `${phoenix ? 'Phoenix' : 'Elixir'} · Elixir ${elixir} · OTP ${otp}`,
    defaultPort: 4000,
    startCommand: start,
    lines: [
      `FROM elixir:${elixir}-otp-${otp}-slim AS build`,
      'RUN apt-get update -qq && apt-get install -y --no-install-recommends build-essential git ca-certificates >/dev/null && rm -rf /var/lib/apt/lists/*',
      'WORKDIR /app',
      'ENV MIX_ENV=prod LANG=C.UTF-8',
      'RUN mix local.hex --force && mix local.rebar --force',
      // Dependencies compile from mix.exs/mix.lock and config alone; the layer survives source changes.
      ...(input.installCommand === null ? [`COPY ${manifests.join(' ')} ./`, ...((await exists(join(dir, 'config'))) ? ['COPY config config'] : []), run('mix deps.get --only prod && mix deps.compile', HEX_CACHES), 'COPY . .'] : ['COPY . .', run(input.installCommand, HEX_CACHES)]),
      run(build, HEX_CACHES),
      '',
      'FROM debian:bookworm-slim',
      ...runtimePackages(ctx, 'debian', ['libstdc++6', 'openssl', 'libncurses6', 'ca-certificates']),
      addUser('debian'),
      'WORKDIR /app',
      'ENV MIX_ENV=prod PHX_SERVER=true LANG=C.UTF-8 LC_ALL=C.UTF-8 PORT=4000',
      `COPY --from=build --chown=app:app /app/_build/prod/rel/${release} /app`,
      'USER app',
      'EXPOSE 4000',
      cmd(start),
    ],
  });
}

export async function planGleam(ctx: Ctx): Promise<BuildPlan> {
  const { dir, input } = ctx;
  const toml = (await readText(join(dir, 'gleam.toml'))) ?? '';
  const name = /^name\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? 'app';
  // Images exist per release only, so a `gleam = ">= 1.6.0"` lower bound (or a pin) picks the tag.
  const version = /^\d+\.\d+\.\d+/.exec(ctx.runtime.gleam ?? (await toolVersions(dir)).gleam ?? /^gleam\s*=\s*"[^"\d]*(\d+\.\d+\.\d+)/m.exec(toml)?.[1] ?? '')?.[0] ?? DEFAULT_GLEAM;
  const otp = /^\d+/.exec(ctx.runtime.erlang ?? (await toolVersions(dir)).erlang ?? '')?.[0] ?? '27';
  if (!(await exists(join(dir, 'manifest.toml')))) warn(ctx, 'No manifest.toml found; dependency versions are not reproducible. Commit manifest.toml.');
  const start = input.startCommand ?? '/app/entrypoint.sh run';
  return generated(ctx, {
    stack: 'gleam',
    label: `Gleam ${version} · ${name} · OTP ${otp}`,
    defaultPort: 8000,
    startCommand: start,
    lines: [
      `FROM ghcr.io/gleam-lang/gleam:v${version}-erlang-alpine AS build`,
      'WORKDIR /app',
      `COPY ${(await existing(dir, ['gleam.toml', 'manifest.toml'])).join(' ')} ./`,
      run(input.installCommand ?? 'gleam deps download', ['/root/.cache']),
      'COPY . .',
      run(input.buildCommand ?? 'gleam export erlang-shipment', ['/root/.cache']),
      '',
      `FROM erlang:${otp}-alpine`,
      ...runtimePackages(ctx, 'alpine', ['ca-certificates']),
      addUser('alpine'),
      'WORKDIR /app',
      'COPY --from=build --chown=app:app /app/build/erlang-shipment /app',
      'ENV PORT=8000',
      'USER app',
      'EXPOSE 8000',
      cmd(start),
    ],
  });
}
