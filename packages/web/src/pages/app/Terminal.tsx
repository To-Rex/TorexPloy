/** A shell in one of the app's containers; opened from the deploy settings as a dialog. */
import { Rocket, SquareTerminal } from 'lucide-react';
import { roleAtLeast, type ApplicationDto } from '@ploy/shared';
import { TerminalView } from '../../components/Terminal.tsx';
import { Callout, EmptyState, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useAppContainers, useRole } from '../../lib/queries.ts';

export function AppTerminal({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const role = useRole();
  const containers = useAppContainers(app.id);

  if (role !== null && !roleAtLeast(role, 'developer')) return <Callout title={m.terminal.viewerTitle}>{m.terminal.viewerText}</Callout>;
  if (app.activeDeployment === null || app.status === 'stopped') {
    return (
      <EmptyState icon={app.activeDeployment === null ? <Rocket /> : <SquareTerminal />} title={m.terminal.notRunningTitle}>
        {m.terminal.notRunningText}
      </EmptyState>
    );
  }
  if (containers.data === undefined && containers.isPending) return <Skeleton height={420} />;
  const services = app.kind === 'compose' ? [...new Set((containers.data ?? []).filter((container) => container.state === 'running').map((container) => container.service ?? ''))].filter((name) => name.length > 0) : undefined;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <p className="muted">{m.terminal.hint}</p>
      <TerminalView path={`/api/applications/${app.id}/terminal`} replicas={Math.max(1, containers.data?.length ?? 1)} {...(services === undefined ? {} : { services })} />
    </div>
  );
}
