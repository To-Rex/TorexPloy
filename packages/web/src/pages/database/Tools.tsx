/**
 * The server-wide tabs: the dashboard (what is running, how big, how busy,
 * live), the sessions connected right now (with cancel and terminate), and
 * the roles or users that can log in.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity as ActivityIcon, Ban, Clock3, Database, FolderOpen, HardDrive, KeyRound, Pause, Play, Plus, Power, ShieldCheck, Table2, Trash2, Users } from 'lucide-react';
import { sqlScripts, type DbActivityDto, type DbSessionDto } from '@ploy/shared';
import { AreaChart } from '../../components/Chart.tsx';
import { useConfirm } from '../../components/Dialog.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Badge, Button, Callout, Input, SkeletonRows, Switch, type Tone } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { errorText } from '../../lib/errors.ts';
import { useConsole } from './ConsoleContext.tsx';
import { signalSession, useDbActivity, useDbRoles } from './dbApi.ts';
import { CreateDatabaseDialog, CreateTableDialog, PasswordDialog, RoleDialog } from './SqlDialogs.tsx';

interface Sample {
  t: number;
  counters: DbActivityDto['counters'];
}

/** Keep the last few minutes of samples while the tab is open. */
function useSamples(activity: DbActivityDto | undefined): Sample[] {
  const [samples, setSamples] = useState<Sample[]>([]);
  const last = useRef(0);
  useEffect(() => {
    if (activity === undefined || activity.sampledAt === last.current) return;
    last.current = activity.sampledAt;
    setSamples((current) => [...current, { t: activity.sampledAt, counters: activity.counters }].slice(-80));
  }, [activity]);
  return samples;
}

function rates(samples: Sample[], pick: (counters: DbActivityDto['counters']) => number): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    const seconds = (current.t - previous.t) / 1_000;
    if (seconds <= 0) continue;
    out.push({ t: current.t, v: Math.max(0, (pick(current.counters) - pick(previous.counters)) / seconds) });
  }
  return out;
}

