/**
 * A self-update as it runs: the stage rail, the bar, what the updater is
 * doing right now and its live log. While the panel replaces itself the
 * stream drops; the view says so and waits for whichever control plane
 * answers next.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { UPDATE_STAGES, type UpdateProgressDto, type UpdateStage, type UpdateStatusDto } from '@ploy/shared';
import { useI18n } from '../i18n/index.tsx';
import { useLogStream } from '../lib/logs.ts';
import { LogViewer } from './LogViewer.tsx';

type StageState = 'done' | 'active' | 'pending' | 'failed';

function stageStates(progress: UpdateProgressDto, failed: boolean, finished: boolean): Record<UpdateStage, StageState> {
  const current = UPDATE_STAGES.indexOf(progress.stage);
  const states = {} as Record<UpdateStage, StageState>;
  UPDATE_STAGES.forEach((stage, index) => {
    if (finished) states[stage] = 'done';
    else if (index < current) states[stage] = 'done';
    else if (index === current) states[stage] = failed ? 'failed' : 'active';
    else states[stage] = 'pending';
  });
  return states;
}

export function UpdateProgress({ status, onFinished }: { status: UpdateStatusDto; onFinished?: (outcome: 'succeeded' | 'failed') => void }) {
  const { m, t } = useI18n();
  const u = m.updates;
  // A daemon may close a followed log before the updater is done; the stream is then picked up again.
  const [attempt, setAttempt] = useState(0);
  const { lines, state, endStatus } = useLogStream(`/api/updates/log?attempt=${attempt}`);
  useEffect(() => {
    if (endStatus !== 'running') return;
    const timer = window.setTimeout(() => setAttempt((count) => count + 1), 2_000);
    return () => window.clearTimeout(timer);
  }, [endStatus]);
  useEffect(() => {
    if (endStatus === 'succeeded' || endStatus === 'failed') onFinished?.(endStatus);
  }, [endStatus, onFinished]);

  const latest = useMemo(() => {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const progress = lines[index]!.progress;
      if (progress !== undefined) return progress;
    }
    return null;
  }, [lines]);
  const progress: UpdateProgressDto = latest ?? status.progress ?? { stage: 'fetch', percent: 0, message: '' };
  const failed = status.state === 'failed' || endStatus === 'failed';
  const finished = !failed && (endStatus === 'succeeded' || progress.stage === 'done');
  // Once the container swap began, a dropped stream means the panel itself is restarting.
  const restarting = !failed && !finished && state === 'error' && (progress.stage === 'replace' || progress.stage === 'health');
  const percent = finished ? 100 : progress.percent;
  const states = stageStates(progress, failed, finished);
  const tone = failed ? 'bad' : finished ? 'ok' : 'work';

  return (
    <div className="upd" data-tone={tone}>
      <ol className="pipeline upd__rail" aria-label={u.progressTitle}>
        {UPDATE_STAGES.map((stage) => (
          <li key={stage} className="pipeline__stage" data-state={states[stage]} aria-current={states[stage] === 'active' ? 'step' : undefined}>
            <span className="pipeline__bar" aria-hidden="true" />
            <span className="pipeline__label">{u.stages[stage]}</span>
          </li>
        ))}
      </ol>
      <div className="upd__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={u.progressTitle}>
        <span className="upd__fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="upd__meta">
        <span className="upd__icon" aria-hidden="true">
          {failed ? <X /> : finished ? <Check /> : restarting ? <RefreshCw className="spin" /> : <LoaderCircle className="spin" />}
        </span>
        <span className="upd__percent tabular">{t(u.percent, { percent })}</span>
        <span className="upd__message truncate">
          {failed ? t(u.stoppedAt, { stage: u.stages[progress.stage] }) : finished ? u.done : restarting ? u.restarting : progress.message.length > 0 ? progress.message : u.stages[progress.stage]}
        </span>
      </div>
      {restarting && <p className="upd__note">{u.restartingHint}</p>}
      <div className="upd__log">
        <LogViewer lines={lines} height={260} live={!finished && !failed} name="torexploy-update" levels={false} empty={u.waitingLog} />
      </div>
    </div>
  );
}
