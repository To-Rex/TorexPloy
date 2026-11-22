/**
 * The database console's server calls, query keys and the bits of browser
 * storage it keeps (open tabs, query history), all per service.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  DbActivityDto,
  DbChange,
  DbChangesResultDto,
  DbFilter,
  DbObjectKind,
  DbObjectSourceDto,
  DbOverviewDto,
  DbRoleDto,
  DbRowsDto,
  DbRowsInput,
  DbRunResultDto,
  DbSort,
  DbTableDto,
  DbTreeDto,
} from '@ploy/shared';
import { api, qs } from '../../lib/api.ts';

const base = (serviceId: string) => `/api/services/${serviceId}/db`;

export const dbKeys = {
  all: (serviceId: string) => ['db', serviceId] as const,
  overview: (serviceId: string) => ['db', serviceId, 'overview'] as const,
  tree: (serviceId: string, database: string) => ['db', serviceId, 'tree', database] as const,
  table: (serviceId: string, database: string, schema: string | null, name: string) => ['db', serviceId, 'table', database, schema ?? '', name] as const,
  source: (serviceId: string, database: string, schema: string | null, name: string, kind: DbObjectKind) => ['db', serviceId, 'source', database, schema ?? '', name, kind] as const,
  rows: (serviceId: string, input: DbRowsInput) => ['db', serviceId, 'rows', input] as const,
  activity: (serviceId: string) => ['db', serviceId, 'activity'] as const,
  roles: (serviceId: string) => ['db', serviceId, 'roles'] as const,
};

export const useDbOverview = (serviceId: string, enabled = true) =>
  useQuery({ queryKey: dbKeys.overview(serviceId), queryFn: () => api.get<DbOverviewDto>(`${base(serviceId)}/overview`), staleTime: 30_000, retry: false, enabled });

export const useDbTree = (serviceId: string, database: string) =>
  useQuery({
    queryKey: dbKeys.tree(serviceId, database),
    queryFn: () => api.get<DbTreeDto>(`${base(serviceId)}/tree${qs({ database })}`),
    enabled: database.length > 0,
    staleTime: 60_000,
    retry: false,
  });

export const fetchTable = (serviceId: string, database: string, schema: string | null, name: string) =>
  api.get<DbTableDto>(`${base(serviceId)}/table${qs({ database, schema: schema ?? undefined, name, fresh: 1 })}`);

export const useDbTable = (serviceId: string, database: string, schema: string | null, name: string, enabled = true) =>
  useQuery({
    queryKey: dbKeys.table(serviceId, database, schema, name),
    queryFn: () => fetchTable(serviceId, database, schema, name),
    enabled,
    staleTime: 60_000,
    retry: false,
  });

export const useDbSource = (serviceId: string, database: string, schema: string | null, name: string, kind: DbObjectKind, detail: string | null) =>
  useQuery({
    queryKey: dbKeys.source(serviceId, database, schema, name, kind),
    queryFn: () => api.get<DbObjectSourceDto>(`${base(serviceId)}/source${qs({ database, schema: schema ?? undefined, name, kind, detail: detail ?? undefined })}`),
    staleTime: 60_000,
    retry: false,
  });

export const useDbRows = (serviceId: string, input: DbRowsInput, enabled = true) =>
  useQuery({
    queryKey: dbKeys.rows(serviceId, input),
    queryFn: () => api.post<DbRowsDto>(`${base(serviceId)}/rows`, input),
    placeholderData: keepPreviousData,
    enabled,
    retry: false,
  });

export const useDbActivity = (serviceId: string, live: boolean) =>
  useQuery({
    queryKey: dbKeys.activity(serviceId),
    queryFn: () => api.get<DbActivityDto>(`${base(serviceId)}/activity`),
    refetchInterval: live ? 3_000 : false,
    retry: false,
  });

export const useDbRoles = (serviceId: string) => useQuery({ queryKey: dbKeys.roles(serviceId), queryFn: () => api.get<DbRoleDto[]>(`${base(serviceId)}/roles`), retry: false });

export interface RunInput {
  database: string;
  session: string;
  sql: string;
  limit?: number;
  readOnly?: boolean;
  timeoutSec?: number;
}

export const runSql = (serviceId: string, input: RunInput) => api.post<DbRunResultDto>(`${base(serviceId)}/run`, input);
export const cancelRun = (serviceId: string, session: string) => api.post<{ cancelled: boolean }>(`${base(serviceId)}/cancel`, { session });
export const closeSession = (serviceId: string, session: string) => api.post(`${base(serviceId)}/close`, { session }).catch(() => undefined);
export const applyChanges = (serviceId: string, input: { database: string; schema: string | null; table: string; changes: DbChange[] }) =>
  api.post<DbChangesResultDto>(`${base(serviceId)}/changes`, input);
export const signalSession = (serviceId: string, pid: string, action: 'cancel' | 'terminate') => api.post<{ ok: boolean }>(`${base(serviceId)}/activity`, { pid, action });

export function exportUrl(serviceId: string, input: { database: string; schema: string | null; table: string; format: 'csv' | 'json' | 'sql'; filters?: DbFilter[]; sort?: DbSort[]; where?: string }): string {
  const view = (input.filters?.length ?? 0) > 0 || (input.sort?.length ?? 0) > 0 || (input.where ?? '').length > 0 ? JSON.stringify({ filters: input.filters ?? [], sort: input.sort ?? [], where: input.where ?? '' }) : undefined;
  return `${base(serviceId)}/export${qs({ database: input.database, schema: input.schema ?? undefined, table: input.table, format: input.format, view })}`;
}

/** A connection id for a query tab: random, so another tab (or person) cannot guess it. */
export function newSessionId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `tab-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

// ------------------------------------------------------------------ storage

export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows and full storage: the console works without it.
  }
}

export interface HistoryEntry {
  sql: string;
  database: string;
  at: number;
  ok: boolean;
  ms: number;
  rows: number | null;
}

const historyKey = (serviceId: string) => `ploy.db.${serviceId}.history`;

export function readHistory(serviceId: string): HistoryEntry[] {
  return readStored<HistoryEntry[]>(historyKey(serviceId), []);
}

export function pushHistory(serviceId: string, entry: HistoryEntry): void {
  const list = readHistory(serviceId).filter((item) => item.sql !== entry.sql);
  writeStored(historyKey(serviceId), [entry, ...list].slice(0, 200));
}

export function clearHistory(serviceId: string): void {
  writeStored(historyKey(serviceId), []);
}

/** Save text as a file in the browser (an exported result). */
export function download(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
