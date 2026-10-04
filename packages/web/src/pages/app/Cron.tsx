import { useState } from 'react';
import { CalendarClock, Ellipsis, Pencil, Play, Plus, ScrollText, Trash2 } from 'lucide-react';
import { createCronJobSchema, type CronJobDto } from '@ploy/shared';
import { useConfirm, Dialog } from '../../components/Dialog.tsx';
import { Card } from '../../components/Frame.tsx';
import { LogViewer } from '../../components/LogViewer.tsx';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu.tsx';
import { Status } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Badge, Button, Callout, Field, Input, SkeletonRows, Switch } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useLogStream } from '../../lib/logs.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useCronJobs, useCronRuns } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { useAppContext } from './AppLayout.tsx';

interface Draft {
  id: string | null;
  name: string;
  schedule: string;
  command: string;
  enabled: boolean;
  timeoutSec: string;
}

const empty: Draft = { id: null, name: '', schedule: '0 3 * * *', command: '', enabled: true, timeoutSec: '3600' };

function RunsPanel({ appId, job }: { appId: string; job: CronJobDto }) {
  const { m, t, formatDuration } = useI18n();
  const runs = useCronRuns(appId, job.id);
  const [open, setOpen] = useState<string | null>(null);
  const { lines } = useLogStream(open === null ? null : `/api/applications/${appId}/cron/${job.id}/runs/${open}/log`);
  return (
    <div className="stack" style={{ gap: 10 }}>
      {runs.isPending ? (
        <SkeletonRows rows={2} />
      ) : runs.data!.length === 0 ? (
        <p className="faint">{m.cron.noRuns}</p>
      ) : (
        <div className="list">
          {runs.data!.slice(0, 10).map((run) => (
            <button key={run.id} type="button" className="list__row" style={{ minHeight: 44 }} aria-pressed={open === run.id} onClick={() => setOpen(open === run.id ? null : run.id)}>
              <Status kind="cron" status={run.status} />
              <span className="grow row faint" style={{ fontSize: 'var(--text-sm)', gap: 12 }}>
                <span>{run.trigger === 'manual' ? m.trigger.manual : m.cron.schedule}</span>
                {run.exitCode !== null && run.exitCode !== 0 && <span>{t(m.cron.exitCode, { code: run.exitCode })}</span>}
              </span>
              {run.durationMs !== null && <span className="faint tabular" style={{ fontSize: 'var(--text-sm)' }}>{formatDuration(run.durationMs)}</span>}
              <span className="faint" style={{ fontSize: 'var(--text-sm)' }}>
                <RelativeTime value={run.startedAt} />
              </span>
            </button>
          ))}
        </div>
      )}
      {open !== null && <LogViewer lines={lines} height={280} levels={false} name={`cron-${job.name}`} />}
    </div>
  );
}

