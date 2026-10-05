import { Link } from 'react-router';
import { RefreshCw, ScrollText } from 'lucide-react';
import { isTerminalDeployment, type ApplicationDto, type DeploymentDto } from '@ploy/shared';
import { CopyButton, ValueField } from '../../components/Copy.tsx';
import { DeploymentItem, deploymentTitle } from '../../components/DeploymentItem.tsx';
import { Card } from '../../components/Frame.tsx';
import { computeStages, PipelineRail } from '../../components/Pipeline.tsx';
import { Status } from '../../components/Status.tsx';
import { Button, Callout, SkeletonRows } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { useLogStream } from '../../lib/logs.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useDeployments } from '../../lib/queries.ts';
import { useAppContext } from './AppLayout.tsx';

/** The in-flight deployment: live pipeline rail and the tail of its log. */
function LiveDeployment({ deployment }: { deployment: DeploymentDto }) {
  const { m, t } = useI18n();
  const { lines } = useLogStream(`/api/deployments/${deployment.id}/log`);
  const stages = computeStages(lines, deployment.status, deployment.finishedAt === null ? null : Date.parse(deployment.finishedAt));
  const tail = lines.slice(-5);
  return (
    <div className="panel">
      <div className="panel__head">
        <Status kind="deployment" status={deployment.status} />
        <span className="grow truncate muted">
          <span className="tabular faint">{t(m.deployments.number, { n: deployment.number })}</span> {deploymentTitle(m, deployment)}
        </span>
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
          <div className="deploy-list">
            {items.map((deployment) => (
              <DeploymentItem key={deployment.id} deployment={deployment} />
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
