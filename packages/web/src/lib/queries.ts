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
  BuildPlanDto,
  ComposeDto,
  ContainerDto,
  CronJobDto,
  CronRunDto,
  DeploymentCleanupDto,
  DeploymentDto,
  DeploymentStatusFilter,
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
  NotificationChannelDto,
  OverviewDto,
  Page,
  PlatformSettingsDto,
  PreviewDto,
  PreviewSettingsDto,
  ProjectDto,
  ProxyOverviewDto,
  RegistryDto,
  S3DestinationDto,
  ServerContainerDto,
  ServerDto,
  ServiceCatalogEntryDto,
  ServiceCredentialsDto,
  ServiceDto,
  SessionDto,
  StorageBucketDto,
  StorageKeyDto,
  StorageListingDto,
  StorageOverviewDto,
  TeamCronJobDto,
  TeamDeploymentDto,
  TeamDto,
  TeamRole,
  TemplateDto,
  UpdateStatusDto,
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
  notifications: ['notifications'] as const,
  s3: ['s3-destinations'] as const,
  registries: ['registries'] as const,
  teamDeployments: ['team-deployments'] as const,
  teamCron: ['team-cron'] as const,
  updates: ['updates'] as const,
};

export const useBootstrap = () => useQuery({ queryKey: keys.bootstrap, queryFn: () => api.get<BootstrapDto>('/api/bootstrap'), staleTime: 60_000 });

/** The caller's role in the current team (null while loading or without a team). */
export function useRole(): TeamRole | null {
  const bootstrap = useBootstrap();
  return bootstrap.data?.teams.find((team) => team.id === bootstrap.data?.currentTeamId)?.role ?? null;
}

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

export const useDeploymentCleanup = (appId: string, enabled: boolean) =>
  useQuery({ queryKey: keys.appPart(appId, 'deployments-cleanup'), queryFn: () => api.get<DeploymentCleanupDto>(`/api/applications/${appId}/deployments/cleanup`), enabled });
