# RPG Project — task runner. Works the same in cloud sessions and locally
# (WSL2/macOS/Linux). Targets marked "pending" print the roadmap task that builds them.

SHELL := /bin/bash
.DEFAULT_GOAL := help

GO_MODULES := server tools/bots
COMPOSE_DEV := docker compose -f deploy/docker-compose.dev.yml
# Cloud sessions run Postgres as a VM service; local machines use Docker.
IS_CLOUD := $(filter true,$(CLAUDE_CODE_REMOTE))

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
.PHONY: gen-proto
gen-proto: ## buf generate: Go (server/internal/net/pb) and TS (packages/protocol/src/gen)
	cd server && go build -o bin/protoc-gen-go google.golang.org/protobuf/cmd/protoc-gen-go
	test -x packages/protocol/node_modules/.bin/protoc-gen-es || pnpm install --frozen-lockfile
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
test: test-go test-ts test-parity ## Go + TS tests

.PHONY: test-go
test-go:
	@set -e; for m in $(GO_MODULES); do echo "==> go test ($$m)"; (cd $$m && go test ./...); done

.PHONY: test-ts
test-ts:
	pnpm test

.PHONY: lint
lint: lint-go lint-ts validate ## golangci-lint + eslint/prettier/tsc + content validation

.PHONY: lint-go
lint-go:
	@set -e; for m in $(GO_MODULES); do \
		echo "==> lint ($$m)"; \
		(cd $$m && test -z "$$(gofmt -l .)" || { gofmt -l .; echo "gofmt: files above need formatting"; exit 1; }); \
		(cd $$m && go vet ./... && golangci-lint run ./...); \
	done

.PHONY: lint-ts
lint-ts:
	pnpm lint
	pnpm typecheck

# Content tooling runs TypeScript directly (Node strips types; the flag is needed < 22.18).
CONTENT_CLI := node --experimental-strip-types packages/content-schema/src/cli.ts

MAPCLI := node --experimental-strip-types tools/mapcli/src/cli.ts

.PHONY: validate
validate: ## Validate data/ and i18n/ against the schemas, then world/ maps (mapcli validate)
	$(CONTENT_CLI) validate
	$(MAPCLI) validate --format text

.PHONY: mapcompile
mapcompile: ## Compile world/ + data/items into build/world.bin (server map)
	cd server && go run ./cmd/mapcompile -root .. -out ../build/world.bin

# Needs node and the pnpm workspace (pnpm install): compares mapcompile's walkability with
# packages/map-format on every tile of world/ and of the server's test fixture.
.PHONY: test-parity
test-parity: ## mapcompile vs packages/map-format walkability on every tile
	cd server && RPG_MAPFORMAT_PARITY=1 go test -count=1 -run TestWalkableParityWithMapFormat ./internal/world/compile/

.PHONY: run-server
run-server: mapcompile ## Compile the map and run the game server on it (RPG_WORLD, DATABASE_URL)
	cd server && RPG_WORLD="$(CURDIR)/build/world.bin" DATABASE_URL="$(DATABASE_URL)" go run ./cmd/gameserver

.PHONY: gen-ids
gen-ids: ## Assign numeric IDs to new items in data/ids.lock.yaml (append-only)
	$(CONTENT_CLI) gen-ids

# spritepack runs TypeScript directly, like the content tooling.
.PHONY: sprites
sprites: ## Pack assets/sprites + assets/sprites.yaml into assets/atlas/ (placeholders for missing art)
	node --experimental-strip-types tools/spritepack/src/cli.ts build $(if $(STRICT),--strict)

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
dev: db-up mapcompile ## Postgres + map + game server (:8080, /ws) + client (:5173) + map editor (:5174)
	@echo "[dev] game client on http://localhost:5173, game server on :8080 (ws /ws), map editor on http://localhost:5174"
	@trap 'kill 0' EXIT; \
	(cd server && RPG_WORLD="$(CURDIR)/build/world.bin" DATABASE_URL="$(DATABASE_URL)" \
		go run ./cmd/gameserver -ws-origins "localhost:5173,localhost:4173") & \
	$(MAKE) client & \
	$(MAKE) editor

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

