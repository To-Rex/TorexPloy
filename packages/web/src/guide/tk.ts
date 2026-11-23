import type { GuideContent } from './types.ts';

export const guide: GuideContent = {
  intro: 'TorexPloy — öz serweriňizdäki ýerleşdiriş platformasy: Git-den ýa-da Docker obrazyndan programmalar, maglumatlar bazalary, faýl ammary, domenler we HTTPS, ätiýaçlyk nusgalary — hemmesi bir panelde. Bu gollanma sizi başdan ahyryna çenli alyp barýar: näme, nirede we haýsy tertipde etmeli.',
  quickStart: [
    {
      title: 'Serwere ornaşdyryň',
      text: 'Bir buýruk bilen Docker, proksi we panel ornaşdyrylýar; ilkinji gezek açylanda administrator hasaby döredilýär.',
      to: '/guide/install',
    },
    {
      title: 'Git-i birikdiriň',
      text: 'Sazlamalar → Git bölüminde GitHub App bir basyşda döredilýär: repozitoriýler, push edilende awtomatik ýerleşdiriş, PR üçin deslapky görnüş.',
      to: '/settings/git',
    },
    {
      title: 'Taslama we programma dörediň',
      text: 'Taslamanyň içinde “Döret → Programma”: repozitoriýi saýlaň, galanyny TorexBuilder özi kesgitleýär.',
      to: '/projects',
    },
    {
      title: 'Domen beriň',
      text: 'Awtomatik salgy derrew işleýär; öz domeniňiziň A ýazgysyny serwere gönükdirseňiz, HTTPS öz-özünden alynýar.',
      to: '/guide/domains',
    },
  ],
  chapters: [
    {
      id: 'start',
      title: 'Işe başlamak',
      sections: [
        {
          id: 'install',
          icon: 'download',
          title: 'Ornaşdyrmak',
          summary: '64 bitli Linux serweri (Ubuntu 22.04+ / Debian 12+), azyndan 2 GB RAM, açyk 80 we 443 portlar hem-de root girişi gerek.',
          blocks: [
            {
              type: 'code',
              label: 'Serwerde, root hökmünde (bir buýruk)',
              text: 'curl -fsSL https://raw.githubusercontent.com/To-Rex/TorexPloy/main/deploy/install.sh \\\n  | sudo TORXPLOY_SOURCE=https://github.com/To-Rex/TorexPloy.git TORXPLOY_PORT=2003 sh',
            },
            {
              type: 'table',
              head: [
                'Üýtgeýän',
                'Manysy',
              ],
              rows: [
                [
                  '`TORXPLOY_SOURCE`',
                  'Haýsy repozitoriýden gurnamaly (`https://github.com/To-Rex/TorexPloy.git`). Soňra panel täzelenmeler üçin şu repozitoriýi yzarlaýar.',
                ],
                [
                  '`TORXPLOY_PORT`',
                  'Domen sazlanýança paneliň açylýan porty. Adaty `3000`; mysalda `2003`; `0` — porty asla açmazlyk.',
                ],
                [
                  '`TORXPLOY_REF`',
                  'Gurnaljak şaha ýa-da teg (adaty `main`).',
                ],
                [
                  '`TORXPLOY_IMAGE`',
                  'Serwerde gurnamagyň ýerine taýýar obraz (`ghcr.io/to-rex/torexploy:main`) — has çalt, az resurs talap edýär.',
                ],
              ],
            },
            {
              type: 'steps',
              items: [
                {
                  title: 'Skript hemme zady taýýarlaýar',
                  text: 'Docker ornaşdyrylýar (ýok bolsa), repozitoriý klonlanyp, paneliň obrazy gurnalýar, `ploy-control` konteýneri we Caddy proksisi işe girizilýär. Adatça 3–6 minut.',
                },
                {
                  title: 'Paneli açyň',
                  text: '`http://<server-ip>:2003` — `TORXPLOY_PORT` arkaly beren portuňyz (bermedik bolsaňyz, `3000`). Ilkinji gezek açanyňyzda administrator hasabyny döredýärsiňiz.',
                },
                {
                  title: 'Panele domen beriň',
                  text: '[Sazlamalar → Web-serwer](/settings/platform) bölüminde `deploy.example.uz` ýaly domen giriziň (onuň A ýazgysy serwere gönükdirilen bolmaly). Şondan soň panel HTTPS arkaly açylýar. Domeniňiz ýok bolsa, şol ýerdäki **sslip.io salgysyny ulanmak** salgylanmasyna basyň: `<IP>.sslip.io` ady serwere öz-özünden gönükdirilýär, DNS sazlamak gerek däl. Ýatda saklanyňyzdan soň meýdançanyň aşagynda DNS we sertifikat ýagdaýy görünýär. Serwerde 80 we 443 portlar açyk bolmaly; IP salgysy arkaly giriş hem öňküsi ýaly işleýär.',
                },
                {
                  title: 'Programmalar üçin domen (hökmany däl)',
                  text: 'Wildcard domen (`*.apps.example.uz`) goşsaňyz, her täze programma awtomatik owadan salgy alýar. Bolmasa, serweriň IP salgysyna esaslanýan `sslip.io` salgysy ulanylýar.',
                },
              ],
            },
            {
              type: 'tip',
              tone: 'info',
              title: 'Başga ýol we porty ýapmak',
              text: 'Repozitoriýi özüňiz klonlap hem ornaşdyryp bilersiňiz: `git clone https://github.com/To-Rex/TorexPloy.git && cd TorexPloy && sudo sh deploy/install.sh`. Domen sazlanandan soň açyk porty ýapmak üçin edil şol ornaşdyryş buýrugyny `TORXPLOY_PORT=0` bilen we ahyrynda `sh -s update` goşup täzeden işlediň.',
            },
          ],
        },
        {
          id: 'concepts',
          icon: 'compass',
          title: 'Esasy düşünjeler',
          summary: 'Topar → Taslama → Programma / Maglumatlar bazasy / Faýl ammary. Hemme zat şu zynjyra ýerleşýär.',
          blocks: [
            {
              type: 'table',
              head: [
                'Düşünje',
                'Bu näme',
                'Nirede',
              ],
              rows: [
                [
                  'Topar',
                  'Adamlar we olaryň rollary; her toparyň öz taslamalary bar. Gapdal paneliň ýokarsyndan çalşylýar.',
                  '[Sazlamalar → Topar](/settings/team)',
                ],
                [
                  'Taslama',
                  'Bir önümiň ähli bölekleri: programmalar, maglumatlar bazalary, faýl ammary we olar üçin umumy üýtgeýänler. Taslamanyň içindäki serwisler bir torda bolup, biri-birini ady boýunça tapýar.',
                  '[Taslamalar](/projects)',
                ],
                [
                  'Programma',
                  'Git repozitoriýden ýa-da Docker obrazyndan işe girizilýän serwis: web (porty bar) ýa-da fon işçisi (worker).',
                  'Taslama → Döret → Programma',
                ],
                [
                  'Maglumatlar bazasy',
                  'PostgreSQL, MySQL, MariaDB, MongoDB, Redis, RabbitMQ, ClickHouse, MinIO — bir basyşda, ätiýaçlyk nusgalary bilen.',
                  'Taslama → Döret → Maglumatlar bazasy',
                ],
                [
                  'Faýl ammary',
                  'S3 bilen gabat gelýän ammar (SeaweedFS): bucket-ler, açarlar, açyk salgylanmalar, ätiýaçlyk nusgalary üçin ýer.',
                  'Taslama → Döret → Faýl ammary',
                ],
                [
                  'Ýerleşdiriş',
                  'Programmanyň bir wersiýasyny gurnamak we işe girizmek. Her biri belgilenýär (#1, #2…), logy saklanýar, oňa yzyna gaýdyp bolýar.',
                  'Programma → Ýerleşdirişler',
                ],
                [
                  'Serwer',
                  'Panel ornaşdyrylan maşyn (`main`) we SSH arkaly birikdirilen goşmaça serwerler. Her programmanyň we maglumatlar bazasynyň haýsy serwerde işlejegini özüňiz saýlaýarsyňyz.',
                  '[Serwerler](/servers)',
                ],
              ],
            },
          ],
        },
        {
          id: 'navigation',
          icon: 'layout',
          title: 'Interfeýs bilen tanyşlyk',
          summary: 'Gapdal panel, ⌘K buýruklar paneli, göni täzelenmeler, serwer sagady we dil/tema — bir minutda.',
          blocks: [
            {
              type: 'list',
              items: [
                '**Gapdal panel** — Esasy (Taslamalar, Ýerleşdirişler, Monitoring, Meýilleşdirilen işler, Docker, Proksi) we Sazlamalar bölümleri. Aşakdaky düwme bilen nyşanlar hataryna ýygnalýar.',
                '**Gözleg (⌘K / Ctrl+K)** — islendik sahypa, taslama, programma ýa-da maglumatlar bazasyna geçmek, dili we temany çalyşmak.',
                '**Göni** görkezijisi — panel serwer bilen hemişe aragatnaşykda: ýagdaýlar, loglar we metrikalar sahypany täzelemezden üýtgeýär.',
                '**Serwer sagady** — ýokardaky sagat serweriň sagat guşagy boýunça ýöreýär; üstüne basyp, guşagy üýtgedip bolýar (administrator).',
                '**Profil menýusy** (aşaky çep burçda) — dil (10: latyn, kiril we täze latyn elipbiýindäki özbek, garagalpak, rus, iňlis, gyrgyz, täjik, gazak, türkmen), tema (ýagty, garaňky, ulgam), çykmak.',
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'apps',
      title: 'Programmalar',
      sections: [
        {
          id: 'apps-create',
          icon: 'rocket',
          title: 'Programma döretmek',
          summary: 'Dört çeşme: GitHub repozitoriýi, islendik Git URL, taýýar Docker obrazy ýa-da bukja/zip ýüklemek (Netlify Drop ýaly).',
          to: '/projects',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Taslamany açyň → Döret → Programma',
                  text: 'Ady, görnüşi (web ýa-da fon işçisi) we serwer saýlanýar.',
                },
                {
                  title: 'Çeşmäni saýlaň',
                  text: '**GitHub** — birikdirilen GitHub App arkaly repozitoriý we şaha sanawdan saýlanýar, push edilende awtomatik ýerleşdiriş ýakylýar. **GitLab** we **Bitbucket** — Sazlamalar → Git bölüminde access token bilen birikdirilen hasapdan edil şonuň ýaly saýlanýar; webhook repozitoriýe panel tarapyndan özbaşdak goşulýar (goşup bilmese, sebäbi hem-de el bilen goşmak üçin URL we secret görkezilýär). **Git** — islendik URL (ýerleşdiriş açary berilýär, ony repozitoriýe özüňiz goşýarsyňyz). **Docker** — `nginx:1.27` ýa-da `ghcr.io/jamoa/ilova:latest` ýaly obraz; hususy reýestrleriň loginleri Sazlamalar → Reýestrler bölüminde. **Faýl ýüklemek** — taýýar saýtyň bukjasyny ýa-da .zip arhiwini taşlaň: panel ony açýar, ulanylan tehnologiýalary kesgitläp gurnaýar we ýerleşdirýär; indiki wersiýalar hem şu ýere taşlanýar ýa-da `curl` bilen API arkaly iberilýär.',
                },
                {
                  title: 'Dörediň',
                  text: 'Ilkinji ýerleşdiriş derrew başlanýar. Programmanyň sahypasynda iş tapgyrma-tapgyr görünýär.',
                },
              ],
            },
            {
              type: 'tip',
              tone: 'info',
              text: 'Web programma porty diňleýär we domen alýar; fon işçisi (worker) portsuz işleýär — nobat işçileri, botlar, cron üçin.',
            },
          ],
        },
        {
          id: 'build',
          icon: 'hammer',
          title: 'Gurnama usullary',
          summary: 'TorexBuilder taslamany özi kesgitleýär; gerek bolsa Dockerfile, Nixpacks, Railpack, Heroku/Paketo buildpack ýa-da statik saýt saýlanýar.',
          blocks: [
            {
              type: 'table',
              head: [
                'Usul',
                'Haçan saýlamaly',
              ],
              rows: [
                [
                  'TorexBuilder (adaty)',
                  'Node, Python, Go, PHP, Ruby, Java, .NET, Rust, statik we beýleki taslamalary awtomatik kesgitleýär, keş we non-root konteýner bilen gurnaýar. `torexploy.json` arkaly jikme-jik sazlanýar.',
                ],
                [
                  'Dockerfile',
                  'Repozitoriýde öz Dockerfile faýlyňyz bar bolsa; onuň ýoluny we `--target` tapgyryny görkezip bolýar.',
                ],
                [
                  'Nixpacks / Railpack',
                  'Railway usulyndaky awtomatik gurnama gerek bolsa.',
                ],
                [
                  'Heroku / Paketo buildpacks',
                  'Heroku ýa-da Cloud Native Buildpacks bilen işlemäge öwrenişen taslamalar üçin.',
                ],
                [
                  'Statik',
                  'HTML/CSS/JS ýa-da SPA: gurnama buýrugy we çykyş bukjasy görkezilýär, netije ýeňil web-serwer arkaly paýlanýar.',
                ],
              ],
            },
            {
              type: 'p',
              text: 'Usul Programma → Umumy → **Gurnama** kartasynda saýlanýar. Kök bukja, install/build buýruklary we ulgam paketleri şol kartadaky **Goşmaça sazlamalar** bölüminde; adatça olara degmegiň zerurlygy ýok. Ornaşdyrylmadyk gurnaýjylar kartanyň aşagyndaky salgylanma arkaly görünýär. **Gurnama meýilnamasyny görmek** düwmesi gurnamadan öň nämäniň kesgitlenendigini we duýduryşlary görkezýär.',
            },
          ],
        },
        {
          id: 'deploy',
          icon: 'play',
          title: 'Ýerleşdirişiň barşy',
          summary: 'Kod → Gurnama → Işletme → Barlag → Trafik → Tamamlama. Täze wersiýa sagdyn bolýança öňki wersiýa işläp durýar.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Kod',
                  text: 'Repozitoriý klonlanýar ýa-da obraz çekilýär.',
                },
                {
                  title: 'Gurnama',
                  text: 'Saýlanan usul bilen obraz gurnalýar; log göni akymda görünýär.',
                },
                {
                  title: 'Işletme',
                  text: 'Täze konteýner(ler) taslamanyň torunda işe girizilýär, olara üýtgeýänler we birikmeler berilýär.',
                },
                {
                  title: 'Barlag',
                  text: 'Health check ýoly (meselem, `/healthz`) jogap berýänçä garaşylýar; garaşmagyň möhleti Giňeldilen bölüminde.',
                },
                {
                  title: 'Trafik',
                  text: 'Proksi täze konteýnere geçýär — ulanyjylar hiç hili kesilmäni duýmaýar.',
                },
                {
                  title: 'Tamamlama',
                  text: 'Köne konteýnerler duruzylýar; wersiýa işjeň diýip bellenýär.',
                },
              ],
            },
            {
              type: 'tip',
              tone: 'info',
              title: 'Strategiýalar',
              text: '**Rolling** (adaty) — kesilmesiz çalyşmak. **Recreate** — ilki könesi duruzylýar, soňra täzesi işe girizilýär; bir diski (tomy) iki nusga bilelikde ulanyp bilmeýän programmalar üçin. Replikalaryň sany hem Giňeldilen bölüminde.',
            },
          ],
        },
        {
          id: 'history',
          icon: 'history',
          title: 'Taryh, yzyna gaýtarmak we arassalamak',
          summary: 'Her ýerleşdiriş tertip belgisi, ýagdaýy, dowamlylygy we logy bilen saklanýar; köne wersiýa bir basyşda gaýdyp bolýar.',
          blocks: [
            {
              type: 'list',
              items: [
                '**#N** — programmanyň içindäki tertip belgisi, arassalanandan soň hem üýtgemeýär. Kartada: kimiň başladandygy, şaha we kommit, sene, **näçe dowam edendigi** (nobatda garaşmak we gurnama wagty aýratyn).',
                '**Şu wersiýa gaýtar** — `⋯` menýusynda; obraz gaýtadan ulanylýar, gurnama bolmaýar, trafik kesilmesiz geçýär.',
                '**Täzeden ýerleşdir** — işjeň wersiýany edil şol obraz bilen täzeden işe girizmek.',
                '**Poz** — tamamlanan, işjeň bolmadyk ýerleşdirişi logy we obrazy bilen bile aýyrýar.',
                '**Arassala** — köne ýerleşdirişleri bir basyşda pozýar; **işjeň** we **iň soňky** ýerleşdiriş hemişe saklanýar.',
                '**Obraz saklamak** sany (Sazlamalar → Web-serwer) näçe bolsa, şonça soňky obraz diskde durýar; köneleri awtomatik pozulýar we olara gaýdyp bolmaýar («Obraz pozulan»).',
              ],
            },
          ],
        },
        {
          id: 'env',
          icon: 'variable',
          title: 'Üýtgeýänler we birikmeler',
          summary: 'Programmanyň üýtgeýänleri, taslamanyň umumy üýtgeýänleri we maglumatlar bazalaryna birikmek — parollary göçürmezden.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Programma → Üýtgeýänler',
                  text: 'Tablisany dolduryň ýa-da **.env görnüşine** geçiň: ol kod redaktory ýaly işleýär (setir belgileri, reňkler, ýalňyş setir derrew bellenýär). `#` bilen başlanýan teswirler we wagtlaýyn öçürilen üýtgeýänler (`# DEBUG=1`) programma berilmeýär, ýöne üýtgeýänler bilen bile saklanýar. `Ctrl+/` (Mac-da `⌘/`) saýlanan setirleri teswire öwürýär ýa-da teswirden çykarýar. Bahalar gizlin durýar, diňe kursor duran setir görünýär.',
                },
                {
                  title: 'Maglumatlar bazasyny birikdiriň',
                  text: 'Şol bölümde **Birikme goşmak**: maglumatlar bazasy we prefiks (`DB_`) saýlanýar. Programma `${DB_DATABASE_URL}`, `${DB_PGHOST}`, `${DB_PGPASSWORD}` ýaly üýtgeýänleri alýar — parol üýtgese, birikme hem täzelenýär.',
                },
                {
                  title: 'Umumy üýtgeýänler',
                  text: 'Taslamanyň sahypasyndaky **Umumy üýtgeýänler** ähli programmalara berilýär; programmanyň öz bahasy ileri tutulýar.',
                },
              ],
            },
            {
              type: 'tip',
              tone: 'work',
              title: 'Möhüm',
              text: 'Üýtgeýänler **indiki ýerleşdirişde** güýje girýär — sahypanyň ýokarsynda «Häzir ýerleşdir» ýatlatmasy peýda bolýar.',
            },
          ],
        },
        {
          id: 'domains',
          icon: 'globe',
          title: 'Domenler we HTTPS',
          summary: 'Her web programma awtomatik salgy alýar; öz domeniňiz üçin bir A ýazgy ýeterlik — sertifikat öz-özünden alynýar we täzelenýär.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'DNS',
                  text: 'Domen prowaýderiňizde `A` ýazgyny serweriň IP salgysyna gönükdiriň (`www` gerek bolsa, ony hem).',
                },
                {
                  title: 'Programma → Domenler → Domen goşmak',
                  text: 'Domen, gerek bolsa ýol (`/api`) we port girizilýär. HTTPS adaty ýagdaýda ýakyk. Sanawda her domen bir setir: DNS we sertifikat ýagdaýy, HTTPS-i ýakmak/öçürmek, gaýtadan barlamak we pozmak. Peýkam jikme-jiklikleri açýar; bir zat nädogry bolsa, olar öz-özünden açylýar.',
                },
                {
                  title: 'Garaşyň',
                  text: 'DNS ýaýrandan soň panel muny görkezýär (DNS ýagdaýy), Caddy bolsa Let’s Encrypt sertifikatyny alýar — adatça bir minudyň içinde.',
                },
              ],
            },
            {
              type: 'list',
              items: [
                '**Gönükdirme** — `www.example.uz` → `example.uz` ýaly 301 redirect domeniň özünde sazlanýar.',
                '**Maglumatlar bazalaryna we faýl ammaryna** hem domen berip bolýar (S3 salgysy üçin amatly).',
                '[Proksi](/proxy) sahypasynda her domeniň haýsy konteýnere barýandygy we Caddy konfigurasiýasy görünýär.',
              ],
            },
          ],
        },
        {
          id: 'logs',
          icon: 'scroll',
          title: 'Loglar we terminal',
          summary: 'Göni loglar derejelerine görä reňklenýär; gözleg, göçürmek, ýükläp almak, doly ekran. Terminal — konteýneriň içine girmek.',
          blocks: [
            {
              type: 'list',
              items: [
                '**Programma → Loglar** — konteýner loglary göni akymda görünýär; `error`/`warn`/`info` derejeleri tapawutlandyrylýar, süzgüç we «Soňuny yzarla» bar. Wagt bellikleri serweriň sagat guşagynda.',
                'Ýokarky sag burçdaky düwmeler: **wagtlaýyn duruzmak**, **wagty görkezmek**, **setirleri geçirmek**, **göçürmek**, **ýükläp almak**, **doly ekran**.',
                '**Ýerleşdiriş logy** — her ýerleşdirişiň aýratyn logy (gurnama, işletme, barlag), «Logy gör» arkaly.',
                '**Terminal** — Programma → Umumy → Terminal (ýa-da `⋯` menýusy): konteýneriň içinde `sh`/`bash`. Maglumatlar bazalarynda hem bar.',
              ],
            },
          ],
        },
        {
          id: 'monitoring',
          icon: 'activity',
          title: 'Monitoring',
          summary: 'Her programma we maglumatlar bazasy üçin CPU, ýat we tor grafikleri; serwerler üçin umumy syn.',
          to: '/monitoring',
          blocks: [
            {
              type: 'list',
              items: [
                '**Programma → Monitoring** — ýokarda göni görkezijiler (prosessor, ýat, tor, konteýnerler) her 15 sekuntda täzelenýär; aşakda soňky sagat/gün/hepde boýunça grafikler, olaryň her biriniň aşagynda ortaça we iň ýokary baha.',
                '[Monitoring](/monitoring) sahypasy — serwerler we ähli serwisler bir ýerde; agyr programmalar derrew göze ilýär.',
                'Ýat we CPU çäkleri Giňeldilen bölüminde bellenýär; çäkden geçen konteýner täzeden işledilýär we bu barada [bildiriş](/settings/notifications) gelýär.',
              ],
            },
          ],
        },
        {
          id: 'cron',
          icon: 'clock',
          title: 'Cron işleri',
          summary: 'Programmanyň içinde meýilnama boýunça buýruklar: hasabatlar, arassalamak, import. Wagt serweriň sagat guşagynda.',
          to: '/schedules',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Programma → Cron işleri → Iş goşmak',
                  text: 'Ady, cron aňlatmasy (`0 3 * * *` — her gün sagat 03:00-da) we buýruk (`node scripts/report.js`).',
                },
                {
                  title: 'Ýerine ýetiriliş',
                  text: 'Iş programmanyň häzirki obrazynda, onuň üýtgeýänleri bilen aýratyn konteýnerde ýerine ýetirilýär; «Häzir ýerine ýetirmek» arkaly el bilen hem işledip bolýar.',
                },
                {
                  title: 'Netije',
                  text: 'Her işledilişiň logy we ýagdaýy saklanýar; [Meýilleşdirilen işler](/schedules) sahypasynda topardaky ähli işler bir ýerde.',
                },
              ],
            },
          ],
        },
        {
          id: 'previews',
          icon: 'git',
          title: 'PR deslapky görnüşleri',
          summary: 'Her pull request öz salgysynda işe girizilýär, PR-da oňa salgylanmaly teswir goýulýar; PR ýapylanda pozulýar.',
          blocks: [
            {
              type: 'p',
              text: 'Programmanyň **PR deslapky görnüş** bölüminde ýakylýar (GitHub, GitLab we Bitbucket-den birikdirilen web programmalar üçin: GitLab-da merge request, Bitbucket-de pull request). PR açylanda deslapky görnüş programmasy döredilip ýerleşdirilýär, her täze push-da täzelenýär, ýapylanda arassalanýar. Deslapky görnüşiň öz üýtgeýänleri bolup biler (meselem, synag maglumatlar bazasy).',
            },
            {
              type: 'tip',
              tone: 'info',
              text: 'GitHub App köne bolsa, onuň sazlamalarynda **Pull requests: Read and write** rugsady we **Pull request** wakasy ýakylan bolmaly.',
            },
          ],
        },
        {
          id: 'compose',
          icon: 'layers',
          title: 'Docker Compose stekleri',
          summary: 'Birnäçe serwisden ybarat taýýar `docker-compose.yml` faýlyny repozitoriýden ýa-da el bilen girizip işletmek.',
          blocks: [
            {
              type: 'p',
              text: 'Taslama → Döret → **Docker Compose**: faýl repozitoriýden (ýoly görkezilip) ýa-da göni tekst görnüşinde alynýar. Platforma serwisleri taslamanyň toruna goşýar, `TZ` berýär, web serwise domen birikdirmäge mümkinçilik berýär; loglar we ýagdaý her serwis boýunça görünýär.',
            },
          ],
        },
      ],
    },
    {
      id: 'data',
      title: 'Maglumatlar',
      sections: [
        {
          id: 'services',
          icon: 'database',
          title: 'Maglumatlar bazalary',
          summary: 'PostgreSQL, MySQL, MariaDB, MongoDB, Redis, RabbitMQ, MinIO, ClickHouse — wersiýasyny saýlap, bir basyşda.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Taslama → Döret → Maglumatlar bazasy',
                  text: 'Görnüşi, wersiýasy, ady we serweri. Giriş maglumatlary awtomatik döredilýär; isleseňiz, **«Giriş maglumatlaryny özüm kesgitlärin»** arkaly ulanyjyny, maglumatlar bazasynyň adyny, paroly (MySQL/MariaDB üçin root parolyny hem) özüňiz berýärsiňiz.',
                },
                {
                  title: 'Birikmek',
                  text: 'Umumy bölüminde **Içki salgy** (`<nom>:5432` — diňe taslamanyň içinden) we **Giriş maglumatlary** (olary görmek audit žurnalyna ýazylýar). Programma birikdirmek — programmanyň Üýtgeýänler bölüminden.',
                },
                {
                  title: 'Daşky giriş (hökmany däl)',
                  text: 'Giňeldilen → **Daşky port**: serweriň şu porty maglumatlar bazasy üçin açylýar; doly URL `Daşky salgy` meýdançasynda. Diňe gerek bolanda we firewall bilen.',
                },
              ],
            },
            {
              type: 'tip',
              tone: 'work',
              text: 'Programmadan maglumatlar bazasyna `localhost` arkaly däl, **içki salgy** (maglumatlar bazasynyň ady) arkaly birikiň — olar bir tordaky aýry-aýry konteýnerler.',
            },
          ],
        },
        {
          id: 'torex-ai',
          icon: 'sparkles',
          title: 'TorexAi',
          summary: 'Platformany we serwerleri ýönekeý dilde dolandyrýan kömekçi: barlaýar, düşündirýär we siziň rugsadyňyz bilen ýerine ýetirýär.',
          to: '/ai',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Bir gezek sazlamak',
                  text: 'Instansiýanyň administratory [Sazlamalar → TorexAi](/settings/ai) bölüminde prowaýder goşýar (Claude, ChatGPT, Grok, Deploy ýa-da OpenAI formatyndaky islendik API), API açaryny girizýär, **Barla** düwmesine basýar we ulanyjylar üçin elýeterli modelleri belleýär.',
                },
                {
                  title: 'Ýazyň',
                  text: '[TorexAi](/ai) sahypasynda näme gerekdigini ýönekeý söz bilen ýazyň: “api programmasyna shop.example.uz domenini birikdir”, “soňky ýerleşdiriş näme üçin şowsuz boldy?”, “serwerde disk näme bilen doldy?”. Faýl ýa-da skrinşot goşup bilersiňiz.',
                },
                {
                  title: 'Tassyklaň',
                  text: 'Okamak amallary derrew ýerine ýetirilýär we jogapda bir setire ýygnalýar. Bir zady üýtgedýän amal kartada görkezilýär: näme ediljekdigi, haýsy buýruk ýa-da sorag bilen. Siz **Rugsat ber** ýa-da **Ret et** düwmesine basýarsyňyz.',
                },
                {
                  title: 'Gerek bolsa yzyna gaýtaryň',
                  text: 'Ýerine ýetirilen üýtgeşmäniň kartasynda **Yzyna gaýtar** düwmesi peýda bolýar: sazlama öňki bahasyna, ýerleşdiriş öňki wersiýasyna, faýl öňki tekstine gaýdýar.',
                },
              ],
            },
            {
              type: 'list',
              items: [
                'TorexAi hemişe **siziň roluňyz** bilen işleýär: siziň edip bilmeýän zadyňyzy ol hem edip bilmeýär.',
                'Pozmak, howply shell buýruklary we repozitoriýe push etmek üçin **hemişe** rugsat soralýar, hatda “adaty üýtgeşmeler üçin soramazlyk” ýakylan bolsa-da.',
                'Programmanyň koduny düzetmek: TorexAi çeşme koduny açýar, üýtgedýär, diff görkezýär we siziň rugsadyňyz bilen täzeden ýerleşdirýär. Üýtgeşme git-de hem galar ýaly, push etmegi haýyş ediň.',
                'Habara **surat we faýl** goşuň: düwme arkaly, penjirä taşlap ýa-da Ctrl+V bilen. Suratlary model görýär, PDF faýllary Claude we ChatGPT okaýar, Word/Excel/PowerPoint faýllaryndan tekst çykarylýar, ZIP arhiwiň içindäkiler sanaw görnüşinde görkezilýär. Diňe faýldan ybarat habar hem bolup bilýär.',
                'Öňki söhbetler çepdäki **Söhbetler** düwmesi bilen açylýan panelde: gözlemek, adyny üýtgetmek, berkitmek we pozmak şu ýerde.',
                'Parollar we tokenler modele gizlenip berilýär; siz olary amal kartasynda doly görýärsiňiz.',
                'Hasabaty, konfigurasiýany ýa-da skripti faýl görnüşinde berýär, surat döredýär (surat modeli birikdirilen bolsa) we metrikalary grafik görnüşinde görkezýär.',
              ],
            },
            {
              type: 'tip',
              tone: 'info',
              title: 'Başarnyklar: hünärmeniň usuly',
              text: 'TorexAi her bir işe laýyk **başarnygy** özi tapýar: serweri barlamak we goramak, rugsatsyz girişiň yzlaryny gözlemek, DDoS hüjümlerine we paroly saýlap tapmaga garşy çäreler, Docker we kitaphanalaryň howpsuzlygy, kod derňewi, ýerleşdiriş ýalňyşlyklary, disk, tizlik, PostgreSQL we MySQL, ätiýaçlyk nusgalary, SSL, loglar, başga serwere göçürmek we gözegçilik. Gerekli başarnyk içki kitaphanadan ýa-da ygtybarly GitHub çeşmelerinden öz-özünden ornaşdyrylýar; teksti şübheli başarnyk administratoryň tassyklamagyna garaşýar. Başarnyk rugsat soramak düzgünlerini üýtgetmeýär. Hemmesi [Sazlamalar → TorexAi → Başarnyklar](/settings/ai/skills) bölüminde.',
            },
            {
              type: 'tip',
              tone: 'work',
              title: 'Serwerdäki buýruklar',
              text: 'SSH serwerinde shell üçin toparda **admin** roly gerek. Umumy lokal serwerde buýruklary diňe instansiýanyň administratory ýerine ýetirip bilýär.',
            },
            {
              type: 'tip',
              tone: 'info',
              title: 'Maglumatlar nirä gidýär',
              text: 'Söhbetiň teksti we gurallaryň netijeleri siziň saýlan prowaýderiňize iberilýär. Muny göz öňünde tutup, haýsy prowaýderi birikdirmelidigini administrator çözýär.',
            },
          ],
        },
        {
          id: 'cli-mcp',
          icon: 'terminal',
          title: 'CLI we MCP',
          summary: 'Terminaldan torex buýrugy bilen, Claude, Cursor we VS Code ýaly AI agentlerden bolsa MCP arkaly dolandyrmak.',
          to: '/settings/mcp',
          blocks: [
            {
              type: 'p',
              text: '**torex** — TorexPloy üçin terminal buýrugy. **MCP** — AI agentleriň (Claude Code, Claude, Cursor, VS Code, Codex we beýlekiler) platformany dolandyrmagy üçin açyk standart. Ikisi hem siziň adyňyzdan we roluňyzyň çäginde işleýär.',
            },
            {
              type: 'code',
              label: 'torex buýrugyny ornaşdyrmak (macOS, Linux; Windows we npm usullary CLI we MCP sahypasynda)',
              text: 'curl -fsSL https://<panel>/cli/install.sh | sh',
            },
            {
              type: 'steps',
              items: [
                {
                  title: 'Girmek',
                  text: '`torex login https://<panel>`: brauzer açylýar, terminaldaky koduň sahypadaky kod bilen gabat gelýändigini barlap, topary we rugsat derejesini saýlaýarsyňyz.',
                },
                {
                  title: 'Bukjany baglamak',
                  text: 'Taslamanyň bukjasynda `torex link`. Şondan soň buýruklarda programmanyň adyny ýazmak hökman däl.',
                },
                {
                  title: 'Işlemek',
                  text: '`torex deploy` (gurnama logy bilen), `torex up` (bukjadaky kody ýükläp ýerleşdirýär), `torex logs -f`, `torex env pull`, `torex rollback`, `torex ai "…"`.',
                },
                {
                  title: 'AI agentini birikdirmek',
                  text: '[Sazlamalar → CLI we MCP](/settings/mcp) sahypasyndan programmaňyz üçin taýýar buýrugy alyň, meselem, Claude Code üçin `claude mcp add --transport http torexploy https://<panel>/mcp`. Programma brauzerde TorexPloy sahypasyny açýar: topary we rugsat derejesini saýlap, **Rugsat ber** düwmesine basýarsyňyz.',
                },
              ],
            },
            {
              type: 'list',
              items: [
                'Rugsat derejeleri: **diňe okamak** hiç zady üýtgetmeýär; **üýtgetmek** ýerleşdirip bilýär, üýtgeýänleri we domenleri üýtgedýär, ýöne hiç zady pozmaýar; **doly** — roluňyzyň rugsat berýän ähli zady.',
                'Pozmak, maglumatlary ýitirmek ýa-da gizlin bahany görkezmek ýaly ädimler siziň anyk razylygyňyz bolmasa ýerine ýetirilmeýär: agent ilki näme boljakdygyny aýdyp, sizden soraýar.',
                'Birikdirilen programmalar we olaryň eden her bir amaly [CLI we MCP](/settings/mcp) sahypasynda görünýär; amallaryň köpüsini bir düwme bilen yzyna gaýtaryp bilýärsiňiz, programmanyň birikmesini islendik wagt kesip bilýärsiňiz.',
                'OAuth goldamaýan programma üçin şol sahypada token dörediň ýa-da islendik MCP kliýentinde buýruk hökmünde `torex mcp` beriň.',
                'CI üçin: `TOREX_URL` we `TOREX_TOKEN` gurşaw üýtgeýänleri bellenende, torex girmezden işleýär.',
              ],
            },
            {
              type: 'tip',
              tone: 'info',
              title: 'TorexAi bilen tapawudy',
              text: 'TorexAi — paneliň içindäki kömekçi, ol administratoryň birikdiren modeli bilen işleýär. MCP arkaly bolsa öz AI agentiňiz (meselem, Claude Code) edil şol gurallar we başarnyklar bilen işleýär.',
            },
          ],
        },
        {
          id: 'database-console',
          icon: 'grid',
          title: 'Maglumatlar bazasynyň konsoly',
          summary: 'PostgreSQL, MySQL we MariaDB maglumatlar bazalaryny pgAdmin ýaly aýratyn sahypada dolandyrmak: tablisalar, SQL, üýtgetmek, meýilnama, sessiýalar we rollar.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Maglumatlar bazasynyň sahypasy → Maglumatlar bazasyny dolandyrmak',
                  text: 'Konsol aýratyn sahypada açylýar: çepde obýektler agajy (maglumatlar bazalary, shemalar, tablisalar, görnüşler, yzygiderlikler, funksiýalar, triggerler), sagda bölümler. Açyk bölümler we soraglaryň teksti şu brauzerde saklanýar — sahypa täzelense-de ýerinde galýar.',
                },
                {
                  title: 'Umumy bölümi',
                  text: 'Serweriň wersiýasy, işlän wagty, göwrümi we birikmeler; göni grafikler (sekuntda sessiýalar, tranzaksiýalar ýa-da soraglar, okalan we ýazylan setirler, keşiň netijeliligi); maglumatlar bazalarynyň sanawy — döretmek, pozmak, açmak; serweriň sazlamalary.',
                },
                {
                  title: 'Tablisa → Maglumatlar',
                  text: 'Serwer tarapynda sahypalara bölmek, sütüniň sözbaşysyna basyp tertiplemek (Shift bilen birnäçe sütün boýunça), süzgüçler we erkin **WHERE** şerti. Öýjügi iki gezek basyp üýtgediň (JSON we uzyn tekst uly penjirede, ENUM we logiki bahalar sanawdan, NULL/DEFAULT bir basyşda), setir goşuň ýa-da belläp pozuň — üýtgeşmeler reňk bilen bellenýär we **Ýatda sakla** basylanda bir tranzaksiýada iberilýär: biri ýalňyş bolsa, hiç biri ulanylmaýar.',
                },
                {
                  title: 'Tablisa → Gurluş we DDL',
                  text: 'Sütünler (görnüşi, NULL, adaty baha, açarlar, salgylanmalar), indeksler we olaryň göwrümi, çäklendirmeler, bu tablisa salgylanýan tablisalar, triggerler we statistika. Sütün ýa-da indeks goşmak, adyny üýtgetmek, pozmak, VACUUM/ANALYZE (MySQL-de OPTIMIZE/CHECK), TRUNCATE we DROP — olaryň her biri ilki SQL koduny görkezýär, siz tassyklaýarsyňyz.',
                },
                {
                  title: 'Sorag bölümi',
                  text: 'Reňkli SQL redaktory tablisa we sütün atlaryny teklip edýär (Ctrl+Space). **Ctrl+Enter** — kursoryň duran soragyny ýa-da bellenen bölegi, **Ctrl+Shift+Enter** ýa-da F5 — tutuş skripti ýerine ýetirýär. Her netije aýratyn bölümde, ýalňyşlyk bolsa onuň ýeri redaktorda çyzylýar. Netijäni CSV/JSON görnüşinde ýükläp almak ýa-da tablisa hökmünde göçürmek bolýar; taryh we .sql faýly açmak/ýatda saklamak bar.',
                },
                {
                  title: 'Meýilnama (EXPLAIN)',
                  text: 'PostgreSQL meýilnamasy agaç görnüşinde: her ädimiň çykdajydaky ýa-da wagtdaky paýy reňk bilen, garaşylan we hakyky setirler ýanaşyk (uly tapawut — ANALYZE gerekdiginiň alamaty). **EXPLAIN ANALYZE** soragy hakykatdan hem ýerine ýetirýär.',
                },
              ],
            },
            {
              type: 'tip',
              tone: 'info',
              title: 'Tranzaksiýalar',
              text: 'Her sorag bölüminiň öz birikmesi bar: `BEGIN` buýrugyndan soňky üýtgeşmeler **Commit** ýa-da **Rollback** basylýança beýlekilere görünmeýär — bölümiň ýokarsyndaky sary zolak muny ýatladýar. 20 minut hereketsiz galan birikme ýapylýar we açyk tranzaksiýa ýatyrylýar. **Diňe okamak** açaryny ýaksaňyz, bölümdäki soraglar maglumatlary üýtgedip bilmeýär.',
            },
            {
              type: 'list',
              items: [
                '**Sessiýalar** bölümi maglumatlar bazasyna birikdirilen ähli sessiýalary göni görkezýär: kim, haýsy maglumatlar bazasyndan, haýsy sorag we näçe wagtdan bäri. Uzak dowam edýän soragy **ýatyryp** ýa-da sessiýany **kesip** bolýar.',
                '**Rollar** (MySQL-de Ulanyjylar): hukuklar, agzalyk, täze rol ýa-da ulanyjy döretmek (parol awtomatik), paroly çalyşmak we pozmak.',
                'Tablisany CSV, JSON ýa-da INSERT skripti görnüşinde ýükläp alyp bolýar (häzirki süzgüç we tertipleme bilen); CSV faýlyny import etseňiz, setirler ilki täze setirler hökmünde görünýär — barlap, ýatda saklaýarsyňyz.',
                'Konsol **işläp düzüji** roly bilen açylýar (giriş maglumatlaryny görmek bilen deň hukuk). Maglumatlary üýtgedýän soraglar, üýtgedilen setirler, eksport we sessiýalaryň kesilmegi audit žurnalyna ýazylýar; soraglaryň teksti we bahalar ýazylmaýar.',
              ],
            },
            {
              type: 'tip',
              tone: 'work',
              text: 'Konsol maglumatlar bazasyna açyk port arkaly däl, taslamanyň torundaky wagtlaýyn kömekçi konteýner arkaly birikýär — daşky port açmak hökman däl we uzakdaky (SSH) serwerlerde hem işleýär.',
            },
          ],
        },
        {
          id: 'backups',
          icon: 'archive',
          title: 'Ätiýaçlyk nusgalary',
          summary: 'El bilen ýa-da meýilnama boýunça; serwerde, S3-de ýa-da öz faýl ammaryňyzda; bir basyşda dikeltmek.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Maglumatlar bazasy → Ätiýaçlyk nusgalary → Ätiýaçlyk nusgasyny döretmek',
                  text: 'PostgreSQL, MySQL, MariaDB, MongoDB we Redis üçin. Nusga sanawda göwrümi we wagty bilen peýda bolýar; ony **ýükläp almak** ýa-da **dikeltmek** bolýar (Redis — diňe ýükläp almak).',
                },
                {
                  title: 'Awtomatik meýilnama',
                  text: 'Cron aňlatmasy (serweriň sagat guşagynda) we saklanjak nusgalaryň sany (1–365): köneleri öz-özünden pozulýar.',
                },
                {
                  title: 'Daşky saklanyş ýeri',
                  text: '[Sazlamalar → S3 salgylary](/settings/storage) bölüminde AWS S3, Cloudflare R2, MinIO… ýa-da taslamadaky **Faýl ammaryny** saýlaň — her nusga şol ýere hem iberilýär.',
                },
              ],
            },
            {
              type: 'tip',
              tone: 'bad',
              title: 'Dikeltmek',
              text: 'Dikeltmek maglumatlar bazasyndaky häzirki maglumatlary nusgadaky ýagdaý bilen çalyşýar. Ilki täze nusga alyň.',
            },
            {
              type: 'list',
              items: [
                '**Programmanyň tomlary** — Programma → Giňeldilen → Tomlar → **Ätiýaçlyk nusgalary**: tomdaky faýllar (ýüklenen faýllar, SQLite) eýeleri we rugsatlary bilen `.tar.gz` arhiwi görnüşinde alynýar. Meýilnama (her 6 sagatda, her gün, her hepde ýa-da öz cron aňlatmaňyz), saklanjak nusgalaryň sany we S3 salgysy maglumatlar bazalaryndaky ýaly.',
                'Faýllaryna ýazyp duran programma üçin **Ätiýaçlyk nusgasy alnanda programmany wagtlaýyn duruzmak** sazlamasyny ýakyň: programma birnäçe sekunt doňdurylýar, soraglar kesilmeýär, nusga bolsa doly bitewi bolýar.',
                'Tom dikeldilende programma duruzylýar, ilki häzirki ýagdaýyň nusgasy alynýar (“Dikeltmezden öňki ýagdaý”), faýllar çalşylýar we programma täzeden işe girizilýär. Bir zat nädogry bolsa, şol nusga arkaly yzyna gaýdyp bolýar.',
              ],
            },
          ],
        },
        {
          id: 'transfer',
          icon: 'download',
          title: 'Taslamany başga panele göçürmek',
          summary: 'Taslamany programmalary, sazlamalary, maglumatlar bazalary, faýllary we kody bilen bir şifrlenen arhiwe eksport edip, başga TorexPloy paneline import etmek.',
          to: '/transfers',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Eksport',
                  text: 'Taslamanyň sahypasynda **⋯ → Eksport et**. Arhiwe nämeleriň girjekdigini saýlaň: maglumatlar bazalary (dump), faýl ammarlary, tomlar, programmalaryň kody we isleseňiz taýýar obrazlar. Sazlamalar, üýtgeýänler, domenler, cron işleri we açarlar hemişe girýär.',
                },
                {
                  title: 'Gizlin sözi saklaň',
                  text: 'Arhiw AES-256 bilen şifrlenýär. Panel berk gizlin söz döredýär (ýa-da özüňiziňkini girizýärsiňiz) we ony eksportyň sahypasynda görkezýär. Gizlin sözsüz arhiwi hiç kim açyp bilmeýär.',
                },
                {
                  title: 'Arhiwi geçiriň',
                  text: 'Üç ýol bar: **.torexploy** faýlyny ýükläp almak; **göçürme salgylanmasy** (başga panel arhiwi göni özi çekip alýar, gizlin söz salgylanmanyň # böleginde); ýa-da **S3** ammaryna nusga.',
                },
                {
                  title: 'Import',
                  text: 'Täze panelde [Göçürmeler → Import](/transfers/import): faýly ýükläň, salgylanmany goýuň ýa-da S3-den saýlaň. Gizlin söz bilen açyň.',
                },
                {
                  title: 'Meýilnamany tassyklaň',
                  text: 'Serweri, taslamanyň adyny we her programmanyň kod çeşmesini saýlaň. Bu panelde eýýäm meşgul domenler we portlar öňünden görkezilýär. **Importy başla** düwmesine basyň: arhiw barlanýar, serwisler döredilip, olaryň maglumatlary dikeldilýär, tomlar doldurylýar we programmalar ýerleşdirilýär.',
                },
              ],
            },
            {
              type: 'table',
              head: [
                'Programmanyň çeşmesi',
                'Import edilen ýerde',
              ],
              rows: [
                [
                  'GitHub, şol hasap birikdirilen',
                  'Repozitoriýe awtomatik baglanýar (repozitoriýniň ady boýunça), push arkaly ýerleşdiriş we deslapky görnüşler işleýär.',
                ],
                [
                  'GitHub birikdirilmedik',
                  'Arhiwdäki koddan (işläp duran kommitden) işe girizilýär; soňra repozitoriýi birikdirip bolýar.',
                ],
                [
                  'GitLab, Bitbucket',
                  'Şu görnüşdäki birikme bar bolsa, repozitoriýe baglanýar; ýok bolsa arhiwdäki koddan.',
                ],
                [
                  'Açyk git salgysy, SSH ýerleşdiriş açary',
                  'Salgy we ýerleşdiriş açary hem bile gelýär.',
                ],
                [
                  'Ýüklenen kod (upload)',
                  'Arhiwdäki zip ýüklenen kod hökmünde dikeldilýär.',
                ],
                [
                  'Taýýar obraz saýlanan bolsa',
                  'Täzeden gurnamazdan, şol obraz bilen derrew işe girizilýär.',
                ],
              ],
            },
            {
              type: 'list',
              items: [
                'Maglumatlar bazalary **şol bir ulanyjylar we parollar** bilen döredilýär, serwisleriň atlary hem saklanýar: programmalardaky birikme salgylary üýtgemeýär.',
                'Faýl ammarlary bucket-leri, faýllary we **şol giriş açarlary** bilen dikeldilýär.',
                'Import ýarym ýolda togtasa (meselem, serwer bilen baglanyşyk kesilse), **Gaýtadan synanyş** ony togtan ýerinden dowam etdirýär, hiç zat iki gezek döredilmeýär.',
                'Terminaldan: `torex export SHOP --link`, soňra başga panelde `torex import <havola>`.',
                'Göçürmek diňe toparyň **administratorlary** üçin; token ulanylsa, onuň doly rugsady bolmaly.',
              ],
            },
            {
              type: 'tip',
              tone: 'work',
              title: 'DNS',
              text: 'Import edilenden soň domenleriň DNS ýazgylaryny täze serweriň IP salgysyna gönükdiriň: HTTPS sertifikatlary öz-özünden berilýär.',
            },
          ],
        },
        {
          id: 'filestore',
          icon: 'hard-drive',
          title: 'Faýl ammary (S3)',
          summary: 'Suratlar, resminamalar we ätiýaçlyk nusgalary üçin S3 bilen gabat gelýän ammar — AWS SDK, rclone, s3cmd bilen işleýär.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Taslama → Döret → Faýl ammary',
                  text: 'Bir basyşda SeaweedFS işe girizilýär; Umumy bölüminde endpoint we root açarlary.',
                },
                {
                  title: 'Bucket-ler we açarlar',
                  text: '**Faýllar** bölüminde bucket dörediň, faýl ýükläň, açyk salgylanma alyň. **Açarlar** bölüminde her programma üçin aýratyn giriş açary (diňe gerekli bucket-lere rugsat bilen).',
                },
                {
                  title: 'Programma birikdirmek',
                  text: 'Üýtgeýänler → Birikme goşmak: programma `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `AWS_*` üýtgeýänlerini alýar. Daşky programmalar, SDK mysallary (Node, Python, PHP, Go, Java, .NET, Ruby, Django, CLI) we wagtlaýyn salgylanmalar — ammaryň **Gollanma** bölüminde, edil şu ammar üçin doldurylan görnüşde.',
                },
                {
                  title: 'Domen',
                  text: '**Domenler** bölüminde `files.example.uz` ýaly salgy berseňiz, faýllar HTTPS arkaly göni paýlanýar.',
                },
              ],
            },
          ],
        },
        {
          id: 'templates',
          icon: 'grid',
          title: 'Şablonlar',
          summary: '130+ taýýar programma (n8n, WordPress, Nextcloud, Gitea, Grafana, Open WebUI…) — gerekli maglumatlar bazasy, disk we sazlamalar bilen bir basyşda.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Taslama → Döret → Şablondan',
                  text: 'Kategoriýalar ýa-da gözleg arkaly saýlaň; kartada haýsy maglumatlar bazasynyň gerekdigi we takmynan näçe ýat talap edýändigi görkezilýär.',
                },
                {
                  title: 'Ady, serwer, domen',
                  text: 'Sag tarapda nämeleriň dörediljekdiginiň sanawy. Domen boş galsa, awtomatik salgy berilýär.',
                },
                {
                  title: 'Ilkinji giriş',
                  text: 'Ornaşdyrylandan soň programmanyň Umumy bölüminde **Ilkinji giriş** kartasy peýda bolýar: login/parolyň nirededigi (Üýtgeýänler, log ýa-da sazlama sahypasy) anyk ýazylan.',
                },
              ],
            },
            {
              type: 'tip',
              tone: 'info',
              text: 'Şablondan döredilen programma adaty programmadyr: üýtgeýänler, domen, maglumatlar bazasy, ätiýaçlyk nusgalary — hemmesi üýtgedilip bilner.',
            },
          ],
        },
      ],
    },
    {
      id: 'team',
      title: 'Topar we howpsuzlyk',
      sections: [
        {
          id: 'roles',
          icon: 'users',
          title: 'Topar we rollar',
          summary: 'Agzalary salgylanma arkaly çagyryň; her kime gerek derejedäki rugsady beriň.',
          to: '/settings/team',
          blocks: [
            {
              type: 'table',
              head: [
                'Rol',
                'Näme edip bilýär',
              ],
              rows: [
                [
                  'Syn ediji',
                  'Hemme zady görýär (loglar, metrikalar, taryh), ýöne hiç zady üýtgedip bilmeýär.',
                ],
                [
                  'Işläp düzüji',
                  'Programma we maglumatlar bazasyny döredýär, ýerleşdirýär, üýtgeýänleri we domenleri dolandyrýar, ätiýaçlyk nusgasyny alýar.',
                ],
                [
                  'Administrator',
                  'Goşmaça: reýestrler, S3 salgylary, bildirişler, serwerler, Docker we Proksi, serwisleri pozmak.',
                ],
                [
                  'Eýesi',
                  'Toparyň eýesi: agzalar we rollar, topary pozmak.',
                ],
                [
                  'Instansiýanyň administratory',
                  'Platformanyň sazlamalary (domen, sagat guşagy, obraz saklamak), täzelemek. Paneli onuň toparyndaky adminler we eýeler hem täzeläp bilýär.',
                ],
              ],
            },
            {
              type: 'p',
              text: '**Çakylyk**: Sazlamalar → Topar → Çagyrmak → salgylanmany göçürip iberiň (ony garaşylýan çakylyklaryň sanawyndan gaýtadan göçürip bolýar). Bir adam birnäçe toparda bolup biler — topar gapdal paneliň ýokarsyndan çalşylýar.',
            },
          ],
        },
        {
          id: 'security',
          icon: 'shield',
          title: 'Howpsuzlyk',
          summary: 'Passkey, iki tapgyrly tassyklama, API tokenleri, deploy hook, audit žurnaly.',
          to: '/settings/security',
          blocks: [
            {
              type: 'list',
              items: [
                '**Passkey** — Sazlamalar → Howpsuzlyk → **Passkey goşmak**: barmak yzy, ýüz ýa-da enjamyň PIN-kody bilen girýärsiňiz, parol hem, kod hem soralmaýar. Giriş sahypasynda **Passkey bilen girmek** düwmesi peýda bolýar, passkey-ler email meýdançasynyň tekliplerinde hem görünýär. Passkey diňe paneliň HTTPS domeninde işleýär (IP salgysynda däl) we şol domene baglanýar: domen üýtgese, passkey-leri täzeden goşmaly bolýar. Parol ätiýaçlyk ýol hökmünde galýar.',
                '**2FA** — Sazlamalar → Howpsuzlyk: autentifikator programmasy (TOTP) we ätiýaçlyk kodlary.',
                '**Parol ýadyňyzdan çyksa** — panele giren bolsaňyz (meselem, GitHub ýa-da passkey bilen), Sazlamalar → Howpsuzlyk bölüminde parol meýdançasynyň aşagyndaky **Paroly ýatdan çykardyňyzmy?** salgylanmasyna basyň we hasabyňyza baglanan GitHub hasaby ýa-da passkey bilen özüňizi tassyklaň. Şondan soň 10 minudyň dowamynda häzirki parol soralmaýar: täze parol bellemek, passkey goşmak ýa-da 2FA-ny öçürmek bolýar. Panele asla girip bilmeseňiz, serwerde `reset-password` buýrugy bar (README faýlyna serediň).',
                '**API tokenleri** — [Sazlamalar → API tokenleri](/settings/tokens): CI ýa-da skriptler üçin; her token bir topara degişli, onuň möhletini kesgitläp bolýar.',
                '**Deploy hook** — Programma → Ýerleşdirişler sahypasynyň aşagynda: gizlin URL, oňa `POST` iberilse, ýerleşdiriş başlanýar (meselem, GitLab CI arkaly). Salgylanmany islendik wagt täzeläp bolýar.',
                '**Audit žurnaly** — [kimiň, haçan, näme edendigi](/settings/audit): girişler, üýtgeşmeler, parollaryň görülmegi.',
                'Ähli gizlin maglumatlar (parollar, tokenler, GitHub açarlary) serwerde şifrlenen görnüşde saklanýar (`PLOY_SECRET_KEY`).',
              ],
            },
          ],
        },
        {
          id: 'notifications',
          icon: 'bell',
          title: 'Bildirişler',
          summary: 'Telegram, Discord, Slack ýa-da gol çekilen webhook — şowsuz ýerleşdiriş, programmanyň işden çykmagy, ätiýaçlyk nusgasynyň ýalňyşlygy, serwer bilen baglanyşygyň kesilmegi barada.',
          to: '/settings/notifications',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Kanal goşmak',
                  text: 'Görnüşi (Telegram bot tokeni we chat ID; Discord/Slack webhook URL; öz webhook salgyňyz) we habarlaryň dili.',
                },
                {
                  title: 'Wakalar',
                  text: 'Haýsy wakalar barada habar gelsin: ýerleşdiriş üstünlikli/şowsuz, programma işden çykdy (crash-loop), ätiýaçlyk nusgasynyň ýalňyşlygy, serwer bilen baglanyşyk kesildi.',
                },
                {
                  title: 'Synag',
                  text: '«Ýatda saklamak we synamak» synag habaryny iberýär; soňky iberişiň ýagdaýy sanawda görünýär.',
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
          title: 'Serwerler',
          summary: 'Panel duran `main` serwerden başga-da SSH arkaly beýleki serwerleri birikdiriň; programmalar we maglumatlar bazalary olaryň islendiginde işläp biler.',
          to: '/servers',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Serwerler → Serwer goşmak',
                  text: 'Ady, `user@host`, port we serwere giriş usuly: SSH paroly (bir gezek, paneliň açaryny ornaşdyrmak üçin; saklanmaýar), öz şahsy açaryňyz ýa-da paneliň açaryny el bilen goşmak. Platforma birikýär, Docker-i barlaýar (gerek bolsa ornaşdyrýar) we proksini işe girizýär.',
                },
                {
                  title: 'Barlamak',
                  text: 'Ýagdaý **Taýýar** bolansoň, programma döredilende şu serweri saýlap bolýar. Mesele bolsa, «Gaýtadan barlamak» onuň sebäbini görkezýär.',
                },
                {
                  title: 'Daşky IP',
                  text: 'Awtomatik kesgitlenýär; daşky portlar we DNS barlagy şu IP salgysyna daýanýar. Kesgitlenmedik bolsa — «Gaýtadan barlamak».',
                },
              ],
            },
            {
              type: 'p',
              text: '[Docker](/docker) sahypasynda serwerdäki konteýnerler, obrazlar we tomlar; [Proksi](/proxy) sahypasynda marşrutlar we Caddy ýagdaýy (administrator).',
            },
          ],
        },
        {
          id: 'settings',
          icon: 'settings',
          title: 'Platformanyň sazlamalary',
          summary: 'Paneliň domeni, programmalaryň domeni, sagat guşagy, obraz saklamak, reýestrler we S3 salgylary.',
          to: '/settings/platform',
          blocks: [
            {
              type: 'list',
              items: [
                '**Web-serwer** — paneliň domeni (HTTPS), programmalar üçin wildcard domen, proksiniň ýagdaýy.',
                '**Sagat guşagy** — tutuş instansiýa üçin bir IANA guşagy: paneldäki seneler, cron we ätiýaçlyk nusgalarynyň meýilnamalary, konteýnerleriň `TZ` üýtgeýäni. Ýokardaky sagatdan hem üýtgedip bolýar.',
                '**Obraz saklamak** — her programma üçin soňky näçe obraz saklansyn (yzyna gaýtarmak üçin).',
                '**Reýestrler** — Docker Hub, GHCR we hususy reýestrleriň loginleri: hususy obrazlary çekmek üçin.',
                '**S3 salgylary** — ätiýaçlyk nusgalary iberilýän daşky ammarlar.',
                '**Git** — GitHub App: bir basyşda döredilýär, webhook we rugsatlar awtomatik sazlanýar. GitLab (gitlab.com ýa-da öz serweriňiz) we Bitbucket access token bilen birikdirilýär; token şifrlenen görnüşde saklanýar we brauzere yzyna iberilmeýär.',
              ],
            },
          ],
        },
        {
          id: 'updates',
          icon: 'refresh',
          title: 'Täzelemek',
          summary: 'Panel özüni özi täzeleýär: täze wersiýa çyksa, gapdal panelde düwme peýda bolýar; programmalar we maglumatlar bazalary durmaýar.',
          blocks: [
            {
              type: 'steps',
              items: [
                {
                  title: 'Habar',
                  text: 'Her 6 sagatda (`PLOY_UPDATE_INTERVAL_SEC`, azyndan 600) yzarlanýan şaha barlanýar; täze kommit bar bolsa, gapdal panelde **Täzelenme bar** ýazgysy, Sazlamalar → Web-serwer bölüminde bolsa üýtgeşmeleriň sanawy görünýär.',
                },
                {
                  title: 'Täzelemek',
                  text: 'Instansiýanyň administratory ýa-da onuň toparyndaky admin düwmä basýar (gapdal paneldäki **Täzelenme bar** düwmesi ýa-da aşakdaky wersiýa ýazgysy arkaly): wagtlaýyn `ploy-updater` konteýneri täze obrazy taýýarlap, paneli edil şol portlar we tomlar bilen täzeden döredýär we onuň sagdynlygyny barlaýar.',
                },
                {
                  title: 'Ýalňyşlyk bolsa',
                  text: 'Köne wersiýa awtomatik dikeldilýär we sebäbi paneldäki ýagdaýda görünýär. El bilen täzelemek — ornaşdyryş buýrugynyň `update` tertibi:',
                },
                {
                  title: 'El bilen täzelemegiň buýrugy',
                  text: '`curl -fsSL https://raw.githubusercontent.com/To-Rex/TorexPloy/main/deploy/install.sh | sudo TORXPLOY_SOURCE=https://github.com/To-Rex/TorexPloy.git sh -s update`',
                },
              ],
            },
          ],
        },
        {
          id: 'troubleshooting',
          icon: 'wrench',
          title: 'Meseleleri çözmek',
          summary: 'Iň köp duş gelýän ýagdaýlar we olaryň ýönekeý çözgütleri.',
          blocks: [
            {
              type: 'faq',
              items: [
                {
                  q: 'Ornaşdyrylanda «port 80 is already used by another container»',
                  a: 'Serwerde başga web-serwer (nginx, apache, traefik) ýa-da köne proksi 80-nji porty eýeläp dur. Ony duruzyň (`docker ps`, `sudo ss -ltnp | grep :80`) we skripti täzeden işlediň — Caddy 80/443 portlaryny özi dolandyrýar.',
                },
                {
                  q: 'Programma maglumatlar bazasyna birigip bilmeýär (timeout, connection refused)',
                  a: '`localhost` ýa-da daşky IP däl, **içki salgyny** ulanyň: maglumatlar bazasynyň ady we porty (`postgres:5432`). Iň aňsady — programmany maglumatlar bazasyna **birikdirmek** we `${DB_DATABASE_URL}` üýtgeýänini ulanmak. Maglumatlar bazasy we programma bir taslamada bolmaly.',
                },
                {
                  q: 'Gurnama ýalňyşlyk bilen tamamlandy',
                  a: 'Ýerleşdiriş logyny açyň — onuň haýsy tapgyrda togtandygy görünýär. Köplenç sebäbi: nädogry kök bukja, ýetmeýän start buýrugy, Node/Python wersiýasy. Umumy → Gurnama kartasynda usuly we buýruklary anyk kesgitläň ýa-da Dockerfile ulanyň; **Gurnama meýilnamasyny görmek** nämäniň kesgitlenendigini görkezýär.',
                },
                {
                  q: 'Domen açylmaýar ýa-da sertifikat ýok',
                  a: 'Programma → Domenler bölüminde DNS ýagdaýyna serediň: A ýazgy serweriň IP salgysyna gönükdirilmändir ýa-da entek ýaýramandyr. 80 we 443 portlar açyk bolmaly. Proksi sahypasynda marşrutyň bardygyny barlaň.',
                },
                {
                  q: 'Öňki wersiýa gaýdyp bolmaýar («Obraz pozulan»)',
                  a: 'Obraz saklamak çäginden daşarda galan wersiýalar diskden pozulýar. Sazlamalar → Web-serwer bölüminde sany artdyryň; gerekli kommiti täzeden ýerleşdirmek hem bolýar.',
                },
                {
                  q: 'Ýerleşdiriş «Nobatda» ýagdaýynda dur',
                  a: 'Şu programmanyň başga bir ýerleşdirişi dowam edýär ýa-da serwer meşgul. Ýerleşdirişler sahypasynda prosesi göni görüň; gerek bolsa ýatyryň.',
                },
                {
                  q: '«Docker is not reachable»',
                  a: 'Serwerde Docker togtapdyr: `sudo systemctl status docker`, soňra `sudo systemctl start docker`. SSH serwerlerinde — Serwerler → Gaýtadan barlamak.',
                },
                {
                  q: 'Daşky URL salgysynda host ýok, diňe `:5432`',
                  a: 'Serweriň daşky IP salgysy kesgitlenmändir. Serwerler → serwer → **Gaýtadan barlamak**; şondan soň doly salgy peýda bolýar. Firewall-da porty açmagy ýatdan çykarmaň.',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};
