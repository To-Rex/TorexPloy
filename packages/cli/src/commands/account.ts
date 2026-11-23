/**
 * Signing in and out, and which panel and team the command line acts in.
 */
import { spawn } from 'node:child_process';
import type { ApiTokenDto, HealthDto, TeamDto, UserDto } from '../../../shared/src/dto.ts';
import type { CliLoginResultDto, CliLoginStartDto } from '../../../shared/src/mcp.ts';
import { flag, on } from '../args.ts';
import { Client } from '../client.ts';
import { normalizeUrl, profileName, readConfig, removeProfile, saveProfile, writeConfig, type Profile } from '../config.ts';
import { AGENT, client, computerName, VERSION, type Command } from '../context.ts';
import { ask, c, CliError, interactive, json, note, out, spinner, table } from '../ui.ts';

/** Open an address in the person's browser; quietly nothing where there is none. */
export function openBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // No browser here (a server, a container): the address is printed anyway.
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function login(command: Command): Promise<void> {
  const given = command.words[0] ?? flag(command.args, 'url') ?? command.selected?.profile.url ?? (interactive() ? await ask('TorexPloy address (for example https://panel.example.com): ') : undefined);
  if (given === undefined || given.length === 0) throw new CliError('Which panel? torex login https://panel.example.com');
  let url: string;
  try {
    url = normalizeUrl(given);
  } catch {
    throw new CliError(`"${given}" is not an address`);
  }
  const anonymous = new Client(url, null, AGENT);
  const health = await anonymous.get<HealthDto>('/api/health').catch((error: Error) => {
    throw new CliError(`${url} does not answer like a TorexPloy panel: ${error.message}`);
  });
  note(c.dim(`TorexPloy ${health.version} at ${url}`));
  const name = flag(command.args, 'profile') ?? profileName(url);

  const token = flag(command.args, 'token');
  if (token !== undefined) {
    const api = new Client(url, token, AGENT);
    const me = await api.get<UserDto>('/api/me');
    const team = await api.get<TeamDto>('/api/team').catch(() => null);
    const profile: Profile = { url, token, user: me.name, email: me.email, ...(team === null ? {} : { team: team.name, teamId: team.id, role: team.role }) };
    saveProfile(name, profile);
    note(`${c.green('✓')} Signed in to ${c.bold(team?.name ?? url)} as ${c.bold(me.name)} with a token. Profile: ${name}`);
    return;
  }

  const start = await anonymous.post<CliLoginStartDto>('/api/cli/login', { name: computerName(), client: `torex ${VERSION}` });
  note('');
  note(`Open this page and approve the sign-in:\n  ${c.cyan(start.verificationUri)}`);
  note(`The page must show this code:  ${c.bold(start.userCode)}`);
  note('');
  if (!on(command.args, 'no-browser') && process.env.SSH_CONNECTION === undefined) openBrowser(start.verificationUri);
  const wait = spinner('Waiting for you to approve it in the browser…');
  const deadline = Date.now() + start.expiresIn * 1000;
  let result: CliLoginResultDto | null = null;
  try {
    while (Date.now() < deadline) {
      await sleep(start.interval * 1000);
      const response = await anonymous.fetch('GET', `/api/cli/login/${start.code}`);
      if (response.status === 202) continue;
      const body = (await response.json().catch(() => null)) as unknown;
      if (response.status === 200) {
        result = body as CliLoginResultDto;
        break;
      }
      if (response.status === 403) throw new CliError('The sign-in was declined in the browser.');
      throw new CliError('The sign-in expired. Run torex login again.');
    }
  } finally {
    wait.stop();
  }
  if (result === null) throw new CliError('Nobody approved the sign-in in time. Run torex login again.');
  saveProfile(name, { url, token: result.token, user: result.user.name, email: result.user.email, team: result.team.name, teamId: result.team.id, role: result.role, access: result.access });
  note(`${c.green('✓')} Signed in to ${c.bold(result.team.name)} as ${c.bold(result.user.name)} (${result.role}, ${result.access} access). Profile: ${name}`);
  note(c.dim('Next: torex status, torex link, torex deploy'));
}

export async function logout(command: Command): Promise<void> {
  const selected = command.selected;
  if (selected === null || selected.fromEnv) throw new CliError('Not signed in with a saved profile.');
  // The token is revoked on the panel too, when it can still be found there.
  try {
    const api = client(command);
    const tokens = await api.get<ApiTokenDto[]>('/api/tokens');
    const own = tokens.find((token) => selected.profile.token.startsWith(token.prefix) && token.kind === 'cli');
    if (own !== undefined) await api.delete(`/api/tokens/${own.id}`);
  } catch {
    // Offline, or already revoked: forgetting it here is what matters.
  }
  removeProfile(selected.name);
  note(`${c.green('✓')} Signed out of ${selected.profile.url} (profile ${selected.name}).`);
}

export async function whoami(command: Command): Promise<void> {
  const api = client(command);
  const [me, team] = await Promise.all([api.get<UserDto>('/api/me'), api.get<TeamDto>('/api/team').catch(() => null)]);
  const profile = command.selected!.profile;
  if (command.json) {
    json({ url: profile.url, profile: command.selected!.name, user: me, team, access: profile.access ?? null });
    return;
  }
  out(`${c.bold(me.name)} <${me.email}>${me.isInstanceAdmin ? c.dim(' · instance administrator') : ''}`);
  out(`Team:    ${team === null ? '—' : `${team.name} (${team.role})`}`);
  out(`Panel:   ${profile.url}`);
  out(`Profile: ${command.selected!.name}${command.selected!.fromEnv ? ' (from TOREX_URL and TOREX_TOKEN)' : ''}`);
  if (profile.access !== undefined) out(`Access:  ${profile.access}`);
}

export function profiles(command: Command): void {
  const config = readConfig();
  const use = flag(command.args, 'use') ?? (command.words[0] === 'use' ? command.words[1] : undefined);
  if (use !== undefined) {
    if (config.profiles[use] === undefined) throw new CliError(`No profile "${use}". These exist: ${Object.keys(config.profiles).join(', ') || 'none'}`);
    config.current = use;
    writeConfig(config);
    note(`${c.green('✓')} Now using ${use} (${config.profiles[use]!.url}).`);
    return;
  }
  if (command.json) {
    json({ current: config.current, profiles: Object.fromEntries(Object.entries(config.profiles).map(([name, profile]) => [name, { ...profile, token: `${profile.token.slice(0, 11)}…` }])) });
    return;
  }
  const rows = Object.entries(config.profiles).map(([name, profile]) => [`${name === config.current ? c.green('●') : ' '} ${name}`, profile.url, profile.team ?? '—', profile.user ?? '—', profile.access ?? '—']);
  if (rows.length === 0) {
    note('No profiles yet. Sign in: torex login <panel address>');
    return;
  }
  out(table(['  PROFILE', 'PANEL', 'TEAM', 'USER', 'ACCESS'], rows));
  note(c.dim('Switch with: torex profiles use <name>'));
}
