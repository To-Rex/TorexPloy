/**
 * One deployment in a history list: what it was (number, commit or trigger),
 * how it went (status, timing, failure reason) and what can be done with it
 * (log, rollback, redeploy, cancel). Shared by an app's history and the
 * team-wide list, so a deployment reads the same everywhere.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Ban, Check, Clock, Ellipsis, GitBranch, Hammer, History, Hourglass, LoaderCircle, Minus, Rocket, RotateCcw, ScrollText, Timer, TriangleAlert, User, X } from 'lucide-react';
import { isTerminalDeployment, type DeploymentDto } from '@ploy/shared';
import { useI18n } from '../i18n/index.tsx';
import type { Messages } from '../i18n/uz.ts';
import { api } from '../lib/api.ts';
import { useAction } from '../lib/mutate.ts';
import { keys } from '../lib/queries.ts';
import { useConfirm } from './Dialog.tsx';
import { Menu, MenuItem } from './Menu.tsx';
import { useReasonText } from './Reason.tsx';
import { deploymentTone } from './Status.tsx';
import { RelativeTime } from './Time.tsx';
import { Badge, Button } from './ui.tsx';

const ICONS = { ok: Check, bad: X, work: LoaderCircle, idle: Minus, info: Minus } as const;

/** Stored timestamps are ISO; older rows may carry SQLite's `YYYY-MM-DD HH:MM:SS` (UTC) instead. */
export function parseTime(value: string | null): number | null {
  if (value === null) return null;
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const time = Date.parse(normalised);
  return Number.isNaN(time) ? null : time;
}

/** The first line of the commit message, or what started the deployment. */
export function deploymentTitle(m: Messages, deployment: Pick<DeploymentDto, 'commitMessage' | 'trigger'>): string {
  const message = deployment.commitMessage?.split('\n')[0]?.trim() ?? '';
  return message.length > 0 ? message : m.deployments.titles[deployment.trigger];
}

export interface DeploymentTiming {
  /** Start to finish; counts up while the deployment runs. */
  total: number | null;
  /** Time spent queued before work started; counts up while still queued. */
  waited: number | null;
  build: number | null;
  live: boolean;
}

export function deploymentTiming(deployment: DeploymentDto, now: number): DeploymentTiming {
  const created = parseTime(deployment.createdAt);
  const started = parseTime(deployment.startedAt);
  const finished = parseTime(deployment.finishedAt);
  const running = !isTerminalDeployment(deployment.status);
  const from = started ?? created;
  let total: number | null = deployment.durationMs;
  if (total === null && from !== null) {
    if (finished !== null) total = Math.max(0, finished - from);
    else if (running && started !== null) total = Math.max(0, now - from);
  }
  let waited: number | null = null;
  if (created !== null) {
    if (started !== null) waited = Math.max(0, started - created);
    else if (deployment.status === 'queued') waited = Math.max(0, now - created);
  }
  return { total, waited, build: deployment.buildDurationMs, live: running };
}

/** A once-a-second clock while something is in flight, so elapsed times count up. */
function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** Timing facts shared by the list item and the deployment page. */
export function DeploymentTimingFacts({ deployment }: { deployment: DeploymentDto }) {
  const { m, t, formatDuration } = useI18n();
  const now = useSecondTick(!isTerminalDeployment(deployment.status));
  const timing = deploymentTiming(deployment, now);
  return (
    <>
      {timing.total !== null && (
        <span className="fact tabular">
          {timing.live ? <LoaderCircle className="spin" aria-hidden="true" /> : <Timer aria-hidden="true" />}
          {t(timing.live ? m.deployments.running : m.deployments.took, { time: formatDuration(timing.total) })}
        </span>
      )}
      {timing.waited !== null && (timing.waited >= 2_000 || deployment.status === 'queued') && (
        <span className="fact tabular">
          <Hourglass aria-hidden="true" />
          {t(m.deployments.waited, { time: formatDuration(timing.waited) })}
        </span>
      )}
      {timing.build !== null && (
        <span className="fact tabular">
          <Hammer aria-hidden="true" />
          {t(m.deployments.built, { time: formatDuration(timing.build) })}
        </span>
      )}
    </>
  );
}

