#!/usr/bin/env bash
# PostgreSQL backups for the RPG Project (docs/09-deployment-aws.md).
#
#   backup.sh [--once]   one compressed dump now, prune old local dumps, optional S3 copy,
#                        then write the backup metrics (below)
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
# Metrics (T4.4): every run rewrites $BACKUP_DIR/metrics/backup.prom, which node-exporter
# reads with its textfile collector (monitoring profile, docs/01 "Observabilidad"):
#   rpg_backup_last_run_success                 1 if the last run succeeded, else 0
#   rpg_backup_last_run_timestamp_seconds       when the last run ended
#   rpg_backup_last_success_timestamp_seconds   when the last successful dump ended
#   rpg_backup_last_size_bytes                  size of the newest dump
#   rpg_backup_interval_seconds                 BACKUP_INTERVAL_SECONDS (alert threshold)
#
# Dumps use pg_dump's custom format (-Fc, compressed). Restore with:
#   pg_restore --clean --if-exists --no-owner -d "$DATABASE" rpg-<timestamp>.dump
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
BACKUP_S3_URI="${BACKUP_S3_URI:-}"
STAMP_FILE="$BACKUP_DIR/.last-success"
METRICS_DIR="$BACKUP_DIR/metrics"
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

# write_metrics RC: the textfile for node-exporter, written atomically (tmp + mv) so a
# scrape never reads half a file. Never fails the run: metrics are best effort.
write_metrics() {
	local rc=$1 ok=0 last=0 size=0 newest
	((rc == 0)) && ok=1
	[[ -f "$STAMP_FILE" ]] && last=$(date -u -r "$STAMP_FILE" +%s)
	newest=$(find "$BACKUP_DIR" -maxdepth 1 -name 'rpg-*.dump' -print 2>/dev/null | sort | tail -n 1)
	[[ -n "$newest" ]] && size=$(wc -c <"$newest" | tr -d ' ')
	{
		mkdir -p "$METRICS_DIR" &&
			cat >"$METRICS_DIR/backup.prom.tmp" <<-PROM &&
				# HELP rpg_backup_last_run_success 1 if the last backup run succeeded.
				# TYPE rpg_backup_last_run_success gauge
				rpg_backup_last_run_success $ok
				# HELP rpg_backup_last_run_timestamp_seconds End of the last backup run.
				# TYPE rpg_backup_last_run_timestamp_seconds gauge
				rpg_backup_last_run_timestamp_seconds $(date -u +%s)
				# HELP rpg_backup_last_success_timestamp_seconds End of the last successful dump (0 = never).
				# TYPE rpg_backup_last_success_timestamp_seconds gauge
				rpg_backup_last_success_timestamp_seconds $last
				# HELP rpg_backup_last_size_bytes Size of the newest dump.
				# TYPE rpg_backup_last_size_bytes gauge
				rpg_backup_last_size_bytes $size
				# HELP rpg_backup_interval_seconds Configured backup period.
				# TYPE rpg_backup_interval_seconds gauge
				rpg_backup_interval_seconds $BACKUP_INTERVAL_SECONDS
			PROM
			mv "$METRICS_DIR/backup.prom.tmp" "$METRICS_DIR/backup.prom"
	} || log "could not write metrics to $METRICS_DIR"
}

main() {
	require_int BACKUP_RETENTION_DAYS "$BACKUP_RETENTION_DAYS"
	require_int BACKUP_INTERVAL_SECONDS "$BACKUP_INTERVAL_SECONDS"
	case "${1:-}" in
	"" | --once)
		# The dump runs as its own process so `set -e` applies inside it (it is ignored in
		# a function called from `||`); its exit status goes to the metrics.
		local rc=0
		"$0" --dump || rc=$?
		write_metrics "$rc"
		return "$rc"
		;;
	--dump) backup_once ;;
	--check) check ;;
	--loop)
		log "every ${BACKUP_INTERVAL_SECONDS}s, keeping ${BACKUP_RETENTION_DAYS} days${BACKUP_S3_URI:+, copying to $BACKUP_S3_URI}"
		while true; do
			# Each run is its own process so `set -e` applies inside it (it is ignored in a
			# function called from `||`). A failure is logged and retried next period;
			# --check turns the container unhealthy meanwhile.
			"$0" --once || log "FAILED (exit $?)"
			sleep "$BACKUP_INTERVAL_SECONDS" &
			wait $! # interruptible: docker stop does not wait for the full sleep
		done
		;;
	*)
		echo "usage: backup.sh [--once | --loop | --check | --dump]" >&2
		exit 2
		;;
	esac
}

trap 'log "stopping"; exit 0' TERM INT
main "$@"
