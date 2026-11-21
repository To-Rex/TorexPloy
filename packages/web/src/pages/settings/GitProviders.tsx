/**
 * GitLab and Bitbucket on the Git settings page: the connected accounts of
 * each (an access token apiece), connecting another, changing its token or
 * name, disconnecting one nothing uses, and the address and secret for
 * setting a repository's webhook up by hand.
 */
import { useState } from 'react';
import { ExternalLink, Pencil, Plus, Trash2, Webhook } from 'lucide-react';
import { createGitProviderSchema, updateGitProviderSchema, type GitProviderDto, type GitProviderWebhookDto } from '@ploy/shared';
import { ValueField } from '../../components/Copy.tsx';
import { Dialog, useConfirm } from '../../components/Dialog.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Avatar, Badge, Button, ButtonLink, Callout, Field, HostMark, Input, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useGitProviders, useRole } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { useQuery } from '@tanstack/react-query';
import { SettingsSection } from './SettingsLayout.tsx';

type Kind = 'gitlab' | 'bitbucket';

/** Where to make a token, filled in as far as the host allows. */
function tokenPage(kind: Kind, baseUrl: string): string {
  if (kind === 'bitbucket') return 'https://id.atlassian.com/manage-profile/security/api-tokens';
  const base = baseUrl.trim().replace(/\/+$/, '') || 'https://gitlab.com';
  return `${base}/-/user_settings/personal_access_tokens?name=TorexPloy&scopes=api`;
}

function ConnectDialog({ kind, open, onClose }: { kind: Kind; open: boolean; onClose: () => void }) {
  const { m } = useI18n();
  const g = m.gitProviders;
  const blank = { name: '', baseUrl: 'https://gitlab.com', token: '', email: '', workspace: '' };
  const [draft, setDraft] = useState(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadedFor, setLoadedFor] = useState(false);
  if (open !== loadedFor) {
    setLoadedFor(open);
    if (open) {
      setDraft(blank);
      setErrors({});
    }
  }
  const connect = useAction((input: Record<string, unknown>) => api.post<GitProviderDto>('/api/git-providers', input), {
    success: g.connected[kind],
    invalidate: [keys.gitProviders],
    inlineValidation: true,
    onSuccess: onClose,
  });
  const submit = () => {
    const optional = (value: string) => (value.trim().length === 0 ? undefined : value.trim());
    const payload =
      kind === 'gitlab'
        ? { kind, name: optional(draft.name), baseUrl: optional(draft.baseUrl) ?? 'https://gitlab.com', token: draft.token.trim() }
        : { kind, name: optional(draft.name), token: draft.token.trim(), email: optional(draft.email), workspace: optional(draft.workspace) };
    const result = validate(m, createGitProviderSchema, payload);
    if (result.errors !== null) return setErrors(result.errors);
    setErrors({});
    connect.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={g.connect[kind]}
      description={g.hints[kind]}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" busy={connect.isPending}>
            {g.connect[kind]}
          </Button>
        </>
      }
    >
      <div className="stack">
        {kind === 'gitlab' && (
          <Field label={g.server} hint={g.serverHint} error={errors.baseUrl}>
            <Input mono value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://gitlab.com" spellCheck={false} inputMode="url" />
          </Field>
        )}
        <Field label={g.token} hint={kind === 'gitlab' ? g.gitlabTokenHint : g.bitbucketTokenHint} error={errors.token}>
          <Input mono type="password" autoComplete="off" value={draft.token} onChange={(event) => setDraft({ ...draft, token: event.target.value })} spellCheck={false} data-autofocus />
        </Field>
        <a className="link-btn" href={tokenPage(kind, draft.baseUrl)} target="_blank" rel="noreferrer noopener" style={{ marginTop: -6 }}>
          {g.createToken} <ExternalLink width={12} height={12} aria-hidden="true" style={{ verticalAlign: '-1px' }} />
        </a>
        {kind === 'bitbucket' && (
          <div className="form-grid">
            <Field label={g.email} optional={m.common.optional} hint={g.emailHint} error={errors.email}>
              <Input value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} inputMode="email" autoComplete="off" />
            </Field>
            <Field label={g.workspace} optional={m.common.optional} hint={g.workspaceHint} error={errors.workspace}>
              <Input mono value={draft.workspace} onChange={(event) => setDraft({ ...draft, workspace: event.target.value })} spellCheck={false} />
            </Field>
          </div>
        )}
        <Field label={g.name} optional={m.common.optional} hint={g.nameHint} error={errors.name}>
          <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

