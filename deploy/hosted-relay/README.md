# Hosted Relay: public deployment runbook (FT-M11)

Target: one small fixed VPS (OVHcloud VPS-1 is the documented candidate; the exact offer is **to be confirmed** by the owner). Debian 12 or Ubuntu 24.04. Nothing here is executed by the repository: every step is run by the operator.

Architecture on the VPS:

```
Internet :443 --TLS--> nginx (rate limits, X-Forwarded-For)  --HTTP--> 127.0.0.1:3443  relay gateway (external-tls)
                                                                       127.0.0.1:3001  app listener (never exposed)
```

The relay is a coordination service only. Repositories, Claude logins and runs stay on the RuntimeNodes.

## 1. Inputs the owner must provide (none are invented here)

| Input | Used for |
| --- | --- |
| VPS (offer confirmed, Linux, root SSH key access) | host |
| Domain / subdomain `RELAY_DOMAIN` with an A/AAAA record to the VPS IP | public origin and certificate |
| Public URL of this fork's source, `SOURCE_REPO_URL` (https) | AGPL-3.0 section 13 offer at `/source` |
| Relay account username + password (chosen on the VPS, never written to a file in this repo) | the single V1 account |
| Decision: outage behaviour (section 7) and retention (section 5) | gate items 5 and 6 |

## 2. Host preparation (once)

```bash
apt-get update && apt-get install -y nginx certbot python3-certbot-nginx sqlite3 ufw git build-essential python3 curl
# Node 22 (see .nvmrc): install from NodeSource or nvm, then: node -v   -> v22.x
useradd --system --home /opt/cloudcli-relay --shell /usr/sbin/nologin cloudcli-relay
ufw default deny incoming && ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
```

Do not open 3001 or 3443. The relay refuses a non-loopback `HOST` and a non-loopback external-tls bind anyway.

## 3. Install and start

```bash
git clone SOURCE_REPO_URL /opt/cloudcli-relay && cd /opt/cloudcli-relay && git checkout <commit-to-deploy>
HUSKY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund
npm run build
chown -R cloudcli-relay:cloudcli-relay /opt/cloudcli-relay

install -d -m 0750 -o root -g cloudcli-relay /etc/cloudcli-relay
install -m 0640 -o root -g cloudcli-relay deploy/hosted-relay/relay.env.example /etc/cloudcli-relay/relay.env
sed -i 's/RELAY_DOMAIN/relay.your-domain.tld/; s#https://SOURCE_REPO_URL#https://your-source-url#' /etc/cloudcli-relay/relay.env

cp deploy/hosted-relay/cloudcli-relay.service /etc/systemd/system/
cp deploy/hosted-relay/nginx-relay-proxy.inc /etc/nginx/cloudcli-relay-proxy.inc
sed 's/RELAY_DOMAIN/relay.your-domain.tld/g' deploy/hosted-relay/nginx-relay.conf > /etc/nginx/conf.d/cloudcli-relay.conf
systemctl daemon-reload && systemctl enable --now cloudcli-relay
certbot --nginx -d relay.your-domain.tld     # after the DNS record resolves; also sets up renewal
nginx -t && systemctl reload nginx
```

Check what is actually loaded (not just the files):

```bash
systemctl is-active cloudcli-relay && journalctl -u cloudcli-relay -n 20 --no-pager
ss -ltnp | grep -E ':(3001|3443|443)\b'          # 3001/3443 must show 127.0.0.1 only
curl -s http://127.0.0.1:3001/health              # role hosted-relay, ready true
systemctl restart cloudcli-relay && sleep 3 && curl -s http://127.0.0.1:3001/health   # survives a restart
```

The journal must show `Remote gateway (external-tls)` and no `CLOUDCLI_SOURCE_URL` warning.

## 4. Bootstrap the account (loopback only)

Password login and first-account creation are refused on the public origin by design. From your own machine:

```bash
ssh -L 3001:127.0.0.1:3001 root@relay.your-domain.tld
# open http://127.0.0.1:3001 in your browser, create the account, sign in,
# then Settings > Remote access: create a pairing code (browser) and a node enrollment code.
```

Then close the tunnel. Pair a remote browser with username + password + code at `https://relay.your-domain.tld`. On each node: `cloudcli node enroll --server https://relay.your-domain.tld --code XXXX-XXXX-XXXX` then `cloudcli node start`.

## 5. Backup and retention

```bash
cp deploy/hosted-relay/cloudcli-relay-backup.{service,timer} /etc/systemd/system/
install -d -m 0700 -o cloudcli-relay -g cloudcli-relay /var/backups/cloudcli-relay
systemctl daemon-reload && systemctl enable --now cloudcli-relay-backup.timer
systemctl start cloudcli-relay-backup.service && journalctl -u cloudcli-relay-backup -n 3 --no-pager   # "backup ok"
```

Daily online SQLite backup (WAL-safe, integrity-checked, 0600, 14 days kept) on the same disk. A same-disk backup does not survive losing the VPS: copy `/var/backups/cloudcli-relay` off-host (owner decision). The database holds password hash, node public keys, browser sessions (token hashes), project names/mappings and session rows; no provider credentials or repositories. Restore = stop service, replace `relay.db` (and remove `-wal`/`-shm`), start.

## 6. Public validation (definition of done)

1. From a machine **outside** the VPS: `node deploy/hosted-relay/smoke-remote.mjs https://relay.your-domain.tld` must print all PASS (TLS, ports 3001/3443 closed, headers/CSP, unauthenticated surface, login refused, 429 on wrong pairing codes).
2. Human, phone or second machine on the public origin (gate item 8):
   - pair with password + code; the page loads with no CSP errors in the console;
   - two nodes enrolled and listed **online**; stop one: it reads **offline** within seconds;
   - start a run on an explicitly chosen online node; the other node receives nothing;
   - stop every node: the client says no node is online, offers no local run, and a send is refused (nothing runs on the VPS: `ps aux | grep -c claude` stays 0);
   - revoke the browser session: the open page is disconnected and reloading demands a new pairing.
3. `ps`/journal on the VPS show the relay never spawned a provider process.

The smoke script sends 12 wrong pairing codes from the caller's address; wait a few minutes before a real pairing from the same address.

## 7. Decisions that are the owner's

- **Outage:** with the relay down nothing is reachable remotely; nodes keep retrying and running runs stop being observed. V1 accepts this (no standby). systemd restarts it on failure.
- **Multi-user:** single-user model. Do not give the account to anyone else.
- **Naming (LICENSE 7(d)/(e)):** do not brand the service "CloudCLI"/"Siteboon". Modified version notice: the client still says "CloudCLI UI"; a rename is a UI change and stays out of this lot.
