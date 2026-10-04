/**
 * Domains of a file store: the HTTPS address S3 clients use from outside.
 * Each one carries the same DNS and certificate checks as an application's.
 */
import { useState } from 'react';
import { Globe, Plus } from 'lucide-react';
import { createDomainSchema, type ServiceDto } from '@ploy/shared';
import { Dialog } from '../../../components/Dialog.tsx';
import { Card } from '../../../components/Frame.tsx';
import { Button, Checkbox, Field, Input, SkeletonRows, Switch } from '../../../components/ui.tsx';
import { useI18n } from '../../../i18n/index.tsx';
import { api } from '../../../lib/api.ts';
import { fieldErrors } from '../../../lib/errors.ts';
import { useAction } from '../../../lib/mutate.ts';
import { keys, useServiceDomains } from '../../../lib/queries.ts';
import { validate } from '../../../lib/validate.ts';
import { DomainRow } from '../../app/Domains.tsx';

export function StorageDomainsTab({ service }: { service: ServiceDto }) {
  const { m } = useI18n();
  const f = m.fileStore;
  const domains = useServiceDomains(service.id);
  const [adding, setAdding] = useState(false);
  const [automatic, setAutomatic] = useState(true);
  const [host, setHost] = useState('');
  const [https, setHttps] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const invalidate = [keys.servicePart(service.id, 'domains'), keys.servicePart(service.id, 'storage'), keys.service(service.id)];
  const close = () => {
    setAdding(false);
    setHost('');
    setErrors({});
  };
  const add = useAction((input: Record<string, unknown>) => api.post(`/api/services/${service.id}/domains`, input), { success: m.domains.added, invalidate, inlineValidation: true, onSuccess: close });
  const canGenerate = !(domains.data ?? []).some((domain) => domain.isGenerated);
  const items = domains.data ?? [];

  return (
    <Card
      title={f.domainsTitle}
      description={f.domainsHint}
      actions={
        <Button variant="primary" icon={<Plus />} onClick={() => { setAutomatic(canGenerate); setAdding(true); }}>
          {f.addDomain}
        </Button>
      }
    >
      {domains.isPending ? (
        <SkeletonRows rows={1} />
      ) : items.length === 0 ? (
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{f.endpointNone}</p>
      ) : (
        items.map((domain) => <DomainRow key={domain.id} domain={domain} invalidate={invalidate} />)
      )}
      <Dialog
        open={adding}
        onClose={close}
        title={f.addDomain}
        onSubmit={() => {
          if (automatic && canGenerate) return add.mutate({ generate: true });
          const payload = { host: host.trim(), https };
          const result = validate(m, createDomainSchema, payload);
          if (result.errors !== null) return setErrors(result.errors);
          setErrors({});
          add.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
        }}
        footer={
          <>
            <Button onClick={close}>{m.common.cancel}</Button>
            <Button type="submit" variant="primary" busy={add.isPending}>
              {m.common.add}
            </Button>
          </>
        }
      >
        <div className="stack">
          {canGenerate && <Checkbox checked={automatic} onChange={setAutomatic} label={m.domains.automatic} hint={m.domains.automaticHint} />}
          {!(automatic && canGenerate) && (
            <>
              <Field label={m.domains.host} hint={f.domainHostHint} error={errors.host}>
                <Input mono value={host} onChange={(event) => setHost(event.target.value.trim())} placeholder="files.example.uz" spellCheck={false} data-autofocus inputMode="url" />
              </Field>
              <Switch checked={https} onChange={setHttps} label={m.domains.https} hint={m.domains.httpsHint} />
            </>
          )}
          <p className="field__hint row" style={{ gap: 6 }}>
            <Globe width={14} height={14} aria-hidden="true" />
            {f.domainsHint}
          </p>
        </div>
      </Dialog>
    </Card>
  );
}
