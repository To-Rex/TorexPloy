/**
 * The database console's connections.
 *
 * Each person gets one catalog connection per service (per database on
 * PostgreSQL) for browsing, editing rows and monitoring, and one connection
 * per query tab, so a transaction begun in a tab is still open on the next
 * run. Connections idle for a while are closed (a query tab's after twenty
 * minutes, rolling back whatever it left open), the number per service is
 * capped, and a run that outlives its time limit is cancelled on the server.
 */
import type { Duplex } from 'node:stream';
import {
  codePointOffset,
  dialectOf,
  hasDbConsole,
  splitSql,
  type DbActivityDto,
  type DbChangesInput,
  type DbChangesResultDto,
  type DbConsoleType,
  type DbErrorDto,
  type DbFilter,
  type DbObjectKind,
  type DbObjectSourceDto,
  type DbOverviewDto,
  type DbRoleDto,
  type DbRowsDto,
  type DbRowsInput,
  type DbRunInput,
  type DbRunResultDto,
  type DbSort,
  type DbStatementResultDto,
  type DbTableDto,
  type DbTreeDto,
  type DbValueKind,
} from '@ploy/shared';
import type { Context } from '../context.ts';
import { projectNetwork } from '../docker/naming.ts';
import { AppError, errorMessage } from '../lib/errors.ts';
import type { ServiceRecord } from '../store/index.ts';
import { StatementError, type Credentials, type Engine, type EngineConnection } from './engine.ts';
import { mysqlEngine } from './my-engine.ts';
import { postgresEngine } from './pg-engine.ts';
import { dockerConnector, type DbConnector, type DbTarget } from './tunnel.ts';
import { ConnectionClosedError, Mutex } from './wire.ts';

const CATALOG_IDLE_MS = 3 * 60_000;
const EDITOR_IDLE_MS = 20 * 60_000;
const MAX_PER_SERVICE = 24;
const MAX_TABS_PER_PERSON = 8;
const TABLE_CACHE_MS = 30_000;
const RUN_BUDGET_BYTES = 24 * 1024 * 1024;
const CELL_BYTES = 256 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;

/** Commands that only read: runs made of these alone are not written to the audit log. */
const READ_COMMANDS = new Set(['SELECT', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC', 'WITH', 'VALUES', 'TABLE', 'FETCH', 'USE', 'SET', 'RESET', 'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'END', 'SAVEPOINT', 'RELEASE', 'DO', 'HELP', 'CALL']);
const WRITE_CALLS = new Set(['CALL', 'DO']);

interface Session {
  key: string;
  serviceId: string;
  userId: string;
  kind: 'catalog' | 'editor';
  conn: EngineConnection;
  lock: Mutex;
  lastUsed: number;
  readOnly: boolean;
  busy: boolean;
  cancelled: boolean;
}

export interface RunOutcome {
  result: DbRunResultDto;
  /** Commands that changed something, for the audit log. */
  writes: string[];
}

const ENGINES: Record<DbConsoleType, Engine> = {
  postgres: postgresEngine,
  mysql: mysqlEngine('mysql'),
  mariadb: mysqlEngine('mariadb'),
};

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

export class DbConsole {
  private readonly ctx: Context;
  private connector: DbConnector;
  private readonly sessions = new Map<string, Session>();
  private readonly opening = new Map<string, Promise<{ session: Session; fresh: boolean }>>();
  private readonly tables = new Map<string, { at: number; table: Promise<DbTableDto> }>();
  private readonly types = new Map<string, Map<number, { type: string; kind: DbValueKind }>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(ctx: Context, connector?: DbConnector) {
    this.ctx = ctx;
    this.connector = connector ?? dockerConnector(ctx);
  }

  /** Replace how connections are opened (tests dial a local database). */
  useConnector(connector: DbConnector): void {
    this.connector = connector;
  }

