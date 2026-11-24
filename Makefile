# Neque's Realm — task runner. Works the same in cloud sessions and locally
# (WSL2/macOS/Linux). Targets marked "pending" print the roadmap task that builds them.

SHELL := /bin/bash
.DEFAULT_GOAL := help

GO_MODULES := server livingworld/server tools/bots tools/launcher
COMPOSE_DEV := docker compose -f deploy/docker-compose.dev.yml
# Cloud sessions run Postgres as a VM service; local machines use Docker.
IS_CLOUD := $(filter true,$(CLAUDE_CODE_REMOTE))
# Native Windows (Git Bash + GNU make, docs/12 "Windows nativo"): binaries need .exe, and
# CURDIR is C:/..., whose colon would split a PATH entry, so PATH gets the /c/... form.
ifeq ($(OS),Windows_NT)
EXE := .exe
POSIX_CURDIR := $(shell cygpath -u '$(CURDIR)' 2>/dev/null)
ifeq ($(POSIX_CURDIR),)
$(error cygpath not found: run make from Git Bash (docs/12, "Windows nativo"))
endif
# Tests that copy world/ or start mapcli and git processes pass the default 5 s there:
# process start and file I/O in %TEMP% are several times slower than on Linux.
VITEST_ARGS := --testTimeout=30000
else
EXE :=
POSIX_CURDIR := $(CURDIR)
VITEST_ARGS :=
endif

define pending
	@echo "[$@] pending: arrives in $(1). Nothing to do yet."
endef

.PHONY: help
help: ## List targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

## ---- setup and code generation -------------------------------------------

.PHONY: setup
setup: ## Install tools and dependencies (scripts/local-setup.sh), then generate code
	bash scripts/local-setup.sh
	$(MAKE) gen

.PHONY: gen
gen: gen-proto gen-sqlc ## buf generate + sqlc generate

# sqlc reads server/migrations (schema) and server/queries; output is committed.
.PHONY: gen-sqlc
gen-sqlc: ## sqlc generate: server/queries -> server/internal/store/db
	cd server && sqlc generate

# Protobuf plugins run locally, pinned by server/go.mod and packages/protocol/package.json.
# buf finds them by name in PATH (proto/buf.gen.yaml).
.PHONY: gen-proto
gen-proto: ## buf generate: Go (server/internal/net/pb) and TS (packages/protocol/src/gen)
	cd server && go build -o bin/protoc-gen-go$(EXE) google.golang.org/protobuf/cmd/protoc-gen-go
	test -x packages/protocol/node_modules/.bin/protoc-gen-es || pnpm install --frozen-lockfile
	PATH="$(POSIX_CURDIR)/server/bin:$(POSIX_CURDIR)/packages/protocol/node_modules/.bin:$$PATH" \
		buf generate --template proto/buf.gen.yaml

.PHONY: proto-lint
proto-lint: ## buf lint + buf format check on proto/
	buf lint proto
	buf format --diff --exit-code proto

.PHONY: proto-breaking
proto-breaking: ## buf breaking: proto/ must stay wire- and JSON-compatible with main
	buf breaking proto --against '.git#branch=main,subdir=proto'

## ---- quality gates ---------------------------------------------------------

.PHONY: test
test: test-go test-ts test-parity test-deploy test-livingworld-boundary ## Go + TS tests (+ deploy script and living world boundary tests)

# The living world (livingworld/README.md): its Go module, its TS package and the boundary
# check's own tests. make test runs the first two with everything else (GO_MODULES, the
# vitest projects) and the third through test-livingworld-boundary.
.PHONY: test-livingworld
test-livingworld: test-livingworld-boundary ## Go and TS tests of livingworld/ (and its boundary check)
	cd livingworld/server && go test ./...
	pnpm exec vitest run --project @rpg/living-world $(VITEST_ARGS)

.PHONY: test-livingworld-boundary
test-livingworld-boundary:
	bash livingworld/check-boundary_test.sh

.PHONY: lint-livingworld
lint-livingworld: ## The living world's boundary: what it imports and who imports it (livingworld/README.md)
	bash livingworld/check-boundary.sh
	node --experimental-strip-types livingworld/client/scripts/boundary.ts

.PHONY: test-go
test-go:
	@set -e; for m in $(GO_MODULES); do echo "==> go test ($$m)"; (cd $$m && go test ./...); done

.PHONY: test-ts
test-ts:
	pnpm test $(VITEST_ARGS)

.PHONY: lint
lint: lint-go lint-ts lint-deploy lint-livingworld validate ## golangci-lint + eslint/prettier/tsc + deploy checks + living world boundary + content validation

.PHONY: lint-go
lint-go:
	@set -e; for m in $(GO_MODULES); do \
		echo "==> lint ($$m)"; \
		(cd $$m && test -z "$$(gofmt -l .)" || { gofmt -l .; echo "gofmt: files above need formatting"; exit 1; }); \
		(cd $$m && go vet ./... && golangci-lint run ./...); \
	done

