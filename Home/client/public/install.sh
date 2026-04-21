#!/usr/bin/env bash
# Genosyn — one-command installer.
#
#   curl -fsSL https://genosyn.com/install.sh | bash
#
# Pulls ghcr.io/genosyn/app:latest and starts a container called "genosyn"
# with a persistent docker volume for /app/data. Re-running the script
# upgrades to the latest image.
#
# Optional environment overrides:
#   GENOSYN_PORT     host port to expose (default: 8471)
#   GENOSYN_NAME     container name       (default: genosyn)
#   GENOSYN_VOLUME   data volume name     (default: genosyn-data)
#   GENOSYN_IMAGE    image reference      (default: ghcr.io/genosyn/app:latest)

set -euo pipefail

PORT="${GENOSYN_PORT:-8471}"
NAME="${GENOSYN_NAME:-genosyn}"
VOLUME="${GENOSYN_VOLUME:-genosyn-data}"
IMAGE="${GENOSYN_IMAGE:-ghcr.io/genosyn/app:latest}"

if [ -t 1 ]; then
  C_RESET=$'\033[0m'
  C_DIM=$'\033[2m'
  C_BOLD=$'\033[1m'
  C_INDIGO=$'\033[38;5;99m'
  C_GREEN=$'\033[32m'
  C_RED=$'\033[31m'
else
  C_RESET=""; C_DIM=""; C_BOLD=""; C_INDIGO=""; C_GREEN=""; C_RED=""
fi

step() { printf '%s→%s %s\n' "${C_INDIGO}" "${C_RESET}" "$*"; }
ok()   { printf '%s✓%s %s\n' "${C_GREEN}"  "${C_RESET}" "$*"; }
die()  { printf '%s✗%s %s\n' "${C_RED}"    "${C_RESET}" "$*" >&2; exit 1; }

printf '%sGenosyn%s %sinstaller%s\n' "${C_BOLD}" "${C_RESET}" "${C_DIM}" "${C_RESET}"
printf '%sRun companies autonomously.%s\n\n' "${C_DIM}" "${C_RESET}"

if ! command -v docker >/dev/null 2>&1; then
  die "Docker is not installed. Get it at https://docs.docker.com/get-docker/"
fi

if ! docker info >/dev/null 2>&1; then
  die "Docker daemon is not reachable. Start Docker Desktop (or your daemon) and re-run."
fi

if docker ps -a --format '{{.Names}}' | grep -qx "${NAME}"; then
  step "Removing existing container '${NAME}'"
  docker rm -f "${NAME}" >/dev/null
fi

step "Pulling ${IMAGE}"
docker pull "${IMAGE}" >/dev/null

step "Starting '${NAME}' on port ${PORT}"
docker run -d \
  --name "${NAME}" \
  --restart unless-stopped \
  -p "${PORT}:8471" \
  -v "${VOLUME}:/app/data" \
  "${IMAGE}" >/dev/null

# Give the server a moment to bind so the URL we print is actually live.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if docker exec "${NAME}" sh -c "wget -qO- http://127.0.0.1:8471 >/dev/null 2>&1 || curl -fsS http://127.0.0.1:8471 >/dev/null 2>&1"; then
    break
  fi
  sleep 1
done

ok "Genosyn is running."
echo
printf '   Open  %shttp://localhost:%s%s\n' "${C_INDIGO}" "${PORT}" "${C_RESET}"
printf '   Logs  %sdocker logs -f %s%s\n'    "${C_DIM}"   "${NAME}" "${C_RESET}"
printf '   Stop  %sdocker stop %s%s\n'       "${C_DIM}"   "${NAME}" "${C_RESET}"
echo
