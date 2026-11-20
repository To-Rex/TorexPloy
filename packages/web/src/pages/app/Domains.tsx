import { useEffect, useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, CornerDownRight, ExternalLink, Globe, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { createDomainSchema, type DomainDto } from '@ploy/shared';
import { useConfirm, Dialog } from '../../components/Dialog.tsx';
import { Card } from '../../components/Frame.tsx';
import { dnsTone, Status, tlsTone } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Badge, Button, Checkbox, EmptyState, Field, Input, Segmented, Select, SkeletonRows, Switch, type Tone } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useCompose, useDomains } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { useAppContext } from './AppLayout.tsx';

const WORST: Record<Tone, number> = { bad: 3, work: 2, idle: 1, info: 1, ok: 0 };

/**
 * One domain as one line: where it points, whether DNS and the certificate
 * are in order, the HTTPS switch and what can be done with it. The details
 * (records, issuer, expiry, how to set DNS up) are behind the arrow, and
 * open by themselves when something needs doing. `invalidate` names what to
 * refresh after a change.
 */
export function DomainRow({ domain, invalidate }: { domain: DomainDto; invalidate: QueryKey[] }) {
  const { m, t, formatDate } = useI18n();
  const d = m.domains;
  const confirm = useConfirm();
  const verify = useAction(() => api.post(`/api/domains/${domain.id}/verify`), { invalidate });
  const toggleHttps = useAction((https: boolean) => api.patch(`/api/domains/${domain.id}`, { https }), { invalidate });
  const remove = useAction(() => api.delete(`/api/domains/${domain.id}`), { success: d.removed, invalidate });
  const url = `${domain.https ? 'https' : 'http'}://${domain.host}`;
  const needsDns = !domain.isGenerated && domain.dns.status !== 'ok';
  const labels = domain.host.split('.');
  const name = labels.length > 2 ? labels.slice(0, -2).join('.') : '@';
  const tones: Tone[] = [dnsTone[domain.dns.status], ...(domain.https ? [tlsTone[domain.tls.status]] : [])];
  const tone = tones.reduce<Tone>((worst, next) => (WORST[next] > WORST[worst] ? next : worst), 'ok');
  const attention = needsDns || (domain.https && domain.tls.status === 'error');
  const [open, setOpen] = useState(attention);
  // Something went wrong since the page opened (a re-check, a change of DNS): show it without being asked.
  useEffect(() => {
    if (attention) setOpen(true);
  }, [attention]);
  const detailsId = `domain-${domain.id}`;

  return (
    <div className="domain" data-state={tone} data-open={open || undefined}>
      <div className="domain__row">
        <span className="domain__mark" aria-hidden="true">
          {domain.redirectTo !== null ? <CornerDownRight /> : <Globe />}
        </span>
        <div className="domain__main">
          <a className="domain__host" href={`${url}${domain.path === '/' ? '' : domain.path}`} target="_blank" rel="noreferrer noopener" title={d.open}>
            <span className="truncate">
              {domain.host}
              {domain.path !== '/' && <span className="faint">{domain.path}</span>}
            </span>
            <ExternalLink aria-hidden="true" />
          </a>
          {(domain.isGenerated || domain.redirectTo !== null || domain.serviceName !== null || domain.stripPath) && (
            <span className="domain__tags">
              {domain.isGenerated && <Badge icon={<Sparkles />}>{d.generated}</Badge>}
              {domain.redirectTo !== null && (
                <span className="domain__redirect">
                  <ArrowRight aria-hidden="true" />
                  {domain.redirectTo.replace(/^https?:\/\//, '')}
                </span>
              )}
              {domain.serviceName !== null && (
                <Badge>
                  {domain.serviceName}
                  {domain.port === null ? '' : `:${domain.port}`}
                </Badge>
              )}
              {domain.stripPath && <Badge>{d.stripped}</Badge>}
            </span>
          )}
        </div>
        <div className="domain__checks">
          <span className="domain__check">
            <span className="domain__check-label">DNS</span>
            <Status kind="dns" status={domain.dns.status} />
          </span>
          <span className="domain__check">
            <span className="domain__check-label">SSL</span>
            <Status kind="tls" status={domain.https ? domain.tls.status : 'disabled'} />
          </span>
        </div>
        <span className="domain__https">
          <Switch checked={domain.https} onChange={(value) => toggleHttps.mutate(value)} label={d.https} disabled={toggleHttps.isPending} />
        </span>
        <div className="domain__actions">
          <Button size="sm" variant="ghost" iconOnly icon={<RefreshCw />} busy={verify.isPending} title={d.verify} onClick={() => verify.mutate()}>
            {d.verify}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Trash2 />}
            title={m.common.remove}
            onClick={async () => {
              const result = await confirm({ title: d.removeTitle, text: t(d.removeText, { host: domain.host }), confirmLabel: m.common.remove, danger: true });
              if (result.confirmed) remove.mutate();
            }}
          >
            {m.common.remove}
          </Button>
          <Button size="sm" variant="ghost" iconOnly className="domain__toggle" icon={<ChevronDown />} aria-expanded={open} aria-controls={detailsId} title={open ? d.hideDetails : d.showDetails} onClick={() => setOpen((current) => !current)}>
            {open ? d.hideDetails : d.showDetails}
          </Button>
        </div>
      </div>
      <div className="domain__wrap" id={detailsId} inert={!open}>
        <div className="domain__clip">
          <div className="domain__detail">
            <dl className="kv">
              <dt>DNS</dt>
              <dd className="row wrap" style={{ gap: 10 }}>
                <Status kind="dns" status={domain.dns.status} />
                {domain.dns.records.length > 0 && <span className="faint">{t(d.pointsTo, { records: domain.dns.records.join(', ') })}</span>}
                {domain.dns.status === 'mismatch' && domain.dns.expected !== null && <span className="faint">{t(d.expected, { ip: domain.dns.expected })}</span>}
              </dd>
              <dt>{d.certificate}</dt>
              <dd className="row wrap" style={{ gap: 10 }}>
                <Status kind="tls" status={domain.tls.status} />
                {domain.tls.issuer !== null && domain.tls.status === 'active' && <span className="faint">{t(d.issuedBy, { issuer: domain.tls.issuer })}</span>}
                {domain.tls.expiresAt !== null && domain.tls.status === 'active' && <span className="faint">{t(d.expires, { date: formatDate(domain.tls.expiresAt, { dateStyle: 'medium' }) })}</span>}
                {domain.tls.message !== null && domain.tls.status !== 'active' && <span className="faint">{domain.tls.message}</span>}
              </dd>
              {domain.dns.checkedAt !== null && (
                <>
                  <dt>{d.checked}</dt>
                  <dd className="faint">
                    <RelativeTime value={domain.dns.checkedAt} />
                  </dd>
                </>
              )}
            </dl>
            {needsDns && (
              <div className="stack" style={{ gap: 8 }}>
                <p className="field__label">{d.dnsTitle}</p>
                <p className="field__hint">{d.dnsInstruction}</p>
                <div className="dns-table">
                  <span>{d.type}</span>
                  <span>{d.name}</span>
                  <span>{d.value}</span>
                  <code>A</code>
                  <code>{name}</code>
                  <code>{domain.dns.expected ?? '—'}</code>
                </div>
                {domain.dns.status === 'mismatch' && <p className="field__hint">{d.cdnHint}</p>}
              </div>
            )}
          </div>
        </div>
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
  const { m, plural } = useI18n();
  const client = useQueryClient();
  const toast = useToast();
  const domains = useDomains(app.id);
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);
  const compose = app.kind === 'compose';
  const list = domains.data ?? [];
  const primary = list.find((domain) => domain.redirectTo === null && domain.path === '/');
  const primaryOrigin = primary === undefined ? null : `${primary.https ? 'https' : 'http'}://${primary.host}`;
  const invalidate = [keys.appPart(app.id, 'domains'), keys.app(app.id)];
  const checkAll = async () => {
    setChecking(true);
    try {
      await Promise.all(list.map((domain) => api.post(`/api/domains/${domain.id}/verify`)));
    } catch (error) {
      toast.error(error);
    } finally {
      for (const key of invalidate) void client.invalidateQueries({ queryKey: key });
      setChecking(false);
    }
  };

  return (
    <Card
      title={
        <>
          {m.domains.title}
          {list.length > 0 && <span className="card__count tabular">{list.length}</span>}
        </>
      }
      description={compose ? m.domains.composeHint : m.domains.httpsHint}
      actions={
        <>
          {list.length > 1 && (
            <Button icon={<RefreshCw />} busy={checking} onClick={() => void checkAll()} title={plural(m.domains.checkAllHint, list.length)}>
              {m.domains.checkAll}
            </Button>
          )}
          <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
            {m.domains.add}
          </Button>
        </>
      }
    >
      {domains.isPending ? (
        <SkeletonRows rows={2} />
      ) : list.length === 0 ? (
        <EmptyState icon={<Globe />} action={<Button icon={<Plus />} onClick={() => setAdding(true)}>{m.domains.add}</Button>}>
          {m.domains.empty}
        </EmptyState>
      ) : (
        <div className="domain-list">
          {list.map((domain) => (
            <DomainRow key={domain.id} domain={domain} invalidate={invalidate} />
          ))}
        </div>
      )}
      <AddDomainDialog open={adding} onClose={() => setAdding(false)} appId={app.id} compose={compose} primaryOrigin={primaryOrigin} canGenerate={!list.some((domain) => domain.isGenerated)} />
    </Card>
  );
}
