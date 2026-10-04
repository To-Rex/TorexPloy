/**
 * ⌘K / Ctrl+K command palette: jump to any project, application, service or
 * server, or run a command — without touching the mouse.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Boxes, FolderKanban, Languages, LayoutDashboard, Moon, Plus, Search, Server, Settings } from 'lucide-react';
import { LOCALES, type Locale } from '@ploy/shared';
import { LOCALE_NAMES, useI18n } from '../i18n/index.tsx';
import { useApplications, useProjects, useServers } from '../lib/queries.ts';
import { useTheme } from '../lib/theme.tsx';

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

const normalize = (value: string): string => value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[ʻʼ'’`]/g, '');

export function CommandPalette({ open, onClose, onNewProject }: { open: boolean; onClose: () => void; onNewProject: () => void }) {
  const { m, t, locale, setLocale } = useI18n();
  const { resolved, setTheme } = useTheme();
  const navigate = useNavigate();
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const projects = useProjects();
  const apps = useApplications();
  const servers = useServers();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      setQuery('');
      setActive(0);
      dialog.showModal();
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (path: string) => () => {
      onClose();
      void navigate(path);
    };
    const nextLocale = LOCALES[(LOCALES.indexOf(locale) + 1) % LOCALES.length] as Locale;
    const list: Item[] = [
      { id: 'p-overview', group: m.palette.pages, label: m.nav.overview, icon: <LayoutDashboard />, run: go('/') },
      { id: 'p-projects', group: m.palette.pages, label: m.nav.projects, icon: <FolderKanban />, run: go('/projects') },
      { id: 'p-servers', group: m.palette.pages, label: m.nav.servers, icon: <Server />, run: go('/servers') },
      { id: 'p-settings', group: m.palette.pages, label: m.nav.settings, icon: <Settings />, run: go('/settings') },
      ...(projects.data ?? []).map((project) => ({ id: project.id, group: m.palette.projects, label: project.name, icon: <FolderKanban />, run: go(`/projects/${project.id}`) })),
      ...(apps.data ?? []).map((app) => ({ id: app.id, group: m.palette.applications, label: app.name, hint: app.url?.replace(/^https?:\/\//, '') ?? m.status.app[app.status], icon: <Boxes />, run: go(`/apps/${app.id}`) })),
      ...(servers.data ?? []).map((server) => ({ id: server.id, group: m.palette.servers, label: server.name, hint: server.host ?? server.publicIp ?? undefined, icon: <Server />, run: go(`/servers/${server.id}`) })),
      { id: 'c-new-project', group: m.palette.commands, label: m.projects.new, icon: <Plus />, run: () => { onClose(); onNewProject(); } },
      { id: 'c-theme', group: m.palette.commands, label: m.palette.toggleTheme, hint: resolved === 'dark' ? m.theme.light : m.theme.dark, icon: <Moon />, run: () => { setTheme(resolved === 'dark' ? 'light' : 'dark'); onClose(); } },
      { id: 'c-language', group: m.palette.commands, label: t(m.palette.language, { language: LOCALE_NAMES[nextLocale] }), icon: <Languages />, run: () => { void setLocale(nextLocale); onClose(); } },
    ];
    return list;
  }, [m, t, projects.data, apps.data, servers.data, resolved, locale, navigate, onClose, onNewProject, setLocale, setTheme]);

  const filtered = useMemo(() => {
    const needle = normalize(query.trim());
    if (needle.length === 0) return items.filter((item) => item.group !== m.palette.applications || items.length < 40);
    return items.filter((item) => normalize(`${item.label} ${item.hint ?? ''}`).includes(needle)).slice(0, 50);
  }, [items, query, m]);

  useEffect(() => setActive(0), [query]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(filtered.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      filtered[active]?.run();
    }
  };

  useEffect(() => {
    document.getElementById(`palette-${filtered[active]?.id ?? ''}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, filtered]);

  let lastGroup = '';
  return (
    <dialog
      ref={ref}
      className="dialog palette"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      aria-label={m.nav.search}
    >
      {open && (
        <>
          <label className="palette__search">
            <Search aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={m.palette.placeholder}
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={filtered[active] ? `palette-${filtered[active]!.id}` : undefined}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <ul className="palette__list" id="palette-list" role="listbox">
            {filtered.length === 0 && <li className="palette__empty">{m.palette.noResults}</li>}
            {filtered.map((item, index) => {
              const header = item.group !== lastGroup ? item.group : null;
              lastGroup = item.group;
              return (
                <li key={item.id} role="presentation">
                  {header !== null && <div className="palette__group">{header}</div>}
                  <div
                    id={`palette-${item.id}`}
                    role="option"
                    aria-selected={index === active}
                    className="palette__item"
                    onPointerMove={() => setActive(index)}
                    onClick={() => item.run()}
                  >
                    {item.icon}
                    <span className="truncate">{item.label}</span>
                    {item.hint !== undefined && <span className="palette__hint truncate">{item.hint}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="palette__foot">{m.palette.hint}</div>
        </>
      )}
    </dialog>
  );
}

export function usePaletteShortcut(open: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
}

