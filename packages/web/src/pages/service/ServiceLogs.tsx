/** Live logs of the database container, with the window to start from. */
import { Card } from '../../components/Frame.tsx';
import { LogViewer } from '../../components/LogViewer.tsx';
import { LogWindowPicker, useLogWindow } from '../../components/LogWindow.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useLogStream } from '../../lib/logs.ts';
import { useServiceContext } from './ServiceLayout.tsx';

export function ServiceLogsTab() {
  const service = useServiceContext();
  const { m } = useI18n();
  const window = useLogWindow();
  const { lines, state, clear } = useLogStream(`/api/services/${service.id}/logs?${window.query}&s=${service.status === 'running' ? 'r' : 'x'}`);
  return (
    <Card title={m.logs.title} description={m.logs.serviceHint} actions={<LogWindowPicker window={window} />}>
      <LogViewer lines={lines} empty={state === 'connecting' ? m.logs.connecting : m.logs.empty} name={`${service.slug}-logs`} onClear={clear} />
    </Card>
  );
}
