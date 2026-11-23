import type { GuideContent } from './types.ts';

export const guide: GuideContent = {
  intro: 'TorexPloy — óz serverińizdegi ornalastırıw platforması: Git-ten yamasa Docker obrazınan qosımshalar, bazalar, fayl saqlaǵısh, domenler hám HTTPS, rezerv nusqalar — hámmesi bir panelde. Bul qollanba basınan aqırına shekem jol kórsetedi: neni, qayda hám qanday tártipte islew kerek.',
  quickStart: [
    {
      title: 'Serverge ornatıń',
      text: 'Bir buyrıq penen Docker, proksi hám panel ornatıladı; birinshi ret ashılǵanda administrator akkauntı jaratıladı.',
      to: '/guide/install',
    },
    {
      title: 'Git-ti jalǵań',
      text: 'Sazlawlar → Git bóliminde GitHub App bir basıwda jaratıladı: repozitoriyler, push bolǵanda avtomat ornalastırıw, PR ushın aldın ala kóriw.',
      to: '/settings/git',
    },
    {
      title: 'Joybar hám qosımsha jaratıń',
      text: 'Joybar ishinde “Jaratıw → Qosımsha”: repozitoriydi tańlań, qalǵanın TorexBuilder ózi anıqlaydı.',
      to: '/projects',
    },
    {
      title: 'Domen beriń',
      text: 'Avtomat mánzil birden isleydi; óz domenińizdiń A jazbasın serverge baǵıtlasańız, HTTPS óz-ózinen alınadı.',
      to: '/guide/domains',
    },
  ],
  chapters: [
    {
      id: 'start',
      title: 'Baslaw',
      sections: [
        {
          id: 'install',
          icon: 'download',
          title: 'Ornatıw',
          summary: '64-bit Linux server (Ubuntu 22.04+ / Debian 12+), keminde 2 GB RAM, ashıq 80 hám 443 portlar hám root kiriw huqıqı kerek.',
          blocks: [
            {
              type: 'code',
              label: 'Serverde, root retinde (bir buyrıq)',
              text: 'curl -fsSL https://raw.githubusercontent.com/To-Rex/TorexPloy/main/deploy/install.sh \\\n  | sudo TORXPLOY_SOURCE=https://github.com/To-Rex/TorexPloy.git TORXPLOY_PORT=2003 sh',
            },
            {
              type: 'table',
              head: [
                'Ózgeriwshi',
                'Mánisi',
              ],
              rows: [
                [
                  '`TORXPLOY_SOURCE`',
                  'Qaysı repozitoriyden jıynaw kerek (`https://github.com/To-Rex/TorexPloy.git`). Keyin panel jańalanıwlar ushın usı repozitoriydi baqlap baradı.',
                ],
                [
                  '`TORXPLOY_PORT`',
                  'Domen sazlanǵanǵa shekem panel ashılatuǵın port. Standart boyınsha `3000`; mısalda `2003`; `0` — hesh qanday port ashpaw.',
                ],
                [
                  '`TORXPLOY_REF`',
                  'Jıynalatuǵın tarmaq yamasa teg (standart boyınsha `main`).',
                ],
                [
                  '`TORXPLOY_IMAGE`',
                  'Serverde jıynaw ornına tayın obraz (`ghcr.io/to-rex/torexploy:main`) — tezirek hám az resurs talap etedi.',
                ],
              ],
            },
            {
              type: 'steps',
              items: [
                {
                  title: 'Skript hámmesin tayarlaydı',
                  text: 'Docker ornatıladı (eger joq bolsa), repozitoriy klonlanıp, panel obrazı jıynaladı, `ploy-control` konteyneri hám Caddy proksi iske túsedi. Ádette 3–6 minut.',
                },
                {
                  title: 'Paneldi ashıń',
                  text: '`http://<server-ip>:2003` — `TORXPLOY_PORT` ózgeriwshisinde bergen portıńız (bermeseńiz, `3000`). Birinshi ret ashılǵanda administrator akkauntın jaratasız.',
                },
                {
                  title: 'Panel domenin beriń',
                  text: '[Sazlawlar → Veb-server](/settings/platform) bóliminde `deploy.example.uz` sıyaqlı domen kiritiń (onıń A jazbası serverge baǵıtlanǵan bolsın). Sonnan keyin panel HTTPS arqalı ashıladı. Domenińiz bolmasa, usı jerdegi **sslip.io mánzilinen paydalanıw** siltewin basıń: `<IP>.sslip.io` atı serverge óz-ózinen baǵıtlanadı, DNS sazlawdıń keregi joq. Saqlaǵannan keyin maydan astında DNS hám sertifikat jaǵdayı kórinedi. Serverde 80 hám 443 portlar ashıq bolıwı kerek; IP mánzil arqalı kiriw burınǵısınsha isley beredi.',
                },
                {
                  title: 'Qosımshalar ushın domen (mindetli emes)',
                  text: 'Wildcard domen (`*.apps.example.uz`) qossańız, hár bir jańa qosımsha avtomat túrde shıraylı mánzil aladı. Bolmasa, serverdiń IP mánzili tiykarında `sslip.io` mánzili qollanıladı.',
                },
              ],
            },
            {
              type: 'tip',
              tone: 'info',
              title: 'Basqa jol hám porttı jabıw',
              text: 'Repozitoriydi ózińiz klonlap ta ornatıwıńız múmkin: `git clone https://github.com/To-Rex/TorexPloy.git && cd TorexPloy && sudo sh deploy/install.sh`. Domen sazlanǵannan keyin ashıq porttı jabıw ushın dál sol ornatıw buyrıǵın `TORXPLOY_PORT=0` menen hám aqırında `sh -s update` dep qaytadan iske túsiriń.',
            },
          ],
        },
        {
          id: 'concepts',
          icon: 'compass',
          title: 'Tiykarǵı túsinikler',
          summary: 'Komanda → Joybar → Qosımsha / Baza / Fayl saqlaǵısh. Hámme nárse usı shınjırǵa jaylasadı.',
          blocks: [
            {
              type: 'table',
              head: [
                'Túsinik',
                'Bul ne',
                'Qayda',
              ],
              rows: [
                [
                  'Komanda',
                  'Adamlar hám olardıń rolleri; hár bir komandanıń óz joybarları bar. Qaptal paneldiń joqarısında almastırıladı.',
                  '[Sazlawlar → Komanda](/settings/team)',
                ],
                [
                  'Joybar',
                  'Bir ónimniń barlıq bólekleri: qosımshalar, bazalar, fayl saqlaǵısh hám olar ushın ortaq ózgeriwshiler. Joybar ishindegi servisler bir tarmaqta boladı hám bir-birin atı boyınsha tabadı.',
                  '[Joybarlar](/projects)',
                ],
                [
                  'Qosımsha',
                  'Git repozitoriyinen yamasa Docker obrazınan iske túsetuǵın servis: veb (portı bar) yamasa fon jumısshısı (worker).',
                  'Joybar → Jaratıw → Qosımsha',
                ],
                [
                  'Baza',
                  'PostgreSQL, MySQL, MariaDB, MongoDB, Redis, RabbitMQ, ClickHouse, MinIO — bir basıwda, rezerv nusqalar menen.',
                  'Joybar → Jaratıw → Maǵlıwmatlar bazası',
                ],
                [
                  'Fayl saqlaǵısh',
                  'S3 menen sáykes saqlaǵısh (SeaweedFS): baketler, giltler, ashıq siltewler, rezerv nusqalar ushın orın.',
                  'Joybar → Jaratıw → Fayl saqlaǵısh',
                ],
                [
                  'Ornalastırıw',
                  'Qosımshanıń bir versiyasın jıynap, iske túsiriw. Hár biri nomerlenedi (#1, #2…), logı saqlanadı, oǵan artqa qaytarıw múmkin.',
                  'Qosımsha → Ornalastırıwlar',
                ],
                [
                  'Server',
                  'Panel ornatılǵan mashina (`main`) hám SSH arqalı jalǵanǵan basqa serverler. Hár bir qosımsha hám baza qaysı serverde isleytuǵının ózińiz tańlaysız.',
                  '[Serverler](/servers)',
                ],
              ],
            },
          ],
        },
        {
          id: 'navigation',
          icon: 'layout',
          title: 'Interfeys penen tanısıw',
          summary: 'Qaptal panel, ⌘K buyrıqlar paneli, tikkeley jańalanıw, server saatı hám til/tema — bir minutta.',
          blocks: [
            {
              type: 'list',
              items: [
                '**Qaptal panel** — Tiykarǵı (Joybarlar, Ornalastırıwlar, Monitoring, Rejelestirilgen tapsırmalar, Docker, Proksi) hám Sazlawlar toparları. Tómendegi túyme menen ikonkalar qatarına jıynaladı.',
                '**Izlew (⌘K / Ctrl+K)** — qálegen bet, joybar, qosımsha yamasa bazaǵa ótiw, til hám temanı almastırıw.',
                '**Tikkeley** indikatorı — panel server menen úzliksiz baylanısta: jaǵdaylar, loglar hám metrikalar betti jańalamastan ózgeredi.',
                '**Server saatı** — joqarıdaǵı saat serverdiń waqıt zonası boyınsha júredi; onıń ústine basıp zonanı ózgertiw múmkin (administrator).',
                '**Profil menyusı** (tómengi shep) — til (10: ózbek tili latın, kirill hám jańa latın jazıwında, qaraqalpaq, rus, inglis, qırǵız, tájik, qazaq, túrkmen), tema (jaqtı, qarańǵı, sistema), shıǵıw.',
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'apps',
      title: 'Qosımshalar',
      sections: [
        {
          id: 'apps-create',
          icon: 'rocket',
          title: 'Qosımsha jaratıw',
          summary: 'Tórt derek: GitHub repozitoriyi, qálegen Git URL, tayın Docker obrazı yamasa papka/zip júklew (Netlify Drop sıyaqlı).',
          to: '/projects',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Joybardı ashıń → Jaratıw → Qosımsha',
                  text: 'Atı, túri (veb yamasa fon jumısshısı) hám server tańlanadı.',
                },
                {
                  title: 'Derekti tańlań',
                  text: '**GitHub** — jalǵanǵan GitHub App arqalı repozitoriy hám tarmaq dizimnen tańlanadı, push bolǵanda avtomat ornalastırıw qosıladı. **GitLab** hám **Bitbucket** — Sazlawlar → Git bóliminde access token menen jalǵanǵan akkaunttan dál usınday tańlanadı; panel repozitoriyge vebxuktı ózi qosadı (qosa almasa, sebebi hám qolda qosıw ushın URL hám secret kórsetiledi). **Git** — qálegen URL (ornalastırıw gilti beriledi, onı repozitoriyge ózińiz qosasız). **Docker** — `nginx:1.27` yamasa `ghcr.io/jamoa/ilova:latest` sıyaqlı obraz; jeke registr loginleri Sazlawlar → Registrler bóliminde. **Fayl júklew** — tayın sayttıń papkasın yamasa .zip arxivti taslań: panel onı ashadı, stekti anıqlap jıynaydı hám ornalastıradı; keyingi versiyalar da usı jerge taslanadı yamasa `curl` menen API arqalı jiberiledi.',
                },
                {
                  title: 'Jaratıń',
                  text: 'Birinshi ornalastırıw birden baslanadı. Qosımsha betinde onıń barısı basqıshpa-basqısh kórinedi.',
                },
              ],
            },
            {
              type: 'tip',
              tone: 'info',
              text: 'Veb qosımsha porttı tıńlaydı hám domen aladı; fon jumısshısı (worker) portsız isleydi — gezek jumısshıları, botlar, cron ushın.',
            },
          ],
        },
        {
          id: 'build',
          icon: 'hammer',
          title: 'Jıynaw usılları',
          summary: 'TorexBuilder joybardı ózi anıqlaydı; kerek bolsa, Dockerfile, Nixpacks, Railpack, Heroku/Paketo buildpack yamasa statikalıq sayt tańlanadı.',
          blocks: [
            {
              type: 'table',
              head: [
                'Usıl',
                'Qashan tańlaw kerek',
              ],
              rows: [
                [
                  'TorexBuilder (standart)',
                  'Node, Python, Go, PHP, Ruby, Java, .NET, Rust, statikalıq hám basqa joybarlardı avtomat túrde anıqlaydı, kesh hám non-root konteyner menen jıynaydı. `torexploy.json` arqalı názik sazlanadı.',
                ],
                [
                  'Dockerfile',
                  'Repozitoriyde óz Dockerfile faylıńız bolsa; jol hám `--target` basqıshın kórsetiw múmkin.',
                ],
                [
                  'Nixpacks / Railpack',
                  'Railway stilindegi avtomat jıynaw kerek bolsa.',
                ],
                [
                  'Heroku / Paketo buildpacks',
                  'Heroku yamasa Cloud Native Buildpacks penen islewge úyrengen joybarlar ushın.',
                ],
                [
                  'Statikalıq',
                  'HTML/CSS/JS yamasa SPA: build buyrıǵı hám nátiyje papkası kórsetiledi, nátiyje jeńil veb-server arqalı tarqatıladı.',
                ],
              ],
            },
            {
              type: 'p',
              text: 'Qosımsha → Ulıwma → **Jıynaw** kartasında usıl tańlanadı. Root papka, install/build buyrıqları hám sistema paketleri usı kartadaǵı **Qosımsha sazlawlar** astında; ádette olarǵa tiyiw shárt emes. Ornatılmaǵan jıynawshılar kartanıń tómenindegi siltew arqalı kórinedi. **Rejeni kóriw** túymesi jıynawdan aldın neler anıqlanǵanın hám eskertiwlerdi kórsetedi.',
            },
          ],
        },
        {
          id: 'deploy',
          icon: 'play',
          title: 'Ornalastırıw barısı',
          summary: 'Kod → Jıynaw → Iske túsiriw → Tekseriw → Trafik → Juwmaqlaw. Jańa versiya saw bolǵanǵa shekem aldıńǵı versiya islep turadı.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Kod',
                  text: 'Repozitoriy klonlanadı yamasa obraz júklep alınadı.',
                },
                {
                  title: 'Jıynaw',
                  text: 'Tańlanǵan usıl menen obraz jıynaladı; log tikkeley kórinip turadı.',
                },
                {
                  title: 'Iske túsiriw',
                  text: 'Jańa konteyner(ler) joybar tarmaǵında kóteriledi, ózgeriwshiler hám baylanıslar beriledi.',
                },
                {
                  title: 'Tekseriw',
                  text: 'Health check jolı (mısalı, `/healthz`) juwap bergenshe kútiledi; kútiw múddeti Keńeytilgen bóliminde.',
                },
                {
                  title: 'Trafik',
                  text: 'Proksi jańa konteynerge ótedi — paydalanıwshılar úzilisti sezbeydi.',
                },
                {
                  title: 'Juwmaqlaw',
                  text: 'Eski konteynerler toqtatıladı; aktiv versiya belgilenedi.',
                },
              ],
            },
            {
              type: 'tip',
              tone: 'info',
              title: 'Strategiyalar',
              text: '**Rolling** (standart) — úzilissiz almastırıw. **Recreate** — aldın eskisi toqtaydı, keyin jańası iske túsedi; bir diskti (tom) eki nusqa birge paydalana almaytuǵın qosımshalar ushın. Replikalar sanı da Keńeytilgen bóliminde.',
            },
          ],
        },
        {
          id: 'history',
          icon: 'history',
          title: 'Tariyx, artqa qaytarıw hám tazalaw',
          summary: 'Hár bir ornalastırıw nomeri, jaǵdayı, dawamlılıǵı hám logı menen saqlanadı; eski versiyaǵa bir basıwda qaytıwǵa boladı.',
          blocks: [
            {
              type: 'list',
              items: [
                '**#N** — qosımsha ishindegi tártip nomeri, tazalawdan keyin de ózgermeydi. Kartada: kim baslaǵanı, tarmaq hám kommit, sáne, **qansha dawam etkeni** (gezekte kútiw hám jıynaw waqtı bólek).',
                '**Usı versiyaǵa qaytıw** — `⋯` menyusında; obraz qayta paydalanıladı, jıynaw bolmaydı, trafik úzilissiz ótedi.',
                '**Qayta ornalastırıw** — aktiv versiyanı dál sol obraz benen qayta kóteriw.',
                '**Óshiriw** — tamamlanǵan, aktiv emes ornalastırıwdı logı hám obrazı menen birge alıp taslaydı.',
                '**Tazalaw** — eski ornalastırıwlardı bir basıwda óshiredi; **aktiv** hám **eń sońǵı** ornalastırıw hámme waqıt saqlanadı.',
                '**Obrazlardı saqlaw** sanı (Sazlawlar → Veb-server) qansha bolsa, sonsha sońǵı obraz diskte turadı; eskileri avtomat túrde óshiriledi hám olarǵa qaytıp bolmaydı («Obraz óshirilgen»).',
              ],
            },
          ],
        },
        {
          id: 'env',
          icon: 'variable',
          title: 'Ózgeriwshiler hám baylanıslar',
          summary: 'Qosımsha ózgeriwshileri, joybardıń ortaq ózgeriwshileri hám bazalarǵa jalǵanıw — parollerdi kóshirmesten.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Qosımsha → Ózgeriwshiler',
                  text: 'Kestede toltırıń yamasa **.env kórinisi**ne ótiń: ol kod redaktorı sıyaqlı isleydi (qatar nomerleri, reńler, qáte qatar birden belgilenedi). `#` belgisi menen baslanǵan túsindirmeler hám waqıtsha óshirilgen ózgeriwshiler (`# DEBUG=1`) qosımshaǵa berilmeydi, biraq ózgeriwshiler menen birge saqlanadı. `Ctrl+/` (Mac-ta `⌘/`) tańlanǵan qatarlardı túsindirmege aylandıradı yamasa keri qaytaradı. Mánisler jasırın turadı, tek kursor turǵan qatar kórinedi.',
                },
                {
                  title: 'Bazanı jalǵań',
                  text: 'Sol bólimde **Baylanıs qosıw**: baza hám prefiks (`DB_`) tańlanadı. Qosımsha `${DB_DATABASE_URL}`, `${DB_PGHOST}`, `${DB_PGPASSWORD}` sıyaqlı ózgeriwshilerdi aladı — parol ózgerse, baylanıs ta jańalanadı.',
                },
                {
                  title: 'Ortaq ózgeriwshiler',
                  text: 'Joybar betindegi **Ortaq ózgeriwshiler** barlıq qosımshalarǵa beriledi; qosımshanıń óz mánisi ústem boladı.',
                },
              ],
            },
            {
              type: 'tip',
              tone: 'work',
              title: 'Áhmiyetli',
              text: 'Ózgeriwshiler **keyingi ornalastırıwda** kúshke kiredi — bettiń joqarısında «Házir ornalastırıw» eskertpesi shıǵadı.',
            },
          ],
        },
        {
          id: 'domains',
          icon: 'globe',
          title: 'Domenler hám HTTPS',
          summary: 'Hár bir veb qosımsha avtomat mánzil aladı; óz domenińiz ushın bir A jazbası jetkilikli — sertifikat óz-ózinen alınadı hám jańalanadı.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'DNS',
                  text: 'Domen provayderinde `A` jazbasın serverdiń IP mánziline baǵıtlań (`www` kerek bolsa, onı da).',
                },
                {
                  title: 'Qosımsha → Domenler → Domen qosıw',
                  text: 'Domen, kerek bolsa jol (`/api`) hám port kiritiledi. HTTPS standart boyınsha qosılǵan. Dizimde hár bir domen bir qatar: DNS hám sertifikat jaǵdayı, HTTPS qosqıshı, qayta tekseriw hám óshiriw. Strelka tolıq maǵlıwmattı ashadı; bir nárse nadurıs bolsa, ol óz-ózinen ashıladı.',
                },
                {
                  title: 'Kútiń',
                  text: 'DNS tarqalǵannan keyin panel onı kórsetedi (DNS jaǵdayı), Caddy Let’s Encrypt sertifikatın aladı — ádette bir minut ishinde.',
                },
              ],
            },
            {
              type: 'list',
              items: [
                '**Qayta baǵıtlaw** — `www.example.uz` → `example.uz` sıyaqlı 301 redirect bir domen ushın sazlanadı.',
                '**Bazalar hám fayl saqlaǵısh** ushın da domen beriw múmkin (S3 mánzili ushın qolaylı).',
                '[Proksi](/proxy) betinde hár bir domen qaysı konteynerge baǵıtlanǵanı hám Caddy konfiguraciyası kórinedi.',
              ],
            },
          ],
        },
        {
          id: 'logs',
          icon: 'scroll',
          title: 'Loglar hám terminal',
          summary: 'Tikkeley loglar dárejeleri boyınsha reńlengen; izlew, kóshirip alıw, júklep alıw, tolıq ekran. Terminal — konteyner ishine kiriw.',
          blocks: [
            {
              type: 'list',
              items: [
                '**Qosımsha → Loglar** — konteyner logları tikkeley aǵıp turadı; `error`/`warn`/`info` dárejeleri ajıratılǵan, filtr hám «sońın baqlaw» bar. Waqıt belgileri server waqıt zonası boyınsha.',
                'Joqarı oń jaqtaǵı túymeler: **toqtatıp turıw**, **waqıttı kórsetiw**, **qatardı oraw**, **kóshirip alıw**, **júklep alıw**, **tolıq ekran**.',
                '**Ornalastırıw logı** — hár bir ornalastırıwdıń óz logı (jıynaw, iske túsiriw, tekseriw), «Logtı kóriw» arqalı.',
                '**Terminal** — Qosımsha → Ulıwma → Terminal (yamasa `⋯` menyu): konteyner ishinde `sh`/`bash`. Bazalar ushın da bar.',
              ],
            },
          ],
        },
        {
          id: 'monitoring',
          icon: 'activity',
          title: 'Monitoring',
          summary: 'Hár bir qosımsha hám baza ushın CPU, yad hám tarmaq grafikleri; serverler ushın ulıwma kórinis.',
          to: '/monitoring',
          blocks: [
            {
              type: 'list',
              items: [
                '**Qosımsha → Monitoring** — joqarıda tikkeley kórsetkishler (processor, yad, tarmaq, konteynerler) hár 15 sekundta jańalanadı; tómende sońǵı saat/kún/hápte boyınsha grafikler, hár biriniń astında ortasha hám eń joqarı mánis.',
                '[Monitoring](/monitoring) beti — serverler hám barlıq servisler bir jerde; awır qosımshalar birden kózge túsedi.',
                'Yad hám CPU sheklewleri Keńeytilgen bóliminde belgilenedi; shekten asqan konteyner qayta iske túsedi hám bul [xabarlama](/settings/notifications) retinde keledi.',
              ],
            },
          ],
        },
        {
          id: 'cron',
          icon: 'clock',
          title: 'Cron tapsırmaları',
          summary: 'Qosımsha ishinde keste boyınsha orınlanatuǵın buyrıqlar: esabatlar, tazalaw, import. Waqıt server waqıt zonası boyınsha.',
          to: '/schedules',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Qosımsha → Cron tapsırmaları → Qosıw',
                  text: 'Atı, cron ańlatpası (`0 3 * * *` — hár kúni saat 03:00 de) hám buyrıq (`node scripts/report.js`).',
                },
                {
                  title: 'Iske túsiriw',
                  text: 'Tapsırma qosımshanıń házirgi obrazında, onıń ózgeriwshileri menen bólek konteynerde orınlanadı; «Házir orınlaw» arqalı qolda da iske túsiriw múmkin.',
                },
                {
                  title: 'Nátiyje',
                  text: 'Hár bir iske túsiwdiń logı hám jaǵdayı saqlanadı; [Rejelestirilgen tapsırmalar](/schedules) betinde komandadaǵı barlıq tapsırmalar bir jerde.',
                },
              ],
            },
          ],
        },
        {
          id: 'previews',
          icon: 'git',
          title: 'PR ushın aldın ala kóriw',
          summary: 'Hár bir pull request óz mánzilinde iske túsedi, PR-ǵa siltew menen kommentariy jazıladı; PR jabılǵanda óshiriledi.',
          blocks: [
            {
              type: 'p',
              text: 'Qosımsha → **PR aldın ala kóriw** bóliminde qosıladı (GitHub, GitLab hám Bitbucket arqalı jalǵanǵan veb-qosımshalar ushın: GitLab-ta merge request, Bitbucket-ta pull request). PR ashılǵanda aldın ala kóriw qosımshası jaratılıp, ornalastırıladı, hár jańa push bolǵanda jańalanadı, PR jabılǵanda tazalanadı. Aldın ala kóriw qosımshasınıń óz ózgeriwshileri bolıwı múmkin (mısalı, test bazası).',
            },
            {
              type: 'tip',
              tone: 'info',
              text: 'GitHub App eski bolsa, onıń sazlawlarında **Pull requests: Read and write** ruqsatı hám **Pull request** hádiysesi qosılǵan bolıwı kerek.',
            },
          ],
        },
        {
          id: 'compose',
          icon: 'layers',
          title: 'Docker Compose stekleri',
          summary: 'Bir neshe servisten ibarat tayın `docker-compose.yml` faylın repozitoriyden alıp yamasa qolda kiritip iske túsiriw.',
          blocks: [
            {
              type: 'p',
              text: 'Joybar → Jaratıw → **Docker Compose**: fayl repozitoriyden (jolı kórsetilip) yamasa tikkeley tekst retinde alınadı. Platforma servislerdi joybar tarmaǵına qosadı, `TZ` beredi, veb servisine domen jalǵawǵa múmkinshilik beredi; loglar hám jaǵday hár bir servis boyınsha kórinedi.',
            },
          ],
        },
      ],
    },
    {
      id: 'data',
      title: 'Maǵlıwmatlar',
      sections: [
        {
          id: 'services',
          icon: 'database',
          title: 'Bazalar',
          summary: 'PostgreSQL, MySQL, MariaDB, MongoDB, Redis, RabbitMQ, MinIO, ClickHouse — versiyanı tańlap, bir basıwda.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Joybar → Jaratıw → Maǵlıwmatlar bazası',
                  text: 'Túri, versiyası, atı hám serveri. Kiriw maǵlıwmatları avtomat túrde jaratıladı; qáleseńiz, **«Kiriw maǵlıwmatların ózim belgileymen»** opciyasın qosıp, paydalanıwshını, baza atın, paroldi (MySQL/MariaDB ushın root parolin de) ózińiz bere alasız.',
                },
                {
                  title: 'Jalǵanıw',
                  text: 'Ulıwma bóliminde **Ishki mánzil** (`<nom>:5432` — tek joybar ishinen) hám **Kiriw maǵlıwmatları** (olardı kóriw audit jurnalına jazıladı). Qosımshaǵa jalǵaw — qosımshanıń Ózgeriwshiler bóliminen.',
                },
                {
                  title: 'Sırttan kiriw (mindetli emes)',
                  text: 'Keńeytilgen → **Sırtqı port**: serverdiń usı portı bazaǵa ashıladı; tolıq URL `Sırtqı mánzil` maydanında. Tek kerek bolǵanda hám firewall menen.',
                },
              ],
            },
            {
              type: 'tip',
              tone: 'work',
              text: 'Qosımshadan bazaǵa `localhost` arqalı emes, **ishki mánzil** (bazanıń atı) arqalı jalǵanıń — olar bir tarmaqtaǵı bólek konteynerler.',
            },
          ],
        },
        {
          id: 'torex-ai',
          icon: 'sparkles',
          title: 'TorexAi',
          summary: 'Platforma hám serverlerdi ápiwayı til menen basqaratuǵın járdemshi: tekseredi, túsindiredi hám ruqsatıńız benen orınlaydı.',
          to: '/ai',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Bir ret sazlaw',
                  text: 'Instanciya administratorı [Sazlawlar → TorexAi](/settings/ai) betinde provayder qosadı (Claude, ChatGPT, Grok, Deploy yamasa OpenAI formatındaǵı qálegen API), API giltin kiritedi, **Tekseriw** túymesin basadı hám paydalanıwshılarǵa ashıq modellerdi belgileydi.',
                },
                {
                  title: 'Jazıń',
                  text: '[TorexAi](/ai) betinde ne kerek ekenin ápiwayı sóz benen jazıń: “api qosımshasına shop.example.uz domenin jalǵa”, “sońǵı ornalastırıw nege sátsiz boldı?”, “serverde disk nege toldı?”. Fayl yamasa skrinshot biriktiriw múmkin.',
                },
                {
                  title: 'Tastıyıqlań',
                  text: 'Oqıw ámelleri birden orınlanadı hám juwapta bir qatarǵa jıynaladı. Bir nárseni ózgertetuǵın ámel kartada kórsetiledi: ne islenetuǵını hám qaysı buyrıq yamasa soraw menen. **Ruqsat beriw** yamasa **Biykarlaw** túymesin basasız.',
                },
                {
                  title: 'Kerek bolsa, artqa qaytarıń',
                  text: 'Orınlanǵan ózgeris kartasında **Artqa qaytarıw** túymesi shıǵadı: sazlaw aldıńǵı mánisine, ornalastırıw aldıńǵı versiyaǵa, fayl aldıńǵı tekstine qaytadı.',
                },
              ],
            },
            {
              type: 'list',
              items: [
                'TorexAi hámme waqıt **sizdiń rolińiz** benen isleydi: siz isley almaytuǵın nárseni ol da isley almaydı.',
                'Óshiriw, qáwipli shell buyrıqları hám repozitoriyge push **hámme waqıt** soraladı, hátte “ápiwayı ózgerislerdi soramaw” qosılǵan bolsa da.',
                'Qosımsha kodın dúzetiw: TorexAi derek kodın ashadı, ózgertedi, diff kórsetedi hám ruqsatıńız benen qayta ornalastıradı. Ózgeris git-te de saqlanıp qalıwı ushın push qılıwdı sorań.',
                'Xabarǵa **súwret hám fayl** biriktiriń: túyme arqalı, aynaǵa taslap yamasa Ctrl+V menen. Súwretlerdi model kóredi, PDF fayllardı Claude hám ChatGPT oqıydı, Word/Excel/PowerPoint fayllarınan tekst ajıratıp alınadı, ZIP quramı dizim retinde kórsetiledi. Tek fayldan ibarat xabar da bola aladı.',
                'Aldıńǵı sáwbetler shep tárepdegi **Sáwbetler** túymesi menen ashılatuǵın panelde: izlew, atın ózgertiw, bekitiw hám óshiriw usı jerde.',
                'Paroller hám tokenler modelge jasırılıp beriledi; siz olardı ámel kartasında tolıq kóresiz.',
                'Esabattı, konfiguraciyanı yamasa skriptti fayl qılıp beredi, súwret jaratadı (súwret modeli jalǵanǵan bolsa) hám metrikalardı grafik qılıp kórsetedi.',
              ],
            },
            {
              type: 'tip',
              tone: 'info',
              title: 'Kónlikpeler: qánige usılı',
              text: 'TorexAi hár bir tapsırmaǵa sáykes **kónlikpeni** ózi tabadı: serverdi tekseriw hám qorǵaw, buzıp kiriw izlerin izlew, DDoS hám parollardı boljap tabıwǵa qarsı ilajlar, Docker hám kitapxanalar qáwipsizligi, kodtı analizlew, ornalastırıw qátesi, disk, tezlik, PostgreSQL hám MySQL, rezerv nusqa, SSL, loglar, basqa serverge kóshiriw hám baqlaw. Kerekli kónlikpe ishki kitapxanadan yamasa isenimli GitHub dereklerinen óz-ózinen ornatıladı; teksti gúmanlı kónlikpe administratordıń tastıyıqlawın kútedi. Kónlikpe ruqsat soraw qaǵıydaların ózgertpeydi. Hámmesi [Sazlawlar → TorexAi → Kónlikpeler](/settings/ai/skills) betinde.',
            },
            {
              type: 'tip',
              tone: 'work',
              title: 'Serverdegi buyrıqlar',
              text: 'SSH serverde shell ushın komandada **admin** roli kerek. Ortaq lokal serverde buyrıqlardı tek instanciya administratorı orınlay aladı.',
            },
            {
              type: 'tip',
              tone: 'info',
              title: 'Maǵlıwmatlar qayaqqa ketedi',
              text: 'Sáwbet teksti hám ásbaplar nátiyjeleri siz tańlaǵan provayderge jiberiledi. Usını esapqa alıp, qaysı provayderdi jalǵawdı administrator sheshedi.',
            },
          ],
        },
        {
          id: 'cli-mcp',
          icon: 'terminal',
          title: 'CLI hám MCP',
          summary: 'Terminaldan torex buyrıǵı menen, al Claude, Cursor hám VS Code sıyaqlı AI agentlerden MCP arqalı basqarıw.',
          to: '/settings/mcp',
          blocks: [
            {
              type: 'p',
              text: '**torex** — TorexPloy-dıń terminal buyrıǵı. **MCP** — AI agentleri (Claude Code, Claude, Cursor, VS Code, Codex hám basqalar) platformanı basqarıwı ushın ashıq standart. Ekewi de sizdiń atıńızdan hám rolińiz sheńberinde isleydi.',
            },
            {
              type: 'code',
              label: 'torex ornatıw (macOS, Linux; Windows hám npm usılları CLI hám MCP betinde)',
              text: 'curl -fsSL https://<panel>/cli/install.sh | sh',
            },
            {
              type: 'steps',
              items: [
                {
                  title: 'Kiriw',
                  text: '`torex login https://<panel>`: brauzer ashıladı, terminaldaǵı kod bettegi kod penen sáykes ekenin tekserip, komanda hám ruqsat dárejesin tańlaysız.',
                },
                {
                  title: 'Papkanı baylanıstırıw',
                  text: 'Joybar papkasında `torex link`. Sonnan keyin buyrıqlarda qosımsha atın jazıw shárt emes.',
                },
                {
                  title: 'Islew',
                  text: '`torex deploy` (build logı menen), `torex up` (papkadaǵı kodtı júklep, ornalastıradı), `torex logs -f`, `torex env pull`, `torex rollback`, `torex ai "…"`.',
                },
                {
                  title: 'AI agentti jalǵaw',
                  text: '[Sazlawlar → CLI hám MCP](/settings/mcp) betinen qosımshańız ushın tayın buyrıqtı alıń, mısalı, Claude Code ushın `claude mcp add --transport http torexploy https://<panel>/mcp`. Qosımsha brauzerde TorexPloy betin ashadı: komanda hám ruqsat dárejesin tańlap, **Ruqsat beriw** túymesin basasız.',
                },
              ],
            },
            {
              type: 'list',
              items: [
                'Ruqsat dárejeleri: **tek oqıw** hesh nárseni ózgertpeydi; **ózgertiw** ornalastıradı, ózgeriwshiler hám domenlerdi ózgertedi, biraq hesh nárseni óshirmeydi; **tolıq** — rolińiz ruqsat bergen hámme nárse.',
                'Óshiriw, maǵlıwmattı joǵaltıw yamasa jasırın mánisti kórsetiw sıyaqlı qádemler anıq razılıǵıńızsız orınlanbaydı: agent aldın ne bolatuǵının aytıp, sizden soraydı.',
                'Jalǵanǵan qosımshalar hám olar orınlaǵan hár bir ámel [CLI hám MCP](/settings/mcp) betinde kórinedi; kóp ámellerdi bir túyme menen artqa qaytarasız, qosımshanı qálegen waqıtta ajıratasız.',
                'OAuth qollamaytuǵın qosımsha ushın usı bette token jaratıń yamasa qálegen MCP klientinde buyrıq retinde `torex mcp` beriń.',
                'CI ushın: `TOREX_URL` hám `TOREX_TOKEN` ortalıq ózgeriwshileri berilgende torex kiriwsiz isleydi.',
              ],
            },
            {
              type: 'tip',
              tone: 'info',
              title: 'TorexAi menen ayırmashılıǵı',
              text: 'TorexAi — panel ishindegi járdemshi, ol administrator jalǵaǵan model menen isleydi. Al MCP arqalı óz AI agentińiz (mısalı, Claude Code) dál sol ásbaplar hám kónlikpeler menen isleydi.',
            },
          ],
        },
        {
          id: 'database-console',
          icon: 'grid',
          title: 'Maǵlıwmatlar bazası konsoli',
          summary: 'PostgreSQL, MySQL hám MariaDB bazaların pgAdmin sıyaqlı bólek bette basqarıw: kesteler, SQL, ózgertiw, reje, seanslar hám roller.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Baza beti → Bazanı basqarıw',
                  text: 'Konsol bólek bette ashıladı: shep tárepte obyektler aǵashı (baza, sxemalar, kesteler, kórinisler, izbe-izlikler, funkciyalar, triggerler), oń tárepte tablar. Ashıq tablar hám soraw tekstleri usı brauzerde saqlanadı — bet jańalansa da, hámmesi orında qaladı.',
                },
                {
                  title: 'Ulıwma tabı',
                  text: 'Server versiyası, islew waqtı, kólemi hám baylanıslar; tikkeley grafikler (seanslar, sekundına tranzakciyalar yamasa sorawlar, oqılǵan hám jazılǵan qatarlar, kesh nátiyjeliligi); bazalar dizimi — jaratıw, óshiriw, ashıw; server sazlawları.',
                },
                {
                  title: 'Keste → Maǵlıwmat',
                  text: 'Server tárepinde betlerge bóliw, baǵana atamasın basıp saralaw (Shift penen bir neshe baǵana), filtrler hám erkin **WHERE** shárti. Uyashıqtı eki ret basıp ózgertiń (JSON hám uzın tekst úlken aynada, ENUM hám logikalıq mánisler dizimnen, NULL/DEFAULT bir basıwda), qatar qosıń yamasa belgilep óshiriń — ózgerisler reń menen belgilenedi hám **Saqlaw** basılǵanda bir tranzakciyada jiberiledi: birewi qáte bolsa, hesh biri qollanılmaydı.',
                },
                {
                  title: 'Keste → Dúzilis hám DDL',
                  text: 'Baǵanalar (túri, NULL, standart mánis, giltler, baylanıslar), indeksler hám olardıń kólemi, sheklewler, bul kestege baylanısqan kesteler, triggerler hám statistika. Baǵana yamasa indeks qosıw, atın ózgertiw, óshiriw, VACUUM/ANALYZE (MySQL ushın OPTIMIZE/CHECK), TRUNCATE hám DROP — hár biri aldın SQL kodın kórsetedi, siz tastıyıqlaysız.',
                },
                {
                  title: 'Soraw tabı',
                  text: 'Reńlengen SQL redaktorı keste hám baǵana atların usınıs etedi (Ctrl+Space). **Ctrl+Enter** — kursor turǵan soraw yamasa belgilengen bólim, **Ctrl+Shift+Enter** yamasa F5 — pútkil skript. Hár nátiyje bólek tabta, qáte bolsa, onıń ornı redaktorda sızıp kórsetiledi. Nátiyjeni CSV/JSON etip júklep alıw yamasa keste retinde kóshirip alıw múmkin; tariyx hám .sql fayldı ashıw/saqlaw bar.',
                },
                {
                  title: 'Reje (EXPLAIN)',
                  text: 'PostgreSQL rejesi aǵash kórinisinde: hár qádemniń bahadaǵı yamasa waqıttaǵı úlesi reń menen, kútilgen hám haqıyqıy qatarlar bir-biriniń qasında (úlken ayırma — ANALYZE kerekligin bildiredi). **EXPLAIN ANALYZE** sorawdı shınında orınlaydı.',
                },
              ],
            },
            {
              type: 'tip',
              tone: 'info',
              title: 'Tranzakciyalar',
              text: 'Hár bir soraw tabınıń óz baylanısı bar: `BEGIN` buyrıǵınan keyingi ózgerisler **Commit** yamasa **Rollback** basılǵansha basqalarǵa kórinbeydi — tabtıń ústindegi sarı panel usını eske saladı. 20 minut háreketsiz turǵan baylanıs jabıladı hám ashıq tranzakciya biykar etiledi. **Tek oqıw** qosqıshın qossańız, tabtaǵı sorawlar maǵlıwmattı ózgerte almaydı.',
            },
            {
              type: 'list',
              items: [
                '**Seanslar** tabı bazaǵa jalǵanǵan barlıq seanslardı tikkeley kórsetedi: kim, qaysı bazadan, qaysı soraw hám qansha waqıttan beri. Uzaq sorawdı **biykar etiw** yamasa seanstı **úziw** múmkin.',
                '**Roller** (MySQL ushın Paydalanıwshılar): huqıqlar, aǵzalıq, jańa rol yamasa paydalanıwshı jaratıw (parol avtomat túrde), paroldi almastırıw hám óshiriw.',
                'Kesteni CSV, JSON yamasa INSERT skripti retinde júklep alıw múmkin (házirgi filtr hám saralaw menen); CSV fayldı import qılsańız, qatarlar aldın jańa qatarlar retinde kórinedi — tekserip, saqlaysız.',
                'Konsol **islep shıǵıwshı** roli menen ashıladı (kiriw maǵlıwmatların kóriw menen birdey huqıq). Maǵlıwmattı ózgertetuǵın sorawlar, ózgertilgen qatarlar, eksport hám seanslardı úziw audit jurnalına jazıladı; soraw teksti hám mánisler jazılmaydı.',
              ],
            },
            {
              type: 'tip',
              tone: 'work',
              text: 'Konsol bazaǵa ashıq port arqalı emes, joybar tarmaǵındaǵı waqıtsha járdemshi konteyner arqalı jalǵanadı — sırtqı port ashıw shárt emes hám qashıqtaǵı (SSH) serverlerde de isleydi.',
            },
          ],
        },
        {
          id: 'backups',
          icon: 'archive',
          title: 'Rezerv nusqalar',
          summary: 'Qolda yamasa keste boyınsha; serverde, S3-te yamasa óz fayl saqlaǵıshıńızda; bir basıwda tiklew.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Baza → Rezerv nusqalar → Rezerv nusqa jaratıw',
                  text: 'PostgreSQL, MySQL, MariaDB, MongoDB hám Redis ushın. Nusqa dizimde kólemi hám waqtı menen shıǵadı; onı **júklep alıw** yamasa **tiklew** múmkin (Redis — tek júklep alıw).',
                },
                {
                  title: 'Avtomat keste',
                  text: 'Cron ańlatpası (server waqıt zonası boyınsha) hám saqlanatuǵın nusqalar sanı (1–365): eskileri óz-ózinen óshiriledi.',
                },
                {
                  title: 'Sırtqı mánzil',
                  text: '[Sazlawlar → S3 mánzilleri](/settings/storage) betinde AWS S3, Cloudflare R2, MinIO… yamasa joybardaǵı **Fayl saqlaǵısh**tı tańlań — hár bir nusqa sol jerge de jiberiledi.',
                },
              ],
            },
            {
              type: 'tip',
              tone: 'bad',
              title: 'Tiklew',
              text: 'Tiklew bazadaǵı házirgi maǵlıwmatlardı nusqadaǵı jaǵday menen almastıradı. Aldın jańa nusqa alıń.',
            },
            {
              type: 'list',
              items: [
                '**Qosımsha diskleri** — Qosımsha → Keńeytilgen → Diskler → **Rezerv nusqalar**: disktegi fayllar (júklengen fayllar, SQLite) `.tar.gz` arxivi retinde iyeleri hám ruqsatları menen birge alınadı. Keste (hár 6 saatta, hár kúni, hár hápte yamasa óz cron ańlatpańız), saqlanatuǵın nusqalar sanı hám S3 mánzili bazalardaǵıday.',
                'Faylǵa jazıp turatuǵın programma ushın **Rezerv nusqa alınǵanda qosımshanı pauzaǵa qoyıw** opciyasın qosıń: qosımsha bir neshe sekundqa muzlatıladı, sorawlar úzilmeydi, al nusqa tolıq sáykes shıǵadı.',
                'Diskti tiklewde qosımsha toqtatıladı, aldın házirgi jaǵdaydıń nusqası alınadı (“Tiklewden aldıńǵı jaǵday”), fayllar almastırıladı hám qosımsha qayta iske túsedi. Bir nárse nadurıs ketse, sol nusqadan artqa qaytıw múmkin.',
              ],
            },
          ],
        },
        {
          id: 'transfer',
          icon: 'download',
          title: 'Joybardı basqa panelge kóshiriw',
          summary: 'Joybardı qosımshaları, sazlawları, maǵlıwmatlar bazaları, faylları hám kodı menen birge bir shifrlanǵan arxivke eksport qılıp, basqa TorexPloy paneline import qılıw.',
          to: '/transfers',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Eksport',
                  text: 'Joybar betinde **⋯ → Eksport qılıw**. Neler kiretuǵının tańlań: maǵlıwmatlar bazaları (dump), fayl saqlaǵıshlar, tomlar, qosımshalar kodı hám qáleseńiz tayın obrazlar. Sazlawlar, ózgeriwshiler, domenler, cron tapsırmaları hám giltler hámme waqıt kiredi.',
                },
                {
                  title: 'Jasırın sózdi saqlań',
                  text: 'Arxiv AES-256 menen shifrlanadı. Panel kúshli jasırın sóz jaratadı (yamasa óz jasırın sózińizdi kiritesiz) hám onı eksport betinde kórsetedi. Jasırın sózsiz arxivti hesh kim asha almaydı.',
                },
                {
                  title: 'Arxivti kóshiriń',
                  text: 'Úsh jol bar: **.torexploy** fayldı júklep alıw; **kóshiriw siltewi** (basqa panel arxivti tikkeley tartıp aladı, jasırın sóz siltewdiń # belgisinen keyingi bóliminde); yamasa **S3** mánziline nusqa.',
                },
                {
                  title: 'Import',
                  text: 'Jańa panelde [Kóshiriw → Import](/transfers/import): fayldı júkleń, siltewdi qoyıń yamasa S3 ishinen tańlań. Jasırın sóz benen ashıń.',
                },
                {
                  title: 'Rejeni tastıyıqlań',
                  text: 'Serverdi, joybar atın hám hár bir qosımshanıń kod deregin tańlań. Bul paneldegi bánt domenler hám portlar aldınnan kórsetiledi. **Importtı baslaw** túymesin basıń: arxiv tekseriledi, servisler jaratılıp, olardıń maǵlıwmatları tiklenedi, tomlar toltırıladı hám qosımshalar ornalastırıladı.',
                },
              ],
            },
            {
              type: 'table',
              head: [
                'Qosımsha deregi',
                'Import qılınǵan jerde',
              ],
              rows: [
                [
                  'GitHub, sol akkaunt jalǵanǵan',
                  'Repozitoriyge avtomat túrde baylanısadı (repozitoriy atı boyınsha), push bolǵanda ornalastırıw hám aldın ala kóriw isleydi.',
                ],
                [
                  'GitHub jalǵanbaǵan',
                  'Arxivtegi kodtan (islep turǵan kommit) iske túsedi; keyin repozitoriydi jalǵaw múmkin.',
                ],
                [
                  'GitLab, Bitbucket',
                  'Usı túrdegi baylanıs bolsa, repozitoriyge baylanısadı; bolmasa, arxivtegi kodtan.',
                ],
                [
                  'Ashıq git mánzili, SSH ornalastırıw gilti',
                  'Mánzil hám ornalastırıw gilti de birge keledi.',
                ],
                [
                  'Júklengen kod (upload)',
                  'Arxivtegi zip júklengen kod retinde tiklenedi.',
                ],
                [
                  'Tayın obraz tańlansa',
                  'Qayta jıynamastan, sol obraz benen birden iske túsedi.',
                ],
              ],
            },
            {
              type: 'list',
              items: [
                'Maǵlıwmatlar bazaları **sol paydalanıwshılar hám paroller** menen jaratıladı, servis atları da saqlanadı: qosımshalardaǵı baylanıs mánzilleri ózgermeydi.',
                'Fayl saqlaǵıshlar baketleri, faylları hám **sol kiriw giltleri** menen tiklenedi.',
                'Import toqtap qalsa (mısalı, server úzilip qalsa), **Qayta urınıw** onı toqtaǵan jerinen dawam ettiredi, hesh nárse eki ret jaratılmaydı.',
                'Terminaldan: `torex export SHOP --link`, keyin basqa panelde `torex import <havola>`.',
                'Kóshiriw tek komanda **administratorları** ushın; token qollanılsa, onıń ruqsatı tolıq bolıwı kerek.',
              ],
            },
            {
              type: 'tip',
              tone: 'work',
              title: 'DNS',
              text: 'Import qılınǵannan keyin domenlerdiń DNS jazbaların jańa serverdiń IP mánziline baǵıtlań: HTTPS sertifikatları óz-ózinen shıǵarıladı.',
            },
          ],
        },
        {
          id: 'filestore',
          icon: 'hard-drive',
          title: 'Fayl saqlaǵısh (S3)',
          summary: 'Súwretler, hújjetler hám rezerv nusqalar ushın S3 menen sáykes saqlaǵısh — AWS SDK, rclone, s3cmd penen isleydi.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Joybar → Jaratıw → Fayl saqlaǵısh',
                  text: 'Bir basıwda SeaweedFS kóteriledi; Ulıwma bóliminde endpoint hám root giltler.',
                },
                {
                  title: 'Baketler hám giltler',
                  text: '**Fayllar** bóliminde baket jaratıń, fayl júkleń, ashıq siltew alıń. **Giltler** bóliminde hár bir qosımsha ushın bólek kiriw gilti (tek kerekli baketlerge ruqsat).',
                },
                {
                  title: 'Qosımshaǵa jalǵaw',
                  text: 'Ózgeriwshiler → Baylanıs qosıw: qosımsha `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `AWS_*` ózgeriwshilerin aladı. Sırtqı qosımshalar, SDK mısalları (Node, Python, PHP, Go, Java, .NET, Ruby, Django, CLI) hám waqıtsha siltewler — saqlaǵıshtıń **Hújjetler** bóliminde, dál usı saqlaǵısh ushın toltırılǵan.',
                },
                {
                  title: 'Domen',
                  text: '**Domenler** bóliminde `files.example.uz` sıyaqlı mánzil berseńiz, fayllar HTTPS arqalı tikkeley tarqatıladı.',
                },
              ],
            },
          ],
        },
        {
          id: 'templates',
          icon: 'grid',
          title: 'Úlgiler',
          summary: '130+ tayın qosımsha (n8n, WordPress, Nextcloud, Gitea, Grafana, Open WebUI…) — kerekli baza, disk hám sazlawlar menen bir basıwda.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Joybar → Jaratıw → Úlgiden',
                  text: 'Kategoriyalar yamasa izlew arqalı tańlań; kartada qaysı baza kerek ekeni hám shama menen kerekli yad kólemi kórsetilgen.',
                },
                {
                  title: 'At, server, domen',
                  text: 'Oń tárepte neler jaratılatuǵınınıń dizimi. Domen bos qalsa, avtomat mánzil beriledi.',
                },
                {
                  title: 'Birinshi kiriw',
                  text: 'Ornatılǵannan keyin qosımshanıń Ulıwma bóliminde **Birinshi kiriw** kartası shıǵadı: login/parol qayda ekeni (Ózgeriwshiler, log yamasa sazlaw beti) anıq jazılǵan.',
                },
              ],
            },
            {
              type: 'tip',
              tone: 'info',
              text: 'Úlgiden jaratılǵan qosımsha — ápiwayı qosımsha: ózgeriwshiler, domen, baza, rezerv nusqa — hámmesin ózgertiwge boladı.',
            },
          ],
        },
      ],
    },
    {
      id: 'team',
      title: 'Komanda hám qáwipsizlik',
      sections: [
        {
          id: 'roles',
          icon: 'users',
          title: 'Komanda hám roller',
          summary: 'Aǵzalardı siltew arqalı shaqırıń; hár kimge kerekli dárejedegi ruqsat beriń.',
          to: '/settings/team',
          blocks: [
            {
              type: 'table',
              head: [
                'Rol',
                'Ne isley aladı',
              ],
              rows: [
                [
                  'Baqlawshı',
                  'Hámmesin kóredi (loglar, metrikalar, tariyx), biraq ózgerte almaydı.',
                ],
                [
                  'Islep shıǵıwshı',
                  'Qosımsha hám baza jaratadı, ornalastıradı, ózgeriwshiler hám domenlerdi basqaradı, rezerv nusqa aladı.',
                ],
                [
                  'Administrator',
                  'Bulardan tısqarı: registrler, S3 mánzilleri, xabarlamalar, serverler, Docker hám Proksi, servislerdi óshiriw.',
                ],
                [
                  'Iyesi',
                  'Komanda iyesi: aǵzalar hám roller, komandanı óshiriw.',
                ],
                [
                  'Instanciya administratorı',
                  'Platforma sazlawları (domen, waqıt zonası, obrazlardı saqlaw), jańalaw. Paneldi onıń komandasındaǵı adminler hám iyeler de jańalay aladı.',
                ],
              ],
            },
            {
              type: 'p',
              text: '**Shaqırıw**: Sazlawlar → Komanda → Shaqırıw → siltewdi kóshirip alıp, jiberiń (kútilip atırǵan shaqırıwlar diziminen qayta kóshirip alıw múmkin). Bir adam bir neshe komandada bolıwı múmkin — qaptal paneldiń joqarısında almastırıladı.',
            },
          ],
        },
        {
          id: 'security',
          icon: 'shield',
          title: 'Qáwipsizlik',
          summary: 'Passkey, eki basqıshlı tastıyıqlaw, API tokenler, deploy hook, audit jurnalı.',
          to: '/settings/security',
          blocks: [
            {
              type: 'list',
              items: [
                '**Passkey** — Sazlawlar → Qáwipsizlik → **Passkey qosıw**: barmaq izi, júz yamasa qurılma PIN-kodı menen kiresiz, parol da, kod ta soralmaydı. Kiriw betinde **Passkey menen kiriw** túymesi shıǵadı, email maydanınıń usınıslarında da kórinedi. Passkey tek paneldiń HTTPS domeninde isleydi (IP mánzilde emes) hám sol domenge baylanısadı: domen ózgerse, passkey-lerdi qaytadan qosıw kerek. Parol rezerv jol retinde qaladı.',
                '**2FA** — Sazlawlar → Qáwipsizlik: autentifikator qosımshası (TOTP) hám rezerv kodlar.',
                '**Parol esten shıqsa** — panelge kirgen bolsańız (mısalı, GitHub yamasa passkey menen), Sazlawlar → Qáwipsizlik bóliminde parol maydanınıń astındaǵı **Paroldi umıttıńız ba?** siltewin basıń hám akkauntıńızǵa baylanısqan GitHub akkauntı yamasa passkey menen ózińizdi tastıyıqlań. Sonnan keyin 10 minut dawamında házirgi parol soralmaydı: jańa parol ornatıw, passkey qosıw yamasa 2FA-nı óshiriw múmkin. Panelge hesh kire almasańız, serverde `reset-password` buyrıǵı bar (README faylına qarań).',
                '**API tokenler** — [Sazlawlar → API tokenler](/settings/tokens): CI yamasa skriptler ushın; hár bir token komandaǵa baylanısqan, onıń múddetin belgilew múmkin.',
                '**Deploy hook** — Qosımsha → Ornalastırıwlar betiniń tómeninde: jasırın URL, oǵan `POST` sorawı jiberilse, ornalastırıw baslanadı (mısalı, GitLab CI arqalı). Siltewdi qálegen waqıtta jańalaw múmkin.',
                '**Audit jurnalı** — [kim, qashan, ne islegeni](/settings/audit): kiriwler, ózgerisler, parollerdi kóriw.',
                'Barlıq jasırın maǵlıwmatlar (paroller, tokenler, GitHub giltleri) serverde shifrlanǵan túrde saqlanadı (`PLOY_SECRET_KEY`).',
              ],
            },
          ],
        },
        {
          id: 'notifications',
          icon: 'bell',
          title: 'Xabarlamalar',
          summary: 'Telegram, Discord, Slack yamasa qol qoyılǵan vebxuk — sátsiz ornalastırıw, qosımshanıń qulawı, rezerv nusqa qátesi, serverdiń úziliwi haqqında.',
          to: '/settings/notifications',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Kanal qosıw',
                  text: 'Túri (Telegram bot tokeni hám chat ID; Discord/Slack vebxuk URL; óz vebxugıńız) hám xabar tili.',
                },
                {
                  title: 'Hádiyseler',
                  text: 'Qaysı hádiyseler haqqında xabar kelsin: ornalastırıw tabıslı/sátsiz, qosımsha qulaǵan (crash-loop), rezerv nusqa qátesi, server úzildi.',
                },
                {
                  title: 'Sınaw',
                  text: '«Saqlaw hám sınaw» test xabarın jiberedi; sońǵı jiberiw jaǵdayı dizimde kórinedi.',
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'platform',
      title: 'Platforma',
      sections: [
        {
          id: 'servers',
          icon: 'server',
          title: 'Serverler',
          summary: 'Panel turǵan `main` serverden tısqarı, SSH arqalı basqa serverlerdi jalǵań; qosımshalar hám bazalar olardıń qálegeninde isley aladı.',
          to: '/servers',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Serverler → Server qosıw',
                  text: 'At, `user@host`, port hám serverge kiriw usılı: SSH parol (bir ret, panel giltin ornatıw ushın qollanıladı; saqlanbaydı), óz jeke giltińiz yamasa panel giltin qolda qosıw. Platforma jalǵanadı, Docker-di tekseredi (kerek bolsa ornatadı) hám proksini kóteredi.',
                },
                {
                  title: 'Tekseriw',
                  text: 'Jaǵdayı **Tayın** bolǵannan keyin, qosımsha jaratqanda usı serverdi tańlaw múmkin. Mashqala bolsa, «Qayta tekseriw» sebebin kórsetedi.',
                },
                {
                  title: 'Sırtqı IP',
                  text: 'Avtomat túrde anıqlanadı; sırtqı portlar hám DNS tekseriwi usı IP mánzilge tiykarlanadı. Anıqlanbaǵan bolsa — «Qayta tekseriw».',
                },
              ],
            },
            {
              type: 'p',
              text: '[Docker](/docker) betinde serverdegi konteynerler, obrazlar hám diskler; [Proksi](/proxy) betinde marshrutlar hám Caddy jaǵdayı (administrator ushın).',
            },
          ],
        },
        {
          id: 'settings',
          icon: 'settings',
          title: 'Platforma sazlawları',
          summary: 'Panel domeni, qosımshalar domeni, waqıt zonası, obrazlardı saqlaw, registrler hám S3 mánzilleri.',
          to: '/settings/platform',
          blocks: [
            {
              type: 'list',
              items: [
                '**Veb-server** — panel domeni (HTTPS), qosımshalar ushın wildcard domen, Proksi jaǵdayı.',
                '**Waqıt zonası** — pútkil instanciya ushın bir IANA zonası: paneldegi sáneler, cron hám rezerv nusqa kesteleri, konteynerlerdiń `TZ` ózgeriwshisi. Joqarıdaǵı saattan da ózgertiwge boladı.',
                '**Obrazlardı saqlaw** — hár bir qosımsha ushın neshe sońǵı obraz saqlansın (artqa qaytarıw ushın).',
                '**Registrler** — Docker Hub, GHCR hám jeke registr loginleri: jeke obrazlardı júklep alıw ushın.',
                '**S3 mánzilleri** — rezerv nusqalar jiberiletuǵın sırtqı saqlaǵıshlar.',
                '**Git** — GitHub App: bir basıwda jaratıladı, vebxuk hám ruqsatlar avtomat túrde sazlanadı. GitLab (gitlab.com yamasa óz serverińiz) hám Bitbucket access token menen jalǵanadı; token shifrlanǵan túrde saqlanadı hám brauzerge qaytarılmaydı.',
              ],
            },
          ],
        },
        {
          id: 'updates',
          icon: 'refresh',
          title: 'Jańalaw',
          summary: 'Panel ózin ózi jańalaydı: jańa versiya shıqsa, qaptal panelde túyme payda boladı; qosımshalar hám bazalar toqtamaydı.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Xabar',
                  text: 'Hár 6 saatta (`PLOY_UPDATE_INTERVAL_SEC`, keminde 600) baqlanıp atırǵan tarmaq tekseriledi; jańa kommit bolsa, qaptal panelde **Jańalanıw bar** jazıwı, al Sazlawlar → Veb-server bóliminde ózgerisler dizimi shıǵadı.',
                },
                {
                  title: 'Jańalaw',
                  text: 'Instanciya administratorı yamasa onıń komandasındaǵı admin túymeni basadı (qaptal paneldegi **Jańalanıw bar** túymesi yamasa tómendegi versiya jazıwı arqalı): waqıtsha `ploy-updater` konteyneri jańa obrazdı tayarlap, paneldi dál sol portlar hám diskler menen qayta jaratadı, onıń saw ekenin tekseredi.',
                },
                {
                  title: 'Qáte bolsa',
                  text: 'Eski versiya avtomat túrde qaytarıladı hám sebebi paneldegi jaǵdayda kórinedi. Qolda jańalaw — ornatıw buyrıǵınıń `update` rejimi:',
                },
                {
                  title: 'Qolda jańalaw buyrıǵı',
                  text: '`curl -fsSL https://raw.githubusercontent.com/To-Rex/TorexPloy/main/deploy/install.sh | sudo TORXPLOY_SOURCE=https://github.com/To-Rex/TorexPloy.git sh -s update`',
                },
              ],
            },
          ],
        },
        {
          id: 'troubleshooting',
          icon: 'wrench',
          title: 'Mashqalalardı sheshiw',
          summary: 'Eń kóp ushırasatuǵın jaǵdaylar hám olardıń ápiwayı sheshimleri.',
          blocks: [
            {
              type: 'faq',
              items: [
                {
                  q: 'Ornatıwda «port 80 is already used by another container»',
                  a: 'Serverde basqa veb-server (nginx, apache, traefik) yamasa eski proksi 80-porttı bánt etken. Onı toqtatıń (`docker ps`, `sudo ss -ltnp | grep :80`) hám skriptti qayta iske túsiriń — Caddy 80/443 portların ózi basqaradı.',
                },
                {
                  q: 'Qosımsha bazaǵa jalǵana almaydı (timeout, connection refused)',
                  a: '`localhost` yamasa sırtqı IP emes, **ishki mánzil**den paydalanıń: bazanıń atı hám portı (`postgres:5432`). Eń ańsatı — qosımshanı bazaǵa **jalǵaw** hám `${DB_DATABASE_URL}` ózgeriwshisin qollanıw. Baza hám qosımsha bir joybarda bolıwı shárt.',
                },
                {
                  q: 'Jıynaw qátelik penen tamamlandı',
                  a: 'Ornalastırıw logın ashıń — qaysı basqıshta toqtaǵanı kórinedi. Kóbinese: nadurıs root papka, jetispeytuǵın start buyrıǵı, Node/Python versiyası. Ulıwma → Jıynaw kartasında usıl menen buyrıqlardı anıq belgileń yamasa Dockerfile qollanıń; **Rejeni kóriw** neler anıqlanǵanın kórsetedi.',
                },
                {
                  q: 'Domen ashılmaydı yamasa sertifikat joq',
                  a: 'Qosımsha → Domenler bóliminde DNS jaǵdayına qarań: A jazbası serverdiń IP mánziline baǵıtlanbaǵan yamasa ele tarqalmaǵan. 80 hám 443 portlar ashıq bolıwı shárt. Proksi betinde marshrut bar ekenin tekseriń.',
                },
                {
                  q: 'Aldıńǵı versiyaǵa qaytıw múmkin emes («Obraz óshirilgen»)',
                  a: 'Obrazlardı saqlaw shegarasınan tısqarı qalǵan versiyalar diskten óshiriledi. Sazlawlar → Veb-server bóliminde sandı kóbeytiń; kerekli kommitti qayta ornalastırıw da múmkin.',
                },
                {
                  q: 'Ornalastırıw «Gezekte» turıp qaldı',
                  a: 'Usı qosımshanıń basqa ornalastırıwı orınlanıp atır yamasa server bánt. Ornalastırıwlar betinde barıstı tikkeley baqlań; kerek bolsa, biykar etiń.',
                },
                {
                  q: '«Docker is not reachable»',
                  a: 'Serverde Docker toqtaǵan: `sudo systemctl status docker`, keyin `sudo systemctl start docker`. SSH serverlerde — Serverler → Qayta tekseriw.',
                },
                {
                  q: 'Sırtqı URL mánzilinde host joq, tek `:5432`',
                  a: 'Serverdiń sırtqı IP mánzili anıqlanbaǵan. Serverler → server → **Qayta tekseriw**; sonnan keyin tolıq mánzil shıǵadı. Firewall sazlawlarında porttı ashıwdı umıtpań.',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};
