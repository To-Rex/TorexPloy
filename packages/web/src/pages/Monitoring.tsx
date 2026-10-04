/**
 * Monitoring: how a server is holding up — CPU, memory, disk and load over
 * time — with a picker when the team has more than one server.
 */
import { useSearchParams } from 'react-router';
import { Activity, Server } from 'lucide-react';
import { Card, Frame } from '../components/Frame.tsx';
import { usePageMeta } from '../components/PageMeta.tsx';
import { Status } from '../components/Status.tsx';
import { EmptyState, Select, Skeleton } from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useServers } from '../lib/queries.ts';
import { HostCharts } from './servers/HostCharts.tsx';

/** The server a page is about: `?server=` when given, else the first ready one. */
export function useChosenServer() {
  const servers = useServers();
  const [params, setParams] = useSearchParams();
  const list = servers.data ?? [];
  const wanted = params.get('server');
  const chosen = list.find((server) => server.id === wanted) ?? list.find((server) => server.status === 'ready') ?? list[0];
  const choose = (id: string) => setParams({ server: id }, { replace: true });
  return { servers, list, chosen, choose };
}

export function ServerPicker({ list, value, onChange }: { list: { id: string; name: string }[]; value: string; onChange: (id: string) => void }) {
  const { m } = useI18n();
  if (list.length < 2) return null;
  return (
    <label className="server-pick">
      <Server width={16} height={16} className="faint" aria-hidden="true" />
      <Select value={value} onChange={(event) => onChange(event.target.value)} aria-label={m.monitoring.server}>
        {list.map((server) => (
          <option key={server.id} value={server.id}>
            {server.name}
          </option>
        ))}
      </Select>
    </label>
  );
}

export function MonitoringPage() {
  const { m } = useI18n();
  usePageMeta([{ label: m.monitoring.title }]);
  const { servers, list, chosen, choose } = useChosenServer();
  return (
    <div className="page">
      <Frame
        icon={<Activity />}
        title={m.monitoring.title}
        description={m.monitoring.subtitle}
        actions={chosen !== undefined ? <ServerPicker list={list} value={chosen.id} onChange={choose} /> : undefined}
      >
        {servers.isPending ? (
          <Skeleton height={320} />
        ) : chosen === undefined ? (
          <EmptyState icon={<Server />}>{m.monitoring.noServers}</EmptyState>
        ) : (
          <Card
            title={chosen.name}
            description={chosen.docker === null ? m.monitoring.serverHint : `Docker ${chosen.docker.version}, ${chosen.docker.os} ${chosen.docker.arch}`}
            actions={<Status kind="server" status={chosen.status} />}
          >
            <HostCharts key={chosen.id} serverId={chosen.id} />
          </Card>
        )}
      </Frame>
    </div>
  );
}
