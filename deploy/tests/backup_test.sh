#!/usr/bin/env bash
# deploy/backup.sh against stub pg_dump, pg_restore, age and aws (lote 16): private file
# modes, S3 server-side encryption, optional age encryption that never leaves a plain dump
# behind, and BACKUP_ENCRYPT_REQUIRED.
#
#   bash deploy/tests/backup_test.sh     (make test-deploy)
# Stub bodies and grep patterns are single-quoted on purpose.
# shellcheck disable=SC2016
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/tests/lib.sh
source "$here/lib.sh"
script="$here/../backup.sh"

setup() {
	t_begin "$1"
	cp "$script" "$T_DIR/backup.sh"
	chmod +x "$T_DIR/backup.sh"
	stub pg_dump 'for a; do case $a in --file=*) printf PGDMP-fake >"${a#--file=}" ;; esac; done'
	stub pg_restore '[[ $1 == --list && -s $2 ]]'
	stub age 'out=""; in=""
while (($#)); do case $1 in -o) out=$2; shift 2 ;; -r) shift 2 ;; *) in=$1; shift ;; esac; done
[[ -z ${FAKE_AGE_FAIL:-} ]] || exit 1
{ echo age-encryption.org/v1; cat "$in"; } >"$out"'
	stub aws ':'
	BK="$T_DIR/backups"
}

# run_backup [VAR=value...]: one --once run; its exit status.
run_backup() {
	env PATH="$T_STUBS:$PATH" BACKUP_DIR="$BK" PGHOST=db PGDATABASE=rpg "$@" \
		"$T_DIR/backup.sh" --once >"$T_DIR/out.log" 2>&1
}

dumps() { find "$BK" -maxdepth 1 -name 'rpg-*' 2>/dev/null | sort; }

# 1. Plain dump: kept owner-only, uploaded with SSE AES256 by default.
setup "plain dump + S3"
run_backup BACKUP_S3_URI=s3://bucket/rpg || fail "exit $?: $(cat "$T_DIR/out.log")"
d=$(dumps)
[[ $d == *.dump && $(wc -l <<<"$d") == 1 ]] || fail "dumps: $d"
called '^aws s3 cp --only-show-errors --sse AES256 .*/rpg-[0-9TZ]+\.dump s3://bucket/rpg/rpg-[0-9TZ]+\.dump$' || fail "upload: $(cat "$T_LOG")"
grep -q '^rpg_backup_last_run_success 1$' "$BK/metrics/backup.prom" || fail "metrics"
if perms_supported; then
	[[ $(mode_of "$d") == 600 ]] || fail "dump mode $(mode_of "$d"), want 600 (umask 077)"
	# node-exporter (another user) reads the metrics: the umask of the dumps is not theirs.
	[[ $(mode_of "$BK/metrics") == 755 ]] || fail "metrics dir mode $(mode_of "$BK/metrics"), want 755"
	[[ $(mode_of "$BK/metrics/backup.prom") == 644 ]] || fail "backup.prom mode $(mode_of "$BK/metrics/backup.prom"), want 644"
	[[ $(mode_of "$BK") == 755 ]] || fail "backup dir mode $(mode_of "$BK"), want 755 (traversable)"
	# A metrics directory an earlier run left private is opened again.
	chmod 700 "$BK/metrics"
	chmod 600 "$BK/metrics/backup.prom"
	run_backup || fail "exit $?: $(cat "$T_DIR/out.log")"
	[[ $(mode_of "$BK/metrics") == 755 && $(mode_of "$BK/metrics/backup.prom") == 644 ]] ||
		fail "private metrics kept: $(mode_of "$BK/metrics") $(mode_of "$BK/metrics/backup.prom")"
fi
t_end

# 2. age encryption: only the .age file stays, and that is what goes to S3.
setup "age encryption"
run_backup BACKUP_S3_URI=s3://bucket/rpg/ BACKUP_AGE_RECIPIENT="age1one age1two" || fail "exit $?: $(cat "$T_DIR/out.log")"
d=$(dumps)
[[ $d == *.dump.age && $(wc -l <<<"$d") == 1 ]] || fail "dumps: $d"
head -n1 "$d" | grep -q age-encryption.org || fail "not encrypted"
called '^age -r age1one -r age1two -o ' || fail "recipients: $(cat "$T_LOG")"
called '^aws s3 cp .* --sse AES256 .*\.dump\.age s3://bucket/rpg/rpg-[0-9TZ]+\.dump\.age$' || fail "upload: $(cat "$T_LOG")"
grep -q '^rpg_backup_last_size_bytes [1-9]' "$BK/metrics/backup.prom" || fail "size metric of the .age dump"
t_end

# 3. age fails: the run fails and no plain dump is left on disk.
setup "age failure"
if run_backup BACKUP_AGE_RECIPIENT=age1one FAKE_AGE_FAIL=1; then fail "succeeded"; fi
[[ -z $(dumps) ]] || fail "left behind: $(dumps)"
called '^aws ' && fail "uploaded after a failed encryption"
grep -q '^rpg_backup_last_run_success 0$' "$BK/metrics/backup.prom" || fail "metrics"
t_end

# 4. BACKUP_ENCRYPT_REQUIRED without a recipient: nothing is dumped.
setup "encryption required"
if run_backup BACKUP_ENCRYPT_REQUIRED=1; then fail "succeeded"; fi
called '^pg_dump' && fail "pg_dump ran"
[[ -z $(dumps) ]] || fail "dumps: $(dumps)"
t_end

# 5. KMS server-side encryption, and an unknown SSE value is refused.
setup "kms"
run_backup BACKUP_S3_URI=s3://b/p BACKUP_S3_SSE=aws:kms BACKUP_S3_KMS_KEY_ID=alias/rpg || fail "exit $?"
called '^aws s3 cp --only-show-errors --sse aws:kms --sse-kms-key-id alias/rpg ' || fail "upload: $(cat "$T_LOG")"
if run_backup BACKUP_S3_URI=s3://b/p BACKUP_S3_SSE=none; then fail "BACKUP_S3_SSE=none accepted"; fi
t_end

t_summary "backup_test"
