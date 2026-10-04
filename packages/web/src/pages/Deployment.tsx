import { Link, useParams } from 'react-router';
import { Ban, Download, History } from 'lucide-react';
import { isTerminalDeployment } from '@ploy/shared';
import { useConfirm } from '../components/Dialog.tsx';
import { LogViewer } from '../components/LogViewer.tsx';
import { usePageMeta } from '../components/PageMeta.tsx';
import { computeStages, PipelineRail } from '../components/Pipeline.tsx';
import { Status } from '../components/Status.tsx';
import { RelativeTime } from '../components/Time.tsx';
import { Button, ButtonLink, Callout, Skeleton } from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';
import { api } from '../lib/api.ts';
import { useLogStream } from '../lib/logs.ts';
import { useAction } from '../lib/mutate.ts';
import { keys, useApp, useDeployment } from '../lib/queries.ts';
import { NotFound } from '../app/RouteError.tsx';
import { Reason } from '../components/Reason.tsx';

export function DeploymentPage() {
  const { deploymentId = '' } = useParams();
  const { m, t, formatDuration, formatDate } = useI18n();
  const confirm = useConfirm();
  const deployment = useDeployment(deploymentId);
  const data = deployment.data;
  const app = useApp(data?.applicationId ?? '');
  const { lines } = useLogStream(data === undefined ? null : `/api/deployments/${deploymentId}/log`);
  usePageMeta([
    { label: m.nav.projects, to: '/projects' },
    ...(data === undefined ? [] : [{ label: data.applicationName, to: `/apps/${data.applicationId}/deployments` }]),
    { label: `${m.deployment.title} ${deploymentId.slice(-6)}` },
  ]);

  const invalidate = data === undefined ? [] : [keys.deployment(deploymentId), keys.appPart(data.applicationId, 'deployments')];
  const cancel = useAction(() => api.post(`/api/deployments/${deploymentId}/cancel`), { success: m.deployments.cancelled, invalidate });
  const redeploy = useAction(() => api.post<{ id: string }>(`/api/deployments/${deploymentId}/redeploy`), { success: m.app.deployQueued, invalidate });

  if (deployment.isError) return <NotFound />;
  if (data === undefined) {
    return (
      <div className="page">
        <Skeleton height={28} width={260} />
        <div style={{ height: 20 }} />
        <Skeleton height={360} />
      </div>
    );
  }

  const stages = computeStages(lines, data.status, data.finishedAt === null ? null : Date.parse(data.finishedAt));
  const failedStage = stages.find((stage) => stage.state === 'failed');
  const running = !isTerminalDeployment(data.status);

  return (
    <div className="page page--wide" style={{ maxWidth: 1400 }}>
      <section className="frame">
      <div className="frame__sheet resource">
      <header className="resource__head">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="resource__title">
            <h1 className="truncate">{data.commitMessage ?? `${m.deployment.title} ${deploymentId.slice(-6)}`}</h1>
            <Status kind="deployment" status={data.status} />
          </div>
          <dl className="resource__meta">
            <span>
              <Link to={`/apps/${data.applicationId}/deployments`}>{data.applicationName}</Link>
            </span>
            {data.commitSha !== null && (
              <span>
                <code>{data.commitSha.slice(0, 7)}</code>
                {data.branch !== null && <span className="faint"> {data.branch}</span>}
              </span>
            )}
            <span>{m.trigger[data.trigger]}</span>
            {data.createdBy !== null && <span>{t(m.deployments.by, { name: data.createdBy.name })}</span>}
            <span title={formatDate(data.createdAt)}>
              <RelativeTime value={data.createdAt} />
            </span>
            {data.durationMs !== null && data.durationMs >= 1000 && <span className="tabular">{m.deployment.duration}: {formatDuration(data.durationMs)}</span>}
            {data.buildDurationMs !== null && <span className="tabular">{m.deployment.buildTime}: {formatDuration(data.buildDurationMs)}</span>}
          </dl>
        </div>
        <div className="resource__actions">
          {running && (
            <Button icon={<Ban />} busy={cancel.isPending} onClick={() => cancel.mutate()}>
              {m.deployments.cancel}
            </Button>
          )}
          {data.canRollback && !data.isActive && (
            <Button
              icon={<History />}
              busy={redeploy.isPending}
              onClick={async () => {
                const result = await confirm({ title: m.deployments.rollbackConfirmTitle, text: m.deployments.rollbackConfirmText, confirmLabel: m.deployments.rollback });
                if (result.confirmed) redeploy.mutate();
              }}
            >
              {m.deployments.rollback}
            </Button>
          )}
          <ButtonLink href={`/api/deployments/${deploymentId}/log.txt`} icon={<Download />}>
            {m.deployment.downloadLog}
          </ButtonLink>
        </div>
      </header>

      <div className="resource__body" style={{ paddingTop: 0 }}>
      <div className="card" style={{ padding: '16px 18px 12px' }}>
        <PipelineRail stages={stages} />
      </div>

      {data.status === 'failed' && (
        <div>
          <Callout tone="bad" title={failedStage === undefined ? m.deployment.failedTitle : t(m.deployment.failedAtStage, { stage: m.stages[failedStage.stage] })}>
            <p>
              <Reason kind="deploy" code={data.errorCode} message={data.errorMessage} />
            </p>
            {app.data?.activeDeployment !== null && app.data?.activeDeployment !== undefined && app.data.activeDeployment.id !== data.id && <p>{m.deployment.previousKeptServing}</p>}
          </Callout>
        </div>
      )}
      {data.status === 'queued' && <Callout tone="work">{m.deployment.waiting}</Callout>}

      <LogViewer lines={lines} height="calc(100dvh - 420px)" empty={m.deployment.logEmpty} live={running} name={`deploy-${deploymentId.slice(-6)}`} levels={false} />
      </div>
      </div>
      </section>
    </div>
  );
}
