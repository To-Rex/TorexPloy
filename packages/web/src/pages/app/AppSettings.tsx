import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { RefreshCw, Trash2 } from 'lucide-react';
import { updateApplicationSchema, type ApplicationDto, type UpdateApplicationInput } from '@ploy/shared';
import { CopyButton, ValueField } from '../../components/Copy.tsx';
import { useConfirm } from '../../components/Dialog.tsx';
import { Button, Callout, Field, Input, Select, Switch, Textarea } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useDeployKey } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { useAppContext } from './AppLayout.tsx';

interface Form {
  name: string;
  description: string;
  repositoryOrUrl: string;
  branch: string;
  image: string;
  autoDeploy: boolean;
  buildType: ApplicationDto['buildType'];
  dockerfilePath: string;
  rootDirectory: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  outputDirectory: string;
  kind: ApplicationDto['kind'];
  port: string;
  replicas: string;
  cpuLimit: string;
  memoryLimitMb: string;
  healthCheckPath: string;
  healthCheckTimeoutSec: string;
  strategy: ApplicationDto['strategy'];
}

function fromApp(app: ApplicationDto): Form {
  return {
    name: app.name,
    description: app.description ?? '',
    repositoryOrUrl: app.source.type === 'github' ? app.source.repository : app.source.type === 'git' ? app.source.url : '',
    branch: app.source.type === 'image' ? '' : app.source.branch,
    image: app.source.type === 'image' ? app.source.image : '',
    autoDeploy: app.autoDeploy,
    buildType: app.buildType,
    dockerfilePath: app.dockerfilePath,
    rootDirectory: app.rootDirectory,
    installCommand: app.installCommand ?? '',
    buildCommand: app.buildCommand ?? '',
    startCommand: app.startCommand ?? '',
    outputDirectory: app.outputDirectory ?? '',
    kind: app.kind,
    port: app.port === null ? '' : String(app.port),
    replicas: String(app.replicas),
    cpuLimit: app.cpuLimit === null ? '' : String(app.cpuLimit),
    memoryLimitMb: app.memoryLimitMb === null ? '' : String(app.memoryLimitMb),
    healthCheckPath: app.healthCheckPath ?? '',
    healthCheckTimeoutSec: String(app.healthCheckTimeoutSec),
    strategy: app.strategy,
  };
}

const orNull = (value: string): string | null => (value.trim().length === 0 ? null : value.trim());
const numOrNull = (value: string): number | null => (value.trim().length === 0 ? null : Number(value));

function toPatch(app: ApplicationDto, form: Form): UpdateApplicationInput {
  const patch: UpdateApplicationInput = {};
  const before = fromApp(app);
  const changed = (key: keyof Form) => form[key] !== before[key];
  if (changed('name')) patch.name = form.name.trim();
  if (changed('description')) patch.description = orNull(form.description);
  if (changed('repositoryOrUrl') || changed('branch') || changed('image')) {
    patch.source =
      app.source.type === 'github'
        ? { type: 'github', installationId: app.source.installationId, repository: form.repositoryOrUrl.trim(), branch: form.branch.trim() }
        : app.source.type === 'git'
          ? { type: 'git', url: form.repositoryOrUrl.trim(), branch: form.branch.trim() }
          : { type: 'image', image: form.image.trim() };
  }
  if (changed('autoDeploy')) patch.autoDeploy = form.autoDeploy;
  if (changed('buildType')) patch.buildType = form.buildType;
  if (changed('dockerfilePath')) patch.dockerfilePath = form.dockerfilePath.trim();
  if (changed('rootDirectory')) patch.rootDirectory = form.rootDirectory.trim();
  if (changed('installCommand')) patch.installCommand = orNull(form.installCommand);
  if (changed('buildCommand')) patch.buildCommand = orNull(form.buildCommand);
  if (changed('startCommand')) patch.startCommand = orNull(form.startCommand);
  if (changed('outputDirectory')) patch.outputDirectory = orNull(form.outputDirectory);
  if (changed('kind')) patch.kind = form.kind;
  if (changed('port')) patch.port = numOrNull(form.port);
  if (changed('replicas')) patch.replicas = Number(form.replicas);
  if (changed('cpuLimit')) patch.cpuLimit = numOrNull(form.cpuLimit);
  if (changed('memoryLimitMb')) patch.memoryLimitMb = numOrNull(form.memoryLimitMb);
  if (changed('healthCheckPath')) patch.healthCheckPath = orNull(form.healthCheckPath);
  if (changed('healthCheckTimeoutSec')) patch.healthCheckTimeoutSec = Number(form.healthCheckTimeoutSec);
  if (changed('strategy')) patch.strategy = form.strategy;
  return patch;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="section">
      <div className="section__intro">
        <h2>{title}</h2>
        {hint !== undefined && <p>{hint}</p>}
      </div>
      <div className="stack">{children}</div>
    </div>
  );
}

