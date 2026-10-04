import { useState } from 'react';
import { METRIC_RANGES, type AppMetricPoint, type MetricRange } from '@ploy/shared';
import { AreaChart } from '../../components/Chart.tsx';
import { Segmented, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useAppMetrics } from '../../lib/queries.ts';
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
        series={[{ label: m.metrics.cpu, color: 'var(--lapis)', values: points.map((point) => ({ t: point.t, v: point.cpu })) }]}
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
          { label: m.metrics.inbound, color: 'var(--lapis)', values: points.map((point) => ({ t: point.t, v: point.rx })) },
          { label: m.metrics.outbound, color: 'var(--work)', values: points.map((point) => ({ t: point.t, v: point.tx })) },
        ]}
        format={(value) => `${formatBytes(value)}${m.units.perSecond}`}
      />
    </div>
  );
}

export function RangePicker({ value, onChange }: { value: MetricRange; onChange: (value: MetricRange) => void }) {
  const { m } = useI18n();
  return <Segmented label={m.app.tabs.metrics} value={value} onChange={onChange} options={METRIC_RANGES.map((range) => ({ value: range, label: m.metrics.ranges[range] }))} />;
}

export function MetricsTab() {
  const app = useAppContext();
  const [range, setRange] = useState<MetricRange>('1h');
  const metrics = useAppMetrics(app.id, range);
  return (
    <div className="stack">
      <div>
        <RangePicker value={range} onChange={setRange} />
      </div>
      <ResourceCharts points={metrics.data?.points} limits={{ cpu: app.cpuLimit, memoryMb: app.memoryLimitMb }} />
    </div>
  );
}
