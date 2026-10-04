/**
 * Every scheduled job of the team, grouped by where it runs, with its next
 * run, the outcome of the last one and a button to run it now.
 */
import { Link } from 'react-router';
import { CalendarClock, Play } from 'lucide-react';
import { roleAtLeast } from '@ploy/shared';
import { Frame } from '../components/Frame.tsx';
import { usePageMeta } from '../components/PageMeta.tsx';
import { Status } from '../components/Status.tsx';
import { RelativeTime } from '../components/Time.tsx';
import { Badge, Button, EmptyState, SkeletonRows } from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';
import { api } from '../lib/api.ts';
import { useAction } from '../lib/mutate.ts';
import { keys, useRole, useTeamCron } from '../lib/queries.ts';

export function SchedulesPage() {
  const { m, t } = useI18n();
  usePageMeta([{ label: m.schedules.title }]);
  const jobs = useTeamCron();
  const role = useRole();
  const developer = role !== null && roleAtLeast(role, 'developer');
  const run = useAction((job: { id: string; applicationId: string }) => api.post(`/api/applications/${job.applicationId}/cron/${job.id}/run`), {
    success: m.cron.started,
    invalidate: [keys.teamCron],
  });

  return (
    <div className="page">
      <Frame icon={<CalendarClock />} title={m.schedules.title} description={m.schedules.subtitle}>
        {jobs.isPending ? (
          <SkeletonRows rows={4} />
        ) : (jobs.data ?? []).length === 0 ? (
          <EmptyState icon={<CalendarClock />} title={m.schedules.emptyTitle}>
            {m.schedules.emptyText}
          </EmptyState>
        ) : (
          <div className="list">
            {jobs.data!.map((job) => (
              <div key={job.id} className="list__row">
                <span className="kind-mark">
                  <CalendarClock aria-hidden="true" />
                </span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="list__title">{job.name}</span>
                    <code className="code-inline">{job.schedule}</code>
                    {!job.enabled && <Badge>{m.cron.paused}</Badge>}
                  </div>
                  <div className="list__meta">
                    <Link to={`/apps/${job.applicationId}/schedules`}>
                      {job.applicationName}
                    </Link>
                    <span>{job.projectName}</span>
                    <code className="truncate" style={{ maxWidth: 360 }}>
                      $ {job.command}
                    </code>
                    {job.enabled && job.nextRunAt !== null && (
                      <span>
                        {t(m.cron.nextRun, { time: '' })}
                        <RelativeTime value={job.nextRunAt} />
                      </span>
                    )}
                  </div>
                </div>
                {job.lastRun !== null && <Status kind="cron" status={job.lastRun.status} />}
                {developer && (
                  <Button size="sm" icon={<Play />} busy={run.isPending && run.variables?.id === job.id} onClick={() => run.mutate(job)}>
                    {m.cron.runNow}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Frame>
    </div>
  );
}
