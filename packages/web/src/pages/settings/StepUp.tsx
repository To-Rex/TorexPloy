/**
 * "Forgot your password?" Wherever the password is asked for as a
 * confirmation (a new password, a new passkey, turning two-factor off), a
 * signed-in owner can prove it is them another way: through the GitHub
 * account linked to theirs, or with one of their passkeys. That confirmation
 * holds on this session for ten minutes, during which the password is not
 * asked for.
 *
 * GitHub takes the browser away and brings it back to the Security page
 * (which reads the outcome from the address); a passkey confirms in place.
 * The trip to GitHub begins with a request, not a link: the server hands
 * this browser a one-time value and will accept the answer only from it.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Fingerprint, ShieldCheck } from 'lucide-react';
import type { PasskeyRequestOptionsDto, StepUpDto, StepUpPurpose, StepUpStartDto } from '@ploy/shared';
import { Dialog } from '../../components/Dialog.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Button, Callout, GithubMark } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { errorText } from '../../lib/errors.ts';
import { getPasskey, PasskeyError, passkeyErrorText, passkeysSupported } from '../../lib/passkey.ts';
import { keys, useMe, useStepUp } from '../../lib/queries.ts';

/** The session's confirmation, kept honest: the clock runs here too, and the server is asked again when it should have lapsed. */
export function useConfirmedOwner(): { status: StepUpDto | undefined; confirmed: boolean; minutesLeft: number } {
  const stepUp = useStepUp();
  const client = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const expires = stepUp.data?.active === true && stepUp.data.expiresAt !== null ? Date.parse(stepUp.data.expiresAt) : null;
  useEffect(() => {
    if (expires === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [expires]);
  useEffect(() => {
    if (expires !== null && now >= expires) void client.invalidateQueries({ queryKey: keys.stepUp });
  }, [client, expires, now]);
  const confirmed = expires !== null && now < expires;
  return { status: stepUp.data, confirmed, minutesLeft: confirmed ? Math.floor((expires - now) / 60_000) : 0 };
}

/** Said while a confirmation is in force: how it was made, how long it holds, and the way to end it early. */
export function ConfirmedNote() {
  const { m, plural } = useI18n();
  const s = m.stepUp;
  const client = useQueryClient();
  const { status, confirmed, minutesLeft } = useConfirmedOwner();
  if (!confirmed || status === undefined || status.method === null) return null;
  return (
    <Callout
      tone="ok"
      action={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void api.delete('/api/me/step-up').finally(() => void client.invalidateQueries({ queryKey: keys.stepUp }));
          }}
        >
          {s.giveUp}
        </Button>
      }
    >
      {s.confirmedBy[status.method]} {minutesLeft > 0 ? plural(s.remaining, minutesLeft) : s.lessThanMinute}
    </Callout>
  );
}

/** One line under a hidden password field: why it is not there. */
export function ConfirmedHint() {
  const { m } = useI18n();
  return (
    <p className="row field__hint" style={{ gap: 6 }}>
      <ShieldCheck width={14} height={14} aria-hidden="true" style={{ color: 'var(--ok)' }} />
      {m.stepUp.confirmedShort}
    </p>
  );
}

/**
 * The link under a password field, and the dialog it opens. Renders nothing
 * when there is no other way to confirm (no linked GitHub account, no
 * passkey) or when the session is confirmed already. `purpose` is what the
 * owner was doing, so GitHub's return can put them back in front of it.
 */
export function ForgotPassword({ purpose }: { purpose: StepUpPurpose }) {
  const { m, t } = useI18n();
  const s = m.stepUp;
  const stepUp = useStepUp();
  const me = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'github' | 'passkey' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const status = stepUp.data;
  if (status === undefined || status.active) return null;
  const github = status.methods.github;
  const passkey = status.methods.passkey && passkeysSupported();
  if (!github && !passkey) return null;

  const withGithub = async () => {
    setBusy('github');
    setFailure(null);
    try {
      const { url } = await api.post<StepUpStartDto>('/api/me/step-up/github', { then: purpose });
      // GitHub has the browser from here; it stays busy until the page is left.
      window.location.assign(url);
    } catch (error) {
      setFailure(error instanceof ApiError && error.params.reason === 'unavailable' ? s.results.unavailable : errorText(m, error));
      setBusy(null);
    }
  };

  const withPasskey = async () => {
    setBusy('passkey');
    setFailure(null);
    try {
      const options = await api.post<PasskeyRequestOptionsDto>('/api/me/step-up/passkey/options');
      const credential = await getPasskey(options.publicKey);
      await api.post('/api/me/step-up/passkey', { ticket: options.ticket, credential });
      await client.invalidateQueries({ queryKey: keys.stepUp });
      void client.invalidateQueries({ queryKey: keys.passkeys });
      setOpen(false);
      toast.success(s.results.ok);
    } catch (error) {
      // Closing the browser's prompt is a decision, not a failure.
      if (!(error instanceof PasskeyError && error.kind === 'cancelled')) setFailure(passkeyErrorText(m, error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button type="button" className="link-btn" onClick={() => setOpen(true)}>
        {s.forgot}
      </button>
      <Dialog
        open={open}
        onClose={() => {
          if (busy === null) setOpen(false);
        }}
        title={s.title}
        description={s.text}
      >
        <div className="stack" style={{ gap: 10 }}>
          {github && (
            <button type="button" className="choice" disabled={busy !== null} aria-busy={busy === 'github' || undefined} onClick={() => void withGithub()}>
              <span className="choice__title">
                <GithubMark />
                {s.withGithub}
              </span>
              <span className="choice__hint">
                {s.withGithubHint}
                {me.data?.githubLogin != null && <> {t(s.withGithubAs, { login: me.data.githubLogin })}</>}
              </span>
            </button>
          )}
          {passkey && (
            <button type="button" className="choice" disabled={busy !== null} aria-busy={busy === 'passkey' || undefined} onClick={() => void withPasskey()}>
              <span className="choice__title">
                <Fingerprint aria-hidden="true" />
                {s.withPasskey}
              </span>
              <span className="choice__hint">{busy === 'passkey' ? m.passkeys.waiting : s.withPasskeyHint}</span>
            </button>
          )}
          {failure !== null && <Callout tone="bad">{failure}</Callout>}
        </div>
      </Dialog>
    </>
  );
}
