#!/usr/bin/env bash
# Genosyn — one-command bootstrap.
#
#   curl -fsSL https://genosyn.com/install.sh | bash
#
# Installs the `genosyn` CLI to /usr/local/bin (or the fallback under
# $HOME/.local/bin when /usr/local/bin isn't writable), makes sure a usable
# Docker daemon is on the host — installing, starting, and granting access to
# one when it's missing — then runs `genosyn install` to pull the image and
# start the container.
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
#   GENOSYN_SANDBOX  give the container what bubblewrap needs to start
#                    (default: 1; set to 0 to run without command execution)
#   GENOSYN_AUTO_UPDATE  enable daily automatic upgrades after install
#                        (default: 1; set to 0 to opt out)
#   GENOSYN_BACKUP_DIR   host directory for optional pre-upgrade backups
#                        (default: ~/.genosyn/backups)
#
# Additional env for the CLI download itself:
#   GENOSYN_CLI_URL         fetch URL for the genosyn script
#                           (default: https://genosyn.com/genosyn)
#   GENOSYN_CLI_PREFIX      install prefix; the binary goes under $prefix/bin
#                           (auto-detected: /usr/local, then $HOME/.local)
#   GENOSYN_SKIP_RUN=1      install the CLI only — no Docker setup, no
#                           `genosyn install`
#   GENOSYN_INSTALL_DOCKER=0 skip the auto-install of Docker when it's missing
#                            (default: install via https://get.docker.com on
#                            Linux, or `brew install --cask` on macOS)
#   GENOSYN_DOCKER_WAIT     seconds to wait for the Docker daemon to come up
#                           (default: 120)

set -euo pipefail

CLI_URL="${GENOSYN_CLI_URL:-https://genosyn.com/genosyn}"
DOCKER_WAIT="${GENOSYN_DOCKER_WAIT:-120}"   # Docker Desktop takes its time to boot
DAEMON_WAIT=20                              # a local daemon start does not
case "${DOCKER_WAIT}" in
  ''|*[!0-9]*)
    printf 'GENOSYN_DOCKER_WAIT must be a whole number of seconds.\n' >&2
    exit 1
    ;;
esac
if [ "${DOCKER_WAIT}" -lt "${DAEMON_WAIT}" ]; then
  DAEMON_WAIT="${DOCKER_WAIT}"
fi

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

  if [ -w "${dst_dir}" ] 2>/dev/null || {
    [ ! -e "${dst_dir}" ] && mkdir -p "${dst_dir}" 2>/dev/null
  }; then
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

if [ "${GENOSYN_SKIP_RUN:-}" = "1" ]; then
  ok "CLI installed. Run 'genosyn install' to pull the image and start the container."
  exit 0
fi

# ---------- docker ----------

# Set when the docker group had to be granted mid-run: group membership only
# reaches new logins, so this run finishes under `sg docker`.
DOCKER_SG=0

sudo_run() {
  # sudo_run <cmd> [args...] — run privileged, or return 127 when we can't.
  if [ "$(id -u)" = "0" ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    return 127
  fi
}

have_docker() {
  if command -v docker >/dev/null 2>&1; then
    return 0
  fi
  # Docker Desktop can put its CLI under ~/.docker/bin instead of /usr/local/bin.
  if [ -x "${HOME}/.docker/bin/docker" ]; then
    PATH="${HOME}/.docker/bin:${PATH}"
    export PATH
    return 0
  fi
  return 1
}

docker_ready() {
  have_docker && docker info >/dev/null 2>&1
}

wait_for_docker() {
  # wait_for_docker <seconds> <label> — poll until the daemon answers. The
  # label is only printed if we end up actually waiting on it.
  local limit="$1" label="$2" waited=0 shown=0
  while :; do
    if docker_ready; then
      if [ "${shown}" = "1" ]; then printf '\n'; fi
      return 0
    fi
    if [ "${waited}" -ge "${limit}" ]; then
      if [ "${shown}" = "1" ]; then printf '\n'; fi
      return 1
    fi
    if [ "${shown}" = "0" ]; then
      printf '  %s%s%s ' "${C_DIM}" "${label}" "${C_RESET}"
      shown=1
    fi
    printf '.'
    sleep 2
    waited=$((waited + 2))
  done
}

install_docker_linux() {
  step "Installing Docker via https://get.docker.com"
  local docker_tmp
  docker_tmp="$(mktemp -t get-docker.XXXXXX)"

  if ! fetch_to "https://get.docker.com" "${docker_tmp}"; then
    rm -f "${docker_tmp}"
    die "Could not download https://get.docker.com. Install Docker manually: https://docs.docker.com/engine/install/"
  fi

  local rc=0
  sudo_run sh "${docker_tmp}" || rc=$?
  rm -f "${docker_tmp}"

  if [ "${rc}" = "127" ]; then
    die "Cannot install Docker without root or sudo. Install it manually: https://docs.docker.com/engine/install/"
  fi
  if [ "${rc}" != "0" ]; then
    die "The Docker install script failed (exit ${rc}). Install Docker manually: https://docs.docker.com/engine/install/"
  fi
}

install_docker_macos() {
  if ! command -v brew >/dev/null 2>&1; then
    die "Docker is not installed, and Homebrew isn't available to install it. Install Docker Desktop from https://docs.docker.com/desktop/install/mac-install/ and re-run this installer."
  fi

  # Homebrew renamed the Docker Desktop cask to docker-desktop; older
  # Homebrew installs still call it docker.
  local cask="docker-desktop"
  if ! brew info --cask "${cask}" >/dev/null 2>&1; then
    cask="docker"
  fi

  step "Installing Docker Desktop via Homebrew (${cask})"
  if ! brew install --cask "${cask}"; then
    die "Homebrew could not install Docker Desktop. Install it from https://docs.docker.com/desktop/install/mac-install/ and re-run this installer."
  fi
}

install_docker() {
  if [ "${GENOSYN_INSTALL_DOCKER:-1}" = "0" ]; then
    die "Docker is not installed. Get it at https://docs.docker.com/get-docker/"
  fi

  local uname_s
  uname_s="$(uname -s)"
  case "${uname_s}" in
    Linux)  install_docker_linux ;;
    Darwin) install_docker_macos ;;
    *)      die "Docker auto-install isn't supported on '${uname_s}'. See https://docs.docker.com/get-docker/" ;;
  esac

  hash -r 2>/dev/null || true
  ok "Docker installed."
}

