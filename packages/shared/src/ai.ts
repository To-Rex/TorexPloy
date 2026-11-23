/**
 * TorexAi: the assistant that runs the platform and its servers.
 *
 * The contract between the control plane and the dashboard: which model
 * providers can be connected, what a conversation holds, how an action the
 * assistant takes is described (its risk, whether it waits for approval,
 * whether it can be undone) and what the live event stream carries.
 */
import { z } from 'zod';
import { TEAM_ROLES, type TeamRole } from './constants.ts';

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * `anthropic` speaks the Messages API; every other kind speaks the OpenAI
 * chat-completions format (ChatGPT, Grok, Deploy and anything compatible:
 * OpenRouter, DeepSeek, Gemini's compatibility endpoint, Ollama).
 */
export const AI_PROVIDER_KINDS = ['anthropic', 'openai', 'xai', 'deploy', 'custom'] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

export interface AiProviderPreset {
  name: string;
  /** Where the API is served; empty for `custom`, where the administrator types it. */
  baseUrl: string;
  /** Whether the provider can make pictures (an images endpoint). */
  images: boolean;
  /** Where an API key is made. */
  keysUrl: string;
  /** Chat models offered when the provider has no model list to ask (or it could not be read). */
  models: readonly string[];
  /** The model suggested first. */
  suggested: string | null;
  imageModels: readonly string[];
}

export const AI_PROVIDER_PRESETS: Record<AiProviderKind, AiProviderPreset> = {
  anthropic: {
    name: 'Claude',
    baseUrl: 'https://api.anthropic.com',
    images: false,
    keysUrl: 'https://platform.claude.com/settings/keys',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'],
    suggested: 'claude-opus-5-5',
    imageModels: [],
  },
  openai: {
    name: 'ChatGPT',
    baseUrl: 'https://api.openai.com/v1',
    images: true,
    keysUrl: 'https://platform.openai.com/api-keys',
    models: [],
    suggested: null,
    imageModels: [],
  },
  xai: {
    name: 'Grok',
    baseUrl: 'https://api.x.ai/v1',
    images: true,
    keysUrl: 'https://console.x.ai',
    models: [],
    suggested: null,
    imageModels: [],
  },
  deploy: {
    name: 'Deploy',
    baseUrl: 'https://api.deploy.com/api/v1',
    images: false,
    keysUrl: 'https://deploy.com',
    // Deploy documents no model list endpoint; these are the models its documentation lists.
    models: ['deepseek-ai/deepseek-v4.1-flash-1017', 'zai-org/glm-5.3-flash'],
    suggested: 'deepseek-ai/deepseek-v4.1-flash-1017',
    imageModels: [],
  },
  custom: {
    name: 'OpenAI-compatible',
    baseUrl: '',
    images: true,
    keysUrl: '',
    models: [],
    suggested: null,
    imageModels: [],
  },
};

/** How hard the model is asked to think: `auto` leaves the provider's default. */
export const AI_EFFORTS = ['auto', 'low', 'medium', 'high'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];

/** A model as conversations name it: `<provider id>:<model id>`. */
export function aiModelRef(providerId: string, model: string): string {
  return `${providerId}:${model}`;
}

export function parseAiModelRef(ref: string | null | undefined): { providerId: string; model: string } | null {
  if (ref == null) return null;
  const colon = ref.indexOf(':');
  if (colon <= 0 || colon === ref.length - 1) return null;
  return { providerId: ref.slice(0, colon), model: ref.slice(colon + 1) };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * How much an action can change:
 * - `safe`: it only reads, or it changes nothing outside the conversation (a file made for download, an edit in a private working copy);
 * - `change`: it changes the platform or a server in an ordinary way; asked about unless the conversation allows such changes;
 * - `danger`: it deletes, overwrites or cannot be taken back; always asked about.
 */
export const AI_RISKS = ['safe', 'change', 'danger'] as const;
export type AiRisk = (typeof AI_RISKS)[number];

/** `pending`: waiting for the person's answer. `rejected`: they said no. `cancelled`: the run stopped before an answer. */
export const AI_ACTION_STATUSES = ['pending', 'running', 'done', 'failed', 'rejected', 'cancelled'] as const;
export type AiActionStatus = (typeof AI_ACTION_STATUSES)[number];

export const AI_TOOLS = [
  'platform_map',
  'api_docs',
  'api_call',
  'logs',
  'wait_deployment',
  'shell',
  'exec',
  'file_read',
  'file_list',
  'file_search',
  'file_write',
  'file_edit',
  'code',
  'create_file',
  'generate_image',
  'read_output',
  'undo',
] as const;
export type AiToolName = (typeof AI_TOOLS)[number];

/** What taking an action back does: shown to the person in their own language. */
export const AI_UNDO_KINDS = ['delete', 'restore', 'opposite', 'rollback', 'file_restore', 'file_remove'] as const;
export type AiUndoKind = (typeof AI_UNDO_KINDS)[number];

export const AI_FILE_KINDS = ['upload', 'generated', 'image', 'snapshot'] as const;
export type AiFileKind = (typeof AI_FILE_KINDS)[number];

export const AI_LIMITS = {
  /** A message as typed. */
  messageMax: 32_000,
  /** Files attached to one message. */
  attachmentsMax: 10,
  /** One attached or generated file. */
  fileMax: 20 * 1024 * 1024,
  /** How much of an attached text file the model is shown. */
  attachmentTextMax: 120_000,
  /** A picture larger than this is not shown to a model (providers refuse it); the dashboard scales pictures down before sending. */
  imageMax: 4_500_000,
  /** The longest side, in pixels, a picture is scaled down to before it is sent. */
  imageSide: 2_000,
  /** A PDF larger than this is not handed to a model. */
  pdfMax: 18 * 1024 * 1024,
  titleMax: 120,
  instructionsMax: 4_000,
  providersMax: 12,
  modelsPerProvider: 40,
  /** Conversations one person may keep in a team. */
  chatsMax: 500,
} as const;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface AiProviderDto {
  id: string;
  kind: AiProviderKind;
  name: string;
  baseUrl: string;
  /** The last characters of the stored key, so the administrator can tell which one it is. */
  keyHint: string | null;
  /** Chat models people may pick, in the order shown. */
  models: string[];
  imageModel: string | null;
}

export interface AiSettingsDto {
  enabled: boolean;
  providers: AiProviderDto[];
  /** `<provider id>:<model>` new conversations start with. */
  defaultModel: string | null;
  /** `<provider id>:<model>` pictures are made with; null when no provider that can make them is connected. */
  imageModel: string | null;
  /** The lowest team role that may talk to TorexAi. What it may then do is always the person's own role. */
  minRole: TeamRole;
  effort: AiEffort;
  /** Input plus output tokens one person may use in a day; null for no limit. */
  dailyTokenLimit: number | null;
  /** Extra instructions from the administrator, given to the model with every conversation. */
  instructions: string;
  /** The conversation is condensed into a summary once a request grows beyond this many input tokens. */
  compactAt: number;
}

export interface AiModelDto {
  /** `<provider id>:<model>`. */
  ref: string;
  model: string;
  provider: string;
  kind: AiProviderKind;
}

export type AiUnavailableReason = 'disabled' | 'not_configured' | 'role';

export interface AiStatusDto {
  /** Whether this person can start a conversation now. */
  ready: boolean;
  reason: AiUnavailableReason | null;
  models: AiModelDto[];
  defaultModel: string | null;
  /** Pictures can be made. */
  images: boolean;
  /** The caller may open the TorexAi settings (the instance administrator). */
  canConfigure: boolean;
  usage: { today: number; limit: number | null };
}

export interface AiChatDto {
  id: string;
  title: string;
  model: string | null;
  pinned: boolean;
  /** Ordinary changes are carried out without asking in this conversation; dangerous ones still ask. */
  autoApprove: boolean;
  /** A reply is being written (or waits for an approval) right now. */
  running: boolean;
  /** An action of this conversation waits for the person's answer. */
  waiting: boolean;
  tokens: { input: number; output: number };
  createdAt: string;
  updatedAt: string;
}

export interface AiFileDto {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AiFileKind;
  createdAt: string;
}

/** What a message shows, in order: prose, attached files, and the actions taken between paragraphs. */
export type AiViewBlock = { type: 'text'; text: string } | { type: 'file'; file: AiFileDto } | { type: 'action'; actionId: string };

export interface AiMessageDto {
  id: string;
  seq: number;
  /** `summary`: the conversation up to here was condensed; the model continues from the summary. */
  role: 'user' | 'assistant' | 'summary';
  blocks: AiViewBlock[];
  model: string | null;
  usage: { input: number; output: number; cached: number } | null;
  /** Why the reply ended early, when it did. */
  error: { code: string; message: string } | null;
  createdAt: string;
}

export interface AiActionDto {
  id: string;
  chatId: string;
  messageId: string;
  tool: AiToolName;
  /** One sentence in the person's language: what is being done and why. */
  title: string;
  /** The technical line under it: `POST /api/applications/app_x/deploy`, a command, a file path. */
  detail: string;
  /** What exactly will run, for the approval card (a request body, a command, a diff). */
  preview: string | null;
  risk: AiRisk;
  status: AiActionStatus;
  /** One line about the outcome. */
  summary: string | null;
  /** The beginning of the output; the whole of it is at `GET /api/ai/actions/:id/output`. */
  output: string | null;
  outputTruncated: boolean;
  /** It can be taken back with `POST /api/ai/actions/:id/undo`. */
  undoable: boolean;
  /** What undoing does. */
  undoKind: AiUndoKind | null;
  undoneAt: string | null;
  undoError: string | null;
  /** Files it made (a document for download, a picture). */
  files: AiFileDto[];
  createdAt: string;
  finishedAt: string | null;
}

export interface AiChatDetailDto {
  chat: AiChatDto;
  messages: AiMessageDto[];
  actions: AiActionDto[];
}

/** What the model is doing at this moment. */
export type AiRunState = 'idle' | 'thinking' | 'writing' | 'tool' | 'waiting';

/** The live stream of one conversation (`GET /api/ai/chats/:id/events`). */
export type AiEvent =
  /** Sent first on every connection: where the conversation stands, and the reply written so far. */
  | { type: 'snapshot'; chat: AiChatDto; state: AiRunState; draft: string }
  | { type: 'message'; message: AiMessageDto }
  | { type: 'delta'; text: string }
  | { type: 'state'; state: AiRunState; tool?: AiToolName }
  | { type: 'action'; action: AiActionDto }
  | { type: 'chat'; chat: AiChatDto }
  | { type: 'done'; reason: 'end' | 'stopped' | 'error' | 'limit'; error?: { code: string; message: string } };

export interface AiUsageDto {
  days: { day: string; input: number; output: number; cached: number; requests: number }[];
  users: { userId: string; name: string; input: number; output: number; requests: number }[];
  models: { model: string; input: number; output: number; requests: number }[];
}

export interface AiProviderTestDto {
  ok: boolean;
  /** Chat models the key can use, when the provider lists them. */
  models: string[];
  imageModels: string[];
  /** The provider's own words when the key or the address was refused. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Charts in replies
// ---------------------------------------------------------------------------

/**
 * A fenced block with the language `chart` in a reply is drawn as a chart.
 * `metric` charts name a resource and the dashboard reads its history itself,
 * so the numbers never pass through the model.
 */
export type AiChartSpec =
  | {
      type: 'line' | 'area' | 'bar';
      title?: string;
      unit?: string;
      x: (string | number)[];
      series: { name: string; data: (number | null)[] }[];
    }
  | { type: 'pie'; title?: string; unit?: string; slices: { name: string; value: number }[] }
  | { type: 'metric'; target: string; metric: 'cpu' | 'memory' | 'network' | 'disk' | 'load'; range?: '1h' | '6h' | '24h' | '7d'; title?: string };

export function parseAiChart(source: string): AiChartSpec | null {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const spec = value as Record<string, unknown>;
  const isNumberList = (list: unknown): boolean => Array.isArray(list) && list.every((item) => item === null || (typeof item === 'number' && Number.isFinite(item)));
  if (spec.type === 'metric') {
    if (typeof spec.target !== 'string' || !/^(app|service|server):[A-Za-z0-9_-]{1,64}$/.test(spec.target)) return null;
    if (!['cpu', 'memory', 'network', 'disk', 'load'].includes(String(spec.metric))) return null;
    if (spec.range !== undefined && !['1h', '6h', '24h', '7d'].includes(String(spec.range))) return null;
    return spec as unknown as AiChartSpec;
  }
  if (spec.type === 'pie') {
    if (!Array.isArray(spec.slices) || spec.slices.length === 0 || spec.slices.length > 24) return null;
    const ok = spec.slices.every((slice) => typeof slice === 'object' && slice !== null && typeof (slice as { name?: unknown }).name === 'string' && Number.isFinite((slice as { value?: unknown }).value) && ((slice as { value: number }).value >= 0));
    return ok ? (spec as unknown as AiChartSpec) : null;
  }
  if (spec.type === 'line' || spec.type === 'area' || spec.type === 'bar') {
    if (!Array.isArray(spec.x) || spec.x.length === 0 || spec.x.length > 500) return null;
    if (!Array.isArray(spec.series) || spec.series.length === 0 || spec.series.length > 8) return null;
    const length = spec.x.length;
    const ok = spec.series.every((series) => typeof series === 'object' && series !== null && typeof (series as { name?: unknown }).name === 'string' && isNumberList((series as { data?: unknown }).data) && ((series as { data: unknown[] }).data.length === length));
    return ok ? (spec as unknown as AiChartSpec) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const modelRef = z.string().trim().min(3).max(300);

export const aiProviderInputSchema = z.object({
  /** Present for a provider that is already stored; absent for a new one. */
  id: z.string().trim().max(40).optional(),
  kind: z.enum(AI_PROVIDER_KINDS),
  name: z.string().trim().min(1).max(60),
  baseUrl: z.string().trim().max(300).default(''),
  /** A new key; left out to keep the stored one. */
  apiKey: z.string().trim().max(600).optional(),
  models: z.array(z.string().trim().min(1).max(200)).max(AI_LIMITS.modelsPerProvider).default([]),
  imageModel: z.string().trim().max(200).nullable().default(null),
});
export type AiProviderInput = z.infer<typeof aiProviderInputSchema>;

export const aiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  providers: z.array(aiProviderInputSchema).max(AI_LIMITS.providersMax).optional(),
  defaultModel: modelRef.nullable().optional(),
  imageModel: modelRef.nullable().optional(),
  minRole: z.enum(TEAM_ROLES).optional(),
  effort: z.enum(AI_EFFORTS).optional(),
  dailyTokenLimit: z.number().int().min(1_000).max(1_000_000_000).nullable().optional(),
  instructions: z.string().max(AI_LIMITS.instructionsMax).optional(),
  compactAt: z.number().int().min(8_000).max(900_000).optional(),
});
export type AiSettingsInput = z.infer<typeof aiSettingsSchema>;

export const aiProviderTestSchema = z.object({
  /** Test the key stored for this provider… */
  id: z.string().trim().max(40).optional(),
  kind: z.enum(AI_PROVIDER_KINDS),
  baseUrl: z.string().trim().max(300).default(''),
  /** …or a key that has just been typed. */
  apiKey: z.string().trim().max(600).optional(),
});

/** Where the person was in the dashboard when they wrote, so "this application" means something. */
export const aiContextSchema = z.object({
  path: z.string().max(300).optional(),
  applicationId: z.string().max(64).optional(),
  serviceId: z.string().max(64).optional(),
  serverId: z.string().max(64).optional(),
  projectId: z.string().max(64).optional(),
  deploymentId: z.string().max(64).optional(),
});
export type AiContextInput = z.infer<typeof aiContextSchema>;

export const aiCreateChatSchema = z.object({
  model: modelRef.optional(),
});

export const aiUpdateChatSchema = z.object({
  title: z.string().trim().min(1).max(AI_LIMITS.titleMax).optional(),
  pinned: z.boolean().optional(),
  autoApprove: z.boolean().optional(),
  model: modelRef.optional(),
});

export const aiSendMessageSchema = z
  .object({
    /** May be empty when files are attached: a screenshot can be the whole message. */
    text: z.string().trim().max(AI_LIMITS.messageMax).default(''),
    files: z.array(z.string().max(64)).max(AI_LIMITS.attachmentsMax).default([]),
    context: aiContextSchema.optional(),
    model: modelRef.optional(),
  })
  .refine((input) => input.text.length > 0 || input.files.length > 0, { path: ['text'], message: 'Write a message or attach a file' });

export const aiDecisionSchema = z.object({
  approve: z.boolean(),
  /** With an approval: carry out ordinary changes without asking for the rest of this conversation. */
  always: z.boolean().default(false),
});

export const aiChatListQuerySchema = z.object({
  query: z.string().trim().max(120).optional(),
});

export const aiUsageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});
