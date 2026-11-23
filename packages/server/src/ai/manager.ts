/**
 * TorexAi's conversations while they run.
 *
 * A message from the person starts a *run*: the model is asked, the tools it
 * calls are planned, approved where needed and carried out, their results go
 * back to the model, and so on until it has nothing left to do. The run lives
 * on the control plane, not in the browser: closing the tab does not stop it,
 * and a dashboard that opens the conversation later is told where it stands
 * and then follows along.
 *
 * Whatever a run does, it does as the person who wrote the message, through
 * the same API and the same role checks as their own clicks.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AI_LIMITS,
  AI_PROVIDER_PRESETS,
  roleAtLeast,
  type AiActionDto,
  type AiChatDto,
  type AiContextInput,
  type AiEvent,
  type AiFileDto,
  type AiMessageDto,
  type AiProviderKind,
  type AiProviderTestDto,
  type AiRunState,
  type AiStatusDto,
  type AiToolName,
  type AiUsageDto,
  type AiViewBlock,
  type TeamRole,
} from '@ploy/shared';
import type { Context } from '../context.ts';
import type { Auth } from '../http/core.ts';
import { AppError, errorMessage } from '../lib/errors.ts';
import { nowIso } from '../lib/ids.ts';
import type { AiActionRecord, AiChatRecord, AiFileRecord, AiMessageRecord } from '../store/index.ts';
import { CodeWorkspaces } from './code.ts';
import { ToolError } from './files.ts';
import { dockerHostShell, sweepShells, type HostShell } from './host.ts';
import { InternalApi, type Actor } from './internal.ts';
import { buildPrompt, contextBlock, SUMMARY_REQUEST, systemPrompt, type AttachmentReader, type StoredRaw } from './prompt.ts';
import { AiSettings, type StoredProvider } from './settings.ts';
import { AiFileStorage } from './storage.ts';
import { findTool, runUndo, toolFailure, toolSpecs, type ToolEnv } from './tools.ts';
import { ProviderError, type AiBlock, type AiUsage, type ChatProvider, type ChatResult, type ToolCall } from './types.ts';

/** Model turns in one run: enough for a long repair job, short of a loop that never ends. */
const MAX_STEPS = 60;
/** How much of a tool's output the model is given at once; the rest is read on request. */
const MODEL_OUTPUT_MAX = 12_000;
const MODEL_OUTPUT_HEAD = 8_500;
/** How much of an output is kept at all. */
const STORED_OUTPUT_MAX = 400_000;
/** How much of it the dashboard is sent with the conversation. */
const PREVIEW_MAX = 6_000;
const MAX_RUNS_PER_USER = 4;
/** A working copy untouched for this long is removed; it is checked out again when needed. */
const WORKSPACE_IDLE_MS = 7 * 24 * 3_600_000;

interface Decision {
  approve: boolean;
  always: boolean;
}

interface Run {
  chatId: string;
  userId: string;
  controller: AbortController;
  state: AiRunState;
  tool: AiToolName | undefined;
  /** The reply as written so far, for a dashboard that joins mid-sentence. */
  draft: string;
  waiters: Map<string, (decision: Decision) => void>;
}

type Listener = (event: AiEvent) => void;

class RunEnded extends Error {
  readonly reason: 'end' | 'stopped' | 'error' | 'limit';
  readonly detail: { code: string; message: string } | undefined;

  constructor(reason: RunEnded['reason'], detail?: { code: string; message: string }) {
    super(detail?.message ?? reason);
    this.reason = reason;
    this.detail = detail;
  }
}

function clipForModel(output: string, actionId: string): string {
  if (output.length <= MODEL_OUTPUT_MAX) return output;
  const tail = MODEL_OUTPUT_MAX - MODEL_OUTPUT_HEAD - 500;
  const omitted = output.length - MODEL_OUTPUT_HEAD - tail;
  return `${output.slice(0, MODEL_OUTPUT_HEAD)}\n\n… [${omitted} characters left out. To read them: read_output with action="${actionId}" and offset=${MODEL_OUTPUT_HEAD}, or with grep to find lines.] …\n\n${output.slice(-tail)}`;
}

