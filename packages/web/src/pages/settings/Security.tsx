import { useEffect, useState } from 'react';
import { renderSVG } from 'uqr';
import { Laptop, ShieldCheck, ShieldOff } from 'lucide-react';
import { changePasswordSchema, type RecoveryCodesDto, type TwoFactorSetupDto } from '@ploy/shared';
import { CopyButton } from '../../components/Copy.tsx';
import { Dialog } from '../../components/Dialog.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Badge, Button, Field, Input, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useMe, useSessions } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { SettingsSection } from './SettingsLayout.tsx';

function describeAgent(agent: string | null): string {
  if (agent === null) return '—';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chrome' : /Firefox\//.test(agent) ? 'Firefox' : /Safari\//.test(agent) ? 'Safari' : /curl/.test(agent) ? 'curl' : 'Browser';
  const os = /Mac OS X/.test(agent) ? 'macOS' : /Windows/.test(agent) ? 'Windows' : /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Linux/.test(agent) ? 'Linux' : '';
  return os.length > 0 ? `${browser}, ${os}` : browser;
}

function RecoveryCodes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const { m } = useI18n();
  return (
    <Dialog open onClose={onClose} title={m.security.recoveryTitle} description={m.security.recoveryText} footer={<Button variant="primary" onClick={onClose}>{m.security.recoveryDone}</Button>}>
      <div className="codeblock" style={{ columns: 2, fontSize: 14, lineHeight: '24px' }}>
        {codes.join('\n')}
        <CopyButton value={codes.join('\n')} />
      </div>
    </Dialog>
  );
}

