#!/usr/bin/env bash
# Which CI jobs a change needs (docs/08-testing-and-verification.md, "CI (GitHub Actions)").
#
#   ci-changes.sh ci|images      in a workflow: diffs $BASE..$HEAD and writes
#                                <job>=true|false to $GITHUB_OUTPUT
#   ci-changes.sh --test         self-test of the rules (run by every `changes` job)
#
# Environment: EVENT (github.event_name), BASE (PR base sha, or the push's `before`), HEAD.
# Every job runs when the change touches a file that affects all of them (CI config,
# Makefile, workspace and lock files), when the base cannot be diffed (first push of a
# branch, force push, workflow_dispatch) and on tags. Being wrong here only costs minutes
# in one direction: when in doubt, a pattern belongs to the job.
set -euo pipefail

# Files that can change the result of any job.
GLOBAL='^(\.github/workflows/ci\.yml|\.github/workflows/images\.yml|\.github/scripts/|Makefile$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig\.base\.json$|vitest\.config\.ts$|eslint\.config\.js$|\.prettierrc\.json$|\.prettierignore$|\.golangci\.yml$)'

# Per job: paths (extended regex, anchored) that make it run. GLOBAL is added to all.
declare -A RULES=(
	# ci.yml
	# The patch path fixture is shared with server/internal/mappatch (T4.5). The account
	# emails' templates (T2.1) are i18n/<lang>/email.yaml, read by server/internal/mail.
	[go-server]='^((server|proto|data|world|packages/map-format/src/patch/testdata)/|i18n/[a-z]+/email\.yaml$)'
	[go-bots]='^(tools/bots|server|proto)/'
	[ts]='^(client|editor|packages|apps/desktop|tools/mapcli|tools/mcp-world|tools/map-pr-worker|tools/spritepack|tools/soundgen|data|world|i18n|assets|proto)/'
	[validate]='^(data|world|i18n|assets|packages|tools/mapcli|server/internal/world|server/cmd/mapcompile)/'
	[actionlint]='^\.github/'
	[build]='^(client|editor|packages|data|world|i18n|assets|proto|tools/spritepack)/'
	# The desktop job compiles Rust: only for the app itself and the client's bridge to it
	# (a web client build failure already fails `build`), plus the game page the app opens
	# (client/play/, and the Vite pages config; T4.3).
	[desktop]='^(apps/desktop/|client/src/net/|client/package\.json$|client/play/|client/vite\.config\.ts$)'
	[e2e]='^(client|editor|packages|server|proto|data|world|i18n|assets|tools/mapcli|tools/map-pr-worker|tools/spritepack)/'
	[integration]='^(server|proto|data|world|tools/map-pr-worker|packages/map-format)/'
	[bench]='^server/(internal/(game|world|session|clock)|go\.(mod|sum))'
	# images.yml (on pull requests; pushes to main and tags always build and publish)
	# The map PR worker's image runs its TypeScript and these packages as they are (T4.5).
	[image]='^(deploy/(Dockerfile|.*\.dockerignore$|Caddyfile|caddy-.*\.caddy$)|tools/map-pr-worker/|packages/map-format/|packages/content-schema/)'
	[deploy-lint]='^deploy/'
	[stack]='^(deploy|server|client|packages|data|world|i18n|assets|proto|tools/bots|tools/spritepack)/'
	[home-stack]='^deploy/'
	# Step of deploy-lint (T4.4): promtool/amtool and the dashboards, only for the
	# monitoring config, the compose file that pins its images, and the Caddy files of
	# the optional /grafana/ route (check.sh parses them with half-set credentials).
	[monitoring]='^deploy/(monitoring/|docker-compose\.yml$|Caddyfile$|caddy-routes\.caddy$|caddy-grafana-.*\.caddy$)'
)
CI_JOBS=(go-server go-bots ts validate actionlint build desktop e2e integration bench)
IMAGES_JOBS=(image deploy-lint stack home-stack monitoring)

# decide JOB < changed-files: prints true or false.
decide() {
	local job=$1 files
	files=$(cat)
	if grep -Eq "$GLOBAL|${RULES[$job]}" <<<"$files"; then echo true; else echo false; fi
}

