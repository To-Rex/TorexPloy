/** Persistent volumes, as a card on the Advanced tab. */
import { useState } from 'react';
import { HardDrive, Plus, Trash2 } from 'lucide-react';
import { createVolumeSchema, type ApplicationDto } from '@ploy/shared';
import { useConfirm, Dialog } from '../../components/Dialog.tsx';
import { Card } from '../../components/Frame.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Button, Callout, Field, Input, SkeletonRows } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useVolumes } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';

export function VolumesCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const confirm = useConfirm();
  const volumes = useVolumes(app.id);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('data');
  const [mountPath, setMountPath] = useState('/app/data');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const invalidate = [keys.appPart(app.id, 'volumes'), keys.app(app.id)];
  const add = useAction((input: { name: string; mountPath: string }) => api.post(`/api/applications/${app.id}/volumes`, input), {
    success: m.storage.added,
    invalidate,
    inlineValidation: true,
    onSuccess: () => setAdding(false),
  });
  const remove = useAction((input: { id: string; removeData: boolean }) => api.delete(`/api/applications/${app.id}/volumes/${input.id}?removeData=${input.removeData}`), { success: m.storage.removed, invalidate });

  return (
    <Card
      title={m.storage.title}
      description={m.storage.hint}
      actions={
        <Button icon={<Plus />} onClick={() => setAdding(true)}>
          {m.storage.add}
        </Button>
      }
    >
      {app.replicas > 1 && (volumes.data ?? []).length > 0 && <Callout tone="work">{m.storage.replicaWarning}</Callout>}
      {volumes.isPending ? (
        <SkeletonRows rows={2} />
      ) : volumes.data!.length === 0 ? (
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{m.storage.empty}</p>
      ) : (
        <div className="list">
          {volumes.data!.map((volume) => (
            <div key={volume.id} className="list__row">
              <HardDrive width={18} height={18} className="faint" aria-hidden="true" />
              <div className="grow">
                <div className="list__title">{volume.name}</div>
                <div className="list__meta">
                  <code>{volume.mountPath}</code>
                  <RelativeTime value={volume.createdAt} />
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon={<Trash2 />}
                onClick={async () => {
                  const result = await confirm({ title: m.storage.removeTitle, text: m.storage.removeText, confirmLabel: m.common.remove, danger: true, checkbox: { label: m.storage.removeData } });
                  if (result.confirmed) remove.mutate({ id: volume.id, removeData: result.checked });
                }}
              >
                {m.common.remove}
              </Button>
            </div>
          ))}
        </div>
      )}
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title={m.storage.add}
        onSubmit={() => {
          const result = validate(m, createVolumeSchema, { name, mountPath });
          if (result.errors !== null) {
            setErrors(result.errors);
            return;
          }
          setErrors({});
          add.mutate(result.data, { onError: (error) => setErrors(fieldErrors(m, error)) });
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
        <div className="form-grid">
          <Field label={m.storage.name} error={errors.name}>
            <Input mono value={name} onChange={(event) => setName(event.target.value)} spellCheck={false} />
          </Field>
          <Field label={m.storage.mountPath} hint={m.storage.mountPathHint} error={errors.mountPath}>
            <Input mono value={mountPath} onChange={(event) => setMountPath(event.target.value)} spellCheck={false} />
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}
