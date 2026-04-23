# syntax=docker/dockerfile:1.7
# Multi-stage build for the Genosyn marketing site.
# React + Vite static build, served by a tiny Express process.
#
# NOTE: Docker build context is the repo root (see docker.yml), because
# Home's prebuild runs `cp ../CLI/genosyn ...` and the CLI directory is a
# sibling of Home/. We mirror the repo layout inside the image at /build/
# so the relative path resolves the same way it does in local dev.

# ---------- deps ----------
FROM node:22-alpine AS deps
WORKDIR /build/Home
COPY Home/package.json Home/package-lock.json* ./
RUN npm ci

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /build/Home
COPY --from=deps /build/Home/node_modules ./node_modules
COPY Home /build/Home
COPY CLI /build/CLI
RUN npm run build

# ---------- runtime ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY Home/package.json Home/package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /build/Home/dist ./dist

RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
