/**
 * The MCP bridge and the snippets that set clients up with it, the raw API,
 * and shell completion.
 */
import { readFileSync } from 'node:fs';
import { runBridge } from '../bridge.ts';
import { flag } from '../args.ts';
import { AGENT, client, type Command } from '../context.ts';
import { c, CliError, note, out } from '../ui.ts';

export async function mcpCommand(command: Command): Promise<void> {
  if (command.words[0] === 'setup' || command.words[0] === 'config') {
    mcpSetup(command, command.words[1]);
    return;
  }
  const selected = command.selected;
  if (selected === null) process.stderr.write('[torex mcp] not signed in: every request will say so until you run torex login\n');
  await runBridge({ url: selected?.profile.url ?? null, token: selected?.profile.token ?? null, agent: AGENT });
}

const CLIENTS = ['claude-code', 'claude-desktop', 'cursor', 'vscode', 'windsurf', 'codex'] as const;

function mcpSetup(command: Command, wanted: string | undefined): void {
  if (command.selected === null) throw new CliError('Sign in first: torex login <panel address>');
  const endpoint = `${command.selected.profile.url}/mcp`;
  const profileArgs = command.selected.fromEnv || command.selected.name === 'default' ? [] : ['--profile', command.selected.name];
  const args = ['mcp', ...profileArgs];
  const script = process.argv[1] ?? 'torex';
  const stdio = { command: 'torex', args };
  const absolute = { command: process.execPath, args: [script, ...args] };
  const block = (value: unknown) => JSON.stringify(value, null, 2);
  const sections: Record<(typeof CLIENTS)[number], string> = {
    'claude-code': [
      `${c.bold('Claude Code')}`,
      c.dim('Signs in through the browser (OAuth):'),
      `  claude mcp add --transport http torexploy ${endpoint}`,
      c.dim('Or through this command line, with its sign-in:'),
      `  claude mcp add torexploy -- torex ${args.join(' ')}`,
    ].join('\n'),
    'claude-desktop': [
      `${c.bold('Claude Desktop and claude.ai')}`,
      c.dim('Settings → Connectors → Add custom connector, with this address (signs in through the browser):'),
      `  ${endpoint}`,
      c.dim('Or in claude_desktop_config.json (Settings → Developer → Edit config):'),
      block({ mcpServers: { torexploy: absolute } }),
    ].join('\n'),
    cursor: [`${c.bold('Cursor')} ${c.dim('(~/.cursor/mcp.json; signs in through the browser)')}`, block({ mcpServers: { torexploy: { url: endpoint } } }), c.dim('or through this command line:'), block({ mcpServers: { torexploy: stdio } })].join('\n'),
    vscode: [`${c.bold('VS Code')} ${c.dim('(.vscode/mcp.json; signs in through the browser)')}`, block({ servers: { torexploy: { type: 'http', url: endpoint } } }), c.dim('or through this command line:'), block({ servers: { torexploy: { type: 'stdio', ...stdio } } })].join('\n'),
    windsurf: [`${c.bold('Windsurf')} ${c.dim('(~/.codeium/windsurf/mcp_config.json)')}`, block({ mcpServers: { torexploy: stdio } })].join('\n'),
    codex: [`${c.bold('Codex')} ${c.dim('(~/.codex/config.toml)')}`, '[mcp_servers.torexploy]', 'command = "torex"', `args = [${args.map((arg) => JSON.stringify(arg)).join(', ')}]`].join('\n'),
  };
  if (wanted !== undefined) {
    const key = CLIENTS.find((name) => name === wanted.toLowerCase() || name.replace('-', '') === wanted.toLowerCase().replace(/[-\s]/g, ''));
    if (key === undefined) throw new CliError(`Unknown client "${wanted}". These have snippets: ${CLIENTS.join(', ')}. Any other client: command "torex", arguments "${args.join(' ')}".`);
    out(sections[key]);
    return;
  }
  out(CLIENTS.map((name) => sections[name]).join('\n\n'));
  note(c.dim(`\nAny other MCP client: run the command "torex ${args.join(' ')}" (stdio), or connect to ${endpoint} (Streamable HTTP with OAuth).`));
}

export async function apiCommand(command: Command): Promise<void> {
  const [methodWord, path] = command.words;
  if (methodWord === undefined || path === undefined) throw new CliError('torex api <METHOD> <path> [--data JSON|@file] [--query key=value]');
  const method = methodWord.toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new CliError(`"${methodWord}" is not an HTTP method`);
  const api = client(command);
  const data = flag(command.args, 'data');
  let body: unknown;
  if (data !== undefined) {
    const text = data.startsWith('@') ? readFileSync(data.slice(1), 'utf8') : data;
    try {
      body = JSON.parse(text);
    } catch {
      throw new CliError('--data must be JSON (or @file.json)');
    }
  }
  const query: Record<string, string> = {};
  const raw = flag(command.args, 'query');
  for (const pair of (raw ?? '').split('&').filter((part) => part.length > 0)) {
    const equals = pair.indexOf('=');
    query[equals === -1 ? pair : pair.slice(0, equals)] = equals === -1 ? '' : pair.slice(equals + 1);
  }
  const response = await api.fetch(method, path.startsWith('/') ? path : `/${path}`, { query, ...(body === undefined ? {} : { body }) });
  const text = await response.text();
  let printed = text;
  try {
    printed = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Not JSON: as it came.
  }
  if (!response.ok) {
    process.stderr.write(`${c.red(`HTTP ${response.status}`)}\n`);
    process.exitCode = 1;
  }
  if (printed.length > 0) out(printed);
}

export function completionCommand(command: Command, names: string[]): void {
  const shell = command.words[0];
  const words = names.join(' ');
  if (shell === 'bash') {
    out(`_torex() {\n  local cur="\${COMP_WORDS[COMP_CWORD]}"\n  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=( $(compgen -W "${words}" -- "$cur") ); fi\n}\ncomplete -F _torex torex`);
    note(c.dim('Add it to ~/.bashrc:  torex completion bash >> ~/.bashrc'));
  } else if (shell === 'zsh') {
    out(`#compdef torex\n_arguments '1: :(${words})' '*::arg:_files'`);
    note(c.dim('Save it as _torex in a folder on $fpath, for example:  torex completion zsh > ~/.zfunc/_torex'));
  } else if (shell === 'fish') {
    out(`complete -c torex -f -n '__fish_use_subcommand' -a '${words}'`);
    note(c.dim('Save it:  torex completion fish > ~/.config/fish/completions/torex.fish'));
  } else {
    throw new CliError('torex completion bash|zsh|fish');
  }
}
