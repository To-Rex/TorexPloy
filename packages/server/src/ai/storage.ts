/**
 * The files of a conversation on disk: `<data>/ai/files/<chat>/<file id>`.
 * What the person attached, what the assistant made for download, the
 * pictures it generated, and the earlier contents of files it overwrote.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiFileKind } from '@ploy/shared';
import type { AiFileRecord, AiStore } from '../store/index.ts';

const MIME: Record<string, string> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
  jsx: 'text/plain; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
  sh: 'text/x-shellscript; charset=utf-8',
  sql: 'application/sql',
  yml: 'text/yaml; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  toml: 'text/plain; charset=utf-8',
  ini: 'text/plain; charset=utf-8',
  conf: 'text/plain; charset=utf-8',
  env: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  patch: 'text/x-diff; charset=utf-8',
  diff: 'text/x-diff; charset=utf-8',
  dockerfile: 'text/plain; charset=utf-8',
};

export function mimeFor(name: string): string {
  const lower = name.toLowerCase();
  const extension = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower;
  return MIME[extension] ?? 'application/octet-stream';
}

/** The format of a picture, by its first bytes. */
export function sniffImage(data: Buffer): string {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString('latin1'))) return 'image/gif';
  return 'application/octet-stream';
}

/**
 * The type of a file someone attached. A model is handed pictures and PDFs
 * as what they are, so the name alone is not believed for those: a
 * `photo.png` that is really a HEIC, or a `.pdf` that is not one, would make
 * the provider refuse the whole message.
 */
export function uploadedMime(name: string, data: Buffer): string {
  const sniffed = sniffImage(data);
  if (sniffed !== 'application/octet-stream') return sniffed;
  const named = mimeFor(name);
  if (VISION_MIMES.has(named)) return 'application/octet-stream';
  if (named === 'application/pdf' && data.subarray(0, 1024).indexOf('%PDF-') === -1) return 'application/octet-stream';
  return named;
}

/** Pictures a model can look at. */
export const VISION_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** A file name as typed or as a model wrote it, without path parts or control characters. */
export function safeFileName(raw: string | undefined, fallback = 'file'): string {
  const cleaned = (raw ?? '')
    .replace(/[\\/]+/g, '_')
    .replace(/[\x00-\x1f\x7f"<>|:*?]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : fallback;
}

export class AiFileStorage {
  private readonly dataDir: string;
  private readonly store: AiStore;

  constructor(dataDir: string, store: AiStore) {
    this.dataDir = dataDir;
    this.store = store;
  }

  private chatDir(chatId: string): string {
    return join(this.dataDir, 'ai', 'files', chatId);
  }

  path(file: Pick<AiFileRecord, 'chatId' | 'id'>): string {
    return join(this.chatDir(file.chatId), file.id);
  }

  async save(input: { chatId: string; kind: AiFileKind; name: string; mime?: string; data: Buffer; actionId?: string | null }): Promise<AiFileRecord> {
    const name = safeFileName(input.name);
    const record = this.store.createFile({ chatId: input.chatId, actionId: input.actionId ?? null, kind: input.kind, name, mime: input.mime ?? mimeFor(name), size: input.data.length });
    try {
      await mkdir(this.chatDir(input.chatId), { recursive: true, mode: 0o700 });
      await writeFile(this.path(record), input.data, { mode: 0o600 });
    } catch (error) {
      this.store.deleteFile(record.id);
      throw error;
    }
    return record;
  }

  read(file: Pick<AiFileRecord, 'chatId' | 'id'>): Promise<Buffer> {
    return readFile(this.path(file));
  }

  async removeChat(chatId: string): Promise<void> {
    await rm(this.chatDir(chatId), { recursive: true, force: true });
  }
}
