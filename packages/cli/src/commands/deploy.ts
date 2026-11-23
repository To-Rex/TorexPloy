/**
 * Shipping and watching: deploy and follow the build, upload a folder and
 * deploy it, read logs, roll back, restart.
 */
import { basename, resolve } from 'node:path';
import type { ApplicationDto, DeploymentDto, ProjectDto, ServerDto } from '../../../shared/src/dto.ts';
import { flag, off, on, seconds } from '../args.ts';
import type { Client } from '../client.ts';
import { findLink, writeLink } from '../config.ts';
import { client, resolveApp, type AppRef, type Command } from '../context.ts';
import { collect, zip } from '../files.ts';
import { ask, bytes, c, choose, CliError, confirm, duration, interactive, json, note, out, relative, spinner, status, table } from '../ui.ts';

/** The panel's upload limit for one archive. */
const UPLOAD_MAX = 512 * 1024 * 1024;

interface LogLine {
  seq: number;
  t: number;
  stream: string;
  text: string;
  replica?: number;
  source?: string;
}

function clock(t: number): string {
  const date = new Date(t);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
}

function printLine(line: LogLine, prefix = ''): void {
  const text = line.stream === 'stderr' ? c.red(line.text) : line.text;
  process.stdout.write(`${c.gray(clock(line.t))} ${prefix}${text}\n`);
}

/** Stop following on Ctrl+C without stopping what is followed. */
function interruptible(): { signal: AbortSignal; interrupted: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let hit = false;
  const handler = () => {
    hit = true;
    controller.abort();
  };
  process.once('SIGINT', handler);
  return { signal: controller.signal, interrupted: () => hit, dispose: () => process.removeListener('SIGINT', handler) };
}

/** Follow a deployment's log to its end; returns the deployment as it finished. */
export async function follow(api: Client, deployment: { id: string }, json: boolean): Promise<DeploymentDto> {
  const watch = interruptible();
  try {
    await api.stream(
      `/api/deployments/${deployment.id}/log`,
      {},
      (event) => {
        if (event.event === 'line' && !json) printLine(JSON.parse(event.data) as LogLine);
        if (event.event === 'end') return false;
        return undefined;
      },
      watch.signal,
    );
  } catch (error) {
    if (!watch.interrupted()) throw error;
  } finally {
    watch.dispose();
  }
  if (watch.interrupted()) {
    note(`\n${c.yellow('!')} Stopped following; the deployment goes on. Follow it again: torex logs --deployment ${deployment.id}`);
    process.exit(130);
  }
  return api.get<DeploymentDto>(`/api/deployments/${deployment.id}`);
}

function finished(ref: AppRef, result: DeploymentDto, command: Command): void {
  if (command.json) {
    json(result);
  } else if (result.status === 'succeeded') {
    note(`\n${c.green('✓')} ${ref.app.name} deployed in ${duration(result.durationMs)}${ref.app.url === null ? '' : `: ${c.cyan(ref.app.url)}`}`);
  } else {
    note(`\n${c.red('✗')} The deployment ${status(result.status)}${result.errorMessage === null ? '' : `: ${result.errorMessage}`}`);
    note(c.dim(`Ask TorexAi why: torex ai "why did deployment ${result.id} of ${ref.app.name} fail?"`));
  }
  if (result.status !== 'succeeded') process.exitCode = 1;
}

export async function deployCommand(command: Command): Promise<void> {
  const api = client(command);
  const ref = await resolveApp(command, api, command.words[0]);
  if (ref.app.sourceType === 'upload') note(c.dim('This application is built from uploads: deploying again builds the last upload. To send this folder, use torex up.'));
  const started = await api.post<DeploymentDto>(`/api/applications/${ref.app.id}/deploy`, { clearCache: on(command.args, 'clear-cache') });
  note(`${c.cyan('→')} Deploying ${c.bold(ref.app.name)} (${started.id})`);
  if (off(command.args, 'wait') || on(command.args, 'detach')) {
    if (command.json) json(started);
    return;
  }
  finished(ref, await follow(api, started, command.json), command);
}