self_test() {
	local fails=0
	check() { # check JOB EXPECTED FILE...
		local job=$1 want=$2 got
		shift 2
		got=$(printf '%s\n' "$@" | decide "$job")
		if [[ $got != "$want" ]]; then
			echo "FAIL: $job for [$*]: got $got, want $want" >&2
			fails=$((fails + 1))
		fi
	}
	# A docs-only change runs nothing.
	for j in "${CI_JOBS[@]}" "${IMAGES_JOBS[@]}"; do check "$j" false docs/01-architecture.md README.md; done
	# CI config, Makefile and the lockfile run everything.
	for f in .github/workflows/ci.yml Makefile pnpm-lock.yaml .github/scripts/ci-changes.sh; do
		for j in "${CI_JOBS[@]}" "${IMAGES_JOBS[@]}"; do check "$j" true "$f"; done
	done
	# The server: Go, integration, E2E and the stack, not the desktop or the web build.
	check go-server true server/internal/session/move.go
	check go-bots true server/pkg/bot/bot.go
	check integration true server/internal/store/accounts.go
	check e2e true server/internal/session/move.go
	check stack true server/internal/session/move.go
	check bench true server/internal/game/loop.go
	check bench false server/internal/httpapi/server.go
	check desktop false server/internal/session/move.go
	check build false server/internal/session/move.go
	check ts false server/internal/session/move.go
	check image false server/internal/session/move.go
	check home-stack false server/internal/session/move.go
	# The client: TS, build, desktop, E2E and the stack, not Go.
	for j in ts build desktop e2e stack; do check "$j" true client/src/net/api.ts; done
	for j in go-server go-bots integration bench validate image; do check "$j" false client/src/net/api.ts; done
	# The desktop job: its app and the client's network bridge (version, API, socket).
	check desktop false client/src/ui/App.tsx
	check desktop false editor/src/state/editor.ts
	check desktop true client/package.json
	check desktop true client/play/index.html client/vite.config.ts
	check desktop false client/index.html
	# Texts: TS, validation, build and E2E, not the Go jobs.
	for j in ts validate build e2e; do check "$j" true i18n/es/client.yaml; done
	for j in go-server go-bots integration desktop; do check "$j" false i18n/es/client.yaml; done
	check go-server true i18n/en/email.yaml
	# The desktop app's Rust only runs its own job and the TS one (apps/desktop has TS).
	check desktop true apps/desktop/src-tauri/src/api.rs
	check e2e false apps/desktop/src-tauri/src/api.rs
	check go-server false apps/desktop/src-tauri/src/api.rs
	# The map PR worker (T4.5): its TS tests, its Postgres test and the E2E; not Go.
	for j in ts integration e2e; do check "$j" true tools/map-pr-worker/src/worker.ts; done
	for j in go-server go-bots bench desktop; do check "$j" false tools/map-pr-worker/src/worker.ts; done
	check integration true packages/map-format/src/patch/merge.ts
	for f in tools/map-pr-worker/src/cli.ts packages/map-format/src/patch/merge.ts packages/content-schema/src/index.ts; do
		check image true "$f"
	done
	check image false client/src/main.tsx
	# The patch path fixture: the TS tests and the server's patch check (T4.5).
	for j in go-server ts; do check "$j" true packages/map-format/src/patch/testdata/paths.json; done
	check go-server false packages/map-format/src/patch/merge.ts
	# Maps and content: validation, server, E2E.
	for j in validate go-server e2e ts integration; do check "$j" true world/islands/puerto/chunks/z07/c0100_0196.json; done
	check desktop false world/islands/puerto/chunks/z07/c0100_0196.json
	# Workflows other than ci.yml/images.yml: actionlint only.
	check actionlint true .github/workflows/map-pr.yml
	check e2e false .github/workflows/map-pr.yml
	# deploy/: lint, images, both stacks; a compose change does not build the images.
	for j in deploy-lint image stack home-stack; do check "$j" true deploy/Dockerfile.gameserver; done
	check image false deploy/docker-compose.home.yml
	check image true deploy/caddy-routes.caddy
	check home-stack true deploy/docker-compose.home.yml
	check e2e false deploy/docker-compose.yml
	# Monitoring (T4.4): its checks run for deploy/monitoring/ and the compose file only;
	# the optional Grafana route of Caddy is part of the web image.
	for j in monitoring deploy-lint stack home-stack; do check "$j" true deploy/monitoring/prometheus/rules/alerts.yml; done
	check image false deploy/monitoring/grafana/dashboards/rpg-overview.json
	check monitoring true deploy/docker-compose.yml
	check monitoring false deploy/backup.sh deploy/Caddyfile.home
	check monitoring true deploy/caddy-grafana-on.caddy
	check monitoring false server/internal/metrics/metrics.go
	check image true deploy/caddy-grafana-on.caddy
	# The bots: their Go job and the stack (they play in it), not the server's.
	check go-bots true tools/bots/cmd/bots/main.go
	check stack true tools/bots/cmd/bots/main.go
	check go-server false tools/bots/cmd/bots/main.go
	# Sound (T3.7): the .ogg files and sounds.yaml are client assets (validated, bundled, played
	# in the E2E); soundgen itself only has unit tests (it needs ffmpeg, which CI never runs).
	for j in ts validate build e2e stack; do check "$j" true assets/sounds.yaml assets/sounds/music/puerto.ogg; done
	for j in go-server go-bots integration desktop bench; do check "$j" false assets/sounds/sfx/hit.ogg; done
	check ts true tools/soundgen/src/sfx.ts
	for j in e2e build validate go-server stack desktop; do check "$j" false tools/soundgen/src/sfx.ts; done
	if ((fails > 0)); then
		echo "ci-changes: $fails rule check(s) failed" >&2
		exit 1
	fi
	echo "ci-changes: rules ok"
}

main() {
	case "${1:-}" in
		--test) self_test; return ;;
		ci) jobs=("${CI_JOBS[@]}") ;;
		images) jobs=("${IMAGES_JOBS[@]}") ;;
		*) echo "usage: $0 ci|images|--test" >&2; exit 2 ;;
	esac
	local out=${GITHUB_OUTPUT:-/dev/stdout} all=false files=""
	local event=${EVENT:-} base=${BASE:-} head=${HEAD:-HEAD}
	if [[ $event != pull_request && $event != push ]] || [[ -z $base || $base =~ ^0+$ ]]; then
		all=true
	elif [[ $1 == images && $event == push ]]; then
		all=true # main and tags publish the images: build and test everything
	elif ! git cat-file -e "$base^{commit}" 2>/dev/null; then
		all=true # force push or a base outside the fetched history
	else
		files=$(git diff --name-only "$base" "$head")
	fi
	{
		echo "## Changed paths → jobs"
		if [[ $all == true ]]; then echo "All jobs run (event: ${event:-none})."; else
			echo "$(wc -l <<<"$files" | tr -d ' ') changed file(s)."
		fi
	} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
	for j in "${jobs[@]}"; do
		local v=true
		[[ $all == true ]] || v=$(decide "$j" <<<"$files")
		echo "$j=$v" >>"$out"
		echo "- \`$j\`: $v" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
	done
}

main "$@"
