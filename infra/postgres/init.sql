-- Runs once, on first container start, against a fresh data volume only
-- (docker-entrypoint-initdb.d scripts do not re-run against an existing
-- volume — see docs/implementation-plan.md for the note on this).
CREATE EXTENSION IF NOT EXISTS vector;

-- Restricted, non-superuser application role. POSTGRES_USER (raas) is a
-- Postgres superuser by default in this image, and superusers always
-- bypass Row-Level Security entirely — regardless of FORCE ROW LEVEL
-- SECURITY, regardless of table ownership. That's not a hypothetical risk:
-- it was verified empirically while building the RLS migration in
-- packages/db (see docs/decisions.md). raas_app is what the running
-- application (Prisma Client at runtime, APP_DATABASE_URL) connects as.
-- raas remains the migration-time role (DATABASE_URL) since DDL needs
-- elevated privileges the app role deliberately does not have.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'raas_app') THEN
    CREATE ROLE raas_app LOGIN PASSWORD 'raas_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO raas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO raas_app;

-- So future migrations (new tenant-scoped tables in later tickets) don't
-- need a manual GRANT repeated every time — raas_app automatically gets
-- DML rights on anything raas creates going forward.
ALTER DEFAULT PRIVILEGES FOR ROLE raas IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO raas_app;

-- Database-level backstops against a runaway query or a transaction left
-- idle mid-flight (e.g. holding a connection open across a slow external
-- call) — mirrors infra/postgres/init.prod.sh's identical ALTER ROLE
-- statements (see that file's comment for the full reasoning on why both
-- of these exist and why statement_timeout alone isn't enough). Same
-- fixed values as that file's own defaults — no env-var parameterization
-- needed here, this script already hardcodes everything else about local
-- dev (see raas_app's password above).
ALTER ROLE raas_app SET statement_timeout = '30s';
ALTER ROLE raas_app SET idle_in_transaction_session_timeout = '10s';
