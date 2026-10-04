import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { LOCALES, THEMES, updateProfileSchema, type Locale, type Theme, type UserDto } from '@ploy/shared';
import { Button, ButtonLink, Callout, Field, GithubMark, Input, Segmented, Skeleton } from '../../components/ui.tsx';
import { LOCALE_NAMES, useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useMe } from '../../lib/queries.ts';
import { useTheme } from '../../lib/theme.tsx';
import { validate } from '../../lib/validate.ts';
import { SettingsSection } from './SettingsLayout.tsx';

export function ProfilePage() {
  const { m, t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const client = useQueryClient();
  const me = useMe();
  const [params] = useSearchParams();
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (me.data !== undefined) setName(me.data.name);
  }, [me.data]);

  const save = useAction((input: { name?: string; locale?: Locale; theme?: Theme }) => api.patch<UserDto>('/api/me', input), {
    invalidate: [keys.me, keys.bootstrap],
    onSuccess: (user) => client.setQueryData(keys.me, user),
  });

  const githubResult = params.get('github') as keyof typeof m.profile.githubResult | null;
  if (me.data === undefined) return <Skeleton height={300} />;
  return (
    <>
      {githubResult !== null && m.profile.githubResult[githubResult] !== undefined && (
        <Callout tone={githubResult === 'linked' ? 'ok' : 'bad'}>{m.profile.githubResult[githubResult]}</Callout>
      )}
      <SettingsSection title={m.profile.title}>
        <form
          className="stack"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const result = validate(m, updateProfileSchema, { name });
            if (result.errors !== null) {
              setErrors(result.errors);
              return;
            }
            save.mutate({ name: name.trim() }, { onSuccess: () => setErrors({}) });
          }}
        >
          <Field label={m.profile.name} error={errors.name}>
            <Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
          </Field>
          <Field label={m.profile.email}>
            <Input value={me.data.email} disabled />
          </Field>
          {name.trim() !== me.data.name && (
            <div>
              <Button type="submit" variant="primary" busy={save.isPending}>
                {m.common.save}
              </Button>
            </div>
          )}
        </form>
      </SettingsSection>
      <SettingsSection title={m.profile.language} hint={m.profile.languageHint}>
        <div>
          <Segmented
            label={m.profile.language}
            value={locale}
            onChange={(value) => {
              void setLocale(value);
              save.mutate({ locale: value });
            }}
            options={LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] }))}
          />
        </div>
      </SettingsSection>
      <SettingsSection title={m.profile.theme} hint={m.profile.themeHint}>
        <div>
          <Segmented
            label={m.profile.theme}
            value={theme}
            onChange={(value) => {
              setTheme(value);
              save.mutate({ theme: value });
            }}
            options={THEMES.map((value) => ({ value, label: m.theme[value] }))}
          />
        </div>
      </SettingsSection>
      <SettingsSection title={m.profile.github} hint={m.profile.githubHint}>
        <div className="row">
          {me.data.githubLogin !== null ? (
            <span className="row" style={{ gap: 8 }}>
              <GithubMark />
              {t(m.profile.githubLinked, { login: me.data.githubLogin })}
            </span>
          ) : (
            <ButtonLink href="/api/auth/github/start?mode=link" icon={<GithubMark />}>
              {m.profile.linkGithub}
            </ButtonLink>
          )}
        </div>
      </SettingsSection>
    </>
  );
}
