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
| `RATE_LIMIT_*`, `CHAT_HISTORY_MESSAGE_LIMIT`, `KB_DELETION_ASYNC_CHUNK_THRESHOLD` | no | api | Platform-wide defaults; per-organization overrides live in the `OrganizationUsageLimit` table, not in env. |
| `OPENAI_EMBEDDING_BATCH_SIZE`, `WORKER_LOCK_DURATION_MS`, `WORKER_STALLED_INTERVAL_MS`, `STUCK_DOCUMENT_THRESHOLD_MS`, `STUCK_DOCUMENT_SWEEP_INTERVAL_MS`, `STUCK_DOCUMENT_AUTO_RETRY` | no | worker | Tuning knobs; defaults are fine for most deployments. |
| `LOG_LEVEL` | no (`info`) | api, worker | |

Full annotated defaults for every optional variable are in
`docker-compose.prod.yml` itself (`${VAR:-default}`) and in
`apps/api/src/env.ts` / `apps/worker/src/env.ts`.

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
   `HEALTHCHECK` (`GET /health/live` for the API; a real Redis `PING` via
   `apps/worker/src/healthcheck.ts` for the worker, which has no HTTP
   server of its own).
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
