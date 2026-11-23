/**
 * TorexAi's configuration: which providers are connected and with what keys,
 * which models people may pick, and the limits that apply to everyone.
 *
 * It is set once by the instance administrator and kept as one settings row.
 * API keys are sealed with the instance key and never leave the control
 * plane again: the dashboard is told only the last characters of each.
 */
import {
  AI_PROVIDER_PRESETS,
  aiModelRef,
  parseAiModelRef,
  type AiEffort,
  type AiModelDto,
  type AiProviderDto,
  type AiProviderKind,
  type AiSettingsDto,
  type AiSettingsInput,
  type TeamRole,
} from '@ploy/shared';
import { AppError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import type { Secrets } from '../lib/secrets.ts';
import type { SettingsStore } from '../store/index.ts';
import { AnthropicProvider } from './providers/anthropic.ts';
import { OpenAiProvider } from './providers/openai.ts';
import type { ChatProvider } from './types.ts';

export interface StoredProvider {
  id: string;
  kind: AiProviderKind;
  name: string;
  baseUrl: string;
  /** Sealed; null for an endpoint that needs no key (a local model server). */
  apiKey: string | null;
  keyHint: string | null;
  models: string[];
  imageModel: string | null;
}

export interface StoredAiSettings {
  enabled: boolean;
  providers: StoredProvider[];
  defaultModel: string | null;
  imageModel: string | null;
  minRole: TeamRole;
  effort: AiEffort;
  dailyTokenLimit: number | null;
  instructions: string;
  compactAt: number;
}

const KEY = 'ai';

export const DEFAULT_AI_SETTINGS: StoredAiSettings = {
  enabled: true,
  providers: [],
  defaultModel: null,
  imageModel: null,
  minRole: 'viewer',
  effort: 'auto',
  dailyTokenLimit: null,
  instructions: '',
  // Long before any current model's window fills: a smaller transcript is cheaper on every later step.
  compactAt: 120_000,
};

/** The address a provider is reached at: what was typed, or the kind's own. */
export function providerBaseUrl(provider: { kind: AiProviderKind; baseUrl: string }): string {
  return provider.baseUrl.length > 0 ? provider.baseUrl : AI_PROVIDER_PRESETS[provider.kind].baseUrl;
}

function checkBaseUrl(kind: AiProviderKind, value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) {
    if (kind === 'custom') throw new AppError('validation_failed', 'An address is required for a custom provider', { issues: [{ path: 'baseUrl', code: 'custom', message: 'Required', params: { reason: 'required' } }] });
    return '';
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError('validation_failed', 'The provider address is not a URL', { issues: [{ path: 'baseUrl', code: 'invalid_format', message: 'Not a URL', params: { format: 'url' } }] });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError('validation_failed', 'The provider address must start with https:// or http://', { issues: [{ path: 'baseUrl', code: 'invalid_format', message: 'Not an http(s) URL', params: { format: 'url' } }] });
  }
  return trimmed;
}

export type ProviderFactory = (provider: StoredProvider, apiKey: string) => ChatProvider;

const defaultFactory: ProviderFactory = (provider, apiKey) =>
  provider.kind === 'anthropic'
    ? new AnthropicProvider({ apiKey, baseUrl: provider.baseUrl })
    : new OpenAiProvider({ kind: provider.kind, baseUrl: providerBaseUrl(provider), apiKey });

export class AiSettings {
  private readonly store: SettingsStore;
  private readonly secrets: Secrets;
  private cache: StoredAiSettings | null = null;
  private factory: ProviderFactory = defaultFactory;
  private readonly clients = new Map<string, { stamp: string; client: ChatProvider }>();

  constructor(store: SettingsStore, secrets: Secrets) {
    this.store = store;
    this.secrets = secrets;
  }

  /** Tests answer in place of the real providers. */
  useFactory(factory: ProviderFactory): void {
    this.factory = factory;
    this.clients.clear();
  }

  get(): StoredAiSettings {
    if (this.cache === null) {
      let stored: Partial<StoredAiSettings> = {};
      try {
        stored = JSON.parse(this.store.getRaw(KEY) ?? '{}') as Partial<StoredAiSettings>;
      } catch {
        stored = {};
      }
      this.cache = { ...DEFAULT_AI_SETTINGS, ...stored, providers: Array.isArray(stored.providers) ? stored.providers : [] };
    }
    return this.cache;
  }

  private save(next: StoredAiSettings): void {
    this.store.setRaw(KEY, JSON.stringify(next));
    this.cache = next;
    this.clients.clear();
  }

  dto(): AiSettingsDto {
    const settings = this.get();
    return {
      enabled: settings.enabled,
      providers: settings.providers.map((provider): AiProviderDto => ({ id: provider.id, kind: provider.kind, name: provider.name, baseUrl: provider.baseUrl, keyHint: provider.keyHint, models: provider.models, imageModel: provider.imageModel })),
      defaultModel: settings.defaultModel,
      imageModel: settings.imageModel,
      minRole: settings.minRole,
      effort: settings.effort,
      dailyTokenLimit: settings.dailyTokenLimit,
      instructions: settings.instructions,
      compactAt: settings.compactAt,
    };
  }

  /** Every model a person may pick, in the order the administrator arranged them. */
  models(): AiModelDto[] {
    return this.get().providers.flatMap((provider) => provider.models.map((model) => ({ ref: aiModelRef(provider.id, model), model, provider: provider.name, kind: provider.kind })));
  }

