/**
 * Moving projects between panels from the terminal.
 *
 *   torex export [PROJECT] [-o FILE] [--link] [--no-download] [--images] [--no-databases|--no-volumes|--no-storage|--no-source] [--s3 DEST]
 *   torex import FILE|LINK [--server S] [--name N] [--no-data] [--no-deploy] [--no-domains] [--no-ports] [--yes]
 *   torex transfers
 *
 * A passphrase comes from --passphrase, else TOREX_PASSPHRASE, else a hidden
 * prompt; an export without one gets a strong one from the panel, printed
 * once. Archives stream to and from disk: their size does not matter.
 */
import { createReadStream, createWriteStream, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { ProjectDto } from '../../../shared/src/dto.ts';
import type { CreatedExportDto, ImportAnalysisDto, ImportSourceChoice, TransferDto, TransferShareDto } from '../../../shared/src/transfer.ts';
import { flag, off, on } from '../args.ts';
import type { Client } from '../client.ts';
import { AGENT, client, type Command } from '../context.ts';
import { bytes, c, choose, CliError, confirm, interactive, json, note, out, relative, secret, spinner, status, table } from '../ui.ts';

const DONE = new Set(['succeeded', 'failed', 'cancelled']);

function passphraseFrom(command: Command): string | undefined {
  return flag(command.args, 'passphrase') ?? (process.env.TOREX_PASSPHRASE !== undefined && process.env.TOREX_PASSPHRASE.length > 0 ? process.env.TOREX_PASSPHRASE : undefined);
}

function stepLine(transfer: TransferDto): string {
  const running = transfer.steps.find((step) => step.status === 'running');
  const what = running === undefined ? '' : ` · ${running.kind}${running.name === null ? '' : ` ${running.name}`}${running.total !== null && running.done !== null && running.unit === 'bytes' ? ` ${bytes(running.done)}/${bytes(running.total)}` : ''}`;
  return `${Math.floor(transfer.percent)}%${what}`;
}

/** Follow a transfer until it is done (or until `until` says it got far enough). */
async function follow(api: Client, id: string, label: string, until: (transfer: TransferDto) => boolean = (transfer) => DONE.has(transfer.status)): Promise<TransferDto> {
  const spin = spinner(label);
  try {
    for (;;) {
      const transfer = await api.get<TransferDto>(`/api/transfers/${id}`);
      if (until(transfer)) {
        spin.stop();
        return transfer;
      }
      spin.update(
        transfer.status === 'receiving'
          ? `${label} ${bytes(transfer.receivedBytes)}${transfer.expectedBytes === null ? '' : ` / ${bytes(transfer.expectedBytes)}`}`
          : transfer.status === 'queued'
            ? `${label} (queued)`
            : `${label} ${stepLine(transfer)}`,
      );
      await new Promise((done) => setTimeout(done, 1_000));
    }
  } catch (error) {
    spin.stop();
    throw error;
  }
}

function report(transfer: TransferDto): void {
  const said = new Set<string>();
  for (const step of transfer.steps) {
    if (step.note !== null) said.add(step.note.message);
    if (step.status === 'failed') note(`  ${c.red('✗')} ${step.note?.message ?? `${step.kind}${step.name === null ? '' : ` ${step.name}`}`}`);
    else if (step.status === 'skipped' && step.note !== null) note(`  ${c.dim('–')} ${step.note.message}`);
  }
  // A step's own trouble was said already.
  for (const warning of transfer.warnings) if (!said.has(warning.message)) note(`  ${c.yellow('!')} ${warning.message}`);
}

/** The project a command is about: a name or id, else the only one, else the person picks. */
async function resolveProject(command: Command, api: Client): Promise<ProjectDto> {
  const wanted = command.words[0] ?? flag(command.args, 'project');
  const projects = await api.get<ProjectDto[]>('/api/projects');
  if (wanted !== undefined) {
    const found = projects.find((project) => project.id === wanted || project.name.toLowerCase() === wanted.toLowerCase());
    if (found === undefined) throw new CliError(`No project "${wanted}". See: torex projects`);
    return found;
  }
  if (projects.length === 0) throw new CliError('There are no projects to export.');
  if (projects.length === 1) return projects[0]!;
  if (!interactive()) throw new CliError('Which project? torex export PROJECT');
  return choose('Which project?', projects.map((project) => ({ label: project.name, value: project })));
}

/** Stream a response body to a file, through a .part file so a broken download never looks whole. */
async function download(api: Client, path: string, file: string): Promise<number> {
  const response = await api.fetch('GET', path, { headers: { accept: 'application/octet-stream' } });
  if (!response.ok || response.body === null) {
    const text = await response.text().catch(() => '');
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON.
    }
    throw api.failure(response.status, parsed);
  }
  const total = Number(response.headers.get('content-length'));
  const part = `${file}.part`;
  const spin = spinner(`Downloading ${basename(file)}`);
  let received = 0;
  try {
    const body = Readable.fromWeb(response.body as unknown as WebReadableStream);
    body.on('data', (chunk: Buffer) => {
      received += chunk.length;
      spin.update(`Downloading ${basename(file)} ${bytes(received)}${Number.isFinite(total) && total > 0 ? ` / ${bytes(total)}` : ''}`);
    });
    await pipeline(body, createWriteStream(part, { mode: 0o600 }));
    renameSync(part, file);
  } catch (error) {
    if (existsSync(part)) unlinkSync(part);
    throw error;
  } finally {
    spin.stop();
  }
  return received;
}

