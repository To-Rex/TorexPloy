import { Card } from '../../components/Frame.tsx';
import { LogViewer } from '../../components/LogViewer.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useLogStream } from '../../lib/logs.ts';
import { useServiceContext } from './ServiceLayout.tsx';

export function ServiceLogsTab() {
  const service = useServiceContext();
  const { m } = useI18n();
  const { lines, state } = useLogStream(`/api/services/${service.id}/logs?tail=500&s=${service.status === 'running' ? 'r' : 'x'}`);
  return (
    <Card title={m.logs.title} description={m.logs.serviceHint}>
      <LogViewer lines={lines} empty={state === 'connecting' ? m.logs.connecting : m.logs.empty} />
    </Card>
  );
}
