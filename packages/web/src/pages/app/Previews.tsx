/**
 * Pull request previews (Dokploy's "Preview Deployments"): every open pull
 * request of the repository gets its own copy of the app on its own
 * address, rebuilt on each push and removed when the pull request closes.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Ellipsis, ExternalLink, GitPullRequest, RotateCcw, ScrollText, Trash2 } from 'lucide-react';
import { updateApplicationSchema, type ApplicationDto, type PreviewSettingsDto } from '@ploy/shared';
import { useConfirm } from '../../components/Dialog.tsx';
import { Card, SaveFooter } from '../../components/Frame.tsx';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu.tsx';
import { Status } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Button, Callout, Field, Input, Skeleton, SkeletonRows, Switch, Textarea } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, usePreviews, usePreviewSettings } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { useAppContext } from './AppLayout.tsx';

/** Previews run only for GitHub web apps (pull request events come from the GitHub app). */
export function supportsPreviews(app: ApplicationDto): boolean {
  return app.kind === 'web' && app.source.type === 'github' && app.parentApplicationId === null;
}

interface Draft {
  enabled: boolean;
  limit: string;
  env: string;
}

const draftFrom = (settings: PreviewSettingsDto): Draft => ({ enabled: settings.enabled, limit: String(settings.limit), env: settings.env });

function SettingsCard({ app, settings }: { app: ApplicationDto; settings: PreviewSettingsDto }) {
  const { m } = useI18n();
  const p = m.previews;
  const [draft, setDraft] = useState<Draft>(() => draftFrom(settings));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const signature = JSON.stringify(settings);
  useEffect(() => setDraft(draftFrom(settings)), [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const initial = draftFrom(settings);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const save = useAction((input: { previewsEnabled: boolean; previewLimit: number; previewEnv: string }) => api.patch(`/api/applications/${app.id}`, input), {
    success: p.saved,
    invalidate: [keys.app(app.id), keys.appPart(app.id, 'preview-settings')],
    inlineValidation: true,
  });
  const submit = () => {
    const payload = { previewsEnabled: draft.enabled, previewLimit: Number(draft.limit), previewEnv: draft.env };
    const result = validate(m, updateApplicationSchema, payload);
    if (result.errors !== null) return setErrors(result.errors);
    setErrors({});
    save.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
  };

  return (
    <Card title={p.settingsTitle} description={p.settingsHint} footer={<SaveFooter dirty={dirty} saving={save.isPending} onSave={submit} onReset={() => setDraft(initial)} />}>
      {!settings.webhookReady && <Callout tone="work" title={p.webhookTitle}>{p.webhookText}</Callout>}
      <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={p.enable} hint={p.enableHint} />
      <div className="form-grid">
        <Field label={p.limit} hint={p.limitHint} error={errors.previewLimit}>
          <Input value={draft.limit} onChange={(event) => setDraft({ ...draft, limit: event.target.value.replace(/\D/g, '') })} inputMode="numeric" style={{ maxWidth: 160 }} />
        </Field>
      </div>
      <Field label={p.env} optional={m.common.optional} hint={p.envHint} error={errors.previewEnv ?? errors.previewsEnabled}>
        <Textarea mono rows={5} value={draft.env} onChange={(event) => setDraft({ ...draft, env: event.target.value })} placeholder={'APP_ENV=preview\nPAYMENTS_SANDBOX=true'} spellCheck={false} />
      </Field>
    </Card>
  );
}

function PreviewList({ app }: { app: ApplicationDto }) {
  const { m, t } = useI18n();
  const p = m.previews;
  const confirm = useConfirm();
  const previews = usePreviews(app.id);
  const invalidate = [keys.appPart(app.id, 'previews')];
  const redeploy = useAction((id: string) => api.post(`/api/applications/${app.id}/previews/${id}/redeploy`), { success: m.app.deployQueued, invalidate });
  const remove = useAction((id: string) => api.delete(`/api/applications/${app.id}/previews/${id}`), { success: p.deleted, invalidate });
  const items = previews.data ?? [];

  return (
    <Card title={p.listTitle} description={p.listHint} flush={items.length > 0}>
      {previews.isPending ? (
        <SkeletonRows rows={2} />
      ) : items.length === 0 ? (
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{app.previewsEnabled ? p.emptyEnabled : p.emptyDisabled}</p>
      ) : (
        <div className="list">
          {items.map((preview) => (
            <div key={preview.id} className="list__row">
              <span className="kind-mark">
                <GitPullRequest aria-hidden="true" />
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <a className="list__title truncate" href={preview.url} target="_blank" rel="noreferrer noopener" style={{ color: 'inherit' }}>
                    #{preview.number} {preview.title}
                  </a>
                </div>
                <div className="list__meta">
                  <code>{preview.branch}</code>
                  {preview.author !== null && <span>{t(p.by, { name: preview.author })}</span>}
                  {preview.appUrl !== null && (
                    <a href={preview.appUrl} target="_blank" rel="noreferrer noopener" className="truncate">
                      {preview.appUrl.replace(/^https?:\/\//, '')}
                    </a>
                  )}
                  <span>
                    <RelativeTime value={preview.updatedAt} />
                  </span>
                </div>
              </div>
              <Status kind="app" status={preview.status} />
              {preview.appUrl !== null && (
                <a className="btn btn--sm" href={preview.appUrl} target="_blank" rel="noreferrer noopener" style={{ textDecoration: 'none' }}>
                  <ExternalLink aria-hidden="true" />
                  {m.app.open}
                </a>
              )}
              <Menu trigger={(props) => <Button {...props} variant="ghost" size="sm" iconOnly icon={<Ellipsis />}>{m.common.actions}</Button>}>
                <MenuItem icon={<ScrollText />} href={`/apps/${preview.id}/logs`}>
                  {p.openApp}
                </MenuItem>
                <MenuItem icon={<RotateCcw />} onSelect={() => redeploy.mutate(preview.id)}>
                  {p.redeploy}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  icon={<Trash2 />}
                  danger
                  onSelect={async () => {
                    const result = await confirm({ title: p.deleteTitle, text: t(p.deleteText, { number: preview.number }), confirmLabel: m.common.delete, danger: true });
                    if (result.confirmed) remove.mutate(preview.id);
                  }}
                >
                  {m.common.delete}
                </MenuItem>
              </Menu>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function PreviewsTab() {
  const app = useAppContext();
  const { m } = useI18n();
  const settings = usePreviewSettings(app.id, supportsPreviews(app));
  if (!supportsPreviews(app)) return <Callout tone="info">{m.previews.unsupported}</Callout>;
  return (
    <>
      {settings.data === undefined ? <Skeleton height={220} /> : <SettingsCard app={app} settings={settings.data} />}
      <PreviewList app={app} />
    </>
  );
}

/** On a preview's own page: which pull request it is and where its parent lives. */
export function PreviewBanner({ app }: { app: ApplicationDto }) {
  const { m, t } = useI18n();
  if (app.pullRequest === null || app.parentApplicationId === null) return null;
  return (
    <Callout
      tone="info"
      title={t(m.previews.bannerTitle, { number: app.pullRequest.number, title: app.pullRequest.title })}
      action={
        <Link className="btn btn--sm" to={`/apps/${app.parentApplicationId}/previews`} style={{ textDecoration: 'none' }}>
          {m.previews.bannerParent}
        </Link>
      }
    >
      {m.previews.bannerHint}{' '}
      <a href={app.pullRequest.url} target="_blank" rel="noreferrer noopener">
        {m.previews.bannerOpenPr}
      </a>
    </Callout>
  );
}
