/**
 * A project, the way Dokploy shows one: every service it holds — apps,
 * compose stacks and databases — in one searchable grid, one "Create
 * service" menu, the project's shared variables behind a button, and bulk
 * actions for what is selected.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Boxes, ChevronDown, Database, Ellipsis, Globe, Layers, LayoutGrid, Link2, Pencil, Play, Plus, Rocket, Search, Square, Trash2, Variable, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { updateProjectSchema, type ApplicationDto, type ServiceDto } from '@ploy/shared';
import { useConfirm, Dialog } from '../../components/Dialog.tsx';
import { EnvEditor } from '../../components/EnvEditor.tsx';
import { Frame } from '../../components/Frame.tsx';
import { AppMark, ServiceMark } from '../../components/KindMark.tsx';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu.tsx';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { Status } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Badge, Button, Field, Input, Segmented, Skeleton, Textarea } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useProject, useProjectVariables, useTemplates } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { NotFound } from '../../app/RouteError.tsx';
import { NewAppDialog } from './NewAppDialog.tsx';
import { NewComposeDialog } from './NewComposeDialog.tsx';
import { NewServiceDialog } from './NewServiceDialog.tsx';
import { TemplateMark, TemplatesDialog } from './TemplatesDialog.tsx';

type Filter = 'all' | 'apps' | 'compose' | 'databases';
type Item = { key: string; kind: 'app'; app: ApplicationDto } | { key: string; kind: 'service'; service: ServiceDto };
type BulkAction = 'deploy' | 'start' | 'stop';

/** A card that can be selected: the checkbox sits beside the link, not inside it, so ticking it never navigates. */
function Selectable({ selected, onSelect, label, children }: { selected: boolean; onSelect: () => void; label: string; children: ReactNode }) {
  return (
    <div className="svc-item" data-selected={selected || undefined}>
      <label className="svc-card__check">
        <input type="checkbox" checked={selected} onChange={onSelect} aria-label={label} />
      </label>
      {children}
    </div>
  );
}