/** Upload a file as the raw body, streamed (fetch cannot report progress or promise a length). */
function upload(api: Client, token: string | null, file: string): Promise<TransferDto> {
  const size = statSync(file).size;
  const url = new URL(`/api/transfers/import/upload?${new URLSearchParams({ name: basename(file) }).toString()}`, `${api.url}/`);
  const spin = spinner(`Uploading ${basename(file)}`);
  return new Promise((done, fail) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, {
      method: 'POST',
      headers: {
        'user-agent': AGENT,
        accept: 'application/json',
        'content-type': 'application/octet-stream',
        'content-length': String(size),
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
    });
    req.on('error', (error) => {
      spin.stop();
      fail(new CliError(`Cannot reach ${api.url}: ${error.message}`));
    });
    req.on('response', (response: IncomingMessage) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => {
        spin.stop();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Not JSON.
        }
        if ((response.statusCode ?? 500) >= 300) fail(api.failure(response.statusCode ?? 500, parsed));
        else done(parsed as TransferDto);
      });
    });
    let sent = 0;
    const stream = createReadStream(file);
    stream.on('data', (chunk) => {
      sent += chunk.length;
      spin.update(`Uploading ${basename(file)} ${bytes(sent)} / ${bytes(size)}`);
    });
    stream.on('error', (error) => {
      req.destroy(error);
    });
    stream.pipe(req);
  });
}

