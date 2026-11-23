/**
 * The panel's API as TorexAi knows it.
 *
 * The assistant runs the platform through the same HTTP API the dashboard
 * uses, acting as the person it talks to, so every permission check, every
 * validation and every audit entry applies to it unchanged. This catalog is
 * what makes that affordable: instead of two hundred tool definitions in
 * every request, the model has one `api_call` tool and looks an endpoint up
 * here when it needs one.
 *
 * It is also an allowlist. An endpoint that is not listed cannot be called:
 * sign-in and account security, webhooks, raw uploads, event streams and
 * TorexAi's own endpoints (it must not approve its own actions) are left out
 * on purpose. A test checks that every route of the application is either
 * listed here or named in `EXCLUDED`.
 */
import { z, type ZodType } from 'zod';
import {
  createApiTokenSchema,
  createApplicationSchema,
  createBucketSchema,
  createComposeSchema,
  createCronJobSchema,
  createDomainSchema,
  createFolderSchema,
  createGitProviderSchema,
  createLinkSchema,
  createNotificationChannelSchema,
  createProjectSchema,
  createRegistrySchema,
  createS3DestinationSchema,
  createServerSchema,
  createServiceSchema,
  createStorageKeySchema,
  createTeamSchema,
  createVolumeSchema,
  dbActivityActionSchema,
  dbChangesSchema,
  dbExportQuerySchema,
  dbObjectQuerySchema,
  dbRowsSchema,
  dbRunSchema,
  dbSessionSchema,
  dbTableQuerySchema,
  deleteObjectsSchema,
  deployRequestSchema,
  deploymentListQuerySchema,
  installTemplateSchema,
  inviteMemberSchema,
  listObjectsQuerySchema,
  METRIC_RANGES,
  paginationSchema,
  platformSettingsSchema,
  presignSchema,
  putVariablesSchema,
  updateApplicationSchema,
  updateBucketSchema,
  updateComposeSchema,
  updateCronJobSchema,
  updateDomainSchema,
  updateGitProviderSchema,
  updateMemberSchema,
  updateNotificationChannelSchema,
  updateProfileSchema,
  updateProjectSchema,
  updateRegistrySchema,
  updateS3DestinationSchema,
  updateServerSchema,
  updateServiceSchema,
  updateTeamSchema,
  updateVolumeBackupSchema,
  type AiRisk,
  type TeamRole,
} from '@ploy/shared';

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** How a call is taken back. Paths may name `:params` of the call's own path and `{id}` from its answer. */
export type UndoRule =
  /** The call created something: delete it. */
  | { kind: 'delete'; path: string; query?: Record<string, string> }
  /** The call changed settings: read them first (`from`, the call's own path by default) and write the old values back. */
  | { kind: 'restore'; from?: string; body?: (before: Record<string, unknown>, sent: Record<string, unknown>) => unknown }
  /** The call has an opposite. */
  | { kind: 'call'; method: ApiMethod; path: string; label: string }
  /** The call put a new deployment in place: redeploy the one that was serving before it. */
  | { kind: 'rollback' };

export interface ApiEntry {
  method: ApiMethod;
  path: string;
  area: string;
  summary: string;
  /** The lowest team role the route accepts (`instance`: the instance administrator). Shown to the model; enforced by the route. */
  role: TeamRole | 'instance' | 'any';
  body?: ZodType;
  query?: ZodType;
  /** Query parameters the route reads without a schema. */
  queryNote?: string;
  note?: string;
  /** Defaults: GET is safe, DELETE is dangerous, everything else is a change. */
  risk?: AiRisk | ((body: Record<string, unknown>) => AiRisk);
  undo?: UndoRule;
}

const range = z.object({ range: z.enum(METRIC_RANGES).default('1h') });
const removeData = 'removeData=true also deletes its volumes and data (irreversible)';

/** Variables are written whole, so undoing a write puts the earlier set back. */
const restoreVariables: UndoRule = {
  kind: 'restore',
  body: (before) => ({ variables: before.variables, ...(typeof before.text === 'string' ? { text: before.text } : {}) }),
};

function sqlRisk(body: Record<string, unknown>): AiRisk {
  const sql = typeof body.sql === 'string' ? body.sql : '';
  if (/\b(drop|truncate|delete\s+from|alter\s+(table|database|schema)|grant|revoke)\b/i.test(sql)) return 'danger';
  if (body.readOnly === true) return 'safe';
  // Without the read-only guard a statement is only as harmless as it looks; ask.
  return /^\s*(select|show|explain|describe|desc|with|values|table)\b/i.test(sql) && !/;\s*\S/.test(sql.trim().replace(/;\s*$/, '')) ? 'safe' : 'change';
}

type Extra = Omit<ApiEntry, 'method' | 'path' | 'area' | 'summary' | 'role'>;
const list: ApiEntry[] = [];
let area = '';
const add = (method: ApiMethod, path: string, role: ApiEntry['role'], summary: string, extra: Extra = {}): void => {
  list.push({ method, path, area, summary, role, ...extra });
};

