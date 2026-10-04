import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Brush, Download, Pencil, RefreshCw, Server as ServerIcon, Trash2 } from 'lucide-react';
import { updateServerSchema } from '@ploy/shared';
import { CopyButton } from '../../components/Copy.tsx';
import { useConfirm, Dialog } from '../../components/Dialog.tsx';
import { Card } from '../../components/Frame.tsx';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { Status } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Badge, Button, Callout, Field, Input, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useBootstrap, useRole, useServer, useServerDocker } from '../../lib/queries.ts';
import { ServerContainers } from './ServerContainers.tsx';
import { validate } from '../../lib/validate.ts';
import { NotFound } from '../../app/RouteError.tsx';
import { HostCharts } from './HostCharts.tsx';
import { Reason } from '../../components/Reason.tsx';

export function ServerPage() {
  const { serverId = '' } = useParams();
  const { m, t, plural, formatBytes } = useI18n();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const server = useServer(serverId);
  const data = server.data;
  const docker = useServerDocker(serverId, data?.status === 'ready');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', host: '', port: '', username: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [installOutput, setInstallOutput] = useState<string | null>(null);
  const bootstrap = useBootstrap();
  const role = useRole();
  usePageMeta([{ label: m.servers.title, to: '/servers' }, { label: data?.name ?? '…' }]);

  const invalidate = [keys.server(serverId), keys.servers];
  const verify = useAction(() => api.post<{ status: string }>(`/api/servers/${serverId}/verify`), {
    invalidate,
    success: (result) => (result.status === 'ready' ? m.servers.verified : null),
  });
  const install = useAction(() => api.post<{ ok: boolean; output: string }>(`/api/servers/${serverId}/install-docker`), {
    invalidate,
    onSuccess: (result) => setInstallOutput(result.output),
    success: (result) => (result.ok ? m.servers.dockerInstalled : null),
  });
  const cleanup = useAction(() => api.post<{ reclaimedBytes: number }>(`/api/servers/${serverId}/cleanup`), {
    invalidate: [keys.serverPart(serverId, 'docker')],
    success: (result) => t(m.servers.cleanupDone, { size: formatBytes(result.reclaimedBytes) }),
  });
  const update = useAction((input: object) => api.patch(`/api/servers/${serverId}`, input), { invalidate, inlineValidation: true, onSuccess: () => setEditing(false) });
  const remove = useAction(() => api.delete(`/api/servers/${serverId}`), { success: m.servers.deleted, invalidate: [keys.servers], onSuccess: () => void navigate('/servers') });

  if (server.isError) return <NotFound />;
  if (data === undefined) return <div className="page"><Skeleton height={300} /></div>;

  const authorizeCommand = data.publicKey === null ? null : `mkdir -p ~/.ssh && echo "${data.publicKey}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
  const needsDocker = data.statusReason === 'docker_missing';

  const canSeeContainers = data.status === 'ready' && (data.kind === 'local' ? bootstrap.data?.user?.isInstanceAdmin === true : role === 'admin' || role === 'owner');

  return (
    <div className="page">
      <section className="frame">
        <div className="frame__sheet resource">
          <header className="resource__head">
            <span className="resource__icon">
              <ServerIcon />
            </span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="resource__title">
                <h1>{data.name}</h1>
                <Status kind="server" status={data.status} />
                {data.kind === 'local' && <Badge tone="info">{m.servers.local}</Badge>}
              </div>
              <div className="resource__meta">
                {data.kind === 'ssh' && <code>{`${data.username}@${data.host}:${data.port}`}</code>}
                {data.publicIp !== null && <span>{m.servers.publicIp}: {data.publicIp}</span>}
                {data.lastSeenAt !== null && (
                  <span>
                    {t(m.servers.lastSeen, { time: '' })}
                    <RelativeTime value={data.lastSeenAt} />
                  </span>
                )}
              </div>
            </div>
            <div className="resource__actions">
              <Button icon={<RefreshCw />} busy={verify.isPending} onClick={() => verify.mutate()}>
                {data.status === 'ready' ? m.servers.reconnect : m.servers.verify}
              </Button>
              {data.kind === 'ssh' && (
                <Button
                  iconOnly
                  icon={<Pencil />}
                  onClick={() => {
                    setForm({ name: data.name, host: data.host ?? '', port: String(data.port ?? 22), username: data.username ?? 'root' });
                    setErrors({});
                    setEditing(true);
                  }}
                >
                  {m.servers.edit}
                </Button>
              )}
            </div>
          </header>

          <div className="resource__body" style={{ paddingTop: 4 }}>
            {data.status !== 'ready' && data.statusMessage !== null && (
              <Callout
                tone={data.status === 'connecting' ? 'work' : 'bad'}
                action={
                  needsDocker ? (
                    <Button size="sm" icon={<Download />} busy={install.isPending} onClick={() => install.mutate()}>
                      {m.servers.installDocker}
                    </Button>
                  ) : undefined
                }
              >
                <Reason kind="server" code={data.statusReason} message={data.statusMessage} />
              </Callout>
            )}
            {install.isPending && <Callout tone="work">{m.servers.installingDocker}</Callout>}
            {installOutput !== null && <div className="codeblock" style={{ maxHeight: 240, overflow: 'auto' }}>{installOutput}</div>}

            {data.kind === 'ssh' && data.status !== 'ready' && authorizeCommand !== null && (
              <Card
                title={m.servers.keyTitle}
                description={m.servers.keyText}
                footer={
                  <Button variant="primary" icon={<RefreshCw />} busy={verify.isPending} onClick={() => verify.mutate()}>
                    {m.servers.verify}
                  </Button>
                }
              >
                <div className="codeblock">
                  {authorizeCommand}
                  <CopyButton value={authorizeCommand} />
                </div>
              </Card>
            )}

            {data.status !== 'pending' && (
              <div className="stat-grid">
                <div className="stat">
                  <div className="stat__label">{m.servers.docker}</div>
                  <div className="stat__value" style={{ fontSize: 'var(--text-lg)' }}>{data.docker?.version ?? '—'}</div>
                  <div className="stat__foot">{data.docker === null ? '' : `${data.docker.os}, ${data.docker.arch}`}</div>
                </div>
                <div className="stat">
                  <div className="stat__label">{m.servers.proxy}</div>
                  <div className="stat__value" style={{ fontSize: 'var(--text-lg)' }}>{data.proxy?.running ? t(m.servers.proxyRunning, { version: data.proxy.version ?? '' }) : m.servers.proxyDown}</div>
                </div>
                <div className="stat">
                  <div className="stat__label">{m.servers.resources}</div>
                  <div className="stat__value" style={{ fontSize: 'var(--text-lg)' }}>{data.docker === null ? '—' : `${plural(m.units.cores, data.docker.cpus)}, ${formatBytes(data.docker.memoryBytes, 0)}`}</div>
                </div>
                <div className="stat">
                  <div className="stat__label">{m.servers.applications}</div>
                  <div className="stat__value" style={{ fontSize: 'var(--text-lg)' }}>
                    {data.applicationCount} / {data.serviceCount}
                  </div>
                  <div className="stat__foot">
                    {m.servers.applications} / {m.servers.services}
                  </div>
                </div>
              </div>
            )}

            {data.hostKeyFingerprint !== null && (
              <p className="field__hint">
                {m.servers.fingerprint}: <code>{data.hostKeyFingerprint}</code>
              </p>
            )}

            {data.status !== 'pending' && (
              <Card title={m.monitoring.serverTitle} description={m.monitoring.serverHint}>
                <HostCharts serverId={serverId} />
              </Card>
            )}

            {data.status === 'ready' && (
              <Card
                title={m.servers.diskUsage}
                description={m.servers.cleanupHint}
                actions={
                  <Button icon={<Brush />} busy={cleanup.isPending} onClick={() => cleanup.mutate()}>
                    {m.servers.cleanup}
                  </Button>
                }
              >
                {docker.data === undefined ? (
                  <Skeleton height={80} />
                ) : (
                  <div className="stat-grid">
                    {[
                      { label: m.servers.images, bytes: docker.data.images.bytes, extra: docker.data.images.reclaimableBytes },
                      { label: m.servers.containers, bytes: docker.data.containers.bytes, extra: 0 },
                      { label: m.servers.volumes, bytes: docker.data.volumes.bytes, extra: 0 },
                      { label: m.servers.buildCache, bytes: docker.data.buildCache.bytes, extra: docker.data.buildCache.reclaimableBytes },
                    ].map((item) => (
                      <div className="stat" key={item.label}>
                        <div className="stat__label">{item.label}</div>
                        <div className="stat__value" style={{ fontSize: 'var(--text-lg)' }}>{formatBytes(item.bytes)}</div>
                        <div className="stat__foot">{item.extra > 0 ? t(m.servers.reclaimable, { size: formatBytes(item.extra) }) : ''}</div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}

            {canSeeContainers && (
              <Card title={m.containers.title} description={m.containers.subtitle}>
                <ServerContainers serverId={serverId} />
              </Card>
            )}

            {data.kind === 'ssh' && (
              <Card
                tone="bad"
                title={m.servers.delete}
                description={m.servers.deleteText}
                actions={
                  <Button
                    variant="danger"
                    icon={<Trash2 />}
                    onClick={async () => {
                      const result = await confirm({ title: m.servers.delete, text: m.servers.deleteText, confirmLabel: m.common.remove, danger: true, typeToConfirm: data.name });
                      if (result.confirmed) remove.mutate();
                    }}
                  >
                    {m.servers.delete}
                  </Button>
                }
              />
            )}
          </div>
        </div>
      </section>

      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title={m.servers.edit}
        onSubmit={() => {
          const payload = { name: form.name.trim(), host: form.host.trim(), port: Number(form.port), username: form.username.trim() };
          const result = validate(m, updateServerSchema, payload);
          if (result.errors !== null) {
            setErrors(result.errors);
            return;
          }
          update.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
        }}
        footer={
          <>
            <Button onClick={() => setEditing(false)}>{m.common.cancel}</Button>
            <Button type="submit" variant="primary" busy={update.isPending}>
              {m.common.save}
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label={m.servers.name} error={errors.name}>
            <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <div className="form-grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
            <Field label={m.servers.host} error={errors.host}>
              <Input mono value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value })} />
            </Field>
            <Field label={m.servers.port} error={errors.port}>
              <Input value={form.port} onChange={(event) => setForm({ ...form, port: event.target.value.replace(/\D/g, '') })} inputMode="numeric" />
            </Field>
          </div>
          <Field label={m.servers.username} error={errors.username}>
            <Input mono value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