export async function exportCommand(command: Command): Promise<void> {
  const api = client(command);
  const project = await resolveProject(command, api);
  const include = {
    databases: !off(command.args, 'databases') && !off(command.args, 'data'),
    volumes: !off(command.args, 'volumes') && !off(command.args, 'data'),
    storage: !off(command.args, 'storage') && !off(command.args, 'data'),
    source: !off(command.args, 'source'),
    images: on(command.args, 'images'),
  };
  const passphrase = passphraseFrom(command);
  const s3 = flag(command.args, 's3');
  let s3DestinationId: string | undefined;
  if (s3 !== undefined) {
    const destinations = await api.get<{ id: string; name: string }[]>('/api/s3-destinations');
    const found = destinations.find((destination) => destination.id === s3 || destination.name.toLowerCase() === s3.toLowerCase());
    if (found === undefined) throw new CliError(`No S3 destination "${s3}"`);
    s3DestinationId = found.id;
  }
  const created = await api.post<CreatedExportDto>('/api/transfers/export', { projectId: project.id, include, ...(passphrase === undefined ? {} : { passphrase }), ...(s3DestinationId === undefined ? {} : { s3DestinationId }) });
  note(`${c.cyan('→')} Exporting ${c.bold(project.name)} (${created.transfer.id})`);
  const finished = await follow(api, created.transfer.id, 'Exporting');
  if (finished.status !== 'succeeded') {
    report(finished);
    throw new CliError(`The export ${finished.status}${finished.error === null ? '' : `: ${finished.error.message}`}`);
  }
  note(`${c.green('✓')} Exported ${project.name}${finished.sizeBytes === null ? '' : ` (${bytes(finished.sizeBytes)})`}`);
  report(finished);

  let file: string | null = null;
  if (!off(command.args, 'download')) {
    file = resolve(flag(command.args, 'output') ?? finished.fileName);
    if (existsSync(file) && !command.yes && !(await confirm(`${file} exists. Replace it?`, false))) file = null;
    else {
      await download(api, `/api/transfers/${finished.id}/download`, file);
      note(`${c.green('✓')} Saved ${file}`);
    }
  }
  let link: TransferShareDto | null = null;
  if (on(command.args, 'link')) link = await api.post<TransferShareDto>(`/api/transfers/${finished.id}/share`);

  if (command.json) return json({ transfer: finished, passphrase: created.passphrase, file, link: link?.link ?? null });
  if (link !== null) {
    out('');
    out(`${c.bold('Transfer link')} ${c.dim(`(works until ${new Date(link.expiresAt).toLocaleString()}; it carries the passphrase)`)}`);
    out(link.link);
    note(c.dim('On the other panel: torex import <link>, or paste it in Transfers → Import.'));
  }
  out('');
  out(`${c.bold('Passphrase')} ${c.dim('(keep it safe: nothing opens the archive without it)')}`);
  out(created.passphrase);
}

