#!/bin/bash
# Restores a dump created by infra/postgres/backup.sh into the self-hosted
# `postgres` service in docker-compose.prod.yml.
#
# Safe by default: with no --target-db, this restores into a scratch
# database (raas_restore_verify), sanity-checks it, then drops it — this
# is the backup *verification* procedure (see DEPLOYMENT.md's Backups
# section) and never touches real data. Restoring over the actual
# production database is a separate, deliberately harder-to-trigger,
# destructive action: it requires --target-db matching POSTGRES_DB
# *and* --force.
#
# Usage:
#   restore.sh <dump-file>                              # verify only (scratch DB, auto-dropped)
#   restore.sh <dump-file> --target-db NAME              # restore into a named non-production DB, left in place
#   restore.sh <dump-file> --target-db raas --force      # DESTRUCTIVE: overwrite the real production database
#
# Env: COMPOSE_FILE (default docker-compose.prod.yml), ENV_FILE (default .env.prod)
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env.prod}"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <dump-file> [--target-db NAME] [--force]" >&2
  exit 1
fi
DUMP_FILE="$1"
shift

TARGET_DB=""
FORCE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --target-db)
      TARGET_DB="${2:?--target-db requires a database name}"
      shift 2
      ;;
    --force)
      FORCE=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

[ -f "$DUMP_FILE" ] || { echo "Dump file not found: $DUMP_FILE" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Env file not found: $ENV_FILE" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${POSTGRES_USER:?POSTGRES_USER must be set (via $ENV_FILE)}"
: "${POSTGRES_DB:?POSTGRES_DB must be set (via $ENV_FILE)}"

VERIFY_ONLY=false
if [ -z "$TARGET_DB" ]; then
  TARGET_DB="raas_restore_verify"
  VERIFY_ONLY=true
fi

if [ "$TARGET_DB" = "$POSTGRES_DB" ] && [ "$FORCE" != true ]; then
  echo "Refusing to restore over '$POSTGRES_DB' without --force — this replaces the current production database." >&2
  echo "Re-run as: $0 $DUMP_FILE --target-db $POSTGRES_DB --force" >&2
  exit 1
fi

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

if [ "$TARGET_DB" = "$POSTGRES_DB" ]; then
  echo "Dropping and recreating production database '$TARGET_DB' ..."
  compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$TARGET_DB\";"
else
  # Scratch/named target: drop first only if it already exists from a
  # prior interrupted run — never true for the production branch above,
  # which always drops unconditionally since that IS the intended action.
  compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$TARGET_DB\";" > /dev/null
fi
compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$TARGET_DB\";"

echo "Restoring $DUMP_FILE into '$TARGET_DB' ..."
# --no-owner (not --no-privileges): ownership can safely be reassigned to
# whichever role runs the restore, but the GRANTs that let raas_app
# actually read/write (see infra/postgres/init.prod.sh) are real restored
# state, not restore-time noise — stripping them would make a "successful"
# production restore silently leave the app without DB access.
compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$TARGET_DB" --no-owner < "$DUMP_FILE"

echo "Sanity check: querying a core table in '$TARGET_DB' ..."
compose exec -T postgres psql -U "$POSTGRES_USER" -d "$TARGET_DB" -v ON_ERROR_STOP=1 \
  -c 'SELECT count(*) AS organization_count FROM "Organization";'

if [ "$VERIFY_ONLY" = true ]; then
  echo "Verification restore succeeded — dropping scratch database '$TARGET_DB' ..."
  compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE \"$TARGET_DB\";"
  echo "Backup verified: $DUMP_FILE restores cleanly."
elif [ "$TARGET_DB" = "$POSTGRES_DB" ]; then
  echo "Production database restored from $DUMP_FILE."
  echo "If api/worker were stopped for this restore, bring them back up:"
  echo "  docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d api worker"
else
  echo "Restore into '$TARGET_DB' complete (left in place — not production, not auto-dropped)."
fi
