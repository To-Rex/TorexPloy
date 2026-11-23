/**
 * Looking around: what runs where, and which application this folder is.
 */
import { basename } from 'node:path';
import type { ApplicationDto, DomainDto, OverviewDto, ProjectDto, ServerDto, ServiceDto } from '../../../shared/src/dto.ts';
import { flag, on } from '../args.ts';
import { findLink, LINK_FILE, writeLink } from '../config.ts';
import { client, resolveApp, type Command } from '../context.ts';
import { c, CliError, json, note, out, relative, status, table } from '../ui.ts';
import { openBrowser } from './account.ts';

function projectName(projects: ProjectDto[], id: string): string {
  return projects.find((project) => project.id === id)?.name ?? '?';
}

function deployed(app: ApplicationDto): string {
  const latest = app.latestDeployment;
  return latest === null ? '—' : `${status(latest.status)} ${c.dim(relative(latest.createdAt))}`;
}

export async function statusCommand(command: Command): Promise<void> {
  const api = client(command);
  const [overview, apps, projects, servers] = await Promise.all([api.get<OverviewDto>('/api/overview'), api.get<ApplicationDto[]>('/api/applications'), api.get<ProjectDto[]>('/api/projects'), api.get<ServerDto[]>('/api/servers')]);
  if (command.json) {
    json({ overview, applications: apps, projects, servers });
    return;
  }
  const team = command.selected?.profile.team;
  out(`${c.bold(team ?? command.selected!.profile.url)}  ${c.dim(`${overview.projects} projects · ${overview.applications.total} applications (${overview.applications.running} running, ${overview.applications.failed} failed) · ${overview.services.total} services · ${overview.servers.ready}/${overview.servers.total} servers ready`)}`);
  if (apps.length > 0) {
    out('');
    out(table(['APPLICATION', 'STATUS', 'ADDRESS', 'LAST DEPLOY'], apps.map((app) => [`${c.dim(`${projectName(projects, app.projectId)}/`)}${app.name}`, status(app.status), app.url ?? c.dim('no domain'), deployed(app)])));
  }
  const down = servers.filter((server) => server.status !== 'ready');
  if (down.length > 0) {
    out('');
    for (const server of down) out(`${c.yellow('!')} Server ${server.name} is ${status(server.status)}${server.statusMessage === null ? '' : `: ${server.statusMessage}`}`);
  }
}

export async function projectsCommand(command: Command): Promise<void> {
  const projects = await client(command).get<ProjectDto[]>('/api/projects');
  if (command.json) return json(projects);
  if (projects.length === 0) return note('No projects yet.');
  out(table(['PROJECT', 'APPS', 'SERVICES', 'HEALTH', 'ID'], projects.map((project) => [project.name, String(project.applicationCount), String(project.serviceCount), `${c.green(String(project.statusSummary.running))} running${project.statusSummary.failed > 0 ? ` · ${c.red(`${project.statusSummary.failed} failed`)}` : ''}`, c.dim(project.id)])));
}

export async function appsCommand(command: Command): Promise<void> {
  const api = client(command);
  const [apps, projects] = await Promise.all([api.get<ApplicationDto[]>('/api/applications'), api.get<ProjectDto[]>('/api/projects')]);
  const wanted = command.words[0] ?? flag(command.args, 'project');
  const shown = wanted === undefined ? apps : apps.filter((app) => { const project = projects.find((candidate) => candidate.id === app.projectId); return project?.name.toLowerCase() === wanted.toLowerCase() || project?.id === wanted; });
  if (command.json) return json(shown);
  if (shown.length === 0) return note(wanted === undefined ? 'No applications yet.' : `No applications in "${wanted}".`);
  out(table(['APPLICATION', 'STATUS', 'SOURCE', 'ADDRESS', 'LAST DEPLOY', 'ID'], shown.map((app) => [`${c.dim(`${projectName(projects, app.projectId)}/`)}${app.name}`, status(app.status), app.sourceType, app.url ?? c.dim('—'), deployed(app), c.dim(app.id)])));
}

