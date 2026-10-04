/**
 * The data layer, assembled once per process.
 */
import type { Database } from '../db/database.ts';
import type { Secrets } from '../lib/secrets.ts';
import { ApplicationStore, DeploymentStore, ProjectStore } from './apps.ts';
import { ApiTokenStore, SessionStore, UserStore } from './identity.ts';
import { BackupStore, CronStore, DomainStore, EnvStore, InstallationStore, LinkStore, MetricStore, ServiceStore, VolumeStore } from './resources.ts';
import { ServerStore } from './servers.ts';
import { AuditStore, SettingsStore, TeamStore } from './teams.ts';

export interface Stores {
  db: Database;
  users: UserStore;
  sessions: SessionStore;
  tokens: ApiTokenStore;
  teams: TeamStore;
  audit: AuditStore;
  settings: SettingsStore;
  servers: ServerStore;
  projects: ProjectStore;
  applications: ApplicationStore;
  deployments: DeploymentStore;
  env: EnvStore;
  domains: DomainStore;
  volumes: VolumeStore;
  services: ServiceStore;
  links: LinkStore;
  backups: BackupStore;
  cron: CronStore;
  installations: InstallationStore;
  metrics: MetricStore;
}

export function createStores(db: Database, secrets: Secrets): Stores {
  return {
    db,
    users: new UserStore(db),
    sessions: new SessionStore(db),
    tokens: new ApiTokenStore(db),
    teams: new TeamStore(db),
    audit: new AuditStore(db),
    settings: new SettingsStore(db),
    servers: new ServerStore(db),
    projects: new ProjectStore(db),
    applications: new ApplicationStore(db),
    deployments: new DeploymentStore(db),
    env: new EnvStore(db, secrets),
    domains: new DomainStore(db),
    volumes: new VolumeStore(db),
    services: new ServiceStore(db, secrets),
    links: new LinkStore(db),
    backups: new BackupStore(db),
    cron: new CronStore(db),
    installations: new InstallationStore(db),
    metrics: new MetricStore(db),
  };
}

export type * from './apps.ts';
export type * from './identity.ts';
export type * from './resources.ts';
export type * from './servers.ts';
export type * from './teams.ts';
