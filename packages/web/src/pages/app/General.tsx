/**
 * General: everything needed to ship the app, top to bottom. The next step
 * when something needs attention; deploy settings (deploy, reload, rebuild,
 * stop, terminal, auto deploy) with the live facts; where the code comes
 * from; and how it is built — or the compose file for a stack.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Container, ExternalLink, GitBranch, Hammer, KeyRound, Play, RotateCcw, Rocket, Square, SquareTerminal, Variable } from 'lucide-react';
import { updateApplicationSchema, type ApplicationDto, type ContainerDto, type SourceInput } from '@ploy/shared';
import { CopyButton } from '../../components/Copy.tsx';
import { useConfirm } from '../../components/Dialog.tsx';
import { Card, SaveFooter } from '../../components/Frame.tsx';
import { useReasonText } from '../../components/Reason.tsx';
import { RepoPicker, type RepoChoice } from '../../components/RepoPicker.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Button, Callout, Field, GithubMark, Input, Skeleton, Switch } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useAppContainers, useAppMetrics, useDeployKey, useDeployment, useGithub, useProject, useTemplates } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { TemplateMark } from '../projects/TemplatesDialog.tsx';
import { useAppContext, useAppTerminal } from './AppLayout.tsx';
import { ComposeFileCard } from './Compose.tsx';
import { useAppForm } from './appForm.ts';

/** The single most useful thing to do next, or nothing when all is well. */
function NextStep({ app, containers }: { app: ApplicationDto; containers: ContainerDto[] | undefined }) {
  const { m } = useI18n();
  const reason = useReasonText();
  const latest = app.latestDeployment;
  const failed = useDeployment(latest !== null && latest.status === 'failed' ? latest.id : '');
  const base = `/apps/${app.id}`;
  const link = (to: string, label: string) => (
    <Link className="btn btn--sm" to={to} style={{ textDecoration: 'none' }}>
      {label}
    </Link>
  );

  if (latest === null) return <Callout tone="info" title={m.appOverview.next.neverDeployedTitle}>{m.appOverview.next.neverDeployedText}</Callout>;
  if (app.status === 'stopped') return <Callout tone="idle" title={m.appOverview.next.stoppedTitle}>{m.appOverview.next.stoppedText}</Callout>;
  if (latest.status === 'failed') {
    const detail = failed.data === undefined ? null : reason('deploy', failed.data.errorCode, failed.data.errorMessage ?? '');
    return (
      <Callout tone="bad" title={m.appOverview.next.failedTitle} action={link(`/deployments/${latest.id}`, m.appOverview.next.openLog)}>
        {detail}
        {app.activeDeployment !== null && <> {m.appOverview.next.failedServing}</>}
      </Callout>
    );
  }
  if (app.status === 'crashed') {
    return (
      <Callout tone="bad" title={m.appOverview.next.crashedTitle} action={link(`${base}/logs`, m.appOverview.next.openLogs)}>
        {m.appOverview.next.crashedText}
      </Callout>
    );
  }
  if (containers?.some((container) => container.oomKilled) === true) {
    return (
      <Callout tone="work" title={m.appOverview.next.oomTitle} action={link(`${base}/advanced`, m.appOverview.next.openSettings)}>
        {m.appOverview.next.oomText}
      </Callout>
    );
  }
  if ((app.kind === 'web' || app.kind === 'compose') && app.url === null && app.activeDeployment !== null) {
    return (
      <Callout tone="info" title={m.appOverview.next.noDomainTitle} action={link(`${base}/domains`, m.appOverview.addDomain)}>
        {m.appOverview.next.noDomainText}
      </Callout>
    );
  }
  return null;
}