export function DeploymentItem({
  deployment,
  heading,
  invalidate = [],
}: {
  deployment: DeploymentDto;
  /** Where it belongs, for lists that span applications. */
  heading?: ReactNode;
  /** Query keys to refresh after an action, besides the application's own. */
  invalidate?: readonly (readonly unknown[])[];
}) {
  const { m, t, formatDate } = useI18n();
  const confirm = useConfirm();
  const reason = useReasonText();
  const refresh = [keys.app(deployment.applicationId), keys.appPart(deployment.applicationId, 'deployments'), ...invalidate];
  const cancel = useAction(() => api.post(`/api/deployments/${deployment.id}/cancel`), { success: m.deployments.cancelled, invalidate: refresh });
  const redeploy = useAction(() => api.post(`/api/deployments/${deployment.id}/redeploy`), { success: m.app.deployQueued, invalidate: refresh });
  const running = !isTerminalDeployment(deployment.status);
  const tone = deploymentTone[deployment.status];
  const Icon = ICONS[tone];
  const detail = `/deployments/${deployment.id}`;
  const created = parseTime(deployment.createdAt);
  const who = deployment.createdBy?.name ?? (deployment.trigger === 'push' ? deployment.commitAuthor : null);

  return (
    <article className="deploy-item" data-tone={tone} aria-label={`${t(m.deployments.number, { n: deployment.number })} ${deploymentTitle(m, deployment)}`}>
      <div className="deploy-item__rail" aria-hidden="true">
        <span className="deploy-item__dot">
          <Icon className={tone === 'work' ? 'spin' : undefined} />
        </span>
      </div>
      <div className="deploy-item__body">
        <div className="deploy-item__head">
          {heading}
          <Badge tone={tone}>{m.status.deployment[deployment.status]}</Badge>
          <span className="deploy-item__num tabular">{t(m.deployments.number, { n: deployment.number })}</span>
          {deployment.isActive && <Badge tone="ok">{m.deployments.active}</Badge>}
          {deployment.status === 'succeeded' && !deployment.canRollback && !deployment.isActive && <span className="deploy-item__note">{m.deployments.imageGone}</span>}
          <span className="deploy-item__when">
            <RelativeTime value={deployment.createdAt} />
          </span>
        </div>
        <Link to={detail} className="deploy-item__title truncate">
          {deploymentTitle(m, deployment)}
        </Link>
        <div className="deploy-item__facts">
          {(deployment.branch !== null || deployment.commitSha !== null) && (
            <span>
              <GitBranch aria-hidden="true" />
              {deployment.branch}
              {deployment.branch !== null && deployment.commitSha !== null && ' · '}
              {deployment.commitSha !== null && <code>{deployment.commitSha.slice(0, 7)}</code>}
            </span>
          )}
          {deployment.commitMessage !== null && (
            <span>
              <Rocket aria-hidden="true" />
              {m.trigger[deployment.trigger]}
            </span>
          )}
          {who !== null && (
            <span>
              <User aria-hidden="true" />
              {who}
            </span>
          )}
          {created !== null && (
            <span className="tabular" title={formatDate(created, { dateStyle: 'full', timeStyle: 'medium' })}>
              <Clock aria-hidden="true" />
              {formatDate(created, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <DeploymentTimingFacts deployment={deployment} />
        </div>
        {deployment.status === 'failed' && deployment.errorMessage !== null && (
          <div className="deploy-item__error">
            <TriangleAlert aria-hidden="true" />
            <span>{reason('deploy', deployment.errorCode, deployment.errorMessage)}</span>
          </div>
        )}
      </div>
      <div className="deploy-item__side">
        <Link className="btn btn--sm btn--ghost deploy-item__log" to={detail}>
          <ScrollText width={14} height={14} aria-hidden="true" />
          {m.deployments.viewLog}
        </Link>
        <Menu trigger={(props) => <Button {...props} variant="ghost" size="sm" iconOnly icon={<Ellipsis />}>{m.common.actions}</Button>}>
          <MenuItem icon={<ScrollText />} href={detail}>
            {m.deployments.viewLog}
          </MenuItem>
          {deployment.canRollback && !deployment.isActive && (
            <MenuItem
              icon={<History />}
              onSelect={async () => {
                const result = await confirm({ title: m.deployments.rollbackConfirmTitle, text: m.deployments.rollbackConfirmText, confirmLabel: m.deployments.rollback });
                if (result.confirmed) redeploy.mutate();
              }}
            >
              {m.deployments.rollback}
            </MenuItem>
          )}
          {deployment.canRollback && deployment.isActive && (
            <MenuItem icon={<RotateCcw />} onSelect={() => redeploy.mutate()}>
              {m.deployments.redeploy}
            </MenuItem>
          )}
          {running && (
            <MenuItem icon={<Ban />} danger onSelect={() => cancel.mutate()}>
              {m.deployments.cancel}
            </MenuItem>
          )}
        </Menu>
      </div>
    </article>
  );
}
