/**
 * Where the person writes to TorexAi: a text box that grows with what is
 * typed, files dropped, pasted or picked, the model to answer with, and one
 * button that sends, or stops the reply being written.
 */
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { ArrowUp, Check, ChevronDown, FileText, Paperclip, Square, X } from 'lucide-react';
import { AI_LIMITS, type AiModelDto } from '@ploy/shared';
import { Menu, MenuItem, MenuLabel } from '../../components/Menu.tsx';
import { useToast } from '../../components/Toast.tsx';
import { useI18n } from '../../i18n/index.tsx';

export interface ComposerProps {
  /** A reply is being written: the button stops it. */
  running: boolean;
  /** The message is on its way (files uploading, the request in flight). */
  sending: boolean;
  models: AiModelDto[];
  model: string | null;
  onModel: (ref: string) => void;
  onSend: (text: string, files: File[]) => Promise<boolean>;
  onStop: () => void;
  /** Text the box starts with (a question carried over from another page). */
  initialText?: string;
  /** Changes when the box should take the focus again (a new conversation). */
  focusKey?: string;
}

const MAX_HEIGHT = 220;

export function Composer({ running, sending, models, model, onModel, onSend, onStop, initialText = '', focusKey }: ComposerProps) {
  const { m, t, formatBytes } = useI18n();
  const toast = useToast();
  const [text, setText] = useState(initialText);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const current = models.find((entry) => entry.ref === model) ?? models[0];

  useEffect(() => {
    const area = box.current;
    if (area === null) return;
    area.style.height = 'auto';
    area.style.height = `${Math.min(MAX_HEIGHT, area.scrollHeight)}px`;
  }, [text]);

  useEffect(() => {
    box.current?.focus();
  }, [focusKey]);

  const add = (incoming: File[]): void => {
    const accepted: File[] = [];
    for (const file of incoming) {
      if (file.size > AI_LIMITS.fileMax) toast.failure(t(m.ai.fileTooLarge, { name: file.name, limit: formatBytes(AI_LIMITS.fileMax, 0) }));
      else accepted.push(file);
    }
    setFiles((existing) => {
      const next = [...existing, ...accepted];
      if (next.length > AI_LIMITS.attachmentsMax) toast.failure(t(m.ai.tooManyFiles, { count: AI_LIMITS.attachmentsMax }));
      return next.slice(0, AI_LIMITS.attachmentsMax);
    });
  };

  const submit = async (): Promise<void> => {
    const value = text.trim();
    if (value.length === 0 || running || sending) return;
    if (await onSend(value, files)) {
      setText('');
      setFiles([]);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const pasted = [...event.clipboardData.files];
    if (pasted.length === 0) return;
    event.preventDefault();
    add(pasted);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    add([...event.dataTransfer.files]);
  };

  return (
    <div
      className="tai-composer"
      data-dragging={dragging || undefined}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {dragging && <div className="tai-composer__drop">{m.ai.dropHere}</div>}
      {files.length > 0 && (
        <div className="tai-composer__files">
          {files.map((file, index) => (
            <span key={`${file.name}-${index}`} className="tai-chip">
              <FileText aria-hidden="true" />
              <span className="truncate">{file.name}</span>
              <small>{formatBytes(file.size)}</small>
              <button type="button" aria-label={m.ai.removeFile} onClick={() => setFiles((existing) => existing.filter((_file, position) => position !== index))}>
                <X aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={box}
        className="tai-composer__input"
        rows={1}
        value={text}
        maxLength={AI_LIMITS.messageMax}
        placeholder={m.ai.placeholder}
        aria-label={m.ai.placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
      />
      <div className="tai-composer__bar">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            add([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
        <button type="button" className="tai-composer__tool" onClick={() => picker.current?.click()} aria-label={m.ai.attach} title={m.ai.attach}>
          <Paperclip aria-hidden="true" />
        </button>
        {current !== undefined && (
          <Menu
            align="start"
            label={m.ai.model}
            trigger={(props) => (
              <button type="button" className="tai-composer__model" {...props} title={m.ai.model}>
                <span className="truncate">{current.model}</span>
                <ChevronDown aria-hidden="true" />
              </button>
            )}
          >
            <MenuLabel>{m.ai.model}</MenuLabel>
            {models.map((entry) => (
              <MenuItem key={entry.ref} icon={entry.ref === current.ref ? <Check /> : <span style={{ width: 15 }} />} onSelect={() => onModel(entry.ref)}>
                <span className="menu__rich">
                  <span>{entry.model}</span>
                  <small>{entry.provider}</small>
                </span>
              </MenuItem>
            ))}
          </Menu>
        )}
        <span className="tai-composer__hint">{m.ai.hint}</span>
        {running ? (
          <button type="button" className="tai-composer__send" data-stop onClick={onStop} aria-label={m.ai.stop} title={m.ai.stop}>
            <Square aria-hidden="true" />
          </button>
        ) : (
          <button type="button" className="tai-composer__send" onClick={() => void submit()} disabled={text.trim().length === 0 || sending} aria-label={m.ai.send} title={m.ai.send} aria-busy={sending || undefined}>
            <ArrowUp aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
