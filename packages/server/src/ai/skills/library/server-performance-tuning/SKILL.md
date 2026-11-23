---
name: server-performance-tuning
description: Find why a server or an application is slow or overloaded - CPU, memory and swap, disk I/O, network, noisy containers, too few or too many replicas - and fix the bottleneck that matters, measuring before and after. Use when a server or site is slow, load is high, memory runs out, containers are killed, or the person asks to speed things up or size resources.
metadata:
  triggers: "sekin tez tezlik yuklama xotira protsessor cpu ram swap qotib qotyapti optimallashtir slow fast speed performance load memory optimize latency медлен тормоз нагрузк памят процессор производительн оптимиз"
  title.uz: "Server tezligini oshirish"
  title.ru: "Ускорение сервера"
  title.en: "Server performance tuning"
  summary.uz: "Server yoki ilova nega sekinligini topadi: CPU, xotira, disk, tarmoq, ogʻir konteynerlar. Eng muhim toʻsiqni tuzatadi va oldin-keyin oʻlchaydi."
  summary.ru: "Находит, почему сервер или приложение тормозит: CPU, память, диск, сеть, тяжёлые контейнеры. Устраняет главное узкое место с замерами до и после."
  summary.en: "Finds why a server or app is slow: CPU, memory, disk, network, heavy containers. Fixes the bottleneck that matters, measured before and after."
  title.kaa: "Server tezligin arttırıw"
  summary.kaa: "Server yamasa qosımsha nege ásten isleytuǵının tabadı: CPU, yad, disk, tarmaq, awır konteynerler. Eń áhmiyetli tosqınlıqtı dúzetedi hám aldın-keyin ólsheydi."
  title.ky: "Сервердин ылдамдыгын жогорулатуу"
  summary.ky: "Сервер же колдонмо эмне үчүн жай иштеп жатканын табат: CPU, эс тутум, диск, тармак, оор контейнерлер. Эң маанилүү тоскоолду оңдойт жана мурун-кийин өлчөйт."
  title.tg: "Баланд бардоштани суръати сервер"
  summary.tg: "Меёбад, ки чаро сервер ё барнома суст аст: CPU, хотира, диск, шабака, контейнерҳои вазнин. Муҳимтарин монеаро ислоҳ мекунад ва натиҷаро пеш аз он ва пас аз он чен мекунад."
  title.kk: "Сервер жылдамдығын арттыру"
  summary.kk: "Сервердің немесе қолданбаның неге баяу екенін табады: CPU, жад, диск, желі, ауыр контейнерлер. Ең маңызды кедергіні түзетеді және нәтижені өзгеріске дейін де, кейін де өлшейді."
  title.tk: "Serweriň tizligini ýokarlandyrmak"
  summary.tk: "Serweriň ýa-da programmanyň näme üçin haýal işleýändigini tapýar: CPU, ýat, disk, tor, agyr konteýnerler. Iň möhüm päsgelçiligi düzedýär we öňünden hem soňundan ölçeýär."
---

# Server performance tuning

Measure, find the one bottleneck, fix it, measure again. Tuning without a measurement is guessing, and most "slow server" reports have a single cause.

## 1. The picture over time

Start with history, not a snapshot: `api_call GET /api/servers/{id}/metrics` with `range: "24h"` (and `"7d"` when the problem is old). Show it to the person as a ```chart block of type "metric"; do not read the points out. Ask: is it slow all the time, at certain hours, or since a certain day? A step change on a day points at a deployment that day (`GET /api/deployments`).

## 2. Which resource is short (one call)

```sh
nproc; uptime; echo ---; free -m; echo ---; vmstat 1 5; echo ---; df -h / /var/lib/docker 2>/dev/null; echo ---; cat /proc/pressure/cpu /proc/pressure/memory /proc/pressure/io 2>/dev/null
```

Read it:

| Sign | Means |
| --- | --- |
| load average well above `nproc`, `us`+`sy` near 100 in vmstat | CPU is short |
| `wa` above 20, `io` pressure `some avg10` above 10 | the disk is the bottleneck |
| `si`/`so` above 0 in vmstat, `available` memory under 10 %, memory pressure above 5 | memory is short and the server swaps |
| `st` above 10 | the virtual machine's host is oversold: only a different plan or provider fixes it |
| all low, but requests are slow | the cause is inside an application or its database, not the server |

## 3. Who uses it

```sh
docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.BlockIO}}' | sort -t$'\t' -k2 -rn | head -12
ps -eo pid,user,%cpu,%mem,rss,etime,comm --sort=-%cpu | head -12
```

Map container names to applications and services with `platform_map`. When the top consumer is not a container, it is on the host: a backup job, a package update, a forgotten process, or a miner (then switch to `intrusion-check`).

For memory kills:

```sh
journalctl -k --since '24 hours ago' --no-pager 2>/dev/null | grep -iE 'out of memory|oom-kill|killed process' | tail -10
docker ps -aq | xargs -r docker inspect -f '{{.Name}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}' | grep -E 'oom=true|restarts=[1-9]'
```

For disk I/O, find the writer: `iostat -x 1 3` (package `sysstat`) and `docker stats` BlockIO. A database without enough memory for its working set turns into a disk problem.

## 4. Fix what was found

Pick the fix for the resource that is short. Every change below is one approval.

**CPU short**
- One application burning CPU in a loop or under real load: look at its logs and metrics (`GET /api/applications/{id}/metrics`). Real load on a web app that is stateless: more replicas spread it only if the server has idle cores; otherwise the server is too small.
- Give a noisy neighbour a CPU limit (`cpuLimit` on the application or service, via `PATCH`; look it up with `api_docs`) so it cannot starve the rest.
- Builds run on the same server and take every core while they run: schedule heavy deploys outside peak hours, or build elsewhere.

**Memory short**
- Put a memory limit on each application that has none, sized from what it really uses (peak from the metrics plus 30 %). One leaking app then restarts alone instead of taking the server down.
- Add swap as a cushion when there is none (`swapon --show` is empty). It does not add speed; it prevents sudden kills:
  ```sh
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab && sysctl -w vm.swappiness=10 && echo 'vm.swappiness=10' > /etc/sysctl.d/60-swap.conf
  ```
- A database using most of the memory is usually configured for a bigger machine or given none: see `postgres-performance` or `mysql-performance`.
- Runtimes that do not see the container limit: Node (`NODE_OPTIONS=--max-old-space-size=<75 % of the limit in MB>`), Java (`-XX:MaxRAMPercentage=75`). Set them as application variables and redeploy.

**Disk I/O short**
- A database doing full table scans: the database skills, an index fixes more than any disk.
- Logs written at debug level: lower the log level.
- Swap thrashing is a memory problem showing up as I/O: fix memory.

**Network**
- `ss -s` with thousands of `TIME-WAIT` or `estab`: a client opening a connection per request (no keep-alive, no pool) or an attack (`attack-response`).

**Nothing on the server is short**: the time is spent inside the application. Find the slow requests (the proxy's logs, the app's own timing), then the slow queries behind them. That is where the next step is.

## 5. When the answer is "a bigger server"

Say so plainly when the measurements show steady use above ~80 % of CPU or memory under normal traffic, after the obvious waste is gone. Give the numbers, the size you would choose and why. Moving to a new server is the `server-migration` skill.

## 6. Report

Before and after, for the resource that was short, from the same measurement. What was changed, and how to take each change back. What to watch next week.
