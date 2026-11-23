---
name: intrusion-check
description: Check a Linux server for signs that someone has broken in - unknown logins, users, SSH keys, processes, miners, cron jobs, listeners, containers, changed binaries - and contain it without destroying evidence. Use when a server is suspected of being hacked or compromised, behaves strangely, has unexplained load or traffic, or after a security alert.
metadata:
  triggers: "buzib buzil buzgan xaker hujum shubha virus mayner zararli kirgan kirdi hacked hack compromis intru breach malware miner backdoor suspicious rootkit взлом хакер вирус майнер подозр компромет"
  title.uz: "Buzib kirish izlarini tekshirish"
  title.ru: "Проверка на взлом"
  title.en: "Intrusion check"
  summary.uz: "Notanish kirishlar, foydalanuvchilar, SSH kalitlar, jarayonlar, maynerlar, cron va konteynerlarni qidiradi. Dalillarni oʻchirmasdan zararni toʻxtatadi."
  summary.ru: "Ищет чужие входы, пользователей, SSH-ключи, процессы, майнеры, cron и контейнеры. Останавливает ущерб, не уничтожая улики."
  summary.en: "Looks for unknown logins, users, SSH keys, processes, miners, cron jobs and containers. Stops the damage without destroying evidence."
  title.kaa: "Buzıp kiriw izlerin tekseriw"
  summary.kaa: "Tanıs emes kiriwler, paydalanıwshılar, SSH giltler, processler, maynerler, cron hám konteynerlerdi izleydi. Dálillerdi óshirmey, ziyandı toqtatadı."
  title.ky: "Бузуп кирүүнүн изин текшерүү"
  summary.ky: "Бейтааныш кирүүлөрдү, колдонуучуларды, SSH ачкычтарын, процесстерди, майнерлерди, cron жана контейнерлерди издейт. Далилдерди өчүрбөстөн зыянды токтотот."
  title.tg: "Санҷиши изҳои рахна"
  summary.tg: "Воридшавиҳо, корбарон, калидҳои SSH, равандҳо, майнерҳо, вазифаҳои нақшавӣ ва контейнерҳои ношиносро ҷустуҷӯ мекунад. Бе нест кардани далелҳо зарарро қатъ мекунад."
  title.kk: "Бұзып кіру іздерін тексеру"
  summary.kk: "Бейтаныс кірулерді, пайдаланушыларды, SSH кілттерін, процестерді, майнерлерді, жоспарлы тапсырмаларды және контейнерлерді іздейді. Дәлелдерді жоймай, зиянды тоқтатады."
  title.tk: "Döwüp girmegiň yzlaryny barlamak"
  summary.tk: "Nätanyş girişleri, ulanyjylary, SSH açarlaryny, prosesleri, maýnerleri, meýilleşdirilen işleri we konteýnerleri gözleýär. Subutnamalary pozmazdan zyýanyň öňüni alýar."
---

# Intrusion check

Two rules decide everything here:

1. **Look before you touch.** Reading is free; every deletion destroys evidence of how they got in, and without knowing that the attacker returns the same way.
2. **A compromised machine cannot be trusted to tell the truth.** `ps`, `ls` and `netstat` may be replaced. Cross-check with a second view (`/proc`, a different tool) when something looks too clean.

Work read-only first. Collect what you find into a short timeline as you go.

## 1. Who logged in, and from where

```sh
last -aiF -n 25; echo ---; lastb -aiF -n 10 2>/dev/null; echo ---; who -a
journalctl -u ssh -u sshd --since '14 days ago' --no-pager 2>/dev/null | grep -E 'Accepted (password|publickey)' | awk '{print $9, $11}' | sort | uniq -c | sort -rn | head -20
```

Show the person the list of addresses that logged in successfully and ask which are theirs. A successful login from an address nobody recognises is the strongest sign there is. An empty or truncated log (`wtmp begins` very recently, gaps in the journal) is itself a sign: logs do not shrink by themselves.

## 2. Accounts and keys

```sh
awk -F: '$3==0 || $3>=1000 {print $1, $3, $7}' /etc/passwd; echo ---
find /etc/passwd /etc/shadow /etc/sudoers /etc/sudoers.d -newermt '-30 days' -printf '%TY-%Tm-%Td %p\n' 2>/dev/null; echo ---
for h in /root /home/*; do f="$h/.ssh/authorized_keys"; [ -f "$f" ] && { echo "== $f ($(stat -c %y "$f" | cut -d. -f1))"; awk '{print $1, substr($2,1,16)"…", $3}' "$f"; }; done
```

Every key gets an owner in the person's mind or it is a finding. The panel's own key carries a `torexploy` comment. Do not remove a key yourself: list them and let the person say which to remove.

## 3. What is running

```sh
ps -eo pid,ppid,user,%cpu,%mem,lstart,cmd --sort=-%cpu | head -25
```

Then look for what hides:

