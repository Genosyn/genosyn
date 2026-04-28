# syntax=docker/dockerfile:1.7
# Multi-stage build for the Genosyn App (Express API + React client).
# Client is built with Vite and served as static assets by the Express server.
#
# Runtime image bundles every supported AI-employee CLI (claude-code, codex,
# opencode, goose) so a fresh self-host can run + sign in without any host
# package management. node-pty needs a native build; we compile it in the
# deps stage with the C toolchain, then copy node_modules into runtime so
# the runtime image stays slim and doesn't need its own toolchain layer.

# ---------- deps ----------
FROM node:22-alpine AS deps
WORKDIR /app
# node-pty compiles a native addon. Alpine ships without a C toolchain, so
# pull in python3 + build-base + linux-headers for the npm install step.
RUN apk add --no-cache python3 make g++ linux-headers libstdc++
COPY package.json package-lock.json* ./
# scripts/ holds the postinstall hook (`rebuild-node-pty.mjs`); without it
# `npm ci` would fail when npm tries to run our postinstall here.
COPY scripts ./scripts
RUN npm ci

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Expects "build" script to compile both server (tsc) and client (vite build)
RUN npm run build

# ---------- runtime ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Provider CLIs + the small toolset they need at runtime. curl/bash power the
# goose installer; libstdc++ is what node-pty's native addon dynamically
# links against.
RUN apk add --no-cache bash curl libstdc++

# Pre-install the npm-distributed CLIs globally. Pinning is intentionally
# loose — these are end-user tools that ship breaking changes inside minor
# bumps; the operator can override by `npm i -g <pkg>@<ver>` post-deploy.
RUN npm install -g \
      @anthropic-ai/claude-code \
      @openai/codex \
      opencode-ai \
    && npm cache clean --force

# Goose ships a static binary via an installer script. CONFIGURE=false skips
# the interactive provider-config prompt; we always pass GOOSE_DISABLE_KEYRING=1
# at spawn time anyway. The `|| true` keeps the build green on architectures
# the script doesn't know about — the in-app installer can retry on first run.
RUN curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh \
      | CONFIGURE=false bash || true \
    && if [ -f /root/.local/bin/goose ]; then mv /root/.local/bin/goose /usr/local/bin/goose; fi

# Carry the dependency tree (with the already-compiled node-pty addon) over
# from the deps stage instead of `npm ci`-ing afresh — that'd require dragging
# the C toolchain into the runtime image. Then prune dev deps in-place.
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
