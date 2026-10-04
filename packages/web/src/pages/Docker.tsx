/**
 * Docker: every container on a server — the platform's and anything else
 * running there — with logs, restart, stop and start.
 */
import { Container, Server } from 'lucide-react';
import { Frame } from '../components/Frame.tsx';
import { usePageMeta } from '../components/PageMeta.tsx';
import { EmptyState, Skeleton } from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useBootstrap } from '../lib/queries.ts';
import { ServerPicker, useChosenServer } from './Monitoring.tsx';
import { ServerContainers } from './servers/ServerContainers.tsx';

export function DockerPage() {
  const { m } = useI18n();
  usePageMeta([{ label: m.docker.title }]);
  const bootstrap = useBootstrap();
  const { servers, list, chosen, choose } = useChosenServer();
  // The panel's own server holds every team's containers: only the instance administrator sees it.
  const visible = list.filter((server) => server.kind !== 'local' || bootstrap.data?.user?.isInstanceAdmin === true);
  const current = visible.find((server) => server.id === chosen?.id) ?? visible[0];
  return (
    <div className="page">
      <Frame
        icon={<Container />}
        title={m.docker.title}
        description={m.docker.subtitle}
        actions={current !== undefined ? <ServerPicker list={visible} value={current.id} onChange={choose} /> : undefined}
      >
        {servers.isPending ? (
          <Skeleton height={240} />
        ) : current === undefined ? (
          <EmptyState icon={<Server />}>{m.docker.noServers}</EmptyState>
        ) : current.status !== 'ready' ? (
          <EmptyState icon={<Server />}>{m.docker.notReady}</EmptyState>
        ) : (
          <ServerContainers key={current.id} serverId={current.id} />
        )}
      </Frame>
    </div>
  );
}
