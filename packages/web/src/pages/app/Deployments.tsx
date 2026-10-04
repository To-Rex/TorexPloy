import { Link } from 'react-router';
import { Ban, Ellipsis, GitCommitHorizontal, History, RotateCcw, ScrollText } from 'lucide-react';
import { isTerminalDeployment, type DeploymentDto } from '@ploy/shared';
import { useConfirm } from '../../components/Dialog.tsx';
import { Menu, MenuItem } from '../../components/Menu.tsx';
import { computeStages, PipelineRail } from '../../components/Pipeline.tsx';
import { Status } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Badge, Button, EmptyState, SkeletonRows } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { useLogStream } from '../../lib/logs.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useDeployments } from '../../lib/queries.ts';
import { useAppContext } from './AppLayout.tsx';
import { useReasonText } from '../../components/Reason.tsx';

/** The in-flight deployment: live pipeline rail and the tail of its log. */
function LiveDeployment({ deployment }: { deployment: DeploymentDto }) {
  const { m } = useI18n();
  const { lines } = useLogStream(`/api/deployments/${deployment.id}/log`);
  const stages = computeStages(lines, deployment.status, deployment.finishedAt === null ? null : Date.parse(deployment.finishedAt));
  const tail = lines.slice(-5);
  return (
    <div className="panel" style={{ marginBottom: 20 }}>
      <div className="panel__head">
        <Status kind="deployment" status={deployment.status} />
        <span className="grow truncate muted">{deployment.commitMessage ?? m.trigger[deployment.trigger]}</span>
        <Link className="btn btn--sm" to={`/deployments/${deployment.id}`} style={{ textDecoration: 'none' }}>
          <ScrollText width={14} height={14} aria-hidden="true" />
          {m.deployments.viewLog}
        </Link>
      </div>
      <div className="panel__body" style={{ display: 'grid', gap: 16 }}>
        <PipelineRail stages={stages} />
        {tail.length > 0 && (
          <div className="codeblock" style={{ paddingRight: 14, maxHeight: 120, overflow: 'hidden' }} aria-hidden="true">
            {tail.map((line) => line.text).join('\n')}
          </div>
        )}
      </div>
    </div>
  );
}

export function DeploymentRow({ deployment, appId }: { deployment: DeploymentDto; appId: string }) {
  const { m, t, formatDuration } = useI18n();
  const confirm = useConfirm();
  const reason = useReasonText();
  const invalidate = [keys.app(appId), keys.appPart(appId, 'deployments')];
  const cancel = useAction(() => api.post(`/api/deployments/${deployment.id}/cancel`), { success: m.deployments.cancelled, invalidate });
  const redeploy = useAction(() => api.post(`/api/deployments/${deployment.id}/redeploy`), { success: m.app.deployQueued, invalidate });
  const running = !isTerminalDeployment(deployment.status);

  return (
    <div className="list__row">
      <div style={{ width: 132, flex: 'none' }}>
        <Status kind="deployment" status={deployment.status} />
      </div>
      <Link to={`/deployments/${deployment.id}`} className="grow" style={{ color: 'inherit', textDecoration: 'none', minWidth: 0 }}>
        <div className="row">
          {deployment.commitSha !== null && (
            <span className="row faint" style={{ gap: 4, flex: 'none' }}>
              <GitCommitHorizontal width={14} height={14} aria-hidden="true" />
              <code>{deployment.commitSha.slice(0, 7)}</code>
            </span>
          )}
          <span className="list__title truncate">{deployment.commitMessage ?? `${m.deployment.title} ${deployment.id.slice(-6)}`}</span>
          {deployment.isActive && <Badge tone="ok">{m.deployments.active}</Badge>}
        </div>
        <div className="list__meta">
          <span>{m.trigger[deployment.trigger]}</span>
          <span>{deployment.createdBy !== null ? t(m.deployments.by, { name: deployment.createdBy.name }) : deployment.trigger === 'push' ? (deployment.commitAuthor ?? m.deployments.byPush) : ''}</span>
          {deployment.durationMs !== null && deployment.durationMs >= 1000 && <span className="tabular">{formatDuration(deployment.durationMs)}</span>}
          {deployment.status === 'failed' && deployment.errorMessage !== null && (
            <span className="truncate" style={{ color: 'var(--bad-ink)', maxWidth: 460 }}>
              {reason('deploy', deployment.errorCode, deployment.errorMessage)}
            </span>
          )}
        </div>
      </Link>
      <span className="faint" style={{ fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
        <RelativeTime value={deployment.createdAt} />
      </span>
      <Menu trigger={(props) => <Button {...props} variant="ghost" size="sm" iconOnly icon={<Ellipsis />}>{m.common.actions}</Button>}>
        <MenuItem icon={<ScrollText />} href={`/deployments/${deployment.id}`}>
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
  );
}

export function DeploymentsTab() {
  const app = useAppContext();
  const { m } = useI18n();
  const deployments = useDeployments(app.id);
  const items = deployments.data?.pages.flatMap((page) => page.items) ?? [];
  const live = items.find((deployment) => !isTerminalDeployment(deployment.status));

  if (deployments.isPending) return <SkeletonRows rows={5} />;
  if (items.length === 0) return <EmptyState icon={<History />}>{m.deployments.empty}</EmptyState>;
  return (
    <>
      {live !== undefined && <LiveDeployment key={live.id} deployment={live} />}
      <div className="list">
        {items.map((deployment) => (
          <DeploymentRow key={deployment.id} deployment={deployment} appId={app.id} />
        ))}
      </div>
      {deployments.hasNextPage && (
        <div style={{ marginTop: 12 }}>
          <Button busy={deployments.isFetchingNextPage} onClick={() => void deployments.fetchNextPage()}>
            {m.deployments.loadMore}
          </Button>
        </div>
      )}
    </>
  );
}
