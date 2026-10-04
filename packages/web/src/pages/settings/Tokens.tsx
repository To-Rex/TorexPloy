import { useState } from 'react';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { createApiTokenSchema, type ApiTokenDto } from '@ploy/shared';
import { CopyButton } from '../../components/Copy.tsx';
import { useConfirm, Dialog } from '../../components/Dialog.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Button, Callout, EmptyState, Field, Input, Select, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useTokens } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { FrameActions } from '../../components/Frame.tsx';

const EXPIRY = ['7', '30', '90', '365', 'never'] as const;

export function TokensPage() {
  const { m, t } = useI18n();
  const confirm = useConfirm();
  const tokens = useTokens();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]>('90');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<string | null>(null);

  const create = useAction((input: { name: string; expiresInDays: number | null }) => api.post<ApiTokenDto>('/api/tokens', input), {
    invalidate: [keys.tokens],
    onSuccess: (result) => setCreated(result.token ?? null),
  });
  const revoke = useAction((id: string) => api.delete(`/api/tokens/${id}`), { success: m.tokens.revoked, invalidate: [keys.tokens] });

  const close = () => {
    setCreating(false);
    setCreated(null);
    setName('');
    setErrors({});
  };

  return (
    <>
      <FrameActions>
        <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
          {m.tokens.create}
        </Button>
      </FrameActions>
      {tokens.data === undefined ? (
        <Skeleton height={100} />
      ) : tokens.data.length === 0 ? (
        <EmptyState icon={<KeyRound />}>{m.tokens.empty}</EmptyState>
      ) : (
        <div className="list">
          {tokens.data.map((token) => (
            <div key={token.id} className="list__row">
              <KeyRound width={18} height={18} className="faint" aria-hidden="true" />
              <div className="grow">
                <div className="list__title">{token.name}</div>
                <div className="list__meta">
                  <code>{token.prefix}…</code>
                  <span>
                    {token.lastUsedAt === null ? (
                      m.tokens.neverUsed
                    ) : (
                      <>
                        {t(m.tokens.lastUsed, { time: '' })}
                        <RelativeTime value={token.lastUsedAt} />
                      </>
                    )}
                  </span>
                  <span>
                    {token.expiresAt === null ? (
                      m.tokens.noExpiry
                    ) : (
                      <>
                        {t(m.tokens.expiresAt, { time: '' })}
                        <RelativeTime value={token.expiresAt} />
                      </>
                    )}
                  </span>
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 />}
                onClick={async () => {
                  const result = await confirm({ title: m.tokens.revoke, text: token.name, confirmLabel: m.tokens.revoke, danger: true });
                  if (result.confirmed) revoke.mutate(token.id);
                }}
              >
                {m.tokens.revoke}
              </Button>
            </div>
          ))}
        </div>
      )}
      <Dialog
        open={creating}
        onClose={close}
        title={created === null ? m.tokens.create : m.tokens.createdTitle}
        onSubmit={() => {
          if (created !== null) {
            close();
            return;
          }
          const payload = { name, expiresInDays: expiry === 'never' ? null : Number(expiry) };
          const result = validate(m, createApiTokenSchema, payload);
          if (result.errors !== null) {
            setErrors(result.errors);
            return;
          }
          create.mutate(payload);
        }}
        footer={
          created === null ? (
            <>
              <Button onClick={close}>{m.common.cancel}</Button>
              <Button type="submit" variant="primary" busy={create.isPending}>
                {m.common.create}
              </Button>
            </>
          ) : (
            <Button type="submit" variant="primary">
              {m.common.close}
            </Button>
          )
        }
      >
        {created === null ? (
          <div className="form-grid">
            <Field label={m.tokens.name} error={errors.name}>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={m.tokens.namePlaceholder} autoFocus />
            </Field>
            <Field label={m.tokens.expires}>
              <Select value={expiry} onChange={(event) => setExpiry(event.target.value as (typeof EXPIRY)[number])}>
                {EXPIRY.map((value) => (
                  <option key={value} value={value}>
                    {m.tokens.expiry[value]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : (
          <div className="stack">
            <Callout tone="work">{m.tokens.createdText}</Callout>
            <div className="codeblock">
              {created}
              <CopyButton value={created} />
            </div>
            <p className="field__label">{m.tokens.usage}</p>
            <div className="codeblock">
              {`curl -H "Authorization: Bearer ${created}" ${window.location.origin}/api/projects`}
              <CopyButton value={`curl -H "Authorization: Bearer ${created}" ${window.location.origin}/api/projects`} />
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
