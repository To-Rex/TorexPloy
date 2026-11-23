/**
 * Pieces every transfer page shares: its status as a badge, the overall
 * progress and the list of steps (each with how far it got and why it was
 * skipped or failed), and notes put into the reader's language.
 */
import type { ReactNode } from 'react';
import { AppWindow, Boxes, CircleCheck, CircleDashed, CircleMinus, CircleX, CloudUpload, Code, Database, Download, FileCheck2, FolderArchive, HardDrive, Layers, LoaderCircle, PackageOpen, Rocket } from 'lucide-react';
import type { TransferDto, TransferNoteDto, TransferStatus, TransferStepDto, TransferStepKind } from '@ploy/shared';
import { Badge, type Tone } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import './transfers.css';

export const STATUS_TONE: Record<TransferStatus, Tone> = {
  receiving: 'work',
  locked: 'info',
  ready: 'info',
  queued: 'idle',
  running: 'work',
  succeeded: 'ok',
  failed: 'bad',
  cancelled: 'idle',
};

export function TransferStatusBadge({ status }: { status: TransferStatus }) {
  const { m } = useI18n();
  return (
    <Badge tone={STATUS_TONE[status]} icon={status === 'running' || status === 'receiving' ? <LoaderCircle className="spin" /> : undefined}>
      {m.transfers.status[status]}
    </Badge>
  );
}

const STEP_ICONS: Record<TransferStepKind, ReactNode> = {
  receive: <Download />,
  verify: <FileCheck2 />,
  prepare: <PackageOpen />,
  project: <Boxes />,
  service: <Database />,
  database: <Database />,
  storage: <FolderArchive />,
  volume: <HardDrive />,
  source: <Code />,
  image: <Layers />,
  application: <AppWindow />,
  deploy: <Rocket />,
  upload: <CloudUpload />,
};

const STATUS_ICONS: Record<TransferStepDto['status'], ReactNode> = {
  pending: <CircleDashed />,
  running: <LoaderCircle className="spin" />,
  done: <CircleCheck />,
  failed: <CircleX />,
  skipped: <CircleMinus />,
};

/** A note from the server in the reader's language: its code picks the words, its parameters fill them in. */
export function useNoteText(): (note: TransferNoteDto) => string {
  const { m, t } = useI18n();
  const notes = m.transfers.notes as Record<string, string>;
  return (note) => {
    const template = notes[note.code] ?? (note.code.startsWith('source_') ? notes.source_other : undefined);
    if (template === undefined) return note.message;
    const text = t(template, note.params ?? {});
    // A note written before its template grew a parameter: the server's own sentence says it whole.
    return /\{[a-zA-Z]+\}/.test(text) ? note.message : text;
  };
}

export function Meter({ value, tone }: { value: number; tone?: Tone }) {
  const color = tone === 'bad' ? 'var(--bad)' : tone === 'ok' ? 'var(--ok)' : undefined;
  return (
    <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)} style={color === undefined ? undefined : { ['--meter' as string]: color }}>
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

function StepAmount({ step }: { step: TransferStepDto }) {
  const { formatBytes } = useI18n();
  if (step.done === null && step.total === null) return null;
  const amount = (value: number) => (step.unit === 'bytes' ? formatBytes(value) : String(value));
  if (step.status === 'done') return <span className="transfer-step__amount">{step.total === null ? null : amount(step.total)}</span>;
  if (step.status !== 'running') return null;
  return (
    <span className="transfer-step__amount">
      {amount(step.done ?? 0)}
      {step.total !== null && step.total > 0 && ` / ${amount(step.total)}`}
    </span>
  );
}

export function TransferSteps({ steps }: { steps: TransferStepDto[] }) {
  const { m } = useI18n();
  const noteText = useNoteText();
  if (steps.length === 0) return null;
  return (
    <ol className="transfer-steps">
      {steps.map((step) => (
        <li key={step.key} className="transfer-step" data-status={step.status}>
          <span className="transfer-step__status" aria-label={m.transfers.stepStatus[step.status]}>
            {STATUS_ICONS[step.status]}
          </span>
          <span className="transfer-step__kind" aria-hidden="true">
            {STEP_ICONS[step.kind]}
          </span>
          <div className="transfer-step__body">
            <div className="transfer-step__line">
              <span className="transfer-step__label">{m.transfers.steps[step.kind]}</span>
              {step.name !== null && <span className="transfer-step__name">{step.name}</span>}
              <span className="grow" />
              <StepAmount step={step} />
            </div>
            {step.status === 'running' && step.total !== null && step.total > 0 && step.done !== null && <Meter value={(step.done / step.total) * 100} />}
            {step.note !== null && <p className="transfer-step__note">{noteText(step.note)}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The overall bar with its percentage, while a transfer moves. */
export function TransferProgress({ transfer }: { transfer: TransferDto }) {
  const { m, t, formatBytes } = useI18n();
  if (transfer.status === 'receiving') {
    const ratio = transfer.expectedBytes === null || transfer.expectedBytes === 0 ? null : (transfer.receivedBytes / transfer.expectedBytes) * 100;
    return (
      <div className="transfer-progress">
        <div className="transfer-progress__line">
          <span>{m.transfers.receiving}</span>
          <span className="faint">
            {formatBytes(transfer.receivedBytes)}
            {transfer.expectedBytes !== null && ` / ${formatBytes(transfer.expectedBytes)}`}
          </span>
        </div>
        <Meter value={ratio ?? 0} />
      </div>
    );
  }
  if (transfer.status !== 'running' && transfer.status !== 'queued') return null;
  return (
    <div className="transfer-progress">
      <div className="transfer-progress__line">
        <span>{transfer.status === 'queued' ? m.transfers.queuedHint : t(m.transfers.percent, { percent: Math.floor(transfer.percent) })}</span>
      </div>
      <Meter value={transfer.percent} />
    </div>
  );
}

export function TransferNotes({ notes, tone = 'work' }: { notes: TransferNoteDto[]; tone?: 'work' | 'bad' }) {
  const noteText = useNoteText();
  if (notes.length === 0) return null;
  return (
    <ul className="transfer-notes" data-tone={tone}>
      {notes.map((note, index) => (
        <li key={`${note.code}-${index}`}>{noteText(note)}</li>
      ))}
    </ul>
  );
}
