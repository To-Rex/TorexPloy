import { ScrollText } from 'lucide-react';
import { Link } from 'react-router';
import { LogViewer } from '../../components/LogViewer.tsx';
import { EmptyState } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useLogStream } from '../../lib/logs.ts';
import { useAppContext } from './AppLayout.tsx';

export function LogsTab() {
  const app = useAppContext();
  const { m } = useI18n();
  const active = app.activeDeployment;
  const serving = active !== null && app.status !== 'stopped';
  // Reconnect when the active deployment changes: its containers are new.
  const { lines, state } = useLogStream(serving ? `/api/applications/${app.id}/logs?tail=500&d=${active.id}` : null);
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
  return <LogViewer lines={lines} showReplica={app.replicas > 1} empty={state === 'connecting' ? m.logs.connecting : m.logs.empty} />;
}
