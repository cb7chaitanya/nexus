# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @raas/api, built from the monorepo root:
#   docker build -f apps/api/Dockerfile -t raas-api .
#
# Stages:
#   pruner  — turbo prune reduces the monorepo to just @raas/api + its
#             workspace dependencies, so the (large) build context isn't
#             copied wholesale into a layer that gets thrown away anyway.
#   builder — full install (dev + prod deps, needed for tsc/prisma
#             generate) and compile. Never shipped — apt build tooling and
#             raw TypeScript sources stay in this stage only.
#   runner  — fresh minimal base, non-root user, only the compiled dist/
#             output, package.jsons, and node_modules the pruned workspace
#             actually produced.
#
# Verified locally end-to-end against the docker-compose dev stack
# (Postgres + Redis): boots, connects, GET /health returns 200 with both
# dependency checks healthy, runs as a non-root uid, and Docker's own
# HEALTHCHECK reports healthy.

FROM node:22.14.0-bookworm-slim AS base
# Pinned exactly (not just "pnpm@9") so a pnpm release doesn't silently
# change install/build behavior between CI and a later rebuild.
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

FROM base AS pruner
WORKDIR /app
COPY . .
RUN pnpm dlx turbo prune @raas/api --docker

FROM base AS builder
WORKDIR /app
# python3/make/g++: some transitive native deps (e.g. argon2's node-gyp
# fallback when no prebuilt binary matches) need a toolchain to install.
# openssl: required by `prisma generate` to resolve the query-engine
# binary target for this base image.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ openssl \
    && rm -rf /var/lib/apt/lists/*
# Installed from the pruned package.json/lockfile layer first so this
# (slow) step is Docker-cached across builds that only change source, not
# dependencies.
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# Builds @raas/api and every workspace package it depends on (turbo
# resolves the dependency graph itself; the pruned workspace only
# contains @raas/api's own dependency closure to begin with). This is
# also where `prisma generate` runs, as part of @raas/db's own build
# script — the generated client ends up inside node_modules, which the
# runner stage below copies wholesale.
RUN pnpm exec turbo run build --filter=@raas/api

# ---- runtime: fresh base, no build toolchain, no TypeScript sources ----
FROM node:22.14.0-bookworm-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 raas \
    && useradd --system --uid 1001 --gid raas apiuser
WORKDIR /app
# The whole pruned/built workspace, not just apps/api: pnpm's node_modules
# layout symlinks each workspace package's own node_modules (including
# @raas/* intra-workspace links) back to packages/*, and those directories
# have to exist at the same relative paths inside the image.
COPY --from=builder --chown=apiuser:raas /app .
USER apiuser
ENV NODE_ENV=production
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/dist/index.js"]
