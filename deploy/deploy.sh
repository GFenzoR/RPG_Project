#!/usr/bin/env bash
# Rolls out a new version of Neque's Realm stack on the server (docs/09-deployment-aws.md).
#
#   ./deploy.sh              pull IMAGE_TAG from .env and restart
#   ./deploy.sh v0.2.0       pin IMAGE_TAG=v0.2.0 in .env, pull and restart
#   ./deploy.sh --no-backup  skip the pre-deploy database dump
#   ./deploy.sh --no-pull    use local images (e.g. from `make docker-build`), for testing
#
# Steps: pull → pin each image to its digest and verify its signature → (announce, TODO) →
# backup → restart gameserver (it applies pending migrations on start and only turns
# healthy afterwards) → restart caddy and backup → prune old images. Run it from anywhere;
# it works on deploy/ next to it.
#
# Images (lote 16): a tag can be moved, a digest cannot. After the pull every image of the
# project is resolved to repo@sha256:… and written to .env (GAMESERVER_IMAGE, WEB_IMAGE,
# BACKUP_IMAGE, MAP_PR_WORKER_IMAGE), which docker-compose.yml prefers over the tag, so the
# containers run exactly what was verified. With cosign installed each digest must carry the
# keyless signature of this repository's images workflow (.github/workflows/images.yml);
# COSIGN_REQUIRED=1 refuses to deploy without cosign. COSIGN_IDENTITY_REGEXP and
# COSIGN_OIDC_ISSUER override the identity checked (forks).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
self="$PWD/$(basename "${BASH_SOURCE[0]}")"
COMPOSE=(docker compose -f docker-compose.yml --env-file .env)
COSIGN_IDENTITY_REGEXP="${COSIGN_IDENTITY_REGEXP:-^https://github\.com/GFenzoR/RPG_Project/\.github/workflows/images\.yml@refs/(heads/main|tags/v[0-9]+\.[0-9]+\.[0-9]+)$}"
COSIGN_OIDC_ISSUER="${COSIGN_OIDC_ISSUER:-https://token.actions.githubusercontent.com}"
COSIGN="${COSIGN:-cosign}" # the cosign binary (deploy/tests stub it)
# Service → image name suffix (rpg-project-<suffix>) → the .env variable that pins it.
PINNED=(gameserver:gameserver:GAMESERVER_IMAGE caddy:web:WEB_IMAGE backup:backup:BACKUP_IMAGE
	map-pr-worker:map-pr-worker:MAP_PR_WORKER_IMAGE)

log() { printf '\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf 'deploy: WARNING: %s\n' "$*" >&2; }
die() {
	printf 'deploy: %s\n' "$*" >&2
	exit 1
}

backup=1
pull=1
tag=""
for arg in "$@"; do
	case "$arg" in
	--no-backup) backup=0 ;;
	--no-pull) pull=0 ;;
	-h | --help)
		sed -n '2,20p' "$self"
		exit 0
		;;
	-*) die "unknown option $arg" ;;
	*) tag="$arg" ;;
	esac
done

[[ -f .env ]] || die "deploy/.env not found: copy .env.example and fill it in"

