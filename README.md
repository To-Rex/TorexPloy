# TorexPloy

Oʻz serveringizda ishlaydigan PaaS: GitHub repozitoriyasini ulaysiz, TorexPloy uni yigʻadi, uzilishsiz joylashtiradi va HTTPS bilan domen beradi.

- **Joylashtirish:** GitHub App (push → avtomatik deploy, commit status), istalgan Git URL (yopiq repo uchun deploy kaliti) yoki Docker image.
- **Yigʻish usullari:** TorexBuilder, repodagi Dockerfile (`--target` bosqichi bilan), Nixpacks, Railpack, Heroku yoki Paketo buildpack’lari, statik sayt. Sirlar buyruq qatoriga tushmaydi, build maqsad serverda boʻladi. Deploy’dan oldin yigʻish rejasini (stack, buyruqlar, Dockerfile, ogohlantirishlar) koʻrish mumkin.
- **TorexBuilder:** stack’ni oʻzi aniqlab, kichik va xavfsiz image yigʻadi. Node/Bun (Next.js, Nuxt, SvelteKit, Remix, Astro, Angular, NestJS, Vite va boshqa SPA’lar, monorepo’lar), Python (Django, FastAPI, Flask, Celery), Go, Rust, PHP/Laravel, Ruby/Rails, Java (Spring Boot, Quarkus), Clojure, .NET, Elixir/Phoenix, Gleam, Dart/Flutter, Swift, Crystal, Nim, Haskell, Deno, statik sayt. Versiyalar `.tool-versions`, `.nvmrc`, `go.mod` kabi fayllardan olinadi; `torexploy.json` orqali buyruqlar, versiyalar va apt paketlar beriladi; dev bogʻliqliklar runtime’ga oʻtmaydi, konteyner root’siz ishlaydi.
- **Ishlash:** uzilishsiz (rolling) yoki recreate strategiyasi, health-check, replikalar, avtomatik qayta ishga tushirish, bir bosishda rollback, self-heal.
- **Tarmoq:** Caddy orqali avtomatik HTTPS (Let’s Encrypt), DNS va sertifikat holatini real tekshirish, avtomatik domenlar.
- **Servislar:** PostgreSQL, MySQL, MariaDB, MongoDB, Redis, RabbitMQ, MinIO, ClickHouse. Ilovaga ulash, zaxira nusxa va tiklash.
- **Fayl ombori:** S3-mos obyekt ombori (SeaweedFS) bir bosishda: bucket’lar va fayl brauzeri, vaqtinchalik (presigned) havolalar, cheklangan kirish kalitlari, ochiq bucket’lar, domen orqali HTTPS bilan tashqi kirish; boshqa servislarning zaxira nusxalari shu omborga yoziladi.
- **Kuzatuv:** real vaqtdagi build va runtime loglar (qidiruv, daraja boʻyicha filtr, replika va vaqt oraligʻi tanlovi, pauza, nusxalash, yuklab olish, toʻliq ekran), CPU/RAM/disk/tarmoq metrikalari, audit jurnali.
- **Jamoa:** rollar (egasi/admin/dasturchi/kuzatuvchi), taklifnomalar, 2FA (TOTP), API tokenlar, GitHub orqali kirish.
- **Bir nechta server:** SSH orqali qoʻshiladi. Masofaviy serverga faqat Docker kerak, agent oʻrnatilmaydi.
- **PR preview:** har bir pull request alohida manzilda vaqtinchalik nusxa sifatida ochiladi (`pr-7-web-…`): yangi push’da qayta joylashtiriladi, PR yopilganda oʻchiriladi, manzil PR’ga izoh sifatida yoziladi. Ota ilovaning sozlamalari, oʻzgaruvchilari va bazalari ishlatiladi, ustidan alohida preview oʻzgaruvchilari qoʻyiladi. Fork’dan kelgan PR’lar sirlar xavfsizligi uchun joylashtirilmaydi.
- **Docker Compose:** bir nechta servisdan iborat steklar, fayl panelda yoki repozitoriyada; har bir servisga domen, log va terminal.
- **Domenlar:** yoʻl boʻyicha marshrutlash (`example.uz/api`), prefiksni olib tashlash, www → asosiy domenga yoʻnaltirish.
- **Zaxira nusxalar S3’ga:** AWS S3, Cloudflare R2, Backblaze B2, MinIO; server yoʻqolsa ham tiklash mumkin.
- **Xususiy registrlar:** GHCR, GitLab, Docker Hub yoki oʻz registringiz logini (saqlashdan oldin tekshiriladi); image ilovalar, Dockerfile’dagi `FROM` va compose’dagi image’lar shu login bilan tortiladi.
- **Jamoa boʻyicha roʻyxatlar:** barcha loyihalardagi deploy’lar (holat boʻyicha filtr) va barcha cron vazifalar bir joyda.
- **Vaqt zonasi:** instansiya uchun bitta IANA zonasi (Sozlamalar’da tanlanadi, dastlab `PLOY_TIMEZONE`dan). Paneldagi sanalar shu zonada koʻrsatiladi; platforma yaratadigan har bir konteyner — ilovalar, cron ishlari, compose servislari, bazalar, shablonlar — `TZ` oʻzgaruvchisini oladi (ilovaning yoki compose faylining oʻz `TZ`si ustun); cron vazifalar va zaxira nusxa jadvallari shu zonaning devor soati boʻyicha hisoblanadi (DST oʻtishlari Vixie cron kabi: 02:30 bahorgi boʻshliqqa tushsa, keyingi haqiqiy daqiqada ishlaydi; kuzgi takrorlanadigan soatda ikki marta ishlamaydi). Zona oʻzgarganda jadvallar darhol qayta hisoblanadi, ishlab turgan konteynerlar esa yangi `TZ`ni keyingi deploy yoki qayta yaratishda oladi.
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
curl -fsSL https://raw.githubusercontent.com/To-Rex/TorexPloy/main/deploy/install.sh \
  | sudo TORXPLOY_SOURCE=https://github.com/To-Rex/TorexPloy.git TORXPLOY_PORT=2003 sh
