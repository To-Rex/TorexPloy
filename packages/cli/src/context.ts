/**
 * What every command works with: the parsed command line, the sign-in it
 * acts with, and finding the application a command is about.
 */
import { hostname } from 'node:os';
import type { ApplicationDto, ProjectDto } from '../../shared/src/dto.ts';
import manifest from '../package.json' with { type: 'json' };
import { flag, on, type Parsed } from './args.ts';
import { Client } from './client.ts';
import { findLink, selectProfile, type Selected } from './config.ts';
import { choose, CliError, interactive } from './ui.ts';

export const VERSION: string = manifest.version;
export const AGENT = `torex/${VERSION} (${process.platform}; node ${process.versions.node})`;

export interface Command {
  args: Parsed;
  /** Words after the command name. */
  words: string[];
  json: boolean;
  yes: boolean;
  selected: Selected | null;
}

export function commandOf(args: Parsed): Command {
  const options: { profile?: string; url?: string; token?: string } = {};
  const profile = flag(args, 'profile');
  const url = flag(args, 'url');
  const token = flag(args, 'token');
  if (profile !== undefined) options.profile = profile;
  if (url !== undefined) options.url = url;
  if (token !== undefined) options.token = token;
  return { args, words: args.words.slice(1), json: on(args, 'json'), yes: on(args, 'yes'), selected: selectProfile(options) };
}

export function client(command: Command): Client {
  if (command.selected === null) throw new CliError('Not signed in. Run: torex login <panel address>');
  return new Client(command.selected.profile.url, command.selected.profile.token, AGENT);
}

export function computerName(): string {
  return hostname().replace(/\.local$/, '').slice(0, 60) || 'computer';
}

export interface AppRef {
  app: ApplicationDto;
  project: ProjectDto | undefined;
}

/**
 * The application a command is about: `--app` or the word given (an id,
 * a name, or `project/name`), else the one this folder is linked to, else
 * the only one there is, else the person picks.
 */
export async function resolveApp(command: Command, api: Client, given: string | undefined): Promise<AppRef> {
  const wanted = given ?? flag(command.args, 'app');
  const [apps, projects] = await Promise.all([api.get<ApplicationDto[]>('/api/applications'), api.get<ProjectDto[]>('/api/projects')]);
  const projectOf = (app: ApplicationDto) => projects.find((project) => project.id === app.projectId);
  const label = (app: ApplicationDto) => `${projectOf(app)?.name ?? '?'}/${app.name}`;
  const pick = (app: ApplicationDto): AppRef => ({ app, project: projectOf(app) });

  if (wanted !== undefined) {
    const byId = apps.find((app) => app.id === wanted);
    if (byId !== undefined) return pick(byId);
    const slash = wanted.indexOf('/');
    const matches =
      slash > 0
        ? apps.filter((app) => {
            const project = projectOf(app);
            const [projectName, appName] = [wanted.slice(0, slash).toLowerCase(), wanted.slice(slash + 1).toLowerCase()];
            return (project?.name.toLowerCase() === projectName || project?.slug === projectName) && (app.name.toLowerCase() === appName || app.slug === appName);
          })
        : apps.filter((app) => app.name.toLowerCase() === wanted.toLowerCase() || app.slug === wanted.toLowerCase());
    if (matches.length === 1) return pick(matches[0]!);
    if (matches.length > 1) throw new CliError(`"${wanted}" is more than one application: ${matches.map(label).join(', ')}. Say which: torex <command> project/name`);
    throw new CliError(`No application "${wanted}". These exist: ${apps.map(label).join(', ') || 'none yet'}`);
  }

  const linked = findLink();
  if (linked !== null && command.selected !== null && linked.link.url === command.selected.profile.url) {
    const app = apps.find((candidate) => candidate.id === linked.link.application);
    if (app !== undefined) return pick(app);
    throw new CliError(`This folder is linked to ${linked.link.name}, which no longer exists. Link it again: torex link`);
  }
  if (apps.length === 1) return pick(apps[0]!);
  if (apps.length === 0) throw new CliError('There are no applications yet. Create one in the dashboard, or upload this folder: torex up');
  if (!interactive()) throw new CliError(`Which application? Give one (torex <command> <app>) or link this folder (torex link). These exist: ${apps.map(label).join(', ')}`);
  return pick(await choose('Which application?', apps.map((app) => ({ label: `${label(app)}  ${app.status}`, value: app }))));
}
