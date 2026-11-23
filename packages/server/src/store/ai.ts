/**
 * TorexAi's records: conversations, their transcript, the actions the
 * assistant took, the files of a conversation and the tokens used.
 */
import type { AiActionStatus, AiFileKind, AiRisk, AiToolName } from '@ploy/shared';
import type { AiBlock, AiRole, AiUsage, UndoRecipe } from '../ai/types.ts';
import type { Database } from '../db/database.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { bool, int01, json, num, numOrNull, str, strOrNull, type Row } from './util.ts';

export interface AiChatRecord {
  id: string;
  userId: string;
  teamId: string;
  /** A conversation with TorexAi, or the record of what an MCP connection did. */
  kind: 'chat' | 'mcp';
  /** The MCP connection it records (`grant:<id>` or `token:<id>`). */
  connection: string | null;
  title: string;
  model: string | null;
  pinned: boolean;
  autoApprove: boolean;
  notes: string[];
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  updatedAt: string;
}

export interface AiMessageRecord {
  id: string;
  chatId: string;
  seq: number;
  role: AiRole;
  blocks: AiBlock[];
  raw: unknown;
  provider: string | null;
  model: string | null;
  stop: string | null;
  usage: AiUsage | null;
  error: { code: string; message: string } | null;
  createdAt: string;
}

