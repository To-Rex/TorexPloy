/**
 * TorexAi settings, for the instance administrator: which model providers
 * are connected, which models people may pick, who may use the assistant
 * and how much, and how many tokens have been spent.
 *
 * It is set up here once; after that everyone uses it with their own role.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, CircleAlert, ExternalLink, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { AI_EFFORTS, AI_PROVIDER_KINDS, AI_PROVIDER_PRESETS, aiModelRef, TEAM_ROLES, type AiEffort, type AiProviderKind, type AiSettingsDto, type AiSettingsInput, type TeamRole } from '@ploy/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Card, SaveFooter } from '../../components/Frame.tsx';
import { Menu, MenuItem } from '../../components/Menu.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Button, Callout, Field, Input, Segmented, Select, Skeleton, Switch, Textarea } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { aiKeys, saveAiSettings, testAiProvider, useAiSettings, useAiUsage } from '../ai/aiApi.ts';
import '../ai/ai.css';

interface ProviderDraft {
  /** Stable in this form only. */
  key: string;
  id: string | undefined;
  kind: AiProviderKind;
  name: string;
  baseUrl: string;
  /** A key that was just typed; empty keeps the stored one. */
  apiKey: string;
  keyHint: string | null;
  models: string[];
  imageModel: string | null;
  /** What the provider offers, once asked. */
  offered: string[];
  offeredImages: string[];
  check: 'idle' | 'checking' | 'ok' | 'failed';
  checkError: string | null;
  /** A model name typed by hand. */
  typed: string;
}

interface Draft {
  enabled: boolean;
  providers: ProviderDraft[];
  defaultModel: string | null;
  imageModel: string | null;
  minRole: TeamRole;
  effort: AiEffort;
  dailyTokenLimit: string;
  instructions: string;
  compactAt: string;
}

let keySeq = 0;
const nextKey = (): string => `p${(keySeq += 1)}`;

function toDraft(settings: AiSettingsDto): Draft {
  return {
    enabled: settings.enabled,
    providers: settings.providers.map((provider) => ({
      key: nextKey(),
      id: provider.id,
      kind: provider.kind,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: '',
      keyHint: provider.keyHint,
      models: provider.models,
      imageModel: provider.imageModel,
      offered: [],
      offeredImages: [],
      check: 'idle',
      checkError: null,
      typed: '',
    })),
    defaultModel: settings.defaultModel,
    imageModel: settings.imageModel,
    minRole: settings.minRole,
    effort: settings.effort,
    dailyTokenLimit: settings.dailyTokenLimit === null ? '' : String(settings.dailyTokenLimit),
    instructions: settings.instructions,
    compactAt: String(settings.compactAt),
  };
}

/** What is sent when saving; also what "has anything changed" compares. */
function toInput(draft: Draft): AiSettingsInput {
  const limit = Number(draft.dailyTokenLimit.replace(/\s/g, ''));
  const compact = Number(draft.compactAt.replace(/\s/g, ''));
  return {
    enabled: draft.enabled,
    providers: draft.providers.map((provider) => ({
      ...(provider.id === undefined ? {} : { id: provider.id }),
      kind: provider.kind,
      name: provider.name.trim(),
      baseUrl: provider.baseUrl.trim(),
      ...(provider.apiKey.trim().length > 0 ? { apiKey: provider.apiKey.trim() } : {}),
      models: provider.models,
      imageModel: provider.imageModel,
    })),
    defaultModel: draft.defaultModel,
    imageModel: draft.imageModel,
    minRole: draft.minRole,
    effort: draft.effort,
    dailyTokenLimit: draft.dailyTokenLimit.trim().length === 0 || !Number.isFinite(limit) ? null : Math.max(1_000, Math.round(limit)),
    instructions: draft.instructions,
    compactAt: Number.isFinite(compact) ? Math.min(900_000, Math.max(8_000, Math.round(compact))) : 120_000,
  };
}

