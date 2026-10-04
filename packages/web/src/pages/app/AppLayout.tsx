import { Outlet, useOutletContext, useParams } from 'react-router';
import { Activity, Boxes, Clock, Container, ExternalLink, GitBranch, Globe, HardDrive, Play, RotateCcw, Rocket, ScrollText, Server, Settings, Square, Variable, Workflow, ChevronDown } from 'lucide-react';
import type { ApplicationDto } from '@ploy/shared';
import { useConfirm } from '../../components/Dialog.tsx';
import { Menu, MenuItem } from '../../components/Menu.tsx';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { Status } from '../../components/Status.tsx';
import { RouteTabs } from '../../components/Tabs.tsx';
import { Button, ButtonLink, Callout, GithubMark, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useApp, useProject } from '../../lib/queries.ts';
import { NotFound } from '../../app/RouteError.tsx';

export function useAppContext(): ApplicationDto {
  return useOutletContext<{ app: ApplicationDto }>().app;
}

export function SourceLabel({ app }: { app: ApplicationDto }) {
  const source = app.source;
  if (source.type === 'github') {
    return (
      <a className="row" style={{ gap: 5 }} href={`https://github.com/${source.repository}/tree/${source.branch}`} target="_blank" rel="noreferrer noopener">
        <GithubMark size={14} />
        {source.repository}
        <span className="faint">
          <GitBranch width={13} height={13} style={{ display: 'inline', verticalAlign: '-2px' }} aria-hidden="true" /> {source.branch}
        </span>
      </a>
    );
  }
  if (source.type === 'git') {
    return (
      <span className="row" style={{ gap: 5 }}>
        <GitBranch aria-hidden="true" />
        <span className="truncate" style={{ maxWidth: 320 }}>{source.url.replace(/^https:\/\//, '')}</span>
        <span className="faint">{source.branch}</span>
      </span>
    );
  }
  return (
    <span className="row" style={{ gap: 5 }}>
      <Container aria-hidden="true" />
      <code>{source.image}</code>
    </span>
  );
}

export function AppLayout() {
  const { appId = '' } = useParams();
  const { m, plural } = useI18n();
  const confirm = useConfirm();
  const app = useApp(appId);
  const project = useProject(app.data?.projectId ?? '');
  const data = app.data;
  usePageMeta([
    { label: m.nav.projects, to: '/projects' },
    ...(data === undefined ? [] : [{ label: project.data?.project.name ?? '…', to: `/projects/${data.projectId}` }]),
    { label: data?.name ?? '…' },
  ]);

  const invalidate = [keys.app(appId), keys.appPart(appId, 'deployments')];
  const deploy = useAction((clearCache: boolean) => api.post(`/api/applications/${appId}/deploy`, { clearCache }), { success: m.app.deployQueued, invalidate });
  const restart = useAction(() => api.post(`/api/applications/${appId}/restart`), { success: m.app.restartQueued, invalidate });
  const stop = useAction(() => api.post(`/api/applications/${appId}/stop`), { success: m.app.stopped, invalidate });
  const start = useAction(() => api.post(`/api/applications/${appId}/start`), { success: m.app.started, invalidate });

  if (app.isError) return <NotFound />;
  const busy = data !== undefined && ['queued', 'building', 'deploying'].includes(data.status);
  const base = `/apps/${appId}`;

  return (
    <div className="page">
      <div className="resource-head">
        <span className="resource-head__icon">{data?.kind === 'worker' ? <Workflow /> : <Boxes />}</span>
        <div className="grow">
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <h1 className="truncate">{data?.name ?? <Skeleton width={200} height={28} />}</h1>
            {data !== undefined && <Status kind="app" status={data.status} />}
          </div>
          {data !== undefined && (
            <div className="resource-head__meta">
              {data.url !== null && (
                <a className="row" style={{ gap: 5 }} href={data.url} target="_blank" rel="noreferrer noopener">
                  <Globe aria-hidden="true" />
                  {data.url.replace(/^https?:\/\//, '')}
                </a>
              )}
              <SourceLabel app={data} />
              <span className="row" style={{ gap: 5 }}>
                <Server aria-hidden="true" />
                {data.serverName}
              </span>
              {data.replicas > 1 && <span>{plural(m.app.replicas, data.replicas)}</span>}
            </div>
          )}
        </div>
        {data !== undefined && (
          <div className="page-head__actions">
            {data.url !== null && (
              <ButtonLink href={data.url} external icon={<ExternalLink />}>
                {m.app.open}
              </ButtonLink>
            )}
            {data.status === 'stopped' ? (
              <Button icon={<Play />} busy={start.isPending} onClick={() => start.mutate()}>
                {m.app.start}
              </Button>
            ) : (
              data.activeDeployment !== null && (
                <Menu trigger={(props) => <Button {...props} iconOnly icon={<RotateCcw />}>{m.common.more}</Button>}>
                  <MenuItem icon={<RotateCcw />} disabled={busy} onSelect={() => restart.mutate()}>
                    {m.app.restart}
                  </MenuItem>
                  <MenuItem
                    icon={<Square />}
                    disabled={busy}
                    onSelect={async () => {
                      const result = await confirm({ title: m.app.stopConfirmTitle, text: m.app.stopConfirmText, confirmLabel: m.app.stop, danger: true });
                      if (result.confirmed) stop.mutate();
                    }}
                  >
                    {m.app.stop}
                  </MenuItem>
                </Menu>
              )
            )}
            <div className="row" style={{ gap: 0 }}>
              <Button variant="primary" icon={<Rocket />} busy={deploy.isPending} onClick={() => deploy.mutate(false)} style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>
                {m.app.deploy}
              </Button>
              <Menu
                trigger={(props) => (
                  <Button {...props} variant="primary" iconOnly icon={<ChevronDown />} style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: '1px solid color-mix(in srgb, white 30%, transparent)', width: 30 }}>
                    {m.common.more}
                  </Button>
                )}
              >
                <MenuItem icon={<Rocket />} onSelect={() => deploy.mutate(true)}>
                  {m.app.deployWithoutCache}
                </MenuItem>
              </Menu>
            </div>
          </div>
        )}
      </div>

      {data?.pendingChanges === true && (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="work" action={<Button size="sm" onClick={() => deploy.mutate(false)} busy={deploy.isPending}>{m.app.applyNow}</Button>}>
            {m.app.pendingChanges}
          </Callout>
        </div>
      )}

      <RouteTabs
        label={data?.name ?? ''}
        items={[
          { to: `${base}/deployments`, label: m.app.tabs.deployments, icon: <Rocket /> },
          { to: `${base}/logs`, label: m.app.tabs.logs, icon: <ScrollText /> },
          { to: `${base}/metrics`, label: m.app.tabs.metrics, icon: <Activity /> },
          { to: `${base}/variables`, label: m.app.tabs.variables, icon: <Variable /> },
          ...(data?.kind === 'worker' ? [] : [{ to: `${base}/domains`, label: m.app.tabs.domains, icon: <Globe /> }]),
          { to: `${base}/storage`, label: m.app.tabs.storage, icon: <HardDrive /> },
          { to: `${base}/cron`, label: m.app.tabs.cron, icon: <Clock /> },
          { to: `${base}/settings`, label: m.app.tabs.settings, icon: <Settings /> },
        ]}
      />
      <div style={{ paddingTop: 24 }}>{data === undefined ? <Skeleton height={240} /> : <Outlet context={{ app: data }} />}</div>
    </div>
  );
}
