#!/bin/bash
# Production Postgres backup for the self-hosted `postgres` service in
# docker-compose.prod.yml (pgvector/pgvector:pg16). pg_dump runs INSIDE
# that container via `docker compose exec` — never against a host-installed
# pg_dump — so its version always exactly matches the server's, with no
# client/server version-skew risk.
#
# Writes a single custom-format dump (`pg_dump -F c`): compressed, and
# unlike a plain SQL dump it can be integrity-checked (`pg_restore --list`)
# without needing a live database to restore into — this script does that
# check on every run, so a corrupt/truncated dump fails loudly here rather
# than being discovered during a real recovery.
#
# Usage: infra/postgres/backup.sh
#
# Env (all optional except needing a valid ENV_FILE to read secrets from):
#   COMPOSE_FILE           docker-compose.prod.yml (default)
#   ENV_FILE                .env.prod (default) — read for POSTGRES_USER/POSTGRES_DB
#   BACKUP_DIR              ./backups (default)
#   BACKUP_RETENTION_DAYS   14 (default) — dumps older than this are deleted
#                           after a successful backup; see DEPLOYMENT.md's
#                           Backups section for why 14 was chosen and how
#                           to change it.
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.prod}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

[ -f "$ENV_FILE" ] || { echo "Env file not found: $ENV_FILE" >&2; exit 1; }

# Only used to read POSTGRES_USER/POSTGRES_DB here — never printed, never
# passed to anything outside this script's own docker compose invocations.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${POSTGRES_USER:?POSTGRES_USER must be set (via $ENV_FILE)}"
: "${POSTGRES_DB:?POSTGRES_DB must be set (via $ENV_FILE)}"

mkdir -p "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump_file="$BACKUP_DIR/raas_${POSTGRES_DB}_${timestamp}.dump"

echo "Backing up database '$POSTGRES_DB' -> $dump_file"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -F c > "$dump_file"

echo "Verifying dump integrity (pg_restore --list) ..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T postgres \
  pg_restore --list < "$dump_file" > /dev/null
echo "OK: dump is a valid, listable pg_restore archive."

size_bytes=$(wc -c < "$dump_file" | tr -d ' ')
echo "Backup complete: $dump_file (${size_bytes} bytes)"

echo "Applying retention: deleting backups older than ${BACKUP_RETENTION_DAYS} days in $BACKUP_DIR ..."
find "$BACKUP_DIR" -maxdepth 1 -name 'raas_*.dump' -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete

echo "Done."
