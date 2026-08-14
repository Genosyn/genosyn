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

echo "user security commands — bootstrap and recovery invariants"
check "master-admin bootstrap requires verified email" \
  "$(grep -Fc "Verify this account's email before granting master-admin access." "${HERE}/genosyn")" '1'
check "master-admin bootstrap rotates existing sessions" \
  "$(grep -Fc '"isMasterAdmin" = TRUE, "sessionVersion" = "sessionVersion" + 1' "${HERE}/genosyn")" '1'
check "password recovery revokes API keys for both database drivers" \
  "$(grep -Fc 'UPDATE api_keys SET "revokedAt"' "${HERE}/genosyn")" '2'
check "password recovery rotates sessions for both database drivers" \
  "$(grep -Fc '"sessionVersion" = "sessionVersion" + 1 WHERE id' "${HERE}/genosyn")" '4'
check "user help advertises safe bootstrap command" \
  "$(cmd_user_help | grep -Fc 'grant-master-admin <email>')" '1'

echo "auto-update schedule — enable, refresh, disable"
test_root="$(mktemp -d -t genosyn-cli-test.XXXXXX)"
trap 'rm -rf "${test_root}"' EXIT
mkdir -p "${test_root}/bin" "${test_root}/state"
mock_crontab="${test_root}/crontab"
export MOCK_CRONTAB_FILE="${mock_crontab}"

cat >"${test_root}/bin/crontab" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -l)
    [ -f "${MOCK_CRONTAB_FILE}" ] || exit 1
    cat "${MOCK_CRONTAB_FILE}"
    ;;
  -)
    cat >"${MOCK_CRONTAB_FILE}"
    ;;
  -r)
    rm -f "${MOCK_CRONTAB_FILE}"
    ;;
  *) exit 2 ;;
esac
EOF
chmod +x "${test_root}/bin/crontab"

original_path="${PATH}"
PATH="${test_root}/bin:${PATH}"
AUTO_UPDATE_DIR="${test_root}/state"
NAME="genosyn-test"
PORT="9000"
VOLUME="genosyn-test-data"
IMAGE="ghcr.io/genosyn/app:latest"
UPGRADE_BACKUP_DIR="${test_root}/backups"
printf '%s\n' '5 2 * * * /usr/local/bin/backup' >"${mock_crontab}"

enable_auto_update 1
check "enable adds one cron entry" \
  "$(grep -Fc '# genosyn-auto-update:genosyn-test' "${mock_crontab}")" '1'
check "wrapper captures the custom port" \
  "$(grep -Fxc 'export GENOSYN_PORT=9000' "$(auto_update_wrapper_path)")" '1'
check "wrapper captures the backup directory" \
  "$(grep -Fxc "export GENOSYN_BACKUP_DIR=${test_root}/backups" "$(auto_update_wrapper_path)")" '1'
check "wrapper runs the safe upgrade command" \
  "$(grep -Fxc '  "${cli_path}" upgrade' "$(auto_update_wrapper_path)")" '1'

# Enabling again refreshes the wrapper and schedule instead of duplicating it.
enable_auto_update 1
check "re-enable remains idempotent" \
  "$(grep -Fc '# genosyn-auto-update:genosyn-test' "${mock_crontab}")" '1'

disable_auto_update 1
check "disable removes only the Genosyn cron entry" \
  "$(cat "${mock_crontab}")" '5 2 * * * /usr/local/bin/backup'
check "disable removes the generated wrapper" \
  "$([ ! -e "$(auto_update_wrapper_path)" ] && echo yes || echo no)" 'yes'
check "disable records the operator opt-out" \
  "$([ -e "$(auto_update_disabled_path)" ] && echo yes || echo no)" 'yes'

ensure_auto_update_default
check "manual upgrade respects the operator opt-out" \
  "$(grep -Fc '# genosyn-auto-update:genosyn-test' "${mock_crontab}")" '0'

rm -f "$(auto_update_disabled_path)"
ensure_auto_update_default
check "existing installs adopt the default-on schedule" \
  "$(grep -Fc '# genosyn-auto-update:genosyn-test' "${mock_crontab}")" '1'

PATH="${original_path}"
rm -rf "${test_root}"
trap - EXIT

echo "upgrade safety — optional backup and automatic rollback"
test_root="$(mktemp -d -t genosyn-cli-upgrade-test.XXXXXX)"
trap 'rm -rf "${test_root}"' EXIT
UPGRADE_BACKUP_DIR="${test_root}/backups"
NAME="genosyn-test"

