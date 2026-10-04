import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, openDatabase } from './database.ts';
import { LATEST_SCHEMA_VERSION } from './schema.ts';

function withTempDb<T>(fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'ploy-db-'));
  try {
    return fn(join(dir, 'ploy.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('openDatabase creates the file, applies every migration and reports the version', () => {
  withTempDb((path) => {
    const db = openDatabase(path);
    try {
      assert.equal(db.schemaVersion, LATEST_SCHEMA_VERSION);
      assert.equal(db.isCurrent, true);

      const tables = db
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .map((row) => row.name);

      for (const expected of [
        'applications',
        'api_tokens',
        'audit_log',
        'deployments',
        'domains',
        'env_vars',
        'jobs',
        'metrics_samples',
        'projects',
        'schema_migrations',
        'servers',
        'services',
        'sessions',
        'settings',
        'team_members',
        'teams',
        'users',
      ]) {
        assert.ok(tables.includes(expected), `expected table ${expected} to exist`);
      }
    } finally {
      db.close();
    }
  });
});

test('migrations are idempotent across restarts', () => {
  withTempDb((path) => {
    const first = openDatabase(path);
    const firstApplied = first.get<{ count: number }>('SELECT COUNT(*) AS count FROM schema_migrations');
    first.close();

    const second = openDatabase(path);
    try {
      const secondApplied = second.get<{ count: number }>('SELECT COUNT(*) AS count FROM schema_migrations');
      assert.equal(secondApplied?.count, firstApplied?.count);
      assert.equal(second.schemaVersion, LATEST_SCHEMA_VERSION);
    } finally {
      second.close();
    }
  });
});

test('WAL mode and foreign key enforcement are active', () => {
  withTempDb((path) => {
    const db = openDatabase(path);
    try {
      assert.equal(db.scalar<string>('PRAGMA journal_mode'), 'wal');
      assert.equal(Number(db.scalar('PRAGMA foreign_keys')), 1);
    } finally {
      db.close();
    }
  });
});

test('foreign keys are enforced, not just declared', () => {
  withTempDb((path) => {
    const db = openDatabase(path);
    try {
      assert.throws(
        () =>
          db.run(
            'INSERT INTO projects (id, team_id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?,?)',
            'prj_1',
            'team_missing',
            'Ghost',
            'ghost',
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
          ),
        /FOREIGN KEY/i,
      );
    } finally {
      db.close();
    }
  });
});

test('CHECK constraints reject invalid enum values', () => {
  withTempDb((path) => {
    const db = openDatabase(path);
    try {
      db.run(
        'INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)',
        'team_1',
        'Acme',
        'acme',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
      assert.throws(
        () =>
          db.run(
            'INSERT INTO team_members (id, team_id, user_id, role, created_at) VALUES (?,?,?,?,?)',
            'tm_1',
            'team_1',
            'usr_1',
            'superuser',
            '2026-01-01T00:00:00.000Z',
          ),
        /CHECK/i,
      );
    } finally {
      db.close();
    }
  });
});

test('env_vars is scoped to exactly one owner (XOR constraint)', () => {
  withTempDb((path) => {
    const db = openDatabase(path);
    try {
      const now = '2026-01-01T00:00:00.000Z';
      assert.throws(
        () =>
          db.run(
            'INSERT INTO env_vars (id, application_id, project_id, key, value, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
            'env_1',
            null,
            null,
            'DATABASE_URL',
            'x',
            now,
            now,
          ),
        /CHECK/i,
        'a variable with no owner must be rejected',
      );
      assert.throws(
        () =>
          db.run(
            'INSERT INTO env_vars (id, application_id, project_id, key, value, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
            'env_2',
            'app_1',
            'prj_1',
            'DATABASE_URL',
            'x',
            now,
            now,
          ),
        /CHECK/i,
        'a variable with two owners must be rejected',
      );
    } finally {
      db.close();
    }
  });
});

test('unique indexes prevent duplicate keys within a scope', () => {
  withTempDb((path) => {
    const db = openDatabase(path);
    try {
      const now = '2026-01-01T00:00:00.000Z';
      db.run('INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)', 'team_1', 'T', 't', now, now);
      db.run('INSERT INTO projects (id, team_id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?,?)', 'prj_1', 'team_1', 'P', 'p', now, now);
      db.run(
        'INSERT INTO env_vars (id, project_id, key, value, created_at, updated_at) VALUES (?,?,?,?,?,?)',
        'env_1',
        'prj_1',
        'KEY',
        'v1',
        now,
        now,
      );
      assert.throws(
        () =>
          db.run(
            'INSERT INTO env_vars (id, project_id, key, value, created_at, updated_at) VALUES (?,?,?,?,?,?)',
            'env_2',
            'prj_1',
            'KEY',
            'v2',
            now,
            now,
          ),
        /UNIQUE/i,
      );
    } finally {
      db.close();
    }
  });
});

test('email uniqueness is case-insensitive', () => {
  withTempDb((path) => {
    const db = openDatabase(path);
    try {
      const now = '2026-01-01T00:00:00.000Z';
      db.run(
        'INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?)',
        'usr_1',
        'Torex@Example.com',
        'Torex',
        'hash',
        now,
        now,
      );
      assert.throws(
        () =>
          db.run(
            'INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?)',
            'usr_2',
            'torex@example.COM',
            'Duplicate',
            'hash',
            now,
            now,
          ),
        /UNIQUE/i,
      );
    } finally {
      db.close();
    }
  });
});

test('transactions commit atomically and roll back completely on failure', () => {
  withTempDb((path) => {
    const db = openDatabase(path);
    try {
      const now = '2026-01-01T00:00:00.000Z';
      db.transaction(() => {
        db.run('INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)', 'team_1', 'A', 'a', now, now);
        db.run('INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)', 'team_2', 'B', 'b', now, now);
      });
      assert.equal(db.scalar<number>('SELECT COUNT(*) FROM teams'), 2);

      assert.throws(() => {
        db.transaction(() => {
          db.run('INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)', 'team_3', 'C', 'c', now, now);
          throw new Error('boom');
        });
      }, /boom/);

      assert.equal(db.scalar<number>('SELECT COUNT(*) FROM teams'), 2, 'the failed transaction must leave no rows');
    } finally {
      db.close();
    }
  });
});

test('nested transaction calls join the outer transaction', () => {
  withTempDb((path) => {
    const db = openDatabase(path);
    try {
      const now = '2026-01-01T00:00:00.000Z';
      db.transaction(() => {
        db.run('INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)', 'team_1', 'A', 'a', now, now);
        db.transaction(() => {
          db.run('INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)', 'team_2', 'B', 'b', now, now);
        });
      });
      assert.equal(db.scalar<number>('SELECT COUNT(*) FROM teams'), 2);
    } finally {
      db.close();
    }
  });
});

test('a rollback restores state changed by an inner failure', () => {
  withTempDb((path) => {
    const db = openDatabase(path);
    try {
      const now = '2026-01-01T00:00:00.000Z';
      assert.throws(() => {
        db.transaction(() => {
          db.run('INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)', 'team_1', 'A', 'a', now, now);
          db.transaction(() => {
            db.run('INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)', 'team_2', 'B', 'b', now, now);
            throw new Error('inner failure');
          });
        });
      }, /inner failure/);
      assert.equal(db.scalar<number>('SELECT COUNT(*) FROM teams'), 0);
    } finally {
      db.close();
    }
  });
});

test('reads and writes work after a rollback (connection is still usable)', () => {
  withTempDb((path) => {
    const db = openDatabase(path);
    try {
      const now = '2026-01-01T00:00:00.000Z';
      assert.throws(() => db.transaction(() => { throw new Error('x'); }));
      db.run('INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)', 'team_1', 'A', 'a', now, now);
      assert.equal(db.scalar<number>('SELECT COUNT(*) FROM teams'), 1);
    } finally {
      db.close();
    }
  });
});

test('parameters are always bound, so injection payloads are inert data', () => {
  withTempDb((path) => {
    const db = openDatabase(path);
    try {
      const now = '2026-01-01T00:00:00.000Z';
      const hostile = "'; DROP TABLE teams; --";
      db.run('INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)', 'team_1', hostile, 'x', now, now);

      assert.equal(db.scalar<string>('SELECT name FROM teams WHERE id = ?', 'team_1'), hostile);
      assert.doesNotThrow(() => db.scalar<number>('SELECT COUNT(*) FROM teams'));
    } finally {
      db.close();
    }
  });
});

test('data survives close and reopen (durability)', () => {
  withTempDb((path) => {
    const first = openDatabase(path);
    const now = '2026-01-01T00:00:00.000Z';
    first.run('INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)', 'team_1', 'Persisted', 'persisted', now, now);
    first.close();

    const second = openDatabase(path);
    try {
      assert.equal(second.scalar<string>('SELECT name FROM teams WHERE id = ?', 'team_1'), 'Persisted');
    } finally {
      second.close();
    }
  });
});

test('checkpoint truncates the WAL without losing data', () => {
  withTempDb((path) => {
    const db = openDatabase(path);
    try {
      const now = '2026-01-01T00:00:00.000Z';
      db.run('INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)', 'team_1', 'A', 'a', now, now);
      db.checkpoint();
      assert.equal(db.scalar<number>('SELECT COUNT(*) FROM teams'), 1);
    } finally {
      db.close();
    }
  });
});

test('read-only connections refuse writes', () => {
  withTempDb((path) => {
    const writable = openDatabase(path);
    writable.close();

    const readOnly = new Database(path, { readOnly: true });
    try {
      assert.throws(() => readOnly.run('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)', 'k', 'v', 'now'));
    } finally {
      readOnly.close();
    }
  });
});

test('the database file is created with restrictive permissions', () => {
  if (process.platform === 'win32') return;
  withTempDb((path) => {
    const db = openDatabase(path);
    try {
      const mode = statSync(path).mode & 0o777;
      assert.ok((mode & 0o077) === 0, `database should not be group/world readable, got ${mode.toString(8)}`);
    } finally {
      db.close();
    }
  });
});