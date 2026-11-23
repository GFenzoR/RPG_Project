#!/usr/bin/env bash
# Tests of check-boundary.sh on small fake repositories (run by make test-livingworld).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

repo() { # a fresh fake repo with one glue file per side
	rm -rf "$tmp/r" && mkdir -p "$tmp/r/livingworld/server" "$tmp/r/livingworld/client/src" \
		"$tmp/r/server/internal/session" "$tmp/r/client/src/render" "$tmp/r/client/src/state"
	cat >"$tmp/r/livingworld/README.md" <<'MD'
<!-- glue:start -->
- `server/internal/session/livingworld.go`
- `client/src/render/living.ts`
<!-- glue:end -->
MD
	printf 'package session\nimport lw "github.com/GFenzoR/RPG_Project/livingworld/server"\n' >"$tmp/r/server/internal/session/livingworld.go"
	printf 'import { createLivingWorld } from "@rpg/living-world";\n' >"$tmp/r/client/src/render/living.ts"
	printf 'package livingworld\nimport "go.yaml.in/yaml/v3"\n' >"$tmp/r/livingworld/server/world.go"
	printf 'import { Container } from "pixi.js";\n' >"$tmp/r/livingworld/client/src/index.ts"
}
expect() { # expect ok|fail <what>
	if bash "$here/check-boundary.sh" "$tmp/r" >/dev/null 2>&1; then got=ok; else got=fail; fi
	if [[ $got != "$1" ]]; then
		echo "check-boundary_test: $2: got $got, want $1" >&2
		exit 1
	fi
}

repo
expect ok "the glue only"
repo
printf 'import "github.com/GFenzoR/RPG_Project/server/internal/world"\n' >>"$tmp/r/livingworld/server/world.go"
expect fail "the module imports server/"
repo
printf 'import { WorldState } from "../../../client/src/state/world.ts";\n' >>"$tmp/r/livingworld/client/src/index.ts"
expect fail "the module imports client/"
repo
printf 'import { burst } from "@rpg/living-world";\n' >"$tmp/r/client/src/state/other.ts"
expect fail "a file outside the glue list imports the package"
repo
printf 'package session\nimport _ "github.com/GFenzoR/RPG_Project/livingworld/server"\n' >"$tmp/r/server/internal/session/move.go"
expect fail "a Go file outside the glue list imports the module"
repo
rm "$tmp/r/client/src/render/living.ts"
expect fail "a glue file that does not exist"
echo "check-boundary_test: ok"
