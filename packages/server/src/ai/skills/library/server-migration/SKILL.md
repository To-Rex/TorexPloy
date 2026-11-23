---
name: server-migration
description: Move applications and databases from one server to another with TorexPloy with as little downtime as possible - add the new server, recreate each application on it with the same settings and variables, copy database data and volumes, switch domains, verify, and retire the old one. Use when asked to move or migrate projects, apps or databases to a new or bigger server, change hosting providers, or replace a failing server.
metadata:
  triggers: "kochir kochirib migratsiya migrate migration relocate transfer переезд перенес перенос миграц"
  title.uz: "Boshqa serverga koʻchirish"
  title.ru: "Переезд на другой сервер"
  title.en: "Server migration"
  summary.uz: "Ilovalar va bazalarni yangi serverga minimal uzilish bilan koʻchiradi: sozlamalar, oʻzgaruvchilar, maʼlumotlar, volume’lar, domenlar, tekshiruv va eski serverni oʻchirish."
  summary.ru: "Переносит приложения и базы на новый сервер с минимальным простоем: настройки, переменные, данные, тома, домены, проверка и вывод старого сервера."
  summary.en: "Moves apps and databases to a new server with minimal downtime: settings, variables, data, volumes, domains, checks, and retiring the old one."
  title.kaa: "Basqa serverge kóshiriw"
  summary.kaa: "Qosımshalar hám maǵlıwmatlar bazaların jańa serverge minimal úzilis menen kóshiredi: sazlawlar, ózgeriwshiler, maǵlıwmatlar, tomlar, domenler, tekseriw hám eski serverdi óshiriw."
  title.ky: "Башка серверге көчүрүү"
  summary.ky: "Колдонмолорду жана маалымат базаларын жаңы серверге минималдуу үзгүлтүк менен көчүрөт: жөндөөлөр, өзгөрмөлөр, маалыматтар, томдор, домендер, текшерүү жана эски серверди өчүрүү."
  title.tg: "Интиқол ба сервери дигар"
  summary.tg: "Барномаҳо ва пойгоҳҳои додаҳоро бо ҳадди ақали танаффус ба сервери нав интиқол медиҳад: танзимот, тағйирёбандаҳо, маълумот, томҳо, доменҳо, санҷиш ва аз кор баровардани сервери кӯҳна."
  title.kk: "Басқа серверге тасымалдау"
  summary.kk: "Қолданбалар мен дерекқорларды жаңа серверге ең аз үзіліспен тасымалдайды: баптаулар, айнымалылар, деректер, томдар, домендер, тексеру және ескі серверді өшіру."
  title.tk: "Başga serwere göçürmek"
  summary.tk: "Programmalary we maglumatlar bazalaryny täze serwere iň az kesilme bilen göçürýär: sazlamalar, üýtgeýänler, maglumatlar, tomlar, domenler, barlag we köne serweri öçürmek."
---

# Server migration

A migration is a plan carried out in order, with the old server untouched until the new one is proven. Write the plan first, agree it with the person, then go step by step.

## 1. Inventory and plan

- `platform_map` and `api_call GET /api/servers`: what runs on the old server.
- For each application: `GET /api/applications/{id}` (source, build and runtime settings), its variables (`GET .../variables`, names only; the values are copied server side, not read), domains, volumes, links, cron jobs.
- For each service: type, version, size (`GET /api/services/{id}/db/overview`), its domains and public port.
- Check the new server: `POST /api/servers` to add it if it is not there yet (the person provides the address and access), then `POST /api/servers/{id}/verify`, and Docker on it (`POST /api/servers/{id}/install-docker` if needed). Compare its CPU, memory and disk with what the old one uses at peak (metrics, `range: "7d"`).

Plan the order: **databases first** (applications need them), then applications, then domains, then the old server. Decide with the person when the short write-freeze for each database may happen.

## 2. Databases

Create the new service on the new server with the **same type and major version** (`POST /api/projects/{id}/services` with the new `serverId`). Then copy the data. The simplest way that never stores a dump on disk streams from the old container straight into the new one through the network, for which the new service needs a public port for a few minutes:

1. Give the new service a public port and allow only the old server's IP to reach it (`ufw allow from <old ip> to any port <port> proto tcp` on the new server, and remember Docker bypasses ufw: also `iptables -I DOCKER-USER -p tcp --dport <port> ! -s <old ip> -j DROP`).
2. Tell the person writes are about to pause; stop the applications that write (`POST /api/applications/{id}/stop`), so the copy is consistent.
3. Stream it, on the old server (`shell`):
   - PostgreSQL: `docker exec <old container> pg_dump -U <user> -d <db> -Fc | docker run --rm -i postgres:<major> pg_restore --no-owner -d "postgresql://<user>:<password>@<new ip>:<port>/<db>"`
   - MySQL/MariaDB: `docker exec <old container> sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers <db>' | docker run --rm -i mysql:<version> mysql -h <new ip> -P <port> -uroot -p<password> <db>`
   Get the credentials with `GET /api/services/{id}/credentials` and put them only in the command, never in your reply.
4. Compare row counts of the main tables on both sides (`db/run` with `readOnly: true`).
5. Remove the public port and the firewall rules.

For a large database where the freeze would be too long, say so and plan logical replication or a maintenance window with the person instead.

Take a fresh backup of the old database before step 2 (`POST /api/services/{id}/backups`), whatever happens.

## 3. Applications

For each application, create it on the new server with the same source and settings (`POST /api/projects/{id}/applications`, then `PATCH` with the build and runtime settings read in step 1). Variables: read them with `reveal` only to write them to the new application with `PUT .../variables` in the same step, and never repeat them in your reply. Point database URLs at the **new** services (their internal host names differ). Recreate volumes, links and cron jobs.

Volumes with data: copy them like databases, after stopping the old app:

```sh
docker run --rm -v <old volume>:/from:ro alpine tar -C /from -czf - . | ssh <new server> 'docker run --rm -i -v <new volume>:/to alpine tar -C /to -xzf -'
```

If the old server cannot reach the new one over SSH, use a volume backup to S3 and restore it on the new application instead.

Deploy each new application (`POST .../deploy`, `wait_deployment`) and check it on its generated address (`POST /api/applications/{id}/domains/generate`) before any real domain moves.

## 4. Switch the domains

1. Ask the person to lower the TTL of the records to 300 seconds a day ahead if possible.
2. Move each domain to the new application (remove it from the old app, add it to the new one), then the person changes the A record to the new server's IP.
3. Watch: `POST /api/domains/{domainId}/verify` until the certificate is served (see `ssl-domain-troubleshooting` if not), and the new app's logs for real traffic.

## 5. Verify, then retire

- Every application answers on its domain; the logs show real requests; no errors in the database logs; backups are scheduled on the new services, and one has succeeded.
- Leave the old server running and untouched for a few days, its applications stopped, as the fallback.
- Only then, with the person's explicit go-ahead: delete the old applications and services (`DELETE`, with data), and remove the server from the panel. That is irreversible: list exactly what will go before asking.

## Report

What moved, the downtime each piece had, what was verified, what still points at the old server, and the date the old server can be shut down.