# Lote 16: static checks of deploy/ that need no Docker daemon (deploy/tests/): the image's
# Go = the go.mod toolchain, and the hardening of the compose stacks (docker compose config,
# skipped without the docker CLI), Caddy headers, backups, deploy.sh and image signing.
.PHONY: lint-deploy
lint-deploy: ## Deploy checks: Go version match, compose/Caddy/backup/deploy hardening
	bash deploy/tests/check-go-version.sh
	bash deploy/tests/check-hardening.sh

# deploy.sh and backup.sh against stub docker, cosign, pg_dump, aws and age.
.PHONY: test-deploy
test-deploy: ## Tests of deploy/deploy.sh and deploy/backup.sh (stubs, no Docker)
	bash deploy/tests/backup_test.sh
	bash deploy/tests/deploy_test.sh

.PHONY: lint-ts
lint-ts:
	pnpm lint
	pnpm typecheck
	pnpm --filter @rpg/client test:build

# Content tooling runs TypeScript directly (Node strips types; the flag is needed < 22.18).
CONTENT_CLI := node --experimental-strip-types packages/content-schema/src/cli.ts

MAPCLI := node --experimental-strip-types tools/mapcli/src/cli.ts

.PHONY: validate
validate: ## Validate data/ and i18n/ against the schemas, then world/ maps (mapcli validate)
	$(CONTENT_CLI) validate
	$(MAPCLI) validate --format text

.PHONY: map-pr
map-pr: ## Map PR check of HEAD=<ref> against BASE=<ref> (default main) into build/map-pr, plus the comment
	$(MAPCLI) pr-check --base $(or $(BASE),main) --head $(or $(HEAD),HEAD) --author $(or $(AUTHOR),local) --association $(or $(ASSOCIATION),NONE) --pr 1 --out build/map-pr; \
	  code=$$?; node --experimental-strip-types tools/mapcli/src/prcomment.ts --dry-run build/map-pr/report.json; exit $$code

.PHONY: mapcompile
# -dev keeps the dev-only islands of world.yaml (the sandbox island, docs/16): every local
# build has them; the production image (deploy/Dockerfile.gameserver) leaves them out.
mapcompile: ## Compile world/ + data/items into build/world.bin (server map, with the dev-only islands)
	cd server && go run ./cmd/mapcompile -root .. -out ../build/world.bin -dev

# Needs node and the pnpm workspace (pnpm install): compares mapcompile's walkability with
# packages/map-format on every tile of world/ and of the server's test fixture.
.PHONY: test-parity
test-parity: ## mapcompile vs packages/map-format walkability on every tile
	cd server && RPG_MAPFORMAT_PARITY=1 go test -count=1 -run TestWalkableParityWithMapFormat ./internal/world/compile/

# Lote 16 (docs/18, docs/08 "Fuzzing"): Go native fuzz targets, as <package dir>:<Fuzz
# func> under server/. Their seeds already run in make test; this mutates them for FUZZTIME
# each, one target after another (go test -fuzz takes one target per run). A failure leaves
# the input in that package's testdata/fuzz/<Func>/: commit it with the fix.
FUZZ_TARGETS := internal/net/gateway:FuzzClientFrame internal/session:FuzzInputDispatch internal/httpapi:FuzzJSONRoutes
FUZZTIME ?= 30s
.PHONY: fuzz
fuzz: ## Fuzz every target for FUZZTIME (default 30s): make fuzz [FUZZTIME=5m] [FUZZ_TARGETS=pkg:Func]
	@set -e; for t in $(FUZZ_TARGETS); do \
		pkg=$${t%%:*}; fn=$${t##*:}; echo "==> fuzz $$fn ($$pkg, $(FUZZTIME))"; \
		(cd server && go test -run '^$$' -fuzz "^$$fn\$$" -fuzztime $(FUZZTIME) ./$$pkg/); \
	done

# Lote 16 (docs/18): known vulnerabilities in what we ship and leaked secrets. The same
# checks run in CI (.github/workflows/security.yml). govulncheck only fails on code that
# actually reaches a vulnerable function; gitleaks is optional locally (CI always runs it).
GOVULNCHECK_VERSION := v1.9.0
AUDIT_GO_MODULES := server livingworld/server tools/bots tools/launcher deploy/healthcheck
.PHONY: audit
audit: ## govulncheck (Go modules) + pnpm audit --prod (high) + gitleaks over the history if installed
	@set -e; for m in $(AUDIT_GO_MODULES); do echo "==> govulncheck ($$m)"; \
		(cd $$m && go run golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION) ./...); done
	@echo "==> pnpm audit --prod --audit-level high"
	pnpm audit --prod --audit-level high
	@if command -v gitleaks >/dev/null 2>&1; then echo "==> gitleaks (git history)"; \
		gitleaks git --config .gitleaks.toml --redact --no-banner .; \
	else echo "==> gitleaks not installed: skipped (CI runs it; https://github.com/gitleaks/gitleaks)"; fi

