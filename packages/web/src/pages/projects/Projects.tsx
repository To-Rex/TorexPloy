import { useState } from 'react';
import { Link } from 'react-router';
import { FolderKanban, Plus } from 'lucide-react';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Button, EmptyState, SkeletonRows } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useProjects } from '../../lib/queries.ts';
import { projectColor } from '../../app/Shell.tsx';
import { StatusMark } from '../../components/Status.tsx';
import { NewProjectDialog } from './NewProjectDialog.tsx';

export function ProjectsPage() {
  const { m, plural, t } = useI18n();
  usePageMeta([{ label: m.projects.title }]);
  const projects = useProjects();
  const [creating, setCreating] = useState(false);

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head__text">
          <h1>{m.projects.title}</h1>
          <p>{m.projects.subtitle}</p>
        </div>
        <div className="page-head__actions">
          <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
            {m.projects.new}
          </Button>
        </div>
      </div>
      {projects.isPending ? (
        <SkeletonRows rows={4} />
      ) : projects.data!.length === 0 ? (
        <EmptyState icon={<FolderKanban />} title={m.projects.emptyTitle} action={<Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>{m.projects.new}</Button>}>
          {m.projects.emptyText}
        </EmptyState>
      ) : (
        <div className="list">
          {projects.data!.map((project) => {
            const summary = project.statusSummary;
            const tone = summary.failed > 0 ? 'bad' : summary.building > 0 ? 'work' : summary.running > 0 ? 'ok' : 'idle';
            const label = summary.failed > 0 ? plural(m.overview.failing, summary.failed) : summary.building > 0 ? m.status.app.building : t(m.overview.running, { count: summary.running });
            return (
              <Link key={project.id} className="list__row" to={`/projects/${project.id}`}>
                <span className="project-dot" style={{ ['--project-color' as string]: projectColor(project.id), width: 10, height: 10, borderRadius: 3 }} aria-hidden="true" />
                <div className="grow">
                  <div className="list__title truncate">{project.name}</div>
                  <div className="list__meta">
                    <span>{plural(m.projects.apps, project.applicationCount)}</span>
                    <span>{plural(m.projects.services, project.serviceCount)}</span>
                    {project.description !== null && <span className="truncate" style={{ maxWidth: 420 }}>{project.description}</span>}
                  </div>
                </div>
                {summary.total > 0 && <StatusMark tone={tone} label={label} />}
                <span className="faint" style={{ fontSize: 'var(--text-sm)', minWidth: 110, textAlign: 'right' }}>
                  <RelativeTime value={project.updatedAt} />
                </span>
              </Link>
            );
          })}
        </div>
      )}
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
