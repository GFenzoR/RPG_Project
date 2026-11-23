#!/usr/bin/env bash
# Every third-party action is pinned to a full commit SHA (lote 16, docs/18): a tag can be
# moved by whoever controls the action's repository, a 40-hex commit cannot. The version
# goes in a comment (`uses: owner/repo@<sha> # vX.Y.Z`); dependabot keeps both up to date.
#
#   check-action-pins.sh [workflow files...]   default: .github/workflows/*.yml
#   check-action-pins.sh --test                self-test
#
# Local actions (./path) and docker:// images are exempt.
set -euo pipefail

# bad prints every `uses:` line of the given files whose ref is not a 40-hex SHA.
bad() {
	grep -nE '^[[:space:]-]*uses:[[:space:]]*' "$@" /dev/null |
		grep -vE 'uses:[[:space:]]*["'\'']?(\./|docker://)' |
		grep -vE 'uses:[[:space:]]*["'\'']?[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}["'\'']?([[:space:]]|$)' || true
}

if [[ ${1:-} == --test ]]; then
	dir=$(mktemp -d)
	trap 'rm -rf "$dir"' EXIT
	cat >"$dir/good.yml" <<'YML'
steps:
  - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
  - uses: ./.github/actions/local
  - uses: docker://alpine:3.20
  - name: x
    uses: "github/codeql-action/init@0123456789abcdef0123456789abcdef01234567"
YML
	cat >"$dir/bad.yml" <<'YML'
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-go@40f1582
  - uses: actions/setup-node@main # v4
YML
	[[ -z $(bad "$dir/good.yml") ]] || { echo "self-test: good.yml flagged"; bad "$dir/good.yml"; exit 1; }
	[[ $(bad "$dir/bad.yml" | wc -l) -eq 3 ]] || { echo "self-test: bad.yml not fully flagged"; bad "$dir/bad.yml"; exit 1; }
	echo "check-action-pins self-test ok"
	exit 0
fi

files=("$@")
[[ ${#files[@]} -gt 0 ]] || files=(.github/workflows/*.yml)
found=$(bad "${files[@]}")
if [[ -n $found ]]; then
	echo "Actions not pinned to a full commit SHA (use owner/repo@<40-hex sha> # vX.Y.Z):"
	echo "$found"
	exit 1
fi
echo "every action is pinned to a commit SHA (${#files[@]} workflow files)"
