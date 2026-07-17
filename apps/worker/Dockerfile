# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @raas/worker, built from the monorepo root:
#   docker build -f apps/worker/Dockerfile -t raas-worker .
#
# Same pruner/builder/runner shape as apps/api/Dockerfile — see that
# file's header comment for the reasoning. The one difference: the worker
# has no HTTP server (it's a pure BullMQ consumer, see
# docs/architecture.md), so there's no port for an orchestrator to probe.
# HEALTHCHECK instead runs apps/worker/src/healthcheck.ts (compiled to
# dist/healthcheck.js) — a real Redis PING on the same connection the
# worker itself runs on, not a fake always-succeeds check.
#
# Verified locally end-to-end against the docker-compose dev stack: boots,
# connects to Redis, logs "worker ready", runs as a non-root uid, and
# Docker's own HEALTHCHECK reports healthy.

FROM node:22.14.0-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

FROM base AS pruner
WORKDIR /app
COPY . .
RUN pnpm dlx turbo prune @raas/worker --docker

FROM base AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ openssl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm exec turbo run build --filter=@raas/worker

FROM node:22.14.0-bookworm-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 raas \
    && useradd --system --uid 1001 --gid raas workeruser
WORKDIR /app
COPY --from=builder --chown=workeruser:raas /app .
USER workeruser
ENV NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "apps/worker/dist/healthcheck.js"]
CMD ["node", "apps/worker/dist/index.js"]
