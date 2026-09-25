#!/usr/bin/env bash
# Private Linux build + test of the CloudCLI Hosted Relay on nas-hub. Run it ON nas-hub, as a
# user in the docker group (no sudo, no root):
#   ssh robin@nas-hub 'bash -s -- /tmp/cloudcli-ctx.tar' < deploy/nas-hub/private-test.sh
# where /tmp/cloudcli-ctx.tar is `git archive --format=tar <commit>` copied there first.
#
# Guarantees: the test container has NO network (network_mode none), publishes no port, mounts no
# host path and no docker.sock. Every resource this script creates carries the cloudcli-relay-test
# name; on exit (also on failure) it removes exactly those, then proves that containers, images,
# networks and volumes are back to their starting set and that the existing services were not
# touched. It never runs docker prune, never edits a Compose file or a network, never restarts or
# recreates an existing container.
set -uo pipefail
CTX="${1:?usage: private-test.sh <context.tar>}"
[ -f "$CTX" ] || { echo "context tar not found: $CTX"; exit 2; }
PROJECT=cloudcli-relay-test
IMAGE=cloudcli-relay:nas-test
BUILDER=cloudcli-relay-test-builder
W="$(mktemp -d /tmp/cloudcli-relay-test.XXXXXX)"
fail=0
CID=""
say() { printf '\n===== %s =====\n' "$1"; }

snapshot() { # $1 = label; existing (Jarvis) containers only: the test container is excluded by name
  docker ps -a --format '{{.Names}}' | sort > "$W/$1.containers"
  docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | sort > "$W/$1.images"
  docker network ls --format '{{.Name}}' | sort > "$W/$1.networks"
  docker volume ls --format '{{.Name}}' | sort > "$W/$1.volumes"
  : > "$W/$1.jarvis"
  for c in $(docker ps -a --format '{{.Names}}' | grep -v "^${PROJECT}-"); do
    docker inspect "$c" --format '{{.Name}} id={{.Id}} started={{.State.StartedAt}} restarts={{.RestartCount}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' >> "$W/$1.jarvis"
  done
  sort -o "$W/$1.jarvis" "$W/$1.jarvis"
  ss -ltnH 2>/dev/null | awk '{print $4}' | sort -u > "$W/$1.listen"
}

compose() {
  tar -xOf "$CTX" deploy/nas-hub/compose.yaml | RELAY_IMAGE="$IMAGE" RELAY_NETWORK_MODE=none CLOUDCLI_REMOTE_ORIGIN=https://relay.test.invalid \
    docker compose -f - -p "$PROJECT" "$@"
}

wait_healthy() {
  for _ in $(seq 1 45); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$CID" 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  return 1
}

cleanup() {
  say "cleanup (only cloudcli-relay-test resources)"
  compose down --volumes --remove-orphans 2>&1 | tail -3
  docker rmi "$IMAGE" >/dev/null 2>&1 && echo "removed image $IMAGE"
  docker buildx rm --force "$BUILDER" >/dev/null 2>&1 && echo "removed builder $BUILDER"
  # The base image is removed only if it was not present before this run.
  grep -q '^node:22-trixie-slim ' "$W/before.images" 2>/dev/null || { docker rmi node:22-trixie-slim >/dev/null 2>&1 && echo "removed base image node:22-trixie-slim (was not present before)"; }
  snapshot after
  echo "-- leftovers vs. the starting state (nothing listed below means clean):"
  for kind in containers images networks volumes; do diff "$W/before.$kind" "$W/after.$kind" | sed "s/^/  $kind: /"; done
  echo "-- existing containers before/after (id, StartedAt, RestartCount, status, health):"
  if diff "$W/before.jarvis" "$W/after.jarvis"; then echo "  IDENTICAL: no existing container was recreated, restarted or changed state"; else echo "  FAIL DIFFERENCE (see above)"; fail=1; fi
  echo "-- host listening sockets before/after:"
  if diff "$W/before.listen" "$W/after.listen"; then echo "  IDENTICAL"; else echo "  FAIL DIFFERENCE (see above)"; fail=1; fi
  docker system df 2>&1 | sed 's/^/  /'
  rm -rf "$W" "$CTX"
  echo "temporary directory and context tar removed"
  if [ "$fail" = 0 ]; then echo "RESULT: ALL CHECKS PASSED"; else echo "RESULT: FAILURES (see FAIL lines above)"; fi
  exit "$fail"
}

