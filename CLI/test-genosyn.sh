#!/usr/bin/env bash
# Tests for the pure helpers in `genosyn`. No docker, no network.
#
#   ./CLI/test-genosyn.sh
#
# Sources `genosyn` rather than invoking it, so the helpers are testable
# without running a command. The source guard at the bottom of `genosyn` is
# what makes that safe.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./genosyn
source "${HERE}/genosyn"

pass=0
fail=0

check() {
  local label="$1" actual="$2" expected="$3"
  if [ "${actual}" = "${expected}" ]; then
    pass=$((pass + 1))
    printf '  ok   %s\n' "${label}"
  else
    fail=$((fail + 1))
    printf '  FAIL %s\n         expected: %s\n         actual:   %s\n' \
      "${label}" "${expected}" "${actual}"
  fi
}

echo "image_repo — tag stripping"
check "tagged ghcr ref" \
  "$(image_repo 'ghcr.io/genosyn/app:latest')" 'ghcr.io/genosyn/app'
check "tagged ghcr ref, semver" \
  "$(image_repo 'ghcr.io/genosyn/app:1.10.0')" 'ghcr.io/genosyn/app'
check "untagged ghcr ref" \
  "$(image_repo 'ghcr.io/genosyn/app')" 'ghcr.io/genosyn/app'
check "bare name, tagged" \
  "$(image_repo 'app:latest')" 'app'
check "bare name, untagged" \
  "$(image_repo 'app')" 'app'

echo "image_repo — registry ports (the colon that is not a tag)"
check "tagged ported ref" \
  "$(image_repo 'localhost:5000/app:1.10.0')" 'localhost:5000/app'
# The regression. Naive ${IMAGE%:*} yields 'localhost' here, whose glob then
# matches every image from that registry.
check "untagged ported ref" \
  "$(image_repo 'localhost:5000/app')" 'localhost:5000/app'
check "untagged ported ref, nested path" \
  "$(image_repo 'registry:5000/team/app')" 'registry:5000/team/app'
check "tagged ported ref, nested path" \
  "$(image_repo 'registry:5000/team/app:2.0')" 'registry:5000/team/app'

echo "image_repo — digests"
check "digest ref" \
  "$(image_repo 'ghcr.io/genosyn/app@sha256:abc123')" 'ghcr.io/genosyn/app'
check "tag + digest ref" \
  "$(image_repo 'ghcr.io/genosyn/app:1.10.0@sha256:abc123')" 'ghcr.io/genosyn/app'
check "ported digest ref" \
  "$(image_repo 'localhost:5000/app@sha256:abc123')" 'localhost:5000/app'
check "bare name digest ref" \
  "$(image_repo 'app@sha256:abc123')" 'app'

# What prune actually asks: "is this image one of ours?" Same-repo refs must
# match regardless of how they're written; anything else must not -- especially
# a bystander image that merely shares a registry host.
echo "prune repo matching — same repo matches, bystanders do not"
same_repo() {
  [ "$(image_repo "$1")" = "$(image_repo "$2")" ] && echo yes || echo no
}
check "ours, different tag" \
  "$(same_repo 'ghcr.io/genosyn/app:latest' 'ghcr.io/genosyn/app:1.9.0')" 'yes'
check "ours, by digest" \
  "$(same_repo 'ghcr.io/genosyn/app:latest' 'ghcr.io/genosyn/app@sha256:abc')" 'yes'
check "sibling image is not ours" \
  "$(same_repo 'ghcr.io/genosyn/app:latest' 'ghcr.io/genosyn/home:latest')" 'no'
check "unrelated registry is not ours" \
  "$(same_repo 'ghcr.io/genosyn/app:latest' 'docker.io/library/postgres:16')" 'no'
check "ported: ours matches ours" \
  "$(same_repo 'localhost:5000/app' 'localhost:5000/app:1.10.0')" 'yes'
# The data-loss case: pruning an untagged ported ref must not sweep up an
# unrelated image that happens to live on the same host:port.
check "ported: bystander on same registry is not ours" \
  "$(same_repo 'localhost:5000/app' 'localhost:5000/postgres:16')" 'no'
check "ported: bystander under another path is not ours" \
  "$(same_repo 'registry:5000/team/app' 'registry:5000/other/db:1')" 'no'

printf '\n%d passed, %d failed\n' "${pass}" "${fail}"
[ "${fail}" -eq 0 ]
