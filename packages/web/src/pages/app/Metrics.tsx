/** Monitoring: what each container is doing now, and CPU, memory and network over time. */
import { useState } from 'react';
import { METRIC_RANGES, type AppMetricPoint, type ContainerDto, type MetricRange } from '@ploy/shared';
import { AreaChart } from '../../components/Chart.tsx';
import { Card } from '../../components/Frame.tsx';
import { StatusMark } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Segmented, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useAppContainers, useAppMetrics } from '../../lib/queries.ts';
import { useAppContext } from './AppLayout.tsx';

export function ResourceCharts({ points, limits }: { points: AppMetricPoint[] | undefined; limits: { cpu: number | null; memoryMb: number | null } }) {
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
  return (
    <div className="chart-grid">
      <AreaChart
        title={m.metrics.cpu}
        headline={last === undefined ? undefined : percent(last.cpu)}
        sub={limits.cpu === null ? m.metrics.noLimit : t(m.metrics.ofLimit, { limit: `${limits.cpu} vCPU` })}
        series={[{ label: m.metrics.cpu, color: 'var(--info)', values: points.map((point) => ({ t: point.t, v: point.cpu })) }]}
        format={percent}
        {...(limits.cpu === null ? {} : { max: limits.cpu * 100 })}
      />
      <AreaChart
        title={m.metrics.memory}
        headline={last === undefined ? undefined : formatBytes(last.mem)}
        sub={limits.memoryMb === null ? m.metrics.noLimit : t(m.metrics.ofLimit, { limit: formatBytes(memLimit, 0) })}
        series={[{ label: m.metrics.memory, color: 'var(--ok)', values: points.map((point) => ({ t: point.t, v: point.mem })) }]}
        format={(value) => formatBytes(value)}
        {...(limits.memoryMb === null ? {} : { max: memLimit })}
      />
      <AreaChart
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
  const containers = useAppContainers(app.id);
  const list = app.activeDeployment === null ? [] : (containers.data ?? []);
  return (
    <>
      {list.length > 0 && <ContainersCard containers={list} compose={app.kind === 'compose'} />}
      <Card title={m.monitoring.resourcesTitle} description={m.monitoring.resourcesHint} actions={<RangePicker value={range} onChange={setRange} />}>
        <ResourceCharts points={metrics.data?.points} limits={{ cpu: app.cpuLimit, memoryMb: app.memoryLimitMb }} />
      </Card>
    </>
  );
}
