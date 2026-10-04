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
    src/github/     GitHub App (manifest flow), JWT RS256, installation token, webhook, commit status, PR izohi
    src/previews/   PR preview'lar: `pull_request` webhook, ota ilovadan nusxa, limit, o'chirish
    src/domains/    avtomatik manzil (apps domeni yoki sslip.io), DNS/TLS tekshiruvi
    src/templates/  bir bosishda o'rnatiladigan ilovalar katalogi va o'rnatuvchi
    src/compose/    Docker Compose: faylni xavfsiz qayta yozish (tarmoq, alias, label) va `docker compose` dvigateli
    src/terminal/   konteynerga veb-terminal (WebSocket ↔ Docker exec TTY)
    src/notifications/ Telegram, Discord, Slack, imzolangan webhook
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
      ├ notification_channels(telegram|discord|slack|webhook) ─ manzil va tokenlar shifrlangan
      ├ git_sources(github_app) ─ github_installations
      ├ s3_destinations ─ zaxira nusxalar uchun S3 (secret shifrlangan)
      ├ registries ─ xususiy registr loginlari (parol shifrlangan; jamoada bitta host — bitta login)
      └ projects ─┬ applications(web|worker|compose; source github|git|image|raw) ─┬ deployments (per-deploy log fayl)
                  │               ├ applications (PR preview: parent_application_id, preview_pr_*)
                  │               ├ env_vars (AES-256-GCM) · domains · volumes
                  │               ├ service_links (DB → env inject)
                  │               └ cron_jobs ─ cron_runs
                  ├ services(DB, backup_destination_id) ─ backups(remote_key)
                  └ env_vars (loyiha darajasidagi umumiy o'zgaruvchilar)
jobs · metrics_host · metrics_app · audit_log · settings
```

## 5. Deploy pipeline

```
QUEUED → (per-app serial; build semaphore = PLOY_MAX_CONCURRENT_BUILDS)
FETCH     git: shallow clone, aniq commit SHA, GitHub App installation token (process ro'yxatida ko'rinmaydi)
BUILD     torex (TorexBuilder: Node/Bun/Python/Go/Rust/PHP/static aniqlanadi → optimallashtirilgan Dockerfile)
          | dockerfile | nixpacks | railpack | heroku | paketo | static  (5.7-boʻlim)
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

### 5.1 Veb-terminal

Brauzer `/api/applications/:id/terminal` (yoki `/api/services/:id/terminal`) manziliga WebSocket ochadi.
Protokol almashinishidan **oldin** tekshiriladi: sessiya cookie'si, `Origin` panelning o'z manzili bilan bir xil,
jamoada kamida `developer` roli. Konteyner nomi mijozdan olinmaydi: server uni faol deploy'ning replikalari
ro'yxatidan o'zi tanlaydi. So'ng ulanish Docker exec (TTY) bilan Engine API'ning hijack qilingan ulanishi
orqali bog'lanadi, shuning uchun lokal server va SSH serverlar bir xil ishlaydi.

- Binary frame'lar — klaviatura va terminal chiqishi; text frame'lar — JSON boshqaruv (`resize`, `ready`, `exit`, `error`).
- Brauzer orqada qolsa, konteyner chiqishi to'xtatib turiladi (backpressure); 30 daqiqa harakatsizlikdan keyin yopiladi.
- Har bir sessiya audit jurnaliga yoziladi (`terminal.opened`), bir foydalanuvchiga ko'pi bilan 8 ta sessiya.

### 5.2 Docker Compose

Compose ilovasi oddiy ilova bilan bir xil yozuv (`kind = 'compose'`): deploy tarixi, GitHub push, deploy hook,
o'zgaruvchilar, domenlar, loglar va terminal umumiy. Fayl panelda saqlanadi (`raw`) yoki repozitoriyadan olinadi.

- Fayl satr sifatida emas, YAML sifatida qayta yoziladi: har bir servis loyiha tarmog'iga `<stek>-<servis>` alias
  bilan qo'shiladi (compose'ning o'z `default` tarmog'i saqlanadi), platforma label'lari qo'yiladi, `restart` va log
  aylanishi berilmagan bo'lsa qo'shiladi. Anchor/merge (`<<: *x`) va `${VAR}` saqlanadi.
