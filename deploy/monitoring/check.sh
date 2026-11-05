#!/usr/bin/env bash
# Static checks of deploy/monitoring (T4.4): `make monitoring-check` and CI (images.yml,
# deploy-lint). Needs only Docker: promtool and amtool come from the pinned images that the
# compose file runs, so the checks use the same versions as production.
#
#   - promtool check config + rules, and the rule unit tests (prometheus/tests)
#   - amtool check-config on the config the Alertmanager entrypoint generates, with every
#     channel set (fake values) and with none
#   - the Grafana dashboards and provisioning parse as JSON/YAML
set -euo pipefail
cd "$(dirname "$0")"

compose=../docker-compose.yml
image() { grep -Eo "image: $1:[^ ]+" "$compose" | head -n 1 | cut -d' ' -f2; }
PROM=$(image prom/prometheus)
AM=$(image prom/alertmanager)
[[ -n $PROM && -n $AM ]] || { echo "check.sh: images not found in $compose" >&2; exit 1; }

echo "==> promtool ($PROM)"
docker run --rm -v "$PWD/prometheus:/etc/prometheus:ro" --entrypoint promtool "$PROM" \
	check config /etc/prometheus/prometheus.yml
docker run --rm -v "$PWD/prometheus:/etc/prometheus:ro" -w /etc/prometheus/tests --entrypoint promtool "$PROM" \
	test rules alerts_test.yml

echo "==> amtool ($AM)"
docker run --rm -v "$PWD/alertmanager:/m:ro" --entrypoint /bin/sh \
	-e ALERT_DISCORD_WEBHOOK_URL=https://discord.example/api/webhooks/1/x \
	-e ALERT_TELEGRAM_BOT_TOKEN=123:abc -e ALERT_TELEGRAM_CHAT_ID=-1001 \
	-e ALERT_WEBHOOK_URL=http://receiver.example/hook \
	-e ALERT_EMAIL_TO=ops@example.com -e ALERT_SMTP_SMARTHOST=smtp.example.com:587 \
	-e ALERT_SMTP_FROM=alerts@example.com -e ALERT_SMTP_USER=u -e ALERT_SMTP_PASSWORD=p \
	"$AM" -c '/m/entrypoint.sh --print >/dev/null && amtool check-config /tmp/alertmanager.yml'
docker run --rm -v "$PWD/alertmanager:/m:ro" --entrypoint /bin/sh "$AM" \
	-c '/m/entrypoint.sh --print >/dev/null && amtool check-config /tmp/alertmanager.yml'

echo "==> caddy /grafana/ route (GRAFANA_PUBLIC=on) with half-configured credentials"
# The compose defaults must keep Caddy parsing whatever subset of the pair is set: a
# Caddyfile error would take the whole site down (only 401 on /grafana/ is acceptable).
CADDY=caddy:2.11-alpine
printf 'POSTGRES_PASSWORD=x\nSITE_ADDRESS=localhost\nACME_EMAIL=ops@example.com\n' >"${TMPDIR:-/tmp}/rpg-check.env"
for pair in "" "GRAFANA_BASIC_AUTH_USER=ops" "GRAFANA_BASIC_AUTH_HASH=\$2a\$10\$h5iRjwthGVRQaUfhHaqSI.HfHTqlpCTohb2XJVOQpnwN8qsLbPWb2"; do
	# Caddy's environment as compose interpolates it (config escapes $ as $$).
	# No mapfile, and args never empty under set -u: bash 3.2 (macOS) runs this too.
	args=(-e GRAFANA_PUBLIC=on)
	while IFS= read -r e; do args+=(-e "$e"); done < <(env -i PATH="$PATH" HOME="${HOME:-/tmp}" ${pair:+"$pair"} GRAFANA_PUBLIC=on \
		docker compose -f "$compose" --env-file "${TMPDIR:-/tmp}/rpg-check.env" config --format json |
		python3 -c 'import json, sys
for k, v in json.load(sys.stdin)["services"]["caddy"]["environment"].items():
    print(k + "=" + v.replace(chr(36) * 2, chr(36)))')
	echo "  case [${pair%%=*}]"
	out=$(docker run --rm "${args[@]}" -v "$PWD/..:/etc/caddy:ro" "$CADDY" \
		caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1) || {
		echo "$out" >&2
		exit 1
	}
done
rm -f "${TMPDIR:-/tmp}/rpg-check.env"

echo "==> grafana provisioning and dashboards"
python3 - grafana/dashboards/*.json <<'PY'
import json, sys
for path in sys.argv[1:]:
    d = json.load(open(path))
    assert d.get("uid") and d.get("panels"), f"{path}: a dashboard needs a uid and panels"
    uids = {p["datasource"]["uid"] for p in d["panels"] if p.get("datasource")}
    assert uids <= {"prometheus"}, f"{path}: unknown datasource uids {uids}"
    print(f"  {path}: {len(d['panels'])} panels")
PY
# Provisioning YAML: parsed with PyYAML when available (Grafana validates it at start too).
python3 - grafana/provisioning/*/*.yml <<'PY'
import sys
try:
    import yaml
except ImportError:
    sys.exit(0)
for path in sys.argv[1:]:
    yaml.safe_load(open(path))
    print(f"  {path}: ok")
PY
echo "monitoring: ok"
