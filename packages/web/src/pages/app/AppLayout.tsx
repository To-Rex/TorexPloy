/**
 * An application (or compose stack), framed as Dokploy frames a service:
 * name, status and where it comes from on top; tabs for General,
 * Environment, Domains, Deployments, Logs, Monitoring, Schedules and
 * Advanced below. The terminal opens as a dialog from anywhere on the page.
 */
import { useEffect, useState } from 'react';
import { Outlet, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router';
import { Container, Ellipsis, ExternalLink, FileCode2, GitBranch, Globe, Pencil, Rocket, Server, SquareTerminal, Trash2 } from 'lucide-react';
import { updateApplicationSchema, type ApplicationDto } from '@ploy/shared';
import { Dialog, useConfirm } from '../../components/Dialog.tsx';
import { AppMark } from '../../components/KindMark.tsx';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu.tsx';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { Status } from '../../components/Status.tsx';
import { RouteTabs } from '../../components/Tabs.tsx';
import { Button, ButtonLink, Callout, Field, GithubMark, Input, Skeleton, Textarea } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useApp, useProject, useTemplates } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { NotFound } from '../../app/RouteError.tsx';
import { TemplateMark } from '../projects/TemplatesDialog.tsx';
import { PreviewBanner, supportsPreviews } from './Previews.tsx';
import { AppTerminal } from './Terminal.tsx';

interface AppOutlet {
  app: ApplicationDto;
  openTerminal: () => void;
}

export function useAppContext(): ApplicationDto {
  return useOutletContext<AppOutlet>().app;
}

/** Open the terminal dialog of the current app. */
export function useAppTerminal(): () => void {
  return useOutletContext<AppOutlet>().openTerminal;
}

