/**
 * Passkeys on the Security page: the ones the account has, adding one
 * (password first, then the device's own prompt, then a name), renaming and
 * removing. When passkeys cannot exist at the address the panel is open at
 * — no HTTPS domain, or another hostname — the card says why and where to go.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Cloud, ExternalLink, Fingerprint, LoaderCircle, Pencil, Plus, Smartphone, Trash2 } from 'lucide-react';
import { LIMITS, type PasskeyCreationOptionsDto, type PasskeyDto, type UserDto } from '@ploy/shared';
import { Dialog, useConfirm } from '../../components/Dialog.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Badge, Button, Callout, Field, Input, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import type { Messages } from '../../i18n/uz.ts';
import { api, ApiError } from '../../lib/api.ts';
import { errorText } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { createPasskey, PasskeyError, passkeysSupported } from '../../lib/passkey.ts';
import { keys, usePasskeys } from '../../lib/queries.ts';
import { SettingsSection } from './SettingsLayout.tsx';

/** What to tell someone when a passkey step fails: the browser's side, the server's reason, or the general text. */
export function passkeyErrorText(m: Messages, error: unknown): string {
  if (error instanceof PasskeyError) return m.passkeys.browser[error.kind];
  if (error instanceof ApiError) {
    const reason = error.params.reason;
    const known = (m.passkeys.errors as Record<string, string>)[typeof reason === 'string' ? reason : ''];
    if (known !== undefined) return known;
  }
  return errorText(m, error);
}

type AddStep = { step: 'password'; error: string | null } | { step: 'waiting' } | { step: 'name'; passkey: PasskeyDto };

/** Add a passkey: confirm the password, let the device make the key, then give it a name. */
function AddPasskeyDialog({ open, onClose, me }: { open: boolean; onClose: () => void; me: UserDto }) {
  const { m } = useI18n();
  const p = m.passkeys;
  const client = useQueryClient();
  const [state, setState] = useState<AddStep>({ step: 'password', error: null });
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setState({ step: 'password', error: null });
      setPassword('');
      setName('');
    }
  }

  const create = async () => {
    setState({ step: 'waiting' });
    try {
      const options = await api.post<PasskeyCreationOptionsDto>('/api/me/passkeys/options', me.hasPassword ? { password } : {});
      const credential = await createPasskey(options.publicKey);
      const passkey = await api.post<PasskeyDto>('/api/me/passkeys', { ticket: options.ticket, credential });
      void client.invalidateQueries({ queryKey: keys.passkeys });
      setPassword('');
      setName(passkey.name);
      setState({ step: 'name', passkey });
    } catch (error) {
      const wrongPassword = error instanceof ApiError && error.code === 'invalid_credentials';
      setState({ step: 'password', error: wrongPassword ? p.wrongPassword : passkeyErrorText(m, error) });
    }
  };

  const finish = async () => {
    if (state.step !== 'name') return;
    const next = name.trim();
    if (next.length > 0 && next !== state.passkey.name) {
      setSaving(true);
      try {
        await api.patch(`/api/me/passkeys/${state.passkey.id}`, { name: next });
        void client.invalidateQueries({ queryKey: keys.passkeys });
      } catch {
        // The passkey itself is saved; a name can be changed again from the list.
      } finally {
        setSaving(false);
      }
    }
    onClose();
  };

  if (state.step === 'name') {
    return (
      <Dialog
        open={open}
        onClose={() => void finish()}
        title={p.addedTitle}
        description={p.addedText}
        onSubmit={() => void finish()}
        footer={
          <Button type="submit" variant="primary" busy={saving}>
            {p.done}
          </Button>
        }
      >
        <Field label={p.name} hint={p.nameHint}>
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={LIMITS.passkeyNameMax} data-autofocus />
        </Field>
      </Dialog>
    );
  }

  const waiting = state.step === 'waiting';
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!waiting) onClose();
      }}
      title={p.addTitle}
      description={p.addText}
      onSubmit={() => {
        if (!waiting) void create();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={waiting}>
            {m.common.cancel}
          </Button>
          <Button type="submit" variant="primary" busy={waiting} disabled={me.hasPassword && password.length === 0}>
            {p.continue}
          </Button>
        </>
      }
    >
      <div className="stack">
        {me.hasPassword && (
          <Field label={p.confirmPassword} hint={p.confirmPasswordHint}>
            <Input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={waiting} data-autofocus />
          </Field>
        )}
        {waiting && (
          <p className="row muted" role="status">
            <LoaderCircle className="spin" width={16} height={16} aria-hidden="true" />
            {p.waiting}
          </p>
        )}
        {state.step === 'password' && state.error !== null && <Callout tone="bad">{state.error}</Callout>}
      </div>
    </Dialog>
  );
}