# Browser origins allowed on /ws in development: the client's Vite dev and preview servers
# (also the webview of `make desktop-dev`). RPG_WS_ORIGINS replaces them.
DEV_WS_ORIGINS ?= localhost:5173,localhost:4173
# Local servers let a brand-new account submit maps (T4.5; production waits 24 h).
DEV_SERVER_FLAGS ?= -map-submit-min-account-age 0
# make dev and make play only (http://localhost, never production): the session cookie
# without Secure, or WebKit (Safari, Playwright's WebKit) drops it on plain http and cannot
# stay logged in; and a per-IP register/login burst for trying many accounts from one
# machine (the default, 10 and one more every 6 s, answered 429 while making several).
LOCAL_PLAY_FLAGS ?= -cookie-secure=false -auth-rate-burst 200
# The dev game server listens on loopback only: Vite proxies /api and /ws to it, and a
# server on every interface makes the Windows firewall ask again after each `go run` (a new
# exe path per build). DEV_HTTP_ADDR=:8080 exposes it on the LAN (docs/12).
DEV_HTTP_ADDR ?= 127.0.0.1:8080
# The servers of make run-server, dev and play (and make bots) load build/world.bin from
# make mapcompile, which keeps the dev-only sandbox island (-dev): a server refuses such a
# world in production (RPG_ENV empty or production, docs/09), so with a local database they
# run as development (your own RPG_ENV wins). With a database that is not local they do not
# impose it: that server refuses the sandbox world, as production would, unless you set
# RPG_ENV=development yourself on a server only you reach. Development also lets the fake
# payment provider run: so, as make play always did, the cosmetic shop stays off
# (PAYMENTS_PROVIDER emptied) unless the server is on loopback and the database is local,
# never where someone else reaches it or on a database that is not yours to give premium
# currency away in.
DEV_LOOPBACK = $(or $(filter 127.0.0.1:%,$(DEV_HTTP_ADDR)),$(filter localhost:%,$(DEV_HTTP_ADDR)))
DEV_LOCAL_DB = $(or $(findstring @localhost:,$(DATABASE_URL)),$(findstring @localhost/,$(DATABASE_URL)),$(findstring @127.0.0.1:,$(DATABASE_URL)),$(findstring @127.0.0.1/,$(DATABASE_URL)))
DEV_RPG_ENV = $(if $(DEV_LOCAL_DB),RPG_ENV="$${RPG_ENV:-development}")$(if $(and $(DEV_LOOPBACK),$(DEV_LOCAL_DB)),, PAYMENTS_PROVIDER=)
# Account emails in development (T2.1): `make dev` starts Mailpit and points the server at
# it, so verification and reset links are read at http://localhost:8025. DEV_MAIL=0 = off.
DEV_MAIL ?= 1
DEV_MAIL_ENV := SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMTP_SECURITY=none SMTP_FROM=noreply@rpg.localhost PUBLIC_URL=http://localhost:5173

.PHONY: run-server
run-server: mapcompile ## Compile the map and run the game server on it (RPG_WORLD, DATABASE_URL, RPG_WS_ORIGINS)
	cd server && $(DEV_RPG_ENV) RPG_WORLD="$(CURDIR)/build/world.bin" DATABASE_URL="$(DATABASE_URL)" go run ./cmd/gameserver \
		-http "$(DEV_HTTP_ADDR)" -ws-origins "$${RPG_WS_ORIGINS:-$(DEV_WS_ORIGINS)}" $(DEV_SERVER_FLAGS)

# Operator tools (T2.6): roles are never granted from the game. Recorded in the audit log.
.PHONY: set-role
set-role: ## Set an account's role: make set-role EMAIL=... ROLE=player|gm|admin NOTE="why" [ALLOW_UNVERIFIED=1] (DATABASE_URL)
	cd server && DATABASE_URL="$(DATABASE_URL)" go run ./cmd/gameserver admin set-role -email "$(EMAIL)" -role "$(ROLE)" -note "$(NOTE)" $(if $(filter 1,$(ALLOW_UNVERIFIED)),-allow-unverified)

.PHONY: reset-link
reset-link: ## Print a one-use password reset link: make reset-link EMAIL=... [PUBLIC_URL=http://localhost:5173] (DATABASE_URL)
	cd server && DATABASE_URL="$(DATABASE_URL)" go run ./cmd/gameserver admin reset-link -email "$(EMAIL)" \
		-public-url "$(or $(PUBLIC_URL),http://localhost:5173)"

.PHONY: mail-up
mail-up: ## Start Mailpit (email catcher, T2.1): UI http://localhost:8025, SMTP 127.0.0.1:1025
	$(COMPOSE_DEV) --profile mail up -d --wait mailpit

.PHONY: mail-down
mail-down: ## Stop Mailpit
	$(COMPOSE_DEV) --profile mail stop mailpit

.PHONY: audit-log
audit-log: ## Print the newest audit log entries: make audit-log [N=50] (DATABASE_URL)
	cd server && DATABASE_URL="$(DATABASE_URL)" go run ./cmd/gameserver admin audit -n $(or $(N),50)

.PHONY: reports
reports: ## Print the open player reports with their context: make reports [N=20] (DATABASE_URL)
	cd server && DATABASE_URL="$(DATABASE_URL)" go run ./cmd/gameserver admin reports -n "$(or $(N),20)"

.PHONY: gen-ids
gen-ids: ## Assign numeric IDs to new items in data/ids.lock.yaml (append-only; RETIRE=1 lists deleted items as retired)
	$(CONTENT_CLI) gen-ids $(if $(RETIRE),--retire)

