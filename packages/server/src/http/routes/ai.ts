/**
 * TorexAi: its settings, a person's conversations, the live stream of a
 * conversation, approvals and undo, and the files of a conversation.
 *
 * A conversation belongs to the person who started it and to the team they
 * started it in; nobody else can read it, an administrator included.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  AI_LIMITS,
  aiChatListQuerySchema,
  aiCreateChatSchema,
  aiDecisionSchema,
  aiProviderTestSchema,
  aiSendMessageSchema,
  aiSettingsSchema,
  aiUpdateChatSchema,
  aiUsageQuerySchema,
  type AiChatDto,
  type AiEvent,
} from '@ploy/shared';
import type { Actor } from '../../ai/internal.ts';
import { safeFileName, uploadedMime, VISION_MIMES } from '../../ai/storage.ts';
import type { Context } from '../../context.ts';
import { AppError, notFound } from '../../lib/errors.ts';
import type { AiChatRecord } from '../../store/index.ts';
import { audit, body, limit, query, RateLimiter, requestOrigin, requireAuth, requireInstanceAdmin, type Ctx, type Env } from '../core.ts';

/** Files of a conversation arrive as raw bodies. */
export const AI_UPLOAD = /^\/api\/ai\/chats\/[^/]+\/files$/;

export function registerAiRoutes(app: Hono<Env>, ctx: Context): void {
  const { stores } = ctx;
  const ai = ctx.ai;
  const sendLimiter = new RateLimiter(30, 30);
  const testLimiter = new RateLimiter(20, 20);

  const loadChat = (c: Ctx): { chat: AiChatRecord; actor: Actor } => {
    const auth = ai.require(c.get('auth'));
    const chat = stores.ai.getChatFor(auth.user.id, auth.teamId, c.req.param('id')!);
    if (chat === undefined) throw notFound('Conversation');
    return { chat, actor: { userId: auth.user.id, teamId: auth.teamId, sessionId: auth.sessionId, ip: c.get('ip'), origin: requestOrigin(c), chatId: chat.id } };
  };

  // --------------------------------------------------------------- settings

  app.get('/api/ai', (c) => c.json(ai.status(requireAuth(c))));

  app.get('/api/ai/settings', (c) => {
    requireInstanceAdmin(c);
    return c.json(ai.settings.dto());
  });

  app.put('/api/ai/settings', async (c) => {
    requireInstanceAdmin(c);
    const input = await body(c, aiSettingsSchema);
    ai.settings.update(input);
    // Never the keys themselves: which fields changed, and how many providers there are now.
    audit(ctx, c, 'ai.settings_updated', { type: 'settings', teamId: null }, { fields: Object.keys(input), providers: ai.settings.get().providers.length });
    return c.json(ai.settings.dto());
  });

  /** Check a key and read the models it can use, before or after it is saved. */
  app.post('/api/ai/settings/test', async (c) => {
    requireInstanceAdmin(c);
    limit(testLimiter, c, 'ai-test');
    return c.json(await ai.testProvider(await body(c, aiProviderTestSchema)));
  });

  app.get('/api/ai/usage', (c) => {
    requireInstanceAdmin(c);
    return c.json(ai.usage(query(c, aiUsageQuerySchema).days));
  });

  // ------------------------------------------------------------------ chats

  app.get('/api/ai/chats', (c) => {
    const auth = ai.require(c.get('auth'));
    const { query: search } = query(c, aiChatListQuerySchema);
    const chats = stores.ai.listChats(auth.user.id, auth.teamId, search);
    const waiting = stores.ai.waitingChatIds(chats.map((chat) => chat.id));
    const list: AiChatDto[] = chats.map((chat) => ai.chatDto(chat, waiting.has(chat.id)));
    return c.json(list);
  });

  app.post('/api/ai/chats', async (c) => {
    const auth = ai.require(c.get('auth'));
    const input = await body(c, aiCreateChatSchema);
    if (input.model !== undefined && ai.settings.resolve(input.model) === null) throw new AppError('bad_request', 'That model is not available');
    if (stores.ai.countChats(auth.user.id, auth.teamId) >= AI_LIMITS.chatsMax) throw new AppError('conflict', 'Too many conversations; delete some old ones first');
    return c.json(ai.chatDto(stores.ai.createChat(auth.user.id, auth.teamId, input.model ?? null)), 201);
  });

  app.get('/api/ai/chats/:id', (c) => c.json(ai.detail(loadChat(c).chat)));

  app.patch('/api/ai/chats/:id', async (c) => {
    const { chat } = loadChat(c);
    const input = await body(c, aiUpdateChatSchema);
    if (input.model !== undefined && ai.settings.resolve(input.model) === null) throw new AppError('bad_request', 'That model is not available');
    stores.ai.updateChat(chat.id, input);
    return c.json(ai.chatDto(stores.ai.getChat(chat.id)!));
  });

  app.delete('/api/ai/chats/:id', async (c) => {
    const { chat } = loadChat(c);
    await ai.deleteChat(chat);
    return c.json({ ok: true });
  });

  /** Send a message. The answer arrives on the conversation's event stream. */
  app.post('/api/ai/chats/:id/messages', async (c) => {
    const { chat, actor } = loadChat(c);
    limit(sendLimiter, c, 'ai-send');
    const input = await body(c, aiSendMessageSchema);
    return c.json(ai.send(actor, chat, input), 202);
  });

  app.post('/api/ai/chats/:id/stop', (c) => c.json({ stopped: ai.stopRun(loadChat(c).chat.id) }));

  /** The live stream of a conversation: where it stands now, then everything that happens in it. */
  app.get('/api/ai/chats/:id/events', (c) => {
    const { chat } = loadChat(c);
    return streamSSE(c, async (stream) => {
      const queue: AiEvent[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = ai.subscribe(chat.id, (event) => {
        // A client that stopped reading loses the tail of a long reply, not the server's memory; it reloads the conversation.
        if (queue.length > 5_000) queue.splice(0, queue.length - 2_500);
        queue.push(event);
        wake?.();
      });
      let open = true;
      stream.onAbort(() => {
        open = false;
        wake?.();
      });
      try {
        const current = stores.ai.getChat(chat.id);
        if (current === undefined) return;
        await stream.writeSSE({ event: 'ai', data: JSON.stringify(ai.snapshot(current)), retry: 2_000 });
        while (open) {
          const next = queue.shift();
          if (next !== undefined) {
            // Text arrives a few characters at a time: what has piled up is sent as one piece.
            if (next.type === 'delta') {
              let text = next.text;
              while (queue[0]?.type === 'delta') text += (queue.shift() as Extract<AiEvent, { type: 'delta' }>).text;
              await stream.writeSSE({ event: 'ai', data: JSON.stringify({ type: 'delta', text } satisfies AiEvent) });
            } else await stream.writeSSE({ event: 'ai', data: JSON.stringify(next) });
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 20_000);
          });
          wake = null;
          if (queue.length === 0 && open) await stream.writeSSE({ event: 'ping', data: '' });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  // ---------------------------------------------------------------- actions

  const loadAction = (c: Ctx): { chat: AiChatRecord; actor: Actor; actionId: string } => {
    const auth = ai.require(c.get('auth'));
    const action = stores.ai.getAction(c.req.param('id')!);
    const chat = action === undefined ? undefined : stores.ai.getChatFor(auth.user.id, auth.teamId, action.chatId);
    if (action === undefined || chat === undefined) throw notFound('Action');
    return { chat, actionId: action.id, actor: { userId: auth.user.id, teamId: auth.teamId, sessionId: auth.sessionId, ip: c.get('ip'), origin: requestOrigin(c), chatId: chat.id } };
  };

  /** Approve or decline an action that is waiting. Only a person can: TorexAi cannot reach this endpoint. */
  app.post('/api/ai/actions/:id/decision', async (c) => {
    const { chat, actionId } = loadAction(c);
    const input = await body(c, aiDecisionSchema);
    ai.decide(chat, actionId, input);
    audit(ctx, c, input.approve ? 'ai.action_approved' : 'ai.action_declined', { type: 'ai_action', id: actionId, name: stores.ai.getAction(actionId)?.detail ?? null }, { always: input.always });
    return c.json({ ok: true });
  });

  app.post('/api/ai/actions/:id/undo', async (c) => {
    const { chat, actor, actionId } = loadAction(c);
    const action = await ai.undo(actor, chat, actionId);
    return c.json(ai.actionDto(action, stores.ai.listFiles(chat.id)));
  });

  /** The whole output of a step, as the person is shown it. */
  app.get('/api/ai/actions/:id/output', (c) => {
    const { actionId } = loadAction(c);
    const action = stores.ai.getAction(actionId)!;
    return c.text(action.display ?? action.output ?? '');
  });

  // ------------------------------------------------------------------ files

  /** Attach a file to a conversation: the raw bytes as the body, the name in `?name=`. */
  app.post('/api/ai/chats/:id/files', async (c) => {
    const { chat } = loadChat(c);
    const length = Number(c.req.header('content-length') ?? NaN);
    if (!Number.isFinite(length) || length <= 0) throw new AppError('bad_request', 'Content-Length is required');
    if (length > AI_LIMITS.fileMax) throw new AppError('payload_too_large', 'The file is too large', { params: { maximum: AI_LIMITS.fileMax } });
    const raw = c.req.raw.body;
    if (raw === null) throw new AppError('bad_request', 'The request has no body');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of Readable.fromWeb(raw as unknown as WebReadableStream)) {
      size += (chunk as Buffer).length;
      if (size > AI_LIMITS.fileMax) throw new AppError('payload_too_large', 'The file is too large', { params: { maximum: AI_LIMITS.fileMax } });
      chunks.push(chunk as Buffer);
    }
    const name = safeFileName(c.req.query('name'), 'file');
    const data = Buffer.concat(chunks);
    const saved = await ai.storage.save({ chatId: chat.id, kind: 'upload', name, mime: uploadedMime(name, data), data });
    return c.json(ai.fileDto(saved), 201);
  });

  app.get('/api/ai/files/:id', async (c) => {
    const auth = ai.require(c.get('auth'));
    const file = stores.ai.getFile(c.req.param('id'));
    const chat = file === undefined ? undefined : stores.ai.getChatFor(auth.user.id, auth.teamId, file.chatId);
    if (file === undefined || chat === undefined || file.kind === 'snapshot') throw notFound('File');
    const path = ai.storage.path(file);
    const info = await stat(path).catch(() => null);
    if (info === null) throw notFound('File');
    // Pictures may be shown in the page; everything else is only ever downloaded, and nothing is allowed to run.
    const inline = c.req.query('inline') === '1' && (VISION_MIMES.has(file.mime) || file.mime === 'image/svg+xml');
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: {
        'Content-Type': inline ? file.mime : 'application/octet-stream',
        'Content-Length': String(info.size),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  });
}
