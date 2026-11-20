import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Fingerprint } from 'lucide-react';
import { loginSchema, type LoginResultDto, type PasskeyRequestOptionsDto } from '@ploy/shared';
import { Button, ButtonLink, Callout, Field, GithubMark, Input } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { errorText, fieldErrors } from '../../lib/errors.ts';
import { getPasskey, passkeyAutofillSupported, PasskeyError, passkeyErrorText, passkeysSupported, type PasskeyAssertion } from '../../lib/passkey.ts';
import { keys, useBootstrap } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { AuthLayout } from './AuthLayout.tsx';

/** A challenge lives five minutes on the server; a request waiting behind the autofill is renewed before that. */
const AUTOFILL_RENEW_MS = 4 * 60_000;

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
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  /** Bumped to start the quiet autofill request again after the explicit one ended without a sign-in. */
  const [autofillRound, setAutofillRound] = useState(0);
  const autofill = useRef<AbortController | null>(null);
  const githubError = params.get('error') as keyof typeof m.auth.githubErrors | null;
  // Offered only where a passkey can exist: the panel's HTTPS domain, in a browser that speaks WebAuthn.
  const passkeys = bootstrap.data?.features.passkeys === true && passkeysSupported();

  const finish = useCallback(async () => {
    await client.invalidateQueries({ queryKey: keys.bootstrap });
    const next = params.get('next');
    await navigate(next !== null && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
  }, [client, navigate, params]);

  const completePasskey = useCallback(
    async (passkeyTicket: string, credential: PasskeyAssertion) => {
      setPasskeyBusy(true);
      try {
        await api.post('/api/auth/passkey', { ticket: passkeyTicket, credential });
        await finish();
      } finally {
        setPasskeyBusy(false);
      }
    },
    [finish],
  );

  /**
   * Passkeys in the email field's suggestions: a request that waits, with no
   * dialog, until a passkey is picked from the autofill. It is renewed
   * before its challenge lapses and steps aside for the explicit button.
   */
  useEffect(() => {
    if (!passkeys || ticket !== null) return;
    let stopped = false;
    const wait = async () => {
      if (!(await passkeyAutofillSupported())) return;
      while (!stopped) {
        const controller = new AbortController();
        autofill.current = controller;
        let lapsed = false;
        const timer = window.setTimeout(() => {
          lapsed = true;
          controller.abort();
        }, AUTOFILL_RENEW_MS);
        let options: PasskeyRequestOptionsDto;
        let credential: PasskeyAssertion;
        try {
          options = await api.post<PasskeyRequestOptionsDto>('/api/auth/passkey/options');
          credential = await getPasskey(options.publicKey, { autofill: true, signal: controller.signal });
        } catch {
          window.clearTimeout(timer);
          // Renewed on schedule; otherwise aborted for the explicit button or refused by the browser, and there is nothing to say.
          if (!stopped && lapsed) continue;
          return;
        }
        window.clearTimeout(timer);
        if (stopped) return;
        try {
          await completePasskey(options.ticket, credential);
          return;
        } catch (error) {
          if (stopped) return;
          // The server's verdict on the picked passkey is shown; the field keeps offering passkeys.
          setFailure(passkeyErrorText(m, error));
        }
      }
    };
    void wait();
    return () => {
      stopped = true;
      autofill.current?.abort();
      autofill.current = null;
    };
  }, [passkeys, ticket, autofillRound, completePasskey, m]);

  const signInWithPasskey = async () => {
    // One WebAuthn request at a time: the quiet one makes way.
    autofill.current?.abort();
    autofill.current = null;
    setErrors({});
    setFailure(null);
    setPasskeyBusy(true);
    try {
      const options = await api.post<PasskeyRequestOptionsDto>('/api/auth/passkey/options');
      const credential = await getPasskey(options.publicKey);
      await completePasskey(options.ticket, credential);
    } catch (error) {
      // Closing the browser's dialog is a decision, not an error worth a red box.
      if (!(error instanceof PasskeyError && error.kind === 'cancelled')) setFailure(passkeyErrorText(m, error));
      setAutofillRound((round) => round + 1);
    } finally {
      setPasskeyBusy(false);
    }
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
            <Input type="email" autoComplete={passkeys ? 'username webauthn' : 'username'} value={email} onChange={(event) => setEmail(event.target.value)} autoFocus inputMode="email" />
          </Field>
          <Field label={m.auth.password} error={errors.password}>
            <Input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          <Button type="submit" variant="primary" block busy={busy} disabled={passkeyBusy}>
            {m.auth.signIn}
          </Button>
          {(passkeys || bootstrap.data?.features.githubLogin === true) && <div className="divider-text">{m.auth.or}</div>}
          {passkeys && (
            <Button block icon={<Fingerprint />} busy={passkeyBusy} disabled={busy} onClick={() => void signInWithPasskey()}>
              {m.auth.withPasskey}
            </Button>
          )}
          {bootstrap.data?.features.githubLogin === true && (
            <ButtonLink href="/api/auth/github/start" icon={<GithubMark />}>
              {m.auth.withGithub}
            </ButtonLink>
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
