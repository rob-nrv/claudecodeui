#!/usr/bin/env bash
# CloudCLI Hosted Relay on nas-hub: staged, journaled installation (Tailscale Serve, tailnet only).
# Runs ON nas-hub as the login user (docker group, no sudo), from an extracted release:
#   bash ~/cloudcli-relay/current/deploy/nas-hub/install.sh <stage> [args]
# Stages, in order (each prints "STAGE <name>: OK" or "STAGE <name>: FAILED (n)"):
#   verify-release <sha>   check that the extracted release is the expected commit
#   snapshot-before        READ-ONLY state of Jarvis containers, images, networks, volumes, sockets
#   prepare                create compose/ and relay.env (mode 0600) under ~/cloudcli-relay
#   preflight              docker compose config (validation only)
#   build                  build cloudcli-relay:nas with a temporary buildx builder, then remove it
#   sidecar-up             start the Tailscale container; print the one-time login link to YOUR terminal
#   status                 read-only view of containers, tailnet login, name, serve/funnel state
#   set-origin             set the public origin from the node's own tailnet name
#   relay-up               start the relay (shares the sidecar loopback, no port, no network of its own)
#   host-probe             HTTPS probe of the tailnet URL from this host (read-only)
#   bootstrap-account      create the first account (prompts on your terminal; nothing is logged)
#   pairing-code           issue a one-time browser pairing code (prompts for the account)
#   backup                 WAL-safe backup of the relay database, copied to ~/cloudcli-relay/backups
#   recreate-test          down (volumes kept) then up: state, login and data must persist
#   restart-policy-test    kill only the relay container: Docker must restart it by policy
#   final-compare          Jarvis containers and host sockets identical; only expected additions
#   uninstall [--apply]    dry run by default: what removal would delete
# Every real change is appended to ~/cloudcli-relay/journal.log as CHANGE; audits are READ.
# Never touched: any Jarvis container, network, volume, Compose file, firewall, host tailscaled.
set -uo pipefail

ROOT="$HOME/cloudcli-relay"
REL="$(cd "$(dirname "$0")/../.." && pwd)"
JOURNAL="$ROOT/journal.log"
COMPOSE_DIR="$ROOT/compose"
ENVF="$ROOT/relay.env"
IMAGE=cloudcli-relay:nas
BUILDER=cloudcli-relay-build-builder
RELAYC=cloudcli-relay-relay-1
TSC=cloudcli-relay-tailscale-1
TSSOCK=/tmp/tailscaled.sock

mkdir -p "$ROOT"
# shellcheck disable=SC1091
PT_LIB_ONLY=1 source "$REL/deploy/nas-hub/private-test.sh"
rm -rf "$W"
W="$ROOT/snapshots"
PROJECT=cloudcli-relay
FAILS=()

journal() { # kind text
  printf '%s | %-6s | %s\n' "$(date -u +%FT%TZ)" "$1" "$2" >> "$JOURNAL"
  echo "[$1] $2"
}
dc() { docker compose -p "$PROJECT" --env-file "$ENVF" -f "$COMPOSE_DIR/compose.yaml" --profile tailscale "$@"; }
tsjson() { docker exec "$TSC" tailscale --socket="$TSSOCK" status --json 2>/dev/null; }
ts_state() { tsjson | sed -n 's/.*"BackendState": *"\([^"]*\)".*/\1/p' | head -1; }
ts_fqdn() { tsjson | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1; }
relay_health() { docker inspect -f '{{.State.Health.Status}}' "$RELAYC" 2>/dev/null; }
wait_relay_healthy() { local _; for _ in $(seq 1 60); do [ "$(relay_health)" = healthy ] && return 0; sleep 2; done; return 1; }
user_count() { docker exec "$RELAYC" node -e 'const D=require("better-sqlite3");console.log(new D(process.env.DATABASE_PATH,{readonly:true}).prepare("select count(*) c from users").get().c)' 2>/dev/null; }
stage_end() { # name
  if [ "${#FAILS[@]}" -eq 0 ]; then echo "STAGE $1: OK"; return 0; fi
  echo "STAGE $1: FAILED (${#FAILS[@]})"; local f; for f in "${FAILS[@]}"; do echo "  - $f"; done; return 1
}
need_before() { [ -s "$W/before/existing" ] || { echo "no starting snapshot: run snapshot-before first"; exit 2; }; }

