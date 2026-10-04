/**
 * The deployment pipeline rail: each stage of the real pipeline, lit as the
 * deployment passes through it. Derived from the stage markers in the log,
 * so it is exactly as accurate as the log itself.
 */
import { DEPLOY_STAGES, type DeployStage, type DeploymentStatus } from '@ploy/shared';
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/index.tsx';
import type { StreamLine } from '../lib/logs.ts';

export type StageState = 'done' | 'active' | 'failed' | 'pending' | 'skipped';

export interface StageView {
  stage: DeployStage;
  state: StageState;
  startedAt: number | null;
  endedAt: number | null;
}

export function computeStages(lines: StreamLine[], status: DeploymentStatus, finishedAt: number | null): StageView[] {
  const starts = new Map<DeployStage, number>();
  for (const line of lines) if (line.stage !== undefined && !starts.has(line.stage)) starts.set(line.stage, line.t);
  const seen = DEPLOY_STAGES.map((stage) => starts.has(stage));
  const last = seen.lastIndexOf(true);
  const inProgress = status === 'queued' || status === 'building' || status === 'deploying';

  return DEPLOY_STAGES.map((stage, index) => {
    const startedAt = starts.get(stage) ?? null;
    const nextStart = DEPLOY_STAGES.slice(index + 1)
      .map((next) => starts.get(next))
      .find((value) => value !== undefined);
    let state: StageState;
    if (last === -1) {
      state = status === 'failed' && index === 0 ? 'failed' : status === 'succeeded' ? 'skipped' : 'pending';
    } else if (index < last) {
      state = seen[index] ? 'done' : 'skipped';
    } else if (index === last) {
      state = status === 'succeeded' ? 'done' : inProgress ? 'active' : 'failed';
    } else {
      state = status === 'succeeded' ? 'skipped' : 'pending';
    }
    const endedAt = state === 'done' || state === 'failed' ? (nextStart ?? finishedAt) : null;
    return { stage, state, startedAt, endedAt };
  });
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function PipelineRail({ stages }: { stages: StageView[] }) {
  const { m, formatDuration } = useI18n();
  const running = stages.some((stage) => stage.state === 'active');
  const now = useNow(running);
  return (
    <ol className="pipeline" aria-label={m.deployment.title}>
      {stages.map((view) => {
        const elapsed = view.startedAt === null ? null : (view.endedAt ?? (view.state === 'active' ? now : null)) === null ? null : (view.endedAt ?? now) - view.startedAt;
        return (
          <li key={view.stage} className="pipeline__stage" data-state={view.state} aria-current={view.state === 'active' ? 'step' : undefined}>
            <span className="pipeline__bar" aria-hidden="true" />
            <span className="pipeline__label">{m.stages[view.stage]}</span>
            <span className="pipeline__time tabular">{elapsed !== null && elapsed >= 0 ? formatDuration(elapsed) : view.state === 'skipped' ? '—' : ''}</span>
          </li>
        );
      })}
    </ol>
  );
}
