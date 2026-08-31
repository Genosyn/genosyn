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
  "docker <run> <-d> <--name> <company-one> <--restart> <unless-stopped> <--security-opt> <seccomp=unconfined> <--security-opt> <systempaths=unconfined> <-p> <9123:8471> <-v> <company-one-data:/app/data> <registry:5000/genosyn/app:test>"

# Bubblewrap can neither create a user namespace nor mount a private /proc
# under Docker's stock profile, so a container created without those two
# options boots with command execution disabled. They are not decoration.
: >"${command_log}"
PATH="${test_root}/bin:${PATH}" \
MOCK_DOCKER_LOG="${command_log}" \
GENOSYN_SANDBOX="0" \
bash -c 'source "$1"; run_container_with_image "$2"' \
  _ "${HERE}/genosyn" "registry:5000/genosyn/app:test"
check "GENOSYN_SANDBOX=0 keeps the stock container profile" \
  "$(cat "${command_log}")" \
  "docker <run> <-d> <--name> <genosyn> <--restart> <unless-stopped> <-p> <8471:8471> <-v> <genosyn-data:/app/data> <registry:5000/genosyn/app:test>"

: >"${command_log}"
PATH="${test_root}/bin:${PATH}" \
MOCK_DOCKER_LOG="${command_log}" \
GENOSYN_NAME="company-one" \
bash -c 'source "$1"; require_docker() { return 0; }; container_exists() { return 0; }; cmd_logs --tail 25 -f' \
  _ "${HERE}/genosyn"
check "logs preserves follow and tail flags" \
  "$(cat "${command_log}")" \
  "docker <logs> <-f> <--tail> <25> <company-one>"

echo "sandbox detection on an existing container"
cat >"${test_root}/bin/docker" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "inspect" ]; then
  case "$*" in
    *SecurityOpt*)  printf '%s\n' "${MOCK_SECURITY_OPT}" ;;
    *MaskedPaths*)  printf '%s\n' "${MOCK_MASKED_PATHS}" ;;
    *Config.Image*) printf '%s\n' "registry:5000/genosyn/app:test" ;;
  esac
fi
exit 0
EOF
chmod +x "${test_root}/bin/docker"

sandbox_ready_result() {
  PATH="${test_root}/bin:${PATH}" \
  MOCK_SECURITY_OPT="$1" \
  MOCK_MASKED_PATHS="$2" \
    bash -c 'source "$1"; container_sandbox_ready && echo ready || echo missing' \
    _ "${HERE}/genosyn"
}

check "a container created with both options is ready" \
  "$(sandbox_ready_result '["seccomp=unconfined"]' '[]')" 'ready'
check "no seccomp option means the sandbox cannot start" \
  "$(sandbox_ready_result 'null' '[]')" 'missing'
# `systempaths=unconfined` is folded into empty masked/read-only path lists
# rather than echoed back in SecurityOpt, so retained masks are the tell that
# only half the options were passed — and bubblewrap then fails mounting /proc
# rather than failing to create the namespace.
check "retained masked paths mean the sandbox cannot start" \
  "$(sandbox_ready_result '["seccomp=unconfined"]' '["/proc/kcore"]')" 'missing'

: >"${command_log}"
PATH="${test_root}/bin:${PATH}" \
MOCK_SECURITY_OPT='["seccomp=unconfined"]' \
MOCK_MASKED_PATHS='["/proc/kcore"]' \
  bash -c 'source "$1"
    recreate_log="$2"
    wait_for_ready() { return 0; }
    run_container_with_image() { printf "recreated %s\n" "$1" >>"${recreate_log}"; }
    ensure_container_sandbox' \
  _ "${HERE}/genosyn" "${command_log}" >/dev/null 2>&1
check "an existing container missing the options is recreated from its own image" \
  "$(cat "${command_log}")" \
  'recreated registry:5000/genosyn/app:test'

: >"${command_log}"
PATH="${test_root}/bin:${PATH}" \
MOCK_SECURITY_OPT='["seccomp=unconfined"]' \
MOCK_MASKED_PATHS='[]' \
  bash -c 'source "$1"
    recreate_log="$2"
    run_container_with_image() { printf "recreated %s\n" "$1" >>"${recreate_log}"; }
    ensure_container_sandbox' \
  _ "${HERE}/genosyn" "${command_log}" >/dev/null 2>&1
