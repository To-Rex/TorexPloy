import { Link } from 'react-router';
import { Ban, Ellipsis, GitCommitHorizontal, History, RefreshCw, RotateCcw, ScrollText } from 'lucide-react';
import { isTerminalDeployment, type ApplicationDto, type DeploymentDto } from '@ploy/shared';
import { CopyButton, ValueField } from '../../components/Copy.tsx';
import { useConfirm } from '../../components/Dialog.tsx';
import { Card } from '../../components/Frame.tsx';
import { Menu, MenuItem } from '../../components/Menu.tsx';
import { computeStages, PipelineRail } from '../../components/Pipeline.tsx';
import { Status } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Badge, Button, Callout, SkeletonRows } from '../../components/ui.tsx';
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
    <div className="panel">
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
    <div className="list__row deploy-row">
      <div className="deploy-row__status">
        <Status kind="deployment" status={deployment.status} />
      </div>
      <Link to={`/deployments/${deployment.id}`} className="grow deploy-row__main" style={{ color: 'inherit', textDecoration: 'none', minWidth: 0 }}>
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

/** The deploy hook: a secret URL a CI system calls to start a deployment. */
function HookCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const rotate = useAction(() => api.post(`/api/applications/${app.id}/hook/rotate`), { success: m.appSettings.hookRotated, invalidate: [keys.app(app.id)] });
  return (
    <Card
      title={m.appSettings.hook}
      description={m.appSettings.hookHint}
      actions={
        <Button size="sm" icon={<RefreshCw />} busy={rotate.isPending} onClick={() => rotate.mutate()}>
          {m.appSettings.rotateHook}
        </Button>
      }
    >
      {app.deployHookUrl === null ? (
        <Callout tone="info">{m.appSettings.hookUnavailable}</Callout>
      ) : (
        <>
          <ValueField value={app.deployHookUrl} secret />
          <div className="codeblock">
            {`curl -X POST ${app.deployHookUrl}`}
            <CopyButton value={`curl -X POST ${app.deployHookUrl}`} />
          </div>
        </>
      )}
    </Card>
  );
}

export function DeploymentsTab() {
  const app = useAppContext();
  const { m } = useI18n();
  const deployments = useDeployments(app.id);
  const items = deployments.data?.pages.flatMap((page) => page.items) ?? [];
  const live = items.find((deployment) => !isTerminalDeployment(deployment.status));

  return (
    <>
      {live !== undefined && <LiveDeployment key={live.id} deployment={live} />}
      <Card title={m.deployments.title} description={m.deployments.hint} flush={items.length > 0}>
        {deployments.isPending ? (
          <SkeletonRows rows={5} />
        ) : items.length === 0 ? (
          <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{m.deployments.empty}</p>
        ) : (
          <div className="list">
            {items.map((deployment) => (
              <DeploymentRow key={deployment.id} deployment={deployment} appId={app.id} />
            ))}
          </div>
        )}
        {deployments.hasNextPage && (
          <div style={{ padding: 12 }}>
            <Button busy={deployments.isFetchingNextPage} onClick={() => void deployments.fetchNextPage()}>
              {m.deployments.loadMore}
            </Button>
          </div>
        )}
      </Card>
      <HookCard app={app} />
    </>
  );
}
