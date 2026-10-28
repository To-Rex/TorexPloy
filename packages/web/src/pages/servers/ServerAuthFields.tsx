import type { ReactNode } from 'react';
import { KeyRound, Lock, SquareTerminal } from 'lucide-react';
import type { ServerAuthInput } from '@ploy/shared';
import { Field, Input, Segmented, Textarea } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';

/** How the panel gets onto the server; `keep` (edit only) leaves the stored key alone. */
export type AuthMethod = 'password' | 'privateKey' | 'key' | 'keep';

export interface AuthForm {
  method: AuthMethod;
  password: string;
  privateKey: string;
  passphrase: string;
}

export const emptyAuth = (method: AuthMethod): AuthForm => ({ method, password: '', privateKey: '', passphrase: '' });

/** The `auth` part of a create/update payload; undefined keeps the current key. */
export function authPayload(form: AuthForm): ServerAuthInput | undefined {
  switch (form.method) {
    case 'password':
      return { method: 'password', password: form.password };
    case 'privateKey':
      return { method: 'privateKey', privateKey: form.privateKey.trim(), ...(form.passphrase.length > 0 ? { passphrase: form.passphrase } : {}) };
    case 'key':
      return { method: 'key' };
    default:
      return undefined;
  }
}

/** The credential chooser shared by "Add server" and "Edit connection". */
export function ServerAuthFields({ form, onChange, errors, editing }: { form: AuthForm; onChange: (next: AuthForm) => void; errors: Record<string, string>; editing: boolean }) {
  const { m } = useI18n();
  const options: { value: AuthMethod; label: string; icon?: ReactNode }[] = [
    ...(editing ? [{ value: 'keep' as const, label: m.servers.authKeep }] : []),
    { value: 'password', label: m.servers.authPassword, icon: <Lock /> },
    { value: 'privateKey', label: m.servers.authPrivateKey, icon: <KeyRound /> },
    ...(editing ? [] : [{ value: 'key' as const, label: m.servers.authManual, icon: <SquareTerminal /> }]),
  ];
  return (
    <>
      <div className="field">
        <span className="field__label">{m.servers.auth}</span>
        <Segmented label={m.servers.auth} value={form.method} onChange={(method) => onChange({ ...form, method })} options={options} />
      </div>
      {form.method === 'password' && (
        <Field label={m.servers.password} hint={m.servers.passwordHint} error={errors['auth.password']}>
          <Input type="password" autoComplete="new-password" value={form.password} onChange={(event) => onChange({ ...form, password: event.target.value })} />
        </Field>
      )}
      {form.method === 'privateKey' && (
        <>
          <Field label={m.servers.privateKey} hint={m.servers.privateKeyHint} error={errors['auth.privateKey']}>
            <Textarea
              mono
              rows={6}
              value={form.privateKey}
              onChange={(event) => onChange({ ...form, privateKey: event.target.value })}
              placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----'}
              spellCheck={false}
              autoComplete="off"
              style={{ fontSize: 'var(--text-sm)' }}
            />
          </Field>
          <Field label={m.servers.passphrase} optional={m.common.optional} hint={m.servers.passphraseHint} error={errors['auth.passphrase']}>
            <Input type="password" autoComplete="off" value={form.passphrase} onChange={(event) => onChange({ ...form, passphrase: event.target.value })} />
          </Field>
        </>
      )}
      {form.method === 'key' && <p className="field__hint">{m.servers.manualHint}</p>}
      {form.method === 'keep' && <p className="field__hint">{m.servers.authKeepHint}</p>}
    </>
  );
}