generated_backup="$(upgrade_backup_path)"
case "$(basename "${generated_backup}")" in
  genosyn-pre-upgrade-genosyn-test-*.tar.gz) backup_name_ok=yes ;;
  *) backup_name_ok=no ;;
esac
check "pre-upgrade backup uses a dated instance-specific name" \
  "${backup_name_ok}" 'yes'
check "pre-upgrade backup directory is private" \
  "$(stat -c '%a' "${UPGRADE_BACKUP_DIR}" 2>/dev/null || stat -f '%Lp' "${UPGRADE_BACKUP_DIR}")" '700'

rollback_log="${test_root}/rollback.log"
docker() {
  printf 'docker %s\n' "$*" >>"${rollback_log}"
  return 0
}
container_exists() { return 0; }
restore_volume_from() {
  printf 'restore %s\n' "$1" >>"${rollback_log}"
  return 0
}
wait_for_ready() {
  printf 'wait-ready\n' >>"${rollback_log}"
  return 0
}

rollback_upgrade \
  "genosyn-test-upgrade-rollback" \
  "${test_root}/backups/pre-upgrade.tar.gz" >/dev/null 2>&1
check "rollback removes failed container, restores data, and restarts old container" \
  "$(cat "${rollback_log}")" \
  "$(printf '%s\n' \
    'docker logs --tail 50 genosyn-test' \
    'docker rm -f genosyn-test' \
    "restore ${test_root}/backups/pre-upgrade.tar.gz" \
    'docker rename genosyn-test-upgrade-rollback genosyn-test' \
    'docker start genosyn-test' \
    'wait-ready')"

: >"${rollback_log}"
rollback_upgrade "genosyn-test-upgrade-rollback" "" >/dev/null 2>&1
check "rollback without a backup restarts the old container without restoring data" \
  "$(cat "${rollback_log}")" \
  "$(printf '%s\n' \
    'docker logs --tail 50 genosyn-test' \
    'docker rm -f genosyn-test' \
    'docker rename genosyn-test-upgrade-rollback genosyn-test' \
    'docker start genosyn-test' \
    'wait-ready')"

upgrade_log="${test_root}/upgrade.log"
docker() {
  case "${1:-} ${2:-}" in
    'inspect --format') printf '%s\n' 'sha256:old' ;;
    'image inspect') printf '%s\n' 'sha256:new' ;;
    *) printf 'docker %s\n' "$*" >>"${upgrade_log}" ;;
  esac
  return 0
}
require_docker() { return 0; }
container_exists() { return 0; }
container_running() { return 0; }
container_named_exists() { return 1; }
ensure_auto_update_default() { return 0; }
image_version_label() { return 0; }
upgrade_backup_path() { printf '%s\n' "${test_root}/backups/pre-upgrade.tar.gz"; }
backup_volume_to() {
  printf 'backup-volume %s\n' "$1" >>"${upgrade_log}"
  return 0
}
run_container_with_image() {
  printf 'run-container %s\n' "$1" >>"${upgrade_log}"
  return 0
}
wait_for_upgrade_ready() { return 0; }
print_post_install() { return 0; }

: >"${upgrade_log}"
cmd_upgrade --no-self-upgrade >/dev/null 2>&1
check "upgrade skips the data backup by default" \
  "$(grep -Fc 'backup-volume ' "${upgrade_log}" || true)" '0'

: >"${upgrade_log}"
cmd_upgrade --no-self-upgrade --backup >/dev/null 2>&1
check "--backup creates one verified data backup" \
  "$(grep -Fc 'backup-volume ' "${upgrade_log}" || true)" '1'

install_log="${test_root}/install.log"
require_docker() { return 0; }
container_exists() { return 0; }
disable_auto_update() {
  printf 'disable-auto-update\n' >>"${install_log}"
  return 0
}
cmd_upgrade() {
  printf 'safe-upgrade %s\n' "$*" >>"${install_log}"
  return 0
}

cmd_install \
  --no-auto-update \
  --port 9100 \
  --name existing-genosyn \
  --volume existing-data \
  --image ghcr.io/genosyn/app:latest >/dev/null 2>&1
check "re-running the installer delegates to the safe upgrade path" \
  "$(cat "${install_log}")" \
  "$(printf '%s\n' \
    'disable-auto-update' \
    'safe-upgrade --port 9100 --name existing-genosyn --volume existing-data --image ghcr.io/genosyn/app:latest')"

