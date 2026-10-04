/**
 * .NET: the SDK from global.json or the project's TargetFramework, a restore
 * layer from the project files alone, `dotnet publish -c Release`, and the
 * ASP.NET (or plain runtime) image listening on $PORT via `--urls`.
 */
import { basename, dirname, join } from 'node:path';
import { addUser, cmd, existing, generated, listDir, listDirs, readJson, readText, run, runtimePackages, toolVersions, warn, type BuildPlan, type Ctx } from './shared.ts';

const DEFAULT_DOTNET = '8.0';
const NUGET_CACHES = ['/root/.nuget/packages'];

/** Project files at the root and one level down (the usual `src/App/App.csproj` layout). */
export async function dotnetProjects(dir: string): Promise<string[]> {
  const isProject = (name: string): boolean => /\.(?:cs|fs)proj$/.test(name);
  const projects = (await listDir(dir)).filter(isProject);
  for (const sub of await listDirs(dir)) {
    projects.push(...(await listDir(join(dir, sub))).filter(isProject).map((name) => `${sub}/${name}`));
    for (const nested of await listDirs(join(dir, sub))) projects.push(...(await listDir(join(dir, sub, nested))).filter(isProject).map((name) => `${sub}/${nested}/${name}`));
  }
  return projects;
}

export async function planDotnet(ctx: Ctx): Promise<BuildPlan> {
  const { dir, input } = ctx;
  const projects = await dotnetProjects(dir);
  const contents = new Map<string, string>();
  for (const project of projects) contents.set(project, (await readText(join(dir, project))) ?? '');
  // The runnable project: a web app, else a worker service, else a console app; class libraries rank last.
  const rank = (content: string): number => (content.includes('Microsoft.NET.Sdk.Web') ? 3 : content.includes('Microsoft.NET.Sdk.Worker') ? 2 : /<OutputType>\s*Exe\s*</i.test(content) ? 1 : 0);
  const project = [...projects].sort((a, b) => rank(contents.get(b)!) - rank(contents.get(a)!))[0]!;
  const content = contents.get(project)!;
  const isWeb = content.includes('Microsoft.NET.Sdk.Web');
  if (projects.length > 1) warn(ctx, `Several .NET projects found (${projects.join(', ')}); publishing ${project}. Set a build command to choose another.`);
  const global = await readJson<{ sdk?: { version?: string } }>(join(dir, 'global.json'));
  const version = /^\d+\.\d+/.exec(ctx.runtime.dotnet ?? global?.sdk?.version ?? (await toolVersions(dir)).dotnet ?? /<TargetFramework>net(\d+\.\d+)/.exec(content)?.[1] ?? '')?.[0] ?? DEFAULT_DOTNET;
  const assembly = /<AssemblyName>([^<]+)</.exec(content)?.[1]?.trim() ?? basename(project).replace(/\.(?:cs|fs)proj$/, '');
  const manifests = await existing(dir, [project, 'global.json', 'nuget.config', 'NuGet.Config', 'Directory.Build.props', 'Directory.Packages.props']);
  const restoreFirst = input.buildCommand === null && dirname(project) === '.';

  const build = input.buildCommand ?? `dotnet publish "${project}" -c Release -o /out --nologo${restoreFirst ? ' --no-restore' : ''}`;
  const start = input.startCommand ?? `dotnet /app/${assembly}.dll${isWeb ? ' --urls http://0.0.0.0:$PORT' : ''}`;
  return generated(ctx, {
    stack: 'dotnet',
    label: `${isWeb ? 'ASP.NET Core' : '.NET'} ${version} · ${assembly}`,
    defaultPort: 8080,
    startCommand: start,
    lines: [
      `FROM mcr.microsoft.com/dotnet/sdk:${version} AS build`,
      'WORKDIR /src',
      ...(restoreFirst ? [`COPY ${manifests.join(' ')} ./`, run(`dotnet restore "${project}"`, NUGET_CACHES)] : []),
      'COPY . .',
      run(build, NUGET_CACHES),
      '',
      `FROM mcr.microsoft.com/dotnet/${isWeb ? 'aspnet' : 'runtime'}:${version}`,
      ...runtimePackages(ctx, 'debian'),
      // .NET 8+ images ship an `app` user; older ones need it created.
      ...(Number(version.split('.')[0]) >= 8 ? [] : [addUser('debian')]),
      'WORKDIR /app',
      'COPY --from=build --chown=app:app /out /app',
      'ENV PORT=8080 ASPNETCORE_HTTP_PORTS=8080 DOTNET_RUNNING_IN_CONTAINER=true',
      'USER app',
      'EXPOSE 8080',
      cmd(start),
    ],
  });
}
