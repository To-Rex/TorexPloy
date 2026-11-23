/**
 * Exports and imports of projects, one row each. The archive is a file under
 * `<dataDir>/transfers/<id>.torexploy`; the row says where it came from, how
 * far the work got, and what is left to do.
 */
import type { ImportPlan, TransferInclude, TransferKind, TransferNoteDto, TransferS3StateDto, TransferSource, TransferStatus, TransferStepDto } from '@ploy/shared';
import type { Database } from '../db/database.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { json, num, numOrNull, str, strOrNull, type Row } from './util.ts';

/** What a transfer must remember between steps (and across a restart of the panel). */
export interface TransferState {
  /** Containers frozen for a consistent copy, so a restart in the middle resumes them. */
  paused?: { serverId: string; container: string }[];
  /** An import's progress in ids. */
  import?: ImportState;
  /** The import checked the whole archive already. */
  verified?: boolean;
}

/** An import's progress in ids, so a retry carries on where it stopped. */
export interface ImportState {
  projectId?: string;
  /** Archive id → id made here. */
  services: Record<string, string>;
  applications: Record<string, string>;
  volumes: Record<string, string>;
  /** Built images loaded from the archive: application (archive id) → the tag it runs as here. */
  images: Record<string, string>;
  /** Entries put back, by path. */
  applied: string[];
  /** Applications that got their settings, variables, domains, links and jobs. */
  configured: string[];
  /** Services whose buckets and keys were made. */
  stocked: string[];
  deployed: string[];
}

export interface TransferRecord {
  id: string;
  teamId: string;
  kind: TransferKind;
  status: TransferStatus;
  source: TransferSource;
  projectId: string | null;
  projectName: string | null;
  fileName: string;
  sizeBytes: number | null;
  receivedBytes: number;
  expectedBytes: number | null;
  include: TransferInclude | null;
  passphraseSealed: string | null;
  plan: ImportPlan | null;
  steps: TransferStepDto[];
  percent: number;
  warnings: TransferNoteDto[];
  error: TransferNoteDto | null;
  state: TransferState | null;
  shareHash: string | null;
  shareExpiresAt: string | null;
  shareDownloads: number;
  shareLastAt: string | null;
  s3: TransferS3StateDto | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
}

function map(row: Row): TransferRecord {
  return {
    id: str(row.id),
    teamId: str(row.team_id),
    kind: str(row.kind) === 'import' ? 'import' : 'export',
    status: str(row.status) as TransferStatus,
    source: str(row.source) as TransferSource,
    projectId: strOrNull(row.project_id),
    projectName: strOrNull(row.project_name),
    fileName: str(row.file_name),
    sizeBytes: numOrNull(row.size_bytes),
    receivedBytes: num(row.received_bytes ?? 0),
    expectedBytes: numOrNull(row.expected_bytes),
    include: json<TransferInclude | null>(row.include, null),
    passphraseSealed: strOrNull(row.passphrase_sealed),
    plan: json<ImportPlan | null>(row.plan, null),
    steps: json<TransferStepDto[]>(row.steps, []),
    percent: num(row.percent ?? 0),
    warnings: json<TransferNoteDto[]>(row.warnings, []),
    error: json<TransferNoteDto | null>(row.error, null),
    state: json<TransferState | null>(row.state, null),
    shareHash: strOrNull(row.share_hash),
    shareExpiresAt: strOrNull(row.share_expires_at),
    shareDownloads: num(row.share_downloads ?? 0),
    shareLastAt: strOrNull(row.share_last_at),
    s3: json<TransferS3StateDto | null>(row.s3, null),
    createdBy: strOrNull(row.created_by),
    createdByName: strOrNull(row.created_by_name),
    createdAt: str(row.created_at),
    startedAt: strOrNull(row.started_at),
    finishedAt: strOrNull(row.finished_at),
    expiresAt: strOrNull(row.expires_at),
  };
}

