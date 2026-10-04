/**
 * Container registries: logins for private images. Deploys of image-source
 * apps, Dockerfile builds and compose stacks pull with them automatically.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { Ellipsis, Package, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { createRegistrySchema, updateRegistrySchema, type RegistryDto, type RegistryTestDto } from '@ploy/shared';
import { Dialog, useConfirm } from '../../components/Dialog.tsx';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Button, EmptyState, Field, Input, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useRegistries } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { FrameActions } from '../../components/Frame.tsx';

type Provider = 'dockerhub' | 'ghcr' | 'gitlab' | 'custom';

interface Draft {
  name: string;
  serverAddress: string;
  username: string;
  password: string;
}

const PRESETS: Record<Provider, Pick<Draft, 'name' | 'serverAddress'>> = {
  dockerhub: { name: 'Docker Hub', serverAddress: 'docker.io' },
  ghcr: { name: 'GitHub', serverAddress: 'ghcr.io' },
  gitlab: { name: 'GitLab', serverAddress: 'registry.gitlab.com' },
  custom: { name: '', serverAddress: '' },
};

function RegistryDialog({ open, editing, onClose }: { open: boolean; editing: RegistryDto | null; onClose: () => void }) {
  const { m } = useI18n();
  const r = m.registries;
  const [provider, setProvider] = useState<Provider>('dockerhub');
  const [draft, setDraft] = useState<Draft>({ ...PRESETS.dockerhub, username: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const key = open ? (editing?.id ?? 'new') : null;
  if (key !== loadedFor) {
    setLoadedFor(key);
    setErrors({});
    setProvider(editing === null ? 'dockerhub' : 'custom');
    setDraft(editing === null ? { ...PRESETS.dockerhub, username: '', password: '' } : { name: editing.name, serverAddress: editing.serverAddress, username: editing.username, password: '' });
  }
  const set = <K extends keyof Draft>(field: K, value: Draft[K]) => setDraft((current) => ({ ...current, [field]: value }));
  const save = useAction(
    (payload: Record<string, unknown>) => (editing === null ? api.post('/api/registries', payload) : api.patch(`/api/registries/${editing.id}`, payload)),
    { success: r.saved, invalidate: [keys.registries], inlineValidation: true, onSuccess: onClose },
  );
  const submit = () => {
    const payload: Record<string, unknown> = { name: draft.name.trim(), serverAddress: draft.serverAddress.trim(), username: draft.username.trim(), password: draft.password };
    if (editing !== null && draft.password.length === 0) delete payload.password;
    const result = validate(m, editing === null ? createRegistrySchema : updateRegistrySchema, payload);
    if (result.errors !== null) return setErrors(result.errors);
    setErrors({});
    save.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={editing === null ? r.addTitle : r.editTitle}
      description={r.dialogHint}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" icon={<ShieldCheck />} busy={save.isPending}>
            {r.checkAndSave}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 16 }}>
        {editing === null && (
          <div className="field">
            <span className="field__label">{r.provider}</span>
            <div className="choices" role="radiogroup" aria-label={r.provider}>
              {(['dockerhub', 'ghcr', 'gitlab', 'custom'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  className="choice"
                  aria-checked={provider === value}
                  onClick={() => {
                    setProvider(value);
                    setDraft((current) => ({ ...current, ...PRESETS[value] }));
                  }}
                >
                  <span className="choice__title">{r.providers[value]}</span>
                  <span className="choice__hint">{r.providerHints[value]}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="form-grid">
          <Field label={r.name} error={errors.name}>
            <Input value={draft.name} onChange={(event) => set('name', event.target.value)} placeholder={r.namePlaceholder} data-autofocus />
          </Field>
          <Field label={r.serverAddress} hint={r.serverAddressHint} error={errors.serverAddress}>
            <Input mono value={draft.serverAddress} onChange={(event) => set('serverAddress', event.target.value.trim().toLowerCase())} placeholder="registry.example.uz" spellCheck={false} />
          </Field>
        </div>
        <div className="form-grid">
          <Field label={r.username} error={errors.username}>
            <Input mono value={draft.username} onChange={(event) => set('username', event.target.value)} spellCheck={false} autoComplete="off" />
          </Field>
          <Field label={r.password} hint={editing === null ? r.passwordHint : m.notifications.keepCredentials} error={errors.password}>
            <Input mono type="password" value={draft.password} onChange={(event) => set('password', event.target.value)} spellCheck={false} autoComplete="new-password" />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

export function RegistriesPage() {
  const { m, plural } = useI18n();
  const r = m.registries;
  const confirm = useConfirm();
  const toast = useToast();
  const registries = useRegistries();
  const [dialog, setDialog] = useState<{ open: boolean; editing: RegistryDto | null }>({ open: false, editing: null });
  const test = useAction((id: string) => api.post<RegistryTestDto>(`/api/registries/${id}/test`), {
    onSuccess: (result) => (result.ok ? toast.success(r.testOk) : toast.failure(r.testFailed, result.error ?? undefined)),
  });
  const remove = useAction((id: string) => api.delete(`/api/registries/${id}`), { success: r.deleted, invalidate: [keys.registries] });

  return (
    <>
      <FrameActions>
        <Button variant="primary" icon={<Plus />} onClick={() => setDialog({ open: true, editing: null })}>
          {r.add}
        </Button>
      </FrameActions>
      {registries.data === undefined ? (
        <Skeleton height={100} />
      ) : registries.data.length === 0 ? (
        <EmptyState icon={<Package />} title={r.emptyTitle}>
          {r.emptyText}
        </EmptyState>
      ) : (
        <div className="list">
          {registries.data.map((registry) => (
            <div key={registry.id} className="list__row">
              <span className="channel-icon" aria-hidden="true">
                <Package />
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="list__title truncate">{registry.name}</div>
                <div className="list__meta">
                  <code>{registry.serverAddress}</code>
                  <span className="truncate">{registry.username}</span>
                  {registry.applications.length === 0 ? (
                    <span>{r.unused}</span>
                  ) : (
                    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {plural(r.usedBy, registry.applications.length)}
                      {registry.applications.slice(0, 3).map((app) => (
                        <Link key={app.id} to={`/apps/${app.id}/general`}>
                          {app.name}
                        </Link>
                      ))}
                    </span>
                  )}
                </div>
              </div>
              <Button size="sm" icon={<ShieldCheck />} busy={test.isPending && test.variables === registry.id} onClick={() => test.mutate(registry.id)}>
                {r.test}
              </Button>
              <Menu trigger={(props) => <Button {...props} variant="ghost" size="sm" iconOnly icon={<Ellipsis />}>{m.common.actions}</Button>}>
                <MenuItem icon={<Pencil />} onSelect={() => setDialog({ open: true, editing: registry })}>
                  {m.common.edit}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  icon={<Trash2 />}
                  danger
                  onSelect={async () => {
                    const result = await confirm({ title: r.deleteTitle, text: r.deleteText, confirmLabel: m.common.delete, danger: true });
                    if (result.confirmed) remove.mutate(registry.id);
                  }}
                >
                  {m.common.delete}
                </MenuItem>
              </Menu>
            </div>
          ))}
        </div>
      )}
      <RegistryDialog open={dialog.open} editing={dialog.editing} onClose={() => setDialog({ open: false, editing: null })} />
    </>
  );
}
