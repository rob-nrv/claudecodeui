#!/usr/bin/env bash
# Private Linux build + test of the CloudCLI Hosted Relay on nas-hub. Run it ON nas-hub, as a
# user in the docker group (no sudo, no root). The archive must be a `git archive` of a commit,
# and that commit id must be passed too, so the script can prove what it built:
#   EXPECT=$(git rev-parse HEAD)
#   git archive --format=tar "$EXPECT" | ssh robin@nas-hub 'cat > /tmp/cloudcli-ctx.tar'
#   ssh robin@nas-hub "bash -s -- /tmp/cloudcli-ctx.tar $EXPECT" < deploy/nas-hub/private-test.sh
# Read-only state check of the existing containers, without building anything:
#   ssh robin@nas-hub 'bash -s -- --snapshot-only' < deploy/nas-hub/private-test.sh
#
# Guarantees: the test container has NO network (network_mode none), publishes no port, mounts no
# host path and no docker.sock. Every resource this script creates carries the cloudcli-relay-test
# name or is one it can prove it pulled itself (the buildx builder image); on exit, also on
# failure, it removes exactly those, then compares the whole state with the starting one. It
# never runs docker prune, never edits a Compose file or a network, never restarts or recreates
# an existing container.
#
# Verdict rule: every failed check, every collection command that did not succeed, every
# difference that is not explained and every resource left behind adds a FAIL; the line
# "RESULT: ALL CHECKS PASSED" is printed only when there is not a single one.
set -uo pipefail

PROJECT=cloudcli-relay-test
IMAGE=cloudcli-relay:nas-test
BUILDER=cloudcli-relay-test-builder
BUILDER_CREATED=0
W="$(mktemp -d /tmp/cloudcli-relay-test.XXXXXX)"
CTX=""
CID=""
declare -a FAILS=()

say() { printf '\n===== %s =====\n' "$1"; }
bad() { FAILS+=("$1"); echo "FAIL  $1"; }

# collect <outfile> <label> <command...>: run a collection command; a non-zero status is a FAIL and
# leaves an empty file, never a silently shorter list.
collect() {
  local out="$1" label="$2" tmp rc
  shift 2
  tmp="$("$@" 2>"$W/collect.err")"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    bad "collection failed (exit $rc): $label: $(head -c 200 "$W/collect.err" | tr '\n' ' ')"
    : > "$out"
    return 1
  fi
  printf '%s\n' "$tmp" | sed '/^$/d' | sort > "$out"
}

listen_sockets() { ss -ltnH | awk '{print $4}'; }

# Fields of `docker inspect -f '{{json .State}}'`. Health is optional, so its absence is "none"
# instead of a template error, and nothing depends on Go-template map semantics.
state_status() { printf '%s' "$1" | sed -n 's/^{"Status":"\([^"]*\)".*/\1/p'; }
state_started() { printf '%s' "$1" | sed -n 's/.*"StartedAt":"\([^"]*\)".*/\1/p'; }
state_health() {
  local h
  h="$(printf '%s' "$1" | sed -n 's/.*"Health":{"Status":"\([^"]*\)".*/\1/p')"
  printf '%s' "${h:-none}"
}

# snapshot_state <label>: containers (with the full state of every container that is not ours),
# images by full id, networks, volumes and host listening sockets.
snapshot_state() {
  local label="$1" d="$W/$1" c head sj status started rc expected got
  mkdir -p "$d"
  collect "$d/containers" "docker ps -a ($label)" docker ps -a --format '{{.Names}}' || true
  : > "$d/existing"
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    case "$c" in "${PROJECT}"-*) continue ;; esac
    head="$(docker inspect -f '{{.Id}} restarts={{.RestartCount}} name={{.Name}}' "$c" 2>"$W/collect.err")"; rc=$?
    if [ "$rc" -ne 0 ] || [ -z "$head" ]; then bad "collection failed: docker inspect $c ($label): $(head -c 160 "$W/collect.err")"; continue; fi
    sj="$(docker inspect -f '{{json .State}}' "$c" 2>"$W/collect.err")"; rc=$?
    if [ "$rc" -ne 0 ] || [ -z "$sj" ]; then bad "collection failed: docker inspect state of $c ($label)"; continue; fi
    status="$(state_status "$sj")"; started="$(state_started "$sj")"
    if [ -z "$status" ] || [ -z "$started" ]; then bad "unreadable state for container $c ($label)"; continue; fi
    echo "$c $head status=$status started=$started health=$(state_health "$sj")" >> "$d/existing"
  done < "$d/containers"
  sort -o "$d/existing" "$d/existing"
  expected="$(grep -vc "^${PROJECT}-" "$d/containers" || true)"
  got="$(wc -l < "$d/existing" | tr -d ' ')"
  [ "$expected" = "$got" ] || bad "collected the state of $got of $expected existing containers ($label): the comparison would be partial"
  [ "${expected:-0}" -gt 0 ] || bad "no existing container found ($label): refusing to compare an empty set"
  collect "$d/images" "docker images ($label)" docker images --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}' || true
  collect "$d/networks" "docker network ls ($label)" docker network ls --format '{{.Name}}' || true
  collect "$d/volumes" "docker volume ls ($label)" docker volume ls --format '{{.Name}}' || true
  collect "$d/listen" "ss -ltn ($label)" listen_sockets || true
}