# spritepack runs TypeScript directly, like the content tooling.
.PHONY: sprites
sprites: ## Pack assets/sprites + assets/sprites.yaml into assets/atlas/ (placeholders for missing art)
	node --experimental-strip-types tools/spritepack/src/cli.ts build $(if $(STRICT),--strict)

# tools/gemini: dev-only Python tools that drive the owner's Gemini and bring what it makes
# into our grid, palette and audio format (tools/CLAUDE.md, "gemini"). Their tests need
# Python 3 and Pillow only (no browser, no network; the ffmpeg step is skipped without
# one), so `make test` leaves them out and CI runs them in their own job.
PYTHON ?= $(shell for p in python3 python; do $$p -c 'import sys; sys.exit(sys.version_info < (3, 10))' >/dev/null 2>&1 && { echo $$p; break; }; done)

.PHONY: test-gemini
test-gemini: ## Unit tests of tools/gemini (Python 3.10+ and Pillow; ffmpeg optional)
	@test -n "$(PYTHON)" || { echo "test-gemini: needs Python 3.10+ as python3 or python"; exit 1; }
	$(PYTHON) -m unittest discover -s tools/gemini -p 'test_*.py' -t tools/gemini

# The owner's picks of Gemini music (build/music-gemini/picks.json) into the game: converts
# each pick into assets/sounds/music/gemini/, rewrites its lines of assets/sounds.yaml, the
# prompt files, the CREDITS.md rows and assets/sounds/music/gemini.yaml, then checks the
# size budget. A slot not picked yet plays its take 1 (provisional); "none" plays what it
# played before Gemini. Swap a pick: edit picks.json and run this again (assets/README.md).
.PHONY: music-gemini
music-gemini: ## Put the owner's Gemini music picks in the game: make music-gemini [FROM=build/music-gemini] (Python 3.10+, ffmpeg)
	@test -n "$(PYTHON)" || { echo "music-gemini: needs Python 3.10+ as python3 or python"; exit 1; }
	$(PYTHON) tools/gemini/music_import.py $(if $(FROM),--from "$(FROM)")
	node --experimental-strip-types tools/soundgen/src/cli.ts check

# soundgen renders our own effects and music and encodes them with ffmpeg (libopus) into
# assets/sounds/ (committed, so builds and CI never need ffmpeg). T3.7, assets/README.md.
.PHONY: sounds
sounds: ## Render assets/sounds/** (needs ffmpeg with libopus) and check the size budget
	node --experimental-strip-types tools/soundgen/src/cli.ts build $(if $(ONLY),--only $(ONLY))

# spritegen draws our own pixel art from code recipes into assets/sprites/ (committed, like
# the sounds). Run `make sprites` afterwards to repack the atlas. assets/README.md.
.PHONY: spritegen
spritegen: ## Draw assets/sprites/** from tools/spritegen recipes (ONLY=decor/ for a path prefix)
	node --experimental-strip-types tools/spritegen/src/cli.ts build $(if $(ONLY),--only $(ONLY))

# gen-borders draws the ground transitions of data/borders.yaml (each fringe's 12 pieces in 4
# looks, and the surf in 4 frames) from the grounds' own art. Run it after make spritegen
# changes a ground, or after a change to data/borders.yaml. docs/06 "Bordes".
.PHONY: borders
borders: ## Draw assets/sprites/borders/** from data/borders.yaml and the grounds' art
	node --experimental-strip-types tools/spritepack/src/gen-borders.ts

.PHONY: pwa-icons
pwa-icons: ## Draw the PWA placeholder icons into client/public/icons/ (T5.6)
	node --experimental-strip-types tools/spritegen/src/pwa-icons.ts

.PHONY: assets
assets: sprites sounds ## make sprites + make sounds

# The editor has no "build" script (it runs on Vite's dev server with its file API), so the
# production bundle is built directly; the client's "build" writes build/client (+ atlas/).
.PHONY: build
build: build-editor build-client ## Production builds of the web apps into build/

.PHONY: build-editor
build-editor:
	cd editor && pnpm exec vite build --outDir ../build/editor --emptyOutDir

.PHONY: build-client
build-client:
	pnpm --filter @rpg/client run build

# Short tick and world benchmarks. Output is benchstat-compatible (-count); CI keeps it as
# an artifact and does not fail on timings.
BENCH_PKGS := ./internal/game ./internal/world
.PHONY: bench
bench: ## Short tick/world benchmarks with -benchmem (server/internal/game, world)
	cd server && go test -run '^$$' -bench . -benchmem -benchtime=$(or $(BENCHTIME),1s) -count=$(or $(COUNT),3) $(BENCH_PKGS)

.PHONY: fmt
fmt: ## Format Go and TS code
	@for m in $(GO_MODULES); do (cd $$m && gofmt -w .); done
	pnpm format

## ---- running -------------------------------------------------------------

