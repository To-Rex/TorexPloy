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
- **Interfeys:** oʻzbek (asosiy), rus va ingliz tillari; yorugʻ, qorongʻi va tizim temasi; ⌘K buyruqlar paneli.

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

Deploy funksiyalari uchun lokal Docker kerak (Docker Desktop, OrbStack yoki Colima). Caddy bilan integratsiya testi `PLOY_TEST_CADDY=/path/to/caddy` boʻlganda ishlaydi.

| Oʻzgaruvchi | Default | Maʼnosi |
|---|---|---|
| `PLOY_DATA_DIR` | `/var/lib/torexploy` (prod), `./data` (dev) | Holat katalogi |
| `PLOY_PORT` | `3000` | HTTP port |
| `PLOY_PUBLIC_URL` | — | Panelning tashqi manzili (domen sozlamasidan ustun) |
| `PLOY_SECRET_KEY` | `data/secret.key` | Shifrlash kaliti (kamida 32 belgi) |
| `PLOY_DOCKER_SOCKET` | `/var/run/docker.sock` | Lokal Docker soketi |
| `PLOY_BUILD_TIMEOUT_MINUTES` | `30` | Bitta build uchun vaqt chegarasi |
| `PLOY_DRAIN_SECONDS` | `10` | Eski versiya trafikni yakunlashi uchun vaqt |
| `PLOY_PROXY_IMAGE` | `caddy:2.11-alpine` | Proxy image’i |
| `PLOY_LOG_LEVEL` | `info` (prod), `debug` (dev) | Log darajasi |
