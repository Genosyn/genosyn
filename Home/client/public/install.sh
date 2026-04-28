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
#   GENOSYN_CLI_URL         fetch URL for the genosyn script
#                           (default: https://genosyn.com/genosyn)
#   GENOSYN_CLI_PREFIX      install prefix; the binary goes under $prefix/bin
#                           (auto-detected: /usr/local, then $HOME/.local)
#   GENOSYN_SKIP_RUN=1      install the CLI but don't run `genosyn install`
#   GENOSYN_INSTALL_DOCKER=0 skip the auto-install of Docker when it's missing
#                            (default: install via https://get.docker.com on
#                            Linux, or `brew install --cask docker` on macOS)

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

fetcher=""
if command -v curl >/dev/null 2>&1; then
  fetcher="curl"
elif command -v wget >/dev/null 2>&1; then
  fetcher="wget"
else
  die "Neither curl nor wget is available. Install one and re-run."
fi

fetch_to() {
  # fetch_to <url> <dest>
  if [ "${fetcher}" = "curl" ]; then
    curl -fsSL "$1" -o "$2"
  else
    wget -q "$1" -O "$2"
  fi
}

install_docker() {
  if [ "${GENOSYN_INSTALL_DOCKER:-1}" = "0" ]; then
    die "Docker is not installed. Get it at https://docs.docker.com/get-docker/"
  fi

  uname_s="$(uname -s)"
  case "${uname_s}" in
    Linux)
      step "Installing Docker via https://get.docker.com"
      docker_tmp="$(mktemp -t get-docker.XXXXXX)"
      fetch_to "https://get.docker.com" "${docker_tmp}"

      if [ "$(id -u)" = "0" ]; then
        sh "${docker_tmp}"
      elif command -v sudo >/dev/null 2>&1; then
        sudo sh "${docker_tmp}"
      else
        rm -f "${docker_tmp}"
        die "Cannot install Docker without root or sudo. Install it manually: https://docs.docker.com/get-docker/"
      fi
      rm -f "${docker_tmp}"

      if command -v systemctl >/dev/null 2>&1; then
        if [ "$(id -u)" = "0" ]; then
          systemctl start docker >/dev/null 2>&1 || true
          systemctl enable docker >/dev/null 2>&1 || true
        elif command -v sudo >/dev/null 2>&1; then
          sudo systemctl start docker >/dev/null 2>&1 || true
          sudo systemctl enable docker >/dev/null 2>&1 || true
        fi
      fi
      ;;
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        step "Installing Docker Desktop via Homebrew"
        brew install --cask docker
        warn "Open Docker Desktop from Applications to start the daemon, then re-run this installer."
        exit 0
      fi
      die "Docker is not installed. Install Docker Desktop from https://docs.docker.com/desktop/install/mac-install/ and re-run."
      ;;
    *)
      die "Docker auto-install isn't supported on '${uname_s}'. See https://docs.docker.com/get-docker/"
      ;;
  esac

  if ! command -v docker >/dev/null 2>&1; then
    die "Docker install completed but 'docker' is not on PATH. Open a new shell and re-run."
  fi
  ok "Docker installed."
}

if ! command -v docker >/dev/null 2>&1; then
  warn "Docker is not installed."
  install_docker
fi

if ! docker info >/dev/null 2>&1; then
  die "Docker daemon is not reachable. Start Docker Desktop (or your daemon) and re-run. On Linux, you may also need: sudo usermod -aG docker \$USER (then log out and back in)."
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
fetch_to "${CLI_URL}" "${tmp}"

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
