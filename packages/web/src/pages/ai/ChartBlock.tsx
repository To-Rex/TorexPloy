/**
 * Charts in TorexAi's replies. The assistant writes a small JSON object in a
 * `chart` code block; this draws it. A "metric" chart names a resource
 * and is drawn from the panel's own history, so the numbers come from the
 * dashboard and not from what a model typed.
 */
import { useMemo, useState } from 'react';
import { parseAiChart, type AiChartSpec } from '@ploy/shared';
import { AreaChart, smoothPath } from '../../components/Chart.tsx';
import { Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useQuery } from '@tanstack/react-query';
import type { AppMetricPoint, HostMetricPoint } from '@ploy/shared';
import { api, qs } from '../../lib/api.ts';
import { keys } from '../../lib/queries.ts';
import { CodeBlock } from './Markdown.tsx';

const COLORS = ['var(--info)', 'var(--ok)', 'var(--work)', 'var(--bad)', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];
const W = 640;
const H = 240;
const PAD = { top: 12, right: 14, bottom: 30, left: 46 };

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10) * power;
}

function Legend({ items }: { items: { name: string; color: string; value?: string }[] }) {
  return (
    <div className="tai-chart__legend">
      {items.map((item) => (
        <span key={item.name}>
          <i style={{ background: item.color }} aria-hidden="true" />
          {item.name}
          {item.value !== undefined && <b>{item.value}</b>}
        </span>
      ))}
    </div>
  );
}

function Cartesian({ spec }: { spec: Extract<AiChartSpec, { type: 'line' | 'area' | 'bar' }> }) {
  const { formatNumber } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const unit = spec.unit ?? '';
  const format = (value: number): string => `${formatNumber(value, { maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1 })}${unit}`;
  const values = spec.series.flatMap((series) => series.data.filter((value): value is number => value !== null));
  const low = Math.min(0, ...values);
  const high = niceMax(Math.max(...values, 0) - low) + low;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const count = spec.x.length;
  const bar = spec.type === 'bar';
  const step = bar ? innerW / count : count > 1 ? innerW / (count - 1) : 0;
  const xOf = (index: number): number => PAD.left + (bar ? step * (index + 0.5) : count > 1 ? step * index : innerW / 2);
  const yOf = (value: number): number => PAD.top + innerH - ((value - low) / (high - low || 1)) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((part) => low + (high - low) * part);
  const labelEvery = Math.max(1, Math.ceil(count / 8));
  const group = bar ? Math.min(46, (step * 0.72) / spec.series.length) : 0;

  return (
    <figure className="tai-chart">
      {spec.title !== undefined && <figcaption>{spec.title}</figcaption>}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spec.title ?? 'chart'} onPointerLeave={() => setHover(null)} onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const x = ((event.clientX - box.left) / box.width) * W - PAD.left;
        const index = bar ? Math.floor(x / step) : Math.round(x / (step || 1));
        setHover(index >= 0 && index < count ? index : null);
      }}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="tai-chart__grid" x1={PAD.left} x2={W - PAD.right} y1={yOf(tick)} y2={yOf(tick)} />
            <text className="tai-chart__axis" x={PAD.left - 8} y={yOf(tick) + 4} textAnchor="end">
              {format(tick)}
            </text>
          </g>
        ))}
        {spec.x.map((label, index) =>
          index % labelEvery === 0 ? (
            <text key={index} className="tai-chart__axis" x={xOf(index)} y={H - 10} textAnchor="middle">
              {String(label).length > 12 ? `${String(label).slice(0, 11)}…` : String(label)}
            </text>
          ) : null,
        )}
        {hover !== null && !bar && <line className="tai-chart__cursor" x1={xOf(hover)} x2={xOf(hover)} y1={PAD.top} y2={PAD.top + innerH} />}
        {spec.series.map((series, seriesIndex) => {
          const color = COLORS[seriesIndex % COLORS.length]!;
          if (bar) {
            return series.data.map((value, index) =>
              value === null ? null : (
                <rect
                  key={`${seriesIndex}-${index}`}
                  x={xOf(index) - (group * spec.series.length) / 2 + group * seriesIndex + 1}
                  width={Math.max(1, group - 2)}
                  y={Math.min(yOf(value), yOf(0))}
                  height={Math.max(1, Math.abs(yOf(value) - yOf(0)))}
                  rx={2}
                  fill={color}
                  opacity={hover === null || hover === index ? 1 : 0.45}
                />
              ),
            );
          }
          // A gap in the data is a gap in the line.
          const runs: [number, number][][] = [];
          let run: [number, number][] = [];
          series.data.forEach((value, index) => {
            if (value === null) {
              if (run.length > 0) runs.push(run);
              run = [];
            } else run.push([xOf(index), yOf(value)]);
          });
          if (run.length > 0) runs.push(run);
          return (
            <g key={seriesIndex}>
              {runs.map((points, runIndex) => {
                const path = points.length === 1 ? `M${points[0]![0] - 0.01},${points[0]![1]} L${points[0]![0]},${points[0]![1]}` : smoothPath(points);
                return (
                  <g key={runIndex}>
                    {spec.type === 'area' && points.length > 1 && <path d={`${path} L${points[points.length - 1]![0]},${yOf(low)} L${points[0]![0]},${yOf(low)} Z`} fill={color} opacity={0.12} />}
                    <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                  </g>
                );
              })}
              {hover !== null && series.data[hover] != null && <circle cx={xOf(hover)} cy={yOf(series.data[hover]!)} r={3.5} fill={color} stroke="var(--surface)" strokeWidth={1.5} />}
            </g>
          );
        })}
      </svg>
      <Legend
        items={spec.series.map((series, index) => ({
          name: hover === null ? series.name : `${series.name} · ${String(spec.x[hover])}`,
          color: COLORS[index % COLORS.length]!,
          ...(hover !== null && series.data[hover] != null ? { value: format(series.data[hover]!) } : {}),
        }))}
      />
    </figure>
  );
}

