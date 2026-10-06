# syntax=docker/dockerfile:1.7
# Genosyn Connect — the hosted OAuth sign-in service (connect.genosyn.com).
#
# The build context is the repo root, like the App and Home images, so the
# published image can carry the license. Only Connect/ and LICENSE are copied.
#
# The image holds no secrets, and the service keeps no state: a sign-in's
# context travels sealed with it. Configuration is environment variables (see
# Connect/README.md); replicas need only the same CONNECT_SECRET.

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /build/Connect
COPY Connect/package.json Connect/package-lock.json ./
RUN npm ci
COPY Connect ./
RUN npm run build

# ---------- runtime ----------
FROM node:22-alpine AS runtime
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ENV NODE_ENV=production
WORKDIR /app

COPY Connect/package.json Connect/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/Connect/dist ./dist

# Apache-2.0 section 4(a): the published image is a redistribution.
COPY LICENSE ./

USER node
EXPOSE 8473
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8473}/healthz" || exit 1
CMD ["node", "dist/index.js"]