# Expected additions only: existing containers and host sockets must be IDENTICAL; everything new
# must match what this installation is allowed to create; nothing may disappear.
check_additions() { # kind regex
  local kind="$1" re="$2" line
  if comm -23 "$W/before/$kind" "$W/after/$kind" | grep -q .; then bad "$kind: something present before has disappeared: $(comm -23 "$W/before/$kind" "$W/after/$kind" | tr '\n' ';')"; fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if echo "$line" | grep -q -E "$re"; then echo "  expected addition ($kind): $line"; else bad "$kind: unexpected addition: $line"; fi
  done < <(comm -13 "$W/before/$kind" "$W/after/$kind")
}
compare_install() {
  local kind
  for kind in existing listen; do
    if ! diff -u "$W/before/$kind" "$W/after/$kind" > "$W/diff.$kind"; then bad "$kind differ from the starting state"; sed 's/^/    /' "$W/diff.$kind" | head -30; fi
  done
  check_additions containers '^cloudcli-relay-(relay|tailscale)-1$'
  check_additions images ' (cloudcli-relay:nas|tailscale/tailscale:[^ ]+)$'
  check_additions networks '^cloudcli-relay_default$'
  check_additions volumes '^cloudcli-relay_(relay-data|ts-state)$'
}

cmd="${1:-}"; shift || true
case "$cmd" in

verify-release)
  sha="${1:?usage: verify-release <sha>}"
  [ -f "$REL/COMMIT" ] || bad "no COMMIT file in the release"
  [ "$(cat "$REL/COMMIT" 2>/dev/null)" = "$sha" ] || bad "release commit is '$(cat "$REL/COMMIT" 2>/dev/null)', expected $sha"
  [ "$(basename "$REL")" = "$sha" ] || bad "release directory is $(basename "$REL"), expected $sha"
  [ -f "$REL/deploy/nas-hub/compose.yaml" ] || bad "compose.yaml missing from the release"
  [ -f "$REL/TAR.sha256" ] && echo "archive sha256 as received on the NAS: $(cut -d' ' -f1 "$REL/TAR.sha256") (compare with Get-FileHash on your PC)"
  if [ "${#FAILS[@]}" -eq 0 ]; then
    ln -sfn "releases/$sha" "$ROOT/current"
    journal CHANGE "created $ROOT, $REL (extracted git archive, commit id read from the archive = $sha), symlink $ROOT/current"
  fi
  stage_end "$cmd"
  ;;

snapshot-before)
  if [ -s "$W/before/existing" ]; then echo "a starting snapshot already exists ($(stat -c %y "$W/before/existing")): not overwritten"; else
    snapshot_state before
    journal READ "starting state captured under $W/before (containers with full state, images by id, networks, volumes, host listening sockets)"
  fi
  echo "-- existing containers:"; cut -c1-190 "$W/before/existing"
  echo "-- host listening sockets:"; tr '\n' ' ' < "$W/before/listen"; echo
  stage_end "$cmd"
  ;;

prepare)
  need_before
  mkdir -p "$COMPOSE_DIR" "$ROOT/backups"
  cp "$REL"/deploy/nas-hub/compose.yaml "$REL"/deploy/nas-hub/serve-tailnet.json "$REL"/deploy/nas-hub/serve-funnel.json "$COMPOSE_DIR/"
  if [ -f "$ENVF" ]; then echo "$ENVF exists: kept"; else
    umask 077
    cat > "$ENVF" <<EOF
RELAY_IMAGE=$IMAGE
RELAY_NETWORK_MODE=service:tailscale
CLOUDCLI_REMOTE_ORIGIN=https://pending.invalid
CLOUDCLI_SOURCE_URL=
TS_HOSTNAME=cloudcli-relay
TS_SERVE_FILE=serve-tailnet.json
EOF
    journal CHANGE "created $ENVF (mode 0600, no secret: image, network mode, placeholder origin, empty source URL, hostname, serve file = tailnet only)"
  fi
  chmod 600 "$ENVF"
  journal CHANGE "copied compose.yaml, serve-tailnet.json, serve-funnel.json to $COMPOSE_DIR; created $ROOT/backups"
  stage_end "$cmd"
  ;;

