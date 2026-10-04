/**
 * Route guards: the dashboard requires a session; setup and sign-in pages
 * are only for visitors without one.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { RefreshCw } from 'lucide-react';
import { BrandMark, Button } from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';
import { errorText } from '../lib/errors.ts';
import { useBootstrap } from '../lib/queries.ts';
import { useTheme } from '../lib/theme.tsx';
import { Shell } from './Shell.tsx';

function Splash() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100dvh' }} aria-busy="true">
      <BrandMark size={36} />
    </div>
  );
}

function Unreachable({ error, retry }: { error: unknown; retry: () => void }) {
  const { m } = useI18n();
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100dvh', padding: 24 }}>
      <div className="stack" style={{ maxWidth: 420, alignItems: 'flex-start' }}>
        <BrandMark size={36} />
        <h1>{m.errors.network}</h1>
        <p className="muted">{errorText(m, error)}</p>
        <Button icon={<RefreshCw />} onClick={retry}>
          {m.common.retry}
        </Button>
      </div>
    </div>
  );
}

/** Apply the profile's language and theme once per session (the profile follows the user across devices). */
function useProfilePreferences(locale: string | undefined, theme: string | undefined): void {
  const { setLocale, locale: current } = useI18n();
  const { setTheme, theme: currentTheme } = useTheme();
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || locale === undefined || theme === undefined) return;
    applied.current = true;
    if (locale !== current && (locale === 'uz' || locale === 'ru' || locale === 'en')) void setLocale(locale);
    if (theme !== currentTheme && (theme === 'light' || theme === 'dark' || theme === 'system')) setTheme(theme);
  }, [locale, theme, current, currentTheme, setLocale, setTheme]);
}

export function AuthedRoot() {
  const bootstrap = useBootstrap();
  const location = useLocation();
  useProfilePreferences(bootstrap.data?.user?.locale, bootstrap.data?.user?.theme);
  if (bootstrap.isPending) return <Splash />;
  if (bootstrap.isError) return <Unreachable error={bootstrap.error} retry={() => void bootstrap.refetch()} />;
  if (bootstrap.data.setupRequired) return <Navigate to="/setup" replace />;
  if (bootstrap.data.user === null) {
    const next = location.pathname === '/' ? '' : `?next=${encodeURIComponent(location.pathname + location.search)}`;
    return <Navigate to={`/login${next}`} replace />;
  }
  return <Shell bootstrap={bootstrap.data} />;
}

export function PublicOnly({ children, allowSignedIn = false }: { children: ReactNode; allowSignedIn?: boolean }) {
  const bootstrap = useBootstrap();
  const location = useLocation();
  if (bootstrap.isPending) return <Splash />;
  if (bootstrap.isError) return <Unreachable error={bootstrap.error} retry={() => void bootstrap.refetch()} />;
  if (bootstrap.data.setupRequired && location.pathname !== '/setup') return <Navigate to="/setup" replace />;
  if (!bootstrap.data.setupRequired && location.pathname === '/setup') return <Navigate to="/" replace />;
  if (bootstrap.data.user !== null && !allowSignedIn) return <Navigate to="/" replace />;
  return <>{children}</>;
}