area = 'overview';
add('GET', '/api/overview', 'viewer', 'Counts and health of the whole team: projects, applications, services, servers, recent deployments');
add('GET', '/api/health', 'any', 'Panel health: database, Docker, proxy; version and uptime');
add('GET', '/api/me', 'any', 'The signed-in person: name, email, locale');
add('PATCH', '/api/me', 'any', 'Change the profile: name, language, theme', { body: updateProfileSchema, undo: { kind: 'restore' } });

area = 'projects';
add('GET', '/api/projects', 'viewer', 'List projects with their applications and services');
add('POST', '/api/projects', 'developer', 'Create a project', { body: createProjectSchema, undo: { kind: 'delete', path: '/api/projects/{id}' } });
add('GET', '/api/projects/:id', 'viewer', 'One project with its applications and services');
add('PATCH', '/api/projects/:id', 'developer', 'Rename a project or change its description', { body: updateProjectSchema, undo: { kind: 'restore' } });
add('DELETE', '/api/projects/:id', 'admin', 'Delete a project with every application and service in it', { queryNote: removeData });
add('GET', '/api/projects/:id/variables', 'developer', 'Shared environment variables of a project (inherited by its applications)');
add('PUT', '/api/projects/:id/variables', 'developer', 'Replace the shared variables of a project (send the complete set)', { body: putVariablesSchema, undo: restoreVariables });

area = 'applications';
add('GET', '/api/applications', 'viewer', 'List every application of the team');
add('POST', '/api/projects/:id/applications', 'developer', 'Create an application in a project (source: a git repository, an image or an upload)', {
  body: createApplicationSchema,
  note: 'It is not deployed until POST /api/applications/{id}/deploy.',
  undo: { kind: 'delete', path: '/api/applications/{id}', query: { removeData: 'true' } },
});
add('GET', '/api/applications/:id', 'viewer', 'One application: source, build and runtime settings, status, active deployment');
add('PATCH', '/api/applications/:id', 'developer', 'Change an application: source, branch, build type and commands, port, replicas, limits, health check, auto deploy, previews', {
  body: updateApplicationSchema,
  note: 'Most settings take effect with the next deployment.',
  undo: { kind: 'restore' },
});
add('DELETE', '/api/applications/:id', 'admin', 'Delete an application and its containers', { queryNote: removeData });
add('POST', '/api/applications/:id/deploy', 'developer', 'Build and deploy the application now; returns the deployment (follow it with wait_deployment)', { body: deployRequestSchema, undo: { kind: 'rollback' } });
add('POST', '/api/applications/:id/restart', 'developer', 'Restart the running containers (a new deployment of the same image)', { undo: { kind: 'rollback' } });
add('POST', '/api/applications/:id/stop', 'developer', 'Stop the application', { undo: { kind: 'call', method: 'POST', path: '/api/applications/:id/start', label: 'Start it again' } });
add('POST', '/api/applications/:id/start', 'developer', 'Start a stopped application', { undo: { kind: 'call', method: 'POST', path: '/api/applications/:id/stop', label: 'Stop it again' } });
add('GET', '/api/applications/:id/containers', 'viewer', 'Running containers of an application with their state');
add('POST', '/api/applications/:id/build-plan', 'developer', 'Show how the repository would be built (detected stack, generated Dockerfile) without deploying', { risk: 'safe' });
add('POST', '/api/applications/:id/webhook', 'developer', 'Check or re-create the push webhook of a GitLab or Bitbucket repository');
add('POST', '/api/applications/:id/hook/rotate', 'admin', 'Issue a new deploy hook URL (the old one stops working)', { risk: 'danger' });
add('GET', '/api/applications/:id/deploy-key', 'developer', 'The public deploy key to add to a private repository');
add('GET', '/api/applications/:id/metrics', 'viewer', 'CPU, memory and network history of an application', { query: range, note: 'To show it to the person, use a ```chart block of type "metric" instead of reading the points.' });

area = 'variables';
add('GET', '/api/applications/:id/variables', 'developer', 'Environment variables of an application and the ones it inherits');
add('PUT', '/api/applications/:id/variables', 'developer', 'Replace the environment variables of an application (send the complete set, including the ones that stay)', {
  body: putVariablesSchema,
  note: 'Read them first with reveal:true, or the values you send back would be the hidden placeholders. They apply with the next deployment.',
  undo: restoreVariables,
});

