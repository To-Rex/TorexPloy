---
name: docker-security-review
description: Review how containers run on a server - privileged mode, root users, mounted Docker socket and host paths, published ports, capabilities, resource limits, stale images - and report what an attacker who gets into one container could reach. Use when asked whether containers, images, a compose file or a Dockerfile are safe, or to review Docker security.
metadata:
  triggers: "konteyner dockerfile compose privileged container containers escape докер контейнер"
  title.uz: "Docker xavfsizligi tahlili"
  title.ru: "Проверка безопасности Docker"
  title.en: "Docker security review"
  summary.uz: "Konteynerlar qanday ishlayotganini tekshiradi: privileged, root, Docker socket, ochiq portlar, limitlar. Bitta konteyner buzilsa nimaga yetishini koʻrsatadi."
  summary.ru: "Проверяет, как запущены контейнеры: privileged, root, Docker socket, открытые порты, лимиты. Показывает, куда дотянется взломщик из одного контейнера."
  summary.en: "Checks how containers run: privileged, root, Docker socket, published ports, limits. Shows what a break-in to one container could reach."
---

# Docker security review

The question behind every check: **if this one container is taken over, what else falls?** A container is a boundary only as long as nothing punches through it.

Everything in sections 1 to 4 only reads.

## 1. The containers that can escape

```sh
docker ps -q | xargs -r docker inspect -f '{{.Name}}|priv={{.HostConfig.Privileged}}|net={{.HostConfig.NetworkMode}}|pid={{.HostConfig.PidMode}}|ipc={{.HostConfig.IpcMode}}|caps={{.HostConfig.CapAdd}}|user={{.Config.User}}|ro={{.HostConfig.ReadonlyRootfs}}|nnp={{.HostConfig.SecurityOpt}}'
```

Rank what you see:

| Setting | Meaning | Severity |
| --- | --- | --- |
| `priv=true` | the container is root on the host | CRITICAL unless it is a platform helper |
| `pid=host`, `net=host`, `ipc=host` | shares the host's processes or network | HIGH |
| `caps` with `SYS_ADMIN`, `SYS_PTRACE`, `NET_ADMIN`, `SYS_MODULE`, `DAC_READ_SEARCH` | most of the way to privileged | HIGH |
| `user=` empty or `0` | runs as root inside; an escape lands as root | MEDIUM (most images do this; worth fixing for internet-facing ones) |

## 2. What is mounted from the host

```sh
docker ps -q | xargs -r docker inspect -f '{{.Name}}{{range .Mounts}}{{if eq .Type "bind"}} {{.Source}}:{{.Destination}}:{{if .RW}}rw{{else}}ro{{end}}{{end}}{{end}}' | awk 'NF>1'
```

- `/var/run/docker.sock` inside a container gives it the whole server: CRITICAL for an application, expected only for the panel itself (`ploy-control`).
- `/`, `/etc`, `/root`, `/home`, `/var/lib/docker` mounted read-write: CRITICAL.
- A project directory mounted read-write into an internet-facing container: MEDIUM, note it.

In TorexPloy a compose application gets host access only when it was allowed explicitly (`api_call GET /api/applications/{id}` shows it): say which applications have it and ask whether each still needs it.

## 3. What is published

```sh
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E '0\.0\.0\.0|\[::\]|:::' || echo 'nothing published on all interfaces'
```

Web applications do not need a published port here: the proxy reaches them over the Docker network. A database, cache, queue or admin tool published on `0.0.0.0` is HIGH: it is open to the internet whatever the firewall says, because Docker's rules come before `ufw`'s.

## 4. Limits, restarts and age

```sh
docker ps -q | xargs -r docker inspect -f '{{.Name}} mem={{.HostConfig.Memory}} cpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}} restart={{.HostConfig.RestartPolicy.Name}} restarts={{.RestartCount}}'
docker ps --format '{{.Names}}\t{{.Image}}\t{{.RunningFor}}' | head -40
docker version --format 'engine {{.Server.Version}}'
```

- `mem=0` on an internet-facing application: one request storm takes the whole server's memory. MEDIUM; in TorexPloy set a memory limit on the application (`PATCH /api/applications/{id}`, look the field up with `api_docs`).
- A container with many restarts is crashing in a loop: not a security finding, but tell the person.
- Images with the tag `latest` or months old carry known holes; see `dependency-vulnerability-audit` for scanning them.

## 5. The image and the Dockerfile

When the application's source is at hand (`code` op "open", then the file tools with `where: code:<id>`), read its `Dockerfile` and compose file for:

- `FROM image:latest` or no tag: unpinned base.
- No `USER` line: runs as root. Suggest a non-root user after the build steps.
- `COPY . .` with no `.dockerignore`: `.env`, `.git` and keys end up inside the image for anyone who can pull it.
- Secrets in `ENV` or `ARG`: visible in `docker history` forever. They belong in the application's variables in the panel.
- `ADD http://...`, or a script downloaded and piped into a shell during the build: unverified code in the image.
- In compose: `privileged: true`, `network_mode: host`, `cap_add`, the Docker socket in `volumes`, `ports:` on a database.

## Report

A table, worst first: container, finding, what an attacker gains, the fix. Then offer the fixes one at a time. For a TorexPloy application the fix is almost always a setting or a file in its repository followed by a redeploy, not a `docker` command: a container changed by hand is replaced at the next deployment.