function Facts({ app, containers }: { app: ApplicationDto; containers: ContainerDto[] | undefined }) {
  const { m, t, formatBytes, formatNumber } = useI18n();
  const live = app.activeDeployment !== null && app.status !== 'stopped';
  const metrics = useAppMetrics(app.id, '1h');
  const last = metrics.data?.points.at(-1);
  const running = containers?.filter((container) => container.state === 'running').length ?? 0;
  const total = containers?.length ?? 0;
  const active = app.activeDeployment;
  const metric = (content: string) => (!live ? '—' : metrics.data === undefined ? <Skeleton width={50} /> : last === undefined ? '—' : content);
  return (
    <dl className="facts-strip">
      <div>
        <dt>{m.appOverview.health}</dt>
        <dd>{active === null ? '—' : containers === undefined ? <Skeleton width={60} /> : t(m.appOverview.replicasRunning, { running, total })}</dd>
      </div>
      <div>
        <dt>{m.appOverview.version}</dt>
        <dd>
          {active === null ? (
            '—'
          ) : (
            <Link to={`/deployments/${active.id}`}>
              {active.commitSha !== null ? <code>{active.commitSha.slice(0, 7)}</code> : m.trigger[active.trigger]} <span className="faint" style={{ fontWeight: 400 }}><RelativeTime value={active.finishedAt ?? active.createdAt} /></span>
            </Link>
          )}
        </dd>
      </div>
      <div>
        <dt>{m.metrics.cpu}</dt>
        <dd>{metric(`${formatNumber(last?.cpu ?? 0, { maximumFractionDigits: (last?.cpu ?? 0) < 10 ? 1 : 0 })}%`)}</dd>
      </div>
      <div>
        <dt>{m.metrics.memory}</dt>
        <dd>{metric(formatBytes(last?.mem ?? 0))}</dd>
      </div>
      {app.internalUrl !== null && (
        <div>
          <dt>{m.appOverview.internalUrl}</dt>
          <dd className="row" style={{ gap: 2 }}>
            <code className="truncate">{app.internalUrl}</code>
            <CopyButton value={app.internalUrl} />
          </dd>
        </div>
      )}
    </dl>
  );
}

function DeployCard({ app, containers }: { app: ApplicationDto; containers: ContainerDto[] | undefined }) {
  const { m } = useI18n();
  const d = m.deploySettings;
  const confirm = useConfirm();
  const openTerminal = useAppTerminal();
  const invalidate = [keys.app(app.id), keys.appPart(app.id, 'deployments')];
  const deploy = useAction((clearCache: boolean) => api.post(`/api/applications/${app.id}/deploy`, { clearCache }), { success: m.app.deployQueued, invalidate });
  const reload = useAction(() => api.post(`/api/applications/${app.id}/restart`), { success: m.app.restartQueued, invalidate });
  const stop = useAction(() => api.post(`/api/applications/${app.id}/stop`), { success: m.app.stopped, invalidate });
  const start = useAction(() => api.post(`/api/applications/${app.id}/start`), { success: m.app.started, invalidate });
  const autoDeploy = useAction((value: boolean) => api.patch(`/api/applications/${app.id}`, { autoDeploy: value }), { success: m.appSettings.saved, invalidate: [keys.app(app.id)] });
  const busy = ['queued', 'building', 'deploying'].includes(app.status);
  const live = app.activeDeployment !== null && app.status !== 'stopped';
  const image = app.source.type === 'image';

  return (
    <Card title={d.title} description={app.kind === 'compose' ? d.composeDescription : d.description}>
      <div className="action-row">
        <Button variant="primary" icon={<Rocket />} busy={deploy.isPending && deploy.variables === false} onClick={() => deploy.mutate(false)} title={d.deployHint}>
          {m.app.deploy}
        </Button>
        <Button icon={<RotateCcw />} disabled={!live || busy} busy={reload.isPending} onClick={() => reload.mutate()} title={d.reloadHint}>
          {d.reload}
        </Button>
        {!image && (
          <Button icon={<Hammer />} busy={deploy.isPending && deploy.variables === true} onClick={() => deploy.mutate(true)} title={d.rebuildHint}>
            {d.rebuild}
          </Button>
        )}
        {app.status === 'stopped' ? (
          <Button icon={<Play />} busy={start.isPending} onClick={() => start.mutate()} title={d.startHint}>
            {m.app.start}
          </Button>
        ) : (
          <Button
            icon={<Square />}
            disabled={app.activeDeployment === null || busy}
            busy={stop.isPending}
            title={d.stopHint}
            onClick={async () => {
              const result = await confirm({ title: m.app.stopConfirmTitle, text: m.app.stopConfirmText, confirmLabel: m.app.stop, danger: true });
              if (result.confirmed) stop.mutate();
            }}
          >
            {m.app.stop}
          </Button>
        )}
        <Button icon={<SquareTerminal />} disabled={!live} onClick={openTerminal} title={d.terminalHint}>
          {d.terminal}
        </Button>
      </div>
      {app.source.type === 'github' && app.parentApplicationId === null && (
        <div className="toggle-row">
          <Switch checked={app.autoDeploy} disabled={autoDeploy.isPending} onChange={(value) => autoDeploy.mutate(value)} label={m.appSettings.autoDeploy} hint={m.appSettings.autoDeployHint} />
        </div>
      )}
      <Facts app={app} containers={containers} />
    </Card>
  );
}

