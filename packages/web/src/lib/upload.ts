/**
 * Source uploads (Netlify Drop style): turning what a person drops or picks
 * — a folder, several files, a `.zip` — into one archive, and sending it
 * to `POST /api/applications/:id/upload` with progress.
 *
 * A folder is walked in the browser (File System Access entries from a
 * drop, `webkitRelativePath` from a directory input), packed with the
 * shared zip writer, and uploaded as a single body. Dependencies and VCS
 * metadata are left out: nobody means to upload `node_modules`.
 */
import { useCallback, useState } from 'react';
import { createZip, isApiErrorBody, LIMITS, type ApplicationDto, type DeploymentDto, type ZipFile } from '@ploy/shared';
import { ApiError } from './api.ts';

export interface PickedFile {
  /** Path inside the archive, forward slashes. */
  path: string;
  file: File;
}

export interface Picked {
  /** The zip's file name, or the folder's name. */
  name: string;
  kind: 'zip' | 'folder';
  /** Folder: the files to pack (empty for a zip). */
  files: PickedFile[];
  /** Folder: unpacked bytes; zip: the file's size. */
  size: number;
  /** Names left out (node_modules, .git, .DS_Store…), for the summary. */
  skipped: string[];
  zip: File | null;
}

export type PickProblemReason = 'empty' | 'too_many_files' | 'too_big' | 'zip_too_large';

export class PickProblem extends Error {
  readonly reason: PickProblemReason;

  constructor(reason: PickProblemReason) {
    super(reason);
    this.name = 'PickProblem';
    this.reason = reason;
  }
}

/** Folders never worth uploading: dependencies are installed by the build, VCS metadata is not source. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__MACOSX', '.cache', '.parcel-cache', '.turbo']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export const isZipName = (name: string): boolean => /\.zip$/i.test(name);

/** The name of the skipped folder or file on a path, or null when every segment is wanted. */
function skippedBy(path: string): string | null {
  const segments = path.split('/');
  for (const segment of segments.slice(0, -1)) if (SKIP_DIRS.has(segment)) return segment;
  const base = segments[segments.length - 1]!;
  return SKIP_FILES.has(base) ? base : null;
}

function folderPick(name: string, candidates: PickedFile[]): Picked {
  const skipped = new Set<string>();
  const files: PickedFile[] = [];
  let size = 0;
  for (const candidate of candidates) {
    const skip = skippedBy(candidate.path);
    if (skip !== null) {
      skipped.add(skip);
      continue;
    }
    files.push(candidate);
    size += candidate.file.size;
  }
  if (files.length === 0) throw new PickProblem('empty');
  if (files.length > LIMITS.uploadFilesMax) throw new PickProblem('too_many_files');
  if (size > LIMITS.uploadUnpackedMax) throw new PickProblem('too_big');
  return { name, kind: 'folder', files, size, skipped: [...skipped].sort(), zip: null };
}

function zipPick(file: File): Picked {
  if (file.size === 0) throw new PickProblem('empty');
  if (file.size > LIMITS.uploadMax) throw new PickProblem('zip_too_large');
  return { name: file.name, kind: 'zip', files: [], size: file.size, skipped: [], zip: file };
}

/**
 * Files from an `<input type="file">`: one `.zip`, or a directory input whose
 * files carry `webkitRelativePath` (`folder/sub/file`). The folder itself is
 * the root, as every static host treats a dropped folder.
 */
export function pickFromFileList(list: FileList | File[]): Picked {
  const files = Array.from(list);
  if (files.length === 0) throw new PickProblem('empty');
  if (files.length === 1 && isZipName(files[0]!.name) && files[0]!.webkitRelativePath.length === 0) return zipPick(files[0]!);
  const paths = files.map((file) => (file.webkitRelativePath.length > 0 ? file.webkitRelativePath : file.name).replace(/\\/g, '/'));
  const roots = new Set(paths.map((path) => path.split('/')[0]!));
  const nested = paths.every((path) => path.includes('/'));
  // One common top folder: strip it and take its name; a loose selection of files keeps their names at the root.
  const root = nested && roots.size === 1 ? [...roots][0]! : null;
  const candidates = files.map((file, index) => ({ path: root === null ? paths[index]! : paths[index]!.slice(root.length + 1), file }));
  return folderPick(root ?? 'site', candidates);
}

type Entry = FileSystemEntry;

async function readAll(directory: FileSystemDirectoryEntry): Promise<Entry[]> {
  const reader = directory.createReader();
  const out: Entry[] = [];
  for (;;) {
    const batch = await new Promise<Entry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return out;
    out.push(...batch);
  }
}

