# TorexPloy

Oʻz serveringizda ishlaydigan PaaS: GitHub repozitoriyasini ulaysiz, TorexPloy uni yigʻadi, uzilishsiz joylashtiradi va HTTPS bilan domen beradi.

- **Joylashtirish:** GitHub App (push → avtomatik deploy, commit status), istalgan Git URL (yopiq repo uchun deploy kaliti) yoki Docker image.
- **Yigʻish:** Dockerfile yoki stack’ni avtomatik aniqlash (Node/Bun, Next.js, Vite SPA, Python, Go, Rust, PHP, Ruby, Deno, Java, statik sayt). BuildKit kesh, parallel build’lar.
- **Ishlash:** uzilishsiz (rolling) yoki recreate strategiyasi, health-check, replikalar, avtomatik qayta ishga tushirish, bir bosishda rollback, self-heal.
- **Tarmoq:** Caddy orqali avtomatik HTTPS (Let’s Encrypt), DNS va sertifikat holatini real tekshirish, avtomatik domenlar.
- **Servislar:** PostgreSQL, MySQL, MariaDB, MongoDB, Redis, RabbitMQ, MinIO, ClickHouse. Ilovaga ulash, zaxira nusxa va tiklash.
- **Kuzatuv:** real vaqtdagi build va runtime loglar, CPU/RAM/disk/tarmoq metrikalari, audit jurnali.
- **Jamoa:** rollar (egasi/admin/dasturchi/kuzatuvchi), taklifnomalar, 2FA (TOTP), API tokenlar, GitHub orqali kirish.
- **Bir nechta server:** SSH orqali qoʻshiladi. Masofaviy serverga faqat Docker kerak, agent oʻrnatilmaydi.
- **PR preview:** har bir pull request alohida manzilda vaqtinchalik nusxa sifatida ochiladi (`pr-7-web-…`): yangi push’da qayta joylashtiriladi, PR yopilganda oʻchiriladi, manzil PR’ga izoh sifatida yoziladi. Ota ilovaning sozlamalari, oʻzgaruvchilari va bazalari ishlatiladi, ustidan alohida preview oʻzgaruvchilari qoʻyiladi. Fork’dan kelgan PR’lar sirlar xavfsizligi uchun joylashtirilmaydi.
- **Docker Compose:** bir nechta servisdan iborat steklar, fayl panelda yoki repozitoriyada; har bir servisga domen, log va terminal.
- **Domenlar:** yoʻl boʻyicha marshrutlash (`example.uz/api`), prefiksni olib tashlash, www → asosiy domenga yoʻnaltirish.
- **Zaxira nusxalar S3’ga:** AWS S3, Cloudflare R2, Backblaze B2, MinIO; server yoʻqolsa ham tiklash mumkin.
- **Xususiy registrlar:** GHCR, GitLab, Docker Hub yoki oʻz registringiz logini (saqlashdan oldin tekshiriladi); image ilovalar, Dockerfile’dagi `FROM` va compose’dagi image’lar shu login bilan tortiladi.
- **Jamoa boʻyicha roʻyxatlar:** barcha loyihalardagi deploy’lar (holat boʻyicha filtr) va barcha cron vazifalar bir joyda.
- **Serverdagi konteynerlar:** barcha konteynerlar roʻyxati (egasi bilan), loglar, qayta ishga tushirish.
- **Shablonlar:** n8n, Uptime Kuma, Grafana, Umami, Metabase, Vaultwarden, Gitea, WordPress, Ghost, Directus, NocoDB, Docmost va boshqalar bir bosishda: kerakli baza, disk va parollar avtomatik yaratiladi.
- **Veb-terminal:** ilova yoki baza konteyneriga brauzerdan kirish (replika va shell tanlash, audit).
- **Bildirishnomalar:** Telegram, Discord, Slack va imzolangan webhook: xato joylashtirish, crash-loop, zaxira nusxa xatosi, server uzilishi.
- **Proksi:** har bir domen qaysi konteynerga yoʻnaltirilgani, Caddy konfiguratsiyasini koʻrish va uni qayta yuklash.
- **Interfeys:** Dokploy uslubida.
  - Guruhlangan yon panelni ikonkalar qatoriga yigʻish mumkin.
  - Loyiha sahifasida barcha xizmatlar bitta panjarada, ularni belgilab birdaniga boshqarish mumkin.
  - Ilova sahifasi tablarga boʻlingan: Umumiy, Oʻzgaruvchilar, Domenlar, PR preview, Joylashtirishlar, Loglar, Monitoring, Cron vazifalar, Kengaytirilgan.
  - Tillar: oʻzbek (asosiy), rus va ingliz. Temalar: yorugʻ, qorongʻi va tizim. ⌘K buyruqlar paneli bor.