/** How to get into an app installed from a template: generated credentials, setup page, or nothing to do. */
function TemplateAccessCard({ app }: { app: ApplicationDto }) {
  const { m, t } = useI18n();
  const templates = useTemplates(app.templateId !== null);
  const project = useProject(app.projectId);
  const template = templates.data?.find((candidate) => candidate.id === app.templateId);
  if (template === undefined) return null;
  const access = template.access;
  const firstService = project.data?.services[0];
  const lines: string[] = [];
  if (access.kind === 'setup') {
    lines.push(m.templates.access.setup);
    if (access.path !== undefined) lines.push(t(m.templates.access.setupPath, { path: access.path }));
  } else if (access.kind === 'login') {
    lines.push(typeof access.user === 'string' ? t(m.templates.access.login, { user: access.user }) : t(m.templates.access.loginVar, { key: access.user.key }));
    lines.push(t(m.templates.access.password, { key: access.passwordKey }));
  } else if (access.kind === 'default') {
    lines.push(t(m.templates.access.defaultLogin, { user: access.user, password: access.password }));
  } else if (access.kind === 'key') {
    lines.push(t(m.templates.access.key, { key: access.key }));
  } else if (access.kind === 'database') {
    lines.push(t(m.templates.access.database, { example: firstService === undefined ? 'postgres:5432' : `${firstService.internalHost}:${firstService.internalPort}` }));
  } else {
    lines.push(m.templates.access.open);
  }
  const siteUrl = app.url === null ? null : `${app.url}${access.kind === 'setup' && access.path !== undefined ? access.path : ''}`;
  const usesVariables = access.kind === 'login' || access.kind === 'key';
  return (
    <Card
      icon={<TemplateMark template={template} size={34} />}
      title={m.templates.access.title}
      description={lines.join(' ')}
      actions={
        <>
          {siteUrl !== null && app.activeDeployment !== null && (
            <a className="btn btn--sm" href={siteUrl} target="_blank" rel="noreferrer noopener" style={{ textDecoration: 'none' }}>
              <ExternalLink width={14} height={14} aria-hidden="true" />
              {m.templates.access.openSite}
            </a>
          )}
          {usesVariables && (
            <Link className="btn btn--sm" to={`/apps/${app.id}/environment`} style={{ textDecoration: 'none' }}>
              <Variable width={14} height={14} aria-hidden="true" />
              {m.templates.access.openVariables}
            </Link>
          )}
        </>
      }
    />
  );
}

type Provider = 'github' | 'git' | 'image';

interface ProviderDraft {
  type: Provider;
  repo: RepoChoice;
  url: string;
  branch: string;
  image: string;
}

