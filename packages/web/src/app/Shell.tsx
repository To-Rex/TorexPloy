/**
 * The authenticated application frame, laid out the way Dokploy does it: a
 * grouped sidebar (home pages, then settings) that folds into an icon rail,
 * a top bar with the rail toggle, breadcrumbs and search, the command
 * palette and the realtime connection.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowUpCircle,
  BellRing,
  CalendarClock,
  Check,
  ChevronRight,
  ChevronsUpDown,
  CloudUpload,
  Container,
  FolderKanban,
  GitBranch,
  Globe,
  KeyRound,
  LogOut,
  Menu as MenuIcon,
  Network,
  Package,
  PanelLeft,
  Plus,
  Rocket,
  ScrollText,
  Search,
  Server,
  Shield,
  UserRound,
  Users,
} from 'lucide-react';
import { LOCALES, THEMES, roleAtLeast, type BootstrapDto } from '@ploy/shared';
import { CommandPalette, usePaletteShortcut } from '../components/CommandPalette.tsx';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../components/Menu.tsx';
import { useCrumbsValue } from '../components/PageMeta.tsx';
import { Avatar, BrandMark, Button, Kbd, Segmented } from '../components/ui.tsx';
import { LOCALE_NAMES, useI18n } from '../i18n/index.tsx';
import { api } from '../lib/api.ts';
import { useRealtime } from '../lib/realtime.ts';
import { useTheme } from '../lib/theme.tsx';
import { NewProjectDialog } from '../pages/projects/NewProjectDialog.tsx';
import { UpdateDialog } from '../components/UpdateDialog.tsx';
import { useToast } from '../components/Toast.tsx';

const PROJECT_COLORS = ['#2563EB', '#16A34A', '#D97706', '#DC2626', '#7C3AED', '#0891B2', '#C2410C', '#4D7C0F'];

export function projectColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PROJECT_COLORS[hash % PROJECT_COLORS.length]!;
}

const RAIL_KEY = 'ploy.sidebar';

function readRail(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === 'rail';
  } catch {
    return false;
  }
}

function SideLink({ to, icon, label, end = false }: { to: string; icon: ReactNode; label: string; end?: boolean }) {
  return (
    <NavLink className="nav-link" to={to} end={end} title={label}>
      {icon}
      <span className="nav-link__label">{label}</span>
    </NavLink>
  );
}

export function Shell({ bootstrap }: { bootstrap: BootstrapDto }) {
  const { m, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const toast = useToast();
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const crumbs = useCrumbsValue();
  const live = useRealtime(bootstrap.currentTeamId);
  const [drawer, setDrawer] = useState(false);
  const [rail, setRail] = useState(readRail);
  const [palette, setPalette] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const [updates, setUpdates] = useState(false);
  const user = bootstrap.user!;
  const team = bootstrap.teams.find((candidate) => candidate.id === bootstrap.currentTeamId) ?? bootstrap.teams[0];
  const admin = team !== undefined && roleAtLeast(team.role, 'admin');
  const mac = navigator.platform.includes('Mac');

  usePaletteShortcut(useCallback(() => setPalette(true), []));
  useEffect(() => setDrawer(false), [location.pathname]);

  const toggleRail = () =>
    setRail((current) => {
      try {
        localStorage.setItem(RAIL_KEY, current ? 'full' : 'rail');
      } catch {
        // Private windows: the choice lasts for this page only.
      }
      return !current;
    });

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
    <div className="shell" data-drawer={drawer ? 'open' : undefined} data-rail={rail ? '' : undefined}>
      <a className="skip-link" href="#main">
        {m.nav.skipToContent}
      </a>
      <aside className="sidebar" aria-label={m.nav.menu}>
        <div className="sidebar__top">
          <Menu
            align="start"
            label={m.nav.teams}
            trigger={(props) => (
              <button className="team-switch" type="button" {...props} aria-label={m.nav.switchTeam} title={team?.name}>
                <BrandMark />
                <span className="team-switch__text">
                  <span className="team-switch__name">TorexPloy</span>
                  <span className="team-switch__role">{team?.name ?? ''}</span>
                </span>
                <ChevronsUpDown aria-hidden="true" />
              </button>
            )}
          >
            <MenuLabel>{m.nav.teams}</MenuLabel>
            {bootstrap.teams.map((candidate) => (
              <MenuItem key={candidate.id} icon={candidate.id === team?.id ? <Check /> : <span style={{ width: 15 }} />} onSelect={() => void switchTeam(candidate.id)}>
                <span className="menu__rich">
                  <span>{candidate.name}</span>
                  <small>{m.roles[candidate.role]}</small>
                </span>
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem icon={<Plus />} onSelect={() => void navigate('/settings/team?new=1')}>
              {m.nav.createTeam}
            </MenuItem>
          </Menu>
        </div>

        <nav className="sidebar__scroll">
          <div className="sidebar__group">
            <div className="sidebar__label">{m.nav.groupHome}</div>
            <SideLink to="/projects" icon={<FolderKanban aria-hidden="true" />} label={m.nav.projects} />
            <SideLink to="/deployments" icon={<Rocket aria-hidden="true" />} label={m.nav.deployments} />
            <SideLink to="/monitoring" icon={<Activity aria-hidden="true" />} label={m.nav.monitoring} />
            <SideLink to="/schedules" icon={<CalendarClock aria-hidden="true" />} label={m.nav.schedules} />
            {admin && <SideLink to="/docker" icon={<Container aria-hidden="true" />} label={m.nav.docker} />}
            {admin && <SideLink to="/proxy" icon={<Network aria-hidden="true" />} label={m.nav.proxy} />}
          </div>
          <div className="sidebar__group">
            <div className="sidebar__label">{m.nav.groupSettings}</div>
            {user.isInstanceAdmin && <SideLink to="/settings/platform" icon={<Globe aria-hidden="true" />} label={m.settings.nav.platform} />}
            <SideLink to="/servers" icon={<Server aria-hidden="true" />} label={m.nav.servers} />
            <SideLink to="/settings/profile" icon={<UserRound aria-hidden="true" />} label={m.settings.nav.profile} />
            <SideLink to="/settings/security" icon={<Shield aria-hidden="true" />} label={m.settings.nav.security} />
            <SideLink to="/settings/team" icon={<Users aria-hidden="true" />} label={m.settings.nav.team} />
            <SideLink to="/settings/git" icon={<GitBranch aria-hidden="true" />} label={m.settings.nav.git} />
            {admin && <SideLink to="/settings/registries" icon={<Package aria-hidden="true" />} label={m.settings.nav.registries} />}
            {admin && <SideLink to="/settings/storage" icon={<CloudUpload aria-hidden="true" />} label={m.settings.nav.storage} />}
            {admin && <SideLink to="/settings/notifications" icon={<BellRing aria-hidden="true" />} label={m.settings.nav.notifications} />}
            <SideLink to="/settings/tokens" icon={<KeyRound aria-hidden="true" />} label={m.settings.nav.tokens} />
            {admin && <SideLink to="/settings/audit" icon={<ScrollText aria-hidden="true" />} label={m.settings.nav.audit} />}
          </div>
        </nav>

        <div className="sidebar__foot">
          {bootstrap.features.updateAvailable && (
            <button type="button" className="sidebar__update" onClick={() => setUpdates(true)} title={m.updates.available}>
              <ArrowUpCircle aria-hidden="true" />
              <span className="sidebar__update-text">
                <span>{m.updates.available}</span>
                <small>{m.updates.availableHint}</small>
              </span>
            </button>
          )}
          <Menu
            align="start"
            label={m.nav.profile}
            trigger={(props) => (
              <button className="user-button" type="button" {...props} title={user.name}>
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
          <div className="sidebar__version">TorexPloy v{bootstrap.version}</div>
        </div>
      </aside>
      <div className="drawer-backdrop" onClick={() => setDrawer(false)} aria-hidden="true" />

      <div className="main">
        <header className="topbar">
          <Button className="topbar__menu" variant="ghost" size="sm" iconOnly icon={<MenuIcon />} onClick={() => setDrawer(true)}>
            {m.nav.menu}
          </Button>
          <Button className="topbar__rail" variant="ghost" size="sm" iconOnly icon={<PanelLeft />} onClick={toggleRail} aria-pressed={rail}>
            {m.nav.toggleSidebar}
          </Button>
          <span className="topbar__sep" aria-hidden="true" />
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
          <button type="button" className="search-trigger" onClick={() => setPalette(true)}>
            <Search aria-hidden="true" />
            <span>{m.nav.search}</span>
            <Kbd>{mac ? '⌘K' : 'Ctrl K'}</Kbd>
          </button>
          <span className="live-indicator" data-state={live} title={live === 'open' ? m.nav.live : m.nav.reconnecting}>
            <span className="live-indicator__text">{live === 'open' ? m.nav.live : live === 'reconnecting' ? m.nav.reconnecting : ''}</span>
          </span>
        </header>
        <main id="main" tabIndex={-1} style={{ outline: 'none' }}>
          <Outlet />
        </main>
      </div>

      <CommandPalette open={palette} onClose={() => setPalette(false)} onNewProject={() => setNewProject(true)} />
      <NewProjectDialog open={newProject} onClose={() => setNewProject(false)} />
      {admin && <UpdateDialog open={updates} onClose={() => setUpdates(false)} />}
    </div>
  );
}
