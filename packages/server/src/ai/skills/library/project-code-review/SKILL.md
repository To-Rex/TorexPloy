---
name: project-code-review
description: Analyse an application's source code as a whole - what it is, how it is built and run, its architecture, security holes (injection, broken authentication and access control, unsafe file and command handling), reliability and performance problems - and report findings with file and line. Use when asked to analyse, review, audit or explain a project or its code, find bugs or vulnerabilities in it, or judge its quality.
metadata:
  triggers: "loyiha proyekt project kod kodni kodini koddagi tahlil bug buglar sifat arxitektura review analyze analyse code quality architecture проект код кода анализ ревью баг качеств архитектур"
  title.uz: "Loyiha kodini tahlil qilish"
  title.ru: "Анализ кода проекта"
  title.en: "Project code review"
  summary.uz: "Loyihani toʻliq oʻrganadi: tuzilishi, xavfsizlik teshiklari, ishonchlilik va tezlik muammolari. Har bir topilma fayl va qatori bilan beriladi."
  summary.ru: "Изучает проект целиком: устройство, дыры в безопасности, проблемы надёжности и скорости. Каждая находка с файлом и строкой."
  summary.en: "Studies a project as a whole: structure, security holes, reliability and speed problems. Every finding comes with its file and line."
  title.kaa: "Joybar kodın analiz qılıw"
  summary.kaa: "Joybardı tolıq úyrenedi: dúzilisi, qáwipsizlik tesikleri, isenimlilik hám tezlik mashqalaları. Hár bir tabılǵan nárse fayl hám qatarı menen beriledi."
  title.ky: "Долбоордун кодун талдоо"
  summary.ky: "Долбоорду толук изилдейт: түзүлүшүн, коопсуздук тешиктерин, ишенимдүүлүк жана ылдамдык көйгөйлөрүн. Ар бир табылга файлы жана сабы менен берилет."
  title.tg: "Таҳлили коди лоиҳа"
  summary.tg: "Лоиҳаро пурра меомӯзад: сохтор, рахнаҳои амниятӣ, мушкилоти эътимоднокӣ ва суръат. Ҳар бозёфт бо файл ва сатри он пешниҳод мешавад."
  title.kk: "Жоба кодын талдау"
  summary.kk: "Жобаны толық зерттейді: құрылымы, қауіпсіздік олқылықтары, сенімділік пен жылдамдық мәселелері. Әр табылған мәселе файлы мен жолы көрсетіліп беріледі."
  title.tk: "Taslamanyň koduny seljermek"
  summary.tk: "Taslamany doly öwrenýär: gurluşyny, howpsuzlyk boşluklaryny, ygtybarlylyk we tizlik meselelerini. Her bir tapyndy faýly we setiri bilen berilýär."
---

# Project code review

Read like someone who will have to run this in production, not like a linter. Ten real findings with evidence beat a hundred style remarks.

Reading is free here: `code` op "open" checks out the commit that is running, and the file tools with `where: code:<id>` read it. Nothing changes until you propose a fix.

## 1. Orient (a few calls, no more)

1. `file_list` at the root, depth 2. Read the manifest (`package.json`, `pyproject.toml`, `composer.json`, `go.mod`, `Cargo.toml`, `pom.xml`), the `Dockerfile` or compose file, and the README's first screen.
2. From those, state: the language and framework, how it starts (the entry point), what it talks to (databases, queues, outside APIs), and how it is built.
3. Find the entry point and follow it to where requests are routed. Now you know where the code that faces the internet lives; that is where to spend the reading.

Do not read every file. Use `file_search` to go straight to the places below, then read around each hit.

## 2. Security: where untrusted input goes

Find where input enters (route handlers, controllers, message consumers, file uploads, webhooks) and follow it to a dangerous sink.

