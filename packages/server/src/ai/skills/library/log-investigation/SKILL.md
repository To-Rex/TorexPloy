---
name: log-investigation
description: Investigate an incident or an error through logs - application, deployment, proxy, database and system logs - narrowing to a time window, correlating events across them, and building a timeline of what happened and why. Use when asked what happened, why something broke at a certain time, to find an error, to read or analyse logs, or to explain a spike of errors.
metadata:
  triggers: "log logs loglar jurnal xato sabab voqea tahlil error errors incident happened timeline journal journalctl логи лог логов ошибк случилось инцидент"
  title.uz: "Loglarni tahlil qilish"
  title.ru: "Расследование по логам"
  title.en: "Log investigation"
  summary.uz: "Ilova, deploy, proksi, baza va tizim loglarini vaqt boʻyicha solishtirib, nima boʻlganini va nega boʻlganini voqealar ketma-ketligi bilan tushuntiradi."
  summary.ru: "Сопоставляет логи приложения, деплоя, прокси, базы и системы по времени и объясняет, что случилось и почему, с хронологией."
  summary.en: "Correlates app, deploy, proxy, database and system logs by time and explains what happened and why, as a timeline."
  title.kaa: "Loglardı analiz qılıw"
  summary.kaa: "Qosımsha, ornalastırıw, proksi, maǵlıwmatlar bazası hám sistema logların waqıt boyınsha salıstırıp, ne bolǵanın hám nege bolǵanın waqıyalar izbe-izligi menen túsindiredi."
  title.ky: "Логдорду талдоо"
  summary.ky: "Колдонмонун, жайгаштыруунун, проксинин, маалымат базасынын жана системанын логдорун убакыт боюнча салыштырып, эмне болгонун жана эмне үчүн болгонун окуялардын ырааттуулугу менен түшүндүрөт."
  title.tg: "Таҳлили логҳо"
  summary.tg: "Логҳои барнома, ҷойгиркунӣ, прокси, пойгоҳи додаҳо ва системаро аз рӯи вақт муқоиса карда, бо пайдарпайии ҳодисаҳо шарҳ медиҳад, ки чӣ рӯй дод ва чаро."
  title.kk: "Логтарды талдау"
  summary.kk: "Қолданба, орналастыру, прокси, дерекқор және жүйе логтарын уақыт бойынша салыстырып, не болғанын және неге болғанын оқиғалар тізбегімен түсіндіреді."
  title.tk: "Loglary seljermek"
  summary.tk: "Programma, ýerleşdiriş, proksi, maglumatlar bazasy we ulgam loglaryny wagt boýunça deňeşdirip, näme bolandygyny we näme üçin bolandygyny wakalaryň yzygiderliligi bilen düşündirýär."
---

# Log investigation

Logs answer "what happened" only when read around the right moment. Find the moment first, then read every log around it, then explain.

## 1. Fix the moment

Ask, or find out: when did it start, is it still happening, what did people see? Convert to the server's time zone (`date` on the server; container logs are usually UTC).

If the person does not know when, find it:

- Deployments around then: `api_call GET /api/deployments` with `pick: ["id","applicationId","status","createdAt","finishedAt"]`.
- Who changed what: `GET /api/audit` (settings, variables, domains, restarts by people and by TorexAi).
- Metrics: `GET /api/applications/{id}/metrics` or the server's, with `range: "24h"`: a spike in CPU, memory or a drop to zero marks the moment. Show it as a ```chart block of type "metric".

## 2. Read around it

Read narrow: a time window and a pattern, never whole logs. The `logs` tool takes `since` (minutes) and `grep` (a regular expression).

| Where | How |
| --- | --- |
| The application | `logs` with `app:<id>` (`app:<id>/<compose service>` for compose), `since`, and `grep` such as `error|exception|fatal|panic|traceback|refused|timeout` |
| A deployment | `logs` with `deployment:<id>`: the errors are picked out for you |
| A database or other service | `logs` with `service:<id>` |
| The proxy (every request, status codes, upstream errors) | `shell`: `docker logs --since <time> --until <time> ploy-proxy 2>&1 \| grep -E '"status":5[0-9][0-9]\|error' \| tail -50` |
| The host: kernel, OOM kills, disk errors | `shell`: `journalctl --since '<YYYY-MM-DD HH:MM>' --until '<...>' -p warning --no-pager \| tail -80` and `journalctl -k --since ... \| grep -iE 'oom\|killed\|i/o error\|ext4\|xfs'` |
| Docker itself (containers dying, restarting) | `shell`: `docker events --since <time> --until <time> --filter type=container --format '{{.Time}} {{.Action}} {{.Actor.Attributes.name}}' \| grep -vE 'exec_(create\|start\|die)' \| tail -40` |
| SSH and logins | `shell`: `journalctl -u ssh -u sshd --since ... --no-pager \| tail -40` |

Docker's `--since` and `--until` take `2026-01-31T14:00:00` or relative values like `30m`.

When a log is long, count before you read: `... | grep -c pattern`, and group repeated lines: `... | sed -E 's/[0-9]{2,}/N/g' | sort | uniq -c | sort -rn | head -20` turns ten thousand lines into the five kinds of errors there are.

## 3. Correlate

Put events from every source on one timeline, to the second where possible. Look for the first abnormal event; later ones are usually consequences:

- a deployment finished → errors start: the new version (compare with the previous deployment, and offer a rollback);
- a variable or setting changed in the audit log → errors start: that change;
- memory climbs → an OOM kill in the kernel log → the container restarts → 502s in the proxy log: a leak or an undersized limit;
- the database logs "too many connections" or a lock wait → the app times out: the database;
- disk errors or "no space left" → everything fails at once: the disk;
- nothing on the server, but errors calling an outside API: the outside service.

## 4. Explain

Write it for the person, not as a log dump:

1. **What happened**, in two sentences.
2. **Timeline**: time, source, event. Five to ten lines, with the one log line that proves each step, secrets removed.
3. **Root cause**, and how sure you are. Say "likely" when the evidence is indirect.
4. **Is it still happening?** Check the last minutes again.
5. **What to do**: the fix, and what would have warned earlier (a notification, a health check, a limit).

If the logs are gone (rotated, the container replaced), say so, say what is still available, and suggest keeping logs longer or shipping them elsewhere.
