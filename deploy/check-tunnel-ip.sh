#!/usr/bin/env bash
# Checks the client-IP chain behind the tunnel (docs/13-hosting-de-pruebas.md): a container
# on the tunnel network plays cloudflared and sends CF-Connecting-IP, as Cloudflare's edge
# does. Expected:
#   - Caddy trusts that network and forwards CF-Connecting-IP as the client IP, so one
#     player's failed logins exhaust THAT player's auth budget (429) ...
#   - ... while another player behind the same tunnel is unaffected (401, not 429).
#   - A forged X-Forwarded-For next to it is ignored.
#
#   deploy/check-tunnel-ip.sh rpg-home_tunnel
set -euo pipefail

net="${1:?usage: check-tunnel-ip.sh <tunnel docker network>}"
image="${CURL_IMAGE:-curlimages/curl:8.11.1}"

# shellcheck disable=SC2016 # expanded by the container's shell
out=$(docker run --rm --network "$net" --entrypoint sh "$image" -c '
login() {
	curl -sS --max-time 10 -o /dev/null -w "%{http_code}" -H "Content-Type: application/json" \
		-H "CF-Connecting-IP: $1" -H "X-Forwarded-For: $2" \
		-d "{\"email\":\"nobody@example.org\",\"password\":\"wrong-password\"}" \
		http://caddy:80/api/auth/login
}
a=""
i=0
while [ $i -lt 15 ]; do
	i=$((i + 1))
	a=$(login 192.0.2.10 "203.0.113.$i")
	[ "$a" = 429 ] && break
done
b=$(login 192.0.2.20 203.0.113.99)
echo "$a $b"
')
read -r a b <<<"$out"
[[ $a == 429 ]] || { echo "check-tunnel-ip: FAIL: player A was never limited (last $a): CF-Connecting-IP or forged XFF honoured per request" >&2; exit 1; }
[[ $b == 401 ]] || { echo "check-tunnel-ip: FAIL: player B got $b, expected 401: the tunnel is not trusted (all players share cloudflared's IP)" >&2; exit 1; }
echo "check-tunnel-ip: ok: CF-Connecting-IP from the tunnel is the client IP; forged X-Forwarded-For ignored"
