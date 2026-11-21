/**
 * GitLab and Bitbucket connections: an account reached with an access token,
 * and the webhooks the panel set up on its repositories. The token and the
 * webhook secret are sealed; neither is ever sent back to a browser except
 * the secret, to an administrator setting a webhook up by hand.
 */
import type { GitProviderKind } from '@ploy/shared';
import type { Database } from '../db/database.ts';
import { generateToken } from '../lib/crypto.ts';
import { newId, nowIso } from '../lib/ids.ts';
import type { Secrets } from '../lib/secrets.ts';
import { str, strOrNull, type Row } from './util.ts';

export interface GitProviderCredentials {
  token: string;
  /** Bitbucket API tokens: the Atlassian account email, for Basic auth. */
  email: string | null;
}

export interface GitProviderRecord {
  id: string;
  teamId: string;
  kind: GitProviderKind;
  name: string;
  /** API and web origin (`https://gitlab.com`, a GitLab of your own, `https://bitbucket.org`). */
  baseUrl: string;
  accountLogin: string;
  accountName: string | null;
  avatarUrl: string | null;
  /** Bitbucket: the workspace the connection is limited to. */
  workspace: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitHookRecord {
  providerId: string;
  repository: string;
  hookId: string | null;
  status: 'ok' | 'failed';
  reason: string | null;
  message: string | null;
  updatedAt: string;
}

function mapProvider(row: Row): GitProviderRecord {
  return {
    id: str(row.id),
    teamId: str(row.team_id),
    kind: str(row.kind) as GitProviderKind,
    name: str(row.name),
    baseUrl: str(row.base_url),
    accountLogin: str(row.account_login),
    accountName: strOrNull(row.account_name),
    avatarUrl: strOrNull(row.avatar_url),
    workspace: strOrNull(row.workspace),
    createdBy: strOrNull(row.created_by),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function mapHook(row: Row): GitHookRecord {
  return {
    providerId: str(row.provider_id),
    repository: str(row.repository),
    hookId: strOrNull(row.hook_id),
    status: str(row.status) as GitHookRecord['status'],
    reason: strOrNull(row.reason),
    message: strOrNull(row.message),
    updatedAt: str(row.updated_at),
  };
}

export interface NewGitProvider {
  teamId: string;
  kind: GitProviderKind;
  name: string;
  baseUrl: string;
  account: { login: string; name: string | null; avatarUrl: string | null };
  workspace: string | null;
  credentials: GitProviderCredentials;
  createdBy: string | null;
}

export class GitProviderStore {
  private readonly db: Database;
  private readonly secrets: Secrets;

  constructor(db: Database, secrets: Secrets) {
    this.db = db;
    this.secrets = secrets;
  }

  create(input: NewGitProvider): GitProviderRecord {
    const id = newId('git');
    const now = nowIso();
    this.db.run(
      `INSERT INTO git_providers (id, team_id, kind, name, base_url, account_login, account_name, avatar_url, workspace, credentials, webhook_secret, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.teamId,
      input.kind,
      input.name,
      input.baseUrl,
      input.account.login,
      input.account.name,
      input.account.avatarUrl,
      input.workspace,
      this.secrets.sealJson(input.credentials, 'git'),
      this.secrets.seal(generateToken(24), 'git'),
      input.createdBy,
      now,
      now,
    );
    return this.get(id)!;
  }

  get(id: string): GitProviderRecord | undefined {
    const row = this.db.get('SELECT * FROM git_providers WHERE id = ?', id);
    return row === undefined ? undefined : mapProvider(row);
  }

  getForTeam(teamId: string, id: string): GitProviderRecord | undefined {
    const provider = this.get(id);
    return provider?.teamId === teamId ? provider : undefined;
  }

  listForTeam(teamId: string): GitProviderRecord[] {
    return this.db.all('SELECT * FROM git_providers WHERE team_id = ? ORDER BY created_at', teamId).map(mapProvider);
  }

  credentials(id: string): GitProviderCredentials {
    return this.secrets.openJson<GitProviderCredentials>(str(this.db.scalar('SELECT credentials FROM git_providers WHERE id = ?', id)), 'git');
  }

  webhookSecret(id: string): string {
    return this.secrets.open(str(this.db.scalar('SELECT webhook_secret FROM git_providers WHERE id = ?', id)), 'git');
  }

  update(
    id: string,
    patch: { name?: string; credentials?: GitProviderCredentials; workspace?: string | null; account?: { login: string; name: string | null; avatarUrl: string | null } },
  ): GitProviderRecord {
    const sets: string[] = ['updated_at = ?'];
    const values: (string | null)[] = [nowIso()];
    if (patch.name !== undefined) sets.push('name = ?'), values.push(patch.name);
    if (patch.credentials !== undefined) sets.push('credentials = ?'), values.push(this.secrets.sealJson(patch.credentials, 'git'));
    if (patch.workspace !== undefined) sets.push('workspace = ?'), values.push(patch.workspace);
    if (patch.account !== undefined) {
      sets.push('account_login = ?', 'account_name = ?', 'avatar_url = ?');
      values.push(patch.account.login, patch.account.name, patch.account.avatarUrl);
    }
    this.db.run(`UPDATE git_providers SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
    return this.get(id)!;
  }

  delete(id: string): void {
    this.db.run('DELETE FROM git_providers WHERE id = ?', id);
  }

  // ---------------------------------------------------------------- hooks

  hook(providerId: string, repository: string): GitHookRecord | undefined {
    const row = this.db.get('SELECT * FROM git_hooks WHERE provider_id = ? AND repository = ?', providerId, repository);
    return row === undefined ? undefined : mapHook(row);
  }

  hooks(providerId: string): GitHookRecord[] {
    return this.db.all('SELECT * FROM git_hooks WHERE provider_id = ?', providerId).map(mapHook);
  }

  setHook(providerId: string, repository: string, result: { status: 'ok' | 'failed'; hookId?: string | null; reason?: string | null; message?: string | null }): GitHookRecord {
    const existing = this.hook(providerId, repository);
    this.db.run(
      `INSERT INTO git_hooks (provider_id, repository, hook_id, status, reason, message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider_id, repository) DO UPDATE SET hook_id = excluded.hook_id, status = excluded.status, reason = excluded.reason, message = excluded.message, updated_at = excluded.updated_at`,
      providerId,
      repository,
      // A failure to re-check keeps the id of the hook that was made before.
      result.hookId === undefined ? (existing?.hookId ?? null) : result.hookId,
      result.status,
      result.reason ?? null,
      result.message?.slice(0, 1_000) ?? null,
      nowIso(),
    );
    return this.hook(providerId, repository)!;
  }

  deleteHook(providerId: string, repository: string): void {
    this.db.run('DELETE FROM git_hooks WHERE provider_id = ? AND repository = ?', providerId, repository);
  }
}
