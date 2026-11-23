#!/usr/bin/env bash
# The Go release of the images must be the one the modules pin (lote 16): every go.mod
# carries `toolchain goX.Y.Z` (what CI's setup-go and local builds use) and a `go`
# directive of at least MIN_GO, and every Go-building Dockerfile's `ARG GO_VERSION` is that
# same X.Y.Z. A Dockerfile left on an old (EOL) Go would ship stdlib vulnerabilities that
# govulncheck on the modules never sees.
#
#   deploy/tests/check-go-version.sh [repo-root]
set -euo pipefail

root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$root"
MIN_GO="1.26"
MODULES=(server tools/bots tools/launcher deploy/healthcheck)
fail=0
err() {
	echo "check-go-version: $*" >&2
	fail=1
}

# ver_ge A B: A >= B for dotted versions.
ver_ge() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" == "$2" ]]; }

want=""
for m in "${MODULES[@]}"; do
	mod="$m/go.mod"
	[[ -f $mod ]] || {
		err "$mod not found"
		continue
	}
	tc=$(sed -n 's/^toolchain go\([0-9.]*\)\r*$/\1/p' "$mod")
	gov=$(sed -n 's/^go \([0-9.]*\)\r*$/\1/p' "$mod")
	[[ -n $tc ]] || err "$mod has no 'toolchain goX.Y.Z' line"
	if [[ -z $gov ]] || ! ver_ge "$gov" "$MIN_GO"; then
		err "$mod: go directive '$gov' is older than $MIN_GO"
	fi
	if [[ -n $tc ]]; then
		if [[ -z $want ]]; then
			want=$tc
		elif [[ $tc != "$want" ]]; then
			err "$mod pins toolchain go$tc, other modules go$want"
		fi
	fi
done

found=0
for df in deploy/Dockerfile.*; do
	case "$df" in *.dockerignore) continue ;; esac
	grep -qE '^FROM .*golang:' "$df" || continue
	found=1
	v=$(sed -n 's/^ARG GO_VERSION=\([0-9.]*\)\r*$/\1/p' "$df")
	if [[ -z $v ]]; then
		err "$df builds Go but has no 'ARG GO_VERSION=X.Y.Z'"
	elif [[ $v != "$want" ]]; then
		err "$df: GO_VERSION=$v but the go.mod files pin toolchain go$want"
	fi
	if grep -qE '^FROM .*golang:[0-9]' "$df"; then
		err "$df: a golang image with a literal version; use \${GO_VERSION}"
	fi
done
((found)) || err "no Dockerfile builds Go (expected deploy/Dockerfile.gameserver)"

((fail == 0)) || exit 1
echo "check-go-version: ok (go$want in ${#MODULES[@]} modules and the Dockerfiles)"
