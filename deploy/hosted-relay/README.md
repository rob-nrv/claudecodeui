# Hosted Relay: public deployment runbook (FT-M11)

Target: one small fixed VPS (OVHcloud VPS-1 is the documented candidate; the exact offer is **to be confirmed** by the owner). Debian 12 or Ubuntu 24.04. Nothing here is executed by the repository: the operator runs each step.

```
Internet :443 --TLS--> nginx (edge rate limits, X-Forwarded-For REPLACED) --HTTP--> 127.0.0.1:3443  relay gateway (external-tls)
                                                                                    127.0.0.1:3001  app listener (never exposed)
```

The relay coordinates only. Repositories, Claude logins and runs stay on the RuntimeNodes. Client addresses used for the relay's own failure limits come from the last `X-Forwarded-For` entry and only from a loopback peer (the gateway refuses any other bind); nginx overwrites that header, so a client cannot choose it.

## 1. Inputs the owner must provide (none are invented here)

| Input | Used for |
| --- | --- |
| VPS (offer confirmed, Linux, SSH key access) | host |
| Domain `RELAY_DOMAIN` with an A/AAAA record to the VPS IP | public origin and certificate |
| **Public https URL of the source of the deployed fork** (`SOURCE_REPO_URL`) at the exact commit deployed | AGPL-3.0 section 13: `/source` and the "Source code" link on the login/pairing page. There is no default; unset means `/source` answers an explicit 404 and the relay warns at startup |
| A push (or other publication) of the deployed commit to that URL | the offer must match what runs |
| Account username + password, chosen on the VPS | the single V1 account |
| Owner decisions in section 8 | gate items 5 and 6 |

## 2. Host preparation (once)

```bash
apt-get update && apt-get install -y nginx certbot git build-essential python3 curl ufw
# Node 22 (.nvmrc): NodeSource or nvm. Check: node -v  -> v22.x
useradd --system --home-dir /opt/cloudcli-relay --shell /usr/sbin/nologin cloudcli-relay
ufw default deny incoming && ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
# Small VPS: the client build needs memory.
[ "$(free -m | awk '/Mem:/{print $2}')" -lt 3000 ] && fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
```

Never open 3001 or 3443.

## 3. Install, build and verify on Linux (no service yet)

Without a push, ship the exact commit from your PC:

```bash
git archive --format=tar <commit-to-deploy> | ssh root@VPS 'mkdir -p /opt/cloudcli-relay && tar -x -C /opt/cloudcli-relay'
```

With a published repository: `git clone SOURCE_REPO_URL /opt/cloudcli-relay && git -C /opt/cloudcli-relay checkout <commit>`.

```bash
chown -R cloudcli-relay:cloudcli-relay /opt/cloudcli-relay
su -s /bin/bash cloudcli-relay -c 'cd /opt/cloudcli-relay && bash deploy/hosted-relay/verify-install.sh'
```

`verify-install.sh` does the clean `npm ci` (native modules), the build, starts the built relay on temporary loopback ports and a temporary database, and checks health, gateway behaviour, CSP, the `/source` 404 while unset, loopback-only listening, no child process and that only the database is written. It prints `ALL CHECKS PASSED` or the failing line. **Until it has run on the VPS, "builds and runs on Linux" is unverified** (all earlier runs were on Windows).

## 4. Configure, certificate, service

```bash
install -d -m 0750 -o root -g cloudcli-relay /etc/cloudcli-relay
install -m 0640 -o root -g cloudcli-relay /opt/cloudcli-relay/deploy/hosted-relay/relay.env.example /etc/cloudcli-relay/relay.env
sed -i 's/RELAY_DOMAIN/relay.your-domain.tld/; s#https://SOURCE_REPO_URL#https://your-source-url#' /etc/cloudcli-relay/relay.env
cd /opt/cloudcli-relay/deploy/hosted-relay

# Certificate first (HTTP only), then the HTTPS site: nginx cannot load a 443 block without a certificate.
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/certbot
sed 's/RELAY_DOMAIN/relay.your-domain.tld/g' nginx-relay-acme.conf > /etc/nginx/conf.d/cloudcli-relay-acme.conf
nginx -t && systemctl reload nginx
certbot certonly --webroot -w /var/www/certbot -d relay.your-domain.tld --deploy-hook 'systemctl reload nginx'

cp nginx-relay-proxy.inc /etc/nginx/cloudcli-relay-proxy.inc
sed 's/RELAY_DOMAIN/relay.your-domain.tld/g' nginx-relay.conf > /etc/nginx/conf.d/cloudcli-relay.conf
cp cloudcli-relay.service /etc/systemd/system/
nginx -t && systemctl daemon-reload && systemctl enable --now cloudcli-relay && systemctl reload nginx
certbot renew --dry-run
```

Check what is actually loaded, not only the files:

