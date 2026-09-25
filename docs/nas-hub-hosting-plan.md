# Hosting the Hosted Relay on nas-hub: feasibility and plan (FT-M11)

**Status: analysis only. Nothing deployed, nothing exposed, nas-hub not inspected.** This session had no SSH credential for nas-hub (it answers on the LAN, TCP 22 open, but this PC holds no key or account for it), so every fact about the machine below is *declared by the owner, not measured*. `deploy/nas-hub/audit-readonly.sh` produces the missing measurements without changing anything.

Related: [hosted-relay.md](hosted-relay.md), [deploy/hosted-relay/README.md](../deploy/hosted-relay/README.md) (VPS runbook).

## 1. Decision (provisional)

**NAS ADAPTÉ SOUS CONDITIONS.** Capacity is not the issue; the conditions are how it is reached from the Internet and what the NAS itself still owes Jarvis.

| Question | Answer | Basis |
| --- | --- | --- |
| Enough CPU/RAM/disk? | Yes on declared specs | Relay idle RSS measured **76 MB**, 79 MB after 200 requests (Windows, Node 24, external-tls); `dist` 11 MB + `dist-server` 6.6 MB; small SQLite. Budget 384 MB / 1 CPU. Real headroom next to Jellyfin/Gluetun/qBittorrent/*arr is **not measured** |
| Native modules on Debian 13 amd64? | Expected yes, **not run** | see 2 |
| Public reach without a domain? | Yes: Tailscale Funnel gives `*.ts.net` | see 3 |
| Real client IP for rate limiting? | **Unknown behind Funnel** (must be tested) | see 3 |
| Hard preconditions | Off-NVMe backup validated, full reboot validated, lid/suspend/power behaviour known | see 6 |

The decision becomes NAS ADAPTÉ once the audit shows headroom, no port conflict and the Jarvis preconditions are closed; it becomes NAS NON ADAPTÉ if, e.g., suspend-on-lid cannot be disabled, headroom is below the budget, or the NVMe has no verified off-disk backup and the owner will not wait for one.

## 2. Build and native modules on Debian 13

- Debian 13 ships Node 20; `.nvmrc` wants Node 22. Do **not** install Node on the Jarvis host: build in a container (`node:22-trixie-slim`, same glibc as the host) so the NAS gets no toolchain and no global Node.
- Native/binary dependencies pulled at install: `better-sqlite3` ^12 (prebuilt linux-x64 glibc binaries exist for Node 22 in recent 12.x, otherwise compiled), `bcrypt` ^6, `node-pty` ^1.2 beta (compiled with `python3`, `make`, `g++`; it is imported by the shell service that the relay module loads), `sharp` (prebuilt), `@vscode/ripgrep` (downloads a binary from GitHub during `postinstall`, so the build needs outbound HTTPS). The Claude Agent SDK's platform binary is installed but never executed by the relay.
- Not proven: none of these has been built for Linux. The first proof is the Linux check already written (`deploy/hosted-relay/verify-install.sh`), run in the builder stage or inside the image.
- Build cost: `npm ci` plus `vite build` can need 1.5 to 2 GB and several CPU minutes. On a shared NAS run it bounded (`systemd-run --scope -p MemoryMax=3G -p CPUQuota=200% ...`) and off-peak, or build elsewhere once a Linux/Docker machine is available and only pull the image.

## 3. Access modes compared

Facts about Tailscale come from its documentation; DuckDNS from its published API. Anything not documented is marked *untested*.

| | **A. Tailscale Serve (tailnet only)** | **B. Tailscale Funnel** | **C. Direct public + free DNS (DuckDNS)** |
| --- | --- | --- | --- |
| Exposure | None public. Only tailnet devices (phone/PC with Tailscale) | Public Internet, via Tailscale ingress; no router change | Public; router forwards 443 (and 80) to the NAS; home IP exposed |
| Address | `https://<name>.<tailnet>.ts.net` (read it from `tailscale status`; do not guess) | Same form; ports limited to 443, 8443, 10000 | `<chosen>.duckdns.org`, IP tracked by an updater |
| HTTPS | Tailscale-issued certificate, terminated by tailscaled | Same; ingress relays cannot decrypt | Own certificate: DNS-01 through DuckDNS TXT API (documented), or HTTP-01 on port 80 |
| WebSockets | *Untested* (the CLI docs do not mention them) | *Untested*, must pass `smoke-browser.mjs` wss check | Yes through nginx (already in the runbook) |
| Client IP | Tailscale identity/IP of the device | **Not forwarded to the backend as a header** (open upstream request tailscale#12972). `--tls-terminated-tcp` with `--proxy-protocol` can carry the source; whether it is the real public IP was *not verified* | Yes (`$remote_addr` at nginx) |
| Rate limiting | In-app limiters only | In-app limiters only, and possibly **one shared bucket** if the real IP is not available (see below); no edge limiter unless an nginx is added | Full nginx `limit_req` as in the runbook |
| Address stability | Stable while machine name and tailnet name do not change | Same | Name stable; IP changes until the updater catches up |
| Stop/reboot | Serve config persists with `--bg`; key expiry can silently kill the node (see 5) | Same | Depends on router/ISP/updater |
| Security | Smallest surface | Only the served target is public; hostname is discoverable (certificate transparency), expect scanning; ACL `funnel` attribute should be scoped to this node | Largest: opens the home network edge on the same host as the torrent/VPN stack; Docker-published ports bypass ufw |
| Smoke scripts | Runnable from a device on the tailnet (this PC has no Tailscale client today) | `smoke-remote` works with two changes (see 4) | Unchanged |

What a collapsed client address means: the relay keys its pairing and enrolment failure limits per client address (5 per address, 20 global per 15 min). If every Funnel visitor looks like one address, anyone who finds the URL can exhaust the global budget and block **pairing** for 15 minutes. It cannot bypass authentication and does not touch already-paired sessions. It is a nuisance for a single-user V1, but it must be known, and it is testable without code: 5 wrong pairings from network A must throttle A only, while one attempt from network B must still be judged, not throttled.

**Recommendation.** Validate the whole chain first on **A (Serve, tailnet-only)**: zero public exposure and a real certificate, and it covers the owner's own phone and PC because Tailscale is already how they reach the NAS. Move to **B (Funnel)** only if a device without Tailscale must reach the relay, after the three Funnel gates in 7 pass. Do not choose **C** for V1 unless B fails a gate: it needs router changes, exposes the home IP and adds nginx, certificate and firewall work on the shared host. FT-M11's written gate is "public origin"; a Serve-only proof would validate everything except public reachability, which the owner must accept explicitly as the V1 bar or leave open until B passes.

## 4. What the VPS runbook assumes that does not hold on nas-hub

| VPS runbook | On nas-hub | Adaptation |
| --- | --- | --- |
| `nginx` terminates TLS, replaces `X-Forwarded-For`, adds `limit_req` | Not needed for A/B: tailscaled terminates TLS and proxies to `127.0.0.1:3443` (the existing `external-tls` mode) | Lose edge rate limits. Add an nginx only if PROXY protocol is proven to carry the real IP, then translate it to `X-Forwarded-For` |
| certbot / Let's Encrypt | Tailscale issues the certificate | Drop certbot; no `nginx-relay*.conf` |
| `systemd` unit, dedicated user, `ProtectSystem` | Host has Docker; Node 22 is absent | Docker Compose service with equivalent hardening (see 5) |
| Relay listens on **loopback only**; gateway must bind loopback | A Docker bridge network cannot reach a loopback-only listener, so published ports do not work | Either `network_mode: host` (relay on host 127.0.0.1:3001/3443, must be free), or the recommended sidecar that shares the relay's network namespace |
| `ufw allow 80/443`, `ss` shows 3001/3443 loopback | No inbound rule needed for Serve/Funnel; Docker-published ports bypass ufw | Publish **no** host port; verify with `ss -ltn` |
| `smoke-remote.mjs` checks port 80 redirects to https | Funnel has no port 80 | Add a `--no-http-redirect` flag; the "3001/3443 closed" check stays valid (only 443/8443/10000 can be public) |
| `git archive`/clone to `/opt`, `npm ci` on host | Build in a container | `Dockerfile` (multi-stage) |
| Backup timer + `backup.mjs` | Same script works; target must be **off the NVMe** | Run it as a one-shot container against the data volume, then copy off-disk |
| `journalctl` for the service | Docker log driver | `json-file` with size limits |
| Public origin `https://relay.example` | `https://<node>.<tailnet>.ts.net` | Set `CLOUDCLI_REMOTE_ORIGIN` from `tailscale status` output; smoke tools take it as argument |

## 5. Isolation on nas-hub (Jarvis untouched)

Preferred design: **its own Compose project and its own Tailscale node (sidecar)**, so the relay shares nothing with Jarvis except the Docker engine.

```
/srv/cloudcli-relay/            (new; owned by uid 10001)
  compose/compose.yaml          separate project name: cloudcli-relay
  data/relay.db                 the only writable state of the relay
  ts-state/                     sidecar node state (0700)
  backups/                      staging only; the copy that counts lives off the NVMe
  secrets/ts-authkey            0600, never in the repo or the report
```

- `tailscale` sidecar (`tailscale/tailscale`) with a serve/funnel config file pointing at `http://127.0.0.1:3443`; `relay` service uses `network_mode: service:tailscale`, so both share one loopback. The relay still binds loopback (its startup checks stay intact); **no host ports are published**; no dependency on the host's own tailscaled or on any Jarvis port or subnet.
- Relay container: non-root uid 10001, `read_only: true` with a `tmpfs` for `/tmp`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `mem_limit: 384m`, `memswap_limit: 384m`, `cpus: 1.0`, `pids_limit: 200`, `restart: unless-stopped`, log rotation `max-size: 10m`, `max-file: 3`.
- The relay container mounts **only** `data/`. No `docker.sock`, no home directories, no `~/.claude`, no repositories, no provider credentials: hosting the relay gives the NAS no ability to run Claude, and the relay itself refuses local execution.
- Keep it out of the Gluetun network namespace: a service using `network_mode: service:gluetun` would push relay and Funnel traffic through the VPN. The audit lists container network modes to confirm nothing shared is reused.
- Tailnet admin (human): create an auth key for a tagged node, **disable key expiry for that node** (expiry would silently take the relay offline), and scope the `funnel` node attribute to that tag if Funnel is used.
- Backup/restore: `backup.mjs` and `restore.mjs` unchanged, run against `data/` with the relay stopped for restore. Add the copy to the NAS's off-NVMe backup.

Alternative if a sidecar node is unwanted: `network_mode: host` with the host's tailscaled serving `127.0.0.1:3443`. It works but puts relay ports on the shared host loopback and ties the relay to the host's Tailscale configuration, so it is second choice.

## 6. Availability: what the user loses

| Event | Effect | V1 acceptable? |
| --- | --- | --- |
| Fibre or box outage | Relay unreachable from the Internet. Nodes elsewhere keep retrying; runs already on a node continue but are unobserved; nothing is lost in the database | Yes for V1 (same accepted outage as the VPS), but the relay's value ("reachable while home machines are off") is gone exactly when the home line is the failure. Matters only for nodes outside the home |
| Power cut | Laptop battery may bridge a short cut (battery health and charge policy unknown). Beyond that, relay down until power and boot; whether the machine boots on AC return is a firmware setting, unknown | Yes if boot-on-AC is confirmed |
| NAS reboot | Back after Docker and Tailscale start, about 1 to 2 minutes, if `restart: unless-stopped` and Docker enabled at boot | Yes, and the reboot test must include the relay |
| Tunnel stopped / Tailscale down / node key expired | Relay unreachable although the NAS is up | Yes only with key expiry disabled and the state volume persisted; otherwise silent outage |
| Lid closed or idle suspend | Laptop may suspend and take everything down | **No** until logind/lid behaviour is verified (audit reads it) |
| Relay database lost | Accounts, node enrolments, pairings, project mappings lost; nodes must re-enrol | Only with a verified off-NVMe copy |

## 7. Smallest plan and public tests

Stages stop at the first failed gate; nothing in Stage 0 to 1 touches a Jarvis service.

**Stage 0: measure (owner action: give SSH access or run the script).** `ssh <user>@nas-hub 'bash -s' < deploy/nas-hub/audit-readonly.sh > nas-hub-audit.txt`. Gates: MemAvailable at least 2 GB with Jarvis running; load average under ~50% of 8 threads; disk at least 40 GB free and under 70% used; 3001/3443 free only if host networking is chosen; lid/suspend disabled; Docker and Tailscale enabled at boot; no relay-relevant container in a shared netns; Gluetun not shared.

**Stage 1: build (Compose project, no exposure).** Changes required in this repository (not done here): `Dockerfile` (multi-stage, non-root), `compose.yaml` with the hardening above, a Tailscale serve/funnel config file, `smoke-remote.mjs --no-http-redirect`. Run `verify-install.sh` logic in the build (native modules load, relay boots, gateway/CSP/`/source` behave). Gate: image builds within its bounded budget and Jarvis containers keep their status and load.

**Stage 2: tailnet-only (Serve).** Serve the sidecar to the tailnet, then from a tailnet device run `smoke-remote.mjs <url> --no-http-redirect`, then `smoke-browser.mjs <url> --expect-online=0`, then with a node enrolled `--expect-online=1`, then stop it and repeat with 0. Also reboot-survival of the relay and a backup/restore rehearsal.

**Stage 3: public (Funnel), only if wanted.** Additional gates: (a) `smoke-browser.mjs` wss check passes through Funnel; (b) per-client limiter test from two networks (5 wrong pairings on network A throttle A only, network B is still judged); (c) `smoke-remote.mjs --probe-rate-limit` last. Then the phone's own browser pairing and a real Claude turn on a node (physical steps).

**Stop criteria:** any Jarvis container leaving `Up` or restarting, sustained load or memory pressure attributable to the build or relay, OOM-kill of the relay, disk over 85%, wss failing through the chosen path, the client-IP gate failing when the owner will not accept a shared bucket, or a smoke FAIL that is not explained.

**Rollback (touches nothing of Jarvis):** `docker compose -p cloudcli-relay down`; in the sidecar `tailscale funnel reset` (or delete the node in the Tailscale admin console and drop its ACL attribute); remove `/srv/cloudcli-relay` after keeping the last backup. Router and DNS are never touched in A/B.

## 8. Jarvis preconditions before any public exposure (not handled here)

| Class | Precondition |
| --- | --- |
| **Blocking** | Independent, off-NVMe backup validated (restore rehearsed), and the relay data added to it: the NVMe is a single point of failure |
| **Blocking** | Full reboot of nas-hub validated with all Jarvis services returning, so the relay is added to a known-good boot, then re-tested once after deployment |
| **Blocking** | Suspend/lid/power behaviour and boot-on-AC confirmed (laptop hardware) |
| **Blocking (public only)** | Firewall state known: Docker-published ports bypass ufw, so the new project publishes none; Funnel ACL scoped to the relay node |
| Important | Free disk and growth known; automatic-updates reboot window known; someone watches the relay (compose healthcheck plus the Jarvis alerting, if any) |
| Later | Standby/second host, log retention beyond Docker rotation |

## 9. Not inspected

Everything on nas-hub: real CPU/RAM/load, disk use and growth, container list, ports, networks, subnets, volumes, restart policies, firewall, Node/Docker/Compose/Tailscale versions, power and lid configuration, connectivity, backup evidence, last full reboot. Also not tested: any Linux build, WebSockets and real client address through Serve/Funnel, and the ISP/box situation. The PROJECT_MASTER was not touched; this NAS decision must be consolidated by `/maj` after the owner validates it.