preflight)
  need_before
  if dc config -q 2>&1; then echo "PASS  compose file and environment are valid"; else bad "docker compose config failed"; fi
  grep -q '^TS_SERVE_FILE=serve-tailnet.json$' "$ENVF" && echo "PASS  serve file is the tailnet-only one (Funnel off)" || bad "TS_SERVE_FILE is not serve-tailnet.json"
  grep -q '"AllowFunnel": *{ *"\${TS_CERT_DOMAIN}:443": *false' "$COMPOSE_DIR/serve-tailnet.json" && echo "PASS  serve-tailnet.json sets AllowFunnel false" || bad "AllowFunnel is not false in serve-tailnet.json"
  dc config 2>/dev/null | grep -E '^\s+(published|ports):' && bad "the compose file publishes a port" || echo "PASS  no published port in the rendered configuration"
  journal READ "docker compose config validated (no change)"
  stage_end "$cmd"
  ;;

build)
  need_before
  docker buildx create --name "$BUILDER" --driver docker-container >/dev/null 2>&1 || { bad "cannot create the buildx builder"; stage_end "$cmd"; exit 1; }
  journal CHANGE "created temporary buildx builder $BUILDER (pulls moby/buildkit:buildx-stable-1 if absent)"
  start=$(date +%s)
  if nice -n 19 docker buildx build --builder "$BUILDER" --load -f "$REL/deploy/nas-hub/Dockerfile" -t "$IMAGE" --build-arg "SOURCE_COMMIT=$(cat "$REL/COMMIT")" "$REL" > "$ROOT/build.log" 2>&1; then
    journal CHANGE "built image $IMAGE in $(( $(date +%s) - start ))s from release $(cat "$REL/COMMIT") (log: $ROOT/build.log)"
  else
    bad "build failed, see $ROOT/build.log"; tail -20 "$ROOT/build.log"
  fi
  docker buildx rm --force "$BUILDER" >/dev/null 2>&1 && journal CHANGE "removed builder $BUILDER and its cache" || bad "could not remove builder $BUILDER"
  bk="$(docker images --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}' | grep ' moby/buildkit:' || true)"
  if [ -n "$bk" ]; then
    bkid="${bk%% *}"; bkref="${bk#* }"
    if grep -q "^$bkid " "$W/before/images"; then echo "$bkref was present before this installation: left in place"
    elif [ -n "$(docker ps -a -q --filter "ancestor=$bkid")" ]; then bad "$bkref is used by a container: left in place"
    elif docker rmi "$bkref" >/dev/null 2>&1; then journal CHANGE "removed $bkref ($bkid): pulled by this installation's builder, unused by any container"
    else bad "could not remove $bkref"; fi
  fi
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "image: $(docker image inspect -f 'id={{.Id}} size={{.Size}} revision={{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")"
    [ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")" = "$(cat "$REL/COMMIT")" ] && echo "PASS  image label = release commit" || bad "image label differs from the release commit"
    docker run --rm --network none --entrypoint node "$IMAGE" -e "const D=require('better-sqlite3');new D(':memory:').exec('select 1');require('bcrypt').hashSync('x',4);require('node-pty');console.log('PASS  native modules load on '+process.platform+' '+process.arch+', node '+process.version)" || bad "native modules do not load"
  else bad "image $IMAGE does not exist"; fi
  stage_end "$cmd"
  ;;

