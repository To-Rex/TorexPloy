/**
 * The file browser: buckets on the left, the chosen bucket's folders and
 * files on the right. Upload by button or drag and drop, download, copy a
 * link, make folders, delete; buckets are created, opened up or removed here too.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ChevronRight, Download, Ellipsis, File, Folder, FolderArchive, FolderPlus, Link2, Lock, LockOpen, Plus, Search, Trash2, Upload } from 'lucide-react';
import { createBucketSchema, createFolderSchema, type ServiceDto, type StorageBucketDto, type StorageOverviewDto } from '@ploy/shared';
import { writeClipboard } from '../../../components/Copy.tsx';
import { Dialog, useConfirm } from '../../../components/Dialog.tsx';
import { Menu, MenuItem, MenuSeparator } from '../../../components/Menu.tsx';
import { useToast } from '../../../components/Toast.tsx';
import { Button, Callout, Checkbox, Field, Input, Skeleton } from '../../../components/ui.tsx';
import { useI18n } from '../../../i18n/index.tsx';
import { api } from '../../../lib/api.ts';
import { fieldErrors } from '../../../lib/errors.ts';
import { useAction } from '../../../lib/mutate.ts';
import { keys, useBuckets, useObjects, useStorageOverview } from '../../../lib/queries.ts';
import { validate } from '../../../lib/validate.ts';

const encodeKey = (key: string): string => key.split('/').map(encodeURIComponent).join('/');

interface UploadItem {
  name: string;
  progress: number;
  state: 'waiting' | 'uploading' | 'done' | 'failed';
}

/** One PUT per file, with progress; cookies carry the session, the header satisfies the CSRF check. */
function uploadFile(serviceId: string, bucket: string, key: string, file: File, onProgress: (ratio: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/services/${serviceId}/storage/buckets/${encodeURIComponent(bucket)}/objects/${encodeKey(key)}`);
    xhr.setRequestHeader('X-Ploy-Request', '1');
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('network'));
    xhr.send(file);
  });
}

function NewBucketDialog({ service, open, onClose }: { service: ServiceDto; open: boolean; onClose: () => void }) {
  const { m } = useI18n();
  const f = m.fileStore;
  const [name, setName] = useState('');
  const [isPublic, setPublic] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const close = () => {
    setName('');
    setPublic(false);
    setErrors({});
    onClose();
  };
  const create = useAction((input: { name: string; public: boolean }) => api.post(`/api/services/${service.id}/storage/buckets`, input), {
    success: f.bucketCreated,
    invalidate: [keys.servicePart(service.id, 'storage', 'buckets'), keys.servicePart(service.id, 'storage')],
    inlineValidation: true,
    onSuccess: close,
  });
  return (
    <Dialog
      open={open}
      onClose={close}
      title={f.newBucket}
      onSubmit={() => {
        const payload = { name: name.trim().toLowerCase(), public: isPublic };
        const result = validate(m, createBucketSchema, payload);
        if (result.errors !== null) return setErrors(result.errors);
        setErrors({});
        create.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
      }}
      footer={
        <>
          <Button onClick={close}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" busy={create.isPending}>
            {m.common.create}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={f.bucketName} hint={f.bucketNameHint} error={errors.name}>
          <Input mono value={name} onChange={(event) => setName(event.target.value)} placeholder="uploads" spellCheck={false} data-autofocus />
        </Field>
        <Checkbox checked={isPublic} onChange={setPublic} label={f.publicBucket} hint={f.publicBucketHint} />
      </div>
    </Dialog>
  );
}

function Buckets({ service, buckets, current, onPick }: { service: ServiceDto; buckets: StorageBucketDto[]; current: string | null; onPick: (name: string | null) => void }) {
  const { m, t } = useI18n();
  const f = m.fileStore;
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const invalidate = [keys.servicePart(service.id, 'storage', 'buckets'), keys.servicePart(service.id, 'storage')];
  const toggle = useAction((input: { name: string; public: boolean }) => api.patch(`/api/services/${service.id}/storage/buckets/${encodeURIComponent(input.name)}`, { public: input.public }), { invalidate });
  const remove = useAction((input: { name: string; force: boolean }) => api.delete(`/api/services/${service.id}/storage/buckets/${encodeURIComponent(input.name)}${input.force ? '?force=true' : ''}`), {
    success: f.bucketDeleted,
    invalidate,
    onSuccess: () => onPick(null),
  });
  return (
    <aside className="files__side">
      <div className="files__side-head">
        <span>{f.bucketsTitle}</span>
        <Button size="sm" variant="ghost" iconOnly icon={<Plus />} onClick={() => setCreating(true)}>
          {f.newBucket}
        </Button>
      </div>
      <div className="files__buckets">
        {buckets.length === 0 ? (
          <p className="field__hint" style={{ padding: '0 8px 8px' }}>{f.noBucketsHint}</p>
        ) : (
          buckets.map((bucket) => (
            <div key={bucket.name} className="bucket" aria-current={bucket.name === current || undefined}>
              <button type="button" className="bucket__pick" onClick={() => onPick(bucket.name)}>
                {bucket.public ? <LockOpen aria-hidden="true" /> : <Lock aria-hidden="true" />}
                <span className="bucket__name">{bucket.name}</span>
                {bucket.public && <span className="bucket__tag">{f.publicBadge}</span>}
              </button>
              <Menu trigger={(props) => <Button {...props} size="sm" variant="ghost" iconOnly icon={<Ellipsis />}>{m.common.actions}</Button>}>
                <MenuItem icon={bucket.public ? <Lock /> : <LockOpen />} onSelect={() => toggle.mutate({ name: bucket.name, public: !bucket.public })}>
                  {bucket.public ? f.makePrivate : f.makePublic}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  icon={<Trash2 />}
                  danger
                  onSelect={async () => {
                    const result = await confirm({ title: f.deleteBucketTitle, text: t(f.deleteBucketText, { name: bucket.name }), confirmLabel: m.common.delete, danger: true, typeToConfirm: bucket.name, checkbox: { label: f.deleteBucketForce } });
                    if (result.confirmed) remove.mutate({ name: bucket.name, force: result.checked });
                  }}
                >
                  {m.common.delete}
                </MenuItem>
              </Menu>
            </div>
          ))
        )}
      </div>
      <NewBucketDialog service={service} open={creating} onClose={() => setCreating(false)} />
    </aside>
  );
}

function Objects({ service, bucket, overview }: { service: ServiceDto; bucket: StorageBucketDto; overview: StorageOverviewDto | undefined }) {
  const { m, t, plural, formatBytes, formatDate } = useI18n();
  const f = m.fileStore;
  const toast = useToast();
  const confirm = useConfirm();
  const [prefix, setPrefix] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [folderDialog, setFolderDialog] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderError, setFolderError] = useState<string | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);
  const listing = useObjects(service.id, bucket.name, prefix);
  const listKey = keys.servicePart(service.id, 'storage', 'objects', bucket.name, prefix);
  useEffect(() => {
    setPrefix('');
    setSelected(new Set());
    setQuery('');
  }, [bucket.name]);
  useEffect(() => setSelected(new Set()), [prefix]);

  const pages = listing.data?.pages ?? [];
  const folders = useMemo(() => [...new Set(pages.flatMap((page) => page.folders))], [pages]);
  const objects = useMemo(() => pages.flatMap((page) => page.objects).filter((object) => object.key !== prefix), [pages, prefix]);
  const needle = query.trim().toLowerCase();
  const shownFolders = folders.filter((folder) => needle.length === 0 || folder.toLowerCase().includes(needle));
  const shownObjects = objects.filter((object) => needle.length === 0 || object.name.toLowerCase().includes(needle));
  const crumbs = prefix.split('/').filter(Boolean);

  const remove = useAction((list: string[]) => api.post<{ deleted: number }>(`/api/services/${service.id}/storage/buckets/${encodeURIComponent(bucket.name)}/delete`, { keys: list }), {
    success: (result) => plural(f.deleted, result.deleted),
    invalidate: [listKey, keys.servicePart(service.id, 'storage', 'buckets')],
    onSuccess: () => setSelected(new Set()),
  });
  const makeFolder = useAction((folderPrefix: string) => api.post(`/api/services/${service.id}/storage/buckets/${encodeURIComponent(bucket.name)}/folders`, { prefix: folderPrefix }), {
    success: f.folderCreated,
    invalidate: [listKey],
    onSuccess: () => {
      setFolderDialog(false);
      setFolderName('');
    },
  });

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploads(list.map((file) => ({ name: file.name, progress: 0, state: 'waiting' })));
    let done = 0;
    for (const [index, file] of list.entries()) {
      setUploads((current) => current.map((item, at) => (at === index ? { ...item, state: 'uploading' } : item)));
      try {
        await uploadFile(service.id, bucket.name, `${prefix}${file.name}`, file, (ratio) => setUploads((current) => current.map((item, at) => (at === index ? { ...item, progress: ratio } : item))));
        done += 1;
        setUploads((current) => current.map((item, at) => (at === index ? { ...item, progress: 1, state: 'done' } : item)));
      } catch {
        setUploads((current) => current.map((item, at) => (at === index ? { ...item, state: 'failed' } : item)));
        toast.failure(t(f.uploadFailed, { name: file.name }));
      }
    }
    if (done > 0) toast.success(plural(f.uploaded, done));
    await listing.refetch();
    window.setTimeout(() => setUploads([]), 2_500);
  };

  const copyLink = async (key: string) => {
    if (bucket.public && overview?.endpoint != null) {
      if (await writeClipboard(`${overview.endpoint}/${encodeURIComponent(bucket.name)}/${encodeKey(key)}`)) toast.success(f.publicLinkCopied);
      return;
    }
    if (overview?.endpoint == null) {
      toast.failure(f.linkNeedsEndpoint);
      return;
    }
    try {
      const { url } = await api.post<{ url: string }>(`/api/services/${service.id}/storage/buckets/${encodeURIComponent(bucket.name)}/presign`, { key, method: 'get', expiresIn: 3600 });
      if (await writeClipboard(url)) toast.success(f.linkCopied);
    } catch (error) {
      toast.error(error);
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void upload(event.dataTransfer.files);
  };
  const toggleSelected = (key: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allKeys = [...shownFolders, ...shownObjects.map((object) => object.key)];
  const allSelected = allKeys.length > 0 && allKeys.every((key) => selected.has(key));
  const downloadHref = (key: string) => `/api/services/${service.id}/storage/buckets/${encodeURIComponent(bucket.name)}/objects/${encodeKey(key)}?download=1`;

  return (
    <section
      className="files__pane"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {dragging && <div className="files__drop">{f.dropHint}</div>}
      <div className="files__bar">
        <nav className="crumbs--files" aria-label={bucket.name}>
          <button type="button" aria-current={crumbs.length === 0 ? 'page' : undefined} onClick={() => setPrefix('')}>
            {bucket.name}
          </button>
          {crumbs.map((part, index) => {
            const target = `${crumbs.slice(0, index + 1).join('/')}/`;
            return (
              <span key={target} className="row" style={{ gap: 4 }}>
                <ChevronRight aria-hidden="true" />
                <button type="button" aria-current={index === crumbs.length - 1 ? 'page' : undefined} onClick={() => setPrefix(target)}>
                  {part}
                </button>
              </span>
            );
          })}
        </nav>
        <span className="toolbar__spacer" />
        <label className="toolbar__search" style={{ flex: '0 1 200px' }}>
          <Search aria-hidden="true" />
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={f.search} aria-label={f.search} />
        </label>
        {selected.size > 0 && (
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 />}
            busy={remove.isPending}
            onClick={async () => {
              const result = await confirm({ title: f.deleteTitle, text: plural(f.deleteText, selected.size), confirmLabel: m.common.delete, danger: true });
              if (result.confirmed) remove.mutate([...selected]);
            }}
          >
            {plural(f.selected, selected.size)}
          </Button>
        )}
        <Button size="sm" icon={<FolderPlus />} onClick={() => setFolderDialog(true)}>
          {f.newFolder}
        </Button>
        <Button size="sm" variant="primary" icon={<Upload />} onClick={() => fileInput.current?.click()}>
          {f.upload}
        </Button>
        <input ref={fileInput} type="file" multiple hidden onChange={(event) => { if (event.target.files !== null) void upload(event.target.files); event.target.value = ''; }} />
      </div>

      {listing.isPending ? (
        <div style={{ padding: 16 }}>
          <Skeleton height={160} />
        </div>
      ) : listing.isError ? (
        <div style={{ padding: 16 }}>
          <Callout tone="bad">{m.errors.codes.storage_unavailable}</Callout>
        </div>
      ) : shownFolders.length === 0 && shownObjects.length === 0 ? (
        <div className="files__empty">
          <FolderArchive aria-hidden="true" />
          <strong>{needle.length > 0 ? m.palette.noResults : f.empty}</strong>
          {needle.length === 0 && <span>{f.emptyHint}</span>}
        </div>
      ) : (
        <div style={{ overflow: 'auto' }}>
          <table className="files__table">
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(allKeys))} aria-label={m.common.actions} />
                </th>
                <th>{f.columns.name}</th>
                <th className="num">{f.columns.size}</th>
                <th className="num">{f.columns.modified}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shownFolders.map((folder) => {
                const name = folder.slice(prefix.length).replace(/\/$/, '');
                return (
                  <tr key={folder} aria-selected={selected.has(folder) || undefined}>
                    <td>
                      <input type="checkbox" checked={selected.has(folder)} onChange={() => toggleSelected(folder)} aria-label={name} />
                    </td>
                    <td>
                      <span className="files__name">
                        <Folder aria-hidden="true" />
                        <button type="button" onClick={() => setPrefix(folder)}>
                          {name}
                        </button>
                      </span>
                    </td>
                    <td className="num">—</td>
                    <td className="num">{f.folder}</td>
                    <td>
                      <span className="files__row-actions">
                        <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={async () => {
                          const result = await confirm({ title: f.deleteTitle, text: plural(f.deleteText, 1), confirmLabel: m.common.delete, danger: true });
                          if (result.confirmed) remove.mutate([folder]);
                        }}>
                          {m.common.delete}
                        </Button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {shownObjects.map((object) => (
                <tr key={object.key} aria-selected={selected.has(object.key) || undefined}>
                  <td>
                    <input type="checkbox" checked={selected.has(object.key)} onChange={() => toggleSelected(object.key)} aria-label={object.name} />
                  </td>
                  <td>
                    <span className="files__name">
                      <File aria-hidden="true" />
                      <a href={downloadHref(object.key)} className="truncate" style={{ color: 'inherit', fontWeight: 500 }} title={object.key}>
                        {object.name}
                      </a>
                    </span>
                  </td>
                  <td className="num">{formatBytes(object.size)}</td>
                  <td className="num">{formatDate(object.lastModified, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                  <td>
                    <span className="files__row-actions">
                      <Button size="sm" variant="ghost" iconOnly icon={<Link2 />} onClick={() => void copyLink(object.key)}>
                        {f.copyLink}
                      </Button>
                      <a className="btn btn--ghost btn--sm btn--icon" href={downloadHref(object.key)} title={f.download} style={{ textDecoration: 'none' }}>
                        <Download aria-hidden="true" />
                        <span className="sr-only">{f.download}</span>
                      </a>
                      <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={async () => {
                        const result = await confirm({ title: f.deleteTitle, text: plural(f.deleteText, 1), confirmLabel: m.common.delete, danger: true });
                        if (result.confirmed) remove.mutate([object.key]);
                      }}>
                        {m.common.delete}
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {listing.hasNextPage && (
            <div style={{ padding: 12 }}>
              <Button size="sm" busy={listing.isFetchingNextPage} onClick={() => void listing.fetchNextPage()}>
                {f.loadMore}
              </Button>
            </div>
          )}
        </div>
      )}

      {uploads.length > 0 && (
        <div className="files__uploads" aria-live="polite">
          <strong>{t(f.uploading, { done: uploads.filter((item) => item.state === 'done').length, total: uploads.length })}</strong>
          {uploads.map((item, index) => (
            <div key={`${item.name}-${index}`} className="files__upload">
              <span className="truncate">{item.name}</span>
              <span className="meter" style={{ ['--meter' as string]: item.state === 'failed' ? 'var(--bad)' : 'var(--ok)' }}>
                <span style={{ width: `${Math.round(item.progress * 100)}%` }} />
              </span>
              <span className="num faint">{item.state === 'failed' ? '✗' : `${Math.round(item.progress * 100)}%`}</span>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={folderDialog}
        onClose={() => setFolderDialog(false)}
        title={f.newFolder}
        onSubmit={() => {
          const payload = { prefix: `${prefix}${folderName.trim().replace(/\/+$/, '')}/` };
          const result = validate(m, createFolderSchema, payload);
          if (result.errors !== null) return setFolderError(result.errors.prefix);
          setFolderError(undefined);
          makeFolder.mutate(payload.prefix);
        }}
        footer={
          <>
            <Button onClick={() => setFolderDialog(false)}>{m.common.cancel}</Button>
            <Button type="submit" variant="primary" busy={makeFolder.isPending}>
              {m.common.create}
            </Button>
          </>
        }
      >
        <Field label={f.folderName} error={folderError}>
          <Input mono value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="2026" spellCheck={false} data-autofocus />
        </Field>
      </Dialog>
    </section>
  );
}

export function StorageFilesTab({ service }: { service: ServiceDto }) {
  const { m } = useI18n();
  const f = m.fileStore;
  const buckets = useBuckets(service.id);
  const overview = useStorageOverview(service.id);
  const [current, setCurrent] = useState<string | null>(null);
  const list = buckets.data ?? [];
  const chosen = list.find((bucket) => bucket.name === current) ?? list[0];
  if (buckets.isError) return <Callout tone="bad">{m.errors.codes.storage_unavailable}</Callout>;
  return (
    <div className="files">
      {buckets.isPending ? (
        <div style={{ padding: 16 }}>
          <Skeleton height={200} />
        </div>
      ) : (
        <Buckets service={service} buckets={list} current={chosen?.name ?? null} onPick={setCurrent} />
      )}
      {chosen === undefined ? (
        <div className="files__empty">
          <FolderArchive aria-hidden="true" />
          <strong>{f.noBuckets}</strong>
          <span>{f.noBucketsHint}</span>
        </div>
      ) : (
        <Objects service={service} bucket={chosen} overview={overview.data} />
      )}
    </div>
  );
}
