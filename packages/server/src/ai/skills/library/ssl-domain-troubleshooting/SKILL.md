---
name: ssl-domain-troubleshooting
description: Fix a domain that does not open or a certificate that is missing, expired or shown as "not secure" on TorexPloy - DNS records, propagation, ports 80 and 443, the Caddy proxy, Let's Encrypt limits, CAA records, CDN and redirect loops. Use when a domain does not work, HTTPS fails, a certificate is not issued or has expired, the browser warns, or after connecting a new domain.
metadata:
  triggers: "ssl https tls dns sertifikat certificate cert letsencrypt ochilmay ochilmadi redirect сертификат открыва"
  title.uz: "Domen va SSL muammolari"
  title.ru: "Проблемы с доменом и SSL"
  title.en: "Domain and SSL troubleshooting"
  summary.uz: "Domen ochilmasa yoki sertifikat chiqmasa: DNS, 80/443 portlar, Caddy proksi, Let’s Encrypt cheklovlari, CDN va redirect sikllarini tekshirib tuzatadi."
  summary.ru: "Домен не открывается или нет сертификата: проверяет DNS, порты 80/443, прокси Caddy, лимиты Let’s Encrypt, CDN и циклы редиректов."
  summary.en: "Domain not opening or no certificate: checks DNS, ports 80/443, the Caddy proxy, Let's Encrypt limits, CDNs and redirect loops."
---

# Domain and SSL troubleshooting

A certificate is issued only when the whole path works: the name points at the server, port 80 reaches the proxy, and the proxy knows the name. Check the path in that order; the first broken link is the cause.

## 1. What the platform sees

- `api_call GET /api/applications/{id}/domains` (or the service's): the domain, its port, its state.
- `POST /api/domains/{domainId}/verify`: checks now where the name resolves and whether a certificate is served. Its answer usually names the problem.
- `GET /api/servers/{id}/proxy`: the proxy's state, its routes and certificates. Is the domain among the routes?

## 2. DNS

From the server (`shell`):

```sh
curl -s -4 https://ifconfig.me; echo; curl -s -6 --max-time 5 https://ifconfig.me; echo
getent ahosts <domain> | awk '{print $1}' | sort -u
(dig +short A <domain> @1.1.1.1; dig +short AAAA <domain> @1.1.1.1; dig +short CAA <domain> @1.1.1.1) 2>/dev/null
```

- **The A record points elsewhere or nowhere**: the person must set it at their DNS provider to the server's public IPv4. Tell them exactly: type `A`, name (`@` for the bare domain, the subdomain otherwise), value the IP.
- **An AAAA record exists but the server has no working IPv6**: Let's Encrypt tries IPv6 first and fails. Remove the AAAA record or make IPv6 work.
- **Changed recently**: propagation is usually minutes, sometimes hours where the old TTL was long. `dig` against `1.1.1.1` and `8.8.8.8` shows what the world sees.
- **CAA records** that do not include `letsencrypt.org` (or the CA in use) forbid issuing. Add `0 issue "letsencrypt.org"`.
- **The proxy of a CDN** (Cloudflare's orange cloud): the name resolves to the CDN, not the server. Either switch the record to "DNS only" until the certificate is issued, or use the CDN's SSL mode "Full (strict)". "Flexible" mode causes an endless redirect loop with a site that forces HTTPS.

## 3. Ports 80 and 443

Certificates are issued over port 80 (HTTP challenge) or 443 (TLS-ALPN). Both must be reachable from the internet:

```sh
ss -tlnp | grep -E ':(80|443)\s'
(ufw status 2>/dev/null | head -20) ; iptables -S DOCKER-USER 2>/dev/null | head
curl -sI --max-time 10 http://<domain>/ | head -5
```

- Something other than the proxy on 80 or 443 (an old nginx or Apache): stop and disable it (ask).
- A firewall at the provider (security group, cloud firewall) is invisible from the server: if the local checks pass and the outside cannot connect, ask the person to open 80 and 443 there.

## 4. The proxy

```sh
docker ps --filter name=ploy-proxy --format '{{.Status}}'
docker logs --since 30m ploy-proxy 2>&1 | grep -iE '<domain>|acme|certificate|challenge|error' | tail -30
```

The error text tells which link is broken:

| Log says | Cause |
| --- | --- |
| `NXDOMAIN`, `no valid A records` | DNS (section 2) |
| `Timeout during connect`, `connection refused` | port 80/443 blocked (section 3) |
| `CAA record prevents issuance` | CAA (section 2) |
| `too many certificates`, `rateLimited` | Let's Encrypt limits: 5 duplicate certificates a week, 50 per registered domain a week, and 5 failed validations an hour. Wait (the log says until when); stop retrying meanwhile |
| `unauthorized`, wrong content at the challenge URL | the name points at a different server, or a CDN answers |

When the route is missing from the proxy, rebuild its configuration: `POST /api/servers/{id}/proxy/reload`.

## 5. The site behind it

- Certificate fine but **502**: the domain's port does not match the port the app listens on, or the app is down: see `deploy-failure-diagnosis`.
- **Redirect loop** (`ERR_TOO_MANY_REDIRECTS`): a CDN in "Flexible" mode, or the app redirecting to HTTPS while it is told the request was HTTP. Apps behind a proxy must trust `X-Forwarded-Proto` (Express `trust proxy`, Django `SECURE_PROXY_SSL_HEADER`, Laravel `TrustProxies`).
- **Mixed content warnings**: the page loads `http://` resources; fix the app's base URL variable.
- **Certificate for the wrong name**: the browser reached another server or the default route; DNS again.

## 6. Confirm

```sh
echo | openssl s_client -connect <domain>:443 -servername <domain> 2>/dev/null | openssl x509 -noout -subject -issuer -dates
curl -sI https://<domain>/ | head -3
```

Then `POST /api/domains/{domainId}/verify` again. Report the cause, what was changed, what the person changed at their DNS provider, and the certificate's expiry date (it renews by itself about 30 days before).
