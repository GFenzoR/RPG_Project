#!/usr/bin/env bash
# Helpers for the deploy/ script tests (deploy/tests/*_test.sh, `make test-deploy`). They run
# the real scripts against stub commands in a temporary directory: no Docker, no database,
# no network.

T_FAILS=0
T_NAME=""

t_begin() {
	T_NAME=$1
	T_DIR=$(mktemp -d)
	T_STUBS="$T_DIR/stubs"
	T_LOG="$T_DIR/calls.log"
	mkdir -p "$T_STUBS"
	: >"$T_LOG"
}

t_end() {
	rm -rf "$T_DIR"
}

fail() {
	echo "FAIL [$T_NAME]: $*" >&2
	T_FAILS=$((T_FAILS + 1))
}

# stub NAME BODY: an executable NAME in the stub directory running BODY (bash). Every call
# is appended to $T_LOG as "NAME args...".
stub() {
	{
		printf '#!/usr/bin/env bash\n'
		printf 'printf "%%s\\n" "%s $*" >>"%s"\n' "$1" "$T_LOG"
		printf '%s\n' "$2"
	} >"$T_STUBS/$1"
	chmod +x "$T_STUBS/$1"
}

# called PATTERN: some logged call matches the extended regex PATTERN.
called() { grep -Eq -- "$1" "$T_LOG"; }

# perms_supported: this filesystem keeps chmod 600 (not a Windows checkout).
perms_supported() {
	local f="$T_DIR/.perm-probe"
	: >"$f"
	chmod 600 "$f" 2>/dev/null || return 1
	[[ "$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f")" == 600 ]]
}

mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

t_summary() {
	local what=$1
	if ((T_FAILS > 0)); then
		echo "$what: $T_FAILS failure(s)" >&2
		exit 1
	fi
	echo "$what: ok"
}