sidecar-up)
  need_before
  dc up -d tailscale 2>&1 | tail -6
  [ "${PIPESTATUS[0]}" -eq 0 ] || bad "docker compose up tailscale failed"
  journal CHANGE "started container $TSC (image tailscale/tailscale:stable, volume ts-state, network cloudcli-relay_default, no published port, TS_USERSPACE=true, serve config = tailnet only)"
  echo "image digest: $(docker image inspect -f '{{index .RepoDigests 0}}' "$(docker inspect -f '{{.Image}}' "$TSC")" 2>/dev/null)"
  shown=0
  for _ in $(seq 1 120); do
    st="$(ts_state)"
    if [ "$st" = "Running" ]; then break; fi
    if [ "$st" = "NeedsLogin" ] && [ "$shown" = 0 ]; then
      url="$(tsjson | sed -n 's/.*"AuthURL": *"\([^"]*\)".*/\1/p' | head -1)"
      if [ -n "$url" ]; then
        if [ -w /dev/tty ]; then
          printf '\n>>> Open this one-time link in YOUR browser and approve the device (do not paste it anywhere):\n>>> %s\n\n' "$url" > /dev/tty
        else
          echo "no terminal available to show the login link safely: run this stage again with ssh -t"; bad "cannot show the login link"; break
        fi
        shown=1
      fi
    fi
    sleep 5
  done
  st="$(ts_state)"
  if [ "$st" = Running ]; then
    fq="$(ts_fqdn)"; echo "$fq" > "$ROOT/fqdn"
    journal CHANGE "tailscale node logged in; tailnet name $fq stored in $ROOT/fqdn (a new device in the owner's tailnet)"
    echo "tailnet name of the relay node: $fq"
  else
    bad "tailscale is '$st' (login not completed within the wait); re-run this stage after approving the device"
  fi
  stage_end "$cmd"
  ;;

status)
  echo "-- containers of the project"; docker ps -a --filter "name=^${PROJECT}-" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}'
  echo "-- tailscale node"; echo "state: $(ts_state)"; echo "name:  $(ts_fqdn)"
  echo "cert domains: $(tsjson | tr -d '\n ' | sed -n 's/.*"CertDomains":\(\[[^]]*\]\|null\).*/\1/p')"
  echo "-- serve (tailnet) and funnel (public) configuration as seen by the node"
  docker exec "$TSC" tailscale --socket="$TSSOCK" serve status 2>&1 | head -12
  docker exec "$TSC" tailscale --socket="$TSSOCK" funnel status 2>&1 | head -6
  echo "-- relay"; echo "health: $(relay_health)"
  docker inspect -f 'netmode={{.HostConfig.NetworkMode}} ports={{json .NetworkSettings.Ports}} restart={{.HostConfig.RestartPolicy.Name}} restarts={{.RestartCount}} started={{.State.StartedAt}}' "$RELAYC" 2>&1
  docker inspect -f 'sidecar: ports={{json .NetworkSettings.Ports}} restart={{.HostConfig.RestartPolicy.Name}} restarts={{.RestartCount}} started={{.State.StartedAt}}' "$TSC" 2>&1
  for c in "$RELAYC" "$TSC"; do
    [ "$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$c" 2>/dev/null)" = "{}" ] || bad "$c publishes a port"
  done
  journal READ "status view (no change)"
  stage_end "$cmd"
  ;;

set-origin)
  fq="$(cat "$ROOT/fqdn" 2>/dev/null)"
  echo "$fq" | grep -q -E '^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$' || { bad "no valid tailnet name stored (run sidecar-up first): '$fq'"; stage_end "$cmd"; exit 1; }
  sed -i "s#^CLOUDCLI_REMOTE_ORIGIN=.*#CLOUDCLI_REMOTE_ORIGIN=https://$fq#" "$ENVF"
  journal CHANGE "set CLOUDCLI_REMOTE_ORIGIN=https://$fq in $ENVF"
  stage_end "$cmd"
  ;;

relay-up)
  grep -q 'pending.invalid' "$ENVF" && { bad "origin is still the placeholder: run set-origin"; stage_end "$cmd"; exit 1; }
  dc up -d 2>&1 | tail -6
  [ "${PIPESTATUS[0]}" -eq 0 ] || bad "docker compose up failed"
  journal CHANGE "started container $RELAYC (image $IMAGE, volume relay-data, network mode container:$TSC, user 10001, read-only rootfs, 384 MiB, 1 CPU, 200 pids, json-file 10m x3)"
  if wait_relay_healthy; then echo "PASS  relay healthy"; else bad "relay not healthy"; docker logs --tail 20 "$RELAYC" 2>&1 | cut -c1-200; fi
  echo "-- what the relay logged at start"; docker logs "$RELAYC" 2>&1 | grep -E "Relay\]" | cut -c1-200
  docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Destination}} {{end}}' "$RELAYC" | grep -q -E 'bind:|docker.sock' && bad "the relay has a bind mount or docker.sock" || echo "PASS  relay mounts: $(docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Destination}} {{end}}' "$RELAYC")"
  for c in "$RELAYC" "$TSC"; do [ "$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$c")" = "{}" ] && echo "PASS  $c publishes no port" || bad "$c publishes a port"; done
  echo "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$RELAYC")" | grep -q "^container:" && echo "PASS  relay shares the sidecar network namespace and has none of its own" || bad "relay network mode is not container:<sidecar>"
  docker inspect -f 'limits: mem={{.HostConfig.Memory}} nanocpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}} readonly={{.HostConfig.ReadonlyRootfs}} user={{.Config.User}} capdrop={{.HostConfig.CapDrop}}' "$RELAYC"
  stage_end "$cmd"
  ;;

