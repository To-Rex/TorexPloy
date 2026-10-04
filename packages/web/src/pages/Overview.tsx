import { Link } from 'react-router';
import { FolderKanban, GitCommitHorizontal, Plus } from 'lucide-react';
import { useState } from 'react';
import { usePageMeta } from '../components/PageMeta.tsx';
import { Status } from '../components/Status.tsx';
import { RelativeTime } from '../components/Time.tsx';
import { Button, Callout, EmptyState, Skeleton, SkeletonRows } from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useOverview, useServers } from '../lib/queries.ts';
import { NewProjectDialog } from './projects/NewProjectDialog.tsx';
import { useReasonText } from '../components/Reason.tsx';

export function OverviewPage() {
  const { m, t, plural, formatDuration } = useI18n();
  usePageMeta([{ label: m.overview.title }]);
  const overview = useOverview();
  const servers = useServers();
  const [creating, setCreating] = useState(false);
  const reason = useReasonText();
  const data = overview.data;
  const broken = (servers.data ?? []).filter((server) => server.status === 'error' || server.status === 'offline');

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head__text">
          <h1>{m.overview.title}</h1>
        </div>
        <div className="page-head__actions">
          <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
            {m.projects.new}
          </Button>
        </div>
      </div>

      {broken.map((server) => (
        <div key={server.id} style={{ marginBottom: 16 }}>
          <Callout
            tone="bad"
            title={m.overview.serverProblemTitle}
            action={
              <Link className="btn btn--sm" to={`/servers/${server.id}`} style={{ textDecoration: 'none' }}>
                {m.overview.openServer}
              </Link>
            }
          >
            {t(m.overview.serverProblemText, { server: server.name, message: server.statusMessage === null ? m.status.server[server.status] : reason('server', server.statusReason, server.statusMessage) })}
          </Callout>
        </div>
      ))}

      <div className="stat-grid">
        {[
          { label: m.overview.applications, value: data?.applications.total, foot: data === undefined ? '' : data.applications.failed > 0 ? plural(m.overview.failing, data.applications.failed) : t(m.overview.running, { count: data.applications.running }), tone: data !== undefined && data.applications.failed > 0 },
          { label: m.overview.services, value: data?.services.total, foot: data === undefined ? '' : t(m.overview.running, { count: data.services.running }), tone: false },
          { label: m.overview.servers, value: data?.servers.total, foot: data === undefined ? '' : t(m.overview.ready, { count: data.servers.ready }), tone: data !== undefined && data.servers.ready < data.servers.total },
          { label: m.overview.projects, value: data?.projects, foot: '', tone: false },
        ].map((stat) => (
          <div className="stat" key={stat.label}>
            <div className="stat__label">{stat.label}</div>
            <div className="stat__value">{stat.value === undefined ? <Skeleton width={40} height={26} /> : stat.value}</div>
            <div className="stat__foot" style={stat.tone ? { color: 'var(--bad-ink)' } : undefined}>
              {stat.foot}
            </div>
          </div>
        ))}
      </div>

      {data !== undefined && data.projects === 0 ? (
        <div style={{ marginTop: 28 }}>
          <EmptyState
            icon={<FolderKanban />}
            title={m.overview.emptyTitle}
            action={
              <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                {m.projects.new}
              </Button>
            }
          >
            {m.overview.emptyText}
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="section-title">
            <h2>{m.overview.recentDeployments}</h2>
          </div>
          {overview.isPending ? (
            <SkeletonRows rows={5} />
          ) : data!.recentDeployments.length === 0 ? (
            <p className="muted">{m.overview.noDeployments}</p>
          ) : (
            <div className="list">
              {data!.recentDeployments.map((deployment) => (
                <Link key={deployment.id} className="list__row" to={`/deployments/${deployment.id}`}>
                  <div className="grow">
                    <div className="row">
                      <span className="list__title truncate">{deployment.applicationName}</span>
                      <span className="faint truncate">{deployment.projectName}</span>
                    </div>
                    <div className="list__meta">
                      {deployment.commitSha !== null && (
                        <span className="row" style={{ gap: 5 }}>
                          <GitCommitHorizontal width={14} height={14} aria-hidden="true" />
                          <code>{deployment.commitSha.slice(0, 7)}</code>
                          <span className="truncate" style={{ maxWidth: 340 }}>{deployment.commitMessage}</span>
                        </span>
                      )}
                      <span>{m.trigger[deployment.trigger]}</span>
                      {deployment.durationMs !== null && deployment.durationMs >= 1000 && <span className="tabular">{formatDuration(deployment.durationMs)}</span>}
                    </div>
                  </div>
                  <Status kind="deployment" status={deployment.status} />
                  <span className="faint" style={{ minWidth: 90, textAlign: 'right', fontSize: 'var(--text-sm)' }}>
                    <RelativeTime value={deployment.createdAt} />
                  </span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
