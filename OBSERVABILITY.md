# Observability

This document covers the three pieces of the production observability layer:
metrics (`GET /metrics`), structured logging correlation, and the error-tracking
abstraction (`@raas/observability`). Health endpoints are covered briefly here
and in more operational detail in [DEPLOYMENT.md](./DEPLOYMENT.md).

None of this changes any business logic — every piece is additive
instrumentation wired onto existing request/job lifecycle hooks (Fastify's
`onRequest`/`onResponse`, BullMQ's `Worker` events, the single `recordUsage`
chokepoint in `packages/usage`), never inside a route handler's or
processor's own decision logic.

---

## 1. Metrics (`packages/metrics`, prom-client)

Both `apps/api` and `apps/worker` are separate processes (see
`docs/architecture.md`'s modular-monolith decision) and therefore have their
own, independent prom-client `Registry` — each exposes its own `GET
/metrics`, scraped separately:

| Process | Endpoint | Notes |
|---|---|---|
| `apps/api` | `GET /metrics` (Fastify route, `plugins/metrics.ts`) | Same port as the rest of the API. |
| `apps/worker` | `GET /metrics` (plain `node:http`, `health-server.ts`) | Same internal-only port as `GET /health` (`WORKER_HEALTH_PORT`, default `3001`). |

Neither route requires authentication — same trust model as `GET /health`
(a Prometheus scraper carries no session cookie or API key). **Do not expose
either port to the public internet** — see
[DEPLOYMENT.md's Observability section](./DEPLOYMENT.md#observability) for
the network posture this assumes.

### Metric families

| Metric | Type | Labels | Process |
|---|---|---|---|
| `raas_http_requests_total` | Counter | `method`, `route`, `status_code` | api |
| `raas_http_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | api |
| `raas_http_errors_total` | Counter | `method`, `route`, `status_code` (>=400) | api |
| `raas_ingestion_jobs_started_total` | Counter | `queue`, `job_name` | worker |
| `raas_ingestion_jobs_completed_total` | Counter | `queue`, `job_name` | worker |
| `raas_ingestion_jobs_failed_total` | Counter | `queue`, `job_name` | worker |
| `raas_document_processing_duration_seconds` | Histogram | `queue`, `job_name` | worker |
| `raas_document_ingestion_duration_seconds` | Histogram | *(none)* | worker |
| `raas_embedding_tokens_total` | Counter | `model` | worker (recorded via `recordUsage`) |
| `raas_llm_tokens_total` | Counter | `model`, `kind` (`prompt`\|`completion`) | api (recorded via `recordUsage`) |
| `raas_process_*`, `raas_nodejs_*` | various | — | both (prom-client's `collectDefaultMetrics`) |

Two duration metrics on the worker, deliberately distinct:

- `raas_document_processing_duration_seconds` — one BullMQ job's own
  `processedOn` → `finishedOn` span, labeled by which pipeline stage it was
  (`extract-text`, `chunk-text`, `embed-chunks`, `process-document`). Useful
  for spotting which *stage* is slow.
- `raas_document_ingestion_duration_seconds` — the whole document's
  end-to-end pipeline duration (enqueue → the `process-document` parent job
  completing, which BullMQ only runs once every child/fanned-out job has
  finished). Useful for "how long does a customer actually wait."

### Cardinality — the one rule that matters

**No metric in this package is ever labeled by `organizationId`,
`documentId`, `userId`, or any other per-tenant/per-item identifier.**
Prometheus label values are a time series each; a per-org label on a
multi-tenant SaaS with an open-ended number of organizations grows without
bound and will eventually take down whatever scrapes it. Per-org detail
already has a home: the `UsageEvent` table (`packages/usage`), queried via
`GET /organizations/:id/usage`. HTTP `route` labels use the **matched route
pattern** (`/kb/:id/documents`), never the raw URL — same reasoning.

If you're adding a new metric: ask whether every label's value set is
*fixed and small* (HTTP methods, queue names, model names — yes) or
*grows with the number of tenants/documents/users* (no). Only the former
belongs on a label.

### Example PromQL

```promql
# API request rate by route
sum(rate(raas_http_requests_total[5m])) by (route)

# 5xx error rate
sum(rate(raas_http_errors_total{status_code=~"5.."}[5m]))

# p95 request latency
histogram_quantile(0.95, sum(rate(raas_http_request_duration_seconds_bucket[5m])) by (le, route))

# Ingestion failure rate by stage
sum(rate(raas_ingestion_jobs_failed_total[5m])) by (queue, job_name)

# p95 end-to-end document ingestion time
histogram_quantile(0.95, sum(rate(raas_document_ingestion_duration_seconds_bucket[5m])) by (le))

# Embedding token spend rate
sum(rate(raas_embedding_tokens_total[1h])) by (model)
```

---

## 2. Structured logging (`@raas/logger`, unchanged implementation)

No new logging package — `@raas/logger`'s existing `createLogger`/`Logger`
mechanism (pino) is the only logger in this codebase; this ticket only adds
fields to the bindings already flowing through it.

### API (`apps/api`) — every `request.log` line carries

| Field | Source | Present on |
|---|---|---|
| `requestId` | Fastify's `genReqId` (`app.ts`) | every request |
| `method`, `route` | `plugins/metrics.ts`'s `onRequest` hook | every request (route falls back to `"unmatched_route"` for a 404) |
| `userId` | `requireAuth` (`plugins/auth-guard.ts`) | authenticated requests only |
| `organizationId` | `requireMembership` / `requireOrgMembership` | org-scoped requests only |

`method`/`route` are bound in the same `onRequest` hook that records the
HTTP metrics above — both need "which route matched," so one hook resolves
it once rather than two hooks duplicating the lookup.

### Worker (`apps/worker`) — every job logger (`createJobLogger`) carries

| Field | Present on |
|---|---|
| `jobId` | every job |
| `organizationId`, `documentId`, `knowledgeBaseId` | every ingestion-pipeline job (`extract-text`, `chunk-text`, `embed-chunks`, `process-document`) |
| `requestId` | every job enqueued from an HTTP request (i.e. everything except the stuck-document sweep's auto-retry, which has no originating request) |

`requestId` is threaded from the API's `request.id`, through
`enqueueDocumentIngestion`'s job payload, through `chunk-text`'s dynamic
`embed-chunks` fan-out, into every processor's `createJobLogger` call — so a
document's worker-side logs can be correlated back to the exact HTTP request
that triggered them, not just to each other via `documentId`.

---

## 3. Error tracking (`packages/observability`)

A vendor-neutral abstraction, not a Sentry integration:

```ts
import { captureException } from "@raas/observability";

captureException(err, { requestId, organizationId, route });
```

- **Default**: `NoopErrorTracker` — does nothing. Every unexpected error is
  already logged independently (`request.log.error` in
  `apps/api/src/plugins/error-handler.ts`, `createJobLogger(...).error` in
  `apps/worker/src/lib/job-failure-alerts.ts`), so a deployment that never
  configures a real tracker loses nothing beyond the aggregation/alerting a
  dedicated service adds on top of logs.
- **`@sentry/node` is never a dependency of this package** —
  `packages/observability/package.json` has zero runtime dependencies.
  `SentryAdapter` is structurally typed against a minimal
  `SentryLikeClient` interface, not an import of the real SDK.

`captureException` is wired into four places — all already the "this is
unexpected, not routine" branch in existing error handling, never a normal
control-flow path:

- `apps/api/src/plugins/error-handler.ts`, the unhandled/500 branch (never
  the `ApiError`/known-4xx branches above it — those are expected,
  client-caused failures, not bugs).
- `apps/worker/src/lib/job-failure-alerts.ts`, only once `job.finishedOn` is
  set (BullMQ has definitively given up retrying) — never on a transient,
  still-retryable attempt.
- Both apps' `uncaughtException`/`unhandledRejection` process-level handlers
  (`apps/api/src/index.ts`, `apps/worker/src/index.ts`) — see "Crash
  handling" below.
- Both apps' top-level `main().catch(...)` — a failure during startup itself
  (before either app is serving anything).

### Adopting a real tracker (Sentry)

Wired up in both apps (`apps/api/src/lib/sentry.ts`,
`apps/worker/src/lib/sentry.ts`), each calling `initSentry()` once at the top
of `main()`, before anything that could fail:

```ts
// apps/api/src/lib/sentry.ts (apps/worker/src/lib/sentry.ts mirrors it)
import * as Sentry from "@sentry/node";
import { SentryAdapter, setErrorTracker } from "@raas/observability";
import { env } from "../env.js";

export function initSentry(): void {
  if (!env.SENTRY_DSN) return;
  Sentry.init({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV });
  setErrorTracker(new SentryAdapter(Sentry));
}
```

`SENTRY_DSN` is optional and unset by default (local dev, and any deployment
that hasn't adopted Sentry) — `initSentry()` is then a no-op and every
`captureException` call keeps going to `NoopErrorTracker`, exactly as before
this existed. Set `SENTRY_DSN` (see `docker-compose.prod.yml`,
`.env.prod.example`) to start actually capturing.

Any other tracker works the same way — implement `ErrorTracker`
(`captureException(error, context)`) and pass it to `setErrorTracker`. No
change to `error-handler.ts`, `job-failure-alerts.ts`, or anywhere else that
calls `captureException`.

### Crash handling: `uncaughtException` / `unhandledRejection`

Both apps register process-level handlers for both events (near the top of
`main()`, right after the app/worker is constructed) — Node's own default
for an uncaught exception or unhandled rejection with no listener is to
print it and exit `1`; registering a handler takes over that responsibility
entirely, so both handlers are written to *never swallow the crash*: every
path through them ends in `process.exit`, non-zero, including a failure
inside the handler itself.

Each handler, in order:

1. `captureException(err, { source: "uncaughtException" | "unhandledRejection" })`.
2. A structured `error`-level log line (the app/worker logger, not `console`).
3. The same `gracefulShutdown` a clean `SIGTERM` uses — draining in-flight
   work (an in-progress chat SSE stream for `apps/api`, an active job for
   `apps/worker`) within the existing `API_SHUTDOWN_TIMEOUT_MS`/
   `WORKER_SHUTDOWN_TIMEOUT_MS` ceiling — then `process.exit(1)`. A crash on
   one request/job is not a reason to sever every other in-flight connection
   instantly.
4. If step 1–3 themselves throw, a `try`/`catch` around the whole handler
   forces `process.exit(1)` immediately as a last resort, so a secondary
   failure while handling the first one still can't leave the process
   hanging.

If a signal-triggered shutdown is already draining when a crash fires, the
crash is still captured and logged, but the existing shutdown's own (`0`)
exit code wins the race rather than starting a second, competing shutdown —
a deliberate, documented tradeoff (see the identical guard comment in both
`index.ts` files), not an oversight.

---

## 4. Health endpoints (pre-existing, verified — not new in this ticket)

| Process | Endpoint | Checks |
|---|---|---|
| `apps/api` | `GET /health/live` | Process is up — no dependency checks (liveness). |
| `apps/api` | `GET /health` | Postgres (`SELECT 1`) + Redis (`PING`) (readiness). |
| `apps/worker` | `GET /health` | Redis `PING`, a real BullMQ `getJobCounts()` call on every registered queue, every registered `Worker.isRunning()`, and `lastSuccessfulJobAt` (module-level state, set on every job completion — see `lib/health-state.ts`). |

Both return `503` (not `200` with a false body) on failure, so an
orchestrator's HTTP-status-based readiness check works without parsing the
response body. Tests: `apps/api/src/routes/health.test.ts`,
`apps/worker/src/health-server.test.ts`.