function RenameDialog({ passkey, onClose }: { passkey: PasskeyDto | null; onClose: () => void }) {
  const { m } = useI18n();
  const p = m.passkeys;
  const [name, setName] = useState('');
  const [shownFor, setShownFor] = useState<string | null>(null);
  if ((passkey?.id ?? null) !== shownFor) {
    setShownFor(passkey?.id ?? null);
    if (passkey !== null) setName(passkey.name);
  }
  const rename = useAction((input: { id: string; name: string }) => api.patch(`/api/me/passkeys/${input.id}`, { name: input.name }), {
    success: p.renamed,
    invalidate: [keys.passkeys],
    onSuccess: onClose,
  });
  return (
    <Dialog
      open={passkey !== null}
      onClose={onClose}
      title={p.renameTitle}
      onSubmit={() => {
        if (passkey !== null && name.trim().length > 0) rename.mutate({ id: passkey.id, name: name.trim() });
      }}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" busy={rename.isPending} disabled={name.trim().length === 0}>
            {m.common.save}
          </Button>
        </>
      }
    >
      <Field label={p.name} hint={p.nameHint}>
        <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={LIMITS.passkeyNameMax} data-autofocus />
      </Field>
    </Dialog>
  );
}

export function PasskeysSection({ me }: { me: UserDto }) {
  const { m, t } = useI18n();
  const p = m.passkeys;
  const confirm = useConfirm();
  const toast = useToast();
  const passkeys = usePasskeys();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<PasskeyDto | null>(null);
  const remove = useAction((id: string) => api.delete(`/api/me/passkeys/${id}`), { success: p.removed, invalidate: [keys.passkeys] });

  const data = passkeys.data;
  const browser = passkeysSupported();
  const full = data !== undefined && data.items.length >= data.limit;
  const canAdd = data !== undefined && data.available && browser && !full;

  return (
    <SettingsSection
      title={p.title}
      hint={p.hint}
      actions={
        <Button
          variant="primary"
          size="sm"
          icon={<Plus />}
          disabled={!canAdd}
          title={full ? t(p.limit, { max: data.limit }) : undefined}
          onClick={() => {
            if (!browser) toast.failure(p.unavailable.browser);
            else setAdding(true);
          }}
        >
          {p.add}
        </Button>
      }
    >
      {data === undefined ? (
        <Skeleton height={72} />
      ) : (
        <>
          {!data.available && data.reason !== null && (
            <Callout
              tone="info"
              action={
                data.reason === 'other_origin' && data.origin !== null ? (
                  <a className="btn btn--sm" href={`${data.origin}/settings/security`} style={{ textDecoration: 'none' }}>
                    <ExternalLink width={14} height={14} aria-hidden="true" />
                    {p.openDomain}
                  </a>
                ) : data.reason === 'no_domain' && me.isInstanceAdmin ? (
                  <Link className="btn btn--sm" to="/settings/platform" style={{ textDecoration: 'none' }}>
                    {p.setDomain}
                  </Link>
                ) : undefined
              }
            >
              {t(p.unavailable[data.reason], { origin: data.origin ?? '' })}
            </Callout>
          )}
          {data.available && !browser && <Callout tone="info">{p.unavailable.browser}</Callout>}

          {data.items.length === 0 ? (
            data.available && browser && <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{p.empty}</p>
          ) : (
            <div className="list">
              {data.items.map((passkey) => (
                <div key={passkey.id} className="list__row">
                  <Fingerprint width={18} height={18} className="faint" aria-hidden="true" />
                  <div className="grow">
                    <div className="row wrap" style={{ gap: '4px 8px' }}>
                      <span className="list__title">{passkey.name}</span>
                      {passkey.synced ? (
                        <span title={p.syncedHint}>
                          <Badge tone="info" icon={<Cloud />}>{p.synced}</Badge>
                        </span>
                      ) : (
                        <span title={p.deviceBoundHint}>
                          <Badge icon={<Smartphone />}>{p.deviceBound}</Badge>
                        </span>
                      )}
                      {!passkey.usableHere && (
                        <span title={p.otherHostHint}>
                          <Badge tone="work">{t(p.otherHost, { host: passkey.rpId })}</Badge>
                        </span>
                      )}
                    </div>
                    <div className="list__meta">
                      <span>
                        {p.created}: <RelativeTime value={passkey.createdAt} />
                      </span>
                      <span>
                        {passkey.lastUsedAt === null ? (
                          p.neverUsed
                        ) : (
                          <>
                            {p.lastUsed}: <RelativeTime value={passkey.lastUsedAt} />
                          </>
                        )}
                      </span>
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} onClick={() => setRenaming(passkey)}>
                    {p.rename}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon={<Trash2 />}
                    busy={remove.isPending && remove.variables === passkey.id}
                    onClick={async () => {
                      const result = await confirm({ title: p.removeTitle, text: t(p.removeText, { name: passkey.name }), confirmLabel: p.remove, danger: true });
                      if (result.confirmed) remove.mutate(passkey.id);
                    }}
                  >
                    {p.remove}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <AddPasskeyDialog open={adding} onClose={() => setAdding(false)} me={me} />
      <RenameDialog passkey={renaming} onClose={() => setRenaming(null)} />
    </SettingsSection>
  );
}
