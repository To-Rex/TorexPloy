import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Plus, Server as ServerIcon } from 'lucide-react';
import { createServerSchema, type ServerDto } from '@ploy/shared';
import { Frame } from '../../components/Frame.tsx';
import { Dialog } from '../../components/Dialog.tsx';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { Status } from '../../components/Status.tsx';
import { Badge, Button, Field, Input, SkeletonRows } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useServers } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';

export function ServersPage() {
  const { m, plural, formatBytes } = useI18n();
  usePageMeta([{ label: m.servers.title }]);
  const navigate = useNavigate();
  const servers = useServers();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', host: '', port: '22', username: 'root' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useAction((input: { name: string; host: string; port: number; username: string }) => api.post<ServerDto>('/api/servers', input), {
    invalidate: [keys.servers],
    inlineValidation: true,
    onSuccess: (server) => {
      setAdding(false);
      void navigate(`/servers/${server.id}`);
    },
  });

  return (
    <div className="page">
      <Frame
        icon={<ServerIcon />}
        title={m.servers.title}
        description={m.servers.subtitle}
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => { setErrors({}); setAdding(true); }}>
            {m.servers.add}
          </Button>
        }
      >
      {servers.isPending ? (
        <SkeletonRows rows={2} />
      ) : (
        <div className="list">
          {servers.data!.map((server) => (
            <Link key={server.id} className="list__row" to={`/servers/${server.id}`}>
              <ServerIcon width={20} height={20} className="faint" aria-hidden="true" />
              <div className="grow">
                <div className="row">
                  <span className="list__title truncate">{server.name}</span>
                  {server.kind === 'local' && <Badge tone="info">{m.servers.local}</Badge>}
                </div>
                <div className="list__meta">
                  <span>{server.kind === 'local' ? (server.publicIp ?? m.servers.localHint) : `${server.username}@${server.host}`}</span>
                  {server.docker !== null && (
                    <span className="tabular">
                      {plural(m.units.cores, server.docker.cpus)}, {formatBytes(server.docker.memoryBytes, 0)}
                    </span>
                  )}
                  <span>
                    {plural(m.projects.apps, server.applicationCount)}, {plural(m.projects.services, server.serviceCount)}
                  </span>
                </div>
              </div>
              <Status kind="server" status={server.status} />
            </Link>
          ))}
        </div>
      )}
      </Frame>
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title={m.servers.add}
        onSubmit={() => {
          const payload = { name: form.name.trim(), host: form.host.trim(), port: Number(form.port), username: form.username.trim() };
          const result = validate(m, createServerSchema, payload);
          if (result.errors !== null) {
            setErrors(result.errors);
            return;
          }
          create.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
        }}
        footer={
          <>
            <Button onClick={() => setAdding(false)}>{m.common.cancel}</Button>
            <Button type="submit" variant="primary" busy={create.isPending}>
              {m.common.continue}
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label={m.servers.name} error={errors.name}>
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="hetzner-1" autoFocus />
          </Field>
          <div className="form-grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
            <Field label={m.servers.host} error={errors.host}>
              <Input mono value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value })} placeholder="203.0.113.10" spellCheck={false} />
            </Field>
            <Field label={m.servers.port} error={errors.port}>
              <Input value={form.port} onChange={(event) => setForm({ ...form, port: event.target.value.replace(/\D/g, '') })} inputMode="numeric" />
            </Field>
          </div>
          <Field label={m.servers.username} hint={m.servers.usernameHint} error={errors.username}>
            <Input mono value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} spellCheck={false} />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