.PHONY: dev
dev: db-up mapcompile ## Postgres + map + game server (:8080, /ws) + client (:5173) + map editor (:5174) + Mailpit (:8025)
	@echo "[dev] game client on http://localhost:5173, game server on $(DEV_HTTP_ADDR) (ws /ws), map editor on http://localhost:5174"
	@mail_env=""; \
	if [ "$(DEV_MAIL)" = 1 ] && $(MAKE) -s mail-up >/dev/null 2>&1; then \
		mail_env="$(DEV_MAIL_ENV)"; echo "[dev] account emails go to Mailpit: http://localhost:8025"; \
	else echo "[dev] Mailpit not started (no Docker?): account emails are off (DEV_MAIL=0 skips it)"; fi; \
	trap 'kill 0' EXIT; \
	(cd server && env $$mail_env $(DEV_RPG_ENV) RPG_WORLD="$(CURDIR)/build/world.bin" DATABASE_URL="$(DATABASE_URL)" \
		go run ./cmd/gameserver -http "$(DEV_HTTP_ADDR)" -ws-origins "$${RPG_WS_ORIGINS:-$(DEV_WS_ORIGINS)}" $(DEV_SERVER_FLAGS) $(LOCAL_PLAY_FLAGS)) & \
	$(MAKE) client & \
	$(MAKE) editor

# The game on the sandbox island (docs/16-probar-el-juego.md): Postgres, the map, the game
# server with -start-town (new characters wake up on Thimblewick) and the client,
# then the URL to open once both answer. With a local database the server runs as
# development (DEV_RPG_ENV); the
# cosmetic shop runs on the fake payment provider only with the server on loopback and a
# local database: never where someone else reaches it. Ctrl+C stops it all.
# PLAY_START_TOWN=puerto plays the normal start.
PLAY_START_TOWN ?= pruebas
PLAY_HEALTH = http://127.0.0.1:$(lastword $(subst :, ,$(DEV_HTTP_ADDR)))/healthz

.PHONY: play
play: db-up mapcompile ## Play on the sandbox island (docs/16): Postgres + map + game server + client; prints the URL to open
	@command -v curl >/dev/null || { echo "[play] needs curl to see when the server and the client answer"; exit 1; }
	@if curl -sf "$(PLAY_HEALTH)" >/dev/null 2>&1; then \
		echo "[play] a game server already answers on $(PLAY_HEALTH) (make dev? one left running?"; \
		echo "       on Windows: taskkill //IM gameserver.exe //F). Stop it first."; exit 1; fi
	@url="http://localhost:$${CLIENT_PORT:-5173}/play/"; shop_env=""; \
	case "$(DEV_HTTP_ADDR)" in 127.0.0.1:*|localhost:*) loopback=1;; *) loopback=0;; esac; \
	case "$(DATABASE_URL)" in *@localhost:*|*@localhost/*|*@127.0.0.1:*|*@127.0.0.1/*) localdb=1;; *) localdb=0;; esac; \
	if [ $$loopback = 1 ] && [ $$localdb = 1 ]; then shop_env="PAYMENTS_PROVIDER=fake"; \
	else shop_env="PAYMENTS_PROVIDER="; echo "[play] the server is not on loopback or the database is not local: no fake payments, the cosmetic shop stays off"; fi; \
	if [ $$localdb = 0 ] && [ -z "$${RPG_ENV:-}" ]; then echo "[play] the database is not local: the server does not run as development and refuses the sandbox world (set RPG_ENV=development if that database and this server are only yours)"; fi; \
	echo "[play] starting the game server (new characters wake up on '$(PLAY_START_TOWN)') and the client..."; \
	trap 'kill 0' EXIT; \
	(cd server && env $(DEV_RPG_ENV) $$shop_env RPG_WORLD="$(CURDIR)/build/world.bin" DATABASE_URL="$(DATABASE_URL)" \
		go run ./cmd/gameserver -http "$(DEV_HTTP_ADDR)" -ws-origins "$${RPG_WS_ORIGINS:-$(DEV_WS_ORIGINS)}" \
		-start-town "$(PLAY_START_TOWN)" $(DEV_SERVER_FLAGS) $(LOCAL_PLAY_FLAGS)) & srv=$$!; \
	$(MAKE) client & \
	ready=0; for i in $$(seq 1 300); do \
		kill -0 $$srv 2>/dev/null || break; \
		if curl -sf "$(PLAY_HEALTH)" >/dev/null 2>&1 && curl -sf "$$url" >/dev/null 2>&1; then ready=1; break; fi; \
		sleep 1; \
	done; \
	if [ $$ready = 1 ]; then echo ""; echo "[play] ready: open $$url  (Ctrl+C stops everything; guide: docs/16-probar-el-juego.md)"; \
	elif ! kill -0 $$srv 2>/dev/null; then echo "[play] the game server stopped: look at its log above"; exit 1; \
	else echo "[play] the server or the client did not answer in 5 minutes: look at the log above"; fi; \
	wait

.PHONY: client
client: ## Game client dev server on http://localhost:5173 (proxies /api and /ws to RPG_SERVER, default :8080)
	pnpm --filter @rpg/client dev

.PHONY: editor
editor: ## Map editor dev server on http://localhost:5174 (edits world/ in place)
	pnpm --filter @rpg/editor dev

# E2E_ARGS goes to `playwright test` (CI adds the HTML report: --reporter=list,html).
# The client E2E starts the game server on the compiled test map against DATABASE_URL.
.PHONY: e2e
e2e: db-up ## Playwright: editor + client (login, enter, walk); screenshots in */e2e/screenshots/actual
	pnpm --filter @rpg/editor e2e $(E2E_ARGS)
	DATABASE_URL="$(DATABASE_URL)" pnpm --filter @rpg/client e2e $(E2E_ARGS)

