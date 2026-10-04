import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Box, Brush, Container, Download, Pencil, RefreshCw, Server as ServerIcon, Trash2 } from 'lucide-react';
import { updateServerSchema, type MetricRange } from '@ploy/shared';
import { AreaChart } from '../../components/Chart.tsx';
import { CopyButton } from '../../components/Copy.tsx';
import { useConfirm, Dialog } from '../../components/Dialog.tsx';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { Status } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Badge, Button, Callout, Field, Input, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useServer, useServerDocker, useServerMetrics } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { NotFound } from '../../app/RouteError.tsx';
import { RangePicker } from '../app/Metrics.tsx';
import { Reason } from '../../components/Reason.tsx';

export function ServerPage() {
  const { serverId = '' } = useParams();
  const { m, t, plural, formatBytes, formatNumber } = useI18n();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const server = useServer(serverId);
  const data = server.data;
  const [range, setRange] = useState<MetricRange>('1h');
  const metrics = useServerMetrics(serverId, range);
  const docker = useServerDocker(serverId, data?.status === 'ready');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', host: '', port: '', username: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [installOutput, setInstallOutput] = useState<string | null>(null);
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

  const points = metrics.data?.points ?? [];
  const latest = metrics.data?.latest ?? null;
  const pct = (value: number) => `${formatNumber(value, { maximumFractionDigits: value < 10 ? 1 : 0 })}%`;
  const authorizeCommand = data.publicKey === null ? null : `mkdir -p ~/.ssh && echo "${data.publicKey}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
  const needsDocker = data.statusReason === 'docker_missing';

  return (
    <div className="page">
      <div className="resource-head">
        <span className="resource-head__icon">
          <ServerIcon />
        </span>
        <div className="grow">
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <h1>{data.name}</h1>
            <Status kind="server" status={data.status} />
            {data.kind === 'local' && <Badge tone="info">{m.servers.local}</Badge>}
          </div>
          <div className="resource-head__meta">
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
        <div className="page-head__actions">
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
      </div>

      {data.status !== 'ready' && data.statusMessage !== null && (
        <div style={{ marginBottom: 16 }}>
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
        </div>
      )}
      {install.isPending && <Callout tone="work">{m.servers.installingDocker}</Callout>}
      {installOutput !== null && <div className="codeblock" style={{ maxHeight: 240, overflow: 'auto', marginBottom: 16 }}>{installOutput}</div>}

      {data.kind === 'ssh' && data.status !== 'ready' && authorizeCommand !== null && (
        <div className="section">
          <div className="section__intro">
            <h2>{m.servers.keyTitle}</h2>
            <p>{m.servers.keyText}</p>
          </div>
          <div className="stack">
            <div className="codeblock">
              {authorizeCommand}
              <CopyButton value={authorizeCommand} />
            </div>
            <div>
              <Button variant="primary" icon={<RefreshCw />} busy={verify.isPending} onClick={() => verify.mutate()}>
                {m.servers.verify}
              </Button>
            </div>
          </div>
        </div>
      )}

      {data.status !== 'pending' && <div className="stat-grid" style={{ marginBottom: 20 }}>
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
      </div>}

      {data.hostKeyFingerprint !== null && (
        <p className="field__hint" style={{ marginBottom: 20 }}>
          {m.servers.fingerprint}: <code>{data.hostKeyFingerprint}</code>
        </p>
      )}

      {data.status !== 'pending' && (
      <div className="stack">
        <div>
          <RangePicker value={range} onChange={setRange} />
        </div>
        <div className="chart-grid">
          <AreaChart
            title={m.metrics.cpu}
            headline={latest === null ? undefined : pct(latest.cpu)}
            series={[{ label: m.metrics.cpu, color: 'var(--lapis)', values: points.map((point) => ({ t: point.t, v: point.cpu })) }]}
            format={pct}
            max={100}
          />
          <AreaChart
            title={m.metrics.memory}
            headline={latest === null ? undefined : `${formatBytes(latest.memUsed)} / ${formatBytes(latest.memTotal, 0)}`}
            series={[{ label: m.metrics.memory, color: 'var(--ok)', values: points.map((point) => ({ t: point.t, v: point.memUsed })) }]}
            format={(value) => formatBytes(value)}
            {...(latest === null ? {} : { max: latest.memTotal })}
          />
          <AreaChart
            title={m.metrics.disk}
            headline={latest === null ? undefined : `${formatBytes(latest.diskUsed)} / ${formatBytes(latest.diskTotal, 0)}`}
            series={[{ label: m.metrics.disk, color: 'var(--work)', values: points.map((point) => ({ t: point.t, v: point.diskUsed })) }]}
            format={(value) => formatBytes(value)}
            {...(latest === null ? {} : { max: latest.diskTotal })}
          />
          <AreaChart
            title={m.metrics.load}
            headline={latest === null ? undefined : formatNumber(latest.load1, { maximumFractionDigits: 2 })}
            series={[{ label: m.metrics.load, color: 'var(--bad)', values: points.map((point) => ({ t: point.t, v: point.load1 })) }]}
            format={(value) => formatNumber(value, { maximumFractionDigits: 2 })}
          />
        </div>
      </div>
      )}

      {data.status === 'ready' && (
        <div className="section" style={{ marginTop: 28 }}>
          <div className="section__intro">
            <h2>{m.servers.diskUsage}</h2>
          </div>
          <div className="stack">
            {docker.data === undefined ? (
              <Skeleton height={80} />
            ) : (
              <div className="stat-grid">
                {[
                  { icon: <Box />, label: m.servers.images, bytes: docker.data.images.bytes, extra: docker.data.images.reclaimableBytes },
                  { icon: <Container />, label: m.servers.containers, bytes: docker.data.containers.bytes, extra: 0 },
                  { icon: <Box />, label: m.servers.volumes, bytes: docker.data.volumes.bytes, extra: 0 },
                  { icon: <Brush />, label: m.servers.buildCache, bytes: docker.data.buildCache.bytes, extra: docker.data.buildCache.reclaimableBytes },
                ].map((item) => (
                  <div className="stat" key={item.label}>
                    <div className="stat__label">{item.label}</div>
                    <div className="stat__value" style={{ fontSize: 'var(--text-lg)' }}>{formatBytes(item.bytes)}</div>
                    <div className="stat__foot">{item.extra > 0 ? t(m.servers.reclaimable, { size: formatBytes(item.extra) }) : ''}</div>
                  </div>
                ))}
              </div>
            )}
            <div>
              <Button icon={<Brush />} busy={cleanup.isPending} onClick={() => cleanup.mutate()}>
                {m.servers.cleanup}
              </Button>
            </div>
          </div>
        </div>
      )}

      {data.kind === 'ssh' && (
        <div className="section">
          <div className="section__intro">
            <h2>{m.appSettings.danger}</h2>
          </div>
          <div className="panel panel--danger">
            <div className="panel__body row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <p className="muted">{m.servers.deleteText}</p>
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
            </div>
          </div>
        </div>
      )}

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
