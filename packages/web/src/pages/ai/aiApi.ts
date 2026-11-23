/**
 * TorexAi's server state: who may use it, the list of conversations, and one
 * conversation as it happens (the transcript, the actions the assistant
 * takes, and the reply being written), fed by the conversation's event
 * stream.
 */
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type {
  AiActionDto,
  AiChatDetailDto,
  AiChatDto,
  AiContextInput,
  AiEvent,
  AiFileDto,
  AiMessageDto,
  AiProviderTestDto,
  AiRunState,
  AiSettingsDto,
  AiSettingsInput,
  AiStatusDto,
  AiToolName,
  AiUsageDto,
  AiProviderKind,
} from '@ploy/shared';
import { api, ApiError, qs } from '../../lib/api.ts';

export const aiKeys = {
  status: ['ai', 'status'] as const,
  settings: ['ai', 'settings'] as const,
  usage: (days: number) => ['ai', 'usage', days] as const,
  chats: (query: string) => ['ai', 'chats', query] as const,
  allChats: ['ai', 'chats'] as const,
  chat: (id: string) => ['ai', 'chat', id] as const,
};

export const useAiStatus = () => useQuery({ queryKey: aiKeys.status, queryFn: () => api.get<AiStatusDto>('/api/ai'), staleTime: 30_000 });
export const useAiSettings = () => useQuery({ queryKey: aiKeys.settings, queryFn: () => api.get<AiSettingsDto>('/api/ai/settings') });
export const useAiUsage = (days: number) => useQuery({ queryKey: aiKeys.usage(days), queryFn: () => api.get<AiUsageDto>(`/api/ai/usage${qs({ days })}`) });
export const useAiChats = (query: string, enabled: boolean) =>
  useQuery({ queryKey: aiKeys.chats(query), queryFn: () => api.get<AiChatDto[]>(`/api/ai/chats${qs({ query })}`), enabled, placeholderData: (previous) => previous });

export const saveAiSettings = (input: AiSettingsInput) => api.put<AiSettingsDto>('/api/ai/settings', input);
export const testAiProvider = (input: { id?: string; kind: AiProviderKind; baseUrl: string; apiKey?: string }) => api.post<AiProviderTestDto>('/api/ai/settings/test', input);
export const createAiChat = (model?: string) => api.post<AiChatDto>('/api/ai/chats', model === undefined ? {} : { model });
export const updateAiChat = (id: string, patch: { title?: string; pinned?: boolean; autoApprove?: boolean; model?: string }) => api.patch<AiChatDto>(`/api/ai/chats/${id}`, patch);
export const deleteAiChat = (id: string) => api.delete<{ ok: boolean }>(`/api/ai/chats/${id}`);
export const sendAiMessage = (id: string, input: { text: string; files: string[]; context?: AiContextInput; model?: string }) => api.post<AiMessageDto>(`/api/ai/chats/${id}/messages`, input);
export const stopAiChat = (id: string) => api.post<{ stopped: boolean }>(`/api/ai/chats/${id}/stop`);
export const decideAiAction = (id: string, approve: boolean, always = false) => api.post<{ ok: boolean }>(`/api/ai/actions/${id}/decision`, { approve, always });
export const undoAiAction = (id: string) => api.post<AiActionDto>(`/api/ai/actions/${id}/undo`);
export const aiFileUrl = (file: Pick<AiFileDto, 'id'>, inline = false) => `/api/ai/files/${file.id}${inline ? '?inline=1' : ''}`;

export async function fetchAiOutput(actionId: string): Promise<string> {
  const response = await fetch(`/api/ai/actions/${actionId}/output`, { credentials: 'same-origin' });
  if (!response.ok) throw new ApiError('internal_error', `HTTP ${response.status}`, response.status);
  return response.text();
}

/**
 * Attach a file to a conversation: the bytes as the body, the name in the
 * address. `onProgress` is told how much has gone up (0 to 1), which `fetch`
 * cannot say.
 */
