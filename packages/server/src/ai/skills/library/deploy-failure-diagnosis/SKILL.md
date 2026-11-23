---
name: deploy-failure-diagnosis
description: Find why a deployment failed or an application will not start on TorexPloy - build errors, missing variables, wrong port, failed health check, crash loops, out of memory, no disk space - fix the cause and deploy again. Use when a deploy fails, a build breaks, an app is down, crashes, restarts in a loop, shows 502 or 503, or the person asks why their project is not working.
metadata:
  triggers: "xato xatolik ishlamay yiqil tushmay tushib tushdi otmay otmadi build 502 503 504 crash crashed qulab failed failing broken ошибк упал упало падает сборк билд"
  title.uz: "Deploy xatosini aniqlash"
  title.ru: "Диагностика сбоя деплоя"
  title.en: "Deploy failure diagnosis"
  summary.uz: "Deploy nega oʻtmaganini yoki ilova nega ishga tushmayotganini topadi: build xatosi, oʻzgaruvchi, port, health check, xotira. Sababni tuzatib qayta deploy qiladi."
  summary.ru: "Находит, почему деплой не прошёл или приложение не стартует: ошибка сборки, переменные, порт, health check, память. Исправляет причину и деплоит снова."
  summary.en: "Finds why a deploy failed or an app will not start: build error, variables, port, health check, memory. Fixes the cause and deploys again."
---

# Deploy failure diagnosis

A failed deployment fails in one of four places, and the log says which. Find the place first; do not guess at fixes.

## 1. Read the failure

1. `platform_map` with the application's name gives its id and state. `api_call GET /api/applications/{id}/deployments` with `pick: ["id","status","createdAt","error","commitMessage"]` gives the last few: is this the first failure, or has it never worked?
2. `logs` with `deployment:<id>` for the failed one. The error lines are picked out for you; read the **first** error, not the last. The last line is usually a consequence ("exit code 1"), the cause is above it.
3. Compare with the last deployment that succeeded: what changed between them (a commit, a variable, a setting)? That difference is the suspect.

Now place the failure:

| The log stops at | The stage | Go to |
| --- | --- | --- |
| cloning, fetching, "authentication failed", "repository not found" | source | 2 |
| a build step: installing packages, compiling, `RUN ...` | build | 3 |
| the image was built, the container started, then "unhealthy", "exited", "did not become ready" | start | 4 |
| the deployment succeeded but the site shows 502, 503 or the wrong thing | routing | 5 |

## 2. Source

- **Authentication failed / not found**: the repository moved, the token expired, or the deploy key was removed. Check `GET /api/applications/{id}` (source, branch), the git provider (`GET /api/git-providers`, `GET /api/github`), and for a deploy key `GET /api/applications/{id}/deploy-key`.
- **Branch does not exist**: list branches through the provider's endpoint and compare.
- **Submodule or LFS errors**: private submodules need their own access; say so.

## 3. Build

`POST /api/applications/{id}/build-plan` shows how the platform intends to build (detected stack, generated Dockerfile) without deploying: check it matches what the project is.

Common causes, by the message:

- **"Cannot find module", "command not found", "No such file or directory"**: a wrong root directory or build command in the application's settings, or a file that exists locally but is in `.gitignore`. Open the source (`code` op "open") and look.
- **Lockfile out of sync** (`npm ci` refuses, `poetry.lock is not up to date`): the manifest was changed without the lockfile. Fix in the repository.
- **Wrong runtime version** ("Unsupported engine", "requires Python >=3.11", syntax errors in valid modern code): the version comes from `.nvmrc`, `engines`, `.python-version`, `runtime.txt` or the Dockerfile's `FROM`. Align it.
- **A variable needed at build time is missing** (front-end builds reading `VITE_*`, `NEXT_PUBLIC_*`, `REACT_APP_*`): it must be set in the application's variables before the build. `GET /api/applications/{id}/variables` shows the names (no `reveal` needed).
- **"Killed", exit code 137, or the build just stops** during a compile or bundle step: out of memory. Check `free -m` on the server with `shell`; builds of large front ends need 2 GB and more. Add swap or build on a bigger server.
- **"no space left on device"**: the `disk-space-recovery` skill.
- **Tests or lint failing in the build**: the code is broken; show the failing lines and offer to fix or to ask its author.

## 4. Start

The image is fine; the container will not stay up or never reports ready.

1. `logs` with `app:<id>`, tail 100: what the application itself printed before it died. This is where the real error is.
2. `shell`: `docker ps -a --filter name=<app-container> --format '{{.Names}}\t{{.Status}}'` and for a dead one `docker inspect -f '{{.State.ExitCode}} oom={{.State.OOMKilled}} {{.State.Error}}' <container>`.

Read the exit code:

- **1 or 2 with an error in the log**: the application's own failure. Most often a missing or wrong variable (`DATABASE_URL`, a secret, a port), or a dependency it cannot reach.
- **127 or 126**: the start command does not exist or is not executable. Check the start command in the settings against the image.
- **137 with `oom=true`**: killed for memory. Raise the application's memory limit, or find the leak.
- **0**: it finished and exited. It is a script, not a server, or it daemonised itself: the main process must stay in the foreground.

Then the usual suspects:

- **Wrong port**: the app listens on one port, the platform expects another. Find what it listens on (`grep -rn 'listen(' `in the source, or the log line "listening on") and compare with the port in the application's settings. Many frameworks listen on `127.0.0.1` by default: inside a container it must be `0.0.0.0`.
- **Health check fails**: the path in the settings must answer 200 without authentication within the timeout. Test it from inside: `exec` with `app:<id>` and `wget -qO- localhost:<port><path> || curl -s localhost:<port><path>`.
- **Cannot reach its database**: the service is in another project or stopped, or the URL uses `localhost`. Inside a container `localhost` is the container itself; the host name is the service's internal one (`GET /api/services/{id}` and its credentials, and the application's links).
- **Migrations failing at start**: read the error; a migration that half-ran needs a careful hand, not a redeploy loop.
- **Slow start**: the app needs longer than the health check timeout (large Java or Rails apps). Raise the timeout rather than removing the check.

## 5. Routing

The deployment is green and the site is not.

- **502 / 503**: the proxy cannot reach the container. Check the domain's target port equals the port the app listens on (`GET /api/applications/{id}/domains`), and that the container is running.
- **Certificate or "not secure"**: the `ssl-domain-troubleshooting` skill.
- **Old version still showing**: a cache or CDN in front, or the browser. Check with `curl -sI` from the server.

## 6. Fix, deploy, confirm

1. Say the cause in one sentence, with the log line that proves it.
2. Make the smallest fix: a setting or variable through the API, or a code change in the working copy (show the diff).
3. Deploy (`POST /api/applications/{id}/deploy`, or `code` op "deploy" for a working copy), then `wait_deployment`.
4. Confirm it is really up: the deployment succeeded, the container has been running for more than a few seconds, and the application answers on its domain.
5. If the fix was in the working copy, push it (`code` op "push") or tell the person that the next push to the repository will undo it.

If the second attempt fails differently, that is progress: diagnose the new error. If it fails the same way twice, stop changing things and tell the person what you know and what you tried.