describe_image() { # id
  docker image inspect -f 'id={{.Id}} created={{.Created}} tags={{.RepoTags}} lastTagTime={{.Metadata.LastTagTime}}' "$1" 2>&1 | head -2
  echo "  containers (any state) referencing it: [$(docker ps -a -q --filter "ancestor=$1" 2>&1 | tr '\n' ' ')]"
}

# Removes an image that appeared during this run ONLY if its identity is established:
# the tag we built, or the buildkit image pulled by the builder this run created; it must not be
# used by any container, and it is removed without force. Everything else new is a FAIL.
reclaim_test_images() {
  local id ref users rc
  collect "$W/now.images" "docker images (reclaim)" docker images --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}' || return 0
  while read -r id ref; do
    [ -n "$id" ] || continue
    case "$ref" in
      "$IMAGE") ;;
      moby/buildkit:*) [ "$BUILDER_CREATED" = 1 ] || { bad "unexplained new image $ref ($id): no builder was created by this run"; describe_image "$id"; continue; } ;;
      *) bad "unexplained new image $ref ($id): not removed"; describe_image "$id"; continue ;;
    esac
    users="$(docker ps -a -q --filter "ancestor=$id" 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ]; then bad "cannot check who uses $ref ($id): $users"; continue; fi
    if [ -n "$users" ]; then bad "new image $ref ($id) is referenced by container(s) $users: left in place"; describe_image "$id"; continue; fi
    echo "provenance of $ref: $(docker image inspect -f 'id={{.Id}} created={{.Created}}' "$id" 2>&1 | head -1)"
    if docker rmi "$ref" >/dev/null 2>&1 && ! docker image inspect "$id" >/dev/null 2>&1; then
      echo "removed $ref ($id): created by this run, unused by any container"
    else
      bad "could not remove $ref ($id)"; describe_image "$id"
    fi
  done < <(comm -13 "$W/before/images" "$W/now.images")
}

compare_states() {
  local kind
  for kind in containers networks volumes listen images existing; do
    if [ ! -s "$W/before/$kind" ] && [ "$kind" != volumes ]; then bad "starting-state list '$kind' is empty: nothing to compare against"; continue; fi
    if ! diff -u "$W/before/$kind" "$W/after/$kind" > "$W/diff.$kind"; then
      bad "$kind differ from the starting state"
      sed 's/^/    /' "$W/diff.$kind" | head -30
    fi
  done
}

check_commit_identity() { # <tar> <expected commit>
  local got
  if [ -z "${2:-}" ]; then bad "no expected commit was given: the archive identity is not asserted"; return 1; fi
  if ! command -v git >/dev/null 2>&1; then bad "git is not available to read the archive commit id"; return 1; fi
  got="$(git get-tar-commit-id < "$1" 2>/dev/null)"
  if [ -z "$got" ]; then bad "the archive carries no commit id (it must come from git archive of a commit)"; return 1; fi
  if [ "$got" != "$2" ]; then bad "the archive is commit $got, expected $2"; return 1; fi
  echo "PASS  the archive is exactly commit $got (sha256 $(sha256sum "$1" | cut -d' ' -f1), $(wc -c < "$1" | tr -d ' ') bytes)"
}

verdict() {
  local f
  if [ "${#FAILS[@]}" -eq 0 ]; then
    echo "RESULT: ALL CHECKS PASSED"
    return 0
  fi
  echo "RESULT: FAILED (${#FAILS[@]})"
  for f in "${FAILS[@]}"; do echo "  - $f"; done
  return 1
}

