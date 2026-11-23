---
name: uptime-and-health-monitoring
description: Make sure problems are noticed before users report them - health checks on every application, memory limits so one crash stays contained, notification channels (Telegram, Slack, Discord, webhook) for failed deploys, crashes, failed backups and offline servers, and an outside uptime check. Use when asked to monitor servers or sites, set up alerts or notifications, know when something goes down, or improve reliability.
metadata:
  triggers: "monitor kuzat kuzatuv ogohlantir bildirishnoma telegram slack discord uptime downtime health healthcheck alert alerts notify notification мониторинг уведомл оповещ телеграм аптайм"
  title.uz: "Kuzatuv va ogohlantirishlar"
  title.ru: "Мониторинг и оповещения"
  title.en: "Uptime and health monitoring"
  summary.uz: "Har bir ilovaga health check, xotira chegarasi va Telegram/Slack/Discord ogohlantirishlarini sozlaydi, shunda muammoni foydalanuvchilardan oldin bilasiz."
  summary.ru: "Настраивает health check для каждого приложения, лимиты памяти и оповещения в Telegram/Slack/Discord, чтобы узнавать о сбоях раньше пользователей."
  summary.en: "Sets up health checks, memory limits and Telegram/Slack/Discord alerts so problems are known before users report them."
  title.kaa: "Baqlaw hám eskertiwler"
  summary.kaa: "Hár bir qosımshaǵa health check, yad shegi hám Telegram/Slack/Discord eskertiwlerin sazlaydı, sonda mashqalanı paydalanıwshılardan aldın bilesiz."
  title.ky: "Көзөмөл жана эскертүүлөр"
  summary.ky: "Ар бир колдонмого ден соолук текшерүүсүн, эс тутум чегин жана Telegram/Slack/Discord эскертүүлөрүн жөндөйт, ошентип көйгөй тууралуу колдонуучулардан мурун билесиз."
  title.tg: "Назорат ва ҳушдорҳо"
  summary.tg: "Барои ҳар барнома санҷиши саломатӣ, ҳадди хотира ва ҳушдорҳои Telegram/Slack/Discord-ро танзим мекунад, то ки мушкилотро пеш аз корбарон донед."
  title.kk: "Бақылау және ескертулер"
  summary.kk: "Әр қолданбаға жұмысқа қабілеттілік тексерісін, жад шегін және Telegram/Slack/Discord ескертулерін баптайды, сонда мәселені пайдаланушылардан бұрын білесіз."
  title.tk: "Gözegçilik we duýduryşlar"
  summary.tk: "Her programma üçin saglyk barlagyny, ýat çägini we Telegram/Slack/Discord duýduryşlaryny sazlaýar, şeýlelikde meseläni ulanyjylardan öň bilersiňiz."
---

# Uptime and health monitoring

Three layers, each catching what the one before misses: the platform checks each application, notifications tell a person, and something outside the server notices when the whole server is gone.

## 1. What is in place

- `platform_map`, then for each application `api_call GET /api/applications/{id}` with `pick: ["name","kind","healthCheckPath","healthCheckTimeoutSec","memoryLimitMb","replicas","strategy","status"]`.
- `GET /api/notifications`: the channels and the events each receives. The events are `deployment.failed`, `deployment.succeeded`, `application.crashed`, `backup.failed` and `server.offline`.
- `GET /api/servers`: the servers, so each is covered.

Make a table: application, health check (yes/no), memory limit, replicas, and whether anyone is told when it fails.

## 2. Health checks

A web application without a health check is declared healthy as soon as its process starts, even when it cannot reach its database; and a rolling deployment then replaces a working version with a broken one.

For each web application without one:

1. Find a path that answers 200 without logging in, quickly, and only when the app really works: `/health`, `/healthz`, `/api/health`, `/up` (Rails), `/actuator/health` (Spring). Search the source (`code` op "open", `file_search` for `health`) or try from inside: `exec` with `app:<id>`: `wget -qO- -S localhost:<port>/health 2>&1 | head -3`.
2. If none exists, a path that renders without the database is better than nothing (`/`), and suggest the developers add a real one that checks the database.
3. Set it: `PATCH /api/applications/{id}` with `healthCheckPath` and a `healthCheckTimeoutSec` long enough for a cold start. Keep `strategy: "rolling"` for web apps so a failing new version never replaces a working one.

## 3. Contain failures

- A memory limit on every application (`memoryLimitMb`), sized from its metrics (peak plus 30 %): a leak then restarts one app, not the server.
- Two replicas for anything that must not blink during a restart, if the server has room and the app keeps no state in memory.

## 4. Tell a person

Ask where the person wants alerts: Telegram, Slack, Discord, or a webhook. They provide the token or URL; never invent one.

`POST /api/notifications` with the channel and events (look the body up with `api_docs`). Recommended: `deployment.failed`, `application.crashed`, `backup.failed`, `server.offline` for everyone on call; `deployment.succeeded` only if they want the noise. Then `POST /api/notifications/{id}/test` and ask the person to confirm the test arrived.

## 5. Watch from outside

The panel cannot report that its own server is down, and nothing on a server sees what its users see (DNS, certificates, the network path). Recommend an outside uptime monitor checking each public domain every minute or few, with alerts to the same place: a hosted service (UptimeRobot, Better Stack, Healthchecks.io and the like, most have a free tier) or a small monitor (Uptime Kuma) deployed on a **different** server through the panel. Monitoring the server from itself only catches half.

For scheduled jobs (cron jobs, backups), a "dead man's switch" check (Healthchecks.io-style ping at the end of each run) catches jobs that silently stop running.

## 6. Prove it

Test one alert end to end with the person's agreement: for example stop a non-critical application for a minute (`POST /api/applications/{id}/stop`, then start it again) and confirm the crash or the outside monitor's alert arrived. Never break production to test.

## Report

The table from step 1 before and after, the channels and their events, what the outside monitor covers, and what remains for the person to set up themselves.
