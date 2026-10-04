/** A shell in the database container; opened from the deploy settings as a dialog. */
import { SquareTerminal } from 'lucide-react';
import { roleAtLeast, type ServiceDto } from '@ploy/shared';
import { TerminalView } from '../../components/Terminal.tsx';
import { Callout, EmptyState } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useRole } from '../../lib/queries.ts';

export function ServiceTerminal({ service }: { service: ServiceDto }) {
  const { m } = useI18n();
  const role = useRole();

  if (role !== null && !roleAtLeast(role, 'developer')) return <Callout title={m.terminal.viewerTitle}>{m.terminal.viewerText}</Callout>;
  if (service.status === 'stopped' || service.status === 'provisioning') {
    return (
      <EmptyState icon={<SquareTerminal />} title={m.terminal.serviceNotRunningTitle}>
        {m.terminal.serviceNotRunningText}
      </EmptyState>
    );
  }
  return (
    <div className="stack" style={{ gap: 12 }}>
      <p className="muted">{m.terminal.serviceHint}</p>
      <TerminalView path={`/api/services/${service.id}/terminal`} replicas={1} />
    </div>
  );
}