rm -rf "${test_root}"
trap - EXIT

echo "display and common flag helpers"
check "human size: bytes" "$(human_size 1023)" "1023B"
check "human size: kibibytes" "$(human_size 1536)" "1.5KB"
check "human size: mebibytes" "$(human_size 1048576)" "1.0MB"
check "human size: tebibytes" "$(human_size 1099511627776)" "1.0TB"

NAME="prod/us west"
AUTO_UPDATE_DIR="/tmp/genosyn state"
check "unsafe container characters are sanitized in state keys" \
  "$(auto_update_key)" "prod_us_west"
check "the sanitized key is used in the wrapper path" \
  "$(auto_update_wrapper_path)" "/tmp/genosyn state/auto-update-prod_us_west.sh"

PORT=8471
NAME=genosyn
VOLUME=genosyn-data
IMAGE=ghcr.io/genosyn/app:latest
parse_common_flags \
  --port 9001 \
  --name=custom \
  --volume custom-data \
  --image=registry:5000/team/app:2 \
  --tail 50 \
  positional
check "common flags parse the space form" "${PORT}" "9001"
check "common flags parse the equals form" "${NAME}" "custom"
check "common flags carry registry ports intact" "${IMAGE}" "registry:5000/team/app:2"
check "common flags leave command-specific args in order" \
  "$(printf '%s|' "${REMAINING[@]}")" "--tail|50|positional|"

missing_value_rc=0
missing_value_output="$(
  bash -c 'source "$1"; parse_common_flags --port' _ "${HERE}/genosyn" 2>&1
)" || missing_value_rc=$?
check "a common flag without a value fails" "${missing_value_rc}" "1"
check "a common flag without a value explains itself" \
  "${missing_value_output}" "✗ Missing value for --port"

for disabled in 0 false FALSE no NO off OFF; do
  if auto_update_requested "${disabled}"; then disabled_result=yes; else disabled_result=no; fi
  check "auto-update opt-out ${disabled}" "${disabled_result}" "no"
done
if auto_update_requested yes; then enabled_result=yes; else enabled_result=no; fi
check "auto-update defaults all other values on" "${enabled_result}" "yes"

echo "vLLM configuration helpers"
test_root="$(mktemp -d -t genosyn-cli-vllm-test.XXXXXX)"
trap 'rm -rf "${test_root}"' EXIT
VLLM_DIR="${test_root}/vllm"
mkdir -p "${VLLM_DIR}"
vllm_write_default_env
check "default vLLM model is the documented Qwen model" \
  "$(vllm_env_get VLLM_MODEL "${VLLM_DIR}/.env")" \
  "Qwen/Qwen2.5-Coder-32B-Instruct"
check "default vLLM endpoint is unauthenticated" \
  "$(vllm_env_get VLLM_API_KEY "${VLLM_DIR}/.env")" ""

vllm_env_set VLLM_PORT 9000 "${VLLM_DIR}/.env"
vllm_env_set VLLM_API_KEY 'secret=with=equals' "${VLLM_DIR}/.env"
check "env upsert replaces a value" \
  "$(vllm_env_get VLLM_PORT "${VLLM_DIR}/.env")" "9000"
check "env values may contain equals signs" \
  "$(vllm_env_get VLLM_API_KEY "${VLLM_DIR}/.env")" "secret=with=equals"
printf '%s\n' 'VLLM_PORT=1' 'KEEP=this' 'VLLM_PORT=2' >"${VLLM_DIR}/duplicates.env"
vllm_env_set VLLM_PORT 8001 "${VLLM_DIR}/duplicates.env"
check "env upsert collapses duplicate keys" \
  "$(grep -Ec '^VLLM_PORT=' "${VLLM_DIR}/duplicates.env")" "1"
check "env upsert preserves unrelated lines" \
  "$(grep -Fxc 'KEEP=this' "${VLLM_DIR}/duplicates.env")" "1"
check "missing env keys read as empty" \
  "$(vllm_env_get UNKNOWN "${VLLM_DIR}/.env")" ""

vllm_write_compose
check "generated compose keeps model interpolation for runtime" \
  "$(grep -Fxc '      --model ${VLLM_MODEL:-Qwen/Qwen2.5-Coder-32B-Instruct}' "${VLLM_DIR}/docker-compose.yml")" \
  "1"
