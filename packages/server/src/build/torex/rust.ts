/**
 * Rust: the toolchain channel from rust-toolchain(.toml), the binary of the
 * package (or of the server-looking workspace member), cargo registry and
 * target cache mounts, and a Debian slim runtime.
 */
import { join } from 'node:path';
import { addUser, cmd, exists, generated, listDirs, readText, run, runtimePackages, toolVersions, warn, type BuildPlan, type Ctx } from './shared.ts';

const CARGO_CACHES = ['/usr/local/cargo/registry', '/usr/local/cargo/git', '/src/target'];

/** `rust:1.82-slim-bookworm` for a pinned channel, the nightly image for nightly, else the current stable. */
async function rustImage(ctx: Ctx): Promise<{ image: string; channel: string }> {
  const dir = ctx.dir;
  const toolchain = (await readText(join(dir, 'rust-toolchain.toml'))) ?? (await readText(join(dir, 'rust-toolchain'))) ?? '';
  const channel = ctx.runtime.rust ?? /channel\s*=\s*"([^"]+)"/.exec(toolchain)?.[1] ?? (toolchain.includes('[') ? null : toolchain.trim() || null) ?? (await toolVersions(dir)).rust ?? 'stable';
  const pinned = /^(\d+\.\d+)/.exec(channel)?.[1];
  if (pinned !== undefined) return { image: `rust:${pinned}-slim-bookworm`, channel: pinned };
  if (channel.startsWith('nightly')) return { image: 'rustlang/rust:nightly-slim', channel: 'nightly' };
  return { image: 'rust:1-slim-bookworm', channel: 'stable' };
}

/** The package to build: the root package, else the first workspace member with a binary (server-like names first). */
async function binaryPackage(dir: string, cargo: string): Promise<{ name: string; flag: string }> {
  const bin = (toml: string): string | undefined => /\[\[bin\]\][^[]*?name\s*=\s*"([^"]+)"/s.exec(toml)?.[1] ?? /\[package\][^[]*?name\s*=\s*"([^"]+)"/s.exec(toml)?.[1];
  const root = bin(cargo);
  if (root !== undefined) return { name: root, flag: '' };
  const members: string[] = [];
  for (const glob of [...(/members\s*=\s*\[([^\]]*)\]/s.exec(cargo)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1]!)) {
    if (glob.endsWith('/*')) members.push(...(await listDirs(join(dir, glob.slice(0, -2)))).map((name) => `${glob.slice(0, -2)}/${name}`));
    else members.push(glob);
  }
  const binaries: string[] = [];
  for (const member of members) {
    const toml = (await readText(join(dir, member, 'Cargo.toml'))) ?? '';
    const name = bin(toml);
    if (name !== undefined && ((await exists(join(dir, member, 'src', 'main.rs'))) || toml.includes('[[bin]]'))) binaries.push(name);
  }
  const name = binaries.find((candidate) => /server|api|web|app/.test(candidate)) ?? binaries[0] ?? 'app';
  return { name, flag: ` -p ${name}` };
}

export async function planRust(ctx: Ctx): Promise<BuildPlan> {
  const { dir, input } = ctx;
  const cargo = (await readText(join(dir, 'Cargo.toml'))) ?? '';
  const { image, channel } = await rustImage(ctx);
  const { name, flag } = await binaryPackage(dir, cargo);
  const locked = await exists(join(dir, 'Cargo.lock'));
  if (!locked) warn(ctx, 'No Cargo.lock found; dependency versions are not reproducible. Commit Cargo.lock.');
  const build = input.buildCommand ?? `cargo build --release${locked ? ' --locked' : ''}${flag}`;
  const start = input.startCommand ?? '/app/server';
  return generated(ctx, {
    stack: 'rust',
    label: `Rust ${channel} · ${name}`,
    defaultPort: 8080,
    startCommand: start,
    lines: [
      `FROM ${image} AS build`,
      'RUN apt-get update -qq && apt-get install -y --no-install-recommends pkg-config libssl-dev >/dev/null && rm -rf /var/lib/apt/lists/*',
      'WORKDIR /src',
      'COPY . .',
      // The target dir is a cache mount, so the binary must be copied out within the same step.
      run(`${build} && mkdir -p /out && cp target/release/${name} /out/server`, CARGO_CACHES),
      '',
      'FROM debian:bookworm-slim',
      ...runtimePackages(ctx, 'debian', ['ca-certificates', 'libssl3']),
      addUser('debian'),
      'WORKDIR /app',
      'COPY --from=build --chown=app:app /out/server /app/server',
      'ENV PORT=8080',
      'USER app',
      'EXPOSE 8080',
      cmd(start),
    ],
  });
}