```

`TORXPLOY_PORT` — domen sozlanguncha panel ochiladigan port (standart `3000`, `0` — ochilmaydi); `TORXPLOY_REF` — branch (standart `main`); `TORXPLOY_IMAGE` — serverda yigʻish oʻrniga tayyor image. Repozitoriyani oʻzingiz klon qilib ham oʻrnatish mumkin:

```sh
git clone https://github.com/To-Rex/TorexPloy.git && cd TorexPloy
sudo sh deploy/install.sh
```

Skript kerak boʻlsa Docker’ni oʻrnatadi, control-plane image’ini yigʻadi va `ploy-control` konteynerini ishga tushiradi. Soʻng:

1. `http://<server-ip>:3000` manzilini oching va administrator hisobini yarating.
2. **Sozlamalar → Veb-server** boʻlimida panel domenini kiriting (masalan, `deploy.example.uz`; A yozuvi serverga yoʻnaltirilgan boʻlishi kerak). Shundan keyin panel HTTPS orqali ochiladi.
3. Ixtiyoriy: ilovalar uchun wildcard domen (`*.apps.example.uz`) qoʻshing. Har bir yangi ilova avtomatik manzil oladi.
4. **Sozlamalar → Git integratsiyasi** boʻlimida “GitHub App yaratish” tugmasini bosing. Ilova sizning nomingizdan yaratiladi, webhook avtomatik sozlanadi.
   GitHub App bu versiyadan oldin yaratilgan boʻlsa, PR preview uchun uning sozlamalarida **Pull requests: Read and write** ruxsatini va **Pull request** hodisasini yoqing, soʻng oʻrnatishda yangi ruxsatni tasdiqlang.

Domen sozlangandan keyin ochiq portni yopib qoʻyish mumkin: xuddi shu oʻrnatish buyrugʻini `TORXPLOY_PORT=0` bilan va oxirida `sh -s update` deb ishga tushiring (klon qilingan boʻlsa: `sudo TORXPLOY_PORT=0 sh deploy/install.sh update`).

