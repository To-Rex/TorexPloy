import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Database } from 'lucide-react';
import { createServiceSchema, type ServiceDto, type ServiceType } from '@ploy/shared';
import { Dialog } from '../../components/Dialog.tsx';
import { Button, Field, Input, Select } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useCatalog, useServers } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';

export function NewServiceDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const { m } = useI18n();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const servers = useServers();
  const [type, setType] = useState<ServiceType>('postgres');
  const [version, setVersion] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [serverId, setServerId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const entry = catalog.data?.find((candidate) => candidate.type === type);

  useEffect(() => {
    if (entry !== undefined) setVersion(entry.defaultVersion);
    if (entry !== undefined && !nameTouched) setName(entry.type);
  }, [entry, nameTouched]);
  useEffect(() => {
    if (serverId === '' && servers.data?.[0] !== undefined) setServerId((servers.data.find((server) => server.status === 'ready') ?? servers.data[0]).id);
  }, [servers.data, serverId]);

  const close = () => {
    setNameTouched(false);
    setErrors({});
    onClose();
  };

  const create = useAction((input: { type: ServiceType; name: string; version: string; serverId: string }) => api.post<ServiceDto>(`/api/projects/${projectId}/services`, input), {
    success: m.services.created,
    invalidate: [keys.project(projectId), keys.projects],
    inlineValidation: true,
    onSuccess: (service) => {
      close();
      void navigate(`/services/${service.id}`);
    },
  });

  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title={m.services.newTitle}
      onSubmit={() => {
        const payload = { type, name: name.trim(), version, serverId };
        const result = validate(m, createServiceSchema, payload);
        if (result.errors !== null) {
          setErrors(result.errors);
          return;
        }
        create.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
      }}
      footer={
        <>
          <Button onClick={close}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" busy={create.isPending}>
            {m.services.create}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 18 }}>
        <div className="field">
          <span className="field__label">{m.services.type}</span>
          <div className="choices" role="radiogroup" aria-label={m.services.type}>
            {(catalog.data ?? []).map((candidate) => (
              <button key={candidate.type} type="button" role="radio" className="choice" aria-checked={candidate.type === type} onClick={() => setType(candidate.type)}>
                <span className="choice__title">
                  <Database aria-hidden="true" />
                  {candidate.label}
                </span>
                <span className="choice__hint">{m.services.descriptions[candidate.type]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="form-grid">
          <Field label={m.services.name} error={errors.name}>
            <Input value={name} onChange={(event) => { setName(event.target.value); setNameTouched(true); }} />
          </Field>
          <Field label={m.services.version} error={errors.version}>
            <Select value={version} onChange={(event) => setVersion(event.target.value)}>
              {(entry?.versions ?? []).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={m.services.server} error={errors.serverId}>
            <Select value={serverId} onChange={(event) => setServerId(event.target.value)}>
              {(servers.data ?? []).map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
