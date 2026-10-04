/** Status rendering: tone + shape + word, never colour alone. */
import type { AppStatus, BackupStatus, CronRunStatus, DeploymentStatus, DnsStatus, ServerStatus, ServiceStatus, TlsStatus } from '@ploy/shared';
import { useI18n } from '../i18n/index.tsx';
import type { Tone } from './ui.tsx';

export const appTone: Record<AppStatus, Tone> = {
  idle: 'idle',
  queued: 'work',
  building: 'work',
  deploying: 'work',
  running: 'ok',
  crashed: 'bad',
  failed: 'bad',
  stopped: 'idle',
};
export const deploymentTone: Record<DeploymentStatus, Tone> = { queued: 'work', building: 'work', deploying: 'work', succeeded: 'ok', failed: 'bad', cancelled: 'idle' };
export const serviceTone: Record<ServiceStatus, Tone> = { provisioning: 'work', running: 'ok', stopped: 'idle', failed: 'bad', restarting: 'work' };
export const serverTone: Record<ServerStatus, Tone> = { pending: 'idle', connecting: 'work', ready: 'ok', error: 'bad', offline: 'bad' };
export const dnsTone: Record<DnsStatus, Tone> = { pending: 'work', ok: 'ok', mismatch: 'work', error: 'bad' };
export const tlsTone: Record<TlsStatus, Tone> = { pending: 'work', active: 'ok', error: 'bad', disabled: 'idle' };
export const runTone: Record<BackupStatus | CronRunStatus, Tone> = { running: 'work', succeeded: 'ok', failed: 'bad' };

export function StatusMark({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className="status" data-tone={tone}>
      <span className="status__mark" aria-hidden="true" />
      {label}
    </span>
  );
}

type StatusProps =
  | { kind: 'app'; status: AppStatus }
  | { kind: 'deployment'; status: DeploymentStatus }
  | { kind: 'service'; status: ServiceStatus }
  | { kind: 'server'; status: ServerStatus }
  | { kind: 'dns'; status: DnsStatus }
  | { kind: 'tls'; status: TlsStatus }
  | { kind: 'backup'; status: BackupStatus }
  | { kind: 'cron'; status: CronRunStatus };

export function Status(props: StatusProps) {
  const { m } = useI18n();
  switch (props.kind) {
    case 'app':
      return <StatusMark tone={appTone[props.status]} label={m.status.app[props.status]} />;
    case 'deployment':
      return <StatusMark tone={deploymentTone[props.status]} label={m.status.deployment[props.status]} />;
    case 'service':
      return <StatusMark tone={serviceTone[props.status]} label={m.status.service[props.status]} />;
    case 'server':
      return <StatusMark tone={serverTone[props.status]} label={m.status.server[props.status]} />;
    case 'dns':
      return <StatusMark tone={dnsTone[props.status]} label={m.status.dns[props.status]} />;
    case 'tls':
      return <StatusMark tone={tlsTone[props.status]} label={m.status.tls[props.status]} />;
    case 'backup':
      return <StatusMark tone={runTone[props.status]} label={m.status.backup[props.status]} />;
    case 'cron':
      return <StatusMark tone={runTone[props.status]} label={m.status.cron[props.status]} />;
  }
}
