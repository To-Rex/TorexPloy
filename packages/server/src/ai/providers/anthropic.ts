/**
 * Claude, through Anthropic's Messages API and its official SDK.
 *
 * What this adapter takes care of beyond sending the conversation:
 * - The prompt cache: the system prompt and tool list are one stable prefix
 *   (the same for every person and conversation), and a second breakpoint
 *   follows the newest message, so each step of a long task re-reads what
 *   came before at the cached price.
 * - Preserved thinking: a turn is stored as Claude returned it and replayed
 *   unchanged, and the transcript is only ever appended to. Should a block
 *   still fail the check (the model was switched mid-conversation), the API
 *   is asked to drop it instead of refusing the request.
 * - Refusals: the request opts into Anthropic's own fallback model, and a
 *   reply that was declined never has its tool calls run.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult, type ModelList, type PromptMessage, type StopReason, type StreamEvent, type ToolCall } from '../types.ts';

type ContentBlock = Anthropic.Beta.BetaContentBlock;
type BlockParam = Anthropic.Beta.BetaContentBlockParam;
type MessageParam = Anthropic.Beta.BetaMessageParam;

export interface AnthropicOptions {
  apiKey: string;
  /** Left empty for api.anthropic.com. */
  baseUrl?: string;
  /** Replaced in tests. */
  fetch?: typeof fetch;
}

interface ModelTraits {
  maxOutput: number;
  adaptive: boolean;
  effort: boolean;
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const BINDING_BETA = 'thinking-binding-controls-2026-08-01';
/** Room for long files written through a tool call; streaming keeps a large ceiling safe from timeouts. */
const MAX_OUTPUT = 64_000;
/** A turn whose tool input did not parse, or whose connection dropped, is asked for again this many times. */
const REISSUE_LIMIT = 2;

/** Tool-use ids must be `[a-zA-Z0-9_-]+`; ids minted by another provider may not be. */
const safeId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * A stored Claude turn, ready to send back. After a mid-reply fallback the
 * API wants the declined model's thinking and tool calls (everything before
 * the last `fallback` block) left out and the block itself kept in place.
 */
export function replayable(content: ContentBlock[]): BlockParam[] {
  let boundary = -1;
  content.forEach((block, index) => {
    if ((block as { type: string }).type === 'fallback') boundary = index;
  });
  const kept = content.filter((block, index) => {
    if (index >= boundary) return true;
    const type = (block as { type: string }).type;
    return type === 'text';
  });
  return kept as unknown as BlockParam[];
}

export function toAnthropicMessages(messages: PromptMessage[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (message.raw !== undefined && message.raw.family === 'anthropic' && Array.isArray(message.raw.content) && message.raw.content.length > 0) {
        out.push({ role: 'assistant', content: replayable(message.raw.content as ContentBlock[]) });
        continue;
      }
      const content: BlockParam[] = [];
      for (const part of message.parts) {
        if (part.type === 'text' && part.text.length > 0) content.push({ type: 'text', text: part.text });
        if (part.type === 'tool_call') content.push({ type: 'tool_use', id: safeId(part.id), name: part.name, input: part.input });
      }
      // An assistant turn may not be empty; two user turns in a row are fine, so an empty one is left out.
      if (content.length > 0) out.push({ role: 'assistant', content });
      continue;
    }
    const content: BlockParam[] = [];
    for (const part of message.parts) {
      if (part.type === 'tool_result') {
        content.push({ type: 'tool_result', tool_use_id: safeId(part.id), content: part.output.length > 0 ? part.output : '(no output)', ...(part.error ? { is_error: true } : {}) });
      } else if (part.type === 'image') {
        content.push({ type: 'image', source: { type: 'base64', media_type: part.mime as 'image/png', data: part.data } });
      } else if (part.type === 'text' && part.text.length > 0) {
        content.push({ type: 'text', text: part.text });
      }
    }
    if (content.length > 0) out.push({ role: 'user', content });
  }
  // The second cache breakpoint: everything up to the newest message.
  const last = out[out.length - 1];
  if (last !== undefined && Array.isArray(last.content)) {
    const block = last.content[last.content.length - 1] as { type: string; cache_control?: unknown } | undefined;
    if (block !== undefined && (block.type === 'text' || block.type === 'tool_result' || block.type === 'image')) {
      last.content = [...last.content.slice(0, -1), { ...block, cache_control: { type: 'ephemeral' } } as BlockParam];
    }
  }
  return out;
}

function providerError(error: unknown): unknown {
  if (error instanceof Anthropic.APIUserAbortError) return new DOMException('Aborted', 'AbortError');
  if (error instanceof Anthropic.AuthenticationError) return new ProviderError(`The API key was refused: ${error.message}`, 401);
  if (error instanceof Anthropic.PermissionDeniedError) return new ProviderError(`The key may not use this: ${error.message}`, 403);
  if (error instanceof Anthropic.NotFoundError) return new ProviderError(`No such model or endpoint: ${error.message}`, 404);
  if (error instanceof Anthropic.RateLimitError) return new ProviderError(`Rate limited: ${error.message}`, 429, true);
  if (error instanceof Anthropic.BadRequestError) return new ProviderError(error.message, 400);
  if (error instanceof Anthropic.APIConnectionError) return new ProviderError(`Could not reach Anthropic: ${error.message}`, 502, true);
  if (error instanceof Anthropic.APIError) return new ProviderError(error.message, error.status ?? 502, (error.status ?? 500) >= 500);
  return error;
}

