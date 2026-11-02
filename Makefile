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
gen: gen-proto ## buf generate + sqlc generate (+ ids.lock.yaml)
	$(call pending,T1.3 (sqlc) / T0.3 (ids.lock.yaml))

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
test: test-go test-ts ## Go + TS tests

.PHONY: test-go
test-go:
	@set -e; for m in $(GO_MODULES); do echo "==> go test ($$m)"; (cd $$m && go test ./...); done

.PHONY: test-ts
test-ts:
	pnpm -r run test

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

.PHONY: validate
validate: ## Validate data/ YAML and world/ maps against the schemas
	$(call pending,T0.3 (content) / T0.4 (maps))

.PHONY: fmt
fmt: ## Format Go and TS code
	@for m in $(GO_MODULES); do (cd $$m && gofmt -w .); done
	pnpm format

## ---- running -------------------------------------------------------------

.PHONY: dev
dev: db-up ## Postgres + server + client + editor in dev mode
	$(call pending,T1.4 (server) / T1.5 (client) / T1.14 (editor))

.PHONY: e2e
e2e: ## Playwright: boot everything, log in and take screenshots
	$(call pending,T1.5)

.PHONY: bots
bots: ## Load test with N bots (make bots N=100)
	cd tools/bots && go run ./cmd/bots -n $(or $(N),10)

## ---- database ------------------------------------------------------------

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