check "generated compose exposes the OpenAI-compatible port" \
  "$(grep -Fxc '      - "${VLLM_PORT:-8000}:8000"' "${VLLM_DIR}/docker-compose.yml")" \
  "1"
check "generated compose reserves every NVIDIA GPU" \
  "$(grep -Fxc '              capabilities: [gpu]' "${VLLM_DIR}/docker-compose.yml")" \
  "1"

echo "container command construction"
command_log="${test_root}/commands.log"
mkdir -p "${test_root}/bin"
cat >"${test_root}/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker' >>"${MOCK_DOCKER_LOG}"
printf ' <%s>' "$@" >>"${MOCK_DOCKER_LOG}"
printf '\n' >>"${MOCK_DOCKER_LOG}"
EOF
chmod +x "${test_root}/bin/docker"
PATH="${test_root}/bin:${PATH}" \
MOCK_DOCKER_LOG="${command_log}" \
GENOSYN_NAME="company-one" \
GENOSYN_PORT="9123" \
GENOSYN_VOLUME="company-one-data" \
bash -c 'source "$1"; run_container_with_image "$2"' \
  _ "${HERE}/genosyn" "registry:5000/genosyn/app:test"
check "run container binds the selected name, port, volume, and image" \
  "$(cat "${command_log}")" \
  "docker <run> <-d> <--name> <company-one> <--restart> <unless-stopped> <-p> <9123:8471> <-v> <company-one-data:/app/data> <registry:5000/genosyn/app:test>"

: >"${command_log}"
PATH="${test_root}/bin:${PATH}" \
MOCK_DOCKER_LOG="${command_log}" \
GENOSYN_NAME="company-one" \
bash -c 'source "$1"; require_docker() { return 0; }; container_exists() { return 0; }; cmd_logs --tail 25 -f' \
  _ "${HERE}/genosyn"
check "logs preserves follow and tail flags" \
  "$(cat "${command_log}")" \
  "docker <logs> <-f> <--tail> <25> <company-one>"

echo "bootstrap installer smoke tests"
mkdir -p "${test_root}/bin" "${test_root}/home"
cat >"${test_root}/bin/docker" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  info) exit 0 ;;
  *) exit 0 ;;
esac
EOF
cat >"${test_root}/bin/curl" <<'EOF'
#!/usr/bin/env bash
dest=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) dest="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cp "${MOCK_CURL_SOURCE}" "${dest}"
EOF
chmod +x "${test_root}/bin/docker" "${test_root}/bin/curl"

installer_rc=0
installer_output="$(
  PATH="${test_root}/bin:${PATH}" \
  HOME="${test_root}/home" \
  MOCK_CURL_SOURCE="${HERE}/genosyn" \
  GENOSYN_CLI_PREFIX="${test_root}/prefix" \
  GENOSYN_SKIP_RUN=1 \
  bash "${HERE}/install.sh" 2>&1
)" || installer_rc=$?
check "installer succeeds with a valid downloaded CLI" "${installer_rc}" "0"
check "installer writes an executable CLI" \
  "$([ -x "${test_root}/prefix/bin/genosyn" ] && echo yes || echo no)" "yes"
check "installer preserves the downloaded CLI exactly" \
  "$(file_sha256 "${test_root}/prefix/bin/genosyn")" \
  "$(file_sha256 "${HERE}/genosyn")"
check "skip-run stops before Docker installation" \
  "$(printf '%s' "${installer_output}" | grep -Fc "CLI installed. Run 'genosyn install'")" "1"

printf '%s\n' '<html>not a script</html>' >"${test_root}/invalid-download"
invalid_rc=0
invalid_output="$(
  PATH="${test_root}/bin:${PATH}" \
  HOME="${test_root}/home" \
  MOCK_CURL_SOURCE="${test_root}/invalid-download" \
  GENOSYN_CLI_PREFIX="${test_root}/invalid-prefix" \
  GENOSYN_SKIP_RUN=1 \
  bash "${HERE}/install.sh" 2>&1
)" || invalid_rc=$?
check "installer rejects a non-script download" "${invalid_rc}" "1"
check "installer explains a non-script download" \
  "$(printf '%s' "${invalid_output}" | grep -Fc 'Downloaded file does not look like a shell script')" \
  "1"

rm -rf "${test_root}"
trap - EXIT

printf '\n%d passed, %d failed\n' "${pass}" "${fail}"
[ "${fail}" -eq 0 ]
