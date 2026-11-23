---
name: backup-and-restore-drill
description: Check that everything worth keeping is backed up off the server and can actually be restored - databases, application volumes, file storage - set up what is missing (schedules, retention, S3), and prove a backup restores with a drill that does not touch production. Use when asked whether backups exist or work, to set up or test backups, to prepare for disaster recovery, or before a risky change.
metadata:
  triggers: "backup backups zaxira nusxa tikla restore disaster recovery snapshot drill бэкап бекап резерв копи восстанов"
  title.uz: "Backup va tiklashni sinash"
  title.ru: "Проверка бэкапов и восстановления"
  title.en: "Backup and restore drill"
  summary.uz: "Hamma muhim maʼlumot server tashqarisiga zaxiralanganini tekshiradi, yetishmaganini sozlaydi va backup haqiqatan tiklanishini ishlab turgan tizimga tegmasdan sinab koʻradi."
  summary.ru: "Проверяет, что всё важное копируется за пределы сервера, настраивает недостающее и доказывает, что бэкап восстанавливается, не трогая рабочую систему."
  summary.en: "Checks everything important is copied off the server, sets up what is missing, and proves a backup restores without touching production."
---

# Backup and restore drill

A backup nobody has restored is a hope, not a backup. The drill answers two questions: is every piece of data copied somewhere that survives the server, and does a copy come back as working data?

## 1. Inventory: what holds data

`platform_map`, then for each project:

- **Database services** (PostgreSQL, MySQL, MariaDB, MongoDB, Redis with persistence, ClickHouse): `api_call GET /api/services/{id}` with `pick: ["name","type","backupSchedule","backupRetention","backupDestinationId"]`, and `GET /api/services/{id}/backups` with `pick: ["status","createdAt","size","error"]`.
- **Application volumes**: `GET /api/applications/{id}/volumes`, and `GET /api/applications/{id}/volumes/{volumeId}/backups`.
- **File storage services** (`minio`, `files`): their buckets hold user uploads; see how they are backed up (`GET /api/services/{id}/storage`).
- **Destinations**: `GET /api/s3-destinations`; `POST /api/s3-destinations/{id}/test` proves the credentials still work.
- **The panel itself**: its database and keys live in `/var/lib/torexploy` on its server. Losing it means losing the configuration of everything. Note whether that directory is copied anywhere (`shell`: `ls -la /var/lib/torexploy`, and ask the person).

Build a table: what, how big, last successful backup, schedule, kept where, kept how long.

## 2. Judge it

For each row, one of:

- **Good**: scheduled, the last run succeeded recently, copied to S3 (off the server), retention fits the data's value.
- **At risk**: backups only on the same server (a dead disk takes both), last success older than the schedule says, failures in the list, no retention (fills the disk).
- **None**: data with no backup at all. Volumes are the usual blind spot: uploads written by an app to its volume.

Also check that someone hears about failures: `GET /api/notifications` should have a channel subscribed to `backup.failed`.

## 3. Close the gaps

Each change is one approval. Ask the person for the schedule if they have a preference; otherwise propose: databases daily at a quiet hour (`0 3 * * *`), kept 14 days; busy databases every 6 hours; volumes with user files daily.

- An S3 destination when none exists: the person must provide the bucket and keys (any S3-compatible storage). Create it with `POST /api/s3-destinations`, then test it.
- A database service: `PATCH /api/services/{id}` with `backupSchedule`, `backupRetention`, `backupDestinationId`.
- A volume: `PATCH /api/applications/{id}/volumes/{volumeId}` with its backup settings (look the fields up with `api_docs`).
- A notification channel for `backup.failed`, if none.
- Then take one backup now of each (`POST .../backups`) and check it succeeds.

## 4. The drill: restore without touching production

Never test by restoring over the live database: the platform's restore replaces the current data.

**PostgreSQL** (backups are `pg_dump` custom format). Fetch the newest backup file to the server. Local backups are under `/var/lib/torexploy/backups/<service id>/` on the panel's server; for S3 ones, download with the AWS CLI in a throwaway container. Then restore it into a throwaway database container of the same major version:

```sh
docker run -d --rm --name restore-drill -e POSTGRES_PASSWORD=drill postgres:<major>
sleep 8; docker exec -i restore-drill pg_restore -U postgres -d postgres --no-owner --exit-on-error < /var/lib/torexploy/backups/<service id>/<file>
docker exec restore-drill psql -U postgres -d postgres -Atc "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 10"
```

**MySQL / MariaDB** (backups are SQL from `mysqldump` / `mariadb-dump`, possibly compressed: check with `file`):

```sh
docker run -d --rm --name restore-drill -e MYSQL_ROOT_PASSWORD=drill -e MYSQL_DATABASE=drill mysql:<version>
sleep 20; docker exec -i restore-drill sh -c 'mysql -uroot -pdrill drill' < /var/lib/torexploy/backups/<service id>/<file>
docker exec restore-drill mysql -uroot -pdrill -N -e "SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema='drill' ORDER BY table_rows DESC LIMIT 10"
```

(`mariadb:<version>` with `MARIADB_ROOT_PASSWORD` / `MARIADB_DATABASE` and the `mariadb` client for MariaDB.)

**A volume backup**: list the archive (`tar -tzf <file> | head`, `tar -tzf <file> | wc -l`) and compare the file count and the newest files with the live volume.

The drill passes when the restore finishes without errors and the row counts of the main tables are close to production's (compare with the same query on the live database through `db/run` with `readOnly: true`). Note how long the restore took: that is the downtime a real disaster would cost.

Always clean up: `docker rm -f restore-drill`, and delete any file you downloaded.

## 5. Report

The inventory table with a verdict per row, what was set up, the drill result (passed or failed, time to restore, row counts), and what remains only the person can do: keep a copy of `/var/lib/torexploy` (or at least its `secret.key`) somewhere safe, and repeat the drill every few months.