compose() {
  tar -xOf "$CTX" deploy/nas-hub/compose.yaml | RELAY_IMAGE="$IMAGE" RELAY_NETWORK_MODE=none CLOUDCLI_REMOTE_ORIGIN=https://relay.test.invalid \
    docker compose -f - -p "$PROJECT" "$@"
}

wait_healthy() {
  local _
  for _ in $(seq 1 45); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$CID" 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  return 1
}

cleanup() {
  local rc
  say "cleanup (only what this run created)"
  if [ -n "$CTX" ]; then
    compose down --volumes --remove-orphans 2>&1 | tail -3
    [ "${PIPESTATUS[0]}" -eq 0 ] || bad "docker compose down failed"
    if docker image inspect "$IMAGE" >/dev/null 2>&1; then docker rmi "$IMAGE" >/dev/null 2>&1 && echo "removed image $IMAGE" || bad "could not remove image $IMAGE"; fi
    if [ "$BUILDER_CREATED" = 1 ]; then docker buildx rm --force "$BUILDER" >/dev/null 2>&1 && echo "removed builder $BUILDER" || bad "could not remove buildx builder $BUILDER"; fi
    reclaim_test_images
    docker ps -a --format '{{.Names}}' | grep -q "^${PROJECT}-" && bad "a $PROJECT container is still present"
    docker volume ls --format '{{.Name}}' | grep -q "^${PROJECT}_" && bad "a $PROJECT volume is still present"
  fi
  snapshot_state after
  echo "-- comparison with the starting state (each difference is a FAIL):"
  compare_states
  echo "-- existing containers (id, restarts, status, StartedAt, health), before then after:"
  sed 's/^/  before: /' "$W/before/existing" | cut -c1-200
  sed 's/^/  after:  /' "$W/after/existing" | cut -c1-200
  docker system df 2>&1 | sed 's/^/  /'
  echo "-- the pieces below are proven by the checks above, not by this line: the test volume, the test image, the builder and its cache no longer exist"
  [ -z "$CTX" ] || rm -f "$CTX"
  rm -rf "$W"
  echo "temporary directory and context tar removed"
  verdict
  rc=$?
  exit "$rc"
}