area = 'deployments';
add('GET', '/api/deployments', 'viewer', 'Deployments of the whole team, newest first (status=active|failed|succeeded…)', { query: deploymentListQuerySchema });
add('GET', '/api/applications/:id/deployments', 'viewer', 'Deployment history of one application', { query: paginationSchema });
add('GET', '/api/deployments/:id', 'viewer', 'One deployment: status, commit, error, duration (its log: the logs tool)');
add('POST', '/api/deployments/:id/cancel', 'developer', 'Cancel a queued or running deployment');
add('POST', '/api/deployments/:id/redeploy', 'developer', 'Deploy this earlier deployment again: a rollback when it is older than the active one', { undo: { kind: 'rollback' } });
add('DELETE', '/api/deployments/:id', 'developer', 'Delete one finished deployment with its log and image');
add('GET', '/api/applications/:id/deployments/cleanup', 'viewer', 'How many old deployments a clean-up would remove');
add('POST', '/api/applications/:id/deployments/cleanup', 'developer', 'Remove every finished deployment except the active and the newest one', { risk: 'danger' });

area = 'domains';
add('GET', '/api/applications/:id/domains', 'viewer', 'Domains of an application with DNS and certificate status');
add('POST', '/api/applications/:id/domains', 'developer', 'Attach a domain to an application (HTTPS certificate is issued automatically once DNS points to the server)', {
  body: createDomainSchema,
  undo: { kind: 'delete', path: '/api/domains/{id}' },
});
add('POST', '/api/applications/:id/domains/generate', 'developer', 'Give the application a free working address (sslip.io) without owning a domain', {
  body: z.object({ serviceName: z.string().optional(), port: z.number().int().optional() }),
  undo: { kind: 'delete', path: '/api/domains/{id}' },
});
add('PATCH', '/api/domains/:domainId', 'developer', 'Change a domain: port, path, HTTPS, redirect', { body: updateDomainSchema });
add('POST', '/api/domains/:domainId/verify', 'viewer', 'Check now where the domain resolves and whether its certificate is served', { risk: 'safe' });
add('DELETE', '/api/domains/:domainId', 'developer', 'Detach a domain');
add('GET', '/api/services/:id/domains', 'viewer', 'Domains of a file store service');
add('POST', '/api/services/:id/domains', 'developer', 'Attach a domain to a file store service', { undo: { kind: 'delete', path: '/api/domains/{id}' } });

area = 'volumes';
add('GET', '/api/applications/:id/volumes', 'viewer', 'Persistent volumes of an application');
add('POST', '/api/applications/:id/volumes', 'developer', 'Add a persistent volume (mounted from the next deployment)', { body: createVolumeSchema, undo: { kind: 'delete', path: '/api/applications/:id/volumes/{id}' } });
add('DELETE', '/api/applications/:id/volumes/:volumeId', 'admin', 'Delete a volume and the data in it');
add('PATCH', '/api/applications/:id/volumes/:volumeId', 'developer', 'Set how a volume is backed up: schedule, copies kept, S3 destination, pause while copying', { body: updateVolumeBackupSchema });
add('GET', '/api/applications/:id/volumes/:volumeId/backups', 'viewer', 'Backups of a volume');
add('POST', '/api/applications/:id/volumes/:volumeId/backups', 'developer', 'Back up a volume now');
add('POST', '/api/applications/:id/volumes/:volumeId/backups/:backupId/restore', 'admin', 'Replace the files of a volume with a backup (a copy of the current files is taken first)', { risk: 'danger' });
add('DELETE', '/api/applications/:id/volumes/:volumeId/backups/:backupId', 'admin', 'Delete one volume backup');

area = 'links';
add('GET', '/api/applications/:id/links', 'viewer', 'Services (databases, queues) linked to an application');
add('POST', '/api/applications/:id/links', 'developer', 'Link a service to an application: its connection variables are injected', { body: createLinkSchema, undo: { kind: 'delete', path: '/api/applications/:id/links/{id}' } });
add('DELETE', '/api/applications/:id/links/:linkId', 'developer', 'Unlink a service from an application');

area = 'cron';
add('GET', '/api/cron', 'viewer', 'Scheduled jobs of the whole team');
add('GET', '/api/applications/:id/cron', 'viewer', 'Scheduled jobs of one application');
add('POST', '/api/applications/:id/cron', 'developer', 'Add a scheduled job (a command run in the application image on a cron schedule)', { body: createCronJobSchema, undo: { kind: 'delete', path: '/api/applications/:id/cron/{id}' } });
add('PATCH', '/api/applications/:id/cron/:cronId', 'developer', 'Change a scheduled job: schedule, command, enabled', { body: updateCronJobSchema });
add('DELETE', '/api/applications/:id/cron/:cronId', 'developer', 'Delete a scheduled job');
add('POST', '/api/applications/:id/cron/:cronId/run', 'developer', 'Run a scheduled job now');
add('POST', '/api/applications/:id/cron/:cronId/cancel', 'developer', 'Stop the running execution of a job');
add('GET', '/api/applications/:id/cron/:cronId/runs', 'viewer', 'Past runs of a scheduled job with status and exit code');

