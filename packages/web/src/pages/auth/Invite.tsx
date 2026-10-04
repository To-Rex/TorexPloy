import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { InvitationPreviewDto } from '@ploy/shared';
import { Button, Callout, Field, Input, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { errorText, fieldErrors } from '../../lib/errors.ts';
import { useBootstrap } from '../../lib/queries.ts';
import { AuthLayout } from './AuthLayout.tsx';

export function InvitePage() {
  const { token = '' } = useParams();
  const { m, t } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const bootstrap = useBootstrap();
  const preview = useQuery({ queryKey: ['invitation', token], queryFn: () => api.get<InvitationPreviewDto>(`/api/invitations/${token}`), retry: false });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const user = bootstrap.data?.user ?? null;

  const accept = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await api.post(`/api/invitations/${token}/accept`, user === null ? { name, password } : {});
      client.clear();
      await navigate('/', { replace: true });
    } catch (error) {
      setErrors(fieldErrors(m, error));
      setFailure(errorText(m, error));
    } finally {
      setBusy(false);
    }
  };

  const data = preview.data;
  const role = data === undefined ? '' : m.roles[data.role];
  return (
    <AuthLayout>
      <form
        className="auth__form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void accept();
        }}
      >
        <h2>{m.invite.title}</h2>
        {preview.isPending && <Skeleton height={40} />}
        {preview.isError && <Callout tone="bad">{m.invite.invalid}</Callout>}
        {data !== undefined && (
          <>
            <p>{data.invitedBy === null ? t(m.invite.textNoInviter, { team: data.teamName, role }) : t(m.invite.text, { inviter: data.invitedBy, team: data.teamName, role })}</p>
            {failure !== null && Object.keys(errors).length === 0 && <Callout tone="bad">{failure}</Callout>}
            {user !== null ? (
              <>
                {user.email.toLowerCase() !== data.email.toLowerCase() && <Callout tone="work">{t(m.invite.wrongAccount, { email: data.email })}</Callout>}
                <Button type="submit" variant="primary" block busy={busy} disabled={user.email.toLowerCase() !== data.email.toLowerCase()}>
                  {m.invite.accept}
                </Button>
              </>
            ) : data.userExists ? (
              <>
                <Callout tone="info">{m.invite.signInFirst}</Callout>
                <Link className="btn btn--primary btn--block" to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`} style={{ textDecoration: 'none' }}>
                  {m.auth.signIn}
                </Link>
              </>
            ) : (
              <>
                <p className="muted">{m.invite.createAccount}</p>
                <Field label={m.auth.email}>
                  <Input value={data.email} disabled />
                </Field>
                <Field label={m.setup.name} error={errors.name}>
                  <Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" autoFocus />
                </Field>
                <Field label={m.auth.password} hint={m.setup.passwordHint} error={errors.password}>
                  <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
                </Field>
                <Button type="submit" variant="primary" block busy={busy}>
                  {m.invite.accept}
                </Button>
              </>
            )}
          </>
        )}
      </form>
    </AuthLayout>
  );
}
