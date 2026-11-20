/**
 * Monitoring: the app as it is this moment — processor, memory, network and
 * containers as live gauges that move when the numbers do — and the same
 * numbers over time, as charts.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Box, Cpu, MemoryStick, Network } from 'lucide-react';
import { METRIC_RANGES, type AppMetricPoint, type ContainerDto, type MetricRange } from '@ploy/shared';
import { AreaChart, smoothPath } from '../../components/Chart.tsx';
import { Card } from '../../components/Frame.tsx';
import { StatusMark } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Callout, Segmented, Skeleton, type Tone } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useAppContainers, useAppMetrics } from '../../lib/queries.ts';
import { useAppContext } from './AppLayout.tsx';

export function ResourceCharts({ points, limits, range }: { points: AppMetricPoint[] | undefined; limits: { cpu: number | null; memoryMb: number | null }; range?: MetricRange }) {
  const { m, t, formatBytes, formatNumber } = useI18n();
  if (points === undefined) {
    return (
      <div className="chart-grid">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} height={220} />
        ))}
      </div>
    );
  }
  const last = points[points.length - 1];
  const memLimit = limits.memoryMb !== null ? limits.memoryMb * 1024 * 1024 : (last?.memLimit ?? 0);
  const percent = (value: number) => `${formatNumber(value, { maximumFractionDigits: value < 10 ? 1 : 0 })}%`;
  // A new range is a new picture: the charts are drawn in again. A refresh of the same range just moves them on.
  const drawn = range ?? 'all';
  return (
    <div className="chart-grid">
      <AreaChart
        key={`cpu-${drawn}`}
        title={m.metrics.cpu}
        headline={last === undefined ? undefined : percent(last.cpu)}
        sub={limits.cpu === null ? m.metrics.noLimit : t(m.metrics.ofLimit, { limit: `${limits.cpu} vCPU` })}
        series={[{ label: m.metrics.cpu, color: 'var(--info)', values: points.map((point) => ({ t: point.t, v: point.cpu })) }]}
        format={percent}
        {...(limits.cpu === null ? {} : { max: limits.cpu * 100 })}
      />
      <AreaChart
        key={`mem-${drawn}`}
        title={m.metrics.memory}
        headline={last === undefined ? undefined : formatBytes(last.mem)}
        sub={limits.memoryMb === null ? m.metrics.noLimit : t(m.metrics.ofLimit, { limit: formatBytes(memLimit, 0) })}
        series={[{ label: m.metrics.memory, color: 'var(--ok)', values: points.map((point) => ({ t: point.t, v: point.mem })) }]}
        format={(value) => formatBytes(value)}
        {...(limits.memoryMb === null ? {} : { max: memLimit })}
      />
      <AreaChart
        key={`net-${drawn}`}
        title={m.metrics.network}
        headline={last === undefined ? undefined : `${formatBytes(last.rx)}${m.units.perSecond}`}
        series={[
          { label: m.metrics.inbound, color: 'var(--info)', values: points.map((point) => ({ t: point.t, v: point.rx })) },
          { label: m.metrics.outbound, color: 'var(--work)', values: points.map((point) => ({ t: point.t, v: point.tx })) },
        ]}
        format={(value) => `${formatBytes(value)}${m.units.perSecond}`}
      />
    </div>
  );
}

export function RangePicker({ value, onChange }: { value: MetricRange; onChange: (value: MetricRange) => void }) {
  const { m } = useI18n();
  return <Segmented label={m.app.tabs.monitoring} value={value} onChange={onChange} options={METRIC_RANGES.map((range) => ({ value: range, label: m.metrics.ranges[range] }))} />;
}

const reducedMotion = (): boolean => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A number that travels to its new value instead of jumping there. */
function useTravelling(target: number, duration = 700): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (reducedMotion() || !Number.isFinite(target)) {
      from.current = target;
      setValue(target);
      return;
    }
    const start = from.current;
    const began = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - began) / duration);
      const eased = 1 - (1 - progress) ** 3;
      const next = start + (target - start) * eased;
      from.current = next;
      setValue(next);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);
  return value;
}

const RING = 2 * Math.PI * 26;

/** How full: a ring that fills to `share` (0–1), with the mark of what it measures in the middle. */
function Ring({ share, tone, children }: { share: number | null; tone: Tone; children: ReactNode }) {
  // Starts empty, so the first value sweeps in like every later change does.
  const [shown, setShown] = useState(0);
  useEffect(() => setShown(share ?? 0), [share]);
  return (
    <span className="gauge__ring" data-state={tone}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle className="gauge__track" cx="32" cy="32" r="26" />
        {share !== null && <circle className="gauge__fill" cx="32" cy="32" r="26" strokeDasharray={RING} strokeDashoffset={RING * (1 - Math.max(0.015, Math.min(1, shown)))} />}
      </svg>
      <span className="gauge__icon">{children}</span>
    </span>
  );
}