### Yangilash

Panel oʻzini oʻzi yangilaydi. Kuzatilayotgan branch (`main`) oldinga ketganini har 6 soatda GitHub orqali tekshiradi; yangi commit bor boʻlsa yon panelda **Yangilanish mavjud** tugmasi chiqadi, **Sozlamalar → Veb-server** boʻlimida esa oʻzgarishlar roʻyxati va **Yangilash** tugmasi (faqat instansiya administratori uchun). Bosilganda `ploy-updater` nomli vaqtinchalik konteyner ishga tushadi: u yangi image’ni tayyorlaydi, `ploy-control`ni xuddi shu portlar, disklar va tarmoqlar bilan qayta yaratadi, `/api/health` javob berishini kutadi va eskisini oʻchiradi. Yangi versiya koʻtarilmasa, eskisi qaytariladi va xato paneldagi holatda koʻrinadi. Ilovalar, bazalar va proxy bu vaqtda toʻxtamaydi; panelning oʻzi bir necha soniya ochilmaydi.

Ikki rejim bor:

- **Manbadan (default).** `install.sh` qaysi GitHub repozitoriya va branch’dan qurgan boʻlsa (`PLOY_UPDATE_REPO`, `PLOY_UPDATE_BRANCH`), yangilovchi shu branch’ning yangi commit’ini klon qilib, image’ni serverning oʻzida yigʻadi (`torexploy:latest`).
- **Tayyor image.** Oʻrnatishda `TORXPLOY_IMAGE=ghcr.io/to-rex/torexploy:main` berilgan boʻlsa, yangilovchi shu image’ni qayta tortadi (`PLOY_UPDATE_IMAGE`). GHCR’dagi paket ochiq boʻlishi kerak (yopiq paket uchun serverda `docker login ghcr.io` qilingan boʻlishi kerak). Image har `main` push’ida GitHub Actions (`.github/workflows/image.yml`) orqali `linux/amd64` va `linux/arm64` uchun quriladi.

Qoʻlda yangilash ham ishlaydi:

```sh
git pull && sudo sh deploy/install.sh update
```

Ikkala yoʻlda ham faqat control-plane konteyneri almashtiriladi. Docker’siz ishga tushirilgan panel (ishlab chiqish) `manual` rejimda: yangilanish haqida xabar beradi, lekin oʻzi qoʻllay olmaydi.

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

## Fayl ombori

**Loyiha → Yaratish → Fayl ombori** — SeaweedFS asosidagi S3-mos obyekt ombori, bir bosishda ishga tushadi. Fayllar servisning diskida (Docker volume) saqlanadi, S3 porti (8333) faqat loyiha tarmogʻida ochiq; root kalitlar boshqa servislardagi kabi “Ulanish ma’lumotlari” boʻlimida.

