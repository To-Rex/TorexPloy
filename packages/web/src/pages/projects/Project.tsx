import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Boxes, Database, Ellipsis, Globe, Link2, Pencil, Plus, Trash2, Workflow } from 'lucide-react';
import { updateProjectSchema, type ApplicationDto, type ServiceDto } from '@ploy/shared';
import { useConfirm, Dialog } from '../../components/Dialog.tsx';
import { EnvEditor } from '../../components/EnvEditor.tsx';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu.tsx';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { Status } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Badge, Button, EmptyState, Field, Input, Skeleton, Textarea } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useProject, useProjectVariables } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { NotFound } from '../../app/RouteError.tsx';
import { NewAppDialog } from './NewAppDialog.tsx';
import { NewServiceDialog } from './NewServiceDialog.tsx';

function AppCard({ app, services }: { app: ApplicationDto; services: ServiceDto[] }) {
  const { m } = useI18n();
  const linked = services.filter((service) => service.linkedApplications.some((candidate) => candidate.id === app.id));
  const deployment = app.latestDeployment;
  return (
    <Link className="resource-card" to={`/apps/${app.id}`}>
      <div className="resource-card__top">
        <span className="resource-card__icon">{app.kind === 'worker' ? <Workflow /> : <Boxes />}</span>
        <div className="grow">
          <div className="resource-card__name truncate">{app.name}</div>
          <div className="resource-card__sub truncate">{app.url === null ? (app.kind === 'worker' ? m.app.kindWorker : m.project.noUrl) : app.url.replace(/^https?:\/\//, '')}</div>
        </div>
        <Status kind="app" status={app.status} />
      </div>
      {linked.length > 0 && (
        <div className="resource-card__links">
          {linked.map((service) => (
            <Badge key={service.id} icon={<Database />}>
              {service.name}
            </Badge>
          ))}
        </div>
      )}
      <div className="resource-card__foot">
        {deployment === null ? (
          <span className="faint">{m.deployments.empty}</span>
        ) : (
          <>
            {deployment.commitSha !== null ? <code className="faint">{deployment.commitSha.slice(0, 7)}</code> : <span className="faint">{m.trigger[deployment.trigger]}</span>}
            <span className="truncate grow">{deployment.commitMessage ?? ''}</span>
            <span className="faint" style={{ whiteSpace: 'nowrap' }}>
              <RelativeTime value={deployment.createdAt} />
            </span>
          </>
        )}
      </div>
    </Link>
  );
}

function ServiceCard({ service }: { service: ServiceDto }) {
  return (
    <Link className="resource-card" to={`/services/${service.id}`}>
      <div className="resource-card__top">
        <span className="resource-card__icon">
          <Database />
        </span>
        <div className="grow">
          <div className="resource-card__name truncate">{service.name}</div>
          <div className="resource-card__sub">
            {service.type} {service.version}
          </div>
        </div>
        <Status kind="service" status={service.status} />
      </div>
      <div className="resource-card__foot">
        <code className="faint truncate">
          {service.internalHost}:{service.internalPort}
        </code>
        {service.linkedApplications.length > 0 && (
          <span className="row truncate faint" style={{ gap: 5 }}>
            <Link2 width={13} height={13} aria-hidden="true" />
            {service.linkedApplications.map((app) => app.name).join(', ')}
          </span>
        )}
        {service.publicPort !== null && (
          <Badge tone="work" icon={<Globe />}>
            {service.publicPort}
          </Badge>
        )}
      </div>
    </Link>
  );
}

export function ProjectPage() {
  const { projectId = '' } = useParams();
  const { m } = useI18n();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const project = useProject(projectId);
  const variables = useProjectVariables(projectId);
  const [newApp, setNewApp] = useState(false);
  const [newService, setNewService] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name: '', description: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const data = project.data;
  usePageMeta([{ label: m.nav.projects, to: '/projects' }, { label: data?.project.name ?? '…' }]);

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

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head__text">
          <h1>{data?.project.name ?? <Skeleton width={220} height={28} />}</h1>
          {data?.project.description != null && <p>{data.project.description}</p>}
        </div>
        <div className="page-head__actions">
          <Button icon={<Database />} onClick={() => setNewService(true)}>
            {m.project.addService}
          </Button>
          <Button variant="primary" icon={<Plus />} onClick={() => setNewApp(true)}>
            {m.project.addApp}
          </Button>
          <Menu trigger={(props) => <Button {...props} iconOnly icon={<Ellipsis />}>{m.common.more}</Button>}>
            <MenuItem
              icon={<Pencil />}
              onSelect={() => {
                setDraft({ name: data?.project.name ?? '', description: data?.project.description ?? '' });
                setEditing(true);
              }}
            >
              {m.common.edit}
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
        </div>
      </div>

      <div className="section-title" style={{ marginTop: 0 }}>
        <h2>{m.project.applications}</h2>
        {data !== undefined && <span className="count">{data.applications.length}</span>}
      </div>
      {data === undefined ? (
        <div className="resource-grid">
          {[0, 1].map((index) => (
            <div key={index} className="resource-card">
              <Skeleton height={36} />
              <Skeleton height={14} width="60%" />
            </div>
          ))}
        </div>
      ) : data.applications.length === 0 ? (
        <EmptyState icon={<Boxes />} title={m.project.emptyAppsTitle} action={<Button variant="primary" icon={<Plus />} onClick={() => setNewApp(true)}>{m.project.addApp}</Button>}>
          {m.project.emptyAppsText}
        </EmptyState>
      ) : (
        <div className="resource-grid">
          {data.applications.map((app) => (
            <AppCard key={app.id} app={app} services={data.services} />
          ))}
        </div>
      )}

      <div className="section-title">
        <h2>{m.project.services}</h2>
        {data !== undefined && <span className="count">{data.services.length}</span>}
      </div>
      {data !== undefined && data.services.length === 0 ? (
        <button type="button" className="empty" style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => setNewService(true)}>
          <span className="row" style={{ gap: 12 }}>
            <span className="empty__icon">
              <Database />
            </span>
            <span className="muted">{m.project.emptyServicesText}</span>
          </span>
        </button>
      ) : (
        <div className="resource-grid">
          {(data?.services ?? []).map((service) => (
            <ServiceCard key={service.id} service={service} />
          ))}
        </div>
      )}

      <div className="section" style={{ marginTop: 32 }}>
        <div className="section__intro">
          <h2>{m.project.variables}</h2>
          <p>{m.project.variablesHint}</p>
        </div>
        {variables.data === undefined ? <Skeleton height={120} /> : <EnvEditor variables={variables.data.variables} onSave={(list) => saveVariables.mutateAsync(list)} saving={saveVariables.isPending} />}
      </div>

      <NewAppDialog projectId={projectId} open={newApp} onClose={() => setNewApp(false)} />
      <NewServiceDialog projectId={projectId} open={newService} onClose={() => setNewService(false)} />
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
