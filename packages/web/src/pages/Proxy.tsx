/**
 * The proxy (Dokploy's Traefik screen): every route a server's proxy
 * serves, where each one goes, the exact configuration it was given, and a
 * button to load it again.
 */
import { ArrowRight, Lock, Network, RefreshCw, Server, Unlock } from 'lucide-react';
import { CopyButton } from '../components/Copy.tsx';
import { Card, Frame } from '../components/Frame.tsx';
import { usePageMeta } from '../components/PageMeta.tsx';
import { StatusMark } from '../components/Status.tsx';
import { Badge, Button, EmptyState, Skeleton } from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';
import { api } from '../lib/api.ts';
import { useAction } from '../lib/mutate.ts';
import { keys, useBootstrap, useServerProxy } from '../lib/queries.ts';
import { ServerPicker, useChosenServer } from './Monitoring.tsx';

function ProxyOverview({ serverId }: { serverId: string }) {
  const { m, t } = useI18n();
  const p = m.proxy;
  const proxy = useServerProxy(serverId);
  const reload = useAction(() => api.post(`/api/servers/${serverId}/proxy/reload`), { success: p.reloaded, invalidate: [keys.serverPart(serverId, 'proxy'), keys.server(serverId)] });
  if (proxy.isPending) return <Skeleton height={240} />;
  if (proxy.isError) return <p className="muted">{p.unavailable}</p>;
  const data = proxy.data;
  return (
    <>
      <Card
        title={p.statusTitle}
        description={data.inSync ? p.inSync : p.outOfSync}
        actions={
          <Button icon={<RefreshCw />} busy={reload.isPending} onClick={() => reload.mutate()}>
            {p.reload}
          </Button>
        }
      >
        <dl className="facts-strip">
          <div>
            <dt>{m.servers.proxy}</dt>
            <dd>
              <StatusMark tone={data.running ? 'ok' : 'bad'} label={data.running ? t(m.servers.proxyRunning, { version: data.version ?? '' }) : m.servers.proxyDown} />
            </dd>
          </div>
          <div>
            <dt>{p.routes}</dt>
            <dd>{data.routes.length}</dd>
          </div>
          <div>
            <dt>{p.httpsRoutes}</dt>
            <dd>{data.routes.filter((route) => route.https).length}</dd>
          </div>
        </dl>
      </Card>

      <Card title={p.routes} description={p.routesHint} flush={data.routes.length > 0}>
        {data.routes.length === 0 ? (
          <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{p.noRoutes}</p>
        ) : (
          <div className="list">
            {data.routes.map((route) => (
              <div key={`${route.host}${route.path}`} className="list__row">
                {route.https ? <Lock width={16} height={16} className="faint" aria-label="HTTPS" /> : <Unlock width={16} height={16} className="faint" aria-label="HTTP" />}
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <a className="list__title truncate" href={`${route.https ? 'https' : 'http'}://${route.host}${route.path === '/' ? '' : route.path}`} target="_blank" rel="noreferrer noopener" style={{ color: 'inherit' }}>
                      {route.host}
                      {route.path !== '/' && <span className="faint">{route.path}</span>}
                    </a>
                    <Badge>{route.label}</Badge>
                    {route.stripPath && <Badge>{p.stripPath}</Badge>}
                  </div>
                  <div className="list__meta">
                    <ArrowRight width={13} height={13} aria-hidden="true" />
                    {route.redirectTo !== null ? (
                      <span>
                        {p.redirect} <code>{route.redirectTo}</code>
                      </span>
                    ) : route.upstreams.length === 0 ? (
                      <span style={{ color: 'var(--work-ink)' }}>{p.noUpstream}</span>
                    ) : (
                      route.upstreams.map((upstream) => <code key={upstream}>{upstream}</code>)
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={p.config} description={p.configHint}>
        <div className="editor">
          <div className="editor__bar">
            <Network aria-hidden="true" />
            <span className="grow">ploy.json</span>
            <CopyButton value={data.config} />
          </div>
          <pre className="editor__area editor__area--readonly" style={{ maxHeight: 520, overflow: 'auto' }}>
            {data.config}
          </pre>
        </div>
      </Card>
    </>
  );
}

export function ProxyPage() {
  const { m } = useI18n();
  usePageMeta([{ label: m.proxy.title }]);
  const bootstrap = useBootstrap();
  const { servers, list, chosen, choose } = useChosenServer();
  // The shared host's proxy routes every team's domains: only the instance administrator sees it.
  const visible = list.filter((server) => server.kind !== 'local' || bootstrap.data?.user?.isInstanceAdmin === true);
  const current = visible.find((server) => server.id === chosen?.id) ?? visible[0];
  return (
    <div className="page">
      <Frame
        icon={<Network />}
        title={m.proxy.title}
        description={m.proxy.subtitle}
        actions={current !== undefined ? <ServerPicker list={visible} value={current.id} onChange={choose} /> : undefined}
      >
        {servers.isPending ? (
          <Skeleton height={240} />
        ) : current === undefined ? (
          <EmptyState icon={<Server />}>{m.docker.noServers}</EmptyState>
        ) : current.status !== 'ready' ? (
          <EmptyState icon={<Server />}>{m.docker.notReady}</EmptyState>
        ) : (
          <ProxyOverview key={current.id} serverId={current.id} />
        )}
      </Frame>
    </div>
  );
}