  /** The provider and model a reference names, when both still exist. */
  resolve(ref: string | null | undefined): { provider: StoredProvider; model: string } | null {
    const parsed = parseAiModelRef(ref);
    if (parsed === null) return null;
    const provider = this.get().providers.find((candidate) => candidate.id === parsed.providerId);
    if (provider === undefined || !provider.models.includes(parsed.model)) return null;
    return { provider, model: parsed.model };
  }

  /** The model a conversation uses: its own choice while that still exists, else the default, else the first one there is. */
  pick(preferred: string | null | undefined): { ref: string; provider: StoredProvider; model: string } | null {
    const settings = this.get();
    for (const ref of [preferred, settings.defaultModel, this.models()[0]?.ref]) {
      const found = this.resolve(ref);
      if (found !== null) return { ref: aiModelRef(found.provider.id, found.model), ...found };
    }
    return null;
  }

  /** The provider and model pictures are made with. */
  imageTarget(): { provider: StoredProvider; model: string } | null {
    const settings = this.get();
    const parsed = parseAiModelRef(settings.imageModel);
    const chosen = parsed === null ? undefined : settings.providers.find((provider) => provider.id === parsed.providerId);
    if (chosen !== undefined && parsed !== null && AI_PROVIDER_PRESETS[chosen.kind].images) return { provider: chosen, model: parsed.model };
    const first = settings.providers.find((provider) => provider.imageModel !== null && AI_PROVIDER_PRESETS[provider.kind].images);
    return first === undefined || first.imageModel === null ? null : { provider: first, model: first.imageModel };
  }

  apiKey(provider: StoredProvider): string {
    return provider.apiKey === null ? '' : this.secrets.open(provider.apiKey, 'ai');
  }

  client(provider: StoredProvider): ChatProvider {
    const stamp = `${provider.kind}|${provider.baseUrl}|${provider.apiKey ?? ''}`;
    const known = this.clients.get(provider.id);
    if (known !== undefined && known.stamp === stamp) return known.client;
    const client = this.factory(provider, this.apiKey(provider));
    this.clients.set(provider.id, { stamp, client });
    return client;
  }

  /** A client for a key that is not stored yet (the "test" button of the settings page). */
  probe(kind: AiProviderKind, baseUrl: string, apiKey: string): ChatProvider {
    return this.factory({ id: 'probe', kind, name: 'probe', baseUrl: checkBaseUrl(kind, baseUrl), apiKey: null, keyHint: null, models: [], imageModel: null }, apiKey);
  }

  update(input: AiSettingsInput): StoredAiSettings {
    const before = this.get();
    let providers = before.providers;
    if (input.providers !== undefined) {
      providers = input.providers.map((entry) => {
        const existing = entry.id === undefined ? undefined : before.providers.find((provider) => provider.id === entry.id);
        const baseUrl = checkBaseUrl(entry.kind, entry.baseUrl);
        const typed = entry.apiKey !== undefined && entry.apiKey.length > 0 ? entry.apiKey : null;
        // A key belongs to the address it was typed for: moving the provider elsewhere must not send the old key there.
        const keepKey = existing !== undefined && existing.kind === entry.kind && existing.baseUrl === baseUrl;
        const models = [...new Set(entry.models)];
        return {
          id: existing?.id ?? newId('aip'),
          kind: entry.kind,
          name: entry.name,
          baseUrl,
          apiKey: typed !== null ? this.secrets.seal(typed, 'ai') : keepKey ? existing.apiKey : null,
          keyHint: typed !== null ? typed.slice(-4) : keepKey ? existing.keyHint : null,
          models,
          imageModel: AI_PROVIDER_PRESETS[entry.kind].images && entry.imageModel !== null && entry.imageModel.length > 0 ? entry.imageModel : null,
        };
      });
    }
    const next: StoredAiSettings = {
      enabled: input.enabled ?? before.enabled,
      providers,
      defaultModel: input.defaultModel !== undefined ? input.defaultModel : before.defaultModel,
      imageModel: input.imageModel !== undefined ? input.imageModel : before.imageModel,
      minRole: input.minRole ?? before.minRole,
      effort: input.effort ?? before.effort,
      dailyTokenLimit: input.dailyTokenLimit !== undefined ? input.dailyTokenLimit : before.dailyTokenLimit,
      instructions: input.instructions ?? before.instructions,
      compactAt: input.compactAt ?? before.compactAt,
    };
    // References to a provider or model that is gone fall back to something that exists.
    const refs = new Set(next.providers.flatMap((provider) => provider.models.map((model) => aiModelRef(provider.id, model))));
    if (next.defaultModel === null || !refs.has(next.defaultModel)) next.defaultModel = [...refs][0] ?? null;
    const image = parseAiModelRef(next.imageModel);
    const imageProvider = image === null ? undefined : next.providers.find((provider) => provider.id === image.providerId);
    if (imageProvider === undefined || !AI_PROVIDER_PRESETS[imageProvider.kind].images) {
      const first = next.providers.find((provider) => provider.imageModel !== null);
      next.imageModel = first === undefined || first.imageModel === null ? null : aiModelRef(first.id, first.imageModel);
    }
    this.save(next);
    return next;
  }
}