/** The last stretch of a series, as a line small enough to sit beside a number. */
function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return null;
  const top = Math.max(...values, 1e-9) * 1.1;
  const width = 96;
  const height = 28;
  const d = smoothPath(values.map((value, index) => [(index / (values.length - 1)) * width, height - 2 - (value / top) * (height - 4)] as const));
  return (
    <svg className="gauge__spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} pathLength={1} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const shareTone = (share: number | null, limited: boolean): Tone => (share === null ? 'idle' : !limited ? 'info' : share >= 0.9 ? 'bad' : share >= 0.75 ? 'work' : 'ok');

/** The app right now. Every number here moves to its next value; nothing jumps. */
function LiveGauges({ points, containers, limits, live, updatedAt }: { points: AppMetricPoint[] | undefined; containers: ContainerDto[] | undefined; limits: { cpu: number | null; memoryMb: number | null }; live: boolean; updatedAt: number }) {
  const { m, t, formatBytes, formatNumber } = useI18n();
  const g = m.monitoring;
  const last = live ? points?.at(-1) : undefined;
  const recent = live ? (points ?? []).slice(-24) : [];
  const peak = (pick: (point: AppMetricPoint) => number) => Math.max(0, ...(points ?? []).map(pick));

  const cpu = useTravelling(last?.cpu ?? 0);
  const mem = useTravelling(last?.mem ?? 0);
  const rx = useTravelling(last?.rx ?? 0);
  const tx = useTravelling(last?.tx ?? 0);

  // Against the limit when there is one; otherwise against a whole core, the container's own limit, or the busiest moment shown.
  const cpuShare = last === undefined ? null : Math.min(1, last.cpu / (limits.cpu !== null ? limits.cpu * 100 : Math.max(100, peak((point) => point.cpu))));
  const memCeiling = limits.memoryMb !== null ? limits.memoryMb * 1024 * 1024 : last !== undefined && last.memLimit > 0 ? last.memLimit : peak((point) => point.mem) * 1.5;
  const memShare = last === undefined || memCeiling <= 0 ? null : Math.min(1, last.mem / memCeiling);
  const netTop = Math.max(1, peak((point) => point.rx), peak((point) => point.tx));
  const running = containers?.filter((container) => container.state === 'running').length ?? 0;
  const total = containers?.length ?? 0;
  const restarts = containers?.reduce((sum, container) => sum + container.restartCount, 0) ?? 0;
  const containerTone = (container: ContainerDto): Tone => (container.state === 'running' ? (container.health === 'unhealthy' ? 'work' : 'ok') : container.state === 'restarting' ? 'work' : 'bad');
  const dash = last === undefined;

  return (
    <section className="card gauges" data-live={live || undefined}>
      <header className="gauges__head">
        <span className="gauges__live">
          <span className="gauges__pulse" aria-hidden="true" />
          {live ? g.live : g.notLive}
        </span>
        <span className="gauges__note">{live ? t(g.refreshEvery, { seconds: 15 }) : g.notLiveHint}</span>
        {/* Runs down between refreshes and starts again when fresh numbers arrive. */}
        {live && (
          <svg key={updatedAt} className="gauges__timer" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="7" />
            <circle cx="10" cy="10" r="7" pathLength={1} />
          </svg>
        )}
      </header>
      <div className="gauges__grid">
        <div className="gauge">
          <Ring share={cpuShare} tone={shareTone(cpuShare, limits.cpu !== null)}>
            <Cpu />
          </Ring>
          <div className="gauge__body">
            <span className="gauge__label">{m.metrics.cpu}</span>
            <strong className="gauge__value tabular">{dash ? '—' : `${formatNumber(cpu, { maximumFractionDigits: cpu < 10 ? 1 : 0, minimumFractionDigits: cpu < 10 ? 1 : 0 })}%`}</strong>
            <span className="gauge__sub">{limits.cpu === null ? m.metrics.noLimit : t(m.metrics.ofLimit, { limit: `${limits.cpu} vCPU` })}</span>
          </div>
          <Spark values={recent.map((point) => point.cpu)} color="var(--info)" />
        </div>
        <div className="gauge">
          <Ring share={memShare} tone={shareTone(memShare, limits.memoryMb !== null)}>
            <MemoryStick />
          </Ring>
          <div className="gauge__body">
            <span className="gauge__label">{m.metrics.memory}</span>
            <strong className="gauge__value tabular">{dash ? '—' : formatBytes(mem)}</strong>
            <span className="gauge__sub">{limits.memoryMb === null ? m.metrics.noLimit : t(m.metrics.ofLimit, { limit: formatBytes(limits.memoryMb * 1024 * 1024, 0) })}</span>
          </div>
          <Spark values={recent.map((point) => point.mem)} color="var(--ok)" />
        </div>
        <div className="gauge gauge--net">
          <span className="gauge__ring" data-state="idle">
            <span className="gauge__icon">
              <Network />
            </span>
          </span>
          <div className="gauge__body">
            <span className="gauge__label">{m.metrics.network}</span>
            <div className="flow" data-moving={!dash || undefined}>
              <ArrowDown aria-hidden="true" />
              <span className="flow__name">{m.metrics.inbound}</span>
              <span className="flow__bar flow__bar--in">
                <i style={{ width: `${dash ? 0 : Math.max(4, Math.round((rx / netTop) * 100))}%` }} />
              </span>
              <strong className="tabular">{dash ? '—' : `${formatBytes(rx)}${m.units.perSecond}`}</strong>
            </div>
            <div className="flow" data-moving={!dash || undefined}>
              <ArrowUp aria-hidden="true" />
              <span className="flow__name">{m.metrics.outbound}</span>
              <span className="flow__bar flow__bar--out">
                <i style={{ width: `${dash ? 0 : Math.max(4, Math.round((tx / netTop) * 100))}%` }} />
              </span>
              <strong className="tabular">{dash ? '—' : `${formatBytes(tx)}${m.units.perSecond}`}</strong>
            </div>
          </div>
        </div>
        <div className="gauge">
          <Ring share={total === 0 ? null : running / total} tone={total === 0 ? 'idle' : running === total ? 'ok' : running === 0 ? 'bad' : 'work'}>
            <Box />
          </Ring>
          <div className="gauge__body">
            <span className="gauge__label">{m.appOverview.containers}</span>
            <strong className="gauge__value tabular">{containers === undefined ? <Skeleton width={56} height={20} /> : total === 0 ? '—' : `${running}/${total}`}</strong>
            <span className="gauge__sub">{total === 0 ? g.noContainers : restarts > 0 ? t(m.appOverview.restartCount, { count: restarts }) : g.noRestarts}</span>
          </div>
          {total > 0 && (
            <span className="gauge__dots" aria-hidden="true">
              {containers!.slice(0, 12).map((container) => (
                <i key={container.name} data-state={containerTone(container)} />
              ))}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function ContainersCard({ containers, compose }: { containers: ContainerDto[]; compose: boolean }) {
  const { m, t } = useI18n();
  const tone = (container: ContainerDto) => (container.state === 'running' ? (container.health === 'unhealthy' ? 'work' : 'ok') : container.state === 'restarting' ? 'work' : 'bad');
  return (
    <Card title={compose ? m.compose.services : m.appOverview.containers} description={m.monitoring.containersHint} flush>
      <div className="list">
        {containers.map((container) => (
          <div key={container.name} className="list__row">
            <StatusMark tone={tone(container)} label={container.service ?? t(m.terminal.replicaN, { n: container.replica + 1 })} />
            <code className="faint truncate grow" style={{ fontSize: 'var(--text-xs)' }}>
              {container.name}
            </code>
            <span className="faint" style={{ fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
              {container.state === 'running' && container.startedAt !== null ? (
                <>
                  {m.appOverview.upSince} <RelativeTime value={container.startedAt} />
                </>
              ) : (
                (m.appOverview.containerStates[container.state as keyof typeof m.appOverview.containerStates] ?? container.state)
              )}
              {container.restartCount > 0 && `, ${t(m.appOverview.restartCount, { count: container.restartCount })}`}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function MonitoringTab() {
  const app = useAppContext();
  const { m } = useI18n();
  const [range, setRange] = useState<MetricRange>('1h');
  const metrics = useAppMetrics(app.id, range);
  // The gauges always read the latest hour, whatever range the charts are on.
  const recent = useAppMetrics(app.id, '1h');
  const containers = useAppContainers(app.id);
  const deployed = app.activeDeployment !== null;
  const live = deployed && app.status !== 'stopped';
  const list = deployed ? (containers.data ?? []) : [];
  const limits = { cpu: app.cpuLimit, memoryMb: app.memoryLimitMb };
  return (
    <>
      {!deployed && <Callout tone="info" title={m.monitoring.neverTitle}>{m.monitoring.neverText}</Callout>}
      <LiveGauges points={recent.data?.points} containers={deployed ? (containers.isError ? [] : containers.data) : []} limits={limits} live={live} updatedAt={recent.dataUpdatedAt} />
      <Card title={m.monitoring.resourcesTitle} description={m.monitoring.resourcesHint} actions={<RangePicker value={range} onChange={setRange} />}>
        <ResourceCharts points={metrics.data?.points} limits={limits} range={range} />
      </Card>
      {list.length > 0 && <ContainersCard containers={list} compose={app.kind === 'compose'} />}
    </>
  );
}
