import { useEffect, useState } from 'react';
import { ExternalLink, Globe, RefreshCw } from 'lucide-react';
import { isWildcardDnsHost, platformSettingsSchema, type PlatformSettingsDto, type PlatformSettingsInput } from '@ploy/shared';
import { Status } from '../../components/Status.tsx';
import { Button, Callout, Field, Input, Skeleton, Switch } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useMe, usePanelDomainStatus, useSettings } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { SettingsSection } from './SettingsLayout.tsx';
import { UpdatesCard } from './UpdatesCard.tsx';
import { TimezoneCard } from './TimezoneCard.tsx';

/**
 * The saved panel domain as a visitor would find it: where the name
 * resolves and what certificate is served there, checked by the server.
 * It keeps asking while a certificate is on its way, and says what to do
 * when something stands in the way.
 */
function PanelDomainStatus({ host }: { host: string }) {
  const { m, t, formatDate } = useI18n();
  const d = m.platform.domainStatus;
  const status = usePanelDomainStatus(host);
  const data = status.data;
  const url = `https://${host}`;
  const here = window.location.origin === url;
  const dns = data?.dns ?? null;
  const tls = data?.tls ?? null;
  const ready = dns?.status === 'ok' && tls?.status === 'active';

  return (
    <div className="panel">
      <div className="panel__head" style={{ flexWrap: 'wrap' }}>
        <Globe width={17} height={17} className="faint" aria-hidden="true" />
        <a href={url} target="_blank" rel="noreferrer noopener" className="truncate mono" style={{ fontWeight: 600, color: 'var(--ink)' }}>
          {host}
        </a>
        <span className="grow" />
        <Button size="sm" variant="ghost" icon={<RefreshCw />} busy={status.isFetching} onClick={() => void status.refetch()}>
          {d.recheck}
        </Button>
      </div>
      <div className="panel__body" style={{ display: 'grid', gap: 12 }}>
        {data === undefined || data.host !== host ? (
          <Skeleton height={48} />
        ) : (
          <>
            <dl className="kv">
              <dt>{d.dns}</dt>
              <dd className="row wrap" style={{ gap: '2px 10px' }}>
                {dns !== null && <Status kind="dns" status={dns.status} />}
                {dns?.status === 'ok' && <span className="faint">{d.dnsOk}</span>}
                {dns?.status === 'mismatch' && (
                  <span className="faint">
                    {t(m.domains.pointsTo, { records: dns.records.join(', ') })}
                    {dns.expected !== null && <> · {t(m.domains.expected, { ip: dns.expected })}</>}
                  </span>
                )}
                {dns?.status === 'pending' && <span className="faint">{d.dnsPending}</span>}
                {dns?.status === 'error' && <span className="faint">{d.dnsError}</span>}
              </dd>
              <dt>{d.certificate}</dt>
              <dd className="row wrap" style={{ gap: '2px 10px' }}>
                {tls === null ? (
                  <span className="faint">{d.tlsWaitingDns}</span>
                ) : (
                  <>
                    <Status kind="tls" status={tls.status} />
                    {tls.status === 'active' && tls.issuer !== null && <span className="faint">{t(m.domains.issuedBy, { issuer: tls.issuer })}</span>}
                    {tls.status === 'active' && tls.expiresAt !== null && <span className="faint">{t(m.domains.expires, { date: formatDate(tls.expiresAt, { dateStyle: 'medium' }) })}</span>}
                    {tls.status === 'pending' && <span className="faint">{d.tlsPending}</span>}
                    {tls.status === 'error' && tls.message !== null && <span className="faint">{tls.message}</span>}
                  </>
                )}
              </dd>
            </dl>
            {!data.proxyRunning && <Callout tone="work">{d.proxyDown}</Callout>}
            {data.proxyRunning && tls !== null && tls.status === 'pending' && <p className="field__hint">{d.tlsPendingHint}</p>}
            {dns?.status === 'mismatch' && <p className="field__hint">{m.domains.cdnHint}</p>}
            {ready && (
              <Callout
                tone="ok"
                action={
                  here ? undefined : (
                    <a className="btn btn--sm" href={`${url}/settings/platform`} style={{ textDecoration: 'none' }}>
                      <ExternalLink width={14} height={14} aria-hidden="true" />
                      {d.open}
                    </a>
                  )
                }
              >
                {d.ready} {here ? d.readyHere : d.keepsIp}
              </Callout>
            )}
            {data.wildcard && <p className="field__hint">{d.wildcard}</p>}
          </>
        )}
      </div>
    </div>
  );
}

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
  const { m, t, plural } = useI18n();
  const settings = useSettings();
  const me = useMe();
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** The certificate email was filled in for the suggested address: said once, next to the field. */
  const [emailPrefilled, setEmailPrefilled] = useState(false);
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
  const suggested = settings.data.suggestedDomain;
  const savedDomain = settings.data.platformDomain;
  const domainChanging = savedDomain !== null && form.platformDomain.trim().toLowerCase() !== savedDomain;

  /** One click for a panel without a domain: the sslip.io name of this server, and an email its certificate needs. */
  const useSuggested = () => {
    if (suggested === null) return;
    const email = form.acmeEmail.trim().length === 0 ? (me.data?.email ?? '') : form.acmeEmail;
    setEmailPrefilled(form.acmeEmail.trim().length === 0 && email.length > 0);
    setForm({ ...form, platformDomain: suggested, acmeEmail: email });
    setErrors({});
  };
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
        // The server checks this too; saying it at once saves a round trip.
        if (payload.acmeEmail === null && [payload.platformDomain, payload.appsDomain].some((host) => host != null && isWildcardDnsHost(host))) {
          setErrors({ acmeEmail: m.validation.acmeEmailRequired });
          return;
        }
        setErrors({});
        setEmailPrefilled(false);
        save.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
      }}
    >
      <SettingsSection title={m.platform.domains} hint={m.platform.domainsHint}>
        <Field label={m.platform.platformDomain} hint={t(m.platform.platformDomainHint, { ip })} error={errors.platformDomain}>
          <Input mono {...text('platformDomain')} placeholder="deploy.example.uz" spellCheck={false} />
        </Field>
        {suggested !== null && form.platformDomain.trim().length === 0 && (
          <p className="field__hint" style={{ marginTop: -8 }}>
            {m.platform.noDomain}{' '}
            <button type="button" className="link-btn" onClick={useSuggested}>
              {t(m.platform.useSuggested, { host: suggested })}
            </button>
          </p>
        )}
        {suggested !== null && form.platformDomain === suggested && savedDomain !== suggested && <Callout tone="info">{m.platform.suggestedHint}</Callout>}
        {domainChanging && settings.data.domainPasskeys > 0 && <Callout tone="work">{plural(m.platform.passkeysAtRisk, settings.data.domainPasskeys)}</Callout>}
        {savedDomain !== null && <PanelDomainStatus host={savedDomain} />}
        <Field label={m.platform.appsDomain} hint={m.platform.appsDomainHint} error={errors.appsDomain}>
          <Input mono {...text('appsDomain')} placeholder="apps.example.uz" spellCheck={false} />
        </Field>
        <Field label={m.platform.acmeEmail} hint={emailPrefilled ? `${m.platform.emailPrefilled} ${m.platform.acmeEmailHint}` : m.platform.acmeEmailHint} error={errors.acmeEmail}>
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
      <TimezoneCard />
      <UpdatesCard />
      <SettingsSection title={m.platform.access}>
        <Switch checked={form.allowGithubSignup} onChange={(value) => setForm({ ...form, allowGithubSignup: value })} label={m.platform.allowGithubSignup} hint={m.platform.allowGithubSignupHint} />
      </SettingsSection>
      {dirty && (
        <div className="savebar">
          <span>{m.common.unsavedChanges}</span>
          <div className="row">
            <Button
              variant="ghost"
              onClick={() => {
                setForm(initial);
                setErrors({});
                setEmailPrefilled(false);
              }}
            >
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
