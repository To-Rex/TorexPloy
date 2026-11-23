/**
 * Where the person writes to TorexAi: a text box that grows with what is
 * typed, files and pictures (picked, dropped anywhere on the conversation,
 * or pasted), the model to answer with, and one button that sends, or stops
 * the reply being written.
 *
 * What is attached is shown before it is sent: pictures as thumbnails, files
 * by name, each with a way to take it off again. While the message goes up
 * every attachment shows how far it has got.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { ArrowUp, Check, ChevronDown, ImagePlus, Paperclip, Square, X } from 'lucide-react';
import { AI_LIMITS, type AiModelDto } from '@ploy/shared';
import { Menu, MenuItem, MenuLabel } from '../../components/Menu.tsx';
import { useToast } from '../../components/Toast.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { fileIcon, prepareImage } from './Attachments.tsx';

export interface ComposerHandle {
  /** Attach files that arrived from outside the box (dropped on the conversation). */
  addFiles: (files: File[]) => void;
}

export interface ComposerProps {
  /** A reply is being written: the button stops it. */
  running: boolean;
  /** The message is on its way (files uploading, the request in flight). */
  sending: boolean;
  models: AiModelDto[];
  model: string | null;
  onModel: (ref: string) => void;
  /** Send the message; `progress(index, fraction)` reports how much of each file has gone up. Resolves to whether it was sent. */
  onSend: (text: string, files: File[], progress: (index: number, fraction: number) => void) => Promise<boolean>;
  onStop: () => void;
  /** Text the box starts with (a question carried over from another page). */
  initialText?: string;
  /** Changes when the box should take the focus again (a new conversation). */
  focusKey?: string;
}

interface Attachment {
  key: number;
  file: File;
  /** An object URL for a picture, to show it before it is sent. */
  preview: string | null;
  /** How much has gone up, while sending. */
  progress: number | null;
}

