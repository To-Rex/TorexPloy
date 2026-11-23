---
name: server-security-audit
description: Audit a Linux server that runs Docker for security weaknesses and report them by severity, without changing anything. Use when asked whether a server is secure, to check or review its security, to find holes or misconfigurations, or before hardening it.
metadata:
  triggers: "xavfsiz xavfsizlik xaker himoya audit zaiflik teshik security secure vulnerab weakness hole holes exposed безопасн защищ уязвим аудит хакер дыр"
  title.uz: "Server xavfsizligi auditi"
  title.ru: "Аудит безопасности сервера"
  title.en: "Server security audit"
  summary.uz: "Serverni oʻzgartirmasdan tekshiradi: SSH, firewall, ochiq portlar, yangilanishlar, Docker. Topilganlarni xavf darajasi boʻyicha beradi."
  summary.ru: "Проверяет сервер, ничего не меняя: SSH, файрвол, открытые порты, обновления, Docker. Находки по степени риска."
  summary.en: "Checks a server without changing it: SSH, firewall, open ports, updates, Docker. Findings ranked by risk."
  title.kaa: "Server qáwipsizligi auditi"
  summary.kaa: "Serverdi ózgertpey tekseredi: SSH, firewall, ashıq portlar, jańalanıwlar, Docker. Tabılǵanlardı qáwip dárejesi boyınsha beredi."
  title.ky: "Сервердин коопсуздук аудити"
  summary.ky: "Серверди өзгөртпөстөн текшерет: SSH, брандмауэр, ачык порттор, жаңылоолор, Docker. Табылгандарды коркунуч деңгээли боюнча берет."
  title.tg: "Аудити амнияти сервер"
  summary.tg: "Серверро бе тағйир додан месанҷад: SSH, файрвол, портҳои кушода, навсозиҳо, Docker. Бозёфтҳоро аз рӯи сатҳи хатар пешниҳод мекунад."
  title.kk: "Сервер қауіпсіздігінің аудиті"
  summary.kk: "Серверді өзгертпей тексереді: SSH, брандмауэр, ашық порттар, жаңартулар, Docker. Табылғандарды қауіп деңгейі бойынша береді."
  title.tk: "Serwer howpsuzlygynyň auditi"
  summary.tk: "Serweri üýtgetmezden barlaýar: SSH, firewall, açyk portlar, täzelenmeler, Docker. Tapylanlary howp derejesi boýunça berýär."
---

# Server security audit

An audit only reads. Every command here is read-only and runs without asking; do not fix anything during the audit. Fixes come afterwards, one approved change at a time (the `server-hardening` skill).

## Method

Run the checks in this order with the `shell` tool. Batch related commands into one call (`a; echo ---; b`) to keep the number of steps small, and read only what you need (`| head`, `| grep`).

### 1. What is this machine

```sh
cat /etc/os-release | head -4; uname -r; uptime; whoami
```

Note the distribution and whether it is still supported: an end-of-life release gets no security fixes, which is a finding by itself.

### 2. Who can get in

```sh
grep -Ev '^\s*(#|$)' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | grep -Ei 'permitrootlogin|passwordauthentication|pubkeyauthentication|port |permitemptypasswords|kbdinteractive|allowusers|maxauthtries'
awk -F: '$3==0{print "uid0:",$1} $7!~/(nologin|false)$/{print "shell:",$1,$7}' /etc/passwd
for h in /root /home/*; do [ -f "$h/.ssh/authorized_keys" ] && echo "$h: $(grep -c . "$h/.ssh/authorized_keys") keys"; done
grep -Ev '^\s*(#|$)' /etc/sudoers /etc/sudoers.d/* 2>/dev/null | grep -i nopasswd
```

Findings: `PasswordAuthentication yes` (or unset on a distribution whose default is yes) with the port reachable from the internet is HIGH; `PermitRootLogin yes` with passwords is HIGH, with keys only is LOW; a second uid 0 account is CRITICAL until explained; more keys than the person expects in `authorized_keys` is HIGH (ask whose they are; do not remove them yourself).

### 3. What is reachable from outside

```sh
ss -tlnpH | awk '{print $4, $6}' | sort -u
(ufw status verbose 2>/dev/null || true); (iptables -S 2>/dev/null | head -40 || true); (nft list ruleset 2>/dev/null | head -40 || true)
```

For every listener on `0.0.0.0` or `[::]`, name the program and ask: does the internet need this? Expected on a TorexPloy host: 22 (SSH), 80 and 443 (the proxy), and the panel's own port only if it is not behind the proxy. Databases (5432, 3306, 27017, 6379), the Docker API (2375/2376) and admin tools listening on all interfaces are findings: 2375 open is CRITICAL (root for anyone), a database open to the internet is HIGH.

Docker publishes ports past `ufw`: a port published with `-p` is open even when `ufw` says deny. Check published ports directly:

```sh
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E '0\.0\.0\.0|\[::\]' || echo 'no published ports'
```

### 4. Updates

```sh
(apt list --upgradable 2>/dev/null | grep -ci security || true); (apt list --upgradable 2>/dev/null | wc -l || true)
[ -f /var/run/reboot-required ] && echo 'reboot required'
(systemctl is-enabled unattended-upgrades 2>/dev/null || echo 'unattended-upgrades: not enabled')
```

On RPM systems use `dnf -q updateinfo list security 2>/dev/null | wc -l`. Pending security updates are MEDIUM, HIGH when the kernel or OpenSSH is among them or automatic updates are off.

### 5. Brute-force exposure

```sh
(systemctl is-active fail2ban 2>/dev/null || echo 'fail2ban: not running')
(journalctl -u ssh -u sshd --since '24 hours ago' --no-pager 2>/dev/null | grep -c 'Failed password' || true)
(lastb -n 5 2>/dev/null | head -5 || true)
```

Thousands of failed logins with password authentication on and no fail2ban is HIGH.

### 6. Docker

```sh
docker ps --format '{{.Names}}' | while read c; do docker inspect -f '{{.Name}} privileged={{.HostConfig.Privileged}} net={{.HostConfig.NetworkMode}} pid={{.HostConfig.PidMode}} user={{.Config.User}} sock={{range .Mounts}}{{if eq .Source "/var/run/docker.sock"}}yes{{end}}{{end}}' "$c"; done
ls -l /var/run/docker.sock; getent group docker
```

Privileged containers, host network or PID, and the Docker socket mounted into a container are findings unless the container is part of the platform (`ploy-control` needs the socket; `ploy-proxy` does not). Members of the `docker` group are root in effect: list them.

### 7. The platform itself

With `api_call`: `GET /api/settings` (is the panel on HTTPS with its own domain?), `GET /api/team/members` (who has owner or admin), `GET /api/tokens` (old API tokens that never expire). Members without two-factor protection on an admin account are worth a line in the report.

### 8. Files and secrets (quick)

```sh
find / -xdev -type f -perm -4000 2>/dev/null | grep -Ev '^/(usr/(bin|lib|libexec|sbin)|bin|sbin|snap)/' | head
find /root /home -maxdepth 3 -name '.env*' -perm -o+r 2>/dev/null | head
```

Unexpected setuid files outside system directories are HIGH. World-readable `.env` files are MEDIUM.

## Report

Write the result for someone who is not a security engineer:

1. One sentence: the overall state.
2. A table: finding, severity (CRITICAL, HIGH, MEDIUM, LOW), why it matters in one clause, the fix in one clause.
3. What is already good (so the person knows what was checked).
4. Offer to fix the findings in order of severity, and say that each change will ask for approval.

Do not invent findings to look thorough, and do not report a check you could not run as passed: say it could not be checked and why.
