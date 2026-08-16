#!/bin/bash
# Container entrypoint. Starts a virtual display, then hands off to the app.
#
# Genosyn's browser tools drive a real, headed Google Chrome — see the
# `browser` block in config.ts for why headed matters. Headed Chrome needs an
# X display and a container has none, so we start Xvfb and point `DISPLAY` at
# it before exec'ing the server.
#
# Everything here is best-effort: if the display cannot be brought up the app
# still boots, `browserProfile.ts` sees no `DISPLAY`, and Chrome falls back to
# headless. A degraded browser is a much better outcome than a container that
# refuses to start.
set -euo pipefail

readonly XVFB_DISPLAY="${GENOSYN_XVFB_DISPLAY:-:99}"
# A believable desktop. Chrome's window is sized separately (--window-size in
# browserProfile.ts); this is the screen it sits on, and `screen.width` /
# `screen.height` are read by fingerprinting scripts.
readonly XVFB_SCREEN="${GENOSYN_XVFB_SCREEN:-1920x1080x24}"

log() {
  printf 'genosyn-entrypoint: %s\n' "$1" >&2
}

start_xvfb() {
  if [ -n "${DISPLAY:-}" ]; then
    log "DISPLAY=${DISPLAY} already set; using the display that is there."
    return 0
  fi
  if ! command -v Xvfb >/dev/null 2>&1; then
    log "Xvfb is not installed; the browser tool will run headless."
    return 1
  fi

  # A container that was restarted (rather than recreated) can leave the lock
  # behind with no process attached to it.
  rm -f "/tmp/.X${XVFB_DISPLAY#:}-lock" 2>/dev/null || true

  # -nolisten tcp: the display is for this container only, never the network.
  Xvfb "${XVFB_DISPLAY}" -screen 0 "${XVFB_SCREEN}" -nolisten tcp &
  local xvfb_pid=$!

  local socket="/tmp/.X11-unix/X${XVFB_DISPLAY#:}"
  local waited=0
  while [ "${waited}" -lt 100 ]; do
    if [ -e "${socket}" ]; then
      export DISPLAY="${XVFB_DISPLAY}"
      log "virtual display ${XVFB_DISPLAY} (${XVFB_SCREEN}) is up."
      return 0
    fi
    if ! kill -0 "${xvfb_pid}" 2>/dev/null; then
      log "Xvfb exited during startup; the browser tool will run headless."
      return 1
    fi
    sleep 0.1
    waited=$((waited + 1))
  done

  log "Xvfb did not come up within 10s; the browser tool will run headless."
  kill "${xvfb_pid}" 2>/dev/null || true
  return 1
}

# `|| true` so a failed display never takes the container down with it.
start_xvfb || true

exec "$@"
