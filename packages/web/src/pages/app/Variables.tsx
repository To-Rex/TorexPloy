import { useState } from 'react';
import { Database, Link2, Unlink } from 'lucide-react';
import { createLinkSchema } from '@ploy/shared';
import { Dialog } from '../../components/Dialog.tsx';
import { EnvEditor } from '../../components/EnvEditor.tsx';
import { Button, Field, Input, Select, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useAppVariables, useLinks, useProject } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { useAppContext } from './AppLayout.tsx';

export function VariablesTab() {
  const app = useAppContext();
  const { m } = useI18n();
  const variables = useAppVariables(app.id);
  const links = useLinks(app.id);
  const project = useProject(app.projectId);
  const [linking, setLinking] = useState(false);
  const [serviceId, setServiceId] = useState('');
  const [prefix, setPrefix] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const invalidate = [keys.appPart(app.id, 'variables'), keys.appPart(app.id, 'links'), keys.app(app.id), keys.project(app.projectId)];

  const save = useAction((list: { key: string; value: string }[]) => api.put(`/api/applications/${app.id}/variables`, { variables: list }), { success: m.variables.saved, invalidate });
  const link = useAction((input: { serviceId: string; prefix: string }) => api.post(`/api/applications/${app.id}/links`, input), {
    success: m.variables.linked,
    invalidate,
    onSuccess: () => {
      setLinking(false);
      setPrefix('');
    },
  });
  const unlink = useAction((linkId: string) => api.delete(`/api/applications/${app.id}/links/${linkId}`), { success: m.variables.unlinked, invalidate });

  const linkedIds = new Set((links.data ?? []).map((item) => item.serviceId));
  const candidates = (project.data?.services ?? []).filter((service) => service.serverId === app.serverId && !linkedIds.has(service.id));

  return (
    <>
      <div className="section">
        <div className="section__intro">
          <h2>{m.variables.title}</h2>
          <p>{m.variables.hint}</p>
          <p>{m.variables.referenceHint}</p>
        </div>
        {variables.data === undefined ? (
          <Skeleton height={160} />
        ) : (
          <EnvEditor variables={variables.data.variables} inherited={variables.data.inherited} onSave={(list) => save.mutateAsync(list)} saving={save.isPending} />
        )}
      </div>
      <div className="section">
        <div className="section__intro">
          <h2>{m.variables.links}</h2>
          <p>{m.variables.linksHint}</p>
        </div>
        <div className="stack" style={{ gap: 12 }}>
          {(links.data ?? []).length > 0 && (
            <div className="list">
              {links.data!.map((item) => (
                <div key={item.id} className="list__row">
                  <Database width={18} height={18} className="faint" aria-hidden="true" />
                  <div className="grow">
                    <div className="list__title">{item.serviceName}</div>
                    <div className="list__meta">
                      {item.keys.slice(0, 6).map((key) => (
                        <code key={key}>{key}</code>
                      ))}
                      {item.keys.length > 6 && <span>+{item.keys.length - 6}</span>}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" icon={<Unlink />} onClick={() => unlink.mutate(item.id)}>
                    {m.variables.unlink}
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div>
            <Button
              icon={<Link2 />}
              disabled={candidates.length === 0}
              title={candidates.length === 0 ? m.variables.noServices : undefined}
              onClick={() => {
                setServiceId(candidates[0]?.id ?? '');
                setLinking(true);
              }}
            >
              {m.variables.link}
            </Button>
            {candidates.length === 0 && (links.data ?? []).length === 0 && <p className="field__hint" style={{ marginTop: 8 }}>{m.variables.noServices}</p>}
          </div>
        </div>
      </div>
      <Dialog
        open={linking}
        onClose={() => setLinking(false)}
        title={m.variables.linkTitle}
        onSubmit={() => {
          const result = validate(m, createLinkSchema, { serviceId, prefix });
          if (result.errors !== null) {
            setErrors(result.errors);
            return;
          }
          link.mutate(result.data as { serviceId: string; prefix: string });
        }}
        footer={
          <>
            <Button onClick={() => setLinking(false)}>{m.common.cancel}</Button>
            <Button type="submit" variant="primary" busy={link.isPending}>
              {m.variables.link}
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label={m.variables.service}>
            <Select value={serviceId} onChange={(event) => setServiceId(event.target.value)}>
              {candidates.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name} ({service.type})
                </option>
              ))}
            </Select>
          </Field>
          <Field label={m.variables.prefix} optional={m.common.optional} hint={m.variables.prefixHint} error={errors.prefix}>
            <Input mono value={prefix} onChange={(event) => setPrefix(event.target.value.toUpperCase())} placeholder="CACHE_" spellCheck={false} />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
