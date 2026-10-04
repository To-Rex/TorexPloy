/**
 * Ruby: the version from .ruby-version / the Gemfile pin, gems installed in
 * a build stage with compilers (plus Node when a package.json drives
 * jsbundling/cssbundling), Rails assets precompiled and bootsnap warmed,
 * then a slim runtime with only the runtime libraries.
 */
import { join } from 'node:path';
import { AppError } from '../../lib/errors.ts';
import { addUser, cmd, exists, existing, generated, readJson, readText, run, runtimePackages, toolVersions, versionLine, warn, type BuildPlan, type Ctx } from './shared.ts';
import { assetBuild, nodeToolchain, type PackageJson } from './node.ts';

const DEFAULT_RUBY = '3.4';

export async function planRuby(ctx: Ctx): Promise<BuildPlan> {
  const { dir, input, procfile } = ctx;
  const gemfile = (await readText(join(dir, 'Gemfile'))) ?? '';
  const lock = (await readText(join(dir, 'Gemfile.lock'))) ?? '';
  // An exact `ruby "3.4.1"` in the Gemfile must match the image; a range (`>= 3.2`) accepts the default.
  const pinned = /^\s*ruby\s+['"](\d+\.\d+)(?:\.\d+)?['"]/m.exec(gemfile)?.[1];
  const version = /(\d+\.\d+)/.exec(ctx.runtime.ruby ?? versionLine(await readText(join(dir, '.ruby-version'))) ?? (await toolVersions(dir)).ruby ?? '')?.[1] ?? pinned ?? DEFAULT_RUBY;
  const isRails = await exists(join(dir, 'config', 'application.rb'));
  const gems = `${gemfile}\n${lock}`;
  const bootsnap = /\bbootsnap\b/.test(gems);
  const mysql = /\bmysql2\b|\btrilogy\b/.test(gems);
  const hasLock = lock.length > 0;
  if (!hasLock) warn(ctx, 'No Gemfile.lock found; gem versions are not reproducible. Run "bundle install" locally and commit Gemfile.lock.');
  const assets = await assetBuild(ctx, (await readJson<PackageJson>(join(dir, 'package.json'))) ?? {});
  const precompile = isRails && ((await exists(join(dir, 'app', 'assets'))) || (await exists(join(dir, 'config', 'initializers', 'assets.rb'))));

  const start =
    input.startCommand ??
    (input.kind === 'worker' ? procfile.worker : undefined) ??
    procfile.web ??
    (isRails ? 'bundle exec rails server -b 0.0.0.0 -p $PORT' : (await exists(join(dir, 'config.ru'))) ? 'bundle exec rackup -o 0.0.0.0 -p $PORT' : null);
  if (start === null) throw new AppError('bad_request', 'Could not determine how to start the app: add a Procfile or set a start command', { params: { reason: 'no_start' } });
  const bundleEnv = `BUNDLE_WITHOUT=development:test${hasLock ? ' BUNDLE_DEPLOYMENT=1' : ''} RAILS_ENV=production RACK_ENV=production`;
  const manifests = await existing(dir, ['Gemfile', 'Gemfile.lock', '.ruby-version']);
  return generated(ctx, {
    stack: 'ruby',
    label: `${isRails ? 'Rails' : 'Ruby'} · Ruby ${version}`,
    defaultPort: 3000,
    startCommand: start,
    lines: [
      `FROM ruby:${version}-slim AS build`,
      'RUN apt-get update -qq && apt-get install -y --no-install-recommends build-essential git pkg-config libpq-dev libyaml-dev' + (mysql ? ' default-libmysqlclient-dev' : '') + ' >/dev/null && rm -rf /var/lib/apt/lists/*',
      `ENV ${bundleEnv}`,
      'WORKDIR /app',
      ...(assets === null ? [] : nodeToolchain(assets.major)),
      ...(input.installCommand === null ? [`COPY ${manifests.join(' ')} ./`, run('bundle install --jobs 4', ['/usr/local/bundle/cache']), 'COPY . .'] : ['COPY . .', run(input.installCommand, ['/usr/local/bundle/cache'])]),
      // jsbundling/cssbundling run the package.json build from assets:precompile, so Node deps are installed first.
      ...(assets === null ? [] : [run(assets.install, assets.caches)]),
      ...(input.buildCommand !== null ? [run(input.buildCommand)] : precompile ? [run('SECRET_KEY_BASE_DUMMY=1 bundle exec rails assets:precompile')] : []),
      ...(bootsnap ? [run('bundle exec bootsnap precompile --gemfile app/ lib/')] : []),
      ...(assets === null ? [] : ['RUN rm -rf node_modules']),
      '',
      `FROM ruby:${version}-slim`,
      ...runtimePackages(ctx, 'debian', ['ca-certificates', 'curl', 'libpq5', 'libyaml-0-2', ...(mysql ? ['libmariadb3'] : [])]),
      addUser('debian'),
      `ENV ${bundleEnv} RAILS_LOG_TO_STDOUT=1 RAILS_SERVE_STATIC_FILES=1 PORT=3000`,
      'WORKDIR /app',
      'COPY --from=build /usr/local/bundle /usr/local/bundle',
      'COPY --from=build --chown=app:app /app /app',
      'USER app',
      'EXPOSE 3000',
      cmd(start),
    ],
  });
}
