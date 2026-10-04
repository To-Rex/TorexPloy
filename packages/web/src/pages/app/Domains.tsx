import { useState } from 'react';
import { ExternalLink, Globe, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { createDomainSchema, type DomainDto } from '@ploy/shared';
import { useConfirm, Dialog } from '../../components/Dialog.tsx';
import { Status } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Badge, Button, ButtonLink, EmptyState, Field, Input, SkeletonRows, Switch } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useDomains } from '../../lib/queries.ts';
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
        <a href={url} target="_blank" rel="noreferrer noopener" className="truncate" style={{ fontWeight: 600, color: 'var(--ink)' }}>
          {domain.host}
        </a>
        {domain.isGenerated && <Badge icon={<Sparkles />}>{m.domains.generated}</Badge>}
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

export function DomainsTab() {
  const app = useAppContext();
  const { m } = useI18n();
  const domains = useDomains(app.id);
  const [adding, setAdding] = useState(false);
  const [host, setHost] = useState('');
  const [https, setHttps] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const invalidate = [keys.appPart(app.id, 'domains'), keys.app(app.id)];
  const add = useAction((input: { host: string; https: boolean }) => api.post('/api/applications/' + app.id + '/domains', input), {
    success: m.domains.added,
    invalidate,
    inlineValidation: true,
    onSuccess: () => {
      setAdding(false);
      setHost('');
    },
  });
  const generate = useAction(() => api.post(`/api/applications/${app.id}/domains/generate`), { invalidate });

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <p className="muted">{m.domains.httpsHint}</p>
        <div className="row">
          {!(domains.data ?? []).some((domain) => domain.isGenerated) && (
            <Button icon={<Sparkles />} busy={generate.isPending} onClick={() => generate.mutate()}>
              {m.domains.generate}
            </Button>
          )}
          <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
            {m.domains.add}
          </Button>
        </div>
      </div>
      {domains.isPending ? (
        <SkeletonRows rows={2} />
      ) : domains.data!.length === 0 ? (
        <EmptyState icon={<Globe />}>{m.domains.empty}</EmptyState>
      ) : (
        domains.data!.map((domain) => <DomainRow key={domain.id} domain={domain} appId={app.id} />)
      )}
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title={m.domains.add}
        onSubmit={() => {
          const result = validate(m, createDomainSchema, { host, https });
          if (result.errors !== null) {
            setErrors(result.errors);
            return;
          }
          setErrors({});
          add.mutate({ host: result.data.host, https: result.data.https }, { onError: (error) => setErrors(fieldErrors(m, error)) });
        }}
        footer={
          <>
            <Button onClick={() => setAdding(false)}>{m.common.cancel}</Button>
            <Button type="submit" variant="primary" busy={add.isPending}>
              {m.common.add}
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label={m.domains.host} error={errors.host}>
            <Input mono value={host} onChange={(event) => setHost(event.target.value.trim())} placeholder={m.domains.hostPlaceholder} spellCheck={false} autoFocus inputMode="url" />
          </Field>
          <Switch checked={https} onChange={setHttps} label={m.domains.https} hint={m.domains.httpsHint} />
        </div>
      </Dialog>
    </div>
  );
}
