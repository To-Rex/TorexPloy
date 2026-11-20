/**
 * Area chart for metric series. Hand-written SVG: tiny, theme-aware through
 * CSS variables, with a hover crosshair and an accessible text summary.
 *
 * The line is a smooth curve that never overshoots its points, drawn in
 * when the chart appears; while the newest sample is fresh, its end pulses,
 * so a glance tells a live chart from a stale one. Under each chart: the
 * average and the peak of what is shown (or each series' latest value).
 */
import { useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useI18n } from '../i18n/index.tsx';

export interface Series {
  label: string;
  color: string;
  values: { t: number; v: number }[];
}

export interface AreaChartProps {
  title: string;
  series: Series[];
  format: (value: number) => string;
  /** Fixed upper bound (e.g. 100 for percentages); defaults to the data maximum. */
  max?: number;
  height?: number;
  headline?: string;
  sub?: string;
  /** The line under the chart with the average and the peak; on by default. */
  stats?: boolean;
}

/** How recent the newest sample must be for the chart to count as live. */
const FRESH_MS = 120_000;

/**
 * A smooth path through the points that stays monotone between them
 * (Fritsch–Carlson tangents): no bumps above a peak or below zero that the
 * data does not have.
 */
export function smoothPath(points: readonly (readonly [number, number])[]): string {
  const n = points.length;
  if (n === 0) return '';
  const at = (index: number) => points[index]!;
  const f = (value: number) => value.toFixed(1);
  if (n < 3) return `M${points.map(([px, py]) => `${f(px)},${f(py)}`).join('L')}`;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let index = 0; index < n - 1; index += 1) {
    dx.push(at(index + 1)[0] - at(index)[0]);
    slope.push(dx[index] === 0 ? 0 : (at(index + 1)[1] - at(index)[1]) / dx[index]!);
  }
  const tangent: number[] = [slope[0]!];
  for (let index = 1; index < n - 1; index += 1) {
    const before = slope[index - 1]!;
    const after = slope[index]!;
    if (before * after <= 0) {
      tangent.push(0);
    } else {
      const w1 = 2 * dx[index]! + dx[index - 1]!;
      const w2 = dx[index]! + 2 * dx[index - 1]!;
      tangent.push((w1 + w2) / (w1 / before + w2 / after));
    }
  }
  tangent.push(slope[n - 2]!);
  let d = `M${f(at(0)[0])},${f(at(0)[1])}`;
  for (let index = 0; index < n - 1; index += 1) {
    const [x0, y0] = at(index);
    const [x1, y1] = at(index + 1);
    const third = dx[index]! / 3;
    d += `C${f(x0 + third)},${f(y0 + tangent[index]! * third)} ${f(x1 - third)},${f(y1 - tangent[index + 1]! * third)} ${f(x1)},${f(y1)}`;
  }
  return d;
}

const PAD = { top: 10, right: 8, bottom: 22, left: 8 };