check "a container that already has them is left alone" \
  "$(cat "${command_log}")" \
  ''

# Not every container runtime speaks Docker's security options. Refusing to
# install at all would be a worse answer than installing without command
# execution and saying so.
cat >"${test_root}/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker' >>"${MOCK_DOCKER_LOG}"
printf ' <%s>' "$@" >>"${MOCK_DOCKER_LOG}"
printf '\n' >>"${MOCK_DOCKER_LOG}"
case "$*" in
  *--security-opt*) printf 'docker: invalid --security-opt: systempaths=unconfined\n' >&2; exit 125 ;;
esac
exit 0
EOF
chmod +x "${test_root}/bin/docker"

: >"${command_log}"
sandbox_reject_stderr="$(
  PATH="${test_root}/bin:${PATH}" \
  MOCK_DOCKER_LOG="${command_log}" \
    bash -c 'source "$1"; run_container_with_image "$2"' \
    _ "${HERE}/genosyn" "registry:5000/genosyn/app:test" 2>&1 >/dev/null
)"
check "a runtime that rejects the options still gets a container" \
  "$(tail -1 "${command_log}")" \
  "docker <run> <-d> <--name> <genosyn> <--restart> <unless-stopped> <-p> <8471:8471> <-v> <genosyn-data:/app/data> <registry:5000/genosyn/app:test>"
check "the rejected attempt is cleaned up before the retry" \
  "$(grep -Fc 'docker <rm> <-f> <genosyn>' "${command_log}" || true)" '1'
case "${sandbox_reject_stderr}" in
  *"command execution will be off"*) sandbox_reject_explained="explained" ;;
  *) sandbox_reject_explained="${sandbox_reject_stderr}" ;;
esac
check "and the operator is told why command execution is off" \
  "${sandbox_reject_explained}" 'explained'

# A failure that has nothing to do with sandboxing is the operator's to read.
cat >"${test_root}/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker' >>"${MOCK_DOCKER_LOG}"
printf ' <%s>' "$@" >>"${MOCK_DOCKER_LOG}"
printf '\n' >>"${MOCK_DOCKER_LOG}"
printf 'docker: Conflict. The container name "/genosyn" is already in use.\n' >&2
exit 125
EOF
chmod +x "${test_root}/bin/docker"

: >"${command_log}"
PATH="${test_root}/bin:${PATH}" \
MOCK_DOCKER_LOG="${command_log}" \
  bash -c 'source "$1"; run_container_with_image "$2"' \
  _ "${HERE}/genosyn" "registry:5000/genosyn/app:test" >/dev/null 2>&1 || true
check "an unrelated docker failure is not retried" \
  "$(grep -Fc 'docker <run>' "${command_log}" || true)" '1'

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


echo "bootstrap installer — docker bootstrap"

# A PATH sandbox: only the host tools the installer legitimately needs, so the
# mocks decide whether docker, sudo, brew, or sg exist at all.
sysbin="${test_root}/sysbin"
mkdir -p "${sysbin}"
for tool in bash sh env mktemp mkdir rm ln cp mv chmod install dirname head grep \
  sed cut tr id sleep cat printf test uname; do
  tool_path="$(command -v "${tool}" 2>/dev/null)"
  [ -n "${tool_path}" ] && ln -sf "${tool_path}" "${sysbin}/${tool}"
done

# A stand-in for the downloaded CLI: the installer only checks the shebang, and
# this way the handoff is observable without pulling an image.
cat >"${test_root}/fake-cli" <<'EOF'
#!/usr/bin/env bash
echo "CLI-INSTALL-RAN $*"
EOF

# curl that serves the CLI and the Docker convenience script from local files.
cat >"${test_root}/mock-curl" <<'EOF'
#!/usr/bin/env bash
url=""; dest=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) dest="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "${url}" in
  *get.docker.com*) cp "${MOCK_GET_DOCKER_SOURCE}" "${dest}" ;;
  *) cp "${MOCK_CURL_SOURCE}" "${dest}" ;;
esac
EOF