area = 'compose';
add('POST', '/api/projects/:id/composes', 'developer', 'Create a Docker Compose stack from a repository or a pasted file', { body: createComposeSchema, undo: { kind: 'delete', path: '/api/applications/{id}', query: { removeData: 'true' } } });
add('GET', '/api/applications/:id/compose', 'viewer', 'The compose file of a stack and its services');
add('PUT', '/api/applications/:id/compose', 'developer', 'Replace the stored compose file (or its path in the repository)', {
  body: updateComposeSchema,
  undo: { kind: 'restore', body: (before, sent) => ({ ...(sent.content !== undefined && typeof before.content === 'string' ? { content: before.content } : {}), ...(sent.composePath !== undefined && typeof before.path === 'string' ? { composePath: before.path } : {}) }) },
});
add('PUT', '/api/applications/:id/host-access', 'admin', 'Allow or forbid a stack to use host features (host ports, host paths, privileged)', {
  body: z.object({ allowed: z.boolean() }),
  risk: 'danger',
});

area = 'previews';
add('GET', '/api/applications/:id/preview-settings', 'developer', 'Pull request preview settings of an application');
add('GET', '/api/applications/:id/previews', 'viewer', 'Running pull request previews');
add('POST', '/api/applications/:id/previews/:previewId/redeploy', 'viewer', 'Deploy a preview again');
add('DELETE', '/api/applications/:id/previews/:previewId', 'developer', 'Remove a preview');

area = 'services';
add('GET', '/api/catalog/services', 'viewer', 'Kinds of service that can be created (postgres, mysql, redis, mongo…) with their versions');
add('POST', '/api/projects/:id/services', 'developer', 'Create a database or another service in a project', { body: createServiceSchema, undo: { kind: 'delete', path: '/api/services/{id}', query: { removeData: 'true' } } });
add('GET', '/api/services/:id', 'viewer', 'One service: type, version, status, limits');
add('PATCH', '/api/services/:id', 'developer', 'Change a service: name, limits, public port, backup schedule', { body: updateServiceSchema, undo: { kind: 'restore' } });
add('DELETE', '/api/services/:id', 'admin', 'Delete a service', { queryNote: removeData });
add('POST', '/api/services/:id/start', 'developer', 'Start a stopped service', { undo: { kind: 'call', method: 'POST', path: '/api/services/:id/stop', label: 'Stop it again' } });
add('POST', '/api/services/:id/stop', 'developer', 'Stop a service (applications that use it lose their connection)', { undo: { kind: 'call', method: 'POST', path: '/api/services/:id/start', label: 'Start it again' } });
add('POST', '/api/services/:id/restart', 'developer', 'Restart a service');
add('POST', '/api/services/:id/redeploy', 'developer', 'Recreate the service container (restart with the current settings)');
add('GET', '/api/services/:id/credentials', 'developer', 'Connection details of a service: host, port, user, password, connection URLs');
add('GET', '/api/services/:id/metrics', 'viewer', 'CPU, memory and network history of a service', { query: range });
add('GET', '/api/services/:id/backups', 'viewer', 'Database backups of a service');
add('POST', '/api/services/:id/backups', 'developer', 'Back up the database now');
add('POST', '/api/services/:id/backups/:backupId/restore', 'admin', 'Restore the database from a backup (overwrites current data)', { risk: 'danger' });
add('DELETE', '/api/services/:id/backups/:backupId', 'admin', 'Delete one database backup');

area = 'database';
add('GET', '/api/services/:id/db/overview', 'developer', 'Database server overview: version, size, connections, list of databases');
add('GET', '/api/services/:id/db/tree', 'developer', 'Schemas, tables, views and functions of one database', { query: z.object({ database: z.string() }) });
add('GET', '/api/services/:id/db/table', 'developer', 'Structure of a table: columns, indexes, constraints, DDL', { query: dbTableQuerySchema });
add('GET', '/api/services/:id/db/source', 'developer', 'Definition of a view, function or trigger', { query: dbObjectQuerySchema });
add('POST', '/api/services/:id/db/rows', 'developer', 'Read rows of a table with filters, sorting and paging', { body: dbRowsSchema, risk: 'safe' });
add('POST', '/api/services/:id/db/run', 'developer', 'Run SQL on PostgreSQL, MySQL or MariaDB and return the result', {
  body: dbRunSchema,
  risk: sqlRisk,
  note: 'session: any id of 8-64 letters you choose and reuse for the conversation (it keeps a connection and its transaction). Send readOnly:true for queries that only read. Close it with /db/close when finished.',
});
add('POST', '/api/services/:id/db/changes', 'developer', 'Insert, update or delete rows of a table in one transaction', { body: dbChangesSchema });
add('POST', '/api/services/:id/db/cancel', 'developer', 'Cancel the query a session is running', { body: dbSessionSchema, risk: 'safe' });
add('POST', '/api/services/:id/db/close', 'developer', 'Close a session and its connection', { body: dbSessionSchema, risk: 'safe' });
add('GET', '/api/services/:id/db/activity', 'developer', 'Sessions and running queries of the database server');
add('POST', '/api/services/:id/db/activity', 'developer', 'Cancel the query of a database session, or terminate the session', { body: dbActivityActionSchema });
add('GET', '/api/services/:id/db/roles', 'developer', 'Roles and users of the database server');
add('GET', '/api/services/:id/db/export', 'developer', 'Export rows of a table as CSV, JSON or INSERT statements', { query: dbExportQuerySchema });

