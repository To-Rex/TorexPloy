/**
 * The database console: a page of its own for a PostgreSQL, MySQL or
 * MariaDB service. The object browser on the left, tabs on the right
 * (dashboard, sessions, roles, any number of queries and tables), all kept
 * per service in this browser so a reload puts everything back.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Link, useParams } from 'react-router';
import { Activity, ArrowLeft, Eye, FileCode2, KeyRound, LayoutDashboard, PanelLeft, Plus, RefreshCw, Table2, X } from 'lucide-react';
import { hasDbConsole } from '@ploy/shared';
import { ServiceMark } from '../../components/KindMark.tsx';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { Status } from '../../components/Status.tsx';
import { Button, Callout, EmptyState, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { errorText } from '../../lib/errors.ts';
import { useProject, useService } from '../../lib/queries.ts';
import { NotFound } from '../../app/RouteError.tsx';
import { ConsoleProvider, type ConsoleTab } from './ConsoleContext.tsx';
import { closeSession, newSessionId, readStored, useDbOverview, useDbTree, writeStored } from './dbApi.ts';
import { QueryTab } from './QueryTab.tsx';
import { ObjectTab, TableTab } from './TableTab.tsx';
import { ActivityTab, DashboardTab, RolesTab } from './Tools.tsx';
import { OBJECT_ICON, Tree } from './Tree.tsx';
import './database.css';

interface Workspace {
  tabs: ConsoleTab[];
  active: string;
  database: string | null;
}

const MAX_TABS = 24;
const workspaceKey = (serviceId: string) => `ploy.db.${serviceId}.workspace`;

function initialWorkspace(serviceId: string): Workspace {
  const stored = readStored<Workspace | null>(workspaceKey(serviceId), null);
  const tabs = (stored?.tabs ?? []).filter((tab) => typeof tab === 'object' && tab !== null && typeof tab.id === 'string');
  if (!tabs.some((tab) => tab.kind === 'dashboard')) tabs.unshift({ id: 'dashboard', kind: 'dashboard' });
  return { tabs, active: tabs.some((tab) => tab.id === stored?.active) ? stored!.active : 'dashboard', database: stored?.database ?? null };
}

export function DatabaseConsolePage() {
  const { serviceId = '' } = useParams();
  const { m, t } = useI18n();
  const service = useService(serviceId);
  const supported = service.data !== undefined && hasDbConsole(service.data.type);
  const overview = useDbOverview(serviceId, supported);
  const project = useProject(service.data?.projectId ?? '');
  const [workspace, setWorkspace] = useState<Workspace>(() => initialWorkspace(serviceId));
  const [sidebar, setSidebar] = useState(false);
  const database = workspace.database !== null && overview.data?.databases.some((db) => db.name === workspace.database) ? workspace.database : (overview.data?.defaultDatabase ?? '');
  const tree = useDbTree(serviceId, overview.data === undefined ? '' : database);
  const tabStrip = useRef<HTMLDivElement>(null);

  usePageMeta([
    { label: m.nav.projects, to: '/projects' },
    ...(service.data === undefined ? [] : [{ label: project.data?.project.name ?? '…', to: `/projects/${service.data.projectId}` }]),
    { label: service.data?.name ?? '…', to: `/services/${serviceId}/general` },
    { label: m.db.title },
  ]);

  useEffect(() => {
    const timer = setTimeout(() => writeStored(workspaceKey(serviceId), workspace), 400);
    return () => clearTimeout(timer);
  }, [workspace, serviceId]);

  const open = useCallback((tab: ConsoleTab) => {
    setWorkspace((current) => {
      const existing = current.tabs.find((entry) => entry.id === tab.id);
      if (existing !== undefined) {
        const tabs = tab.kind === 'table' && existing.kind === 'table' ? current.tabs.map((entry) => (entry.id === tab.id ? { ...entry, view: tab.view } : entry)) : current.tabs;
        return { ...current, tabs, active: tab.id };
      }
      let tabs = [...current.tabs, tab];
      if (tabs.length > MAX_TABS) {
        const oldest = tabs.find((entry) => entry.kind === 'table' || entry.kind === 'object');
        if (oldest !== undefined) tabs = tabs.filter((entry) => entry !== oldest);
      }
      return { ...current, tabs, active: tab.id };
    });
    setSidebar(false);
  }, []);

  const close = useCallback(
    (id: string) => {
      setWorkspace((current) => {
        const index = current.tabs.findIndex((tab) => tab.id === id);
        const tab = current.tabs[index];
        if (tab === undefined || tab.kind === 'dashboard') return current;
        if (tab.kind === 'query') void closeSession(serviceId, tab.session);
        const tabs = current.tabs.filter((entry) => entry.id !== id);
        const active = current.active === id ? (tabs[Math.max(0, index - 1)]?.id ?? 'dashboard') : current.active;
        return { ...current, tabs, active };
      });
    },
    [serviceId],
  );

  const update = useCallback((id: string, patch: Partial<ConsoleTab>) => {
    setWorkspace((current) => ({ ...current, tabs: current.tabs.map((tab) => (tab.id === id ? ({ ...tab, ...patch } as ConsoleTab) : tab)) }));
  }, []);

  const setDatabase = useCallback((name: string) => setWorkspace((current) => ({ ...current, database: name })), []);

  // Scroll the active tab into view in the strip.
  useEffect(() => {
    tabStrip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [workspace.active]);

  const titles = useMemo(() => {
    let queries = 0;
    return new Map(
      workspace.tabs.map((tab) => {
        switch (tab.kind) {
          case 'dashboard':
            return [tab.id, m.db.tabs.dashboard];
          case 'activity':
            return [tab.id, m.db.tabs.activity];
          case 'roles':
            return [tab.id, overview.data?.type === 'postgres' ? m.db.tabs.roles : m.db.tabs.users];
          case 'query': {
            queries += 1;
            const first = tab.sql.split('\n').map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith('--'));
            return [tab.id, tab.title || (first === undefined ? `${m.db.tabs.query} ${queries}` : first.length > 28 ? `${first.slice(0, 28)}…` : first)];
          }
          default:
            return [tab.id, tab.name];
        }
      }),
    );
  }, [workspace.tabs, m, overview.data?.type]);

  if (service.isError) return <NotFound />;
  if (service.data !== undefined && !supported) {
    return (
      <div className="page">
        <EmptyState icon={<Table2 />} title={m.db.unsupportedTitle} action={<Link to={`/services/${serviceId}/general`}>{m.db.back}</Link>}>
          {m.db.unsupportedText}
        </EmptyState>
      </div>
    );
  }

  const icon = (tab: ConsoleTab) => {
    switch (tab.kind) {
      case 'dashboard':
        return <LayoutDashboard aria-hidden="true" />;
      case 'activity':
        return <Activity aria-hidden="true" />;
      case 'roles':
        return <KeyRound aria-hidden="true" />;
      case 'query':
        return <FileCode2 aria-hidden="true" />;
      case 'table':
        return tab.objectKind === 'view' ? <Eye aria-hidden="true" /> : <Table2 aria-hidden="true" />;
      default:
        return OBJECT_ICON[tab.objectKind];
    }
  };

  const data = service.data;
  return (
    <div className="dbc">
      <header className="dbc__head">
        <Link to={`/services/${serviceId}/general`} className="dbc__back" aria-label={m.db.back}>
          <ArrowLeft aria-hidden="true" />
        </Link>
        <span className="dbc__mark">{data !== undefined && <ServiceMark type={data.type} />}</span>
        <div className="dbc__name">
          <h1 className="truncate">{data?.name ?? <Skeleton width={140} height={20} />}</h1>
          <span className="dbc__meta">
            {overview.data !== undefined ? (
              <>
                {m.project.databaseLabel[overview.data.type]} {overview.data.version.split(' ')[0]} · <code>{overview.data.user}</code>
              </>
            ) : data !== undefined ? (
              `${m.project.databaseLabel[data.type]} ${data.version}`
            ) : null}
          </span>
        </div>
        {data !== undefined && (
          <span className="dbc__status">
            <Status kind="service" status={data.status} />
          </span>
        )}
        <span className="grow" />
        <Button size="sm" variant="ghost" className="dbc__sidetoggle" iconOnly icon={<PanelLeft />} aria-pressed={sidebar} onClick={() => setSidebar(!sidebar)}>
          {m.db.tree.title}
        </Button>
        {overview.data !== undefined && (
          <Button
            size="sm"
            variant="primary"
            icon={<Plus />}
            onClick={() => open({ id: `query:${newSessionId()}`, kind: 'query', title: '', sql: '', session: newSessionId(), database, limit: 1_000, readOnly: false })}
            aria-label={m.db.tabs.newQuery}
          >
            <span className="dbc__new-label">{m.db.tabs.newQuery}</span>
          </Button>
        )}
      </header>

      {overview.isLoading && (
        <div className="dbc__state">
          <span className="spinner" aria-hidden="true" />
          <p>{m.db.connecting}</p>
        </div>
      )}
      {overview.error !== null && overview.error !== undefined && (
        <div className="dbc__state">
          <Callout tone="bad" title={m.db.unreachableTitle} action={<Button icon={<RefreshCw />} onClick={() => void overview.refetch()} busy={overview.isFetching}>{m.common.retry}</Button>}>
            <p>{errorText(m, overview.error)}</p>
            <p className="muted">{data?.status === 'running' ? m.db.unreachableHint : t(m.db.notRunningHint, { status: data?.status ?? '' })}</p>
          </Callout>
        </div>
      )}

      {data !== undefined && overview.data !== undefined && (
        <ConsoleProvider service={data} overview={overview.data} database={database} setDatabase={setDatabase} tree={tree.data} open={open} closeTab={close}>
          <div className="dbc__body">
            <aside className="dbc__side" data-open={sidebar || undefined}>
              <Tree tree={tree.data} loading={tree.isLoading} error={tree.error} onRefresh={() => void tree.refetch()} refreshing={tree.isFetching} />
            </aside>
            {sidebar && <button type="button" className="dbc__scrim" aria-label={m.common.close} onClick={() => setSidebar(false)} />}
            <section className="dbc__main">
              <div className="dbc__tabs" role="tablist" ref={tabStrip}>
                {workspace.tabs.map((tab) => (
                  <div
                    key={tab.id}
                    className="dbc__tab"
                    role="tab"
                    aria-selected={workspace.active === tab.id}
                    data-kind={tab.kind}
                    tabIndex={0}
                    title={tab.kind === 'table' || tab.kind === 'object' ? `${tab.database} · ${tab.schema === null ? '' : `${tab.schema}.`}${tab.name}` : titles.get(tab.id)}
                    onClick={() => setWorkspace((current) => ({ ...current, active: tab.id }))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') setWorkspace((current) => ({ ...current, active: tab.id }));
                    }}
                    onAuxClick={(event: ReactMouseEvent) => {
                      if (event.button === 1) close(tab.id);
                    }}
                  >
                    {icon(tab)}
                    <span className="dbc__tab-label">{titles.get(tab.id)}</span>
                    {tab.kind !== 'dashboard' && (
                      <button
                        type="button"
                        className="dbc__tab-close"
                        aria-label={t(m.db.tabs.close, { name: titles.get(tab.id) ?? '' })}
                        onClick={(event) => {
                          event.stopPropagation();
                          close(tab.id);
                        }}
                      >
                        <X aria-hidden="true" />
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  className="dbc__tab-add"
                  aria-label={m.db.tabs.newQuery}
                  onClick={() => open({ id: `query:${newSessionId()}`, kind: 'query', title: '', sql: '', session: newSessionId(), database, limit: 1_000, readOnly: false })}
                >
                  <Plus aria-hidden="true" />
                </button>
              </div>
              <div className="dbc__panes">
                {workspace.tabs.map((tab) => {
                  const visible = workspace.active === tab.id;
                  switch (tab.kind) {
                    case 'dashboard':
                      return <DashboardTab key={tab.id} visible={visible} />;
                    case 'activity':
                      return <ActivityTab key={tab.id} visible={visible} />;
                    case 'roles':
                      return <RolesTab key={tab.id} visible={visible} />;
                    case 'query':
                      return <QueryTab key={tab.id} tab={tab} visible={visible} onChange={(patch) => update(tab.id, patch)} />;
                    case 'table':
                      return <TableTab key={tab.id} tab={tab} visible={visible} onChange={(patch) => update(tab.id, patch)} />;
                    case 'object':
                      return <ObjectTab key={tab.id} tab={tab} visible={visible} />;
                  }
                })}
              </div>
            </section>
          </div>
        </ConsoleProvider>
      )}
    </div>
  );
}

export const Component = DatabaseConsolePage;
