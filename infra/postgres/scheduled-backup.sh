#!/bin/bash
# Cron/systemd entry point — wraps backup.sh (unmodified) with the
# daily/weekly retention scheme operations wants: keep the last 7 daily
# backups and the last 4 weekly backups, by count, not age. backup.sh's
# own BACKUP_RETENTION_DAYS is deliberately set high below (this wrapper
# is the actual retention policy; backup.sh's age-based cleanup is just a
# secondary backstop so BACKUP_DIR can never grow unbounded even if this
# wrapper stops running for a long time).
#
# BACKUP_ROOT defaults to $HOME/raas-backups — outside the git repo
# (never risks being committed) and outside every docker named volume
# (raas_postgres_data included) as required: a backup that lives on the
# same volume as the database it's backing up doesn't protect against
# the failure modes that actually matter (disk failure, `down -v`).
#
# Usage: infra/postgres/scheduled-backup.sh
# Env: REPO_DIR (default: this script's repo root), BACKUP_ROOT (default: $HOME/raas-backups)
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/raas-backups}"
DAILY_DIR="$BACKUP_ROOT/daily"
WEEKLY_DIR="$BACKUP_ROOT/weekly"
mkdir -p "$DAILY_DIR" "$WEEKLY_DIR"

cd "$REPO_DIR"

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) — starting scheduled backup ==="
BACKUP_DIR="$DAILY_DIR" BACKUP_RETENTION_DAYS=30 ./infra/postgres/backup.sh

# Weekly promotion: once a week (Sunday, UTC), copy that day's dump into
# weekly/ too — a plain file copy, not a second pg_dump run, so this
# never touches the database an extra time.
if [ "$(date -u +%u)" = "7" ]; then
  latest_daily=$(ls -t "$DAILY_DIR"/*.dump | head -1)
  cp "$latest_daily" "$WEEKLY_DIR/"
  echo "Promoted to weekly: $WEEKLY_DIR/$(basename "$latest_daily")"
fi

# Retention (by count): keep the last 7 daily, last 4 weekly. Newest-first
# listing, drop everything past the keep count.
echo "Applying retention: 7 daily / 4 weekly ..."
{ ls -t "$DAILY_DIR"/*.dump 2>/dev/null || true; } | tail -n +8 | while IFS= read -r f; do
  rm -v -- "$f"
done
{ ls -t "$WEEKLY_DIR"/*.dump 2>/dev/null || true; } | tail -n +5 | while IFS= read -r f; do
  rm -v -- "$f"
done

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) — scheduled backup complete ==="
echo "Daily backups: $(ls "$DAILY_DIR"/*.dump 2>/dev/null | wc -l | tr -d ' ') / 7"
echo "Weekly backups: $(ls "$WEEKLY_DIR"/*.dump 2>/dev/null | wc -l | tr -d ' ') / 4"