function AppCard({ app, selected, onSelect }: { app: ApplicationDto; selected: boolean; onSelect: () => void }) {
  const { m, t } = useI18n();
  const templates = useTemplates(app.templateId !== null);
  const template = templates.data?.find((candidate) => candidate.id === app.templateId);
  const deployment = app.latestDeployment;
  return (
    <Selectable selected={selected} onSelect={onSelect} label={t(m.project.select, { name: app.name })}>
    <Link className="svc-card" to={`/apps/${app.id}`}>
      <div className="svc-card__top">
        {template !== undefined ? <TemplateMark template={template} size={38} /> : <AppMark kind={app.kind} />}
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="svc-card__name">{app.name}</div>
          <div className="svc-card__sub">
            {app.url !== null ? app.url.replace(/^https?:\/\//, '') : app.kind === 'worker' ? m.app.kindWorker : app.kind === 'compose' ? m.compose.kindLabel : m.project.noUrl}
          </div>
        </div>
        <Status kind="app" status={app.status} />
      </div>
      <div className="svc-card__foot">
        {deployment === null ? (
          <span>{m.project.neverDeployed}</span>
        ) : (
          <>
            {deployment.commitSha !== null ? <code>{deployment.commitSha.slice(0, 7)}</code> : <span>{m.trigger[deployment.trigger]}</span>}
            <span className="truncate grow">{deployment.commitMessage ?? ''}</span>
            <span style={{ whiteSpace: 'nowrap' }}>
              <RelativeTime value={deployment.createdAt} />
            </span>
          </>
        )}
      </div>
    </Link>
    </Selectable>
  );
}

function ServiceCard({ service, selected, onSelect }: { service: ServiceDto; selected: boolean; onSelect: () => void }) {
  const { m, t } = useI18n();
  return (
    <Selectable selected={selected} onSelect={onSelect} label={t(m.project.select, { name: service.name })}>
    <Link className="svc-card" to={`/services/${service.id}`}>
      <div className="svc-card__top">
        <ServiceMark type={service.type} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="svc-card__name">{service.name}</div>
          <div className="svc-card__sub">
            {m.project.databaseLabel[service.type]} {service.version}
          </div>
        </div>
        <Status kind="service" status={service.status} />
      </div>
      <div className="svc-card__foot">
        <code className="truncate">
          {service.internalHost}:{service.internalPort}
        </code>
        {service.linkedApplications.length > 0 && (
          <span className="row truncate" style={{ gap: 5 }}>
            <Link2 width={13} height={13} aria-hidden="true" />
            {service.linkedApplications.map((app) => app.name).join(', ')}
          </span>
        )}
        <span className="grow" />
        {service.publicPort !== null && (
          <Badge tone="work" icon={<Globe />}>
            {service.publicPort}
          </Badge>
        )}
      </div>
    </Link>
    </Selectable>
  );
}

export function ProjectPage() {
  const { projectId = '' } = useParams();
  const { m, t, plural } = useI18n();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const client = useQueryClient();
  const project = useProject(projectId);
  const [variablesOpen, setVariablesOpen] = useState(false);
  const variables = useProjectVariables(projectId);
  const [newApp, setNewApp] = useState(false);
  const [newService, setNewService] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [newCompose, setNewCompose] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const createOptions = [
    { id: 'app', icon: <Boxes />, title: m.create.app, hint: m.create.appHint, run: () => setNewApp(true) },
    { id: 'compose', icon: <Layers />, title: m.create.compose, hint: m.create.composeHint, run: () => setNewCompose(true) },
    { id: 'database', icon: <Database />, title: m.create.database, hint: m.create.databaseHint, run: () => setNewService(true) },
    { id: 'template', icon: <LayoutGrid />, title: m.create.template, hint: m.create.templateHint, run: () => setTemplates(true) },
  ];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: '', description: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const data = project.data;
  usePageMeta([{ label: m.nav.projects, to: '/projects' }, { label: data?.project.name ?? '…' }]);

  const items = useMemo<Item[]>(() => {
    if (data === undefined) return [];
    return [
      ...data.applications.map((app) => ({ key: `app:${app.id}`, kind: 'app' as const, app })),
      ...data.services.map((service) => ({ key: `svc:${service.id}`, kind: 'service' as const, service })),
    ];
  }, [data]);
  const counts = {
    all: items.length,
    apps: items.filter((item) => item.kind === 'app' && item.app.kind !== 'compose').length,
    compose: items.filter((item) => item.kind === 'app' && item.app.kind === 'compose').length,
    databases: items.filter((item) => item.kind === 'service').length,
  };
  const visible = items.filter((item) => {
    if (filter === 'apps' && !(item.kind === 'app' && item.app.kind !== 'compose')) return false;
    if (filter === 'compose' && !(item.kind === 'app' && item.app.kind === 'compose')) return false;
    if (filter === 'databases' && item.kind !== 'service') return false;
    const needle = query.trim().toLowerCase();
    const name = item.kind === 'app' ? item.app.name : item.service.name;
    return needle.length === 0 || name.toLowerCase().includes(needle);
  });

  const toggle = (key: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const chosen = items.filter((item) => selected.has(item.key));

  const runBulk = async (action: BulkAction) => {
    const targets = chosen.filter((item) => action !== 'deploy' || item.kind === 'app');
    if (action === 'stop') {
      const result = await confirm({ title: m.project.bulkStopTitle, text: plural(m.project.bulkStopText, targets.length), confirmLabel: m.project.bulkStop, danger: true });
      if (!result.confirmed) return;
    }
    setBulkBusy(true);
    const outcomes = await Promise.allSettled(
      targets.map((item) =>
        item.kind === 'app'
          ? api.post(`/api/applications/${item.app.id}/${action}`, action === 'deploy' ? { clearCache: false } : undefined)
          : api.post(`/api/services/${item.service.id}/${action === 'deploy' ? 'redeploy' : action}`),
      ),
    );
    setBulkBusy(false);
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected').length;
    if (failed === 0) toast.success(plural(m.project.bulkDone, targets.length));
    else toast.failure(t(m.project.bulkPartial, { failed, total: targets.length }));
    setSelected(new Set());
    void client.invalidateQueries({ queryKey: keys.project(projectId) });
  };

  const saveVariables = useAction((list: { key: string; value: string }[]) => api.put(`/api/projects/${projectId}/variables`, { variables: list }), {
    success: m.variables.saved,
    invalidate: [[...keys.project(projectId), 'variables'], keys.project(projectId)],
  });
  const update = useAction((input: { name: string; description: string | null }) => api.patch(`/api/projects/${projectId}`, input), {
    success: m.project.renamed,
    invalidate: [keys.project(projectId), keys.projects],
    onSuccess: () => setEditing(false),
  });
  const remove = useAction((removeData: boolean) => api.delete(`/api/projects/${projectId}?removeData=${removeData}`), {
    success: m.project.deleted,
    invalidate: [keys.projects, keys.overview],
    onSuccess: () => void navigate('/projects'),
  });

  if (project.isError) return <NotFound />;
  const variableCount = variables.data?.variables.length ?? 0;
  const anyApp = chosen.some((item) => item.kind === 'app');

  return (
    <div className="page">
      <Frame
        title={data?.project.name ?? <Skeleton width={220} height={26} />}
        description={data === undefined ? undefined : (data.project.description ?? m.projects.noDescription)}
        actions={
          <>
            <Button icon={<Variable />} onClick={() => setVariablesOpen(true)}>
              {m.project.variablesButton}
              {variableCount > 0 && <span className="count">{variableCount}</span>}
            </Button>
            <Menu
              trigger={(props) => (
                <Button {...props} variant="primary" icon={<Plus />}>
                  {m.create.button}
                  <ChevronDown width={15} height={15} aria-hidden="true" style={{ marginRight: -4 }} />
                </Button>
              )}
            >
              {createOptions.map((option) => (
                <MenuItem key={option.id} icon={option.icon} onSelect={option.run}>
                  <span className="menu__rich">
                    <span>{option.title}</span>
                    <small>{option.hint}</small>
                  </span>
                </MenuItem>
              ))}
            </Menu>
            <Menu trigger={(props) => <Button {...props} iconOnly icon={<Ellipsis />}>{m.common.more}</Button>}>
              <MenuItem
                icon={<Pencil />}
                onSelect={() => {
                  setDraft({ name: data?.project.name ?? '', description: data?.project.description ?? '' });
                  setErrors({});
                  setEditing(true);
                }}
              >
                {m.project.edit}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<Trash2 />}
                danger
                onSelect={async () => {
                  const result = await confirm({
                    title: m.project.deleteTitle,
                    text: m.project.deleteText,
                    confirmLabel: m.common.delete,
                    danger: true,
                    typeToConfirm: data?.project.name ?? '',
                    checkbox: { label: m.project.deleteData, hint: m.project.deleteDataHint },
                  });
                  if (result.confirmed) remove.mutate(result.checked);
                }}
              >
                {m.project.deleteTitle}
              </MenuItem>
            </Menu>
          </>
        }
      >
        {data === undefined ? (
          <div className="svc-grid">
            {[0, 1, 2].map((index) => (
              <div key={index} className="svc-card">
                <Skeleton height={38} />
                <Skeleton height={14} width="60%" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="create-tiles">
            <div className="create-tiles__intro">
              <h3>{m.project.emptyAppsTitle}</h3>
              <p>{m.project.emptyAppsText}</p>
            </div>
            {createOptions.map((option) => (
              <button key={option.id} type="button" className="create-tile" onClick={option.run}>
                <span className="create-tile__icon">{option.icon}</span>
                <span className="create-tile__title">{option.title}</span>
                <span className="create-tile__hint">{option.hint}</span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="toolbar">
              <label className="toolbar__search">
                <Search aria-hidden="true" />
                <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={m.project.search} aria-label={m.project.search} />
              </label>
              <Segmented
                label={m.project.filter}
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: `${m.project.filters.all} ${counts.all}` },
                  ...(counts.apps > 0 ? [{ value: 'apps' as const, label: `${m.project.filters.apps} ${counts.apps}` }] : []),
                  ...(counts.compose > 0 ? [{ value: 'compose' as const, label: `${m.project.filters.compose} ${counts.compose}` }] : []),
                  ...(counts.databases > 0 ? [{ value: 'databases' as const, label: `${m.project.filters.databases} ${counts.databases}` }] : []),
                ]}
              />
            </div>

            {chosen.length > 0 && (
              <div className="bulkbar" role="region" aria-label={m.project.bulkLabel}>
                <span className="bulkbar__count">{plural(m.project.selected, chosen.length)}</span>
                {anyApp && (
                  <Button size="sm" icon={<Rocket />} disabled={bulkBusy} onClick={() => void runBulk('deploy')}>
                    {m.project.bulkDeploy}
                  </Button>
                )}
                <Button size="sm" icon={<Play />} disabled={bulkBusy} onClick={() => void runBulk('start')}>
                  {m.project.bulkStart}
                </Button>
                <Button size="sm" icon={<Square />} disabled={bulkBusy} onClick={() => void runBulk('stop')}>
                  {m.project.bulkStop}
                </Button>
                <Button size="sm" variant="ghost" icon={<X />} onClick={() => setSelected(new Set())}>
                  {m.project.clearSelection}
                </Button>
              </div>
            )}

            {visible.length === 0 ? (
              <p className="muted" style={{ padding: '12px 2px' }}>
                {m.project.noMatch}
              </p>
            ) : (
              <div className="svc-grid" data-selecting={chosen.length > 0 || undefined}>
                {visible.map((item) =>
                  item.kind === 'app' ? (
                    <AppCard key={item.key} app={item.app} selected={selected.has(item.key)} onSelect={() => toggle(item.key)} />
                  ) : (
                    <ServiceCard key={item.key} service={item.service} selected={selected.has(item.key)} onSelect={() => toggle(item.key)} />
                  ),
                )}
              </div>
            )}
          </>
        )}
      </Frame>

      <NewAppDialog projectId={projectId} open={newApp} onClose={() => setNewApp(false)} />
      <NewServiceDialog projectId={projectId} open={newService} onClose={() => setNewService(false)} />
      <TemplatesDialog projectId={projectId} open={templates} onClose={() => setTemplates(false)} />
      <NewComposeDialog projectId={projectId} open={newCompose} onClose={() => setNewCompose(false)} />
      <Dialog open={variablesOpen} onClose={() => setVariablesOpen(false)} wide title={m.project.variables} description={m.project.variablesHint}>
        {variables.data === undefined ? <Skeleton height={120} /> : <EnvEditor variables={variables.data.variables} onSave={(list) => saveVariables.mutateAsync(list)} saving={saveVariables.isPending} />}
      </Dialog>
      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title={m.project.settings}
        onSubmit={() => {
          const payload = { name: draft.name.trim(), description: draft.description.trim().length === 0 ? null : draft.description.trim() };
          const result = validate(m, updateProjectSchema, { name: payload.name, ...(payload.description === null ? {} : { description: payload.description }) });
          if (result.errors !== null) {
            setErrors(result.errors);
            return;
          }
          update.mutate(payload);
        }}
        footer={
          <>
            <Button onClick={() => setEditing(false)}>{m.common.cancel}</Button>
            <Button type="submit" variant="primary" busy={update.isPending}>
              {m.common.save}
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label={m.projects.name} error={errors.name}>
            <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Field>
          <Field label={m.projects.description} optional={m.common.optional}>
            <Textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={3} />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