Arxitektura va dizayn qarorlari: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Oʻrnatish

Talablar: 64-bit Linux server (Ubuntu 22.04+ yoki Debian 12+ tavsiya etiladi), kamida 2 GB RAM, ochiq 80 va 443 portlar, root kirish.

```sh
git clone <repo-url> torexploy && cd torexploy
sudo sh deploy/install.sh
```

Skript kerak boʻlsa Docker’ni oʻrnatadi, control-plane image’ini yigʻadi va `ploy-control` konteynerini ishga tushiradi. Soʻng:

1. `http://<server-ip>:3000` manzilini oching va administrator hisobini yarating.
2. **Sozlamalar → Platforma** boʻlimida panel domenini kiriting (masalan, `deploy.example.uz`; A yozuvi serverga yoʻnaltirilgan boʻlishi kerak). Shundan keyin panel HTTPS orqali ochiladi.
3. Ixtiyoriy: ilovalar uchun wildcard domen (`*.apps.example.uz`) qoʻshing. Har bir yangi ilova avtomatik manzil oladi.
4. **Sozlamalar → Git integratsiyasi** boʻlimida “GitHub App yaratish” tugmasini bosing. Ilova sizning nomingizdan yaratiladi, webhook avtomatik sozlanadi.
   GitHub App bu versiyadan oldin yaratilgan boʻlsa, PR preview uchun uning sozlamalarida **Pull requests: Read and write** ruxsatini va **Pull request** hodisasini yoqing, soʻng oʻrnatishda yangi ruxsatni tasdiqlang.

Domen sozlangandan keyin 3000-portni yopib qoʻyish mumkin: `sudo TORXPLOY_PORT=0 sh deploy/install.sh update`.

### Yangilash

```sh
git pull && sudo sh deploy/install.sh update
```

Faqat control-plane konteyneri almashtiriladi. Ilovalar, bazalar va proxy toʻxtamaydi.

### Zaxira nusxa

Barcha holat `/var/lib/torexploy` katalogida saqlanadi: SQLite bazasi, `secret.key` (shifrlash kaliti), loglar va DB zaxira nusxalari. Ishlab turgan tizimdan izchil nusxa olish:

```sh
docker exec ploy-control node packages/server/src/cli.ts backup /var/lib/torexploy/torexploy-backup.db
```

`secret.key` faylisiz saqlangan sirlar (env oʻzgaruvchilar, SSH kalitlar, parollar) ochilmaydi. Uni baza bilan birga saqlang.

### Tiklash buyruqlari

```sh
docker exec ploy-control node packages/server/src/cli.ts reset-password admin@example.uz
docker exec ploy-control node packages/server/src/cli.ts disable-2fa admin@example.uz
docker exec ploy-control node packages/server/src/cli.ts info
```

## Qoʻshimcha server ulash

**Serverlar → Server qoʻshish** boʻlimida IP manzil va SSH foydalanuvchini kiriting. TorexPloy shu server uchun alohida ed25519 kalit yaratadi va uni `authorized_keys` ga qoʻshish buyrugʻini koʻrsatadi. “Ulanishni tekshirish” bosilganda:

