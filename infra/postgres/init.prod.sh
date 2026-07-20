#!/bin/bash
# Production counterpart to infra/postgres/init.sql (used by the local dev
# stack). Runs once, on first container start, against a fresh data volume
# only — docker-entrypoint-initdb.d scripts never re-run against an
# existing volume.
#
# The dev version hardcodes raas_app's password ('raas_app') directly in
# SQL, which is fine for a throwaway local database but not safe to ship
# as-is for production. This version reads it from POSTGRES_APP_PASSWORD
# (required — see docker-compose.prod.yml and docs/deployment.md) via a
# psql heredoc, which the shell expands before psql ever sees the
# statement, so the password never lands in a checked-in file.
set -euo pipefail

: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD must be set — refusing to create raas_app with no password}"

# Database-level backstops, independent of anything the Prisma client
# does or doesn't set (connection_limit/pool_timeout in APP_DATABASE_URL
# only bound how the CLIENT waits for a connection from its own pool —
# nothing about how long Postgres itself lets a query run, or a
# transaction sit idle, once a connection is actually in use). Applied as
# ROLE defaults so they hold for every session raas_app opens, regardless
# of which process (api or worker) or which connection string parameters
# it used to get there.
#
# statement_timeout: kills any single SQL statement that runs longer than
# this — a real ceiling on a runaway or pathological query, generous
# enough that no legitimate query in this app should ever approach it.
#
# idle_in_transaction_session_timeout: kills a transaction that's been
# opened but is sitting idle (no statement currently executing) longer
# than this — the specific failure mode of application code holding a
# transaction open across a slow or hung external call (an OpenAI
# request, for example) instead of making that call before opening the
# transaction or after closing it. This is what actually reclaims a
# connection in that scenario; statement_timeout does not, since no
# statement is executing while the app is waiting on the external call.
#
# Both configurable via env (DB_STATEMENT_TIMEOUT/
# DB_IDLE_IN_TRANSACTION_TIMEOUT, see docker-compose.prod.yml) rather than
# hardcoded, with the same defaults used if unset — see DEPLOYMENT.md's
# "Database connection pool and timeouts" section for the full reasoning
# and sizing, and for how to apply this to a database that was already
# initialized before this existed (this script only runs once, against a
# fresh volume — see the file-level comment above).
: "${DB_STATEMENT_TIMEOUT:=30s}"
: "${DB_IDLE_IN_TRANSACTION_TIMEOUT:=10s}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE EXTENSION IF NOT EXISTS vector;

  -- Restricted, non-superuser application role — see the identical
  -- comment in infra/postgres/init.sql for why this exists (RLS bypass by
  -- superusers). POSTGRES_USER remains the migration-time role
  -- (DATABASE_URL); raas_app is what the running application connects as
  -- (APP_DATABASE_URL).
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'raas_app') THEN
      CREATE ROLE raas_app LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END
  \$\$;

  GRANT USAGE ON SCHEMA public TO raas_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO raas_app;

  ALTER DEFAULT PRIVILEGES FOR ROLE "$POSTGRES_USER" IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO raas_app;

  ALTER ROLE raas_app SET statement_timeout = '${DB_STATEMENT_TIMEOUT}';
  ALTER ROLE raas_app SET idle_in_transaction_session_timeout = '${DB_IDLE_IN_TRANSACTION_TIMEOUT}';
EOSQL
