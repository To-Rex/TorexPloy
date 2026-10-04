/**
 * S3 destinations: where database backups are copied off the server.
 */
import { useState } from 'react';
import { CloudUpload, Ellipsis, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { createS3DestinationSchema, updateS3DestinationSchema, type S3DestinationDto } from '@ploy/shared';
import { Dialog, useConfirm } from '../../components/Dialog.tsx';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Button, EmptyState, Field, Input, Skeleton, Switch } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useS3Destinations } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { FrameActions } from '../../components/Frame.tsx';

type Provider = 'aws' | 'r2' | 'b2' | 'custom';

interface Draft {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  pathPrefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** Starting points for the common providers; every field stays editable. */
const PRESETS: Record<Provider, Partial<Draft>> = {
  aws: { endpoint: 'https://s3.eu-central-1.amazonaws.com', region: 'eu-central-1', forcePathStyle: false },
  r2: { endpoint: 'https://<account-id>.r2.cloudflarestorage.com', region: 'auto', forcePathStyle: true },
  b2: { endpoint: 'https://s3.eu-central-003.backblazeb2.com', region: 'eu-central-003', forcePathStyle: false },
  custom: { endpoint: 'https://s3.example.uz', region: 'us-east-1', forcePathStyle: true },
};

const empty: Draft = { name: '', endpoint: PRESETS.aws.endpoint!, region: PRESETS.aws.region!, bucket: '', pathPrefix: 'torexploy', accessKeyId: '', secretAccessKey: '', forcePathStyle: false };

function DestinationDialog({ open, editing, onClose }: { open: boolean; editing: S3DestinationDto | null; onClose: () => void }) {
  const { m } = useI18n();
  const s = m.s3;
  const [provider, setProvider] = useState<Provider>('aws');
  const [draft, setDraft] = useState<Draft>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const key = open ? (editing?.id ?? 'new') : null;
  if (key !== loadedFor) {
    setLoadedFor(key);
    setErrors({});
    setProvider(editing === null ? 'aws' : 'custom');
    setDraft(editing === null ? empty : { ...editing, secretAccessKey: '' });
  }
  const set = <K extends keyof Draft>(field: K, value: Draft[K]) => setDraft((current) => ({ ...current, [field]: value }));

  const save = useAction(
    (payload: Record<string, unknown>) => (editing === null ? api.post('/api/s3-destinations', payload) : api.patch(`/api/s3-destinations/${editing.id}`, payload)),
    { success: s.saved, invalidate: [keys.s3], inlineValidation: true, onSuccess: onClose },
  );

  const submit = () => {
    const payload: Record<string, unknown> = { ...draft, endpoint: draft.endpoint.trim(), bucket: draft.bucket.trim(), name: draft.name.trim() };
    if (editing !== null && draft.secretAccessKey.length === 0) delete payload.secretAccessKey;
    const result = validate(m, editing === null ? createS3DestinationSchema : updateS3DestinationSchema, payload);
    if (result.errors !== null) return setErrors(result.errors);
    setErrors({});
    save.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={editing === null ? s.addTitle : s.editTitle}
      description={s.dialogHint}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" icon={<ShieldCheck />} busy={save.isPending}>
            {s.checkAndSave}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 16 }}>
        {editing === null && (
          <div className="field">
            <span className="field__label">{s.provider}</span>
            <div className="choices" role="radiogroup" aria-label={s.provider}>
              {(['aws', 'r2', 'b2', 'custom'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  className="choice"
                  aria-checked={provider === value}
                  onClick={() => {
                    setProvider(value);
                    setDraft((current) => ({ ...current, ...PRESETS[value] }));
                  }}
                >
                  <span className="choice__title">{s.providers[value]}</span>
                  <span className="choice__hint">{s.providerHints[value]}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="form-grid">
          <Field label={s.name} error={errors.name}>
            <Input value={draft.name} onChange={(event) => set('name', event.target.value)} placeholder={s.namePlaceholder} data-autofocus />
          </Field>
          <Field label={s.bucket} error={errors.bucket}>
            <Input mono value={draft.bucket} onChange={(event) => set('bucket', event.target.value.trim().toLowerCase())} placeholder="company-backups" spellCheck={false} />
          </Field>
        </div>
        <div className="form-grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
          <Field label={s.endpoint} hint={s.endpointHint} error={errors.endpoint}>
            <Input mono value={draft.endpoint} onChange={(event) => set('endpoint', event.target.value)} spellCheck={false} inputMode="url" />
          </Field>
          <Field label={s.region} error={errors.region}>
            <Input mono value={draft.region} onChange={(event) => set('region', event.target.value.trim())} spellCheck={false} />
          </Field>
        </div>
        <div className="form-grid">
          <Field label={s.accessKeyId} error={errors.accessKeyId}>
            <Input mono value={draft.accessKeyId} onChange={(event) => set('accessKeyId', event.target.value.trim())} spellCheck={false} autoComplete="off" />
          </Field>
          <Field label={s.secretAccessKey} error={errors.secretAccessKey} hint={editing === null ? undefined : m.notifications.keepCredentials}>
            <Input mono type="password" value={draft.secretAccessKey} onChange={(event) => set('secretAccessKey', event.target.value)} spellCheck={false} autoComplete="new-password" />
          </Field>
        </div>
        <Field label={s.pathPrefix} optional={m.common.optional} hint={s.pathPrefixHint} error={errors.pathPrefix}>
          <Input mono value={draft.pathPrefix} onChange={(event) => set('pathPrefix', event.target.value.trim())} spellCheck={false} />
        </Field>
        <Switch checked={draft.forcePathStyle} onChange={(value) => set('forcePathStyle', value)} label={s.pathStyle} hint={s.pathStyleHint} />
      </div>
    </Dialog>
  );
}

export function StoragePage() {
  const { m, plural } = useI18n();
  const s = m.s3;
  const confirm = useConfirm();
  const toast = useToast();
  const destinations = useS3Destinations();
  const [dialog, setDialog] = useState<{ open: boolean; editing: S3DestinationDto | null }>({ open: false, editing: null });
  const test = useAction((id: string) => api.post<{ ok: boolean; error: string | null }>(`/api/s3-destinations/${id}/test`), {
    onSuccess: (result) => (result.ok ? toast.success(s.testOk) : toast.failure(s.testFailed, result.error ?? undefined)),
  });
  const remove = useAction((id: string) => api.delete(`/api/s3-destinations/${id}`), { success: s.deleted, invalidate: [keys.s3] });

  return (
    <>
      <FrameActions>
        <Button variant="primary" icon={<Plus />} onClick={() => setDialog({ open: true, editing: null })}>
          {s.add}
        </Button>
      </FrameActions>
      {destinations.data === undefined ? (
        <Skeleton height={100} />
      ) : destinations.data.length === 0 ? (
        <EmptyState icon={<CloudUpload />} title={s.emptyTitle}>
          {s.emptyText}
        </EmptyState>
      ) : (
        <div className="list">
          {destinations.data.map((destination) => (
            <div key={destination.id} className="list__row">
              <span className="channel-icon" aria-hidden="true">
                <CloudUpload />
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="list__title truncate">{destination.name}</div>
                <div className="list__meta">
                  <code className="truncate">
                    {destination.bucket}
                    {destination.pathPrefix.length > 0 ? `/${destination.pathPrefix}` : ''}
                  </code>
                  <span className="truncate">{destination.endpoint.replace(/^https?:\/\//, '')}</span>
                  <span>{destination.services.length === 0 ? s.unused : plural(s.usedBy, destination.services.length)}</span>
                </div>
              </div>
              <Button size="sm" icon={<ShieldCheck />} busy={test.isPending && test.variables === destination.id} onClick={() => test.mutate(destination.id)}>
                {s.test}
              </Button>
              <Menu trigger={(props) => <Button {...props} variant="ghost" size="sm" iconOnly icon={<Ellipsis />}>{m.common.actions}</Button>}>
                <MenuItem icon={<Pencil />} onSelect={() => setDialog({ open: true, editing: destination })}>
                  {m.common.edit}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  icon={<Trash2 />}
                  danger
                  onSelect={async () => {
                    const result = await confirm({ title: s.deleteTitle, text: s.deleteText, confirmLabel: m.common.delete, danger: true });
                    if (result.confirmed) remove.mutate(destination.id);
                  }}
                >
                  {m.common.delete}
                </MenuItem>
              </Menu>
            </div>
          ))}
        </div>
      )}
      <DestinationDialog open={dialog.open} editing={dialog.editing} onClose={() => setDialog({ open: false, editing: null })} />
    </>
  );
}
