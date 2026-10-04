# TorexPloy — arxitektura va ijro rejasi

> Self-hosted PaaS: GitHub repo → build → zero-downtime deploy → domen + HTTPS.
> Bitta VPS'dan boshlanadi, SSH orqali istalgancha serverga kengayadi.

## 1. Asosiy qarorlar

| Qatlam | Tanlov | Nima uchun |
|---|---|---|
| Runtime | **Node.js 26, native TypeScript** | Server uchun build bosqichi yo'q; `node:sqlite`, `fetch`, `crypto` ichida tayyor. |
| Control-plane DB | **SQLite (WAL) — `node:sqlite`** | Bitta fayl, atomik tranzaksiyalar, ops talab qilmaydi. Control-plane yuklamasi (ko'p o'qish, kam yozish) uchun ideal. Zaxira nusxa — bitta fayl. |
| HTTP | **Hono + @hono/node-server** | Kichik va tez, web-standart API, SSE helper. Tashqi bog'liqligi deyarli yo'q. |
| Validatsiya | **zod** (`@ploy/shared`) | Bitta schema server va UI'da ishlaydi, shuning uchun API kontrakti ikki joyda alohida yozilmaydi. |
| Konteynerlar | **Docker Engine API** (unix socket) + **`docker buildx` CLI** | Lifecycle, stats, events va loglar to'g'ridan-to'g'ri API orqali (CLI matnini parse qilish yo'q). Build uchun BuildKit CLI ishlatiladi, chunki kesh, `--mount=type=cache` va bekor qilish faqat shu yerda to'liq ishlaydi. |
| Multi-server | **SSH tunnel** (`ssh … docker system dial-stdio`) | Remote serverga agent o'rnatish shart emas, faqat Docker va SSH kalit kerak. Tunnel lokal unix socket bo'lib ochiladi, shuning uchun Docker kodi local va remote uchun **bir xil**. |
| Reverse proxy | **Caddy** (har bir serverda `ploy-proxy`) | Avtomatik ACME (Let's Encrypt + ZeroSSL), atomik graceful reload, HTTP/3. Config Docker API orqali yuboriladi; admin API konteyner ichidagi `localhost`'da turadi va ilovalarga ko'rinmaydi. |
| Realtime | **SSE** | Loglar, metrikalar va holat o'zgarishlari bir tomonlama oqim. WebSocket'dan sodda, proxy orqali yaxshi o'tadi va o'zi qayta ulanadi. |
| Navbat | **SQLite `jobs` jadvali** + in-process worker'lar | Redis kerak emas. Jarayon qayta ishga tushsa, navbat saqlanib qoladi; retry va backoff bor. |
| Frontend | **React 19 + Vite + TanStack Query + React Router** | Route darajasidagi code splitting, SSE → cache invalidation, optimistik yangilanishlar. |
| i18n | **O'z tipli lug'atlarimiz** (uz asosiy, ru/en lazy) | `uz` lug'ati — tip manbai, shuning uchun ru/en'da kalit yetishmasa **compile xatosi** chiqadi. Plural `Intl.PluralRules`, sana va sonlar `Intl.*` orqali formatlanadi. |
| Stil | **Qo'lda yozilgan CSS design system** (token'lar) | Runtime yo'q, to'liq nazorat, `data-theme` + `prefers-color-scheme`. Shriftlar lokal (offline / air-gapped muhitda ham ishlaydi). |

**Tamoyil:** mock, fake yoki placeholder yo'q. Platforma ishlashi uchun Docker shart. Docker topilmasa, UI aniq
diagnostika ko'rsatadi; "soxta" fallback rejimi yo'q.

## 2. Topologiya

```
                         Internet (80/443)
                                │
          ┌─────────────────────▼─────────────────────┐   har bir serverda
          │ ploy-proxy  (Caddy, ACME, HTTP/3)         │◄── bittadan
          │ tarmoqlar: ploy + har bir loyiha tarmog'i │
          └───┬───────────────┬──────────────┬────────┘
              │ ploy          │ ploy-p-<A>   │ ploy-p-<B>
  ┌───────────▼────────┐  ┌───▼─────────┐ ┌──▼──────────┐
  │ ploy-control       │  │ A ilovalari │ │ B ilovalari │   loyihalar bir-biridan
  │ API · UI · worker  │  │ A DB'lari   │ │ B DB'lari   │   tarmoq darajasida ajratilgan
  │ SQLite · scheduler │  └─────────────┘ └─────────────┘
  └──┬───────────┬─────┘
     │ docker.sock (local)
     │ SSH dial-stdio tunnel (remote) ──► remote server: Docker + ploy-proxy + ilovalar
```

- **Ilovalar faqat o'z loyihasining tarmog'iga** ulanadi. A loyiha B loyihaning bazasini ko'ra olmaydi.
- **Host'ga port ochilmaydi.** Ilovaga faqat proxy orqali kiriladi. DB uchun public port ixtiyoriy va aniq yoqiladi.
- **Health-check** proxy konteyneri ichidan bajariladi (`docker exec ploy-proxy wget …`), shuning uchun local va remote
  serverlarda bir xil ishlaydi va control-plane'ga ilova tarmoqlariga kirish kerak bo'lmaydi.

## 3. Kod tuzilmasi

```
packages/
  shared/   API kontrakti: zod schema'lar, DTO tiplar, enum'lar, xato kodlari. Node'ga ham, DOM'ga ham bog'liq emas.
  server/   control plane
    src/lib/        config, logger, crypto, xatolar, id'lar, process runner, cron parser, tar
    src/db/         SQLite wrapper, migratsiyalar
    src/docker/     Engine API client (socket), stream demux, build CLI
    src/servers/    server ulanishlari (local socket | SSH tunnel), bootstrap, host metrikalari
    src/proxy/      Caddy config generatori + sync (desired state → atomik yuklash)
    src/build/      git fetch, stack aniqlash, Dockerfile generatsiya
    src/deploy/     pipeline, rollback, reconcile (self-heal), cleanup
    src/services/   DB katalogi (postgres, mysql, mariadb, mongo, redis, rabbitmq, minio, clickhouse), backup
    src/github/     GitHub App (manifest flow), JWT RS256, installation token, webhook, commit status
    src/jobs/       navbat, worker pool, scheduler, cron
    src/realtime/   event bus, SSE
    src/metrics/    host va konteyner sampler, retention
    src/http/       Hono app, auth middleware, route'lar
  web/      dashboard (React)
deploy/     Dockerfile, install.sh
```

## 4. Ma'lumot modeli

```
users ─ sessions · api_tokens · user_identities(github)
teams ─ team_members(owner|admin|developer|viewer) · invitations
      ├ servers(local|ssh) ─ ssh kalit (shifrlangan), host key fingerprint
      ├ git_sources(github_app) ─ github_installations
      └ projects ─┬ applications ─┬ deployments (per-deploy log fayl)
                  │               ├ env_vars (AES-256-GCM) · domains · volumes
                  │               ├ service_links (DB → env inject)
                  │               └ cron_jobs ─ cron_runs
                  ├ services(DB) ─ backups
                  └ env_vars (loyiha darajasidagi umumiy o'zgaruvchilar)
jobs · metrics_host · metrics_app · audit_log · settings
```

## 5. Deploy pipeline

```
QUEUED → (per-app serial; build semaphore = PLOY_MAX_CONCURRENT_BUILDS)
FETCH     git: shallow clone, aniq commit SHA, GitHub App installation token (process ro'yxatida ko'rinmaydi)
BUILD     Dockerfile | auto (Node/Bun/Python/Go/Rust/PHP/static aniqlanadi → optimallashtirilgan Dockerfile)
          BuildKit layer cache + `RUN --mount=type=cache` (npm/pip/go kesh), `--progress=plain` log oqimi
START     yangi konteynerlar: ploy-<app>-<deploy>-<n>, loyiha tarmog'ida, resource limitlar, log rotation
HEALTH    web: port + ixtiyoriy HTTP yo'l (2xx/3xx); worker: barqarorlik oynasi (qayta ishga tushmasligi kerak)
SWITCH    active_deployment almashadi → Caddy config atomik yuklanadi (in-flight so'rovlar uzilmaydi)
DRAIN     eski konteynerlar grace period'dan keyin SIGTERM → o'chiriladi
DONE      eski image'lar retention (oxirgi N ta) bo'yicha GC'ga
```

- **Switch'dan oldingi xato:** eski versiya trafikni xizmat qilishda davom etadi, yangi konteynerlar tozalanadi.
- **Rollback:** avvalgi image bilan yangi deploy (build yo'q, bir necha soniyada).
- **Strategiya:** `rolling` (default, zero-downtime) yoki `recreate` (volume'ni bir o'zi ishlatadigan ilovalar uchun).
- **Recovery:** control-plane restart bo'lganda yarim qolgan deploy'lar `failed` deb belgilanadi va konteynerlari
  tozalanadi. Aktiv deploy konteynerlari yo'qolgan bo'lsa, qayta yaratiladi. Proxy config DB'dan qayta quriladi.
- **Auto-restart:** Docker `unless-stopped` policy ishlatiladi. Docker events kuzatilib, crash-loop aniqlanadi va
  UI'da ko'rsatiladi.

## 6. Xavfsizlik

| Xavf | Chora |
|---|---|
| Parol | scrypt (N=2^15), per-user salt, constant-time taqqoslash |
| Sessiya | 32B token, DB'da faqat SHA-256; `httpOnly`, `SameSite=Lax`, HTTPS'da `Secure` |
| CSRF | Mutatsiyalarda `Origin` tekshiruvi + `X-Ploy-Request` header (cross-site formdan yuborib bo'lmaydi) |
| Brute-force | IP + email bo'yicha token bucket, audit log |
| 2FA | TOTP (RFC 6238) + bir martalik recovery kodlar |
| Sirlar | AES-256-GCM, HKDF bilan ajratilgan sub-key'lar, master key `data/secret.key` (0600) |
| Webhook | `X-Hub-Signature-256` HMAC, constant-time |
| RBAC | Har bir resurs `team_id` bilan bog'langan; har bir handler rolni tekshiradi |
| Konteyner | `no-new-privileges`, `cap-drop ALL` + minimal allowlist, PID/CPU/RAM limitlar, loyiha tarmog'i izolyatsiyasi, docker.sock hech qachon mount qilinmaydi |
| Env | Sirlar `ps` ro'yxatida ko'rinmaydi (Engine API body orqali uzatiladi), UI'da maskalanadi, loglarda redact qilinadi |
| SSH | Har bir server uchun alohida ed25519 kalit, host key TOFU + fingerprint saqlanadi |
| HTTP | CSP, HSTS (HTTPS'da), `frame-ancestors 'none'`, `nosniff` |

## 7. Realtime va observability

- `EventBus` → `/api/events` (team bo'yicha SSE): deployment, ilova, servis va server holatlari.
- Build log: avval fayldan replay, keyin live tail. Kech ulangan mijoz ham to'liq logni ko'radi.
- Runtime log: Docker logs `follow` stream → SSE.
- Metrikalar: host (CPU/RAM/disk/load) va ilova (CPU/RAM/network) har 15 soniyada; grafiklar time-bucket bo'yicha agregatsiya qilinadi; retention sozlanadi.
- `/api/health` (liveness), `/api/health/ready` (DB + Docker + proxy).

### 7.1 Xato sabablari va lokalizatsiya

Server, deploy va servis xatolari ikki shaklda saqlanadi: barqaror **sabab kodi** (`status_reason`, `error_code`;
masalan `ssh_auth`, `health_timeout`, `oom`) va inglizcha texnik xabar. Panel kodni joriy tilga tarjima qiladi,
texnik xabar esa "Texnik tafsilotlar" ichida koʻrinadi. Shu tufayli interfeys toʻliq oʻzbekcha boʻlib qoladi,
diagnostika esa yoʻqolmaydi.

## 8. UX tamoyillari

- Tezlik: route-level splitting, `staleTime`, skeleton (layout shift yo'q), optimistik mutatsiyalar.
- Klaviatura: ⌘K command palette, ko'rinadigan fokus halqalari, to'liq tab-navigatsiya, `Esc` bilan yopish.
- Accessibility: semantik HTML, ARIA faqat kerak joyda, WCAG AA kontrast (ikkala temada), `prefers-reduced-motion`.
- Til va tema: profilda saqlanadi (barcha qurilmalarda sinxron) + `localStorage` (login sahifasida ham).
  Tema sahifa chizilishidan oldin qo'llanadi, shuning uchun miltillash bo'lmaydi.
- Brauzerlarda (Chromium) o'zbekcha CLDR ma'lumotlari yo'q, shuning uchun o'zbekcha sana, nisbiy vaqt va son
  formatlash CLDR qoliplari asosida qo'lda yozilgan (`i18n/uzFormat.ts`): "4-okt, 2026, 14:05", "6 daqiqa oldin".
  Rus va ingliz tillari `Intl` orqali formatlanadi.

## 8.1 Test strategiyasi

- Unit: kripto (RFC 6238 vektorlari), cron, tar (tizim `tar` bilan tekshiriladi), stack aniqlash, env.
- Protokol: Docker client unix socket'dagi server bilan (version negotiation, demux, xato semantikasi).
- End-to-end pipeline: Engine API'ni simulyatsiya qiluvchi in-process daemon bilan. Haqiqiy HTTP client, proxy sync va
  deploy holat mashinasi ishlaydi; faqat daemon simulyatsiya qilinadi.
- Real Caddy: generatsiya qilingan config `caddy validate` va jonli routing/reload orqali tekshiriladi.

## 9. Ijro rejasi

| # | Bosqich | Tayyorlik mezoni |
|---|---|---|
| 1 | Monorepo, shared kontrakt, server skeleti, DB sxemasi | typecheck + migratsiya testlari |
| 2 | Auth (setup wizard, login, sessiya, 2FA, API token), team/RBAC, audit | HTTP integratsiya testlari |
| 3 | Loyiha, ilova, env, domen, volume, servis CRUD | HTTP testlar |
| 4 | Docker client, server ulanishlari (local/SSH), Caddy sync | protokol testlari (socket darajasida) |
| 5 | Git + stack aniqlash + build, pipeline, navbat, rollback, reconcile, cleanup | pipeline va builder testlari |
| 6 | DB servislar, link'lar, backup; cron job'lar | catalog va cron testlari |
| 7 | GitHub App (manifest), webhook, OAuth login, commit status | imzo/JWT testlari |
| 8 | SSE, metrikalar, runtime log | stream testlari |
| 9 | Dashboard: design system, i18n (uz/ru/en), tema, barcha sahifalar | build + headless screenshot tekshiruvi |
| 10 | Dockerfile, install.sh, yangilash, hujjatlar | `install.sh` lint, image build skripti |