host-probe)
  fq="$(cat "$ROOT/fqdn" 2>/dev/null)"; url="https://$fq"
  echo "probing $url from this host over the tailnet (read-only)"
  code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>&1; }
  h="$(curl -sS --max-time 15 "$url/health" 2>&1)"; echo "GET /health -> $h"
  [ "$h" = '{"status":"ok"}' ] && echo "PASS  HTTPS answers with a valid certificate; remote /health discloses liveness only" || bad "unexpected /health answer"
  hdr="$(curl -sS -D - -o /dev/null --max-time 15 "$url/" 2>&1 | tr -d '\r')"
  echo "$hdr" | grep -i -E '^(HTTP|content-security-policy|strict-transport|x-frame|x-content-type)' | cut -c1-160
  echo "$hdr" | grep -qi "content-security-policy: default-src 'self'" && echo "PASS  CSP present" || bad "CSP missing"
  [ "$(code "$url/api/projects")" = 401 ] && echo "PASS  unauthenticated /api/projects -> 401" || bad "/api/projects is not 401"
  [ "$(code -X POST -H 'Content-Type: application/json' -H "Origin: $url" -d '{}' "$url/api/auth/login")" = 403 ] && echo "PASS  password login refused on the public origin" || bad "login not refused"
  echo "certificate: $(echo | curl -sS -v --max-time 15 "$url/health" 2>&1 | grep -E 'issuer:|expire date:|SSL connection using' | tr '\n' ' ' | cut -c1-260)"
  journal READ "host probe of $url (health, CSP, 401, login refused)"
  stage_end "$cmd"
  ;;

bootstrap-account|pairing-code)
  [ -w /dev/tty ] || { echo "run with ssh -t: the credentials are typed on your terminal"; exit 2; }
  read -r -p "Relay username: " RELAY_USERNAME < /dev/tty
  read -r -s -p "Relay password (typed here, never stored or logged): " RELAY_PASSWORD < /dev/tty; echo > /dev/tty
  if [ "$cmd" = bootstrap-account ]; then
    read -r -s -p "Repeat the password: " again < /dev/tty; echo > /dev/tty
    [ "$again" = "$RELAY_PASSWORD" ] || { echo "passwords differ"; exit 2; }
    export RELAY_USERNAME RELAY_PASSWORD
    docker exec -e RELAY_USERNAME -e RELAY_PASSWORD "$RELAYC" node deploy/relay-admin.mjs register && journal CHANGE "first account created in the relay database (credentials not logged)" || bad "account creation failed"
  else
    export RELAY_USERNAME RELAY_PASSWORD
    docker exec -e RELAY_USERNAME -e RELAY_PASSWORD "$RELAYC" node deploy/relay-admin.mjs pairing-code > "$W/pair.out" 2>&1 && cat "$W/pair.out" > /dev/tty || { bad "pairing code not issued: $(cat "$W/pair.out")"; }
    rm -f "$W/pair.out"
    journal CHANGE "a one-time pairing code was issued (single use, 10 min; the code itself is not logged)"
  fi
  unset RELAY_PASSWORD again
  stage_end "$cmd"
  ;;

backup)
  docker exec -e BACKUP_DIR=/data/backups "$RELAYC" node deploy/backup.mjs || bad "backup failed"
  f="$(docker exec "$RELAYC" sh -c 'ls /data/backups/relay-*.db | tail -1' 2>/dev/null)"
  if [ -n "$f" ] && docker cp "$RELAYC:$f" "$ROOT/backups/" ; then
    b="$ROOT/backups/$(basename "$f")"; chmod 600 "$b"
    journal CHANGE "backup $b ($(stat -c %s "$b") bytes, sha256 $(sha256sum "$b" | cut -d' ' -f1)); a copy inside the relay volume at $f. This copy is on the SAME NVMe: it is not an independent backup."
    echo "copy it off the NAS from your PC, e.g.: scp robin@192.168.1.145:$b <folder outside the repository>"
  else bad "backup file could not be copied"; fi
  stage_end "$cmd"
  ;;

