# syntax=docker/dockerfile:1.7
# Multi-stage build for the Genosyn App (Express API + React client).
# Client is built with Vite and served as static assets by the Express server.
#
# API-key and custom models talk to their APIs directly in-process. The pinned
# `@openai/codex` dependency contributes one narrow official app-server binary
# for self-hosted OpenAI subscription models; generic provider CLIs remain
# removed. The rest of the runtime toolset is a shell + git for Genosyn's
# coding/repo tools and a real Google Chrome for its browser tool.
#
# The base is Debian, not Alpine, and that is load-bearing rather than taste.
# Google ships Chrome for glibc only; on musl the best available browser was
# Alpine's `chromium` package, which meant the browser tool was a Chromium
# wearing a hand-written "I am Chrome on macOS" costume. Sites do not detect
# automation so much as they detect *contradictions*, and that costume
# contradicted itself at every layer a fingerprinting script reads — fonts,
# WebGL renderer, `navigator.platform`, codec support. Debian + real Chrome
# removes the contradictions by removing the costume. See `config.browser`.

# ---------- deps ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /build/App
# better-sqlite3 compiles a native addon; slim images ship no C toolchain.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY App/package.json App/package-lock.json* ./
RUN npm ci

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /build/App
COPY --from=deps /build/App/node_modules ./node_modules
COPY App ./
# CI passes the version and short commit SHA as build args; vite.config.ts reads them from env
# and bakes them into the client bundle so the UI footer shows what
# operators are actually running.
ARG APP_VERSION=dev
ARG APP_COMMIT=local
ENV APP_VERSION=$APP_VERSION
ENV APP_COMMIT=$APP_COMMIT
# Expects "build" script to compile both server (tsc) and client (vite build)
RUN npm run build

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ENV NODE_ENV=production
WORKDIR /app

