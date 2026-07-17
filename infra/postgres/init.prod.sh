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
EOSQL
