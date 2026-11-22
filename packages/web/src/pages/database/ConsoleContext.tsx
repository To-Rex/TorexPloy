/**
 * What every part of the console shares: the service, the engine, the
 * database being browsed, how to open tabs, and how to run a statement a
 * dialog built (shown first, run on a connection of its own).
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import {
  dialectOf,
  quoteIdent,
  SQL_FUNCTIONS,
  SQL_KEYWORDS,
  type DbConsoleType,
  type DbErrorDto,
  type DbObjectKind,
  type DbOverviewDto,
  type DbRunResultDto,
  type DbTableDto,
  type DbTreeDto,
  type ServiceDto,
  type SqlDialect,
} from '@ploy/shared';
import { Dialog } from '../../components/Dialog.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Button, Callout } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { errorText } from '../../lib/errors.ts';
import { dbKeys, fetchTable, newSessionId, runSql } from './dbApi.ts';
import type { Completion, CompletionContext } from './SqlEditor.tsx';
import { SqlEditor } from './SqlEditor.tsx';

export type TableView = 'data' | 'structure' | 'ddl';

export type ConsoleTab =
  | { id: string; kind: 'dashboard' }
  | { id: string; kind: 'activity' }
  | { id: string; kind: 'roles' }
  | { id: string; kind: 'query'; title: string; sql: string; session: string; database: string; limit: number; readOnly: boolean }
  | { id: string; kind: 'table'; database: string; schema: string | null; name: string; objectKind: DbObjectKind; view: TableView }
  | { id: string; kind: 'object'; database: string; schema: string | null; name: string; objectKind: DbObjectKind; detail: string | null };

export interface SqlRequest {
  title: string;
  sql: string;
  description?: ReactNode;
  danger?: boolean;
  confirmLabel?: string;
  /** Database to run in; the browsed one by default. */
  database?: string;
  onDone?: (result: DbRunResultDto) => void;
}

interface ConsoleValue {
  service: ServiceDto;
  type: DbConsoleType;
  dialect: SqlDialect;
  overview: DbOverviewDto;
  database: string;
  setDatabase: (name: string) => void;
  /** Whether this engine has schemas inside a database (PostgreSQL). */
  schemas: boolean;
  openTable: (target: { database?: string; schema: string | null; name: string; kind?: DbObjectKind; view?: TableView }) => void;
  openObject: (target: { database?: string; schema: string | null; name: string; kind: DbObjectKind; detail: string | null }) => void;
  openQuery: (sql?: string, title?: string) => void;
  openTool: (kind: 'dashboard' | 'activity' | 'roles') => void;
  closeTab: (id: string) => void;
  /** Show a statement, run it when confirmed. */
  execute: (request: SqlRequest) => void;
  /** Run a statement straight away on the tool connection. */
  runTool: (sql: string, database?: string) => Promise<DbRunResultDto>;
  completions: (context: CompletionContext) => Completion[];
  refresh: () => void;
}

const Context = createContext<ConsoleValue | null>(null);

export function useConsole(): ConsoleValue {
  const value = useContext(Context);
  if (value === null) throw new Error('useConsole outside the console');
  return value;
}

/** A run that failed as a whole or in a statement, as one message. */
export function runFailure(result: DbRunResultDto): DbErrorDto | null {
  return result.error;
}