export function SecurityPage() {
  const { m, plural } = useI18n();
  const me = useMe();
  const sessions = useSessions();
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' });
  const [passwordErrors, setPasswordErrors] = useState<Record<string, string>>({});
  const [setup, setSetup] = useState<TwoFactorSetupDto | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [disableForm, setDisableForm] = useState({ password: '', code: '' });
  const [qr, setQr] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateCode, setRegenerateCode] = useState('');

  useEffect(() => {
    if (setup !== null) setQr(renderSVG(setup.otpauthUrl, { border: 0 }));
  }, [setup]);

  const changePassword = useAction((input: { currentPassword: string; newPassword: string }) => api.post('/api/me/password', input), {
    success: m.security.passwordChanged,
    invalidate: [keys.sessions],
    inlineValidation: true,
    onSuccess: () => setPasswords({ currentPassword: '', newPassword: '' }),
  });
  const startSetup = useAction(() => api.post<TwoFactorSetupDto>('/api/me/2fa/setup'), { onSuccess: setSetup });
  const enable = useAction((value: string) => api.post<RecoveryCodesDto>('/api/me/2fa/enable', { code: value }), {
    success: m.security.enabled,
    invalidate: [keys.me, keys.bootstrap],
    onSuccess: (result) => {
      setSetup(null);
      setCode('');
      setCodes(result.recoveryCodes);
    },
  });
  const disable = useAction((input: { password: string; code: string }) => api.post('/api/me/2fa/disable', input), {
    success: m.security.disabled,
    invalidate: [keys.me, keys.bootstrap],
    onSuccess: () => {
      setDisabling(false);
      setDisableForm({ password: '', code: '' });
    },
  });
  const regenerate = useAction((value: string) => api.post<RecoveryCodesDto>('/api/me/2fa/recovery-codes', { code: value }), {
    onSuccess: (result) => {
      setRegenerating(false);
      setRegenerateCode('');
      setCodes(result.recoveryCodes);
    },
  });
  const revoke = useAction((id: string) => api.delete(`/api/me/sessions/${id}`), { invalidate: [keys.sessions] });
  const revokeOthers = useAction(() => api.delete<{ removed: number }>('/api/me/sessions'), {
    invalidate: [keys.sessions],
    success: (result) => plural(m.security.revoked, result.removed),
  });

  if (me.data === undefined) return <Skeleton height={300} />;
  return (
    <>
      <SettingsSection title={m.security.password} hint={m.security.passwordHint}>
        <form
          className="stack"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const result = validate(m, changePasswordSchema, passwords);
            if (result.errors !== null) {
              setPasswordErrors(result.errors);
              return;
            }
            setPasswordErrors({});
            changePassword.mutate(result.data, { onError: (error) => setPasswordErrors(fieldErrors(m, error)) });
          }}
        >
          <input type="text" autoComplete="username" value={me.data.email} readOnly hidden />
          {me.data.hasPassword && (
            <Field label={m.security.currentPassword} error={passwordErrors.currentPassword}>
              <Input type="password" autoComplete="current-password" value={passwords.currentPassword} onChange={(event) => setPasswords({ ...passwords, currentPassword: event.target.value })} />
            </Field>
          )}
          <Field label={m.security.newPassword} hint={m.setup.passwordHint} error={passwordErrors.newPassword}>
            <Input type="password" autoComplete="new-password" value={passwords.newPassword} onChange={(event) => setPasswords({ ...passwords, newPassword: event.target.value })} />
          </Field>
          <div>
            <Button type="submit" busy={changePassword.isPending}>
              {m.security.changePassword}
            </Button>
          </div>
        </form>
      </SettingsSection>

      <SettingsSection title={m.security.twoFactor} hint={m.security.twoFactorHint}>
        <div className="row">
          {me.data.twoFactorEnabled ? (
            <Badge tone="ok" icon={<ShieldCheck />}>{m.security.twoFactorOn}</Badge>
          ) : (
            <Badge icon={<ShieldOff />}>{m.security.twoFactorOff}</Badge>
          )}
        </div>
        {me.data.twoFactorEnabled ? (
          <div className="row wrap">
            <Button onClick={() => setDisabling(true)}>{m.security.disable}</Button>
            <Button variant="ghost" onClick={() => setRegenerating(true)}>
              {m.security.regenerate}
            </Button>
          </div>
        ) : setup === null ? (
          <div>
            <Button variant="primary" busy={startSetup.isPending} onClick={() => startSetup.mutate()}>
              {m.security.enable}
            </Button>
          </div>
        ) : (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              enable.mutate(code.trim());
            }}
          >
            <p>{m.security.scan}</p>
            <div className="qr" aria-hidden="true" dangerouslySetInnerHTML={{ __html: qr }} />
            <Field label={m.security.manualKey}>
              <div className="secret-field">
                <span>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</span>
                <CopyButton value={setup.secret} />
              </div>
            </Field>
            <Field label={m.security.enterCode}>
              <Input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" style={{ maxWidth: 180, letterSpacing: '0.2em' }} />
            </Field>
            <div className="row">
              <Button onClick={() => setSetup(null)}>{m.common.cancel}</Button>
              <Button type="submit" variant="primary" busy={enable.isPending} disabled={code.length !== 6}>
                {m.security.activate}
              </Button>
            </div>
          </form>
        )}
      </SettingsSection>

      <SettingsSection title={m.security.sessions} hint={m.security.sessionsHint}>
        {sessions.data === undefined ? (
          <Skeleton height={120} />
        ) : (
          <>
            <div className="list">
              {sessions.data.map((session) => (
                <div key={session.id} className="list__row">
                  <Laptop width={18} height={18} className="faint" aria-hidden="true" />
                  <div className="grow">
                    <div className="row">
                      <span className="list__title">{describeAgent(session.userAgent)}</span>
                      {session.current && <Badge tone="ok">{m.security.current}</Badge>}
                    </div>
                    <div className="list__meta">
                      {session.ip !== null && <span>{session.ip}</span>}
                      <RelativeTime value={session.lastUsedAt} />
                    </div>
                  </div>
                  {!session.current && (
                    <Button size="sm" variant="ghost" onClick={() => revoke.mutate(session.id)}>
                      {m.security.revoke}
                    </Button>
                  )}
                </div>
              ))}
            </div>
            {sessions.data.length > 1 && (
              <div>
                <Button busy={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>
                  {m.security.revokeOthers}
                </Button>
              </div>
            )}
          </>
        )}
      </SettingsSection>

      {codes !== null && <RecoveryCodes codes={codes} onClose={() => setCodes(null)} />}
      <Dialog
        open={regenerating}
        onClose={() => setRegenerating(false)}
        title={m.security.regenerate}
        onSubmit={() => regenerate.mutate(regenerateCode)}
        footer={
          <>
            <Button onClick={() => setRegenerating(false)}>{m.common.cancel}</Button>
            <Button type="submit" variant="primary" busy={regenerate.isPending} disabled={regenerateCode.length !== 6}>
              {m.common.confirm}
            </Button>
          </>
        }
      >
        <Field label={m.security.enterCode}>
          <Input value={regenerateCode} onChange={(event) => setRegenerateCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" autoFocus />
        </Field>
      </Dialog>
      <Dialog
        open={disabling}
        onClose={() => setDisabling(false)}
        title={m.security.disableTitle}
        onSubmit={() => disable.mutate(disableForm)}
        footer={
          <>
            <Button onClick={() => setDisabling(false)}>{m.common.cancel}</Button>
            <Button type="submit" variant="danger" busy={disable.isPending}>
              {m.security.disable}
            </Button>
          </>
        }
      >
        <div className="stack">
          {me.data.hasPassword && (
            <Field label={m.security.currentPassword}>
              <Input type="password" autoComplete="current-password" value={disableForm.password} onChange={(event) => setDisableForm({ ...disableForm, password: event.target.value })} />
            </Field>
          )}
          <Field label={m.security.enterCode}>
            <Input value={disableForm.code} onChange={(event) => setDisableForm({ ...disableForm, code: event.target.value.replace(/\D/g, '').slice(0, 6) })} inputMode="numeric" autoComplete="one-time-code" />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