# The small toolset the built-in tools need at runtime. bash backs the `bash`
# coding tool; git + openssh-client back the Code Repositories feature (the
# server shells out to `git` to clone/fetch/checkout before every run, and
# SSH-auth repos run `ssh` via GIT_SSH_COMMAND); curl is a common utility the
# `bash` tool reaches for, and is also how the Chrome apt key is fetched below.
#
# smbclient backs the `smb` backup destination kind, which pushes archives to a
# NAS with no mount required. It's here rather than as an npm dependency
# because every JS SMB client tops out at SMB 2.1 and none of them implement
# signing — services/backupDestinations.ts shells out to `smbclient` to get
# SMB3 + signing/encryption. Self-hosters who only ever use the `local` or
# `sftp` kinds pay the layer size but nothing else; the SMB code path reports a
# clear error if the binary is ever absent.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash bubblewrap ca-certificates curl ffmpeg git openssh-client \
      pulseaudio pulseaudio-utils smbclient \
    && rm -rf /var/lib/apt/lists/*

# Real Google Chrome from Google's own apt repository, for both linux/amd64 and
# linux/arm64 — Google shipped official arm64 Linux builds in July 2026, which
# is what makes a single Chrome-based image possible across the CI matrix.
#
# The key is stored ASCII-armoured and referenced with `signed-by`, so the repo
# is trusted for Chrome alone and the image needs no gnupg. `apt-get install`
# fails loudly if the package is missing for an architecture, which is the
# failure mode we want: a silent downgrade to Chromium is exactly the thing
# this image exists to avoid.
#
# Xvfb gives Chrome a display so it can run *headed*. Headless is the single
# loudest automation signal a browser emits, and the entrypoint's virtual
# display is what lets us avoid emitting it.
#
# The font packages matter more than they look. Font enumeration is a standard
# fingerprinting axis, and a "desktop Chrome" that can only render one bitmap
# family is not credible. fonts-noto-cjk is deliberately left out: it is ~200MB
# and only affects rendering of CJK text, not the credibility of the profile.
RUN install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
         -o /etc/apt/keyrings/google-chrome.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main" \
         > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      google-chrome-stable \
      xvfb \
      fonts-liberation fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Fail the build if this is not actually Google Chrome. `browserProfile.ts`
# decides whether to apply its compatibility mask by asking the binary what it
# is, so an image that quietly shipped Chromium would quietly go back to
# wearing a costume — and we would find out from a blocked Routine rather than
# from CI.
RUN google-chrome-stable --version | grep -q "Google Chrome"

# Named for Playwright's convention and read by `browserProfile.ts` and
# `htmlToPdf.ts`. It points at Chrome, not Chromium; the variable name is
# historical.
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Xvfb runs as the unprivileged `node` user and puts its socket here. /tmp is
# already 1777 on Debian, but creating the directory in the image means the
# very first browser launch doesn't race the display coming up.
RUN install -d -m 1777 /tmp/.X11-unix

# Carry the dependency tree over from the deps stage instead of `npm ci`-ing
# afresh — that'd require dragging the C toolchain into the runtime image. Then
# prune dev deps in-place.
COPY App/package.json App/package-lock.json* ./
COPY --from=deps /build/App/node_modules ./node_modules
RUN npm prune --omit=dev && npm cache clean --force

# Built artifacts (server + client)
COPY --from=build /build/App/dist ./dist

# config.ts is bundled by tsc into dist/. Keep the source as a reference only;
# the runtime imports dist/config.js, so configuration changes require rebuilding
# the image rather than editing or mounting this copy after the build.
COPY --from=build /build/App/config.ts ./config.ts

# Starts the virtual display and the private audio server used by the Google
# Meet notetaker, then execs CMD.
COPY --chmod=0755 App/docker-entrypoint.sh /usr/local/bin/genosyn-entrypoint

# Fail the image build if the standard runtime contract drifts: command
# execution is on out of the box, and the only mode the stock image may ship it
# in is bubblewrap, whose executable therefore has to be here. A host that
# refuses user namespaces falls back to disabled at boot, which is why this
# check does not enter a namespace and the build needs no privileged flags.
RUN command -v bwrap >/dev/null \
    && bwrap --version >/dev/null \
    && node --input-type=module -e 'const { config } = await import("./dist/config.js"); if (config.agent.codingTools.executionMode !== "bubblewrap") throw new Error(`Expected stock executionMode=bubblewrap, received ${config.agent.codingTools.executionMode}`);'

# Help conversations can inspect the exact code that produced this image.
# Keep the snapshot read-only by placing it outside config.dataDir and exposing
# it only through the in-process list/search/read Help tools. The root context
# is deliberate: App, Home, CLI, roadmap, docs, and delivery workflows all
# belong to the product context an AI Employee may need to explain.
COPY --chown=node:node \
  AGENTS.md CLAUDE.md CONTRIBUTING.md LICENSE README.md RELEASING.md ROADMAP.md VERSION \
  ./.genosyn-source/
COPY --chown=node:node App ./.genosyn-source/App
COPY --chown=node:node Home ./.genosyn-source/Home
COPY --chown=node:node CLI ./.genosyn-source/CLI
COPY --chown=node:node .github ./.genosyn-source/.github
# `App/config.ts` may contain deployment secrets in source-built images. Help
# does not belong in the Help snapshot. Help then reads only files named by an
# immutable release manifest and applies a second fail-closed path denylist.
# Source-managed development derives the equivalent allowlist from Git-tracked
# files.
RUN rm .genosyn-source/App/config.ts \
    && find .genosyn-source -type f -print | sed 's#^\.genosyn-source/##' | sort > .genosyn-source/.genosyn-help-manifest \
    && mv .genosyn-source genosyn-source \
    && chmod -R a-w genosyn-source

# Runtime data lives here — mount a volume in production
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

USER node
EXPOSE 8471
ENTRYPOINT ["/usr/local/bin/genosyn-entrypoint"]
CMD ["node", "dist/server/index.js"]
