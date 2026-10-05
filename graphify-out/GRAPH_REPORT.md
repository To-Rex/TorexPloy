# Graph Report - TorexPloy  (2026-10-05)

## Corpus Check
- 289 files · ~300,040 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 9 file(s) not represented in the graph (top: .css 5, (none) 4)

## Summary
- 3356 nodes · 12402 edges · 109 communities (96 shown, 13 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 195 edges (avg confidence: 0.85)
- Token cost: 125,588 input · 0 output

## Community Hubs (Navigation)
- Shared Schemas & Constants
- API DTOs & HTTP Tests
- HTTP Routes & Errors
- Web App Shell & i18n
- Core Package Test Refs
- Web Form Primitives
- Docker Naming & Deploy Glue
- App & Project Pages
- Store Layer & Secrets
- Settings & Storage Pages
- Web Queries & Roles
- Servers, SSH & Processes
- UI Components & Lists
- Teams, IDs & Tokens
- Auth, Crypto & TOTP
- Application & User Stores
- Service Pages & Cards
- Applications Routes & Cron DTOs
- Docker Client
- Deployer & Previews
- Resource Stores & Status
- Core Domain Repositories
- Server Bootstrap & Terminal
- Architecture Docs & README
- Core Proxy Managers
- Update Checker & Self Locator
- Template & Service Catalogs
- Core Deploy Pipeline & Events
- Store Mappers & Utils
- Storage Routes & Preview DTOs
- Core Container Engines
- Compose Transform & Deps
- Template Install & Notifier
- Deployment History UI
- Core Database & Repos
- Container Replacement & Launcher
- Deployment Store & Events
- Team, Cron & Domain Pages
- Self-Updater & Progress
- Config & Logger
- Context, Log Files & Bus
- Server Database & Settings
- Core Docker Engine
- Storage Manager (S3)
- Account Routes & Schemas
- Registry Auth & Metrics
- Cron Parser
- Platform Settings & Updates UI
- S3 SigV4 Client
- Core Crypto & Service Catalog
- Core IDs & Application Repo
- GitHub App Client
- Server Manager & Host Probe
- Service Manager & Backups
- In-App Guide
- Root package.json
- Core Team Repository
- Project & Metric Stores
- Notifications Delivery
- Core Git & Process Exec
- Storage Keys & Destinations
- Compose Engine
- Proxy Manager
- S3 Client Test Harness
- Notification Store & Locale
- Core Job Repository
- Core Errors
- Cron Store
- tsconfig.base
- Core Logger
- Core Deployment Repository
- Domain Store
- Web package & Vite
- Domain Checker (DNS/TLS)
- Log Viewer
- Server Store
- Core Server Repository
- Core Container Engine Interface
- Deployer Test Fake Docker
- Cron Runner
- Web Dependencies
- Core Config
- Core EnvVar Repository
- Caddy Config Builder
- Core Domain Repository
- Core User Repository
- Core Service Repository
- Shared API Errors
- Uzbek Formatting & I18n Provider
- Web Entry (main.tsx)
- Core Project Repository
- Core Session Repository
- Log Writer
- Reconciler
- Backup Store
- Web tsconfig
- Session Store
- Link Store
- Server tsconfig
- Shared package.json
- Shared tsconfig
- Terminal Component
- Storage Bucket Store
- Theme Provider
- Core package.json
- Web Dev Dependencies
- Root tsconfig
- Favicon Mark

## God Nodes (most connected - your core abstractions)
1. `useI18n()` - 229 edges
2. `Button` - 143 edges
3. `useAction()` - 106 edges
4. `AppError` - 101 edges
5. `Field()` - 88 edges
6. `Input` - 87 edges
7. `Context` - 82 edges
8. `DockerClient` - 82 edges
9. `react` - 82 edges
10. `nowIso()` - 77 edges

## Surprising Connections (you probably didn't know these)
- `TorexBuilder` --semantically_similar_to--> `TorexBuilder stack detection`  [INFERRED] [semantically similar]
  README.md → docs/ARCHITECTURE.md
- `PR preview` --semantically_similar_to--> `PR previews (child applications)`  [INFERRED] [semantically similar]
  README.md → docs/ARCHITECTURE.md
- `Fayl ombori (SeaweedFS S3 storage)` --semantically_similar_to--> `File storage service (SeaweedFS)`  [INFERRED] [semantically similar]
  README.md → docs/ARCHITECTURE.md
- `Self-update (ploy-updater)` --semantically_similar_to--> `Self-update mechanism (checker, launcher, updater, replace)`  [INFERRED] [semantically similar]
  README.md → docs/ARCHITECTURE.md
- `Security model (scrypt, AES-256-GCM, no-new-privileges)` --semantically_similar_to--> `Security measures table`  [INFERRED] [semantically similar]
  README.md → docs/ARCHITECTURE.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Deploy pipeline components** — docs_architecture_deploy_pipeline, docs_architecture_build_methods, docs_architecture_ploy_proxy, docs_architecture_docker_engine_api [INFERRED 0.85]
- **Image publish and self-update flow** — github_workflows_image, github_workflows_image_ghcr_image, docs_architecture_self_update, deploy_install [INFERRED 0.85]

## Communities (109 total, 13 thin omitted)

### Community 0 - "Shared Schemas & Constants"
Cohesion: 0.02
Nodes (123): registryDto(), APP_KINDS, APP_STATUSES, APT_PACKAGE_RE, BACKUP_STATUSES, BUCKET_RE, BUILD_TYPES, CRON_RUN_STATUSES (+115 more)

### Community 1 - "API DTOs & HTTP Tests"
Cohesion: 0.03
Nodes (76): EnqueueInput, readLog(), BINDINGS, fakeInspect(), harness(), previewHarness(), pullRequestEvent(), sha() (+68 more)

### Community 2 - "HTTP Routes & Errors"
Cohesion: 0.06
Nodes (84): emit(), isPublicOrigin(), publicBaseUrl(), createHttpApp(), CSP, MIME, audit(), authMiddleware() (+76 more)

### Community 3 - "Web App Shell & i18n"
Cohesion: 0.08
Nodes (61): LOCALES, THEMES, updateServiceSchema, AuthedRoot(), PublicOnly(), Splash(), Unreachable(), useProfilePreferences() (+53 more)

### Community 4 - "Core Package Test Refs"
Cohesion: 0.07
Nodes (23): DatabaseOptions, openDatabase(), RunResult, SqlValue, LATEST_SCHEMA_VERSION, Migration, MIGRATIONS, Harness (+15 more)

### Community 5 - "Web Form Primitives"
Cohesion: 0.15
Nodes (59): ConfirmProvider(), Dialog(), Button, Callout(), Checkbox(), Field(), Input, Select (+51 more)

### Community 6 - "Docker Naming & Deploy Glue"
Cohesion: 0.07
Nodes (41): COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL, ComposeContainer, APP_CAPABILITIES, appContainerSpec(), ContainerSpecInput, ContainerSummary, StatsSample (+33 more)

### Community 7 - "App & Project Pages"
Cohesion: 0.07
Nodes (51): ApplicationDto, updateApplicationSchema, AppMark(), BRANDS, ServiceMark(), RepoChoice, RepoPicker(), RouteTabs() (+43 more)

### Community 8 - "Store Layer & Secrets"
Cohesion: 0.07
Nodes (20): main(), DatabaseOptions, openDatabase(), Row, RunResult, SqlValue, LATEST_SCHEMA_VERSION, Migration (+12 more)

### Community 9 - "Settings & Storage Pages"
Cohesion: 0.08
Nodes (49): writeClipboard(), useConfirm(), FrameActions(), CloseContext, Menu(), MenuItem(), MenuSeparator(), TriggerProps (+41 more)

### Community 10 - "Web Queries & Roles"
Cohesion: 0.07
Nodes (41): DeploymentStatusFilter, MetricRange, roleAtLeast(), AppMetricPoint, ContainerDto, ProjectDto, AreaChart(), AreaChartProps (+33 more)

### Community 11 - "Servers, SSH & Processes"
Cohesion: 0.07
Nodes (20): commitFiles(), AppConfig, Logger, commandExists(), ProcessError, ProcessResult, runProcess(), RunProcessOptions (+12 more)

### Community 12 - "UI Components & Lists"
Cohesion: 0.10
Nodes (41): putVariablesSchema, projectColor(), EnvEditor(), parseDotenv(), Row, toDotenv(), toRows(), ActionsSlot (+33 more)

### Community 13 - "Teams, IDs & Tokens"
Cohesion: 0.06
Nodes (18): recoveryCodes(), sha256(), IdPrefix, newId(), randomId(), slugify(), uniqueSlug(), ApiTokenStore (+10 more)

### Community 14 - "Auth, Crypto & TOTP"
Cohesion: 0.08
Nodes (38): RFC-4226, RateLimiter, setSessionCookie(), teamDto(), userDto(), bootstrapDto(), LoginTicket, recoveryHash() (+30 more)

### Community 15 - "Application & User Stores"
Cohesion: 0.07
Nodes (7): nowIso(), ApplicationStore, mapApplication(), UserStore, int01(), AppStatus, PreviewDto

### Community 16 - "Service Pages & Cards"
Cohesion: 0.13
Nodes (43): ServiceCredentialsDto, ServiceDto, BuilderPicker(), CopyButton(), ValueField(), Card(), SaveFooter(), useI18n() (+35 more)

### Community 17 - "Applications Routes & Cron DTOs"
Cohesion: 0.04
Nodes (27): cronJobDto(), cronRunDto(), linkDto(), serverDto(), teamCronJobDto(), volumeDto(), Role, rangeQuery (+19 more)

### Community 18 - "Docker Client"
Cohesion: 0.07
Nodes (6): DockerClient, DockerError, DockerStreamDemuxer, DockerUnavailableError, JsonLinesParser, tail()

### Community 19 - "Deployer & Previews"
Cohesion: 0.11
Nodes (9): Cancelled, Deployer, sleep(), throwIfAborted(), imageRepository(), PreviewManager, ApplicationRecord, DeploymentRecord (+1 more)

### Community 20 - "Resource Stores & Status"
Cohesion: 0.05
Nodes (22): Credentials, AppSample, DomainRecord, EnvOwner, HostSample, InstallationRecord, mapVolume(), ServiceStore (+14 more)

### Community 21 - "Core Domain Repositories"
Cohesion: 0.08
Nodes (33): Row, DeployRequest, mapApplication(), mapAuditEntry(), mapService(), numOrNull(), parseJson(), strOrNull() (+25 more)

### Community 22 - "Server Bootstrap & Terminal"
Cohesion: 0.09
Nodes (22): SESSION_COOKIE, sessionAuth(), Maintenance, Scheduler, Task, errorMessage(), createContext(), schedule() (+14 more)

### Community 23 - "Architecture Docs & README"
Cohesion: 0.06
Nodes (39): fail(), say(), install.sh script, TorexPloy architecture and execution plan, Backups to S3 destinations, Build methods (torex, dockerfile, nixpacks, railpack, heroku, paketo, static), Docker Compose apps, Data model (teams, projects, applications, services) (+31 more)

### Community 24 - "Core Proxy Managers"
Cohesion: 0.07
Nodes (10): Logger, ApplyRouteInput, CaddyProxy, CaddyProxyOptions, createProxyManager(), EmbeddedProxy, ExternalProxy, ProxyManager (+2 more)

### Community 25 - "Update Checker & Self Locator"
Cohesion: 0.08
Nodes (22): Context, CheckerOptions, CheckResult, EMPTY, GithubCommit, GithubCompare, GithubError, LatestCommit (+14 more)

### Community 26 - "Template & Service Catalogs"
Cohesion: 0.05
Nodes (26): BackupSpec, CATALOG, ContainerTemplate, password(), secretKey(), SeedFile, STORAGE_MASTER_TOML, STORAGE_ROOT_ACTIONS (+18 more)

### Community 27 - "Core Deploy Pipeline & Events"
Cohesion: 0.08
Nodes (24): AppConfig, buildContainerSpec(), containerLabels(), containerName(), deploymentContainerNames(), DeploymentContext, DeploymentPipeline, LogWriter (+16 more)

### Community 28 - "Store Mappers & Utils"
Cohesion: 0.11
Nodes (21): APP_COLUMNS, DeploymentOptions, mapProject(), NewApplication, mapUser(), SessionRecord, mapBackup(), mapInstallation() (+13 more)

### Community 29 - "Storage Routes & Preview DTOs"
Cohesion: 0.06
Nodes (25): domainDto(), s3DestinationDto(), storageBucketDto(), storageKeyDto(), storageListingDto(), storageObjectDto(), attachment(), registerStorageRoutes() (+17 more)

### Community 30 - "Core Container Engines"
Cohesion: 0.08
Nodes (14): DockerEngineOptions, DockerStatsFormat, parseDockerBytes(), parseMemoryPair(), BuildRequest, BuildResult, ContainerInfo, ContainerRef (+6 more)

### Community 31 - "Compose Transform & Deps"
Cohesion: 0.07
Nodes (36): dependencies, hono, @hono/node-server, @ploy/shared, ws, yaml, zod, devDependencies (+28 more)

### Community 32 - "Template Install & Notifier"
Cohesion: 0.10
Nodes (25): expandReferences(), isSensitive(), resolveAppEnv(), ResolvedEnv, canGenerateDomain(), generatedHost(), generateDomain(), generateServiceDomain() (+17 more)

### Community 33 - "Deployment History UI"
Cohesion: 0.14
Nodes (29): isTerminalDeployment(), DeploymentItem(), deploymentTiming, DeploymentTimingFacts(), deploymentTitle(), ICONS, parseTime(), useSecondTick() (+21 more)

### Community 34 - "Core Database & Repos"
Cohesion: 0.07
Nodes (3): Database, ApiTokenRepository, SettingsRepository

### Community 35 - "Container Replacement & Launcher"
Cohesion: 0.11
Nodes (23): ContainerInspect, ImageInspect, imageTag(), isUserNetwork(), launchUpdater(), UPDATER_CONTAINER, updaterSpec(), bindTarget() (+15 more)

### Community 36 - "Deployment Store & Events"
Cohesion: 0.08
Nodes (11): DeploymentStore, mapDeployment(), DeploymentStatus, ServerStatus, DEPLOY_STAGES, DeployStage, LogEnd, PlatformEventType (+3 more)

### Community 37 - "Team, Cron & Domain Pages"
Cohesion: 0.13
Nodes (25): Status(), listeners, RelativeTime(), useTick(), Avatar(), Badge(), SkeletonRows(), useAudit() (+17 more)

### Community 38 - "Self-Updater & Progress"
Cohesion: 0.13
Nodes (26): buildFromSource(), log(), main(), portOf(), probeHealth(), progress(), pullImage(), readEnv() (+18 more)

### Community 39 - "Config & Logger"
Cohesion: 0.11
Nodes (25): bool(), buildCommit(), ConfigError, contextSocket(), gitHead(), int(), loadConfig(), LOG_LEVELS (+17 more)

### Community 40 - "Context, Log Files & Bus"
Cohesion: 0.10
Nodes (14): composeProject(), fakeCli(), FakeContainer, fakeDaemon(), harness(), LogKind, logPath(), removeLog() (+6 more)

### Community 41 - "Server Database & Settings"
Cohesion: 0.10
Nodes (3): Database, InstallationStore, SettingsStore

### Community 42 - "Core Docker Engine"
Cohesion: 0.17
Nodes (5): DockerEngine, engineWithBinary(), EngineInfo, runProcess(), runQuiet()

### Community 43 - "Storage Manager (S3)"
Cohesion: 0.16
Nodes (4): escapeXml(), S3ObjectHead, StorageManager, StorageBucketRecord

### Community 44 - "Account Routes & Schemas"
Cohesion: 0.07
Nodes (15): auditDto(), invitationDto(), memberDto(), tokenDto(), changePasswordSchema, createApiTokenSchema, createTeamSchema, inviteMemberSchema (+7 more)

### Community 45 - "Registry Auth & Metrics"
Cohesion: 0.09
Nodes (19): compareVersions(), cpuPercent(), DockerEvent, DockerSystemInfo, DockerVersion, encodeQuery(), ImageSummary, memoryUsage() (+11 more)

### Community 46 - "Cron Parser"
Cohesion: 0.16
Nodes (25): ALIASES, CronError, CronSchedule, dayMatches(), formatter(), formatters, instantFor(), matchesAt() (+17 more)

### Community 47 - "Platform Settings & Updates UI"
Cohesion: 0.16
Nodes (20): allZones(), FALLBACK_ZONES, ServerClock(), TimezoneDialog(), useNow(), useServerOffset(), zoneLabel(), zoneOffset() (+12 more)

### Community 48 - "S3 SigV4 Client"
Cohesion: 0.15
Nodes (21): RFC-3986, amzDateNow(), blocks(), canonicalQuery(), decodeXml(), encode(), hmac(), parseDeleteResult() (+13 more)

### Community 49 - "Core Crypto & Service Catalog"
Cohesion: 0.13
Nodes (21): constantTimeEqual(), decryptSecret(), encryptSecret(), generateToken(), hashPassword(), hmac(), isEncryptedSecret(), PasswordHash (+13 more)

### Community 50 - "Core IDs & Application Repo"
Cohesion: 0.15
Nodes (12): fromBool(), ApplicationRepository, Application, containerSlug(), isValidHost(), isValidHostname(), isValidSlug(), newId() (+4 more)

### Community 51 - "GitHub App Client"
Cohesion: 0.14
Nodes (3): base64url(), GithubApp, GithubRepositoryDto

### Community 52 - "Server Manager & Host Probe"
Cohesion: 0.17
Nodes (13): cpuBusyPercent(), CpuTimes, HostReading, parseDf(), parseLoadavg(), parseMeminfo(), parseProcStat(), parseRemoteProbe() (+5 more)

### Community 53 - "Service Manager & Backups"
Cohesion: 0.24
Nodes (6): reasonOf(), catalogEntry, ServiceManager, BackupRecord, ServiceRecord, CreateServiceInput

### Community 54 - "In-App Guide"
Cohesion: 0.16
Nodes (19): guide, cache, LOADERS, loadGuide(), guide, GuideBlock, GuideChapter, GuideContent (+11 more)

### Community 55 - "Root package.json"
Cohesion: 0.09
Nodes (22): description, devDependencies, @types/node, typescript, engines, node, name, private (+14 more)

### Community 56 - "Core Team Repository"
Cohesion: 0.19
Nodes (7): mapTeam(), mapTeamMember(), isUniqueViolation(), TeamRepository, Team, TeamMember, TeamRole

### Community 57 - "Project & Metric Stores"
Cohesion: 0.11
Nodes (4): mapProjectStats(), ProjectStore, MetricStore, num()

### Community 58 - "Notifications Delivery"
Cohesion: 0.20
Nodes (10): fill(), clip(), escapeHtml(), Notifier, renderFor(), NotificationChannelRecord, NotificationEvent, NotificationKind (+2 more)

### Community 59 - "Core Git & Process Exec"
Cohesion: 0.18
Nodes (16): assertPublicRepoUrl(), authArgs(), CommitInfo, currentBranch(), ensureClone(), fetchAndReset(), GitContext, listRemoteBranches() (+8 more)

### Community 60 - "Storage Keys & Destinations"
Cohesion: 0.13
Nodes (10): DELETE_BATCH, S3Listing, S3Target, BACKUPS_BUCKET, BucketStats, STORAGE_REGION, StoreReach, S3DestinationRecord (+2 more)

### Community 62 - "Proxy Manager"
Cohesion: 0.22
Nodes (3): ProxyRoute, ProxyManager, ProxyInfo

### Community 63 - "S3 Client Test Harness"
Cohesion: 0.20
Nodes (5): escapeXml(), FakeS3, Harness, unescapeXml(), S3Client

### Community 64 - "Notification Store & Locale"
Cohesion: 0.15
Nodes (4): NotificationChannelPatch, NotificationStore, Locale, NotificationConfigInput

### Community 65 - "Core Job Repository"
Cohesion: 0.21
Nodes (4): mapJob(), JobRepository, Job, nowIso()

### Community 66 - "Core Errors"
Cohesion: 0.22
Nodes (14): AppError, AppErrorOptions, badRequest(), conflict(), ErrorCode, forbidden(), internal(), isAppError() (+6 more)

### Community 68 - "tsconfig.base"
Cohesion: 0.11
Nodes (17): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, exactOptionalPropertyTypes, forceConsistentCasingInFileNames, isolatedModules, noEmit, noFallthroughCasesInSwitch (+9 more)

### Community 69 - "Core Logger"
Cohesion: 0.20
Nodes (12): LogLevel, createLogger(), formatValue(), isRedactedKey(), LEVEL_WEIGHT, LogContext, LoggerOptions, redact() (+4 more)

### Community 70 - "Core Deployment Repository"
Cohesion: 0.25
Nodes (4): mapDeployment(), DeploymentRepository, Deployment, DeploymentStatus

### Community 71 - "Domain Store"
Cohesion: 0.21
Nodes (3): DomainStore, mapDomain(), primaryOf()

### Community 72 - "Web package & Vite"
Cohesion: 0.12
Nodes (15): @ploy/shared, zod, name, private, scripts, build, dev, preview (+7 more)

### Community 73 - "Domain Checker (DNS/TLS)"
Cohesion: 0.17
Nodes (5): checkDns(), checkTls(), DomainChecker, first(), FOLLOW_UPS_MS

### Community 74 - "Log Viewer"
Cohesion: 0.17
Nodes (14): ANSI_BRIGHT, ANSI_COLORS, download(), highlight(), LevelFilter, LogViewerProps, parseAnsi(), renderText() (+6 more)

### Community 76 - "Core Server Repository"
Cohesion: 0.30
Nodes (4): mapServer(), ServerRepository, Server, ServerStatus

### Community 78 - "Deployer Test Fake Docker"
Cohesion: 0.25
Nodes (5): createApp(), FakeContainer, FakeDocker, setup(), readTar()

### Community 79 - "Cron Runner"
Cohesion: 0.23
Nodes (5): withPlatformEnv(), CronRunner, CronJobRecord, CronRunRecord, TeamCronJobRecord

### Community 80 - "Web Dependencies"
Cohesion: 0.14
Nodes (14): dependencies, @fontsource-variable/jetbrains-mono, @fontsource-variable/onest, lucide-react, @ploy/shared, react, react-dom, react-router (+6 more)

### Community 81 - "Core Config"
Cohesion: 0.29
Nodes (11): absoluteDataDir(), ConfigError, ConfigOverrides, envEnum(), envInt(), envString(), loadConfig(), LOG_LEVELS (+3 more)

### Community 82 - "Core EnvVar Repository"
Cohesion: 0.31
Nodes (4): mapEnvVar(), EnvVarRepository, EnvScope, EnvVar

### Community 83 - "Caddy Config Builder"
Cohesion: 0.29
Nodes (12): buildCaddyConfig(), CaddyConfigInput, escapeHtml(), hostMatch(), Json, NOT_FOUND, prefixOf(), proxyHandler() (+4 more)

### Community 84 - "Core Domain Repository"
Cohesion: 0.33
Nodes (3): mapDomain(), DomainRepository, Domain

### Community 85 - "Core User Repository"
Cohesion: 0.35
Nodes (3): mapUser(), UserRepository, User

### Community 86 - "Core Service Repository"
Cohesion: 0.33
Nodes (3): ServiceRepository, Service, ServiceCredentials

### Community 87 - "Shared API Errors"
Cohesion: 0.23
Nodes (9): AppErrorOptions, ApiErrorBody, ERROR_CODES, ErrorCode, isApiErrorBody(), ValidationIssue, ApiError, request() (+1 more)

### Community 88 - "Uzbek Formatting & I18n Provider"
Cohesion: 0.26
Nodes (11): I18nProvider(), pad2(), formatUzDate(), formatUzNumber(), formatUzRelative(), MONTHS, MONTHS_SHORT, pad() (+3 more)

### Community 89 - "Web Entry (main.tsx)"
Cohesion: 0.17
Nodes (5): storedLocale(), queryClient, @fontsource-variable/jetbrains-mono, @fontsource-variable/onest, react-dom

### Community 90 - "Core Project Repository"
Cohesion: 0.38
Nodes (3): mapProject(), ProjectRepository, Project

### Community 95 - "Web tsconfig"
Cohesion: 0.20
Nodes (9): compilerOptions, jsx, lib, module, moduleResolution, types, extends, include (+1 more)

### Community 98 - "Server tsconfig"
Cohesion: 0.22
Nodes (8): compilerOptions, lib, module, moduleResolution, types, extends, include, ../../tsconfig.base.json

### Community 99 - "Shared package.json"
Cohesion: 0.22
Nodes (8): dependencies, zod, exports, zod, name, private, type, version

### Community 100 - "Shared tsconfig"
Cohesion: 0.22
Nodes (8): compilerOptions, lib, module, moduleResolution, types, extends, include, ../../tsconfig.base.json

### Community 101 - "Terminal Component"
Cohesion: 0.22
Nodes (8): ERROR_CODES, ErrorCode, PALETTE, Phase, Shell, socketUrl(), @xterm/addon-fit, @xterm/xterm

### Community 103 - "Theme Provider"
Cohesion: 0.32
Nodes (6): Theme, UserDto, storedTheme(), ThemeContext, ThemeProvider(), ThemeState

### Community 104 - "Core package.json"
Cohesion: 0.33
Nodes (5): exports, name, private, type, version

### Community 105 - "Web Dev Dependencies"
Cohesion: 0.40
Nodes (5): devDependencies, @types/react, @types/react-dom, vite, @vitejs/plugin-react

### Community 106 - "Root tsconfig"
Cohesion: 0.50
Nodes (3): extends, files, ./tsconfig.base.json

## Knowledge Gaps
- **487 isolated node(s):** `name`, `version`, `private`, `type`, `description` (+482 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 851 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **13 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ContainerEngine` connect `Core Container Engine Interface` to `Core Docker Engine`, `Core Deploy Pipeline & Events`, `Core Package Test Refs`, `Core Container Engines`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _487 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Shared Schemas & Constants` be split into smaller, more focused modules?**
  _Cohesion score 0.018853102906520033 - nodes in this community are weakly interconnected._
- **Why does `Context` connect `Update Checker & Self Locator` to `API DTOs & HTTP Tests`, `HTTP Routes & Errors`, `Docker Naming & Deploy Glue`, `Store Layer & Secrets`, `Servers, SSH & Processes`, `Auth, Crypto & TOTP`, `Applications Routes & Cron DTOs`, `Deployer & Previews`, `Server Bootstrap & Terminal`, `Storage Routes & Preview DTOs`, `Template Install & Notifier`, `Context, Log Files & Bus`, `Storage Manager (S3)`, `Account Routes & Schemas`, `Registry Auth & Metrics`, `GitHub App Client`, `Server Manager & Host Probe`, `Service Manager & Backups`, `Notifications Delivery`, `Storage Keys & Destinations`, `Compose Engine`, `Proxy Manager`, `Domain Checker (DNS/TLS)`, `Deployer Test Fake Docker`, `Cron Runner`, `Reconciler`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Should `API DTOs & HTTP Tests` be split into smaller, more focused modules?**
  _Cohesion score 0.02560187903699354 - nodes in this community are weakly interconnected._
- **Why does `nowIso()` connect `Application & User Stores` to `Session Store`, `Notification Store & Locale`, `Link Store`, `Cron Store`, `Deployment Store & Events`, `Storage Bucket Store`, `Domain Store`, `Store Layer & Secrets`, `Server Database & Settings`, `Server Store`, `Teams, IDs & Tokens`, `Resource Stores & Status`, `Project & Metric Stores`, `Store Mappers & Utils`, `Backup Store`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Should `HTTP Routes & Errors` be split into smaller, more focused modules?**
  _Cohesion score 0.05676190476190476 - nodes in this community are weakly interconnected._