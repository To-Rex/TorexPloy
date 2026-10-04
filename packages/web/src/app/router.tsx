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
      { index: true, lazy: async () => ({ Component: (await import('../pages/Overview.tsx')).OverviewPage }) },
      { path: 'projects', lazy: async () => ({ Component: (await import('../pages/projects/Projects.tsx')).ProjectsPage }) },
      { path: 'projects/:projectId', lazy: async () => ({ Component: (await import('../pages/projects/Project.tsx')).ProjectPage }) },
      {
        path: 'apps/:appId',
        lazy: async () => ({ Component: (await import('../pages/app/AppLayout.tsx')).AppLayout }),
        children: [
          { index: true, element: <Navigate to="deployments" replace /> },
          { path: 'deployments', lazy: async () => ({ Component: (await import('../pages/app/Deployments.tsx')).DeploymentsTab }) },
          { path: 'logs', lazy: async () => ({ Component: (await import('../pages/app/Logs.tsx')).LogsTab }) },
          { path: 'metrics', lazy: async () => ({ Component: (await import('../pages/app/Metrics.tsx')).MetricsTab }) },
          { path: 'variables', lazy: async () => ({ Component: (await import('../pages/app/Variables.tsx')).VariablesTab }) },
          { path: 'domains', lazy: async () => ({ Component: (await import('../pages/app/Domains.tsx')).DomainsTab }) },
          { path: 'storage', lazy: async () => ({ Component: (await import('../pages/app/Storage.tsx')).StorageTab }) },
          { path: 'cron', lazy: async () => ({ Component: (await import('../pages/app/Cron.tsx')).CronTab }) },
          { path: 'settings', lazy: async () => ({ Component: (await import('../pages/app/AppSettings.tsx')).AppSettingsTab }) },
        ],
      },
      { path: 'deployments/:deploymentId', lazy: async () => ({ Component: (await import('../pages/Deployment.tsx')).DeploymentPage }) },
      {
        path: 'services/:serviceId',
        lazy: async () => ({ Component: (await import('../pages/service/ServiceLayout.tsx')).ServiceLayout }),
        children: [
          { index: true, element: <Navigate to="connect" replace /> },
          { path: 'connect', lazy: async () => ({ Component: (await import('../pages/service/Connect.tsx')).ConnectTab }) },
          { path: 'logs', lazy: async () => ({ Component: (await import('../pages/service/ServiceLogs.tsx')).ServiceLogsTab }) },
          { path: 'metrics', lazy: async () => ({ Component: (await import('../pages/service/ServiceMetrics.tsx')).ServiceMetricsTab }) },
          { path: 'backups', lazy: async () => ({ Component: (await import('../pages/service/Backups.tsx')).BackupsTab }) },
          { path: 'settings', lazy: async () => ({ Component: (await import('../pages/service/ServiceSettings.tsx')).ServiceSettingsTab }) },
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
          { path: 'platform', lazy: async () => ({ Component: (await import('../pages/settings/Platform.tsx')).PlatformPage }) },
          { path: 'audit', lazy: async () => ({ Component: (await import('../pages/settings/Audit.tsx')).AuditPage }) },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
