/**
 * One export or import, from start to finish.
 *
 * An export shows its progress, then the archive: its passphrase (once, right
 * after it was started, and to administrators on request), the download,
 * the transfer link another panel imports it through, and a copy to S3.
 *
 * An import shows its archive arriving, asks for the passphrase, and lays out
 * what it holds against this panel: the server it lands on, the project's
 * name, where each application's code comes from, and what clashes (a domain
 * served here already, a port in use). Then its progress, step by step, and
 * what is left to do by hand.
 */
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, CloudUpload, Download, Ellipsis, ExternalLink, FolderOpen, KeyRound, Link2, LockOpen, Play, RotateCcw, Square, Trash2, Unlink } from 'lucide-react';
import type { ImportAnalysisDto, ImportPlanInput, ImportSourceChoice, TransferDto, TransferShareDto } from '@ploy/shared';
import { CopyButton } from '../../components/Copy.tsx';
import { useConfirm } from '../../components/Dialog.tsx';
import { Card, Frame } from '../../components/Frame.tsx';
import { AppMark, ServiceMark } from '../../components/KindMark.tsx';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu.tsx';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Badge, Button, Callout, Field, Input, Select, Skeleton, SkeletonRows, Switch } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api, ApiError, qs } from '../../lib/api.ts';
import { errorText } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useS3Destinations, useTransfer } from '../../lib/queries.ts';
import { NotFound } from '../../app/RouteError.tsx';
import { TransferNotes, TransferProgress, TransferStatusBadge, TransferSteps, useNoteText } from './parts.tsx';