const MAX_HEIGHT = 220;
const PREVIEWABLE = /^image\/(png|jpeg|gif|webp|svg\+xml|avif|bmp)$/;
let nextKey = 0;

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer({ running, sending, models, model, onModel, onSend, onStop, initialText = '', focusKey }, ref) {
  const { m, t, formatBytes } = useI18n();
  const toast = useToast();
  const [text, setText] = useState(initialText);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [preparing, setPreparing] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const picturePicker = useRef<HTMLInputElement>(null);
  const live = useRef<Attachment[]>([]);
  live.current = attachments;
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

  // Previews are browser memory: given back when the box goes away.
  useEffect(
    () => () => {
      for (const attachment of live.current) if (attachment.preview !== null) URL.revokeObjectURL(attachment.preview);
    },
    [],
  );

  const add = async (incoming: File[]): Promise<void> => {
    if (incoming.length === 0) return;
    const room = AI_LIMITS.attachmentsMax - live.current.length;
    if (incoming.length > room) toast.failure(t(m.ai.tooManyFiles, { count: AI_LIMITS.attachmentsMax }));
    const taken = incoming.slice(0, Math.max(0, room));
    if (taken.length === 0) return;
    setPreparing((count) => count + 1);
    try {
      const ready: Attachment[] = [];
      for (const original of taken) {
        // A large photo is scaled down first; the limit applies to what is actually sent.
        const file = await prepareImage(original).catch(() => original);
        if (file.size > AI_LIMITS.fileMax) {
          toast.failure(t(m.ai.fileTooLarge, { name: file.name, limit: formatBytes(AI_LIMITS.fileMax, 0) }));
          continue;
        }
        if (file.size === 0) continue;
        ready.push({ key: (nextKey += 1), file, preview: PREVIEWABLE.test(file.type) ? URL.createObjectURL(file) : null, progress: null });
      }
      setAttachments((existing) => [...existing, ...ready].slice(0, AI_LIMITS.attachmentsMax));
    } finally {
      setPreparing((count) => count - 1);
      box.current?.focus();
    }
  };

  useImperativeHandle(ref, () => ({ addFiles: (files) => void add(files) }));

  const remove = (key: number): void =>
    setAttachments((existing) => {
      const gone = existing.find((attachment) => attachment.key === key);
      if (gone !== undefined && gone.preview !== null) URL.revokeObjectURL(gone.preview);
      return existing.filter((attachment) => attachment.key !== key);
    });

  const busy = sending || preparing > 0;
  const canSend = (text.trim().length > 0 || attachments.length > 0) && !busy && !running;

  const submit = async (): Promise<void> => {
    if (!canSend) return;
    const sent = attachments;
    setAttachments((existing) => existing.map((attachment) => ({ ...attachment, progress: 0 })));
    const ok = await onSend(
      text.trim(),
      sent.map((attachment) => attachment.file),
      (index, fraction) => setAttachments((existing) => existing.map((attachment) => (attachment.key === sent[index]?.key ? { ...attachment, progress: fraction } : attachment))),
    );
    if (ok) {
      for (const attachment of sent) if (attachment.preview !== null) URL.revokeObjectURL(attachment.preview);
      setText('');
      setAttachments([]);
    } else setAttachments((existing) => existing.map((attachment) => ({ ...attachment, progress: null })));
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
    // A screenshot from the clipboard is always called "image.png": give it a name that tells one from the next.
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    void add(pasted.map((file, index) => (/^image\.\w+$/.test(file.name) ? new File([file], `screenshot-${stamp}${pasted.length > 1 ? `-${index + 1}` : ''}.${file.name.split('.').pop()}`, { type: file.type }) : file)));
  };

  const pick = (input: HTMLInputElement): void => {
    void add([...(input.files ?? [])]);
    input.value = '';
  };

  return (
    <div className="tai-composer">
      {attachments.length > 0 && (
        <div className="tai-composer__files">
          {attachments.map((attachment) => {
            const uploading = attachment.progress !== null;
            const percent = Math.round((attachment.progress ?? 0) * 100);
            return (
              <div key={attachment.key} className="tai-attach" data-kind={attachment.preview === null ? 'file' : 'picture'} data-uploading={uploading || undefined} title={`${attachment.file.name} · ${formatBytes(attachment.file.size)}`}>
                {attachment.preview !== null ? (
                  <img src={attachment.preview} alt={attachment.file.name} />
                ) : (
                  <>
                    <span className="tai-attach__icon">{fileIcon(attachment.file.name, attachment.file.type)}</span>
                    <span className="tai-attach__text">
                      <span className="truncate">{attachment.file.name}</span>
                      <small>{uploading ? `${percent}%` : formatBytes(attachment.file.size)}</small>
                    </span>
                  </>
                )}
                {uploading && (
                  <span className="tai-attach__progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={m.ai.uploading}>
                    <i style={{ width: `${percent}%` }} />
                  </span>
                )}
                {!uploading && (
                  <button type="button" className="tai-attach__remove" aria-label={`${m.ai.removeFile}: ${attachment.file.name}`} onClick={() => remove(attachment.key)}>
                    <X aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          })}
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
        <input ref={filePicker} type="file" multiple hidden onChange={(event) => pick(event.target)} />
        <input ref={picturePicker} type="file" accept="image/*" multiple hidden onChange={(event) => pick(event.target)} />
        <button type="button" className="tai-composer__tool" onClick={() => picturePicker.current?.click()} disabled={sending} aria-label={m.ai.attachPicture} title={m.ai.attachPicture}>
          <ImagePlus aria-hidden="true" />
        </button>
        <button type="button" className="tai-composer__tool" onClick={() => filePicker.current?.click()} disabled={sending} aria-label={m.ai.attach} title={m.ai.attach}>
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
        <span className="tai-composer__hint">{preparing > 0 ? m.ai.preparing : sending && attachments.length > 0 ? m.ai.uploading : m.ai.hint}</span>
        {running ? (
          <button type="button" className="tai-composer__send" data-stop onClick={onStop} aria-label={m.ai.stop} title={m.ai.stop}>
            <Square aria-hidden="true" />
          </button>
        ) : (
          <button type="button" className="tai-composer__send" onClick={() => void submit()} disabled={!canSend} aria-label={m.ai.send} title={m.ai.send} aria-busy={busy || undefined}>
            <ArrowUp aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
});