area = 'storage';
add('GET', '/api/services/:id/storage', 'viewer', 'File store overview: endpoint, usage, buckets');
add('GET', '/api/services/:id/storage/buckets', 'viewer', 'Buckets of a file store');
add('POST', '/api/services/:id/storage/buckets', 'developer', 'Create a bucket', { body: createBucketSchema });
add('PATCH', '/api/services/:id/storage/buckets/:bucket', 'developer', 'Change a bucket: public reading, quota', { body: updateBucketSchema });
add('DELETE', '/api/services/:id/storage/buckets/:bucket', 'developer', 'Delete an empty bucket');
add('GET', '/api/services/:id/storage/buckets/:bucket/objects', 'viewer', 'List files and folders of a bucket', { query: listObjectsQuerySchema });
add('POST', '/api/services/:id/storage/buckets/:bucket/delete', 'developer', 'Delete files or folders of a bucket', { body: deleteObjectsSchema, risk: 'danger' });
add('POST', '/api/services/:id/storage/buckets/:bucket/folders', 'developer', 'Create a folder in a bucket', { body: createFolderSchema });
add('POST', '/api/services/:id/storage/buckets/:bucket/presign', 'developer', 'Make a temporary link to download or upload one file', { body: presignSchema });
add('GET', '/api/services/:id/storage/keys', 'viewer', 'Access keys of a file store');
add('POST', '/api/services/:id/storage/keys', 'admin', 'Create an S3 access key for the file store (the secret is shown once)', { body: createStorageKeySchema, undo: { kind: 'delete', path: '/api/services/:id/storage/keys/{id}' } });
add('DELETE', '/api/services/:id/storage/keys/:keyId', 'admin', 'Revoke an access key');
add('POST', '/api/services/:id/storage/backup-destination', 'admin', 'Register this file store as a backup destination for databases and volumes');

area = 'servers';
add('GET', '/api/servers', 'viewer', 'Servers: the local host and SSH servers, with status and resources');
add('POST', '/api/servers', 'admin', 'Add a server reached over SSH', { body: createServerSchema, undo: { kind: 'delete', path: '/api/servers/{id}' } });
add('GET', '/api/servers/:id', 'viewer', 'One server: address, Docker version, CPU, memory, disk');
add('PATCH', '/api/servers/:id', 'admin', 'Change a server: name, address, credentials', { body: updateServerSchema });
add('DELETE', '/api/servers/:id', 'admin', 'Remove a server from the panel');
add('POST', '/api/servers/:id/verify', 'admin', 'Connect to the server again and re-check Docker', { risk: 'safe' });
add('POST', '/api/servers/:id/install-docker', 'admin', 'Install Docker on an SSH server', { risk: 'danger' });
add('GET', '/api/servers/:id/metrics', 'viewer', 'CPU, memory, disk and load history of a server', { query: range, note: 'To show it to the person, use a ```chart block of type "metric".' });
add('GET', '/api/servers/:id/docker', 'viewer', 'Docker disk usage on a server: images, containers, volumes, build cache');
add('GET', '/api/servers/:id/containers', 'admin', 'Every container on a server with its state and owner');
add('POST', '/api/servers/:id/containers/:containerId/start', 'admin', 'Start a container on a server (any container, not only the platform\'s)', { undo: { kind: 'call', method: 'POST', path: '/api/servers/:id/containers/:containerId/stop', label: 'Stop it again' } });
add('POST', '/api/servers/:id/containers/:containerId/stop', 'admin', 'Stop a container on a server', { undo: { kind: 'call', method: 'POST', path: '/api/servers/:id/containers/:containerId/start', label: 'Start it again' } });
add('POST', '/api/servers/:id/containers/:containerId/restart', 'admin', 'Restart a container on a server');
add('GET', '/api/servers/:id/proxy', 'admin', 'The reverse proxy (Caddy) of a server: state, routes, certificates');
add('POST', '/api/servers/:id/proxy/reload', 'admin', 'Rebuild and reload the proxy configuration of a server');
add('POST', '/api/servers/:id/cleanup', 'admin', 'Free disk space on a server: remove unused images and build cache', { risk: 'danger' });