/** Make an application for a folder that has none yet: a project, a server, a name. */
async function createForFolder(api: Client, dir: string): Promise<AppRef> {
  if (!interactive()) throw new CliError('No application to upload to. Name one (torex up --app <app>) or run this in a terminal to create one.');
  const [projects, servers] = await Promise.all([api.get<ProjectDto[]>('/api/projects'), api.get<ServerDto[]>('/api/servers')]);
  let project: ProjectDto | null = projects.length === 0 ? null : await choose('Which project?', [...projects.map((candidate) => ({ label: candidate.name, value: candidate as ProjectDto | null })), { label: c.cyan('+ a new project'), value: null }]);
  if (project === null) {
    const name = await ask(`Name of the new project [${basename(dir)}]: `, basename(dir));
    project = await api.post<ProjectDto>('/api/projects', { name });
  }
  const ready = servers.filter((server) => server.status === 'ready');
  const server = await choose('Which server?', (ready.length > 0 ? ready : servers).map((candidate) => ({ label: `${candidate.name} ${c.dim(candidate.host ?? 'this panel')}`, value: candidate })));
  const name = await ask(`Name of the application [${basename(dir)}]: `, basename(dir));
  const app = await api.post<ApplicationDto>(`/api/projects/${project.id}/applications`, { name, serverId: server.id, source: { type: 'upload' } });
  return { app, project };
}

export async function upCommand(command: Command): Promise<void> {
  const api = client(command);
  const dir = resolve(command.words[0] ?? '.');
  const named = flag(command.args, 'app');
  const linked = findLink(dir);
  let ref: AppRef;
  if (named !== undefined || (linked !== null && linked.link.url === command.selected!.profile.url)) {
    ref = await resolveApp(command, api, named);
  } else {
    const apps = await api.get<ApplicationDto[]>('/api/applications');
    const uploads = apps.filter((app) => app.sourceType === 'upload');
    if (uploads.length > 0 && interactive()) {
      const chosen = await choose('Upload this folder to which application?', [...uploads.map((app) => ({ label: app.name, value: app as ApplicationDto | null })), { label: c.cyan('+ a new application'), value: null }]);
      ref = chosen === null ? await createForFolder(api, dir) : { app: chosen, project: undefined };
    } else {
      ref = await createForFolder(api, dir);
    }
    writeLink(dir, { url: command.selected!.profile.url, application: ref.app.id, name: ref.app.name });
    note(c.dim(`Linked ${basename(dir)} to ${ref.app.name}: next time, just torex up.`));
  }
  if (ref.app.sourceType !== 'upload') {
    throw new CliError(`${ref.app.name} is built from ${ref.app.sourceType}, not from uploads. Deploy it with torex deploy, or switch its source to Upload in the dashboard.`);
  }

  const packing = spinner(`Packing ${basename(dir)}…`);
  let archive: Uint8Array;
  let summary: string;
  try {
    const found = await collect(dir, { includeEnv: on(command.args, 'include-env'), maxBytes: UPLOAD_MAX });
    if (found.files.length === 0) throw new CliError(`Nothing to upload in ${dir}`);
    archive = await zip(found.files);
    summary = `${found.files.length} files, ${bytes(found.bytes)} → ${bytes(archive.byteLength)}`;
    packing.stop(`${c.green('✓')} Packed ${summary}`);
    if (found.skippedEnv.length > 0) note(c.dim(`Left out ${found.skippedEnv.join(', ')}: put its values in the panel (torex env push), or pass --include-env.`));
  } catch (error) {
    packing.stop();
    throw error instanceof CliError ? error : new CliError((error as Error).message);
  }
  if (archive.byteLength > UPLOAD_MAX) throw new CliError(`The archive is ${bytes(archive.byteLength)}; the panel takes up to ${bytes(UPLOAD_MAX)}.`);

  const sending = spinner(`Uploading ${bytes(archive.byteLength)}…`);
  const deployNow = !off(command.args, 'deploy');
  const response = await api.fetch('POST', `/api/applications/${ref.app.id}/upload`, { query: { name: basename(dir), deploy: deployNow ? '1' : '0', clearCache: on(command.args, 'clear-cache') ? '1' : undefined }, raw: archive });
  const body = (await response.json().catch(() => null)) as { deployment: DeploymentDto | null } | null;
  sending.stop();
  if (!response.ok) throw api.failure(response.status, body);
  note(`${c.green('✓')} Uploaded to ${c.bold(ref.app.name)}`);
  const deployment = body?.deployment ?? null;
  if (deployment === null) {
    note(c.dim('Not deployed (--no-deploy). Deploy it with: torex deploy'));
    return;
  }
  note(`${c.cyan('→')} Deploying (${deployment.id})`);
  if (off(command.args, 'wait')) return;
  finished(ref, await follow(api, deployment, command.json), command);
}

