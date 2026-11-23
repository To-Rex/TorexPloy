/**
 * What TorexAi did, as the person sees it.
 *
 * Reading is quiet: a run of steps that only looked at things folds into one
 * line ("5 steps"), which opens to show each of them. A change is a card:
 * what is about to happen in the person's own words, the technical detail a
 * click away, and, while it waits, the buttons that let it run or not. A
 * finished change keeps its card, with a way to take it back when there is
 * one.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { BookOpen, Check, ChevronRight, CircleAlert, Code2, FileDown, FilePen, FileSearch, FileText, FolderOpen, GraduationCap, Hourglass, ImageIcon, LoaderCircle, Map as MapIcon, Plug, ScrollText, ShieldAlert, SquareTerminal, Undo2, X } from 'lucide-react';
import type { AiActionDto, AiToolName } from '@ploy/shared';
import { useConfirm } from '../../components/Dialog.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Button } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { decideAiAction, fetchAiOutput, undoAiAction } from './aiApi.ts';
import { Attachments } from './Attachments.tsx';

const TOOL_ICON: Record<AiToolName, ReactNode> = {
  platform_map: <MapIcon />,
  api_docs: <BookOpen />,
  api_call: <Plug />,
  logs: <ScrollText />,
  wait_deployment: <Hourglass />,
  shell: <SquareTerminal />,
  exec: <SquareTerminal />,
  file_read: <FileText />,
  file_list: <FolderOpen />,
  file_search: <FileSearch />,
  file_write: <FilePen />,
  file_edit: <FilePen />,
  code: <Code2 />,
  create_file: <FileDown />,
  generate_image: <ImageIcon />,
  read_output: <FileText />,
  undo: <Undo2 />,
  skill: <GraduationCap />,
};

function StatusDot({ action }: { action: AiActionDto }) {
  if (action.status === 'running' || action.status === 'pending') return <LoaderCircle className="tai-spin" aria-hidden="true" />;
  if (action.status === 'done') return <Check className="tai-ok" aria-hidden="true" />;
  if (action.status === 'failed') return <CircleAlert className="tai-bad" aria-hidden="true" />;
  return <X className="tai-idle" aria-hidden="true" />;
}

/** The output of a step, the beginning at first and all of it on request. */
function Output({ action }: { action: AiActionDto }) {
  const { m } = useI18n();
  const [full, setFull] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  if (action.output === null || action.output.length === 0) return null;
  const more = async (): Promise<void> => {
    setLoading(true);
    try {
      setFull(await fetchAiOutput(action.id));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="tai-output">
      <pre>{full ?? action.output}</pre>
      {action.outputTruncated && full === null && (
        <button type="button" className="tai-link" onClick={() => void more()} disabled={loading}>
          {m.ai.showAll}
        </button>
      )}
    </div>
  );
}

/** One step that only read something: a line that opens to its detail and output. */
function StepRow({ action }: { action: AiActionDto }) {
  const { m } = useI18n();
  const [open, setOpen] = useState(false);
  const hasMore = (action.output ?? '').length > 0 || (action.preview ?? '').length > 0;
  return (
    <div className="tai-step" data-status={action.status}>
      <button type="button" className="tai-step__head" onClick={() => setOpen((value) => !value)} aria-expanded={open} disabled={!hasMore}>
        <span className="tai-step__icon" aria-hidden="true">
          {TOOL_ICON[action.tool]}
        </span>
        <span className="tai-step__label">{action.title.length > 0 ? action.title : m.ai.tools[action.tool]}</span>
        {action.detail.length > 0 && <code className="tai-step__detail truncate">{action.detail}</code>}
        <span className="tai-step__status">
          <StatusDot action={action} />
        </span>
      </button>
      {action.status === 'failed' && action.summary !== null && !open && <p className="tai-step__error">{action.summary}</p>}
      {open && <Output action={action} />}
      <Attachments files={action.files} />
    </div>
  );
}

/** A change: what it is, whether it may run, how it went, and how to take it back. */
function ChangeCard({ action }: { action: AiActionDto }) {
  const { m } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(action.status === 'pending');
  const [busy, setBusy] = useState<'approve' | 'reject' | 'always' | 'undo' | null>(null);
  const pending = action.status === 'pending';
  const danger = action.risk === 'danger';
  // Once answered, the card folds back to a line: the details stay a click away.
  useEffect(() => {
    if (!pending) setOpen(false);
  }, [pending]);

  const decide = async (kind: 'approve' | 'reject' | 'always'): Promise<void> => {
    setBusy(kind);
    try {
      await decideAiAction(action.id, kind !== 'reject', kind === 'always');
    } catch (error) {
      toast.error(error);
      setBusy(null);
    }
  };

  const undo = async (): Promise<void> => {
    const answer = await confirm({ title: m.ai.undoConfirm, text: action.undoKind === null ? action.title : m.ai.undoKinds[action.undoKind], confirmLabel: m.ai.undo });
    if (!answer.confirmed) return;
    setBusy('undo');
    try {
      await undoAiAction(action.id);
      toast.success(m.ai.undone);
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="tai-card" data-status={action.status} data-risk={action.risk}>
      <div className="tai-card__head">
        <span className="tai-card__icon" aria-hidden="true">
          {danger ? <ShieldAlert /> : TOOL_ICON[action.tool]}
        </span>
        <div className="tai-card__text">
          <div className="tai-card__title">{action.title.length > 0 ? action.title : m.ai.tools[action.tool]}</div>
          {action.detail.length > 0 && <code className="tai-card__detail">{action.detail}</code>}
        </div>
        <span className="tai-card__status" data-status={action.undoneAt !== null ? 'undone' : action.status}>
          {action.undoneAt !== null ? m.ai.undone : pending ? (danger ? m.ai.approval.danger : m.ai.approval.title) : m.ai.status[action.status]}
        </span>
      </div>

      {pending && danger && <p className="tai-card__warning">{m.ai.approval.dangerHint}</p>}
      {action.status === 'failed' && action.summary !== null && <p className="tai-card__error">{action.summary}</p>}
      {action.undoError !== null && (
        <p className="tai-card__error">
          {m.ai.undoFailed}: {action.undoError}
        </p>
      )}

      {((action.preview ?? '').length > 0 || (action.output ?? '').length > 0) && (
        <button type="button" className="tai-card__toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <ChevronRight aria-hidden="true" data-open={open || undefined} />
          {m.ai.approval.details}
        </button>
      )}
      {open && (
        <div className="tai-card__more">
          {(action.preview ?? '').length > 0 && <pre className="tai-card__preview">{action.preview}</pre>}
          {!pending && <Output action={action} />}
        </div>
      )}
      <Attachments files={action.files} />

      {pending && (
        <div className="tai-card__actions">
          <Button variant={danger ? 'danger' : 'primary'} size="sm" busy={busy === 'approve'} disabled={busy !== null} onClick={() => void decide('approve')}>
            {m.ai.approval.approve}
          </Button>
          <Button size="sm" busy={busy === 'reject'} disabled={busy !== null} onClick={() => void decide('reject')}>
            {m.ai.approval.reject}
          </Button>
          {!danger && (
            <Button variant="ghost" size="sm" busy={busy === 'always'} disabled={busy !== null} onClick={() => void decide('always')}>
              {m.ai.approval.always}
            </Button>
          )}
        </div>
      )}
      {action.undoable && (
        <div className="tai-card__actions">
          <Button variant="ghost" size="sm" icon={<Undo2 />} busy={busy === 'undo'} onClick={() => void undo()}>
            {m.ai.undo}
          </Button>
          {action.undoKind !== null && <span className="tai-card__hint">{m.ai.undoKinds[action.undoKind]}</span>}
        </div>
      )}
    </div>
  );
}

/** A step is shown as a card when it changes something, or when it waits for or was refused an answer. */
export const isChange = (action: AiActionDto): boolean => action.risk !== 'safe';

/** A run of consecutive actions between two paragraphs of a reply. */
export function ActionRun({ actions, live }: { actions: AiActionDto[]; live: boolean }) {
  const { m, plural } = useI18n();
  const [open, setOpen] = useState(false);
  // Changes always stand on their own; the quiet steps between them are grouped.
  const groups: ({ kind: 'steps'; items: AiActionDto[] } | { kind: 'change'; item: AiActionDto })[] = [];
  for (const action of actions) {
    if (isChange(action)) groups.push({ kind: 'change', item: action });
    else {
      const last = groups[groups.length - 1];
      if (last !== undefined && last.kind === 'steps') last.items.push(action);
      else groups.push({ kind: 'steps', items: [action] });
    }
  }
  return (
    <div className="tai-run">
      {groups.map((group, index) => {
        if (group.kind === 'change') return <ChangeCard key={group.item.id} action={group.item} />;
        const items = group.items;
        const working = live && index === groups.length - 1 && items.some((item) => item.status === 'running');
        const failed = items.filter((item) => item.status === 'failed').length;
        const withFiles = items.filter((item) => item.files.length > 0);
        // One or two steps are short enough to show as they are.
        if (items.length <= 2) return items.map((item) => <StepRow key={item.id} action={item} />);
        const current = items[items.length - 1]!;
        return (
          <div key={items[0]!.id} className="tai-steps" data-open={open || undefined}>
            <button type="button" className="tai-steps__head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
              <ChevronRight aria-hidden="true" data-open={open || undefined} />
              {working ? <LoaderCircle className="tai-spin" aria-hidden="true" /> : null}
              <span>{plural(m.ai.steps, items.length)}</span>
              {working && <span className="tai-steps__now truncate">{current.title.length > 0 ? current.title : m.ai.tools[current.tool]}</span>}
              {failed > 0 && !working && <span className="tai-steps__failed">{plural(m.ai.stepsFailed, failed)}</span>}
            </button>
            {open && <div className="tai-steps__list">{items.map((item) => <StepRow key={item.id} action={item} />)}</div>}
            {!open && withFiles.map((item) => <Attachments key={item.id} files={item.files} />)}
          </div>
        );
      })}
    </div>
  );
}