.PHONY: ui-preview
# The game's interface with made-up states and a picture of Puerto for the map: no server,
# no Postgres (docs/08). ONLY=<scene> for one scene; screenshots in
# client/e2e/screenshots/actual/ui-preview/.
ui-preview: ## Screenshots of the game UI at desktop, tablet and phone sizes, without a server
	node --experimental-strip-types client/e2e/ui-preview.ts $(if $(ONLY),--only $(ONLY))

.PHONY: bots
# Load test (tools/bots, docs/07-performance-budget.md). Without URL it builds the map and
# starts its own server on loopback (tools/bots/loadtest.sh; LOAD_DATABASE_URL, default the
# dev database); with URL it plays against a running server, reading its internal
# /metrics at 127.0.0.1:9100 only when URL is on this machine (METRICS=... for another).
SCENARIO ?= base
bots: ## Load test: make bots N=100 [SCENARIO=base|stress] [DURATION=10m] [URL=... PREFIX=load METRICS=...]
ifeq ($(URL),)
	$(MAKE) mapcompile
	tools/bots/loadtest.sh -n $(or $(N),10) -scenario $(SCENARIO) -duration $(or $(DURATION),$(if $(filter stress,$(SCENARIO)),5m,10m)) \
		-prefix $(or $(PREFIX),load) -report "$(if $(REPORT),$(abspath $(REPORT)),$(CURDIR)/build/loadtest-$(SCENARIO)-$(or $(N),10).json)"
else
	cd tools/bots && go run ./cmd/bots -n $(or $(N),10) -scenario $(SCENARIO) -duration $(or $(DURATION),60s) \
		-url $(URL) -prefix $(or $(PREFIX),load) $(if $(METRICS),-metrics "$(METRICS)") $(if $(REPORT),-report "$(abspath $(REPORT))")
endif

.PHONY: bench-tick
bench-tick: ## Tick benchmarks: empty loop and N players walking (internal/game, internal/session)
	cd server && go test -run '^$$' -bench . -benchmem ./internal/game/ ./internal/session/

## ---- desktop app (apps/desktop, Tauri 2; docs/12 "Cliente de escritorio") ----------

DESKTOP_DIR := apps/desktop/src-tauri

# The webview loads the client's Vite dev server (:5173, started by Tauri); the app talks to
# RPG_SERVER_URL (default http://localhost:8080, run `make run-server` or `make dev`).
.PHONY: desktop-dev
desktop-dev: ## Desktop app in dev mode against RPG_SERVER_URL (default http://localhost:8080)
	pnpm --filter @rpg/desktop tauri dev

.PHONY: desktop-build
desktop-build: ## Desktop installers for this OS into apps/desktop/src-tauri/target/release/bundle/
	pnpm --filter @rpg/desktop tauri build

.PHONY: desktop-build-debug
desktop-build-debug: ## Debug desktop binary (no installers), used by desktop-smoke
	pnpm --filter @rpg/desktop tauri build --debug --no-bundle

.PHONY: desktop-test
desktop-test: build-client ## rustfmt + clippy + cargo test of the desktop app
	cd $(DESKTOP_DIR) && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test

.PHONY: desktop-smoke
desktop-smoke: db-up desktop-build-debug ## Linux: real app under Xvfb + tauri-driver: login, enter the world, screenshots
	DATABASE_URL="$(DATABASE_URL)" apps/desktop/e2e/smoke.sh

## ---- production stack in Docker (deploy/, docs/09) ------------------------

# Same compose file as the server; deploy/.env is created for local use on first run.
COMPOSE_PROD := docker compose -f deploy/docker-compose.yml --env-file deploy/.env
GIT_COMMIT = $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)

# Local-only settings: Caddy's local CA on https://localhost (no ACME, so the email is a
# placeholder) and a random DB password.
deploy/.env:
	cp deploy/.env.example $@
	sed -i.bak -e 's/^SITE_ADDRESS=.*/SITE_ADDRESS=localhost/' \
		-e 's/^ACME_EMAIL=.*/ACME_EMAIL=local@example.com/' \
		-e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$$(openssl rand -hex 24)/" $@ && rm -f $@.bak
	@echo "created $@ for local use (SITE_ADDRESS=localhost)"

.PHONY: docker-build
docker-build: deploy/.env ## Build the gameserver, web and backup images from this checkout
	VERSION=dev COMMIT=$(GIT_COMMIT) $(COMPOSE_PROD) build

.PHONY: docker-up
docker-up: docker-build ## Run the full production stack locally (https://localhost)
	$(COMPOSE_PROD) up -d --wait
	$(COMPOSE_PROD) ps
	@echo "up: https://localhost (Caddy local CA; the browser warns about the certificate)"

.PHONY: docker-down
docker-down: ## Stop the local production stack (volumes are kept)
	$(COMPOSE_PROD) down

.PHONY: docker-logs
docker-logs: ## Follow the logs of the local production stack
	$(COMPOSE_PROD) logs -f --tail=100

## ---- monitoring (T4.4; docs/09 "Monitoreo") --------------------------------

