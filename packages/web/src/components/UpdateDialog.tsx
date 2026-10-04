/**
 * Self-update: what is running, what is published, the commits in between,
 * and the button that starts the updater. While the panel replaces itself
 * the dialog keeps polling and reloads the page once the new version answers.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, GitCommitHorizontal, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { UpdateStatusDto } from '@ploy/shared';
import { useI18n } from '../i18n/index.tsx';
import { api } from '../lib/api.ts';
import { useAction } from '../lib/mutate.ts';
import { keys, useUpdateStatus } from '../lib/queries.ts';
import { Dialog } from './Dialog.tsx';
import { RelativeTime } from './Time.tsx';
import { useToast } from './Toast.tsx';
import { Badge, Button, Callout, Skeleton } from './ui.tsx';

const short = (sha: string | null): string => (sha === null ? '—' : sha.slice(0, 7));

/** Once an update is running: wait for the panel to come back on the new build, then reload. */
function useReloadWhenUpdated(status: UpdateStatusDto | undefined) {
  const { m } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const target = useRef<string | null>(null);
  useEffect(() => {
    if (status?.state === 'updating' && status.latest !== null) target.current = status.latest.commit;
  }, [status]);
  useEffect(() => {
    if (target.current === null) return;
    const timer = window.setInterval(async () => {
      try {
        const health = await api.get<{ version: string; commit?: string | null }>('/api/health');
        if (health.commit !== undefined && health.commit === target.current) {
          window.clearInterval(timer);
          toast.success(m.updates.updated);
          void client.invalidateQueries({ queryKey: keys.bootstrap });
          window.setTimeout(() => window.location.reload(), 1_200);
        }
      } catch {
        // The panel is restarting; keep polling.
      }
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [status?.state, client, m, toast]);
}

export function UpdateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { m, t, formatDate } = useI18n();
  const u = m.updates;
  const status = useUpdateStatus(open);
  const data = status.data;
  const [confirming, setConfirming] = useState(false);
  useReloadWhenUpdated(data);
  const check = useAction(() => api.post<UpdateStatusDto>('/api/updates/check'), {
    invalidate: [keys.updates, keys.bootstrap],
    success: (result) => (result.available ? null : u.upToDate),
  });
  const apply = useAction(() => api.post('/api/updates/apply'), { invalidate: [keys.updates], success: u.started, onSuccess: () => setConfirming(false) });

  return (
    <Dialog open={open} onClose={onClose} wide title={u.title} description={u.subtitle}>
      {data === undefined ? (
        <Skeleton height={160} />
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          <dl className="facts-strip">
            <div>
              <dt>{u.current}</dt>
              <dd>
                v{data.current.version} <code className="faint">{short(data.current.commit)}</code>
              </dd>
            </div>
            <div>
              <dt>{u.latest}</dt>
              <dd>{data.latest === null ? '—' : <code>{short(data.latest.commit)}</code>}</dd>
            </div>
            <div>
              <dt>{u.checked}</dt>
              <dd>{data.checkedAt === null ? '—' : <RelativeTime value={data.checkedAt} />}</dd>
            </div>
            <div>
              <dt>{u.source}</dt>
              <dd className="truncate" title={data.mode === 'image' && data.image !== null ? data.image : `${data.repository}@${data.branch}`}>
                {data.mode === 'image' && data.image !== null ? data.image : `${data.repository} · ${data.branch}`}
              </dd>
            </div>
          </dl>

          {data.state === 'updating' && (
            <Callout tone="work" title={u.updatingTitle}>
              {u.updatingText}
            </Callout>
          )}
          {data.state === 'failed' && (
            <Callout tone="bad" title={u.failedTitle}>
              {u.failedText}
              {data.error !== null && <pre className="codeblock" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{data.error}</pre>}
            </Callout>
          )}
          {data.checkError !== null && <Callout tone="work">{t(u.checkFailed, { reason: data.checkError })}</Callout>}
          {data.mode === 'manual' && <Callout tone="info">{u.manualText}</Callout>}
          {!data.available && data.state === 'idle' && data.checkError === null && <Callout tone="ok">{u.upToDate}</Callout>}

          {data.available && data.state !== 'updating' && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <h3>{u.changes}</h3>
                {data.latest !== null && (
                  <a href={data.latest.url} target="_blank" rel="noreferrer noopener" style={{ fontSize: 'var(--text-sm)' }}>
                    {u.openOnGithub}
                  </a>
                )}
              </div>
              {data.commits.length === 0 ? (
                <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
                  {data.current.commit === null ? u.unknownCurrent : u.noCommitList}
                </p>
              ) : (
                <ul className="update-commits">
                  {data.commits.map((commit) => (
                    <li key={commit.sha}>
                      <GitCommitHorizontal aria-hidden="true" />
                      <a href={commit.url} target="_blank" rel="noreferrer noopener" className="truncate" title={commit.message}>
                        {commit.message}
                      </a>
                      <span className="faint">
                        {commit.author !== null && `${commit.author} · `}
                        {formatDate(commit.date, { dateStyle: 'medium' })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {confirming && data.canApply && (
            <Callout
              tone="work"
              title={u.confirmTitle}
              action={
                <Button variant="primary" size="sm" busy={apply.isPending} onClick={() => apply.mutate()}>
                  {u.confirmYes}
                </Button>
              }
            >
              {u.confirmText}
            </Callout>
          )}

          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
            <Button icon={<RefreshCw />} busy={check.isPending} disabled={data.state === 'updating'} onClick={() => check.mutate()}>
              {u.checkNow}
            </Button>
            {data.available && data.state !== 'updating' && (
              <Button variant="primary" icon={<ArrowUpCircle />} disabled={!data.canApply} title={data.canApply ? undefined : data.mode === 'manual' ? u.manualShort : u.adminOnly} onClick={() => setConfirming(true)}>
                {data.state === 'failed' ? u.retry : u.update}
              </Button>
            )}
            {data.available && !data.canApply && data.mode !== 'manual' && <Badge>{u.adminOnly}</Badge>}
          </div>
        </div>
      )}
    </Dialog>
  );
}
