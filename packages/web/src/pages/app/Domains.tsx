import { useState } from 'react';
import { ArrowRight, CornerDownRight, ExternalLink, Globe, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { createDomainSchema, type DomainDto } from '@ploy/shared';
import { useConfirm, Dialog } from '../../components/Dialog.tsx';
import { Card } from '../../components/Frame.tsx';
import { Status } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Badge, Button, ButtonLink, Checkbox, EmptyState, Field, Input, Segmented, Select, SkeletonRows, Switch } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useCompose, useDomains } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { useAppContext } from './AppLayout.tsx';

function DomainRow({ domain, appId }: { domain: DomainDto; appId: string }) {
  const { m, t, formatDate } = useI18n();
  const confirm = useConfirm();
  const invalidate = [keys.appPart(appId, 'domains'), keys.app(appId)];
  const verify = useAction(() => api.post(`/api/domains/${domain.id}/verify`), { invalidate });
  const toggleHttps = useAction((https: boolean) => api.patch(`/api/domains/${domain.id}`, { https }), { invalidate });
  const remove = useAction(() => api.delete(`/api/domains/${domain.id}`), { success: m.domains.removed, invalidate });
  const url = `${domain.https ? 'https' : 'http'}://${domain.host}`;
  const needsDns = !domain.isGenerated && domain.dns.status !== 'ok';
  const labels = domain.host.split('.');
  const name = labels.length > 2 ? labels.slice(0, -2).join('.') : '@';

  return (
    <div className="panel">
      <div className="panel__head" style={{ flexWrap: 'wrap' }}>
        <Globe width={17} height={17} className="faint" aria-hidden="true" />
        <a href={`${url}${domain.path === '/' ? '' : domain.path}`} target="_blank" rel="noreferrer noopener" className="truncate" style={{ fontWeight: 600, color: 'var(--ink)' }}>
          {domain.host}
          {domain.path !== '/' && <span className="faint">{domain.path}</span>}
        </a>
        {domain.isGenerated && <Badge icon={<Sparkles />}>{m.domains.generated}</Badge>}
        {domain.redirectTo !== null && (
          <span className="row faint" style={{ gap: 4, fontSize: 'var(--text-sm)' }}>
            <ArrowRight width={13} height={13} aria-hidden="true" />
            {domain.redirectTo.replace(/^https?:\/\//, '')}
          </span>
        )}
        {domain.serviceName !== null && (
          <Badge>
            {domain.serviceName}
            {domain.port === null ? '' : `:${domain.port}`}
          </Badge>
        )}
        {domain.stripPath && <Badge>{m.domains.stripped}</Badge>}
        <span className="grow" />
        <ButtonLink href={url} external size="sm" variant="ghost" icon={<ExternalLink />}>
          {m.domains.open}
        </ButtonLink>
        <Button size="sm" variant="ghost" icon={<RefreshCw />} busy={verify.isPending} onClick={() => verify.mutate()}>
          {m.domains.verify}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={<Trash2 />}
          onClick={async () => {
            const result = await confirm({ title: m.domains.removeTitle, text: t(m.domains.removeText, { host: domain.host }), confirmLabel: m.common.remove, danger: true });
            if (result.confirmed) remove.mutate();
          }}
        >
          {m.common.remove}
        </Button>
      </div>
      <div className="panel__body" style={{ display: 'grid', gap: 14 }}>
        <dl className="kv">
          <dt>DNS</dt>
          <dd className="row wrap" style={{ gap: 10 }}>
            <Status kind="dns" status={domain.dns.status} />
            {domain.dns.records.length > 0 && <span className="faint">{t(m.domains.pointsTo, { records: domain.dns.records.join(', ') })}</span>}
            {domain.dns.status === 'mismatch' && domain.dns.expected !== null && <span className="faint">{t(m.domains.expected, { ip: domain.dns.expected })}</span>}
          </dd>
          <dt>{m.domains.certificate}</dt>
          <dd className="row wrap" style={{ gap: 10 }}>
            <Status kind="tls" status={domain.tls.status} />
            {domain.tls.issuer !== null && domain.tls.status === 'active' && <span className="faint">{t(m.domains.issuedBy, { issuer: domain.tls.issuer })}</span>}
            {domain.tls.expiresAt !== null && domain.tls.status === 'active' && <span className="faint">{t(m.domains.expires, { date: formatDate(domain.tls.expiresAt, { dateStyle: 'medium' }) })}</span>}
            {domain.tls.message !== null && domain.tls.status !== 'active' && <span className="faint">{domain.tls.message}</span>}
          </dd>
          <dt>{m.domains.https}</dt>
          <dd>
            <Switch checked={domain.https} onChange={(value) => toggleHttps.mutate(value)} label={domain.https ? m.common.enabled : m.common.disabled} disabled={toggleHttps.isPending} />
          </dd>
        </dl>
        {needsDns && (
          <div className="stack" style={{ gap: 8 }}>
            <p className="field__label">{m.domains.dnsTitle}</p>
            <p className="field__hint">{m.domains.dnsInstruction}</p>
            <div className="dns-table">
              <span>{m.domains.type}</span>
              <span>{m.domains.name}</span>
              <span>{m.domains.value}</span>
              <code>A</code>
              <code>{name}</code>
              <code>{domain.dns.expected ?? '—'}</code>
            </div>
            {domain.dns.status === 'mismatch' && <p className="field__hint">{m.domains.cdnHint}</p>}
          </div>
        )}
        {domain.dns.checkedAt !== null && (
          <p className="field__hint">
            {t(m.domains.checkedAt, { time: '' })}
            <RelativeTime value={domain.dns.checkedAt} />
          </p>
        )}
      </div>
    </div>
  );
}

type DomainMode = 'route' | 'redirect';

function AddDomainDialog({ open, onClose, appId, compose, primaryOrigin, canGenerate }: { open: boolean; onClose: () => void; appId: string; compose: boolean; primaryOrigin: string | null; canGenerate: boolean }) {
  const { m } = useI18n();
  const composeFile = useCompose(appId, compose && open);
  const services = composeFile.data?.services ?? [];
  const [mode, setMode] = useState<DomainMode>('route');
  const [automatic, setAutomatic] = useState(false);
  const [host, setHost] = useState('');
  const [path, setPath] = useState('/');
  const [stripPath, setStripPath] = useState(false);
  const [service, setService] = useState('');
  const [port, setPort] = useState('');
  const [redirectTo, setRedirectTo] = useState('');
  const [https, setHttps] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const invalidate = [keys.appPart(appId, 'domains'), keys.app(appId)];
  const chosenService = service.length > 0 ? service : (services[0] ?? '');

  const reset = () => {
    setMode('route');
    setAutomatic(false);
    setHost('');
    setPath('/');
    setStripPath(false);
    setService('');
    setPort('');
    setRedirectTo('');
    setHttps(true);
    setErrors({});
  };
  const close = () => {
    reset();
    onClose();
  };
  const add = useAction((input: Record<string, unknown>) => api.post(`/api/applications/${appId}/domains`, input), { success: m.domains.added, invalidate, inlineValidation: true, onSuccess: close });
  const generate = useAction((input: Record<string, unknown>) => api.post(`/api/applications/${appId}/domains/generate`, input), { success: m.domains.added, invalidate, onSuccess: close });

  const submit = () => {
    const portValue = port.trim().length === 0 ? null : Number(port);
    if (compose && mode === 'route' && chosenService.length === 0) {
      setErrors({ serviceName: m.domains.serviceRequired });
      return;
    }
    if (automatic && mode === 'route') {
      generate.mutate({ ...(compose ? { serviceName: chosenService } : {}), ...(portValue === null ? {} : { port: portValue }) });
      return;
    }
    const payload =
      mode === 'redirect'
        ? { host, https, redirectTo: redirectTo.trim().replace(/\/+$/, '') }
        : { host, https, path: path.trim() || '/', stripPath: path.trim() !== '/' && stripPath, port: portValue, ...(compose ? { serviceName: chosenService } : {}) };
    const result = validate(m, createDomainSchema, payload);
    if (result.errors !== null) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    add.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={m.domains.add}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={close}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" busy={add.isPending || generate.isPending}>
            {m.common.add}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Segmented
          label={m.domains.mode}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'route', label: m.domains.modeRoute, icon: <Globe /> },
            { value: 'redirect', label: m.domains.modeRedirect, icon: <CornerDownRight /> },
          ]}
        />
        {mode === 'route' && canGenerate && <Checkbox checked={automatic} onChange={setAutomatic} label={m.domains.automatic} hint={m.domains.automaticHint} />}
        {!(automatic && mode === 'route') && (
          <Field label={m.domains.host} error={errors.host}>
            <Input mono value={host} onChange={(event) => setHost(event.target.value.trim())} placeholder={mode === 'redirect' ? 'www.example.uz' : m.domains.hostPlaceholder} spellCheck={false} data-autofocus inputMode="url" />
          </Field>
        )}
        {mode === 'route' ? (
          <>
            {compose && (
              <div className="form-grid">
                <Field label={m.domains.service} error={errors.serviceName} hint={services.length === 0 ? m.domains.serviceHintEmpty : undefined}>
                  {services.length > 0 ? (
                    <Select value={chosenService} onChange={(event) => setService(event.target.value)}>
                      {services.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input mono value={service} onChange={(event) => setService(event.target.value.trim())} placeholder="web" spellCheck={false} />
                  )}
                </Field>
                <Field label={m.domains.port} error={errors.port} hint={m.domains.portHintCompose}>
                  <Input mono value={port} onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, ''))} placeholder="80" inputMode="numeric" />
                </Field>
              </div>
            )}
            {!(automatic && mode === 'route') && (
              <Field label={m.domains.path} error={errors.path} hint={m.domains.pathHint}>
                <Input mono value={path} onChange={(event) => setPath(event.target.value.trim())} placeholder="/" spellCheck={false} />
              </Field>
            )}
            {!automatic && path.trim() !== '/' && path.trim().length > 0 && <Switch checked={stripPath} onChange={setStripPath} label={m.domains.stripPath} hint={m.domains.stripPathHint} />}
            {!compose && !automatic && (
              <Field label={m.domains.port} optional={m.common.optional} error={errors.port} hint={m.domains.portHint}>
                <Input mono value={port} onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, ''))} placeholder={m.domains.portAuto} inputMode="numeric" />
              </Field>
            )}
          </>
        ) : (
          <Field label={m.domains.redirectTo} error={errors.redirectTo} hint={m.domains.redirectHint}>
            <Input mono value={redirectTo} onChange={(event) => setRedirectTo(event.target.value.trim())} placeholder={primaryOrigin ?? 'https://example.uz'} spellCheck={false} inputMode="url" />
          </Field>
        )}
        {!(automatic && mode === 'route') && <Switch checked={https} onChange={setHttps} label={m.domains.https} hint={m.domains.httpsHint} />}
      </div>
    </Dialog>
  );
}