export async function servicesCommand(command: Command): Promise<void> {
  const api = client(command);
  const projects = await api.get<ProjectDto[]>('/api/projects');
  const wanted = command.words[0] ?? flag(command.args, 'project');
  const chosen = wanted === undefined ? projects : projects.filter((project) => project.name.toLowerCase() === wanted.toLowerCase() || project.id === wanted);
  const details = await Promise.all(chosen.map((project) => api.get<{ services: ServiceDto[] }>(`/api/projects/${project.id}`)));
  const services = details.flatMap((detail) => detail.services);
  if (command.json) return json(services);
  if (services.length === 0) return note('No services yet.');
  out(table(['SERVICE', 'TYPE', 'STATUS', 'INTERNAL ADDRESS', 'SERVER', 'ID'], services.map((service) => [`${c.dim(`${projectName(projects, service.projectId)}/`)}${service.name}`, `${service.type} ${service.version}`, status(service.status), `${service.internalHost}:${service.internalPort}`, service.serverName, c.dim(service.id)])));
}

export async function serversCommand(command: Command): Promise<void> {
  const servers = await client(command).get<ServerDto[]>('/api/servers');
  if (command.json) return json(servers);
  out(table(['SERVER', 'STATUS', 'ADDRESS', 'APPS', 'SERVICES', 'DOCKER', 'ID'], servers.map((server) => [server.name, status(server.status), server.host ?? server.publicIp ?? (server.kind === 'local' ? 'this panel' : '—'), String(server.applicationCount), String(server.serviceCount), server.docker?.version ?? '—', c.dim(server.id)])));
}

export async function infoCommand(command: Command): Promise<void> {
  const api = client(command);
  const { app, project } = await resolveApp(command, api, command.words[0]);
  const domains = await api.get<DomainDto[]>(`/api/applications/${app.id}/domains`);
  if (command.json) return json({ application: app, domains });
  out(`${c.bold(app.name)} ${c.dim(`in ${project?.name ?? '?'} · ${app.id}`)}`);
  out(`Status:   ${status(app.status)}${app.pendingChanges ? c.yellow('  (settings changed since the last deploy)') : ''}`);
  out(`Source:   ${app.sourceType}${app.source.type === 'github' || app.source.type === 'git' || app.source.type === 'gitlab' || app.source.type === 'bitbucket' ? ` ${'repository' in app.source ? app.source.repository : ''}${'branch' in app.source ? `@${app.source.branch}` : ''}` : ''}`);
  out(`Build:    ${app.buildType}${app.port === null ? '' : ` · port ${app.port}`} · ${app.replicas} replica${app.replicas === 1 ? '' : 's'}`);
  out(`Server:   ${app.serverName}`);
  if (domains.length > 0) out(`Domains:  ${domains.map((domain) => `${domain.https ? 'https' : 'http'}://${domain.host}${domain.path === '/' ? '' : domain.path}`).join(', ')}`);
  const latest = app.latestDeployment;
  if (latest !== null) out(`Deployed: ${status(latest.status)} ${relative(latest.createdAt)}${latest.commitMessage === null ? '' : c.dim(` · ${latest.commitMessage.split('\n')[0]}`)}`);
}

export async function linkCommand(command: Command): Promise<void> {
  const api = client(command);
  const { app, project } = await resolveApp(command, api, command.words[0]);
  const path = writeLink(process.cwd(), { url: command.selected!.profile.url, application: app.id, name: app.name, ...(project === undefined ? {} : { project: project.name }) });
  note(`${c.green('✓')} ${basename(process.cwd())} is linked to ${c.bold(`${project?.name ?? '?'}/${app.name}`)} (${path}). Commands here act on it without naming it.`);
  note(c.dim(`${LINK_FILE} holds no secrets; commit it or add it to .gitignore, as you like.`));
}

export async function unlinkCommand(): Promise<void> {
  const found = findLink();
  if (found === null) throw new CliError('This folder is not linked.');
  const { rm } = await import('node:fs/promises');
  await rm(found.path);
  note(`${c.green('✓')} Unlinked from ${found.link.name}.`);
}

export async function openCommand(command: Command): Promise<void> {
  const api = client(command);
  const { app } = await resolveApp(command, api, command.words[0]);
  const target = on(command.args, 'dashboard') || app.url === null ? `${command.selected!.profile.url}/apps/${app.id}` : app.url;
  note(`Opening ${target}`);
  openBrowser(target);
}