start_docker_daemon() {
  case "$(uname -s)" in
    Linux)
      if command -v systemctl >/dev/null 2>&1; then
        step "Starting the Docker daemon"
        sudo_run systemctl enable --now docker >/dev/null 2>&1 || true
      elif command -v service >/dev/null 2>&1; then
        step "Starting the Docker daemon"
        sudo_run service docker start >/dev/null 2>&1 || true
      elif command -v rc-service >/dev/null 2>&1; then
        step "Starting the Docker daemon"
        sudo_run rc-service docker start >/dev/null 2>&1 || true
      else
        return 0
      fi
      wait_for_docker "${DAEMON_WAIT}" "waiting for the Docker daemon" || true
      ;;
    Darwin)
      if [ ! -d "/Applications/Docker.app" ]; then
        return 0
      fi
      step "Starting Docker Desktop"
      open -a Docker >/dev/null 2>&1 || true
      wait_for_docker "${DOCKER_WAIT}" "waiting for Docker Desktop" || true
      ;;
  esac
  return 0
}

socket_permission_problem() {
  # A daemon that answers root but not us: group membership, not a dead daemon.
  [ "$(uname -s)" = "Linux" ] || return 1
  [ "$(id -u)" != "0" ] || return 1
  command -v sudo >/dev/null 2>&1 || return 1
  have_docker || return 1
  sudo docker info >/dev/null 2>&1
}

grant_docker_access() {
  # The daemon is up but our user can't reach its socket — the classic
  # "you're not in the docker group yet" state right after an install.
  local user
  user="$(id -un)"

  step "Adding ${user} to the docker group"
  sudo_run groupadd -f docker >/dev/null 2>&1 \
    || sudo_run addgroup docker >/dev/null 2>&1 \
    || true

  if ! sudo_run usermod -aG docker "${user}" >/dev/null 2>&1 \
    && ! sudo_run addgroup "${user}" docker >/dev/null 2>&1; then
    return 1
  fi

  # Group membership only takes effect on new logins, so borrow it for the
  # rest of this run rather than asking for a logout.
  if command -v sg >/dev/null 2>&1 && sg docker -c 'docker info' >/dev/null 2>&1; then
    DOCKER_SG=1
    ok "Docker group access granted."
    return 0
  fi
  return 1
}

fix_docker_group() {
  warn "Your user can't reach the Docker socket yet."
  if grant_docker_access; then
    return 0
  fi
  die "You've been added to the docker group, but this session can't use it yet. Log out and back in, then re-run this installer."
}

ensure_docker() {
  if ! have_docker; then
    warn "Docker is not installed."
    install_docker
  fi

  if ! have_docker && [ "$(uname -s)" != "Darwin" ]; then
    die "Docker was installed but 'docker' is not on PATH. Open a new shell and re-run this installer."
  fi

  if docker_ready; then
    ok "Docker daemon is reachable."
    return 0
  fi

  # Check this before starting the daemon: a socket we're locked out of would
  # otherwise burn the whole daemon-start wait before we diagnose it.
  if socket_permission_problem; then
    fix_docker_group
    return 0
  fi

  start_docker_daemon
  if docker_ready; then
    ok "Docker daemon is running."
    return 0
  fi

  if socket_permission_problem; then
    fix_docker_group
    return 0
  fi

  if [ "$(uname -s)" = "Darwin" ]; then
    warn "Docker Desktop isn't running yet."
    printf '  Open it from Applications, finish first-run setup, then run %s%s install%s.\n' \
      "${C_DIM}" "${BIN_PATH}" "${C_RESET}"
    exit 0
  fi

  die "Docker daemon is not reachable. Start it and re-run this installer."
}

ensure_docker

# ---------- hand off to `genosyn install` ----------

echo
if [ "${DOCKER_SG}" = "1" ]; then
  warn "Log out and back in so future shells can run docker without sudo."
  sg docker -c "$(printf '%q ' "${BIN_PATH}" install)"
else
  "${BIN_PATH}" install
fi