export const useDeployments = (appId: string) =>
  useInfiniteQuery({
    queryKey: keys.appPart(appId, 'deployments'),
    queryFn: ({ pageParam }) => api.get<Page<DeploymentDto>>(`/api/applications/${appId}/deployments${qs({ cursor: pageParam, limit: 20 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const useDeployment = (id: string) =>
  useQuery({ queryKey: keys.deployment(id), queryFn: () => api.get<DeploymentDto & { applicationName: string }>(`/api/deployments/${id}`) });

export const useAppContainers = (id: string) =>
  useQuery({ queryKey: keys.appPart(id, 'containers'), queryFn: () => api.get<ContainerDto[]>(`/api/applications/${id}/containers`), refetchInterval: 15_000, retry: false });
export const useCompose = (id: string, enabled = true) => useQuery({ queryKey: keys.appPart(id, 'compose'), queryFn: () => api.get<ComposeDto>(`/api/applications/${id}/compose`), enabled });
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
/** What a deploy of the current branch would build; fetched on demand, never automatically. */
export const fetchBuildPlan = (id: string) => api.post<BuildPlanDto>(`/api/applications/${id}/build-plan`);
export const usePreviewSettings = (id: string, enabled: boolean) =>
  useQuery({ queryKey: keys.appPart(id, 'preview-settings'), queryFn: () => api.get<PreviewSettingsDto>(`/api/applications/${id}/preview-settings`), enabled });
export const usePreviews = (id: string) =>
  useQuery({ queryKey: keys.appPart(id, 'previews'), queryFn: () => api.get<PreviewDto[]>(`/api/applications/${id}/previews`), refetchInterval: 15_000 });
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
export const useTemplates = (enabled = true) => useQuery({ queryKey: ['templates'], queryFn: () => api.get<TemplateDto[]>('/api/catalog/templates'), staleTime: Infinity, enabled });
// File store
export const useStorageOverview = (id: string) =>
  useQuery({ queryKey: keys.servicePart(id, 'storage'), queryFn: () => api.get<StorageOverviewDto>(`/api/services/${id}/storage`), retry: false });
export const useBuckets = (id: string) =>
  useQuery({ queryKey: keys.servicePart(id, 'storage', 'buckets'), queryFn: () => api.get<StorageBucketDto[]>(`/api/services/${id}/storage/buckets`), retry: false });
export const useObjects = (id: string, bucket: string | null, prefix: string) =>
  useInfiniteQuery({
    queryKey: keys.servicePart(id, 'storage', 'objects', bucket, prefix),
    queryFn: ({ pageParam }) => api.get<StorageListingDto>(`/api/services/${id}/storage/buckets/${encodeURIComponent(bucket ?? '')}/objects${qs({ prefix, cursor: pageParam, limit: 200 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: bucket !== null,
    retry: false,
  });
export const useStorageKeys = (id: string) =>
  useQuery({ queryKey: keys.servicePart(id, 'storage', 'keys'), queryFn: () => api.get<StorageKeyDto[]>(`/api/services/${id}/storage/keys`), retry: false });
export const useServiceDomains = (id: string) => useQuery({ queryKey: keys.servicePart(id, 'domains'), queryFn: () => api.get<DomainDto[]>(`/api/services/${id}/domains`) });

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

export const useServerContainers = (id: string) =>
  useQuery({ queryKey: keys.serverPart(id, 'containers'), queryFn: () => api.get<ServerContainerDto[]>(`/api/servers/${id}/containers`), refetchInterval: 15_000, retry: false });
export const useServerContainerLogs = (serverId: string, containerId: string | null) =>
  useQuery({
    queryKey: keys.serverPart(serverId, 'containers', containerId, 'logs'),
    queryFn: () => api.get<{ name: string; lines: { stream: 'stdout' | 'stderr'; text: string }[] }>(`/api/servers/${serverId}/containers/${containerId}/logs`),
    enabled: containerId !== null,
    retry: false,
  });
export const useServerProxy = (id: string) =>
  useQuery({ queryKey: keys.serverPart(id, 'proxy'), queryFn: () => api.get<ProxyOverviewDto>(`/api/servers/${id}/proxy`), refetchInterval: 15_000, retry: false });
export const useGithub = (enabled = true) => useQuery({ queryKey: keys.github, queryFn: () => api.get<GithubStatusDto>('/api/github'), enabled });
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
export const useNotificationChannels = (enabled = true) => useQuery({ queryKey: keys.notifications, queryFn: () => api.get<NotificationChannelDto[]>('/api/notifications'), enabled });
export const useS3Destinations = (enabled = true) => useQuery({ queryKey: keys.s3, queryFn: () => api.get<S3DestinationDto[]>('/api/s3-destinations'), enabled });
/** The running version against the tracked branch; polls fast while an update runs. */
export const useUpdateStatus = (enabled: boolean) =>
  useQuery({
    queryKey: keys.updates,
    queryFn: () => api.get<UpdateStatusDto>('/api/updates'),
    enabled,
    staleTime: 60_000,
    retry: false,
    refetchInterval: (query) => (query.state.data?.state === 'updating' ? 3_000 : 30 * 60_000),
  });
export const useRegistries = (enabled = true) => useQuery({ queryKey: keys.registries, queryFn: () => api.get<RegistryDto[]>('/api/registries'), enabled });

/** Every deployment of the team, newest first, optionally only one status (or `active`). */
export const useTeamDeployments = (status: DeploymentStatusFilter | null) =>
  useInfiniteQuery({
    queryKey: [...keys.teamDeployments, status ?? 'all'],
    queryFn: ({ pageParam }) => api.get<Page<TeamDeploymentDto>>(`/api/deployments${qs({ cursor: pageParam, limit: 30, status: status ?? undefined })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const useTeamCron = () => useQuery({ queryKey: keys.teamCron, queryFn: () => api.get<TeamCronJobDto[]>('/api/cron') });

export const useAudit = () =>
  useInfiniteQuery({
    queryKey: keys.audit,
    queryFn: ({ pageParam }) => api.get<Page<AuditEntryDto>>(`/api/audit${qs({ cursor: pageParam, limit: 50 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
