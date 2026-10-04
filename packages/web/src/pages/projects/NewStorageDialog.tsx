/**
 * Creating a file store: a name, a server, and optionally a public address
 * right away. Everything else (buckets, keys) happens on its own page.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { FolderArchive } from 'lucide-react';
import { createServiceSchema, type DomainDto, type ServiceDto } from '@ploy/shared';
import { Dialog } from '../../components/Dialog.tsx';
import { Button, Callout, Checkbox, Field, Input, Select } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useCatalog, useServers } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';

export function NewStorageDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const { m } = useI18n();
  const f = m.fileStore;
  const navigate = useNavigate();
  const catalog = useCatalog();
  const servers = useServers();
  const entry = catalog.data?.find((candidate) => candidate.type === 'files');
  const [name, setName] = useState('files');
  const [serverId, setServerId] = useState('');
  const [autoDomain, setAutoDomain] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (serverId === '' && servers.data?.[0] !== undefined) setServerId((servers.data.find((server) => server.status === 'ready') ?? servers.data[0]).id);
  }, [servers.data, serverId]);

  const close = () => {
    setErrors({});
    onClose();
  };
  const create = useAction(
    async (input: { name: string; version: string; serverId: string }) => {
      const service = await api.post<ServiceDto>(`/api/projects/${projectId}/services`, { type: 'files', ...input });
      // A public address is a convenience: failing to generate one must not undo the store.
      if (autoDomain) await api.post<DomainDto>(`/api/services/${service.id}/domains`, { generate: true }).catch(() => undefined);
      return service;
    },
    {
      success: f.created,
      invalidate: [keys.project(projectId), keys.projects],
      inlineValidation: true,
      onSuccess: (service) => {
        close();
        void navigate(`/services/${service.id}`);
      },
    },
  );

  return (
    <Dialog
      open={open}
      onClose={close}
      title={f.createTitle}
      description={f.createHint}
      onSubmit={() => {
        const payload = { type: 'files' as const, name: name.trim(), version: entry?.defaultVersion ?? '', serverId };
        const result = validate(m, createServiceSchema, payload);
        if (result.errors !== null) return setErrors(result.errors);
        setErrors({});
        create.mutate({ name: payload.name, version: payload.version, serverId }, { onError: (error) => setErrors(fieldErrors(m, error)) });
      }}
      footer={
        <>
          <Button onClick={close}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" icon={<FolderArchive />} busy={create.isPending} disabled={entry === undefined}>
            {f.create}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 16 }}>
        {catalog.isSuccess && entry === undefined && <Callout tone="work">{m.errors.codes.storage_unavailable}</Callout>}
        <div className="form-grid">
          <Field label={f.name} error={errors.name}>
            <Input value={name} onChange={(event) => setName(event.target.value)} data-autofocus />
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
        <Checkbox checked={autoDomain} onChange={setAutoDomain} label={f.autoDomain} hint={f.autoDomainHint} />
      </div>
    </Dialog>
  );
}
