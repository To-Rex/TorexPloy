/**
 * A database, framed like an application: name, status and engine on top;
 * General, Logs, Monitoring, Backups and Advanced tabs below; the terminal
 * as a dialog.
 */
import { useState } from 'react';
import { Outlet, useNavigate, useOutletContext, useParams } from 'react-router';
import { Ellipsis, Pencil, Server, SquareTerminal, Trash2 } from 'lucide-react';
import { updateServiceSchema, type ServiceDto } from '@ploy/shared';
import { Dialog, useConfirm } from '../../components/Dialog.tsx';
import { ServiceMark } from '../../components/KindMark.tsx';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu.tsx';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { Reason } from '../../components/Reason.tsx';
import { Status } from '../../components/Status.tsx';
import { RouteTabs } from '../../components/Tabs.tsx';
import { Button, Callout, Field, Input, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useProject, useService } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { NotFound } from '../../app/RouteError.tsx';
import { ServiceTerminal } from './ServiceTerminal.tsx';

interface ServiceOutlet {
  service: ServiceDto;
  openTerminal: () => void;
}

export function useServiceContext(): ServiceDto {
  return useOutletContext<ServiceOutlet>().service;
}

export function useServiceTerminal(): () => void {
  return useOutletContext<ServiceOutlet>().openTerminal;
}

function RenameDialog({ service, open, onClose }: { service: ServiceDto; open: boolean; onClose: () => void }) {
  const { m } = useI18n();
  const [name, setName] = useState(service.name);
  const [error, setError] = useState<string | undefined>();
  const [loadedFor, setLoadedFor] = useState(false);
  if (open !== loadedFor) {
    setLoadedFor(open);
    if (open) {
      setName(service.name);
      setError(undefined);
    }
  }
  const save = useAction((value: string) => api.patch(`/api/services/${service.id}`, { name: value }), {
    success: m.services.saved,
    invalidate: [keys.service(service.id), keys.project(service.projectId)],
    inlineValidation: true,
    onSuccess: onClose,
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={m.services.rename}
      onSubmit={() => {
        const result = validate(m, updateServiceSchema, { name: name.trim() });
        if (result.errors !== null) return setError(result.errors.name);
        save.mutate(name.trim(), { onError: (failure) => setError(fieldErrors(m, failure).name) });
      }}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            {m.common.save}
          </Button>
        </>
      }
    >
      <Field label={m.services.name} error={error}>
        <Input value={name} onChange={(event) => setName(event.target.value)} data-autofocus />
      </Field>
    </Dialog>
  );
}

export function ServiceLayout() {
  const { serviceId = '' } = useParams();
  const { m, t } = useI18n();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const service = useService(serviceId);
  const data = service.data;
  const project = useProject(data?.projectId ?? '');
  const [terminal, setTerminal] = useState(false);
  const [renaming, setRenaming] = useState(false);
  usePageMeta([
    { label: m.nav.projects, to: '/projects' },
    ...(data === undefined ? [] : [{ label: project.data?.project.name ?? '…', to: `/projects/${data.projectId}` }]),
    { label: data?.name ?? '…' },
  ]);
  const remove = useAction((removeData: boolean) => api.delete(`/api/services/${serviceId}?removeData=${removeData}`), {
    success: m.services.deleted,
    invalidate: [keys.project(data?.projectId ?? ''), keys.projects],
    onSuccess: () => void navigate(`/projects/${data?.projectId ?? ''}`),
  });

  if (service.isError) return <NotFound />;
  const base = `/services/${serviceId}`;
  return (
    <div className="page">
      <section className="frame">
        <div className="frame__sheet resource">
          <header className="resource__head">
            <span className="resource__icon">{data !== undefined && <ServiceMark type={data.type} />}</span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="resource__title">
                <h1 className="truncate">{data?.name ?? <Skeleton width={180} height={26} />}</h1>
                {data !== undefined && <Status kind="service" status={data.status} />}
              </div>
              {data !== undefined && (
                <div className="resource__meta">
                  <span>{data.type === 'files' ? m.project.databaseLabel.files : `${m.project.databaseLabel[data.type]} ${data.version}`}</span>
                  <code>
                    {data.internalHost}:{data.internalPort}
                  </code>
                  <span className="row" style={{ gap: 5 }}>
                    <Server aria-hidden="true" />
                    {data.serverName}
                  </span>
                </div>
              )}
            </div>
            {data !== undefined && (
              <div className="resource__actions">
                <Menu trigger={(props) => <Button {...props} iconOnly icon={<Ellipsis />}>{m.common.more}</Button>}>
                  <MenuItem icon={<Pencil />} onSelect={() => setRenaming(true)}>
                    {m.services.rename}
                  </MenuItem>
                  <MenuItem icon={<SquareTerminal />} onSelect={() => setTerminal(true)}>
                    {m.deploySettings.terminal}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    icon={<Trash2 />}
                    danger
                    onSelect={async () => {
                      const result = await confirm({ title: m.services.delete, text: m.services.deleteText, confirmLabel: m.common.delete, danger: true, typeToConfirm: data.name, checkbox: { label: m.services.deleteData } });
                      if (result.confirmed) remove.mutate(result.checked);
                    }}
                  >
                    {m.services.delete}
                  </MenuItem>
                </Menu>
              </div>
            )}
          </header>
          {data?.status === 'failed' && data.statusMessage !== null && (
            <div className="resource__notice">
              <Callout tone="bad">
                <Reason kind="service" code={data.statusReason} message={data.statusMessage} />
              </Callout>
            </div>
          )}
          <div className="resource__tabs">
            <RouteTabs
              label={data?.name ?? ''}
              items={
                data?.type === 'files'
                  ? [
                      { to: `${base}/general`, label: m.fileStore.tabs.general },
                      { to: `${base}/files`, label: m.fileStore.tabs.files },
                      { to: `${base}/keys`, label: m.fileStore.tabs.keys },
                      { to: `${base}/domains`, label: m.fileStore.tabs.domains },
                      { to: `${base}/docs`, label: m.fileStore.tabs.docs },
                      { to: `${base}/logs`, label: m.services.tabs.logs },
                      { to: `${base}/monitoring`, label: m.services.tabs.monitoring },
                      { to: `${base}/advanced`, label: m.services.tabs.advanced },
                    ]
                  : [
                      { to: `${base}/general`, label: m.services.tabs.general },
                      { to: `${base}/logs`, label: m.services.tabs.logs },
                      { to: `${base}/monitoring`, label: m.services.tabs.monitoring },
                      { to: `${base}/backups`, label: m.services.tabs.backups },
                      { to: `${base}/advanced`, label: m.services.tabs.advanced },
                    ]
              }
            />
          </div>
          <div className="resource__body">{data === undefined ? <Skeleton height={240} /> : <Outlet context={{ service: data, openTerminal: () => setTerminal(true) } satisfies ServiceOutlet} />}</div>
        </div>
      </section>
      {data !== undefined && (
        <>
          <Dialog open={terminal} onClose={() => setTerminal(false)} xl title={t(m.deploySettings.terminalTitle, { name: data.name })}>
            {terminal && <ServiceTerminal service={data} />}
          </Dialog>
          <RenameDialog service={data} open={renaming} onClose={() => setRenaming(false)} />
        </>
      )}
    </div>
  );
}