# Sourced by the self-test with PT_LIB_ONLY=1: functions only, nothing runs.
if [ "${PT_LIB_ONLY:-0}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

main() {
  local START BUILD BK COUNT users_before users_after ports mode mounts VPASS label
  trap 'rm -rf "$W"' EXIT

  if [ "${1:-}" = "--snapshot-only" ]; then
    say "read-only state of the existing containers"
    snapshot_state now
    cat "$W/now/existing" | cut -c1-200
    verdict
    exit $?
  fi

  CTX="${1:?usage: private-test.sh <context.tar> <commit> | --snapshot-only}"
  local EXPECT_COMMIT="${2:-}"
  [ -f "$CTX" ] || { echo "context tar not found: $CTX"; exit 2; }
  trap cleanup EXIT

  say "starting state (read-only)"
  docker version --format 'docker {{.Server.Version}}' || bad "docker version failed"
  docker compose version || bad "docker compose version failed"
  snapshot_state before
  cut -c1-200 "$W/before/existing"
  uptime
  free -m | sed -n 1,2p
  df -h / | tail -1

  say "identity of what is built"
  check_commit_identity "$CTX" "$EXPECT_COMMIT"

  say "build on Debian 13 (native modules compiled here)"
  if docker buildx version >/dev/null 2>&1 && docker buildx create --name "$BUILDER" --driver docker-container >/dev/null 2>&1; then
    BUILDER_CREATED=1
    BUILD=(buildx build --builder "$BUILDER" --load)
    echo "dedicated buildx builder: it and its cache are removed at the end (no prune)"
  else
    BUILD=(build)
    echo "buildx unavailable: default builder; a leftover build cache would be reported as a FAIL, never pruned"
  fi
  START=$(date +%s)
  if nice -n 19 docker "${BUILD[@]}" -f deploy/nas-hub/Dockerfile -t "$IMAGE" --build-arg "SOURCE_COMMIT=$EXPECT_COMMIT" - < "$CTX" > "$W/build.log" 2>&1; then
    echo "PASS  image built in $(( $(date +%s) - START ))s, size $(docker images --format '{{.Size}}' "$IMAGE")"
  else
    bad "build failed"
    tail -25 "$W/build.log"
    exit 1
  fi
  label="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE" 2>/dev/null)"
  if [ -n "$EXPECT_COMMIT" ] && [ "$label" = "$EXPECT_COMMIT" ]; then echo "PASS  the image is labelled with commit $label"; else bad "image revision label is '$label', expected '$EXPECT_COMMIT'"; fi
  docker run --rm --network none --entrypoint node "$IMAGE" -e "const D=require('better-sqlite3');new D(':memory:').exec('select 1');require('bcrypt').hashSync('x',4);require('node-pty');console.log('PASS  native modules load on '+process.platform+' '+process.arch+', node '+process.version)" || bad "native modules do not load"

  say "private service (network_mode none, no published port, no host mount)"
  compose up -d relay 2>&1 | tail -5
  [ "${PIPESTATUS[0]}" -eq 0 ] || bad "docker compose up failed"
  CID="$(compose ps -q relay)"
  if [ -z "$CID" ]; then bad "the test container does not exist"; exit 1; fi
  if wait_healthy; then echo "PASS  container healthy"; else bad "container not healthy"; docker logs --tail 30 "$CID"; fi

  say "no public port"
  ports="$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$CID")"
  mode="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CID")"
  if [ "$ports" = "{}" ] || [ "$ports" = "null" ]; then echo "PASS  no port mapping ($ports)"; else bad "published ports: $ports"; fi
  if [ "$mode" = none ]; then echo "PASS  network mode none: no interface but loopback"; else bad "network mode is $mode"; fi
  mounts="$(docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Destination}} {{end}}' "$CID")"
  if echo "$mounts" | grep -q -E 'bind:|docker.sock'; then bad "a bind mount or docker.sock is present: $mounts"; else echo "PASS  only a named volume is mounted: $mounts"; fi
  docker inspect -f 'limits: mem={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} nanocpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}} readonly={{.HostConfig.ReadonlyRootfs}} caps_dropped={{.HostConfig.CapDrop}} secopt={{.HostConfig.SecurityOpt}} user={{.Config.User}}' "$CID"

  say "in-container verification"
  VPASS="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | cut -c1-24)Aa1"
  docker exec -e VERIFY_PASSWORD="$VPASS" "$CID" node deploy/verify-container.mjs --expect-loopback-only || bad "in-container verification reported failures"

  say "backup and restore rehearsal (test volume only)"
  docker exec -e BACKUP_DIR=/data/backups "$CID" node deploy/backup.mjs || bad "backup failed"
  BK="$(docker exec "$CID" sh -c 'ls /data/backups/relay-*.db | tail -1' 2>/dev/null)"
  [ -n "$BK" ] || bad "no backup file was produced"
  COUNT='const D=require("better-sqlite3");console.log(new D(process.env.DATABASE_PATH,{readonly:true}).prepare("select count(*) c from users").get().c)'
  users_before="$(docker exec "$CID" node -e "$COUNT")"
  compose stop relay >/dev/null 2>&1 || bad "could not stop the test relay"
  docker run --rm --network none --read-only --cap-drop ALL --user 10001:10001 -v "${PROJECT}_relay-data:/data" -e DATABASE_PATH=/data/relay.db --entrypoint node "$IMAGE" deploy/restore.mjs "$BK" || bad "restore failed"
  compose start relay >/dev/null 2>&1 || bad "could not start the test relay after restore"
  wait_healthy || bad "relay not healthy after restore"
  users_after="$(docker exec "$CID" node -e "$COUNT" 2>/dev/null)"
  if [ -n "$users_after" ] && [ "$users_before" = "$users_after" ]; then echo "PASS  restored database serves again, accounts before/after: $users_before/$users_after"; else bad "restore: accounts $users_before -> $users_after"; fi

  say "restart survival (this container only)"
  docker restart "$CID" >/dev/null 2>&1 || bad "could not restart the test container"
  if wait_healthy; then echo "PASS  relay healthy again after a restart of its own container"; else bad "not healthy after restart"; fi

  say "resource use while running"
  docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}} pids={{.PIDs}}' "$CID" || bad "docker stats failed"
  uptime
  docker logs --tail 5 "$CID" 2>&1 | cut -c1-160 | sed 's/^/log: /'
}
main "$@"
