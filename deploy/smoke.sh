#!/usr/bin/env bash
# Smoke test of a running stack, through Caddy (docs/09-deployment-aws.md, docs/13).
#
#   deploy/smoke.sh http://localhost:8080
#
# Checks: /healthz, the website, the game page and the public API (T4.3), register + login, the /ws upgrade, and that a
# client-supplied X-Forwarded-For / CF-Connecting-IP cannot dodge the per-IP auth rate
# limit (T1.3). The last check consumes this machine's auth budget for about a minute.
set -euo pipefail

base="${1:?usage: smoke.sh <base-url>}"
base="${base%/}"
curl_opts=(-sS --max-time 10)
fail() { echo "smoke: FAIL: $*" >&2; exit 1; }
ok() { echo "smoke: ok: $*"; }

code=$(curl "${curl_opts[@]}" -o /dev/null -w '%{http_code}' "$base/healthz")
[[ $code == 200 ]] || fail "/healthz answered $code"
ok "/healthz"

page=$(curl "${curl_opts[@]}" "$base/")
grep -qi '<script' <<<"$page" || fail "/ is not the client build"
ok "website page"

# T4.3: the game lives in /play/ (a different page of the same build); website routes such
# as /highscores fall back to the website page.
game=$(curl "${curl_opts[@]}" "$base/play/")
grep -qi '<script' <<<"$game" && [[ $game != "$page" ]] || fail "/play/ is not the game page"
hs=$(curl "${curl_opts[@]}" "$base/highscores")
[[ $hs == "$page" ]] || fail "/highscores does not fall back to the website page"
ok "game page (/play/) and website routes"
status=$(curl "${curl_opts[@]}" "$base/api/status")
grep -q '"online":true' <<<"$status" || fail "/api/status: $status"
code=$(curl "${curl_opts[@]}" -o /dev/null -w '%{http_code}' "$base/api/highscores?category=level")
[[ $code == 200 ]] || fail "/api/highscores answered $code"
ok "/api/status and /api/highscores"

email="smoke-$(date +%s)-$RANDOM@example.org"
creds="{\"email\":\"$email\",\"password\":\"smoke-password-1\"}"
code=$(curl "${curl_opts[@]}" -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
	-d "$creds" "$base/api/auth/register")
[[ $code == 201 ]] || fail "register answered $code"
login=$(curl "${curl_opts[@]}" -H 'Content-Type: application/json' \
	-d "{\"email\":\"$email\",\"password\":\"smoke-password-1\",\"token_in_body\":true}" "$base/api/auth/login")
grep -q '"token"' <<<"$login" || fail "login: $login"
ok "register + login"

# WebSocket upgrade through the proxy. curl keeps the upgraded connection open until the
# timeout, so only the status code matters.
code=$(curl -sS --http1.1 --max-time 3 -o /dev/null -w '%{http_code}' \
	-H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
	-H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$base/ws" || true)
[[ $code == 101 ]] || fail "/ws upgrade answered $code"
ok "/ws upgrade (101)"

# Spoofing: every failed login carries a different forged client IP. If the server keyed on
# them, no request would ever be limited; keyed on the real hop, the burst (10) runs out.
# forged_logins <header...>: prints the status codes, stopping at the first 429.
forged_logins() {
	local i code out=()
	for i in $(seq 1 15); do
		local hdrs=()
		for h in "$@"; do hdrs+=(-H "$h: 203.0.113.$i"); done
		code=$(curl "${curl_opts[@]}" -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
			"${hdrs[@]}" -d '{"email":"nobody@example.org","password":"wrong-password"}' "$base/api/auth/login")
		out+=("$code")
		[[ $code == 429 ]] && break
	done
	echo "${out[*]}"
}

# 1. Forged CF-Connecting-IP: limited by the real IP (direct to Caddy), or refused at the
#    edge (Cloudflare answers 403 to requests that already carry the header).
codes=$(forged_logins CF-Connecting-IP X-Forwarded-For)
refused=1
for c in $codes; do [[ $c == 403 ]] || refused=0; done
if [[ " $codes " == *" 429 "* || $refused == 1 ]]; then
	ok "forged CF-Connecting-IP limited or refused (codes: $codes)"
else
	fail "forged CF-Connecting-IP was never rate limited (codes: $codes)"
fi

# 2. Forged X-Forwarded-For / X-Real-IP only: must hit the per-IP limit everywhere.
codes=$(forged_logins X-Forwarded-For X-Real-IP)
[[ " $codes " == *" 429 "* ]] || fail "forged X-Forwarded-For was never rate limited (codes: $codes)"
ok "forged X-Forwarded-For does not bypass the per-IP limit (codes: $codes)"
