#!/usr/bin/env bash
# Smoke test of a running stack, through Caddy (docs/09-deployment-aws.md, docs/13).
#
#   deploy/smoke.sh http://localhost:8080
#
# Checks: /healthz, the client page, register + login, the /ws upgrade, and that a
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
ok "client page"

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
limited=0
codes=()
for i in $(seq 1 15); do
	code=$(curl "${curl_opts[@]}" -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
		-H "X-Forwarded-For: 203.0.113.$i" -H "X-Real-IP: 203.0.113.$i" -H "CF-Connecting-IP: 198.51.100.$i" \
		-d '{"email":"nobody@example.org","password":"wrong-password"}' "$base/api/auth/login")
	codes+=("$code")
	if [[ $code == 429 ]]; then limited=1; break; fi
done
[[ $limited == 1 ]] || fail "15 logins with forged client IPs were never rate limited (codes: ${codes[*]})"
ok "forged X-Forwarded-For / CF-Connecting-IP do not bypass the per-IP limit (codes: ${codes[*]})"
