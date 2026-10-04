/**
 * Server state: query keys and read hooks.
 *
 * Keys are hierarchical (`['app', id, 'domains']`) so a realtime event can
 * invalidate exactly what changed — or everything under a resource.
 */
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  ApiTokenDto,
  ApplicationDto,
  AuditEntryDto,
  BackupDto,
  BootstrapDto,
  CronJobDto,
  CronRunDto,
  DeploymentDto,
  DockerDiskUsageDto,
  DomainDto,
  GithubRepositoryDto,
  GithubStatusDto,
  HostMetricPoint,
  AppMetricPoint,
  InvitationDto,
  LinkDto,
  MemberDto,
  MetricRange,
  OverviewDto,
  Page,
  PlatformSettingsDto,
  ProjectDto,
  ServerDto,
  ServiceCatalogEntryDto,
  ServiceCredentialsDto,
  ServiceDto,
  SessionDto,
  TeamDto,
  UserDto,
  VariablesDto,
  VolumeDto,
  HostMetricPoint as HostPoint,
} from '@ploy/shared';
import { api, qs } from './api.ts';

export const keys = {
  bootstrap: ['bootstrap'] as const,
  overview: ['overview'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  apps: ['apps'] as const,
  app: (id: string) => ['app', id] as const,
  appPart: (id: string, part: string, ...rest: unknown[]) => ['app', id, part, ...rest] as const,
  deployment: (id: string) => ['deployment', id] as const,
  service: (id: string) => ['service', id] as const,
  servicePart: (id: string, part: string, ...rest: unknown[]) => ['service', id, part, ...rest] as const,
  servers: ['servers'] as const,
  server: (id: string) => ['server', id] as const,
  serverPart: (id: string, part: string, ...rest: unknown[]) => ['server', id, part, ...rest] as const,
  catalog: ['catalog'] as const,
  github: ['github'] as const,
  repositories: (installationId: number) => ['github', 'repositories', installationId] as const,
  branches: (installationId: number, repository: string) => ['github', 'branches', installationId, repository] as const,
  settings: ['settings'] as const,
  me: ['me'] as const,
  team: ['team'] as const,
  members: ['team', 'members'] as const,
  invitations: ['team', 'invitations'] as const,
  tokens: ['tokens'] as const,
  sessions: ['sessions'] as const,
  audit: ['audit'] as const,
};

export const useBootstrap = () => useQuery({ queryKey: keys.bootstrap, queryFn: () => api.get<BootstrapDto>('/api/bootstrap'), staleTime: 60_000 });

export const useOverview = () => useQuery({ queryKey: keys.overview, queryFn: () => api.get<OverviewDto>('/api/overview') });

export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: () => api.get<ProjectDto[]>('/api/projects') });

export interface ProjectDetail {
  project: ProjectDto;
  applications: ApplicationDto[];
  services: ServiceDto[];
}
export const useProject = (id: string) => useQuery({ queryKey: keys.project(id), queryFn: () => api.get<ProjectDetail>(`/api/projects/${id}`) });
export const useProjectVariables = (id: string) =>
  useQuery({ queryKey: [...keys.project(id), 'variables'], queryFn: () => api.get<VariablesDto>(`/api/projects/${id}/variables`) });

export const useApplications = () => useQuery({ queryKey: keys.apps, queryFn: () => api.get<ApplicationDto[]>('/api/applications'), staleTime: 30_000 });
export const useApp = (id: string) => useQuery({ queryKey: keys.app(id), queryFn: () => api.get<ApplicationDto>(`/api/applications/${id}`) });

