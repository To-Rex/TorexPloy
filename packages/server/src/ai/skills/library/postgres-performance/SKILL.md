---
name: postgres-performance
description: Make a PostgreSQL database faster - find the slow and frequent queries, missing and unused indexes, table bloat and vacuum problems, connection exhaustion and lock waits, and memory settings that do not fit the container - and fix them safely. Use when a Postgres database or a site that uses one is slow, uses too much CPU or memory, runs out of connections, or the person asks to optimise or tune PostgreSQL.
metadata:
  triggers: "postgres psql sql sorov sorovlar indeks baza query queries index vacuum bloat connections tune optimize постгрес запрос индекс база"
  title.uz: "PostgreSQL tezligi"
  title.ru: "Производительность PostgreSQL"
  title.en: "PostgreSQL performance"
  summary.uz: "Sekin va koʻp bajariladigan soʻrovlar, yetishmayotgan indekslar, vacuum, ulanishlar va xotira sozlamalarini tekshirib, PostgreSQL’ni xavfsiz tezlashtiradi."
  summary.ru: "Медленные и частые запросы, недостающие индексы, vacuum, соединения и настройки памяти: безопасно ускоряет PostgreSQL."
  summary.en: "Slow and frequent queries, missing indexes, vacuum, connections and memory settings: speeds PostgreSQL up safely."
  title.kaa: "PostgreSQL tezligi"
  summary.kaa: "Ásten hám jiyi orınlanatuǵın sorawlar, jetispeytuǵın indeksler, vacuum, jalǵanıwlar hám yad sazlawların tekserip, PostgreSQL jumısın qáwipsiz tezletedi."
  title.ky: "PostgreSQL ылдамдыгы"
  summary.ky: "Жай жана көп аткарылуучу суроолорду, жетишпеген индекстерди, vacuum, туташууларды жана эс тутум жөндөөлөрүн текшерип, PostgreSQL’ди коопсуз ылдамдатат."
  title.tg: "Суръати PostgreSQL"
  summary.tg: "Дархостҳои суст ва зуд-зуд иҷрошаванда, индексҳои норасо, vacuum, пайвастҳо ва танзимоти хотираро санҷида, PostgreSQL-ро бехатар тезтар мекунад."
  title.kk: "PostgreSQL жылдамдығы"
  summary.kk: "Баяу және жиі орындалатын сұраныстарды, жетіспейтін индекстерді, vacuum, қосылымдар мен жад баптауларын тексеріп, PostgreSQL жылдамдығын қауіпсіз арттырады."
  title.tk: "PostgreSQL tizligi"
  summary.tk: "Haýal we köp ýerine ýetirilýän soraglary, ýetmeýän indeksleri, vacuum işini, birikmeleri we ýat sazlamalaryny barlap, PostgreSQL bazasyny howpsuz çaltlandyrýar."
---

# PostgreSQL performance

Use the database console of the platform: `api_call POST /api/services/{id}/db/run` with `{ "session": "<your id>", "database": "<name>", "sql": "...", "readOnly": true }`. Every query in sections 1 to 5 only reads; send them with `readOnly: true`. Close the session with `/db/close` when done. `GET /api/services/{id}/db/overview` gives the version, size and databases first.

## 1. What hurts: the queries

Is `pg_stat_statements` there?

```sql
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_stat_statements';
```

If yes, the ten queries that take the most time in total, which is what matters (a 5 ms query run a million times beats a 2 s query run twice):

```sql
SELECT round(total_exec_time::numeric / 1000, 1) AS total_s, calls, round(mean_exec_time::numeric, 1) AS mean_ms, rows,
       round(100 * shared_blks_hit::numeric / nullif(shared_blks_hit + shared_blks_read, 0), 1) AS hit_pct, left(regexp_replace(query, '\s+', ' ', 'g'), 160) AS query
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;
```

(Before PostgreSQL 13 the columns are `total_time` and `mean_time`.)

If it is not installed, offer to enable it. It needs a restart of the service, so ask:

```sql
ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';
```

then `POST /api/services/{id}/restart`, then `CREATE EXTENSION pg_stat_statements;`, and come back after real traffic has run for a while. `ALTER SYSTEM` writes into the data directory, so it survives redeployments. Meanwhile, look at what runs now (section 4) and at the tables (section 2).

## 2. The tables: scans and indexes

```sql
SELECT relname, seq_scan, seq_tup_read, idx_scan, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) AS size
FROM pg_stat_user_tables ORDER BY seq_tup_read DESC LIMIT 15;
```

