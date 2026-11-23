/**
 * TorexAi's skills as stored: the ones installed on this instance, the
 * repositories they may come from, and what those repositories held when
 * they were last read.
 */
import type { AiSkillFlag, AiSkillSource } from '@ploy/shared';
import type { Database } from '../db/database.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { bool, int01, json, num, str, strOrNull, type Row } from './util.ts';

export interface SkillRecord {
  name: string;
  description: string;
  body: string;
  files: Record<string, string>;
  metadata: Record<string, string>;
  source: AiSkillSource;
  origin: string | null;
  hash: string;
  flags: AiSkillFlag[];
  enabled: boolean;
  auto: boolean;
  installedBy: string | null;
  uses: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillSourceRecord {
  id: string;
  repo: string;
  ref: string | null;
  commit: string | null;
  syncedAt: string | null;
  error: string | null;
  createdAt: string;
}

export interface CatalogRecord {
  sourceId: string;
  name: string;
  description: string;
  path: string;
  body: string;
  files: Record<string, string>;
  metadata: Record<string, string>;
  hash: string;
  flags: AiSkillFlag[];
}

export type SkillInput = Pick<SkillRecord, 'name' | 'description' | 'body' | 'files' | 'metadata' | 'source' | 'origin' | 'hash' | 'flags' | 'auto' | 'installedBy'>;

function mapSkill(row: Row): SkillRecord {
  return {
    name: str(row.name),
    description: str(row.description),
    body: str(row.body),
    files: json<Record<string, string>>(row.files, {}),
    metadata: json<Record<string, string>>(row.metadata, {}),
    source: str(row.source) as AiSkillSource,
    origin: strOrNull(row.origin),
    hash: str(row.hash),
    flags: json<AiSkillFlag[]>(row.flags, []),
    enabled: bool(row.enabled),
    auto: bool(row.auto),
    installedBy: strOrNull(row.installed_by),
    uses: num(row.uses),
    lastUsedAt: strOrNull(row.last_used_at),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function mapSource(row: Row): SkillSourceRecord {
  return { id: str(row.id), repo: str(row.repo), ref: strOrNull(row.ref), commit: strOrNull(row.commit_sha), syncedAt: strOrNull(row.synced_at), error: strOrNull(row.error), createdAt: str(row.created_at) };
}

function mapCatalog(row: Row): CatalogRecord {
  return {
    sourceId: str(row.source_id),
    name: str(row.name),
    description: str(row.description),
    path: str(row.path),
    body: str(row.body),
    files: json<Record<string, string>>(row.files, {}),
    metadata: json<Record<string, string>>(row.metadata, {}),
    hash: str(row.hash),
    flags: json<AiSkillFlag[]>(row.flags, []),
  };
}

export class SkillStore {
  private readonly db: Database;
  /** Grows with every change to what is installed or offered, so a cache built from them knows when it is stale. */
  revision = 0;

  constructor(db: Database) {
    this.db = db;
  }

  // ---------------------------------------------------------------- installed

  list(): SkillRecord[] {
    return this.db.all('SELECT * FROM ai_skills ORDER BY name ASC').map(mapSkill);
  }

  get(name: string): SkillRecord | undefined {
    const row = this.db.get('SELECT * FROM ai_skills WHERE name = ?', name);
    return row === undefined ? undefined : mapSkill(row);
  }

  count(): number {
    return num(this.db.scalar('SELECT COUNT(*) FROM ai_skills') ?? 0);
  }

  /** Install a skill, or replace the text of one that is installed (its state and its counters stay). */
  put(input: SkillInput): SkillRecord {
    this.revision += 1;
    const now = nowIso();
    this.db.run(
      `INSERT INTO ai_skills (name, description, body, files, metadata, source, origin, hash, flags, auto, installed_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET description = excluded.description, body = excluded.body, files = excluded.files, metadata = excluded.metadata,
         source = excluded.source, origin = excluded.origin, hash = excluded.hash, flags = excluded.flags, updated_at = excluded.updated_at`,
      input.name,
      input.description,
      input.body,
      JSON.stringify(input.files),
      JSON.stringify(input.metadata),
      input.source,
      input.origin,
      input.hash,
      JSON.stringify(input.flags),
      int01(input.auto),
      input.installedBy,
      now,
      now,
    );
    return this.get(input.name)!;
  }

  setEnabled(name: string, enabled: boolean): void {
    this.revision += 1;
    this.db.run('UPDATE ai_skills SET enabled = ?, updated_at = ? WHERE name = ?', int01(enabled), nowIso(), name);
  }

  used(name: string): void {
    this.db.run('UPDATE ai_skills SET uses = uses + 1, last_used_at = ? WHERE name = ?', nowIso(), name);
  }

  remove(name: string): void {
    this.revision += 1;
    this.db.run('DELETE FROM ai_skills WHERE name = ?', name);
  }

  // ------------------------------------------------------------------ sources

  sources(): SkillSourceRecord[] {
    return this.db.all('SELECT * FROM ai_skill_sources ORDER BY created_at ASC, id ASC').map(mapSource);
  }

  source(id: string): SkillSourceRecord | undefined {
    const row = this.db.get('SELECT * FROM ai_skill_sources WHERE id = ?', id);
    return row === undefined ? undefined : mapSource(row);
  }

  sourceByRepo(repo: string): SkillSourceRecord | undefined {
    const row = this.db.get('SELECT * FROM ai_skill_sources WHERE repo = ? COLLATE NOCASE', repo);
    return row === undefined ? undefined : mapSource(row);
  }

  addSource(repo: string, ref: string | null): SkillSourceRecord {
    this.revision += 1;
    const id = newId('aik');
    this.db.run('INSERT INTO ai_skill_sources (id, repo, ref, created_at) VALUES (?, ?, ?, ?)', id, repo, ref, nowIso());
    return this.source(id)!;
  }

  removeSource(id: string): void {
    this.revision += 1;
    this.db.run('DELETE FROM ai_skill_sources WHERE id = ?', id);
  }

  setSourceError(id: string, error: string): void {
    this.db.run('UPDATE ai_skill_sources SET error = ?, synced_at = ? WHERE id = ?', error, nowIso(), id);
  }

  /** Replace what a repository is known to hold. */
  setCatalog(sourceId: string, commit: string | null, entries: Omit<CatalogRecord, 'sourceId'>[]): void {
    this.revision += 1;
    this.db.transaction(() => {
      this.db.run('DELETE FROM ai_skill_catalog WHERE source_id = ?', sourceId);
      for (const entry of entries) {
        this.db.run(
          'INSERT INTO ai_skill_catalog (source_id, name, description, path, body, files, metadata, hash, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          sourceId,
          entry.name,
          entry.description,
          entry.path,
          entry.body,
          JSON.stringify(entry.files),
          JSON.stringify(entry.metadata),
          entry.hash,
          JSON.stringify(entry.flags),
        );
      }
      this.db.run('UPDATE ai_skill_sources SET commit_sha = ?, synced_at = ?, error = NULL WHERE id = ?', commit, nowIso(), sourceId);
    });
  }

  touchSource(id: string): void {
    this.db.run('UPDATE ai_skill_sources SET synced_at = ?, error = NULL WHERE id = ?', nowIso(), id);
  }

  catalog(): CatalogRecord[] {
    return this.db.all('SELECT c.* FROM ai_skill_catalog c JOIN ai_skill_sources s ON s.id = c.source_id ORDER BY s.created_at ASC, s.id ASC, c.name ASC').map(mapCatalog);
  }

  catalogEntry(sourceId: string, name: string): CatalogRecord | undefined {
    const row = this.db.get('SELECT * FROM ai_skill_catalog WHERE source_id = ? AND name = ?', sourceId, name);
    return row === undefined ? undefined : mapCatalog(row);
  }

  catalogCounts(): Map<string, number> {
    return new Map(this.db.all('SELECT source_id, COUNT(*) AS n FROM ai_skill_catalog GROUP BY source_id').map((row) => [str(row.source_id), num(row.n)]));
  }
}