area = 'team';
add('GET', '/api/teams', 'any', 'Teams the person belongs to');
add('POST', '/api/teams', 'any', 'Create a team', { body: createTeamSchema });
add('GET', '/api/team', 'viewer', 'The team in use');
add('PATCH', '/api/team', 'admin', 'Rename the team', { body: updateTeamSchema, undo: { kind: 'restore' } });
add('DELETE', '/api/team', 'owner', 'Delete the team in use with everything in it');
add('GET', '/api/team/members', 'viewer', 'Members of the team with their roles');
add('PATCH', '/api/team/members/:userId', 'admin', "Change a member's role", { body: updateMemberSchema, risk: 'danger' });
add('DELETE', '/api/team/members/:userId', 'viewer', 'Remove a member from the team (or leave it)');
add('GET', '/api/team/invitations', 'admin', 'Pending invitations');
add('POST', '/api/team/invitations', 'admin', 'Invite someone to the team with a role; returns the invitation link', { body: inviteMemberSchema, undo: { kind: 'delete', path: '/api/team/invitations/{id}' } });
add('POST', '/api/team/invitations/:id/link', 'admin', 'Make a new link for an invitation');
add('DELETE', '/api/team/invitations/:id', 'admin', 'Revoke an invitation');
add('GET', '/api/audit', 'admin', 'Audit log: who did what and when', { query: paginationSchema });

area = 'tokens';
add('GET', '/api/tokens', 'developer', "The person's API tokens (names and expiry, not the secrets)");
add('POST', '/api/tokens', 'developer', 'Create an API token for the panel (the platform API key); the secret is returned once', {
  body: createApiTokenSchema,
  note: 'The person sees the token on the action card. It is used as "Authorization: Bearer <token>".',
  undo: { kind: 'delete', path: '/api/tokens/{id}' },
});
add('DELETE', '/api/tokens/:id', 'developer', 'Revoke an API token');

area = 'git';
add('GET', '/api/github', 'viewer', 'GitHub connection: the app and its installations');
add('GET', '/api/github/installations/:id/repositories', 'developer', 'Repositories a GitHub installation can reach');
add('GET', '/api/github/installations/:id/branches', 'developer', 'Branches of a GitHub repository', { query: z.object({ repository: z.string() }) });
add('GET', '/api/git-providers', 'viewer', 'GitLab and Bitbucket connections');
add('POST', '/api/git-providers', 'admin', 'Connect a GitLab or Bitbucket account with an access token', { body: createGitProviderSchema, undo: { kind: 'delete', path: '/api/git-providers/{id}' } });
add('PATCH', '/api/git-providers/:id', 'admin', 'Rename a connection or replace its token', { body: updateGitProviderSchema });
add('DELETE', '/api/git-providers/:id', 'admin', 'Disconnect a GitLab or Bitbucket account');
add('GET', '/api/git-providers/:id/repositories', 'developer', 'Repositories of a GitLab or Bitbucket connection');
add('GET', '/api/git-providers/:id/branches', 'developer', 'Branches of a GitLab or Bitbucket repository', { query: z.object({ repository: z.string() }) });

area = 'registries';
add('GET', '/api/registries', 'developer', 'Container registries the team signs in to');
add('POST', '/api/registries', 'admin', 'Add a container registry login', { body: createRegistrySchema, undo: { kind: 'delete', path: '/api/registries/{id}' } });
add('PATCH', '/api/registries/:id', 'admin', 'Change a registry login', { body: updateRegistrySchema });
add('POST', '/api/registries/:id/test', 'admin', 'Check a registry login', { risk: 'safe' });
add('DELETE', '/api/registries/:id', 'admin', 'Remove a registry login');

area = 'backups';
add('GET', '/api/s3-destinations', 'developer', 'S3 destinations backups are copied to');
add('POST', '/api/s3-destinations', 'admin', 'Add an S3 backup destination', { body: createS3DestinationSchema, undo: { kind: 'delete', path: '/api/s3-destinations/{id}' } });
add('PATCH', '/api/s3-destinations/:id', 'admin', 'Change an S3 backup destination', { body: updateS3DestinationSchema });
add('POST', '/api/s3-destinations/:id/test', 'admin', 'Check that an S3 destination can be written to', { risk: 'safe' });
add('DELETE', '/api/s3-destinations/:id', 'admin', 'Remove an S3 backup destination');

area = 'notifications';
add('GET', '/api/notifications', 'admin', 'Notification channels (Telegram, Discord, Slack, webhook) and the events they receive');
add('POST', '/api/notifications', 'admin', 'Add a notification channel', { body: createNotificationChannelSchema, undo: { kind: 'delete', path: '/api/notifications/{id}' } });
add('PATCH', '/api/notifications/:id', 'admin', 'Change a notification channel', { body: updateNotificationChannelSchema });
add('POST', '/api/notifications/:id/test', 'admin', 'Send a test notification', { risk: 'safe' });
add('DELETE', '/api/notifications/:id', 'admin', 'Remove a notification channel');

area = 'templates';
add('GET', '/api/catalog/templates', 'any', 'One-click templates (n8n, Grafana, WordPress…); use pick:["id","name","category"] and find to search it');
add('POST', '/api/projects/:id/templates', 'developer', 'Install a template into a project', { body: installTemplateSchema });