export function AppSettingsTab() {
  const app = useAppContext();
  const { m } = useI18n();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [form, setForm] = useState<Form>(() => fromApp(app));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const deployKey = useDeployKey(app.id, app.source.type === 'git' && app.source.url.startsWith('git@'));
  const signature = JSON.stringify(fromApp(app));
  useEffect(() => setForm(fromApp(app)), [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = useMemo(() => toPatch(app, form), [app, form]);
  const dirty = Object.keys(patch).length > 0;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));
  const text = (key: keyof Form, numeric = false) => ({
    value: form[key] as string,
    onChange: (event: { target: { value: string } }) => set(key, (numeric ? event.target.value.replace(/[^\d.]/g, '') : event.target.value) as Form[typeof key]),
  });

  const save = useAction((input: UpdateApplicationInput) => api.patch(`/api/applications/${app.id}`, input), {
    success: m.appSettings.saved,
    invalidate: [keys.app(app.id), keys.project(app.projectId)],
    inlineValidation: true,
  });
  const rotate = useAction(() => api.post(`/api/applications/${app.id}/hook/rotate`), { success: m.appSettings.hookRotated, invalidate: [keys.app(app.id)] });
  const remove = useAction((removeData: boolean) => api.delete(`/api/applications/${app.id}?removeData=${removeData}`), {
    success: m.appSettings.deleted,
    invalidate: [keys.project(app.projectId), keys.projects, keys.apps],
    onSuccess: () => void navigate(`/projects/${app.projectId}`),
  });

  const submit = () => {
    const result = validate(m, updateApplicationSchema, patch);
    if (result.errors !== null) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    save.mutate(patch, { onError: (error) => setErrors(fieldErrors(m, error)) });
  };

  const isImage = app.source.type === 'image';
  const err = (key: string) => errors[key];

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Section title={m.appSettings.general} hint={m.appSettings.generalHint}>
        <Field label={m.appSettings.name} error={err('name')}>
          <Input {...text('name')} />
        </Field>
        <Field label={m.appSettings.description} optional={m.common.optional} error={err('description')}>
          <Textarea {...text('description')} rows={2} />
        </Field>
      </Section>

      <Section title={m.appSettings.source} hint={m.appSettings.sourceHint}>
        {isImage ? (
          <Field label={m.newApp.image} hint={m.newApp.imageHint} error={err('source.image')}>
            <Input mono {...text('image')} spellCheck={false} />
          </Field>
        ) : (
          <div className="form-grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
            <Field label={app.source.type === 'github' ? m.newApp.repository : m.newApp.gitUrl} error={err('source.repository') ?? err('source.url')}>
              <Input mono {...text('repositoryOrUrl')} spellCheck={false} readOnly={app.source.type === 'github'} />
            </Field>
            <Field label={m.newApp.branch} error={err('source.branch')}>
              <Input mono {...text('branch')} spellCheck={false} />
            </Field>
          </div>
        )}
        {app.source.type === 'github' && <Switch checked={form.autoDeploy} onChange={(value) => set('autoDeploy', value)} label={m.appSettings.autoDeploy} hint={m.appSettings.autoDeployHint} />}
        {deployKey.data?.publicKey != null && (
          <Field label={m.appSettings.deployKey} hint={m.newApp.deployKeyText}>
            <div className="codeblock">
              {deployKey.data.publicKey}
              <CopyButton value={deployKey.data.publicKey} />
            </div>
          </Field>
        )}
      </Section>

      {!isImage && (
        <Section title={m.appSettings.build} hint={m.appSettings.buildHint}>
          <div className="form-grid">
            <Field label={m.appSettings.buildType}>
              <Select value={form.buildType} onChange={(event) => set('buildType', event.target.value as Form['buildType'])}>
                {(['auto', 'dockerfile', 'static'] as const).map((value) => (
                  <option key={value} value={value}>
                    {m.appSettings.buildTypes[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={m.appSettings.rootDirectory} hint={m.newApp.rootDirectoryHint} error={err('rootDirectory')}>
              <Input mono {...text('rootDirectory')} placeholder="./" spellCheck={false} />
            </Field>
            {form.buildType !== 'static' && (
              <Field label={m.appSettings.dockerfilePath} error={err('dockerfilePath')}>
                <Input mono {...text('dockerfilePath')} spellCheck={false} />
              </Field>
            )}
          </div>
          {form.buildType !== 'dockerfile' && (
            <div className="form-grid">
              <Field label={m.appSettings.installCommand} error={err('installCommand')}>
                <Input mono {...text('installCommand')} placeholder={m.appSettings.auto} spellCheck={false} />
              </Field>
              <Field label={m.appSettings.buildCommand} error={err('buildCommand')}>
                <Input mono {...text('buildCommand')} placeholder={m.appSettings.auto} spellCheck={false} />
              </Field>
              {form.buildType === 'static' ? (
                <Field label={m.appSettings.outputDirectory} hint={m.appSettings.outputDirectoryHint} error={err('outputDirectory')}>
                  <Input mono {...text('outputDirectory')} placeholder="dist" spellCheck={false} />
                </Field>
              ) : null}
            </div>
          )}
          {form.buildType !== 'static' && (
            <Field label={m.appSettings.startCommand} error={err('startCommand')}>
              <Input mono {...text('startCommand')} placeholder={m.appSettings.auto} spellCheck={false} />
            </Field>
          )}
        </Section>
      )}

      <Section title={m.appSettings.runtime} hint={m.appSettings.runtimeHint}>
        <div className="form-grid">
          <Field label={m.newApp.kind}>
            <Select value={form.kind} onChange={(event) => set('kind', event.target.value as Form['kind'])}>
              <option value="web">{m.newApp.kindWeb}</option>
              <option value="worker">{m.newApp.kindWorker}</option>
            </Select>
          </Field>
          {form.kind === 'web' && (
            <Field label={m.appSettings.port} hint={m.newApp.portHint} error={err('port')}>
              <Input {...text('port', true)} inputMode="numeric" placeholder={m.appSettings.auto} />
            </Field>
          )}
          <Field label={m.appSettings.replicas} hint={m.appSettings.replicasHint} error={err('replicas')}>
            <Input {...text('replicas', true)} inputMode="numeric" />
          </Field>
          <Field label={m.appSettings.cpu} hint={m.appSettings.cpuHint} error={err('cpuLimit')}>
            <Input {...text('cpuLimit', true)} inputMode="decimal" placeholder="—" />
          </Field>
          <Field label={m.appSettings.memory} hint={m.appSettings.memoryHint} error={err('memoryLimitMb')}>
            <Input {...text('memoryLimitMb', true)} inputMode="numeric" placeholder="—" />
          </Field>
        </div>
      </Section>

      {form.kind === 'web' && (
        <Section title={m.appSettings.health} hint={m.appSettings.healthHint}>
          <div className="form-grid">
            <Field label={m.appSettings.healthPath} hint={m.appSettings.healthPathHint} error={err('healthCheckPath')}>
              <Input mono {...text('healthCheckPath')} placeholder="/health" spellCheck={false} />
            </Field>
            <Field label={m.appSettings.healthTimeout} error={err('healthCheckTimeoutSec')}>
              <Input {...text('healthCheckTimeoutSec', true)} inputMode="numeric" />
            </Field>
          </div>
        </Section>
      )}

      <Section title={m.appSettings.strategy}>
        <div className="choices" role="radiogroup" aria-label={m.appSettings.strategy}>
          {(['rolling', 'recreate'] as const).map((value) => (
            <button key={value} type="button" role="radio" className="choice" aria-checked={form.strategy === value} onClick={() => set('strategy', value)}>
              <span className="choice__title">{m.appSettings.strategies[value]}</span>
              <span className="choice__hint">{m.appSettings.strategyHints[value]}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title={m.appSettings.hook} hint={m.appSettings.hookHint}>
        {app.deployHookUrl === null ? (
          <Callout tone="info">{m.appSettings.hookUnavailable}</Callout>
        ) : (
          <>
            <ValueField value={app.deployHookUrl} secret />
            <div className="codeblock">
              {`curl -X POST ${app.deployHookUrl}`}
              <CopyButton value={`curl -X POST ${app.deployHookUrl}`} />
            </div>
          </>
        )}
        <div>
          <Button size="sm" icon={<RefreshCw />} busy={rotate.isPending} onClick={() => rotate.mutate()}>
            {m.appSettings.rotateHook}
          </Button>
        </div>
      </Section>

      <Section title={m.appSettings.danger} hint={m.appSettings.dangerHint}>
        <div className="panel panel--danger">
          <div className="panel__body row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div style={{ maxWidth: '60ch' }}>
              <p style={{ fontWeight: 600 }}>{m.appSettings.deleteTitle}</p>
              <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{m.appSettings.deleteText}</p>
            </div>
            <Button
              variant="danger"
              icon={<Trash2 />}
              onClick={async () => {
                const result = await confirm({
                  title: m.appSettings.deleteTitle,
                  text: m.appSettings.deleteText,
                  confirmLabel: m.common.delete,
                  danger: true,
                  typeToConfirm: app.name,
                  checkbox: { label: m.appSettings.deleteData },
                });
                if (result.confirmed) remove.mutate(result.checked);
              }}
            >
              {m.app.delete}
            </Button>
          </div>
        </div>
      </Section>

      {dirty && (
        <div className="savebar">
          <span>{m.common.unsavedChanges}</span>
          <div className="row">
            <Button variant="ghost" onClick={() => { setForm(fromApp(app)); setErrors({}); }}>
              {m.common.discard}
            </Button>
            <Button type="submit" variant="primary" busy={save.isPending}>
              {m.common.saveChanges}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
