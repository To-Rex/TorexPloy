/**
 * The drop zone for a source upload: a folder or a `.zip` dropped, or picked
 * through the two buttons; then what was picked (name, files, size, what
 * was left out) and, while it goes, the packing and upload progress.
 * Picking is the only thing it does on its own — the parent decides when
 * to upload (the new-app dialog after creating the app, the source card at
 * once).
 */
import { useRef, useState, type DragEvent } from 'react';
import { FileArchive, Folder, FolderUp, LoaderCircle, X } from 'lucide-react';
import { LIMITS } from '@ploy/shared';
import { useI18n, type I18n } from '../i18n/index.tsx';
import type { Messages } from '../i18n/uz.ts';
import { ApiError } from '../lib/api.ts';
import { errorText } from '../lib/errors.ts';
import { pickFromDrop, pickFromFileList, PickProblem, type Picked, type UploadState } from '../lib/upload.ts';
import { Button } from './ui.tsx';

/** The message for a refused upload: the archive's reason when the server named one, else the general error text. */
export function uploadErrorText(m: Messages, error: unknown): string {
  if (error instanceof ApiError) {
    const reason = error.params.reason;
    const known = (m.upload.errors as Record<string, string>)[typeof reason === 'string' ? reason : ''];
    if (known !== undefined) return known;
  }
  return errorText(m, error);
}

function problemText(i18n: I18n, error: unknown): string {
  const { m, t, formatBytes } = i18n;
  if (error instanceof PickProblem) {
    switch (error.reason) {
      case 'too_many_files':
        return t(m.upload.problems.too_many_files, { max: LIMITS.uploadFilesMax });
      case 'too_big':
        return t(m.upload.problems.too_big, { max: formatBytes(LIMITS.uploadUnpackedMax, 0) });
      case 'zip_too_large':
        return t(m.upload.problems.zip_too_large, { max: formatBytes(LIMITS.uploadMax, 0) });
      default:
        return m.upload.problems.empty;
    }
  }
  return errorText(m, error);
}

export function UploadDrop({
  picked,
  onPick,
  state,
  disabled = false,
  title,
  hint,
}: {
  picked: Picked | null;
  onPick: (picked: Picked | null) => void;
  state: UploadState;
  disabled?: boolean;
  title?: string;
  hint?: string;
}) {
  const i18n = useI18n();
  const { m, t, plural, formatBytes } = i18n;
  const u = m.upload;
  const [dragging, setDragging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const busy = state.phase === 'packing' || state.phase === 'uploading';

  const take = async (source: Picked | Promise<Picked>) => {
    try {
      const result = await source;
      setProblem(null);
      onPick(result);
    } catch (error) {
      setProblem(problemText(i18n, error));
      onPick(null);
    }
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (disabled || busy) return;
    void take(pickFromDrop(event.dataTransfer));
  };

  if (picked === null) {
    return (
      <div className="stack" style={{ gap: 6 }}>
        <div
          className="dropzone"
          data-active={dragging || undefined}
          data-disabled={disabled || undefined}
          onDragOver={(event) => {
            event.preventDefault();
            if (!disabled) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <span className="dropzone__icon" aria-hidden="true">
            <FolderUp />
          </span>
          <span className="dropzone__title">{title ?? u.dropTitle}</span>
          <span className="dropzone__hint">{hint ?? u.dropHint}</span>
          <span className="dropzone__actions">
            <Button size="sm" icon={<Folder />} disabled={disabled} onClick={() => folderInput.current?.click()}>
              {u.chooseFolder}
            </Button>
            <Button size="sm" icon={<FileArchive />} disabled={disabled} onClick={() => zipInput.current?.click()}>
              {u.chooseZip}
            </Button>
          </span>
          <input
            ref={folderInput}
            type="file"
            multiple
            hidden
            {...({ webkitdirectory: '' } as object)}
            onChange={(event) => {
              if (event.target.files !== null && event.target.files.length > 0) void take(pickFromFileList(event.target.files));
              event.target.value = '';
            }}
          />
          <input
            ref={zipInput}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              if (event.target.files !== null && event.target.files.length > 0) void take(pickFromFileList(event.target.files));
              event.target.value = '';
            }}
          />
        </div>
        {problem !== null && <p className="field__error">{problem}</p>}
      </div>
    );
  }

  const Icon = picked.kind === 'zip' ? FileArchive : Folder;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="upload-summary">
        <Icon aria-hidden="true" />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="upload-summary__name truncate">{picked.name}</div>
          <div className="upload-summary__meta">
            {picked.kind === 'folder' ? `${plural(u.files, picked.files.length)} · ${formatBytes(picked.size)}` : formatBytes(picked.size)}
            {picked.skipped.length > 0 && <> · {t(u.skipped, { names: picked.skipped.join(', ') })}</>}
          </div>
        </div>
        {!busy && state.phase !== 'done' && (
          <Button variant="ghost" size="sm" iconOnly icon={<X />} disabled={disabled} onClick={() => onPick(null)}>
            {u.remove}
          </Button>
        )}
      </div>
      {(busy || state.phase === 'done') && (
        <div className="upload-progress" aria-live="polite">
          <span className="row" style={{ gap: 6 }}>
            {busy && <LoaderCircle className="spin" width={14} height={14} aria-hidden="true" />}
            {state.phase === 'packing' && t(u.packing, { percent: Math.round(state.ratio * 100) })}
            {state.phase === 'uploading' && t(u.uploading, { percent: Math.round(state.ratio * 100) })}
            {state.phase === 'done' && u.done}
          </span>
          <div className="meter">
            <span style={{ width: `${state.phase === 'done' ? 100 : Math.round(state.ratio * 100)}%` }} />
          </div>
        </div>
      )}
      {state.phase === 'failed' && <p className="field__error">{uploadErrorText(m, state.error)}</p>}
    </div>
  );
}