/** Fields that change after a transfer is made, and their columns (JSON ones are stringified). */
const COLUMNS = {
  status: 'status',
  projectId: 'project_id',
  projectName: 'project_name',
  fileName: 'file_name',
  sizeBytes: 'size_bytes',
  receivedBytes: 'received_bytes',
  expectedBytes: 'expected_bytes',
  include: 'include',
  passphraseSealed: 'passphrase_sealed',
  plan: 'plan',
  steps: 'steps',
  percent: 'percent',
  warnings: 'warnings',
  error: 'error',
  state: 'state',
  shareHash: 'share_hash',
  shareExpiresAt: 'share_expires_at',
  s3: 's3',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  expiresAt: 'expires_at',
} as const satisfies Partial<Record<keyof TransferRecord, string>>;

const JSON_FIELDS = new Set<string>(['include', 'plan', 'steps', 'warnings', 'error', 'state', 's3']);

export type TransferPatch = Partial<Pick<TransferRecord, keyof typeof COLUMNS>>;

const SELECT = 'SELECT t.*, u.name AS created_by_name FROM transfers t LEFT JOIN users u ON u.id = t.created_by';

export class TransferStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  create(input: {
    teamId: string;
    kind: TransferKind;
    status: TransferStatus;
    source: TransferSource;
    projectId?: string | null;
    projectName?: string | null;
    fileName: string;
    include?: TransferInclude | null;
    passphraseSealed?: string | null;
    expectedBytes?: number | null;
    createdBy: string | null;
    expiresAt?: string | null;
  }): TransferRecord {
    const id = newId('trf');
    this.db.run(
      `INSERT INTO transfers (id, team_id, kind, status, source, project_id, project_name, file_name, include, passphrase_sealed, expected_bytes, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.teamId,
      input.kind,
      input.status,
      input.source,
      input.projectId ?? null,
      input.projectName ?? null,
      input.fileName,
      input.include === undefined || input.include === null ? null : JSON.stringify(input.include),
      input.passphraseSealed ?? null,
      input.expectedBytes ?? null,
      input.createdBy,
      nowIso(),
      input.expiresAt ?? null,
    );
    return this.get(id)!;
  }

  get(id: string): TransferRecord | undefined {
    const row = this.db.get(`${SELECT} WHERE t.id = ?`, id);
    return row === undefined ? undefined : map(row);
  }

  getForTeam(teamId: string, id: string): TransferRecord | undefined {
    const row = this.db.get(`${SELECT} WHERE t.id = ? AND t.team_id = ?`, id, teamId);
    return row === undefined ? undefined : map(row);
  }

  listForTeam(teamId: string, filter: { kind?: TransferKind; projectId?: string } = {}): TransferRecord[] {
    const clauses = ['t.team_id = ?'];
    const params: string[] = [teamId];
    if (filter.kind !== undefined) {
      clauses.push('t.kind = ?');
      params.push(filter.kind);
    }
    if (filter.projectId !== undefined) {
      clauses.push('t.project_id = ?');
      params.push(filter.projectId);
    }
    return this.db.all(`${SELECT} WHERE ${clauses.join(' AND ')} ORDER BY t.created_at DESC LIMIT 200`, ...params).map(map);
  }

  /** Every transfer in one of these states (work to pick up, or to close out after a restart). */
  listByStatus(statuses: TransferStatus[]): TransferRecord[] {
    return this.db.all(`${SELECT} WHERE t.status IN (${statuses.map(() => '?').join(', ')}) ORDER BY t.created_at`, ...statuses).map(map);
  }

  findByShareHash(hash: string): TransferRecord | undefined {
    const row = this.db.get(`${SELECT} WHERE t.share_hash = ?`, hash);
    return row === undefined ? undefined : map(row);
  }

  /** Transfers whose archive is past keeping. */
  listExpired(now: string): TransferRecord[] {
    return this.db.all(`${SELECT} WHERE t.expires_at IS NOT NULL AND t.expires_at <= ?`, now).map(map);
  }

  update(id: string, patch: TransferPatch): TransferRecord {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, column] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, string][]) {
      if (!(key in patch)) continue;
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value === null ? null : JSON_FIELDS.has(key) ? JSON.stringify(value) : (value as string | number));
    }
    if (sets.length > 0) this.db.run(`UPDATE transfers SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
    return this.get(id)!;
  }

  countDownload(id: string): void {
    this.db.run('UPDATE transfers SET share_downloads = share_downloads + 1, share_last_at = ? WHERE id = ?', nowIso(), id);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM transfers WHERE id = ?', id);
  }
}