function EditDialog({ provider, onClose }: { provider: GitProviderDto | null; onClose: () => void }) {
  const { m } = useI18n();
  const g = m.gitProviders;
  const [draft, setDraft] = useState({ name: '', token: '', email: '', workspace: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if ((provider?.id ?? null) !== loadedFor) {
    setLoadedFor(provider?.id ?? null);
    if (provider !== null) {
      setDraft({ name: provider.name, token: '', email: '', workspace: provider.workspace ?? '' });
      setErrors({});
    }
  }
  const save = useAction((input: Record<string, unknown>) => api.patch<GitProviderDto>(`/api/git-providers/${provider!.id}`, input), {
    success: g.saved,
    invalidate: [keys.gitProviders],
    inlineValidation: true,
    onSuccess: onClose,
  });
  const submit = () => {
    if (provider === null) return;
    const payload: Record<string, unknown> = {};
    if (draft.name.trim() !== provider.name) payload.name = draft.name.trim();
    if (draft.token.trim().length > 0) payload.token = draft.token.trim();
    if (provider.kind === 'bitbucket') {
      if (draft.email.trim().length > 0) payload.email = draft.email.trim();
      const workspace = draft.workspace.trim();
      if (workspace !== (provider.workspace ?? '')) payload.workspace = workspace.length === 0 ? null : workspace;
    }
    if (Object.keys(payload).length === 0) return onClose();
    const result = validate(m, updateGitProviderSchema, payload);
    if (result.errors !== null) return setErrors(result.errors);
    setErrors({});
    save.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
  };
  return (
    <Dialog
      open={provider !== null}
      onClose={onClose}
      title={g.editTitle}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            {m.common.save}
          </Button>
        </>
      }
    >
      {provider !== null && (
        <div className="stack">
          <Field label={g.name} error={errors.name}>
            <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Field>
          <Field label={g.newToken} optional={m.common.optional} hint={g.newTokenHint} error={errors.token}>
            <Input mono type="password" autoComplete="off" value={draft.token} onChange={(event) => setDraft({ ...draft, token: event.target.value })} spellCheck={false} />
          </Field>
          {provider.kind === 'bitbucket' && (
            <div className="form-grid">
              <Field label={g.email} optional={m.common.optional} hint={g.emailHint} error={errors.email}>
                <Input value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} inputMode="email" autoComplete="off" />
              </Field>
              <Field label={g.workspace} optional={m.common.optional} hint={g.workspaceHint} error={errors.workspace}>
                <Input mono value={draft.workspace} onChange={(event) => setDraft({ ...draft, workspace: event.target.value })} spellCheck={false} />
              </Field>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** The address and secret to enter on GitLab or Bitbucket when the panel could not add the webhook itself. */
export function ManualWebhookDialog({ providerId, kind, open, onClose }: { providerId: string; kind: Kind; open: boolean; onClose: () => void }) {
  const { m } = useI18n();
  const g = m.gitProviders;
  const webhook = useQuery({ queryKey: ['git-providers', providerId, 'webhook'], queryFn: () => api.get<GitProviderWebhookDto>(`/api/git-providers/${providerId}/webhook`), enabled: open, staleTime: 0 });
  return (
    <Dialog open={open} onClose={onClose} title={g.webhookTitle} description={g.webhookText[kind]} wide>
      {webhook.data === undefined ? (
        <Skeleton height={120} />
      ) : (
        <div className="stack">
          {webhook.data.url === null ? (
            <Callout tone="work">{g.noPublicUrl}</Callout>
          ) : (
            <Field label={g.webhookUrl}>
              <ValueField value={webhook.data.url} />
            </Field>
          )}
          <Field label={g.webhookSecret}>
            <ValueField value={webhook.data.secret} secret />
          </Field>
        </div>
      )}
    </Dialog>
  );
}

export function GitProvidersSection({ kind }: { kind: Kind }) {
  const { m, t, plural } = useI18n();
  const g = m.gitProviders;
  const confirm = useConfirm();
  const role = useRole();
  const providers = useGitProviders();
  const [connecting, setConnecting] = useState(false);
  const [editing, setEditing] = useState<GitProviderDto | null>(null);
  const [webhookFor, setWebhookFor] = useState<string | null>(null);
  const remove = useAction((id: string) => api.delete(`/api/git-providers/${id}`), { success: g.removed, invalidate: [keys.gitProviders] });
  const admin = role === 'admin' || role === 'owner';
  const list = (providers.data ?? []).filter((provider) => provider.kind === kind);

  return (
    <SettingsSection
      title={g.titles[kind]}
      hint={g.hints[kind]}
      actions={
        admin ? (
          <Button icon={<Plus />} onClick={() => setConnecting(true)}>
            {g.connect[kind]}
          </Button>
        ) : undefined
      }
    >
      {providers.isPending ? (
        <Skeleton height={56} />
      ) : list.length === 0 ? (
        <div className="provider-empty">
          <span className="provider-empty__mark" data-kind={kind} aria-hidden="true">
            <HostMark host={kind} size={20} />
          </span>
          <span className="muted">{g.none}</span>
        </div>
      ) : (
        <div className="list">
          {list.map((provider) => (
            <div key={provider.id} className="list__row provider-row">
              <span className="provider-row__avatar">
                <Avatar name={provider.account.login} src={provider.account.avatarUrl} size={32} />
                <span className="provider-row__host" data-kind={kind} aria-hidden="true">
                  <HostMark host={kind} size={11} />
                </span>
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="list__title">{provider.name}</div>
                <div className="list__meta">
                  <span>{provider.account.name ?? provider.account.login}</span>
                  <span className="faint">{new URL(provider.baseUrl).host}</span>
                  {provider.workspace !== null && <code>{provider.workspace}</code>}
                  <RelativeTime value={provider.createdAt} />
                </div>
              </div>
              <Badge tone={provider.usedBy > 0 ? 'info' : undefined}>{provider.usedBy > 0 ? plural(g.usedBy, provider.usedBy) : g.unused}</Badge>
              <ButtonLink href={provider.baseUrl} external size="sm" variant="ghost" icon={<ExternalLink />}>
                {g.openOn[kind]}
              </ButtonLink>
              {admin && (
                <>
                  <Button size="sm" variant="ghost" iconOnly icon={<Webhook />} title={g.webhookTitle} onClick={() => setWebhookFor(provider.id)}>
                    {g.webhookTitle}
                  </Button>
                  <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} title={g.edit} onClick={() => setEditing(provider)}>
                    {g.edit}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Trash2 />}
                    title={provider.usedBy > 0 ? g.inUse : g.remove}
                    disabled={provider.usedBy > 0}
                    onClick={async () => {
                      const result = await confirm({ title: t(g.removeTitle, { name: provider.name }), text: g.removeText, confirmLabel: g.remove, danger: true });
                      if (result.confirmed) remove.mutate(provider.id);
                    }}
                  >
                    {g.remove}
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {admin && (
        <>
          <ConnectDialog kind={kind} open={connecting} onClose={() => setConnecting(false)} />
          <EditDialog provider={editing} onClose={() => setEditing(null)} />
          {webhookFor !== null && <ManualWebhookDialog providerId={webhookFor} kind={kind} open onClose={() => setWebhookFor(null)} />}
        </>
      )}
    </SettingsSection>
  );
}
