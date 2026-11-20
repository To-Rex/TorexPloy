/**
 * Choosing a GitHub repository and branch from the connected installations.
 *
 * `RepoBrowser` is the list itself: the account, a search, and the
 * repositories with what tells them apart (visibility, language, last
 * push), driven by the keyboard as well as the mouse. The creation dialogs
 * show it in place (`RepoPicker`); an application's settings show what is
 * chosen and open it in a dialog to change it (`RepoField`).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { BookMarked, Check, ExternalLink, GitBranch, Lock, Search, Settings2 } from 'lucide-react';
import type { GithubInstallationDto, GithubRepositoryDto } from '@ploy/shared';
import { useI18n } from '../i18n/index.tsx';
import { useBranches, useRepositories } from '../lib/queries.ts';
import { Dialog } from './Dialog.tsx';
import { Avatar, Button, Callout, Field, GithubMark, Select, Skeleton } from './ui.tsx';

export interface RepoChoice {
  installationId: number | null;
  repository: string | null;
  branch: string;
}

/** GitHub's own colours for the languages most repositories are written in. */
const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572a5',
  Go: '#00add8',
  Rust: '#dea584',
  Java: '#b07219',
  Kotlin: '#a97bff',
  Swift: '#f05138',
  PHP: '#4f5d95',
  Ruby: '#701516',
  'C#': '#178600',
  'C++': '#f34b7d',
  C: '#555555',
  Dart: '#00b4ab',
  Elixir: '#6e4a7e',
  HTML: '#e34c26',
  CSS: '#563d7c',
  SCSS: '#c6538c',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  Astro: '#ff5a03',
  Shell: '#89e051',
  Dockerfile: '#384d54',
};