export interface AiActionRecord {
  id: string;
  chatId: string;
  messageId: string;
  callId: string;
  tool: AiToolName;
  title: string;
  detail: string;
  preview: string | null;
  input: Record<string, unknown>;
  risk: AiRisk;
  status: AiActionStatus;
  summary: string | null;
  output: string | null;
  display: string | null;
  undo: UndoRecipe | null;
  undoneAt: string | null;
  undoError: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AiFileRecord {
  id: string;
  chatId: string;
  actionId: string | null;
  kind: AiFileKind;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}

export interface AiMessageInput {
  role: AiRole;
  blocks: AiBlock[];
  raw?: unknown;
  provider?: string | null;
  model?: string | null;
  stop?: string | null;
  usage?: AiUsage | null;
  error?: { code: string; message: string } | null;
}

export interface AiActionInput {
  chatId: string;
  messageId: string;
  callId: string;
  tool: AiToolName;
  title: string;
  detail: string;
  preview: string | null;
  input: Record<string, unknown>;
  risk: AiRisk;
  status: AiActionStatus;
}

export type AiActionPatch = Partial<Pick<AiActionRecord, 'status' | 'summary' | 'output' | 'display' | 'undo' | 'undoneAt' | 'undoError' | 'finishedAt'>>;

function mapChat(row: Row): AiChatRecord {
  return {
    id: str(row.id),
    userId: str(row.user_id),
    teamId: str(row.team_id),
    kind: str(row.kind) === 'mcp' ? 'mcp' : 'chat',
    connection: strOrNull(row.connection),
    title: str(row.title),
    model: strOrNull(row.model),
    pinned: bool(row.pinned),
    autoApprove: bool(row.auto_approve),
    notes: json<string[]>(row.notes, []),
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function mapMessage(row: Row): AiMessageRecord {
  const input = numOrNull(row.input_tokens);
  return {
    id: str(row.id),
    chatId: str(row.chat_id),
    seq: num(row.seq),
    role: str(row.role) as AiRole,
    blocks: json<AiBlock[]>(row.blocks, []),
    raw: json<unknown>(row.raw, null),
    provider: strOrNull(row.provider),
    model: strOrNull(row.model),
    stop: strOrNull(row.stop),
    usage: input === null ? null : { input, output: num(row.output_tokens ?? 0), cached: num(row.cached_tokens ?? 0) },
    error: json<{ code: string; message: string } | null>(row.error, null),
    createdAt: str(row.created_at),
  };
}

function mapAction(row: Row): AiActionRecord {
  return {
    id: str(row.id),
    chatId: str(row.chat_id),
    messageId: str(row.message_id),
    callId: str(row.call_id),
    tool: str(row.tool) as AiToolName,
    title: str(row.title),
    detail: str(row.detail),
    preview: strOrNull(row.preview),
    input: json<Record<string, unknown>>(row.input, {}),
    risk: str(row.risk) as AiRisk,
    status: str(row.status) as AiActionStatus,
    summary: strOrNull(row.summary),
    output: strOrNull(row.output),
    display: strOrNull(row.display),
    undo: json<UndoRecipe | null>(row.undo, null),
    undoneAt: strOrNull(row.undone_at),
    undoError: strOrNull(row.undo_error),
    createdAt: str(row.created_at),
    finishedAt: strOrNull(row.finished_at),
  };
}

function mapFile(row: Row): AiFileRecord {
  return {
    id: str(row.id),
    chatId: str(row.chat_id),
    actionId: strOrNull(row.action_id),
    kind: str(row.kind) as AiFileKind,
    name: str(row.name),
    mime: str(row.mime),
    size: num(row.size),
    createdAt: str(row.created_at),
  };
}

export class AiStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // ------------------------------------------------------------------ chats

  createChat(userId: string, teamId: string, model: string | null): AiChatRecord {
    const id = newId('aic');
    const now = nowIso();
    this.db.run('INSERT INTO ai_chats (id, user_id, team_id, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, userId, teamId, model, now, now);
    return this.getChat(id)!;
  }

  /**
   * The record of an MCP connection, made the first time it acts. One message
   * anchors its steps (every step belongs to a message); it never grows.
   */
  mcpChat(userId: string, teamId: string, connection: string, client: string): AiChatRecord {
    const found = this.db.get('SELECT * FROM ai_chats WHERE connection = ?', connection);
    if (found !== undefined) {
      const chat = mapChat(found);
      if (chat.userId === userId && chat.teamId === teamId) return chat;
      // The same connection now acts for someone else (cannot happen for a token, which never changes hands): start afresh.
      this.deleteChat(chat.id);
    }
    const id = newId('aic');
    const now = nowIso();
    this.db.transaction(() => {
      this.db.run("INSERT INTO ai_chats (id, user_id, team_id, kind, connection, title, created_at, updated_at) VALUES (?, ?, ?, 'mcp', ?, ?, ?, ?)", id, userId, teamId, connection, client.slice(0, 120), now, now);
      this.db.run("INSERT INTO ai_messages (id, chat_id, seq, role, blocks, created_at) VALUES (?, ?, 1, 'assistant', '[]', ?)", newId('aim'), id, now);
    });
    return this.getChat(id)!;
  }

  /** The message every step of an MCP connection hangs from. */
  mcpAnchor(chatId: string): string {
    return str(this.db.scalar('SELECT id FROM ai_messages WHERE chat_id = ? ORDER BY seq ASC LIMIT 1', chatId));
  }

  /** What MCP connections did lately, newest first: the person's own, or the whole team's. */
  mcpActions(filter: { userId?: string; teamId: string }, limit = 50): { action: AiActionRecord; client: string; chatId: string }[] {
    const rows = this.db.all(
      `SELECT a.*, c.title AS client_name FROM ai_actions a JOIN ai_chats c ON c.id = a.chat_id
        WHERE c.kind = 'mcp' AND c.team_id = ? ${filter.userId === undefined ? '' : 'AND c.user_id = ?'}
        ORDER BY a.created_at DESC LIMIT ?`,
      ...(filter.userId === undefined ? [filter.teamId, limit] : [filter.teamId, filter.userId, limit]),
    );
    return rows.map((row) => ({ action: mapAction(row), client: str(row.client_name), chatId: str(row.chat_id) }));
  }

  getChat(id: string): AiChatRecord | undefined {
    const row = this.db.get('SELECT * FROM ai_chats WHERE id = ?', id);
    return row === undefined ? undefined : mapChat(row);
  }

  /** A conversation as its owner sees it, within the team it was started in. */
  getChatFor(userId: string, teamId: string, id: string): AiChatRecord | undefined {
    const row = this.db.get('SELECT * FROM ai_chats WHERE id = ? AND user_id = ? AND team_id = ?', id, userId, teamId);
    return row === undefined ? undefined : mapChat(row);
  }

  listChats(userId: string, teamId: string, search: string | undefined, limit = 200): AiChatRecord[] {
    if (search === undefined || search.length === 0) {
      return this.db.all("SELECT * FROM ai_chats WHERE user_id = ? AND team_id = ? AND kind = 'chat' ORDER BY pinned DESC, updated_at DESC LIMIT ?", userId, teamId, limit).map(mapChat);
    }
    // The title, or anything the person or the assistant wrote.
    const pattern = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    return this.db
      .all(
        `SELECT c.* FROM ai_chats c
          WHERE c.user_id = ? AND c.team_id = ? AND c.kind = 'chat'
            AND (c.title LIKE ? ESCAPE '\\' OR EXISTS (
              SELECT 1 FROM ai_messages m WHERE m.chat_id = c.id AND m.role IN ('user','assistant') AND m.blocks LIKE ? ESCAPE '\\'))
          ORDER BY c.pinned DESC, c.updated_at DESC LIMIT ?`,
        userId,
        teamId,
        pattern,
        pattern,
        limit,
      )
      .map(mapChat);
  }

  countChats(userId: string, teamId: string): number {
    return num(this.db.scalar("SELECT COUNT(*) FROM ai_chats WHERE user_id = ? AND team_id = ? AND kind = 'chat'", userId, teamId) ?? 0);
  }

  updateChat(id: string, patch: Partial<Pick<AiChatRecord, 'title' | 'model' | 'pinned' | 'autoApprove'>>, touch = false): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      values.push(patch.title);
    }
    if (patch.model !== undefined) {
      sets.push('model = ?');
      values.push(patch.model);
    }
    if (patch.pinned !== undefined) {
      sets.push('pinned = ?');
      values.push(int01(patch.pinned));
    }
    if (patch.autoApprove !== undefined) {
      sets.push('auto_approve = ?');
      values.push(int01(patch.autoApprove));
    }
    if (touch) {
      sets.push('updated_at = ?');
      values.push(nowIso());
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE ai_chats SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  touchChat(id: string): void {
    this.db.run('UPDATE ai_chats SET updated_at = ? WHERE id = ?', nowIso(), id);
  }

  addChatTokens(id: string, usage: AiUsage): void {
    this.db.run('UPDATE ai_chats SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?', usage.input, usage.output, id);
  }

  addNote(id: string, note: string): void {
    const chat = this.getChat(id);
    if (chat === undefined) return;
    this.db.run('UPDATE ai_chats SET notes = ? WHERE id = ?', JSON.stringify([...chat.notes, note].slice(-20)), id);
  }

  /** The notes waiting for the model, removed as they are handed over. */
  takeNotes(id: string): string[] {
    const chat = this.getChat(id);
    if (chat === undefined || chat.notes.length === 0) return [];
    this.db.run("UPDATE ai_chats SET notes = '[]' WHERE id = ?", id);
    return chat.notes;
  }

  deleteChat(id: string): void {
    this.db.run('DELETE FROM ai_chats WHERE id = ?', id);
  }

  /** Conversations nobody has touched since `before`, oldest first: what a retention sweep removes. */
  staleChats(before: string, limit = 200): AiChatRecord[] {
    return this.db.all('SELECT * FROM ai_chats WHERE updated_at < ? AND pinned = 0 ORDER BY updated_at ASC LIMIT ?', before, limit).map(mapChat);
  }

  // --------------------------------------------------------------- messages

  appendMessage(chatId: string, input: AiMessageInput): AiMessageRecord {
    const id = newId('aim');
    this.db.transaction(() => {
      const seq = num(this.db.scalar('SELECT COALESCE(MAX(seq), 0) + 1 FROM ai_messages WHERE chat_id = ?', chatId) ?? 1);
      this.db.run(
        `INSERT INTO ai_messages (id, chat_id, seq, role, blocks, raw, provider, model, stop, input_tokens, output_tokens, cached_tokens, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        chatId,
        seq,
        input.role,
        JSON.stringify(input.blocks),
        input.raw === undefined || input.raw === null ? null : JSON.stringify(input.raw),
        input.provider ?? null,
        input.model ?? null,
        input.stop ?? null,
        input.usage?.input ?? null,
        input.usage?.output ?? null,
        input.usage?.cached ?? null,
        input.error == null ? null : JSON.stringify(input.error),
        nowIso(),
      );
    });
    return this.getMessage(id)!;
  }

  getMessage(id: string): AiMessageRecord | undefined {
    const row = this.db.get('SELECT * FROM ai_messages WHERE id = ?', id);
    return row === undefined ? undefined : mapMessage(row);
  }

  listMessages(chatId: string): AiMessageRecord[] {
    return this.db.all('SELECT * FROM ai_messages WHERE chat_id = ? ORDER BY seq ASC', chatId).map(mapMessage);
  }

  /** The transcript the model continues from: the latest summary (if any) and everything after it. */
  listMessagesForPrompt(chatId: string): AiMessageRecord[] {
    const from = num(this.db.scalar("SELECT COALESCE(MAX(seq), 0) FROM ai_messages WHERE chat_id = ? AND role = 'summary'", chatId) ?? 0);
    return this.db.all('SELECT * FROM ai_messages WHERE chat_id = ? AND seq >= ? ORDER BY seq ASC', chatId, from).map(mapMessage);
  }

  setMessageError(id: string, error: { code: string; message: string }): void {
    this.db.run('UPDATE ai_messages SET error = ? WHERE id = ?', JSON.stringify(error), id);
  }

  // ---------------------------------------------------------------- actions

  createAction(input: AiActionInput): AiActionRecord {
    const id = newId('aia');
    this.db.run(
      `INSERT INTO ai_actions (id, chat_id, message_id, call_id, tool, title, detail, preview, input, risk, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.chatId,
      input.messageId,
      input.callId,
      input.tool,
      input.title,
      input.detail,
      input.preview,
      JSON.stringify(input.input),
      input.risk,
      input.status,
      nowIso(),
    );
    return this.getAction(id)!;
  }

  getAction(id: string): AiActionRecord | undefined {
    const row = this.db.get('SELECT * FROM ai_actions WHERE id = ?', id);
    return row === undefined ? undefined : mapAction(row);
  }

  listActions(chatId: string): AiActionRecord[] {
    return this.db.all('SELECT * FROM ai_actions WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC', chatId).map(mapAction);
  }

  updateAction(id: string, patch: AiActionPatch): AiActionRecord {
    const sets: string[] = [];
    const values: (string | null)[] = [];
    const set = (column: string, value: string | null): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.summary !== undefined) set('summary', patch.summary);
    if (patch.output !== undefined) set('output', patch.output);
    if (patch.display !== undefined) set('display', patch.display);
    if (patch.undo !== undefined) set('undo', patch.undo === null ? null : JSON.stringify(patch.undo));
    if (patch.undoneAt !== undefined) set('undone_at', patch.undoneAt);
    if (patch.undoError !== undefined) set('undo_error', patch.undoError);
    if (patch.finishedAt !== undefined) set('finished_at', patch.finishedAt);
    if (sets.length > 0) this.db.prepare(`UPDATE ai_actions SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.getAction(id)!;
  }

  /** Chats that have an action waiting for an answer. */
  waitingChatIds(chatIds: string[]): Set<string> {
    if (chatIds.length === 0) return new Set();
    const marks = chatIds.map(() => '?').join(',');
    return new Set(this.db.prepare(`SELECT DISTINCT chat_id FROM ai_actions WHERE status = 'pending' AND chat_id IN (${marks})`).all(...chatIds).map((row) => str((row as Row).chat_id)));
  }

  /** Actions a restart left unfinished: nobody is waiting on them any more. */
  cancelInterrupted(): number {
    return this.db.run("UPDATE ai_actions SET status = 'cancelled', summary = COALESCE(summary, 'The panel restarted before this ran'), finished_at = ? WHERE status IN ('pending','running')", nowIso()).changes;
  }

  // ------------------------------------------------------------------ files

  createFile(input: { chatId: string; actionId?: string | null; kind: AiFileKind; name: string; mime: string; size: number }): AiFileRecord {
    const id = newId('aif');
    this.db.run('INSERT INTO ai_files (id, chat_id, action_id, kind, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, input.chatId, input.actionId ?? null, input.kind, input.name, input.mime, input.size, nowIso());
    return this.getFile(id)!;
  }

  getFile(id: string): AiFileRecord | undefined {
    const row = this.db.get('SELECT * FROM ai_files WHERE id = ?', id);
    return row === undefined ? undefined : mapFile(row);
  }

  listFiles(chatId: string): AiFileRecord[] {
    return this.db.all('SELECT * FROM ai_files WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC', chatId).map(mapFile);
  }

  setFileAction(id: string, actionId: string): void {
    this.db.run('UPDATE ai_files SET action_id = ? WHERE id = ?', actionId, id);
  }

  deleteFile(id: string): void {
    this.db.run('DELETE FROM ai_files WHERE id = ?', id);
  }

  // ------------------------------------------------------------------ usage

  addUsage(day: string, userId: string, teamId: string, model: string, usage: AiUsage): void {
    this.db.run(
      `INSERT INTO ai_usage (day, user_id, team_id, model, requests, input_tokens, output_tokens, cached_tokens) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT (day, user_id, team_id, model) DO UPDATE SET
         requests = requests + 1,
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cached_tokens = cached_tokens + excluded.cached_tokens`,
      day,
      userId,
      teamId,
      model,
      usage.input,
      usage.output,
      usage.cached,
    );
  }

  /** Tokens a person used on a day, across teams. Input read from the provider's cache costs a tenth and counts as a tenth. */
  usedOn(day: string, userId: string): number {
    return num(this.db.scalar('SELECT COALESCE(SUM(input_tokens - cached_tokens + cached_tokens / 10 + output_tokens), 0) FROM ai_usage WHERE day = ? AND user_id = ?', day, userId) ?? 0);
  }

  usageSince(day: string): {
    days: { day: string; input: number; output: number; cached: number; requests: number }[];
    users: { userId: string; name: string; input: number; output: number; requests: number }[];
    models: { model: string; input: number; output: number; requests: number }[];
  } {
    const days = this.db
      .all('SELECT day, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cached_tokens) AS cached, SUM(requests) AS requests FROM ai_usage WHERE day >= ? GROUP BY day ORDER BY day ASC', day)
      .map((row) => ({ day: str(row.day), input: num(row.input), output: num(row.output), cached: num(row.cached), requests: num(row.requests) }));
    const users = this.db
      .all(
        `SELECT a.user_id, COALESCE(u.name, a.user_id) AS name, SUM(a.input_tokens) AS input, SUM(a.output_tokens) AS output, SUM(a.requests) AS requests
           FROM ai_usage a LEFT JOIN users u ON u.id = a.user_id WHERE a.day >= ? GROUP BY a.user_id ORDER BY SUM(a.input_tokens + a.output_tokens) DESC LIMIT 50`,
        day,
      )
      .map((row) => ({ userId: str(row.user_id), name: str(row.name), input: num(row.input), output: num(row.output), requests: num(row.requests) }));
    const models = this.db
      .all('SELECT model, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(requests) AS requests FROM ai_usage WHERE day >= ? GROUP BY model ORDER BY SUM(input_tokens + output_tokens) DESC LIMIT 50', day)
      .map((row) => ({ model: str(row.model), input: num(row.input), output: num(row.output), requests: num(row.requests) }));
    return { days, users, models };
  }
}