# sudo that records what it was asked to elevate, then runs it with the
# daemon reachable — that is what root access buys on a fresh install.
cat >"${test_root}/mock-sudo" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"${MOCK_SUDO_LOG}"
MOCK_DOCKER_OK=1 exec "$@"
EOF

# docker whose socket only answers when MOCK_DOCKER_OK is set.
cat >"${test_root}/mock-docker-gated" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  info) [ "${MOCK_DOCKER_OK:-0}" = "1" ] && exit 0 || exit 1 ;;
  *) exit 0 ;;
esac
EOF

# The Docker convenience script, which drops a working docker onto PATH.
cat >"${test_root}/mock-get-docker" <<'GETDOCKER_EOF'
#!/bin/sh
echo "get-docker ran"
cat >"${MOCK_DOCKER_BIN_DIR}/docker" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "${MOCK_DOCKER_BIN_DIR}/docker"
GETDOCKER_EOF

cat >"${test_root}/mock-sg" <<'EOF'
#!/usr/bin/env bash
# sg <group> -c <command>
echo "$*" >>"${MOCK_SG_LOG}"
MOCK_DOCKER_OK=1 bash -c "$3"
EOF

cat >"${test_root}/mock-uname" <<'EOF'
#!/usr/bin/env bash
echo "${MOCK_UNAME_S}"
EOF

cat >"${test_root}/mock-noop" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

# Pin an unprivileged identity so these cases exercise the sudo and docker-group
# paths whether the suite itself runs as root (containers, CI) or not.
cat >"${test_root}/mock-id" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -un) echo tester ;;
  *) echo 1000 ;;
esac
EOF

chmod +x "${test_root}/fake-cli" "${test_root}/mock-curl" "${test_root}/mock-sudo" \
  "${test_root}/mock-docker-gated" "${test_root}/mock-get-docker" \
  "${test_root}/mock-sg" "${test_root}/mock-uname" "${test_root}/mock-noop" \
  "${test_root}/mock-id"

new_case_bin() {
  # new_case_bin <name> — a mock dir that shadows the PATH sandbox.
  local dir="${test_root}/$1"
  rm -rf "${dir}"
  mkdir -p "${dir}"
  cp "${test_root}/mock-curl" "${dir}/curl"
  cp "${test_root}/mock-id" "${dir}/id"
  echo "${dir}"
}

# --- opting out of the Docker install ---

optout_bin="$(new_case_bin case-optout)"
cp "${test_root}/mock-uname" "${optout_bin}/uname"
optout_rc=0
optout_output="$(
  PATH="${optout_bin}:${sysbin}" \
  HOME="${test_root}/home" \
  MOCK_UNAME_S=Linux \
  MOCK_CURL_SOURCE="${test_root}/fake-cli" \
  GENOSYN_CLI_PREFIX="${test_root}/optout-prefix" \
  GENOSYN_INSTALL_DOCKER=0 \
  GENOSYN_DOCKER_WAIT=0 \
  bash "${HERE}/install.sh" 2>&1
)" || optout_rc=$?
check "GENOSYN_INSTALL_DOCKER=0 refuses to install Docker" "${optout_rc}" "1"
check "the opt-out points at the Docker docs" \
  "$(printf '%s' "${optout_output}" | grep -Fc 'Docker is not installed. Get it at')" "1"
check "the CLI is installed even when Docker setup fails" \
  "$([ -x "${test_root}/optout-prefix/bin/genosyn" ] && echo yes || echo no)" "yes"

# --- installing Docker on Linux ---

linux_bin="$(new_case_bin case-linux)"
cp "${test_root}/mock-uname" "${linux_bin}/uname"
cp "${test_root}/mock-sudo" "${linux_bin}/sudo"
cp "${test_root}/mock-noop" "${linux_bin}/systemctl"
linux_sudo_log="${test_root}/linux-sudo.log"
: >"${linux_sudo_log}"
linux_rc=0
linux_output="$(
  PATH="${linux_bin}:${sysbin}" \
  HOME="${test_root}/home" \
  MOCK_UNAME_S=Linux \
  MOCK_CURL_SOURCE="${test_root}/fake-cli" \
  MOCK_GET_DOCKER_SOURCE="${test_root}/mock-get-docker" \
  MOCK_DOCKER_BIN_DIR="${linux_bin}" \
  MOCK_SUDO_LOG="${linux_sudo_log}" \
  GENOSYN_CLI_PREFIX="${test_root}/linux-prefix" \
  GENOSYN_DOCKER_WAIT=0 \
  bash "${HERE}/install.sh" 2>&1
)" || linux_rc=$?
check "a Linux host without Docker installs it" "${linux_rc}" "0"
check "the convenience script is fetched" \
  "$(printf '%s' "${linux_output}" | grep -Fc 'Installing Docker via https://get.docker.com')" "1"
