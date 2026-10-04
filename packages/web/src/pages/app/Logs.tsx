import { ScrollText } from 'lucide-react';
import { Link } from 'react-router';
import { Card } from '../../components/Frame.tsx';
import { LogViewer } from '../../components/LogViewer.tsx';
import { useState } from 'react';
import { EmptyState, Segmented } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useLogStream } from '../../lib/logs.ts';
import { useCompose } from '../../lib/queries.ts';
import { useAppContext } from './AppLayout.tsx';

export function LogsTab() {
  const app = useAppContext();
  const { m } = useI18n();
  const active = app.activeDeployment;
  const serving = active !== null && app.status !== 'stopped';
  const compose = app.kind === 'compose';
  const stack = useCompose(app.id, compose);
  const [service, setService] = useState('');
  // Reconnect when the active deployment changes (its containers are new) or another service is picked.
  const { lines, state } = useLogStream(serving ? `/api/applications/${app.id}/logs?tail=500&d=${active.id}${service.length > 0 ? `&service=${encodeURIComponent(service)}` : ''}` : null);
  if (!serving) {
    return (
      <EmptyState
        icon={<ScrollText />}
        action={
          app.latestDeployment !== null ? (
            <Link className="btn" to={`/deployments/${app.latestDeployment.id}`} style={{ textDecoration: 'none' }}>
              {m.deployments.viewLog}
            </Link>
          ) : undefined
        }
      >
        {m.logs.notRunning}
      </EmptyState>
    );
  }
  const services = stack.data?.services ?? [];
  return (
    <Card
      title={m.logs.title}
      description={m.logs.hint}
      actions={
        compose && services.length > 1 ? (
          <Segmented
            label={m.compose.services}
            value={service}
            onChange={setService}
            options={[{ value: '', label: m.compose.allServices }, ...services.map((name) => ({ value: name, label: name }))]}
          />
        ) : undefined
      }
    >
      <LogViewer lines={lines} showReplica={app.replicas > 1} empty={state === 'connecting' ? m.logs.connecting : m.logs.empty} />
    </Card>
  );
}
