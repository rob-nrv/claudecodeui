#!/usr/bin/env bash
# Self-test of the verdict logic of private-test.sh WITHOUT Docker and without the 160 s build:
# `docker`, `ss` and `git` are replaced by shell functions that serve canned answers, so the
# cases that produced a false "ALL CHECKS PASSED" on nas-hub can be replayed anywhere with bash 4+.
#   bash deploy/nas-hub/private-test.selftest.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export PT_LIB_ONLY=1
# shellcheck disable=SC1091
source "$HERE/private-test.sh"
set +e   # the library sets -e-free options; failures are asserted explicitly below

declare -A STATE HEAD USERS
CONTAINERS=()
IMAGES=()
NETWORKS=(bridge host none)
VOLUMES=()
LISTEN=("0.0.0.0:22" "0.0.0.0:8096")
INSPECT_FAIL=""
PS_RC=0
SS_RC=0
RMI_FAIL=0
RMI_LOG=()
TAR_ID=""

docker() {
  case "$1" in
    ps)
      if [[ "$*" == *"--filter ancestor="* ]]; then
        local all="$*" id; id="${all##*ancestor=}"; id="${id%% *}"
        printf '%s' "${USERS[$id]:-}"; [ -n "${USERS[$id]:-}" ] && echo; return 0
      fi
      [ "$PS_RC" -eq 0 ] || { echo "Cannot connect to the Docker daemon" >&2; return "$PS_RC"; }
      [ "${#CONTAINERS[@]}" -eq 0 ] || printf '%s\n' "${CONTAINERS[@]}"
      ;;
    inspect)
      local name="${4:-}"
      if [ "$INSPECT_FAIL" = "$name" ]; then echo "template parsing error: map has no entry for key \"Health\"" >&2; return 1; fi
      case "$3" in
        *json*) printf '%s\n' "${STATE[$name]:-}" ;;
        *) printf '%s\n' "${HEAD[$name]:-}" ;;
      esac
      ;;
    image)
      [ "$2" = inspect ] || return 1
      local ref="${@: -1}" line
      for line in "${IMAGES[@]}"; do [[ "$line" == "$ref "* || "$line" == *" $ref" ]] && { echo "id=$ref created=2026-09-25T19:00:00Z"; return 0; }; done
      return 1
      ;;
    images) [ "${#IMAGES[@]}" -eq 0 ] || printf '%s\n' "${IMAGES[@]}" ;;
    network) printf '%s\n' "${NETWORKS[@]}" ;;
    volume) [ "${#VOLUMES[@]}" -eq 0 ] || printf '%s\n' "${VOLUMES[@]}" ;;
    rmi)
      RMI_LOG+=("$2"); [ "$RMI_FAIL" -eq 0 ] || return 1
      local kept=() line
      for line in "${IMAGES[@]}"; do [[ "$line" == *" $2" ]] || kept+=("$line"); done
      IMAGES=("${kept[@]}")
      ;;
    *) echo "stub: unsupported docker $*" >&2; return 99 ;;
  esac
}
ss() { [ "$SS_RC" -eq 0 ] || return "$SS_RC"; printf 'LISTEN 0 4096 %s 0.0.0.0:*\n' "${LISTEN[@]}"; }
git() { [ "$1" = get-tar-commit-id ] && { printf '%s' "$TAR_ID"; [ -z "$TAR_ID" ] || echo; return 0; }; return 1; }

NOHEALTH='{"Status":"running","Running":true,"Paused":false,"StartedAt":"2026-09-24T13:58:43.257620057Z","FinishedAt":"0001-01-01T00:00:00Z"}'
HEALTHY='{"Status":"running","Running":true,"StartedAt":"2026-09-24T13:58:43.268376261Z","FinishedAt":"0001-01-01T00:00:00Z","Health":{"Status":"healthy","FailingStreak":0,"Log":[]}}'

