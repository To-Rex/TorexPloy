---
name: mysql-performance
description: Make a MySQL or MariaDB database faster - find the slow and frequent queries, full table scans, missing and redundant indexes, buffer pool and connection problems, lock waits - and fix them safely. Use when a MySQL or MariaDB database or a site that uses one is slow, uses too much CPU or memory, hits "too many connections", or the person asks to optimise or tune MySQL or MariaDB.
metadata:
  triggers: "mysql mariadb sql sorov sorovlar indeks baza query queries index innodb buffer connections tune optimize мускул мариа запрос индекс база"
  title.uz: "MySQL va MariaDB tezligi"
  title.ru: "Производительность MySQL и MariaDB"
  title.en: "MySQL and MariaDB performance"
  summary.uz: "Sekin soʻrovlar, toʻliq jadval skanlari, indekslar, InnoDB buffer pool va ulanishlarni tekshirib, MySQL/MariaDB’ni xavfsiz tezlashtiradi."
  summary.ru: "Медленные запросы, полные сканы, индексы, InnoDB buffer pool и соединения: безопасно ускоряет MySQL и MariaDB."
  summary.en: "Slow queries, full table scans, indexes, the InnoDB buffer pool and connections: speeds MySQL and MariaDB up safely."
  title.kaa: "MySQL hám MariaDB tezligi"
  summary.kaa: "Ásten isleytuǵın sorawlar, tolıq keste skanları, indeksler, InnoDB buffer pool hám jalǵanıwlardı tekserip, MySQL hám MariaDB jumısın qáwipsiz tezletedi."
  title.ky: "MySQL жана MariaDB ылдамдыгы"
  summary.ky: "Жай суроолорду, таблицаларды толук скандоону, индекстерди, InnoDB buffer pool жана туташууларды текшерип, MySQL/MariaDB’ни коопсуз ылдамдатат."
  title.tg: "Суръати MySQL ва MariaDB"
  summary.tg: "Дархостҳои суст, скани пурраи ҷадвалҳо, индексҳо, InnoDB buffer pool ва пайвастҳоро санҷида, MySQL/MariaDB-ро бехатар тезтар мекунад."
  title.kk: "MySQL және MariaDB жылдамдығы"
  summary.kk: "Баяу сұраныстарды, кестені толық сканерлеуді, индекстерді, InnoDB buffer pool және қосылымдарды тексеріп, MySQL/MariaDB жылдамдығын қауіпсіз арттырады."
  title.tk: "MySQL we MariaDB tizligi"
  summary.tk: "Haýal soraglary, doly tablisa skanirlemelerini, indeksleri, InnoDB buffer pool sazlamasyny we birikmeleri barlap, MySQL/MariaDB bazalaryny howpsuz çaltlandyrýar."
---

# MySQL and MariaDB performance

Use the platform's database console: `api_call POST /api/services/{id}/db/run` with `{ "session": "<your id>", "database": "<name>", "sql": "...", "readOnly": true }`. Everything in sections 1 to 4 only reads. `GET /api/services/{id}/db/overview` gives the version first: MySQL 8 and MariaDB differ in a few places noted below.

## 1. What hurts: the queries

`performance_schema` keeps a summary of every statement shape (on by default in MySQL 8; in MariaDB check `SHOW VARIABLES LIKE 'performance_schema'`, it is often off and needs a restart to enable):

```sql
SELECT LEFT(DIGEST_TEXT, 160) AS query, COUNT_STAR AS calls, ROUND(SUM_TIMER_WAIT / 1e12, 1) AS total_s, ROUND(AVG_TIMER_WAIT / 1e9, 1) AS avg_ms,
       SUM_ROWS_EXAMINED AS examined, SUM_ROWS_SENT AS sent, SUM_NO_INDEX_USED AS no_index
FROM performance_schema.events_statements_summary_by_digest ORDER BY SUM_TIMER_WAIT DESC LIMIT 10;
```

`examined` far above `sent`, or `no_index` above zero, is a query reading rows it throws away: an index is missing.

Without `performance_schema`, turn on the slow log for a while (ask; it is a runtime change and ends at the next restart):

```sql
SET GLOBAL slow_query_log = 'ON'; SET GLOBAL long_query_time = 0.5; SET GLOBAL log_queries_not_using_indexes = 'ON';
```

and read it after traffic has run: `SHOW VARIABLES LIKE 'slow_query_log_file';` then `exec` in the service's container to `tail -100` that file.

