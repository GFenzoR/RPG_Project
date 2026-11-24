#!/usr/bin/env bash
# The living world's boundary (livingworld/README.md, "Frontera"), run by `make lint`:
#   1. nothing under livingworld/ imports the game server (server/) or client (client/);
#   2. outside livingworld/, only the glue files listed in livingworld/README.md (between
#      the glue:start and glue:end marks) import the module (its Go module path or the
#      @rpg/living-world package).
#
#   livingworld/check-boundary.sh [repo-root]
set -euo pipefail

root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$root"
fail=0
err() {
	echo "livingworld boundary: $*" >&2
	fail=1
}

readme=livingworld/README.md
[[ -f $readme ]] || {
	echo "livingworld boundary: $readme not found" >&2
	exit 1
}
# The glue list: the first `path` of each "- " line between the marks.
glue=$(sed -n '/<!-- glue:start -->/,/<!-- glue:end -->/p' "$readme" | sed -n 's/^- `\([^`]*\)`.*/\1/p' || true)
[[ -n $glue ]] || err "$readme has no glue list between <!-- glue:start --> and <!-- glue:end -->"

# The code files the checks read: Go, and TypeScript or JavaScript of any module flavour.
CODE_NAMES=(-name '*.go' -o -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.cts' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs')
code_files() { # code files under $1, without dependencies and build output
	find "$1" \( -name node_modules -o -name build -o -name dist -o -name .wt -o -name .git -o -name gen \) -prune \
		-o -type f \( "${CODE_NAMES[@]}" \) -print 2>/dev/null
}
root_files() { # code files at the repository's root (vitest.config.ts, eslint.config.js...)
	find . -maxdepth 1 -type f \( "${CODE_NAMES[@]}" \) -print 2>/dev/null | sed 's#^\./##'
}

# ts_specs prints the module specifier of every import of a TS file: `from "x"` (also
# `export ... from`), side-effect `import "x"` and dynamic `import("x")`.
ts_specs() {
	grep -oE "(from|import)[[:space:]]*\(?[[:space:]]*['\"][^'\"]+['\"]" "$1" 2>/dev/null |
		sed -E "s/.*['\"]([^'\"]+)['\"]$/\1/" || true
}
# lands_in <file> <spec> <dir>: whether the relative spec, from file, resolves under dir/.
lands_in() {
	[[ $2 == .* ]] || return 1
	local to
	to=$(realpath -m "$(dirname "$1")/$2")
	[[ $to == "$root/$3" || $to == "$root/$3/"* ]]
}
root=$(realpath -m "$root")

# 1. livingworld/ never reaches into the server or the client.
while IFS= read -r f; do
	[[ -n $f ]] || continue
	bad=0
	grep -qE '"github\.com/GFenzoR/RPG_Project/server' "$f" && bad=1
	while IFS= read -r spec; do
		[[ -n $spec ]] || continue
		if [[ $spec == @rpg/client* ]] || lands_in "$f" "$spec" server || lands_in "$f" "$spec" client; then
			bad=1
		fi
	done < <(ts_specs "$f")
	[[ $bad -eq 0 ]] || err "$f imports from server/ or client/ (the module only talks through its Host and its API)"
done < <(code_files livingworld)

# 2. Outside livingworld/, only the glue imports the module.
for dir in server client editor packages tools apps .; do
	[[ -d $dir ]] || continue
	lister=code_files
	[[ $dir != . ]] || lister=root_files
	while IFS= read -r f; do
		[[ -n $f ]] || continue
		uses=0
		grep -qE '"github\.com/GFenzoR/RPG_Project/livingworld' "$f" && uses=1
		while IFS= read -r spec; do
			[[ -n $spec ]] || continue
			if [[ $spec == @rpg/living-world* ]] || lands_in "$f" "$spec" livingworld; then
				uses=1
			fi
		done < <(ts_specs "$f")
		if [[ $uses -eq 1 ]] && ! grep -qxF "$f" <<<"$glue"; then
			err "$f imports the living world but is not in the glue list of $readme"
		fi
	done < <("$lister" "$dir")
done

# The glue files exist.
while IFS= read -r g; do
	[[ -n $g && -f $g ]] || err "glue file $g of $readme does not exist"
done <<<"$glue"

if [[ $fail -ne 0 ]]; then
	exit 1
fi
echo "livingworld boundary: ok ($(wc -l <<<"$glue" | tr -d ' ') glue files)"