reset() {
  FAILS=(); CONTAINERS=(gluetun jellyfin portainer); INSPECT_FAIL=""; PS_RC=0; SS_RC=0; RMI_FAIL=0; RMI_LOG=(); USERS=(); BUILDER_CREATED=0
  STATE=([gluetun]="$HEALTHY" [jellyfin]="$HEALTHY" [portainer]="$NOHEALTH")
  HEAD=([gluetun]="26f4713 restarts=0 name=/gluetun" [jellyfin]="e5411e4 restarts=0 name=/jellyfin" [portainer]="a1b2c3d restarts=0 name=/portainer")
  IMAGES=("sha256:aaa jellyfin/jellyfin:latest" "sha256:bbb qmcgaw/gluetun:v3")
  VOLUMES=()
  rm -rf "$W/before" "$W/after" "$W/now.images"
}

results=0
ok() { echo "PASS  selftest: $1"; }
ko() { echo "FAIL  selftest: $1"; results=1; }
has_fail() { local f; for f in "${FAILS[@]}"; do [[ "$f" == *"$1"* ]] && return 0; done; return 1; }
expect_clean() { if [ "${#FAILS[@]}" -eq 0 ]; then ok "$1"; else ko "$1 (unexpected: ${FAILS[*]})"; fi; }
expect_fail() { if has_fail "$2"; then ok "$1"; else ko "$1 (no FAIL containing '$2'; got: ${FAILS[*]:-none})"; fi; }
run_verdict() { local out; out="$(verdict)"; local rc=$?; echo "$out" | grep -q 'ALL CHECKS PASSED'; echo "$rc/$?"; }

# 1. Mixed containers with and without Health: all are collected, health is none or healthy.
reset; snapshot_state before; snapshot_state after; compare_states
expect_clean "containers with and without Health are all collected and identical"
[ "$(wc -l < "$W/before/existing" | tr -d ' ')" = 3 ] && grep -q 'portainer .*health=none' "$W/before/existing" && grep -q 'gluetun .*health=healthy' "$W/before/existing" \
  && ok "the state file has 3 lines with health none/healthy" || ko "state file content: $(cat "$W/before/existing")"

# 2. A collection command that fails is a FAIL, never a shorter list.
reset; INSPECT_FAIL=portainer; snapshot_state before
expect_fail "failed docker inspect is reported" "collection failed: docker inspect portainer"
expect_fail "a partial collection is reported as partial" "the comparison would be partial"
reset; PS_RC=1; snapshot_state before
expect_fail "docker ps failure is reported" "collection failed (exit 1): docker ps"
expect_fail "an empty existing set is refused" "refusing to compare an empty set"
reset; SS_RC=2; snapshot_state before
expect_fail "ss failure is reported" "collection failed (exit 2): ss -ltn"
reset; STATE[jellyfin]=""; snapshot_state before
expect_fail "an unreadable state is reported" "collection failed: docker inspect state of jellyfin"

# 3. A change of an existing container between before and after is a FAIL.
reset; snapshot_state before; STATE[jellyfin]="${HEALTHY/2026-09-24T13:58:43.268376261Z/2026-09-25T21:31:00.000000000Z}"; snapshot_state after; compare_states
expect_fail "a changed StartedAt of an existing container is a FAIL" "existing differ"
reset; snapshot_state before; HEAD[gluetun]="deadbeef restarts=1 name=/gluetun"; snapshot_state after; compare_states
expect_fail "a changed id or restart count is a FAIL" "existing differ"
reset; snapshot_state before; NETWORKS+=(cloudcli-relay-test_default); snapshot_state after; compare_states
expect_fail "a leftover network is a FAIL" "networks differ"
reset; snapshot_state before; VOLUMES+=(cloudcli-relay-test_relay-data); snapshot_state after; compare_states
expect_fail "a leftover volume is a FAIL" "volumes differ"
reset; snapshot_state before; LISTEN+=("0.0.0.0:3001"); snapshot_state after; compare_states
expect_fail "a new host listening socket is a FAIL" "listen differ"

