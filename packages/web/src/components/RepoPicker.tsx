/**
 * Choosing a GitHub repository and branch from the connected installations,
 * shared by the application and compose creation dialogs.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { GitBranch, Lock, Search } from 'lucide-react';
import type { GithubInstallationDto } from '@ploy/shared';
import { useI18n } from '../i18n/index.tsx';
import { useBranches, useRepositories } from '../lib/queries.ts';
import { Callout, Field, Select } from './ui.tsx';

export interface RepoChoice {
  installationId: number | null;
  repository: string | null;
  branch: string;
}

export function RepoPicker({
  installations,
  value,
  onChange,
  onConnect,
  errors,
}: {
  installations: GithubInstallationDto[];
  value: RepoChoice;
  onChange: (next: RepoChoice) => void;
  /** Called when the user follows the link to connect GitHub (to close the dialog). */
  onConnect: () => void;
  errors: Record<string, string>;
}) {
  const { m, formatRelative } = useI18n();
  const [search, setSearch] = useState('');
  const repositories = useRepositories(value.installationId);
  const branches = useBranches(value.installationId, value.repository);

  useEffect(() => {
    if (value.installationId === null && installations.length > 0) onChange({ ...value, installationId: installations[0]!.id });
  }, [installations, value, onChange]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (repositories.data ?? []).filter((repo) => repo.fullName.toLowerCase().includes(needle)).slice(0, 100);
  }, [repositories.data, search]);

  if (installations.length === 0) {
    return (
      <Callout
        tone="info"
        title={m.newApp.noInstallationsTitle}
        action={
          <Link className="btn btn--sm" to="/settings/git" onClick={onConnect} style={{ textDecoration: 'none' }}>
            {m.newApp.connectGithub}
          </Link>
        }
      >
        {m.newApp.noInstallationsText}
      </Callout>
    );
  }

  const sourceError = errors['source.repository'] ?? errors['source.installationId'];
  return (
    <>
      {installations.length > 1 && (
        <Field label={m.newApp.account}>
          <Select value={value.installationId ?? ''} onChange={(event) => onChange({ installationId: Number(event.target.value), repository: null, branch: '' })}>
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
                aria-selected={value.repository === repo.fullName}
                onClick={() => onChange({ ...value, repository: repo.fullName, branch: repo.defaultBranch })}
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
      {value.repository !== null && (
        <Field label={m.newApp.branch} error={errors['source.branch']}>
          <Select value={value.branch} onChange={(event) => onChange({ ...value, branch: event.target.value })}>
            {(branches.data ?? [value.branch]).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </>
  );
}