async function walk(entry: Entry, prefix: string, out: PickedFile[], skipped: Set<string>): Promise<void> {
  if (entry.isFile) {
    if (SKIP_FILES.has(entry.name)) {
      skipped.add(entry.name);
      return;
    }
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ path: `${prefix}${entry.name}`, file });
    return;
  }
  if (!entry.isDirectory) return;
  // Not walked at all: a node_modules folder may hold a hundred thousand files.
  if (SKIP_DIRS.has(entry.name)) {
    skipped.add(entry.name);
    return;
  }
  for (const child of await readAll(entry as FileSystemDirectoryEntry)) await walk(child, `${prefix}${entry.name}/`, out, skipped);
}

/**
 * What a drop holds. A single `.zip` is taken as is; a single folder is the
 * root; several items land side by side at the root.
 */
export async function pickFromDrop(transfer: DataTransfer): Promise<Picked> {
  const items = Array.from(transfer.items).filter((item) => item.kind === 'file');
  const entries = items.map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null));
  if (entries.length === 0 || entries.some((entry) => entry === null)) return pickFromFileList(transfer.files);
  const list = entries as Entry[];
  if (list.length === 1 && list[0]!.isFile && isZipName(list[0]!.name)) {
    const file = items[0]!.getAsFile();
    if (file !== null) return zipPick(file);
  }
  const files: PickedFile[] = [];
  const skipped = new Set<string>();
  if (list.length === 1 && list[0]!.isDirectory) {
    for (const child of await readAll(list[0] as FileSystemDirectoryEntry)) await walk(child, '', files, skipped);
    const picked = folderPick(list[0]!.name, files);
    return { ...picked, skipped: [...new Set([...picked.skipped, ...skipped])].sort() };
  }
  for (const entry of list) await walk(entry, '', files, skipped);
  const picked = folderPick('site', files);
  return { ...picked, skipped: [...new Set([...picked.skipped, ...skipped])].sort() };
}

/** Pack a folder pick into a zip. Progress runs over reading (first half) and compressing (second half). */
export async function packFolder(picked: Picked, onProgress: (ratio: number) => void): Promise<Blob> {
  const files: ZipFile[] = [];
  for (const [index, item] of picked.files.entries()) {
    files.push({ path: item.path, data: new Uint8Array(await item.file.arrayBuffer()), mtime: new Date(item.file.lastModified) });
    onProgress(((index + 1) / picked.files.length) * 0.5);
  }
  const chunks = await createZip(files, { onProgress: (done, total) => onProgress(0.5 + (done / total) * 0.5) });
  return new Blob(chunks as BlobPart[], { type: 'application/zip' });
}

export interface UploadResult {
  application: ApplicationDto;
  deployment: DeploymentDto | null;
}

/** Send the archive. XMLHttpRequest, because fetch reports no upload progress; cookies carry the session, the header satisfies the CSRF check. */
export function uploadArchive(applicationId: string, archive: Blob, name: string, options: { deploy?: boolean; onProgress?: (ratio: number) => void } = {}): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({ name });
    if (options.deploy === false) query.set('deploy', '0');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/applications/${applicationId}/upload?${query.toString()}`);
    xhr.setRequestHeader('X-Ploy-Request', '1');
    xhr.setRequestHeader('Content-Type', 'application/zip');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText.length > 0 ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as UploadResult);
        return;
      }
      if (isApiErrorBody(body)) {
        reject(new ApiError(body.error.code, body.error.message, xhr.status, { ...(body.error.params === undefined ? {} : { params: body.error.params }), ...(body.error.issues === undefined ? {} : { issues: body.error.issues }) }));
        return;
      }
      reject(new ApiError('internal_error', `HTTP ${xhr.status}`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('network', 'Network error', 0));
    xhr.onabort = () => reject(new ApiError('network', 'Upload cancelled', 0));
    xhr.send(archive);
  });
}

export type UploadState = { phase: 'idle' } | { phase: 'packing'; ratio: number } | { phase: 'uploading'; ratio: number } | { phase: 'done' } | { phase: 'failed'; error: unknown };

/** Pack (when needed) and upload a pick, exposing the phase and progress for the drop zone to draw. */
export function useArchiveUpload() {
  const [state, setState] = useState<UploadState>({ phase: 'idle' });
  const run = useCallback(async (applicationId: string, picked: Picked, options: { deploy?: boolean } = {}): Promise<UploadResult> => {
    try {
      let archive: Blob;
      if (picked.kind === 'zip' && picked.zip !== null) archive = picked.zip;
      else {
        setState({ phase: 'packing', ratio: 0 });
        archive = await packFolder(picked, (ratio) => setState({ phase: 'packing', ratio }));
      }
      setState({ phase: 'uploading', ratio: 0 });
      const result = await uploadArchive(applicationId, archive, picked.name, { ...options, onProgress: (ratio) => setState({ phase: 'uploading', ratio }) });
      setState({ phase: 'done' });
      return result;
    } catch (error) {
      setState({ phase: 'failed', error });
      throw error;
    }
  }, []);
  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  return { state, run, reset, busy: state.phase === 'packing' || state.phase === 'uploading' };
}