# Prometheus + Alertmanager + Grafana + node-exporter: the `monitoring` profile of the same
# compose file, on 127.0.0.1 only. A Grafana admin password is added to deploy/.env on the
# first run (only when missing); the ALERT_* channels are optional (docs/09).
COMPOSE_MON := $(COMPOSE_PROD) --profile monitoring

.PHONY: monitoring-env
monitoring-env: deploy/.env
	@grep -qE '^GRAFANA_ADMIN_PASSWORD=.+' deploy/.env || { \
		echo "GRAFANA_ADMIN_PASSWORD=$$(openssl rand -hex 16)" >> deploy/.env; \
		echo "added a random GRAFANA_ADMIN_PASSWORD to deploy/.env (user admin)"; }

.PHONY: monitoring-up
monitoring-up: docker-build monitoring-env ## Production stack + monitoring: Grafana on http://localhost:3000/grafana/
	$(COMPOSE_MON) up -d --wait
	$(COMPOSE_MON) ps
	@echo "Grafana: http://localhost:3000/grafana/ (admin, GRAFANA_ADMIN_PASSWORD in deploy/.env)"
	@echo "Prometheus: http://localhost:9090  Alertmanager: http://localhost:9093"

.PHONY: monitoring-down
monitoring-down: ## Stop the local stack and its monitoring (volumes are kept)
	$(COMPOSE_MON) --profile monitoring-test --profile map-pr down

.PHONY: monitoring-check
monitoring-check: ## promtool/amtool checks, rule unit tests and dashboard JSON (needs Docker)
	deploy/monitoring/check.sh

# End-to-end alert test: a webhook receiver joins the stack, the gameserver is stopped and
# GameServerDown must reach the receiver (~2 min: 1 min `for`, scrape and group_wait).
# Alertmanager is recreated with ALERT_WEBHOOK_URL pointing at the receiver; run
# `make monitoring-up` afterwards to go back to the channels of deploy/.env.
.PHONY: monitoring-test
monitoring-test: monitoring-env ## Fire GameServerDown for real on a test webhook (after make monitoring-up: uses the built images)
	ALERT_WEBHOOK_URL=http://alert-receiver:8000/ $(COMPOSE_MON) --profile monitoring-test up -d --wait --no-build
	$(COMPOSE_PROD) stop gameserver
	@echo "waiting for GameServerDown on the test receiver (up to 4 min)..."; \
	ok=0; for i in $$(seq 1 48); do \
		if $(COMPOSE_PROD) logs alert-receiver 2>/dev/null | grep -q 'ALERT firing GameServerDown'; then \
			$(COMPOSE_PROD) logs --no-log-prefix alert-receiver | grep ALERT; ok=1; break; fi; \
		sleep 5; \
	done; \
	$(COMPOSE_PROD) start gameserver >/dev/null; \
	test "$$ok" = 1 || { echo "GameServerDown did not arrive"; exit 1; }; \
	echo "monitoring-test: alert delivered (gameserver restarted)"

## ---- home hosting (docs/13-hosting-de-pruebas.md) --------------------------

# The logic lives in deploy/home.sh (same steps on Linux, macOS and WSL2). It creates
# deploy/.env.home from deploy/env.home.template with random secrets the first time and
# only adds missing keys afterwards, so `git pull && make home-up` updates in place.
HOME_SH := bash deploy/home.sh
COMPOSE_HOME := docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.home.yml --env-file deploy/.env.home
# Every optional profile: with --profile flags compose ignores COMPOSE_PROFILES, so down and
# logs must name map-pr (T4.5) too or its worker would be left running.
HOME_PROFILES := --profile quick-tunnel --profile tunnel --profile monitoring --profile map-pr --profile mail

# A clone with Windows line endings (CRLF) breaks the shell scripts and Caddyfiles in
# confusing ways; .gitattributes prevents it, this catches clones made before it.
.PHONY: home-check-eol
home-check-eol:
	@if grep -q $$'\r' deploy/home.sh deploy/home-tunnel.sh deploy/Caddyfile.home 2>/dev/null; then \
		echo "[home] error: files have Windows line endings (CRLF). Fix the clone with:"; \
		echo "  git config core.autocrlf false && git rm -rq --cached . && git reset -q --hard"; \
		exit 1; fi

deploy/.env.home: deploy/env.home.template
	@$(HOME_SH) env

.PHONY: home-up
home-up: home-check-eol ## Build, start and check the game on this PC; prints what to open (BUILD=0: no rebuild)
	@$(HOME_SH) up

.PHONY: home-admin
home-admin: ## Give a registered account a role: make home-admin EMAIL=you@example.com [ROLE=admin|gm|player] [ALLOW_UNVERIFIED=1]
	@$(HOME_SH) admin "$(EMAIL)" "$(or $(ROLE),admin)"

.PHONY: home-reset-password
home-reset-password: ## One-use password reset link when there is no SMTP: make home-reset-password EMAIL=you@example.com
	@$(HOME_SH) reset-password "$(EMAIL)"

.PHONY: home-tunnel
home-tunnel: deploy/.env.home ## Cloudflare Quick Tunnel: prints a public https://….trycloudflare.com URL
	COMPOSE="$(COMPOSE_HOME)" bash deploy/home-tunnel.sh

