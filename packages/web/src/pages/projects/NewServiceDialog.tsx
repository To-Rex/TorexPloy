/**
 * A new database or service: engine, version, server, and — when wanted —
 * the credentials, public port and memory ceiling chosen by hand instead of
 * generated. Everything left blank is filled in as before.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Database, Dices } from 'lucide-react';
import { createServiceSchema, type ServiceCredentialField, type ServiceDto, type ServiceType } from '@ploy/shared';
import { Dialog } from '../../components/Dialog.tsx';
import { Button, Field, Input, Select, Switch } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useCatalog, useServers } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';

type Credentials = Record<ServiceCredentialField, string>;
const EMPTY: Credentials = { username: '', password: '', database: '', rootPassword: '' };

/** A password that every engine, URL and shell quoting accepts: letters and digits without look-alikes. */
function randomPassword(length = 24): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

export function NewServiceDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const { m, t } = useI18n();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const servers = useServers();
  const [type, setType] = useState<ServiceType>('postgres');
  const [version, setVersion] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [serverId, setServerId] = useState('');
  const [custom, setCustom] = useState(false);
  const [credentials, setCredentials] = useState<Credentials>(EMPTY);
  const [publicPort, setPublicPort] = useState('');
  const [memory, setMemory] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const entry = catalog.data?.find((candidate) => candidate.type === type);
  const fields = entry?.credentialFields ?? [];

  useEffect(() => {
    if (entry !== undefined) setVersion(entry.defaultVersion);
    if (entry !== undefined && !nameTouched) setName(entry.type);
  }, [entry, nameTouched]);
  useEffect(() => {
    if (serverId === '' && servers.data?.[0] !== undefined) setServerId((servers.data.find((server) => server.status === 'ready') ?? servers.data[0]).id);
  }, [servers.data, serverId]);

  const close = () => {
    setNameTouched(false);
    setCustom(false);
    setCredentials(EMPTY);
    setPublicPort('');
    setMemory('');
    setErrors({});
    onClose();
  };
  const setCredential = (field: ServiceCredentialField, value: string) => setCredentials((current) => ({ ...current, [field]: value }));

  const create = useAction((input: Record<string, unknown>) => api.post<ServiceDto>(`/api/projects/${projectId}/services`, input), {
    success: m.services.created,
    invalidate: [keys.project(projectId), keys.projects],
    inlineValidation: true,
    onSuccess: (service) => {
      close();
      void navigate(`/services/${service.id}`);
    },
  });

  const secretField = (field: 'password' | 'rootPassword', label: string, hint: string) => (
    <Field label={label} optional={m.common.optional} hint={errors[`credentials.${field}`] === undefined ? hint : undefined} error={errors[`credentials.${field}`]}>
      <div className="row" style={{ gap: 6 }}>
        <Input mono value={credentials[field]} onChange={(event) => setCredential(field, event.target.value)} autoComplete="off" spellCheck={false} style={{ flex: 1 }} />
        <Button size="sm" icon={<Dices />} onClick={() => setCredential(field, randomPassword())}>
          {m.services.generate}
        </Button>
      </div>
    </Field>
  );

  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title={m.services.newTitle}
      onSubmit={() => {
        // Only the fields this engine has, and only the ones filled in: the rest is generated.
        const chosen = Object.fromEntries(
          fields.filter((field) => credentials[field].trim().length > 0).map((field) => [field, field === 'password' || field === 'rootPassword' ? credentials[field] : credentials[field].trim()]),
        );
        const payload = {
          type,
          name: name.trim(),
          version,
          serverId,
          ...(custom && Object.keys(chosen).length > 0 ? { credentials: chosen } : {}),
          ...(publicPort.trim().length > 0 ? { publicPort: Number(publicPort.trim()) } : {}),
          ...(memory.trim().length > 0 ? { memoryLimitMb: Number(memory.trim()) } : {}),
        };
        const result = validate(m, createServiceSchema, payload);
        if (result.errors !== null) {
          setErrors(result.errors);
          return;
        }
        create.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
      }}
      footer={
        <>
          <Button onClick={close}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" busy={create.isPending}>
            {m.services.create}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 18 }}>
        <div className="field">
          <span className="field__label">{m.services.type}</span>
          <div className="choices" role="radiogroup" aria-label={m.services.type}>
            {(catalog.data ?? []).filter((candidate) => candidate.type !== 'files').map((candidate) => (
              <button key={candidate.type} type="button" role="radio" className="choice" aria-checked={candidate.type === type} onClick={() => setType(candidate.type)}>
                <span className="choice__title">
                  <Database aria-hidden="true" />
                  {candidate.label}
                </span>
                <span className="choice__hint">{m.services.descriptions[candidate.type]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="form-grid">
          <Field label={m.services.name} error={errors.name}>
            <Input value={name} onChange={(event) => { setName(event.target.value); setNameTouched(true); }} />
          </Field>
          <Field label={m.services.version} error={errors.version}>
            <Select value={version} onChange={(event) => setVersion(event.target.value)}>
              {(entry?.versions ?? []).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={m.services.server} error={errors.serverId}>
            <Select value={serverId} onChange={(event) => setServerId(event.target.value)}>
              {(servers.data ?? []).map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="stack" style={{ gap: 12 }}>
          <Switch checked={custom} onChange={setCustom} label={m.services.customCredentials} hint={custom ? m.services.customCredentialsHint : m.services.autoCredentialsHint} />
          {custom && (
            <div className="form-grid">
              {fields.includes('username') && (
                <Field label={m.services.username} optional={m.common.optional} hint={errors['credentials.username'] === undefined ? m.services.usernameHint : undefined} error={errors['credentials.username']}>
                  <Input mono value={credentials.username} onChange={(event) => setCredential('username', event.target.value)} placeholder="app_user" autoComplete="off" spellCheck={false} />
                </Field>
              )}
              {fields.includes('database') && (
                <Field label={m.services.database} optional={m.common.optional} hint={errors['credentials.database'] === undefined ? m.services.databaseHint : undefined} error={errors['credentials.database']}>
                  <Input mono value={credentials.database} onChange={(event) => setCredential('database', event.target.value)} placeholder="app" autoComplete="off" spellCheck={false} />
                </Field>
              )}
              {secretField('password', m.services.password, m.services.passwordHint)}
              {fields.includes('rootPassword') && secretField('rootPassword', m.services.rootPassword, m.services.rootPasswordHint)}
            </div>
          )}
        </div>

        <div className="form-grid">
          <Field label={m.services.publicPort} optional={m.common.optional} hint={errors.publicPort === undefined ? m.services.publicPortCreateHint : undefined} error={errors.publicPort}>
            <Input mono inputMode="numeric" value={publicPort} onChange={(event) => setPublicPort(event.target.value)} placeholder={entry === undefined ? '' : String(entry.port)} />
          </Field>
          <Field label={m.services.memoryLimit} optional={m.common.optional} hint={errors.memoryLimitMb === undefined ? t(m.services.memoryLimitHint, { mb: entry?.memoryMb ?? 0 }) : undefined} error={errors.memoryLimitMb}>
            <Input mono inputMode="numeric" value={memory} onChange={(event) => setMemory(event.target.value)} placeholder={entry === undefined ? '' : String(entry.memoryMb)} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