export function CronTab() {
  const app = useAppContext();
  const { m, t } = useI18n();
  const confirm = useConfirm();
  const jobs = useCronJobs(app.id);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const invalidate = [keys.appPart(app.id, 'cron')];

  const save = useAction(
    (input: Draft) => {
      const body = { name: input.name.trim(), schedule: input.schedule.trim(), command: input.command.trim(), enabled: input.enabled, timeoutSec: Number(input.timeoutSec) };
      return input.id === null ? api.post(`/api/applications/${app.id}/cron`, body) : api.patch(`/api/applications/${app.id}/cron/${input.id}`, body);
    },
    { success: m.cron.saved, invalidate, inlineValidation: true, onSuccess: () => setDraft(null) },
  );
  const run = useAction((jobId: string) => api.post(`/api/applications/${app.id}/cron/${jobId}/run`), {
    success: m.cron.started,
    invalidate,
    onSuccess: () => void 0,
  });
  const toggle = useAction((job: CronJobDto) => api.patch(`/api/applications/${app.id}/cron/${job.id}`, { enabled: !job.enabled }), { invalidate });
  const remove = useAction((jobId: string) => api.delete(`/api/applications/${app.id}/cron/${jobId}`), { invalidate });

  const presets = [
    { label: m.cron.presets.every15, value: '*/15 * * * *' },
    { label: m.cron.presets.hourly, value: '0 * * * *' },
    { label: m.cron.presets.daily, value: '0 3 * * *' },
    { label: m.cron.presets.weekly, value: '0 9 * * 1' },
  ];

  return (
    <Card
      title={m.cron.title}
      description={m.cron.hint}
      actions={
        <Button variant="primary" icon={<Plus />} onClick={() => { setErrors({}); setDraft(empty); }}>
          {m.cron.add}
        </Button>
      }
    >
      {app.activeDeployment === null && <Callout tone="info">{m.cron.noDeployment}</Callout>}
      {jobs.isPending ? (
        <SkeletonRows rows={2} />
      ) : jobs.data!.length === 0 ? (
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{m.cron.empty}</p>
      ) : (
        jobs.data!.map((job) => (
          <div key={job.id} className="panel">
            <div className="panel__head" style={{ flexWrap: 'wrap' }}>
              <CalendarClock width={17} height={17} className="faint" aria-hidden="true" />
              <div className="grow" style={{ minWidth: 200 }}>
                <div className="row">
                  <span style={{ fontWeight: 600 }}>{job.name}</span>
                  <code className="code-inline">{job.schedule}</code>
                  {!job.enabled && <Badge>{m.cron.paused}</Badge>}
                </div>
                <div className="list__meta">
                  <code className="truncate" style={{ maxWidth: 420 }}>$ {job.command}</code>
                  {job.nextRunAt !== null && (
                    <span>
                      {t(m.cron.nextRun, { time: '' })}
                      <RelativeTime value={job.nextRunAt} />
                    </span>
                  )}
                </div>
              </div>
              {job.lastRun !== null && <Status kind="cron" status={job.lastRun.status} />}
              <Button size="sm" icon={<Play />} disabled={app.activeDeployment === null} busy={run.isPending && run.variables === job.id} onClick={() => run.mutate(job.id)}>
                {m.cron.runNow}
              </Button>
              <Button size="sm" variant="ghost" icon={<ScrollText />} aria-expanded={expanded === job.id} onClick={() => setExpanded(expanded === job.id ? null : job.id)}>
                {m.cron.runs}
              </Button>
              <Menu trigger={(props) => <Button {...props} size="sm" variant="ghost" iconOnly icon={<Ellipsis />}>{m.common.actions}</Button>}>
                <MenuItem icon={<Pencil />} onSelect={() => { setErrors({}); setDraft({ id: job.id, name: job.name, schedule: job.schedule, command: job.command, enabled: job.enabled, timeoutSec: String(job.timeoutSec) }); }}>
                  {m.common.edit}
                </MenuItem>
                <MenuItem icon={<CalendarClock />} onSelect={() => toggle.mutate(job)}>
                  {job.enabled ? m.cron.paused : m.cron.enabled}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  icon={<Trash2 />}
                  danger
                  onSelect={async () => {
                    const result = await confirm({ title: m.cron.removeTitle, text: job.name, confirmLabel: m.common.delete, danger: true });
                    if (result.confirmed) remove.mutate(job.id);
                  }}
                >
                  {m.common.delete}
                </MenuItem>
              </Menu>
            </div>
            {expanded === job.id && (
              <div className="panel__body">
                <RunsPanel appId={app.id} job={job} />
              </div>
            )}
          </div>
        ))
      )}

      <Dialog
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id === null ? m.cron.add : m.common.edit}
        onSubmit={() => {
          if (draft === null) return;
          const result = validate(m, createCronJobSchema, { name: draft.name, schedule: draft.schedule, command: draft.command, enabled: draft.enabled, timeoutSec: Number(draft.timeoutSec) });
          if (result.errors !== null) {
            setErrors(result.errors);
            return;
          }
          setErrors({});
          save.mutate(draft, { onError: (error) => setErrors(fieldErrors(m, error)) });
        }}
        footer={
          <>
            <Button onClick={() => setDraft(null)}>{m.common.cancel}</Button>
            <Button type="submit" variant="primary" busy={save.isPending}>
              {m.common.save}
            </Button>
          </>
        }
      >
        {draft !== null && (
          <div className="stack">
            <Field label={m.cron.name} error={errors.name}>
              <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} autoFocus />
            </Field>
            <Field label={m.cron.schedule} hint={m.cron.scheduleHint} error={errors.schedule}>
              <Input mono value={draft.schedule} onChange={(event) => setDraft({ ...draft, schedule: event.target.value })} spellCheck={false} />
            </Field>
            <div className="row wrap" style={{ gap: 6, marginTop: -6 }}>
              {presets.map((preset) => (
                <Button key={preset.value} size="sm" variant="ghost" aria-pressed={draft.schedule === preset.value} onClick={() => setDraft({ ...draft, schedule: preset.value })}>
                  {preset.label}
                </Button>
              ))}
            </div>
            <Field label={m.cron.command} error={errors.command}>
              <Input mono value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder={m.cron.commandPlaceholder} spellCheck={false} />
            </Field>
            <div className="form-grid">
              <Field label={m.cron.timeout} error={errors.timeoutSec}>
                <Input value={draft.timeoutSec} onChange={(event) => setDraft({ ...draft, timeoutSec: event.target.value.replace(/\D/g, '') })} inputMode="numeric" />
              </Field>
              <div style={{ alignSelf: 'end', paddingBottom: 8 }}>
                <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={m.cron.enabled} />
              </div>
            </div>
          </div>
        )}
      </Dialog>
    </Card>
  );
}
