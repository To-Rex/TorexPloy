/**
 * Live container logs: every replica (or compose service) of the active
 * deployment, with the window, the replica and the service to look at.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ScrollText } from 'lucide-react';
import { Card } from '../../components/Frame.tsx';
import { LogViewer } from '../../components/LogViewer.tsx';
import { LogWindowPicker, useLogWindow } from '../../components/LogWindow.tsx';
import { EmptyState, Segmented, Select } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useLogStream } from '../../lib/logs.ts';
import { useCompose } from '../../lib/queries.ts';
import { useAppContext } from './AppLayout.tsx';

export function LogsTab() {
  const app = useAppContext();
  const { m, t } = useI18n();
  const active = app.activeDeployment;
  const serving = active !== null && app.status !== 'stopped';
  const compose = app.kind === 'compose';
  const stack = useCompose(app.id, compose);
  const [service, setService] = useState('');
  const [replica, setReplica] = useState<number | null>(null);
  const window = useLogWindow();
  // Reconnect when the active deployment changes (its containers are new), the window changes or another service is picked.
  const url = serving ? `/api/applications/${app.id}/logs?${window.query}&d=${active.id}${service.length > 0 ? `&service=${encodeURIComponent(service)}` : ''}` : null;
  const { lines, state, clear } = useLogStream(url);
  const shown = useMemo(() => (replica === null ? lines : lines.filter((line) => line.replica === replica)), [lines, replica]);

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
        <>
          {compose && services.length > 1 && (
            <Segmented
              label={m.compose.services}
              value={service}
              onChange={setService}
              options={[{ value: '', label: m.compose.allServices }, ...services.map((name) => ({ value: name, label: name }))]}
            />
          )}
          {!compose && app.replicas > 1 && (
            <Select value={replica === null ? '' : String(replica)} onChange={(event) => setReplica(event.target.value === '' ? null : Number(event.target.value))} aria-label={m.logs.replicaFilter} style={{ width: 'auto' }}>
              <option value="">{m.logs.replicaAll}</option>
              {Array.from({ length: app.replicas }, (_, index) => (
                <option key={index} value={index}>
                  {t(m.logs.replica, { n: index + 1 })}
                </option>
              ))}
            </Select>
          )}
          <LogWindowPicker window={window} />
        </>
      }
    >
      <LogViewer lines={shown} showReplica={app.replicas > 1} empty={state === 'connecting' ? m.logs.connecting : m.logs.empty} name={`${app.slug}-logs`} onClear={clear} />
    </Card>
  );
}
