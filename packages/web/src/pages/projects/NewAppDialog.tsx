import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Boxes, Container, FolderUp, GitBranch, Workflow } from 'lucide-react';
import { createApplicationSchema, DEFAULT_BUILD_TYPE, type ApplicationDto, type BuildType, type CreateApplicationInput } from '@ploy/shared';
import { BuilderPicker } from '../../components/Builders.tsx';
import { CopyButton } from '../../components/Copy.tsx';
import { Dialog } from '../../components/Dialog.tsx';
import { RepoPicker } from '../../components/RepoPicker.tsx';
import { UploadDrop } from '../../components/UploadDrop.tsx';
import { Button, Field, GithubMark, Input, Select } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useGithub, useServers } from '../../lib/queries.ts';
import { useArchiveUpload, type Picked } from '../../lib/upload.ts';
import { validate } from '../../lib/validate.ts';

type SourceKind = 'github' | 'git' | 'image' | 'upload';

export function NewAppDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const { m } = useI18n();
  const navigate = useNavigate();
  const github = useGithub();
  const servers = useServers();
  const installations = github.data?.installations ?? [];

  const [source, setSource] = useState<SourceKind>('github');
  const [installationId, setInstallationId] = useState<number | null>(null);
  const [repository, setRepository] = useState<string | null>(null);
  const [branch, setBranch] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [image, setImage] = useState('');
  const [picked, setPicked] = useState<Picked | null>(null);
  const pickedRef = useRef<Picked | null>(null);
  pickedRef.current = picked;
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [serverId, setServerId] = useState('');
  const [kind, setKind] = useState<'web' | 'worker'>('web');
  const [rootDirectory, setRootDirectory] = useState('');
  const [buildType, setBuildType] = useState<BuildType>(DEFAULT_BUILD_TYPE);
  const [port, setPort] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<{ app: ApplicationDto; publicKey: string | null } | null>(null);
  /** An upload application that exists but whose archive has not landed yet (the upload failed; submitting again retries it). */
  const [pendingUpload, setPendingUpload] = useState<ApplicationDto | null>(null);
  const archive = useArchiveUpload();

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

  const reset = () => {
    setRepository(null);
    setBranch('');
    setGitUrl('');
    setImage('');
    setPicked(null);
    setName('');
    setNameTouched(false);
    setRootDirectory('');
    setBuildType(DEFAULT_BUILD_TYPE);
    setPort('');
    setErrors({});
    setCreated(null);
    setPendingUpload(null);
    archive.reset();
  };

  const close = () => {
    if (archive.busy) return;
    reset();
    onClose();
  };

  /** Send the picked folder or zip to a freshly created upload application, then open its deployments. */
  const finishUpload = async (app: ApplicationDto) => {
    const current = pickedRef.current;
    if (current === null) return;
    setPendingUpload(app);
    try {
      await archive.run(app.id, current);
      reset();
      onClose();
      void navigate(`/apps/${app.id}/deployments`);
    } catch {
      // The drop zone shows the reason; submitting again retries the upload for the same application.
    }
  };

  const create = useAction((input: CreateApplicationInput) => api.post<{ application: ApplicationDto; deploymentId: string | null }>(`/api/projects/${projectId}/applications`, input), {
    invalidate: [keys.project(projectId), keys.projects, keys.apps],
    inlineValidation: true,
    onSuccess: async (result) => {
      if (result.application.source.type === 'upload') {
        await finishUpload(result.application);
        return;
      }
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
    if (source === 'upload') {
      if (picked === null) {
        setErrors({ upload: m.upload.needFile });
        return;
      }
      // The application already exists from an attempt whose upload failed: only the upload is retried.
      if (pendingUpload !== null) {
        void finishUpload(pendingUpload);
        return;
      }
    }
    const sourceInput =
      source === 'github'
        ? { type: 'github' as const, installationId: installationId ?? 0, repository: repository ?? '', branch }
        : source === 'git'
          ? { type: 'git' as const, url: gitUrl.trim(), branch: branch.trim() || 'main' }
          : source === 'upload'
            ? { type: 'upload' as const }
            : { type: 'image' as const, image: image.trim() };
    const payload = {
      name: name.trim(),
      serverId,
      kind,
      source: sourceInput,
      ...(source === 'image' ? {} : { build: { buildType, ...(rootDirectory.trim().length > 0 ? { rootDirectory: rootDirectory.trim() } : {}) } }),
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

  const busy = create.isPending || archive.busy;
  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title={m.newApp.title}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={close} disabled={archive.busy}>
            {m.common.cancel}
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {source === 'git' && gitUrl.startsWith('git@') ? m.newApp.submitNoDeploy : pendingUpload !== null ? m.common.retry : m.newApp.submit}
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
                { value: 'upload', icon: <FolderUp />, label: m.newApp.sourceUpload },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                className="choice"
                aria-checked={source === option.value}
                disabled={pendingUpload !== null}
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

        {source === 'github' && (
          <RepoPicker
            installations={installations}
            value={{ installationId, repository, branch }}
            onChange={(next) => {
              setInstallationId(next.installationId);
              if (next.repository !== null && next.repository !== repository) suggestName(next.repository);
              setRepository(next.repository);
              setBranch(next.branch);
            }}
            onConnect={close}
            errors={errors}
          />
        )}

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

        {source === 'upload' && (
          <div className="field">
            <span className="field__label">{m.upload.title}</span>
            <UploadDrop
              picked={picked}
              state={archive.state}
              disabled={busy}
              onPick={(next) => {
                setPicked(next);
                setErrors({});
                archive.reset();
                if (next !== null) suggestName(next.name.replace(/\.zip$/i, ''));
              }}
            />
            {errors.upload !== undefined && <p className="field__error">{errors.upload}</p>}
            <p className="field__hint">{m.newApp.uploadHint}</p>
          </div>
        )}

        <div className="form-grid">
          <Field label={m.newApp.name} error={errors.name}>
            <Input value={name} onChange={(event) => { setName(event.target.value); setNameTouched(true); }} disabled={pendingUpload !== null} />
          </Field>
          <Field label={m.newApp.server} error={errors.serverId}>
            <Select value={serverId} onChange={(event) => setServerId(event.target.value)} disabled={pendingUpload !== null}>
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
              <button key={option.value} type="button" role="radio" className="choice" aria-checked={kind === option.value} disabled={pendingUpload !== null} onClick={() => setKind(option.value)}>
                <span className="choice__title">
                  {option.icon}
                  {option.label}
                </span>
                <span className="choice__hint">{option.hint}</span>
              </button>
            ))}
          </div>
        </div>

        {source !== 'image' && (
          <div className="field">
            <span className="field__label">{m.build.title}</span>
            <BuilderPicker compact value={buildType} onChange={setBuildType} />
            {errors['build.buildType'] !== undefined && <p className="field__error">{errors['build.buildType']}</p>}
          </div>
        )}

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