function NoInstallations({ onConnect }: { onConnect: () => void }) {
  const { m } = useI18n();
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

/** `text` with the part that matches the search picked out. */
function Marked({ text, needle }: { text: string; needle: string }): ReactNode {
  const at = needle.length === 0 ? -1 : text.toLowerCase().indexOf(needle);
  if (at === -1) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

function RepoBrowser({
  installations,
  installationId,
  onInstallation,
  selected,
  onSelect,
  onConfirm,
  tall = false,
  autoFocus = false,
}: {
  installations: GithubInstallationDto[];
  installationId: number | null;
  onInstallation: (id: number) => void;
  selected: string | null;
  onSelect: (repo: GithubRepositoryDto) => void;
  /** Enter on the chosen repository, or a double click: "this one, go on". */
  onConfirm?: (repo: GithubRepositoryDto) => void;
  /** The roomier list of a dialog made for choosing. */
  tall?: boolean;
  autoFocus?: boolean;
}) {
  const { m, plural, formatRelative } = useI18n();
  const p = m.provider;
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const repositories = useRepositories(installationId);
  const needle = search.trim().toLowerCase();
  const filtered = useMemo(
    () => (repositories.data ?? []).filter((repo) => repo.fullName.toLowerCase().includes(needle) || (repo.description ?? '').toLowerCase().includes(needle)).slice(0, 200),
    [repositories.data, needle],
  );
  const installation = installations.find((candidate) => candidate.id === installationId);

  useEffect(() => setActive(0), [needle, installationId]);
  useEffect(() => {
    list.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (filtered.length > 0) setActive((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length);
    } else if (event.key === 'Enter') {
      // Never the surrounding form's submit: Enter here is about the list.
      event.preventDefault();
      const repo = filtered[active];
      if (repo === undefined) return;
      if (repo.fullName === selected) onConfirm?.(repo);
      else onSelect(repo);
    }
  };

  return (
    <div className="repo-browser" data-tall={tall || undefined}>
      {installations.length > 1 && (
        <div className="repo-accounts" role="group" aria-label={m.newApp.account}>
          {installations.map((candidate) => (
            <button key={candidate.id} type="button" aria-pressed={candidate.id === installationId} onClick={() => onInstallation(candidate.id)}>
              <Avatar name={candidate.accountLogin} src={candidate.avatarUrl} size={20} />
              {candidate.accountLogin}
            </button>
          ))}
        </div>
      )}
      <label className="repo-search">
        <Search aria-hidden="true" />
        <input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={onKeyDown} placeholder={m.newApp.searchRepositories} aria-label={m.newApp.searchRepositories} spellCheck={false} autoComplete="off" {...(autoFocus ? { 'data-autofocus': true } : {})} />
        {repositories.data !== undefined && <span className="repo-search__count tabular">{plural(p.found, filtered.length)}</span>}
      </label>
      <div className="repo-list" role="listbox" aria-label={m.newApp.repository} ref={list}>
        {repositories.isPending ? (
          <div className="repo-list__state" aria-busy="true">
            {[72, 54, 64, 48].map((width) => (
              <div className="repo-option repo-option--ghost" key={width}>
                <Skeleton width={30} height={30} style={{ borderRadius: 8 }} />
                <div className="grow" style={{ display: 'grid', gap: 6 }}>
                  <Skeleton width={`${width}%`} />
                  <Skeleton width={`${width - 22}%`} height={11} />
                </div>
              </div>
            ))}
          </div>
        ) : repositories.isError ? (
          <p className="repo-list__empty">{p.loadFailed}</p>
        ) : filtered.length === 0 ? (
          <p className="repo-list__empty">{m.newApp.noRepositories}</p>
        ) : (
          filtered.map((repo, index) => {
            const [owner, ...rest] = repo.fullName.split('/');
            const chosen = selected === repo.fullName;
            return (
              <button
                key={repo.id}
                type="button"
                role="option"
                className="repo-option"
                aria-selected={chosen}
                data-active={index === active || undefined}
                onClick={() => {
                  setActive(index);
                  onSelect(repo);
                }}
                onDoubleClick={() => onConfirm?.(repo)}
              >
                <span className="repo-option__mark" aria-hidden="true">
                  {repo.private ? <Lock /> : <BookMarked />}
                </span>
                <span className="repo-option__text">
                  <span className="repo-option__name">
                    <span className="repo-option__owner">{owner}/</span>
                    <Marked text={rest.join('/')} needle={needle.includes('/') ? needle.slice(needle.indexOf('/') + 1) : needle} />
                    {repo.private && <span className="repo-option__tag">{p.private}</span>}
                  </span>
                  {repo.description !== null && repo.description.length > 0 && <span className="repo-option__desc">{repo.description}</span>}
                </span>
                <span className="repo-option__meta">
                  {repo.language !== null && (
                    <span className="repo-option__lang">
                      <i style={{ background: LANGUAGE_COLORS[repo.language] ?? 'var(--idle)' }} />
                      {repo.language}
                    </span>
                  )}
                  {repo.updatedAt !== null && <span>{formatRelative(repo.updatedAt)}</span>}
                </span>
                <span className="repo-option__check" aria-hidden="true">
                  {chosen && <Check />}
                </span>
              </button>
            );
          })
        )}
      </div>
      {installation !== undefined && (
        <p className="repo-browser__foot">
          {installation.repositorySelection === 'selected' ? p.missingSelected : p.missing}{' '}
          <a href={`https://github.com/${installation.accountType === 'Organization' ? `organizations/${installation.accountLogin}/` : ''}settings/installations/${installation.id}`} target="_blank" rel="noreferrer noopener">
            {p.manageAccess}
            <ExternalLink aria-hidden="true" />
          </a>
        </p>
      )}
    </div>
  );
}

/** The list in place, with the branch under it: for dialogs that are already about creating something. */
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
  const { m } = useI18n();
  const branches = useBranches(value.installationId, value.repository);

  useEffect(() => {
    if (value.installationId === null && installations.length > 0) onChange({ ...value, installationId: installations[0]!.id });
  }, [installations, value, onChange]);

  if (installations.length === 0) return <NoInstallations onConnect={onConnect} />;

  const sourceError = errors['source.repository'] ?? errors['source.installationId'];
  return (
    <>
      <div className="field">
        <span className="field__label">{m.newApp.repository}</span>
        <RepoBrowser
          installations={installations}
          installationId={value.installationId}
          onInstallation={(installationId) => onChange({ installationId, repository: null, branch: '' })}
          selected={value.repository}
          onSelect={(repo) => onChange({ ...value, repository: repo.fullName, branch: repo.defaultBranch })}
        />
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

function RepoDialog({ open, onClose, installations, value, onPick }: { open: boolean; onClose: () => void; installations: GithubInstallationDto[]; value: RepoChoice; onPick: (next: RepoChoice) => void }) {
  const { m } = useI18n();
  const p = m.provider;
  const [installationId, setInstallationId] = useState<number | null>(value.installationId ?? installations[0]?.id ?? null);
  const [picked, setPicked] = useState<{ repository: string; branch: string } | null>(null);
  const [loadedFor, setLoadedFor] = useState(false);
  // Each opening starts from what is chosen now, not from where the last one was left.
  if (open !== loadedFor) {
    setLoadedFor(open);
    if (open) {
      setInstallationId(value.installationId ?? installations[0]?.id ?? null);
      setPicked(value.repository === null ? null : { repository: value.repository, branch: value.branch });
    }
  }
  const branches = useBranches(installationId, picked?.repository ?? null);
  const confirm = (choice: { repository: string; branch: string } | null) => {
    if (choice === null || installationId === null) return;
    onPick({ installationId, repository: choice.repository, branch: choice.branch });
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={p.repoTitle}
      description={p.repoHint}
      footer={
        <>
          <div className="repo-pick">
            {picked === null ? (
              <span className="repo-pick__none">{p.selectedNone}</span>
            ) : (
              <>
                <GithubMark size={15} />
                <span className="repo-pick__name truncate">{picked.repository}</span>
                <label className="repo-pick__branch">
                  <GitBranch aria-hidden="true" />
                  <span className="sr-only">{m.newApp.branch}</span>
                  <Select value={picked.branch} onChange={(event) => setPicked({ ...picked, branch: event.target.value })}>
                    {(branches.data ?? [picked.branch]).map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </label>
              </>
            )}
          </div>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button variant="primary" disabled={picked === null} onClick={() => confirm(picked)}>
            {p.pick}
          </Button>
        </>
      }
    >
      <RepoBrowser
        tall
        autoFocus
        installations={installations}
        installationId={installationId}
        onInstallation={(id) => {
          setInstallationId(id);
          setPicked(null);
        }}
        selected={picked?.repository ?? null}
        onSelect={(repo) => setPicked({ repository: repo.fullName, branch: repo.defaultBranch })}
        onConfirm={(repo) => confirm(picked?.repository === repo.fullName ? picked : { repository: repo.fullName, branch: repo.defaultBranch })}
      />
    </Dialog>
  );
}

/**
 * The chosen repository as one line: what it is, its branch (changed right
 * there), and a button that opens the list to choose another.
 */
export function RepoField({
  installations,
  value,
  onChange,
  onConnect,
  errors,
}: {
  installations: GithubInstallationDto[];
  value: RepoChoice;
  onChange: (next: RepoChoice) => void;
  onConnect: () => void;
  errors: Record<string, string>;
}) {
  const { m, t, formatRelative } = useI18n();
  const p = m.provider;
  const [open, setOpen] = useState(false);
  const repositories = useRepositories(value.repository === null ? null : value.installationId);
  const branches = useBranches(value.installationId, value.repository);
  if (installations.length === 0) return <NoInstallations onConnect={onConnect} />;

  const details = repositories.data?.find((repo) => repo.fullName === value.repository);
  const [owner, ...rest] = (value.repository ?? '').split('/');
  const error = errors['source.repository'] ?? errors['source.installationId'] ?? errors['source.branch'];
  return (
    <div className="field">
      <span className="field__label">{m.newApp.repository}</span>
      {value.repository === null ? (
        <button type="button" className="repo-empty" onClick={() => setOpen(true)}>
          <span className="repo-card__mark" aria-hidden="true">
            <GithubMark size={18} />
          </span>
          <span className="repo-empty__text">
            <strong>{p.none}</strong>
            <span>{p.noneHint}</span>
          </span>
          <span className="btn btn--primary btn--sm">{p.choose}</span>
        </button>
      ) : (
        <div className="repo-card">
          <span className="repo-card__mark" aria-hidden="true">
            <GithubMark size={18} />
          </span>
          <div className="repo-card__text">
            <a className="repo-card__name" href={`https://github.com/${value.repository}`} target="_blank" rel="noreferrer noopener" title={p.openOnGithub}>
              <span className="repo-option__owner">{owner}/</span>
              {rest.join('/')}
              <ExternalLink aria-hidden="true" />
            </a>
            <span className="repo-card__meta">
              {details === undefined ? null : (
                <>
                  <span>
                    {details.private ? <Lock aria-hidden="true" /> : <BookMarked aria-hidden="true" />}
                    {details.private ? p.private : p.public}
                  </span>
                  {details.language !== null && (
                    <span className="repo-option__lang">
                      <i style={{ background: LANGUAGE_COLORS[details.language] ?? 'var(--idle)' }} />
                      {details.language}
                    </span>
                  )}
                  {details.updatedAt !== null && <span>{t(p.updated, { time: formatRelative(details.updatedAt) })}</span>}
                </>
              )}
            </span>
          </div>
          <label className="repo-card__branch" title={m.newApp.branch}>
            <GitBranch aria-hidden="true" />
            <span className="sr-only">{m.newApp.branch}</span>
            <Select value={value.branch} onChange={(event) => onChange({ ...value, branch: event.target.value })}>
              {(branches.data ?? [value.branch]).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </label>
          <Button icon={<Settings2 />} onClick={() => setOpen(true)}>
            {p.change}
          </Button>
        </div>
      )}
      {error !== undefined && <p className="field__error">{error}</p>}
      <RepoDialog open={open} onClose={() => setOpen(false)} installations={installations} value={value} onPick={onChange} />
    </div>
  );
}
