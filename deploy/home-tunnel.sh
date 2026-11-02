#!/usr/bin/env bash
# Starts the Cloudflare Quick Tunnel of the home stack and prints its public URL
# (docs/13-hosting-de-pruebas.md). Called by `make home-tunnel`; COMPOSE is the compose
# command of the home stack.
set -euo pipefail

compose=${COMPOSE:?COMPOSE must hold the home compose command}
read -r -a cmd <<<"$compose"

"${cmd[@]}" --profile quick-tunnel up -d cloudflared-quick
echo "home-tunnel: waiting for the public URL..."
url=""
for _ in $(seq 1 60); do
	url=$("${cmd[@]}" logs --no-color cloudflared-quick 2>&1 |
		grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -n 1 || true)
	[[ -n $url ]] && break
	sleep 1
done
if [[ -z $url ]]; then
	echo "home-tunnel: no URL after 60 s; check \`make home-logs\`" >&2
	exit 1
fi

# The DNS name can take a few seconds to resolve; wait until the game answers through it.
for _ in $(seq 1 30); do
	if curl -fsS --max-time 5 -o /dev/null "$url/healthz" 2>/dev/null; then
		break
	fi
	sleep 2
done

cat <<MSG

  Public URL (share it): $url

  It changes on every start. Stop it with \`make home-down\` (or keep the game running and
  remove only the tunnel: docker compose ... rm -sf cloudflared-quick).
MSG
echo "$url" >"${HOME_TUNNEL_URL_FILE:-/dev/null}"
