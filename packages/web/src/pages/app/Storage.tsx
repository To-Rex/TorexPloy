/**
 * Persistent volumes, as a card on the Advanced tab: each volume with how it
 * is backed up and how its last copy went, and a dialog with its copies
 * (download, restore, delete) and its backup schedule.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ArchiveRestore, CalendarClock, Cloud, DatabaseBackup, Download, Ellipsis, HardDrive, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import { createVolumeSchema, updateVolumeBackupSchema, type ApplicationDto, type VolumeBackupDto, type VolumeDto } from '@ploy/shared';
import { useConfirm, Dialog } from '../../components/Dialog.tsx';
import { Card } from '../../components/Frame.tsx';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu.tsx';
import { Status } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { useToast } from '../../components/Toast.tsx';
import { AffixInput, Badge, Button, Callout, Field, Input, Select, SkeletonRows, Stepper, Switch } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useRole, useS3Destinations, useVolumeBackups, useVolumes } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';

/** Schedules most people pick; anything else is a cron expression of their own. */
const PRESETS = { '6h': '0 */6 * * *', daily: '0 3 * * *', weekly: '0 3 * * 0' } as const;
type Preset = 'off' | keyof typeof PRESETS | 'custom';

function presetOf(schedule: string | null): Preset {
  if (schedule === null || schedule.trim().length === 0) return 'off';
  const found = (Object.entries(PRESETS) as [keyof typeof PRESETS, string][]).find(([, cron]) => cron === schedule.trim());
  return found === undefined ? 'custom' : found[0];
}

/** How a volume is backed up, in a few words: "Every day at 03:00", or its cron expression. */
function ScheduleText({ schedule }: { schedule: string | null }) {
  const { m } = useI18n();
  const preset = presetOf(schedule);
  if (preset === 'off') return <>{m.storage.handOnly}</>;
  if (preset === 'custom') return <code>{schedule}</code>;
  return <>{m.storage.presets[preset]}</>;
}