check "the convenience script runs with root" \
  "$(grep -c 'sh /' "${linux_sudo_log}" || true)" "1"
check "the installed Docker is reported" \
  "$(printf '%s' "${linux_output}" | grep -Fc 'Docker installed.')" "1"
check "the handoff runs once Docker is up" \
  "$(printf '%s' "${linux_output}" | grep -Fc 'CLI-INSTALL-RAN install')" "1"

# --- a daemon the user is not yet allowed to talk to ---

group_bin="$(new_case_bin case-group)"
cp "${test_root}/mock-uname" "${group_bin}/uname"
cp "${test_root}/mock-sudo" "${group_bin}/sudo"
cp "${test_root}/mock-sg" "${group_bin}/sg"
cp "${test_root}/mock-docker-gated" "${group_bin}/docker"
# Present so a daemon restart would be visible if the installer reached for one.
cp "${test_root}/mock-noop" "${group_bin}/systemctl"
cp "${test_root}/mock-noop" "${group_bin}/usermod"
cp "${test_root}/mock-noop" "${group_bin}/groupadd"
group_sudo_log="${test_root}/group-sudo.log"
group_sg_log="${test_root}/group-sg.log"
: >"${group_sudo_log}"
: >"${group_sg_log}"
group_rc=0
group_output="$(
  PATH="${group_bin}:${sysbin}" \
  HOME="${test_root}/home" \
  MOCK_UNAME_S=Linux \
  MOCK_CURL_SOURCE="${test_root}/fake-cli" \
  MOCK_SUDO_LOG="${group_sudo_log}" \
  MOCK_SG_LOG="${group_sg_log}" \
  GENOSYN_CLI_PREFIX="${test_root}/group-prefix" \
  GENOSYN_DOCKER_WAIT=0 \
  bash "${HERE}/install.sh" 2>&1
)" || group_rc=$?
check "a socket the user cannot reach is repaired" "${group_rc}" "0"
check "the user is added to the docker group" \
  "$(grep -Fc 'usermod -aG docker' "${group_sudo_log}" || true)" "1"
check "the daemon is not restarted to fix a permission problem" \
  "$(printf '%s' "${group_output}" | grep -Fc 'Starting the Docker daemon')" "0"
check "the rest of the run borrows the new group" \
  "$(grep -Fc 'docker -c' "${group_sg_log}" || true)" "2"
check "the handoff runs under the new group" \
  "$(printf '%s' "${group_output}" | grep -Fc 'CLI-INSTALL-RAN install')" "1"

# --- macOS without Homebrew ---

mac_bin="$(new_case_bin case-mac)"
cp "${test_root}/mock-uname" "${mac_bin}/uname"
mac_rc=0
mac_output="$(
  PATH="${mac_bin}:${sysbin}" \
  HOME="${test_root}/home" \
  MOCK_UNAME_S=Darwin \
  MOCK_CURL_SOURCE="${test_root}/fake-cli" \
  GENOSYN_CLI_PREFIX="${test_root}/mac-prefix" \
  GENOSYN_DOCKER_WAIT=0 \
  bash "${HERE}/install.sh" 2>&1
)" || mac_rc=$?
check "macOS without Homebrew stops with instructions" "${mac_rc}" "1"
check "macOS without Homebrew names Docker Desktop" \
  "$(printf '%s' "${mac_output}" | grep -Fc 'Homebrew isn'"'"'t available')" "1"

rm -rf "${test_root}"
trap - EXIT

printf '\n%d passed, %d failed\n' "${pass}" "${fail}"
[ "${fail}" -eq 0 ]