.PHONY: home-tunnel-domain
home-tunnel-domain: deploy/.env.home ## Named Cloudflare Tunnel with your domain (CLOUDFLARE_TUNNEL_TOKEN)
	@grep -qE '^CLOUDFLARE_TUNNEL_TOKEN=.+' deploy/.env.home || { echo "set CLOUDFLARE_TUNNEL_TOKEN in deploy/.env.home (docs/13)"; exit 1; }
	$(COMPOSE_HOME) --profile tunnel up -d cloudflared

# Same monitoring profile as production (T4.4): Grafana on http://localhost:3000/grafana/
# (user admin, GRAFANA_ADMIN_PASSWORD of deploy/.env.home, generated by the template).
.PHONY: home-monitoring-up
home-monitoring-up: home-check-eol ## The game plus monitoring (Prometheus, Alertmanager, Grafana; docs/13)
	@$(HOME_SH) up --monitoring

.PHONY: home-down
home-down: ## Stop the home stack, its tunnels and its monitoring (the data is kept)
	$(COMPOSE_HOME) $(HOME_PROFILES) down

.PHONY: home-logs
home-logs: deploy/.env.home ## Follow the logs of the home stack
	$(COMPOSE_HOME) $(HOME_PROFILES) logs -f --tail=100

.PHONY: home-backup
home-backup: ## pg_dump of the home database into deploy/backups/
	@$(HOME_SH) backup
	@ls -lh deploy/backups | tail -n 3

.PHONY: home-restore
home-restore: ## Replace the home database with a backup: make home-restore FILE=deploy/backups/home-….dump
	@$(HOME_SH) restore "$(FILE)"

.PHONY: home-reset
home-reset: ## Delete ALL data of the home stack (asks first; CONFIRM=yes skips the question)
	@$(HOME_SH) reset

## ---- double-click launcher (docs/13, "La forma más fácil: doble clic") ------

# tools/launcher (Go, stdlib only): NequesRealm-Servidor.exe at the repo root starts the
# home stack through deploy/home.sh, opens the game and shows a menu in Spanish. Built for
# Windows always; on other systems also ./nequesrealm-servidor for this OS. Git ignores both.
LAUNCHER_EXE := NequesRealm-Servidor.exe

.PHONY: launcher
launcher: ## Build NequesRealm-Servidor.exe: double-click it to start the game server on this PC (docs/13)
	cd tools/launcher && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o ../../$(LAUNCHER_EXE) .
ifneq ($(OS),Windows_NT)
	cd tools/launcher && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o ../../nequesrealm-servidor .
endif
	@echo "[launcher] built $(LAUNCHER_EXE): double-click it (docs/13-hosting-de-pruebas.md)"

# Only when the owner runs it: a shortcut on the Windows desktop to the launcher.
.PHONY: launcher-shortcut
launcher-shortcut: launcher ## Windows: shortcut to NequesRealm-Servidor.exe on the desktop
ifeq ($(OS),Windows_NT)
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/launcher-shortcut.ps1 -Target "$(CURDIR)/$(LAUNCHER_EXE)"
else
	@echo "[launcher-shortcut] only on Windows (Git Bash): on Linux or macOS run ./nequesrealm-servidor"
endif

## ---- database ------------------------------------------------------------

# Dev database; the server also applies pending migrations on start (-migrate).
DATABASE_URL ?= postgres://postgres:postgres@localhost:5432/rpg
TEST_DATABASE_URL ?= postgres://postgres:postgres@localhost:5432/rpg_test
GOOSE := goose -dir server/migrations postgres "$(DATABASE_URL)"

.PHONY: migrate-up
migrate-up: ## Apply pending migrations to DATABASE_URL
	$(GOOSE) up

.PHONY: migrate-down
migrate-down: ## Roll back the last migration on DATABASE_URL
	$(GOOSE) down

.PHONY: migrate-status
migrate-status: ## Show migration status of DATABASE_URL
	$(GOOSE) status

.PHONY: migrate-new
migrate-new: ## Create a migration: make migrate-new NAME=add_houses
	@test -n "$(NAME)" || { echo "usage: make migrate-new NAME=snake_case_name"; exit 1; }
	goose -dir server/migrations -s create $(NAME) sql

.PHONY: test-integration
test-integration: ## Go integration tests + the map PR worker's queue against Postgres (TEST_DATABASE_URL)
	cd server && TEST_DATABASE_URL="$(TEST_DATABASE_URL)" go test -tags integration -count=1 ./...
	MAP_PR_WORKER_DATABASE_URL="$(TEST_DATABASE_URL)" pnpm exec vitest run tools/map-pr-worker/src/queue.integration.test.ts

.PHONY: db-up
db-up: ## Start dev Postgres (Docker locally, VM service in cloud sessions)
ifeq ($(IS_CLOUD),true)
	service postgresql start
else
	$(COMPOSE_DEV) up -d --wait
endif

.PHONY: db-down
db-down: ## Stop dev Postgres (data is kept in a Docker volume)
ifeq ($(IS_CLOUD),true)
	service postgresql stop
else
	$(COMPOSE_DEV) down
endif