area = 'settings';
add('GET', '/api/settings', 'instance', 'Instance settings: panel domain, apps domain, certificate email, time zone, build concurrency, retention');
add('PATCH', '/api/settings', 'instance', 'Change instance settings', { body: platformSettingsSchema, risk: 'danger', undo: { kind: 'restore' } });
add('GET', '/api/settings/domain', 'instance', 'Check the panel domain: DNS and certificate');
add('GET', '/api/updates', 'admin', 'Installed version and whether a newer TorexPloy is published');
add('POST', '/api/updates/check', 'admin', 'Look for a newer TorexPloy now', { risk: 'safe' });
add('POST', '/api/updates/apply', 'admin', 'Update TorexPloy itself: the panel restarts and this conversation is interrupted', { risk: 'danger' });

export const API_CATALOG: readonly ApiEntry[] = list;

/**
 * Routes TorexAi may not call, with the reason. Patterns are matched against
 * `METHOD path` as the application registers them.
 */
export const EXCLUDED: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /^\w+ \/api\/ai(\/|$)/, why: 'its own endpoints: it must not approve or undo its own actions, or change its own settings' },
  { pattern: /^\w+ \/api\/(auth|setup|bootstrap|invitations)(\/|$)/, why: 'signing in and joining' },
  { pattern: /^\w+ \/api\/me\/(password|2fa|passkeys|step-up|sessions|team)(\/|$)/, why: 'account security and the team in use belong to the person alone' },
  { pattern: /^\w+ \/api\/(webhooks|hooks)\//, why: 'called by git hosts and CI, not by people' },
  { pattern: /^GET \/api\/events$/, why: 'an event stream' },
  { pattern: /\/log$|\/logs$|\/updates\/log$/, why: 'log streams: the logs tool reads them' },
  { pattern: /\/log\.txt$|\/download$/, why: 'file downloads' },
  { pattern: /\/objects\/:key\{\.\+\}$/, why: 'raw file transfer' },
  { pattern: /^POST \/api\/applications\/:id\/upload$/, why: 'a raw archive upload: the code tool deploys edited sources' },
  { pattern: /^\w+ \/api\/github\/(manifest|install|setup|pending)|^DELETE \/api\/github(\/|$)/, why: 'connecting GitHub happens in the browser, on github.com' },
  { pattern: /^GET \/api\/git-providers\/:id\/webhook$/, why: 'a webhook secret' },
  { pattern: /^\w+ \/api\/(mcp|connect|cli)(\/|$)/, why: 'connecting outside apps and the command line: people decide that in the dashboard, not an assistant' },
  { pattern: /^\w+ \/api\/transfers(\/|$)/, why: 'moving a project between panels carries every secret it has: people do it in the dashboard or with the command line' },
  { pattern: /^\*|^ALL /, why: 'catch-all handlers' },
];

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

interface Compiled {
  entry: ApiEntry;
  regex: RegExp;
  params: string[];
}

const compiled: Compiled[] = API_CATALOG.map((entry) => {
  const params: string[] = [];
  const source = entry.path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      params.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { entry, regex: new RegExp(`^${source}$`), params };
});

export interface MatchedEntry {
  entry: ApiEntry;
  params: Record<string, string>;
}

/** The catalog entry a concrete call (`POST /api/applications/app_1/deploy`) belongs to. */
export function matchApi(method: string, path: string): MatchedEntry | null {
  const wanted = method.toUpperCase();
  for (const candidate of compiled) {
    if (candidate.entry.method !== wanted) continue;
    const match = candidate.regex.exec(path);
    if (match === null) continue;
    const params: Record<string, string> = {};
    candidate.params.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1] ?? '');
    });
    return { entry: candidate.entry, params };
  }
  return null;
}

export function riskOf(entry: ApiEntry, body: Record<string, unknown>): AiRisk {
  if (typeof entry.risk === 'function') return entry.risk(body);
  return entry.risk ?? (entry.method === 'GET' ? 'safe' : entry.method === 'DELETE' ? 'danger' : 'change');
}

/** A path template with the call's own parameters and the answer's id filled in; null when one is missing. */
export function fillPath(template: string, params: Record<string, string>, response: unknown): string | null {
  let missing = false;
  const filled = template
    .replace(/:([A-Za-z]+)/g, (_match, name: string) => {
      const value = params[name];
      if (value === undefined) missing = true;
      return encodeURIComponent(value ?? '');
    })
    .replace(/\{id\}/g, () => {
      const id = typeof response === 'object' && response !== null ? (response as { id?: unknown }).id : undefined;
      if (typeof id !== 'string' && typeof id !== 'number') missing = true;
      return encodeURIComponent(String(id ?? ''));
    });
  return missing ? null : filled;
}