function uptime(startedAt: string | null, now: number): string {
  if (startedAt === null) return '—';
  const seconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1_000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

export function DashboardTab({ visible }: { visible: boolean }) {
  const { m, formatBytes, formatNumber, t } = useI18n();
  const confirm = useConfirm();
  const toast = useToast();
  const { service, overview, database, setDatabase, type, openQuery, openTool, runTool, refresh, dialect } = useConsole();
  const activity = useDbActivity(service.id, visible);
  const samples = useSamples(activity.data);
  const [creating, setCreating] = useState<'database' | 'table' | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [visible]);

  const databases = overview.databases.filter((db) => showSystem || !db.system);
  const largest = Math.max(1, ...databases.map((db) => db.sizeBytes ?? 0));
  const totalSize = overview.databases.filter((db) => !db.system).reduce((sum, db) => sum + (db.sizeBytes ?? 0), 0);
  const counters = activity.data?.counters;
  const connections = counters?.connections ?? overview.databases.reduce((sum, db) => sum + (db.connections ?? 0), 0);
  const usage = overview.maxConnections === null ? 0 : Math.min(1, connections / overview.maxConnections);

  const charts = useMemo(() => {
    const sessions = samples.map((sample) => ({ t: sample.t, total: sample.counters.connections, active: sample.counters.active }));
    const throughput = rates(samples, (counter) => (type === 'postgres' ? counter.commits + counter.rollbacks : (counter.queries ?? 0)));
    const rollbacks = rates(samples, (counter) => counter.rollbacks);
    const read = rates(samples, (counter) => counter.rowsRead);
    const written = rates(samples, (counter) => counter.rowsWritten);
    const hits = rates(samples, (counter) => counter.cacheHits);
    const reads = rates(samples, (counter) => counter.diskReads);
    const cache = hits.map((point, index) => {
      const disk = reads[index]?.v ?? 0;
      return { t: point.t, v: point.v + disk === 0 ? 100 : (point.v / (point.v + disk)) * 100 };
    });
    return { sessions, throughput, rollbacks, read, written, cache };
  }, [samples, type]);

  const perSecond = (value: number) => `${formatNumber(value, { maximumFractionDigits: value < 10 ? 1 : 0 })}/s`;

  return (
    <div className="dash" hidden={!visible}>
      <div className="dash__tiles">
        <div className="dash__tile">
          <span className="dash__tile-icon" data-tone="info">
            <Database aria-hidden="true" />
          </span>
          <div>
            <div className="dash__tile-label">{m.project.databaseLabel[type]}</div>
            <div className="dash__tile-value truncate" title={overview.version}>
              {overview.version.split(' ')[0]}
            </div>
            <div className="dash__tile-sub truncate" title={overview.user}>
              {overview.user}
            </div>
          </div>
        </div>
        <div className="dash__tile">
          <span className="dash__tile-icon" data-tone="ok">
            <Clock3 aria-hidden="true" />
          </span>
          <div>
            <div className="dash__tile-label">{m.db.dashboard.uptime}</div>
            <div className="dash__tile-value">{uptime(overview.startedAt, now)}</div>
            <div className="dash__tile-sub">{m.db.dashboard.running}</div>
          </div>
        </div>
        <div className="dash__tile">
          <span className="dash__tile-icon" data-tone="work">
            <HardDrive aria-hidden="true" />
          </span>
          <div>
            <div className="dash__tile-label">{m.db.dashboard.size}</div>
            <div className="dash__tile-value">{formatBytes(totalSize)}</div>
            <div className="dash__tile-sub">{t(m.db.dashboard.databasesCount, { count: overview.databases.filter((db) => !db.system).length })}</div>
          </div>
        </div>
        <div className="dash__tile">
          <span className="dash__tile-icon" data-tone={usage > 0.8 ? 'bad' : 'info'}>
            <Users aria-hidden="true" />
          </span>
          <div className="grow">
            <div className="dash__tile-label">{m.db.dashboard.connections}</div>
            <div className="dash__tile-value">
              {formatNumber(connections)}
              {overview.maxConnections !== null && <span className="dash__tile-of"> / {formatNumber(overview.maxConnections)}</span>}
            </div>
            <div className="dash__meter" aria-hidden="true">
              <span style={{ width: `${Math.round(usage * 100)}%` }} data-high={usage > 0.8 || undefined} />
            </div>
          </div>
        </div>
      </div>

      <div className="dash__quick">
        <Button size="sm" variant="primary" icon={<Play />} onClick={() => openQuery()}>
          {m.db.dashboard.newQuery}
        </Button>
        <Button size="sm" icon={<Table2 />} onClick={() => setCreating('table')}>
          {m.db.dialogs.createTable}
        </Button>
        <Button size="sm" icon={<Plus />} onClick={() => setCreating('database')}>
          {m.db.dialogs.createDatabase}
        </Button>
        <Button size="sm" icon={<ActivityIcon />} onClick={() => openTool('activity')}>
          {m.db.tabs.activity}
        </Button>
        <Button size="sm" icon={<KeyRound />} onClick={() => openTool('roles')}>
          {dialect === 'postgres' ? m.db.tabs.roles : m.db.tabs.users}
        </Button>
      </div>

      <div className="dash__charts">
        <AreaChart
          title={m.db.dashboard.sessions}
          headline={counters === undefined ? undefined : formatNumber(counters.connections)}
          sub={counters === undefined ? undefined : t(m.db.dashboard.activeNow, { count: counters.active })}
          series={[
            { label: m.db.dashboard.total, color: 'var(--info)', values: charts.sessions.map((point) => ({ t: point.t, v: point.total })) },
            { label: m.db.dashboard.active, color: 'var(--ok)', values: charts.sessions.map((point) => ({ t: point.t, v: point.active })) },
          ]}
          format={(value) => formatNumber(value, { maximumFractionDigits: 0 })}
        />
        <AreaChart
          title={type === 'postgres' ? m.db.dashboard.transactions : m.db.dashboard.queries}
          headline={charts.throughput.length === 0 ? undefined : perSecond(charts.throughput.at(-1)!.v)}
          series={[
            { label: type === 'postgres' ? m.db.dashboard.transactions : m.db.dashboard.queries, color: 'var(--info)', values: charts.throughput },
            { label: m.db.dashboard.rollbacks, color: 'var(--bad)', values: charts.rollbacks },
          ]}
          format={perSecond}
        />
        <AreaChart
          title={m.db.dashboard.rows}
          headline={charts.read.length === 0 ? undefined : perSecond(charts.read.at(-1)!.v)}
          series={[
            { label: m.db.dashboard.read, color: 'var(--ok)', values: charts.read },
            { label: m.db.dashboard.written, color: 'var(--work)', values: charts.written },
          ]}
          format={perSecond}
        />
        <AreaChart
          title={m.db.dashboard.cache}
          headline={charts.cache.length === 0 ? undefined : `${formatNumber(charts.cache.at(-1)!.v, { maximumFractionDigits: 1 })}%`}
          sub={m.db.dashboard.cacheHint}
          series={[{ label: m.db.dashboard.cache, color: 'var(--ok)', values: charts.cache }]}
          format={(value) => `${formatNumber(value, { maximumFractionDigits: 1 })}%`}
          max={100}
        />
      </div>
      {activity.error !== null && activity.error !== undefined && <Callout tone="bad">{errorText(m, activity.error)}</Callout>}

      <section className="dash__section">
        <header>
          <h3>{m.db.dashboard.databases}</h3>
          <span className="grow" />
          {overview.databases.some((db) => db.system) && <Switch checked={showSystem} onChange={setShowSystem} label={m.db.dashboard.showSystem} />}
          <Button size="sm" icon={<Plus />} onClick={() => setCreating('database')}>
            {m.db.dialogs.createDatabase}
          </Button>
        </header>
        <div className="dbtable">
          <table>
            <thead>
              <tr>
                <th>{m.db.structure.name}</th>
                <th>{m.db.dashboard.size}</th>
                {type !== 'postgres' && <th>{m.db.dashboard.tables}</th>}
                <th>{m.db.dashboard.connections}</th>
                <th>{type === 'postgres' ? m.db.dashboard.encoding : m.db.dialogs.charset}</th>
                <th>{type === 'postgres' ? m.db.dashboard.owner : m.db.dashboard.collation}</th>
                <th aria-label={m.db.table.actions} />
              </tr>
            </thead>
            <tbody>
              {databases.map((db) => (
                <tr key={db.name} data-current={db.name === database || undefined}>
                  <td>
                    <button type="button" className="dbtable__link" onClick={() => setDatabase(db.name)}>
                      <Database aria-hidden="true" />
                      <code>{db.name}</code>
                    </button>
                    {db.primary && <Badge tone="ok">{m.db.dashboard.primary}</Badge>}
                    {db.system && <Badge>{m.db.dashboard.system}</Badge>}
                  </td>
                  <td className="dash__size">
                    <span className="dash__bar" aria-hidden="true">
                      <span style={{ width: `${Math.max(2, ((db.sizeBytes ?? 0) / largest) * 100)}%` }} />
                    </span>
                    {db.sizeBytes === null ? '—' : formatBytes(db.sizeBytes)}
                  </td>
                  {type !== 'postgres' && <td>{db.tables === null ? '—' : formatNumber(db.tables)}</td>}
                  <td>{db.connections === null ? '—' : formatNumber(db.connections)}</td>
                  <td>{db.encoding ?? '—'}</td>
                  <td>{(type === 'postgres' ? db.owner : db.collation) ?? '—'}</td>
                  <td className="dbtable__actions">
                    <Button size="sm" variant="ghost" iconOnly icon={<FolderOpen />} onClick={() => setDatabase(db.name)}>
                      {m.db.dashboard.open}
                    </Button>
                    {!db.primary && !db.system && (
                      <Button
                        size="sm"
                        variant="ghost"
                        iconOnly
                        icon={<Trash2 />}
                        onClick={async () => {
                          const result = await confirm({ title: t(m.db.dashboard.dropTitle, { name: db.name }), text: m.db.dashboard.dropText, confirmLabel: m.common.delete, danger: true, typeToConfirm: db.name });
                          if (!result.confirmed) return;
                          try {
                            const run = await runTool(sqlScripts.dropDatabase(dialect, db.name), overview.defaultDatabase);
                            if (run.error !== null) toast.failure(m.db.confirm.failed, run.error.message);
                            else {
                              toast.success(m.db.dashboard.dropped);
                              if (database === db.name) setDatabase(overview.defaultDatabase);
                              refresh();
                            }
                          } catch (error) {
                            toast.error(error);
                          }
                        }}
                      >
                        {m.common.delete}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {overview.settings.length > 0 && (
        <section className="dash__section">
          <header>
            <h3>{m.db.dashboard.settings}</h3>
          </header>
          <dl className="dash__settings">
            {overview.settings.map((setting) => (
              <div key={setting.key}>
                <dt>
                  <code>{setting.key}</code>
                </dt>
                <dd title={setting.value}>{setting.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {creating === 'database' && <CreateDatabaseDialog onClose={() => setCreating(null)} />}
      {creating === 'table' && <CreateTableDialog schema={null} onClose={() => setCreating(null)} />}
    </div>
  );
}

const STATE_TONE: Record<string, Tone> = { active: 'ok', idle: 'idle', 'idle in transaction': 'work', 'idle in transaction (aborted)': 'bad' };

export function ActivityTab({ visible }: { visible: boolean }) {
  const { m, formatNumber, t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const { service, refresh } = useConsole();
  const [live, setLive] = useState(true);
  const [hideIdle, setHideIdle] = useState(false);
  const [filter, setFilter] = useState('');
  const activity = useDbActivity(service.id, visible && live);
  const sessions = (activity.data?.sessions ?? []).filter(
    (session) =>
      (!hideIdle || session.state !== 'idle') &&
      (filter.length === 0 || [session.user, session.database, session.query, session.client, session.application].some((value) => value?.toLowerCase().includes(filter.toLowerCase()))),
  );

  const signal = async (session: DbSessionDto, action: 'cancel' | 'terminate') => {
    if (action === 'terminate') {
      const result = await confirm({ title: t(m.db.activity.terminateTitle, { pid: session.pid }), text: m.db.activity.terminateText, confirmLabel: m.db.activity.terminate, danger: true });
      if (!result.confirmed) return;
    }
    try {
      const done = await signalSession(service.id, session.pid, action);
      if (done.ok) toast.success(action === 'cancel' ? m.db.activity.cancelled : m.db.activity.terminated);
      else toast.info(m.db.activity.nothing);
      void activity.refetch();
      refresh();
    } catch (error) {
      toast.error(error);
    }
  };

  return (
    <div className="dbtool" hidden={!visible}>
      <div className="dbtool__bar">
        <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={m.db.activity.search} aria-label={m.db.activity.search} />
        <Switch checked={hideIdle} onChange={setHideIdle} label={m.db.activity.hideIdle} />
        <span className="grow" />
        <span className="muted">{t(m.db.activity.count, { count: formatNumber(sessions.length) })}</span>
        <Button size="sm" variant={live ? 'secondary' : 'primary'} icon={live ? <Pause /> : <Play />} onClick={() => setLive(!live)}>
          {live ? m.db.activity.pause : m.db.activity.resume}
        </Button>
      </div>
      {activity.isLoading && <SkeletonRows rows={5} />}
      {activity.error !== null && activity.error !== undefined && <Callout tone="bad">{errorText(m, activity.error)}</Callout>}
      <div className="dbtable dbtable--sessions">
        <table>
          <thead>
            <tr>
              <th>PID</th>
              <th>{m.db.activity.user}</th>
              <th>{m.db.activity.state}</th>
              <th>{m.db.activity.duration}</th>
              <th>{m.db.activity.query}</th>
              <th aria-label={m.db.table.actions} />
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.pid} data-own={session.own || undefined}>
                <td className="mono">
                  {session.pid}
                  {session.own && <Badge tone="info">{m.db.activity.console}</Badge>}
                </td>
                <td>
                  <div>{session.user ?? '—'}</div>
                  <div className="muted dbtable__sub">
                    {session.database ?? ''}
                    {session.client !== null && ` · ${session.client}`}
                  </div>
                  {session.application !== null && <div className="muted dbtable__sub">{session.application}</div>}
                </td>
                <td>
                  <Badge tone={STATE_TONE[session.state ?? ''] ?? 'idle'}>{session.state ?? '—'}</Badge>
                  {session.wait !== null && <div className="muted dbtable__sub">{session.wait}</div>}
                </td>
                <td className="mono">{session.durationSec === null ? '—' : `${formatNumber(session.durationSec)} s`}</td>
                <td className="dbtable__query">
                  <code title={session.query ?? ''}>{session.query ?? ''}</code>
                </td>
                <td className="dbtable__actions">
                  {!session.own && session.state === 'active' && (
                    <Button size="sm" variant="ghost" icon={<Ban />} onClick={() => void signal(session, 'cancel')}>
                      {m.db.activity.cancel}
                    </Button>
                  )}
                  {!session.own && (
                    <Button size="sm" variant="ghost" iconOnly icon={<Power />} onClick={() => void signal(session, 'terminate')}>
                      {m.db.activity.terminate}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RolesTab({ visible }: { visible: boolean }) {
  const { m, t } = useI18n();
  const { service, dialect, execute, overview } = useConsole();
  const roles = useDbRoles(service.id);
  const [creating, setCreating] = useState(false);
  const [password, setPassword] = useState<{ name: string; host: string | null } | null>(null);
  const current = overview.user.split('@')[0];
  return (
    <div className="dbtool" hidden={!visible}>
      <div className="dbtool__bar">
        <h3 className="dbtool__title">{dialect === 'postgres' ? m.db.tabs.roles : m.db.tabs.users}</h3>
        <span className="grow" />
        <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
          {dialect === 'postgres' ? m.db.dialogs.createRole : m.db.dialogs.createUser}
        </Button>
      </div>
      {roles.isLoading && <SkeletonRows rows={4} />}
      {roles.error !== null && roles.error !== undefined && <Callout tone="bad">{errorText(m, roles.error)}</Callout>}
      <div className="dbtable">
        <table>
          <thead>
            <tr>
              <th>{m.db.roles.name}</th>
              <th>{m.db.roles.attributes}</th>
              <th>{dialect === 'postgres' ? m.db.roles.memberOf : m.db.roles.databases}</th>
              <th aria-label={m.db.table.actions} />
            </tr>
          </thead>
          <tbody>
            {(roles.data ?? []).map((role) => (
              <tr key={`${role.name}@${role.host ?? ''}`}>
                <td>
                  <span className="dbtable__name">
                    <code>{role.name}</code>
                    {role.host !== null && <span className="muted">@{role.host}</span>}
                    {role.primary && <Badge tone="ok">{m.db.roles.primary}</Badge>}
                    {role.name === current && <Badge tone="info">{m.db.roles.you}</Badge>}
                  </span>
                  {role.plugin !== null && <div className="muted dbtable__sub">{role.plugin}</div>}
                </td>
                <td>
                  <span className="dbtable__badges">
                    {role.superuser && (
                      <Badge tone="work" icon={<ShieldCheck aria-hidden="true" />}>
                        {m.db.roles.superuser}
                      </Badge>
                    )}
                    {role.canLogin ? <Badge tone="ok">{m.db.roles.canLogin}</Badge> : <Badge>{dialect === 'postgres' ? m.db.roles.noLogin : m.db.roles.locked}</Badge>}
                    {role.createDb && <Badge>{m.db.roles.createDb}</Badge>}
                    {role.createRole && <Badge>{m.db.roles.createRole}</Badge>}
                    {role.connectionLimit !== null && <Badge>{t(m.db.roles.limit, { count: role.connectionLimit })}</Badge>}
                    {role.validUntil !== null && <Badge>{t(m.db.roles.validUntil, { date: role.validUntil })}</Badge>}
                  </span>
                </td>
                <td className="dbtable__comment">{role.memberOf.join(', ') || '—'}</td>
                <td className="dbtable__actions">
                  <Button size="sm" variant="ghost" iconOnly icon={<KeyRound />} onClick={() => setPassword({ name: role.name, host: role.host })}>
                    {m.db.roles.changePassword}
                  </Button>
                  {!role.primary && role.name !== current && (
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon={<Trash2 />}
                      onClick={() => execute({ title: t(m.db.roles.dropTitle, { name: role.name }), sql: sqlScripts.dropRole(dialect, role.name, role.host ?? '%'), danger: true, confirmLabel: m.common.delete, description: m.db.roles.dropText, onDone: () => void roles.refetch() })}
                    >
                      {m.common.delete}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && <RoleDialog onClose={() => setCreating(false)} />}
      {password !== null && <PasswordDialog name={password.name} host={password.host} onClose={() => setPassword(null)} />}
    </div>
  );
}
