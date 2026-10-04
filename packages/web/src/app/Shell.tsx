/**
 * The authenticated application frame: sidebar, top bar with breadcrumbs,
 * command palette and the realtime connection.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, ChevronsUpDown, FolderKanban, LayoutDashboard, LogOut, Menu as MenuIcon, Plus, Search, Server, Settings, UserRound } from 'lucide-react';
import { LOCALES, THEMES, type BootstrapDto } from '@ploy/shared';
import { CommandPalette, usePaletteShortcut } from '../components/CommandPalette.tsx';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../components/Menu.tsx';
import { useCrumbsValue } from '../components/PageMeta.tsx';
import { Avatar, BrandMark, Button, Kbd, Segmented } from '../components/ui.tsx';
import { LOCALE_NAMES, useI18n } from '../i18n/index.tsx';
import { api } from '../lib/api.ts';
import { useProjects } from '../lib/queries.ts';
import { useRealtime } from '../lib/realtime.ts';
import { useTheme } from '../lib/theme.tsx';
import { NewProjectDialog } from '../pages/projects/NewProjectDialog.tsx';
import { useToast } from '../components/Toast.tsx';

const PROJECT_COLORS = ['#2746C7', '#0C9A8A', '#D18A00', '#C73340', '#7A4FD0', '#2F7FC1', '#B85C38', '#4F8A3C'];

export function projectColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PROJECT_COLORS[hash % PROJECT_COLORS.length]!;
}

export function Shell({ bootstrap }: { bootstrap: BootstrapDto }) {
  const { m, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const toast = useToast();
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const crumbs = useCrumbsValue();
  const projects = useProjects();
  const live = useRealtime(bootstrap.currentTeamId);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const user = bootstrap.user!;
  const team = bootstrap.teams.find((candidate) => candidate.id === bootstrap.currentTeamId) ?? bootstrap.teams[0];

  usePaletteShortcut(useCallback(() => setPalette(true), []));
  useEffect(() => setDrawer(false), [location.pathname]);

  const persist = (patch: { locale?: string; theme?: string }) => void api.patch('/api/me', patch).catch(() => undefined);

  const switchTeam = async (teamId: string) => {
    try {
      await api.post('/api/me/team', { teamId });
      client.clear();
      await navigate('/');
    } catch (error) {
      toast.error(error);
    }
  };

  const signOut = async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    client.clear();
    await navigate('/login');
  };

  return (
    <div className="shell" data-drawer={drawer ? 'open' : undefined}>
      <a className="skip-link" href="#main">
        {m.nav.skipToContent}
      </a>
      <aside className="sidebar" aria-label={m.nav.menu}>
        <div className="sidebar__top">
          <Menu
            align="start"
            label={m.nav.teams}
            trigger={(props) => (
              <button className="team-switch" type="button" {...props} aria-label={m.nav.switchTeam}>
                <BrandMark />
                <span className="team-switch__text">
                  <span className="team-switch__name">{team?.name ?? 'TorexPloy'}</span>
                  <span className="team-switch__role">{team === undefined ? '' : m.roles[team.role]}</span>
                </span>
                <ChevronsUpDown aria-hidden="true" />
              </button>
            )}
          >
            <MenuLabel>{m.nav.teams}</MenuLabel>
            {bootstrap.teams.map((candidate) => (
              <MenuItem key={candidate.id} icon={candidate.id === team?.id ? <Check /> : <span style={{ width: 15 }} />} onSelect={() => void switchTeam(candidate.id)}>
                {candidate.name}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem icon={<Plus />} onSelect={() => void navigate('/settings/team?new=1')}>
              {m.nav.createTeam}
            </MenuItem>
          </Menu>
          <button type="button" className="search-trigger" onClick={() => setPalette(true)}>
            <Search aria-hidden="true" />
            <span>{m.nav.search}</span>
            <Kbd>{navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K'}</Kbd>
          </button>
        </div>

        <nav className="sidebar__nav">
          <NavLink className="nav-link" to="/" end>
            <LayoutDashboard aria-hidden="true" />
            {m.nav.overview}
          </NavLink>
          <NavLink className="nav-link" to="/projects" end>
            <FolderKanban aria-hidden="true" />
            {m.nav.projects}
            {projects.data !== undefined && <span className="nav-link__count">{projects.data.length}</span>}
          </NavLink>
          <NavLink className="nav-link" to="/servers">
            <Server aria-hidden="true" />
            {m.nav.servers}
          </NavLink>
          <NavLink className="nav-link" to="/settings">
            <Settings aria-hidden="true" />
            {m.nav.settings}
          </NavLink>
        </nav>

        <div className="sidebar__group">
          <div className="sidebar__group-title">
            <span>{m.nav.projectsGroup}</span>
            <Button variant="ghost" size="sm" iconOnly icon={<Plus />} onClick={() => setNewProject(true)}>
              {m.nav.newProject}
            </Button>
          </div>
          {(projects.data ?? []).slice(0, 30).map((project) => (
            <NavLink key={project.id} to={`/projects/${project.id}`} className="sidebar__project">
              <span className="project-dot" style={{ ['--project-color' as string]: projectColor(project.id) }} aria-hidden="true" />
              <span className="truncate">{project.name}</span>
            </NavLink>
          ))}
        </div>

        <div className="sidebar__foot">
          <Menu
            align="start"
            label={m.nav.profile}
            trigger={(props) => (
              <button className="user-button" type="button" {...props}>
                <Avatar name={user.name} src={user.avatarUrl} />
                <span className="user-button__text">
                  <span className="user-button__name">{user.name}</span>
                  <span className="user-button__email">{user.email}</span>
                </span>
                <ChevronsUpDown aria-hidden="true" width={15} height={15} />
              </button>
            )}
          >
            <MenuItem icon={<UserRound />} onSelect={() => void navigate('/settings/profile')}>
              {m.nav.profile}
            </MenuItem>
            <MenuSeparator />
            <MenuLabel>{m.nav.theme}</MenuLabel>
            <div style={{ padding: '2px 6px 6px' }}>
              <Segmented
                label={m.nav.theme}
                value={theme}
                onChange={(value) => {
                  setTheme(value);
                  persist({ theme: value });
                }}
                options={THEMES.map((value) => ({ value, label: m.theme[value] }))}
              />
            </div>
            <MenuLabel>{m.nav.language}</MenuLabel>
            {LOCALES.map((value) => (
              <MenuItem
                key={value}
                icon={value === locale ? <Check /> : <span style={{ width: 15 }} />}
                onSelect={() => {
                  void setLocale(value);
                  persist({ locale: value });
                }}
              >
                {LOCALE_NAMES[value]}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem icon={<LogOut />} onSelect={() => void signOut()}>
              {m.nav.signOut}
            </MenuItem>
          </Menu>
        </div>
      </aside>
      <div className="drawer-backdrop" onClick={() => setDrawer(false)} aria-hidden="true" />

      <div className="main">
        <header className="topbar">
          <Button className="topbar__menu" variant="ghost" iconOnly icon={<MenuIcon />} onClick={() => setDrawer(true)}>
            {m.nav.menu}
          </Button>
          <nav className="crumbs" aria-label="breadcrumb">
            {crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1;
              return (
                <span key={`${crumb.label}-${index}`} className="row" style={{ gap: 6, minWidth: 0 }}>
                  {index > 0 && <ChevronRight aria-hidden="true" />}
                  {last || crumb.to === undefined ? (
                    <span className="truncate" aria-current={last ? 'page' : undefined}>
                      {crumb.label}
                    </span>
                  ) : (
                    <Link className="truncate" to={crumb.to}>
                      {crumb.label}
                    </Link>
                  )}
                </span>
              );
            })}
          </nav>
          <span className="live-indicator" data-state={live} title={live === 'open' ? m.nav.live : m.nav.reconnecting}>
            {live === 'open' ? m.nav.live : live === 'reconnecting' ? m.nav.reconnecting : ''}
          </span>
        </header>
        <main id="main" tabIndex={-1} style={{ outline: 'none' }}>
          <Outlet />
        </main>
      </div>

      <CommandPalette open={palette} onClose={() => setPalette(false)} onNewProject={() => setNewProject(true)} />
      <NewProjectDialog open={newProject} onClose={() => setNewProject(false)} />
    </div>
  );
}
