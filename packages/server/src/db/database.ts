/**
 * SQLite database wrapper.
 *
 * Uses `node:sqlite` (built into Node 22+), so the platform has no native
 * dependency to compile and no separate database server to operate. WAL mode
 * gives concurrent readers alongside a single writer, which matches the
 * control-plane workload: many dashboard reads, serialized writes.
 *
 * All writes go through prepared statements with bound parameters — there is no
 * string interpolation of user input anywhere in the platform.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema.ts';

export type Row = Record<string, unknown>;
export type SqlValue = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface DatabaseOptions {
  /** Open the database read-only (used by the CLI for inspection). */
  readOnly?: boolean;
}

/**
 * Thin, explicit wrapper over `node:sqlite`.
 *
 * Deliberately small: it adds migrations, transactions and prepared-statement
 * caching, and otherwise stays out of the way.
 */
export class Database {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  constructor(path: string, options: DatabaseOptions = {}) {
    const readOnly = options.readOnly ?? false;

    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (!readOnly) {
        // Create the file ourselves so it never inherits a permissive umask.
        // The database holds encrypted secrets; it must not be world readable.
        if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
        try {
          chmodSync(path, 0o600);
        } catch {
          // Best effort: some filesystems (e.g. mounted volumes) ignore chmod.
        }
      }
    }

    this.path = path;
    this.db = new DatabaseSync(path, { readOnly });

    if (!readOnly) {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.db.exec('PRAGMA temp_store = MEMORY');
    }
  }

  /** Apply pending migrations. Safe to call on every boot. */
  migrate(): { applied: number; version: number } {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    const row = this.get<{ version: number | null }>('SELECT MAX(version) AS version FROM schema_migrations');
    let current = row?.version ?? 0;
    let applied = 0;

    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      // PRAGMA foreign_keys is a no-op inside a transaction, so it is switched around it.
      if (migration.rebuildsTables === true) this.db.exec('PRAGMA foreign_keys = OFF');
      try {
        this.transaction(() => {
          this.db.exec(migration.sql);
          if (migration.rebuildsTables === true) {
            const broken = this.all('PRAGMA foreign_key_check');
            if (broken.length > 0) throw new Error(`Migration ${migration.version} would break ${broken.length} foreign key(s)`);
          }
          this.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
            migration.version,
            migration.name,
            new Date().toISOString(),
          );
        });
      } finally {
        if (migration.rebuildsTables === true) this.db.exec('PRAGMA foreign_keys = ON');
      }
      current = migration.version;
      applied += 1;
    }

    return { applied, version: current };
  }

  get schemaVersion(): number {
    const row = this.get<{ version: number | null }>('SELECT MAX(version) AS version FROM schema_migrations');
    return row?.version ?? 0;
  }

  get isCurrent(): boolean {
    return this.schemaVersion >= LATEST_SCHEMA_VERSION;
  }

  private cached(sql: string): StatementSync {
    const existing = this.statements.get(sql);
    if (existing !== undefined) return existing;
    const statement = this.db.prepare(sql);
    this.statements.set(sql, statement);
    return statement;
  }

  /** Execute one or more statements with no results (DDL, pragmas). */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** Prepare a statement, bypassing the cache (for statements built dynamically). */
  prepare(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  /** Run a write statement. Returns affected rows and the last insert rowid. */
  run(sql: string, ...params: SqlValue[]): RunResult {
    const result = this.cached(sql).run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  /** Fetch the first matching row, or undefined. */
  get<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    const row = this.cached(sql).get(...params) as T | undefined;
    return row;
  }

  /** Fetch all matching rows. */
  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.cached(sql).all(...params) as T[];
  }

  /** Fetch a single scalar value from the first row of the first column. */
  scalar<T extends SqlValue = SqlValue>(sql: string, ...params: SqlValue[]): T | undefined {
    const row = this.get<Row>(sql, ...params);
    if (row === undefined) return undefined;
    const values = Object.values(row);
    return values[0] as T | undefined;
  }

  /**
   * Run `fn` inside a transaction. Nested calls join the outer transaction
   * (SQLite has no true nested transactions, so savepoints would be needed for
   * independent rollback; joining is the correct behaviour for this codebase).
   */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return fn();
      } finally {
        this.depth -= 1;
      }
    }

    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // A failed rollback means the transaction was already aborted.
      }
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  /** Compact the database file and truncate the WAL. Used by scheduled maintenance. */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }
}

/** Open a database and bring it up to the latest schema version. */
export function openDatabase(path: string, options: DatabaseOptions = {}): Database {
  const db = new Database(path, options);
  db.migrate();
  return db;
}

/**
 * Convert a SQLite row into a plain object with `null` preserved.
 * `node:sqlite` returns null-prototype objects, which break `Object.hasOwn` and
 * JSON round-tripping in some call sites, so rows are normalized on read.
 */
export function plainRow<T extends Row>(row: T): T {
  return { ...row } as T;
}

export function plainRows<T extends Row>(rows: T[]): T[] {
  return rows.map((row) => ({ ...row }) as T);
}