/**
 * The compose file card on a stack's General tab: edited here for a stored
 * stack, read from the repository (with its path editable) for a git-backed one.
 */
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Boxes, FileCode2, Lightbulb, Rocket, Save } from 'lucide-react';
import type { ApplicationDto } from '@ploy/shared';
import { CopyButton } from '../../components/Copy.tsx';
import { Card } from '../../components/Frame.tsx';
import { Button, Callout, Field, Input, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useCompose } from '../../lib/queries.ts';

/** Tab inserts two spaces instead of leaving the field; Shift+Tab still moves focus out. */
function indentOnTab(event: KeyboardEvent<HTMLTextAreaElement>, setValue: (value: string) => void): void {
  if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  const area = event.currentTarget;
  const { selectionStart, selectionEnd, value } = area;
  const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
  setValue(next);
  requestAnimationFrame(() => {
    area.selectionStart = area.selectionEnd = selectionStart + 2;
  });
}

function ServicesStrip({ app, services }: { app: ApplicationDto; services: string[] }) {
  const { m } = useI18n();
  if (services.length === 0) return null;
  return (
    <div className="compose-services">
      <span className="faint" style={{ fontSize: 'var(--text-sm)' }}>{m.compose.services}</span>
      {services.map((service) => {
        const alias = `${app.slug}-${service}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
        return (
          <span key={service} className="chip" title={m.compose.aliasHint}>
            <Boxes aria-hidden="true" />
            {service}
            <code className="faint">{alias}</code>
          </span>
        );
      })}
    </div>
  );
}

export function ComposeFileCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const compose = useCompose(app.id);
  const stored = app.source.type === 'raw';
  const [draft, setDraft] = useState<string | null>(null);
  const [path, setPath] = useState(app.composePath ?? 'docker-compose.yml');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setPath(app.composePath ?? 'docker-compose.yml'), [app.composePath]);

  const content = draft ?? compose.data?.content ?? '';
  const dirty = stored && draft !== null && draft !== compose.data?.content;
  const invalidate = [keys.app(app.id), keys.appPart(app.id, 'compose')];
  const save = useAction((input: { content?: string; composePath?: string }) => api.put(`/api/applications/${app.id}/compose`, input), {
    success: m.compose.saved,
    invalidate,
    inlineValidation: true,
    onSuccess: () => {
      setDraft(null);
      setError(null);
    },
  });
  const deploy = useAction(() => api.post(`/api/applications/${app.id}/deploy`, { clearCache: false }), { success: m.app.deployQueued, invalidate: [...invalidate, keys.appPart(app.id, 'deployments')] });
  const onError = (failure: unknown) => {
    const fields = fieldErrors(m, failure);
    setError(fields.content ?? (failure instanceof ApiError ? failure.message : null));
  };

  const needed = compose.data?.hostAccessNeeded ?? [];

  return (
    <Card title={m.compose.fileTitle} description={stored ? m.compose.fileStoredHint : m.compose.fileRepoHint}>
      {compose.isPending ? (
        <Skeleton height={420} />
      ) : (
        <>
      <ServicesStrip app={app} services={compose.data?.services ?? []} />
      {needed.length > 0 && !app.hostAccess && (
        <Callout tone="work" title={m.compose.hostAccessBlockedTitle}>
          {m.compose.hostAccessBlockedText} <code>{needed.join('; ')}</code>
        </Callout>
      )}

      {stored ? (
        <div className="editor">
          <div className="editor__bar">
            <FileCode2 aria-hidden="true" />
            <span className="grow">docker-compose.yml</span>
            <CopyButton value={content} />
          </div>
          <textarea
            className="editor__area"
            value={content}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => indentOnTab(event, setDraft)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="docker-compose.yml"
            aria-invalid={error !== null || undefined}
            rows={24}
          />
          {error !== null && (
            <p className="editor__error" role="alert">
              {error}
            </p>
          )}
          <div className="editor__foot">
            <p className="faint" style={{ fontSize: 'var(--text-xs)' }}>{m.compose.editorHint}</p>
            <span className="grow" />
            <Button icon={<Save />} disabled={!dirty} busy={save.isPending} onClick={() => save.mutate({ content }, { onError })}>
              {m.common.save}
            </Button>
            <Button
              variant="primary"
              icon={<Rocket />}
              busy={save.isPending || deploy.isPending}
              onClick={() => {
                if (dirty) save.mutate({ content }, { onError, onSuccess: () => deploy.mutate() });
                else deploy.mutate();
              }}
            >
              {dirty ? m.compose.saveAndDeploy : m.app.deploy}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="form-grid" style={{ alignItems: 'end' }}>
            <Field label={m.compose.path} hint={m.compose.pathHint}>
              <Input mono value={path} onChange={(event) => setPath(event.target.value.trim())} spellCheck={false} />
            </Field>
            <div>
              <Button disabled={path === (app.composePath ?? '') || path.length === 0} busy={save.isPending} onClick={() => save.mutate({ composePath: path }, { onError })}>
                {m.common.save}
              </Button>
            </div>
          </div>
          {error !== null && <Callout tone="bad">{error}</Callout>}
          {compose.data?.content == null ? (
            <Callout tone="info">{m.compose.notFetchedYet}</Callout>
          ) : (
            <div className="editor">
              <div className="editor__bar">
                <FileCode2 aria-hidden="true" />
                <span className="grow">{compose.data.path}</span>
                <span className="faint" style={{ fontSize: 'var(--text-xs)' }}>{m.compose.fromRepository}</span>
                <CopyButton value={compose.data.content} />
              </div>
              <pre className="editor__area editor__area--readonly">{compose.data.content}</pre>
            </div>
          )}
        </>
      )}

      <div className="compose-tips">
        <Lightbulb aria-hidden="true" />
        <ul>
          <li>{m.compose.tipVariables}</li>
          <li>{m.compose.tipFiles}</li>
          <li>{m.compose.tipNetwork}</li>
          <li>{m.compose.tipDomains}</li>
        </ul>
      </div>
        </>
      )}
    </Card>
  );
}
