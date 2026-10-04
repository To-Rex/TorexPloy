/**
 * Settings pages are listed in the sidebar (as Dokploy does); this layout
 * frames the current one with its title and what it is for, and each
 * section inside becomes a card.
 */
import type { ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router';
import { BellRing, CloudUpload, GitBranch, Globe, KeyRound, Package, ScrollText, Settings, Shield, UserRound, Users } from 'lucide-react';
import { Card, Frame } from '../../components/Frame.tsx';
import { usePageMeta } from '../../components/PageMeta.tsx';
import { useI18n } from '../../i18n/index.tsx';

type Page = 'profile' | 'security' | 'team' | 'git' | 'tokens' | 'notifications' | 'storage' | 'registries' | 'platform' | 'audit';

const ICONS: Record<Page, ReactNode> = {
  profile: <UserRound />,
  security: <Shield />,
  team: <Users />,
  git: <GitBranch />,
  tokens: <KeyRound />,
  notifications: <BellRing />,
  storage: <CloudUpload />,
  registries: <Package />,
  platform: <Globe />,
  audit: <ScrollText />,
};

export function SettingsLayout() {
  const { m } = useI18n();
  const location = useLocation();
  const segment = location.pathname.split('/').filter(Boolean)[1] ?? 'profile';
  const page = (segment in ICONS ? segment : 'profile') as Page;
  const title = m.settings.nav[page];
  usePageMeta([{ label: m.settings.title }, { label: title }]);
  return (
    <div className="page">
      <Frame slot icon={ICONS[page] ?? <Settings />} title={title} description={m.settings.pages[page]}>
        <Outlet />
      </Frame>
    </div>
  );
}

export function SettingsSection({ title, hint, actions, children }: { title: string; hint?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card title={title} description={hint} actions={actions}>
      {children}
    </Card>
  );
}