const TABLE_REFERENCE = /\b(?:from|join|update|into|table)\s+((?:"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:"[^"]+"|`[^`]+`|[\w$]+))?)/gi;

const unquote = (name: string): string => name.replace(/^["`]|["`]$/g, '');

interface ProviderProps {
  service: ServiceDto;
  overview: DbOverviewDto;
  database: string;
  setDatabase: (name: string) => void;
  tree: DbTreeDto | undefined;
  open: (tab: ConsoleTab) => void;
  closeTab: (id: string) => void;
  children: ReactNode;
}

export function ConsoleProvider({ service, overview, database, setDatabase, tree, open, closeTab, children }: ProviderProps) {
  const client = useQueryClient();
  const type = overview.type;
  const dialect = dialectOf(type);
  const [toolSession] = useState(() => newSessionId().replace('tab-', 'tool-'));
  const [request, setRequest] = useState<SqlRequest | null>(null);

  const refresh = useCallback(() => void client.invalidateQueries({ queryKey: dbKeys.all(service.id) }), [client, service.id]);

  const runTool = useCallback(
    (sql: string, target?: string) => runSql(service.id, { database: target ?? database, session: toolSession, sql, limit: 1_000 }),
    [service.id, database, toolSession],
  );

  const completions = useCallback(
    ({ qualifier, text }: CompletionContext): Completion[] => {
      const quote = (name: string) => (/^[a-z_][a-z0-9_$]*$/.test(name) ? name : quoteIdent(name, dialect));
      const objects = (tree?.schemas ?? []).flatMap((schema) => schema.objects.map((object) => ({ schema: schema.name, object })));
      const tableOf = (schema: string | null, name: string): DbTableDto | undefined =>
        client.getQueryData<DbTableDto>(dbKeys.table(service.id, database, dialect === 'postgres' ? (schema ?? 'public') : null, name));
      // Columns of the tables the statement names; fetch the ones not seen yet for the next keystroke.
      const mentioned = [...text.matchAll(TABLE_REFERENCE)].map((match) => {
        const parts = match[1]!.split('.').map(unquote);
        return parts.length === 2 ? { schema: parts[0]!, name: parts[1]! } : { schema: null, name: parts[0]! };
      });
      const known = objects.filter(({ object }) => object.kind === 'table' || object.kind === 'view' || object.kind === 'materialized_view' || object.kind === 'partitioned_table' || object.kind === 'foreign_table');
      const resolve = (name: string, schema: string | null) => known.find(({ schema: owner, object }) => object.name === name && (schema === null || dialect === 'mysql' || owner === schema));
      for (const reference of mentioned) {
        const found = resolve(reference.name, reference.schema);
        if (found === undefined) continue;
        const schema = dialect === 'postgres' ? found.schema : null;
        if (tableOf(schema, found.object.name) === undefined) {
          void client.prefetchQuery({
            queryKey: dbKeys.table(service.id, database, schema ?? (dialect === 'postgres' ? 'public' : null), found.object.name),
            queryFn: () => fetchTable(service.id, database, schema ?? (dialect === 'postgres' ? 'public' : null), found.object.name),
            staleTime: 60_000,
          });
        }
      }
      if (qualifier !== null) {
        // users.<col>, or alias.<col> for "FROM users u", or schema.<table>.
        const alias = new RegExp(`\\b((?:"[^"]+"|[\\w$]+)(?:\\.(?:"[^"]+"|[\\w$]+))?)\\s+(?:as\\s+)?${qualifier.replace(/\$/g, '\\$')}\\b`, 'i').exec(text);
        const name = alias === null ? qualifier : unquote(alias[1]!.split('.').at(-1)!);
        const found = resolve(name, null);
        const table = found === undefined ? undefined : tableOf(dialect === 'postgres' ? found.schema : null, found.object.name);
        if (table !== undefined) return table.columns.map((column) => ({ label: column.name, kind: 'column' as const, detail: column.type, insert: quote(column.name) }));
        const schema = tree?.schemas.find((entry) => entry.name === qualifier);
        if (schema !== undefined) return schema.objects.map((object) => ({ label: object.name, kind: object.kind === 'view' ? ('view' as const) : ('table' as const), detail: object.kind, insert: quote(object.name) }));
        return [];
      }
      const columns: Completion[] = [];
      for (const reference of mentioned) {
        const found = resolve(reference.name, reference.schema);
        const table = found === undefined ? undefined : tableOf(dialect === 'postgres' ? found.schema : null, found.object.name);
        for (const column of table?.columns ?? []) columns.push({ label: column.name, kind: 'column', detail: `${table!.name} · ${column.type}`, insert: quote(column.name) });
      }
      const tables: Completion[] = known.map(({ schema, object }) => ({
        label: object.name,
        kind: object.kind === 'view' || object.kind === 'materialized_view' ? 'view' : 'table',
        detail: dialect === 'postgres' && schema !== 'public' ? schema : undefined,
        insert: dialect === 'postgres' && schema !== 'public' ? `${quote(schema)}.${quote(object.name)}` : quote(object.name),
      }));
      const routines: Completion[] = objects.filter(({ object }) => object.kind === 'function' || object.kind === 'procedure').map(({ object }) => ({ label: object.name, kind: 'function', detail: object.detail ?? undefined }));
      const keywords: Completion[] = SQL_KEYWORDS.map((word) => ({ label: word, kind: 'keyword' }));
      const functions: Completion[] = SQL_FUNCTIONS.map((name) => ({ label: name, kind: 'function', insert: `${name}(` }));
      return [...columns, ...tables, ...routines, ...keywords, ...functions];
    },
    [client, database, dialect, service.id, tree],
  );

  const value = useMemo<ConsoleValue>(
    () => ({
      service,
      type,
      dialect,
      overview,
      database,
      setDatabase,
      schemas: dialect === 'postgres',
      openTable: ({ database: target, schema, name, kind = 'table', view = 'data' }) =>
        open({ id: `table:${target ?? database}:${schema ?? ''}:${name}`, kind: 'table', database: target ?? database, schema, name, objectKind: kind, view }),
      openObject: ({ database: target, schema, name, kind, detail }) =>
        open({ id: `object:${target ?? database}:${schema ?? ''}:${name}:${kind}:${detail ?? ''}`, kind: 'object', database: target ?? database, schema, name, objectKind: kind, detail }),
      openQuery: (sql = '', title) => open({ id: `query:${newSessionId()}`, kind: 'query', title: title ?? '', sql, session: newSessionId(), database, limit: 1_000, readOnly: false }),
      openTool: (kind) => open({ id: kind, kind } as ConsoleTab),
      closeTab,
      execute: setRequest,
      runTool,
      completions,
      refresh,
    }),
    [service, type, dialect, overview, database, setDatabase, open, closeTab, runTool, completions, refresh],
  );

  return (
    <Context.Provider value={value}>
      {children}
      {request !== null && <SqlConfirm request={request} dialect={dialect} onClose={() => setRequest(null)} run={runTool} refresh={refresh} />}
    </Context.Provider>
  );
}

/** The statement a dialog or menu built, shown (and editable) before it runs. */
function SqlConfirm({ request, dialect, onClose, run, refresh }: { request: SqlRequest; dialect: SqlDialect; onClose: () => void; run: (sql: string, database?: string) => Promise<DbRunResultDto>; refresh: () => void }) {
  const { m } = useI18n();
  const toast = useToast();
  const [sql, setSql] = useState(request.sql);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await run(sql, request.database);
      if (result.error !== null) {
        setFailure(result.error.message);
        return;
      }
      toast.success(m.db.confirm.done);
      refresh();
      request.onDone?.(result);
      onClose();
    } catch (error) {
      setFailure(errorText(m, error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={request.title}
      description={request.description ?? m.db.confirm.description}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant={request.danger === true ? 'danger' : 'primary'} icon={<Play />} busy={busy}>
            {request.confirmLabel ?? m.db.confirm.run}
          </Button>
        </>
      }
    >
      <SqlEditor value={sql} onChange={setSql} dialect={dialect} label={request.title} minRows={4} maxRows={16} onRun={() => void submit()} />
      {failure !== null && (
        <div style={{ marginTop: 12 }}>
          <Callout tone="bad" title={m.db.confirm.failed}>
            <span className="mono-wrap">{failure}</span>
          </Callout>
        </div>
      )}
    </Dialog>
  );
}