/** One copy: when, how it came about, how big, where it is, and what can be done with it. */
function BackupRow({ app, volume, backup, admin }: { app: ApplicationDto; volume: VolumeDto; backup: VolumeBackupDto; admin: boolean }) {
  const { m, t, formatBytes, formatDuration } = useI18n();
  const s = m.storage;
  const confirm = useConfirm();
  const base = `/api/applications/${app.id}/volumes/${volume.id}/backups/${backup.id}`;
  const invalidate = [keys.appPart(app.id, 'volumes'), keys.app(app.id)];
  const restore = useAction(() => api.post(`${base}/restore`), { success: s.restored, invalidate });
  const remove = useAction(() => api.delete(base), { success: s.backupDeleted, invalidate });
  return (
    <div className="list__row backup-row" data-trigger={backup.trigger}>
      <Status kind="backup" status={backup.status} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="list__title">
          <RelativeTime value={backup.startedAt} />
          <span className="backup-row__trigger">{s.triggers[backup.trigger]}</span>
        </div>
        <div className="list__meta">
          {backup.sizeBytes !== null && (
            <span className="tabular" title={backup.rawBytes === null ? undefined : t(s.uncompressed, { size: formatBytes(backup.rawBytes) })}>
              {formatBytes(backup.sizeBytes)}
              {backup.rawBytes !== null && <span className="faint"> · {t(s.uncompressed, { size: formatBytes(backup.rawBytes) })}</span>}
            </span>
          )}
          {backup.finishedAt !== null && <span className="tabular">{formatDuration(Date.parse(backup.finishedAt) - Date.parse(backup.startedAt))}</span>}
          {backup.remote !== null && <Badge icon={<Cloud />}>{backup.onServer ? (backup.remote.destinationName ?? 'S3') : `${m.s3.onlyRemote}: ${backup.remote.destinationName ?? 'S3'}`}</Badge>}
          {backup.errorMessage !== null && (
            <span className="truncate" style={{ color: backup.status === 'succeeded' ? 'var(--work-ink)' : 'var(--bad-ink)' }} title={backup.errorMessage}>
              {backup.errorMessage}
            </span>
          )}
        </div>
      </div>
      {backup.status === 'succeeded' && admin && (
        <a className="btn btn--sm btn--ghost" href={`${base}/download`} download style={{ textDecoration: 'none' }}>
          <Download aria-hidden="true" />
          {m.common.download}
        </a>
      )}
      {backup.status !== 'running' && admin && (
        <Menu trigger={(props) => <Button {...props} size="sm" variant="ghost" iconOnly icon={<Ellipsis />}>{m.common.actions}</Button>}>
          {backup.status === 'succeeded' && (
            <MenuItem
              icon={<ArchiveRestore />}
              onSelect={async () => {
                const result = await confirm({ title: s.restoreTitle, text: s.restoreText, confirmLabel: s.restore, danger: true, typeToConfirm: volume.name });
                if (result.confirmed) restore.mutate();
              }}
            >
              {s.restore}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem
            icon={<Trash2 />}
            danger
            onSelect={async () => {
              const result = await confirm({ title: s.deleteBackupTitle, text: s.deleteBackupText, confirmLabel: m.common.delete, danger: true });
              if (result.confirmed) remove.mutate();
            }}
          >
            {m.common.delete}
          </MenuItem>
        </Menu>
      )}
      {restore.isPending && (
        <div className="backup-row__busy" role="status">
          <LoaderCircle className="spin" aria-hidden="true" />
          {s.restoring}
        </div>
      )}
    </div>
  );
}

/** How a volume is backed up: how often, how many copies, where else, and whether to pause the application. */
function BackupPolicy({ app, volume }: { app: ApplicationDto; volume: VolumeDto }) {
  const { m, t, timezone } = useI18n();
  const s = m.storage;
  const role = useRole();
  const destinations = useS3Destinations();
  const initial = () => ({ preset: presetOf(volume.backupSchedule), cron: volume.backupSchedule ?? '', retention: String(volume.backupRetention), destination: volume.backupDestinationId ?? '', pause: volume.backupPause });
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const signature = JSON.stringify([volume.backupSchedule, volume.backupRetention, volume.backupDestinationId, volume.backupPause]);
  useEffect(() => setDraft(initial()), [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const schedule = draft.preset === 'off' ? null : draft.preset === 'custom' ? draft.cron.trim() : PRESETS[draft.preset];
  const payload = { backupSchedule: schedule, backupRetention: Number(draft.retention), backupDestinationId: draft.destination.length === 0 ? null : draft.destination, backupPause: draft.pause };
  const dirty = schedule !== volume.backupSchedule || payload.backupRetention !== volume.backupRetention || payload.backupDestinationId !== volume.backupDestinationId || draft.pause !== volume.backupPause;
  const save = useAction((input: typeof payload) => api.patch(`/api/applications/${app.id}/volumes/${volume.id}`, input), {
    success: s.policySaved,
    invalidate: [keys.appPart(app.id, 'volumes')],
    inlineValidation: true,
  });
  const submit = () => {
    const result = validate(m, updateVolumeBackupSchema, payload);
    if (result.errors !== null) return setErrors(result.errors);
    setErrors({});
    save.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
  };
  const admin = role === 'admin' || role === 'owner';
  return (
    <section className="backup-policy">
      <h3 className="backup-policy__title">
        <CalendarClock aria-hidden="true" />
        {s.policyTitle}
      </h3>
      <div className="form-grid">
        <Field label={s.frequency}>
          <Select value={draft.preset} onChange={(event) => setDraft({ ...draft, preset: event.target.value as Preset, cron: event.target.value === 'custom' && draft.cron.length === 0 ? '0 2 * * *' : draft.cron })}>
            {(['off', '6h', 'daily', 'weekly', 'custom'] as const).map((preset) => (
              <option key={preset} value={preset}>
                {s.presets[preset]}
              </option>
            ))}
          </Select>
        </Field>
        {draft.preset === 'custom' ? (
          <Field label={s.cron} hint={t(s.cronHint, { zone: timezone })} error={errors.backupSchedule}>
            <Input mono value={draft.cron} onChange={(event) => setDraft({ ...draft, cron: event.target.value })} placeholder="0 2 * * *" spellCheck={false} />
          </Field>
        ) : (
          <Field label={s.retention} hint={s.retentionHint} error={errors.backupRetention ?? errors.backupSchedule}>
            <Stepper value={draft.retention} onChange={(retention) => setDraft({ ...draft, retention })} min={1} max={365} labels={{ decrease: m.advanced.decrease, increase: m.advanced.increase }} />
          </Field>
        )}
        {draft.preset === 'custom' && (
          <Field label={s.retention} hint={s.retentionHint} error={errors.backupRetention}>
            <Stepper value={draft.retention} onChange={(retention) => setDraft({ ...draft, retention })} min={1} max={365} labels={{ decrease: m.advanced.decrease, increase: m.advanced.increase }} />
          </Field>
        )}
        <Field label={m.s3.copyTo} hint={m.s3.copyToHint} error={errors.backupDestinationId}>
          <Select value={draft.destination} onChange={(event) => setDraft({ ...draft, destination: event.target.value })}>
            <option value="">{m.s3.serverOnly}</option>
            {(destinations.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.bucket})
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {(destinations.data ?? []).length === 0 && admin && (
        <p className="field__hint">
          {m.s3.noneYet} <Link to="/settings/storage">{m.s3.addFirst}</Link>
        </p>
      )}
      <Switch checked={draft.pause} onChange={(pause) => setDraft({ ...draft, pause })} label={s.pause} hint={s.pauseHint} />
      {dirty && (
        <div className="backup-policy__foot">
          <span>{m.common.unsavedChanges}</span>
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(initial());
              setErrors({});
            }}
          >
            {m.common.discard}
          </Button>
          <Button variant="primary" busy={save.isPending} onClick={submit}>
            {m.common.save}
          </Button>
        </div>
      )}
    </section>
  );
}

function BackupsDialog({ app, volume, onClose }: { app: ApplicationDto; volume: VolumeDto | null; onClose: () => void }) {
  const { m, t } = useI18n();
  const s = m.storage;
  const role = useRole();
  const toast = useToast();
  const backups = useVolumeBackups(app.id, volume?.id ?? null);
  const start = useAction(() => api.post(`/api/applications/${app.id}/volumes/${volume!.id}/backups`), { success: s.backupStarted, invalidate: [keys.appPart(app.id, 'volumes')] });
  const admin = role === 'admin' || role === 'owner';
  const developer = admin || role === 'developer';
  const running = (backups.data ?? []).some((backup) => backup.status === 'running');
  const deployed = app.activeDeployment !== null;
  return (
    <Dialog open={volume !== null} onClose={onClose} wide title={volume === null ? '' : t(s.backupsTitle, { name: volume.name })} description={s.backupsHint}>
      {volume !== null && (
        <div className="stack" style={{ gap: 18 }}>
          <div className="backup-head">
            <span className="backup-head__path">
              <HardDrive aria-hidden="true" />
              <code>{volume.mountPath}</code>
            </span>
            {developer && (
              <Button
                variant="primary"
                icon={<DatabaseBackup />}
                busy={start.isPending || running}
                disabled={!deployed}
                title={deployed ? undefined : m.appOverview.next.neverDeployedTitle}
                onClick={() => start.mutate(undefined, { onError: (error) => toast.error(error) })}
              >
                {running ? s.backupRunning : s.backupNow}
              </Button>
            )}
          </div>
          {backups.isPending ? (
            <SkeletonRows rows={2} />
          ) : (backups.data ?? []).length === 0 ? (
            <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{s.noBackups}</p>
          ) : (
            <div className="list backup-list">
              {backups.data!.map((backup) => (
                <BackupRow key={backup.id} app={app} volume={volume} backup={backup} admin={admin} />
              ))}
            </div>
          )}
          {developer && <BackupPolicy app={app} volume={volume} />}
        </div>
      )}
    </Dialog>
  );
}

/** A volume as one row: where it is mounted, how it is backed up, how the last copy went. */
function VolumeRow({ app, volume, onBackups }: { app: ApplicationDto; volume: VolumeDto; onBackups: () => void }) {
  const { m, t, plural, formatBytes } = useI18n();
  const s = m.storage;
  const confirm = useConfirm();
  const invalidate = [keys.appPart(app.id, 'volumes'), keys.app(app.id)];
  const remove = useAction((removeData: boolean) => api.delete(`/api/applications/${app.id}/volumes/${volume.id}?removeData=${removeData}`), { success: s.removed, invalidate });
  const last = volume.lastBackup;
  return (
    <div className="volume">
      <span className="volume__mark" aria-hidden="true">
        <HardDrive />
      </span>
      <div className="volume__main">
        <div className="volume__title">
          {volume.name}
          <code>{volume.mountPath}</code>
        </div>
        <div className="volume__meta">
          {last === null ? (
            <span className="faint">{s.neverBackedUp}</span>
          ) : last.status === 'running' ? (
            <span className="row" style={{ gap: 6 }}>
              <LoaderCircle className="spin" width={13} height={13} aria-hidden="true" />
              {s.backupRunning}
            </span>
          ) : (
            <span className="row" style={{ gap: 6 }}>
              <Status kind="backup" status={last.status} />
              <RelativeTime value={last.startedAt} />
              {last.sizeBytes !== null && last.status === 'succeeded' && <span className="faint tabular">· {formatBytes(last.sizeBytes)}</span>}
            </span>
          )}
          <span className="row" style={{ gap: 5 }}>
            <CalendarClock width={13} height={13} aria-hidden="true" />
            <ScheduleText schedule={volume.backupSchedule} />
            {volume.nextBackupAt !== null && (
              <span className="faint">
                · {t(s.nextBackup, { time: '' })}
                <RelativeTime value={volume.nextBackupAt} />
              </span>
            )}
          </span>
          {volume.backupDestinationId !== null && <Badge icon={<Cloud />}>S3</Badge>}
        </div>
      </div>
      <div className="volume__actions">
        <Button size="sm" icon={<DatabaseBackup />} onClick={onBackups}>
          {s.backups}
          {volume.backupCount > 0 && <span className="count" title={plural(s.count, volume.backupCount)}>{volume.backupCount}</span>}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={<Trash2 />}
          onClick={async () => {
            const result = await confirm({ title: s.removeTitle, text: s.removeText, confirmLabel: m.common.remove, danger: true, checkbox: { label: s.removeData } });
            if (result.confirmed) remove.mutate(result.checked);
          }}
        >
          {m.common.remove}
        </Button>
      </div>
    </div>
  );
}

export function VolumesCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const volumes = useVolumes(app.id);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState('data');
  const [mountPath, setMountPath] = useState('/app/data');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const invalidate = [keys.appPart(app.id, 'volumes'), keys.app(app.id)];
  const add = useAction((input: { name: string; mountPath: string }) => api.post(`/api/applications/${app.id}/volumes`, input), {
    success: m.storage.added,
    invalidate,
    inlineValidation: true,
    onSuccess: () => setAdding(false),
  });
  const list = volumes.data ?? [];
  const opened = list.find((volume) => volume.id === open) ?? null;

  return (
    <Card
      id="adv-volumes"
      icon={<HardDrive />}
      title={m.storage.title}
      description={m.storage.hint}
      actions={
        <Button icon={<Plus />} onClick={() => setAdding(true)}>
          {m.storage.add}
        </Button>
      }
    >
      {app.replicas > 1 && list.length > 0 && <Callout tone="work">{m.storage.replicaWarning}</Callout>}
      {volumes.isPending ? (
        <SkeletonRows rows={2} />
      ) : list.length === 0 ? (
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{m.storage.empty}</p>
      ) : (
        <div className="volume-list">
          {list.map((volume) => (
            <VolumeRow key={volume.id} app={app} volume={volume} onBackups={() => setOpen(volume.id)} />
          ))}
        </div>
      )}
      <BackupsDialog app={app} volume={opened} onClose={() => setOpen(null)} />
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title={m.storage.add}
        onSubmit={() => {
          const result = validate(m, createVolumeSchema, { name, mountPath });
          if (result.errors !== null) {
            setErrors(result.errors);
            return;
          }
          setErrors({});
          add.mutate(result.data, { onError: (error) => setErrors(fieldErrors(m, error)) });
        }}
        footer={
          <>
            <Button onClick={() => setAdding(false)}>{m.common.cancel}</Button>
            <Button type="submit" variant="primary" busy={add.isPending}>
              {m.common.add}
            </Button>
          </>
        }
      >
        <div className="form-grid">
          <Field label={m.storage.name} error={errors.name}>
            <Input mono value={name} onChange={(event) => setName(event.target.value)} spellCheck={false} />
          </Field>
          <Field label={m.storage.mountPath} hint={m.storage.mountPathHint} error={errors.mountPath}>
            <AffixInput mono value={mountPath} onChange={(event) => setMountPath(event.target.value)} spellCheck={false} />
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}
