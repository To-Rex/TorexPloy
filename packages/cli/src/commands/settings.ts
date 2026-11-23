/**
 * An application's variables and domains.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDotenv, toDotenv, type DotenvVariable } from '../../../shared/src/dotenv.ts';
import type { DeploymentDto, DomainDto, VariablesDto } from '../../../shared/src/dto.ts';
import { flag, on } from '../args.ts';
import type { Client } from '../client.ts';
import { client, resolveApp, type AppRef, type Command } from '../context.ts';
import { c, CliError, confirm, interactive, json, note, out, status, table } from '../ui.ts';
import { follow } from './deploy.ts';

const ENV_SUBCOMMANDS = new Set(['set', 'unset', 'pull', 'push', 'list', 'ls']);

async function save(api: Client, ref: AppRef, variables: DotenvVariable[], command: Command, said: string): Promise<void> {
  await api.put(`/api/applications/${ref.app.id}/variables`, { variables });
  note(`${c.green('✓')} ${said} on ${c.bold(ref.app.name)}.`);
  if (on(command.args, 'deploy')) {
    const started = await api.post<DeploymentDto>(`/api/applications/${ref.app.id}/deploy`, {});
    note(`${c.cyan('→')} Deploying (${started.id})`);
    const result = await follow(api, started, false);
    if (result.status !== 'succeeded') process.exitCode = 1;
    note(result.status === 'succeeded' ? `${c.green('✓')} Deployed` : `${c.red('✗')} The deployment ${result.status}`);
  } else {
    note(c.dim('They take effect with the next deployment: torex deploy (or pass --deploy).'));
  }
}

export async function envCommand(command: Command): Promise<void> {
  const api = client(command);
  const sub = ENV_SUBCOMMANDS.has(command.words[0] ?? '') ? command.words[0]! : 'list';
  const rest = sub === 'list' && !ENV_SUBCOMMANDS.has(command.words[0] ?? '') ? command.words : command.words.slice(1);
  const appWord = sub === 'list' ? rest[0] : undefined;
  const ref = await resolveApp(command, api, appWord);
  const current = await api.get<VariablesDto>(`/api/applications/${ref.app.id}/variables`);

  if (sub === 'list' || sub === 'ls') {
    if (command.json) return json(on(command.args, 'reveal') ? current : { ...current, variables: current.variables.map((variable) => ({ key: variable.key })) });
    if (current.variables.length === 0 && current.inherited.length === 0) return note(`${ref.app.name} has no variables. Add some: torex env set KEY=value`);
    const reveal = on(command.args, 'reveal');
    for (const variable of current.variables) out(`${c.bold(variable.key)}=${reveal ? variable.value : c.dim('••••••')}`);
    for (const inherited of current.inherited) out(`${c.dim(`${inherited.key}  (from ${inherited.source})`)}`);
    if (!reveal && current.variables.length > 0) note(c.dim('Values are hidden; show them with --reveal.'));
    return;
  }

  if (sub === 'set') {
    const assignments = rest.filter((word) => word.length > 0);
    if (assignments.length === 0) throw new CliError('Nothing to set. torex env set KEY=value [KEY2=value2 …]');
    const next = [...current.variables];
    for (const assignment of assignments) {
      const equals = assignment.indexOf('=');
      if (equals <= 0) throw new CliError(`"${assignment}" is not KEY=value`);
      const key = assignment.slice(0, equals);
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) throw new CliError(`"${key}" is not a variable name`);
      const value = assignment.slice(equals + 1);
      const index = next.findIndex((variable) => variable.key === key);
      if (index === -1) next.push({ key, value });
      else next[index] = { key, value };
    }
    return save(api, ref, next, command, `Set ${assignments.length} variable${assignments.length === 1 ? '' : 's'}`);
  }

  if (sub === 'unset') {
    if (rest.length === 0) throw new CliError('Which variables? torex env unset KEY [KEY2 …]');
    const missing = rest.filter((key) => !current.variables.some((variable) => variable.key === key));
    if (missing.length > 0) throw new CliError(`${ref.app.name} has no ${missing.join(', ')}`);
    return save(api, ref, current.variables.filter((variable) => !rest.includes(variable.key)), command, `Removed ${rest.join(', ')}`);
  }

  const file = resolve(rest[0] ?? flag(command.args, 'file') ?? '.env');
  if (sub === 'pull') {
    if (existsSync(file) && !command.yes && !(await confirm(`${file} exists. Replace it?`, false))) return;
    const text = toDotenv(current.variables);
    writeFileSync(file, text.length === 0 || text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
    note(`${c.green('✓')} Wrote ${current.variables.length} variables of ${ref.app.name} to ${file}`);
    return;
  }

  // push
  if (!existsSync(file)) throw new CliError(`No ${file}`);
  const parsed = parseDotenv(readFileSync(file, 'utf8'));
  if (parsed.badLine !== null) throw new CliError(`${file}, line ${parsed.badLine}: not KEY=value`);
  const before = new Map(current.variables.map((variable) => [variable.key, variable.value]));
  const after = new Map(parsed.variables.map((variable) => [variable.key, variable.value]));
  const added = [...after.keys()].filter((key) => !before.has(key));
  const changed = [...after.keys()].filter((key) => before.has(key) && before.get(key) !== after.get(key));
  const removed = [...before.keys()].filter((key) => !after.has(key));
  if (added.length + changed.length + removed.length === 0) return note(`${ref.app.name} already has exactly these variables.`);
  note(`${c.green(`+${added.length}`)} ${c.yellow(`~${changed.length}`)} ${c.red(`-${removed.length}`)}  ${[...added.map((key) => c.green(key)), ...changed.map((key) => c.yellow(key)), ...removed.map((key) => c.red(key))].join(' ')}`);
  if (!command.yes) {
    if (!interactive()) throw new CliError('Replacing variables needs a yes: run it in a terminal or pass --yes');
    if (!(await confirm(`Replace the variables of ${ref.app.name} with ${file}?`, false))) return;
  }
  return save(api, ref, parsed.variables, command, `Replaced the variables with ${file}`);
}

export async function domainsCommand(command: Command): Promise<void> {
  const api = client(command);
  const sub = command.words[0] === 'add' || command.words[0] === 'remove' || command.words[0] === 'rm' ? command.words[0] : 'list';
  const ref = await resolveApp(command, api, sub === 'list' ? command.words[0] : undefined);
  const domains = await api.get<DomainDto[]>(`/api/applications/${ref.app.id}/domains`);
  if (sub === 'list') {
    if (command.json) return json(domains);
    if (domains.length === 0) return note(`${ref.app.name} has no domains. Add one: torex domains add app.example.com`);
    out(table(['DOMAIN', 'PORT', 'DNS', 'HTTPS', 'ID'], domains.map((domain) => [`${domain.https ? 'https' : 'http'}://${domain.host}${domain.path === '/' ? '' : domain.path}${domain.redirectTo === null ? '' : c.dim(` → ${domain.redirectTo}`)}`, domain.port === null ? c.dim('app') : String(domain.port), status(domain.dns.status), domain.https ? status(domain.tls.status) : c.dim('off'), c.dim(domain.id)])));
    return;
  }
  const host = command.words[1];
  if (host === undefined) throw new CliError(`Which domain? torex domains ${sub} app.example.com`);
  if (sub === 'add') {
    const port = flag(command.args, 'port');
    const created = await api.post<DomainDto>(`/api/applications/${ref.app.id}/domains`, { host, ...(port === undefined ? {} : { port: Number(port) }) });
    note(`${c.green('✓')} Added ${c.bold(created.host)} to ${ref.app.name}.`);
    if (created.dns.status !== 'ok') note(c.dim(`Point its DNS at the server${created.dns.expected === null ? '' : ` (an A record to ${created.dns.expected})`}; HTTPS follows by itself once it resolves.`));
    return;
  }
  const domain = domains.find((candidate) => candidate.host === host.toLowerCase() || candidate.id === host);
  if (domain === undefined) throw new CliError(`${ref.app.name} has no domain ${host}`);
  if (!command.yes && !(await confirm(`Remove ${domain.host} from ${ref.app.name}?`, false))) return;
  await api.delete(`/api/domains/${domain.id}`);
  note(`${c.green('✓')} Removed ${domain.host}.`);
}
