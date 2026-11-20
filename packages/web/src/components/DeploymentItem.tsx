/**
 * One deployment in a history list: what it was (number, commit or trigger),
 * how it went (status, timing, failure reason) and what can be done with it
 * (log, rollback, redeploy, cancel). Shared by an app's history and the
 * team-wide list, so a deployment reads the same everywhere.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Ban, Check, Ellipsis, FolderUp, GitBranch, Hammer, History, Hourglass, LoaderCircle, Minus, RotateCcw, ScrollText, Timer, Trash2, TriangleAlert, User, X } from 'lucide-react';
import { isTerminalDeployment, type DeploymentDto } from '@ploy/shared';
import { useI18n } from '../i18n/index.tsx';
import type { Messages } from '../i18n/uz.ts';
import { api } from '../lib/api.ts';
import { useAction } from '../lib/mutate.ts';
import { keys } from '../lib/queries.ts';
import { useConfirm } from './Dialog.tsx';
import { Menu, MenuItem, MenuSeparator } from './Menu.tsx';
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

/** The first line of the commit message, the uploaded archive's name, or what started the deployment. */
export function deploymentTitle(m: Messages, deployment: Pick<DeploymentDto, 'commitMessage' | 'trigger' | 'upload'>): string {
  const message = deployment.commitMessage?.split('\n')[0]?.trim() ?? '';
  if (message.length > 0) return message;
  if (deployment.upload !== null) return deployment.upload.name;
  return m.deployments.titles[deployment.trigger];
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

/**
 * Timing facts shared by the list item and the deployment page. A list item
 * shows how long it took and nothing else (`compact`), unless the wait in
 * the queue is the story; the page shows every part.
 */
export function DeploymentTimingFacts({ deployment, compact = false }: { deployment: DeploymentDto; compact?: boolean }) {
  const { m, t, formatDuration } = useI18n();
  const now = useSecondTick(!isTerminalDeployment(deployment.status));
  const timing = deploymentTiming(deployment, now);
  const waitedWorthShowing = timing.waited !== null && (deployment.status === 'queued' || timing.waited >= (compact ? 30_000 : 2_000));
  return (
    <>
      {timing.total !== null && (
        <span className="fact tabular">
          {timing.live ? <LoaderCircle className="spin" aria-hidden="true" /> : <Timer aria-hidden="true" />}
          {t(timing.live ? m.deployments.running : m.deployments.took, { time: formatDuration(timing.total) })}
        </span>
      )}
      {waitedWorthShowing && (
        <span className="fact tabular">
          <Hourglass aria-hidden="true" />
          {t(m.deployments.waited, { time: formatDuration(timing.waited!) })}
        </span>
      )}
      {!compact && timing.build !== null && (
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
  const { m, t, plural, formatBytes } = useI18n();
  const confirm = useConfirm();
  const reason = useReasonText();
  const refresh = [keys.app(deployment.applicationId), keys.appPart(deployment.applicationId, 'deployments'), keys.appPart(deployment.applicationId, 'deployments-cleanup'), ...invalidate];
  const cancel = useAction(() => api.post(`/api/deployments/${deployment.id}/cancel`), { success: m.deployments.cancelled, invalidate: refresh });
  const redeploy = useAction(() => api.post(`/api/deployments/${deployment.id}/redeploy`), { success: m.app.deployQueued, invalidate: refresh });
  const remove = useAction(() => api.delete(`/api/deployments/${deployment.id}`), { success: m.deployments.deleted, invalidate: refresh });
  const running = !isTerminalDeployment(deployment.status);
  const tone = deploymentTone[deployment.status];
  const Icon = ICONS[tone];
  const detail = `/deployments/${deployment.id}`;
  const who = deployment.createdBy?.name ?? (deployment.trigger === 'push' ? deployment.commitAuthor : null);

  const title = deploymentTitle(m, deployment);
  const canGoBack = deployment.canRollback && !deployment.isActive;
  const rollback = async () => {
    const result = await confirm({ title: m.deployments.rollbackConfirmTitle, text: m.deployments.rollbackConfirmText, confirmLabel: m.deployments.rollback });
    if (result.confirmed) redeploy.mutate();
  };
  // A pushed commit says where it came from by itself; any other trigger is worth a word.
  const showTrigger = deployment.trigger !== 'push' && (deployment.commitMessage !== null || deployment.upload !== null);

  return (
    <article className="deploy-item" data-tone={tone} data-active={deployment.isActive || undefined} aria-label={`${t(m.deployments.number, { n: deployment.number })} ${title}`}>
      <span className="deploy-item__dot" aria-hidden="true">
        <Icon className={tone === 'work' ? 'spin' : undefined} />
      </span>
      <div className="deploy-item__body">
        <div className="deploy-item__head">
          <Link to={detail} className="deploy-item__title truncate">
            {title}
          </Link>
          {deployment.isActive && <Badge tone="ok">{m.deployments.active}</Badge>}
          {deployment.status === 'succeeded' && !deployment.canRollback && !deployment.isActive && <span className="deploy-item__note">{m.deployments.imageGone}</span>}
        </div>
        <div className="deploy-item__facts">
          {heading}
          <span className="deploy-item__status">{m.status.deployment[deployment.status]}</span>
          <span className="tabular">{t(m.deployments.number, { n: deployment.number })}</span>
          {(deployment.branch !== null || deployment.commitSha !== null) && (
            <span>
              <GitBranch aria-hidden="true" />
              {deployment.branch}
              {deployment.commitSha !== null && <code>{deployment.commitSha.slice(0, 7)}</code>}
            </span>
          )}
          {showTrigger && <span>{m.trigger[deployment.trigger]}</span>}
          {deployment.upload !== null && (
            <span>
              <FolderUp aria-hidden="true" />
              {plural(m.upload.files, deployment.upload.files)}, {formatBytes(deployment.upload.bytes, 0)}
            </span>
          )}
          {who !== null && (
            <span>
              <User aria-hidden="true" />
              {who}
            </span>
          )}
          <DeploymentTimingFacts deployment={deployment} compact />
        </div>
        {deployment.status === 'failed' && deployment.errorMessage !== null && (
          <div className="deploy-item__error">
            <TriangleAlert aria-hidden="true" />
            <span>{reason('deploy', deployment.errorCode, deployment.errorMessage)}</span>
          </div>
        )}
      </div>
      <div className="deploy-item__side">
        {canGoBack && (
          <Button className="deploy-item__log" variant="ghost" size="sm" icon={<History />} busy={redeploy.isPending} onClick={() => void rollback()}>
            {m.deployments.rollbackShort}
          </Button>
        )}
        <Link className="btn btn--sm btn--ghost deploy-item__log" to={detail}>
          <ScrollText width={14} height={14} aria-hidden="true" />
          {m.deployments.viewLog}
        </Link>
        <span className="deploy-item__when">
          <RelativeTime value={deployment.createdAt} />
        </span>
        <Menu trigger={(props) => <Button {...props} variant="ghost" size="sm" iconOnly icon={<Ellipsis />}>{m.common.actions}</Button>}>
          <MenuItem icon={<ScrollText />} href={detail}>
            {m.deployments.viewLog}
          </MenuItem>
          {canGoBack && (
            <MenuItem icon={<History />} onSelect={() => void rollback()}>
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
          {!running && !deployment.isActive && (
            <>
              <MenuSeparator />
              <MenuItem
                icon={<Trash2 />}
                danger
                onSelect={async () => {
                  const result = await confirm({
                    title: t(m.deployments.deleteConfirmTitle, { n: deployment.number }),
                    text: m.deployments.deleteConfirmText,
                    confirmLabel: m.deployments.delete,
                    danger: true,
                  });
                  if (result.confirmed) remove.mutate();
                }}
              >
                {m.deployments.delete}
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </article>
  );
}
