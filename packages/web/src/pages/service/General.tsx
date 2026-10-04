/**
 * A database's General tab: deploy settings (reload, recreate, stop,
 * terminal), the internal connection with its credentials, the external
 * port, and the apps linked to it.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Eye, Play, RefreshCcw, RotateCcw, Square, SquareTerminal } from 'lucide-react';
import { updateServiceSchema, type ServiceCredentialsDto, type ServiceDto } from '@ploy/shared';
import { CopyButton, ValueField } from '../../components/Copy.tsx';
import { useConfirm } from '../../components/Dialog.tsx';
import { Card, SaveFooter } from '../../components/Frame.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Button, Field, Input } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { fetchServiceCredentials, keys } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { useServiceContext, useServiceTerminal } from './ServiceLayout.tsx';

function DeployCard({ service }: { service: ServiceDto }) {
  const { m } = useI18n();
  const d = m.deploySettings;
  const confirm = useConfirm();
  const openTerminal = useServiceTerminal();
  const invalidate = [keys.service(service.id), keys.project(service.projectId)];
  const action = useAction((name: 'start' | 'stop' | 'restart' | 'redeploy') => api.post(`/api/services/${service.id}/${name}`), { invalidate, success: m.deploySettings.queued });
  const stopped = service.status === 'stopped';
  const live = !stopped && service.status !== 'provisioning';
  return (
    <Card title={d.title} description={d.serviceDescription}>
      <div className="action-row">
        <Button icon={<RotateCcw />} disabled={!live} busy={action.isPending && action.variables === 'restart'} onClick={() => action.mutate('restart')} title={d.serviceReloadHint}>
          {d.reload}
        </Button>
        <Button
          icon={<RefreshCcw />}
          busy={action.isPending && action.variables === 'redeploy'}
          title={d.recreateHint}
          onClick={async () => {
            const result = await confirm({ title: d.recreateTitle, text: d.recreateText, confirmLabel: d.recreate });
            if (result.confirmed) action.mutate('redeploy');
          }}
        >
          {d.recreate}
        </Button>
        {stopped ? (
          <Button icon={<Play />} busy={action.isPending && action.variables === 'start'} onClick={() => action.mutate('start')}>
            {m.services.start}
          </Button>
        ) : (
          <Button
            icon={<Square />}
            busy={action.isPending && action.variables === 'stop'}
            onClick={async () => {
              const result = await confirm({ title: d.stopServiceTitle, text: d.stopServiceText, confirmLabel: m.services.stop, danger: true });
              if (result.confirmed) action.mutate('stop');
            }}
          >
            {m.services.stop}
          </Button>
        )}
        <Button icon={<SquareTerminal />} disabled={!live} onClick={openTerminal} title={d.terminalHint}>
          {d.terminal}
        </Button>
      </div>
      <dl className="facts-strip">
        <div>
          <dt>{m.deploySettings.engine}</dt>
          <dd>
            {m.project.databaseLabel[service.type]} {service.version}
          </dd>
        </div>
        <div>
          <dt>{m.services.internal}</dt>
          <dd className="row" style={{ gap: 2 }}>
            <code className="truncate">
              {service.internalHost}:{service.internalPort}
            </code>
            <CopyButton value={`${service.internalHost}:${service.internalPort}`} />
          </dd>
        </div>
        <div>
          <dt>{m.services.public}</dt>
          <dd>{service.publicPort === null ? m.services.publicOff : <code>:{service.publicPort}</code>}</dd>
        </div>
        <div>
          <dt>{m.services.linkedApps}</dt>
          <dd>{service.linkedApplications.length}</dd>
        </div>
      </dl>
    </Card>
  );
}

function CredentialsCard({ service, credentials, onReveal, loading }: { service: ServiceDto; credentials: ServiceCredentialsDto | null; onReveal: () => void; loading: boolean }) {
  const { m } = useI18n();
  return (
    <Card
      title={m.services.internal}
      description={m.services.internalHint}
      actions={
        credentials === null ? (
          <Button icon={<Eye />} busy={loading} onClick={onReveal}>
            {m.services.reveal}
          </Button>
        ) : undefined
      }
    >
      <div className="form-grid">
        <Field label={m.services.host}>
          <ValueField value={service.internalHost} />
        </Field>
        <Field label={m.services.port}>
          <ValueField value={String(service.internalPort)} />
        </Field>
        {credentials !== null && credentials.username !== null && (
          <Field label={m.services.username}>
            <ValueField value={credentials.username} />
          </Field>
        )}
        {credentials !== null && (
          <Field label={m.services.password}>
            <ValueField value={credentials.password} secret />
          </Field>
        )}
        {credentials !== null && credentials.database !== null && (
          <Field label={m.services.database}>
            <ValueField value={credentials.database} />
          </Field>
        )}
      </div>
      {credentials === null ? (
        <p className="field__hint">{m.services.revealHint}</p>
      ) : (
        <Field label={m.services.internalUrl}>
          <ValueField value={credentials.internalUrl} secret />
        </Field>
      )}
    </Card>
  );
}

function ExternalCard({ service, credentials }: { service: ServiceDto; credentials: ServiceCredentialsDto | null }) {
  const { m } = useI18n();
  const initial = service.publicPort === null ? '' : String(service.publicPort);
  const [port, setPort] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => setPort(initial), [initial]);
  const save = useAction((publicPort: number | null) => api.patch(`/api/services/${service.id}`, { publicPort }), {
    success: m.services.saved,
    invalidate: [keys.service(service.id), keys.project(service.projectId)],
    inlineValidation: true,
  });
  const submit = () => {
    const value = port.trim().length === 0 ? null : Number(port);
    const result = validate(m, updateServiceSchema, { publicPort: value });
    if (result.errors !== null) return setErrors(result.errors);
    setErrors({});
    save.mutate(value, { onError: (error) => setErrors(fieldErrors(m, error)) });
  };
  return (
    <Card
      title={m.services.public}
      description={m.services.publicPortHint}
      footer={<SaveFooter dirty={port !== initial} saving={save.isPending} onSave={submit} onReset={() => setPort(initial)} />}
    >
      <div className="form-grid">
        <Field label={m.services.publicPort} error={errors.publicPort} hint={m.services.publicPortFieldHint}>
          <Input value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="—" />
        </Field>
        {service.publicPort !== null && (
          <Field label={m.services.publicUrl}>
            {credentials?.publicUrl != null ? <ValueField value={credentials.publicUrl} secret /> : <ValueField value={`:${service.publicPort}`} />}
          </Field>
        )}
      </div>
    </Card>
  );
}

function LinkedCard({ service, credentials }: { service: ServiceDto; credentials: ServiceCredentialsDto | null }) {
  const { m } = useI18n();
  const env = credentials === null ? null : Object.entries(credentials.env).map(([key, value]) => `${key}=${value}`).join('\n');
  return (
    <Card title={m.services.linkedApps} description={m.services.env}>
      {service.linkedApplications.length === 0 ? (
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{m.services.notLinked}</p>
      ) : (
        <div className="row wrap">
          {service.linkedApplications.map((app) => (
            <Link key={app.id} className="btn btn--sm" to={`/apps/${app.id}/environment`} style={{ textDecoration: 'none' }}>
              {app.name}
            </Link>
          ))}
        </div>
      )}
      {env !== null && (
        <div className="codeblock">
          {env}
          <CopyButton value={env} />
        </div>
      )}
    </Card>
  );
}

export function ServiceGeneralTab() {
  const service = useServiceContext();
  const toast = useToast();
  const [credentials, setCredentials] = useState<ServiceCredentialsDto | null>(null);
  const [loading, setLoading] = useState(false);
  const reveal = async () => {
    setLoading(true);
    try {
      setCredentials(await fetchServiceCredentials(service.id));
    } catch (error) {
      toast.error(error);
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <DeployCard service={service} />
      <CredentialsCard service={service} credentials={credentials} onReveal={() => void reveal()} loading={loading} />
      <ExternalCard service={service} credentials={credentials} />
      <LinkedCard service={service} credentials={credentials} />
    </>
  );
}
