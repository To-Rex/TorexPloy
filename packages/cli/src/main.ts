/**
 * torex: TorexPloy from the terminal.
 *
 * Sign in once (`torex login`, which asks for a yes in the browser), link a
 * folder to an application, then deploy, upload, read logs, change variables
 * and domains, ask TorexAi, or hand the platform to an AI agent as an MCP
 * server (`torex mcp`). Everything acts as the person who signed in, with
 * their role in the team and the reach they chose for this computer.
 */
import { on, parseArgs } from './args.ts';
import { ApiError } from './client.ts';
import { commandOf, VERSION, type Command } from './context.ts';
import { login, logout, profiles, whoami } from './commands/account.ts';
import { aiCommand } from './commands/ai.ts';
import { deployCommand, deploymentsCommand, lifecycleCommand, logsCommand, rollbackCommand, upCommand } from './commands/deploy.ts';
import { appsCommand, infoCommand, linkCommand, openCommand, projectsCommand, serversCommand, servicesCommand, statusCommand, unlinkCommand } from './commands/platform.ts';
import { domainsCommand, envCommand } from './commands/settings.ts';
import { apiCommand, completionCommand, mcpCommand } from './commands/tools.ts';
import { c, CliError, out, setColour } from './ui.ts';

interface Entry {
  usage: string;
  summary: string;
  group: string;
  run: (command: Command) => Promise<void> | void;
}

const COMMANDS: Record<string, Entry> = {
  login: { group: 'Account', usage: 'login [url] [--token T] [--profile NAME] [--no-browser]', summary: 'Sign in to a TorexPloy panel (approve it in the browser)', run: login },
  logout: { group: 'Account', usage: 'logout', summary: 'Sign out here and revoke this sign-in', run: logout },
  whoami: { group: 'Account', usage: 'whoami', summary: 'Who, which team and which panel', run: whoami },
  profiles: { group: 'Account', usage: 'profiles [use NAME]', summary: 'Sign-ins to several panels or teams, and switching between them', run: profiles },
  status: { group: 'Overview', usage: 'status', summary: 'Applications, services and servers at a glance', run: statusCommand },
  projects: { group: 'Overview', usage: 'projects', summary: 'List projects', run: projectsCommand },
  apps: { group: 'Overview', usage: 'apps [PROJECT]', summary: 'List applications', run: appsCommand },
  services: { group: 'Overview', usage: 'services [PROJECT]', summary: 'List databases and other services', run: servicesCommand },
  servers: { group: 'Overview', usage: 'servers', summary: 'List servers', run: serversCommand },
  link: { group: 'Applications', usage: 'link [APP]', summary: 'Link this folder to an application', run: linkCommand },
  unlink: { group: 'Applications', usage: 'unlink', summary: 'Forget the link of this folder', run: unlinkCommand },
  info: { group: 'Applications', usage: 'info [APP]', summary: 'Settings, status, domains and the latest deployment', run: infoCommand },
  deploy: { group: 'Applications', usage: 'deploy [APP] [--no-wait] [--clear-cache]', summary: 'Deploy and follow the build to its end', run: deployCommand },
  up: { group: 'Applications', usage: 'up [DIR] [--app APP] [--no-deploy] [--include-env]', summary: "Upload this folder's code and deploy it", run: upCommand },
  deployments: { group: 'Applications', usage: 'deployments [APP]', summary: 'Recent deployments', run: deploymentsCommand },
  logs: { group: 'Applications', usage: 'logs [APP|SERVICE-ID] [-f] [--tail N] [--since 10m] [--service NAME] | logs --deployment ID', summary: 'Runtime logs, or a deployment’s build log', run: logsCommand },
  rollback: { group: 'Applications', usage: 'rollback [APP] [DEPLOYMENT]', summary: 'Deploy the previous good version again', run: rollbackCommand },
  restart: { group: 'Applications', usage: 'restart [APP]', summary: 'Restart an application', run: (command) => lifecycleCommand(command, 'restart') },
  stop: { group: 'Applications', usage: 'stop [APP]', summary: 'Stop an application', run: (command) => lifecycleCommand(command, 'stop') },
  start: { group: 'Applications', usage: 'start [APP]', summary: 'Start a stopped application', run: (command) => lifecycleCommand(command, 'start') },
  open: { group: 'Applications', usage: 'open [APP] [--dashboard]', summary: 'Open the site (or its page in the dashboard)', run: openCommand },
  env: { group: 'Applications', usage: 'env [APP] [--reveal] | env set K=V… | env unset K… | env pull [FILE] | env push [FILE]  [--app APP] [--deploy]', summary: 'Environment variables', run: envCommand },
  domains: { group: 'Applications', usage: 'domains [APP] | domains add HOST [--port N] | domains remove HOST  [--app APP]', summary: 'Domains', run: domainsCommand },
  ai: { group: 'TorexAi and MCP', usage: 'ai [MESSAGE] [--chat ID] [--model REF]', summary: 'Ask TorexAi; without a message, a conversation', run: aiCommand },
  mcp: { group: 'TorexAi and MCP', usage: 'mcp | mcp setup [claude-code|claude-desktop|cursor|vscode|windsurf|codex]', summary: 'Be an MCP server on stdio, or print how to connect a client', run: mcpCommand },
  api: { group: 'Other', usage: 'api METHOD PATH [--data JSON|@FILE] [--query k=v&…]', summary: 'Call the API and print the answer', run: apiCommand },
  completion: { group: 'Other', usage: 'completion bash|zsh|fish', summary: 'Shell completion', run: (command) => completionCommand(command, Object.keys(COMMANDS)) },
};

