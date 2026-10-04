import { Outlet, useOutletContext, useParams } from 'react-router';
import { Activity, Archive, Database, Ellipsis, Plug, Play, RotateCcw, ScrollText, Server, Settings, Square } from 'lucide-react';
import type { ServiceDto } from '@ploy/shared';
import { Menu, MenuItem } from '../../components/Menu.tsx';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { Status } from '../../components/Status.tsx';
import { RouteTabs } from '../../components/Tabs.tsx';
import { Button, Callout, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useProject, useService } from '../../lib/queries.ts';
import { NotFound } from '../../app/RouteError.tsx';
import { Reason } from '../../components/Reason.tsx';

export function useServiceContext(): ServiceDto {
  return useOutletContext<{ service: ServiceDto }>().service;
}

export function ServiceLayout() {
  const { serviceId = '' } = useParams();
  const { m } = useI18n();
  const service = useService(serviceId);
  const data = service.data;
  const project = useProject(data?.projectId ?? '');
  usePageMeta([
    { label: m.nav.projects, to: '/projects' },
    ...(data === undefined ? [] : [{ label: project.data?.project.name ?? '…', to: `/projects/${data.projectId}` }]),
    { label: data?.name ?? '…' },
  ]);
  const invalidate = [keys.service(serviceId)];
  const action = useAction((name: 'start' | 'stop' | 'restart' | 'redeploy') => api.post(`/api/services/${serviceId}/${name}`), { invalidate });

  if (service.isError) return <NotFound />;
  const base = `/services/${serviceId}`;
  return (
    <div className="page">
      <div className="resource-head">
        <span className="resource-head__icon">
          <Database />
        </span>
        <div className="grow">
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <h1 className="truncate">{data?.name ?? <Skeleton width={180} height={28} />}</h1>
            {data !== undefined && <Status kind="service" status={data.status} />}
          </div>
          {data !== undefined && (
            <div className="resource-head__meta">
              <span>
                {data.type} {data.version}
              </span>
              <code>
                {data.internalHost}:{data.internalPort}
              </code>
              <span className="row" style={{ gap: 5 }}>
                <Server aria-hidden="true" />
                {data.serverName}
              </span>
            </div>
          )}
        </div>
        {data !== undefined && (
          <div className="page-head__actions">
            {data.status === 'stopped' ? (
              <Button icon={<Play />} busy={action.isPending} onClick={() => action.mutate('start')}>
                {m.services.start}
              </Button>
            ) : (
              <Button icon={<RotateCcw />} busy={action.isPending} onClick={() => action.mutate('restart')}>
                {m.services.restart}
              </Button>
            )}
            <Menu trigger={(props) => <Button {...props} iconOnly icon={<Ellipsis />}>{m.common.more}</Button>}>
              {data.status !== 'stopped' && (
                <MenuItem icon={<Square />} onSelect={() => action.mutate('stop')}>
                  {m.services.stop}
                </MenuItem>
              )}
              <MenuItem icon={<RotateCcw />} onSelect={() => action.mutate('redeploy')}>
                {m.services.recreate}
              </MenuItem>
            </Menu>
          </div>
        )}
      </div>
      {data?.status === 'failed' && data.statusMessage !== null && (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="bad">
            <Reason kind="service" code={data.statusReason} message={data.statusMessage} />
          </Callout>
        </div>
      )}
      <RouteTabs
        label={data?.name ?? ''}
        items={[
          { to: `${base}/connect`, label: m.services.tabs.connect, icon: <Plug /> },
          { to: `${base}/logs`, label: m.services.tabs.logs, icon: <ScrollText /> },
          { to: `${base}/metrics`, label: m.services.tabs.metrics, icon: <Activity /> },
          { to: `${base}/backups`, label: m.services.tabs.backups, icon: <Archive /> },
          { to: `${base}/settings`, label: m.services.tabs.settings, icon: <Settings /> },
        ]}
      />
      <div style={{ paddingTop: 24 }}>{data === undefined ? <Skeleton height={240} /> : <Outlet context={{ service: data }} />}</div>
    </div>
  );
}