export function DomainsTab() {
  const app = useAppContext();
  const { m } = useI18n();
  const domains = useDomains(app.id);
  const [adding, setAdding] = useState(false);
  const compose = app.kind === 'compose';
  const primary = (domains.data ?? []).find((domain) => domain.redirectTo === null && domain.path === '/');
  const primaryOrigin = primary === undefined ? null : `${primary.https ? 'https' : 'http'}://${primary.host}`;

  return (
    <Card
      title={m.domains.title}
      description={compose ? m.domains.composeHint : m.domains.httpsHint}
      actions={
        <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
          {m.domains.add}
        </Button>
      }
    >
      {domains.isPending ? (
        <SkeletonRows rows={2} />
      ) : domains.data!.length === 0 ? (
        <EmptyState icon={<Globe />} action={<Button icon={<Plus />} onClick={() => setAdding(true)}>{m.domains.add}</Button>}>
          {m.domains.empty}
        </EmptyState>
      ) : (
        domains.data!.map((domain) => <DomainRow key={domain.id} domain={domain} appId={app.id} />)
      )}
      <AddDomainDialog open={adding} onClose={() => setAdding(false)} appId={app.id} compose={compose} primaryOrigin={primaryOrigin} canGenerate={!(domains.data ?? []).some((domain) => domain.isGenerated)} />
    </Card>
  );
}
