/**
 * PostgreSQL's plan (EXPLAIN FORMAT JSON) as a tree: each step with what it
 * reads, its share of the cost (or of the time, with ANALYZE) as a heat bar,
 * the rows it expected next to the rows it got, and its conditions on demand.
 */
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react';
import { useI18n } from '../../i18n/index.tsx';
import { formatMs } from './format.ts';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  Schema?: string;
  Alias?: string;
  'Index Name'?: string;
  'Join Type'?: string;
  'Strategy'?: string;
  'Startup Cost'?: number;
  'Total Cost'?: number;
  'Plan Rows'?: number;
  'Actual Total Time'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  Plans?: PlanNode[];
  [detail: string]: unknown;
}

interface Explained {
  Plan: PlanNode;
  'Planning Time'?: number;
  'Execution Time'?: number;
}

/** Read an EXPLAIN (FORMAT JSON) result cell; null when it is not one. */
export function parsePlan(text: string | null | undefined): Explained | null {
  if (text === null || text === undefined) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (typeof first === 'object' && first !== null && 'Plan' in first) return first as Explained;
  } catch {
    return null;
  }
  return null;
}

const SKIP = new Set(['Node Type', 'Plans', 'Parallel Aware', 'Async Capable', 'Startup Cost', 'Total Cost', 'Plan Rows', 'Plan Width', 'Actual Startup Time', 'Actual Total Time', 'Actual Rows', 'Actual Loops', 'Relation Name', 'Schema', 'Alias', 'Index Name', 'Parent Relationship', 'Join Type', 'Strategy', 'Partial Mode', 'Inner Unique']);

function exclusive(node: PlanNode, analyzed: boolean): number {
  const own = analyzed ? (node['Actual Total Time'] ?? 0) * (node['Actual Loops'] ?? 1) : (node['Total Cost'] ?? 0);
  const children = (node.Plans ?? []).reduce((sum, child) => sum + (analyzed ? (child['Actual Total Time'] ?? 0) * (child['Actual Loops'] ?? 1) : (child['Total Cost'] ?? 0)), 0);
  return Math.max(0, own - children);
}

function Node({ node, total, analyzed, depth }: { node: PlanNode; total: number; analyzed: boolean; depth: number }) {
  const { m, formatNumber } = useI18n();
  const [open, setOpen] = useState(true);
  const [details, setDetails] = useState(false);
  const share = total > 0 ? exclusive(node, analyzed) / total : 0;
  const children = node.Plans ?? [];
  const planned = node['Plan Rows'];
  const actual = node['Actual Rows'] === undefined ? undefined : node['Actual Rows'] * (node['Actual Loops'] ?? 1);
  const misestimate = planned !== undefined && actual !== undefined && Math.max(planned, 1) / Math.max(actual, 1);
  const off = misestimate !== false && (misestimate > 10 || misestimate < 0.1);
  const target = [node['Join Type'] === undefined ? null : node['Join Type'], node['Strategy'] === undefined || node['Strategy'] === 'Plain' ? null : node['Strategy']].filter((part) => part !== null).join(' ');
  const facts = Object.entries(node).filter(([key, value]) => !SKIP.has(key) && value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0));
  return (
    <li className="plan__node">
      <div className="plan__row" style={{ '--heat': Math.min(1, share * 1.6), '--depth': depth } as React.CSSProperties}>
        <button type="button" className="plan__toggle" aria-expanded={open} disabled={children.length === 0} onClick={() => setOpen(!open)} aria-label={node['Node Type']}>
          {children.length === 0 ? <span className="plan__dot" /> : open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        </button>
        <button type="button" className="plan__main" onClick={() => setDetails(!details)} aria-expanded={details}>
          <span className="plan__type">
            {target.length > 0 && <span className="plan__mod">{target}</span>}
            {node['Node Type']}
          </span>
          {node['Relation Name'] !== undefined && (
            <span className="plan__on">
              {m.db.plan.on} <code>{node['Relation Name']}</code>
              {node.Alias !== undefined && node.Alias !== node['Relation Name'] && <> ({node.Alias})</>}
            </span>
          )}
          {node['Index Name'] !== undefined && (
            <span className="plan__on">
              {m.db.plan.using} <code>{node['Index Name']}</code>
            </span>
          )}
        </button>
        <span className="plan__metrics">
          <span className="plan__share" title={analyzed ? m.db.plan.timeShare : m.db.plan.costShare}>
            {Math.round(share * 100)}%
          </span>
          {analyzed && node['Actual Total Time'] !== undefined && <span>{formatMs(exclusive(node, true))}</span>}
          <span className="plan__rows" data-off={off || undefined} title={m.db.plan.rowsHint}>
            {off && <TriangleAlert aria-hidden="true" />}
            {planned !== undefined && formatNumber(planned)}
            {actual !== undefined && <> → {formatNumber(actual)}</>}
            {' '}
            {m.db.plan.rows}
          </span>
          {node['Total Cost'] !== undefined && <span className="plan__cost">{formatNumber(node['Total Cost'], { maximumFractionDigits: 1 })}</span>}
        </span>
      </div>
      {details && facts.length > 0 && (
        <dl className="plan__facts">
          {facts.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {open && children.length > 0 && (
        <ul className="plan__children">
          {children.map((child, index) => (
            <Node key={index} node={child} total={total} analyzed={analyzed} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function PlanView({ plan }: { plan: Explained }) {
  const { m } = useI18n();
  const analyzed = plan.Plan['Actual Total Time'] !== undefined;
  const total = useMemo(() => {
    let sum = 0;
    const walk = (node: PlanNode) => {
      sum += exclusive(node, analyzed);
      for (const child of node.Plans ?? []) walk(child);
    };
    walk(plan.Plan);
    return sum;
  }, [plan, analyzed]);
  return (
    <div className="plan">
      <div className="plan__summary">
        {plan['Planning Time'] !== undefined && (
          <span>
            {m.db.plan.planning} <strong>{formatMs(plan['Planning Time'])}</strong>
          </span>
        )}
        {plan['Execution Time'] !== undefined && (
          <span>
            {m.db.plan.execution} <strong>{formatMs(plan['Execution Time'])}</strong>
          </span>
        )}
        <span>
          {m.db.plan.totalCost} <strong>{plan.Plan['Total Cost']?.toFixed(1)}</strong>
        </span>
        <span className="plan__legend">{analyzed ? m.db.plan.analyzedLegend : m.db.plan.estimatedLegend}</span>
      </div>
      <ul className="plan__tree">
        <Node node={plan.Plan} total={total} analyzed={analyzed} depth={0} />
      </ul>
    </div>
  );
}
