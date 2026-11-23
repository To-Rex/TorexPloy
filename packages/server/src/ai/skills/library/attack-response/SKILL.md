---
name: attack-response
description: Respond to an attack in progress on a server or site - a flood of requests (DDoS), brute-force logins, scanners and abusive bots - by finding who is doing it and blocking them without blocking real visitors. Use when a site is slow or down under unusual traffic, logs fill with failed logins or probes, or the person says they are under attack.
metadata:
  triggers: "hujum ddos brute bot botlar flood blokla ban attack attacked bruteforce bots scanner abuse block атак ддос брут бот боты флуд заблок"
  title.uz: "Hujumga javob"
  title.ru: "Реакция на атаку"
  title.en: "Attack response"
  summary.uz: "Soʻrovlar toshqini, parol terish va botlarni aniqlaydi, hujumchi manzillarni haqiqiy mijozlarga zarar bermasdan bloklaydi."
  summary.ru: "Определяет флуд запросов, перебор паролей и ботов, блокирует адреса атакующих, не задевая настоящих посетителей."
  summary.en: "Identifies request floods, password guessing and bots, and blocks the attackers' addresses without hurting real visitors."
  title.kaa: "Hújimge juwap"
  summary.kaa: "Sorawlar tasqının, parol tańlawdı hám botlardı anıqlaydı, hújimshi mánzillerdi haqıyqıy klientlerge ziyan keltirmey bloklaydı."
  title.ky: "Чабуулга жооп берүү"
  summary.ky: "Сурамдардын ташкынын, сырсөз тандоону жана боттарды аныктап, чабуулчу даректерди чыныгы кардарларга зыян келтирбестен бөгөттөйт."
  title.tg: "Вокуниш ба ҳамла"
  summary.tg: "Селаи дархостҳо, интихоби паролҳо ва ботҳоро муайян мекунад ва нишониҳои ҳамлагаронро бе зарар ба мизоҷони воқеӣ манъ мекунад."
  title.kk: "Шабуылға жауап"
  summary.kk: "Сұраныстар тасқынын, құпиясөз теруді және боттарды анықтайды, шабуылдаушы мекенжайларды нақты клиенттерге зиян келтірмей бұғаттайды."
  title.tk: "Hüjüme jogap"
  summary.tk: "Soraglaryň joşgunyny, parollary çaklamagy we botlary anyklaýar, hüjümçi salgylary hakyky müşderilere zyýan ýetirmezden petikleýär."
---

# Attack response

Speed matters, but a wrong block is its own outage. Measure first, block narrowly, and keep a list of what you blocked so it can be undone.

## 1. Is it an attack at all

Most "attacks" are something else. In two calls:

```sh
uptime; free -m | sed -n 2p; df -h / | tail -1
docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' | sort -k2 -rn | head -8
```

A full disk, a container at its memory limit, or one runaway application explains a slow site far more often than a flood. If the load is one application's own doing, switch to `server-performance-tuning`.

## 2. Who is asking

The proxy sees every web request. Its container is `ploy-proxy` (Caddy); logs are JSON lines.

```sh
docker logs --since 10m ploy-proxy 2>&1 | grep -o '"remote_ip":"[^"]*"' | sort | uniq -c | sort -rn | head -15
docker logs --since 10m ploy-proxy 2>&1 | grep -o '"host":"[^"]*","uri":"[^"]*"' | sort | uniq -c | sort -rn | head -15
docker logs --since 10m ploy-proxy 2>&1 | grep -o '"status":[0-9]*' | sort | uniq -c | sort -rn
```

If access logging is not on for the proxy, count connections instead:

```sh
ss -tnH state established '( sport = :443 or sport = :80 )' | awk '{print $4}' | sed 's/:[0-9]*$//' | sort | uniq -c | sort -rn | head -15
```

Read the shape:

- **A few addresses with thousands of requests each**: a simple flood or a scraper. Block them.
- **Thousands of addresses, each with a few requests, all to one expensive URL** (search, login, an API): a distributed flood. Blocking addresses will not keep up; protect the URL (section 4) and put a CDN in front (section 5).
- **Many 404s for `/wp-login.php`, `/.env`, `/phpmyadmin`**: scanners. Harmless noise unless something answers; make sure nothing does.
- **Failed logins in the SSH journal**: brute force. `journalctl -u ssh -u sshd --since '1 hour ago' --no-pager | grep -c 'Failed password'`.

Before blocking, make sure the top address is not the person's own office, their monitoring, a payment provider's callback or a search engine. Ask when unsure: show the top five with their request counts.

## 3. Block the few

Insert at the top so it applies before Docker's rules pass the traffic on:

```sh
iptables -I DOCKER-USER -s <ip> -j DROP
```

`DOCKER-USER` is the chain Docker reserves for exactly this; a plain `ufw deny from <ip>` does **not** stop traffic to containers. For the host's own services (SSH) also:

```sh
ufw insert 1 deny from <ip> to any
```

For more than a handful of addresses use a set, which stays fast at tens of thousands:

```sh
ipset create ploy-blocked hash:net -exist
ipset add ploy-blocked <ip-or-cidr> -exist
iptables -C DOCKER-USER -m set --match-set ploy-blocked src -j DROP 2>/dev/null || iptables -I DOCKER-USER -m set --match-set ploy-blocked src -j DROP
```

Tell the person these rules are gone after a reboot unless saved (`netfilter-persistent save`, with the `iptables-persistent` package), and give them the list of blocked addresses as a file.

## 4. Slow the many

A rule in `DOCKER-USER` that limits new connections per address protects every site at once:

```sh
iptables -I DOCKER-USER -p tcp --syn -m multiport --dports 80,443 -m connlimit --connlimit-above 60 --connlimit-mask 32 -j REJECT --reject-with tcp-reset
iptables -I DOCKER-USER -p tcp --syn -m multiport --dports 80,443 -m hashlimit --hashlimit-name ploy-http --hashlimit-mode srcip --hashlimit-above 40/second --hashlimit-burst 120 -j DROP
```

These numbers suit ordinary sites; an API used by many clients behind one address (an office, a mobile carrier) needs higher limits. Say what you chose and why, and watch the 2xx count for a minute afterwards: if real visitors drop, loosen it.

For brute force on SSH, set up fail2ban as in `server-hardening` section 3; with password logins off it is noise, not danger.

## 5. When the server cannot win

A flood larger than the server's network link cannot be stopped on the server: the packets already arrived. Say so honestly and recommend, in this order:

1. A CDN or DDoS-protection proxy in front of the domain (Cloudflare and its kind): DNS change only, works within minutes. Afterwards allow ports 80 and 443 from the CDN's address ranges alone.
2. The hosting provider's own protection: most have a switch or a support channel for it.
3. More replicas or a bigger server help only against load that is real traffic, never against a flood.

## 6. Afterwards

- Show the effect: requests per address and the 2xx/5xx split before and after.
- List every rule added and the command that removes it (`iptables -D DOCKER-USER ...`, `ipset destroy ploy-blocked`).
- Look for why it hurt: one endpoint without caching or a limit is usually the real weakness. Suggest the application-side fix.
- If login pages were the target, suggest a check for accounts that were actually broken into.