```sh
ls -l /proc/[0-9]*/exe 2>/dev/null | grep -E '\(deleted\)|/tmp/|/dev/shm/|/var/tmp/' | head
for p in $(ps -eo pid --no-headers --sort=-%cpu | head -8); do echo "$p $(readlink /proc/$p/exe 2>/dev/null) cwd=$(readlink /proc/$p/cwd 2>/dev/null)"; done
```

Signs: a binary running from `/tmp`, `/dev/shm` or `/var/tmp`; an executable that was deleted after start; a process with a random or system-looking name (`kworkerds`, `systemd-logind` owned by a normal user, `xmrig`, `kdevtmpfsi`, `kinsing`) holding a full CPU core; a process whose parent is a web server or a database. High CPU with nothing obvious in `ps` means compare `ls /proc | grep -c '^[0-9]'` with `ps -e --no-headers | wc -l`.

## 4. What starts by itself

```sh
for u in $(cut -d: -f1 /etc/passwd); do c=$(crontab -l -u "$u" 2>/dev/null | grep -Ev '^\s*(#|$)'); [ -n "$c" ] && echo "== $u" && echo "$c"; done
ls -la /etc/cron.d /etc/cron.hourly /etc/cron.daily 2>/dev/null | grep -v '^total'; echo ---
systemctl list-unit-files --type=service --state=enabled --no-pager | tail -n +2 | head -60; echo ---
find /etc/systemd/system /usr/lib/systemd/system /etc/init.d /etc/rc.local /etc/profile.d /etc/ld.so.preload -newermt '-30 days' -type f -printf '%TY-%Tm-%Td %p\n' 2>/dev/null
cat /etc/ld.so.preload 2>/dev/null
```

Cron lines that download and run something, a unit file created recently that the person did not install, and anything at all in `/etc/ld.so.preload` are findings.

## 5. What it talks to

```sh
ss -tlnpH; echo ---; ss -tnpH state established | awk '{print $4, $5, $6}' | grep -Ev '127\.0\.0\.1|\[::1\]' | sort | uniq -c | sort -rn | head -20
```

An unknown listener, or steady outbound connections to one address on ports like 3333, 4444, 5555, 14444 (mining pools) or to an IRC port, is a finding. Resolve nothing and connect to nothing yourself.

## 6. Containers

```sh
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.CreatedAt}}' | sort -k4 -r | head -30
docker ps -q | xargs -r docker inspect -f '{{.Name}} privileged={{.HostConfig.Privileged}} binds={{.HostConfig.Binds}}' | grep -E 'privileged=true|:/host|/:/|docker.sock'
```

Compare with what the panel knows (`platform_map`, and `api_call GET /api/servers/{id}/containers`): a container the platform did not create, especially privileged or with the host's root mounted, is how an exposed Docker API is usually abused.

## 7. Changed system files

```sh
(dpkg --verify 2>/dev/null | grep -E '^..5' | grep -E '/(s?bin|lib)/' | head -20) || (rpm -Va 2>/dev/null | grep -E '^..5' | grep -E '/(s?bin|lib)/' | head -20)
find /usr/bin /usr/sbin /bin /sbin -newermt '-14 days' -type f -printf '%TY-%Tm-%Td %p\n' 2>/dev/null | head -20
find /tmp /var/tmp /dev/shm -type f \( -perm -u+x -o -name '.*' \) -printf '%TY-%Tm-%Td %u %p\n' 2>/dev/null | head -20
```

A changed `sshd`, `ps`, `ls`, `netstat`, `sudo` or PAM module means the machine is deeply compromised.

## Verdict

Say plainly which of three it is, and what you base it on:

- **No sign of intrusion**: every check clean. Say what was checked, and that a clean check is not proof.
- **Suspicious**: things that need the person's answer (whose key, whose login, whose container).
- **Compromised**: at least one hard sign (unknown successful login, unknown root account or key, miner, changed system binary, unknown privileged container).

## If it is compromised

Order matters. Ask before each step; these are the person's decisions.

1. **Preserve**: save the evidence you found as a file for the person (`create_file` with the timeline, the process list, the suspicious lines). Do not delete logs, files or containers yet.
2. **Contain**: stop the damage without wiping it. Stop a miner with `kill -STOP <pid>` (frozen, still inspectable) rather than `kill -9`; stop a rogue container with `docker stop`, not `docker rm`. Block its outbound address in the firewall if it is talking to one.
3. **Close the door they used**, once known: remove the unknown key or account, switch off password logins, close the exposed port (see `server-hardening`).
4. **Rotate every secret that was on the machine**: application variables, database passwords, API tokens, deploy keys, the panel's own sessions. Assume all of them were read.
5. **Tell the truth about cleaning**: when system binaries changed or root was obtained, the machine cannot be made trustworthy again by removing what was found. The sound fix is a new server, restored from backups taken *before* the first sign, with the applications redeployed from the panel. Offer to plan that move.

Never run a "cleanup script" found on the internet, and never run a file found in the attacker's directory to see what it does.