export function SourceLabel({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const source = app.source;
  if (source.type === 'github') {
    return (
      <a className="row" style={{ gap: 5 }} href={`https://github.com/${source.repository}/tree/${source.branch}`} target="_blank" rel="noreferrer noopener">
        <GithubMark size={14} />
        {source.repository}
        <span className="faint">
          <GitBranch width={13} height={13} style={{ display: 'inline', verticalAlign: '-2px' }} aria-hidden="true" /> {source.branch}
        </span>
      </a>
    );
  }
  if (source.type === 'git') {
    return (
      <span className="row" style={{ gap: 5 }}>
        <GitBranch aria-hidden="true" />
        <span className="truncate" style={{ maxWidth: 320 }}>{source.url.replace(/^https:\/\//, '')}</span>
        <span className="faint">{source.branch}</span>
      </span>
    );
  }
  if (source.type === 'raw') {
    return (
      <span className="row" style={{ gap: 5 }}>
        <FileCode2 aria-hidden="true" />
        {m.compose.storedSource}
      </span>
    );
  }
  return (
    <span className="row" style={{ gap: 5 }}>
      <Container aria-hidden="true" />
      <code>{source.image}</code>
    </span>
  );
}

function EditDialog({ app, open, onClose }: { app: ApplicationDto; open: boolean; onClose: () => void }) {
  const { m } = useI18n();
  const [draft, setDraft] = useState({ name: app.name, description: app.description ?? '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadedFor, setLoadedFor] = useState<boolean>(false);
  if (open !== loadedFor) {
    setLoadedFor(open);
    if (open) {
      setDraft({ name: app.name, description: app.description ?? '' });
      setErrors({});
    }
  }
  const save = useAction((input: { name: string; description: string | null }) => api.patch(`/api/applications/${app.id}`, input), {
    success: m.appSettings.saved,
    invalidate: [keys.app(app.id), keys.project(app.projectId)],
    inlineValidation: true,
    onSuccess: onClose,
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={m.app.editTitle}
      onSubmit={() => {
        const payload = { name: draft.name.trim(), description: draft.description.trim().length === 0 ? null : draft.description.trim() };
        const result = validate(m, updateApplicationSchema, payload);
        if (result.errors !== null) return setErrors(result.errors);
        save.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
      }}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            {m.common.save}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={m.appSettings.name} error={errors.name}>
          <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} data-autofocus />
        </Field>
        <Field label={m.appSettings.description} optional={m.common.optional} error={errors.description}>
          <Textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={3} />
        </Field>
      </div>
    </Dialog>
  );
}

export function AppLayout() {
  const { appId = '' } = useParams();
  const { m, t, plural } = useI18n();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const app = useApp(appId);
  const data = app.data;
  const project = useProject(data?.projectId ?? '');
  const templates = useTemplates(data?.templateId != null);
  const template = templates.data?.find((candidate) => candidate.id === data?.templateId);
  const [terminal, setTerminal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [params, setParams] = useSearchParams();
  // `?terminal=1` (from the command palette or an old link) opens the terminal dialog.
  useEffect(() => {
    if (params.get('terminal') !== '1') return;
    setTerminal(true);
    const next = new URLSearchParams(params);
    next.delete('terminal');
    setParams(next, { replace: true });
  }, [params, setParams]);
  usePageMeta([
    { label: m.nav.projects, to: '/projects' },
    ...(data === undefined ? [] : [{ label: project.data?.project.name ?? '…', to: `/projects/${data.projectId}` }]),
    { label: data?.name ?? '…' },
  ]);

  const invalidate = [keys.app(appId), keys.appPart(appId, 'deployments')];
  const deploy = useAction(() => api.post(`/api/applications/${appId}/deploy`, { clearCache: false }), { success: m.app.deployQueued, invalidate });
  const remove = useAction((removeData: boolean) => api.delete(`/api/applications/${appId}?removeData=${removeData}`), {
    success: m.appSettings.deleted,
    invalidate: [keys.project(data?.projectId ?? ''), keys.projects, keys.apps],
    onSuccess: () => void navigate(`/projects/${data?.projectId ?? ''}`),
  });

  if (app.isError) return <NotFound />;
  const base = `/apps/${appId}`;
  const compose = data?.kind === 'compose';
  const preview = data?.parentApplicationId != null;

  const askDelete = async () => {
    if (data === undefined) return;
    const result = await confirm({
      title: m.appSettings.deleteTitle,
      text: compose ? m.compose.deleteText : m.appSettings.deleteText,
      confirmLabel: m.common.delete,
      danger: true,
      typeToConfirm: data.name,
      checkbox: { label: compose ? m.compose.deleteData : m.appSettings.deleteData },
    });
    if (result.confirmed) remove.mutate(result.checked);
  };

  return (
    <div className="page">
      <section className="frame">
        <div className="frame__sheet resource">
          <header className="resource__head">
            <span className="resource__icon">{template !== undefined ? <TemplateMark template={template} size={44} /> : data === undefined ? null : <AppMark kind={data.kind} />}</span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="resource__title">
                <h1 className="truncate">{data?.name ?? <Skeleton width={200} height={26} />}</h1>
                {data !== undefined && <Status kind="app" status={data.status} />}
              </div>
              {data?.description != null && <p className="resource__desc">{data.description}</p>}
              {data !== undefined && (
                <div className="resource__meta">
                  {data.url !== null && (
                    <a className="row" style={{ gap: 5 }} href={data.url} target="_blank" rel="noreferrer noopener">
                      <Globe aria-hidden="true" />
                      {data.url.replace(/^https?:\/\//, '')}
                    </a>
                  )}
                  <SourceLabel app={data} />
                  <span className="row" style={{ gap: 5 }}>
                    <Server aria-hidden="true" />
                    {data.serverName}
                  </span>
                  {data.replicas > 1 && <span>{plural(m.app.replicas, data.replicas)}</span>}
                </div>
              )}
            </div>
            {data !== undefined && (
              <div className="resource__actions">
                {data.url !== null && (
                  <ButtonLink href={data.url} external icon={<ExternalLink />}>
                    {m.app.open}
                  </ButtonLink>
                )}
                <Menu trigger={(props) => <Button {...props} iconOnly icon={<Ellipsis />}>{m.common.more}</Button>}>
                  <MenuItem icon={<Rocket />} onSelect={() => deploy.mutate()}>
                    {m.app.deploy}
                  </MenuItem>
                  <MenuItem icon={<Pencil />} onSelect={() => setEditing(true)}>
                    {m.app.editTitle}
                  </MenuItem>
                  <MenuItem icon={<SquareTerminal />} onSelect={() => setTerminal(true)}>
                    {m.deploySettings.terminal}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem icon={<Trash2 />} danger onSelect={() => void askDelete()}>
                    {m.app.delete}
                  </MenuItem>
                </Menu>
              </div>
            )}
          </header>

          {data?.pullRequest != null && (
            <div className="resource__notice">
              <PreviewBanner app={data} />
            </div>
          )}

          {data?.pendingChanges === true && (
            <div className="resource__notice">
              <Callout tone="work" action={<Button size="sm" onClick={() => deploy.mutate()} busy={deploy.isPending}>{m.app.applyNow}</Button>}>
                {m.app.pendingChanges}
              </Callout>
            </div>
          )}

          <div className="resource__tabs">
            <RouteTabs
              label={data?.name ?? ''}
              items={[
                { to: `${base}/general`, label: m.app.tabs.general },
                // A preview takes its settings from the parent on every deploy: nothing to edit here.
                ...(preview ? [] : [{ to: `${base}/environment`, label: m.app.tabs.environment }]),
                ...(data?.kind === 'worker' ? [] : [{ to: `${base}/domains`, label: m.app.tabs.domains }]),
                ...(data !== undefined && supportsPreviews(data) ? [{ to: `${base}/previews`, label: m.app.tabs.previews }] : []),
                { to: `${base}/deployments`, label: m.app.tabs.deployments },
                { to: `${base}/logs`, label: m.app.tabs.logs },
                { to: `${base}/monitoring`, label: m.app.tabs.monitoring },
                // Compose stacks declare their own jobs in the file.
                ...(compose || preview ? [] : [{ to: `${base}/schedules`, label: m.app.tabs.schedules }]),
                ...(preview ? [] : [{ to: `${base}/advanced`, label: m.app.tabs.advanced }]),
              ]}
            />
          </div>
          <div className="resource__body">{data === undefined ? <Skeleton height={240} /> : <Outlet context={{ app: data, openTerminal: () => setTerminal(true) } satisfies AppOutlet} />}</div>
        </div>
      </section>
      {data !== undefined && (
        <>
          <Dialog open={terminal} onClose={() => setTerminal(false)} xl title={t(m.deploySettings.terminalTitle, { name: data.name })}>
            {terminal && <AppTerminal app={data} />}
          </Dialog>
          <EditDialog app={data} open={editing} onClose={() => setEditing(false)} />
        </>
      )}
    </div>
  );
}