A large table (`n_live_tup` in the hundreds of thousands and up) with a high `seq_tup_read` and few `idx_scan` is read whole again and again: a missing index. Find which query does it (section 1), then look at its plan:

```sql
EXPLAIN (ANALYZE, BUFFERS) <the select>;
```

`EXPLAIN ANALYZE` runs the statement: use it only on `SELECT`, never on a write. Look for `Seq Scan` on the big table with a `Filter`, `Rows Removed by Filter` in the thousands, and the node with the largest actual time.

Unused indexes cost every write and disk space:

```sql
SELECT s.indexrelid::regclass AS index, s.relname AS table, s.idx_scan, pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT 10;
```

Counters reset with `pg_stat_reset()` and at a crash; check `SELECT stats_reset FROM pg_stat_database WHERE datname = current_database();` before calling an index unused.

## 3. Vacuum and bloat

```sql
SELECT relname, n_live_tup, n_dead_tup, round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) AS dead_pct, last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables WHERE n_dead_tup > 10000 ORDER BY n_dead_tup DESC LIMIT 10;
SELECT pid, now() - xact_start AS open_for, state, left(query, 80) FROM pg_stat_activity WHERE xact_start IS NOT NULL ORDER BY xact_start LIMIT 5;
```

Many dead rows and an old `last_autovacuum` on a busy table: autovacuum cannot keep up, or something blocks it. The usual blocker is a transaction left open for hours (`idle in transaction`), which the second query shows: it stops vacuum on the whole database. Fixing the application that leaves it open is the real fix; ending that session is the immediate one (ask).

## 4. Connections and locks

`GET /api/services/{id}/db/activity` lists sessions and running queries. Or:

```sql
SELECT state, count(*) FROM pg_stat_activity GROUP BY state;
SHOW max_connections;
SELECT pid, pg_blocking_pids(pid) AS blocked_by, now() - query_start AS waiting, left(query, 100) FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0;
```

- Near `max_connections` with most of them `idle`: the applications' pools are too large in sum (replicas × pool size). Lower the pool size per app, or add PgBouncer in front. Raising `max_connections` costs memory per connection and is the last resort.
- Lock waits: find the blocker's query. A migration running `ALTER TABLE` at peak time is the usual cause.

## 5. Settings for the memory it has

```sql
SELECT name, setting, unit FROM pg_settings WHERE name IN ('shared_buffers','effective_cache_size','work_mem','maintenance_work_mem','max_connections','random_page_cost','checkpoint_timeout','max_wal_size');
SELECT round(100.0 * sum(blks_hit) / nullif(sum(blks_hit) + sum(blks_read), 0), 2) AS cache_hit_pct FROM pg_stat_database;
```

Compare with the service's memory limit (`GET /api/services/{id}`, `memoryLimitMb`; no limit means the server's memory, shared with everything else). Rough targets:

- `shared_buffers`: 25 % of the memory the database may use. The image default (128 MB) is far too small for anything real.
- `effective_cache_size`: 50 to 75 % of it (a hint, allocates nothing).
- `work_mem`: 8 to 32 MB; it is per sort per connection, so it multiplies.
- `maintenance_work_mem`: 256 MB to 1 GB when memory allows.
- `random_page_cost = 1.1` on SSD disks.

A cache hit below 99 % on a busy database means the working set does not fit in memory.

## 6. Changes

Each is one approval, smallest first.

1. **A missing index**, built without locking the table for writes. Send it alone (not inside `BEGIN`): `CREATE INDEX CONCURRENTLY idx_<table>_<columns> ON <table> (<columns>);`. On a big table it takes a while; if it fails it leaves an `INVALID` index to drop and retry. Check the plan again afterwards.
2. **Settings**: `ALTER SYSTEM SET <name> = '<value>';` then `SELECT pg_reload_conf();`. `shared_buffers` and `max_connections` need a restart of the service: say so, and do it at a quiet time.
3. **A manual vacuum** of one bloated table: `VACUUM (ANALYZE, VERBOSE) <table>;`. `VACUUM FULL` locks the table completely and rewrites it: only with the person's explicit choice and a backup taken first.
4. **Dropping an unused index**: `DROP INDEX CONCURRENTLY <name>;` only after the counters have run long enough to be trusted.
5. **Memory for the service**: if the database needs more than its limit, raise `memoryLimitMb` (`PATCH /api/services/{id}`); check the server has it to give.

Take a backup before structural changes (`POST /api/services/{id}/backups`).

## Report

The three worst queries or tables with their numbers, what was changed, and the same numbers afterwards. What needs the application's developers (a query to rewrite, a pool size, a transaction left open), with the evidence.
