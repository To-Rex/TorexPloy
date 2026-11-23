/**
 * `torex ai`: TorexAi in the terminal. A question as words after the command
 * gets one answer; without one it is a conversation. Steps that change
 * something are shown and asked about here, as the dashboard would ask.
 */
import { createInterface } from 'node:readline/promises';
import type { AiActionDto, AiChatDto, AiEvent, AiStatusDto } from '../../../shared/src/ai.ts';
import { flag } from '../args.ts';
import type { Client } from '../client.ts';
import { client, type Command } from '../context.ts';
import { ask, c, CliError, interactive, note } from '../ui.ts';

const REASONS: Record<string, string> = {
  disabled: 'TorexAi is switched off on this panel.',
  not_configured: 'TorexAi is not set up yet: the instance administrator connects a model provider in Settings → TorexAi.',
  role: 'TorexAi is open from a higher role than yours in this team.',
  limit: "Today's token allowance is used up.",
};

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (text += chunk));
    process.stdin.on('end', () => resolve(text));
  });
}

class Turn {
  private readonly shown = new Map<string, string>();
  private atLineStart = true;

  private readonly api: Client;
  /** How a question is asked: the conversation's own prompt, so two readers never share the keyboard. */
  private readonly question: (text: string) => Promise<string>;

  constructor(api: Client, question: (text: string) => Promise<string>) {
    this.api = api;
    this.question = question;
  }

  private write(text: string): void {
    if (text.length === 0) return;
    process.stdout.write(text);
    this.atLineStart = text.endsWith('\n');
  }

  private line(text: string): void {
    if (!this.atLineStart) this.write('\n');
    this.write(`${text}\n`);
  }

  private label(action: AiActionDto): string {
    const what = action.title.length > 0 ? action.title : action.tool;
    return `${what}${action.detail.length > 0 ? c.dim(`  ${action.detail.length > 100 ? `${action.detail.slice(0, 99)}…` : action.detail}`) : ''}`;
  }

  /** A step, each time its state changes. A step that waits is asked about. */
  async action(action: AiActionDto): Promise<void> {
    if (this.shown.get(action.id) === action.status) return;
    this.shown.set(action.id, action.status);
    if (action.status === 'running') this.line(`${c.cyan('•')} ${this.label(action)}`);
    else if (action.status === 'done') this.line(`${c.green('✓')} ${this.label(action)}${action.summary === null || action.summary.length === 0 ? '' : c.dim(`  ${action.summary}`)}`);
    else if (action.status === 'failed') this.line(`${c.red('✗')} ${this.label(action)}${action.summary === null ? '' : c.dim(`  ${action.summary}`)}`);
    else if (action.status === 'rejected') this.line(`${c.yellow('–')} ${this.label(action)} ${c.dim('(declined)')}`);
    else if (action.status === 'pending') await this.approve(action);
  }

  private async approve(action: AiActionDto): Promise<void> {
    const danger = action.risk === 'danger';
    this.line(`${danger ? c.red('▲ Dangerous step') : c.yellow('? A step that changes something')}: ${c.bold(action.title.length > 0 ? action.title : action.tool)}`);
    if (action.detail.length > 0) this.line(c.dim(`  ${action.detail}`));
    if (action.preview !== null && action.preview.length > 0) this.line(c.dim(action.preview.split('\n').slice(0, 12).map((row) => `  │ ${row}`).join('\n')));
    if (!interactive()) {
      this.line(c.yellow('  Waiting for an answer in the dashboard (this terminal cannot ask).'));
      return;
    }
    const answer = (await this.question(danger ? '  Allow it? [y/N] ' : '  Allow it? [y/N, a = allow such changes for this conversation] ')).trim().toLowerCase();
    const approve = answer === 'y' || answer === 'yes' || answer === 'ha' || (!danger && answer === 'a');
    await this.api.post(`/api/ai/actions/${action.id}/decision`, { approve, always: !danger && answer === 'a' });
    this.atLineStart = true;
  }

  /** Send one message and show the reply as it comes; resolves when the reply has ended. */
  async run(chatId: string, text: string): Promise<'end' | 'stopped' | 'error' | 'limit'> {
    const controller = new AbortController();
    let ready!: () => void;
    const subscribed = new Promise<void>((resolve) => (ready = resolve));
    let reason: 'end' | 'stopped' | 'error' | 'limit' = 'end';
    const interrupt = () => {
      reason = 'stopped';
      void this.api.post(`/api/ai/chats/${chatId}/stop`).catch(() => undefined);
    };
    process.once('SIGINT', interrupt);
    const streaming = this.api
      .stream(
        `/api/ai/chats/${chatId}/events`,
        {},
        async (event) => {
          if (event.event !== 'ai') return undefined;
          const message = JSON.parse(event.data) as AiEvent;
          if (message.type === 'snapshot') ready();
          else if (message.type === 'delta') this.write(message.text);
          else if (message.type === 'action') await this.action(message.action);
          else if (message.type === 'done') {
            if (reason !== 'stopped') reason = message.reason;
            if (message.reason === 'error' && message.error !== undefined) this.line(c.red(`✗ ${message.error.message}`));
            if (message.reason === 'limit') this.line(c.yellow("TorexAi reached the steps it may take for one message; say 'continue' to go on."));
            return false;
          }
          return undefined;
        },
        controller.signal,
      )
      .catch((error: unknown) => {
        ready();
        throw error;
      });
    try {
      await subscribed;
      await this.api.post(`/api/ai/chats/${chatId}/messages`, { text, files: [] });
      await streaming;
    } finally {
      process.removeListener('SIGINT', interrupt);
      controller.abort();
      if (!this.atLineStart) this.write('\n');
    }
    return reason;
  }
}

export async function aiCommand(command: Command): Promise<void> {
  const api = client(command);
  const state = await api.get<AiStatusDto>('/api/ai');
  if (!state.ready) throw new CliError(REASONS[state.reason ?? ''] ?? 'TorexAi is not available to you right now.');
  const model = flag(command.args, 'model');
  let chatId = flag(command.args, 'chat') ?? (await api.post<AiChatDto>('/api/ai/chats', model === undefined ? {} : { model })).id;
  let message = command.words.join(' ').trim();
  if (message.length === 0 && !process.stdin.isTTY) message = (await readStdin()).trim();
  const dashboard = `${command.selected!.profile.url}/ai/${chatId}`;

  if (message.length > 0) {
    const reason = await new Turn(api, (text) => ask(text)).run(chatId, message);
    note(c.dim(`Continue: torex ai --chat ${chatId} "…"  ·  ${dashboard}`));
    if (reason === 'error') process.exitCode = 1;
    return;
  }
  if (!interactive()) throw new CliError('Ask something: torex ai "why did the last deploy of api fail?"');
  note(c.dim(`TorexAi · ${dashboard}\nAsk anything about your servers and applications. /new starts afresh, /exit or Ctrl+D leaves.`));
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  const turn = new Turn(api, (text) => reader.question(text));
  try {
    for (;;) {
      let text: string;
      try {
        text = (await reader.question(c.cyan('› '))).trim();
      } catch {
        break;
      }
      if (text.length === 0) continue;
      if (text === '/exit' || text === '/quit') break;
      if (text === '/new') {
        chatId = (await api.post<AiChatDto>('/api/ai/chats', model === undefined ? {} : { model })).id;
        note(c.dim(`A new conversation: ${command.selected!.profile.url}/ai/${chatId}`));
        continue;
      }
      await turn.run(chatId, text);
    }
  } finally {
    reader.close();
  }
}