export function AreaChart({ title, series, format, max, height = 168, headline, sub, stats = true }: AreaChartProps) {
  const { m, formatDate } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId();

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(200, entry!.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const times = useMemo(() => [...new Set(series.flatMap((s) => s.values.map((point) => point.t)))].sort((a, b) => a - b), [series]);
  const top = useMemo(() => {
    const dataMax = Math.max(0, ...series.flatMap((s) => s.values.map((point) => point.v)));
    const bound = max ?? (dataMax === 0 ? 1 : dataMax * 1.15);
    return Math.max(bound, 1e-9);
  }, [series, max]);

  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const t0 = times[0] ?? 0;
  const t1 = times[times.length - 1] ?? 1;
  const x = (t: number) => PAD.left + (t1 === t0 ? innerW / 2 : ((t - t0) / (t1 - t0)) * innerW);
  const y = (v: number) => PAD.top + innerH - (Math.min(v, top) / top) * innerH;

  const paths = series.map((s) => {
    if (s.values.length === 0) return { line: '', area: '' };
    const line = smoothPath(s.values.map((point) => [x(point.t), y(point.v)] as const));
    const area = `${line}L${x(s.values[s.values.length - 1]!.t).toFixed(1)},${PAD.top + innerH}L${x(s.values[0]!.t).toFixed(1)},${PAD.top + innerH}Z`;
    return { line, area };
  });

  const empty = times.length === 0;
  const hoverT = hover === null ? null : times[hover];
  const latest = series.map((s) => s.values[s.values.length - 1]?.v ?? 0);
  const peak = series.map((s) => Math.max(0, ...s.values.map((point) => point.v)));
  const average = series.map((s) => (s.values.length === 0 ? 0 : s.values.reduce((sum, point) => sum + point.v, 0) / s.values.length));
  const fresh = !empty && t1 > Date.now() - FRESH_MS;

  const onMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (empty) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientX - rect.left;
    let best = 0;
    let distance = Infinity;
    times.forEach((t, index) => {
      const d = Math.abs(x(t) - position);
      if (d < distance) {
        distance = d;
        best = index;
      }
    });
    setHover(best);
  };

  return (
    <figure className="chart">
      <figcaption className="chart__head">
        <span className="chart__title">{title}</span>
        {headline !== undefined && <span className="chart__value tabular">{headline}</span>}
        {sub !== undefined && <span className="chart__sub">{sub}</span>}
      </figcaption>
      <div ref={ref} className="chart__plot">
        {empty ? (
          <div className="chart__empty" style={{ height }}>
            {m.metrics.noData}
          </div>
        ) : (
          <svg width={width} height={height} role="img" aria-label={`${title}: ${series.map((s, index) => `${s.label} ${format(latest[index]!)}, ${m.metrics.peak} ${format(peak[index]!)}`).join('; ')}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            <defs>
              {series.map((s, index) => (
                <linearGradient key={s.label} id={`${gradientId}-${index}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity="0.22" />
                  <stop offset="100%" stopColor={s.color} stopOpacity="0" />
                </linearGradient>
              ))}
            </defs>
            {[0.25, 0.5, 0.75, 1].map((fraction) => (
              <line key={fraction} x1={PAD.left} x2={width - PAD.right} y1={PAD.top + innerH * (1 - fraction)} y2={PAD.top + innerH * (1 - fraction)} className="chart__grid" />
            ))}
            <text x={width - PAD.right} y={PAD.top + 10} textAnchor="end" className="chart__axis">
              {format(top)}
            </text>
            {paths.map((path, index) => (
              <g key={series[index]!.label}>
                <path className="chart__area" d={path.area} fill={`url(#${gradientId}-${index})`} />
                <path className="chart__line" d={path.line} pathLength={1} fill="none" stroke={series[index]!.color} strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
              </g>
            ))}
            <text x={PAD.left} y={height - 6} className="chart__axis">
              {formatDate(t0, { hour: '2-digit', minute: '2-digit' })}
            </text>
            <text x={width - PAD.right} y={height - 6} textAnchor="end" className="chart__axis">
              {formatDate(t1, { hour: '2-digit', minute: '2-digit' })}
            </text>
            {/* The newest sample of each series: it pulses while the data is fresh. */}
            {fresh &&
              hover === null &&
              series.map((s) => {
                const point = s.values[s.values.length - 1];
                return point === undefined ? null : (
                  <g key={s.label} className="chart__now" style={{ color: s.color }}>
                    <circle className="chart__now-ring" cx={x(point.t)} cy={y(point.v)} r="4" />
                    <circle cx={x(point.t)} cy={y(point.v)} r="3" fill="currentColor" stroke="var(--surface)" strokeWidth="1.5" />
                  </g>
                );
              })}
            {hoverT !== null && hoverT !== undefined && (
              <g>
                <line x1={x(hoverT)} x2={x(hoverT)} y1={PAD.top} y2={PAD.top + innerH} className="chart__cursor" />
                {series.map((s) => {
                  const point = s.values.find((candidate) => candidate.t === hoverT);
                  return point === undefined ? null : <circle key={s.label} cx={x(point.t)} cy={y(point.v)} r="3.5" fill="var(--surface)" stroke={s.color} strokeWidth="2" />;
                })}
              </g>
            )}
          </svg>
        )}
        {hoverT !== null && hoverT !== undefined && (
          <div className="chart__tip" style={{ left: Math.min(Math.max(x(hoverT), 70), width - 70) }}>
            <span className="faint">{formatDate(hoverT, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</span>
            {series.map((s) => {
              const point = s.values.find((candidate) => candidate.t === hoverT);
              return (
                <span key={s.label} className="row" style={{ gap: 6 }}>
                  <span className="chart__swatch" style={{ background: s.color }} />
                  {series.length > 1 && <span>{s.label}</span>}
                  <strong className="tabular">{point === undefined ? '—' : format(point.v)}</strong>
                </span>
              );
            })}
          </div>
        )}
      </div>
      {stats && !empty && (
        <div className="chart__stats">
          {series.length === 1 ? (
            <>
              <span>
                {m.metrics.average} <strong className="tabular">{format(average[0]!)}</strong>
              </span>
              <span>
                {m.metrics.peak} <strong className="tabular">{format(peak[0]!)}</strong>
              </span>
            </>
          ) : (
            series.map((s, index) => (
              <span key={s.label}>
                <i className="chart__swatch" style={{ background: s.color }} />
                {s.label} <strong className="tabular">{format(latest[index]!)}</strong>
              </span>
            ))
          )}
        </div>
      )}
    </figure>
  );
}