- O'zgaruvchilar `docker compose` CLI'ga muhit sifatida beriladi: fayldagi `${NOM}` shu orqali to'ladi, `.env` yozilmaydi.
- `up --detach --build --remove-orphans`; keyin barcha servislar ishlab turishi (health-check bo'lsa, healthy) yoki
  bir martalik vazifa 0 kod bilan tugashi kutiladi. Xato bergan servis logining oxiri xatoga qo'shiladi.
- Host darajasidagi imkoniyatlar (`privileged`, `network_mode: host`, host namespace'lar, xavfli `cap_add`,
  `devices`, mutlaq bind-mount, masalan `/var/run/docker.sock`) faqat admin ilovaga ruxsat bergandan keyin ishlaydi.
- 80/443 portlarni hostga ochish taqiqlangan (proxy'niki); domen servis va portga biriktiriladi.
- `compose/<app>/code` har deploy'da yangilanadi, `compose/<app>/files` saqlanadi (`../files/...`). SSH serverlarda
  nisbiy bind-mount bo'lsa, katalog serverga xuddi shu yo'lga ko'chiriladi.

### 5.3 Domenlar

Domen = host + yo'l prefiksi (`/`, `/api`), ixtiyoriy prefiksni olib tashlash, compose uchun servis va port, yoki
faqat yo'naltirish (308, yo'l va so'rov saqlanadi). Bitta host bir nechta yo'lga bo'linishi mumkin, lekin faqat bitta
jamoaga tegishli bo'ladi. Caddy'da aniqroq prefiks oldin turadi; sertifikat host uchun bitta.

### 5.4 Shablonlar

Shablon — image manbali oddiy ilova va unga kerakli bazalar. O'rnatishda servislar yaratiladi, ilovaga prefiks
bilan ulanadi (`DB_`, `CACHE_`), ilova o'zgaruvchilari esa `${DB_PGPASSWORD}` kabi havolalar sifatida yoziladi:
parollar nusxalanmaydi va servis bilan birga yangilanadi. Tasodifiy kalitlar o'rnatish paytida yaratiladi.
Hammasi bitta tranzaksiyada; tekshiruv o'tmasa, hech narsa yaratilmaydi. O'rnatilgandan keyin ilova
oddiy ilova kabi tahrirlanadi. Har bir image va teg registrda tekshirilgan; test har bir `${...}` havolasi
ulangan servisdan kelishini statik tekshiradi.

> MinIO Inc. hamjamiyat image'larini (Docker Hub, Quay) chiqarishni to'xtatdi, shuning uchun S3 servisi
> `pgsty/minio` (qo'llab-quvvatlanadigan drop-in fork) bilan ishlaydi; health-check `curl` orqali.

### 5.5 Xususiy registrlar

Jamoa registr loginini saqlaydi (`ghcr.io`, `registry.gitlab.com`, `docker.io`, `registry.example.uz:5000`).
Manzil Docker nomlaganidek saqlanadi: `https://` va oxirgi `/` olib tashlanadi, `index.docker.io` kabi
taxalluslar `docker.io` bo'ladi. Saqlash va login/parol o'zgarishidan oldin control-plane'ning lokal Docker'i
`POST /auth` (`docker login`, hech narsa yozmaydi) bilan tekshiradi; rad etilsa `registry_auth_failed`.

- **Image ilova:** image qaysi registrda ekanini Docker qoidasi aniqlaydi (`imageRegistryHost`: birinchi qism
  faqat `.`/`:` bo'lsa yoki `localhost` bo'lsa host, aks holda Docker Hub). Jamoada shu host uchun login bo'lsa,
  pull `X-Registry-Auth` bilan ketadi.
- **Build va compose:** jamoaning barcha loginlari deploy'ning o'z scratch katalogidagi `DOCKER_CONFIG`
  (`config.json`, `auths`, 0600) ga yoziladi, shuning uchun Dockerfile `FROM` va compose'dagi xususiy image'lar
  tortiladi. Katalog ish tugashi bilan o'chiriladi; bir jamoa logini boshqa jamoa build'iga hech qachon tushmaydi.
- Parol API'da qaytarilmaydi va deploy logida yashiriladi. Registr o'chirilsa, ilovalar image havolasini saqlaydi.

### 5.6 PR preview'lar

Preview — ota ilovaning yashirin bola ilovasi (`parent_application_id`, migratsiya v7): bitta pull request'ning
head branch'ini joylashtiradi. U oddiy ilova bo'lgani uchun build, deploy tarixi, loglar, domen, proxy, metrikalar
va terminal o'zgarishsiz ishlaydi. Loyiha va jamoa ro'yxatlarida, overview va server hisoblagichlarida ko'rinmaydi;
ota ilovaning "PR preview" tabida turadi (`GET /api/applications/:id/previews`), o'z sahifasi esa id bo'yicha ochiladi
(`parentApplicationId`, `pullRequest` bilan).

- **Yoqish:** faqat GitHub manbali web ilovada: `PATCH /api/applications/:id` → `previewsEnabled`, `previewLimit`
  (1–20), `previewEnv` (`.env` matni, `env` maqsadida shifrlanadi). Preview'ning o'zida yoqib bo'lmaydi. Manba yoki
  tur o'zgarsa, preview o'chadi. `GET …/preview-settings` matnni ochib beradi va webhook tayyorligini aytadi.
- **Webhook (`pull_request`, imzo push'dagidek tekshiriladi):** `opened`, `reopened`, `synchronize` — shu repo va base
  branch'dagi, preview yoqilgan har bir ilova uchun preview yaratiladi (limitdan oshsa o'tkazib yuboriladi va logga
  yoziladi) yoki yangilanadi, so'ng PR head commit'i navbatga qo'yiladi (`trigger: push`). `closed` — preview
  konteynerlari, image'lari va ma'lumotlari bilan o'chiriladi.
- **Fork'dan kelgan PR'lar e'tiborsiz qoldiriladi:** begona kod ota ilovaning sirlari va bazalari bilan ishga tushmasligi kerak.
- **Nusxa:** nom `<ota>-pr-<n>`, build va runtime sozlamalari, o'zgaruvchilar (ustidan `previewEnv`), ulangan bazalar;
  bitta replika, `rolling`, avtomatik deploy o'chiq; disk va cron yo'q. Har bir deploy oldidan (webhook yoki
  "qayta joylashtirish") ota ilovadan qayta olinadi, shuning uchun ota sozlamalari keyingi push'da qo'llanadi.
- **Manzil:** mavjud generator `pr-<n>-<ota>` yorlig'i bilan (`pr-7-web-shop.apps.example.uz`, sslip.io yoki
  `.localhost`). Manzil yaratib bo'lmasa ham preview joylashtiriladi.
- **PR izohi:** muvaffaqiyatli deploy'dan keyin PR'ga manzil bilan bitta izoh yoziladi, keyingi deploy'larda shu izoh
  yangilanadi. Xato bo'lsa faqat logga yoziladi, deploy'ga ta'sir qilmaydi. Commit status ham PR'da ko'rinadi.
- **O'chirish:** ota ilova yoki loyiha o'chirilganda avval preview'lar konteynerlari bilan o'chiriladi
  (`Deployer.remove`): `ON DELETE CASCADE` faqat yozuvlarni o'chiradi, konteynerlarni to'xtatmaydi.
- Audit: `preview.created`, `preview.deleted`. Realtime: preview va ota ilova uchun `application.updated` /
  `application.deleted`.
- Yangi GitHub App manifestida `pull_requests: write` ruxsati va `pull_request` hodisasi bor. Avval yaratilgan App'da
  ularni GitHub sozlamalarida qo'shib, o'rnatishda yangi ruxsatni tasdiqlash kerak.

### 5.7 Yigʻish usullari

Ilova `buildType` bilan image'ni kim yasashini tanlaydi (`BUILD_TYPES`; migratsiya v8 `applications` jadvalini qayta
quradi, eski `auto` → `torex`). `build/index.ts` (`runBuild`) bitta kirish nuqtasi: TorexBuilder, Dockerfile va statik
sayt uchun `planBuild` + `docker buildx build` (`build/builder.ts`), tashqi yigʻuvchilar uchun ularning oʻz CLI'si.
Deployer faqat `DeployPlan` koʻradi (`mode: dockerfile | generated | external`); `external` rejada Dockerfile yoʻq,
start buyrugʻi image'ning oʻzida.

| Tur | Nima qiladi | Buyruq |
|---|---|---|
| `torex` | TorexBuilder: stack aniqlanadi, optimallashtirilgan Dockerfile yoziladi; `systemPackages` (apt) image'ga qoʻshiladi | `docker buildx build --secret id=ploy_env,src=…` |
| `dockerfile` | Repodagi Dockerfile; `buildStage` → `--target` | `docker buildx build --build-arg NOM` (qiymat muhitdan) |
| `nixpacks` | Railway'ning birinchi yigʻuvchisi: `nixpacks.toml`ni oʻzi oʻqiydi, Dockerfile yozib `docker build` qiladi; panel buyruqlari `--install-cmd/--build-cmd/--start-cmd` | `nixpacks build <ctx> --name <tag> --label … --env NOM [--no-cache]` |
| `railpack` | `railpack prepare` reja va info faylini yozadi, soʻng BuildKit Railpack frontend'i bilan quradi; frontend tegi CLI versiyasiga mos (`ghcr.io/railwayapp/railpack-frontend:v<versiya>`) | `railpack prepare <ctx> --plan-out … --info-out … --env NOM` → `docker buildx build --build-arg BUILDKIT_SYNTAX=<frontend> -f railpack-plan.json --secret id=NOM,env=NOM --build-arg secrets-hash=… --build-arg cache-key=<app>` |
| `heroku` / `paketo` | Cloud Native Buildpacks (`pack`): builder `heroku/builder:24` yoki `paketobuildpacks/builder-jammy-base`, `buildpackBuilder` almashtiradi; `startCommand` Procfile'ga yoziladi; `pack`da `--label` yoʻq, shuning uchun image `FROM <tag>-cnb` Dockerfile bilan qayta label'lanadi va vaqtinchalik teg olib tashlanadi | `pack build <tag>-cnb --path <ctx> --builder <image> --pull-policy if-not-present --trust-builder --env NOM [--clear-cache]` |
| `static` | Fayllar Caddy bilan beriladi (TorexBuilder orqali) | `docker buildx build` |

- **Muhit.** Har bir CLI `DOCKER_HOST` (lokal soket yoki SSH tunnel) va deploy'ning oʻz `DOCKER_CONFIG`'i (jamoa
  registr loginlari, ish tugagach oʻchiriladi) bilan ishlaydi: build maqsad serverning BuildKit'ida boʻladi.
  Oʻzgaruvchilar faqat nomi bilan beriladi (`--env NOM`, `--secret id=NOM,env=NOM`), qiymatni CLI oʻz muhitidan
  oʻqiydi — buyruq qatorida sir yoʻq. `PATH`, `DOCKER_*` kabi nomlar oʻtkazilmaydi. Farq: Railpack sirlarni BuildKit
  secret sifatida oladi (qatlamga tushmaydi), Nixpacks esa ularni image'ga `ENV` qilib yozadi (uning dizayni, logda
  aytiladi), `pack` faqat build vaqtida beradi.
