/**
 * Access keys of a file store: one per application or partner, scoped to
 * the buckets and rights it needs. The secret is shown once, at creation.
 */
import { useState } from 'react';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { createStorageKeySchema, type ServiceDto, type StorageKeyCreatedDto, type StoragePermission } from '@ploy/shared';
import { ValueField } from '../../../components/Copy.tsx';
import { Dialog, useConfirm } from '../../../components/Dialog.tsx';
import { Card } from '../../../components/Frame.tsx';
import { Badge, Button, Callout, Checkbox, Field, Input, Select, SkeletonRows } from '../../../components/ui.tsx';
import { useI18n } from '../../../i18n/index.tsx';
import { api } from '../../../lib/api.ts';
import { fieldErrors } from '../../../lib/errors.ts';
import { useAction } from '../../../lib/mutate.ts';
import { keys, useBuckets, useStorageKeys } from '../../../lib/queries.ts';
import { validate } from '../../../lib/validate.ts';
import { RelativeTime } from '../../../components/Time.tsx';

function NewKeyDialog({ service, open, onClose }: { service: ServiceDto; open: boolean; onClose: () => void }) {
  const { m } = useI18n();
  const f = m.fileStore;
  const buckets = useBuckets(service.id);
  const [name, setName] = useState('');
  const [permission, setPermission] = useState<StoragePermission>('readwrite');
  const [scopeAll, setScopeAll] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<StorageKeyCreatedDto | null>(null);
  const reset = () => {
    setName('');
    setPermission('readwrite');
    setScopeAll(true);
    setChosen([]);
    setErrors({});
    setCreated(null);
  };
  const close = () => {
    reset();
    onClose();
  };
  const create = useAction((input: { name: string; buckets: string[] | null; permission: StoragePermission }) => api.post<StorageKeyCreatedDto>(`/api/services/${service.id}/storage/keys`, input), {
    invalidate: [keys.servicePart(service.id, 'storage', 'keys'), keys.servicePart(service.id, 'storage')],
    inlineValidation: true,
    onSuccess: setCreated,
  });
  return (
    <Dialog
      open={open}
      onClose={close}
      title={created === null ? f.newKey : f.keyCreatedTitle}
      description={created === null ? f.keysHint : f.keyCreatedHint}
      onSubmit={() => {
        if (created !== null) return close();
        const payload = { name: name.trim(), buckets: scopeAll ? null : chosen, permission };
        const result = validate(m, createStorageKeySchema, payload);
        if (result.errors !== null) return setErrors(result.errors);
        setErrors({});
        create.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
      }}
      footer={
        created === null ? (
          <>
            <Button onClick={close}>{m.common.cancel}</Button>
            <Button type="submit" variant="primary" busy={create.isPending}>
              {m.common.create}
            </Button>
          </>
        ) : (
          <Button type="submit" variant="primary">
            {m.common.close}
          </Button>
        )
      }
    >
      {created === null ? (
        <div className="stack" style={{ gap: 14 }}>
          <div className="form-grid">
            <Field label={f.keyName} error={errors.name}>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={f.keyNamePlaceholder} data-autofocus />
            </Field>
            <Field label={f.permission}>
              <Select value={permission} onChange={(event) => setPermission(event.target.value as StoragePermission)}>
                <option value="readwrite">{f.permissions.readwrite}</option>
                <option value="read">{f.permissions.read}</option>
              </Select>
            </Field>
          </div>
          <div className="field">
            <span className="field__label">{f.scope}</span>
            <Checkbox checked={scopeAll} onChange={setScopeAll} label={f.scopeAll} />
            {!scopeAll && (
              <div className="stack" style={{ gap: 6, paddingLeft: 24 }}>
                {(buckets.data ?? []).map((bucket) => (
                  <Checkbox
                    key={bucket.name}
                    checked={chosen.includes(bucket.name)}
                    onChange={(value) => setChosen((current) => (value ? [...current, bucket.name] : current.filter((name) => name !== bucket.name)))}
                    label={bucket.name}
                  />
                ))}
                {(buckets.data ?? []).length === 0 && <p className="field__hint">{f.noBuckets}</p>}
                {errors.buckets !== undefined && <p className="field__error">{errors.buckets}</p>}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <Field label={f.accessKeyId}>
            <ValueField value={created.accessKeyId} />
          </Field>
          <Field label={f.secretAccessKey}>
            <ValueField value={created.secretAccessKey} secret />
          </Field>
          <Callout tone="work">{f.keyCreatedHint}</Callout>
        </div>
      )}
    </Dialog>
  );
}

export function StorageKeysTab({ service }: { service: ServiceDto }) {
  const { m, t } = useI18n();
  const f = m.fileStore;
  const confirm = useConfirm();
  const list = useStorageKeys(service.id);
  const [creating, setCreating] = useState(false);
  const revoke = useAction((id: string) => api.delete(`/api/services/${service.id}/storage/keys/${id}`), {
    success: f.revoked,
    invalidate: [keys.servicePart(service.id, 'storage', 'keys'), keys.servicePart(service.id, 'storage')],
  });
  const items = list.data ?? [];
  return (
    <Card
      title={f.keysTitle}
      description={f.keysHint}
      flush={items.length > 0}
      actions={
        <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
          {f.newKey}
        </Button>
      }
    >
      {list.isPending ? (
        <SkeletonRows rows={2} />
      ) : list.isError ? (
        <Callout tone="bad">{m.errors.codes.storage_unavailable}</Callout>
      ) : items.length === 0 ? (
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{f.noKeys}</p>
      ) : (
        <div className="list">
          {items.map((key) => (
            <div key={key.id} className="list__row">
              <KeyRound width={18} height={18} className="faint" aria-hidden="true" />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className="list__title">{key.name}</span>
                  <Badge tone={key.permission === 'read' ? 'idle' : 'ok'}>{f.permissions[key.permission]}</Badge>
                  {key.managedBy === 'backups' && <Badge tone="info">{f.managedBackups}</Badge>}
                </div>
                <div className="list__meta">
                  <code>{key.accessKeyId}</code>
                  <span className="truncate">{key.buckets === null ? f.scopeAll : key.buckets.join(', ')}</span>
                  <span>
                    {f.lastUsed}: {key.lastUsedAt === null ? f.never : <RelativeTime value={key.lastUsedAt} />}
                  </span>
                </div>
              </div>
              {key.managedBy === 'user' && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 />}
                  busy={revoke.isPending && revoke.variables === key.id}
                  onClick={async () => {
                    const result = await confirm({ title: f.revokeTitle, text: t(f.revokeText, { name: key.name }), confirmLabel: f.revoke, danger: true });
                    if (result.confirmed) revoke.mutate(key.id);
                  }}
                >
                  {f.revoke}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      <NewKeyDialog service={service} open={creating} onClose={() => setCreating(false)} />
    </Card>
  );
}
