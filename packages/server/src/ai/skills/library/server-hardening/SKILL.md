---
name: server-hardening
description: Harden a Linux Docker server against attackers without locking anyone out - SSH keys only, firewall, fail2ban, automatic security updates, kernel network settings. Use when asked to protect or secure a server, defend it from hackers, close holes found by an audit, or set up a firewall or fail2ban.
metadata:
  triggers: "himoya himoyala xaker mustahkam firewall ufw fail2ban yop harden protect secure lockdown defend защит укреп файрвол фаервол хакер"
  title.uz: "Serverni himoyalash"
  title.ru: "Защита сервера"
  title.en: "Server hardening"
  summary.uz: "SSH’ni kalitga oʻtkazadi, firewall va fail2ban qoʻyadi, avtomatik yangilanishni yoqadi. Har bir qadam tasdiq bilan, serverdan uzilib qolmaslik choralari bilan."
  summary.ru: "Переводит SSH на ключи, ставит файрвол и fail2ban, включает автообновления. Каждый шаг с подтверждением и защитой от потери доступа."
  summary.en: "Moves SSH to keys, sets up a firewall and fail2ban, turns on automatic updates. Every step approved, with guards against lockout."
---

# Server hardening

Hardening changes how the server is reached, so the first rule is: **never cut the way you came in**. A hardened server nobody can log in to is an outage.

## Before anything

1. If no audit was done in this conversation, do the reading part of `server-security-audit` first (sections 1 to 3 are enough). Harden what is actually weak, not a checklist.
2. Establish how the panel reaches this server and how the person does:
   - `api_call GET /api/servers/{id}`: `kind` is `local` (the panel runs on it) or `ssh` (the panel logs in with its own key, as the listed user, on the listed port).
   - Ask the person how they log in themselves: with a key or with a password. If with a password, they must have a working key **before** passwords are switched off. Do not guess.
3. Tell the person the plan as a short list and the one risk (lockout), then go step by step. One change per approval; verify each before the next.

## 1. SSH

Only after confirming a key works for everyone who needs to get in (the panel's key is in `authorized_keys` of its user; check with `grep -c . ~/.ssh/authorized_keys`).

Write a drop-in instead of editing the main file, so it is one file to undo:

```sh
cat > /etc/ssh/sshd_config.d/60-hardening.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin prohibit-password
MaxAuthTries 4
LoginGraceTime 30
CONF
sshd -t && systemctl reload ssh 2>/dev/null || systemctl reload sshd
```

- `sshd -t` must pass before the reload; if it fails, remove the file and report.
- `reload`, never `restart`: existing sessions stay up.
- If the main `sshd_config` has no `Include /etc/ssh/sshd_config.d/*.conf` line (older systems), the drop-in is ignored: check with `sshd -T | grep -i passwordauthentication` after the reload. Only then edit the main file.
- Do not change the SSH port unless asked: it breaks the panel's connection until the server's port is updated in the panel (`PATCH /api/servers/{id}`), and it stops no real attacker.
- After the change, prove the door still opens: `api_call POST /api/servers/{id}/verify` for an SSH server. If it fails, undo at once.

## 2. Firewall

Docker writes its own iptables rules, and a port published by a container is open **whatever ufw says**. So the firewall protects the host's own services; container ports are closed by not publishing them (in TorexPloy: a service's public port setting, a compose file's `ports:`).

```sh
ufw --version || (apt-get update -qq && apt-get install -y ufw)
ufw default deny incoming; ufw default allow outgoing
ufw allow OpenSSH        # or: ufw allow <ssh port>/tcp, if the port is not 22
ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 443/udp
```

Then, and only after the allow rules are in place and listed back with `ufw show added`:

```sh
ufw --force enable && ufw status verbose
```

- The SSH rule comes first and is checked before `enable`. If the panel's own port is reached directly (not through the proxy), allow it too: look at how the person opens the panel.
- If other servers of the same team reach this one (a database used across servers), allow those source addresses explicitly: `ufw allow from <ip> to any port <port> proto tcp`.
- On systems with firewalld instead of ufw, use `firewall-cmd --permanent --add-service=ssh --add-service=http --add-service=https && firewall-cmd --reload`; do not install a second firewall beside it.

## 3. fail2ban

```sh
apt-get install -y fail2ban
cat > /etc/fail2ban/jail.d/sshd.local <<'CONF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
bantime.increment = true
CONF
systemctl enable --now fail2ban && sleep 2 && fail2ban-client status sshd
```

Add the person's own address to `ignoreip` if they have a fixed one, so a typo cannot ban them: ask, do not assume.

## 4. Automatic security updates

```sh
apt-get install -y unattended-upgrades && dpkg-reconfigure -f noninteractive unattended-upgrades
systemctl is-enabled unattended-upgrades; grep -E 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades
```

Leave automatic reboots off unless the person wants them; say that a pending kernel update needs a reboot they should plan. On RPM systems: `dnf install -y dnf-automatic` and `systemctl enable --now dnf-automatic-install.timer`.

## 5. Kernel network settings

Safe on a Docker host (forwarding must stay on):

```sh
cat > /etc/sysctl.d/60-hardening.conf <<'CONF'
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_redirects = 0
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
CONF
sysctl --system | tail -3
```

Never set `net.ipv4.ip_forward = 0` on a Docker host: containers lose the network.

## 6. What must not listen publicly

For each database or admin port found open in the audit: close it at its source. For a TorexPloy service, `api_call PATCH /api/services/{id}` with the public port removed; applications reach it over the project's network anyway. Do not paper over it with a firewall rule that Docker bypasses.

## After

- Run the audit's sections 2, 3 and 5 again and show before and after as a short table.
- Say what was changed, where each change lives (the file paths), and how to undo it. File edits made through the file tools can be undone from their cards; commands cannot, so name the reverse command.
- Recommend what only the person can do: two-factor protection for panel admins, removing old API tokens, a backup before the next big change.
