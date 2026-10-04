import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Trash2 } from 'lucide-react';
import { updateServiceSchema, type UpdateServiceInput } from '@ploy/shared';
import { useConfirm } from '../../components/Dialog.tsx';
import { Button, Field, Input } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { useServiceContext } from './ServiceLayout.tsx';

export function ServiceSettingsTab() {
  const service = useServiceContext();
  const { m } = useI18n();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const initial = {
    name: service.name,
    publicPort: service.publicPort === null ? '' : String(service.publicPort),
    cpuLimit: service.cpuLimit === null ? '' : String(service.cpuLimit),
    memoryLimitMb: service.memoryLimitMb === null ? '' : String(service.memoryLimitMb),
  };
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const signature = JSON.stringify(initial);
  useEffect(() => setForm(initial), [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useAction((input: UpdateServiceInput) => api.patch(`/api/services/${service.id}`, input), {
    success: m.services.saved,
    invalidate: [keys.service(service.id), keys.project(service.projectId)],
    inlineValidation: true,
  });
  const remove = useAction((removeData: boolean) => api.delete(`/api/services/${service.id}?removeData=${removeData}`), {
    success: m.services.deleted,
    invalidate: [keys.project(service.projectId), keys.projects],
    onSuccess: () => void navigate(`/projects/${service.projectId}`),
  });

  const num = (value: string) => (value.trim().length === 0 ? null : Number(value));
  const patch: UpdateServiceInput = {};
  if (form.name !== initial.name) patch.name = form.name.trim();
  if (form.publicPort !== initial.publicPort) patch.publicPort = num(form.publicPort);
  if (form.cpuLimit !== initial.cpuLimit) patch.cpuLimit = num(form.cpuLimit);
  if (form.memoryLimitMb !== initial.memoryLimitMb) patch.memoryLimitMb = num(form.memoryLimitMb);
  const dirty = Object.keys(patch).length > 0;

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const result = validate(m, updateServiceSchema, patch);
        if (result.errors !== null) {
          setErrors(result.errors);
          return;
        }
        setErrors({});
        save.mutate(patch, { onError: (error) => setErrors(fieldErrors(m, error)) });
      }}
    >
      <div className="section">
        <div className="section__intro">
          <h2>{m.appSettings.general}</h2>
        </div>
        <Field label={m.services.name} error={errors.name}>
          <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
      </div>
      <div className="section">
        <div className="section__intro">
          <h2>{m.services.publicPort}</h2>
          <p>{m.services.publicPortHint}</p>
        </div>
        <Field label={m.services.publicPort} error={errors.publicPort}>
          <Input value={form.publicPort} onChange={(event) => setForm({ ...form, publicPort: event.target.value.replace(/\D/g, '') })} inputMode="numeric" placeholder="—" />
        </Field>
      </div>
      <div className="section">
        <div className="section__intro">
          <h2>{m.services.resources}</h2>
          <p>{m.services.resourcesHint}</p>
        </div>
        <div className="form-grid">
          <Field label={m.appSettings.cpu} hint={m.appSettings.cpuHint} error={errors.cpuLimit}>
            <Input value={form.cpuLimit} onChange={(event) => setForm({ ...form, cpuLimit: event.target.value.replace(/[^\d.]/g, '') })} inputMode="decimal" placeholder="—" />
          </Field>
          <Field label={m.appSettings.memory} error={errors.memoryLimitMb}>
            <Input value={form.memoryLimitMb} onChange={(event) => setForm({ ...form, memoryLimitMb: event.target.value.replace(/\D/g, '') })} inputMode="numeric" placeholder="—" />
          </Field>
        </div>
      </div>
      <div className="section">
        <div className="section__intro">
          <h2>{m.appSettings.danger}</h2>
          <p>{m.appSettings.dangerHint}</p>
        </div>
        <div className="panel panel--danger">
          <div className="panel__body row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <p className="muted" style={{ maxWidth: '60ch' }}>{m.services.deleteText}</p>
            <Button
              variant="danger"
              icon={<Trash2 />}
              onClick={async () => {
                const result = await confirm({ title: m.services.delete, text: m.services.deleteText, confirmLabel: m.common.delete, danger: true, typeToConfirm: service.name, checkbox: { label: m.services.deleteData } });
                if (result.confirmed) remove.mutate(result.checked);
              }}
            >
              {m.services.delete}
            </Button>
          </div>
        </div>
      </div>
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
