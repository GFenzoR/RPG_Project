#!/usr/bin/env bash
# Desktop smoke test on Linux (make desktop-smoke): game server on :18090 against
# DATABASE_URL, the debug desktop app under Xvfb driven by tauri-driver, then e2e/smoke.ts.
# Needs: webkit2gtk-driver (WebKitWebDriver), tauri-driver (cargo install tauri-driver
# --locked), Xvfb, and Postgres (make db-up). Screenshots in apps/desktop/e2e/screenshots/.
set -euo pipefail
cd "$(dirname "$0")/../../.."

PORT=${SMOKE_PORT:-18090}
BIN=apps/desktop/src-tauri/target/debug/rpg-desktop
LOG=build/desktop-smoke
mkdir -p "$LOG"
for tool in WebKitWebDriver tauri-driver Xvfb; do
	command -v "$tool" >/dev/null || { echo "missing $tool (see docs/12-local-development.md)"; exit 1; }
done
test -x "$BIN" || { echo "build the app first: make desktop-build-debug"; exit 1; }

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

(cd server && go run ./cmd/mapcompile -root .. -out ../build/world.bin)
# The desktop app's WebSocket origin: tauri://localhost on Linux and macOS.
(cd server && exec go run ./cmd/gameserver -http "127.0.0.1:$PORT" -world ../build/world.bin -seed 1 \
	-auth-rate-burst 1000 -start-town testisle -ws-origins "tauri://localhost,http://tauri.localhost") \
	>"$LOG/server.log" 2>&1 &
pids+=($!)
for _ in $(seq 120); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || { cat "$LOG/server.log"; exit 1; }

Xvfb :99 -screen 0 1280x800x24 >"$LOG/xvfb.log" 2>&1 &
pids+=($!)
export DISPLAY=:99
# tauri-driver starts the app with this environment.
RPG_SERVER_URL="http://127.0.0.1:$PORT" tauri-driver >"$LOG/driver.log" 2>&1 &
pids+=($!)
sleep 2

DESKTOP_BIN="$PWD/$BIN" SERVER="http://127.0.0.1:$PORT" \
	node --experimental-strip-types apps/desktop/e2e/smoke.ts || {
	echo "--- driver/app log"; tail -n 40 "$LOG/driver.log"; exit 1
}
