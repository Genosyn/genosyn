# syntax=docker/dockerfile:1.7
# Genosyn build for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner).
#
# The scanner builds this file with the repository root as the build context
# (so the root .dockerignore applies), with network access. It then adds its
# own layer (Claude Code, debuggers, compilers) and scans the finished image
# with NO network. So everything a scan needs to build, start, and test
# Genosyn offline is fetched here: npm dependencies (including the pinned
# OpenCode and Codex binaries), native addons, and a Chromium for the browser
# tests. The checkout lives at /src, built in place, exactly as maintainers
# build it from source. See .oss-scanner/threat_model.md for what to look at
# and how to run things.
#
# Keep this building when the build changes: a new top-level package, a Node
# major bump, or a new native dependency belongs here too.
# App/server/ossScanner.test.ts pins the scanner contract (Node major matches
# .nvmrc, the checkout at /src, every project built, tests never fatal).
#
# Nothing secret is baked in. The App generates its own instance secrets on
# first boot; the boot check below deletes them with its throwaway data dir.

# Debian bookworm with Node 22, the same base as App/Dockerfile. Node 22 is
# the version pinned in .nvmrc, the other Dockerfiles, and CI. Debian rather
# than Alpine: Playwright's Chromium and the prebuilt native addons expect
# glibc, and the App ships on this base.
FROM node:22-bookworm-slim

# - The scan is offline: keep npm from phoning home on every command.
# - PLAYWRIGHT_BROWSERS_PATH: one fixed place for Playwright's Chromium,
#   independent of $HOME.
# - GENOSYN_TEST_BROWSER: the App's browser test scripts (App/scripts/test-*.ts)
#   default to an installed Google Chrome; point them at Playwright's Chromium,
#   as CI does.
ENV DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    GENOSYN_TEST_BROWSER=chromium

# System packages.
#   python3 make g++    toolchain for native addons (better-sqlite3, bcrypt)
#                       when no prebuilt binary matches
#   git openssh-client  Repositories: the server shells out to git (and ssh
#                       for SSH remotes); the Repository tests drive real git
#   bash curl ca-certificates ffmpeg libatomic1 smbclient
#                       the runtime toolset App/Dockerfile ships (coding tools,
#                       browser recordings, SMB backups, newer Node via npx)
#   procps sqlite3 jq   for whoever investigates offline: ps, the SQLite
#                       database the App creates, JSON from the API
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash ca-certificates curl ffmpeg g++ git jq libatomic1 make \
      openssh-client procps python3 smbclient sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first, from the lockfiles only, so editing source does not
# reinstall them on a rebuild. `npm ci` installs exactly the lockfile. App's
# optional dependencies carry the platform binaries for the pinned OpenCode
# (opencode-ai) and Codex (@openai/codex) runtimes and @napi-rs/canvas. The npm
# cache is kept on purpose so pure-JS reinstalls can work with `--offline`.
COPY App/package.json App/package-lock.json /src/App/
COPY Connect/package.json Connect/package-lock.json /src/Connect/
COPY Home/package.json Home/package-lock.json /src/Home/
RUN cd /src/App && npm ci --include=optional
RUN cd /src/Connect && npm ci
RUN cd /src/Home && npm ci

# Chromium for the browser tests and the App's own browser tools, at the
# version the locked playwright-core expects, with its system libraries.
# CI runs the same `playwright-core install --with-deps chromium`.
RUN cd /src/App && npx --no-install playwright-core install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Scanner contract: the checkout lives inside the image, at /src. The
# .dockerignore keeps node_modules/ and dist/ out of the context, so the
# dependencies installed above survive this copy.
COPY . /src
WORKDIR /src

# Build every project the way its own Dockerfile and CI do. A failure here
# fails the build, which is what we want: the scanner emails the log.
#   App      server -> App/dist/server (tsc), client -> App/dist/client (vite)
#   Connect  -> Connect/dist (tsc)
#   Home     -> Home/dist (tsc + vite with prerendering); its prebuild copies
#            CLI/ into Home/client/public, which is why the whole repo is here
RUN cd /src/App && npm run build
RUN cd /src/Connect && npm run build
RUN cd /src/Home && npm run build

# The pinned agent runtimes must start offline. App/Dockerfile fails its build
# on a wrong OpenCode; here a mismatch is only reported, so the rest of the
# App can still be scanned. The pin is read from App/package.json.
RUN cd /src/App; \
    pinned=$(node -p "require('./package.json').dependencies['opencode-ai']"); \
    actual=$(./node_modules/.bin/opencode --version 2>&1); \
    echo "OpenCode $actual (pinned $pinned); Codex $(./node_modules/.bin/codex --version 2>&1)"; \
    if [ "$actual" != "$pinned" ]; then echo "WARNING: OpenCode $actual is not the pinned $pinned"; fi

# --- Cheap tests -------------------------------------------------------------
# Run the unit suites so the image is known to work, but never let a failing
# or slow test abort the build. Each one is bounded by `timeout` (exit 124
# means it hit the bound) because the scanner allows the whole build 45
# minutes. Full logs stay in the image under /var/log/genosyn-tests/ as the
# baseline a scan can compare its own runs against.
RUN mkdir -p /var/log/genosyn-tests