## 2. The plan of a bad query

```sql
EXPLAIN <the select>;
```

MySQL 8.0.18+ and MariaDB 10.1+ can measure it (`EXPLAIN ANALYZE` / `ANALYZE <select>`), which runs the statement: only on `SELECT`. Look for `type: ALL` (a full scan) on a large table, `rows` in the hundreds of thousands, `Using filesort` and `Using temporary` on big results.

Tables that are scanned whole and indexes that do nothing (the `sys` schema: MySQL 5.7+, MariaDB 10.6+):

```sql
SELECT * FROM sys.statements_with_full_table_scans ORDER BY total_latency DESC LIMIT 10;
SELECT * FROM sys.schema_unused_indexes LIMIT 20;
SELECT table_name, redundant_index_name, dominant_index_name FROM sys.schema_redundant_indexes LIMIT 20;
```

Tables without a primary key (InnoDB then makes a hidden one; replication and some tools suffer) and leftovers on MyISAM:

```sql
SELECT t.TABLE_NAME, t.ENGINE, t.TABLE_ROWS, ROUND((t.DATA_LENGTH + t.INDEX_LENGTH) / 1048576) AS mb
FROM information_schema.TABLES t LEFT JOIN information_schema.TABLE_CONSTRAINTS c ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME AND c.CONSTRAINT_TYPE = 'PRIMARY KEY'
WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE' AND (c.CONSTRAINT_NAME IS NULL OR t.ENGINE <> 'InnoDB') ORDER BY mb DESC LIMIT 20;
```

## 3. Memory and the buffer pool

```sql
SELECT @@innodb_buffer_pool_size / 1048576 AS buffer_pool_mb, @@max_connections, @@tmp_table_size / 1048576 AS tmp_mb, @@innodb_log_file_size / 1048576 AS log_mb;
SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_buffer_pool_reads','Innodb_buffer_pool_read_requests','Threads_connected','Max_used_connections','Created_tmp_disk_tables','Created_tmp_tables','Aborted_connects');
```

- Buffer pool misses: `Innodb_buffer_pool_reads / Innodb_buffer_pool_read_requests` above 1 % means the working set does not fit. Size `innodb_buffer_pool_size` to 50 to 70 % of the memory the service may use (its `memoryLimitMb`, or the server's memory if it has none, minus what else runs there).
- `Created_tmp_disk_tables` high against `Created_tmp_tables`: sorts and groupings spill to disk; usually a missing index, sometimes a small `tmp_table_size`.
- `Max_used_connections` near `max_connections`: see section 4.

## 4. Connections and locks

`GET /api/services/{id}/db/activity` lists sessions and their queries. Lock waits:

```sql
SELECT * FROM sys.innodb_lock_waits\G
```

(or, without `sys`, `SHOW ENGINE INNODB STATUS` and its `TRANSACTIONS` part). Many sleeping connections: the applications' pools in sum (replicas × pool size) are too large; lower them before raising `max_connections`.

## 5. Changes

One approval each, smallest first. Take a backup before structural changes (`POST /api/services/{id}/backups`).

1. **A missing index**, online: `ALTER TABLE <t> ADD INDEX idx_<cols> (<cols>), ALGORITHM=INPLACE, LOCK=NONE;`. If the server refuses `LOCK=NONE` for that change, it would block writes: say so and pick a quiet time. Check the plan afterwards.
2. **Settings**: `SET GLOBAL innodb_buffer_pool_size = <bytes>;` resizes online in MySQL 5.7+ and MariaDB 10.2+. To keep a setting across restarts: in MySQL 8 use `SET PERSIST` instead of `SET GLOBAL`; MariaDB has no `SET PERSIST`, so a lasting change belongs in the service's configuration file, written with the file tools inside the container only if it sits on a volume (check with `docker inspect`), otherwise tell the person it lasts until the next restart.
3. **A table moved to InnoDB**: `ALTER TABLE <t> ENGINE=InnoDB;` rewrites and locks the table: only by explicit choice, at a quiet time, after a backup.
4. **Dropping a redundant or unused index**: only after the counters have covered a full business cycle (a week), since `sys.schema_unused_indexes` forgets at each restart.
5. **More memory for the service** (`PATCH /api/services/{id}`, `memoryLimitMb`), when the buffer pool needs it and the server has it.

## Report

The worst queries and tables with their numbers, what was changed, the same numbers afterwards, and what the application's developers need to change (with the query and its plan as evidence).
