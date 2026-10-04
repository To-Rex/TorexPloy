/**
 * Go: the version from go.mod (`go` and `toolchain` directives), a module
 * download layer cached ahead of the sources, a static binary, and an
 * Alpine runtime with no toolchain.
 */
import { join } from 'node:path';
import { addUser, cmd, exists, existing, generated, listDirs, newest, readText, run, runtimePackages, toolVersions, warn, type BuildPlan, type Ctx } from './shared.ts';

const DEFAULT_GO = '1.24';
const GO_CACHES = ['/go/pkg/mod', '/root/.cache/go-build'];

export async function planGo(ctx: Ctx): Promise<BuildPlan> {
  const { dir, input } = ctx;
  const gomod = (await readText(join(dir, 'go.mod'))) ?? '';
  const tools = await toolVersions(dir);
  const pinned = /^\d+\.\d+/.exec(ctx.runtime.go ?? tools.golang ?? tools.go ?? '')?.[0];
  const version = pinned ?? newest(/^go\s+(1\.\d+)/m.exec(gomod)?.[1], /^toolchain\s+go(1\.\d+)/m.exec(gomod)?.[1]) ?? DEFAULT_GO;

  // `main.go` at the root, else the server-looking command under cmd/.
  let target = '.';
  if (!(await exists(join(dir, 'main.go'))) && (await exists(join(dir, 'cmd')))) {
    const commands = await listDirs(join(dir, 'cmd'));
    if (commands.length >= 1) target = `./cmd/${commands.find((name) => ['server', 'api', 'web', 'app'].includes(name)) ?? commands[0]!}`;
    if (commands.length > 1) warn(ctx, `Several commands under cmd/ (${commands.join(', ')}); building ${target}. Set a build command to choose another.`);
  }
  const vendored = await exists(join(dir, 'vendor'));
  const manifests = await existing(dir, ['go.mod', 'go.sum', 'go.work', 'go.work.sum']);
  if (!manifests.includes('go.sum') && !vendored) warn(ctx, 'No go.sum found; dependency versions are not verified. Run "go mod tidy" and commit go.sum.');

  const build = input.buildCommand ?? `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ${target}`;
  const start = input.startCommand ?? '/app/server';
  return generated(ctx, {
    stack: 'go',
    label: `Go ${version}`,
    defaultPort: 8080,
    startCommand: start,
    lines: [
      `FROM golang:${version}-alpine AS build`,
      'ENV GOTOOLCHAIN=auto',
      'WORKDIR /src',
      // Modules are downloaded from go.mod/go.sum alone, so the layer survives source changes.
      ...(vendored || input.buildCommand !== null ? [] : [`COPY ${manifests.join(' ')} ./`, run('go mod download', GO_CACHES)]),
      'COPY . .',
      run(`mkdir -p /out && ${build}`, GO_CACHES),
      '',
      'FROM alpine:3.21',
      ...runtimePackages(ctx, 'alpine', ['ca-certificates', 'tzdata']),
      addUser('alpine'),
      'WORKDIR /app',
      // Templates, static files and migrations are commonly read relative to the working directory.
      'COPY --from=build --chown=app:app /src /app',
      'COPY --from=build --chown=app:app /out/server /app/server',
      'ENV PORT=8080',
      'USER app',
      'EXPOSE 8080',
      cmd(start),
    ],
  });
}
