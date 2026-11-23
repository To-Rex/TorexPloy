---
name: disk-space-recovery
description: Free disk space on a full or nearly full server safely - find what is using it (Docker images, build cache, old deployments, container logs, volumes, journals, backups, database files) and remove only what can be rebuilt, never data. Use when a disk is full or almost full, deploys fail with "no space left on device", or the person asks to clean up a server.
metadata:
  triggers: "disk joy toldi tolib tolgan tozala boshat hajm space full cleanup clean диск место заполн почист очист"
  title.uz: "Disk joyini boʻshatish"
  title.ru: "Освобождение места на диске"
  title.en: "Disk space recovery"
  summary.uz: "Diskni nima egallaganini topadi (image, build kesh, eski deploylar, loglar, backup) va faqat qayta tiklanadiganini oʻchiradi, maʼlumotlarga tegmaydi."
  summary.ru: "Находит, что занимает диск (образы, кэш сборки, старые деплои, логи, бэкапы), и удаляет только то, что можно пересоздать, не трогая данные."
  summary.en: "Finds what fills the disk (images, build cache, old deploys, logs, backups) and removes only what can be rebuilt, never data."
  title.kaa: "Disktegi orındı bosatıw"
  summary.kaa: "Diskti ne iyelegenin tabadı (obrazlar, jıynaw keshi, eski ornalastırıwlar, loglar, rezerv nusqalar) hám tek qayta tiklenetuǵının óshiredi, maǵlıwmatlarǵa tiymeydi."
  title.ky: "Дисктеги орунду бошотуу"
  summary.ky: "Дискти эмне ээлегенин табат (образдар, куруу кэши, эски жайгаштыруулар, логдор, камдык көчүрмөлөр) жана кайра түзүлө ала тургандарын гана өчүрөт, маалыматтарга тийбейт."
  title.tg: "Озод кардани ҷойи диск"
  summary.tg: "Меёбад, ки дискро чӣ ишғол кардааст (образҳо, кэши сохтан, ҷойгиркуниҳои кӯҳна, логҳо, нусхаҳои эҳтиётӣ) ва танҳо он чиро, ки аз нав барқарор кардан мумкин аст, нест мекунад; ба маълумот даст намерасонад."
  title.kk: "Дискідегі орынды босату"
  summary.kk: "Дискіні не алып жатқанын табады (образдар, құрастыру кэші, ескі орналастырулар, логтар, сақтық көшірмелер) және тек қайта жасауға болатынын жояды, деректерге тиіспейді."
  title.tk: "Diskde ýer boşatmak"
  summary.tk: "Diskde ýeri nämäniň eýeleýändigini tapýar (obrazlar, gurnama keşi, köne ýerleşdirişler, loglar, ätiýaçlyk nusgalary) we diňe gaýtadan döredip bolýan zatlary pozýar, maglumatlara degmeýär."
---

# Disk space recovery

The rule: **delete what can be rebuilt, never what cannot.** Images and build cache come back with the next build; a volume, a database file or a backup does not come back at all.

## 1. How full, and how fast

```sh
df -hT -x tmpfs -x devtmpfs -x overlay; echo ---; df -i / | tail -1
```

A disk at 100 % inodes but not bytes is millions of small files (a cache directory, a mail queue, session files): find the directory with `find / -xdev -type d -size +1M 2>/dev/null | head`.

Ask the metrics how fast it has filled (`api_call GET /api/servers/{id}/metrics` with `range: "7d"`): a steady climb means something grows without limit, and cleaning only buys time until the cause is fixed.

## 2. Where it went (one call)

```sh
docker system df; echo ---
du -xh --max-depth=1 / 2>/dev/null | sort -rh | head -12; echo ---
du -sh /var/lib/docker/* 2>/dev/null | sort -rh | head -8; echo ---
journalctl --disk-usage 2>/dev/null; du -sh /var/log 2>/dev/null; du -sh /var/lib/torexploy/* 2>/dev/null | sort -rh | head -6
```

Then the usual large items:

```sh
find /var/lib/docker/containers -name '*-json.log' -size +100M -printf '%s %p\n' 2>/dev/null | sort -rn | head -5 | awk '{printf "%.0f MB %s\n", $1/1048576, $2}'
docker volume ls -qf dangling=true | wc -l
find / -xdev -type f -size +500M -not -path '/proc/*' -not -path '/var/lib/docker/overlay2/*' -printf '%s %p\n' 2>/dev/null | sort -rn | head -10 | awk '{printf "%.1f GB %s\n", $1/1073741824, $2}'
```

## 3. Free it, safest first

Show the person the plan with the size each step should free, then go in this order. Each step is one approval; check `df -h /` after each and stop when there is enough room (20 % free is comfortable).

1. **Build cache and unused images**, the usual winner, through the platform: `api_call POST /api/servers/{id}/cleanup`. By hand the same is `docker builder prune -af && docker image prune -af`. Running containers keep their images; the next deployment of a stopped app pulls or builds again.
2. **Old deployments** of each application: `GET /api/applications/{id}/deployments/cleanup` shows how many would go, `POST` removes all but the active and the newest one (so a rollback to the previous one still works).
3. **The systemd journal**: `journalctl --vacuum-size=200M`.
4. **Old rotated logs**: `find /var/log -type f \( -name '*.gz' -o -name '*.[0-9]' \) -mtime +7 -delete`.
5. **Huge container logs**: containers started by TorexPloy rotate their logs (20 MB × 5); others may not. Empty one without breaking the container: `truncate -s 0 <path>-json.log`. Then fix the cause: the image logs too much, or set log limits in its compose file (`logging: { driver: json-file, options: { max-size: 20m, max-file: "5" } }`).
6. **Package caches**: `apt-get clean` (or `dnf clean all`).
7. **Stopped containers** that no one needs: list with `docker ps -a --filter status=exited --format '{{.Names}}\t{{.Image}}\t{{.Status}}'`, ask about each one that the platform did not create. `docker container prune -f` removes all stopped ones; platform-managed ones are recreated at their next deploy.

## 4. Only with the person's explicit choice

These hold data. Never remove them as part of a "cleanup"; name them, give their size, and let the person decide one by one.

- **Dangling volumes** (`docker volume ls -f dangling=true`): no container uses them now, but one may have used them yesterday: an application that was deleted, or a service that is stopped. Show each with its size (`docker system df -v`) and, where a name tells, which app it belonged to.
- **Local backups** under `/var/lib/torexploy/backups/`: lower the retention of the service (`backupRetention` with `PATCH /api/services/{id}`) and move backups off the server to S3 (`backupDestinationId`), rather than deleting files by hand. A backup kept only on the same disk dies with that disk anyway.
- **Database files**: a database that grew is data. See its own skill: old rows may be archived, tables vacuumed (PostgreSQL) or optimised (MySQL), but only by decision.
- **Large files found under `/root`, `/home`, `/opt`**: dumps, archives and downloads someone made by hand. Ask.

## 5. Make it not happen again

- Put local backups on S3 with a retention.
- Keep old deployments in check (the cleanup above, now and then).
- If the disk is simply too small for what runs on it, say so with numbers: the growth per week and the days until full. Most providers grow a disk without a rebuild.
- Offer a notification for the server going offline (`uptime-and-health-monitoring`), since a full disk is the most common reason.

## Report

Free space before and after, what was removed and how much each step freed, what was left on purpose (with sizes), and what keeps growing.