function draftFrom(app: ApplicationDto): ProviderDraft {
  const source = app.source;
  return {
    type: source.type === 'raw' ? 'git' : source.type,
    repo: source.type === 'github' ? { installationId: source.installationId, repository: source.repository, branch: source.branch } : { installationId: null, repository: null, branch: '' },
    url: source.type === 'git' ? source.url : '',
    branch: source.type === 'git' ? source.branch : 'main',
    image: source.type === 'image' ? source.image : '',
  };
}

function sourceFrom(draft: ProviderDraft): SourceInput | null {
  if (draft.type === 'github') {
    if (draft.repo.installationId === null || draft.repo.repository === null) return null;
    return { type: 'github', installationId: draft.repo.installationId, repository: draft.repo.repository, branch: draft.repo.branch };
  }
  if (draft.type === 'git') return { type: 'git', url: draft.url.trim(), branch: draft.branch.trim() };
  return { type: 'image', image: draft.image.trim() };
}

function sameSource(next: SourceInput, current: ApplicationDto['source']): boolean {
  if (next.type === 'github' && current.type === 'github') return next.installationId === current.installationId && next.repository === current.repository && next.branch === current.branch;
  if (next.type === 'git' && current.type === 'git') return next.url === current.url && next.branch === current.branch;
  if (next.type === 'image' && current.type === 'image') return next.image === current.image;
  return false;
}

