#!/usr/bin/env bash
# Installs the tools and dependencies needed to develop RPG Project.
# Called by `make setup`. Idempotent: re-running it only installs what is missing.
# Works on Linux, WSL2 and macOS (bash 3.2 compatible). Also safe in cloud sessions,
# where scripts/cloud-setup.sh already installed most tools.
set -euo pipefail

cd "$(dirname "$0")/.."

# Pinned tool versions. golangci-lint must match .github/workflows/ci.yml.
# staticcheck is also run by golangci-lint; the standalone binary is for quick checks.
BUF_VERSION=v1.75.0
SQLC_VERSION=v1.31.1
GOOSE_VERSION=v3.29.0
STATICCHECK_VERSION=2026.2.2
GOLANGCI_LINT_VERSION=v2.15.0

log() { printf '[local-setup] %s\n' "$*"; }
fail() { printf '[local-setup] ERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# 1. Required base tools
have git || fail "git is not installed"
have go || fail "Go is not installed (use the version in server/go.mod: https://go.dev/dl/)"
have node || fail "Node 22 is not installed (https://nodejs.org or nvm)"
# Must match "engines" in package.json.
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' \
  || fail "Node >= 22.13 required, found $(node --version)"
if ! have pnpm; then
  log "pnpm not found; enabling it with corepack"
  corepack enable || true
  have pnpm || fail "pnpm is still missing; run 'corepack enable' (may need sudo) or 'npm i -g pnpm'"
fi
have docker || log "WARNING: Docker not found. 'make db-up' needs it for local Postgres."

# 2. Go tools (installed into GOBIN or GOPATH/bin)
gobin=$(go env GOBIN)
[ -n "$gobin" ] || gobin="$(go env GOPATH)/bin"
case ":$PATH:" in
  *":$gobin:"*) ;;
  *) log "WARNING: $gobin is not in PATH; add it so the Go tools are found" ;;
esac

install_go_tool() { # binary module@version
  local bin=$1 pkg=$2 want installed
  want=${pkg##*@v}
  want=${want##*@}
  if have "$bin"; then
    installed=$("$bin" --version 2>/dev/null || "$bin" version 2>/dev/null || "$bin" -version 2>/dev/null || true)
    case "$installed" in
      *"$want"*) log "$bin $want already installed" ;;
      *) log "WARNING: $bin is installed but not version $want (found: ${installed%%$'\n'*})."
         log "         Reinstall with: go install $pkg" ;;
    esac
  else
    log "installing $bin ($pkg)"
    go install "$pkg"
  fi
}
install_go_tool buf "github.com/bufbuild/buf/cmd/buf@$BUF_VERSION"
install_go_tool goose "github.com/pressly/goose/v3/cmd/goose@$GOOSE_VERSION"
install_go_tool staticcheck "honnef.co/go/tools/cmd/staticcheck@$STATICCHECK_VERSION"
install_go_tool golangci-lint "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$GOLANGCI_LINT_VERSION"
# sqlc needs cgo (a C compiler: build-essential on Linux/WSL, Xcode CLT on macOS).
CGO_ENABLED=1 install_go_tool sqlc "github.com/sqlc-dev/sqlc/cmd/sqlc@$SQLC_VERSION"

# 3. Go module dependencies
for m in server tools/bots; do
  log "go mod download ($m)"
  (cd "$m" && go mod download)
done

# 4. JS dependencies and the Playwright browser matching @playwright/test
log "pnpm install"
pnpm install --frozen-lockfile
log "installing Chromium for Playwright"
if ! pnpm exec playwright install chromium; then
  log "WARNING: Playwright Chromium install failed. On Linux/WSL you may also need:"
  log "         sudo pnpm exec playwright install-deps chromium"
fi

log "done. Next: 'make db-up' (Postgres in Docker) and 'make test'."
