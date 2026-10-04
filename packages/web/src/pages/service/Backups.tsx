import { useEffect, useState } from 'react';
import { Archive, ArchiveRestore, Download, Ellipsis, Plus, Trash2 } from 'lucide-react';
import { updateServiceSchema } from '@ploy/shared';
import { useConfirm } from '../../components/Dialog.tsx';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu.tsx';
import { Status } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Button, Callout, EmptyState, Field, Input, SkeletonRows } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useCatalog, useServiceBackups } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { useServiceContext } from './ServiceLayout.tsx';

export function BackupsTab() {
  const service = useServiceContext();
  const { m, formatBytes, formatDuration } = useI18n();
  const confirm = useConfirm();
  const catalog = useCatalog();
  const backups = useServiceBackups(service.id);
  const entry = catalog.data?.find((candidate) => candidate.type === service.type);
  const [schedule, setSchedule] = useState(service.backupSchedule ?? '');
  const [retention, setRetention] = useState(String(service.backupRetention));
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    setSchedule(service.backupSchedule ?? '');
    setRetention(String(service.backupRetention));
  }, [service.backupSchedule, service.backupRetention]);

  const invalidate = [keys.servicePart(service.id, 'backups'), keys.service(service.id)];
  const create = useAction(() => api.post(`/api/services/${service.id}/backups`), { success: m.services.backupStarted, invalidate });
  const restore = useAction((id: string) => api.post(`/api/services/${service.id}/backups/${id}/restore`), { success: m.services.restored, invalidate });
  const remove = useAction((id: string) => api.delete(`/api/services/${service.id}/backups/${id}`), { invalidate });
  const savePolicy = useAction((input: { backupSchedule: string | null; backupRetention: number }) => api.patch(`/api/services/${service.id}`, input), {
    success: m.services.saved,
    invalidate,
    inlineValidation: true,
  });

  if (entry !== undefined && !entry.supportsBackup) return <Callout tone="info">{m.services.backupUnsupported}</Callout>;

  const policyDirty = schedule !== (service.backupSchedule ?? '') || retention !== String(service.backupRetention);
  return (
    <>
      <div className="section">
        <div className="section__intro">
          <h2>{m.services.backups}</h2>
        </div>
        <div className="stack">
          <div>
            <Button variant="primary" icon={<Plus />} busy={create.isPending} disabled={service.status !== 'running'} onClick={() => create.mutate()}>
              {m.services.backupNow}
            </Button>
          </div>
          {backups.isPending ? (
            <SkeletonRows rows={2} />
          ) : backups.data!.length === 0 ? (
            <EmptyState icon={<Archive />}>{m.services.backupsEmpty}</EmptyState>
          ) : (
            <div className="list">
              {backups.data!.map((backup) => (
                <div key={backup.id} className="list__row">
                  <Status kind="backup" status={backup.status} />
                  <div className="grow">
                    <div className="list__title">
                      <RelativeTime value={backup.startedAt} />
                    </div>
                    <div className="list__meta">
                      <span>{backup.trigger === 'manual' ? m.trigger.manual : m.services.schedule}</span>
                      {backup.sizeBytes !== null && <span className="tabular">{formatBytes(backup.sizeBytes)}</span>}
                      {backup.finishedAt !== null && <span className="tabular">{formatDuration(Date.parse(backup.finishedAt) - Date.parse(backup.startedAt))}</span>}
                      {backup.errorMessage !== null && <span style={{ color: 'var(--bad-ink)' }} className="truncate">{backup.errorMessage}</span>}
                    </div>
                  </div>
                  {backup.status === 'succeeded' && (
                    <a className="btn btn--sm btn--ghost" href={`/api/services/${service.id}/backups/${backup.id}/download`} download style={{ textDecoration: 'none' }}>
                      <Download aria-hidden="true" />
                      {m.common.download}
                    </a>
                  )}
                  {backup.status !== 'running' && (
                    <Menu trigger={(props) => <Button {...props} size="sm" variant="ghost" iconOnly icon={<Ellipsis />}>{m.common.actions}</Button>}>
                      {backup.status === 'succeeded' && (
                        <MenuItem
                          icon={<ArchiveRestore />}
                          onSelect={async () => {
                            const result = await confirm({ title: m.services.restoreTitle, text: m.services.restoreText, confirmLabel: m.services.restore, danger: true, typeToConfirm: service.name });
                            if (result.confirmed) restore.mutate(backup.id);
                          }}
                        >
                          {m.services.restore}
                        </MenuItem>
                      )}
                      <MenuSeparator />
                      <MenuItem icon={<Trash2 />} danger onSelect={() => remove.mutate(backup.id)}>
                        {m.common.delete}
                      </MenuItem>
                    </Menu>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="section">
        <div className="section__intro">
          <h2>{m.services.schedule}</h2>
          <p>{m.services.scheduleHint}</p>
        </div>
        <form
          className="stack"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const payload = { backupSchedule: schedule.trim().length === 0 ? null : schedule.trim(), backupRetention: Number(retention) };
            const result = validate(m, updateServiceSchema, payload);
            if (result.errors !== null) {
              setErrors(result.errors);
              return;
            }
            setErrors({});
            savePolicy.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
          }}
        >
          <div className="form-grid">
            <Field label={m.services.schedule} error={errors.backupSchedule}>
              <Input mono value={schedule} onChange={(event) => setSchedule(event.target.value)} placeholder="0 3 * * *" spellCheck={false} />
            </Field>
            <Field label={m.services.retention} error={errors.backupRetention}>
              <Input value={retention} onChange={(event) => setRetention(event.target.value.replace(/\D/g, ''))} inputMode="numeric" />
            </Field>
          </div>
          {policyDirty && (
            <div>
              <Button type="submit" variant="primary" busy={savePolicy.isPending}>
                {m.common.save}
              </Button>
            </div>
          )}
        </form>
      </div>
    </>
  );
}
