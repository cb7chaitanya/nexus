# syntax=docker/dockerfile:1.7
#
# Multi-stage build for @raas/web, built from the monorepo root:
#   docker build -f apps/web/Dockerfile -t raas-web .
#
# Uses Next.js's "standalone" output (see apps/web/next.config.mjs) rather
# than the pruner/full-copy shape apps/api and apps/worker use: Next's own
# build-trace step already produces a minimal, self-contained server
# bundle (server.js + only the node_modules it actually resolved as
# reachable), which is the officially documented Docker pattern for
# Next.js and needs no separate node_modules copy at all.
#
# Verified locally end-to-end: boots, serves the placeholder page with
# HTTP 200, runs as a non-root uid, and Docker's own HEALTHCHECK reports
# healthy.

FROM node:22.14.0-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

FROM base AS pruner
WORKDIR /app
COPY . .
RUN pnpm dlx turbo prune @raas/web --docker

FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* vars are inlined into the client bundle at `next build`
# time, not read at container runtime — a Docker build is sandboxed from
# the eventual container's runtime env, so this must be explicitly
# threaded through as a build ARG (Railway auto-populates build ARGs
# from service variables of the same name when the Dockerfile declares
# them) or every fetch in apps/web silently falls back to its
# http://localhost:4000 dev default, baked in permanently until rebuilt.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm exec turbo run build --filter=@raas/web

# ---- runtime: just the standalone server output ----
FROM node:22.14.0-bookworm-slim AS runner
RUN groupadd --system --gid 1001 raas \
    && useradd --system --uid 1001 --gid raas webuser
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder --chown=webuser:raas /app/apps/web/.next/standalone ./
# Standalone output deliberately excludes static assets and public/ —
# Next's own docs call out that these must be copied in by hand.
COPY --from=builder --chown=webuser:raas /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=webuser:raas /app/apps/web/public ./apps/web/public
USER webuser
ENV PORT=3000
# Next's standalone server.js defaults HOSTNAME to localhost, which binds
# only the container's loopback interface — unreachable through Docker's
# port forwarding (that arrives via the container's real network
# interface, not 127.0.0.1). Must be explicit.
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