```bash
systemctl is-active cloudcli-relay && journalctl -u cloudcli-relay -n 20 --no-pager   # "Remote gateway (external-tls)", no source-URL warning
ss -ltnp | grep -E ':(3001|3443|443|80)\b'            # 3001/3443 must be 127.0.0.1 only
curl -s http://127.0.0.1:3001/health                  # hosted-relay, ready true
systemctl restart cloudcli-relay && sleep 3 && curl -s http://127.0.0.1:3001/health
```

## 5. Bootstrap the account (loopback only)

Password login and first-account creation are refused on the public origin by design.

```bash
ssh -L 3001:127.0.0.1:3001 root@relay.your-domain.tld
# browser: http://127.0.0.1:3001 -> create the account, sign in, Settings > Remote access:
# one pairing code (browser) and one enrollment code per node. Close the tunnel afterwards.
```

Nodes: `cloudcli node enroll --server https://relay.your-domain.tld --code XXXX-XXXX-XXXX` then `cloudcli node start`.

## 6. Public validation (definition of done)

Everything below runs from a machine **outside** the VPS and, except the last paragraph, needs no human. Order matters: the rate-limit probe blocks the caller's address from pairing for about 15 minutes.

```bash
# 1. Exposure, TLS, headers/CSP, unauthenticated surface (no credentials needed)
node deploy/hosted-relay/smoke-remote.mjs https://relay.your-domain.tld

# 2. Authenticated browser journey in real Chrome (one single-use pairing code, credentials from env)
RELAY_USERNAME=... RELAY_PASSWORD=... RELAY_PAIRING_CODE=XXXX-XXXX-XXXX \
  node deploy/hosted-relay/smoke-browser.mjs https://relay.your-domain.tld --expect-online=0 --out=./relay-evidence

# 3. Same journey with nodes: start N nodes (cloudcli node start), mint a new code, run the
#    command above with --expect-online=N; stop every node, mint a new code and run it again
#    with --expect-online=0 (all nodes offline, no local fallback).

# 4. Last: throttling of wrong pairing codes (reports which layer answered)
node deploy/hosted-relay/smoke-remote.mjs https://relay.your-domain.tld --probe-rate-limit
```

`smoke-browser.mjs` proves: the pairing form for an unpaired browser, the `/source` link, pairing under the served CSP, the app opening (no host onboarding), a `__Host-` Secure/HttpOnly/SameSite=Strict cookie invisible to JavaScript, the `wss://` WebSocket opening (101), the service worker registering, no CSP violation (upstream GitHub calls are blocked on purpose and reported as INFO), the relay never listing itself as a node or executing locally, server-side revocation on logout, and re-pairing being demanded.

Only these need a person or a physical device: the same pairing in a **phone's own browser** (touch input, mobile layout, iOS/Android cookie behaviour), and a real Claude turn on a chosen node (needs that node's Claude login). Everything else is automated above.

On the VPS afterwards: `pgrep -a claude` must be empty and `journalctl -u cloudcli-relay` must show no provider process, so the relay never ran a provider.

## 7. Backup and restore

```bash
cd /opt/cloudcli-relay/deploy/hosted-relay
cp cloudcli-relay-backup.service cloudcli-relay-backup.timer /etc/systemd/system/
install -d -m 0700 -o cloudcli-relay -g cloudcli-relay /var/backups/cloudcli-relay
systemctl daemon-reload && systemctl enable --now cloudcli-relay-backup.timer
systemctl start cloudcli-relay-backup.service && journalctl -u cloudcli-relay-backup -n 3 --no-pager   # "backup ok ... integrity ok"
```

Daily WAL-safe backup through SQLite's backup API (no extra package), integrity-checked, mode 0600, 14 days kept on the same disk. Copy `/var/backups/cloudcli-relay` off the VPS (owner decision): a same-disk backup does not survive losing the VPS. The database holds the password hash, node public keys, browser-session token hashes, project names and mappings, and session rows; no provider credentials or repositories.

Restore (tested locally on a WAL database: backup, delete rows, restore, rows back):

```bash
systemctl stop cloudcli-relay
cd /opt/cloudcli-relay && DATABASE_PATH=/var/lib/cloudcli-relay/relay.db node deploy/hosted-relay/restore.mjs /var/backups/cloudcli-relay/relay-<stamp>.db
chown cloudcli-relay:cloudcli-relay /var/lib/cloudcli-relay/relay.db && systemctl start cloudcli-relay
```

The previous database is kept beside it as `relay.db.before-restore-<time>`.

## 8. Decisions that are the owner's

- **Outage:** relay down means nothing is reachable remotely; nodes keep retrying and running runs stop being observed. V1 accepts this (no standby); systemd restarts the service on failure.
- **Multi-user:** single-user model; do not give the account to anyone else.
- **IPv6 clients:** limits are per address; a client with a whole /64 can rotate addresses. The relay's global failure cap and nginx's zone still bound the total.
- **Naming (LICENSE 7(d)/(e)):** do not brand the service "CloudCLI" or "Siteboon". The client still says "CloudCLI"; renaming is a UI change outside this lot.
- **Sidebar/About links** to the upstream GitHub repository remain (behind login). Only the login/pairing "source" link was changed, to `/source`.
