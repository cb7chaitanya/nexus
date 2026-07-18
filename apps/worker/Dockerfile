# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @raas/worker, built from the monorepo root:
#   docker build -f apps/worker/Dockerfile -t raas-worker .
#
# Same pruner/builder/runner shape as apps/api/Dockerfile — see that
# file's header comment for the reasoning. The worker now runs a small
# internal HTTP server (see src/health-server.ts) purely for GET /health —
# not published to the host by default (see docker-compose.prod.yml),
# reachable only inside the compose network / by Docker's own HEALTHCHECK
# below, which checks real Redis + BullMQ queue connectivity, not a fake
# always-succeeds response.
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
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/worker/dist/index.js"]
