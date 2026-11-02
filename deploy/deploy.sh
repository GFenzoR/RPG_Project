#!/usr/bin/env bash
# Rolls out a new version of the RPG Project stack on the server (docs/09-deployment-aws.md).
#
#   ./deploy.sh              pull IMAGE_TAG from .env and restart
#   ./deploy.sh v0.2.0       pin IMAGE_TAG=v0.2.0 in .env, pull and restart
#   ./deploy.sh --no-backup  skip the pre-deploy database dump
#   ./deploy.sh --no-pull    use local images (e.g. from `make docker-build`), for testing
#
# Steps: pull → (announce, TODO) → backup → restart gameserver (it applies pending
# migrations on start and only turns healthy afterwards) → restart caddy and backup →
# prune old images. Run it from anywhere; it works on deploy/ next to it.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
self="$PWD/$(basename "${BASH_SOURCE[0]}")"
COMPOSE=(docker compose -f docker-compose.yml --env-file .env)

log() { printf '\033[1m==> %s\033[0m\n' "$*"; }
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
		sed -n '2,11p' "$self"
		exit 0
		;;
	-*) die "unknown option $arg" ;;
	*) tag="$arg" ;;
	esac
done

[[ -f .env ]] || die "deploy/.env not found: copy .env.example and fill it in"

if [[ -n "$tag" ]]; then
	[[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "invalid image tag '$tag'"
	log "pinning IMAGE_TAG=$tag in .env"
	if grep -q '^IMAGE_TAG=' .env; then
		sed -i.bak "s/^IMAGE_TAG=.*/IMAGE_TAG=$tag/" .env && rm -f .env.bak
	else
		printf 'IMAGE_TAG=%s\n' "$tag" >>.env
	fi
fi

if ((pull)); then
	log "pulling images"
	"${COMPOSE[@]}" pull --quiet gameserver caddy backup postgres
fi

# TODO(admin-commands): announce the restart in game (e.g. 5 and 1 minute warnings) and
# ask the server to save every player before stopping, once the admin command exists.
# Until then the SIGTERM shutdown (stop_grace_period: 30s) is the only save point.

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

log "removing unused images"
docker image prune -f >/dev/null

"${COMPOSE[@]}" ps
log "deployed $(grep '^IMAGE_TAG=' .env | cut -d= -f2-)"
