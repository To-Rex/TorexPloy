import type { GuideContent } from './types.ts';

export const guide: GuideContent = {
  intro:
    "TorexPloy — oʻz serveringizdagi joylashtirish platformasi: Git’dan yoki Docker image’dan ilovalar, bazalar, fayl ombori, domenlar va HTTPS, zaxira nusxalar — hammasi bitta panelda. Bu qoʻllanma boshidan oxirigacha olib boradi: nimani, qayerda va qanday tartibda qilish kerak.",
  quickStart: [
    { title: "Serverga oʻrnating", text: "Bir buyruq bilan Docker, proksi va panel oʻrnatiladi; birinchi ochilganda administrator hisobi yaratiladi.", to: "/guide/install" },
    { title: "Git’ni ulang", text: "Sozlamalar → Git boʻlimida GitHub App bir bosishda yaratiladi: repozitoriyalar, push’da avtomatik deploy, PR preview.", to: "/settings/git" },
    { title: "Loyiha va ilova yarating", text: "Loyiha ichida “Yaratish → Ilova”: repozitoriyani tanlang, qolganini TorexBuilder oʻzi aniqlaydi.", to: "/projects" },
    { title: "Domen bering", text: "Avtomatik manzil darhol ishlaydi; oʻz domeningizning A yozuvini serverga qaratsangiz, HTTPS oʻzi olinadi.", to: "/guide/domains" },
  ],
  chapters: [
    {
      id: "start",
      title: "Boshlash",
      sections: [
        {
          id: "install",
          icon: "download",
          title: "Oʻrnatish",
          summary: "64-bit Linux server (Ubuntu 22.04+ / Debian 12+), kamida 2 GB RAM, ochiq 80 va 443 portlar va root kirish kerak.",
          blocks: [
            { type: "code", label: "Serverda", text: "git clone <repo-url> torexploy && cd torexploy\nsudo sh deploy/install.sh" },
            {
              type: "steps",
              items: [
                { title: "Skript hammasini tayyorlaydi", text: "Docker oʻrnatiladi (boʻlmasa), panel image’i yigʻiladi, `ploy-control` konteyneri va Caddy proksi ishga tushadi." },
                { title: "Panelni oching", text: "`http://<server-ip>:3000` (port `TORXPLOY_PORT=2003` kabi oʻzgartirilgan boʻlishi mumkin) — birinchi ochilganda administrator hisobini yaratasiz." },
                { title: "Panel domenini bering", text: "[Sozlamalar → Veb-server](/settings/platform) boʻlimida `deploy.example.uz` kabi domen kiriting (A yozuvi serverga qaragan boʻlsin). Shundan soʻng panel HTTPS orqali ochiladi." },
                { title: "Ilovalar uchun domen (ixtiyoriy)", text: "Wildcard domen (`*.apps.example.uz`) qoʻshsangiz, har bir yangi ilova avtomatik chiroyli manzil oladi. Boʻlmasa, server IP’si asosida `sslip.io` manzili ishlatiladi." },
              ],
            },
            { type: "tip", tone: "info", title: "Portni yopish", text: "Domen sozlangach, ochiq portni yopish mumkin: `sudo TORXPLOY_PORT=0 sh deploy/install.sh update`." },
          ],
        },
        {
          id: "concepts",
          icon: "compass",
          title: "Asosiy tushunchalar",
          summary: "Jamoa → Loyiha → Ilova / Baza / Fayl ombori. Hamma narsa shu zanjirga joylashadi.",
          blocks: [
            {
              type: "table",
              head: ["Tushuncha", "Nima bu", "Qayerda"],
              rows: [
                ["Jamoa", "Odamlar va ularning rollari; har bir jamoaning oʻz loyihalari bor. Yon panel yuqorisidan almashtiriladi.", "[Sozlamalar → Jamoa](/settings/team)"],
                ["Loyiha", "Bir mahsulotning hamma qismlari: ilovalar, bazalar, fayl ombori va ular uchun umumiy oʻzgaruvchilar. Loyiha ichidagi xizmatlar bir tarmoqda, bir-birini nomi bilan topadi.", "[Loyihalar](/projects)"],
                ["Ilova", "Git repozitoriyadan yoki Docker image’dan ishga tushadigan xizmat: veb (portga ega) yoki fon ishchisi (worker).", "Loyiha → Yaratish → Ilova"],
                ["Baza", "PostgreSQL, MySQL, MariaDB, MongoDB, Redis, RabbitMQ, ClickHouse, MinIO — bir bosishda, zaxira nusxalar bilan.", "Loyiha → Yaratish → Maʼlumotlar bazasi"],
                ["Fayl ombori", "S3 bilan mos ombor (SeaweedFS): bucket’lar, kalitlar, ochiq havolalar, zaxira nusxalar uchun manzil.", "Loyiha → Yaratish → Fayl ombori"],
                ["Joylashtirish", "Ilovaning bitta versiyasini yigʻib, ishga tushirish. Har biri raqamlanadi (#1, #2…), logi saqlanadi, orqaga qaytarish mumkin.", "Ilova → Joylashtirishlar"],
                ["Server", "Panel oʻrnatilgan mashina (`main`) va SSH orqali ulangan qoʻshimcha serverlar. Har bir ilova va baza qaysi serverda ishlashini tanlaysiz.", "[Serverlar](/servers)"],
              ],
            },
          ],
        },
        {
          id: "navigation",
          icon: "layout",
          title: "Interfeys bilan tanishuv",
          summary: "Yon panel, ⌘K buyruqlar paneli, jonli yangilanish, server soati va til/mavzu — bir daqiqada.",
          blocks: [
            {
              type: "list",
              items: [
                "**Yon panel** — Asosiy (Loyihalar, Joylashtirishlar, Monitoring, Rejalashtirilgan vazifalar, Docker, Proksi) va Sozlamalar guruhlari. Pastki tugma bilan ikonkalar qatoriga yigʻiladi.",
                "**Qidirish (⌘K / Ctrl+K)** — istalgan sahifa, loyiha, ilova yoki bazaga sakrash, tilni va mavzuni almashtirish.",
                "**Jonli** indikatori — panel server bilan doimiy aloqada: holatlar, loglar va metrikalar sahifani yangilamasdan oʻzgaradi.",
                "**Server soati** — yuqoridagi soat server vaqt mintaqasida yuradi; ustiga bosib mintaqani oʻzgartirish mumkin (administrator).",
                "**Profil menyusi** (pastki chap) — til (oʻzbek, rus, ingliz), mavzu (yorugʻ, qorongʻi, tizim), chiqish.",
              ],
            },
          ],
        },
      ],
    },
    {
      id: "apps",
      title: "Ilovalar",
      sections: [
        {
          id: "apps-create",
          icon: "rocket",
          title: "Ilova yaratish",
          summary: "Uch manba: GitHub repozitoriya, istalgan Git URL yoki tayyor Docker image.",
          to: "/projects",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Loyihani oching → Yaratish → Ilova", text: "Nomi, turi (veb yoki fon ishchisi) va server tanlanadi." },
                { title: "Manbani tanlang", text: "**GitHub** — ulangan GitHub App orqali repozitoriya va branch roʻyxatdan tanlanadi, push’da avtomatik deploy yoqiladi. **Git** — istalgan URL (deploy kaliti beriladi, uni repozitoriyaga qoʻshasiz). **Docker** — `nginx:1.27` yoki `ghcr.io/jamoa/ilova:latest` kabi image; xususiy registr loginlari Sozlamalar → Registrlar’da." },
                { title: "Yarating", text: "Birinchi joylashtirish darhol boshlanadi. Ilova sahifasida jarayon bosqichma-bosqich koʻrinadi." },
              ],
            },
            { type: "tip", tone: "info", text: "Veb ilova port tinglaydi va domen oladi; fon ishchisi (worker) portsiz ishlaydi — navbat ishchilari, botlar, cron uchun." },
          ],
        },
        {
          id: "build",
          icon: "hammer",
          title: "Yigʻish usullari",
          summary: "TorexBuilder loyihani oʻzi aniqlaydi; kerak boʻlsa Dockerfile, Nixpacks, Railpack, Heroku/Paketo buildpack yoki statik sayt tanlanadi.",
          blocks: [
            {
              type: "table",
              head: ["Usul", "Qachon tanlash"],
              rows: [
                ["TorexBuilder (standart)", "Node, Python, Go, PHP, Ruby, Java, .NET, Rust, statik va boshqa loyihalarni avtomatik aniqlaydi, kesh va non-root konteyner bilan yigʻadi. `torexploy.json` orqali nozik sozlanadi."],
                ["Dockerfile", "Repozitoriyada oʻz Dockerfile’ingiz boʻlsa; yoʻl va `--target` bosqichini koʻrsatish mumkin."],
                ["Nixpacks / Railpack", "Railway uslubidagi avtomatik yigʻish kerak boʻlsa."],
                ["Heroku / Paketo buildpacks", "Heroku yoki Cloud Native Buildpacks bilan oʻrganib qolgan loyihalar uchun."],
                ["Statik", "HTML/CSS/JS yoki SPA: build buyrugʻi va chiqish papkasi koʻrsatiladi, natija yengil veb-server bilan tarqatiladi."],
              ],
            },
            { type: "p", text: "Ilova → Umumiy → **Yigʻish** kartasida usul, root papka, install/build/start buyruqlari va tizim paketlari sozlanadi. **Rejani koʻrish** tugmasi yigʻishdan oldin nima aniqlanganini va ogohlantirishlarni koʻrsatadi." },
          ],
        },
        {
          id: "deploy",
          icon: "play",
          title: "Joylashtirish jarayoni",
          summary: "Kod → Yigʻish → Ishga tushirish → Tekshiruv → Trafik → Yakunlash. Oldingi versiya yangi versiya sogʻlom boʻlguncha ishlab turadi.",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Kod", text: "Repozitoriya klon qilinadi yoki image tortiladi." },
                { title: "Yigʻish", text: "Tanlangan usul bilan image quriladi; log jonli oqadi." },
                { title: "Ishga tushirish", text: "Yangi konteyner(lar) loyiha tarmogʻida koʻtariladi, oʻzgaruvchilar va ulanishlar beriladi." },
                { title: "Tekshiruv", text: "Health check yoʻli (masalan, `/healthz`) javob berguncha kutiladi; muddat Kengaytirilgan tabida." },
                { title: "Trafik", text: "Proksi yangi konteynerga oʻtadi — foydalanuvchilar uzilishni sezmaydi." },
                { title: "Yakunlash", text: "Eski konteynerlar toʻxtatiladi; faol versiya belgilanadi." },
              ],
            },
            { type: "tip", tone: "info", title: "Strategiyalar", text: "**Rolling** (standart) — uzilishsiz almashtirish. **Recreate** — avval eskisi toʻxtaydi, keyin yangisi chiqadi; bitta disk (volume) ni ikki nusxa birga ishlata olmaydigan ilovalar uchun. Replikalar soni ham Kengaytirilgan tabida." },
          ],
        },
        {
          id: "history",
          icon: "history",
          title: "Tarix, orqaga qaytish va tozalash",
          summary: "Har bir joylashtirish raqam, holat, davomiylik va log bilan saqlanadi; eski versiyaga bir bosishda qaytiladi.",
          blocks: [
            {
              type: "list",
              items: [
                "**#N** — ilova ichidagi tartib raqami, tozalashdan keyin ham oʻzgarmaydi. Kartada: kim boshlagan, branch va commit, sana, **qancha davom etgani** (navbatda kutish va yigʻish vaqti alohida).",
                "**Shu versiyaga qaytish** — `⋯` menyusida; image qayta ishlatiladi, yigʻish boʻlmaydi, trafik uzilishsiz oʻtadi.",
                "**Qayta joylashtirish** — faol versiyani xuddi shu image bilan qayta koʻtarish.",
                "**Oʻchirish** — tugagan, faol boʻlmagan joylashtirishni logi va image’i bilan olib tashlaydi.",
                "**Tozalash** — eski joylashtirishlarni bir bosishda oʻchiradi; **faol** va **eng oxirgi** har doim saqlanadi.",
                "**Image saqlash** soni (Sozlamalar → Platforma) qancha boʻlsa, shuncha oxirgi image diskda turadi; eskilari avtomatik oʻchiriladi va ularga qaytib boʻlmaydi («Image oʻchirilgan»).",
              ],
            },
          ],
        },
        {
          id: "env",
          icon: "variable",
          title: "Oʻzgaruvchilar va ulanishlar",
          summary: "Ilova oʻzgaruvchilari, loyihaning umumiy oʻzgaruvchilari va bazalarga ulanish — parollarni koʻchirmasdan.",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Ilova → Oʻzgaruvchilar", text: "Muharrirda `KEY=value` qatorlarini yozing yoki `.env` faylni qoʻying. Maxfiy qiymatlar yashirin saqlanadi." },
                { title: "Bazani ulang", text: "Oʻsha tabda **Ulanish qoʻshish**: baza va prefiks (`DB_`) tanlanadi. Ilova `${DB_DATABASE_URL}`, `${DB_PGHOST}`, `${DB_PGPASSWORD}` kabi oʻzgaruvchilarni oladi — parol oʻzgarsa, ulanish ham yangilanadi." },
                { title: "Umumiy oʻzgaruvchilar", text: "Loyiha sahifasidagi **Umumiy oʻzgaruvchilar** barcha ilovalarga beriladi; ilovaning oʻz qiymati ustun." },
              ],
            },
            { type: "tip", tone: "work", title: "Muhim", text: "Oʻzgaruvchilar **keyingi joylashtirishda** kuchga kiradi — sahifa yuqorisida «Hozir joylashtirish» eslatmasi chiqadi." },
          ],
        },
        {
          id: "domains",
          icon: "globe",
          title: "Domenlar va HTTPS",
          summary: "Har bir veb ilova avtomatik manzil oladi; oʻz domeningiz uchun bitta A yozuv yetarli — sertifikat oʻzi olinadi va yangilanadi.",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "DNS", text: "Domen provayderida `A` yozuvni server IP’siga qarating (`www` kerak boʻlsa, uni ham)." },
                { title: "Ilova → Domenlar → Domen qoʻshish", text: "Domen, kerak boʻlsa yoʻl (`/api`) va port kiritiladi. HTTPS standart yoqiq." },
                { title: "Kuting", text: "DNS tarqalgach panel buni koʻrsatadi (DNS holati), Caddy Let’s Encrypt sertifikatini oladi — odatda bir daqiqa ichida." },
              ],
            },
            { type: "list", items: ["**Yoʻnaltirish** — `www.example.uz` → `example.uz` kabi 301 redirect bir domen ustida sozlanadi.", "**Bazalar va fayl ombori** uchun ham domen berish mumkin (S3 manzili uchun qulay).", "[Proksi](/proxy) sahifasida har bir domen qaysi konteynerga ketayotgani va Caddy konfiguratsiyasi koʻrinadi."] },
          ],
        },
        {
          id: "logs",
          icon: "scroll",
          title: "Loglar va terminal",
          summary: "Jonli loglar darajalar bilan boʻyalgan; qidirish, nusxalash, yuklab olish, toʻliq ekran. Terminal — konteyner ichiga kirish.",
          blocks: [
            {
              type: "list",
              items: [
                "**Ilova → Loglar** — konteyner loglari jonli oqadi; `error`/`warn`/`info` darajalari ajratilgan, filtr va «oxirini kuzatish» bor. Vaqt belgilari server mintaqasida.",
                "Yuqori oʻng tugmalar: **toʻxtatib turish**, **vaqtni koʻrsatish**, **qatorni oʻrash**, **nusxalash**, **yuklab olish**, **toʻliq ekran**.",
                "**Joylashtirish logi** — har bir deploy’ning alohida logi (yigʻish, ishga tushirish, tekshiruv), «Logni koʻrish» orqali.",
                "**Terminal** — Ilova → Umumiy → Terminal (yoki `⋯` menyu): konteyner ichida `sh`/`bash`. Bazalar uchun ham bor.",
              ],
            },
          ],
        },
        {
          id: "monitoring",
          icon: "activity",
          title: "Monitoring",
          summary: "Har bir ilova va baza uchun CPU, xotira va tarmoq grafiklari; serverlar uchun umumiy koʻrinish.",
          to: "/monitoring",
          blocks: [
            { type: "list", items: ["**Ilova → Monitoring** — oxirgi soat/kun boʻyicha resurslar, qayta ishga tushishlar soni, replikalar holati.", "[Monitoring](/monitoring) sahifasi — serverlar va barcha xizmatlar bir joyda; ogʻir ilovalar darhol koʻrinadi.", "Xotira va CPU chegaralari Kengaytirilgan tabida belgilanadi; chegaradan oshgan konteyner qayta ishga tushadi va bu [bildirishnoma](/settings/notifications) sifatida keladi."] },
          ],
        },
        {
          id: "cron",
          icon: "clock",
          title: "Cron vazifalar",
          summary: "Ilova ichida jadval boʻyicha buyruqlar: hisobotlar, tozalash, import. Vaqt server mintaqasida.",
          to: "/schedules",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Ilova → Cron vazifalar → Qoʻshish", text: "Nomi, cron ifodasi (`0 3 * * *` — har kuni 03:00) va buyruq (`node scripts/report.js`)." },
                { title: "Ishga tushirish", text: "Vazifa ilovaning joriy image’ida, uning oʻzgaruvchilari bilan alohida konteynerda bajariladi; «Hozir bajarish» bilan qoʻlda ham." },
                { title: "Natija", text: "Har bir ishga tushish logi va holati saqlanadi; [Rejalashtirilgan vazifalar](/schedules) sahifasida jamoadagi hammasi bir joyda." },
              ],
            },
          ],
        },
        {
          id: "previews",
          icon: "git",
          title: "PR preview",
          summary: "Har bir pull request oʻz manzilida ishga tushadi, PR’ga havola bilan izoh yoziladi; PR yopilganda oʻchiriladi.",
          blocks: [
            { type: "p", text: "Ilova → **PR preview** tabida yoqiladi (GitHub App orqali ulangan ilovalar uchun). PR ochilganda preview ilova yaratilib joylashtiriladi, har yangi push’da yangilanadi, yopilganda tozalanadi. Preview oʻz oʻzgaruvchilariga ega boʻlishi mumkin (masalan, test bazasi)." },
            { type: "tip", tone: "info", text: "GitHub App eski boʻlsa, uning sozlamalarida **Pull requests: Read and write** ruxsati va **Pull request** hodisasi yoqilgan boʻlishi kerak." },
          ],
        },
        {
          id: "compose",
          icon: "layers",
          title: "Docker Compose steklari",
          summary: "Bir nechta servisdan iborat tayyor `docker-compose.yml` ni repozitoriyadan yoki qoʻlda kiritib ishga tushirish.",
          blocks: [
            { type: "p", text: "Loyiha → Yaratish → **Docker Compose**: fayl repozitoriyadan (yoʻl bilan) yoki toʻgʻridan-toʻgʻri matn sifatida olinadi. Platforma servislarni loyiha tarmogʻiga qoʻshadi, `TZ` beradi, veb servisga domen ulash imkonini beradi; loglar va holat har bir servis boʻyicha koʻrinadi." },
          ],
        },
      ],
    },
    {
      id: "data",
      title: "Maʼlumotlar",
      sections: [
        {
          id: "services",
          icon: "database",
          title: "Bazalar",
          summary: "PostgreSQL, MySQL, MariaDB, MongoDB, Redis, RabbitMQ, MinIO, ClickHouse — versiya tanlab, bir bosishda.",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Loyiha → Yaratish → Maʼlumotlar bazasi", text: "Tur, versiya, nom va server. Kirish maʼlumotlari avtomatik yaratiladi; xohlasangiz **«Kirish maʼlumotlarini oʻzim belgilayman»** bilan foydalanuvchi, baza nomi, parol (MySQL/MariaDB’da root paroli) ni oʻzingiz berasiz." },
                { title: "Ulanish", text: "Umumiy tabida **Ichki manzil** (`<nom>:5432` — faqat loyiha ichidan) va **Kirish maʼlumotlari** (koʻrish audit jurnaliga yoziladi). Ilovaga ulash — ilovaning Oʻzgaruvchilar tabidan." },
                { title: "Tashqi kirish (ixtiyoriy)", text: "Kengaytirilgan → **Tashqi port**: serverning shu porti bazaga ochiladi; toʻliq URL `Tashqi manzil`da. Faqat kerak boʻlganda va firewall bilan." },
              ],
            },
            { type: "tip", tone: "work", text: "Ilovadan bazaga `localhost` orqali emas, **ichki manzil** (baza nomi) orqali ulaning — ular bir tarmoqdagi alohida konteynerlar." },
          ],
        },
        {
          id: "backups",
          icon: "archive",
          title: "Zaxira nusxalar",
          summary: "Qoʻlda yoki jadval boʻyicha; serverda, S3’da yoki oʻz fayl omboringizda; bir bosishda tiklash.",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Baza → Zaxira nusxalar → Zaxira nusxa yaratish", text: "PostgreSQL, MySQL, MariaDB, MongoDB va Redis uchun. Nusxa roʻyxatda hajmi va vaqti bilan chiqadi; **yuklab olish** yoki **tiklash** mumkin (Redis — faqat yuklab olish)." },
                { title: "Avtomatik jadval", text: "Cron ifodasi (server mintaqasida) va saqlash soni (1–365): eskilari oʻzi oʻchiriladi." },
                { title: "Tashqi manzil", text: "[Sozlamalar → S3 manzillar](/settings/storage)da AWS S3, Cloudflare R2, MinIO… yoki loyihadagi **Fayl ombori**ni tanlang — har bir nusxa oʻsha yerga ham yuboriladi." },
              ],
            },
            { type: "tip", tone: "bad", title: "Tiklash", text: "Tiklash bazadagi joriy maʼlumotlarni nusxadagi holat bilan almashtiradi. Avval yangi nusxa oling." },
          ],
        },
        {
          id: "filestore",
          icon: "hard-drive",
          title: "Fayl ombori (S3)",
          summary: "Rasmlar, hujjatlar va zaxira nusxalar uchun S3 bilan mos ombor — AWS SDK, rclone, s3cmd bilan ishlaydi.",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Loyiha → Yaratish → Fayl ombori", text: "Bir bosishda SeaweedFS koʻtariladi; Umumiy tabida endpoint va root kalitlar." },
                { title: "Bucket va kalitlar", text: "**Fayllar** tabida bucket yarating, fayl yuklang, ochiq havola oling. **Kalitlar** tabida har bir ilova uchun alohida access key (faqat kerakli bucket’larga ruxsat)." },
                { title: "Ilovaga ulash", text: "Oʻzgaruvchilar → Ulanish qoʻshish: ilova `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `AWS_*` oʻzgaruvchilarini oladi." },
                { title: "Domen", text: "**Domenlar** tabida `files.example.uz` kabi manzil bersangiz, fayllar HTTPS orqali toʻgʻridan-toʻgʻri tarqatiladi." },
              ],
            },
          ],
        },
        {
          id: "templates",
          icon: "grid",
          title: "Shablonlar",
          summary: "130+ tayyor ilova (n8n, WordPress, Nextcloud, Gitea, Grafana, Open WebUI…) — kerakli baza, disk va sozlamalar bilan bir bosishda.",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Loyiha → Yaratish → Shablondan", text: "Toifalar yoki qidiruv orqali tanlang; kartada qaysi baza kerakligi va taxminiy xotira koʻrsatilgan." },
                { title: "Nom, server, domen", text: "Oʻng tomonda nimalar yaratilishi roʻyxati. Domen boʻsh qolsa, avtomatik manzil." },
                { title: "Birinchi kirish", text: "Oʻrnatilgach ilovaning Umumiy tabida **Birinchi kirish** kartasi: login/parol qayerda (Oʻzgaruvchilar, log yoki sozlash sahifasi) aniq yozilgan." },
              ],
            },
            { type: "tip", tone: "info", text: "Shablondan yaratilgan ilova oddiy ilova: oʻzgaruvchilar, domen, baza, zaxira — hammasi tahrirlanadi." },
          ],
        },
      ],
    },
    {
      id: "team",
      title: "Jamoa va xavfsizlik",
      sections: [
        {
          id: "roles",
          icon: "users",
          title: "Jamoa va rollar",
          summary: "Aʼzolarni havola bilan taklif qiling; har kimga kerakli darajadagi ruxsat bering.",
          to: "/settings/team",
          blocks: [
            {
              type: "table",
              head: ["Rol", "Nima qila oladi"],
              rows: [
                ["Kuzatuvchi", "Hammasini koʻradi (loglar, metrikalar, tarix), lekin oʻzgartira olmaydi."],
                ["Dasturchi", "Ilova va baza yaratadi, joylashtiradi, oʻzgaruvchilar va domenlarni boshqaradi, zaxira oladi."],
                ["Administrator", "Qoʻshimcha: registrlar, S3 manzillar, bildirishnomalar, serverlar, Docker va Proksi, xizmatlarni oʻchirish."],
                ["Egasi", "Jamoa egasi: aʼzolar va rollar, jamoani oʻchirish."],
                ["Instansiya administratori", "Platforma sozlamalari (domen, vaqt mintaqasi, image saqlash), yangilash."],
              ],
            },
            { type: "p", text: "**Taklif**: Sozlamalar → Jamoa → Taklif qilish → havolani nusxalab yuboring (kutilayotgan takliflar roʻyxatidan qayta nusxalash mumkin). Bir kishi bir nechta jamoada boʻlishi mumkin — yon panel yuqorisidan almashtiriladi." },
          ],
        },
        {
          id: "security",
          icon: "shield",
          title: "Xavfsizlik",
          summary: "Ikki bosqichli tasdiqlash, API tokenlar, deploy hook, audit jurnali.",
          to: "/settings/security",
          blocks: [
            {
              type: "list",
              items: [
                "**2FA** — Sozlamalar → Xavfsizlik: autentifikator ilovasi (TOTP) va zaxira kodlar.",
                "**API tokenlar** — [Sozlamalar → API tokenlar](/settings/tokens): CI yoki skriptlar uchun; har bir token jamoaga bogʻlangan, muddatini belgilash mumkin.",
                "**Deploy hook** — Ilova → Joylashtirishlar pastida: maxfiy URL, unga `POST` yuborilsa joylashtirish boshlanadi (masalan, GitLab CI’dan). Havolani istalgan vaqt yangilash mumkin.",
                "**Audit jurnali** — [kim, qachon, nima qilgani](/settings/audit): kirishlar, oʻzgarishlar, parollarni koʻrish.",
                "Barcha maxfiy maʼlumotlar (parollar, tokenlar, GitHub kalitlari) serverda shifrlangan holda saqlanadi (`PLOY_SECRET_KEY`).",
              ],
            },
          ],
        },
        {
          id: "notifications",
          icon: "bell",
          title: "Bildirishnomalar",
          summary: "Telegram, Discord, Slack yoki imzolangan webhook — xato joylashtirish, ilova qulashi, zaxira xatosi, server uzilishi haqida.",
          to: "/settings/notifications",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Kanal qoʻshish", text: "Tur (Telegram bot tokeni va chat ID; Discord/Slack webhook URL; oʻz webhook’ingiz) va xabar tili." },
                { title: "Hodisalar", text: "Qaysi hodisalar kelsin: joylashtirish muvaffaqiyatli/xato, ilova qulagan (crash-loop), zaxira nusxa xatosi, server uzildi." },
                { title: "Sinash", text: "«Saqlash va sinash» test xabar yuboradi; oxirgi yuborish holati roʻyxatda koʻrinadi." },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "platform",
      title: "Platforma",
      sections: [
        {
          id: "servers",
          icon: "server",
          title: "Serverlar",
          summary: "Panel turgan `main` serverdan tashqari SSH orqali boshqa serverlarni ulang; ilovalar va bazalar istalganida ishlaydi.",
          to: "/servers",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Serverlar → Server qoʻshish", text: "Nom, `user@host`, port va SSH kalit. Platforma ulanadi, Docker’ni tekshiradi (kerak boʻlsa oʻrnatadi) va proksini koʻtaradi." },
                { title: "Tekshirish", text: "Holat **Tayyor** boʻlgach, ilova yaratishda shu serverni tanlash mumkin. Muammo boʻlsa «Qayta tekshirish» sababini koʻrsatadi." },
                { title: "Ommaviy IP", text: "Avtomatik aniqlanadi; tashqi portlar va DNS tekshiruvi shu IP’ga tayanadi. Aniqlanmagan boʻlsa — «Qayta tekshirish»." },
              ],
            },
            { type: "p", text: "[Docker](/docker) sahifasida serverdagi konteynerlar, image’lar va disklar; [Proksi](/proxy)da marshrutlar va Caddy holati (administrator)." },
          ],
        },
        {
          id: "settings",
          icon: "settings",
          title: "Platforma sozlamalari",
          summary: "Panel domeni, ilovalar domeni, vaqt mintaqasi, image saqlash, registrlar va S3 manzillar.",
          to: "/settings/platform",
          blocks: [
            {
              type: "list",
              items: [
                "**Veb-server** — panel domeni (HTTPS), ilovalar uchun wildcard domen, Proksi holati.",
                "**Vaqt mintaqasi** — butun instansiya uchun bitta IANA zonasi: paneldagi sanalar, cron va zaxira jadvallari, konteynerlarning `TZ` oʻzgaruvchisi. Yuqoridagi soatdan ham oʻzgartiriladi.",
                "**Image saqlash** — har bir ilova uchun nechta oxirgi image saqlansin (orqaga qaytish uchun).",
                "**Registrlar** — Docker Hub, GHCR va xususiy registr loginlari: xususiy image’larni tortish uchun.",
                "**S3 manzillar** — zaxira nusxalar yuboriladigan tashqi omborlar.",
                "**Git** — GitHub App: bir bosishda yaratiladi, webhook va ruxsatlar avtomatik.",
              ],
            },
          ],
        },
        {
          id: "updates",
          icon: "refresh",
          title: "Yangilash",
          summary: "Panel oʻzini oʻzi yangilaydi: yangi versiya chiqsa yon panelda tugma paydo boʻladi; ilovalar va bazalar toʻxtamaydi.",
          blocks: [
            {
              type: "steps",
              items: [
                { title: "Xabar", text: "Har 6 soatda (`PLOY_UPDATE_INTERVAL_SEC`, kamida 600) kuzatilayotgan branch tekshiriladi; yangi commit boʻlsa yon panelda **Yangilanish mavjud**, Sozlamalar → Veb-server’da oʻzgarishlar roʻyxati." },
                { title: "Yangilash", text: "Instansiya administratori tugmani bosadi: vaqtinchalik `ploy-updater` konteyneri yangi image’ni tayyorlab, panelni xuddi shu portlar va disklar bilan qayta yaratadi, sogʻlomligini tekshiradi." },
                { title: "Xato boʻlsa", text: "Eski versiya avtomatik qaytariladi va sabab paneldagi holatda koʻrinadi. Qoʻlda: `git pull && sudo sh deploy/install.sh update`." },
              ],
            },
          ],
        },
        {
          id: "troubleshooting",
          icon: "wrench",
          title: "Muammolarni hal qilish",
          summary: "Eng koʻp uchraydigan vaziyatlar va ularning oddiy yechimlari.",
          blocks: [
            {
              type: "faq",
              items: [
                { q: "Oʻrnatishda «port 80 is already used by another container»", a: "Serverda boshqa veb-server (nginx, apache, traefik) yoki eski proksi 80-portni band qilgan. Uni toʻxtating (`docker ps`, `sudo ss -ltnp | grep :80`) va skriptni qayta ishga tushiring — Caddy 80/443 ni oʻzi boshqaradi." },
                { q: "Ilova bazaga ulanolmayapti (timeout, connection refused)", a: "`localhost` yoki tashqi IP emas, **ichki manzil**dan foydalaning: baza nomi va porti (`postgres:5432`). Eng osoni — ilovani bazaga **ulash** va `${DB_DATABASE_URL}` oʻzgaruvchisini ishlatish. Baza va ilova bir loyihada boʻlishi shart." },
                { q: "Yigʻish xato bilan tugadi", a: "Joylashtirish logini oching — qaysi bosqichda toʻxtagani koʻrinadi. Koʻpincha: notoʻgʻri root papka, yetishmayotgan start buyrugʻi, Node/Python versiyasi. Umumiy → Yigʻish kartasida usulni va buyruqlarni aniq belgilang yoki Dockerfile ishlating; **Rejani koʻrish** nima aniqlanganini koʻrsatadi." },
                { q: "Domen ochilmayapti yoki sertifikat yoʻq", a: "Ilova → Domenlar’da DNS holatiga qarang: A yozuv server IP’siga qaramagan yoki hali tarqalmagan. 80 va 443 portlar ochiq boʻlishi shart. Proksi sahifasida marshrut borligini tekshiring." },
                { q: "Oldingi versiyaga qaytib boʻlmayapti («Image oʻchirilgan»)", a: "Image saqlash chegarasidan tashqarida qolgan versiyalar diskdan oʻchiriladi. Sozlamalar → Platforma’da sonni oshiring; kerakli commit’ni qayta joylashtirish ham mumkin." },
                { q: "Joylashtirish «Navbatda» turibdi", a: "Shu ilovaning boshqa joylashtirishi ishlayapti yoki server band. Joylashtirishlar sahifasida jonli jarayonni koʻring; kerak boʻlsa bekor qiling." },
                { q: "«Docker is not reachable»", a: "Serverda Docker toʻxtagan: `sudo systemctl status docker`, keyin `sudo systemctl start docker`. SSH serverlarda — Serverlar → Qayta tekshirish." },
                { q: "Tashqi URL’da host yoʻq, faqat `:5432`", a: "Serverning ommaviy IP’si aniqlanmagan. Serverlar → server → **Qayta tekshirish**; shundan soʻng toʻliq manzil chiqadi. Firewall’da portni ochishni unutmang." },
              ],
            },
          ],
        },
      ],
    },
  ],
};