# Genosyn Connect: a few seconds.
RUN cd /src/Connect; \
    timeout -k 30 180 npm test > /var/log/genosyn-tests/connect.log 2>&1; rc=$?; \
    tail -n 12 /var/log/genosyn-tests/connect.log; \
    if [ "$rc" -ne 0 ]; then echo "WARNING: Connect tests exited $rc (see /var/log/genosyn-tests/connect.log)"; fi

# Home (marketing site and docs): a few seconds.
RUN cd /src/Home; \
    timeout -k 30 180 npm test > /var/log/genosyn-tests/home.log 2>&1; rc=$?; \
    tail -n 12 /var/log/genosyn-tests/home.log; \
    if [ "$rc" -ne 0 ]; then echo "WARNING: Home tests exited $rc (see /var/log/genosyn-tests/home.log)"; fi

# App: a fixed, security-focused slice of the unit suite, run exactly as
# `npm test` runs it (node:test through tsx with the same --import). The whole
# suite takes CI about 30 minutes, too long for the scanner's 45-minute build;
# this slice takes about 4 minutes on 10 cores. It covers the auth and
# authorization middleware, crypto and outbound-request helpers, the MCP
# protocol, this image's own contract, and the services and routes guarding
# sign-in, sessions, delegation, Approvals, Standdowns, the Vault, tenancy,
# mail automation, and the public endpoints. It needs no network: route tests
# boot the real Express router on loopback against in-memory SQLite. A scan
# can run any other test file offline. Bounded at 15 minutes.
RUN cd /src/App; \
    start=$(date +%s); \
    timeout -k 60 900 npx tsx --test --import ./server/test/httpSetup.ts \
      "server/middleware/**/*.test.ts" \
      "server/lib/**/*.test.ts" \
      "server/mcp/**/*.test.ts" \
      "server/ossScanner.test.ts" \
      "server/services/userSessions.test.ts" \
      "server/services/authThrottle.test.ts" \
      "server/services/passkeyLogin.test.ts" \
      "server/services/ssoLogin.test.ts" \
      "server/services/companySso.test.ts" \
      "server/services/workspaceTenancy.test.ts" \
      "server/services/mcpTokens.test.ts" \
      "server/services/memberToolAuthority.test.ts" \
      "server/services/memberTurnAuthority.test.ts" \
      "server/services/taintPolicy.test.ts" \
      "server/services/approvals.test.ts" \
      "server/services/standdowns.test.ts" \
      "server/services/runtimeSecurity.test.ts" \
      "server/services/outboundNetworkPolicy.test.ts" \
      "server/services/browserRequestBoundary.test.ts" \
      "server/services/repositoryCommandRun.test.ts" \
      "server/services/hostedOauth.test.ts" \
      "server/services/mail/analysisAutomation.test.ts" \
      "server/services/mail/unsubscribe.test.ts" \
      "server/services/mail/hostPolicy.test.ts" \
      "server/services/mail/deliveryPolicy.test.ts" \
      "server/routes/authSecurity.test.ts" \
      "server/routes/passkeyLogin.test.ts" \
      "server/routes/signupInvitations.test.ts" \
      "server/routes/companySso.test.ts" \
      "server/routes/companySsoAuth.test.ts" \
      "server/routes/mcpDelegatedAuthority.test.ts" \
      "server/routes/browserAuthorityBoundary.test.ts" \
      "server/routes/browserViewerAuth.test.ts" \
      "server/routes/vault.test.ts" \
      "server/routes/vaultSources.test.ts" \
      "server/routes/browserVault.test.ts" \
      "server/routes/formsAuthenticatedRoutes.test.ts" \
      "server/routes/publicForms.boundaries.test.ts" \
      "server/routes/channelWebhooks.test.ts" \
      "server/routes/chatSurfaceWebhooks.test.ts" \
      "server/routes/integrationsHostedOauth.test.ts" \
      "server/routes/unsubscribe.test.ts" \
      > /var/log/genosyn-tests/app.log 2>&1; rc=$?; \
    tail -n 12 /var/log/genosyn-tests/app.log; \
    echo "App unit tests took $(( $(date +%s) - start ))s"; \
    if [ "$rc" -ne 0 ]; then echo "WARNING: App unit tests exited $rc (see /var/log/genosyn-tests/app.log)"; fi

# Boot the compiled App against an empty data directory, as CI's fresh-boot
# job does: the whole migration chain runs on SQLite and the server must
# answer /api/health. The throwaway data directory (database and generated
# instance secrets) is deleted in the same step, so none of it is in the image.
RUN cd /src/App; \
    rm -rf data; \
    NODE_ENV=production node dist/server/index.js > /var/log/genosyn-tests/boot.log 2>&1 & pid=$!; \
    ok=0; \
    for i in $(seq 1 120); do \
      if curl -fsS http://127.0.0.1:8471/api/health > /dev/null 2>&1; then ok=1; break; fi; \
      if ! kill -0 "$pid" 2>/dev/null; then break; fi; \
      sleep 1; \
    done; \
    kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; \
    rm -rf data; \
    tail -n 15 /var/log/genosyn-tests/boot.log; \
    if [ "$ok" = 1 ]; then echo "App booted against a fresh database and answered /api/health"; \
    else echo "WARNING: App did not answer /api/health (see /var/log/genosyn-tests/boot.log)"; fi

# The scanner adds its own layer and starts the image with `bash` in /src.
CMD ["bash"]