- **Ilovadan ulanish.** Ilovaning “Oʻzgaruvchilar” tabida omborni ulang: `S3_ENDPOINT` (`http://<slug>:8333`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` (`us-east-1`), `S3_FORCE_PATH_STYLE=true`, `S3_BUCKET` va `AWS_ENDPOINT_URL`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` kiritiladi. Manzil har doim path-style: `endpoint/bucket/kalit`.
- **Bucket va fayllar.** Panelda bucket yaratish, papkalar, yuklash (5 GB gacha) va yuklab olish, bir nechta faylni yoki butun papkani oʻchirish. Boʻsh boʻlmagan bucket faqat “majburan” oʻchiriladi.
- **Tashqi kirish.** Ombor sahifasida domen biriktiring (`files.example.uz`, avtomatik HTTPS; yoki “Manzil yaratish”) yoki umumiy port oching. Shundan keyin vaqtinchalik havolalar (presigned URL) ishlaydi: brauzer faylni panelsiz, toʻgʻridan-toʻgʻri omborga yuklaydi yoki undan yuklab oladi.
- **Ochiq bucket.** “Ochiq” belgisi qoʻyilgan bucket’dagi fayllar kalitsiz oʻqiladi (`https://files.example.uz/site/logo.png`) — statik fayllar va rasmlar uchun. Yozish baribir kalit talab qiladi.
- **Kalitlar.** Admin har bir ilova yoki hamkor uchun alohida kalit yaratadi: faqat oʻqish yoki oʻqish+yozish, barcha bucket’lar yoki tanlanganlari. Maxfiy kalit faqat yaratilganda bir marta koʻrsatiladi; kalit bekor qilinganda darhol ishlamay qoladi.
- **Zaxira nusxalar shu omborga.** Ombor sahifasida “Zaxira manzilini yaratish”: `backups` bucket’i, faqat unga ruxsatli kalit va S3 manzil yaratiladi. Soʻng baza sozlamalarida shu manzilni tanlang — nusxalar serverdan tashqari omborga ham tushadi. Manzil oʻchirilganda kalit ham bekor qilinadi.

Mijozlar (kalitlarni panelning “Kalitlar” boʻlimidan oling):

```sh
# AWS CLI
AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_REGION=us-east-1 aws --endpoint-url https://files.example.uz s3 cp rasm.png s3://photos/avatars/rasm.png
# rclone
rclone config create ombor s3 provider=Other endpoint=https://files.example.uz access_key_id=… secret_access_key=… force_path_style=true
rclone sync ./public ombor:site
```

```python
import os, boto3  # kalitlar AWS_* oʻzgaruvchilardan olinadi
s3 = boto3.client("s3", endpoint_url=os.environ["S3_ENDPOINT"], region_name="us-east-1")
s3.upload_file("rasm.png", "photos", "avatars/rasm.png")
url = s3.generate_presigned_url("get_object", Params={"Bucket": "photos", "Key": "avatars/rasm.png"}, ExpiresIn=3600)
```

```js
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
await s3.send(new PutObjectCommand({ Bucket: 'photos', Key: 'avatars/rasm.png', Body: data, ContentType: 'image/png' }));
```

Laravel: `config/filesystems.php` dagi `s3` diski uchun `AWS_ENDPOINT=${S3_ENDPOINT}`, `AWS_USE_PATH_STYLE_ENDPOINT=true`, `AWS_BUCKET=photos`, `AWS_DEFAULT_REGION=us-east-1` — kalitlar bogʻlanganda `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` sifatida oʻzi keladi. Ilova ichidan presigned havola yaratish uchun `S3_ENDPOINT` oʻrniga omborning umumiy manzilini (`https://files.example.uz`) bering — ichki manzil brauzerdan ochilmaydi.

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
| `PLOY_TIMEZONE` | `Asia/Tashkent` | Instansiya vaqt zonasining boshlangʻich qiymati (birinchi ishga tushishda bazaga yoziladi); keyin Sozlamalar’da oʻzgartiriladi |
| `PLOY_UPDATE_CHECK` | `true` | Yangilanishlarni GitHub orqali tekshirish |
| `PLOY_UPDATE_REPO` | `To-Rex/TorexPloy` | Kuzatiladigan GitHub repozitoriya (`owner/name`) |
| `PLOY_UPDATE_BRANCH` | `main` | Kuzatiladigan branch |
| `PLOY_UPDATE_IMAGE` | — | Tayyor image; berilsa yangilanish manbadan emas, shu image’dan olinadi |
| `PLOY_UPDATE_INTERVAL_SEC` | `21600` | Tekshirish oraligʻi (kamida 600) |
| `PLOY_CONTAINER` | `ploy-control` | Panel konteynerining nomi (yangilovchi uni shu nom bilan topadi) |
| `PLOY_COMMIT`, `PLOY_BUILT_AT` | image’dan | Build identifikatori (`Dockerfile` `ARG`lari); qoʻlda berilmaydi. Ishlab chiqishda commit checkout’ning `.git/HEAD`idan olinadi |
