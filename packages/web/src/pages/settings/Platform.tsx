import { useEffect, useState } from 'react';
import { platformSettingsSchema, type PlatformSettingsDto, type PlatformSettingsInput } from '@ploy/shared';
import { Button, Field, Input, Skeleton, Switch } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useSettings } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { SettingsSection } from './SettingsLayout.tsx';

interface Form {
  platformDomain: string;
  appsDomain: string;
  acmeEmail: string;
  buildConcurrency: string;
  imageRetention: string;
  metricsRetentionDays: string;
  allowGithubSignup: boolean;
}

const toForm = (settings: PlatformSettingsDto): Form => ({
  platformDomain: settings.platformDomain ?? '',
  appsDomain: settings.appsDomain ?? '',
  acmeEmail: settings.acmeEmail ?? '',
  buildConcurrency: String(settings.buildConcurrency),
  imageRetention: String(settings.imageRetention),
  metricsRetentionDays: String(settings.metricsRetentionDays),
  allowGithubSignup: settings.allowGithubSignup,
});

export function PlatformPage() {
  const { m, t } = useI18n();
  const settings = useSettings();
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (settings.data !== undefined) setForm(toForm(settings.data));
  }, [settings.data]);
  const save = useAction((input: PlatformSettingsInput) => api.patch<PlatformSettingsDto>('/api/settings', input), {
    success: m.platform.saved,
    invalidate: [keys.settings],
    inlineValidation: true,
  });

  if (settings.data === undefined || form === null) return <Skeleton height={300} />;
  const initial = toForm(settings.data);
  const dirty = JSON.stringify(initial) !== JSON.stringify(form);
  const ip = settings.data.publicIp ?? '…';
  const text = (key: Exclude<keyof Form, 'allowGithubSignup'>, numeric = false) => ({
    value: form[key],
    onChange: (event: { target: { value: string } }) => setForm({ ...form, [key]: numeric ? event.target.value.replace(/\D/g, '') : event.target.value }),
  });

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const payload: PlatformSettingsInput = {
          platformDomain: form.platformDomain.trim().length === 0 ? null : form.platformDomain.trim().toLowerCase(),
          appsDomain: form.appsDomain.trim().length === 0 ? null : form.appsDomain.trim().toLowerCase(),
          acmeEmail: form.acmeEmail.trim().length === 0 ? null : form.acmeEmail.trim(),
          buildConcurrency: Number(form.buildConcurrency),
          imageRetention: Number(form.imageRetention),
          metricsRetentionDays: Number(form.metricsRetentionDays),
          allowGithubSignup: form.allowGithubSignup,
        };
        const result = validate(m, platformSettingsSchema, payload);
        if (result.errors !== null) {
          setErrors(result.errors);
          return;
        }
        setErrors({});
        save.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
      }}
    >
      <SettingsSection title={m.platform.domains} hint={m.platform.domainsHint}>
        <Field label={m.platform.platformDomain} hint={t(m.platform.platformDomainHint, { ip })} error={errors.platformDomain}>
          <Input mono {...text('platformDomain')} placeholder="deploy.example.uz" spellCheck={false} />
        </Field>
        <Field label={m.platform.appsDomain} hint={m.platform.appsDomainHint} error={errors.appsDomain}>
          <Input mono {...text('appsDomain')} placeholder="apps.example.uz" spellCheck={false} />
        </Field>
        <Field label={m.platform.acmeEmail} hint={m.platform.acmeEmailHint} error={errors.acmeEmail}>
          <Input type="email" {...text('acmeEmail')} placeholder="ops@example.uz" />
        </Field>
        <Field label={m.platform.publicIp}>
          <Input mono value={settings.data.publicIp ?? ''} disabled />
        </Field>
      </SettingsSection>
      <SettingsSection title={m.platform.builds} hint={m.platform.buildsHint}>
        <div className="form-grid">
          <Field label={m.platform.buildConcurrency} hint={m.platform.buildConcurrencyHint} error={errors.buildConcurrency}>
            <Input {...text('buildConcurrency', true)} inputMode="numeric" />
          </Field>
          <Field label={m.platform.imageRetention} hint={m.platform.imageRetentionHint} error={errors.imageRetention}>
            <Input {...text('imageRetention', true)} inputMode="numeric" />
          </Field>
          <Field label={m.platform.metricsRetention} error={errors.metricsRetentionDays}>
            <Input {...text('metricsRetentionDays', true)} inputMode="numeric" />
          </Field>
        </div>
      </SettingsSection>
      <SettingsSection title={m.platform.access}>
        <Switch checked={form.allowGithubSignup} onChange={(value) => setForm({ ...form, allowGithubSignup: value })} label={m.platform.allowGithubSignup} hint={m.platform.allowGithubSignupHint} />
      </SettingsSection>
      {dirty && (
        <div className="savebar">
          <span>{m.common.unsavedChanges}</span>
          <div className="row">
            <Button variant="ghost" onClick={() => setForm(initial)}>
              {m.common.discard}
            </Button>
            <Button type="submit" variant="primary" busy={save.isPending}>
              {m.common.saveChanges}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
