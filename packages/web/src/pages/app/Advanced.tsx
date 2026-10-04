/**
 * Advanced: how the app runs once built — the run command, port and
 * replicas, resource limits, health check, rollout strategy, volumes —
 * each in its own card with its own save; host access for compose stacks;
 * and deletion.
 */
import { useNavigate } from 'react-router';
import { Trash2 } from 'lucide-react';
import { roleAtLeast, type ApplicationDto } from '@ploy/shared';
import { useConfirm } from '../../components/Dialog.tsx';
import { Card, SaveFooter } from '../../components/Frame.tsx';
import { Button, Callout, Field, Input, Select, Switch } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useCompose, useRole } from '../../lib/queries.ts';
import { useAppContext } from './AppLayout.tsx';
import { useAppForm } from './appForm.ts';
import { VolumesCard } from './Storage.tsx';

function RunCommandCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const { text, dirty, submit, reset, saving, errors } = useAppForm(app);
  return (
    <Card title={m.advanced.runTitle} description={m.advanced.runHint} footer={<SaveFooter dirty={dirty} saving={saving} onSave={submit} onReset={reset} />}>
      <Field label={m.appSettings.startCommand} error={errors.startCommand}>
        <Input mono {...text('startCommand')} placeholder={app.source.type === 'image' ? m.advanced.runImagePlaceholder : m.appSettings.auto} spellCheck={false} />
      </Field>
    </Card>
  );
}

function RuntimeCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const { form, set, text, dirty, submit, reset, saving, errors } = useAppForm(app);
  return (
    <Card title={m.advanced.runtimeTitle} description={m.advanced.runtimeHint} footer={<SaveFooter dirty={dirty} saving={saving} onSave={submit} onReset={reset} />}>
      <div className="form-grid">
        <Field label={m.newApp.kind}>
          <Select value={form.kind} onChange={(event) => set('kind', event.target.value as ApplicationDto['kind'])}>
            <option value="web">{m.newApp.kindWeb}</option>
            <option value="worker">{m.newApp.kindWorker}</option>
          </Select>
        </Field>
        {form.kind === 'web' && (
          <Field label={m.appSettings.port} hint={m.newApp.portHint} error={errors.port}>
            <Input {...text('port', true)} inputMode="numeric" placeholder={m.appSettings.auto} />
          </Field>
        )}
        <Field label={m.appSettings.replicas} hint={m.appSettings.replicasHint} error={errors.replicas}>
          <Input {...text('replicas', true)} inputMode="numeric" />
        </Field>
      </div>
    </Card>
  );
}

function ResourcesCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const { text, dirty, submit, reset, saving, errors } = useAppForm(app);
  return (
    <Card title={m.advanced.resourcesTitle} description={m.advanced.resourcesHint} footer={<SaveFooter dirty={dirty} saving={saving} onSave={submit} onReset={reset} />}>
      <div className="form-grid">
        <Field label={m.appSettings.cpu} hint={m.appSettings.cpuHint} error={errors.cpuLimit}>
          <Input {...text('cpuLimit', true)} inputMode="decimal" placeholder="—" />
        </Field>
        <Field label={m.appSettings.memory} hint={m.appSettings.memoryHint} error={errors.memoryLimitMb}>
          <Input {...text('memoryLimitMb', true)} inputMode="numeric" placeholder="—" />
        </Field>
      </div>
    </Card>
  );
}

function HealthCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const { text, dirty, submit, reset, saving, errors } = useAppForm(app);
  const compose = app.kind === 'compose';
  return (
    <Card
      title={compose ? m.compose.settleTitle : m.appSettings.health}
      description={compose ? m.compose.settleHint : m.appSettings.healthHint}
      footer={<SaveFooter dirty={dirty} saving={saving} onSave={submit} onReset={reset} />}
    >
      <div className="form-grid">
        {!compose && (
          <Field label={m.appSettings.healthPath} hint={m.appSettings.healthPathHint} error={errors.healthCheckPath}>
            <Input mono {...text('healthCheckPath')} placeholder="/health" spellCheck={false} />
          </Field>
        )}
        <Field label={m.appSettings.healthTimeout} error={errors.healthCheckTimeoutSec}>
          <Input {...text('healthCheckTimeoutSec', true)} inputMode="numeric" />
        </Field>
      </div>
    </Card>
  );
}

function StrategyCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const { form, set, dirty, submit, reset, saving } = useAppForm(app);
  return (
    <Card title={m.appSettings.strategy} description={m.advanced.strategyHint} footer={<SaveFooter dirty={dirty} saving={saving} onSave={submit} onReset={reset} />}>
      <div className="radio-list" role="radiogroup" aria-label={m.appSettings.strategy}>
        {(['rolling', 'recreate'] as const).map((value) => (
          <button key={value} type="button" role="radio" className="radio-item" aria-checked={form.strategy === value} onClick={() => set('strategy', value)}>
            <span className="radio-item__dot" aria-hidden="true" />
            <span>
              <span className="radio-item__title">{m.appSettings.strategies[value]}</span>
              <span className="radio-item__hint">{m.appSettings.strategyHints[value]}</span>
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}

/** Compose only: an administrator's grant for host-reaching features (privileged, host network, absolute binds). */
function HostAccessCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const role = useRole();
  const admin = role !== null && roleAtLeast(role, 'admin');
  const compose = useCompose(app.id);
  const toggle = useAction((allowed: boolean) => api.put(`/api/applications/${app.id}/host-access`, { allowed }), {
    success: m.appSettings.saved,
    invalidate: [keys.app(app.id), keys.appPart(app.id, 'compose')],
  });
  const needed = compose.data?.hostAccessNeeded ?? [];
  return (
    <Card title={m.compose.hostAccessTitle} description={m.compose.hostAccessHint}>
      {needed.length > 0 ? (
        <Callout tone={app.hostAccess ? 'info' : 'work'} title={m.compose.hostAccessUses}>
          <ul className="plain-list">
            {needed.map((item) => (
              <li key={item}>
                <code>{item}</code>
              </li>
            ))}
          </ul>
        </Callout>
      ) : (
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{m.compose.hostAccessNone}</p>
      )}
      <Switch
        checked={app.hostAccess}
        onChange={(value) => toggle.mutate(value)}
        disabled={!admin || toggle.isPending}
        label={m.compose.hostAccessAllow}
        hint={admin ? m.compose.hostAccessWarning : m.compose.hostAccessAdminOnly}
      />
    </Card>
  );
}

function DangerCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const compose = app.kind === 'compose';
  const remove = useAction((removeData: boolean) => api.delete(`/api/applications/${app.id}?removeData=${removeData}`), {
    success: m.appSettings.deleted,
    invalidate: [keys.project(app.projectId), keys.projects, keys.apps],
    onSuccess: () => void navigate(`/projects/${app.projectId}`),
  });
  return (
    <Card
      tone="bad"
      title={m.appSettings.deleteTitle}
      description={compose ? m.compose.deleteText : m.appSettings.deleteText}
      actions={
        <Button
          variant="danger"
          icon={<Trash2 />}
          busy={remove.isPending}
          onClick={async () => {
            const result = await confirm({
              title: m.appSettings.deleteTitle,
              text: compose ? m.compose.deleteText : m.appSettings.deleteText,
              confirmLabel: m.common.delete,
              danger: true,
              typeToConfirm: app.name,
              checkbox: { label: compose ? m.compose.deleteData : m.appSettings.deleteData },
            });
            if (result.confirmed) remove.mutate(result.checked);
          }}
        >
          {m.app.delete}
        </Button>
      }
    />
  );
}

export function AdvancedTab() {
  const app = useAppContext();
  const compose = app.kind === 'compose';
  if (compose) {
    return (
      <>
        <HealthCard app={app} />
        <HostAccessCard app={app} />
        <DangerCard app={app} />
      </>
    );
  }
  return (
    <>
      <RunCommandCard app={app} />
      <div className="card-row">
        <RuntimeCard app={app} />
        <ResourcesCard app={app} />
      </div>
      {app.kind === 'web' && <HealthCard app={app} />}
      <StrategyCard app={app} />
      <VolumesCard app={app} />
      <DangerCard app={app} />
    </>
  );
}