- host kaliti saqlanadi (keyingi ulanishlarda qatʼiy tekshiriladi);
- Docker tekshiriladi (yoʻq boʻlsa, bir bosishda oʻrnatish mumkin);
- serverda platforma tarmogʻi va Caddy proxy ishga tushiriladi.

## Xavfsizlik

- Parollar scrypt bilan, sessiya tokenlari faqat SHA-256 koʻrinishida saqlanadi. Cookie’lar `httpOnly`, `SameSite=Lax`, HTTPS’da `Secure`.
- Barcha sirlar AES-256-GCM bilan shifrlanadi, har bir maqsad uchun alohida kalit hosil qilinadi (HKDF).
- Har bir loyiha alohida Docker tarmogʻida ishlaydi. Ilova konteynerlari `no-new-privileges`, cheklangan capability’lar va PID/CPU/RAM chegaralari bilan ishga tushadi.
- Build vaqtidagi sirlar BuildKit secret orqali uzatiladi va image tarixiga tushmaydi. Loglarda maxfiy qiymatlar yashiriladi.
- Registr loginlari shifrlangan holda saqlanadi va API’da qaytarilmaydi. Build va compose uchun ular har bir deploy’ning alohida CLI config’iga (0600) yoziladi va ish tugashi bilan oʻchiriladi: bir jamoa logini boshqa jamoaga koʻrinmaydi.
- Caddy admin API faqat proxy konteynerining ichki loopback’ida ochiq, ilovalar uni koʻra olmaydi.

`ploy-control` konteyneri Docker soketiga ega, ya’ni server ustidan root darajasidagi huquqqa ega. Panelga kirishni 2FA va kuchli parollar bilan himoyalang.

## Ishlab chiqish

Node.js 26 kerak (sinovdan shu versiyada oʻtgan; server TypeScript’ni build’siz, toʻgʻridan-toʻgʻri ishga tushiradi).

```sh
npm install
npm run dev        # API: http://localhost:3000
npm run dev:web    # panel: http://localhost:5173 (API’ga proxy qiladi)
npm run verify     # typecheck + testlar + panel build
```

Deploy funksiyalari uchun lokal Docker kerak (Docker Desktop, OrbStack yoki Colima). Soket va `buildx`/`compose` plaginlari avtomatik topiladi; Mac'da ilovalar `http://<ilova>-<kod>.localhost` manzilida ochiladi. Caddy bilan integratsiya testi `PLOY_TEST_CADDY=/path/to/caddy`, S3 testlari esa `PLOY_TEST_WEED=/path/to/weed` (SeaweedFS) boʻlganda ishlaydi.

| Oʻzgaruvchi | Default | Maʼnosi |
|---|---|---|
| `PLOY_DATA_DIR` | `/var/lib/torexploy` (prod), `./data` (dev) | Holat katalogi |
| `PLOY_PORT` | `3000` | HTTP port |
| `PLOY_PUBLIC_URL` | — | Panelning tashqi manzili (domen sozlamasidan ustun) |
| `PLOY_SECRET_KEY` | `data/secret.key` | Shifrlash kaliti (kamida 32 belgi) |
| `PLOY_DOCKER_SOCKET` | avtomatik | Lokal Docker soketi. Berilmasa: `DOCKER_HOST`, docker CLI'ning joriy konteksti, `/var/run/docker.sock`, Docker Desktop, OrbStack, Colima, Rancher Desktop |
| `PLOY_BUILD_TIMEOUT_MINUTES` | `30` | Bitta build uchun vaqt chegarasi |
| `PLOY_DRAIN_SECONDS` | `10` | Eski versiya trafikni yakunlashi uchun vaqt |
| `PLOY_PROXY_IMAGE` | `caddy:2.11-alpine` | Proxy image’i |
| `PLOY_LOG_LEVEL` | `info` (prod), `debug` (dev) | Log darajasi |
| `PLOY_TIMEZONE` | `Asia/Tashkent` | Shablon ilovalarga beriladigan vaqt zonasi |
