#!/usr/bin/env bash
# PostgreSQL backups for the RPG Project (docs/09-deployment-aws.md).
#
#   backup.sh [--once]   one compressed dump now, prune old local dumps, optional S3 copy
#   backup.sh --loop     the above every BACKUP_INTERVAL_SECONDS (the compose service)
#   backup.sh --check    healthcheck: exit 0 if the last successful dump is recent enough
#
# Connection: the standard libpq variables PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE.
# Settings (all optional):
#   BACKUP_DIR               where dumps go                         (default /backups)
#   BACKUP_RETENTION_DAYS    local dumps older than this are deleted (default 14)
#   BACKUP_INTERVAL_SECONDS  --loop period                           (default 86400 = daily)
#   BACKUP_S3_URI            e.g. s3://my-bucket/rpg; empty = no upload. Credentials come
#                            from the usual AWS variables or the instance role. Retention in
#                            S3 is a bucket lifecycle rule, not this script.
#
# Dumps use pg_dump's custom format (-Fc, compressed). Restore with:
#   pg_restore --clean --if-exists --no-owner -d "$DATABASE" rpg-<timestamp>.dump
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
BACKUP_S3_URI="${BACKUP_S3_URI:-}"
STAMP_FILE="$BACKUP_DIR/.last-success"
tmp=""

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

require_int() {
	[[ "$2" =~ ^[0-9]+$ ]] || {
		log "$1 must be a non-negative integer, got '$2'"
		exit 2
	}
}

backup_once() {
	mkdir -p "$BACKUP_DIR"
	local name file
	name="rpg-$(date -u +%Y%m%dT%H%M%SZ).dump"
	file="$BACKUP_DIR/$name"
	tmp="$file.partial"
	trap 'rm -f "$tmp"' EXIT

	log "dumping ${PGDATABASE:-?}@${PGHOST:-?} to $file"
	pg_dump --format=custom --compress=6 --no-owner --file="$tmp"
	# A dump that pg_restore cannot list is not a backup.
	pg_restore --list "$tmp" >/dev/null
	mv "$tmp" "$file"
	log "wrote $(du -h "$file" | cut -f1)"

	if [[ -n "$BACKUP_S3_URI" ]]; then
		log "uploading to ${BACKUP_S3_URI%/}/$name"
		aws s3 cp --only-show-errors "$file" "${BACKUP_S3_URI%/}/$name"
	fi

	local pruned
	pruned=$(find "$BACKUP_DIR" -maxdepth 1 -name 'rpg-*.dump' -mtime "+$BACKUP_RETENTION_DAYS" -print -delete | wc -l)
	((pruned == 0)) || log "pruned $pruned dump(s) older than $BACKUP_RETENTION_DAYS days"

	touch "$STAMP_FILE"
}

check() {
	# Healthy if the last success is younger than two intervals (one missed run is tolerated).
	local max_minutes=$((BACKUP_INTERVAL_SECONDS * 2 / 60 + 1))
	[[ -n "$(find "$STAMP_FILE" -mmin "-$max_minutes" 2>/dev/null)" ]]
}

main() {
	require_int BACKUP_RETENTION_DAYS "$BACKUP_RETENTION_DAYS"
	require_int BACKUP_INTERVAL_SECONDS "$BACKUP_INTERVAL_SECONDS"
	case "${1:-}" in
	"" | --once) backup_once ;;
	--check) check ;;
	--loop)
		log "every ${BACKUP_INTERVAL_SECONDS}s, keeping ${BACKUP_RETENTION_DAYS} days${BACKUP_S3_URI:+, copying to $BACKUP_S3_URI}"
		while true; do
			# Each run is its own process so `set -e` applies inside it (it is ignored in a
			# function called from `||`). A failure is logged and retried next period;
			# --check turns the container unhealthy meanwhile.
			"$0" || log "FAILED (exit $?)"
			sleep "$BACKUP_INTERVAL_SECONDS" &
			wait $! # interruptible: docker stop does not wait for the full sleep
		done
		;;
	*)
		echo "usage: backup.sh [--once | --loop | --check]" >&2
		exit 2
		;;
	esac
}

trap 'log "stopping"; exit 0' TERM INT
main "$@"