# file_mode FILE: octal permission bits (GNU and BSD stat).
file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# .env holds every secret of the stack: owner only (lote 16). Fixed when it is not; a
# filesystem that cannot (e.g. a Windows checkout) only gets the warning.
protect_env() {
	local mode
	mode=$(file_mode .env) || return 0
	if ((8#$mode & 8#077)); then
		chmod 600 .env 2>/dev/null || true
		local now
		now=$(file_mode .env)
		if ((8#$now & 8#077)); then
			warn "deploy/.env is readable by other users (mode $mode) and chmod 600 did not take; protect it by hand"
		else
			warn "deploy/.env was readable by other users (mode $mode): now 600. If other people use this host, rotate its secrets (docs/09)"
		fi
	fi
}

# env_get KEY: the value of KEY in .env (empty if unset).
env_get() { sed -n "s/^$1=//p" .env | tail -n 1; }

# env_set KEY VALUE: replace or append KEY=VALUE in .env, keeping it private.
env_set() {
	if grep -q "^$1=" .env; then
		sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak
	else
		printf '%s=%s\n' "$1" "$2" >>.env
	fi
	chmod 600 .env 2>/dev/null || true
}

# env_unset KEY: drop KEY from .env.
env_unset() {
	if grep -q "^$1=" .env; then
		sed -i.bak "/^$1=/d" .env && rm -f .env.bak
		chmod 600 .env 2>/dev/null || true
	fi
}

protect_env

if [[ -n "$tag" ]]; then
	[[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "invalid image tag '$tag'"
	log "pinning IMAGE_TAG=$tag in .env"
	env_set IMAGE_TAG "$tag"
fi

# The digests of the previous deploy go: this run pulls the tag again and pins what it gets.
for entry in "${PINNED[@]}"; do
	env_unset "${entry##*:}"
done

registry=$(env_get IMAGE_REGISTRY)
registry=${registry:-ghcr.io/gfenzor}
image_tag=$(env_get IMAGE_TAG)
image_tag=${image_tag:-latest}

services=(gameserver caddy backup)
# The map PR worker (T4.5) only runs with the map-pr profile (COMPOSE_PROFILES in .env).
worker=0
if "${COMPOSE[@]}" config --services | grep -qx map-pr-worker; then
	worker=1
	services+=(map-pr-worker)
fi

# pin_digests: resolve each pulled image to repo@sha256:…, verify it, write the pins.
pin_digests() {
	local entry service suffix var repo ref digest
	local verify=1
	if ! command -v "$COSIGN" >/dev/null 2>&1; then
		verify=0
		[[ ${COSIGN_REQUIRED:-0} == 1 ]] && die "COSIGN_REQUIRED=1 but cosign is not installed (docs/09, \"Imágenes firmadas\")"
		warn "cosign is not installed: image signatures are NOT verified (install it, docs/09)"
	fi
	for entry in "${PINNED[@]}"; do
		IFS=: read -r service suffix var <<<"$entry"
		[[ " ${services[*]} " == *" $service "* ]] || continue
		repo="$registry/rpg-project-$suffix"
		ref="$repo:$image_tag"
		digest=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ref" |
			grep -m1 "^$repo@sha256:[0-9a-f]\{64\}$") ||
			die "no registry digest for $ref (was it pulled from $registry?)"
		if ((verify)); then
			log "verifying the signature of $digest"
			"$COSIGN" verify --certificate-identity-regexp "$COSIGN_IDENTITY_REGEXP" \
				--certificate-oidc-issuer "$COSIGN_OIDC_ISSUER" "$digest" >/dev/null ||
				die "signature check failed for $digest: not built by $COSIGN_IDENTITY_REGEXP. Not deployed"
		fi
		env_set "$var" "$digest"
		log "$service runs $digest"
	done
}

if ((pull)); then
	log "pulling images"
	"${COMPOSE[@]}" pull --quiet "${services[@]}" postgres
	pin_digests
fi

# TODO(admin-commands): announce the restart in game (e.g. 5 and 1 minute warnings) and
# ask the server to save every player before stopping, once the admin command exists.
# Until then the SIGTERM shutdown (stop_grace_period: 90s) is the only save point.

"${COMPOSE[@]}" up -d --wait postgres
if ((backup)); then
	log "pre-deploy backup"
	"${COMPOSE[@]}" run --rm --no-deps backup --once
fi

# Migrations: the gameserver applies pending ones on start (-migrate, embedded in the
# binary) and `--wait` blocks until its healthcheck passes, i.e. after migrating.
log "restarting gameserver (applies pending migrations)"
"${COMPOSE[@]}" up -d --wait --no-deps gameserver

log "restarting caddy and backup"
"${COMPOSE[@]}" up -d --wait caddy backup

# Restart the map PR worker after the gameserver, so it never works on a schema older than
# the server's.
if ((worker)); then
	log "restarting the map PR worker"
	"${COMPOSE[@]}" up -d --no-deps map-pr-worker
fi

log "removing unused images"
docker image prune -f >/dev/null

"${COMPOSE[@]}" ps
log "deployed $image_tag"
