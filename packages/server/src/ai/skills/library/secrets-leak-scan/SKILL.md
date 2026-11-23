---
name: secrets-leak-scan
description: Find passwords, API keys, tokens and private keys left where they should not be - in an application's source code and git history, in Docker images and container environments, in world-readable files on a server - without printing the secrets themselves. Use when asked whether secrets, keys, passwords or .env files have leaked or are exposed, or before making a repository public.
metadata:
  triggers: "oshkor sizib sizdi sizgan leak leaked leaking exposed hardcoded credential credentials утечк утек слит засвет"
  title.uz: "Sirlar sizib chiqishini tekshirish"
  title.ru: "Поиск утечек секретов"
  title.en: "Secrets leak scan"
  summary.uz: "Kod, git tarixi, Docker image va serverdagi fayllardan parol, API kalit va tokenlarni qidiradi. Sirlarning oʻzini koʻrsatmaydi, faqat joyini aytadi."
  summary.ru: "Ищет пароли, API-ключи и токены в коде, истории git, образах Docker и файлах сервера. Сами секреты не показывает, только место."
  summary.en: "Looks for passwords, API keys and tokens in code, git history, Docker images and server files. Shows where they are, never the secrets themselves."
  title.kaa: "Sırlardıń sırtqa shıǵıp ketiwin tekseriw"
  summary.kaa: "Kod, git tariyxı, Docker obrazı hám serverdegi fayllardan parol, API gilt hám tokenlerdi izleydi. Sırlardıń ózin kórsetpeydi, tek ornın aytadı."
  title.ky: "Сырлардын агып чыгышын текшерүү"
  summary.ky: "Коддон, git тарыхынан, Docker образынан жана сервердеги файлдардан сырсөздөрдү, API ачкычтарын жана токендерди издейт. Сырлардын өзүн көрсөтпөйт, жайгашкан жерин гана айтат."
  title.tg: "Санҷиши ифшои сирҳо"
  summary.tg: "Паролҳо, калидҳои API ва токенҳоро дар код, таърихи git, образи Docker ва файлҳои сервер ҷустуҷӯ мекунад. Худи сирҳоро нишон намедиҳад, танҳо ҷойи онҳоро мегӯяд."
  title.kk: "Құпиялардың жылыстауын тексеру"
  summary.kk: "Кодтан, git тарихынан, Docker образынан және сервердегі файлдардан құпиясөздерді, API кілттері мен токендерді іздейді. Құпиялардың өзін көрсетпейді, тек орнын айтады."
  title.tk: "Gizlin maglumatlaryň syzmagyny barlamak"
  summary.tk: "Kodda, git taryhynda, Docker obrazynda we serwerdäki faýllarda parollary, API açarlaryny we tokenleri gözleýär. Gizlin maglumatlaryň özüni görkezmeýär, diňe ýerini aýdýar."
---

# Secrets leak scan

Rule one: **never print a secret you find.** Report the file, the line number and the kind of secret, with the value cut to its first four characters. Every command below is written to do that; keep it that way when you adapt one.

## 1. The source code

Open the application's source (`code` op "open"), then search with `file_search` and `where: code:<id>`. Search for the shapes of secrets, not for the word "password" alone:

| What | Pattern |
| --- | --- |
| Private keys | `-----BEGIN [A-Z ]*PRIVATE KEY-----` |
| AWS access key | `AKIA[0-9A-Z]{16}` |
| GitHub token | `gh[pousr]_[A-Za-z0-9]{36,}` or `github_pat_[A-Za-z0-9_]{60,}` |
| GitLab token | `glpat-[A-Za-z0-9_-]{20,}` |
| Slack token | `xox[baprs]-[A-Za-z0-9-]{10,}` |
| Stripe live key | `sk_live_[A-Za-z0-9]{20,}` |
| Telegram bot token | `[0-9]{8,10}:[A-Za-z0-9_-]{35}` |
| Google API key | `AIza[0-9A-Za-z_-]{35}` |
| JWT | `eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.` |
| Database URL with a password | `(postgres|mysql|mongodb(\+srv)?|redis|amqp)://[^:/\s]+:[^@\s]+@` |
| Assigned in code | `(password|passwd|secret|api_?key|token)\s*[:=]\s*["'][^"']{8,}["']` (case-insensitive) |

