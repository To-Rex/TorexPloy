/**
 * PHP on Apache: the version from composer.json / .php-version, common
 * extensions, Composer with a cache mount, a Node stage for Vite/Mix assets
 * when a package.json is present, and Laravel's caches warmed at container
 * start (when the real environment is available). Apache needs root to
 * bind and then drops to www-data itself, so there is no USER step here.
 */
import { join } from 'node:path';
import { cmd, exists, generated, readJson, readText, run, runtimePackages, toolVersions, versionLine, writeFileStep, type BuildPlan, type Ctx } from './shared.ts';
import { assetBuild, type PackageJson } from './node.ts';

const DEFAULT_PHP = '8.4';
const PHP_VERSIONS = ['8.1', '8.2', '8.3', '8.4', '8.5'];

interface ComposerJson {
  require?: Record<string, string>;
}

export async function planPhp(ctx: Ctx): Promise<BuildPlan> {
  const { dir, input, procfile } = ctx;
  const composer = await readJson<ComposerJson>(join(dir, 'composer.json'));
  const hasComposer = composer !== null;
  const laravel = composer?.require?.['laravel/framework'] !== undefined || (await exists(join(dir, 'artisan')));
  const requested = /(8\.\d+)/.exec(ctx.runtime.php ?? versionLine(await readText(join(dir, '.php-version'))) ?? (await toolVersions(dir)).php ?? composer?.require?.php ?? '')?.[1];
  const version = requested !== undefined && PHP_VERSIONS.includes(requested) ? requested : DEFAULT_PHP;
  // Heroku-style `web: heroku-php-apache2 web/` names the document root; otherwise Laravel's `public/` or the repo root.
  const procfileRoot = /heroku-php-(?:apache2|nginx)\s+(\S+)/.exec(procfile.web ?? '')?.[1]?.replace(/\/+$/, '');
  const docroot = procfileRoot !== undefined ? `/var/www/html/${procfileRoot}` : (await exists(join(dir, 'public'))) ? '/var/www/html/public' : '/var/www/html';
  const assets = await assetBuild(ctx, (await readJson<PackageJson>(join(dir, 'package.json'))) ?? {});
  const assetsDir = input.outputDirectory ?? 'public/build';
  const extensions = ['pdo_mysql', 'pdo_pgsql', 'opcache', ...(laravel ? ['bcmath', 'intl', 'zip', 'pcntl'] : [])];

  // Laravel's config/route/view caches depend on the environment, so they are built when the container starts.
  const laravelStart = ['#!/bin/sh', 'set -e', 'php artisan optimize || true', 'exec apache2-foreground'];
  const start = input.startCommand ?? (laravel ? '/usr/local/bin/torex-start' : null);
  return generated(ctx, {
    stack: 'php',
    label: `${laravel ? 'Laravel · ' : ''}PHP ${version} · Apache${hasComposer ? ' · Composer' : ''}`,
    defaultPort: 80,
    startCommand: start,
    lines: [
      ...(assets === null ? [] : [`FROM node:${assets.major}-slim AS assets`, 'WORKDIR /app', 'COPY . .', run(assets.install, assets.caches), run(assets.build), '']),
      `FROM php:${version}-apache`,
      'COPY --from=mlocati/php-extension-installer /usr/bin/install-php-extensions /usr/local/bin/',
      `RUN install-php-extensions ${extensions.join(' ')} >/dev/null && a2enmod rewrite headers >/dev/null && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"`,
      ...runtimePackages(ctx, 'debian'),
      `ENV APACHE_DOCUMENT_ROOT=${docroot}`,
      "RUN sed -ri -e 's!/var/www/html!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/sites-available/*.conf /etc/apache2/apache2.conf && sed -ri 's/AllowOverride None/AllowOverride All/g' /etc/apache2/apache2.conf",
      ...(hasComposer ? ['COPY --from=composer:2 /usr/bin/composer /usr/bin/composer'] : []),
      'WORKDIR /var/www/html',
      'COPY . .',
      ...(hasComposer ? [run(input.installCommand ?? 'composer install --no-dev --optimize-autoloader --no-interaction --no-progress', ['/root/.composer/cache'])] : []),
      ...(assets === null ? [] : [`COPY --from=assets /app/${assetsDir} /var/www/html/${assetsDir}`]),
      ...(input.buildCommand === null ? [] : [run(input.buildCommand)]),
      laravel ? 'RUN chown -R www-data:www-data storage bootstrap/cache' : 'RUN chown -R www-data:www-data /var/www/html',
      ...(laravel && input.startCommand === null ? [writeFileStep('/usr/local/bin/torex-start', laravelStart), 'RUN chmod +x /usr/local/bin/torex-start'] : []),
      'ENV PORT=80',
      'EXPOSE 80',
      ...(start === null ? [] : [cmd(start)]),
    ],
  });
}
