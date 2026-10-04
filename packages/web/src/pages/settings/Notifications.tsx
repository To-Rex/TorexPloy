/**
 * Notification channels: where the team hears about failed deploys, crashing
 * apps, failed backups and unreachable servers.
 */
import { useState, type ReactNode } from 'react';
import { BellRing, Ellipsis, Hash, MessagesSquare, Pencil, Plus, Send, Trash2, Webhook } from 'lucide-react';
import {
  createNotificationChannelSchema,
  LOCALES,
  NOTIFICATION_EVENTS,
  NOTIFICATION_KINDS,
  updateNotificationChannelSchema,
  type Locale,
  type NotificationChannelDto,
  type NotificationEvent,
  type NotificationKind,
} from '@ploy/shared';
import { Dialog, useConfirm } from '../../components/Dialog.tsx';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu.tsx';
import { StatusMark } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Button, Checkbox, EmptyState, Field, Input, Select, Skeleton, Switch } from '../../components/ui.tsx';
import { LOCALE_NAMES, useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useNotificationChannels } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { FrameActions } from '../../components/Frame.tsx';

const KIND_ICONS: Record<NotificationKind, ReactNode> = {
  telegram: <Send />,
  discord: <MessagesSquare />,
  slack: <Hash />,
  webhook: <Webhook />,
};

interface Draft {
  name: string;
  kind: NotificationKind;
  locale: Locale;
  events: NotificationEvent[];
  botToken: string;
  chatId: string;
  url: string;
  secret: string;
}

const emptyDraft = (locale: Locale): Draft => ({
  name: '',
  kind: 'telegram',
  locale,
  events: ['deployment.failed', 'application.crashed', 'backup.failed', 'server.offline'],
  botToken: '',
  chatId: '',
  url: '',
  secret: '',
});

function configOf(draft: Draft): Record<string, string> {
  if (draft.kind === 'telegram') return { kind: 'telegram', botToken: draft.botToken.trim(), chatId: draft.chatId.trim() };
  if (draft.kind === 'webhook') return { kind: 'webhook', url: draft.url.trim(), ...(draft.secret.trim().length === 0 ? {} : { secret: draft.secret.trim() }) };
  return { kind: draft.kind, url: draft.url.trim() };
}

/** Field errors arrive as `config.botToken`; the form shows them under the plain field. */
function flatten(errors: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).map(([key, value]) => [key.replace(/^config\./, ''), value]));
}

