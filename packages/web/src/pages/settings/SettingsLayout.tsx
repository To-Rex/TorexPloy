import { NavLink, Outlet } from 'react-router';
import { GitBranch, KeyRound, ScrollText, Server, Shield, UserRound, Users } from 'lucide-react';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useBootstrap } from '../../lib/queries.ts';

export function SettingsLayout() {
  const { m } = useI18n();
  const bootstrap = useBootstrap();
  const user = bootstrap.data?.user;
  const role = bootstrap.data?.teams.find((team) => team.id === bootstrap.data?.currentTeamId)?.role;
  const admin = role === 'admin' || role === 'owner';
  usePageMeta([{ label: m.settings.title }]);
  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head__text">
          <h1>{m.settings.title}</h1>
        </div>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={m.settings.title}>
          <div className="settings-nav__group">{m.settings.account}</div>
          <NavLink className="nav-link" to="profile">
            <UserRound aria-hidden="true" />
            {m.settings.nav.profile}
          </NavLink>
          <NavLink className="nav-link" to="security">
            <Shield aria-hidden="true" />
            {m.settings.nav.security}
          </NavLink>
          <div className="settings-nav__group">{m.settings.workspace}</div>
          <NavLink className="nav-link" to="team">
            <Users aria-hidden="true" />
            {m.settings.nav.team}
          </NavLink>
          <NavLink className="nav-link" to="git">
            <GitBranch aria-hidden="true" />
            {m.settings.nav.git}
          </NavLink>
          <NavLink className="nav-link" to="tokens">
            <KeyRound aria-hidden="true" />
            {m.settings.nav.tokens}
          </NavLink>
          {admin && (
            <NavLink className="nav-link" to="audit">
              <ScrollText aria-hidden="true" />
              {m.settings.nav.audit}
            </NavLink>
          )}
          {user?.isInstanceAdmin === true && (
            <>
              <div className="settings-nav__group">{m.settings.instance}</div>
              <NavLink className="nav-link" to="platform">
                <Server aria-hidden="true" />
                {m.settings.nav.platform}
              </NavLink>
            </>
          )}
        </nav>
        <div style={{ minWidth: 0 }}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}

export function SettingsSection({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="section">
      <div className="section__intro">
        <h2>{title}</h2>
        {hint !== undefined && <p>{hint}</p>}
      </div>
      <div className="stack" style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}
