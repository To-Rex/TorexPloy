/**
 * Every deployment of the team in one place, newest first: what is
 * building right now, what failed, what shipped.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { GitCommitHorizontal, Rocket } from 'lucide-react';
import type { DeploymentStatusFilter } from '@ploy/shared';
import { Frame } from '../components/Frame.tsx';
import { AppMark } from '../components/KindMark.tsx';
import { usePageMeta } from '../components/PageMeta.tsx';
import { useReasonText } from '../components/Reason.tsx';
import { Status } from '../components/Status.tsx';
import { RelativeTime } from '../components/Time.tsx';
import { Button, EmptyState, Segmented, SkeletonRows } from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useTeamDeployments } from '../lib/queries.ts';

type Filter = 'all' | Extract<DeploymentStatusFilter, 'active' | 'succeeded' | 'failed'>;

export function DeploymentsPage() {
  const { m, t, formatDuration } = useI18n();
  usePageMeta([{ label: m.teamDeployments.title }]);
  const reason = useReasonText();
  const [filter, setFilter] = useState<Filter>('all');
  const deployments = useTeamDeployments(filter === 'all' ? null : filter);
  const items = deployments.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="page">
      <Frame icon={<Rocket />} title={m.teamDeployments.title} description={m.teamDeployments.subtitle}>
        <div className="toolbar">
          <Segmented
            label={m.teamDeployments.filter}
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: m.teamDeployments.filters.all },
              { value: 'active', label: m.teamDeployments.filters.active },
              { value: 'succeeded', label: m.teamDeployments.filters.succeeded },
              { value: 'failed', label: m.teamDeployments.filters.failed },
            ]}
          />
        </div>
        {deployments.isPending ? (
          <SkeletonRows rows={6} />
        ) : items.length === 0 ? (
          <EmptyState icon={<Rocket />} title={filter === 'all' ? m.teamDeployments.emptyTitle : undefined}>
            {filter === 'all' ? m.teamDeployments.emptyText : m.teamDeployments.emptyFiltered}
          </EmptyState>
        ) : (
          <div className="list">
            {items.map((deployment) => (
              <Link key={deployment.id} className="list__row deploy-row" to={`/deployments/${deployment.id}`} style={{ color: 'inherit' }}>
                <AppMark kind={deployment.applicationKind} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="list__title truncate">{deployment.applicationName}</span>
                    <span className="faint truncate">{deployment.projectName}</span>
                  </div>
                  <div className="list__meta">
                    {deployment.commitSha !== null && (
                      <span className="row" style={{ gap: 5 }}>
                        <GitCommitHorizontal width={14} height={14} aria-hidden="true" />
                        <code>{deployment.commitSha.slice(0, 7)}</code>
                        {deployment.commitMessage !== null && (
                          <span className="truncate" style={{ maxWidth: 340 }}>
                            {deployment.commitMessage}
                          </span>
                        )}
                      </span>
                    )}
                    <span>{m.trigger[deployment.trigger]}</span>
                    {deployment.createdBy !== null && <span>{t(m.deployments.by, { name: deployment.createdBy.name })}</span>}
                    {deployment.durationMs !== null && deployment.durationMs >= 1000 && <span className="tabular">{formatDuration(deployment.durationMs)}</span>}
                    {deployment.status === 'failed' && deployment.errorMessage !== null && (
                      <span className="truncate" style={{ color: 'var(--bad-ink)', maxWidth: 420 }}>
                        {reason('deploy', deployment.errorCode, deployment.errorMessage)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="deploy-row__status">
                  <Status kind="deployment" status={deployment.status} />
                </div>
                <span className="faint" style={{ minWidth: 88, textAlign: 'right', fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
                  <RelativeTime value={deployment.createdAt} />
                </span>
              </Link>
            ))}
          </div>
        )}
        {deployments.hasNextPage && (
          <div>
            <Button busy={deployments.isFetchingNextPage} onClick={() => void deployments.fetchNextPage()}>
              {m.deployments.loadMore}
            </Button>
          </div>
        )}
      </Frame>
    </div>
  );
}
