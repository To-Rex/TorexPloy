import { useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { setupSchema } from '@ploy/shared';
import { Button, Callout, Field, Input } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { errorText, fieldErrors } from '../../lib/errors.ts';
import { keys } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { AuthLayout } from './AuthLayout.tsx';

export function SetupPage() {
  const { m, locale } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [form, setForm] = useState({ name: '', email: '', password: '', teamName: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof form) => (event: ChangeEvent<HTMLInputElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async () => {
    const result = validate(m, setupSchema, { ...form, locale });
    if (result.errors !== null) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api.post('/api/setup', result.data);
      await client.invalidateQueries({ queryKey: keys.bootstrap });
      await navigate('/', { replace: true });
    } catch (error) {
      setErrors(fieldErrors(m, error));
      setFailure(errorText(m, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <form
        className="auth__form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2>{m.setup.title}</h2>
        <p>{m.setup.subtitle}</p>
        {failure !== null && Object.keys(errors).length === 0 && <Callout tone="bad">{failure}</Callout>}
        <Field label={m.setup.name} error={errors.name}>
          <Input value={form.name} onChange={set('name')} autoComplete="name" autoFocus />
        </Field>
        <Field label={m.setup.email} error={errors.email}>
          <Input type="email" value={form.email} onChange={set('email')} autoComplete="email" inputMode="email" />
        </Field>
        <Field label={m.setup.password} hint={m.setup.passwordHint} error={errors.password}>
          <Input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" />
        </Field>
        <Field label={m.setup.teamName} hint={m.setup.teamHint} error={errors.teamName}>
          <Input value={form.teamName} onChange={set('teamName')} autoComplete="organization" />
        </Field>
        <Button type="submit" variant="primary" block busy={busy}>
          {m.setup.submit}
        </Button>
      </form>
    </AuthLayout>
  );
}