export function uploadAiFile(chatId: string, file: File, onProgress?: (fraction: number) => void): Promise<AiFileDto> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/ai/chats/${chatId}/files${qs({ name: file.name })}`);
    request.withCredentials = true;
    request.setRequestHeader('X-Ploy-Request', '1');
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    request.onerror = () => reject(new ApiError('network', 'Network error', 0));
    request.onabort = () => reject(new ApiError('network', 'Upload cancelled', 0));
    request.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(request.responseText);
      } catch {
        // Not JSON: an error page from something in between.
      }
      if (request.status >= 200 && request.status < 300 && data !== null) {
        onProgress?.(1);
        resolve(data as AiFileDto);
        return;
      }
      const error = (data as { error?: { code?: string; message?: string; params?: Record<string, string | number> } } | null)?.error;
      reject(new ApiError((error?.code ?? 'internal_error') as 'internal_error', error?.message ?? `HTTP ${request.status}`, request.status, error?.params === undefined ? {} : { params: error.params }));
    };
    request.send(file);
  });
}

// ---------------------------------------------------------------------------
// One conversation, live
// ---------------------------------------------------------------------------

export interface Conversation {
  /** The transcript has been read at least once. */
  loaded: boolean;
  /** It could not be read (deleted, or not this person's). */
  missing: boolean;
  chat: AiChatDto | null;
  messages: AiMessageDto[];
  actions: Record<string, AiActionDto>;
  /** The reply as written so far. */
  draft: string;
  state: AiRunState;
  tool: AiToolName | null;
  /** How the last reply ended, when it did not end well. */
  ended: { reason: 'stopped' | 'error' | 'limit'; error?: { code: string; message: string } } | null;
}

const EMPTY: Conversation = { loaded: false, missing: false, chat: null, messages: [], actions: {}, draft: '', state: 'idle', tool: null, ended: null };

type Change = { type: 'reset' } | { type: 'detail'; detail: AiChatDetailDto } | { type: 'missing' } | { type: 'event'; event: AiEvent } | { type: 'sent'; message: AiMessageDto } | { type: 'chat'; chat: AiChatDto };

function withMessage(messages: AiMessageDto[], message: AiMessageDto): AiMessageDto[] {
  const index = messages.findIndex((existing) => existing.id === message.id);
  if (index !== -1) return messages.map((existing, position) => (position === index ? message : existing));
  return [...messages, message].sort((a, b) => a.seq - b.seq);
}

function reduce(current: Conversation, change: Change): Conversation {
  switch (change.type) {
    case 'reset':
      return EMPTY;
    case 'missing':
      return { ...EMPTY, loaded: true, missing: true };
    case 'detail': {
      // Events may have arrived before the transcript did: what they brought is kept on top of it.
      let messages = change.detail.messages;
      for (const message of current.messages) if (!messages.some((existing) => existing.id === message.id)) messages = withMessage(messages, message);
      const actions = { ...Object.fromEntries(change.detail.actions.map((action) => [action.id, action])), ...(current.loaded ? {} : current.actions) };
      return { ...current, loaded: true, missing: false, chat: current.chat ?? change.detail.chat, messages, actions };
    }
    case 'sent':
      return { ...current, messages: withMessage(current.messages, change.message), state: 'thinking', draft: '', ended: null };
    case 'chat':
      return { ...current, chat: change.chat };
    case 'event': {
      const event = change.event;
      switch (event.type) {
        case 'snapshot':
          return { ...current, chat: event.chat, state: event.state, draft: event.draft, tool: null };
        case 'message':
          // A finished assistant turn replaces what was being written.
          return { ...current, messages: withMessage(current.messages, event.message), draft: event.message.role === 'assistant' ? '' : current.draft };
        case 'delta':
          return { ...current, draft: current.draft + event.text, state: 'writing' };
        case 'state':
          return { ...current, state: event.state, tool: event.tool ?? null };
        case 'action':
          return { ...current, actions: { ...current.actions, [event.action.id]: event.action } };
        case 'chat':
          return { ...current, chat: event.chat };
        case 'done':
          return { ...current, state: 'idle', tool: null, draft: '', ended: event.reason === 'end' ? null : { reason: event.reason, ...(event.error === undefined ? {} : { error: event.error }) } };
      }
    }
  }
}

function patchLists(client: QueryClient, chat: AiChatDto): void {
  client.setQueriesData<AiChatDto[]>({ queryKey: aiKeys.allChats }, (list) => (list === undefined ? list : list.some((entry) => entry.id === chat.id) ? list.map((entry) => (entry.id === chat.id ? { ...entry, ...chat } : entry)) : list));
}

/**
 * A conversation and everything that happens in it. The transcript is read
 * once; after that the event stream keeps it current, and a reconnect reads
 * it again in case something was missed while the connection was down.
 */
export function useConversation(chatId: string | null): { conversation: Conversation; noteSent: (message: AiMessageDto) => void; setChat: (chat: AiChatDto) => void } {
  const client = useQueryClient();
  const [conversation, dispatch] = useReducer(reduce, EMPTY);
  const connected = useRef(false);

  const load = useCallback(
    async (id: string, signal: { cancelled: boolean }) => {
      try {
        const detail = await api.get<AiChatDetailDto>(`/api/ai/chats/${id}`);
        if (!signal.cancelled) dispatch({ type: 'detail', detail });
      } catch (error) {
        if (!signal.cancelled && error instanceof ApiError && (error.status === 404 || error.status === 403)) dispatch({ type: 'missing' });
      }
    },
    [],
  );

  useEffect(() => {
    dispatch({ type: 'reset' });
    if (chatId === null) return;
    const signal = { cancelled: false };
    connected.current = false;
    void load(chatId, signal);
    const source = new EventSource(`/api/ai/chats/${chatId}/events`);
    source.addEventListener('ai', (message) => {
      let event: AiEvent;
      try {
        event = JSON.parse((message as MessageEvent<string>).data) as AiEvent;
      } catch {
        return;
      }
      if (event.type === 'snapshot') {
        // The second snapshot means the stream was re-established: read again what may have been missed.
        if (connected.current) void load(chatId, signal);
        connected.current = true;
      }
      dispatch({ type: 'event', event });
      if (event.type === 'chat' || event.type === 'snapshot') patchLists(client, event.chat);
      if (event.type === 'done') {
        void client.invalidateQueries({ queryKey: aiKeys.allChats });
        void client.invalidateQueries({ queryKey: aiKeys.status });
        // What the assistant changed is on other pages too.
        void client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'ai' && query.queryKey[0] !== 'bootstrap' });
      }
    });
    return () => {
      signal.cancelled = true;
      source.close();
    };
  }, [chatId, client, load]);

  const noteSent = useCallback((message: AiMessageDto) => dispatch({ type: 'sent', message }), []);
  const setChat = useCallback(
    (chat: AiChatDto) => {
      dispatch({ type: 'chat', chat });
      patchLists(client, chat);
    },
    [client],
  );
  return { conversation, noteSent, setChat };
}
