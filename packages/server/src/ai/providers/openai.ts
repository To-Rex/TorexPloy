/**
 * The OpenAI chat-completions format, as ChatGPT, Grok, Deploy and every
 * "OpenAI-compatible" endpoint speak it.
 *
 * One adapter serves them all, so it sends only what the format's common
 * core defines: the conversation, the tools, and a request for a streamed
 * answer with token counts. Anything a particular endpoint refuses (the usage
 * option on older servers, a reasoning effort on a model without one) is left
 * out on the retry, not guessed at up front.
 */
import type { AiProviderKind } from '@ploy/shared';
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult, type GeneratedImage, type ImageSize, type ModelList, type PromptMessage, type StopReason, type StreamEvent, type ToolCall } from '../types.ts';

export interface OpenAiOptions {
  kind: AiProviderKind;
  baseUrl: string;
  apiKey: string;
  /** Replaced in tests. */
  fetch?: typeof fetch;
}

/** No byte from the provider for this long means the connection is dead. */
const IDLE_TIMEOUT_MS = 180_000;
const MAX_ATTEMPTS = 3;

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

/** Models that are not for conversation, whatever the endpoint. */
const NOT_CHAT = /embed|whisper|tts|audio|speech|moderation|realtime|transcri|rerank|similarity|video|guard|ocr/i;
const IMAGE_MODEL = /image|dall-e|imagine|flux|stable-diffusion|sdxl/i;

export function toWireMessages(system: string, messages: PromptMessage[]): WireMessage[] {
  const wire: WireMessage[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'tool') {
      for (const part of message.parts) {
        if (part.type === 'tool_result') wire.push({ role: 'tool', tool_call_id: part.id, content: part.output.length > 0 ? part.output : '(no output)' });
      }
      continue;
    }
    if (message.role === 'assistant') {
      if (message.raw !== undefined && message.raw.family === 'openai') {
        wire.push(message.raw.content as WireMessage);
        continue;
      }
      const text = message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
      const calls = message.parts.flatMap((part): WireToolCall[] => (part.type === 'tool_call' ? [{ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } }] : []));
      if (text.length === 0 && calls.length === 0) continue;
      wire.push({ role: 'assistant', content: text.length > 0 ? text : null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
      continue;
    }
    const images = message.parts.filter((part) => part.type === 'image');
    const text = message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n');
    if (images.length === 0) {
      wire.push({ role: 'user', content: text });
      continue;
    }
    wire.push({
      role: 'user',
      content: [
        ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
        ...images.map((part) => ({ type: 'image_url' as const, image_url: { url: `data:${part.type === 'image' ? part.mime : ''};base64,${part.type === 'image' ? part.data : ''}` } })),
      ],
    });
  }
  return wire;
}

/** The provider's own explanation out of an error body, whatever shape it took. */
export function errorText(status: number, body: string): string {
  let detail = body.trim().slice(0, 600);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown };
    const message = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message ?? parsed.detail);
    if (typeof message === 'string' && message.length > 0) detail = message.slice(0, 600);
  } catch {
    // Not JSON: an HTML error page or plain text; the beginning of it is shown as is.
  }
  return detail.length > 0 ? `${status}: ${detail}` : `HTTP ${status}`;
}

function parseArguments(text: string): { input: Record<string, unknown>; invalid?: string } {
  const source = text.trim();
  if (source.length === 0) return { input: {} };
  try {
    const value: unknown = JSON.parse(source);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return { input: value as Record<string, unknown> };
    return { input: {}, invalid: source.slice(0, 2_000) };
  } catch {
    return { input: {}, invalid: source.slice(0, 2_000) };
  }
}

/** Lines of a `text/event-stream` body, as the `data:` payloads they carry. */
export async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let timer: NodeJS.Timeout | null = null;
  let fail: (error: Error) => void = () => undefined;
  const failed = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  // Nothing may be awaiting it when it settles (the stream ended first).
  failed.catch(() => undefined);
  const arm = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => fail(new ProviderError('The provider stopped answering', 504, true)), IDLE_TIMEOUT_MS);
  };
  const onAbort = (): void => fail(new DOMException('Aborted', 'AbortError'));
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  arm();
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), failed]);
      if (done) break;
      arm();
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) yield line.slice(5).trimStart();
      }
    }
    const rest = buffer.trim();
    if (rest.startsWith('data:')) yield rest.slice(5).trimStart();
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => undefined);
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

