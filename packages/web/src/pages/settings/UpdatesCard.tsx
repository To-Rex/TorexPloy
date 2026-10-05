/** The instance's version, whether a newer one is published, and the way to it. */
import { useState } from 'react';
import { ArrowUpCircle, RefreshCw } from 'lucide-react';
import { StatusMark } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { UpdateDialog } from '../../components/UpdateDialog.tsx';
import { Button, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useUpdateStatus } from '../../lib/queries.ts';
import { SettingsSection } from './SettingsLayout.tsx';

export function UpdatesCard() {
  const { m, t } = useI18n();
  const u = m.updates;
  const status = useUpdateStatus(true);
  const [open, setOpen] = useState(false);
  const check = useAction(() => api.post('/api/updates/check'), { invalidate: [keys.updates, keys.bootstrap] });
  const data = status.data;
  const tone = data === undefined ? 'idle' : data.state === 'updating' ? 'work' : data.state === 'failed' ? 'bad' : data.available ? 'work' : 'ok';
  const label =
    data === undefined
      ? ''
      : data.state === 'updating'
        ? data.progress === null
          ? u.updatingTitle
          : `${u.stages[data.progress.stage]} · ${t(u.percent, { percent: data.progress.percent })}`
        : data.state === 'failed'
          ? u.failedTitle
          : data.available
            ? u.available
            : data.checkError !== null
              ? u.checkFailedShort
              : u.upToDate;
  return (
    <SettingsSection
      title={u.title}
      hint={u.subtitle}
      actions={
        <>
          <Button size="sm" icon={<RefreshCw />} busy={check.isPending} onClick={() => check.mutate()}>
            {u.checkNow}
          </Button>
          <Button size="sm" variant={data?.available === true ? 'primary' : 'secondary'} icon={<ArrowUpCircle />} onClick={() => setOpen(true)}>
            {data?.available === true ? u.update : u.details}
          </Button>
        </>
      }
    >
      {data === undefined ? (
        <Skeleton height={60} />
      ) : (
        <dl className="facts-strip">
          <div>
            <dt>{u.current}</dt>
            <dd>
              v{data.current.version} <code className="faint">{data.current.commit === null ? '—' : data.current.commit.slice(0, 7)}</code>
            </dd>
          </div>
          <div>
            <dt>{u.status}</dt>
            <dd>
              <StatusMark tone={tone} label={label} />
            </dd>
          </div>
          <div>
            <dt>{u.checked}</dt>
            <dd>{data.checkedAt === null ? '—' : <RelativeTime value={data.checkedAt} />}</dd>
          </div>
          <div>
            <dt>{u.source}</dt>
            <dd className="truncate">{data.mode === 'image' && data.image !== null ? data.image : `${data.repository} · ${data.branch}`}</dd>
          </div>
        </dl>
      )}
      <UpdateDialog open={open} onClose={() => setOpen(false)} />
    </SettingsSection>
  );
}
