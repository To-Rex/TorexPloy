/**
 * What TorexAi's parts say to each other.
 *
 * A transcript is kept in a provider-neutral form (`AiBlock`), so a
 * conversation can move between Claude, ChatGPT, Grok and Deploy. Each
 * provider adapter turns that form into its own request and its streamed
 * answer back into text and tool calls.
 */
import type { AiEffort, AiRisk, AiToolName, AiUndoKind } from '@ploy/shared';

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export type AiBlock =
  | { type: 'text'; text: string }
  /** Text for the model only: where the person is in the dashboard, what they undid. Never shown. */
  | { type: 'context'; text: string }
  | { type: 'file'; fileId: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; output: string; error?: boolean };

export type AiRole = 'user' | 'assistant' | 'tool' | 'summary';

export interface AiUsage {
  /** Every input token of the request, cached ones included. */
  input: number;
  output: number;
  /** The part of `input` read from the provider's prompt cache. */
  cached: number;
}

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

/** The two wire formats: Anthropic's Messages API, and OpenAI chat completions (ChatGPT, Grok, Deploy, compatible ones). */
export type ProviderFamily = 'anthropic' | 'openai';

export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; output: string; error: boolean };

export interface PromptMessage {
  role: 'user' | 'assistant' | 'tool';
  parts: PromptPart[];
  /** The turn as a provider of this family returned it; an adapter of the same family replays it unchanged. */
  raw?: { family: ProviderFamily; content: unknown } | undefined;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the input object. */
  schema: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: PromptMessage[];
  tools: ToolSpec[];
  effort: AiEffort;
  signal: AbortSignal;
}

export type StreamEvent = { type: 'text'; text: string } | { type: 'thinking' } | { type: 'tool'; name: string };

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** The arguments did not parse as a JSON object: the call is answered with an error instead of being run. */
  invalid?: string | undefined;
}

/** `context`: the conversation no longer fits the model's window and has to be condensed first. */
export type StopReason = 'end' | 'tool' | 'length' | 'context' | 'refusal' | 'other';

export interface ChatResult {
  text: string;
  calls: ToolCall[];
  stop: StopReason;
  usage: AiUsage;
  /** The model that answered (a provider may substitute one). */
  model: string;
  /** The turn in the provider's own form, kept for replay. */
  raw: unknown;
}

export interface ModelList {
  chat: string[];
  image: string[];
}

export interface GeneratedImage {
  mime: string;
  data: Buffer;
}

export interface ChatProvider {
  readonly family: ProviderFamily;
  chat(request: ChatRequest, onEvent: (event: StreamEvent) => void): Promise<ChatResult>;
  listModels(): Promise<ModelList>;
  /** Make a picture. Absent on providers that have no images endpoint. */
  image?(model: string, prompt: string, size: ImageSize, signal: AbortSignal): Promise<GeneratedImage>;
}

export type ImageSize = 'square' | 'landscape' | 'portrait';

/** A provider said no: a bad key, an unknown model, a rate limit, an outage. `retryable` ones are worth one more try. */
export class ProviderError extends Error {
  override name = 'ProviderError';
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** How to take an action back. Carried out as the person who asks, with their role. */
export type UndoRecipe =
  | { kind: 'api'; does: AiUndoKind; label: string; method: string; path: string; query?: Record<string, string>; body?: unknown }
  | { kind: 'file'; does: AiUndoKind; label: string; where: string; path: string; /** The file with the earlier contents; null when the write created the file. */ snapshotId: string | null };

export interface ToolOutcome {
  /** What the model reads. */
  output: string;
  /** What the person reads, when it differs: their own data with the secrets the model's copy has hidden. */
  display?: string;
  /** One line for the person. */
  summary: string;
  error?: boolean;
  undo?: UndoRecipe | null;
  /** Files made by the action, to show under it. */
  fileIds?: string[];
}

export interface ToolPlan {
  /** One sentence for the person: what is about to happen. */
  title: string;
  /** The technical line: a method and path, a command, a file. */
  detail: string;
  /** What exactly will run, shown on the approval card. */
  preview?: string | null;
  risk: AiRisk;
  /** Ask the person even where ordinary changes are allowed without asking (showing secrets to the model). */
  confirm?: boolean;
  run: (signal: AbortSignal) => Promise<ToolOutcome>;
}

export type ToolName = AiToolName;