function Pie({ spec }: { spec: Extract<AiChartSpec, { type: 'pie' }> }) {
  const { formatNumber } = useI18n();
  const total = spec.slices.reduce((sum, slice) => sum + slice.value, 0) || 1;
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <figure className="tai-chart tai-chart--pie">
      {spec.title !== undefined && <figcaption>{spec.title}</figcaption>}
      <div className="tai-chart__pie">
        <svg viewBox="0 0 200 200" role="img" aria-label={spec.title ?? 'chart'}>
          <g transform="rotate(-90 100 100)">
            {spec.slices.map((slice, index) => {
              const length = (slice.value / total) * circumference;
              const circle = <circle key={slice.name} cx={100} cy={100} r={radius} fill="none" stroke={COLORS[index % COLORS.length]} strokeWidth={34} strokeDasharray={`${Math.max(0, length - 1.5)} ${circumference}`} strokeDashoffset={-offset} />;
              offset += length;
              return circle;
            })}
          </g>
        </svg>
        <Legend
          items={spec.slices.map((slice, index) => ({
            name: slice.name,
            color: COLORS[index % COLORS.length]!,
            value: `${formatNumber(slice.value, { maximumFractionDigits: 2 })}${spec.unit ?? ''} · ${formatNumber((slice.value / total) * 100, { maximumFractionDigits: 1 })}%`,
          }))}
        />
      </div>
    </figure>
  );
}

