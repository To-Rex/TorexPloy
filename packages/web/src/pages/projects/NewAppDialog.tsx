import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Boxes, Container, GitBranch, Lock, Search, Workflow } from 'lucide-react';
import { createApplicationSchema, type ApplicationDto, type AppKind, type CreateApplicationInput } from '@ploy/shared';
import { CopyButton } from '../../components/Copy.tsx';
import { Dialog } from '../../components/Dialog.tsx';
import { Button, Callout, Field, GithubMark, Input, Select } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useBranches, useGithub, useRepositories, useServers } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';

type SourceKind = 'github' | 'git' | 'image';

export function NewAppDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const { m, formatRelative } = useI18n();
  const navigate = useNavigate();
  const github = useGithub();
  const servers = useServers();
  const installations = github.data?.installations ?? [];

  const [source, setSource] = useState<SourceKind>('github');
  const [installationId, setInstallationId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [repository, setRepository] = useState<string | null>(null);
  const [branch, setBranch] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [image, setImage] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [serverId, setServerId] = useState('');
  const [kind, setKind] = useState<AppKind>('web');
  const [rootDirectory, setRootDirectory] = useState('');
  const [port, setPort] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<{ app: ApplicationDto; publicKey: string | null } | null>(null);

  const repositories = useRepositories(source === 'github' ? installationId : null);
  const branches = useBranches(installationId, repository);

  useEffect(() => {
    if (installationId === null && installations.length > 0) setInstallationId(installations[0]!.id);
  }, [installations, installationId]);
  useEffect(() => {
    if (serverId === '' && servers.data !== undefined && servers.data.length > 0) {
      setServerId((servers.data.find((server) => server.status === 'ready') ?? servers.data[0]!).id);
    }
  }, [servers.data, serverId]);
  useEffect(() => {
    if (!open) return;
    if (installations.length === 0 && github.isSuccess) setSource('git');
  }, [open, installations.length, github.isSuccess]);

  const suggestName = (value: string) => {
    if (!nameTouched) setName(value.split('/').pop()?.replace(/\.git$/, '').replace(/[:@].*$/, '') ?? '');
  };

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (repositories.data ?? []).filter((repo) => repo.fullName.toLowerCase().includes(needle)).slice(0, 100);
  }, [repositories.data, search]);

  const reset = () => {
    setRepository(null);
    setBranch('');
    setGitUrl('');
    setImage('');
    setName('');
    setNameTouched(false);
    setRootDirectory('');
    setPort('');
    setErrors({});
    setCreated(null);
    setSearch('');
  };

  const close = () => {
    reset();
    onClose();
  };

  const create = useAction((input: CreateApplicationInput) => api.post<{ application: ApplicationDto; deploymentId: string | null }>(`/api/projects/${projectId}/applications`, input), {
    invalidate: [keys.project(projectId), keys.projects, keys.apps],
    inlineValidation: true,
    onSuccess: async (result) => {
      if (result.deploymentId === null) {
        const key = await api.get<{ publicKey: string | null }>(`/api/applications/${result.application.id}/deploy-key`);
        setCreated({ app: result.application, publicKey: key.publicKey });
        return;
      }
      close();
      void navigate(`/apps/${result.application.id}/deployments`);
    },
  });

  const deployNow = useAction((appId: string) => api.post(`/api/applications/${appId}/deploy`, {}), {
    onSuccess: () => {
      const id = created?.app.id;
      close();
      if (id !== undefined) void navigate(`/apps/${id}/deployments`);
    },
  });

  const submit = () => {
    const sourceInput =
      source === 'github'
        ? { type: 'github' as const, installationId: installationId ?? 0, repository: repository ?? '', branch }
        : source === 'git'
          ? { type: 'git' as const, url: gitUrl.trim(), branch: branch.trim() || 'main' }
          : { type: 'image' as const, image: image.trim() };
    const payload = {
      name: name.trim(),
      serverId,
      kind,
      source: sourceInput,
      ...(rootDirectory.trim().length > 0 ? { build: { rootDirectory: rootDirectory.trim() } } : {}),
      ...(port.trim().length > 0 ? { port: Number(port) } : {}),
    };
    const result = validate(m, createApplicationSchema, payload);
    if (result.errors !== null) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    create.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
  };

  if (created !== null) {
    return (
      <Dialog
        open={open}
        onClose={close}
        title={m.newApp.deployKeyTitle}
        description={m.newApp.deployKeyText}
        footer={
          <>
            <Button onClick={close}>{m.common.close}</Button>
            <Button variant="primary" busy={deployNow.isPending} onClick={() => deployNow.mutate(created.app.id)}>
              {m.newApp.deployNow}
            </Button>
          </>
        }
      >
        <div className="codeblock">
          {created.publicKey}
          <CopyButton value={created.publicKey ?? ''} />
        </div>
      </Dialog>
    );
  }

  const sourceError = errors['source.repository'] ?? errors['source.installationId'];
  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title={m.newApp.title}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={close}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" busy={create.isPending}>
            {source === 'git' && gitUrl.startsWith('git@') ? m.newApp.submitNoDeploy : m.newApp.submit}
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
                { value: 'github', icon: <GithubMark />, label: m.newApp.sourceGithub },
                { value: 'git', icon: <GitBranch />, label: m.newApp.sourceGit },
                { value: 'image', icon: <Container />, label: m.newApp.sourceImage },
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
                }}
              >
                <span className="choice__title">
                  {option.icon}
                  {option.label}
                </span>
              </button>
            ))}
          </div>
        </div>

        {source === 'github' &&
          (installations.length === 0 ? (
            <Callout
              tone="info"
              title={m.newApp.noInstallationsTitle}
              action={
                <Link className="btn btn--sm" to="/settings/git" onClick={close} style={{ textDecoration: 'none' }}>
                  {m.newApp.connectGithub}
                </Link>
              }
            >
              {m.newApp.noInstallationsText}
            </Callout>
          ) : (
            <>
              {installations.length > 1 && (
                <Field label={m.newApp.account}>
                  <Select value={installationId ?? ''} onChange={(event) => { setInstallationId(Number(event.target.value)); setRepository(null); }}>
                    {installations.map((installation) => (
                      <option key={installation.id} value={installation.id}>
                        {installation.accountLogin}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <div className="field">
                <span className="field__label">{m.newApp.repository}</span>
                <label className="input" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Search width={15} height={15} className="faint" aria-hidden="true" />
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={m.newApp.searchRepositories} style={{ border: 0, outline: 0, background: 'transparent', flex: 1, minWidth: 0 }} aria-label={m.newApp.searchRepositories} />
                </label>
                <div className="repo-list" role="listbox" aria-label={m.newApp.repository}>
                  {repositories.isPending ? (
                    <p className="faint" style={{ padding: 12 }}>{m.newApp.loadingRepositories}</p>
                  ) : filtered.length === 0 ? (
                    <p className="faint" style={{ padding: 12 }}>{m.newApp.noRepositories}</p>
                  ) : (
                    filtered.map((repo) => (
                      <button
                        key={repo.id}
                        type="button"
                        role="option"
                        className="repo-option"
                        aria-selected={repository === repo.fullName}
                        onClick={() => {
                          setRepository(repo.fullName);
                          setBranch(repo.defaultBranch);
                          suggestName(repo.fullName);
                        }}
                      >
                        {repo.private ? <Lock width={14} height={14} className="faint" aria-hidden="true" /> : <GitBranch width={14} height={14} className="faint" aria-hidden="true" />}
                        <span className="grow truncate" style={{ fontWeight: 540 }}>{repo.fullName}</span>
                        {repo.language !== null && <span className="faint" style={{ fontSize: 'var(--text-sm)' }}>{repo.language}</span>}
                        {repo.updatedAt !== null && <span className="faint" style={{ fontSize: 'var(--text-sm)' }}>{formatRelative(repo.updatedAt)}</span>}
                      </button>
                    ))
                  )}
                </div>
                {sourceError !== undefined && <p className="field__error">{sourceError}</p>}
              </div>
              {repository !== null && (
                <Field label={m.newApp.branch} error={errors['source.branch']}>
                  <Select value={branch} onChange={(event) => setBranch(event.target.value)}>
                    {(branches.data ?? [branch]).map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </>
          ))}

        {source === 'git' && (
          <div className="form-grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
            <Field label={m.newApp.gitUrl} hint={m.newApp.gitUrlHint} error={errors['source.url']}>
              <Input mono value={gitUrl} onChange={(event) => { setGitUrl(event.target.value); suggestName(event.target.value); }} placeholder="https://github.com/org/app.git" spellCheck={false} autoFocus />
            </Field>
            <Field label={m.newApp.branch} error={errors['source.branch']}>
              <Input mono value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" spellCheck={false} />
            </Field>
          </div>
        )}

        {source === 'image' && (
          <Field label={m.newApp.image} hint={m.newApp.imageHint} error={errors['source.image']}>
            <Input mono value={image} onChange={(event) => { setImage(event.target.value); suggestName(event.target.value.split(':')[0] ?? ''); }} placeholder="nginx:1.27-alpine" spellCheck={false} autoFocus />
          </Field>
        )}

        <div className="form-grid">
          <Field label={m.newApp.name} error={errors.name}>
            <Input value={name} onChange={(event) => { setName(event.target.value); setNameTouched(true); }} />
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

        <div className="field">
          <span className="field__label">{m.newApp.kind}</span>
          <div className="choices" role="radiogroup" aria-label={m.newApp.kind}>
            {(
              [
                { value: 'web', icon: <Boxes />, label: m.newApp.kindWeb, hint: m.newApp.kindWebHint },
                { value: 'worker', icon: <Workflow />, label: m.newApp.kindWorker, hint: m.newApp.kindWorkerHint },
              ] as const
            ).map((option) => (
              <button key={option.value} type="button" role="radio" className="choice" aria-checked={kind === option.value} onClick={() => setKind(option.value)}>
                <span className="choice__title">
                  {option.icon}
                  {option.label}
                </span>
                <span className="choice__hint">{option.hint}</span>
              </button>
            ))}
          </div>
        </div>

        {source !== 'image' &&
          (advanced ? (
            <div className="form-grid">
              <Field label={m.newApp.rootDirectory} hint={m.newApp.rootDirectoryHint} error={errors['build.rootDirectory']}>
                <Input mono value={rootDirectory} onChange={(event) => setRootDirectory(event.target.value)} placeholder="apps/web" spellCheck={false} />
              </Field>
              {kind === 'web' && (
                <Field label={m.newApp.port} hint={m.newApp.portHint} error={errors.port}>
                  <Input value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="3000" />
                </Field>
              )}
            </div>
          ) : (
            <div>
              <Button variant="ghost" size="sm" onClick={() => setAdvanced(true)}>
                {m.newApp.advanced}
              </Button>
            </div>
          ))}
      </div>
    </Dialog>
  );
}
