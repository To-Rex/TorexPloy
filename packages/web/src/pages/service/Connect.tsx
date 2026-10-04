import { useState } from 'react';
import { Link } from 'react-router';
import { Eye } from 'lucide-react';
import type { ServiceCredentialsDto } from '@ploy/shared';
import { CopyButton, ValueField } from '../../components/Copy.tsx';
import { Button, Field } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { fetchServiceCredentials } from '../../lib/queries.ts';
import { useToast } from '../../components/Toast.tsx';
import { useServiceContext } from './ServiceLayout.tsx';

export function ConnectTab() {
  const service = useServiceContext();
  const { m } = useI18n();
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
      <div className="section">
        <div className="section__intro">
          <h2>{m.services.internal}</h2>
          <p>{m.services.internalHint}</p>
        </div>
        <div className="stack">
          <ValueField value={`${service.internalHost}:${service.internalPort}`} />
          {credentials === null ? (
            <div>
              <Button icon={<Eye />} busy={loading} onClick={() => void reveal()}>
                {m.services.reveal}
              </Button>
              <p className="field__hint" style={{ marginTop: 6 }}>{m.services.revealHint}</p>
            </div>
          ) : (
            <>
              <Field label="URL">
                <ValueField value={credentials.internalUrl} secret />
              </Field>
              <div className="form-grid">
                {credentials.username !== null && (
                  <Field label={m.services.username}>
                    <ValueField value={credentials.username} />
                  </Field>
                )}
                <Field label={m.services.password}>
                  <ValueField value={credentials.password} secret />
                </Field>
                {credentials.database !== null && (
                  <Field label={m.services.database}>
                    <ValueField value={credentials.database} />
                  </Field>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="section">
        <div className="section__intro">
          <h2>{m.services.public}</h2>
          <p>{m.services.publicHint}</p>
        </div>
        <div>
          {service.publicPort === null ? (
            <p className="muted">
              {m.services.publicOff}.{' '}
              <Link to={`/services/${service.id}/settings`}>{m.services.publicPort}</Link>
            </p>
          ) : credentials?.publicUrl != null ? (
            <ValueField value={credentials.publicUrl} secret />
          ) : (
            <ValueField value={`:${service.publicPort}`} />
          )}
        </div>
      </div>
      <div className="section">
        <div className="section__intro">
          <h2>{m.services.linkedApps}</h2>
          <p>{m.services.env}</p>
        </div>
        <div className="stack" style={{ gap: 12 }}>
          {service.linkedApplications.length === 0 ? (
            <p className="muted">{m.services.notLinked}</p>
          ) : (
            <div className="row wrap">
              {service.linkedApplications.map((app) => (
                <Link key={app.id} className="btn btn--sm" to={`/apps/${app.id}/variables`} style={{ textDecoration: 'none' }}>
                  {app.name}
                </Link>
              ))}
            </div>
          )}
          {credentials !== null && (
            <div className="codeblock">
              {Object.entries(credentials.env)
                .map(([key, value]) => `${key}=${value}`)
                .join('\n')}
              <CopyButton value={Object.entries(credentials.env).map(([key, value]) => `${key}=${value}`).join('\n')} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