function Secret({ value, link = false }: { value: string; link?: boolean }) {
  return (
    <div className={link ? 'transfer-secret transfer-secret--link' : 'transfer-secret'}>
      <code>{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

/** The passphrase: shown once after the export started, and to administrators when they ask. */
function PassphraseCard({ transfer, fresh }: { transfer: TransferDto; fresh: string | null }) {
  const { m } = useI18n();
  const d = m.transfers.detail;
  const [shown, setShown] = useState<string | null>(fresh);
  const reveal = useAction(() => api.get<{ passphrase: string }>(`/api/transfers/${transfer.id}/passphrase`), { onSuccess: (result) => setShown(result.passphrase) });
  return (
    <Card icon={<KeyRound />} title={d.passphraseTitle} description={fresh !== null ? d.passphraseFresh : d.passphraseText}>
      {shown !== null ? (
        <Secret value={shown} />
      ) : (
        <div>
          <Button icon={<KeyRound />} busy={reveal.isPending} onClick={() => reveal.mutate()}>
            {d.showPassphrase}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** The transfer link: made on request (it carries the passphrase after #), withdrawn at any time. */
function ShareCard({ transfer }: { transfer: TransferDto }) {
  const { m, t, formatDate } = useI18n();
  const d = m.transfers.detail;
  const [made, setMade] = useState<TransferShareDto | null>(null);
  const share = useAction(() => api.post<TransferShareDto>(`/api/transfers/${transfer.id}/share`), { invalidate: [keys.transfers], onSuccess: setMade });
  const unshare = useAction(() => api.delete(`/api/transfers/${transfer.id}/share`), {
    invalidate: [keys.transfers],
    success: d.linkWithdrawn,
    onSuccess: () => setMade(null),
  });
  const active = transfer.share;
  return (
    <Card icon={<Link2 />} title={d.linkTitle} description={d.linkText}>
      <div className="stack" style={{ gap: 12 }}>
        {made !== null && active !== null && (
          <>
            <Secret value={made.link} link />
            <p className="faint" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
              {d.linkOnce}
            </p>
          </>
        )}
        {active !== null && (
          <div className="row" style={{ gap: 12, flexWrap: 'wrap', fontSize: 'var(--text-sm)' }}>
            <Badge tone="ok">{d.linkActive}</Badge>
            <span className="faint">{t(d.linkExpires, { time: formatDate(active.expiresAt) })}</span>
            <span className="faint">{t(d.linkDownloads, { count: active.downloads })}</span>
          </div>
        )}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Button icon={<Link2 />} busy={share.isPending} onClick={() => share.mutate()}>
            {active === null ? d.linkCreate : d.linkRenew}
          </Button>
          {active !== null && (
            <Button icon={<Unlink />} busy={unshare.isPending} onClick={() => unshare.mutate()}>
              {d.linkWithdraw}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function S3Card({ transfer }: { transfer: TransferDto }) {
  const { m } = useI18n();
  const d = m.transfers.detail;
  const destinations = useS3Destinations();
  const [destinationId, setDestinationId] = useState('');
  const copy = useAction((id: string) => api.post(`/api/transfers/${transfer.id}/s3`, { destinationId: id }), { invalidate: [keys.transfers], success: d.s3Started });
  const chosen = destinationId || destinations.data?.[0]?.id || '';
  const state = transfer.s3;
  if ((destinations.data ?? []).length === 0 && state === null) return null;
  return (
    <Card icon={<CloudUpload />} title={d.s3Title} description={d.s3Text}>
      <div className="stack" style={{ gap: 12 }}>
        {state !== null && (
          <Callout tone={state.status === 'done' ? 'ok' : state.status === 'failed' ? 'bad' : 'work'}>
            {state.status === 'done' ? (
              <>
                {d.s3Done} <code>{state.destinationName}</code> · <code>{state.key}</code>
              </>
            ) : state.status === 'failed' ? (
              `${d.s3Failed} ${state.error ?? ''}`
            ) : (
              d.s3Uploading
            )}
          </Callout>
        )}
        {(destinations.data ?? []).length > 0 && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Select value={chosen} onChange={(event) => setDestinationId(event.target.value)} aria-label={d.s3Title} style={{ maxWidth: 280 }}>
              {destinations.data!.map((destination) => (
                <option key={destination.id} value={destination.id}>
                  {destination.name}
                </option>
              ))}
            </Select>
            <Button icon={<CloudUpload />} busy={copy.isPending} disabled={state?.status === 'uploading'} onClick={() => copy.mutate(chosen)}>
              {d.s3Copy}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function UnlockCard({ transfer }: { transfer: TransferDto }) {
  const { m } = useI18n();
  const u = m.transfers.unlock;
  const client = useQueryClient();
  const [passphrase, setPassphrase] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const unlock = useAction((value: string) => api.post<ImportAnalysisDto>(`/api/transfers/${transfer.id}/unlock`, { passphrase: value }), {
    inlineErrors: true,
    onSuccess: (analysis) => {
      client.setQueryData(keys.transferAnalysis(transfer.id, null), analysis);
      void client.invalidateQueries({ queryKey: keys.transfers });
    },
  });
  return (
    <Card icon={<LockOpen />} title={u.title} description={u.text}>
      <form
        className="stack"
        style={{ gap: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          setFailure(null);
          unlock.mutate(passphrase, {
            onError: (error) => {
              const reason = error instanceof ApiError ? error.params.reason : undefined;
              setFailure(reason === 'wrong_passphrase' ? u.wrong : reason === 'too_many_tries' ? u.tooMany : errorText(m, error));
            },
          });
        }}
      >
        <Field label={m.transfers.passphrase} error={failure ?? undefined}>
          <Input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="off" autoFocus />
        </Field>
        <div>
          <Button type="submit" variant="primary" icon={<LockOpen />} disabled={passphrase.length === 0} busy={unlock.isPending}>
            {u.submit}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ImportPlanner({ transfer }: { transfer: TransferDto }) {
  const { m, t, plural, formatBytes, formatDate } = useI18n();
  const p = m.transfers.plan;
  const noteText = useNoteText();
  const [serverId, setServerId] = useState<string | null>(null);
  const analysis = useQuery({
    queryKey: keys.transferAnalysis(transfer.id, serverId),
    queryFn: () => api.get<ImportAnalysisDto>(`/api/transfers/${transfer.id}/analysis${qs({ serverId })}`),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const [name, setName] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, ImportSourceChoice>>({});
  const [options, setOptions] = useState({ restoreData: true, domains: true, publicPorts: true, deploy: true });
  const start = useAction((plan: ImportPlanInput) => api.post<TransferDto>(`/api/transfers/${transfer.id}/start`, plan), { invalidate: [keys.transfers], success: m.transfers.importStarted });

  if (analysis.isPending) return <SkeletonRows rows={5} />;
  if (analysis.isError) return <Callout tone="bad">{errorText(m, analysis.error)}</Callout>;
  const data = analysis.data;
  const server = serverId ?? data.serverId;
  const projectName = name ?? data.suggestedName;
  const sourceLabel = (choice: ImportSourceChoice, app: ImportAnalysisDto['applications'][number]): string =>
    choice === 'repository'
      ? t(p.fromRepository, { account: app.repositoryAccess?.account ?? app.repositoryAccess?.provider ?? '' })
      : choice === 'archive'
        ? app.archiveBytes === null
          ? p.fromArchive
          : `${p.fromArchive} · ${formatBytes(app.archiveBytes)}`
        : p.fromImage;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card icon={<FolderOpen />} title={p.title} description={t(p.archiveFrom, { time: formatDate(data.createdAt), version: data.panelVersion, origin: data.origin ?? p.unknownOrigin })}>
        <div className="transfer-grid">
          <Field label={p.server} hint={p.serverHint}>
            <Select value={server ?? ''} onChange={(event) => setServerId(event.target.value)}>
              {data.servers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.host === null ? '' : ` · ${item.host}`} · {m.status.server[item.status]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={p.name}>
            <Input value={projectName} onChange={(event) => setName(event.target.value)} />
          </Field>
        </div>
      </Card>

      {data.services.length > 0 && (
        <Card title={p.services} flush>
          <div>
            {data.services.map((service) => (
              <div key={service.id} className="plan-row">
                <div className="plan-row__head">
                  <ServiceMark type={service.type} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="plan-row__title">{service.name}</div>
                    <div className="plan-row__meta">
                      <span>{service.type === 'files' ? m.project.databaseLabel.files : `${m.project.databaseLabel[service.type]} ${service.version}`}</span>
                      {service.buckets > 0 && <span>{plural(p.buckets, service.buckets)}</span>}
                      {service.keys > 0 && <span>{plural(p.keys, service.keys)}</span>}
                    </div>
                  </div>
                  {service.data !== null ? <Badge tone="ok">{p.data[service.data]}</Badge> : <Badge>{p.noData}</Badge>}
                  {service.publicPort !== null && <Badge tone={service.portTaken ? 'bad' : 'work'}>{service.portTaken ? t(p.portTaken, { port: service.publicPort }) : t(p.port, { port: service.publicPort })}</Badge>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {data.applications.length > 0 && (
        <Card title={p.applications} flush>
          <div>
            {data.applications.map((app) => {
              const choice = sources[app.id] ?? app.sources[0] ?? null;
              return (
                <div key={app.id} className="plan-row">
                  <div className="plan-row__head">
                    <AppMark kind={app.kind} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="plan-row__title">{app.name}</div>
                      <div className="plan-row__meta">
                        {app.repository !== null && (
                          <span>
                            {app.repository}
                            {app.branch !== null && ` · ${app.branch}`}
                            {app.commit !== null && ` · ${app.commit.slice(0, 7)}`}
                          </span>
                        )}
                        {app.image !== null && <span>{app.image}</span>}
                        {app.variables > 0 && <span>{plural(p.variables, app.variables)}</span>}
                        {app.volumes > 0 && <span>{plural(p.volumes, app.volumes)}</span>}
                        {app.cron > 0 && <span>{plural(p.cron, app.cron)}</span>}
                        {app.links.length > 0 && <span>{t(p.links, { names: app.links.join(', ') })}</span>}
                      </div>
                    </div>
                  </div>
                  {app.sources.length > 1 ? (
                    <div className="segmented" role="group" aria-label={p.codeFrom}>
                      {app.sources.map((option) => (
                        <button key={option} type="button" aria-pressed={choice === option} onClick={() => setSources((current) => ({ ...current, [app.id]: option }))}>
                          {sourceLabel(option, app)}
                        </button>
                      ))}
                    </div>
                  ) : app.sources.length === 1 ? (
                    <span className="faint" style={{ fontSize: 'var(--text-sm)' }}>
                      {p.codeFrom}: {sourceLabel(app.sources[0]!, app)}
                    </span>
                  ) : app.sourceType === 'image' || app.sourceType === 'raw' ? null : (
                    <Callout tone="work">{p.noCode}</Callout>
                  )}
                  {choice === 'archive' && ['github', 'gitlab', 'bitbucket', 'git'].includes(app.sourceType) && <span className="faint" style={{ fontSize: 'var(--text-sm)' }}>{p.archiveNote}</span>}
                  {app.domains.length > 0 && (
                    <div className="plan-row__domains">
                      {app.domains.map((domain) => (
                        <Badge key={`${domain.host}${domain.path}`} tone={domain.conflict ? 'bad' : 'idle'}>
                          {domain.host}
                          {domain.path === '/' ? '' : domain.path}
                          {domain.conflict && ` · ${p.domainTaken}`}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {!app.builderAvailable && <span className="faint" style={{ fontSize: 'var(--text-sm)' }}>{p.builderMissing}</span>}
                  {app.hostAccess && <span className="faint" style={{ fontSize: 'var(--text-sm)' }}>{p.hostAccess}</span>}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card title={p.options}>
        <div className="stack" style={{ gap: 14 }}>
          <Switch checked={options.restoreData} onChange={(value) => setOptions((current) => ({ ...current, restoreData: value }))} label={p.restoreData} hint={p.restoreDataHint} />
          <Switch checked={options.domains} onChange={(value) => setOptions((current) => ({ ...current, domains: value }))} label={p.domains} hint={p.domainsHint} />
          <Switch checked={options.publicPorts} onChange={(value) => setOptions((current) => ({ ...current, publicPorts: value }))} label={p.publicPorts} hint={p.publicPortsHint} />
          <Switch checked={options.deploy} onChange={(value) => setOptions((current) => ({ ...current, deploy: value }))} label={p.deploy} hint={p.deployHint} />
        </div>
      </Card>

      {data.warnings.length > 0 && (
        <Callout tone="work" title={p.warnings}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`}>{noteText(warning)}</li>
            ))}
          </ul>
        </Callout>
      )}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button
          variant="primary"
          icon={<Play />}
          disabled={server === null || projectName.trim().length === 0}
          busy={start.isPending}
          onClick={() => server !== null && start.mutate({ serverId: server, projectName: projectName.trim(), sources, ...options })}
        >
          {p.start}
        </Button>
      </div>
    </div>
  );
}

export function TransferPage() {
  const { transferId = '' } = useParams();
  const { m, t, formatBytes, formatDate } = useI18n();
  const d = m.transfers.detail;
  const location = useLocation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const transfer = useTransfer(transferId);
  const data = transfer.data;
  const title = data === undefined ? '…' : data.kind === 'export' ? t(d.exportTitle, { name: data.projectName ?? data.fileName }) : t(d.importTitle, { name: data.projectName ?? data.fileName });
  usePageMeta([{ label: m.transfers.title, to: '/transfers' }, { label: title }]);
  const fresh = (location.state as { passphrase?: string } | null)?.passphrase ?? null;
  // The passphrase travels in history state only; it leaves with the first reload.
  useEffect(() => {
    if (fresh !== null) window.history.replaceState({ ...window.history.state, usr: null }, '');
  }, [fresh]);

  const cancel = useAction(() => api.post(`/api/transfers/${transferId}/cancel`), { invalidate: [keys.transfers] });
  const retry = useAction(() => api.post(`/api/transfers/${transferId}/retry`), { invalidate: [keys.transfers], success: d.retried });
  const remove = useAction(() => api.delete(`/api/transfers/${transferId}`), {
    invalidate: [keys.transfers],
    success: d.deleted,
    onSuccess: () => void navigate('/transfers'),
  });

  if (transfer.isError) return transfer.error instanceof ApiError && transfer.error.status === 404 ? <NotFound /> : <Callout tone="bad">{errorText(m, transfer.error)}</Callout>;
  const running = data !== undefined && ['receiving', 'queued', 'running'].includes(data.status);
  const failed = data !== undefined && (data.status === 'failed' || data.status === 'cancelled');

  return (
    <div className="page">
      <Frame
        icon={<ArrowLeftRight />}
        title={data === undefined ? <Skeleton width={260} height={26} /> : title}
        description={
          data === undefined ? undefined : (
            <span className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <TransferStatusBadge status={data.status} />
              <span>{m.transfers.source[data.source]}</span>
              {data.sizeBytes !== null && <span>{formatBytes(data.sizeBytes)}</span>}
              <span>
                <RelativeTime value={data.createdAt} />
              </span>
            </span>
          )
        }
        actions={
          data === undefined ? undefined : (
            <>
              {data.downloadable && (
                <a className="btn btn--primary" href={`/api/transfers/${data.id}/download`} download={data.fileName} style={{ textDecoration: 'none' }}>
                  <Download width={16} height={16} aria-hidden="true" />
                  {m.common.download}
                </a>
              )}
              {failed && (
                <Button icon={<RotateCcw />} busy={retry.isPending} onClick={() => retry.mutate()}>
                  {d.retry}
                </Button>
              )}
              <Menu trigger={(props) => <Button {...props} iconOnly icon={<Ellipsis />}>{m.common.more}</Button>}>
                {(running || data.status === 'locked' || data.status === 'ready') && (
                  <MenuItem icon={<Square />} onSelect={() => cancel.mutate()}>
                    {d.cancel}
                  </MenuItem>
                )}
                {data.kind === 'import' && data.projectId !== null && (
                  <MenuItem icon={<ExternalLink />} onSelect={() => void navigate(`/projects/${data.projectId}`)}>
                    {d.openProject}
                  </MenuItem>
                )}
                <MenuSeparator />
                <MenuItem
                  icon={<Trash2 />}
                  danger
                  onSelect={async () => {
                    const result = await confirm({ title: d.deleteTitle, text: data.kind === 'export' ? d.deleteExportText : d.deleteImportText, confirmLabel: m.common.delete, danger: true });
                    if (result.confirmed) remove.mutate();
                  }}
                >
                  {d.delete}
                </MenuItem>
              </Menu>
            </>
          )
        }
      >
        {data === undefined ? (
          <SkeletonRows rows={4} />
        ) : (
          <div className="stack" style={{ gap: 16 }}>
            {data.status === 'succeeded' && data.kind === 'import' && data.projectId !== null && (
              <Callout
                tone="ok"
                title={d.importDone}
                action={
                  <Link className="btn btn--sm" to={`/projects/${data.projectId}`} style={{ textDecoration: 'none' }}>
                    {d.openProject}
                  </Link>
                }
              >
                {data.warnings.length > 0 ? d.importDoneWarnings : d.importDoneText}
              </Callout>
            )}
            {data.status === 'succeeded' && data.kind === 'export' && !data.downloadable && <Callout tone="idle">{d.expired}</Callout>}
            {data.error !== null && (
              <Callout tone={data.status === 'cancelled' ? 'idle' : 'bad'} title={data.status === 'cancelled' ? m.transfers.status.cancelled : d.failedTitle}>
                {data.error.code === 'interrupted' ? m.transfers.notes.interrupted : data.error.message}
                {failed && data.kind === 'import' && data.steps.length > 0 && <div style={{ marginTop: 6 }}>{d.retryHint}</div>}
              </Callout>
            )}

            {data.kind === 'export' && (data.status === 'succeeded' || fresh !== null) && (data.downloadable || fresh !== null) && <PassphraseCard transfer={data} fresh={fresh} />}

            <TransferProgress transfer={data} />
            {data.kind === 'import' && data.status === 'locked' && <UnlockCard transfer={data} />}
            {data.kind === 'import' && data.status === 'ready' && <ImportPlanner transfer={data} />}

            {data.warnings.length > 0 && data.status !== 'ready' && (
              <div className="stack" style={{ gap: 8 }}>
                <strong>{d.warnings}</strong>
                <TransferNotes notes={data.warnings} />
              </div>
            )}

            {data.kind === 'export' && data.downloadable && (
              <div className="transfer-grid">
                <ShareCard transfer={data} />
                <S3Card transfer={data} />
              </div>
            )}

            {data.steps.length > 0 && data.status !== 'ready' && (
              <Card title={d.steps}>
                <TransferSteps steps={data.steps} />
              </Card>
            )}

            {data.kind === 'export' && data.downloadable && data.expiresAt !== null && (
              <p className="faint" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
                {t(d.keptUntil, { time: formatDate(data.expiresAt) })}
              </p>
            )}
          </div>
        )}
      </Frame>
    </div>
  );
}