# 4. Images left behind: only proven test images are removed, without force, and only when unused.
reset; snapshot_state before
IMAGES+=("sha256:28a898719c18 moby/buildkit:buildx-stable-1"); BUILDER_CREATED=1; reclaim_test_images 2>/dev/null; snapshot_state after; compare_states
expect_clean "the buildkit image pulled by this run's builder is reclaimed"
[ "${RMI_LOG[*]:-}" = "moby/buildkit:buildx-stable-1" ] && ok "it was removed by tag, once, without force" || ko "rmi log: ${RMI_LOG[*]:-none}"
reset; snapshot_state before
IMAGES+=("sha256:28a898719c18 moby/buildkit:buildx-stable-1"); BUILDER_CREATED=0; reclaim_test_images >/dev/null 2>&1; snapshot_state after; compare_states >/dev/null 2>&1
expect_fail "a buildkit image without a builder created by this run is not removed" "unexplained new image moby/buildkit"
[ "${#RMI_LOG[@]}" -eq 0 ] && ok "and no rmi was attempted" || ko "rmi log: ${RMI_LOG[*]}"
reset; snapshot_state before
IMAGES+=("sha256:28a898719c18 moby/buildkit:buildx-stable-1"); BUILDER_CREATED=1; USERS[sha256:28a898719c18]="abc123"; reclaim_test_images >/dev/null 2>&1
expect_fail "a new image used by a container is left in place" "referenced by container(s)"
[ "${#RMI_LOG[@]}" -eq 0 ] && ok "and no rmi was attempted" || ko "rmi log: ${RMI_LOG[*]}"
reset; snapshot_state before
IMAGES+=("sha256:cafe1234 nginx:latest"); BUILDER_CREATED=1; reclaim_test_images >/dev/null 2>&1
expect_fail "an unknown new image is a FAIL and is never removed" "unexplained new image nginx:latest"
[ "${#RMI_LOG[@]}" -eq 0 ] && ok "and no rmi was attempted" || ko "rmi log: ${RMI_LOG[*]}"
reset; snapshot_state before
IMAGES+=("sha256:28a898719c18 moby/buildkit:buildx-stable-1"); BUILDER_CREATED=1; RMI_FAIL=1; reclaim_test_images >/dev/null 2>&1
expect_fail "a failing rmi is a FAIL" "could not remove moby/buildkit"
reset; snapshot_state before
IMAGES+=("sha256:beef0001 cloudcli-relay:nas-test"); reclaim_test_images >/dev/null 2>&1; snapshot_state after; compare_states
expect_clean "the test image is reclaimed"

# 5. Commit identity of the archive.
reset; TAR_ID="8738b9f4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; check_commit_identity /dev/null 8738b9f4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa >/dev/null
expect_clean "a matching archive commit is accepted"
reset; TAR_ID="1111111111111111111111111111111111111111"; check_commit_identity /dev/null 8738b9f4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa >/dev/null
expect_fail "a different archive commit is a FAIL" "the archive is commit 1111"
reset; TAR_ID=""; check_commit_identity /dev/null 8738b9f4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa >/dev/null
expect_fail "an archive without a commit id is a FAIL" "carries no commit id"
reset; TAR_ID="8738b9f4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; check_commit_identity /dev/null "" >/dev/null
expect_fail "no expected commit is a FAIL" "identity is not asserted"

# 6. The verdict line.
FAILS=(); [ "$(run_verdict)" = "0/0" ] && ok "no FAIL: exit 0 and ALL CHECKS PASSED" || ko "verdict without FAIL: $(run_verdict)"
FAILS=("x"); [ "$(run_verdict)" = "1/1" ] && ok "one FAIL: exit 1 and never ALL CHECKS PASSED" || ko "verdict with FAIL: $(run_verdict)"

rm -rf "$W"
[ "$results" = 0 ] && echo "SELFTEST OK" || echo "SELFTEST FAILED"
exit "$results"