function Usage() {
  const { m, formatNumber, formatDate } = useI18n();
  const usage = useAiUsage(30);
  const days = useMemo(() => {
    // Every day of the window, with zeros where nothing was used.
    const byDay = new Map((usage.data?.days ?? []).map((day) => [day.day, day]));
    const out: { day: string; input: number; output: number }[] = [];
    for (let back = 29; back >= 0; back -= 1) {
      const day = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
      const found = byDay.get(day);
      out.push({ day, input: found === undefined ? 0 : found.input - found.cached, output: found?.output ?? 0 });
    }
    return out;
  }, [usage.data]);
  if (usage.data === undefined) return <Skeleton height={140} />;
  const peak = Math.max(1, ...days.map((day) => day.input + day.output));
  const total = usage.data.days.reduce((sum, day) => sum + day.input + day.output, 0);
  const requests = usage.data.days.reduce((sum, day) => sum + day.requests, 0);
  const compact = (value: number): string => formatNumber(value, { notation: 'compact', maximumFractionDigits: 1 });
  if (total === 0) return <p className="faint" style={{ margin: 0 }}>{m.ai.settings.usageEmpty}</p>;
  return (
    <div className="tai-usage">
      <div className="row wrap" style={{ gap: '4px 20px', fontSize: 'var(--text-sm)' }}>
        <span>
          <strong>{compact(total)}</strong> {m.ai.settings.usageTokens}
        </span>
        <span>
          <strong>{formatNumber(requests)}</strong> {m.ai.settings.usageRequests}
        </span>
        <span className="tai-chart__legend" style={{ margin: 0 }}>
          <span>
            <i style={{ background: 'var(--info)' }} />
            {m.ai.settings.usageInput}
          </span>
          <span>
            <i style={{ background: 'var(--ok)' }} />
            {m.ai.settings.usageOutput}
          </span>
        </span>
      </div>
      <div>
        <div className="tai-usage__bars" role="img" aria-label={m.ai.settings.usageTitle}>
          {days.map((day) => (
            <div key={day.day} className="tai-usage__bar" data-empty={day.input + day.output === 0 || undefined} title={`${formatDate(day.day, { day: 'numeric', month: 'short' })}: ${compact(day.input + day.output)}`}>
              <i style={{ height: `${(day.input / peak) * 100}%` }} />
              <i style={{ height: `${(day.output / peak) * 100}%` }} />
            </div>
          ))}
        </div>
        <div className="tai-usage__axis">
          <span>{formatDate(days[0]!.day, { day: 'numeric', month: 'short' })}</span>
          <span>{formatDate(days[days.length - 1]!.day, { day: 'numeric', month: 'short' })}</span>
        </div>
      </div>
      <div className="tai-usage__tables">
        <div>
          <h4>{m.ai.settings.usageByPerson}</h4>
          {usage.data.users.slice(0, 8).map((user) => (
            <div key={user.userId} className="tai-usage__row">
              <span className="truncate">{user.name}</span>
              <span>{compact(user.input + user.output)}</span>
            </div>
          ))}
        </div>
        <div>
          <h4>{m.ai.settings.usageByModel}</h4>
          {usage.data.models.slice(0, 8).map((model) => (
            <div key={model.model} className="tai-usage__row">
              <span className="truncate mono">{model.model.slice(model.model.indexOf(':') + 1)}</span>
              <span>{compact(model.input + model.output)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AiSettingsPage() {
  const { m, t } = useI18n();
  const s = m.ai.settings;
  const toast = useToast();
  const client = useQueryClient();
  const settings = useAiSettings();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<AiSettingsDto | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings.data === undefined || saved !== null) return;
    setSaved(settings.data);
    setDraft(toDraft(settings.data));
  }, [settings.data, saved]);

  const dirty = useMemo(() => draft !== null && saved !== null && JSON.stringify(toInput(draft)) !== JSON.stringify(toInput(toDraft(saved))), [draft, saved]);

  if (settings.isError) return <Callout tone="bad">{m.errors.codes.forbidden}</Callout>;
  if (draft === null || saved === null) return <Skeleton height={220} />;

  const update = (patch: Partial<Draft>): void => setDraft((current) => (current === null ? current : { ...current, ...patch }));
  const updateProvider = (key: string, patch: Partial<ProviderDraft>): void =>
    setDraft((current) => (current === null ? current : { ...current, providers: current.providers.map((provider) => (provider.key === key ? { ...provider, ...patch } : provider)) }));

  const addProvider = (kind: AiProviderKind): void => {
    const preset = AI_PROVIDER_PRESETS[kind];
    update({
      providers: [
        ...draft.providers,
        { key: nextKey(), id: undefined, kind, name: preset.name, baseUrl: '', apiKey: '', keyHint: null, models: preset.suggested === null ? [] : [preset.suggested], imageModel: null, offered: [...preset.models], offeredImages: [], check: 'idle', checkError: null, typed: '' },
      ],
    });
  };

  const check = async (provider: ProviderDraft): Promise<void> => {
    updateProvider(provider.key, { check: 'checking', checkError: null });
    try {
      const result = await testAiProvider({ ...(provider.id === undefined ? {} : { id: provider.id }), kind: provider.kind, baseUrl: provider.baseUrl.trim(), ...(provider.apiKey.trim().length > 0 ? { apiKey: provider.apiKey.trim() } : {}) });
      if (!result.ok) {
        updateProvider(provider.key, { check: 'failed', checkError: result.error });
        return;
      }
      // A provider that has just been connected starts with its first model switched on, so it works at once.
      const models = provider.models.length > 0 ? provider.models : result.models.slice(0, 1);
      const imageModel = provider.imageModel ?? result.imageModels[0] ?? null;
      updateProvider(provider.key, { check: 'ok', offered: result.models, offeredImages: result.imageModels, models, imageModel });
    } catch (error) {
      toast.error(error);
      updateProvider(provider.key, { check: 'idle' });
    }
  };

  const save = async (): Promise<void> => {
    const unnamed = draft.providers.find((provider) => provider.name.trim().length === 0);
    if (unnamed !== undefined) {
      toast.failure(s.nameRequired);
      return;
    }
    setSaving(true);
    try {
      const result = await saveAiSettings(toInput(draft));
      // Models that were offered stay offered, so nothing has to be checked again after saving.
      const next = toDraft(result);
      next.providers = next.providers.map((provider, index) => {
        const before = draft.providers[index];
        return before === undefined ? provider : { ...provider, offered: before.offered, offeredImages: before.offeredImages, check: before.check === 'ok' ? 'ok' : 'idle' };
      });
      setSaved(result);
      setDraft(next);
      toast.success(m.common.saved);
      void client.invalidateQueries({ queryKey: aiKeys.status });
      client.setQueryData(aiKeys.settings, result);
    } catch (error) {
      toast.error(error);
    } finally {
      setSaving(false);
    }
  };

  const savedModels = saved.providers.flatMap((provider) => provider.models.map((model) => ({ ref: aiModelRef(provider.id, model), label: `${provider.name} · ${model}` })));
  const savedImages = saved.providers.filter((provider) => provider.imageModel !== null && AI_PROVIDER_PRESETS[provider.kind].images).map((provider) => ({ ref: aiModelRef(provider.id, provider.imageModel!), label: `${provider.name} · ${provider.imageModel}` }));
  const footer = <SaveFooter dirty={dirty} saving={saving} onSave={() => void save()} onReset={() => setDraft(toDraft(saved))} />;

  return (
    <>
      <Card
        icon={<Sparkles />}
        title={s.providersTitle}
        description={s.providersHint}
        actions={
          <Menu
            label={s.addProvider}
            trigger={(props) => (
              <Button icon={<Plus />} {...props}>
                {s.addProvider}
              </Button>
            )}
          >
            {AI_PROVIDER_KINDS.map((kind) => (
              <MenuItem key={kind} onSelect={() => addProvider(kind)}>
                <span className="menu__rich">
                  <span>{AI_PROVIDER_PRESETS[kind].name}</span>
                  <small>{s.kinds[kind]}</small>
                </span>
              </MenuItem>
            ))}
          </Menu>
        }
        footer={dirty || saving ? footer : undefined}
      >
        {draft.providers.length === 0 ? (
          <Callout tone="info" title={s.noProvidersTitle}>
            {s.noProvidersText}
          </Callout>
        ) : (
          <div className="tai-providers">
            {draft.providers.map((provider) => {
              const preset = AI_PROVIDER_PRESETS[provider.kind];
              const choices = [...new Set([...provider.models, ...provider.offered])];
              const imageChoices = [...new Set([...(provider.imageModel === null ? [] : [provider.imageModel]), ...provider.offeredImages])];
              const toggle = (model: string): void => updateProvider(provider.key, { models: provider.models.includes(model) ? provider.models.filter((entry) => entry !== model) : [...provider.models, model] });
              const addTyped = (): void => {
                const model = provider.typed.trim();
                if (model.length === 0) return;
                updateProvider(provider.key, { typed: '', models: provider.models.includes(model) ? provider.models : [...provider.models, model] });
              };
              return (
                <div key={provider.key} className="tai-provider">
                  <div className="tai-provider__head">
                    <strong>{provider.name.length > 0 ? provider.name : preset.name}</strong>
                    <span className="tai-provider__kind">{s.kinds[provider.kind]}</span>
                    <span className="grow" />
                    {preset.keysUrl.length > 0 && (
                      <a className="row faint" style={{ gap: 4, fontSize: 'var(--text-xs)' }} href={preset.keysUrl} target="_blank" rel="noreferrer noopener">
                        {s.getKey} <ExternalLink width={12} height={12} aria-hidden="true" />
                      </a>
                    )}
                    <Button variant="ghost" size="sm" iconOnly icon={<Trash2 />} onClick={() => update({ providers: draft.providers.filter((entry) => entry.key !== provider.key) })}>
                      {m.common.remove}
                    </Button>
                  </div>
                  <div className="tai-provider__grid">
                    <Field label={s.providerName}>
                      <Input value={provider.name} maxLength={60} onChange={(event) => updateProvider(provider.key, { name: event.target.value })} />
                    </Field>
                    <Field label={s.apiKey} hint={provider.keyHint !== null && provider.apiKey.length === 0 ? t(s.keyKept, { hint: provider.keyHint }) : undefined}>
                      <Input type="password" mono autoComplete="off" value={provider.apiKey} placeholder={provider.keyHint !== null ? `••••••••${provider.keyHint}` : 'sk-…'} onChange={(event) => updateProvider(provider.key, { apiKey: event.target.value, check: 'idle' })} />
                    </Field>
                  </div>
                  {(provider.kind === 'custom' || provider.baseUrl.length > 0) && (
                    <Field label={s.baseUrl} hint={provider.kind === 'custom' ? s.baseUrlHint : undefined}>
                      <Input mono value={provider.baseUrl} placeholder={preset.baseUrl.length > 0 ? preset.baseUrl : 'https://api.example.com/v1'} onChange={(event) => updateProvider(provider.key, { baseUrl: event.target.value, check: 'idle' })} />
                    </Field>
                  )}
                  <div className="row wrap" style={{ gap: 10 }}>
                    <Button size="sm" icon={<RefreshCw />} busy={provider.check === 'checking'} onClick={() => void check(provider)}>
                      {s.check}
                    </Button>
                    {provider.check === 'ok' && (
                      <span className="row" style={{ gap: 5, color: 'var(--ok-ink)', fontSize: 'var(--text-sm)' }}>
                        <Check width={15} height={15} aria-hidden="true" /> {t(s.checkOk, { count: provider.offered.length })}
                      </span>
                    )}
                    {provider.check === 'failed' && (
                      <span className="row" style={{ gap: 5, color: 'var(--bad-ink)', fontSize: 'var(--text-sm)', minWidth: 0 }}>
                        <CircleAlert width={15} height={15} aria-hidden="true" style={{ flex: 'none' }} /> <span>{provider.checkError ?? s.checkFailed}</span>
                      </span>
                    )}
                  </div>
                  <Field label={s.models} hint={s.modelsHint}>
                    <div>
                      {choices.length > 0 && (
                        <div className="tai-models" style={{ marginBottom: 8 }}>
                          {choices.slice(0, 60).map((model) => (
                            <button key={model} type="button" aria-pressed={provider.models.includes(model)} onClick={() => toggle(model)}>
                              {provider.models.includes(model) && <Check aria-hidden="true" />}
                              <span className="truncate">{model}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="row" style={{ gap: 8 }}>
                        <Input
                          mono
                          value={provider.typed}
                          placeholder={s.modelPlaceholder}
                          onChange={(event) => updateProvider(provider.key, { typed: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter') return;
                            event.preventDefault();
                            addTyped();
                          }}
                        />
                        <Button size="sm" onClick={addTyped} disabled={provider.typed.trim().length === 0}>
                          {m.common.add}
                        </Button>
                      </div>
                    </div>
                  </Field>
                  {preset.images && (
                    <Field label={s.imageModel} hint={s.imageModelHint}>
                      <Input mono list={`images-${provider.key}`} value={provider.imageModel ?? ''} placeholder={s.imageModelPlaceholder} onChange={(event) => updateProvider(provider.key, { imageModel: event.target.value.trim().length === 0 ? null : event.target.value.trim() })} />
                    </Field>
                  )}
                  <datalist id={`images-${provider.key}`}>
                    {imageChoices.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title={s.generalTitle} description={s.generalHint} footer={dirty || saving ? footer : undefined}>
        <div style={{ display: 'grid', gap: 16 }}>
          <Switch checked={draft.enabled} onChange={(enabled) => update({ enabled })} label={s.enabled} hint={s.enabledHint} />
          <div className="tai-provider__grid">
            <Field label={s.defaultModel} hint={savedModels.length === 0 ? s.saveFirst : s.defaultModelHint}>
              <Select value={draft.defaultModel ?? ''} disabled={savedModels.length === 0} onChange={(event) => update({ defaultModel: event.target.value.length === 0 ? null : event.target.value })}>
                {savedModels.length === 0 && <option value="">—</option>}
                {savedModels.map((model) => (
                  <option key={model.ref} value={model.ref}>
                    {model.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={s.imageDefault} hint={savedImages.length === 0 ? s.imageNone : s.imageDefaultHint}>
              <Select value={draft.imageModel ?? ''} disabled={savedImages.length === 0} onChange={(event) => update({ imageModel: event.target.value.length === 0 ? null : event.target.value })}>
                {savedImages.length === 0 && <option value="">—</option>}
                {savedImages.map((model) => (
                  <option key={model.ref} value={model.ref}>
                    {model.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={s.minRole} hint={s.minRoleHint}>
            <Segmented label={s.minRole} value={draft.minRole} onChange={(minRole) => update({ minRole })} options={TEAM_ROLES.map((role) => ({ value: role, label: m.roles[role] }))} />
          </Field>
          <Field label={s.effort} hint={s.effortHint}>
            <Segmented label={s.effort} value={draft.effort} onChange={(effort) => update({ effort })} options={AI_EFFORTS.map((effort) => ({ value: effort, label: s.efforts[effort] }))} />
          </Field>
          <div className="tai-provider__grid">
            <Field label={s.dailyLimit} hint={s.dailyLimitHint}>
              <Input inputMode="numeric" value={draft.dailyTokenLimit} placeholder={s.unlimited} onChange={(event) => update({ dailyTokenLimit: event.target.value.replace(/[^\d\s]/g, '') })} />
            </Field>
            <Field label={s.compactAt} hint={s.compactAtHint}>
              <Input inputMode="numeric" value={draft.compactAt} onChange={(event) => update({ compactAt: event.target.value.replace(/[^\d\s]/g, '') })} />
            </Field>
          </div>
          <Field label={s.instructions} hint={s.instructionsHint}>
            <Textarea rows={4} maxLength={4_000} value={draft.instructions} placeholder={s.instructionsPlaceholder} onChange={(event) => update({ instructions: event.target.value })} />
          </Field>
          <Callout tone="info" title={s.privacyTitle}>
            {s.privacyText}
          </Callout>
        </div>
      </Card>

      <Card title={s.usageTitle} description={s.usageHint}>
        <Usage />
      </Card>
    </>
  );
}