export const useDeployments = (appId: string) =>
  useInfiniteQuery({
    queryKey: keys.appPart(appId, 'deployments'),
    queryFn: ({ pageParam }) => api.get<Page<DeploymentDto>>(`/api/applications/${appId}/deployments${qs({ cursor: pageParam, limit: 20 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const useDeployment = (id: string) =>
  useQuery({ queryKey: keys.deployment(id), queryFn: () => api.get<DeploymentDto & { applicationName: string }>(`/api/deployments/${id}`) });

export const useAppVariables = (id: string) => useQuery({ queryKey: keys.appPart(id, 'variables'), queryFn: () => api.get<VariablesDto>(`/api/applications/${id}/variables`) });
export const useDomains = (id: string) => useQuery({ queryKey: keys.appPart(id, 'domains'), queryFn: () => api.get<DomainDto[]>(`/api/applications/${id}/domains`) });
export const useVolumes = (id: string) => useQuery({ queryKey: keys.appPart(id, 'volumes'), queryFn: () => api.get<VolumeDto[]>(`/api/applications/${id}/volumes`) });
export const useLinks = (id: string) => useQuery({ queryKey: keys.appPart(id, 'links'), queryFn: () => api.get<LinkDto[]>(`/api/applications/${id}/links`) });
export const useCronJobs = (id: string) => useQuery({ queryKey: keys.appPart(id, 'cron'), queryFn: () => api.get<CronJobDto[]>(`/api/applications/${id}/cron`) });
export const useCronRuns = (appId: string, cronId: string | null) =>
  useQuery({
    queryKey: keys.appPart(appId, 'cron', cronId, 'runs'),
    queryFn: () => api.get<CronRunDto[]>(`/api/applications/${appId}/cron/${cronId}/runs`),
    enabled: cronId !== null,
  });
export const useDeployKey = (id: string, enabled: boolean) =>
  useQuery({ queryKey: keys.appPart(id, 'deploy-key'), queryFn: () => api.get<{ publicKey: string | null }>(`/api/applications/${id}/deploy-key`), enabled });

const METRICS_REFRESH_MS = 15_000;

export const useAppMetrics = (id: string, range: MetricRange) =>
  useQuery({
    queryKey: keys.appPart(id, 'metrics', range),
    queryFn: () => api.get<{ range: MetricRange; points: AppMetricPoint[] }>(`/api/applications/${id}/metrics${qs({ range })}`),
    refetchInterval: METRICS_REFRESH_MS,
    placeholderData: keepPreviousData,
  });

export const useService = (id: string) => useQuery({ queryKey: keys.service(id), queryFn: () => api.get<ServiceDto>(`/api/services/${id}`) });
export const useServiceBackups = (id: string) => useQuery({ queryKey: keys.servicePart(id, 'backups'), queryFn: () => api.get<BackupDto[]>(`/api/services/${id}/backups`) });
export const useServiceMetrics = (id: string, range: MetricRange) =>
  useQuery({
    queryKey: keys.servicePart(id, 'metrics', range),
    queryFn: () => api.get<{ range: MetricRange; points: AppMetricPoint[] }>(`/api/services/${id}/metrics${qs({ range })}`),
    refetchInterval: METRICS_REFRESH_MS,
    placeholderData: keepPreviousData,
  });
export const fetchServiceCredentials = (id: string) => api.get<ServiceCredentialsDto>(`/api/services/${id}/credentials`);
export const useCatalog = () => useQuery({ queryKey: keys.catalog, queryFn: () => api.get<ServiceCatalogEntryDto[]>('/api/catalog/services'), staleTime: Infinity });

export const useServers = () => useQuery({ queryKey: keys.servers, queryFn: () => api.get<ServerDto[]>('/api/servers') });
export const useServer = (id: string) => useQuery({ queryKey: keys.server(id), queryFn: () => api.get<ServerDto>(`/api/servers/${id}`) });
export const useServerMetrics = (id: string, range: MetricRange) =>
  useQuery({
    queryKey: keys.serverPart(id, 'metrics', range),
    queryFn: () => api.get<{ range: MetricRange; points: HostMetricPoint[]; latest: HostPoint | null }>(`/api/servers/${id}/metrics${qs({ range })}`),
    refetchInterval: METRICS_REFRESH_MS,
    placeholderData: keepPreviousData,
  });
export const useServerDocker = (id: string, enabled: boolean) =>
  useQuery({ queryKey: keys.serverPart(id, 'docker'), queryFn: () => api.get<DockerDiskUsageDto>(`/api/servers/${id}/docker`), enabled, staleTime: 60_000, retry: false });

export const useGithub = () => useQuery({ queryKey: keys.github, queryFn: () => api.get<GithubStatusDto>('/api/github') });
export const useRepositories = (installationId: number | null) =>
  useQuery({
    queryKey: keys.repositories(installationId ?? 0),
    queryFn: () => api.get<GithubRepositoryDto[]>(`/api/github/installations/${installationId}/repositories`),
    enabled: installationId !== null,
    staleTime: 60_000,
  });
export const useBranches = (installationId: number | null, repository: string | null) =>
  useQuery({
    queryKey: keys.branches(installationId ?? 0, repository ?? ''),
    queryFn: () => api.get<string[]>(`/api/github/installations/${installationId}/branches${qs({ repository })}`),
    enabled: installationId !== null && repository !== null,
    staleTime: 60_000,
  });

export const useSettings = (enabled = true) => useQuery({ queryKey: keys.settings, queryFn: () => api.get<PlatformSettingsDto>('/api/settings'), enabled });
export const useMe = () => useQuery({ queryKey: keys.me, queryFn: () => api.get<UserDto>('/api/me') });
export const useTeam = () => useQuery({ queryKey: keys.team, queryFn: () => api.get<TeamDto>('/api/team') });
export const useMembers = () => useQuery({ queryKey: keys.members, queryFn: () => api.get<MemberDto[]>('/api/team/members') });
export const useInvitations = (enabled: boolean) => useQuery({ queryKey: keys.invitations, queryFn: () => api.get<InvitationDto[]>('/api/team/invitations'), enabled });
export const useTokens = () => useQuery({ queryKey: keys.tokens, queryFn: () => api.get<ApiTokenDto[]>('/api/tokens') });
export const useSessions = () => useQuery({ queryKey: keys.sessions, queryFn: () => api.get<SessionDto[]>('/api/me/sessions') });
export const useAudit = () =>
  useInfiniteQuery({
    queryKey: keys.audit,
    queryFn: ({ pageParam }) => api.get<Page<AuditEntryDto>>(`/api/audit${qs({ cursor: pageParam, limit: 50 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