export async function deploymentsCommand(command: Command): Promise<void> {
  const api = client(command);
  const { app } = await resolveApp(command, api, command.words[0]);
  const list = await api.get<DeploymentDto[] | { items: DeploymentDto[] }>(`/api/applications/${app.id}/deployments`);
  const items = Array.isArray(list) ? list : list.items;
  if (command.json) return json(items);
  out(table(['#', 'STATUS', 'TRIGGER', 'WHAT', 'WHEN', 'TOOK', 'ID'], items.slice(0, 20).map((deployment) => [String(deployment.number), `${status(deployment.status)}${deployment.isActive ? c.green(' ●') : ''}`, deployment.trigger, (deployment.commitMessage ?? deployment.upload?.name ?? '—').split('\n')[0]!.slice(0, 50), relative(deployment.createdAt), duration(deployment.durationMs), c.dim(deployment.id)])));
}

export async function rollbackCommand(command: Command): Promise<void> {
  const api = client(command);
  const ref = await resolveApp(command, api, command.words[0]);
  const list = await api.get<DeploymentDto[] | { items: DeploymentDto[] }>(`/api/applications/${ref.app.id}/deployments`);
  const items = Array.isArray(list) ? list : list.items;
  const wanted = command.words[1];
  const target = wanted !== undefined ? items.find((deployment) => deployment.id === wanted || String(deployment.number) === wanted) : items.find((deployment) => deployment.status === 'succeeded' && !deployment.isActive && deployment.canRollback);
  if (target === undefined) throw new CliError(wanted === undefined ? 'There is no earlier successful version to go back to.' : `No deployment ${wanted} of ${ref.app.name}.`);
  if (!command.yes && !(await confirm(`Deploy ${ref.app.name} #${target.number} (${(target.commitMessage ?? target.upload?.name ?? target.id).split('\n')[0]}) again?`, true))) return;
  const started = await api.post<DeploymentDto>(`/api/deployments/${target.id}/redeploy`);
  note(`${c.cyan('→')} Rolling back to #${target.number} (${started.id})`);
  finished(ref, await follow(api, started, command.json), command);
}

export async function lifecycleCommand(command: Command, action: 'restart' | 'stop' | 'start'): Promise<void> {
  const api = client(command);
  const { app } = await resolveApp(command, api, command.words[0]);
  if (action === 'stop' && !command.yes && !(await confirm(`Stop ${app.name}? It stops answering until started again.`, false))) return;
  await api.post(`/api/applications/${app.id}/${action}`);
  note(`${c.green('✓')} ${app.name}: ${action === 'restart' ? 'restarting' : action === 'stop' ? 'stopped' : 'starting'}`);
}

export async function logsCommand(command: Command): Promise<void> {
  const api = client(command);
  const deploymentId = flag(command.args, 'deployment');
  if (deploymentId !== undefined) {
    await follow(api, { id: deploymentId }, false);
    return;
  }
  const keepFollowing = on(command.args, 'follow');
  const tail = flag(command.args, 'tail');
  const since = flag(command.args, 'since');
  const query: Record<string, string | undefined> = { tail: tail ?? (keepFollowing ? '100' : '200'), since: since === undefined ? undefined : String(seconds(since)), service: flag(command.args, 'service') };
  const given = command.words[0];
  const path = given !== undefined && given.startsWith('svc_') ? `/api/services/${given}/logs` : `/api/applications/${(await resolveApp(command, api, given)).app.id}/logs`;
  const watch = interruptible();
  // Reading ends on Ctrl+C, at the end of the stream, or (without --follow) once the lines stop coming.
  const stop = new AbortController();
  watch.signal.addEventListener('abort', () => stop.abort(), { once: true });
  let idle: NodeJS.Timeout | null = null;
  const quietSoon = (ms: number): void => {
    if (keepFollowing) return;
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(() => stop.abort(), ms);
  };
  quietSoon(4_000);
  let replicas = 1;
  try {
    await api.stream(
      path,
      query,
      (event) => {
        if (event.event === 'meta') replicas = (JSON.parse(event.data) as { replicas?: number }).replicas ?? 1;
        if (event.event === 'line') {
          const line = JSON.parse(event.data) as LogLine;
          const prefix = line.source !== undefined ? c.magenta(`${line.source} `) : replicas > 1 ? c.magenta(`#${(line.replica ?? 0) + 1} `) : '';
          printLine(line, prefix);
          quietSoon(1_200);
        }
        if (event.event === 'end') return false;
        return undefined;
      },
      stop.signal,
    );
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    if (idle !== null) clearTimeout(idle);
    watch.dispose();
  }
}
