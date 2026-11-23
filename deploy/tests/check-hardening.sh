#!/usr/bin/env bash
# Static hardening checks of deploy/ (lote 16, docs/09 "Seguridad del despliegue"): the
# compose stacks (through `docker compose config`, no daemon needed), the security headers
# of Caddy, and the switches of the backup and deploy scripts and the image signing. Each
# check is the regression test of one finding of the lote 16 audit.
#
#   deploy/tests/check-hardening.sh      (make lint-deploy)
# Stub bodies and grep patterns are single-quoted on purpose.
# shellcheck disable=SC2016
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
fail=0
err() {
	echo "check-hardening: $*" >&2
	fail=1
}
# has FILE REGEX WHY: FILE matches the extended REGEX.
has() { grep -Eq -- "$2" "$1" || err "$1: $3"; }
# hasnt FILE REGEX WHY: FILE does not match.
hasnt() { ! grep -Eq -- "$2" "$1" || err "$1: $3"; }

# ---- compose ------------------------------------------------------------------------------
if docker compose version >/dev/null 2>&1; then
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT
	printf 'POSTGRES_PASSWORD=x\nSITE_ADDRESS=example.com\nACME_EMAIL=ops@example.com\n' >"$tmp/prod.env"
	sed 's/__RANDOM__/x/' deploy/env.home.template >"$tmp/home.env"
	docker compose -f deploy/docker-compose.yml --env-file "$tmp/prod.env" \
		--profile monitoring --profile map-pr config --format json >"$tmp/prod.json"
	docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.home.yml --env-file "$tmp/home.env" \
		--profile quick-tunnel --profile tunnel --profile monitoring --profile mail config --format json >"$tmp/home.json"
	node deploy/tests/check-compose.mjs production "$tmp/prod.json" home "$tmp/home.json" || fail=1
else
	echo "check-hardening: docker compose not found, compose checks skipped (CI runs them)"
fi
# Immutable images: deploy.sh pins digests in .env and compose prefers them over the tag.
for v in GAMESERVER_IMAGE WEB_IMAGE BACKUP_IMAGE MAP_PR_WORKER_IMAGE; do
	has deploy/docker-compose.yml "image: \\$\\{$v:-" "the image does not prefer \$$v (deploy.sh digest pin)"
done

# ---- Caddy --------------------------------------------------------------------------------
R=deploy/caddy-routes.caddy
has $R "Content-Security-Policy \"default-src 'self'; script-src 'self';" "no CSP (or a script-src beyond 'self')"
has $R "frame-ancestors 'none'" "CSP without frame-ancestors 'none'"
has $R "object-src 'none'" "CSP without object-src 'none'"
has $R "base-uri 'none'" "CSP without base-uri 'none'"
hasnt $R "unsafe-eval|script-src[^;]*unsafe-inline" "CSP allows eval or inline scripts"
has $R 'Permissions-Policy "camera=\(\), microphone=\(\), geolocation=\(\)' "no Permissions-Policy"
has $R 'Cross-Origin-Opener-Policy "same-origin"' "no Cross-Origin-Opener-Policy"
has $R '^@pages not path /api/\* /ws /ws/\* /healthz' "the page headers must not cover /api, /ws, /healthz"
has deploy/Caddyfile 'Strict-Transport-Security "max-age=31536000' "no HSTS"
has deploy/Caddyfile.home 'Strict-Transport-Security "max-age=31536000' "no HSTS behind the tunnel"
has deploy/smoke.sh 'content-security-policy' "the smoke test does not check the CSP"

# ---- backups ------------------------------------------------------------------------------
has deploy/backup.sh '^umask 077$' "dumps are not private (umask 077)"
has deploy/backup.sh 'aws s3 cp --only-show-errors "\$\{sse\[@\]\}"' "S3 upload without server-side encryption"
has deploy/backup.sh 'BACKUP_ENCRYPT_REQUIRED' "no BACKUP_ENCRYPT_REQUIRED"
has deploy/Dockerfile.backup 'apk add --no-cache .*\bage\b' "the backup image has no age"
has deploy/docker-compose.yml 'BACKUP_AGE_RECIPIENT: \$\{BACKUP_AGE_RECIPIENT' "BACKUP_AGE_RECIPIENT not passed to the backup service"

# ---- deploy and image signing ---------------------------------------------------------------
has deploy/deploy.sh '"\$COSIGN" verify --certificate-identity-regexp' "deploy.sh does not verify signatures"
has deploy/deploy.sh 'COSIGN_REQUIRED' "deploy.sh has no COSIGN_REQUIRED"
has deploy/deploy.sh 'chmod 600 \.env' "deploy.sh does not keep .env private"
has .github/workflows/images.yml 'id-token: write' "the image job cannot sign (id-token: write)"
has .github/workflows/images.yml 'cosign sign --yes "\$IMAGE@\$DIGEST"' "images are not signed by digest"

((fail == 0)) || exit 1
echo "check-hardening: ok"