function Metric({ spec }: { spec: Extract<AiChartSpec, { type: 'metric' }> }) {
  const { m, formatBytes, formatNumber } = useI18n();
  const [kind, id = ''] = spec.target.split(':');
  const range = spec.range ?? '1h';
  // Only the one that matches the target asks the server anything.
  const app = useQuery({ queryKey: keys.appPart(id, 'metrics', range), queryFn: () => api.get<{ points: AppMetricPoint[] }>(`/api/applications/${id}/metrics${qs({ range })}`), enabled: kind === 'app', refetchInterval: 30_000 });
  const service = useQuery({ queryKey: keys.servicePart(id, 'metrics', range), queryFn: () => api.get<{ points: AppMetricPoint[] }>(`/api/services/${id}/metrics${qs({ range })}`), enabled: kind === 'service', refetchInterval: 30_000 });
  const server = useQuery({ queryKey: keys.serverPart(id, 'metrics', range), queryFn: () => api.get<{ points: HostMetricPoint[]; latest: HostMetricPoint | null }>(`/api/servers/${id}/metrics${qs({ range })}`), enabled: kind === 'server', refetchInterval: 30_000 });
  const percent = (value: number): string => `${formatNumber(value, { maximumFractionDigits: value < 10 ? 1 : 0 })}%`;
  const query = kind === 'app' ? app : kind === 'service' ? service : server;
  const title = spec.title ?? `${m.metrics[spec.metric === 'memory' ? 'memory' : spec.metric === 'network' ? 'network' : spec.metric === 'disk' ? 'disk' : spec.metric === 'load' ? 'load' : 'cpu']} · ${range}`;

  const chart = useMemo(() => {
    if (kind === 'server') {
      const points = server.data?.points ?? [];
      const latest = server.data?.latest ?? null;
      if (spec.metric === 'memory') return { series: [{ label: m.metrics.memory, color: 'var(--ok)', values: points.map((point) => ({ t: point.t, v: point.memUsed })) }], format: (value: number) => formatBytes(value), max: latest?.memTotal };
      if (spec.metric === 'disk') return { series: [{ label: m.metrics.disk, color: 'var(--work)', values: points.map((point) => ({ t: point.t, v: point.diskUsed })) }], format: (value: number) => formatBytes(value), max: latest?.diskTotal };
      if (spec.metric === 'load') return { series: [{ label: m.metrics.load, color: 'var(--bad)', values: points.map((point) => ({ t: point.t, v: point.load1 })) }], format: (value: number) => formatNumber(value, { maximumFractionDigits: 2 }), max: undefined };
      if (spec.metric === 'cpu') return { series: [{ label: m.metrics.cpu, color: 'var(--info)', values: points.map((point) => ({ t: point.t, v: point.cpu })) }], format: percent, max: 100 };
      return null;
    }
    const points = (kind === 'app' ? app.data?.points : service.data?.points) ?? [];
    if (spec.metric === 'memory') return { series: [{ label: m.metrics.memory, color: 'var(--ok)', values: points.map((point) => ({ t: point.t, v: point.mem })) }], format: (value: number) => formatBytes(value), max: undefined };
    if (spec.metric === 'network') {
      return {
        series: [
          { label: m.metrics.inbound, color: 'var(--info)', values: points.map((point) => ({ t: point.t, v: point.rx })) },
          { label: m.metrics.outbound, color: 'var(--work)', values: points.map((point) => ({ t: point.t, v: point.tx })) },
        ],
        format: (value: number) => `${formatBytes(value)}${m.units.perSecond}`,
        max: undefined,
      };
    }
    if (spec.metric === 'cpu') return { series: [{ label: m.metrics.cpu, color: 'var(--info)', values: points.map((point) => ({ t: point.t, v: point.cpu })) }], format: percent, max: undefined };
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, spec.metric, app.data, service.data, server.data, m]);

  if (query.isError) return <p className="tai-chart__note">{m.ai.chartUnavailable}</p>;
  if (query.data === undefined) return <Skeleton height={200} />;
  if (chart === null) return <p className="tai-chart__note">{m.ai.chartUnavailable}</p>;
  return (
    <div className="tai-chart tai-chart--metric">
      <AreaChart title={title} series={chart.series} format={chart.format} {...(chart.max == null ? {} : { max: chart.max })} height={180} />
    </div>
  );
}

export function ChartBlock({ source, complete }: { source: string; complete: boolean }) {
  const spec = useMemo(() => parseAiChart(source), [source]);
  // Still being written: a chart-shaped placeholder instead of half an object.
  if (spec === null) return complete ? <CodeBlock code={source} lang="json" /> : <Skeleton height={200} />;
  if (spec.type === 'metric') return <Metric spec={spec} />;
  if (spec.type === 'pie') return <Pie spec={spec} />;
  return <Cartesian spec={spec} />;
}
