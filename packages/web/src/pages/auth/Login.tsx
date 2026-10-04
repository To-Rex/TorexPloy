import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { loginSchema, type LoginResultDto } from '@ploy/shared';
import { Button, ButtonLink, Callout, Field, GithubMark, Input } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { errorText, fieldErrors } from '../../lib/errors.ts';
import { keys, useBootstrap } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { AuthLayout } from './AuthLayout.tsx';

export function LoginPage() {
  const { m } = useI18n();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const bootstrap = useBootstrap();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [ticket, setTicket] = useState<string | null>(params.get('ticket'));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const githubError = params.get('error') as keyof typeof m.auth.githubErrors | null;

  const finish = async () => {
    await client.invalidateQueries({ queryKey: keys.bootstrap });
    const next = params.get('next');
    await navigate(next !== null && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
  };

  const submitPassword = async () => {
    const result = validate(m, loginSchema, { email, password });
    if (result.errors !== null) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setFailure(null);
    setBusy(true);
    try {
      const response = await api.post<LoginResultDto>('/api/auth/login', result.data);
      if (response.twoFactorRequired && response.ticket !== undefined) setTicket(response.ticket);
      else await finish();
    } catch (error) {
      setErrors(fieldErrors(m, error));
      setFailure(errorText(m, error));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    if (ticket === null) return;
    setBusy(true);
    setFailure(null);
    try {
      await api.post('/api/auth/login/2fa', { ticket, code });
      await finish();
    } catch (error) {
      setFailure(errorText(m, error));
      if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'unauthorized') setTicket(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      {ticket === null ? (
        <form
          className="auth__form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submitPassword();
          }}
        >
          <h2>{m.auth.loginTitle}</h2>
          <p>{m.auth.loginSubtitle}</p>
          {githubError !== null && m.auth.githubErrors[githubError] !== undefined && <Callout tone="bad">{m.auth.githubErrors[githubError]}</Callout>}
          {failure !== null && Object.keys(errors).length === 0 && <Callout tone="bad">{failure}</Callout>}
          <Field label={m.auth.email} error={errors.email}>
            <Input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} autoFocus inputMode="email" />
          </Field>
          <Field label={m.auth.password} error={errors.password}>
            <Input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          <Button type="submit" variant="primary" block busy={busy}>
            {m.auth.signIn}
          </Button>
          {bootstrap.data?.features.githubLogin === true && (
            <>
              <div className="divider-text">{m.auth.or}</div>
              <ButtonLink href="/api/auth/github/start" icon={<GithubMark />}>
                {m.auth.withGithub}
              </ButtonLink>
            </>
          )}
        </form>
      ) : (
        <form
          className="auth__form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submitCode();
          }}
        >
          <h2>{m.auth.twoFactorTitle}</h2>
          <p>{m.auth.twoFactorText}</p>
          {failure !== null && <Callout tone="bad">{failure}</Callout>}
          <Field label={m.auth.code}>
            <Input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" inputMode="text" autoFocus spellCheck={false} maxLength={20} style={{ letterSpacing: '0.12em', fontSize: 'var(--text-lg)' }} />
          </Field>
          <Button type="submit" variant="primary" block busy={busy} disabled={code.trim().length < 6}>
            {m.auth.verify}
          </Button>
          <Button variant="ghost" block onClick={() => { setTicket(null); setCode(''); setFailure(null); }}>
            {m.auth.useAnotherAccount}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