.PHONY: bots
# Load test (tools/bots, docs/07-performance-budget.md). Without URL it builds the map and
# starts its own server on loopback (tools/bots/loadtest.sh); with URL it plays against a
# running server (its /metrics is internal, so only client-side numbers unless METRICS=...).
SCENARIO ?= base
bots: ## Load test: make bots N=100 [SCENARIO=base|stress] [DURATION=10m] [URL=... PREFIX=load METRICS=...]
ifeq ($(URL),)
	$(MAKE) mapcompile
	tools/bots/loadtest.sh -n $(or $(N),10) -scenario $(SCENARIO) -duration $(or $(DURATION),$(if $(filter stress,$(SCENARIO)),5m,10m)) \
		-prefix $(or $(PREFIX),load) -report $(or $(REPORT),$(CURDIR)/build/loadtest-$(SCENARIO)-$(or $(N),10).json)
else
	cd tools/bots && go run ./cmd/bots -n $(or $(N),10) -scenario $(SCENARIO) -duration $(or $(DURATION),60s) \
		-url $(URL) -prefix $(or $(PREFIX),load) -metrics "$(METRICS)" $(if $(REPORT),-report $(REPORT))
endif

.PHONY: bench-tick
bench-tick: ## Tick benchmarks: empty loop and N players walking (internal/game, internal/session)
	cd server && go test -run '^$$' -bench . -benchmem ./internal/game/ ./internal/session/

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

## ---- home hosting (docs/13-hosting-de-pruebas.md) --------------------------

COMPOSE_HOME := docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.home.yml --env-file deploy/.env.home
HOME_PROFILES := --profile quick-tunnel --profile tunnel

deploy/.env.home:
	cp deploy/.env.home.example $@
	sed -i.bak -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$$(openssl rand -hex 24)/" $@ && rm -f $@.bak
	@echo "created $@ (random database password)"

.PHONY: home-up
home-up: deploy/.env.home ## Build and start the game on this PC (http://localhost:8080)
	VERSION=dev COMMIT=$(GIT_COMMIT) $(COMPOSE_HOME) up -d --build --wait
	$(COMPOSE_HOME) ps
	@echo "up: http://localhost:$$(grep -E '^HOME_HTTP_PORT=' deploy/.env.home | cut -d= -f2 || echo 8080)  —  share it with: make home-tunnel"

.PHONY: home-tunnel
home-tunnel: deploy/.env.home ## Cloudflare Quick Tunnel: prints a public https://….trycloudflare.com URL
	COMPOSE="$(COMPOSE_HOME)" bash deploy/home-tunnel.sh

.PHONY: home-tunnel-domain
home-tunnel-domain: deploy/.env.home ## Named Cloudflare Tunnel with your domain (CLOUDFLARE_TUNNEL_TOKEN)
	@grep -qE '^CLOUDFLARE_TUNNEL_TOKEN=.+' deploy/.env.home || { echo "set CLOUDFLARE_TUNNEL_TOKEN in deploy/.env.home (docs/13)"; exit 1; }
	$(COMPOSE_HOME) --profile tunnel up -d cloudflared

.PHONY: home-down
home-down: ## Stop the home stack and its tunnels (the database volume is kept)
	$(COMPOSE_HOME) $(HOME_PROFILES) down

.PHONY: home-logs
home-logs: ## Follow the logs of the home stack
	$(COMPOSE_HOME) $(HOME_PROFILES) logs -f --tail=100

.PHONY: home-backup
home-backup: ## pg_dump of the home database into deploy/backups/
	@mkdir -p deploy/backups
	f=deploy/backups/home-$$(date +%Y%m%d-%H%M%S).dump; \
	$(COMPOSE_HOME) exec -T postgres sh -c 'pg_dump -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -Fc' > $$f.part \
		&& mv $$f.part $$f && echo "wrote $$f (restore: docs/13-hosting-de-pruebas.md)"
	@ls -lh deploy/backups | tail -n 3

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
test-integration: ## Go integration tests against Postgres (TEST_DATABASE_URL)
	cd server && TEST_DATABASE_URL="$(TEST_DATABASE_URL)" go test -tags integration -count=1 ./...

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
