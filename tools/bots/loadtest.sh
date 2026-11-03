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
bots="$root/build/bots-load"
log="$root/build/loadtest-server.log"

if [[ ! -f "$root/build/world.bin" ]]; then
  echo "loadtest: $root/build/world.bin is missing (make mapcompile)" >&2
  exit 2
fi
for u in "http://127.0.0.1:$port/healthz" "http://$maddr/metrics"; do
  # curl without -f exits 0 on any HTTP answer and non-zero when nothing listens.
  if curl -s -o /dev/null --max-time 2 "$u"; then
    echo "loadtest: something already answers on $u (another load test or server?);" \
      "stop it or set LOAD_PORT / LOAD_METRICS_PORT" >&2
    exit 1
  fi
done
(cd "$root/server" && go build -o "$bin" ./cmd/gameserver)
(cd "$root/tools/bots" && go build -o "$bots" ./cmd/bots)

DATABASE_URL="$db" "$bin" -world "$root/build/world.bin" -data "$root/data" \
  -http "127.0.0.1:$port" -metrics-addr "$maddr" -auth-rate-burst 1000 >"$log" 2>&1 &
server=$!
stop_server() {
  kill -INT "$server" 2>/dev/null || true
  wait "$server" 2>/dev/null || true
}
trap stop_server EXIT

up=
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
    up=1
    break
  fi
  if ! kill -0 "$server" 2>/dev/null; then
    echo "loadtest: the server exited; see $log" >&2
    tail -n 20 "$log" >&2
    exit 1
  fi
  sleep 0.5
done
if [[ -z "$up" ]]; then
  echo "loadtest: the server did not answer /healthz in 30 s; see $log" >&2
  exit 1
fi
# The answer must come from our server, not one that held the port (checked above, but
# a server can start in between).
if ! kill -0 "$server" 2>/dev/null; then
  echo "loadtest: the server exited after starting; see $log" >&2
  tail -n 20 "$log" >&2
  exit 1
fi
echo "loadtest: server up on :$port (log: $log)"

# Run from the caller's directory, so a relative -report lands where the caller expects.
"$bots" -url "http://127.0.0.1:$port" -metrics "http://$maddr/metrics" \
  -world "$root/build/world.bin" -require-metrics "$@"
