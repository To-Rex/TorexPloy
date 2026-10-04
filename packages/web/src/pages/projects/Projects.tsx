/**
 * The home page: every project of the team, searchable and sortable, with
 * the getting-started checklist and server problems on top while they matter.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Boxes, Clock, Database, FolderKanban, Plus, Search } from 'lucide-react';
import { Frame } from '../../components/Frame.tsx';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { useReasonText } from '../../components/Reason.tsx';
import { StatusMark } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Button, Callout, EmptyState, Input, Select, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useProjects, useServers } from '../../lib/queries.ts';
import { projectColor } from '../../app/Shell.tsx';
import { Onboarding } from '../Onboarding.tsx';
import { NewProjectDialog } from './NewProjectDialog.tsx';

type Sort = 'updated' | 'name' | 'created';

export function ProjectsPage() {
  const { m, plural, t } = useI18n();
  usePageMeta([{ label: m.projects.title }]);
  const projects = useProjects();
  const servers = useServers();
  const reason = useReasonText();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('updated');
  const broken = (servers.data ?? []).filter((server) => server.status === 'error' || server.status === 'offline');

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = (projects.data ?? []).filter((project) => needle.length === 0 || project.name.toLowerCase().includes(needle) || (project.description ?? '').toLowerCase().includes(needle));
    return [...list].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'created' ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt)));
  }, [projects.data, query, sort]);

  return (
    <div className="page">
      <Frame
        icon={<FolderKanban />}
        title={m.projects.title}
        description={m.projects.subtitle}
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
            {m.projects.new}
          </Button>
        }
      >
        {broken.map((server) => (
          <Callout
            key={server.id}
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
        ))}

        <Onboarding onCreateProject={() => setCreating(true)} />

        {projects.isPending ? (
          <div className="svc-grid">
            {[0, 1, 2].map((index) => (
              <div key={index} className="project-tile">
                <Skeleton height={38} />
                <Skeleton height={14} width="70%" />
              </div>
            ))}
          </div>
        ) : projects.data!.length === 0 ? (
          <EmptyState
            icon={<FolderKanban />}
            title={m.projects.emptyTitle}
            action={
              <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                {m.projects.new}
              </Button>
            }
          >
            {m.projects.emptyText}
          </EmptyState>
        ) : (
          <>
            <div className="toolbar">
              <label className="toolbar__search">
                <Search aria-hidden="true" />
                <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={m.projects.search} aria-label={m.projects.search} />
              </label>
              <span className="toolbar__spacer" />
              <Select value={sort} onChange={(event) => setSort(event.target.value as Sort)} aria-label={m.projects.sort}>
                <option value="updated">{m.projects.sortUpdated}</option>
                <option value="name">{m.projects.sortName}</option>
                <option value="created">{m.projects.sortCreated}</option>
              </Select>
            </div>
            {visible.length === 0 ? (
              <p className="muted" style={{ padding: '12px 2px' }}>
                {m.projects.noMatch}
              </p>
            ) : (
              <div className="svc-grid">
                {visible.map((project) => {
                  const summary = project.statusSummary;
                  const tone = summary.failed > 0 ? 'bad' : summary.building > 0 ? 'work' : summary.running > 0 ? 'ok' : 'idle';
                  const label = summary.failed > 0 ? plural(m.overview.failing, summary.failed) : summary.building > 0 ? m.status.app.building : t(m.overview.running, { count: summary.running });
                  return (
                    <Link key={project.id} className="project-tile" to={`/projects/${project.id}`} style={{ ['--project-color' as string]: projectColor(project.id) }}>
                      <div className="project-tile__top">
                        <span className="project-card__mark" aria-hidden="true">
                          {project.name.slice(0, 1).toUpperCase()}
                        </span>
                        <div className="grow" style={{ minWidth: 0 }}>
                          <div className="project-tile__name">{project.name}</div>
                          {summary.total > 0 ? <StatusMark tone={tone} label={label} /> : <span className="faint" style={{ fontSize: 'var(--text-sm)' }}>{m.projects.emptyShort}</span>}
                        </div>
                      </div>
                      <p className="project-tile__desc">{project.description ?? m.projects.noDescription}</p>
                      <div className="project-tile__foot">
                        <span>
                          <Boxes aria-hidden="true" />
                          {project.applicationCount}
                          <span className="sr-only">{plural(m.projects.apps, project.applicationCount)}</span>
                        </span>
                        <span>
                          <Database aria-hidden="true" />
                          {project.serviceCount}
                          <span className="sr-only">{plural(m.projects.services, project.serviceCount)}</span>
                        </span>
                        <span className="grow" />
                        <span>
                          <Clock aria-hidden="true" />
                          <RelativeTime value={project.updatedAt} />
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </>
        )}
      </Frame>
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
