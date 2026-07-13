-- Runs once, on first container start, against a fresh data volume only
-- (docker-entrypoint-initdb.d scripts do not re-run against an existing
-- volume — see docs/implementation-plan.md for the note on this).
CREATE EXTENSION IF NOT EXISTS vector;