export class AnthropicProvider implements ChatProvider {
  readonly family = 'anthropic' as const;
  private readonly client: Anthropic;
  private readonly traits = new Map<string, Promise<ModelTraits>>();

  constructor(options: AnthropicOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl !== undefined && options.baseUrl.length > 0 ? { baseURL: options.baseUrl.replace(/\/+$/, '') } : {}),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      maxRetries: 2,
    });
  }

  /** What a model accepts, asked once from the Models API. An unknown model gets the plainest request. */
  private modelTraits(model: string): Promise<ModelTraits> {
    let known = this.traits.get(model);
    if (known === undefined) {
      known = this.client.models
        .retrieve(model)
        .then((info) => ({
          maxOutput: info.max_tokens ?? 16_000,
          adaptive: info.capabilities?.thinking?.types?.adaptive?.supported === true,
          effort: info.capabilities?.effort?.supported === true,
        }))
        .catch((): ModelTraits => {
          this.traits.delete(model);
          return { maxOutput: 16_000, adaptive: false, effort: false };
        });
      this.traits.set(model, known);
    }
    return known;
  }

  async chat(request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<ChatResult> {
    const traits = await this.modelTraits(request.model);
    const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: Math.min(MAX_OUTPUT, traits.maxOutput),
      // Tools render before the system prompt, so this one breakpoint caches both.
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      messages: toAnthropicMessages(request.messages),
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.schema as Anthropic.Beta.BetaTool.InputSchema,
        // Long inputs (a file's contents) stream as they are written; the agent validates every input before running it.
        eager_input_streaming: true,
      })),
      // A request the model's classifiers decline is answered by Anthropic's recommended substitute instead.
      fallbacks: 'default',
      betas: traits.adaptive ? [FALLBACK_BETA, BINDING_BETA] : [FALLBACK_BETA],
      ...(traits.adaptive ? { thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } } : {}),
      ...(request.effort !== 'auto' && traits.effort ? { output_config: { effort: request.effort } } : {}),
    };

    for (let attempt = 0; ; attempt += 1) {
      let emitted = false;
      try {
        const stream = this.client.beta.messages.stream(params, { signal: request.signal });
        for await (const event of stream) {
          if (event.type === 'content_block_start') {
            const type = (event.content_block as { type: string }).type;
            if (type === 'thinking' || type === 'redacted_thinking') onEvent({ type: 'thinking' });
            else if (event.content_block.type === 'tool_use') onEvent({ type: 'tool', name: event.content_block.name });
          } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            emitted = true;
            onEvent({ type: 'text', text: event.delta.text });
          }
        }
        return this.result(await stream.finalMessage());
      } catch (error) {
        const mapped = providerError(error);
        // A tool input that could not be parsed, or a dropped connection: neither is an API error, and both are worth asking again
        // (as long as nothing of the lost reply was already shown).
        const transient = !(error instanceof Anthropic.APIError) && (error as Error).name !== 'AbortError' && !request.signal.aborted;
        if (transient && !emitted && attempt < REISSUE_LIMIT) continue;
        if (transient) throw new ProviderError(`The reply was lost on the way: ${(error as Error).message}`, 502, true);
        throw mapped;
      }
    }
  }

  private result(message: Anthropic.Beta.BetaMessage): ChatResult {
    const content = message.content;
    let boundary = -1;
    content.forEach((block, index) => {
      if ((block as { type: string }).type === 'fallback') boundary = index;
    });
    const text = content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    const reason = message.stop_reason;
    // Tool calls of a refused or cut-off reply may be incomplete and are never run; nor are the declined model's (before the fallback).
    const runnable = reason === 'tool_use';
    const calls: ToolCall[] = [];
    if (runnable) {
      content.forEach((block, index) => {
        if (block.type !== 'tool_use' || index < boundary) return;
        const input = block.input;
        if (typeof input === 'object' && input !== null && !Array.isArray(input)) calls.push({ id: block.id, name: block.name, input: input as Record<string, unknown> });
        else calls.push({ id: block.id, name: block.name, input: {}, invalid: JSON.stringify(input).slice(0, 2_000) });
      });
    }
    const hasToolUse = content.some((block) => block.type === 'tool_use');
    const stop: StopReason =
      reason === 'refusal' ? 'refusal' : reason === 'max_tokens' ? 'length' : reason === 'model_context_window_exceeded' ? 'context' : runnable && calls.length > 0 ? 'tool' : reason === 'end_turn' || reason === 'stop_sequence' ? 'end' : 'other';
    const usage = message.usage;
    const cached = usage.cache_read_input_tokens ?? 0;
    return {
      text,
      calls,
      stop,
      usage: { input: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + cached, output: usage.output_tokens, cached },
      model: message.model,
      // A turn holding tool calls that were not run cannot go back as it is (every call needs its result): only its text is kept.
      raw: hasToolUse && !runnable ? null : content,
    };
  }

  async listModels(): Promise<ModelList> {
    try {
      const models: { id: string; created: number }[] = [];
      for await (const model of this.client.models.list({ limit: 100 })) {
        // Retired models are still listed for a while; they would only fail when picked.
        if ((model as { deprecated_at?: string | null }).deprecated_at != null) continue;
        models.push({ id: model.id, created: Date.parse(model.created_at) || 0 });
        if (models.length >= 200) break;
      }
      models.sort((a, b) => b.created - a.created);
      return { chat: models.map((model) => model.id), image: [] };
    } catch (error) {
      throw providerError(error);
    }
  }
}
