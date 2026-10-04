/**
 * A Docker Compose stack: from a file kept in the panel, a GitHub repository
 * or any git URL.
 */
import { useEffect, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { FileCode2, GitBranch, ShieldAlert } from 'lucide-react';
import { createComposeSchema, roleAtLeast, type ApplicationDto, type CreateComposeInput } from '@ploy/shared';
import { Dialog } from '../../components/Dialog.tsx';
import { RepoPicker, type RepoChoice } from '../../components/RepoPicker.tsx';
import { Button, Callout, Checkbox, Field, GithubMark, Input, Select } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useGithub, useRole, useServers } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';

type SourceKind = 'raw' | 'github' | 'git';

const STARTER = `services:
  web:
    image: nginx:alpine
    environment:
      TZ: \${TZ:-Asia/Tashkent}
`;

export function NewComposeDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const { m } = useI18n();
  const navigate = useNavigate();
  const github = useGithub();
  const servers = useServers();
  const role = useRole();
  const admin = role !== null && roleAtLeast(role, 'admin');
  const installations = github.data?.installations ?? [];

  const [source, setSource] = useState<SourceKind>('raw');
  const [content, setContent] = useState(STARTER);
  const [repo, setRepo] = useState<RepoChoice>({ installationId: null, repository: null, branch: '' });
  const [gitUrl, setGitUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [composePath, setComposePath] = useState('docker-compose.yml');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [serverId, setServerId] = useState('');
  const [hostAccess, setHostAccess] = useState<{ needed: string; allow: boolean } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (serverId === '' && servers.data !== undefined && servers.data.length > 0) setServerId((servers.data.find((server) => server.status === 'ready') ?? servers.data[0]!).id);
  }, [servers.data, serverId]);

  const suggestName = (value: string) => {
    if (!nameTouched) setName(value.split('/').pop()?.replace(/\.git$/, '') ?? '');
  };
  const close = () => {
    setSource('raw');
    setContent(STARTER);
    setRepo({ installationId: null, repository: null, branch: '' });
    setGitUrl('');
    setBranch('');
    setComposePath('docker-compose.yml');
    setName('');
    setNameTouched(false);
    setHostAccess(null);
    setErrors({});
    onClose();
  };

  const create = useAction((input: CreateComposeInput) => api.post<{ application: ApplicationDto; deploymentId: string | null }>(`/api/projects/${projectId}/composes`, input), {
    success: m.compose.created,
    invalidate: [keys.project(projectId), keys.projects, keys.apps],
    inlineValidation: true,
    onSuccess: (result) => {
      close();
      void navigate(`/apps/${result.application.id}`);
    },
  });

  const submit = () => {
    const sourceInput =
      source === 'raw'
        ? { type: 'raw' as const, content }
        : source === 'github'
          ? { type: 'github' as const, installationId: repo.installationId ?? 0, repository: repo.repository ?? '', branch: repo.branch }
          : { type: 'git' as const, url: gitUrl.trim(), branch: branch.trim() || 'main' };
    const payload = { name: name.trim(), serverId, source: sourceInput, composePath: composePath.trim() || 'docker-compose.yml', allowHostAccess: hostAccess?.allow === true };
    const result = validate(m, createComposeSchema, payload);
    if (result.errors !== null) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    create.mutate(payload, {
      onError: (error) => {
        if (error instanceof ApiError && error.params.reason === 'compose_host_access') {
          setHostAccess({ needed: error.message.replace(/^[^(]*\(|\)$/g, ''), allow: false });
          return;
        }
        const fields = fieldErrors(m, error);
        setErrors({ ...fields, ...(fields['source.content'] !== undefined ? { content: fields['source.content'] } : {}) });
      },
    });
  };

  const onEditorKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Tab' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    const area = event.currentTarget;
    const at = area.selectionStart;
    setContent(`${content.slice(0, at)}  ${content.slice(area.selectionEnd)}`);
    requestAnimationFrame(() => {
      area.selectionStart = area.selectionEnd = at + 2;
    });
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title={m.compose.newTitle}
      description={m.compose.newSubtitle}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={close}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" busy={create.isPending} disabled={hostAccess !== null && !hostAccess.allow}>
            {m.compose.createAndDeploy}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 18 }}>
        <div className="field">
          <span className="field__label">{m.newApp.source}</span>
          <div className="choices" role="radiogroup" aria-label={m.newApp.source}>
            {(
              [
                { value: 'raw', icon: <FileCode2 />, label: m.compose.sourceRaw, hint: m.compose.sourceRawHint },
                { value: 'github', icon: <GithubMark />, label: m.newApp.sourceGithub, hint: m.compose.sourceRepoHint },
                { value: 'git', icon: <GitBranch />, label: m.newApp.sourceGit, hint: m.compose.sourceRepoHint },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                className="choice"
                aria-checked={source === option.value}
                onClick={() => {
                  setSource(option.value);
                  setErrors({});
                  setHostAccess(null);
                }}
              >
                <span className="choice__title">
                  {option.icon}
                  {option.label}
                </span>
                <span className="choice__hint">{option.hint}</span>
              </button>
            ))}
          </div>
        </div>

        {source === 'raw' && (
          <div className="field">
            <span className="field__label">docker-compose.yml</span>
            <textarea
              className="editor__area editor__area--boxed"
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setHostAccess(null);
              }}
              onKeyDown={onEditorKey}
              rows={14}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label="docker-compose.yml"
              aria-invalid={errors.content !== undefined || undefined}
            />
            {errors.content !== undefined ? <p className="field__error">{errors.content}</p> : <p className="field__hint">{m.compose.editorHint}</p>}
          </div>
        )}

        {source === 'github' && (
          <RepoPicker
            installations={installations}
            value={repo}
            onChange={(next) => {
              if (next.repository !== null && next.repository !== repo.repository) suggestName(next.repository);
              setRepo(next);
            }}
            onConnect={close}
            errors={errors}
          />
        )}

        {source === 'git' && (
          <div className="form-grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
            <Field label={m.newApp.gitUrl} hint={m.newApp.gitUrlHint} error={errors['source.url']}>
              <Input mono value={gitUrl} onChange={(event) => { setGitUrl(event.target.value); suggestName(event.target.value); }} placeholder="https://github.com/org/stack.git" spellCheck={false} data-autofocus />
            </Field>
            <Field label={m.newApp.branch} error={errors['source.branch']}>
              <Input mono value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" spellCheck={false} />
            </Field>
          </div>
        )}

        {source !== 'raw' && (
          <Field label={m.compose.path} hint={m.compose.pathHint} error={errors.composePath}>
            <Input mono value={composePath} onChange={(event) => setComposePath(event.target.value)} spellCheck={false} />
          </Field>
        )}

        <div className="form-grid">
          <Field label={m.newApp.name} error={errors.name}>
            <Input value={name} onChange={(event) => { setName(event.target.value); setNameTouched(true); }} placeholder={m.compose.namePlaceholder} />
          </Field>
          <Field label={m.newApp.server} error={errors.serverId}>
            <Select value={serverId} onChange={(event) => setServerId(event.target.value)}>
              {(servers.data ?? []).map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                  {server.status === 'ready' ? '' : ` (${m.newApp.serverNotReady})`}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {hostAccess !== null && (
          <Callout tone="work" title={m.compose.hostAccessBlockedTitle}>
            <p style={{ marginBottom: 8 }}>
              {m.compose.hostAccessBlockedText} <code>{hostAccess.needed}</code>
            </p>
            {admin ? (
              <Checkbox checked={hostAccess.allow} onChange={(allow) => setHostAccess({ ...hostAccess, allow })} label={m.compose.hostAccessAllow} hint={m.compose.hostAccessWarning} />
            ) : (
              <p className="row" style={{ gap: 6 }}>
                <ShieldAlert width={14} height={14} aria-hidden="true" />
                {m.compose.hostAccessAdminOnly}
              </p>
            )}
          </Callout>
        )}
      </div>
    </Dialog>
  );
}