export async function importCommand(command: Command): Promise<void> {
  const api = client(command);
  const source = command.words[0];
  if (source === undefined) throw new CliError('What to import? torex import FILE.torexploy | torex import <transfer link>');
  let passphrase = passphraseFrom(command);
  let started: TransferDto;
  if (/^https?:\/\//i.test(source)) {
    // A transfer link carries its passphrase after #.
    const hash = source.indexOf('#');
    if (passphrase === undefined && hash !== -1 && hash < source.length - 1) passphrase = decodeURIComponent(source.slice(hash + 1));
    started = await api.post<TransferDto>('/api/transfers/import/link', { link: source, ...(passphrase === undefined ? {} : { passphrase }) });
    note(`${c.cyan('→')} The panel is fetching the archive from ${new URL(source).host} (${started.id})`);
  } else {
    const file = resolve(source);
    if (!existsSync(file)) throw new CliError(`No ${file}`);
    started = await upload(api, command.selected?.profile.token ?? null, file);
    note(`${c.green('✓')} Uploaded ${basename(file)} (${started.id})`);
  }
  let transfer = await follow(api, started.id, 'Receiving', (current) => !['receiving'].includes(current.status));
  if (transfer.status === 'failed' || transfer.status === 'cancelled') throw new CliError(`The archive did not arrive: ${transfer.error?.message ?? transfer.status}`);

  let analysis: ImportAnalysisDto;
  if (transfer.status === 'locked') {
    for (let attempt = 0; ; attempt += 1) {
      passphrase ??= await secret('Passphrase: ');
      if (passphrase.length === 0) throw new CliError('The archive needs its passphrase: --passphrase, TOREX_PASSPHRASE, or type it when asked');
      try {
        analysis = await api.post<ImportAnalysisDto>(`/api/transfers/${transfer.id}/unlock`, { passphrase });
        break;
      } catch (error) {
        const wrong = error instanceof Error && /passphrase does not open/i.test(error.message);
        if (!wrong || !interactive() || attempt >= 2 || flag(command.args, 'passphrase') !== undefined) throw error;
        note(c.red('That passphrase does not open this archive.'));
        passphrase = undefined;
      }
    }
  } else {
    analysis = await api.get<ImportAnalysisDto>(`/api/transfers/${transfer.id}/analysis`);
  }

  // Where it lands.
  const serverWord = flag(command.args, 'server');
  let serverId = analysis.serverId;
  if (serverWord !== undefined) {
    const server = analysis.servers.find((candidate) => candidate.id === serverWord || candidate.name.toLowerCase() === serverWord.toLowerCase());
    if (server === undefined) throw new CliError(`No server "${serverWord}". Servers: ${analysis.servers.map((candidate) => candidate.name).join(', ')}`);
    serverId = server.id;
  } else if (analysis.servers.length > 1 && interactive() && !command.yes) {
    serverId = await choose('Which server?', analysis.servers.map((server) => ({ label: `${server.name}${server.host === null ? '' : c.dim(` ${server.host}`)} ${status(server.status)}`, value: server.id })));
  }
  if (serverId === null) throw new CliError('This team has no server to import onto: add one first');
  if (serverId !== analysis.serverId) analysis = await api.get<ImportAnalysisDto>(`/api/transfers/${transfer.id}/analysis`, { serverId });
  const name = flag(command.args, 'name') ?? analysis.suggestedName;

  // What it brings, and where each application's code comes from.
  out(`${c.bold(analysis.project.name)} ${c.dim(`made ${relative(analysis.createdAt)} on TorexPloy ${analysis.panelVersion}${analysis.origin === null ? '' : ` (${analysis.origin})`}`)}`);
  const sources: Record<string, ImportSourceChoice> = {};
  if (analysis.services.length > 0) {
    out(table(['SERVICE', 'TYPE', 'DATA', 'PORT'], analysis.services.map((service) => [service.name, `${service.type} ${service.version}`, service.data ?? c.dim('none'), service.publicPort === null ? c.dim('—') : service.portTaken ? c.red(`${service.publicPort} taken`) : String(service.publicPort)])));
  }
  if (analysis.applications.length > 0) {
    out(
      table(
        ['APPLICATION', 'CODE FROM', 'DOMAINS'],
        analysis.applications.map((app) => {
          const choice = app.sources[0];
          if (choice !== undefined) sources[app.id] = choice;
          const from = choice === 'repository' ? `repository (${app.repositoryAccess?.account ?? app.repositoryAccess?.provider})` : choice === 'archive' ? 'archived code' : choice === 'image' ? 'built image' : app.sourceType === 'image' ? `image ${app.image ?? ''}` : c.yellow('needs a repository');
          return [app.name, from, app.domains.map((domain) => (domain.conflict ? c.red(`${domain.host} (taken)`) : domain.host)).join(', ') || c.dim('—')];
        }),
      ),
    );
  }
  for (const warning of analysis.warnings) note(`${c.yellow('!')} ${warning.message}`);
  const server = analysis.servers.find((candidate) => candidate.id === serverId)!;
  if (!command.yes) {
    if (!interactive()) throw new CliError('Starting the import needs a yes: run it in a terminal or pass --yes');
    if (!(await confirm(`Import as "${name}" onto ${server.name}?`, true))) return;
  }

  const plan = {
    serverId,
    projectName: name,
    sources,
    restoreData: !off(command.args, 'data'),
    domains: !off(command.args, 'domains'),
    publicPorts: !off(command.args, 'ports'),
    deploy: !off(command.args, 'deploy'),
  };
  await api.post(`/api/transfers/${transfer.id}/start`, plan);
  transfer = await follow(api, transfer.id, 'Importing');
  if (command.json) return json(transfer);
  report(transfer);
  if (transfer.status !== 'succeeded') throw new CliError(`The import ${transfer.status}${transfer.error === null ? '' : `: ${transfer.error.message}`}. Retry: torex api POST /api/transfers/${transfer.id}/retry`);
  note(`${c.green('✓')} Imported ${c.bold(name)} onto ${server.name}`);
  if (transfer.projectId !== null) note(c.dim(`See it: torex apps ${JSON.stringify(name)}`));
}

export async function transfersCommand(command: Command): Promise<void> {
  const transfers = await client(command).get<TransferDto[]>('/api/transfers');
  if (command.json) return json(transfers);
  if (transfers.length === 0) return note('No exports or imports yet. Export one: torex export PROJECT');
  out(
    table(
      ['KIND', 'PROJECT', 'STATUS', 'SIZE', 'WHEN', 'ID'],
      transfers.map((transfer) => [transfer.kind, transfer.projectName ?? transfer.fileName, status(transfer.status), transfer.sizeBytes === null ? c.dim('—') : bytes(transfer.sizeBytes), relative(transfer.createdAt), c.dim(transfer.id)]),
    ),
  );
}
