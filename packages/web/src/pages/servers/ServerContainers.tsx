/**
 * Every container on a server, ours and not, with what owns it and the
 * everyday actions: logs, restart, stop, start.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Ellipsis, Play, RotateCcw, ScrollText, Search, Square } from 'lucide-react';
import type { ServerContainerDto } from '@ploy/shared';
import { Dialog, useConfirm } from '../../components/Dialog.tsx';
import { parseAnsi } from '../../components/LogViewer.tsx';
import { Menu, MenuItem } from '../../components/Menu.tsx';
import { StatusMark } from '../../components/Status.tsx';
import { Badge, Button, Segmented, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useServerContainers, useServerContainerLogs } from '../../lib/queries.ts';

type Filter = 'all' | 'platform' | 'external';

function OwnerChip({ owner }: { owner: ServerContainerDto['owner'] }) {
  const { m } = useI18n();
  const label = m.containers.owners[owner.kind];
  if (owner.kind === 'application' || owner.kind === 'compose') {
    return (
      <Link to={`/apps/${owner.id}`} className="chip">
        {label}: {owner.name}
      </Link>
    );
  }
  if (owner.kind === 'service') {
    return (
      <Link to={`/services/${owner.id}`} className="chip">
        {label}: {owner.name}
      </Link>
    );
  }
  return <Badge tone={owner.kind === 'external' ? 'work' : undefined}>{label}</Badge>;
}

function LogsDialog({ serverId, container, onClose }: { serverId: string; container: ServerContainerDto | null; onClose: () => void }) {
  const { m } = useI18n();
  const logs = useServerContainerLogs(serverId, container?.id ?? null);
  return (
    <Dialog open={container !== null} onClose={onClose} wide title={container?.name ?? ''} description={m.containers.logsHint}>
      {logs.isPending ? (
        <Skeleton height={300} />
      ) : (
        <pre className="container-logs">
          {(logs.data?.lines ?? []).length === 0
            ? m.logs.empty
            : logs.data!.lines.map((line, index) => (
                <span key={index} className={line.stream === 'stderr' ? 'container-logs__err' : undefined}>
                  {parseAnsi(line.text.replace(/^\S+Z /, '')).map((segment, part) => (
                    <span key={part} style={segment.color === undefined ? undefined : { color: segment.color }}>
                      {segment.text}
                    </span>
                  ))}
                  {'\n'}
                </span>
              ))}
        </pre>
      )}
    </Dialog>
  );
}

export function ServerContainers({ serverId }: { serverId: string }) {
  const { m } = useI18n();
  const confirm = useConfirm();
  const containers = useServerContainers(serverId);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [viewing, setViewing] = useState<ServerContainerDto | null>(null);
  const invalidate = [keys.serverPart(serverId, 'containers')];
  const act = useAction((input: { id: string; action: 'start' | 'stop' | 'restart' }) => api.post(`/api/servers/${serverId}/containers/${input.id}/${input.action}`), {
    success: m.containers.done,
    invalidate,
  });

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (containers.data ?? []).filter((container) => {
      const ours = container.owner.kind !== 'external';
      if (filter === 'platform' && !ours) return false;
      if (filter === 'external' && ours) return false;
      return needle.length === 0 || container.name.toLowerCase().includes(needle) || container.image.toLowerCase().includes(needle);
    });
  }, [containers.data, filter, query]);

  if (containers.isPending) return <Skeleton height={160} />;
  if (containers.isError) return <p className="muted">{m.containers.unavailable}</p>;
  const external = (containers.data ?? []).filter((container) => container.owner.kind === 'external').length;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <Segmented
          label={m.containers.filter}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `${m.containers.all} (${containers.data?.length ?? 0})` },
            { value: 'platform', label: m.containers.platform },
            { value: 'external', label: `${m.containers.external} (${external})` },
          ]}
        />
        <label className="template-search" style={{ flex: '1 1 220px', height: 34 }}>
          <Search aria-hidden="true" />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={m.containers.search} aria-label={m.containers.search} />
        </label>
      </div>
      <div className="list">
        {visible.length === 0 ? (
          <p className="muted" style={{ padding: 16 }}>{m.containers.none}</p>
        ) : (
          visible.map((container) => {
            const running = container.state === 'running';
            const tone = running ? 'ok' : container.state === 'restarting' ? 'work' : container.state === 'exited' || container.state === 'dead' ? 'bad' : 'idle';
            const vital = container.owner.kind === 'proxy' || container.owner.kind === 'platform';
            return (
              <div key={container.id} className="list__row container-line">
                <StatusMark tone={tone} label="" />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <code className="list__title truncate">{container.name}</code>
                    <OwnerChip owner={container.owner} />
                  </div>
                  <div className="list__meta">
                    <span className="truncate" style={{ maxWidth: 320 }}>{container.image}</span>
                    <span>{container.status}</span>
                    {container.ports.map((port) => (
                      <code key={port}>{port}</code>
                    ))}
                  </div>
                </div>
                <Menu trigger={(props) => <Button {...props} variant="ghost" size="sm" iconOnly icon={<Ellipsis />}>{m.common.actions}</Button>}>
                  <MenuItem icon={<ScrollText />} onSelect={() => setViewing(container)}>
                    {m.containers.logs}
                  </MenuItem>
                  {running ? (
                    <>
                      <MenuItem icon={<RotateCcw />} onSelect={() => act.mutate({ id: container.id, action: 'restart' })}>
                        {m.containers.restart}
                      </MenuItem>
                      {!vital && (
                        <MenuItem
                          icon={<Square />}
                          danger
                          onSelect={async () => {
                            const result = await confirm({ title: m.containers.stopTitle, text: container.name, confirmLabel: m.containers.stop, danger: true });
                            if (result.confirmed) act.mutate({ id: container.id, action: 'stop' });
                          }}
                        >
                          {m.containers.stop}
                        </MenuItem>
                      )}
                    </>
                  ) : (
                    <MenuItem icon={<Play />} onSelect={() => act.mutate({ id: container.id, action: 'start' })}>
                      {m.containers.start}
                    </MenuItem>
                  )}
                </Menu>
              </div>
            );
          })
        )}
      </div>
      <LogsDialog serverId={serverId} container={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