| Look for | Search | It is a hole when |
| --- | --- | --- |
| SQL injection | string building next to `query(`, `execute(`, `raw(`, `` `SELECT ``, `"SELECT`, `+ req.`, `f"SELECT`, `%s" %` | request data is concatenated or interpolated into SQL instead of bound as a parameter |
| Command injection | `exec(`, `execSync(`, `spawn(` with `shell: true`, `system(`, `popen(`, `subprocess` with `shell=True`, backticks | any part of the command comes from a request |
| Path traversal | `readFile(`, `sendFile(`, `open(`, `createReadStream(`, `include`, `require` with a variable | a file name from a request is joined to a path without confining it to a directory |
| Missing access control | handlers that take an id (`/users/:id`, `/orders/:id`) | the record is loaded by id without checking it belongs to the caller (the most common real bug) |
| Missing authentication | the route table | a state-changing or data-returning route has no auth middleware, especially `/admin`, `/internal`, `/debug`, `/api/*` added later |
| Weak session and password handling | `md5(`, `sha1(`, `jwt.sign(`, `jwt.verify(`, `algorithms`, `secret` | passwords hashed without bcrypt, scrypt or argon2; JWT secret hard-coded or `none` accepted; tokens that never expire |
| Cross-site scripting | `innerHTML`, `dangerouslySetInnerHTML`, `v-html`, `|safe`, `{!! !!}`, `html_safe` | user-supplied text is rendered as HTML |
| SSRF | `fetch(`, `axios(`, `requests.get(`, `curl_exec(` with a URL from the request | the server fetches a URL the user chose, with no allowlist |
| Unsafe deserialization | `pickle.loads`, `yaml.load(` without a safe loader, `unserialize(`, `eval(`, `new Function(` | the data comes from outside |
| Open CORS | `Access-Control-Allow-Origin`, `cors(` | `*` or a reflected origin together with credentials |
| Uploads | `multer`, `upload`, `move_uploaded_file` | no size limit, no type check, or files saved inside the web root with their own name |
| Secrets in code | see the `secrets-leak-scan` skill | |

For each hit, read the code path far enough to say whether it is real. "Could be vulnerable" is not a finding; "the `id` from the URL reaches this query at `orders.js:41` unescaped" is.

## 3. Reliability: what takes it down

- **Errors that vanish**: empty `catch`, `except: pass`, promises without a handler. Search `catch {`, `catch (e) {}`, `except:`.
- **No timeouts** on outbound HTTP and database calls: one slow dependency holds every worker.
- **Unbounded work**: a list endpoint without a limit, a loop of queries inside a loop (N+1), reading a whole file or table into memory.
- **State in the process**: sessions, uploads or caches kept in memory or on the container's disk. They vanish at every deployment and break with two replicas.
- **Startup and shutdown**: does it handle `SIGTERM`, does it run migrations at start in a way two replicas would race on, is there a health endpoint that checks its dependencies.
- **Configuration**: values that must differ per environment hard-coded (URLs, ports, debug flags). `DEBUG=True`, stack traces sent to the client, and verbose error pages in production are also security findings.

## 4. How it is built and run here

Compare what the code expects with how it is deployed (`api_call GET /api/applications/{id}`, its variables without `reveal`, its volumes and links): a variable the code reads that is not set, a directory it writes to that is not a volume, a port it listens on that differs from the one configured, a health check path that does not exist in the routes.

## 5. Report

1. **What this is**, in three sentences a non-developer follows.
2. **Findings**, worst first. For each: a title, severity (CRITICAL, HIGH, MEDIUM, LOW), the place as `path:line`, two or three lines of the code as evidence, what goes wrong in practice, and the fix in a sentence.
3. **What is done well**: real things, briefly. It tells the person what was looked at.
4. **What was not reviewed** (generated code, vendored libraries, the front end, anything too large to read): say so.
5. Offer to fix the top findings. Each fix is a small diff in the working copy, shown before it is deployed, and pushed to a branch so it lasts.

Do not report style, naming or formatting unless asked. Do not pad the list: if the code is in good shape, say that.
