/** Routes. Every page is a lazily loaded chunk; the shell and the session load once. */
import { createBrowserRouter, Navigate } from 'react-router';
import { AuthedRoot, PublicOnly } from './Gate.tsx';
import { NotFound, RouteError } from './RouteError.tsx';

export const router = createBrowserRouter([
  {
    path: '/setup',
    errorElement: <RouteError />,
    lazy: async () => {
      const { SetupPage } = await import('../pages/auth/Setup.tsx');
      return { element: <PublicOnly><SetupPage /></PublicOnly> };
    },
  },
  {
    path: '/login',
    errorElement: <RouteError />,
    lazy: async () => {
      const { LoginPage } = await import('../pages/auth/Login.tsx');
      return { element: <PublicOnly><LoginPage /></PublicOnly> };
    },
  },
  {
    path: '/invite/:token',
    errorElement: <RouteError />,
    lazy: async () => {
      const { InvitePage } = await import('../pages/auth/Invite.tsx');
      return { element: <PublicOnly allowSignedIn><InvitePage /></PublicOnly> };
    },
  },
  {
    path: '/',
    element: <AuthedRoot />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/projects" replace /> },
      { path: 'projects', lazy: async () => ({ Component: (await import('../pages/projects/Projects.tsx')).ProjectsPage }) },
      { path: 'projects/:projectId', lazy: async () => ({ Component: (await import('../pages/projects/Project.tsx')).ProjectPage }) },
      { path: 'deployments', lazy: async () => ({ Component: (await import('../pages/Deployments.tsx')).DeploymentsPage }) },
      { path: 'monitoring', lazy: async () => ({ Component: (await import('../pages/Monitoring.tsx')).MonitoringPage }) },
      { path: 'schedules', lazy: async () => ({ Component: (await import('../pages/Schedules.tsx')).SchedulesPage }) },
      { path: 'docker', lazy: async () => ({ Component: (await import('../pages/Docker.tsx')).DockerPage }) },
      { path: 'proxy', lazy: async () => ({ Component: (await import('../pages/Proxy.tsx')).ProxyPage }) },
      { path: 'guide', lazy: async () => ({ Component: (await import('../pages/Guide.tsx')).GuidePage }) },
      { path: 'guide/:section', lazy: async () => ({ Component: (await import('../pages/Guide.tsx')).GuidePage }) },
      {
        path: 'apps/:appId',
        lazy: async () => ({ Component: (await import('../pages/app/AppLayout.tsx')).AppLayout }),
        children: [
          { index: true, element: <Navigate to="general" replace /> },
          { path: 'general', lazy: async () => ({ Component: (await import('../pages/app/General.tsx')).GeneralTab }) },
          { path: 'environment', lazy: async () => ({ Component: (await import('../pages/app/Variables.tsx')).EnvironmentTab }) },
          { path: 'domains', lazy: async () => ({ Component: (await import('../pages/app/Domains.tsx')).DomainsTab }) },
          { path: 'deployments', lazy: async () => ({ Component: (await import('../pages/app/Deployments.tsx')).DeploymentsTab }) },
          { path: 'logs', lazy: async () => ({ Component: (await import('../pages/app/Logs.tsx')).LogsTab }) },
          { path: 'monitoring', lazy: async () => ({ Component: (await import('../pages/app/Metrics.tsx')).MonitoringTab }) },
          { path: 'schedules', lazy: async () => ({ Component: (await import('../pages/app/Cron.tsx')).CronTab }) },
          { path: 'previews', lazy: async () => ({ Component: (await import('../pages/app/Previews.tsx')).PreviewsTab }) },
          { path: 'advanced', lazy: async () => ({ Component: (await import('../pages/app/Advanced.tsx')).AdvancedTab }) },
          // Older addresses (bookmarks, notifications) land on the tab that now holds the same thing.
          ...['overview', 'compose'].map((path) => ({ path, element: <Navigate to="../general" replace /> })),
          { path: 'terminal', element: <Navigate to="../general?terminal=1" replace /> },
          { path: 'variables', element: <Navigate to="../environment" replace /> },
          { path: 'metrics', element: <Navigate to="../monitoring" replace /> },
          { path: 'cron', element: <Navigate to="../schedules" replace /> },
          ...['storage', 'settings'].map((path) => ({ path, element: <Navigate to="../advanced" replace /> })),
        ],
      },
      { path: 'deployments/:deploymentId', lazy: async () => ({ Component: (await import('../pages/Deployment.tsx')).DeploymentPage }) },
      {
        path: 'services/:serviceId',
        lazy: async () => ({ Component: (await import('../pages/service/ServiceLayout.tsx')).ServiceLayout }),
        children: [
          { index: true, element: <Navigate to="general" replace /> },
          { path: 'general', lazy: async () => ({ Component: (await import('../pages/service/General.tsx')).ServiceGeneralTab }) },
          { path: 'logs', lazy: async () => ({ Component: (await import('../pages/service/ServiceLogs.tsx')).ServiceLogsTab }) },
          { path: 'monitoring', lazy: async () => ({ Component: (await import('../pages/service/ServiceMetrics.tsx')).ServiceMetricsTab }) },
          { path: 'backups', lazy: async () => ({ Component: (await import('../pages/service/Backups.tsx')).BackupsTab }) },
          { path: 'advanced', lazy: async () => ({ Component: (await import('../pages/service/ServiceSettings.tsx')).ServiceAdvancedTab }) },
          { path: 'files', lazy: async () => ({ Component: (await import('../pages/service/storage/Tabs.tsx')).FilesTab }) },
          { path: 'keys', lazy: async () => ({ Component: (await import('../pages/service/storage/Tabs.tsx')).KeysTab }) },
          { path: 'domains', lazy: async () => ({ Component: (await import('../pages/service/storage/Tabs.tsx')).DomainsTab }) },
          ...['connect', 'terminal'].map((path) => ({ path, element: <Navigate to="../general" replace /> })),
          { path: 'metrics', element: <Navigate to="../monitoring" replace /> },
          { path: 'settings', element: <Navigate to="../advanced" replace /> },
        ],
      },
      { path: 'servers', lazy: async () => ({ Component: (await import('../pages/servers/Servers.tsx')).ServersPage }) },
      { path: 'servers/:serverId', lazy: async () => ({ Component: (await import('../pages/servers/Server.tsx')).ServerPage }) },
      {
        path: 'settings',
        lazy: async () => ({ Component: (await import('../pages/settings/SettingsLayout.tsx')).SettingsLayout }),
        children: [
          { index: true, element: <Navigate to="profile" replace /> },
          { path: 'profile', lazy: async () => ({ Component: (await import('../pages/settings/Profile.tsx')).ProfilePage }) },
          { path: 'security', lazy: async () => ({ Component: (await import('../pages/settings/Security.tsx')).SecurityPage }) },
          { path: 'team', lazy: async () => ({ Component: (await import('../pages/settings/Team.tsx')).TeamPage }) },
          { path: 'git', lazy: async () => ({ Component: (await import('../pages/settings/Git.tsx')).GitPage }) },
          { path: 'tokens', lazy: async () => ({ Component: (await import('../pages/settings/Tokens.tsx')).TokensPage }) },
          { path: 'notifications', lazy: async () => ({ Component: (await import('../pages/settings/Notifications.tsx')).NotificationsPage }) },
          { path: 'storage', lazy: async () => ({ Component: (await import('../pages/settings/Storage.tsx')).StoragePage }) },
          { path: 'registries', lazy: async () => ({ Component: (await import('../pages/settings/Registries.tsx')).RegistriesPage }) },
          { path: 'platform', lazy: async () => ({ Component: (await import('../pages/settings/Platform.tsx')).PlatformPage }) },
          { path: 'audit', lazy: async () => ({ Component: (await import('../pages/settings/Audit.tsx')).AuditPage }) },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
