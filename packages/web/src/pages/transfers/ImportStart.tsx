/**
 * Start an import: the archive comes as a file from this computer, from
 * another panel through its transfer link, or from an S3 destination. Once it
 * is here, its own page asks for the passphrase and how to put it in place.
 */
import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CloudDownload, FileArchive, Link2, Upload } from 'lucide-react';
import { isApiErrorBody, TRANSFER_EXTENSION, type TransferDto, type TransferS3ObjectDto } from '@ploy/shared';
import { Frame } from '../../components/Frame.tsx';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Button, Callout, EmptyState, Field, Input, Select, SkeletonRows } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { errorText } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useS3Destinations } from '../../lib/queries.ts';
import { Meter } from './parts.tsx';

type Source = 'file' | 'link' | 's3';

/** Send the archive with upload progress (fetch reports none); the session cookie and the CSRF header go along. */
function uploadArchive(file: File, onProgress: (ratio: number) => void): Promise<TransferDto> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/transfers/import/upload?${new URLSearchParams({ name: file.name }).toString()}`);
    xhr.setRequestHeader('X-Ploy-Request', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText.length > 0 ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body as TransferDto);
      if (isApiErrorBody(body)) return reject(new ApiError(body.error.code, body.error.message, xhr.status, { ...(body.error.params === undefined ? {} : { params: body.error.params }) }));
      reject(new ApiError('internal_error', `HTTP ${xhr.status}`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('network', 'Network error', 0));
    xhr.send(file);
  });
}

function FileSource() {
  const { m, t, formatBytes } = useI18n();
  const s = m.transfers.start;
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [ratio, setRatio] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const pick = (picked: File | undefined) => {
    setFailure(null);
    if (picked === undefined) return;
    if (!picked.name.toLowerCase().endsWith(TRANSFER_EXTENSION)) {
      setFailure(t(s.notArchive, { extension: TRANSFER_EXTENSION }));
      return;
    }
    setFile(picked);
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    pick(event.dataTransfer.files[0]);
  };
  const send = async () => {
    if (file === null) return;
    setFailure(null);
    setRatio(0);
    try {
      const transfer = await uploadArchive(file, setRatio);
      void navigate(`/transfers/${transfer.id}`);
    } catch (error) {
      setRatio(null);
      setFailure(errorText(m, error));
    }
  };

  return (
    <div className="stack">
      <div
        className="file-drop"
        data-over={over || undefined}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        <FileArchive aria-hidden="true" />
        {file === null ? (
          <>
            <span>{t(s.dropHint, { extension: TRANSFER_EXTENSION })}</span>
            <Button size="sm" onClick={() => input.current?.click()}>
              {s.choose}
            </Button>
          </>
        ) : (
          <>
            <strong>{file.name}</strong>
            <span className="faint">{formatBytes(file.size)}</span>
            {ratio === null && (
              <Button size="sm" onClick={() => setFile(null)}>
                {s.another}
              </Button>
            )}
          </>
        )}
        <input ref={input} type="file" accept={TRANSFER_EXTENSION} hidden onChange={(event) => pick(event.target.files?.[0])} />
      </div>
      {ratio !== null && (
        <div className="transfer-progress">
          <div className="transfer-progress__line">
            <span>{s.uploading}</span>
            <span className="faint">{Math.round(ratio * 100)}%</span>
          </div>
          <Meter value={ratio * 100} />
        </div>
      )}
      {failure !== null && <Callout tone="bad">{failure}</Callout>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="primary" icon={<Upload />} disabled={file === null} busy={ratio !== null} onClick={() => void send()}>
          {s.upload}
        </Button>
      </div>
    </div>
  );
}

function LinkSource() {
  const { m } = useI18n();
  const s = m.transfers.start;
  const navigate = useNavigate();
  const [link, setLink] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const carries = link.includes('#');
  const start = useAction((input: { link: string; passphrase?: string }) => api.post<TransferDto>('/api/transfers/import/link', input), {
    invalidate: [keys.transfers],
    onSuccess: (transfer) => void navigate(`/transfers/${transfer.id}`),
  });
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        start.mutate({ link: link.trim(), ...(passphrase.length > 0 ? { passphrase } : {}) });
      }}
    >
      <Field label={s.link} hint={s.linkHint}>
        <Input value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://panel.example.com/api/transfers/pull/…#…" spellCheck={false} autoComplete="off" mono />
      </Field>
      {!carries && link.length > 0 && (
        <Field label={m.transfers.passphrase} optional={m.common.optional} hint={s.linkPassphraseHint}>
          <Input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="off" />
        </Field>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button type="submit" variant="primary" icon={<CloudDownload />} disabled={link.trim().length < 10} busy={start.isPending}>
          {s.fetch}
        </Button>
      </div>
    </form>
  );
}

function S3Source() {
  const { m, formatBytes } = useI18n();
  const s = m.transfers.start;
  const navigate = useNavigate();
  const destinations = useS3Destinations();
  const [destinationId, setDestinationId] = useState('');
  const chosen = destinationId || destinations.data?.[0]?.id || '';
  const objects = useQuery({ queryKey: ['transfer-s3', chosen], queryFn: () => api.get<TransferS3ObjectDto[]>(`/api/transfers/s3/${chosen}`), enabled: chosen !== '', retry: false });
  const [key, setKey] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const start = useAction((input: { destinationId: string; key: string; passphrase?: string }) => api.post<TransferDto>('/api/transfers/import/s3', input), {
    invalidate: [keys.transfers],
    onSuccess: (transfer) => void navigate(`/transfers/${transfer.id}`),
  });

  if (destinations.isPending) return <SkeletonRows rows={2} />;
  if ((destinations.data ?? []).length === 0) return <Callout tone="idle">{s.noDestinations}</Callout>;
  return (
    <div className="stack">
      <Field label={s.destination}>
        <Select
          value={chosen}
          onChange={(event) => {
            setDestinationId(event.target.value);
            setKey(null);
          }}
        >
          {destinations.data!.map((destination) => (
            <option key={destination.id} value={destination.id}>
              {destination.name}
            </option>
          ))}
        </Select>
      </Field>
      {objects.isPending ? (
        <SkeletonRows rows={2} />
      ) : objects.isError ? (
        <Callout tone="bad">{errorText(m, objects.error)}</Callout>
      ) : (objects.data ?? []).length === 0 ? (
        <EmptyState icon={<FileArchive />}>{s.noArchives}</EmptyState>
      ) : (
        <div className="list">
          {objects.data!.map((object) => (
            <button key={object.key} type="button" className="list__row" aria-pressed={key === object.key} onClick={() => setKey(object.key)} style={key === object.key ? { background: 'var(--surface-hover)' } : undefined}>
              <span className="kind-mark" aria-hidden="true">
                <FileArchive />
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="list__title truncate">{object.key.split('/').pop()}</div>
                <div className="list__meta">
                  <span>{formatBytes(object.size)}</span>
                  {object.lastModified !== null && <RelativeTime value={object.lastModified} />}
                  <code className="truncate">{object.key}</code>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {key !== null && (
        <Field label={m.transfers.passphrase} optional={m.common.optional} hint={s.s3PassphraseHint}>
          <Input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="off" />
        </Field>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="primary" icon={<CloudDownload />} disabled={key === null} busy={start.isPending} onClick={() => key !== null && start.mutate({ destinationId: chosen, key, ...(passphrase.length > 0 ? { passphrase } : {}) })}>
          {s.fetch}
        </Button>
      </div>
    </div>
  );
}

export function ImportStartPage() {
  const { m } = useI18n();
  const s = m.transfers.start;
  usePageMeta([{ label: m.transfers.title, to: '/transfers' }, { label: m.transfers.import }]);
  const [source, setSource] = useState<Source>('file');
  const options: { value: Source; icon: ReactNode; title: string; hint: string }[] = [
    { value: 'file', icon: <FileArchive />, title: s.fromFile, hint: s.fromFileHint },
    { value: 'link', icon: <Link2 />, title: s.fromLink, hint: s.fromLinkHint },
    { value: 's3', icon: <CloudDownload />, title: s.fromS3, hint: s.fromS3Hint },
  ];
  return (
    <div className="page">
      <Frame icon={<CloudDownload />} title={s.title} description={s.subtitle}>
        <div className="stack" style={{ gap: 20 }}>
          <div className="import-sources" role="group" aria-label={s.title}>
            {options.map((option) => (
              <button key={option.value} type="button" className="import-source" aria-pressed={source === option.value} onClick={() => setSource(option.value)}>
                {option.icon}
                <strong>{option.title}</strong>
                <span>{option.hint}</span>
              </button>
            ))}
          </div>
          {source === 'file' ? <FileSource /> : source === 'link' ? <LinkSource /> : <S3Source />}
          <Callout tone="info">{s.next}</Callout>
        </div>
      </Frame>
    </div>
  );
}