recreate-test)
  before="$(user_count)"; fq="$(ts_fqdn)"
  echo "accounts before: $before, node name: $fq"
  journal CHANGE "recreate-test: docker compose down (volumes kept) then up -d, for project $PROJECT only"
  dc down 2>&1 | tail -4; [ "${PIPESTATUS[0]}" -eq 0 ] || bad "compose down failed"
  dc up -d 2>&1 | tail -4; [ "${PIPESTATUS[0]}" -eq 0 ] || bad "compose up failed"
  for _ in $(seq 1 60); do [ "$(ts_state)" = Running ] && break; sleep 2; done
  [ "$(ts_state)" = Running ] && echo "PASS  tailscale Running again without a new login" || bad "tailscale is '$(ts_state)' after recreation"
  [ "$(ts_fqdn)" = "$fq" ] && echo "PASS  same tailnet name $fq" || bad "tailnet name changed to '$(ts_fqdn)'"
  wait_relay_healthy && echo "PASS  relay healthy" || bad "relay not healthy"
  after="$(user_count)"; [ -n "$after" ] && [ "$before" = "$after" ] && echo "PASS  relay data persisted (accounts $before -> $after)" || bad "accounts $before -> $after"
  docker exec "$TSC" tailscale --socket="$TSSOCK" serve status 2>&1 | grep -q "proxy http://127.0.0.1:3443" && echo "PASS  serve configuration re-applied (proxy to 127.0.0.1:3443)" || bad "serve configuration not present"
  stage_end "$cmd"
  ;;

restart-policy-test)
  n0="$(docker inspect -f '{{.RestartCount}}' "$RELAYC")"
  journal CHANGE "restart-policy-test: docker kill (SIGKILL) of $RELAYC only; Docker must restart it (policy unless-stopped)"
  docker kill "$RELAYC" >/dev/null || bad "docker kill failed"
  for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Running}}' "$RELAYC" 2>/dev/null)" = true ] && [ "$(docker inspect -f '{{.RestartCount}}' "$RELAYC")" -gt "$n0" ] && break; sleep 2; done
  n1="$(docker inspect -f '{{.RestartCount}}' "$RELAYC")"
  [ "$n1" -gt "$n0" ] && echo "PASS  restarted by policy (RestartCount $n0 -> $n1)" || bad "not restarted by Docker"
  wait_relay_healthy && echo "PASS  relay healthy after the automatic restart" || bad "relay not healthy after the automatic restart"
  echo "NOTE  a full NAS reboot is not exercised here (Jarvis owns that validation): docker is enabled at boot and both containers use restart: unless-stopped"
  stage_end "$cmd"
  ;;

final-compare)
  snapshot_state after
  journal READ "final state captured under $W/after"
  compare_install
  echo "-- Jarvis containers, before then after:"
  sed 's/^/  before: /' "$W/before/existing" | cut -c1-190; sed 's/^/  after:  /' "$W/after/existing" | cut -c1-190
  echo "-- host listening sockets: before $(tr '\n' ' ' < "$W/before/listen")"; echo "                          after  $(tr '\n' ' ' < "$W/after/listen")"
  docker system df | sed 's/^/  /'
  stage_end "$cmd"
  ;;

uninstall)
  echo "Removal plan (only what this installation created):"
  echo "  docker compose -p $PROJECT down --volumes   (containers $RELAYC, $TSC; volumes ${PROJECT}_relay-data, ${PROJECT}_ts-state; network ${PROJECT}_default)"
  echo "  docker rmi $IMAGE; docker rmi tailscale/tailscale:stable (only if no other container uses it)"
  echo "  rm -rf $ROOT   (journal, backups, releases, snapshots; keep $ROOT/backups if you want the backup)"
  echo "  Tailscale admin console: delete the machine ${PROJECT}. Nothing of Jarvis, the host tailscaled, the router or DNS is touched."
  if [ "${1:-}" = "--apply" ]; then
    dc down --volumes --remove-orphans; journal CHANGE "uninstall: compose down --volumes"
    docker rmi "$IMAGE" >/dev/null 2>&1 && journal CHANGE "uninstall: removed image $IMAGE"
    if [ -z "$(docker ps -a -q --filter ancestor=tailscale/tailscale:stable)" ]; then docker rmi tailscale/tailscale:stable >/dev/null 2>&1 && journal CHANGE "uninstall: removed image tailscale/tailscale:stable"; fi
    echo "Now remove $ROOT yourself after keeping what you need (this script does not delete its own journal)."
  else echo "DRY RUN: add --apply to run the docker part."; fi
  ;;

*)
  sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
  ;;
esac