Also list files that should never be in a repository: `.env`, `.env.*` (other than `.env.example`), `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `*.keystore`, `credentials.json`, `service-account*.json`, `.npmrc` and `.pypirc` with a token.

Sort what you find: a real secret, a placeholder (`changeme`, `xxx`, `your-key-here`, `example`), or a test fixture. Only real ones are findings; do not flood the report with placeholders.

## 2. The git history

A secret removed in a later commit is still in the history. In the working copy, with `shell` on the panel's server or with `exec` where `git` exists:

```sh
git log --all --oneline -- '.env' '.env.*' '*.pem' '*.key' 'id_rsa*' | head -20
git log --all -p -G 'AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|sk_live_|gh[pousr]_[A-Za-z0-9]{36}' --format='commit %h %ad %an' --date=short | grep -E '^commit|^\+.*(AKIA|PRIVATE KEY|sk_live_|gh[pousr]_)' | cut -c1-60 | head -40
```

`cut -c1-60` keeps the values out of the answer. A hit means the secret must be treated as public from the day of that commit, whatever the repository's visibility is now.

## 3. Images and running containers

```sh
docker ps --format '{{.Names}}' | while read c; do n=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" | grep -ciE 'pass|secret|token|key='); echo "$c: $n secret-looking variables"; done
docker history --no-trunc --format '{{.CreatedBy}}' <image> | grep -oiE '(ARG|ENV) +[A-Z_]*(PASS|SECRET|TOKEN|KEY)[A-Z_]*' | sort -u
```

Variables in a running container are normal: that is how an application gets its settings. A secret in the image's **history** (`ARG` or `ENV` at build time) is a finding: everyone who can pull the image can read it.

Inside a container, look for files baked in that should not be:

```sh
find / -xdev \( -name '.env' -o -name '*.pem' -o -name 'id_rsa' -o -name '.git' \) -not -path '/proc/*' -not -path '*/node_modules/*' 2>/dev/null | head -20
```

A `.git` directory or a `.env` inside a web root is served to the internet by some stacks: check with the application's own domain (`/.env`, `/.git/HEAD`) and report a 200 as CRITICAL.

## 4. The server

```sh
find /root /home /opt /srv /var/www -maxdepth 4 \( -name '.env*' -o -name '*.pem' -o -name 'id_rsa' -o -name '*.key' \) -perm -o+r -printf '%m %u %p\n' 2>/dev/null | head -30
grep -lE 'PASS|TOKEN|SECRET' /etc/cron.d/* /var/spool/cron/crontabs/* 2>/dev/null
history_files=$(ls /root/.bash_history /home/*/.bash_history 2>/dev/null); for f in $history_files; do echo "$f: $(grep -ciE 'password=|--password|token=|PGPASSWORD=|mysql .* -p[^ ]' "$f") lines with secrets"; done
```

World-readable key and `.env` files are MEDIUM (any process on the machine reads them); fix with `chmod 600`. Secrets in shell history are LOW but worth clearing.

## 5. The platform

`api_call GET /api/tokens` (API tokens: unused or never-expiring ones), `GET /api/applications/{id}/variables` without `reveal` (the names are enough: look for the same secret reused across many applications), and the audit log (`GET /api/audit`) for who revealed secrets recently.

## What to do with a finding

1. **Rotate first.** A leaked secret is fixed only by making it worthless: issue a new one at its provider, put it in the application's variables in the panel, redeploy, then revoke the old one. Removing the line from the code does nothing by itself.
2. Then remove it from the code, and add the file to `.gitignore` and `.dockerignore`.
3. Rewriting git history (`git filter-repo`) is optional and disruptive; after rotation it is rarely worth it. Say so.
4. Offer each rotation as its own step, and tell the person which ones only they can do (anything at a third-party provider).

## Report

A table: where (file and line, or container, or path), what kind, since when (the commit date, if from history), severity, what to do. Never the value.