/** `2026-11-23`, the day in the instance's time zone: where one day's token allowance ends and the next begins. */
export function dayIn(timezone: string, date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function titleFrom(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  if (flat.length <= 60) return flat;
  const cut = flat.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return `${space > 30 ? cut.slice(0, space) : cut}…`;
}

export class AiManager {
  readonly settings: AiSettings;
  readonly api: InternalApi;
  readonly storage: AiFileStorage;
  readonly workspaces: CodeWorkspaces;
  private readonly ctx: Context;
  private host: HostShell;
  private readonly runs = new Map<string, Run>();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.settings = new AiSettings(ctx.stores.settings, ctx.secrets);
    this.api = new InternalApi(ctx);
    this.storage = new AiFileStorage(ctx.config.dataDir, ctx.stores.ai);
    this.workspaces = new CodeWorkspaces(ctx);
    this.host = dockerHostShell(ctx);
  }

  /** Tests run commands against a script instead of a server. */
  useHost(host: HostShell): void {
    this.host = host;
  }

  /** Close out what a restart interrupted and clear what it left on the servers. */
  start(): void {
    const cancelled = this.ctx.stores.ai.cancelInterrupted();
    if (cancelled > 0) this.ctx.logger.info('TorexAi actions interrupted by a restart were cancelled', { count: cancelled });
    void sweepShells(this.ctx).catch(() => undefined);
  }

  stop(): void {
    for (const run of this.runs.values()) run.controller.abort();
  }

  // ----------------------------------------------------------------- access

  /** What TorexAi is for this person right now. */
  status(auth: Auth): AiStatusDto {
    const settings = this.settings.get();
    const models = this.settings.models();
    const role = auth.role;
    const reason = !settings.enabled ? 'disabled' : models.length === 0 ? 'not_configured' : role === null || !roleAtLeast(role, settings.minRole) ? 'role' : null;
    return {
      ready: reason === null,
      reason,
      models: reason === null ? models : [],
      defaultModel: this.settings.pick(null)?.ref ?? null,
      images: this.settings.imageTarget() !== null,
      canConfigure: auth.user.isInstanceAdmin,
      usage: { today: this.ctx.stores.ai.usedOn(dayIn(this.ctx.stores.settings.timezone()), auth.user.id), limit: settings.dailyTokenLimit },
    };
  }

  /** The caller, when TorexAi is switched on, configured and open to their role. */
  require(auth: Auth | null): Auth & { teamId: string; role: TeamRole } {
    if (auth === null) throw new AppError('unauthorized', 'Authentication required');
    if (auth.teamId === null || auth.role === null) throw new AppError('forbidden', 'You are not a member of any team');
    const status = this.status(auth);
    if (status.reason === 'disabled') throw new AppError('ai_unavailable', 'TorexAi is switched off on this instance', { params: { reason: 'disabled' } });
    if (status.reason === 'not_configured') throw new AppError('ai_unavailable', 'No model provider is connected yet', { params: { reason: 'not_configured' } });
    if (status.reason === 'role') throw new AppError('forbidden', `TorexAi is available from the ${this.settings.get().minRole} role`);
    return auth as Auth & { teamId: string; role: TeamRole };
  }

  // ------------------------------------------------------------------- DTOs

  fileDto(file: AiFileRecord): AiFileDto {
    return { id: file.id, name: file.name, mime: file.mime, size: file.size, kind: file.kind, createdAt: file.createdAt };
  }

  chatDto(chat: AiChatRecord, waiting?: boolean): AiChatDto {
    const run = this.runs.get(chat.id);
    return {
      id: chat.id,
      title: chat.title,
      model: this.settings.pick(chat.model)?.ref ?? null,
      pinned: chat.pinned,
      autoApprove: chat.autoApprove,
      running: run !== undefined,
      waiting: waiting ?? (run !== undefined && run.waiters.size > 0),
      tokens: { input: chat.inputTokens, output: chat.outputTokens },
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    };
  }

  actionDto(action: AiActionRecord, files: AiFileRecord[]): AiActionDto {
    const shown = action.display ?? action.output;
    return {
      id: action.id,
      chatId: action.chatId,
      messageId: action.messageId,
      tool: action.tool,
      title: action.title,
      detail: action.detail,
      preview: action.preview,
      risk: action.risk,
      status: action.status,
      summary: action.summary,
      output: shown === null ? null : shown.slice(0, PREVIEW_MAX),
      outputTruncated: shown !== null && shown.length > PREVIEW_MAX,
      undoable: action.undo !== null && action.undoneAt === null && action.status === 'done',
      undoKind: action.undo?.does ?? null,
      undoneAt: action.undoneAt,
      undoError: action.undoError,
      files: files.filter((file) => file.actionId === action.id && file.kind !== 'snapshot').map((file) => this.fileDto(file)),
      createdAt: action.createdAt,
      finishedAt: action.finishedAt,
    };
  }

  /** A transcript row as the dashboard shows it. Rows that only carry tool results have nothing of their own to show. */
  messageDto(message: AiMessageRecord, actions: AiActionRecord[], files: AiFileRecord[]): AiMessageDto | null {
    if (message.role === 'tool') return null;
    const byCall = new Map(actions.filter((action) => action.messageId === message.id).map((action) => [action.callId, action.id]));
    const blocks: AiViewBlock[] = [];
    for (const block of message.blocks) {
      if (block.type === 'text' && block.text.length > 0) blocks.push({ type: 'text', text: block.text });
      else if (block.type === 'file') {
        const file = files.find((candidate) => candidate.id === block.fileId);
        if (file !== undefined) blocks.push({ type: 'file', file: this.fileDto(file) });
      } else if (block.type === 'tool_call') {
        const actionId = byCall.get(block.id);
        if (actionId !== undefined) blocks.push({ type: 'action', actionId });
      }
    }
    return { id: message.id, seq: message.seq, role: message.role, blocks, model: message.model, usage: message.usage, error: message.error, createdAt: message.createdAt };
  }

  detail(chat: AiChatRecord): { chat: AiChatDto; messages: AiMessageDto[]; actions: AiActionDto[] } {
    const { ai } = this.ctx.stores;
    const actions = ai.listActions(chat.id);
    const files = ai.listFiles(chat.id);
    return {
      chat: this.chatDto(chat),
      messages: ai.listMessages(chat.id).flatMap((message) => this.messageDto(message, actions, files) ?? []),
      actions: actions.map((action) => this.actionDto(action, files)),
    };
  }

  // ------------------------------------------------------------- live events

  subscribe(chatId: string, listener: Listener): () => void {
    let set = this.listeners.get(chatId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(chatId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(chatId);
    };
  }

  snapshot(chat: AiChatRecord): AiEvent {
    const run = this.runs.get(chat.id);
    return { type: 'snapshot', chat: this.chatDto(chat), state: run?.state ?? 'idle', draft: run?.draft ?? '' };
  }

  private emit(chatId: string, event: AiEvent): void {
    for (const listener of this.listeners.get(chatId) ?? []) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not break the run.
      }
    }
  }

  private emitChat(chatId: string): void {
    const chat = this.ctx.stores.ai.getChat(chatId);
    if (chat !== undefined) this.emit(chatId, { type: 'chat', chat: this.chatDto(chat) });
  }

  private emitAction(action: AiActionRecord): void {
    this.emit(action.chatId, { type: 'action', action: this.actionDto(action, this.ctx.stores.ai.listFiles(action.chatId)) });
  }

  private emitMessage(message: AiMessageRecord): void {
    const { ai } = this.ctx.stores;
    const dto = this.messageDto(message, ai.listActions(message.chatId), ai.listFiles(message.chatId));
    if (dto !== null) this.emit(message.chatId, { type: 'message', message: dto });
  }

  private setState(run: Run, state: AiRunState, tool?: AiToolName): void {
    run.state = state;
    run.tool = tool;
    this.emit(run.chatId, { type: 'state', state, ...(tool === undefined ? {} : { tool }) });
  }

  isRunning(chatId: string): boolean {
    return this.runs.has(chatId);
  }

  // ------------------------------------------------------------ conversation

  private toolEnv(actor: Actor, chat: AiChatRecord): ToolEnv {
    return { ctx: this.ctx, actor, chat, api: this.api, settings: this.settings, host: this.host, workspaces: this.workspaces, storage: this.storage, store: this.ctx.stores.ai };
  }

  private place(actor: Actor, context: AiContextInput | undefined): string | null {
    if (context === undefined) return null;
    const { stores } = this.ctx;
    const parts: string[] = [];
    const application = context.applicationId === undefined ? undefined : stores.applications.getForTeam(actor.teamId, context.applicationId);
    if (application !== undefined) parts.push(`the application ${application.id} "${application.name}" (${application.status})`);
    const service = context.serviceId === undefined ? undefined : stores.services.getForTeam(actor.teamId, context.serviceId);
    if (service !== undefined) parts.push(`the ${service.type} service ${service.id} "${service.name}" (${service.status})`);
    const deployment = context.deploymentId === undefined ? undefined : stores.deployments.getForTeam(actor.teamId, context.deploymentId);
    if (deployment !== undefined) parts.push(`the deployment ${deployment.id} (${deployment.status}) of the application ${deployment.applicationId}`);
    const server = context.serverId === undefined ? undefined : stores.servers.getForTeam(actor.teamId, context.serverId);
    if (server !== undefined) parts.push(`the server ${server.id} "${server.name}"`);
    const project = context.projectId === undefined ? undefined : stores.projects.get(context.projectId);
    if (project !== undefined && project.teamId === actor.teamId) parts.push(`the project ${project.id} "${project.name}"`);
    if (parts.length === 0) return context.path === undefined ? null : `the page ${context.path}`;
    return parts.join(', ');
  }

  /** Take a message from the person and start answering it. */
  send(actor: Actor, chat: AiChatRecord, input: { text: string; files: string[]; context?: AiContextInput | undefined; model?: string | undefined }): AiMessageDto {
    const { ai } = this.ctx.stores;
    if (this.runs.has(chat.id)) throw new AppError('ai_busy', 'TorexAi is still answering in this conversation');
    const mine = [...this.runs.values()].filter((run) => run.userId === actor.userId).length;
    if (mine >= MAX_RUNS_PER_USER) throw new AppError('ai_busy', 'Too many conversations are being answered at once; wait for one to finish');
    if (input.model !== undefined) {
      if (this.settings.resolve(input.model) === null) throw new AppError('bad_request', 'That model is not available');
      ai.updateChat(chat.id, { model: input.model });
    }
    if (this.settings.pick(input.model ?? chat.model) === null) throw new AppError('ai_unavailable', 'No model provider is connected yet', { params: { reason: 'not_configured' } });
    this.checkAllowance(actor.userId);
    const attached = input.files.map((id) => {
      const file = ai.getFile(id);
      if (file === undefined || file.chatId !== chat.id || file.kind !== 'upload') throw new AppError('bad_request', 'An attached file does not belong to this conversation');
      return file;
    });
    const auth = this.api.auth(actor);
    const timezone = this.ctx.stores.settings.timezone();
    const now = `${new Intl.DateTimeFormat('en-CA', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date()).replace(',', '')}, ${timezone}`;
    const blocks: AiBlock[] = [
      { type: 'context', text: contextBlock({ role: auth.role, instanceAdmin: auth.user.isInstanceAdmin, now, place: this.place(actor, input.context), notes: ai.takeNotes(chat.id) }) },
      ...attached.map((file): AiBlock => ({ type: 'file', fileId: file.id })),
      { type: 'text', text: input.text },
    ];
    const first = ai.listMessages(chat.id).length === 0;
    const message = ai.appendMessage(chat.id, { role: 'user', blocks });
    ai.updateChat(chat.id, first && chat.title.length === 0 ? { title: titleFrom(input.text) } : {}, true);

    const run: Run = { chatId: chat.id, userId: actor.userId, controller: new AbortController(), state: 'thinking', tool: undefined, draft: '', waiters: new Map() };
    this.runs.set(chat.id, run);
    this.emitMessage(message);
    this.emitChat(chat.id);
    void this.drive(run, actor);
    return this.messageDto(message, [], attached)!;
  }

  /** Stop the reply being written. What was already done stays done. */
  stopRun(chatId: string): boolean {
    const run = this.runs.get(chatId);
    if (run === undefined) return false;
    run.controller.abort();
    return true;
  }

  /** The person's answer to an action waiting for approval. */
  decide(chat: AiChatRecord, actionId: string, decision: Decision): void {
    const run = this.runs.get(chat.id);
    const waiter = run?.waiters.get(actionId);
    if (run === undefined || waiter === undefined) throw new AppError('conflict', 'This action is no longer waiting for an answer');
    run.waiters.delete(actionId);
    waiter(decision);
  }

  /** Take back one action, at the person's own request. */
  async undo(actor: Actor, chat: AiChatRecord, actionId: string): Promise<AiActionRecord> {
    const { ai } = this.ctx.stores;
    const action = ai.getAction(actionId);
    if (action === undefined || action.chatId !== chat.id) throw new AppError('not_found', 'Action not found', { params: { resource: 'action' } });
    if (action.undo === null || action.status !== 'done') throw new AppError('conflict', 'This action cannot be undone');
    if (action.undoneAt !== null) throw new AppError('conflict', 'This action was already undone');
    try {
      await runUndo(action.undo, this.toolEnv(actor, chat));
    } catch (error) {
      const message = error instanceof ToolError ? error.message : errorMessage(error);
      const failed = ai.updateAction(action.id, { undoError: message.slice(0, 1_000) });
      this.emitAction(failed);
      throw new AppError('conflict', `Could not undo: ${message}`);
    }
    const undone = ai.updateAction(action.id, { undoneAt: nowIso(), undoError: null });
    // The model was not there for it: it is told with the person's next message.
    ai.addNote(chat.id, `Since your last reply the person undid the step "${action.title || action.detail}" (undo id ${action.id}) themselves: ${action.undo.label.toLowerCase()}.`);
    this.ctx.stores.audit.record({ teamId: actor.teamId, userId: actor.userId, action: 'ai.undo', targetType: 'ai_action', targetId: action.id, targetName: action.title || action.detail, ip: actor.ip, metadata: { viaAi: chat.id, byHand: true } });
    this.emitAction(undone);
    return undone;
  }

  async deleteChat(chat: AiChatRecord): Promise<void> {
    this.runs.get(chat.id)?.controller.abort();
    this.ctx.stores.ai.deleteChat(chat.id);
    await this.storage.removeChat(chat.id).catch(() => undefined);
    await this.workspaces.remove(chat.id).catch(() => undefined);
  }

  // --------------------------------------------------------------- settings

  async testProvider(input: { id?: string | undefined; kind: AiProviderKind; baseUrl: string; apiKey?: string | undefined }): Promise<AiProviderTestDto> {
    const stored = input.id === undefined ? undefined : this.settings.get().providers.find((provider) => provider.id === input.id);
    const preset = AI_PROVIDER_PRESETS[input.kind];
    let client: ChatProvider;
    if (input.apiKey !== undefined && input.apiKey.length > 0) client = this.settings.probe(input.kind, input.baseUrl, input.apiKey);
    else if (stored !== undefined) client = this.settings.client(stored);
    else client = this.settings.probe(input.kind, input.baseUrl, '');
    try {
      const listed = await client.listModels();
      const chat = listed.chat.slice(0, 200);
      return { ok: true, models: chat.length > 0 ? chat : [...preset.models], imageModels: preset.images ? listed.image.slice(0, 50) : [], error: null };
    } catch (error) {
      const refused = error instanceof ProviderError && (error.status === 401 || error.status === 403);
      // An endpoint without a model list still works when its key is right: offer the models it is known to have.
      if (!refused && preset.models.length > 0 && error instanceof ProviderError && (error.status === 404 || error.status === 405)) {
        return { ok: true, models: [...preset.models], imageModels: [], error: null };
      }
      return { ok: false, models: [], imageModels: [], error: errorMessage(error).slice(0, 500) };
    }
  }

  usage(days: number): AiUsageDto {
    const from = dayIn(this.ctx.stores.settings.timezone(), new Date(Date.now() - (days - 1) * 86_400_000));
    return this.ctx.stores.ai.usageSince(from);
  }

  /** Remove working copies nobody has used for a week, and those of conversations that are gone. */
  async prune(): Promise<void> {
    const root = join(this.ctx.config.dataDir, 'ai', 'workspaces');
    const names = await readdir(root).catch(() => [] as string[]);
    for (const chatId of names) {
      if (this.runs.has(chatId)) continue;
      const chat = this.ctx.stores.ai.getChat(chatId);
      const info = await stat(join(root, chatId)).catch(() => null);
      const idle = chat === undefined || Date.now() - Date.parse(chat.updatedAt) > WORKSPACE_IDLE_MS;
      if (info !== null && idle) await rm(join(root, chatId), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ the run

  private checkAllowance(userId: string): void {
    const limit = this.settings.get().dailyTokenLimit;
    if (limit === null) return;
    const used = this.ctx.stores.ai.usedOn(dayIn(this.ctx.stores.settings.timezone()), userId);
    if (used >= limit) throw new AppError('ai_limit_reached', "Today's token allowance is used up", { params: { limit } });
  }

  private account(actor: Actor, chatId: string, ref: string, usage: AiUsage): void {
    const { ai } = this.ctx.stores;
    ai.addUsage(dayIn(this.ctx.stores.settings.timezone()), actor.userId, actor.teamId, ref, usage);
    ai.addChatTokens(chatId, usage);
  }

  private attachments(): AttachmentReader {
    const { ai } = this.ctx.stores;
    return {
      record: (fileId) => ai.getFile(fileId),
      text: async (file) => {
        const data = await this.storage.read(file).catch(() => null);
        if (data === null || data.subarray(0, 8_000).includes(0)) return null;
        const text = data.toString('utf8');
        return text.length > AI_LIMITS.attachmentTextMax ? `${text.slice(0, AI_LIMITS.attachmentTextMax)}\n… (the rest of the file, ${text.length - AI_LIMITS.attachmentTextMax} characters, is not shown)` : text;
      },
      base64: async (file) => (await this.storage.read(file)).toString('base64'),
    };
  }

  private async ask(run: Run, provider: StoredProvider, model: string, extra: string | null, withTools: boolean): Promise<ChatResult> {
    const client = this.settings.client(provider);
    const history = this.ctx.stores.ai.listMessagesForPrompt(run.chatId);
    const messages = await buildPrompt(history, { family: client.family, providerId: provider.id }, this.attachments());
    if (extra !== null) messages.push({ role: 'user', parts: [{ type: 'text', text: extra }] });
    const settings = this.settings.get();
    return client.chat(
      // The tools are sent even when none should be called: the request then shares its cached prefix with every other one.
      { model, system: systemPrompt(settings.instructions), messages, tools: toolSpecs(), effort: settings.effort, signal: run.controller.signal },
      (event) => {
        if (!withTools) return;
        if (event.type === 'text') {
          run.draft += event.text;
          if (run.state !== 'writing') this.setState(run, 'writing');
          this.emit(run.chatId, { type: 'delta', text: event.text });
        } else if (event.type === 'thinking' && run.state !== 'thinking') this.setState(run, 'thinking');
        else if (event.type === 'tool') this.setState(run, 'tool', event.name as AiToolName);
      },
    );
  }

  /** Replace the transcript so far by the model's own summary of it. Returns false when it could not be made. */
  private async compact(run: Run, actor: Actor, chosen: { ref: string; provider: StoredProvider; model: string }): Promise<boolean> {
    const { ai } = this.ctx.stores;
    try {
      const result = await this.ask(run, chosen.provider, chosen.model, SUMMARY_REQUEST, false);
      this.account(actor, run.chatId, chosen.ref, result.usage);
      const summary = result.text.trim();
      if (summary.length < 40) return false;
      const message = ai.appendMessage(run.chatId, { role: 'summary', blocks: [{ type: 'text', text: summary }], model: chosen.ref, usage: result.usage });
      this.emitMessage(message);
      return true;
    } catch (error) {
      if (run.controller.signal.aborted) throw error;
      this.ctx.logger.warn('TorexAi could not condense a conversation', { chatId: run.chatId, error: errorMessage(error) });
      return false;
    }
  }

  private async drive(run: Run, actor: Actor): Promise<void> {
    const { ai } = this.ctx.stores;
    let ended: RunEnded;
    try {
      ended = await this.loop(run, actor);
    } catch (error) {
      if (error instanceof RunEnded) ended = error;
      else if (run.controller.signal.aborted) ended = new RunEnded('stopped');
      else if (error instanceof ProviderError) ended = new RunEnded('error', { code: 'ai_provider_error', message: error.message });
      else if (error instanceof AppError) ended = new RunEnded(error.code === 'ai_limit_reached' ? 'limit' : 'error', { code: error.code, message: error.message });
      else {
        this.ctx.logger.error('TorexAi run failed', { chatId: run.chatId, error });
        ended = new RunEnded('error', { code: 'internal_error', message: errorMessage(error) });
      }
    }
    // A reply cut short keeps what was written of it.
    if (run.draft.trim().length > 0) {
      const partial = ai.appendMessage(run.chatId, { role: 'assistant', blocks: [{ type: 'text', text: run.draft }], stop: ended.reason, error: ended.detail ?? null });
      run.draft = '';
      this.emitMessage(partial);
    } else if (ended.detail !== undefined) {
      const note = ai.appendMessage(run.chatId, { role: 'assistant', blocks: [], stop: ended.reason, error: ended.detail });
      this.emit(run.chatId, { type: 'message', message: { id: note.id, seq: note.seq, role: 'assistant', blocks: [], model: null, usage: null, error: ended.detail, createdAt: note.createdAt } });
    }
    for (const [actionId, waiter] of run.waiters) {
      run.waiters.delete(actionId);
      waiter({ approve: false, always: false });
    }
    this.runs.delete(run.chatId);
    ai.touchChat(run.chatId);
    this.emit(run.chatId, { type: 'state', state: 'idle' });
    this.emitChat(run.chatId);
    this.emit(run.chatId, { type: 'done', reason: ended.reason, ...(ended.detail === undefined ? {} : { error: ended.detail }) });
  }

  private async loop(run: Run, actor: Actor): Promise<RunEnded> {
    const { ai } = this.ctx.stores;
    let compactedForContext = false;
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const chat = ai.getChat(run.chatId);
      if (chat === undefined) return new RunEnded('stopped');
      const chosen = this.settings.pick(chat.model);
      if (chosen === null) throw new AppError('ai_unavailable', 'No model provider is connected');
      this.checkAllowance(actor.userId);

      // A transcript that has grown long is condensed before it is sent again: every later step is then cheaper.
      const history = ai.listMessagesForPrompt(run.chatId);
      const lastUsage = [...history].reverse().find((message) => message.role === 'assistant' && message.usage !== null)?.usage;
      if (lastUsage != null && lastUsage.input > this.settings.get().compactAt) await this.compact(run, actor, chosen);

      this.setState(run, 'thinking');
      run.draft = '';
      const result = await this.ask(run, chosen.provider, chosen.model, null, true);
      this.account(actor, run.chatId, chosen.ref, result.usage);

      if (result.stop === 'context') {
        // The window is full: condense once and ask again; a second time means even the summary does not fit.
        if (compactedForContext || !(await this.compact(run, actor, chosen))) return new RunEnded('error', { code: 'ai_provider_error', message: 'The conversation no longer fits the model. Start a new one.' });
        compactedForContext = true;
        continue;
      }

      const blocks: AiBlock[] = [];
      if (result.text.length > 0) blocks.push({ type: 'text', text: result.text });
      for (const call of result.calls) blocks.push({ type: 'tool_call', id: call.id, name: call.name, input: call.input });
      const raw: StoredRaw | null = result.raw == null ? null : { family: this.settings.client(chosen.provider).family, providerId: chosen.provider.id, content: result.raw };
      const failure =
        result.stop === 'refusal'
          ? { code: 'ai_refused', message: 'The model declined to answer this.' }
          : result.stop === 'length'
            ? { code: 'ai_cut_off', message: 'The reply was cut off at the length limit.' }
            : null;
      const message = ai.appendMessage(run.chatId, { role: 'assistant', blocks, raw, provider: chosen.provider.kind, model: chosen.ref, stop: result.stop, usage: result.usage, error: failure });
      run.draft = '';
      this.emitMessage(message);
      this.emitChat(run.chatId);

      if (result.calls.length === 0) return new RunEnded(failure === null ? 'end' : 'error');

      const results: AiBlock[] = [];
      let stopped = false;
      for (const call of result.calls) {
        if (stopped || run.controller.signal.aborted) {
          stopped = true;
          results.push({ type: 'tool_result', id: call.id, output: 'Not run: the person stopped the reply.', error: true });
          continue;
        }
        const outcome = await this.runCall(run, actor, message, call);
        results.push({ type: 'tool_result', id: call.id, output: outcome.output, ...(outcome.error ? { error: true } : {}) });
      }
      ai.appendMessage(run.chatId, { role: 'tool', blocks: results });
      if (stopped || run.controller.signal.aborted) return new RunEnded('stopped');
    }
    return new RunEnded('limit', { code: 'ai_step_limit', message: `TorexAi stopped after ${MAX_STEPS} steps. Send "continue" to let it go on.` });
  }

  private waitForDecision(run: Run, actionId: string): Promise<Decision> {
    return new Promise((resolve) => {
      run.waiters.set(actionId, resolve);
      run.controller.signal.addEventListener('abort', () => {
        if (run.waiters.delete(actionId)) resolve({ approve: false, always: false });
      }, { once: true });
    });
  }

  private async runCall(run: Run, actor: Actor, message: AiMessageRecord, call: ToolCall): Promise<{ output: string; error: boolean }> {
    const { ai } = this.ctx.stores;
    const definition = findTool(call.name);
    if (definition === undefined) return { output: `There is no tool called "${call.name}".`, error: true };
    if (call.invalid !== undefined) return { output: `The arguments were not a JSON object and the call was not run. What arrived: ${call.invalid}`, error: true };
    const chat = ai.getChat(run.chatId);
    if (chat === undefined) return { output: 'The conversation was deleted.', error: true };
    const env = this.toolEnv(actor, chat);
    const tool = definition.spec.name;

    let plan;
    try {
      plan = await definition.plan(call.input, env);
    } catch (error) {
      const text = toolFailure(error);
      if (!(error instanceof ToolError) && !(error instanceof AppError)) this.ctx.logger.warn('A TorexAi tool could not be planned', { tool, error: errorMessage(error) });
      // Shown as a step that did not happen, so the person sees why the assistant changed course.
      const failed = ai.createAction({ chatId: chat.id, messageId: message.id, callId: call.id, tool, title: '', detail: '', preview: null, input: call.input, risk: 'safe', status: 'failed' });
      this.emitAction(ai.updateAction(failed.id, { summary: text.slice(0, 500), output: text, finishedAt: nowIso() }));
      return { output: text, error: true };
    }

    const asks = plan.risk === 'danger' || plan.confirm === true || (plan.risk === 'change' && !chat.autoApprove);
    let action = ai.createAction({ chatId: chat.id, messageId: message.id, callId: call.id, tool, title: plan.title, detail: plan.detail, preview: plan.preview ?? null, input: call.input, risk: plan.risk, status: asks ? 'pending' : 'running' });
    this.emitAction(action);

    if (asks) {
      this.setState(run, 'waiting', tool);
      this.emitChat(chat.id);
      const decision = await this.waitForDecision(run, action.id);
      if (run.controller.signal.aborted) {
        this.emitAction(ai.updateAction(action.id, { status: 'cancelled', finishedAt: nowIso() }));
        return { output: 'Not run: the person stopped the reply before answering.', error: true };
      }
      if (!decision.approve) {
        this.emitAction(ai.updateAction(action.id, { status: 'rejected', finishedAt: nowIso() }));
        this.emitChat(chat.id);
        return { output: 'The person declined this action, so it was not run. Do not try it again or reach the same result another way; ask them what they would like instead.', error: true };
      }
      if (decision.always && plan.risk === 'change') ai.updateChat(chat.id, { autoApprove: true });
      action = ai.updateAction(action.id, { status: 'running' });
      this.emitAction(action);
      this.emitChat(chat.id);
    }

    this.setState(run, 'tool', tool);
    try {
      const outcome = await plan.run(run.controller.signal);
      const failed = outcome.error === true;
      const undo = failed ? null : (outcome.undo ?? null);
      for (const fileId of outcome.fileIds ?? []) ai.setFileAction(fileId, action.id);
      action = ai.updateAction(action.id, {
        status: failed ? 'failed' : 'done',
        summary: outcome.summary.slice(0, 500),
        output: outcome.output.slice(0, STORED_OUTPUT_MAX),
        display: outcome.display === undefined ? null : outcome.display.slice(0, STORED_OUTPUT_MAX),
        undo,
        finishedAt: nowIso(),
      });
      this.emitAction(action);
      const forModel = clipForModel(outcome.output, action.id);
      return { output: undo === null ? forModel : `${forModel}\n(undo id: ${action.id})`, error: failed };
    } catch (error) {
      if (run.controller.signal.aborted) {
        this.emitAction(ai.updateAction(action.id, { status: 'cancelled', summary: 'Stopped', finishedAt: nowIso() }));
        return { output: 'Stopped by the person before it finished. It may have taken effect in part.', error: true };
      }
      const text = toolFailure(error);
      if (!(error instanceof ToolError) && !(error instanceof AppError) && !(error instanceof ProviderError)) this.ctx.logger.warn('A TorexAi tool failed', { tool, error: errorMessage(error) });
      this.emitAction(ai.updateAction(action.id, { status: 'failed', summary: text.slice(0, 500), output: text, finishedAt: nowIso() }));
      return { output: text, error: true };
    }
  }
}
