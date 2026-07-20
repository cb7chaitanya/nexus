# Deployment

Production deployment for this repo is docker-compose based: three
application images (`apps/api`, `apps/worker`, `apps/web`), each built from
its own multi-stage `Dockerfile`, orchestrated by
[`docker-compose.prod.yml`](./docker-compose.prod.yml) alongside Postgres,
Redis, and S3-compatible object storage.

Everything in this document was verified by actually building and running
the stack locally against real Postgres/Redis/MinIO containers — not just
written and assumed to work.

## Required environment variables

Copy [`.env.prod.example`](./.env.prod.example) to `.env.prod` and fill in
every value marked `CHANGE_ME`. `docker-compose.prod.yml` will refuse to
start with a clear error if a required variable is missing (via `${VAR:?...}`
guards) — there is no way to silently deploy with a blank secret.

| Variable | Required | Used by | Notes |
|---|---|---|---|
| `POSTGRES_USER` | yes | postgres, migrate | Migration-time superuser role. Never what the app connects as. |
| `POSTGRES_PASSWORD` | yes | postgres, migrate | |
| `POSTGRES_DB` | yes | postgres, migrate, api, worker | |
| `POSTGRES_APP_PASSWORD` | yes | postgres, api, worker | Password for `raas_app`, the restricted role Prisma actually connects as at runtime — RLS is bypassed entirely by a superuser, so this must differ from `POSTGRES_PASSWORD`. See `packages/db/src/client.ts`. |
| `DB_STATEMENT_TIMEOUT`, `DB_IDLE_IN_TRANSACTION_TIMEOUT` | no (`30s` / `10s`) | postgres | Postgres-side backstops applied as `raas_app` role defaults. See [Database connection pool and timeouts](#database-connection-pool-and-timeouts). |
| `API_DB_CONNECTION_LIMIT`, `API_DB_POOL_TIMEOUT_SECONDS` | no (`10` / `20`) | api | Prisma client connection pool sizing for `apps/api`. See [Database connection pool and timeouts](#database-connection-pool-and-timeouts). |
| `WORKER_DB_CONNECTION_LIMIT`, `WORKER_DB_POOL_TIMEOUT_SECONDS` | no (`15` / `20`) | worker | Prisma client connection pool sizing for `apps/worker`. See [Database connection pool and timeouts](#database-connection-pool-and-timeouts). |
| `REDIS_PASSWORD` | yes | redis, api, worker | Redis backs BullMQ job data and rate-limit counters in production — always password-protected, unlike the local dev stack. |
| `WEB_ORIGIN` | yes | api | The one origin allowed to make credentialed cross-origin requests. Never a wildcard — see `docs/cors-csrf-policy.md`. |
| `SESSION_JWT_SECRET` | yes | api | HMAC signing key for session JWTs. Generate with `openssl rand -base64 48`; never reuse the dev value. |
| `S3_BUCKET` | yes | api, worker | Created automatically on API boot if it doesn't exist (`ensureBucketExists`). |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | yes | api, worker, object-storage | Doubles as the bundled MinIO's root credentials when using the built-in `object-storage` service. |
| `OPENAI_API_KEY` | yes, unless both providers below are `fake` | api, worker | |
| `EMBEDDING_PROVIDER` / `LLM_PROVIDER` | no (default `openai`) | api, worker | `fake` is a real, deterministic, offline provider — never use it in a real deployment. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE` | no | api, worker | Point at a real S3/R2 provider instead of the bundled MinIO by setting these and deleting the `object-storage` service — no code change either way. |
| `API_PORT`, `WEB_PORT` | no (4000 / 3000) | api, web | Host ports published by compose. |
| `SESSION_TTL_SECONDS` | no (604800 = 7 days) | api | |
| `MAX_COMPLETION_TOKENS` | no (`1024`) | api | Hard per-request ceiling on chat completion output tokens — the real per-request cost backstop. |
| `API_SHUTDOWN_TIMEOUT_MS` | no (`25000`) | api | How long SIGTERM/SIGINT waits for an in-progress chat SSE stream to finish. Must stay below the `api` service's `stop_grace_period` (`30s`) — see [First staging deployment](#first-staging-deployment). |
| `RATE_LIMIT_*`, `CHAT_HISTORY_MESSAGE_LIMIT`, `KB_DELETION_ASYNC_CHUNK_THRESHOLD` | no | api | Platform-wide defaults; per-organization overrides live in the `OrganizationUsageLimit` table, not in env. |
| `OPENAI_EMBEDDING_BATCH_SIZE`, `WORKER_LOCK_DURATION_MS`, `WORKER_STALLED_INTERVAL_MS`, `STUCK_DOCUMENT_THRESHOLD_MS`, `STUCK_DOCUMENT_SWEEP_INTERVAL_MS`, `STUCK_DOCUMENT_AUTO_RETRY`, `STUCK_DOCUMENT_MAX_AUTO_RETRIES` | no | worker | Tuning knobs; defaults are fine for most deployments. |
| `WORKER_MAX_DOCUMENT_BYTES` | no (`209715200` = 200 MiB) | worker | Per-document in-memory guardrail during extraction. Multiplied by `WORKER_EXTRACTION_CONCURRENCY` for this worker's worst-case concurrent memory use — size both against the container's real memory limit. |
| `WORKER_PROCESSING_CONCURRENCY`, `WORKER_EXTRACTION_CONCURRENCY`, `WORKER_EMBEDDING_CONCURRENCY`, `WORKER_SWEEP_CONCURRENCY`, `WORKER_KB_CLEANUP_CONCURRENCY` | no (`10`/`4`/`2`/`1`/`2`) | worker | Per-queue BullMQ concurrency. |
| `WORKER_MAX_JOB_DURATION_MS` | no (`600000` = 10 min) | worker | Outermost per-job-attempt wall-clock ceiling. |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | no (`25000`) | worker | How long SIGTERM/SIGINT waits for active jobs to finish. Must stay below the `worker` service's `stop_grace_period` (`30s`) — see [First staging deployment](#first-staging-deployment). |
| `WORKER_REDIS_CONNECT_TIMEOUT_MS` | no (`10000`) | worker | Bounds the startup Redis PING-or-fail check. |
| `WORKER_HEALTH_PORT` | no (`3001`) | worker | `GET /health` — internal only, not published to the host (see `docker-compose.prod.yml`). |
| `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_TIMEOUT_MS` | no | worker | Job-failure alerting (see `apps/worker/src/lib/notifications/`). Unset URL selects a no-op notifier — alerting is optional, not load-bearing for the worker to start. |
| `LOG_LEVEL` | no (`info`) | api, worker | |

Full annotated defaults for every optional variable are in
`docker-compose.prod.yml` itself (`${VAR:-default}`) and in
`apps/api/src/env.ts` / `apps/worker/src/env.ts`.

## Database connection pool and timeouts

Two independent layers, both previously implicit/unset, now both explicit:

**1. Client-side pool sizing (`API_DB_CONNECTION_LIMIT`/`WORKER_DB_CONNECTION_LIMIT`
and their `_POOL_TIMEOUT_SECONDS` counterparts)** — Prisma reads
`connection_limit`/`pool_timeout` as query-string parameters on the
connection URL itself, not from `schema.prisma` (which only declares
`url = env("DATABASE_URL")` — no code or schema change needed to tune
these, only the URL `docker-compose.prod.yml` builds). Without them,
Prisma's own default pool size is `num_physical_cpus*2+1` per process —
`api` and `worker` are separate processes with completely independent,
uncoordinated pools against the *same* Postgres instance. Defaults here:
`API_DB_CONNECTION_LIMIT=10`, `WORKER_DB_CONNECTION_LIMIT=15` (worker
gets more: it runs several concurrent BullMQ workers —
processing/extraction/embedding/sweep/kb-cleanup, each with its own
concurrency setting in `apps/worker/src/env.ts` — each potentially
holding its own connection). 10 + 15 = 25 total, comfortably under
Postgres's default `max_connections=100` (unmodified by this stack),
leaving headroom for Postgres's own reserved superuser connections, the
short-lived `migrate` job, manual `psql` access during an incident, and
room to raise these before they'd become the bottleneck.

**Scaling past a single replica of `api` or `worker` requires revisiting
this math** — two `api` replicas at the default `connection_limit=10`
means 20 connections from `api` alone. Size
`(api replicas × API_DB_CONNECTION_LIMIT) + (worker replicas ×
WORKER_DB_CONNECTION_LIMIT)` to stay comfortably under `max_connections`
(raising `max_connections` itself, via a custom `postgres` `command:`/config
file, is the other lever — not configured by this stack today).

**2. Database-side timeouts (`DB_STATEMENT_TIMEOUT`/
`DB_IDLE_IN_TRANSACTION_TIMEOUT`)** — applied as `raas_app` **role**
defaults by `infra/postgres/init.prod.sh` (`ALTER ROLE raas_app SET
...`), so they hold for every session that role opens regardless of
which process or which pool it came from. These protect against a
different failure mode than the pool settings above: `connection_limit`
bounds how many connections a client *opens*; these bound what a
connection can *do* once Postgres has it:

- `statement_timeout` (default `30s`) kills any single SQL statement
  that runs longer than this — a ceiling on a runaway or pathological
  query.
- `idle_in_transaction_session_timeout` (default `10s`) kills a
  transaction that's open but has no statement currently executing —
  the specific shape of application code holding a transaction open
  across a slow or hung external call (an OpenAI request, for example)
  instead of making that call outside the transaction. `statement_timeout`
  does **not** catch this case (no statement is executing while the app
  waits on the external call) — this is the setting that actually
  reclaims that connection.

**Important operational caveat:** `docker-entrypoint-initdb.d` scripts —
`init.prod.sh` included — only run once, on first container start
against a **fresh** `raas_postgres_data` volume. They do **not** re-run
on a subsequent `docker compose up`, so an already-initialized production
database (i.e., any deployment predating this configuration) will not
pick up `DB_STATEMENT_TIMEOUT`/`DB_IDLE_IN_TRANSACTION_TIMEOUT`
automatically. Apply them once, manually, against that database instead:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "ALTER ROLE raas_app SET statement_timeout = '30s'; ALTER ROLE raas_app SET idle_in_transaction_session_timeout = '10s';"
```

(Substitute the real values if overriding the defaults via
`DB_STATEMENT_TIMEOUT`/`DB_IDLE_IN_TRANSACTION_TIMEOUT`.) This only needs
running once per database — it's a role-level `ALTER`, not tied to any
particular connection or container, and survives container
restarts/redeploys from then on.

## First staging deployment

This section is specific to standing the stack up for the *first* time on
a host that has never run it — steady-state redeploys only need
[Deployment order](#deployment-order) below.

### Pre-flight checklist

- [ ] `.env.prod` created from `.env.prod.example`, every `CHANGE_ME`
  replaced with a real value — `POSTGRES_PASSWORD` and
  `POSTGRES_APP_PASSWORD` are **different** secrets (see the env var
  table above for why: a shared value would be a copy/paste of a
  superuser password into a role that must never have superuser-level
  access).
- [ ] `WEB_ORIGIN` is the real staging URL, not a placeholder — a wrong
  value here doesn't fail loudly, it silently breaks every credentialed
  request from the web app (CORS rejection in the browser, not a
  server-side error).
- [ ] `OPENAI_API_KEY` is a real key (unless deliberately staging with
  `EMBEDDING_PROVIDER=fake`/`LLM_PROVIDER=fake` — a legitimate choice for
  a first smoke-test pass with zero OpenAI cost, see `.env.prod.example`,
  but never for anything meant to look/behave like production).
- [ ] DNS/reverse proxy/TLS termination in front of `api` and `web` is
  already provisioned — this compose stack is application-tier only (see
  the top-of-file comment in `docker-compose.prod.yml`); it does not
  terminate TLS or handle a public hostname itself.
- [ ] The host has enough free memory for `WORKER_EXTRACTION_CONCURRENCY
  × WORKER_MAX_DOCUMENT_BYTES` (defaults: `4 × 200 MiB` = 800 MiB worst
  case, on top of Node's own baseline) plus Postgres/Redis/MinIO's own
  footprint.
- [ ] If Postgres will be reachable from outside this host for
  administration, confirm `docker-compose.prod.yml` still doesn't publish
  its port (it doesn't, by design — see the top-of-file comment) and that
  any external access goes through a separate, deliberate tunnel/bastion,
  not a compose change.

### Deploy

Follow [Deployment order](#deployment-order) below for the actual
`docker compose up` command and what it does at each step.

### Smoke test

Once every service reports `healthy` (`docker compose ... ps`):

1. **Health endpoints respond from inside the network** (they're not
   published to the host — see [Observability](#observability)):
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.prod exec api \
     node -e "fetch('http://127.0.0.1:4000/health').then(r=>r.json()).then(console.log)"
   docker compose -f docker-compose.prod.yml --env-file .env.prod exec worker \
     node -e "fetch('http://127.0.0.1:3001/health').then(r=>r.json()).then(console.log)"
   ```
   Both should report `"status":"healthy"` with every individual check
   (`database`/`redis` for api; `redis`/`queues` for worker) also
   `"healthy"` — a 200 with a `false` top-level status never happens by
   design (see `apps/api/src/routes/health.ts`), but check the nested
   checks too, not just the outer status.
2. **`GET /health/live` on `api`** (published to the host, so reachable
   directly) confirms the process itself is up regardless of dependency
   state: `curl -f http://<host>:${API_PORT:-4000}/health/live`.
3. **A real signup + org creation** through `api` (`POST /auth/signup`)
   confirms Postgres RLS, session cookies, and the `raas_app` role
   grants are all correctly wired end to end — not just that Postgres is
   *reachable* (the health check's `SELECT 1` doesn't exercise RLS at
   all).
4. **A real document upload → ingestion → chat round-trip** (through
   `web`, or directly against `api` if `web` isn't wired up yet) confirms
   the full chain: presigned upload to MinIO/S3, `worker` picking up the
   ingestion job (check `worker`'s logs for `"worker ready"` at startup
   and job-completion log lines), embeddings actually written, and a chat
   request retrieving them. This is the one step that can't be
   short-circuited by checking individual services in isolation — it's
   the only thing that proves the BullMQ handoff between `api` and
   `worker` actually works against this specific deployment's Redis.
5. **Logs are structured JSON**, not `pino-pretty` output — confirms
   `NODE_ENV=production` actually took effect (`docker compose ... logs
   api worker`).

If any step fails, do not consider this stack "deployed" — work the
failure from [Deployment order](#deployment-order)'s dependency chain
(the earliest failing service in that chain is almost always the real
cause, even if a later service's logs are what you saw first) rather
than restarting services out of order.

## Deployment order

`docker-compose.prod.yml` encodes this order via `depends_on` +
`condition:` — running `docker compose -f docker-compose.prod.yml --env-file
.env.prod up -d` performs it automatically. It is documented here so the
*reason* for each step is explicit, not just the mechanics:

1. **`postgres`, `redis`, `object-storage`** start first and must each
   report healthy (real `pg_isready` / `redis-cli ping` / `mc ready`
   checks, not just "container is running").
2. **`migrate`** runs once `postgres` is healthy: applies
   `prisma migrate deploy` against the real database and exits. `api` and
   `worker` both wait on this exiting `0` (`condition:
   service_completed_successfully`) before they're allowed to start — see
   [Migrations](#migrations) below. If `migrate` fails, the deploy stops
   there; `api`/`worker` never come up against a schema they don't match.
3. **`api`** and **`worker`** start once `migrate` has succeeded and
   `redis`/`object-storage` are healthy. Each has its own Docker
   `HEALTHCHECK` — `GET /health/live` for the API, `GET /health` for the
   worker (`apps/worker/src/health-server.ts`; checks real Redis and
   BullMQ queue connectivity, not a fake always-succeeds response). Both
   ports are internal-only (see the `WORKER_HEALTH_PORT` note above) —
   reachable inside the compose network and by Docker's own HEALTHCHECK,
   not published to the host.
4. **`web`** starts once `api`'s container exists (it has no hard runtime
   dependency on the API today — the bundled page is a placeholder — but
   the ordering is future-proofed for when it starts calling the API).

To deploy from scratch:

```bash
cp .env.prod.example .env.prod   # then fill in every CHANGE_ME value
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.prod ps   # confirm all services report "healthy"
```

## Migrations

`prisma migrate deploy` runs automatically as part of every deploy — there
is no manual migration step, by design (requirement: "do not require
manual migration execution"):

- The `migrate` service in `docker-compose.prod.yml` reuses the `api`
  image (which already contains the Prisma CLI, schema, and migration
  history — see `apps/api/Dockerfile`) with its entrypoint overridden to
  `prisma migrate deploy` instead of `node apps/api/dist/index.js`.
- It runs once per `docker compose up`, waits for Postgres to be healthy,
  and both `api` and `worker` block on it succeeding.
- `prisma migrate deploy` is safe to run against an already-up-to-date
  database — it only applies migrations that haven't been recorded yet
  and is a no-op otherwise, so re-running `docker compose up` (e.g. to
  pick up a new image) never re-applies anything.
- CI independently verifies every migration applies cleanly to a fresh
  database on every PR (`.github/workflows/ci.yml`, "Verify Prisma
  migrations apply cleanly" step) — a broken migration fails the PR
  before it can reach `main`, let alone production.

## Rollback procedure

**Application code (no schema change):** roll back to the previous image
tag and restart just the affected service(s):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod pull  # if using a registry
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --no-deps api worker web
```

If deploying by building locally rather than pulling from a registry,
`git checkout <previous-good-sha>` and re-run the `up -d --build` command
from [Deployment order](#deployment-order) above.

**A migration shipped with the bad release:** Prisma migrations in this
repo are additive-by-construction (see `docs/decisions.md` and every
migration under `packages/db/prisma/migrations/` — new columns are
nullable-or-defaulted, nothing is dropped or renamed in place). That means
the previous application version almost always keeps working unmodified
against the *new* schema, so the fast, safe rollback is:

1. Roll back the application images only (see above). Leave the schema as
   the new migration left it.
2. Confirm the previous code path still works against the new schema
   (true for every migration currently in this repo).

Only if a migration is later found to be genuinely backwards-incompatible
(not true for anything currently in `prisma/migrations/`, but a real
possibility for a future one):

1. Roll back the application images first, as above — always precedes any
   database rollback, since you want the code that matches the schema
   you're rolling back *to* already running before you touch the schema.
2. Write and apply a new forward migration that reverses the change (never
   hand-edit or delete a migration file that has already shipped — Prisma
   tracks applied migrations by name in `_prisma_migrations`, and deleting
   a history entry desyncs every other environment's understanding of
   what's actually been applied).
3. Re-run `migrate deploy` via `docker compose ... up -d migrate` (or the
   full `up -d`, which runs it as part of the normal sequence).

**Full stack rollback:** `docker compose -f docker-compose.prod.yml
--env-file .env.prod down` stops every service without touching the named
volumes (`raas_postgres_data`, `raas_redis_data`,
`raas_object_storage_data` are not removed by a plain `down`) — data
survives a full stack restart. Only `down -v` deletes volumes, and that
should never be run against a real deployment's data without a separate,
verified backup.

## CI

`.github/workflows/ci.yml` runs on every PR: install → lint → typecheck →
build → verify Prisma migrations apply cleanly to a fresh database →
run the full test suite (against real Postgres/Redis service containers,
matching this repo's existing no-mocking testing philosophy). On push to
`main`, a second job builds all three production images
(`apps/api/Dockerfile`, `apps/worker/Dockerfile`, `apps/web/Dockerfile`)
and pushes them to GHCR, tagged both `latest` and the commit SHA.

## Observability

Full detail in [OBSERVABILITY.md](./OBSERVABILITY.md) — this section is the
deployment-specific subset.

- **Scrape targets**: `GET /metrics` on `apps/api` (same port as the rest of
  the API) and `GET /metrics` on `apps/worker` (`WORKER_HEALTH_PORT`, same
  internal-only port `GET /health` already uses — see the env var table
  above). Both are Prometheus exposition format (`prom-client`), both
  unauthenticated.
- **Do not expose either `/metrics` endpoint publicly.** They carry no
  tenant data, but they are operational detail (request rates, queue
  throughput, error rates) an attacker can use for reconnaissance. Same
  posture as `GET /health`: reachable inside the compose/cluster network and
  by whatever scrapes it, never published to a public load balancer.
  `docker-compose.prod.yml` already keeps `WORKER_HEALTH_PORT` internal-only
  for this reason; a real Prometheus deployment should scrape both apps over
  the same private network, not through any public ingress.
- **No new required environment variables.** Metrics and the
  `@raas/observability` no-op error tracker both work with zero
  configuration. `SENTRY_DSN` (or an equivalent) is only relevant if a
  deployment later adopts a real error tracker — see OBSERVABILITY.md's
  "Adopting a real tracker" section; nothing in this repo reads that
  variable today.
- **Log aggregation**: both apps already log structured JSON (pino) to
  stdout in production (`NODE_ENV=production` disables `pino-pretty` — see
  `packages/logger`), so a standard container log driver / log-shipping
  sidecar (CloudWatch, Loki, Datadog Agent, etc.) needs no app-side change
  to start collecting `requestId`/`organizationId`/`jobId`-correlated logs.
