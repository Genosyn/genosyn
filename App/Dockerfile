# syntax=docker/dockerfile:1.7
# Multi-stage build for the Genosyn App (Express API + React client).
# Client is built with Vite and served as static assets by the Express server.
#
# The App talks to model APIs (Anthropic / OpenAI / any OpenAI-compatible
# endpoint) directly, in-process — there are no provider CLIs to bundle. The
# runtime image only needs the toolset the built-in tools use: a shell + git
# for the coding/repo tools and Chromium for the browser tool.

# ---------- deps ----------
FROM node:22-alpine AS deps
WORKDIR /app
# better-sqlite3 compiles a native addon. Alpine ships without a C toolchain,
# so pull in python3 + build-base + linux-headers for the npm install step.
RUN apk add --no-cache python3 make g++ linux-headers libstdc++
COPY package.json package-lock.json* ./
RUN npm ci

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build context is ./App, so .git lives outside it. CI passes the version
# and short commit SHA as build args; vite.config.ts reads them from env
# and bakes them into the client bundle so the UI footer shows what
# operators are actually running.
ARG APP_VERSION=dev
ARG APP_COMMIT=local
ENV APP_VERSION=$APP_VERSION
ENV APP_COMMIT=$APP_COMMIT
# Expects "build" script to compile both server (tsc) and client (vite build)
RUN npm run build

# ---------- runtime ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The small toolset the built-in tools need at runtime. bash backs the `bash`
# coding tool; git + openssh-client back the Code Repositories feature (the
# server shells out to `git` to clone/fetch/checkout before every run, and
# SSH-auth repos run `ssh` via GIT_SSH_COMMAND); curl is a common utility the
# `bash` tool reaches for. libstdc++ is what better-sqlite3's native addon and
# Chromium dynamically link against. chromium + nss + freetype + harfbuzz +
# ttf-freefont + ca-certificates back the built-in `browser` MCP server (driven
# by playwright-core when AIEmployee.browserEnabled is true). Playwright's
# bundled Chromium is glibc and won't run on musl, so we use the apk build and
# point playwright-core at it via PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
#
# samba-client (~54MB) backs the `smb` backup destination kind, which pushes
# archives to a NAS with no mount required. It's here rather than as an npm
# dependency because every JS SMB client tops out at SMB 2.1 and none of them
# implement signing — services/backupDestinations.ts shells out to `smbclient`
# to get SMB3 + signing/encryption. Self-hosters who only ever use the `local`
# or `sftp` kinds pay the layer size but nothing else; the SMB code path
# reports a clear error if the binary is ever absent.
RUN apk add --no-cache \
      bash curl libstdc++ git openssh-client \
      chromium nss freetype harfbuzz ca-certificates ttf-freefont \
      samba-client
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Carry the dependency tree over from the deps stage instead of `npm ci`-ing
# afresh — that'd require dragging the C toolchain into the runtime image. Then
# prune dev deps in-place.
COPY package.json package-lock.json* ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev && npm cache clean --force

# Built artifacts (server + client)
COPY --from=build /app/dist ./dist

# config.ts is bundled by tsc into dist/, but keep the source around for
# self-hosters who want to read/edit it post-build.
COPY --from=build /app/config.ts ./config.ts

# Runtime data lives here — mount a volume in production
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

USER node
EXPOSE 8471
CMD ["node", "dist/server/index.js"]
