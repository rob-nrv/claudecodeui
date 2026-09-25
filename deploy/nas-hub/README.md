# CloudCLI Hosted Relay on nas-hub (Docker Compose, isolated)

Plan and reasoning: [docs/nas-hub-hosting-plan.md](../../docs/nas-hub-hosting-plan.md). This directory is the executable part. **Nothing here publishes a port, starts Funnel or touches a Jarvis container.** FT-M11 stays not validated for the DoD until the public proofs of the plan (section 7) exist.

## What is here

| File | Role |
| --- | --- |
| `Dockerfile` | Multi-stage build on `node:22-trixie-slim` (Node 22 as in `.nvmrc`, glibc like Debian 13). Native modules are rebuilt and load-checked at build time. Runs as uid 10001; image holds the built client and the relay only |
| `compose.yaml` | Project `cloudcli-relay`: the relay (hardened, limited, no published port) and an optional `tailscale` sidecar (profile `tailscale`) |
| `serve-tailnet.json`, `serve-funnel.json` | Tailscale serve configurations. Funnel is **off** in the first and **on** in the second; the second is not used until the Funnel gates pass |
| `relay.env.example` | Variables, no secrets |
| `verify-container.mjs` | In-container verification (isolation, health, CSP, auth, WebSocket, no local execution, client-address keying, logout) |
| `private-test.sh` | Builds and tests on nas-hub with no network, then removes exactly what it created and proves Jarvis is unchanged |
| `audit-readonly.sh`, `firewall-readonly.sh`, `backup-evidence-readonly.sh` | Read-only inventories (the firewall one needs interactive sudo) |

## Why this network design

The relay refuses to start unless its app listener **and** its gateway are on loopback (`HOST` and `CLOUDCLI_REMOTE_BIND` are checked). On a Docker bridge network a loopback-only listener cannot be reached through a published port, so publishing is not an option. Two designs keep the invariant:

1. **Sidecar (chosen):** the relay uses `network_mode: service:tailscale`. Relay and sidecar share one loopback; the sidecar's serve config proxies `https://<node>.<tailnet>.ts.net` to `http://127.0.0.1:3443`, which is exactly the `external-tls` mode already tested. No host port exists, nothing of Jarvis is involved (its Docker subnets are 172.17 to 172.21, Gluetun's namespace is not shared, host `tailscaled` is not reconfigured), and Tailscale runs in userspace mode without capabilities.
2. Host networking: rejected as first choice, it puts 3001/3443 on the shared host loopback and ties the relay to the host's Tailscale configuration.

For the private test the same compose file is used with `RELAY_NETWORK_MODE=none`: the container has no interface but loopback, so it cannot be reached from anywhere, and the tests run inside it with `docker exec`.

Not yet tested: the `tailscale` sidecar (needs a Tailscale auth key and HTTPS enabled for the tailnet; the audit shows `CertDomains: null`, so **HTTPS certificates are not enabled yet**: Tailscale admin console, DNS, Enable HTTPS). Its `read_only` root may need an extra `tmpfs`; adjust when first started.

## Private Linux test (no exposure)

From the repository, at the commit to test (working tree may be dirty; only the commit is shipped):

```bash
git archive --format=tar HEAD | ssh robin@192.168.1.145 'cat > /tmp/cloudcli-ctx.tar'
ssh robin@192.168.1.145 'bash -s -- /tmp/cloudcli-ctx.tar' < deploy/nas-hub/private-test.sh | tee nas-hub-private-test.txt
```

Each `ssh` asks for the login password once (interactive; never put it in a file). The script needs only the docker group. Expected end: `RESULT: ALL CHECKS PASSED`, no leftovers, existing containers `IDENTICAL`.

Optional read-only checks (need your interactive password, the second one needs sudo):

```bash
ssh robin@192.168.1.145 'bash -s' < deploy/nas-hub/backup-evidence-readonly.sh > nas-hub-backup-evidence.txt
ssh -t robin@192.168.1.145 'sudo bash -s' < deploy/nas-hub/firewall-readonly.sh > nas-hub-firewall.txt
```

## Real start, stop, restore (after the private test and the Jarvis preconditions)

State lives in two named volumes of project `cloudcli-relay` (`relay-data`, `ts-state`); secrets in `/srv/cloudcli-relay/relay.env` (mode 0600, outside the repository).

```bash
# one-time: build the image from the commit to run (same context method as above), tag cloudcli-relay:nas
git archive --format=tar <commit> | ssh robin@nas-hub 'docker build -f deploy/nas-hub/Dockerfile -t cloudcli-relay:nas -'
# compose files: copy deploy/nas-hub/{compose.yaml,serve-tailnet.json,serve-funnel.json} to /srv/cloudcli-relay/compose/
cd /srv/cloudcli-relay/compose
docker compose --env-file ../relay.env --profile tailscale up -d      # start (Serve, tailnet only)
docker compose --env-file ../relay.env --profile tailscale ps
docker compose --env-file ../relay.env --profile tailscale stop       # stop, state kept
docker compose --env-file ../relay.env --profile tailscale down       # remove containers, volumes kept
```

Backup (WAL-safe, inside the volume) and restore:

```bash
docker exec -e BACKUP_DIR=/data/backups cloudcli-relay-relay-1 node deploy/backup.mjs
docker cp cloudcli-relay-relay-1:/data/backups/. /path/on/another/disk/      # the copy that counts must leave the NVMe
docker compose --env-file ../relay.env --profile tailscale stop relay
docker run --rm --network none --read-only --cap-drop ALL --user 10001:10001 -v cloudcli-relay_relay-data:/data --entrypoint node cloudcli-relay:nas deploy/restore.mjs /data/backups/relay-<stamp>.db
docker compose --env-file ../relay.env --profile tailscale start relay
```

Funnel is a separate, gated step: set `TS_SERVE_FILE=serve-funnel.json` only after the plan's Funnel gates pass, and revert to `serve-tailnet.json` (then `up -d`) to stop it. Smoke commands per edge:

```bash
node deploy/hosted-relay/smoke-remote.mjs https://<node>.<tailnet>.ts.net --edge=tailscale-serve      # from a tailnet device
node deploy/hosted-relay/smoke-remote.mjs https://<node>.<tailnet>.ts.net --edge=tailscale-funnel     # from outside, later
```

## Rollback (touches nothing of Jarvis)

`docker compose --profile tailscale down`, `docker rmi cloudcli-relay:nas`, then optionally `docker volume rm cloudcli-relay_relay-data cloudcli-relay_ts-state` after keeping the last backup, delete the node in the Tailscale admin console and drop its ACL attribute. Router, DNS and the host `tailscaled` are never modified.
