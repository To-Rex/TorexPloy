/**
 * Every deployment of the team in one place, newest first: what is
 * building right now, what failed, what shipped.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { Rocket } from 'lucide-react';
import type { DeploymentStatusFilter } from '@ploy/shared';
import { DeploymentItem } from '../components/DeploymentItem.tsx';
import { Frame } from '../components/Frame.tsx';
import { AppMark } from '../components/KindMark.tsx';
import { usePageMeta } from '../components/PageMeta.tsx';
import { Button, EmptyState, Segmented, SkeletonRows } from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';
import { keys, useTeamDeployments } from '../lib/queries.ts';

type Filter = 'all' | Extract<DeploymentStatusFilter, 'active' | 'succeeded' | 'failed'>;

export function DeploymentsPage() {
  const { m } = useI18n();
  usePageMeta([{ label: m.teamDeployments.title }]);
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
          <div className="deploy-list">
            {items.map((deployment) => (
              <DeploymentItem
                key={deployment.id}
                deployment={deployment}
                invalidate={[keys.teamDeployments]}
                heading={
                  <Link to={`/apps/${deployment.applicationId}/deployments`} className="deploy-item__app">
                    <AppMark kind={deployment.applicationKind} />
                    <span className="truncate">{deployment.applicationName}</span>
                    <span className="faint truncate">{deployment.projectName}</span>
                  </Link>
                }
              />
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
