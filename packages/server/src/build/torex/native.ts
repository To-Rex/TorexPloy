/**
 * Languages that compile to a single binary: Dart (and Flutter web as a
 * static site), Swift (Vapor), Crystal, Nim and Haskell. Each builds in the
 * language's image and ships only the binary in a minimal runtime.
 */
import { join } from 'node:path';
import { addUser, cmd, exists, existing, generated, listDir, readText, run, runtimePackages, staticRuntime, toolVersions, warn, type BuildPlan, type Ctx } from './shared.ts';

/** The common tail of a binary runtime stage: the binary at /app/server, a non-root user, the port. */
function binaryRuntime(ctx: Ctx, image: string, family: 'debian' | 'alpine', packages: string[], binary: string, port: number, start: string): string[] {
  return [
    `FROM ${image}`,
    ...runtimePackages(ctx, family, packages),
    addUser(family),
    'WORKDIR /app',
    `COPY --from=build --chown=app:app ${binary} /app/server`,
    `ENV PORT=${port}`,
    'USER app',
    `EXPOSE ${port}`,
    cmd(start),
  ];
}

export async function planDart(ctx: Ctx): Promise<BuildPlan> {
  const { dir, input } = ctx;
  const pubspec = (await readText(join(dir, 'pubspec.yaml'))) ?? '';
  const name = /^name:\s*(\S+)/m.exec(pubspec)?.[1] ?? 'app';
  const manifests = await existing(dir, ['pubspec.yaml', 'pubspec.lock']);
  if (!manifests.includes('pubspec.lock')) warn(ctx, 'No pubspec.lock found; package versions are not reproducible. Commit pubspec.lock.');

  // A Flutter app can only be deployed here as a web build served statically.
  if (/^\s+flutter:\s*$/m.test(pubspec) || /^\s+sdk:\s*flutter\s*$/m.test(pubspec)) {
    return generated(ctx, {
      stack: 'static-flutter',
      label: `Flutter web · ${name} → static`,
      defaultPort: 8080,
      startCommand: null,
      lines: [
        'FROM ghcr.io/cirruslabs/flutter:stable AS build',
        'WORKDIR /app',
        'COPY . .',
        run(input.installCommand ?? 'flutter pub get', ['/root/.pub-cache']),
        run(input.buildCommand ?? 'flutter build web --release', ['/root/.pub-cache']),
        '',
        ...staticRuntime('build', `/app/${input.outputDirectory ?? 'build/web'}`, runtimePackages(ctx, 'alpine')),
      ],
    });
  }

  const sdk = /^\d+\.\d+/.exec(ctx.runtime.dart ?? (await toolVersions(dir)).dart ?? /sdk:\s*['"]?\^?(\d+\.\d+)/.exec(pubspec)?.[1] ?? '')?.[0];
  const entry = (await existing(dir, ['bin/server.dart', 'bin/main.dart', `bin/${name}.dart`]))[0] ?? (await listDir(join(dir, 'bin'))).filter((file) => file.endsWith('.dart')).map((file) => `bin/${file}`)[0] ?? 'bin/server.dart';
  const build = input.buildCommand ?? `dart compile exe ${entry} -o /out/server`;
  const start = input.startCommand ?? '/app/server';
  return generated(ctx, {
    stack: 'dart',
    label: `Dart ${sdk ?? 'stable'} · ${name}`,
    defaultPort: 8080,
    startCommand: start,
    lines: [
      `FROM dart:${sdk ?? 'stable'} AS build`,
      'WORKDIR /app',
      `COPY ${manifests.join(' ')} ./`,
      run(input.installCommand ?? 'dart pub get', ['/root/.pub-cache']),
      'COPY . .',
      run(`mkdir -p /out && ${build}`, ['/root/.pub-cache']),
      '',
      ...binaryRuntime(ctx, 'debian:bookworm-slim', 'debian', ['ca-certificates'], '/out/server', 8080, start),
    ],
  });
}

export async function planSwift(ctx: Ctx): Promise<BuildPlan> {
  const { dir, input } = ctx;
  const manifest = (await readText(join(dir, 'Package.swift'))) ?? '';
  const toolsVersion = /swift-tools-version:\s*(\d+\.\d+)/.exec(manifest)?.[1];
  const version = /^\d+\.\d+/.exec(ctx.runtime.swift ?? (await readText(join(dir, '.swift-version')))?.trim() ?? (await toolVersions(dir)).swift ?? '')?.[0] ?? (toolsVersion !== undefined && Number(toolsVersion) >= 6 ? toolsVersion : '6.0');
  const product = /\.executableTarget\(\s*name:\s*"([^"]+)"/.exec(manifest)?.[1] ?? /\.executable\(\s*name:\s*"([^"]+)"/.exec(manifest)?.[1] ?? 'App';
  const vapor = manifest.includes('vapor/vapor');
  if (!(await exists(join(dir, 'Package.resolved')))) warn(ctx, 'No Package.resolved found; package versions are not reproducible. Commit Package.resolved.');
  const build = input.buildCommand ?? `swift build -c release --product ${product} --static-swift-stdlib`;
  const start = input.startCommand ?? (vapor ? '/app/server serve --env production --hostname 0.0.0.0 --port $PORT' : '/app/server');
  return generated(ctx, {
    stack: 'swift',
    label: `${vapor ? 'Vapor · ' : ''}Swift ${version} · ${product}`,
    defaultPort: 8080,
    startCommand: start,
    lines: [
      `FROM swift:${version}-noble AS build`,
      'WORKDIR /src',
      `COPY ${(await existing(dir, ['Package.swift', 'Package.resolved'])).join(' ')} ./`,
      run(input.installCommand ?? 'swift package resolve', ['/root/.cache/org.swift.swiftpm']),
      'COPY . .',
      run(`${build} && mkdir -p /out && cp .build/release/${product} /out/server`, ['/root/.cache/org.swift.swiftpm']),
      '',
      ...binaryRuntime(ctx, `swift:${version}-noble-slim`, 'debian', ['ca-certificates', 'tzdata'], '/out/server', 8080, start),
    ],
  });
}

export async function planCrystal(ctx: Ctx): Promise<BuildPlan> {
  const { dir, input } = ctx;
  const shard = (await readText(join(dir, 'shard.yml'))) ?? '';
  const name = /^name:\s*(\S+)/m.exec(shard)?.[1] ?? 'app';
  const target = /^targets:\s*\n\s+(\w+):/m.exec(shard)?.[1] ?? name;
  const exact = /^\d+\.\d+\.\d+$/.exec(ctx.runtime.crystal ?? (await toolVersions(dir)).crystal ?? /^crystal:\s*['"]?(\d+\.\d+\.\d+)['"]?\s*$/m.exec(shard)?.[1] ?? '')?.[0];
  const framework = /^\s+kemal:/m.test(shard) ? 'Kemal' : /^\s+lucky:/m.test(shard) ? 'Lucky' : /^\s+amber:/m.test(shard) ? 'Amber' : null;
  if (!(await exists(join(dir, 'shard.lock')))) warn(ctx, 'No shard.lock found; shard versions are not reproducible. Commit shard.lock.');
  const build = input.buildCommand ?? `shards build ${target} --release --static --production`;
  const start = input.startCommand ?? '/app/server';
  return generated(ctx, {
    stack: 'crystal',
    label: `${framework === null ? '' : `${framework} · `}Crystal ${exact ?? 'latest'} · ${target}`,
    defaultPort: 8080,
    startCommand: start,
    lines: [
      `FROM crystallang/crystal:${exact ?? 'latest'}-alpine AS build`,
      'WORKDIR /src',
      `COPY ${(await existing(dir, ['shard.yml', 'shard.lock'])).join(' ')} ./`,
      run(input.installCommand ?? 'shards install --production', ['/root/.cache/shards']),
      'COPY . .',
      run(`${build} && mkdir -p /out && cp bin/${target} /out/server`, ['/root/.cache/shards', '/root/.cache/crystal']),
      '',
      ...binaryRuntime(ctx, 'alpine:3.21', 'alpine', ['ca-certificates', 'tzdata'], '/out/server', 8080, start),
    ],
  });
}

export async function planNim(ctx: Ctx, nimble: string): Promise<BuildPlan> {
  const { dir, input } = ctx;
  const text = (await readText(join(dir, nimble))) ?? '';
  const bin = /^\s*bin\s*=\s*@\[\s*"([^"]+)"/m.exec(text)?.[1] ?? nimble.replace(/\.nimble$/, '');
  const srcDir = /^\s*srcDir\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? '.';
  const build = input.buildCommand ?? `nim c -d:release --opt:speed -o:/out/server ${srcDir}/${bin}.nim`;
  const start = input.startCommand ?? '/app/server';
  return generated(ctx, {
    stack: 'nim',
    label: `Nim · ${bin}`,
    defaultPort: 8080,
    startCommand: start,
    lines: [
      'FROM nimlang/nim:alpine AS build',
      'WORKDIR /src',
      'COPY . .',
      run(input.installCommand ?? 'nimble install -d -y', ['/root/.nimble/pkgs2', '/root/.nimble/packages_official.json']),
      run(`mkdir -p /out && ${build}`, ['/root/.nimble/pkgs2', '/root/.cache/nim']),
      '',
      ...binaryRuntime(ctx, 'alpine:3.21', 'alpine', ['ca-certificates', 'pcre', 'openssl'], '/out/server', 8080, start),
    ],
  });
}

export async function planHaskell(ctx: Ctx): Promise<BuildPlan> {
  const { dir, input } = ctx;
  const stack = await exists(join(dir, 'stack.yaml'));
  const cabalFile = (await listDir(dir)).find((name) => name.endsWith('.cabal'));
  const cabal = cabalFile === undefined ? '' : ((await readText(join(dir, cabalFile))) ?? '');
  const packageYaml = (await readText(join(dir, 'package.yaml'))) ?? '';
  const executable = /^executable\s+(\S+)/m.exec(cabal)?.[1] ?? /^executables:\s*\n\s+([\w-]+):/m.exec(packageYaml)?.[1] ?? cabalFile?.replace(/\.cabal$/, '') ?? 'app';
  const ghc = /^\d+\.\d+/.exec(ctx.runtime.ghc ?? (await toolVersions(dir)).ghc ?? '')?.[0] ?? '9.6';
  if (stack) warn(ctx, 'Stack downloads the GHC its resolver names on the first build, which can take a while; later builds reuse the cached toolchain.');
  const build = input.buildCommand ?? (stack ? 'stack build --copy-bins --local-bin-path /out' : `cabal update && cabal install exe:${executable} --install-method=copy --installdir=/out --overwrite-policy=always`);
  const start = input.startCommand ?? '/app/server';
  return generated(ctx, {
    stack: 'haskell',
    label: `Haskell · ${stack ? 'Stack' : 'Cabal'} · GHC ${ghc}`,
    defaultPort: 8080,
    startCommand: start,
    lines: [
      `FROM haskell:${ghc} AS build`,
      'WORKDIR /src',
      'COPY . .',
      run(`mkdir -p /out && ${build} && mv /out/${executable} /out/server`, ['/root/.stack', '/root/.cabal', '/root/.cache/cabal', '/src/.stack-work', '/src/dist-newstyle']),
      '',
      ...binaryRuntime(ctx, 'debian:bookworm-slim', 'debian', ['ca-certificates', 'libgmp10'], '/out/server', 8080, start),
    ],
  });
}