const ALIASES: Record<string, string> = { ls: 'apps', app: 'info', log: 'logs', variables: 'env', vars: 'env', domain: 'domains', signin: 'login', signout: 'logout', me: 'whoami', profile: 'profiles' };

function help(): string {
  const groups = new Map<string, [string, Entry][]>();
  for (const [name, entry] of Object.entries(COMMANDS)) groups.set(entry.group, [...(groups.get(entry.group) ?? []), [name, entry]]);
  const lines = [`${c.bold('torex')} ${c.dim(VERSION)}  TorexPloy from the terminal`, '', `${c.bold('Usage:')} torex <command> [options]`];
  for (const [group, entries] of groups) {
    lines.push('', c.bold(group));
    for (const [name, entry] of entries) lines.push(`  ${name.padEnd(12)} ${entry.summary}`);
  }
  lines.push(
    '',
    c.bold('Options'),
    '  --json            Machine-readable output',
    '  --profile NAME    Use another sign-in (see torex profiles)',
    '  --yes, -y         Do not ask before acting',
    '  --no-color        No colours',
    '',
    c.dim('APP is an id, a name, or project/name; in a linked folder it can be left out.'),
    c.dim('CI: set TOREX_URL and TOREX_TOKEN instead of signing in. More: torex help <command>'),
  );
  return lines.join('\n');
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.get('color') === 'false') setColour(false);
  const first = args.words[0];
  if (first === 'version' || (on(args, 'version') && first === undefined)) {
    out(VERSION);
    return 0;
  }
  if (first === undefined || first === 'help') {
    const topic = first === 'help' ? args.words[1] : undefined;
    const entry = topic === undefined ? undefined : COMMANDS[ALIASES[topic] ?? topic];
    out(entry === undefined ? help() : `${c.bold('Usage:')} torex ${entry.usage}\n\n${entry.summary}`);
    return 0;
  }
  const name = ALIASES[first] ?? first;
  const entry = COMMANDS[name];
  if (entry === undefined) {
    process.stderr.write(`${c.red('✗')} Unknown command "${first}". See: torex help\n`);
    return 2;
  }
  if (on(args, 'help')) {
    out(`${c.bold('Usage:')} torex ${entry.usage}\n\n${entry.summary}`);
    return 0;
  }
  try {
    await entry.run(commandOf(args));
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (error) {
    if (error instanceof CliError || error instanceof ApiError) {
      process.stderr.write(`${c.red('✗')} ${error.message}\n`);
      return error.exitCode;
    }
    if ((error as Error).name === 'AbortError') return 130;
    process.stderr.write(`${c.red('✗')} ${(error as Error).message}\n`);
    if (process.env.TOREX_DEBUG !== undefined) process.stderr.write(`${(error as Error).stack ?? ''}\n`);
    return 1;
  }
}

// Run when started as a program (not when a test imports it).
const started = process.argv[1] ?? '';
if (/torex(\.mjs)?$|main\.ts$|torex\.cmd$/.test(started) || process.env.TOREX_MAIN === '1') {
  const finish = (code: number): void => {
    process.exitCode = code;
    // Idle connections to the panel can hold the process open for a few seconds: once the output is out, leave.
    setTimeout(() => process.stdout.write('', () => process.exit(code)), 100).unref();
  };
  main(process.argv.slice(2)).then(finish, (error: unknown) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    finish(1);
  });
}
