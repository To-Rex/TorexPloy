/**
 * Files in a conversation, as the person sees them: pictures as thumbnails
 * that open full size, everything else as a chip that downloads. The same
 * pieces show what was attached to a message and what the assistant made.
 *
 * Pictures are prepared before they are sent: a photo straight from a phone
 * is several megabytes and several thousand pixels wide, which costs tokens
 * on every later step of the conversation and is more than a model can use.
 * It is scaled down in the browser first.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Download, File as FileIcon, FileArchive, FileCode2, FileImage, FileSpreadsheet, FileText, X } from 'lucide-react';
import { AI_LIMITS, type AiFileDto } from '@ploy/shared';
import { useI18n } from '../../i18n/index.tsx';
import { aiFileUrl } from './aiApi.ts';

const CODE = /\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|rb|php|java|kt|c|h|cpp|cs|sh|bash|zsh|sql|json|ya?ml|toml|ini|conf|env|xml|html?|css|scss|dockerfile|patch|diff)$/i;
const SHEET = /\.(xlsx?|ods|csv|tsv)$/i;
const ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/i;

/** The icon that says what kind of file a name is. */
export function fileIcon(name: string, mime: string): ReactNode {
  if (mime.startsWith('image/')) return <FileImage aria-hidden="true" />;
  if (SHEET.test(name)) return <FileSpreadsheet aria-hidden="true" />;
  if (ARCHIVE.test(name)) return <FileArchive aria-hidden="true" />;
  if (CODE.test(name)) return <FileCode2 aria-hidden="true" />;
  if (mime === 'application/pdf' || mime.startsWith('text/') || /\.(pdf|docx?|odt|pptx?|odp|md|txt|log|rtf)$/i.test(name)) return <FileText aria-hidden="true" />;
  return <FileIcon aria-hidden="true" />;
}

/** Whether a stored file is shown as a picture. */
export const isPicture = (file: Pick<AiFileDto, 'mime' | 'kind'>): boolean => file.kind === 'image' || ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'].includes(file.mime);

/** A picture at full size over the page; Escape or a click beside it closes. */
export function ImageViewer({ file, onClose }: { file: AiFileDto; onClose: () => void }) {
  const { m, formatBytes } = useI18n();
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  return createPortal(
    <div className="tai-viewer" role="dialog" aria-modal="true" aria-label={file.name} onClick={onClose}>
      <div className="tai-viewer__bar" onClick={(event) => event.stopPropagation()}>
        <span className="truncate">{file.name}</span>
        <small>{formatBytes(file.size)}</small>
        <span className="grow" />
        <a href={aiFileUrl(file)} download={file.name} aria-label={m.ai.download} title={m.ai.download}>
          <Download aria-hidden="true" />
        </a>
        <button type="button" onClick={onClose} aria-label={m.common.close} title={m.common.close} autoFocus>
          <X aria-hidden="true" />
        </button>
      </div>
      <img src={aiFileUrl(file, true)} alt={file.name} onClick={(event) => event.stopPropagation()} />
    </div>,
    document.body,
  );
}

/**
 * The files of a message or of a step. `compact`: small square thumbnails,
 * as in a message the person sent; otherwise pictures are shown large, the
 * way something the assistant made deserves.
 */
export function Attachments({ files, compact = false }: { files: AiFileDto[]; compact?: boolean }) {
  const { m, formatBytes } = useI18n();
  const [viewing, setViewing] = useState<AiFileDto | null>(null);
  if (files.length === 0) return null;
  const pictures = files.filter(isPicture);
  const others = files.filter((file) => !isPicture(file));
  return (
    <div className="tai-files" data-compact={compact || undefined}>
      {pictures.length > 0 && (
        <div className="tai-files__pictures">
          {pictures.map((file) =>
            compact ? (
              <button key={file.id} type="button" className="tai-thumb" onClick={() => setViewing(file)} aria-label={`${m.ai.openPicture}: ${file.name}`} title={file.name}>
                <img src={aiFileUrl(file, true)} alt="" loading="lazy" />
              </button>
            ) : (
              <figure key={file.id} className="tai-picture">
                <button type="button" onClick={() => setViewing(file)} aria-label={`${m.ai.openPicture}: ${file.name}`}>
                  <img src={aiFileUrl(file, true)} alt={file.name} loading="lazy" />
                </button>
                <figcaption>
                  <span className="truncate">{file.name}</span>
                  <a href={aiFileUrl(file)} download={file.name} aria-label={m.ai.download} title={m.ai.download}>
                    <Download aria-hidden="true" />
                  </a>
                </figcaption>
              </figure>
            ),
          )}
        </div>
      )}
      {others.length > 0 && (
        <div className="tai-files__list">
          {others.map((file) => (
            <a key={file.id} className="tai-file" href={aiFileUrl(file)} download={file.name} title={m.ai.download}>
              {fileIcon(file.name, file.mime)}
              <span className="tai-file__name truncate">{file.name}</span>
              <span className="tai-file__size">{formatBytes(file.size)}</span>
            </a>
          ))}
        </div>
      )}
      {viewing !== null && <ImageViewer file={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Before sending
// ---------------------------------------------------------------------------

/** Formats a model takes as they are. */
const MODEL_FORMATS = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** Below this a picture that is already small enough in pixels is sent untouched. */
const KEEP_BYTES = 1_500_000;

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * A picture as it will be sent: scaled so its longer side is at most
 * `AI_LIMITS.imageSide`, and in a format a model reads (a browser that can
 * show a HEIC or a BMP can turn it into a JPEG here). A picture that is
 * already small is returned as it was; one the browser cannot decode is sent
 * as a plain file.
 */
export async function prepareImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= AI_LIMITS.imageSide && file.size <= KEEP_BYTES && MODEL_FORMATS.has(file.type)) return file;
    const scale = Math.min(1, AI_LIMITS.imageSide / longest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (context === null) return file;
    const base = file.name.replace(/\.[^.]+$/, '') || 'image';
    // A screenshot stays a PNG while that is small: text in it stays sharp. Otherwise a JPEG, on white where it was transparent.
    if (file.type === 'image/png') {
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const png = await toBlob(canvas, 'image/png');
      if (png !== null && png.size <= KEEP_BYTES) return new File([png], `${base}.png`, { type: 'image/png' });
    }
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const jpeg = await toBlob(canvas, 'image/jpeg', 0.88);
    if (jpeg === null || (jpeg.size >= file.size && MODEL_FORMATS.has(file.type) && scale === 1)) return file;
    return new File([jpeg], `${base}.jpg`, { type: 'image/jpeg' });
  } finally {
    bitmap.close();
  }
}
