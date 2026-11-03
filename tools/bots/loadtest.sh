#!/usr/bin/env bash
# Load test with its own server (make bots without URL): builds the gameserver, starts it
# on loopback against Postgres with its internal /metrics, runs cmd/bots with the given
# arguments and stops the server. Needs build/world.bin (make mapcompile).
#
#   tools/bots/loadtest.sh -n 100 -scenario base -duration 10m -report build/load.json
#
# Environment: LOAD_DATABASE_URL (default $DATABASE_URL or the dev database rpg),
# LOAD_PORT (8090), LOAD_METRICS_PORT (9190).
#
# Every bot connects from 127.0.0.1, so this test server gets a larger per-IP
# register/login burst (-auth-rate-burst, the flag meant for local harnesses). Only this
# local process gets it: production keeps the default limits.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
db="${LOAD_DATABASE_URL:-${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/rpg}}"
port="${LOAD_PORT:-8090}"
maddr="127.0.0.1:${LOAD_METRICS_PORT:-9190}"
bin="$root/build/gameserver-load"
log="$root/build/loadtest-server.log"

if [[ ! -f "$root/build/world.bin" ]]; then
  echo "loadtest: $root/build/world.bin is missing (make mapcompile)" >&2
  exit 2
fi
(cd "$root/server" && go build -o "$bin" ./cmd/gameserver)

DATABASE_URL="$db" "$bin" -world "$root/build/world.bin" -data "$root/data" \
  -http "127.0.0.1:$port" -metrics-addr "$maddr" -auth-rate-burst 1000 >"$log" 2>&1 &
server=$!
stop_server() {
  kill -INT "$server" 2>/dev/null || true
  wait "$server" 2>/dev/null || true
}
trap stop_server EXIT

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$server" 2>/dev/null; then
    echo "loadtest: the server exited; see $log" >&2
    tail -n 20 "$log" >&2
    exit 1
  fi
  sleep 0.5
done
echo "loadtest: server up on :$port (log: $log)"

cd "$root/tools/bots"
go run ./cmd/bots -url "http://127.0.0.1:$port" -metrics "http://$maddr/metrics" \
  -world "$root/build/world.bin" "$@"
