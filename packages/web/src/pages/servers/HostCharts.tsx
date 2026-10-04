/** A server's CPU, memory, disk and load over time, with the range picker. */
import { useState, type ReactNode } from 'react';
import type { MetricRange } from '@ploy/shared';
import { AreaChart } from '../../components/Chart.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useServerMetrics } from '../../lib/queries.ts';
import { RangePicker } from '../app/Metrics.tsx';

export function HostCharts({ serverId, actions }: { serverId: string; actions?: (picker: ReactNode) => ReactNode }) {
  const { m, formatBytes, formatNumber } = useI18n();
  const [range, setRange] = useState<MetricRange>('1h');
  const metrics = useServerMetrics(serverId, range);
  const points = metrics.data?.points ?? [];
  const latest = metrics.data?.latest ?? null;
  const pct = (value: number) => `${formatNumber(value, { maximumFractionDigits: value < 10 ? 1 : 0 })}%`;
  const picker = <RangePicker value={range} onChange={setRange} />;
  return (
    <>
      {actions === undefined ? <div>{picker}</div> : actions(picker)}
      <div className="chart-grid">
        <AreaChart
          title={m.metrics.cpu}
          headline={latest === null ? undefined : pct(latest.cpu)}
          series={[{ label: m.metrics.cpu, color: 'var(--info)', values: points.map((point) => ({ t: point.t, v: point.cpu })) }]}
          format={pct}
          max={100}
        />
        <AreaChart
          title={m.metrics.memory}
          headline={latest === null ? undefined : `${formatBytes(latest.memUsed)} / ${formatBytes(latest.memTotal, 0)}`}
          series={[{ label: m.metrics.memory, color: 'var(--ok)', values: points.map((point) => ({ t: point.t, v: point.memUsed })) }]}
          format={(value) => formatBytes(value)}
          {...(latest === null ? {} : { max: latest.memTotal })}
        />
        <AreaChart
          title={m.metrics.disk}
          headline={latest === null ? undefined : `${formatBytes(latest.diskUsed)} / ${formatBytes(latest.diskTotal, 0)}`}
          series={[{ label: m.metrics.disk, color: 'var(--work)', values: points.map((point) => ({ t: point.t, v: point.diskUsed })) }]}
          format={(value) => formatBytes(value)}
          {...(latest === null ? {} : { max: latest.diskTotal })}
        />
        <AreaChart
          title={m.metrics.load}
          headline={latest === null ? undefined : formatNumber(latest.load1, { maximumFractionDigits: 2 })}
          series={[{ label: m.metrics.load, color: 'var(--bad)', values: points.map((point) => ({ t: point.t, v: point.load1 })) }]}
          format={(value) => formatNumber(value, { maximumFractionDigits: 2 })}
        />
      </div>
    </>
  );
}