- **CLI mavjudligi.** `build/tools.ts` ishga tushganda PATH'da `nixpacks`, `railpack`, `pack` borligini tekshiradi;
  `BootstrapDto.features.builders` shu roʻyxatni beradi, panel faqat shularni taklif qiladi. Yoʻq yigʻuvchi tanlansa
  `422 validation_failed` (`buildType`, `reason: builder_unavailable`); deploy vaqtida CLI topilmasa
  `docker_unavailable` (`reason: builder_missing`). Control-plane image'i uchala binarni pinned versiya va sha256 bilan
  oʻrnatadi (`Dockerfile` boshidagi `ARG`lar; Railpack va pack checksum chiqaradi, Nixpacks'niki pin qilinganda hisoblangan).
- **Reja koʻrish.** `POST /api/applications/:id/build-plan` (developer) manbani deploy'dagidek shallow clone qiladi
  (GitHub token, deploy kaliti), build qilmasdan `BuildPlanDto` qaytaradi: `mode`, `stack`, `label`, Dockerfile matni
  (repodagi yoki TorexBuilder yozadigani), commit va ogohlantirishlar (yigʻuvchi e'tiborsiz qoldiradigan sozlamalar,
  topilmagan `buildStage`). Nixpacks uchun `nixpacks plan`, Railpack uchun `railpack prepare --info-out`, buildpack'lar
  uchun faqat builder nomi. Bir ilova uchun bir vaqtda bitta (ikkinchisi `409 conflict`, `plan_in_progress`); image va
  compose ilovalari `422`. Vaqtinchalik katalog har doim oʻchiriladi.
- **Xatolar.** Build xatosi `bad_request` + `reason: build_failed` (stderr'ning oxirgi mazmunli satrlari bilan), vaqt
  chegarasi `build_timeout`. Railpack rejalashtira olmasa chiqish kodi 0 boʻladi, shuning uchun info faylidagi
  `success` tekshiriladi.

**TorexBuilder** (`build/detect.ts` + `build/torex/*`, har bir stack oʻz faylida):

- Stack'lar: Node/Bun (Next.js standalone va export, Nuxt, SvelteKit, Remix/React Router, Astro, Angular SSR, NestJS,
  Vite/CRA/Gatsby/Docusaurus kabi statik freymvorklar, pnpm/yarn/npm/bun workspace'lar), Python (Django, FastAPI,
  Flask, Litestar, Sanic, Celery worker; uv/Poetry/PDM/Pipenv/pip), Go, Rust (workspace'lar bilan), PHP/Laravel,
  Ruby/Rails, Java (Maven/Gradle; Spring Boot, Quarkus, Micronaut), Clojure, .NET, Elixir/Phoenix, Gleam, Dart/Flutter,
  Swift/Vapor, Crystal, Nim, Haskell, Deno, statik sayt.
- Versiya manbalari: `.tool-versions`, `mise.toml`, `.nvmrc`/`.node-version`/`engines`/`packageManager`,
  `.python-version`/`requires-python`, `go.mod` (`toolchain` bilan), `rust-toolchain.toml`, `.ruby-version`,
  `.php-version`/`composer.json`, `pom.xml`/`build.gradle`/`.sdkmanrc`, `global.json` va boshqalar.
- Har bir Dockerfile: avval manifest va lockfile'lar `COPY` qilinadi (install qatlami keshlanadi), dev
  bogʻliqliklar runtime bosqichiga oʻtmaydi (prune), runtime foydalanuvchi root emas (PHP-apache'dan tashqari),
  `ENV PORT` + `EXPOSE`, `LABEL torexploy.builder=torex torexploy.stack=<stack>`. Sirlar faqat
  `--mount=type=secret,id=ploy_env` orqali, qatlamga tushmaydi.
- `torexploy.json` (kontekst katalogida, ixtiyoriy): `installCommand`, `buildCommand`, `startCommand`,
  `outputDirectory`, `systemPackages: []`, `runtime: { node, python, go, … }`. Ustunlik: panel sozlamalari > fayl >
  aniqlash. Notoʻgʻri fayl → `bad_request` (`reason: config_invalid`).
- `warnings[]`: lockfile yoʻq, start buyrugʻi taxmin qilingan, dev-server `start` skripti, EOL Node, monorepo
  (`--filter` buyruqlari bilan), Django'da `STATIC_ROOT` yoʻq va hokazo. Ular deploy logida va reja oynasida
  koʻrsatiladi.

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
| PR preview | Fork'dan kelgan PR'lar joylashtirilmaydi (begona kod sirlarni olmaydi); preview o'zgaruvchilari shifrlangan; branch nomi va commit SHA tekshiriladi |
| RBAC | Har bir resurs `team_id` bilan bog'langan; har bir handler rolni tekshiradi |
| Konteyner | `no-new-privileges`, `cap-drop ALL` + minimal allowlist, PID/CPU/RAM limitlar, loyiha tarmog'i izolyatsiyasi, docker.sock hech qachon mount qilinmaydi |
| Env | Sirlar `ps` ro'yxatida ko'rinmaydi (Engine API body orqali uzatiladi), UI'da maskalanadi, loglarda redact qilinadi |
| SSH | Har bir server uchun alohida ed25519 kalit, host key TOFU + fingerprint saqlanadi |
| HTTP | CSP, HSTS (HTTPS'da), `frame-ancestors 'none'`, `nosniff` |
| Terminal | Upgrade'dan oldin sessiya + `Origin` + `developer` roli; konteyner server tomonida tanlanadi; audit, sessiya cheklovi, harakatsizlik taymauti |
| Compose | Host darajasidagi imkoniyatlar faqat admin ruxsati bilan; 80/443 taqiqlangan; konteynerlar label orqali ajratiladi |
| Domen yo'llari | Begona jamoa hostiga yo'l qo'shib bo'lmaydi (host bitta jamoaga tegishli) |
| S3 | Kalitlar shifrlanadi; manzil saqlanishidan oldin yozib/o'chirib tekshiriladi; SigV4 AWS namunasi bilan tekshirilgan |
| Registrlar | Faqat admin boshqaradi; parol shifrlangan, API'da qaytarilmaydi; saqlashdan oldin `POST /auth` bilan tekshiriladi; CLI config har deploy uchun alohida (0600) va keyin o'chiriladi |
| Bildirishnomalar | Kanallarni faqat admin boshqaradi; manzil/token shifrlanadi; Discord/Slack uchun faqat rasmiy hostlar; webhook HMAC (`X-Ploy-Signature`), redirect'lar ta'qiqlangan, 10 s taymaut |

## 7. Realtime va observability

- `EventBus` → `/api/events` (team bo'yicha SSE): deployment, ilova, servis va server holatlari.
- Build log: avval fayldan replay, keyin live tail. Kech ulangan mijoz ham to'liq logni ko'radi.
- Runtime log: Docker logs `follow` stream → SSE.
- Metrikalar: host (CPU/RAM/disk/load) va ilova (CPU/RAM/network) har 15 soniyada; grafiklar time-bucket bo'yicha agregatsiya qilinadi; retention sozlanadi.
- `/api/health` (liveness), `/api/health/ready` (DB + Docker + proxy).
- Jamoa bo'yicha ro'yxatlar: `GET /api/deployments` (keyset kursor, `?status=` — holat yoki `active` =
  navbatda/build/deploy) va `GET /api/cron` (loyiha → ilova → nom tartibida, server nomi bilan).

### 7.1 Bildirishnomalar

Deployer, reconciler, backup va server monitoringi faqat "nima bo'ldi"ni xabar qiladi (`deploymentFinished`,
`appCrashed`, `backupFailed`, `serverOffline`). `Notifier` shu hodisaga obuna bo'lgan yoqilgan kanallarni topadi,
xabarni kanal tilida (uz/ru/en) va formatida (Telegram HTML, Discord/Slack markdown, JSON) yaratadi va fonda
yuboradi. Yetkazish asosiy amalni hech qachon to'xtatmaydi; oxirgi natija kanalda saqlanadi va sozlamalarda
ko'rinadi. Takrorlanuvchi signallar (crash-loop, uzilib-ulanayotgan server) 30 daqiqada bir marta yuboriladi.
O'z-o'zini tiklash (reconciler restart) muvaffaqiyati xabar qilinmaydi, xatosi qilinadi.

### 7.2 Zaxira nusxalar va S3

Zaxira nusxa avval serverga yoziladi, so'ng servisga tanlangan S3 manziliga oqim bilan yuklanadi (AWS S3,
Cloudflare R2, Backblaze B2, MinIO, SeaweedFS). Yuklash muvaffaqiyatsiz bo'lsa, nusxa serverda qoladi, ogohlantirish
yoziladi va bildirishnoma yuboriladi. Saqlash muddati tugagan nusxalar ikkala joydan o'chiriladi. Server nusxasi
yo'qolgan bo'lsa, yuklab olish va tiklash S3'dan ishlaydi.

### 7.3 Xato sabablari va lokalizatsiya

Server, deploy va servis xatolari ikki shaklda saqlanadi: barqaror **sabab kodi** (`status_reason`, `error_code`;
masalan `ssh_auth`, `health_timeout`, `oom`) va inglizcha texnik xabar. Panel kodni joriy tilga tarjima qiladi,
texnik xabar esa "Texnik tafsilotlar" ichida koʻrinadi. Shu tufayli interfeys toʻliq oʻzbekcha boʻlib qoladi,
diagnostika esa yoʻqolmaydi.

## 8. UX tamoyillari

- Tuzilma Dokploy'nikiga mos: chap panelda ikki guruh bor.
  - **Asosiy:** Loyihalar, Joylashtirishlar, Monitoring, Rejalashtirilgan vazifalar, Docker, Proksi.
  - **Sozlamalar:** Veb-server, Serverlar, Profil, Xavfsizlik, Jamoa, Git, Registrlar, S3 manzillar, Bildirishnomalar, API tokenlar, Audit.
  - Panel ikonkalar qatoriga yigʻiladi; tanlov `localStorage`da saqlanadi.
- Har bir sahifa bitta shablonda: kulrang ramka ichida oq varaq turadi. Unda sarlavha, qisqa tavsif va asosiy amallar, pastida kartalar boʻladi (`components/Frame.tsx`: `Frame`, `Card`, `SaveFooter`).
  - Har bir sozlamalar kartasi faqat oʻz maydonlarini saqlaydi, shuning uchun kartalar bir-birining oʻzgarishini bosib ketmaydi (`pages/app/appForm.ts`).
- Loyiha sahifasida ilovalar, compose steklar va bazalar bitta panjarada koʻrinadi.
  - Qidiruv va tur boʻyicha filtr bor.
  - Bir nechtasini belgilab, bir yoʻla joylashtirish, ishga tushirish yoki toʻxtatish mumkin.
  - Barcha yaratish amallari bitta "Yaratish" menyusida.
- Ilova tablari: Umumiy, Oʻzgaruvchilar, Domenlar, PR preview, Joylashtirishlar, Loglar, Monitoring, Cron vazifalar, Kengaytirilgan.
  - "Umumiy" tabida joylashtirish kartasi (joylashtirish, qayta yuklash, keshsiz yigʻish, toʻxtatish, terminal, avtomatik deploy), manba (GitHub, Git yoki Docker) va yigʻish usuli bor.
  - "Kengaytirilgan" tabida ishga tushirish buyrugʻi, port va replikalar, resurslar, sogʻliq tekshiruvi, strategiya va disklar bor.
  - Terminal dialog oynada ochiladi.
  - Eski manzillar (`/overview`, `/settings`, `/variables` va boshqalar) yangi tablarga yoʻnaltiriladi.
- Baza tablari: Umumiy (ichki va tashqi ulanish, kirish maʼlumotlari), Loglar, Monitoring, Zaxira nusxalar, Kengaytirilgan.
- Log koʻruvchisi (`components/LogViewer.tsx`) hamma joyda bitta: virtualizatsiya, ANSI ranglar, qidiruv (moslik
  ajratib koʻrsatiladi), daraja boʻyicha filtr (`lib/logLevel.ts`: matndagi soʻzlar va HTTP status kodlaridan
  taxminiy daraja), vaqt belgilari, pauza (yangi qatorlar sanaladi), nusxalash, `.txt` yuklab olish, oʻrash,
  toʻliq ekran (Esc bilan chiqiladi), oxirini kuzatish. Jonli loglarda qatorlar soni (`tail`, 100…5000 yoki
  hammasi) va vaqt oraligʻi (`since`, soniya) serverga `logWindow` orqali beriladi; replika va compose servis
  boʻyicha filtr ham bor.
- Ranglar shadcn'ning zinc palitrasida. Asosiy tugma siyoh rangida (yorugʻ temada qora, qorongʻida oq). Rang faqat holat uchun ishlatiladi: yashil, sariq va qizil.
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
- Terminal: haqiqiy HTTP server, haqiqiy WebSocket mijoz va hijack protokolini gapiradigan daemon (auth/origin/rol rad etishlari, klaviatura, resize, exit kodi).
- Shablonlar: har bir `${...}` havolasi statik tekshiriladi; o'rnatish bazalar, havolalar, disk, manzil va deploy'ni yaratishi tekshiriladi.
- Bildirishnomalar: formatlash va escaping, host cheklovlari, imzolangan webhook yetkazish, obuna va takrorlarni bostirish.
- Migratsiyalar: 1-versiyadagi baza ma'lumotlari bilan joyida yangilanadi; jadval qayta qurilishi (v4) bola yozuvlarni saqlaydi.
- Compose: faylni qayta yozish (tarmoq, alias, merge key, host ruxsati, port cheklovi) va soxta `docker` CLI bilan dvigatel oqimi.
- Caddy (haqiqiy): yo'l prefikslari tartibi, prefiksni olib tashlash, yo'nalish (308) yo'l va so'rov bilan.
- S3: SigV4 AWS rasmiy namunasi; haqiqiy SeaweedFS (`PLOY_TEST_WEED`) bilan yuklash/olish/o'chirish va zaxira nusxa oqimi.
- Registrlar: manzil normallashtirish va image → registr qoidasi; HTTP orqali `/auth` tekshiruvi, rollar va jamoa
  izolyatsiyasi; pull'dagi `X-Registry-Auth`; compose CLI config'ida faqat o'z jamoasining loginlari.
- PR preview: imzolangan `pull_request` webhook'lari HTTP orqali (yaratish va navbat, `synchronize`, `closed` bilan
  konteynerlarni o'chirish, fork, limit, preview yoqilmagan ilova), ro'yxatlardan chiqarish, sozlamalar validatsiyasi
  va rollar; v6 → v7 migratsiyasi ma'lumotlarni saqlaydi.

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
