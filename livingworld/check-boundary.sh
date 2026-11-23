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

code_files() { # code files under $1, without dependencies and build output
	find "$1" \( -name node_modules -o -name build -o -name dist -o -name .wt -o -name .git -o -name gen \) -prune \
		-o -type f \( -name '*.go' -o -name '*.ts' -o -name '*.tsx' \) -print 2>/dev/null
}

# 1. livingworld/ never reaches into the server or the client.
while IFS= read -r f; do
	[[ -n $f ]] || continue
	if grep -nE '"github\.com/GFenzoR/RPG_Project/server' "$f" >/dev/null ||
		grep -nE "from ['\"](@rpg/client|[./]*(\.\./)+(client|server)/)" "$f" >/dev/null ||
		grep -nE "import\(['\"][./]*(\.\./)+(client|server)/" "$f" >/dev/null; then
		err "$f imports from server/ or client/ (the module only talks through its Host and its API)"
	fi
done < <(code_files livingworld)

# 2. Outside livingworld/, only the glue imports the module.
for dir in server client editor packages tools apps; do
	[[ -d $dir ]] || continue
	while IFS= read -r f; do
		[[ -n $f ]] || continue
		if grep -qE '"github\.com/GFenzoR/RPG_Project/livingworld|from ['"'"'"](@rpg/living-world|[./]+/livingworld/)' "$f"; then
			if ! grep -qxF "$f" <<<"$glue"; then
				err "$f imports the living world but is not in the glue list of $readme"
			fi
		fi
	done < <(code_files "$dir")
done

# The glue files exist.
while IFS= read -r g; do
	[[ -n $g && -f $g ]] || err "glue file $g of $readme does not exist"
done <<<"$glue"

if [[ $fail -ne 0 ]]; then
	exit 1
fi
echo "livingworld boundary: ok ($(wc -l <<<"$glue" | tr -d ' ') glue files)"