export class OpenAiProvider implements ChatProvider {
  readonly family = 'openai' as const;
  private readonly kind: AiProviderKind;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  /** Options this endpoint refused once; they are not sent again for the life of the process. */
  private readonly refused = new Set<'stream_options' | 'reasoning_effort'>();

  constructor(options: OpenAiOptions) {
    this.kind = options.kind;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetcher = options.fetch ?? fetch;
  }

  private headers(stream: boolean): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
      ...(this.apiKey.length > 0 ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  private async post(path: string, body: unknown, stream: boolean, signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetcher(`${this.baseUrl}${path}`, { method: 'POST', headers: this.headers(stream), body: JSON.stringify(body), signal });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      throw new ProviderError(`Could not reach ${this.baseUrl}: ${(error as Error).message}`, 502, true);
    }
  }

  async chat(request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<ChatResult> {
    const messages = toWireMessages(request.system, request.messages);
    const tools = request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.schema } }));
    for (let attempt = 1; ; attempt += 1) {
      const body: Record<string, unknown> = {
        model: request.model,
        messages,
        stream: true,
        ...(tools.length > 0 ? { tools } : {}),
        ...(this.refused.has('stream_options') ? {} : { stream_options: { include_usage: true } }),
        ...(request.effort !== 'auto' && !this.refused.has('reasoning_effort') ? { reasoning_effort: request.effort } : {}),
      };
      const response = await this.post('/chat/completions', body, true, request.signal);
      if (!response.ok || response.body === null) {
        const text = await response.text().catch(() => '');
        // An option the endpoint does not know: say it again without it.
        if (response.status === 400 || response.status === 422) {
          const option = (['stream_options', 'reasoning_effort'] as const).find((name) => name in body && text.includes(name));
          if (option !== undefined) {
            this.refused.add(option);
            continue;
          }
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) {
          await sleep(attempt * 1_500, request.signal);
          continue;
        }
        throw new ProviderError(errorText(response.status, text), response.status, retryable);
      }
      return this.read(response.body, request, onEvent);
    }
  }

  private async read(stream: ReadableStream<Uint8Array>, request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<ChatResult> {
    let text = '';
    let reasoning = '';
    let finish: string | null = null;
    let model = request.model;
    const usage = { input: 0, output: 0, cached: 0 };
    const pending: { id: string; name: string; args: string }[] = [];
    let thinking = false;

    for await (const data of sseData(stream, request.signal)) {
      if (data === '[DONE]') break;
      let chunk: {
        model?: string;
        error?: { message?: string } | string;
        choices?: { delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null } | null;
      };
      try {
        chunk = JSON.parse(data) as typeof chunk;
      } catch {
        continue;
      }
      if (chunk.error !== undefined && chunk.error !== null) {
        throw new ProviderError(typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'The provider reported an error'), 502, false);
      }
      if (typeof chunk.model === 'string' && chunk.model.length > 0) model = chunk.model;
      if (chunk.usage != null) {
        usage.input = chunk.usage.prompt_tokens ?? usage.input;
        usage.output = chunk.usage.completion_tokens ?? usage.output;
        usage.cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? usage.cached;
      }
      const choice = chunk.choices?.[0];
      if (choice === undefined) continue;
      if (choice.finish_reason != null) finish = choice.finish_reason;
      const delta = choice.delta;
      if (delta === undefined) continue;
      const thought = delta.reasoning_content ?? delta.reasoning;
      if (typeof thought === 'string' && thought.length > 0) {
        reasoning += thought;
        if (!thinking) {
          thinking = true;
          onEvent({ type: 'thinking' });
        }
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        text += delta.content;
        onEvent({ type: 'text', text: delta.content });
      }
      for (const [position, call] of (delta.tool_calls ?? []).entries()) {
        // Fragments of one call share an index; a server that sends whole calls may leave it out.
        const index = call.index ?? (call.id !== undefined ? pending.findIndex((entry) => entry.id === call.id) : position);
        let entry = index >= 0 ? pending[index] : undefined;
        if (entry === undefined) {
          entry = { id: call.id ?? '', name: '', args: '' };
          if (index >= 0) pending[index] = entry;
          else pending.push(entry);
        }
        if (call.id !== undefined && call.id.length > 0) entry.id = call.id;
        if (call.function?.name !== undefined && call.function.name.length > 0) {
          if (entry.name.length === 0) onEvent({ type: 'tool', name: call.function.name });
          entry.name = call.function.name;
        }
        if (call.function?.arguments !== undefined) entry.args += call.function.arguments;
      }
    }

    const calls: ToolCall[] = [];
    const wireCalls: WireToolCall[] = [];
    for (const [index, entry] of pending.entries()) {
      if (entry === undefined || entry.name.length === 0) continue;
      const id = entry.id.length > 0 ? entry.id : `call_${Date.now().toString(36)}_${index}`;
      const parsed = parseArguments(entry.args);
      calls.push({ id, name: entry.name, input: parsed.input, invalid: parsed.invalid });
      wireCalls.push({ id, type: 'function', function: { name: entry.name, arguments: parsed.invalid === undefined ? JSON.stringify(parsed.input) : '{}' } });
    }
    // A reply cut off by the length limit may hold half a call: none of that turn's calls are run.
    const cut = finish === 'length';
    const stop: StopReason = cut ? 'length' : finish === 'content_filter' ? 'refusal' : calls.length > 0 ? 'tool' : finish === 'stop' || finish === null ? 'end' : 'other';
    const kept = cut ? [] : calls;
    const raw: Record<string, unknown> = {
      role: 'assistant',
      content: text.length > 0 ? text : null,
      ...(kept.length > 0 ? { tool_calls: wireCalls } : {}),
      // Models that think aloud want their reasoning back with the tool results of the same turn.
      ...(reasoning.length > 0 && kept.length > 0 ? { reasoning_content: reasoning } : {}),
    };
    return { text, calls: kept, stop, usage: { ...usage, cached: Math.min(usage.cached, usage.input) }, model, raw };
  }

  async listModels(): Promise<ModelList> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/models`, { headers: this.headers(false), signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      throw new ProviderError(`Could not reach ${this.baseUrl}: ${(error as Error).message}`, 502, true);
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) throw new ProviderError(errorText(response.status, text), response.status, response.status >= 500);
    let parsed: { data?: { id?: unknown; created?: unknown }[] } | { id?: unknown; created?: unknown }[];
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new ProviderError('The model list is not JSON', 502);
    }
    const entries = (Array.isArray(parsed) ? parsed : (parsed.data ?? [])).filter((entry): entry is { id: string; created?: unknown } => typeof entry?.id === 'string' && entry.id.length > 0);
    // Newest first where the endpoint says when a model appeared, by name otherwise.
    entries.sort((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0) || a.id.localeCompare(b.id));
    const ids = [...new Set(entries.map((entry) => entry.id))];
    return {
      chat: ids.filter((id) => !NOT_CHAT.test(id) && !IMAGE_MODEL.test(id)),
      image: ids.filter((id) => IMAGE_MODEL.test(id) && !/edit|vision|video/i.test(id)),
    };
  }

  async image(model: string, prompt: string, size: ImageSize, signal: AbortSignal): Promise<GeneratedImage> {
    // Each API names the shape its own way; an endpoint whose way is not known draws at its default.
    const dimensions =
      this.kind === 'openai'
        ? { size: size === 'landscape' ? '1536x1024' : size === 'portrait' ? '1024x1536' : '1024x1024' }
        : this.kind === 'xai'
          ? { aspect_ratio: size === 'landscape' ? '3:2' : size === 'portrait' ? '2:3' : '1:1', response_format: 'b64_json' }
          : {};
    const response = await this.post('/images/generations', { model, prompt, n: 1, ...dimensions }, false, signal);
    const text = await response.text().catch(() => '');
    if (!response.ok) throw new ProviderError(errorText(response.status, text), response.status, response.status === 429 || response.status >= 500);
    let parsed: { data?: { b64_json?: unknown; url?: unknown }[] };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new ProviderError('The image answer is not JSON', 502);
    }
    const first = parsed.data?.[0];
    if (typeof first?.b64_json === 'string' && first.b64_json.length > 0) {
      const data = Buffer.from(first.b64_json, 'base64');
      return { data, mime: sniffImage(data) };
    }
    if (typeof first?.url === 'string' && /^https:\/\//.test(first.url)) {
      const download = await this.fetcher(first.url, { signal });
      if (!download.ok) throw new ProviderError(`The picture could not be downloaded (${download.status})`, 502, true);
      const data = Buffer.from(await download.arrayBuffer());
      return { data, mime: sniffImage(data) };
    }
    throw new ProviderError('The provider returned no picture', 502);
  }
}

/** The format of a picture, by its first bytes. */
export function sniffImage(data: Buffer): string {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString('latin1'))) return 'image/gif';
  return 'application/octet-stream';
}