  start(): void {
    this.timer ??= setInterval(() => this.sweep(), 30_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.sessions.values()].map((session) => this.drop(session)));
  }

  engine(service: ServiceRecord): Engine {
    if (!hasDbConsole(service.type)) throw new AppError('bad_request', 'This service has no database console', { params: { reason: 'unsupported' } });
    return ENGINES[service.type];
  }

  primaryDatabase(service: ServiceRecord): string {
    return service.credentials.database ?? (service.type === 'postgres' ? 'postgres' : '');
  }

  private credentials(service: ServiceRecord): Credentials {
    if (service.type !== 'postgres' && service.credentials.rootPassword !== undefined) return { user: 'root', password: service.credentials.rootPassword };
    return { user: service.credentials.username ?? '', password: service.credentials.password };
  }

  private target(service: ServiceRecord): DbTarget {
    return { serviceId: service.id, serverId: service.serverId, network: projectNetwork(service.projectId), host: service.containerName, port: service.internalPort };
  }

  private async openStream(service: ServiceRecord): Promise<Duplex> {
    try {
      return await timeout(this.connector(this.target(service)), CONNECT_TIMEOUT_MS, 'Timed out opening a connection to the database');
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('database_unreachable', errorMessage(error), { params: { reason: 'tunnel' } });
    }
  }

  private async connect(service: ServiceRecord, database: string): Promise<EngineConnection> {
    if (service.status === 'stopped' || service.status === 'provisioning') {
      throw new AppError('database_unreachable', 'The database is not running', { params: { reason: service.status } });
    }
    const engine = this.engine(service);
    const stream = await this.openStream(service);
    try {
      return await timeout(engine.connect(stream, this.credentials(service), database), CONNECT_TIMEOUT_MS, 'Timed out logging in to the database');
    } catch (error) {
      stream.destroy();
      if (error instanceof StatementError) throw new AppError('database_error', error.message, { params: { code: error.code ?? '', reason: 'login' } });
      throw new AppError('database_unreachable', errorMessage(error), { params: { reason: 'login' } });
    }
  }

  private async session(service: ServiceRecord, userId: string, kind: Session['kind'], id: string, database: string): Promise<{ session: Session; fresh: boolean }> {
    const engine = this.engine(service);
    const key = `${service.id}|${userId}|${kind}|${id}`;
    const existing = this.sessions.get(key);
    if (existing !== undefined) {
      if (existing.conn.alive && (!engine.connectionPerDatabase || existing.conn.database === database)) {
        existing.lastUsed = Date.now();
        return { session: existing, fresh: false };
      }
      if (existing.busy) throw new AppError('conflict', 'A query is still running in this tab', { params: { reason: 'busy' } });
      await this.drop(existing);
    }
    const pending = this.opening.get(key);
    if (pending !== undefined) return pending;
    const opening = (async () => {
      await this.makeRoom(service.id, userId, kind);
      const conn = await this.connect(service, database);
      const session: Session = { key, serviceId: service.id, userId, kind, conn, lock: new Mutex(), lastUsed: Date.now(), readOnly: false, busy: false, cancelled: false };
      this.sessions.set(key, session);
      return { session, fresh: true };
    })();
    this.opening.set(key, opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(key);
    }
  }

  /** Keep within the caps by closing the longest-idle connections; refuse when everything is busy. */
  private async makeRoom(serviceId: string, userId: string, kind: Session['kind']): Promise<void> {
    const ofService = [...this.sessions.values()].filter((session) => session.serviceId === serviceId);
    const tabs = ofService.filter((session) => session.userId === userId && session.kind === 'editor');
    const evict = async (candidates: Session[]): Promise<void> => {
      const idle = candidates.filter((session) => !session.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (idle === undefined) throw new AppError('conflict', 'Too many console connections are open to this database', { params: { reason: 'too_many_sessions' } });
      await this.drop(idle);
    };
    if (kind === 'editor' && tabs.length >= MAX_TABS_PER_PERSON) await evict(tabs);
    if (ofService.length >= MAX_PER_SERVICE) await evict(ofService);
  }

  private async drop(session: Session): Promise<void> {
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    await session.conn.close().catch(() => session.conn.destroy());
  }

  private sweep(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.busy) continue;
      const limit = session.kind === 'editor' ? EDITOR_IDLE_MS : CATALOG_IDLE_MS;
      if (!session.conn.alive || now - session.lastUsed > limit) void this.drop(session);
    }
    for (const [key, entry] of this.tables) if (now - entry.at > TABLE_CACHE_MS) this.tables.delete(key);
  }

  /** Run `work` on the session alone; database errors become API errors. */
  private use<T>(session: Session, work: () => Promise<T>): Promise<T> {
    return session.lock.run(async () => {
      session.busy = true;
      session.lastUsed = Date.now();
      try {
        return await work();
      } catch (error) {
        throw translate(error);
      } finally {
        session.busy = false;
        session.lastUsed = Date.now();
        if (!session.conn.alive) void this.drop(session);
      }
    });
  }

  private async catalog<T>(service: ServiceRecord, userId: string, database: string, work: (conn: EngineConnection, engine: Engine) => Promise<T>): Promise<T> {
    const engine = this.engine(service);
    const target = engine.connectionPerDatabase ? database : '';
    const { session } = await this.session(service, userId, 'catalog', target, target);
    return this.use(session, () => work(session.conn, engine));
  }

  /** Close everything open to a service (it was stopped, recreated or deleted). */
  async closeService(serviceId: string): Promise<void> {
    for (const [key] of this.tables) if (key.startsWith(`${serviceId}|`)) this.tables.delete(key);
    await Promise.all([...this.sessions.values()].filter((session) => session.serviceId === serviceId).map((session) => this.drop(session)));
  }

  // ------------------------------------------------------------------ browse

  overview(service: ServiceRecord, userId: string): Promise<DbOverviewDto> {
    const primary = this.primaryDatabase(service);
    return this.catalog(service, userId, primary, (conn, engine) => engine.overview(conn, primary, service.credentials.username ?? ''));
  }

  tree(service: ServiceRecord, userId: string, database: string): Promise<DbTreeDto> {
    return this.catalog(service, userId, database, (conn, engine) => engine.tree(conn, database));
  }

  table(service: ServiceRecord, userId: string, database: string, schema: string | null, name: string, fresh = false): Promise<DbTableDto> {
    const key = `${service.id}|${database}|${schema ?? ''}|${name}`;
    const cached = this.tables.get(key);
    if (!fresh && cached !== undefined && Date.now() - cached.at < TABLE_CACHE_MS) return cached.table;
    const table = this.catalog(service, userId, database, (conn, engine) => engine.table(conn, database, engine.dialect === 'postgres' ? (schema ?? 'public') : null, name));
    this.tables.set(key, { at: Date.now(), table });
    table.catch(() => this.tables.delete(key));
    return table;
  }

  source(service: ServiceRecord, userId: string, database: string, schema: string | null, name: string, kind: DbObjectKind, detail: string | undefined): Promise<DbObjectSourceDto> {
    return this.catalog(service, userId, database, (conn, engine) => engine.source(conn, database, engine.dialect === 'postgres' ? (schema ?? 'public') : null, name, kind, detail));
  }

  async rows(service: ServiceRecord, userId: string, input: DbRowsInput): Promise<DbRowsDto> {
    const table = await this.table(service, userId, input.database, input.schema, input.table);
    return this.catalog(service, userId, input.database, (conn, engine) => engine.rows(conn, input, table));
  }

  async changes(service: ServiceRecord, userId: string, input: DbChangesInput): Promise<DbChangesResultDto> {
    const table = await this.table(service, userId, input.database, input.schema, input.table, true);
    return this.catalog(service, userId, input.database, (conn, engine) => engine.changes(conn, input, table));
  }

  activity(service: ServiceRecord, userId: string): Promise<DbActivityDto> {
    const primary = this.primaryDatabase(service);
    const own = new Set([...this.sessions.values()].filter((session) => session.serviceId === service.id).map((session) => session.conn.backendId));
    return this.catalog(service, userId, primary, async (conn, engine) => {
      const activity = await engine.activity(conn);
      for (const entry of activity.sessions) if (own.has(entry.pid)) entry.own = true;
      return activity;
    });
  }

  signal(service: ServiceRecord, userId: string, pid: string, action: 'cancel' | 'terminate'): Promise<boolean> {
    const primary = this.primaryDatabase(service);
    return this.catalog(service, userId, primary, (conn, engine) => engine.signal(conn, pid, action));
  }

  roles(service: ServiceRecord, userId: string): Promise<DbRoleDto[]> {
    const primary = this.primaryDatabase(service);
    return this.catalog(service, userId, primary, (conn, engine) => engine.roles(conn, service.credentials.username ?? ''));
  }

  /**
   * Stream a table out on a connection of its own (an export can take minutes
   * and must not hold up browsing). `write` resolves when the bytes may go on.
   */
  async export(
    service: ServiceRecord,
    input: { database: string; schema: string | null; table: string; view: { filters: DbFilter[]; sort: DbSort[]; where: string } },
    userId: string,
    onStart: (table: DbTableDto) => Promise<void>,
    onBatch: (columns: string[], rows: (string | null)[][], table: DbTableDto) => Promise<void>,
  ): Promise<number> {
    const engine = this.engine(service);
    const table = await this.table(service, userId, input.database, input.schema, input.table);
    const conn = await this.connect(service, engine.connectionPerDatabase ? input.database : this.primaryDatabase(service));
    try {
      await onStart(table);
      const { sql, params } = engine.exportQuery(conn, input.view, table);
      return await conn.each(sql, params, 2_000, (columns, rows) => onBatch(columns, rows, table));
    } catch (error) {
      throw translate(error);
    } finally {
      await conn.close().catch(() => conn.destroy());
    }
  }

  // ------------------------------------------------------------------- query

  async run(service: ServiceRecord, userId: string, input: DbRunInput): Promise<RunOutcome> {
    const engine = this.engine(service);
    const dialect = dialectOf(engine.type);
    const statements = splitSql(input.sql, dialect);
    const { session, fresh } = await this.session(service, userId, 'editor', input.session, input.database);
    if (session.busy) throw new AppError('conflict', 'A query is still running in this tab', { params: { reason: 'busy' } });
    return this.use(session, async () => {
      const conn = session.conn;
      if (!engine.connectionPerDatabase && conn.database !== input.database) await conn.useDatabase(input.database);
      if (session.readOnly !== input.readOnly) {
        await conn.setReadOnly(input.readOnly);
        session.readOnly = input.readOnly;
      }
      session.cancelled = false;
      const timer = setTimeout(() => void this.interrupt(service, session, true), input.timeoutSec * 1000);
      const started = performance.now();
      const results: (DbStatementResultDto & { oids?: (number | undefined)[] })[] = [];
      const writes: string[] = [];
      let error: DbErrorDto | null = null;
      let budget = RUN_BUDGET_BYTES;
      try {
        for (const [index, statement] of statements.entries()) {
          const begun = performance.now();
          try {
            const outcomes = await conn.execute(statement.text, { maxRows: input.limit, maxCellBytes: CELL_BYTES, maxBytes: Math.max(1024 * 1024, budget) }, () => void this.interrupt(service, session, false));
            const durationMs = Math.round(performance.now() - begun);
            for (const outcome of outcomes) {
              for (const row of outcome.rows) for (const cell of row) budget -= cell?.length ?? 0;
              const command = outcome.command.toUpperCase();
              if (!READ_COMMANDS.has(command.split(' ')[0] ?? '') || WRITE_CALLS.has(command)) writes.push(command);
              results.push({
                index,
                start: statement.start,
                end: statement.end,
                command: outcome.command,
                columns: outcome.columns?.map(({ name, type, kind }) => ({ name, type, kind })) ?? null,
                oids: outcome.columns?.map((column) => column.oid),
                rows: outcome.rows,
                rowCount: outcome.rowCount,
                truncated: outcome.truncated,
                clipped: outcome.clipped,
                durationMs,
                notices: outcome.notices,
                insertId: outcome.insertId,
              });
            }
          } catch (failure) {
            if (!(failure instanceof StatementError)) throw failure;
            const position = failure.offset === null ? null : statement.start + (dialect === 'postgres' ? codePointOffset(statement.text, failure.offset) : failure.offset);
            error = { message: failure.message, code: failure.code, detail: failure.detail, hint: failure.hint, position, statement: index, notices: failure.notices };
            break;
          }
          if (session.cancelled) break;
        }
      } finally {
        clearTimeout(timer);
      }
      if (writes.some((command) => /^(CREATE|ALTER|DROP|TRUNCATE|RENAME|COMMENT|GRANT|REVOKE)/.test(command))) {
        for (const key of this.tables.keys()) if (key.startsWith(`${service.id}|`)) this.tables.delete(key);
      }
      await this.nameTypes(service, userId, conn.database, results);
      return {
        result: {
          results: results.map(({ oids: _oids, ...result }) => result),
          error,
          transaction: conn.transaction,
          durationMs: Math.round(performance.now() - started),
          newSession: fresh,
          cancelled: session.cancelled,
          database: conn.database,
        },
        writes,
      };
    });
  }

  /** Give result columns PostgreSQL only numbered (enums, domains, extension types) their names. */
  private async nameTypes(service: ServiceRecord, userId: string, database: string, results: (DbStatementResultDto & { oids?: (number | undefined)[] })[]): Promise<void> {
    const engine = this.engine(service);
    if (engine.describeTypes === undefined) return;
    const cacheKey = `${service.id}|${database}`;
    const known = this.types.get(cacheKey) ?? new Map<number, { type: string; kind: DbValueKind }>();
    this.types.set(cacheKey, known);
    const missing = new Set<number>();
    for (const result of results) for (const oid of result.oids ?? []) if (oid !== undefined && !known.has(oid)) missing.add(oid);
    if (missing.size > 0) {
      try {
        const found = await this.catalog(service, userId, database, (conn) => engine.describeTypes!(conn, [...missing]));
        for (const [oid, value] of found) known.set(oid, value);
      } catch {
        // Leave the numbers: naming types is a nicety.
      }
    }
    for (const result of results) {
      result.oids?.forEach((oid, index) => {
        const name = oid === undefined ? undefined : known.get(oid);
        if (name !== undefined && result.columns?.[index] !== undefined) result.columns[index] = { ...result.columns[index]!, type: name.type, kind: name.kind };
      });
    }
  }

  /** Stop the tab's running query. False when nothing was running. */
  async cancel(service: ServiceRecord, userId: string, sessionId: string): Promise<boolean> {
    const session = this.sessions.get(`${service.id}|${userId}|editor|${sessionId}`);
    if (session === undefined || !session.busy) return false;
    await this.interrupt(service, session, true);
    return true;
  }

  private async interrupt(service: ServiceRecord, session: Session, byPerson: boolean): Promise<void> {
    if (byPerson) session.cancelled = true;
    const engine = this.engine(service);
    try {
      await engine.cancel(session.conn, () => this.openStream(service), this.credentials(service));
    } catch (error) {
      this.ctx.logger.warn('Could not cancel a console query', { service: service.id, error: errorMessage(error) });
    }
  }

  /** Close a query tab's connection (the tab was closed). */
  async close(service: ServiceRecord, userId: string, sessionId: string): Promise<void> {
    const session = this.sessions.get(`${service.id}|${userId}|editor|${sessionId}`);
    if (session === undefined) return;
    if (session.busy) await this.interrupt(service, session, true);
    await this.drop(session);
  }
}

function translate(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (error instanceof StatementError) {
    return new AppError('database_error', error.message, { params: { code: error.code ?? '', ...(error.detail === null ? {} : { detail: error.detail }), ...(error.hint === null ? {} : { hint: error.hint }) } });
  }
  if (error instanceof ConnectionClosedError) return new AppError('database_unreachable', 'The connection to the database closed', { params: { reason: 'closed' } });
  if (error instanceof Error && /ECONNRESET|EPIPE|socket hang up/.test(error.message)) return new AppError('database_unreachable', error.message, { params: { reason: 'closed' } });
  return error;
}
