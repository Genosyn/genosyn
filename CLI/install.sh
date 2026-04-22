#!/usr/bin/env bash
# Genosyn — one-command bootstrap.
#
#   curl -fsSL https://genosyn.com/install.sh | bash
#
# Installs the `genosyn` CLI to /usr/local/bin (or the fallback under
# $HOME/.local/bin when /usr/local/bin isn't writable), then runs
# `genosyn install` to pull the image and start the container.
#
# Re-running is safe: it overwrites the CLI and re-runs `genosyn install`,
# which upgrades the image and recreates the container while preserving the
# data volume.
#
# Optional environment overrides (forwarded to `genosyn install`):
#   GENOSYN_PORT     host port to expose (default: 8471)
#   GENOSYN_NAME     container name       (default: genosyn)
#   GENOSYN_VOLUME   data volume name     (default: genosyn-data)
#   GENOSYN_IMAGE    image reference      (default: ghcr.io/genosyn/app:latest)
#
# Additional env for the CLI download itself:
#   GENOSYN_CLI_URL     fetch URL for the genosyn script
#                       (default: https://genosyn.com/genosyn)
#   GENOSYN_CLI_PREFIX  install prefix; the binary goes under $prefix/bin
#                       (auto-detected: /usr/local, then $HOME/.local)
#   GENOSYN_SKIP_RUN=1  install the CLI but don't run `genosyn install`

set -euo pipefail

CLI_URL="${GENOSYN_CLI_URL:-https://genosyn.com/genosyn}"

if [ -t 1 ]; then
  C_RESET=$'\033[0m'
  C_DIM=$'\033[2m'
  C_BOLD=$'\033[1m'
  C_INDIGO=$'\033[38;5;99m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
else
  C_RESET=""; C_DIM=""; C_BOLD=""; C_INDIGO=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi

step() { printf '%s→%s %s\n' "${C_INDIGO}" "${C_RESET}" "$*"; }
ok()   { printf '%s✓%s %s\n' "${C_GREEN}"  "${C_RESET}" "$*"; }
warn() { printf '%s!%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "${C_RED}"    "${C_RESET}" "$*" >&2; exit 1; }

printf '%sGenosyn%s %sinstaller%s\n' "${C_BOLD}" "${C_RESET}" "${C_DIM}" "${C_RESET}"
printf '%sRun companies autonomously.%s\n\n' "${C_DIM}" "${C_RESET}"

# ---------- sanity checks ----------

if ! command -v docker >/dev/null 2>&1; then
  die "Docker is not installed. Get it at https://docs.docker.com/get-docker/"
fi

if ! docker info >/dev/null 2>&1; then
  die "Docker daemon is not reachable. Start Docker Desktop (or your daemon) and re-run."
fi

fetcher=""
if command -v curl >/dev/null 2>&1; then
  fetcher="curl"
elif command -v wget >/dev/null 2>&1; then
  fetcher="wget"
else
  die "Neither curl nor wget is available. Install one and re-run."
fi

# ---------- pick install prefix ----------

pick_prefix() {
  if [ -n "${GENOSYN_CLI_PREFIX:-}" ]; then
    echo "${GENOSYN_CLI_PREFIX}"
    return
  fi
  # Prefer /usr/local if its bin is writable directly OR we can sudo.
  if [ -w "/usr/local/bin" ] 2>/dev/null; then
    echo "/usr/local"
    return
  fi
  if command -v sudo >/dev/null 2>&1 && [ -d "/usr/local/bin" ]; then
    echo "/usr/local"
    return
  fi
  # Fall back to user-local.
  echo "${HOME}/.local"
}

PREFIX="$(pick_prefix)"
BIN_DIR="${PREFIX}/bin"
BIN_PATH="${BIN_DIR}/genosyn"

# ---------- download CLI ----------

tmp="$(mktemp -t genosyn-cli.XXXXXX)"
trap 'rm -f "${tmp}"' EXIT

step "Downloading genosyn CLI from ${CLI_URL}"
if [ "${fetcher}" = "curl" ]; then
  curl -fsSL "${CLI_URL}" -o "${tmp}"
else
  wget -q "${CLI_URL}" -O "${tmp}"
fi

# Minimal smoke-check: must be non-empty and look like a shell script.
if [ ! -s "${tmp}" ]; then
  die "Downloaded file is empty. Check ${CLI_URL}."
fi
if ! head -1 "${tmp}" | grep -q '^#!'; then
  die "Downloaded file does not look like a shell script. Check ${CLI_URL}."
fi

# ---------- install to $PREFIX/bin ----------

install_bin() {
  local src="$1" dst="$2"
  local dst_dir
  dst_dir="$(dirname "${dst}")"

  if [ -w "${dst_dir}" ] 2>/dev/null || { [ ! -e "${dst_dir}" ] && [ -w "$(dirname "${dst_dir}")" ] 2>/dev/null; }; then
    mkdir -p "${dst_dir}"
    install -m 0755 "${src}" "${dst}"
    return 0
  fi

  if command -v sudo >/dev/null 2>&1; then
    step "Elevating with sudo to write ${dst}"
    sudo mkdir -p "${dst_dir}"
    sudo install -m 0755 "${src}" "${dst}"
    return 0
  fi

  die "Cannot write to ${dst_dir} and sudo is unavailable. Re-run with GENOSYN_CLI_PREFIX=\$HOME/.local."
}

step "Installing to ${BIN_PATH}"
install_bin "${tmp}" "${BIN_PATH}"
ok "Installed genosyn CLI."

# ---------- PATH advice ----------

case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *)
    warn "${BIN_DIR} is not on your PATH."
    printf '   Add it with:  %sexport PATH="%s:\$PATH"%s\n' "${C_DIM}" "${BIN_DIR}" "${C_RESET}"
    printf '   Then restart your shell, or run the CLI directly as %s%s%s.\n\n' "${C_DIM}" "${BIN_PATH}" "${C_RESET}"
    ;;
esac

# ---------- hand off to `genosyn install` ----------

if [ "${GENOSYN_SKIP_RUN:-}" = "1" ]; then
  ok "CLI installed. Run 'genosyn install' to pull the image and start the container."
  exit 0
fi

echo
"${BIN_PATH}" install
