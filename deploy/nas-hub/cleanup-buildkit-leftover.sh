#!/usr/bin/env bash
# One-off, targeted cleanup of the ONE image left on nas-hub by the first private test run
# (2026-09-25): moby/buildkit:buildx-stable-1, id 28a898719c18, pulled by `docker buildx create
# --driver docker-container` when the test builder cloudcli-relay-test-builder was made. The run
# report shows it absent from the starting image list and present after cleanup, and every other
# resource of the run (container, volume, image, builder, cache) was removed.
#
# Default is a DRY RUN: it prints the identity evidence and what it would do, and changes nothing.
#   ssh robin@192.168.1.145 'bash -s' < deploy/nas-hub/cleanup-buildkit-leftover.sh
# To remove it, after reading the evidence (still no sudo, no prune, no -f):
#   ssh robin@192.168.1.145 'bash -s -- --apply' < deploy/nas-hub/cleanup-buildkit-leftover.sh
#
# It refuses (and removes nothing) unless ALL of these hold: the tag exists with an id starting
# 28a898719c18; no container in any state references the image; no buildx builder exists that
# could use it; no Compose project under /opt/nas names it; it is the only tag on that id.
set -uo pipefail
REF="moby/buildkit:buildx-stable-1"
ID_PREFIX="28a898719c18"
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
refuse() { echo "REFUSED: $1"; exit 1; }

main() {
  local id users builders refs tags
  id="$(docker image inspect -f '{{.Id}}' "$REF" 2>/dev/null)" || refuse "$REF is not present (nothing to clean, or already removed)"
  echo "== identity"
  docker image inspect -f 'id={{.Id}}
tags={{.RepoTags}}
created(upstream build)={{.Created}}
lastTagTime={{.Metadata.LastTagTime}}' "$REF" 2>&1
  case "${id#sha256:}" in "$ID_PREFIX"*) ;; *) refuse "id ${id#sha256:} does not start with $ID_PREFIX: this is not the image recorded in the run report" ;; esac

  echo "== who could be using it"
  users="$(docker ps -a -q --filter "ancestor=$id" 2>&1)" || refuse "cannot list containers: $users"
  echo "containers (any state) referencing it: [${users}]"
  [ -z "$users" ] || refuse "a container references this image"
  builders="$(docker buildx ls 2>&1)" || builders="(buildx not available)"
  echo "$builders" | sed 's/^/buildx: /'
  echo "$builders" | grep -q "cloudcli-relay-test-builder" && refuse "the test builder still exists"
  echo "$builders" | grep -i -q "docker-container" && refuse "a docker-container buildx builder exists and could depend on this image"
  refs="$(grep -rhs -E '^\s*image:\s*.*buildkit' /opt/nas/compose 2>/dev/null || true)"
  echo "Compose image: lines under /opt/nas naming buildkit: [${refs}]"
  [ -z "$refs" ] || refuse "a Compose project names buildkit"
  tags="$(docker images --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}' | grep -c "^$id " || true)"
  echo "tags on this id: $tags"
  [ "$tags" = "1" ] || refuse "the id carries $tags tags"

  if [ "$APPLY" = 1 ]; then
    docker rmi "$REF" && echo "removed $REF ($id)" || refuse "docker rmi failed"
    docker image inspect "$REF" >/dev/null 2>&1 && refuse "$REF is still present" || echo "verified: $REF no longer exists"
    docker system df | sed 's/^/  /'
  else
    echo "DRY RUN: all conditions hold; re-run with --apply to remove $REF"
  fi
}
main