/** Where the code comes from: a connected GitHub repository, any Git URL, or a ready image. */
function ProviderCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const p = m.provider;
  const github = useGithub();
  const [draft, setDraft] = useState<ProviderDraft>(() => draftFrom(app));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const signature = JSON.stringify(app.source);
  useEffect(() => setDraft(draftFrom(app)), [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const deployKey = useDeployKey(app.id, app.source.type === 'git' && app.source.url.startsWith('git@'));
  const save = useAction((source: SourceInput) => api.patch(`/api/applications/${app.id}`, { source }), {
    success: m.appSettings.saved,
    invalidate: [keys.app(app.id), keys.project(app.projectId), keys.appPart(app.id, 'deploy-key')],
    inlineValidation: true,
  });
  const next = sourceFrom(draft);
  const dirty = next !== null && !sameSource(next, app.source);
  const submit = () => {
    if (next === null) return;
    const result = validate(m, updateApplicationSchema, { source: next });
    if (result.errors !== null) return setErrors(result.errors);
    setErrors({});
    save.mutate(next, { onError: (error) => setErrors(fieldErrors(m, error)) });
  };
  const choices: { value: Provider; label: string; icon: ReactNode }[] = [
    { value: 'github', label: 'GitHub', icon: <GithubMark size={16} /> },
    { value: 'git', label: 'Git', icon: <GitBranch aria-hidden="true" /> },
    { value: 'image', label: 'Docker', icon: <Container aria-hidden="true" /> },
  ];

  return (
    <Card
      title={p.title}
      description={p.description}
      footer={<SaveFooter dirty={dirty} saving={save.isPending} onSave={submit} onReset={() => { setDraft(draftFrom(app)); setErrors({}); }} note={dirty ? p.redeployNote : undefined} />}
    >
      <div className="picker" role="group" aria-label={p.title}>
        {choices.map((choice) => (
          <button key={choice.value} type="button" aria-pressed={draft.type === choice.value} onClick={() => setDraft({ ...draft, type: choice.value })}>
            {choice.icon}
            {choice.label}
          </button>
        ))}
      </div>
      {draft.type === 'github' &&
        (github.data === undefined ? (
          <Skeleton height={120} />
        ) : (
          <RepoPicker installations={github.data.installations} value={draft.repo} onChange={(repo) => setDraft((current) => ({ ...current, repo }))} onConnect={() => undefined} errors={errors} />
        ))}
      {draft.type === 'git' && (
        <>
          <div className="form-grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
            <Field label={m.newApp.gitUrl} hint={p.gitHint} error={errors['source.url']}>
              <Input mono value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://gitlab.com/team/app.git" spellCheck={false} />
            </Field>
            <Field label={m.newApp.branch} error={errors['source.branch']}>
              <Input mono value={draft.branch} onChange={(event) => setDraft({ ...draft, branch: event.target.value })} spellCheck={false} />
            </Field>
          </div>
          {deployKey.data?.publicKey != null && (
            <Field
              label={
                <span className="row" style={{ gap: 6 }}>
                  <KeyRound width={14} height={14} aria-hidden="true" />
                  {m.appSettings.deployKey}
                </span>
              }
              hint={m.newApp.deployKeyText}
            >
              <div className="codeblock">
                {deployKey.data.publicKey}
                <CopyButton value={deployKey.data.publicKey} />
              </div>
            </Field>
          )}
        </>
      )}
      {draft.type === 'image' && (
        <Field label={m.newApp.image} hint={p.imageHint} error={errors['source.image']}>
          <Input mono value={draft.image} onChange={(event) => setDraft({ ...draft, image: event.target.value })} placeholder="ghcr.io/team/app:latest" spellCheck={false} />
        </Field>
      )}
    </Card>
  );
}

/** How the code becomes an image: detected automatically, from a Dockerfile, or as a static site. */
function BuildCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const b = m.build;
  const { form, set, text, dirty, submit, reset, saving, errors } = useAppForm(app);
  const types = ['auto', 'dockerfile', 'static'] as const;
  return (
    <Card title={b.title} description={b.description} footer={<SaveFooter dirty={dirty} saving={saving} onSave={submit} onReset={reset} />}>
      <div className="radio-list" role="radiogroup" aria-label={b.title}>
        {types.map((value) => (
          <button key={value} type="button" role="radio" className="radio-item" aria-checked={form.buildType === value} onClick={() => set('buildType', value)}>
            <span className="radio-item__dot" aria-hidden="true" />
            <span>
              <span className="radio-item__title">{m.appSettings.buildTypes[value]}</span>
              <span className="radio-item__hint">{b.hints[value]}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="form-grid">
        <Field label={m.appSettings.rootDirectory} hint={m.newApp.rootDirectoryHint} error={errors.rootDirectory}>
          <Input mono {...text('rootDirectory')} placeholder="./" spellCheck={false} />
        </Field>
        {form.buildType !== 'static' && (
          <Field label={m.appSettings.dockerfilePath} hint={form.buildType === 'auto' ? b.dockerfileAutoHint : undefined} error={errors.dockerfilePath}>
            <Input mono {...text('dockerfilePath')} spellCheck={false} />
          </Field>
        )}
      </div>
      {form.buildType !== 'dockerfile' && (
        <div className="form-grid">
          <Field label={m.appSettings.installCommand} error={errors.installCommand}>
            <Input mono {...text('installCommand')} placeholder={m.appSettings.auto} spellCheck={false} />
          </Field>
          <Field label={m.appSettings.buildCommand} error={errors.buildCommand}>
            <Input mono {...text('buildCommand')} placeholder={m.appSettings.auto} spellCheck={false} />
          </Field>
          {form.buildType === 'static' && (
            <Field label={m.appSettings.outputDirectory} hint={m.appSettings.outputDirectoryHint} error={errors.outputDirectory}>
              <Input mono {...text('outputDirectory')} placeholder="dist" spellCheck={false} />
            </Field>
          )}
        </div>
      )}
    </Card>
  );
}

export function GeneralTab() {
  const app = useAppContext();
  const containers = useAppContainers(app.id);
  const containerList = app.activeDeployment === null ? [] : containers.data;
  const compose = app.kind === 'compose';
  const preview = app.parentApplicationId !== null;
  return (
    <>
      <NextStep app={app} containers={containerList} />
      <DeployCard app={app} containers={containerList} />
      {preview ? null : (
        <>
      {app.templateId !== null && <TemplateAccessCard app={app} />}
      {compose ? <ComposeFileCard app={app} /> : <ProviderCard app={app} />}
      {!compose && app.source.type !== 'image' && <BuildCard app={app} />}
        </>
      )}
    </>
  );
}