function ChannelDialog({ open, editing, onClose }: { open: boolean; editing: NotificationChannelDto | null; onClose: () => void }) {
  const { m, locale } = useI18n();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(locale));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const n = m.notifications;

  // Reset the form whenever the dialog opens for a different channel (or a new one).
  const key = open ? (editing?.id ?? 'new') : null;
  if (key !== loadedFor) {
    setLoadedFor(key);
    setErrors({});
    setDraft(editing === null ? emptyDraft(locale) : { ...emptyDraft(editing.locale), name: editing.name, kind: editing.kind, locale: editing.locale, events: editing.events });
  }

  const set = <K extends keyof Draft>(field: K, value: Draft[K]) => setDraft((current) => ({ ...current, [field]: value }));
  const credentialsTouched = draft.botToken.length > 0 || draft.chatId.length > 0 || draft.url.length > 0 || draft.secret.length > 0;

  const save = useAction(
    async (payload: Record<string, unknown>) => {
      const channel = editing === null ? await api.post<NotificationChannelDto>('/api/notifications', payload) : await api.patch<NotificationChannelDto>(`/api/notifications/${editing.id}`, payload);
      // A new channel proves itself right away: one test message.
      const test = editing === null || payload.config !== undefined ? await api.post<{ ok: boolean; error: string | null }>(`/api/notifications/${channel.id}/test`) : null;
      return { channel, test };
    },
    {
      invalidate: [keys.notifications],
      inlineValidation: true,
      onSuccess: ({ test }) => {
        if (test === null) toast.success(n.saved);
        else if (test.ok) toast.success(n.testSent);
        else toast.failure(n.testFailed, test.error ?? undefined);
        onClose();
      },
    },
  );

  const submit = () => {
    const base = { name: draft.name.trim(), locale: draft.locale, events: draft.events };
    if (editing === null) {
      const payload = { ...base, config: configOf(draft) };
      const result = validate(m, createNotificationChannelSchema, payload);
      if (result.errors !== null) return setErrors(flatten(result.errors));
      save.mutate(payload, { onError: (error) => setErrors(flatten(fieldErrors(m, error))) });
      return;
    }
    const payload = { ...base, ...(credentialsTouched ? { config: configOf(draft) } : {}) };
    const result = validate(m, updateNotificationChannelSchema, payload);
    if (result.errors !== null) return setErrors(flatten(result.errors));
    save.mutate(payload, { onError: (error) => setErrors(flatten(fieldErrors(m, error))) });
  };

  const keepHint = editing === null ? undefined : n.keepCredentials;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={editing === null ? n.addTitle : n.editTitle}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            {editing === null ? n.addAndTest : m.common.save}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 18 }}>
        <div className="field">
          <span className="field__label">{n.kind}</span>
          <div className="choices" role="radiogroup" aria-label={n.kind}>
            {NOTIFICATION_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                className="choice"
                aria-checked={draft.kind === kind}
                onClick={() => set('kind', kind)}
              >
                <span className="choice__title">
                  {KIND_ICONS[kind]}
                  {n.kinds[kind]}
                </span>
                <span className="choice__hint">{n.kindHints[kind]}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="form-grid">
          <Field label={n.name} error={errors.name}>
            <Input value={draft.name} onChange={(event) => set('name', event.target.value)} placeholder={n.namePlaceholder} data-autofocus />
          </Field>
          <Field label={n.language} hint={n.languageHint}>
            <Select value={draft.locale} onChange={(event) => set('locale', event.target.value as Locale)}>
              {LOCALES.map((value) => (
                <option key={value} value={value}>
                  {LOCALE_NAMES[value]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {draft.kind === 'telegram' ? (
          <>
            <ol className="steps">
              <li>{n.telegramSteps.bot}</li>
              <li>{n.telegramSteps.add}</li>
              <li>{n.telegramSteps.chat}</li>
            </ol>
            <div className="form-grid">
              <Field label={n.botToken} error={errors.botToken} hint={keepHint}>
                <Input mono value={draft.botToken} onChange={(event) => set('botToken', event.target.value)} placeholder="123456789:AA…" spellCheck={false} autoComplete="off" />
              </Field>
              <Field label={n.chatId} error={errors.chatId} hint={keepHint ?? n.chatIdHint}>
                <Input mono value={draft.chatId} onChange={(event) => set('chatId', event.target.value)} placeholder="-1001234567890" spellCheck={false} autoComplete="off" />
              </Field>
            </div>
          </>
        ) : (
          <>
            <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
              {n.urlSteps[draft.kind]}
            </p>
            <Field label={draft.kind === 'webhook' ? n.url : n.webhookUrl} error={errors.url} hint={keepHint}>
              <Input
                mono
                value={draft.url}
                onChange={(event) => set('url', event.target.value)}
                placeholder={draft.kind === 'discord' ? 'https://discord.com/api/webhooks/…' : draft.kind === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://example.uz/hooks/torexploy'}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
            {draft.kind === 'webhook' && (
              <Field label={n.secret} optional={m.common.optional} error={errors.secret} hint={n.secretHint}>
                <Input mono value={draft.secret} onChange={(event) => set('secret', event.target.value)} spellCheck={false} autoComplete="off" />
              </Field>
            )}
          </>
        )}

        <div className="field">
          <span className="field__label">{n.events}</span>
          <div className="stack" style={{ gap: 10 }}>
            {NOTIFICATION_EVENTS.map((event) => (
              <Checkbox
                key={event}
                checked={draft.events.includes(event)}
                onChange={(checked) => set('events', checked ? [...draft.events, event] : draft.events.filter((value) => value !== event))}
                label={n.eventNames[event]}
                hint={n.eventHints[event]}
              />
            ))}
          </div>
          {errors.events !== undefined && <p className="field__error">{n.eventsRequired}</p>}
        </div>
      </div>
    </Dialog>
  );
}

export function NotificationsPage() {
  const { m, t } = useI18n();
  const n = m.notifications;
  const confirm = useConfirm();
  const toast = useToast();
  const channels = useNotificationChannels();
  const [dialog, setDialog] = useState<{ open: boolean; editing: NotificationChannelDto | null }>({ open: false, editing: null });

  const toggle = useAction((input: { id: string; enabled: boolean }) => api.patch(`/api/notifications/${input.id}`, { enabled: input.enabled }), { invalidate: [keys.notifications] });
  const remove = useAction((id: string) => api.delete(`/api/notifications/${id}`), { success: n.deleted, invalidate: [keys.notifications] });
  const test = useAction((id: string) => api.post<{ ok: boolean; error: string | null }>(`/api/notifications/${id}/test`), {
    invalidate: [keys.notifications],
    onSuccess: (result) => (result.ok ? toast.success(n.testSent) : toast.failure(n.testFailed, result.error ?? undefined)),
  });

  return (
    <>
      <FrameActions>
        <Button variant="primary" icon={<Plus />} onClick={() => setDialog({ open: true, editing: null })}>
          {n.add}
        </Button>
      </FrameActions>
      {channels.data === undefined ? (
        <Skeleton height={120} />
      ) : channels.data.length === 0 ? (
        <EmptyState icon={<BellRing />} title={n.emptyTitle}>
          {n.emptyText}
        </EmptyState>
      ) : (
        <div className="list">
          {channels.data.map((channel) => (
            <div key={channel.id} className="list__row">
              <span className="channel-icon" data-kind={channel.kind} aria-hidden="true">
                {KIND_ICONS[channel.kind]}
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="list__title truncate">{channel.name}</span>
                  <span className="faint" style={{ fontSize: 'var(--text-sm)' }}>
                    {n.kinds[channel.kind]}
                  </span>
                </div>
                <div className="list__meta">
                  <code className="truncate">{channel.target}</code>
                  <span>{channel.events.map((event) => n.eventShort[event]).join(', ')}</span>
                  {channel.lastStatus !== null && channel.lastSentAt !== null && (
                    <span className="row" style={{ gap: 6 }} title={channel.lastError ?? undefined}>
                      <StatusMark tone={channel.lastStatus === 'ok' ? 'ok' : 'bad'} label={channel.lastStatus === 'ok' ? n.lastOk : n.lastFailed} />
                      <RelativeTime value={channel.lastSentAt} />
                    </span>
                  )}
                </div>
                {channel.lastStatus === 'failed' && channel.lastError !== null && (
                  <p className="truncate" style={{ color: 'var(--bad-ink)', fontSize: 'var(--text-sm)', marginTop: 2 }}>
                    {channel.lastError}
                  </p>
                )}
              </div>
              <Switch checked={channel.enabled} onChange={(enabled) => toggle.mutate({ id: channel.id, enabled })} label={t(n.enabledFor, { name: channel.name })} hideLabel />
              <Menu trigger={(props) => <Button {...props} variant="ghost" size="sm" iconOnly icon={<Ellipsis />}>{m.common.actions}</Button>}>
                <MenuItem icon={<BellRing />} onSelect={() => test.mutate(channel.id)}>
                  {n.sendTest}
                </MenuItem>
                <MenuItem icon={<Pencil />} onSelect={() => setDialog({ open: true, editing: channel })}>
                  {m.common.edit}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  icon={<Trash2 />}
                  danger
                  onSelect={async () => {
                    const result = await confirm({ title: n.deleteTitle, text: channel.name, confirmLabel: m.common.delete, danger: true });
                    if (result.confirmed) remove.mutate(channel.id);
                  }}
                >
                  {m.common.delete}
                </MenuItem>
              </Menu>
            </div>
          ))}
        </div>
      )}
      <ChannelDialog open={dialog.open} editing={dialog.editing} onClose={() => setDialog({ open: false, editing: null })} />
    </>
  );
}