# Everything below runs inside main() so that bash has parsed it in full before any command runs:
# no command can then swallow the rest of the script when it is fed through ssh on stdin.
main() {
say "starting state (read-only)"
docker version --format 'docker {{.Server.Version}}'
docker compose version
snapshot before
cut -c1-150 "$W/before.jarvis"
uptime
free -m | sed -n 1,2p
df -h / | tail -1
trap cleanup EXIT

say "build on Debian 13 (native modules compiled here)"
if docker buildx version >/dev/null 2>&1 && docker buildx create --name "$BUILDER" --driver docker-container >/dev/null 2>&1; then
  BUILD=(buildx build --builder "$BUILDER" --load)
  echo "dedicated buildx builder: its cache disappears with it (no prune needed)"
else
  BUILD=(build)
  echo "buildx unavailable: default builder; leftover build cache will be reported, never pruned"
fi
START=$(date +%s)
if nice -n 19 docker "${BUILD[@]}" -f deploy/nas-hub/Dockerfile -t "$IMAGE" - < "$CTX" > "$W/build.log" 2>&1; then
  echo "PASS  image built in $(( $(date +%s) - START ))s, size $(docker images --format '{{.Size}}' "$IMAGE")"
else
  echo "FAIL  build failed; last lines:"
  tail -25 "$W/build.log"
  fail=1
  exit 1
fi
docker run --rm --network none --entrypoint node "$IMAGE" -e "const D=require('better-sqlite3');new D(':memory:').exec('select 1');require('bcrypt').hashSync('x',4);require('node-pty');console.log('PASS  native modules load on '+process.platform+' '+process.arch+', node '+process.version)" || { echo "FAIL  native modules"; fail=1; }

say "private service (network_mode none, no published port, no host mount)"
compose up -d relay 2>&1 | tail -5
CID="$(compose ps -q relay)"
if wait_healthy; then echo "PASS  container healthy"; else echo "FAIL  health=$(docker inspect -f '{{.State.Health.Status}}' "$CID" 2>/dev/null)"; docker logs --tail 30 "$CID"; fail=1; fi

say "no public port"
ports="$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$CID")"
mode="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CID")"
if [ "$ports" = "{}" ] || [ "$ports" = "null" ]; then echo "PASS  no port mapping ($ports)"; else echo "FAIL  ports $ports"; fail=1; fi
if [ "$mode" = none ]; then echo "PASS  network mode none: no interface but loopback"; else echo "FAIL  network mode $mode"; fail=1; fi
mounts="$(docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Destination}} {{end}}' "$CID")"
if echo "$mounts" | grep -q -E 'bind:|docker.sock'; then echo "FAIL  a bind mount or docker.sock is present: $mounts"; fail=1; else echo "PASS  only a named volume is mounted: $mounts"; fi
docker inspect -f 'limits: mem={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} nanocpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}} readonly={{.HostConfig.ReadonlyRootfs}} caps_dropped={{.HostConfig.CapDrop}} secopt={{.HostConfig.SecurityOpt}} user={{.Config.User}}' "$CID"

say "in-container verification"
VPASS="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | cut -c1-24)Aa1"
docker exec -e VERIFY_PASSWORD="$VPASS" "$CID" node deploy/verify-container.mjs --expect-loopback-only || fail=1

say "backup and restore rehearsal (test volume only)"
docker exec -e BACKUP_DIR=/data/backups "$CID" node deploy/backup.mjs || fail=1
BK="$(docker exec "$CID" sh -c 'ls /data/backups/relay-*.db | tail -1' 2>/dev/null)"
COUNT='const D=require("better-sqlite3");console.log(new D(process.env.DATABASE_PATH,{readonly:true}).prepare("select count(*) c from users").get().c)'
users_before="$(docker exec "$CID" node -e "$COUNT")"
compose stop relay >/dev/null 2>&1
docker run --rm --network none --read-only --cap-drop ALL --user 10001:10001 -v "${PROJECT}_relay-data:/data" -e DATABASE_PATH=/data/relay.db --entrypoint node "$IMAGE" deploy/restore.mjs "$BK" || fail=1
compose start relay >/dev/null 2>&1
wait_healthy
users_after="$(docker exec "$CID" node -e "$COUNT" 2>/dev/null)"
if [ "$users_before" = "$users_after" ] && [ -n "$users_after" ]; then echo "PASS  restored database serves again, accounts before/after: $users_before/$users_after"; else echo "FAIL  restore: $users_before -> $users_after"; fail=1; fi

say "restart survival (this container only)"
docker restart "$CID" >/dev/null 2>&1
if wait_healthy; then echo "PASS  relay healthy again after a restart of its own container"; else echo "FAIL  not healthy after restart"; fail=1; fi

say "resource use while running"
docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}} pids={{.PIDs}}' "$CID"
uptime
docker logs --tail 5 "$CID" 2>&1 | cut -c1-160 | sed 's/^/log: /'
}
main