// ---------------------------------------------------------------------------
// Describing schemas
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** A JSON Schema as a compact TypeScript-like type: what a model needs to fill a body in, without the regular expressions. */
export function describeJsonSchema(schema: Json, depth = 0): string {
  if (depth > 5) return 'object';
  const variants = (schema.anyOf ?? schema.oneOf) as Json[] | undefined;
  if (Array.isArray(variants)) {
    const parts = [...new Set(variants.map((variant) => describeJsonSchema(variant, depth + 1)))];
    return parts.join(' | ');
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  const type = schema.type;
  if (type === 'object' || schema.properties !== undefined) {
    const properties = (schema.properties ?? {}) as Record<string, Json>;
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const keys = Object.keys(properties);
    if (keys.length === 0) return schema.additionalProperties !== undefined && schema.additionalProperties !== false ? 'Record<string, any>' : '{}';
    const fields = keys.map((key) => {
      const property = properties[key]!;
      const hasDefault = property.default !== undefined;
      const optional = !required.has(key) || hasDefault;
      const suffix = hasDefault && (typeof property.default !== 'object' || property.default === null) ? ` = ${JSON.stringify(property.default)}` : '';
      return `${key}${optional ? '?' : ''}: ${describeJsonSchema(property, depth + 1)}${suffix}`;
    });
    return `{ ${fields.join(', ')} }`;
  }
  if (type === 'array') {
    const items = schema.items as Json | undefined;
    const inner = items === undefined ? 'any' : describeJsonSchema(items, depth + 1);
    return /[ |]/.test(inner) && !inner.startsWith('{') ? `(${inner})[]` : `${inner}[]`;
  }
  if (type === 'integer' || type === 'number') {
    const min = schema.minimum ?? schema.exclusiveMinimum;
    const max = schema.maximum ?? schema.exclusiveMaximum;
    const bounded = typeof min === 'number' && typeof max === 'number' && max < 1e12;
    return bounded ? `${type === 'integer' ? 'int' : 'number'}(${min}..${max})` : type === 'integer' ? 'int' : 'number';
  }
  if (type === 'string') return 'string';
  if (type === 'boolean') return 'boolean';
  if (type === 'null') return 'null';
  return 'any';
}

const described = new WeakMap<ZodType, string>();

export function describeSchema(schema: ZodType): string {
  const known = described.get(schema);
  if (known !== undefined) return known;
  let text: string;
  try {
    text = describeJsonSchema(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json);
  } catch {
    text = 'object';
  }
  described.set(schema, text);
  return text;
}

const roleLabel = (role: ApiEntry['role']): string => (role === 'any' ? 'anyone signed in' : role === 'instance' ? 'instance administrator' : `${role}+`);

export function describeEntry(entry: ApiEntry, detailed: boolean): string {
  const risk = typeof entry.risk === 'function' ? 'depends on the statement' : riskOf(entry, {});
  const head = `${entry.method} ${entry.path} — ${entry.summary} [${roleLabel(entry.role)}${risk === 'safe' ? '' : `; ${risk === 'danger' ? 'dangerous, always asks' : 'asks before running'}`}]`;
  if (!detailed) return head;
  const lines = [head];
  if (entry.query !== undefined) lines.push(`  query: ${describeSchema(entry.query)}`);
  if (entry.queryNote !== undefined) lines.push(`  query: ${entry.queryNote}`);
  if (entry.body !== undefined) lines.push(`  body: ${describeSchema(entry.body)}`);
  if (entry.note !== undefined) lines.push(`  note: ${entry.note}`);
  return lines.join('\n');
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'with', 'api', 'how', 'do', 'i', 'is', 'get', 'list', 'show']);

/** Endpoints that match a few words, best first. */
export function searchApi(query: string, limit = 12): ApiEntry[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
  if (words.length === 0) return [];
  const scored: { entry: ApiEntry; score: number; order: number }[] = [];
  for (const [order, entry] of API_CATALOG.entries()) {
    const path = entry.path.toLowerCase();
    const summary = entry.summary.toLowerCase();
    let score = 0;
    for (const word of words) {
      const stem = word.length > 4 ? word.replace(/(ies|es|s|ing|ed)$/, '') : word;
      if (entry.area === word || entry.area.startsWith(stem)) score += 4;
      if (path.includes(stem)) score += 3;
      if (summary.includes(stem)) score += 2;
      if (entry.method.toLowerCase() === word) score += 1;
    }
    if (score > 0) scored.push({ entry, score, order });
  }
  // Equal matches keep the catalog's order, which puts the common thing (an application's) before the rare one.
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((item) => item.entry);
}

/** The areas of the API with how many endpoints each has: what `api_docs` answers when asked nothing. */
export function apiAreas(): string {
  const counts = new Map<string, number>();
  for (const entry of API_CATALOG) counts.set(entry.area, (counts.get(entry.area) ?? 0) + 1);
  return [...counts].map(([name, count]) => `${name} (${count})`).join(', ');
}
