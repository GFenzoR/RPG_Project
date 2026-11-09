#!/usr/bin/env bash
# Home stack helper (docs/13-hosting-de-pruebas.md): the logic behind `make home-*`, so the
# same steps work on Linux, macOS and Windows (WSL2) without anything but Docker, make,
# git and bash. Run from anywhere; it works on the repo it lives in.
#
#   deploy/home.sh env                      create/complete deploy/.env.home
#   deploy/home.sh up [--monitoring]        build, start, wait until healthy, print the URLs
#   deploy/home.sh admin EMAIL [ROLE]       give an account the gm or admin role
#   deploy/home.sh reset-password EMAIL     print a one-use password reset link (no SMTP)
#   deploy/home.sh backup                   pg_dump into deploy/backups/
#   deploy/home.sh restore FILE             replace the database with a backup
#   deploy/home.sh reset                    delete every volume of the home stack
#   deploy/home.sh compose ARGS...          docker compose on the home stack
#
# Arrays are expanded as ${a[@]+"${a[@]}"}: macOS ships bash 3.2, where an empty "${a[@]}"
# is an unbound variable under set -u.
#
# Environment: BUILD=0 starts the images already built (no `--build`); CONFIRM=yes skips
# the questions of restore and reset (CI, scripts).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ENV_FILE=deploy/.env.home
TEMPLATE=deploy/env.home.template
BACKUP_DIR=deploy/backups
# Every optional profile: with --profile flags compose ignores COMPOSE_PROFILES, so down,
# stop and logs must name them all or a worker or tunnel would be left running.
ALL_PROFILES=(--profile quick-tunnel --profile tunnel --profile monitoring --profile map-pr --profile mail)

say() { printf '[home] %s\n' "$*"; }
die() {
	printf '[home] error: %s\n' "$*" >&2
	exit 1
}

compose() {
	docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.home.yml \
		--env-file "$ENV_FILE" "$@"
}

# Value of KEY in deploy/.env.home (empty when unset or commented out).
env_get() {
	[[ -f $ENV_FILE ]] || return 0
	sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r'
}

random_secret() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }

# create_or_complete_env: deploy/.env.home from the template the first time; afterwards
# only the active keys of the template that the file lacks are appended (a new release can
# add one), each __RANDOM__ with a fresh secret. Existing values are never changed.
ensure_env() {
	[[ -f $TEMPLATE ]] || die "$TEMPLATE is missing: is this a full checkout?"
	if [[ ! -f $ENV_FILE ]]; then
		local line out=""
		while IFS= read -r line || [[ -n $line ]]; do
			while [[ $line == *__RANDOM__* ]]; do
				line=${line/__RANDOM__/$(random_secret)}
			done
			out+="$line"$'\n'
		done <"$TEMPLATE"
		(umask 077 && printf '%s' "$out" >"$ENV_FILE")
		say "created $ENV_FILE with new random passwords (keep it private; git ignores it)"
		return
	fi
	local key value added=()
	while IFS='=' read -r key value; do
		[[ $key =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
		grep -qE "^$key=.+" "$ENV_FILE" && continue
		[[ $value == __RANDOM__ ]] && value=$(random_secret)
		# An empty "KEY=" line would win over the appended one only if it came later.
		# umask 077: the rewrite must stay as private as the file it replaces.
		(
			umask 077
			grep -vE "^$key=$" "$ENV_FILE" >"$ENV_FILE.tmp" || true
			printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE.tmp"
		)
		mv "$ENV_FILE.tmp" "$ENV_FILE"
		added+=("$key")
	done < <(grep -E '^[A-Z][A-Z0-9_]*=' "$TEMPLATE")
	if ((${#added[@]})); then
		say "added to $ENV_FILE: ${added[*]}"
	fi
	# Files made by the old `cp .env.home.example` flow were world-readable.
	chmod 600 "$ENV_FILE"
}

# Problems a non-developer hits before Docker says anything useful.
preflight() {
	command -v docker >/dev/null 2>&1 ||
		die "docker not found. Install Docker Desktop (Windows/macOS) or Docker Engine (Linux): docs/13, step 1"
	local info
	if ! info=$(docker info 2>&1); then
		case $info in
		*"permission denied"*)
			die "this user may not use Docker. Run: sudo usermod -aG docker \$USER, then log out and back in (docs/13, step 1)" ;;
		*) die "Docker is not running. Open Docker Desktop (or: sudo systemctl start docker) and try again" ;;
		esac
	fi
	local v
	v=$(docker compose version --short 2>/dev/null | sed 's/^v//') ||
		die "docker compose (v2) not found: update Docker Desktop or install docker-compose-plugin"
	local major=${v%%.*} rest=${v#*.}
	local minor=${rest%%.*}
	if ((major < 2 || (major == 2 && minor < 24))); then
		die "docker compose $v is too old (2.24 or newer needed): update Docker"
	fi
	case $PWD in
	/mnt/[a-z] | /mnt/[a-z]/*)
		say "warning: the repo is on a Windows drive ($PWD). It works, but builds are much"
		say "  slower and files can get Windows line endings. Clone it inside WSL instead:"
		say "  cd ~ && git clone https://github.com/GFenzoR/RPG_Project.git (docs/13, step 1)"
		;;
	esac
}

port() {
	local p
	p=$(env_get HOME_HTTP_PORT)
	echo "${p:-8080}"
}

running() { [[ -n $(compose "${ALL_PROFILES[@]}" ps -q --status running "$1" 2>/dev/null) ]]; }

banner() {
	local p base
	p=$(port)
	base="http://localhost:$p"
	cat <<MSG

  RPG Project is running on this PC.

    Website  $base/
    Game     $base/play/
MSG
	if running grafana; then
		echo "    Grafana  http://localhost:$(env_get GRAFANA_PORT | grep . || echo 3000)/grafana/  (user admin, GRAFANA_ADMIN_PASSWORD in $ENV_FILE)"
	fi
	if [[ $(env_get HOME_BIND) == 0.0.0.0 ]]; then
		echo "    LAN      http://<this PC's IP>:$p/  (HOME_BIND=0.0.0.0)"
	fi
	cat <<MSG

  Next steps:
    make home-tunnel              public https link to share with friends
    make home-admin EMAIL=you@…   give your account the admin role (register first)
    make home-backup              save the database to $BACKUP_DIR/
    make home-monitoring-up       Prometheus + Grafana
    make home-logs                follow the logs
    make home-down                stop everything (your data is kept)

MSG
}

cmd_up() {
	local profile=()
	[[ ${1:-} == --monitoring ]] && profile=(--profile monitoring)
	preflight
	ensure_env
	local build=(--build)
	[[ ${BUILD:-1} == 0 ]] && build=()
	say "building and starting (the first time takes several minutes)..."
	if ! VERSION=${VERSION:-dev} COMMIT=${COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)} \
		compose ${profile[@]+"${profile[@]}"} up -d ${build[@]+"${build[@]}"} --wait --wait-timeout 600; then
		compose "${ALL_PROFILES[@]}" ps -a || true
		say "start failed. 'port is already allocated': change HOME_HTTP_PORT (or GRAFANA_PORT) in $ENV_FILE."
		say "Otherwise see 'make home-logs' and docs/13, 'Problemas comunes'."
		exit 1
	fi
	banner
}

# One-use password reset link (T2.1) for when the server has no SMTP: the operator gives
# it to the owner of the account by a channel they trust. PUBLIC_URL comes from the
# gameserver's environment (deploy/.env.home or http://localhost:8080).
cmd_reset_password() {
	local email=${1:-}
	[[ -n $email ]] || die "usage: make home-reset-password EMAIL=you@example.com"
	running gameserver || die "the game is not running: make home-up first"
	compose exec -T gameserver /app/gameserver admin reset-link -email "$email"
}

cmd_admin() {
	local email=${1:-} role=${2:-admin}
	[[ -n $email ]] || die "usage: make home-admin EMAIL=you@example.com [ROLE=admin|gm|player]"
	case $role in admin | gm | player) ;; *) die "ROLE must be admin, gm or player" ;; esac
	running gameserver || die "the game is not running: make home-up first"
	compose exec -T gameserver /app/gameserver admin set-role -email "$email" -role "$role" \
		-note "${NOTE:-make home-admin}"
}

cmd_backup() {
	running postgres || die "the database is not running: make home-up first"
	mkdir -p "$BACKUP_DIR"
	local f
	f="$BACKUP_DIR/home-$(date +%Y%m%d-%H%M%S)${1:+-$1}.dump"
	# shellcheck disable=SC2016 # expanded by the shell inside the postgres container
	compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$f.part"
	mv "$f.part" "$f"
	LAST_BACKUP=$f
	say "wrote $f (restore it with: make home-restore FILE=$f)"
}

confirm() { # confirm WORD MESSAGE
	[[ ${CONFIRM:-} == yes ]] && return 0
	[[ -t 0 ]] || die "$2 Re-run with CONFIRM=yes to do it without asking."
	local answer
	printf '%s\nType %s to continue: ' "$2" "$1"
	read -r answer
	[[ $answer == "$1" ]] || die "cancelled"
}

cmd_restore() {
	local file=${1:-}
	[[ -n $file ]] || die "usage: make home-restore FILE=$BACKUP_DIR/home-<date>.dump"
	[[ -s $file ]] || die "$file does not exist or is empty"
	ensure_env
	confirm restore "This REPLACES the whole game database with $file."
	compose up -d --wait postgres
	# Check the archive before touching anything: a truncated file or a leftover .part
	# must not leave an empty database behind.
	compose exec -T postgres pg_restore -l <"$file" >/dev/null ||
		die "$file is not a pg_dump custom archive (make home-backup writes one); nothing was changed"
	# Stop the writers first, so the safety dump includes their last save on shutdown.
	compose "${ALL_PROFILES[@]}" stop gameserver map-pr-worker
	cmd_backup before-restore
	local safety=$LAST_BACKUP
	failed() { die "restore failed; your previous data is in $safety: make home-restore FILE=$safety"; }
	# Drop and recreate instead of pg_restore --clean: tables added by newer migrations
	# would survive --clean and clash with the restored goose version.
	# shellcheck disable=SC2016 # expanded by the shell inside the postgres container
	compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --if-exists --force "$POSTGRES_DB" &&
		createdb -U "$POSTGRES_USER" "$POSTGRES_DB"' || failed
	# shellcheck disable=SC2016 # expanded by the shell inside the postgres container
	compose exec -T postgres sh -c 'pg_restore --no-owner --exit-on-error -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <"$file" || failed
	say "restored $file; starting the game (it applies newer migrations on start)..."
	BUILD=0 cmd_up
}

cmd_reset() {
	confirm borrar "This DELETES every account, character and map submission of the home server (and the Grafana data). Backups in $BACKUP_DIR/ and $ENV_FILE are kept."
	compose "${ALL_PROFILES[@]}" down -v --remove-orphans
	say "all data deleted. 'make home-up' starts a fresh server."
}

main() {
	local cmd=${1:-}
	shift || true
	case $cmd in
	env) ensure_env ;;
	up) cmd_up "$@" ;;
	admin) cmd_admin "$@" ;;
	reset-password) cmd_reset_password "$@" ;;
	backup) cmd_backup ;;
	restore) cmd_restore "$@" ;;
	reset) cmd_reset ;;
	compose)
		ensure_env
		compose "$@"
		;;
	*) die "usage: deploy/home.sh env|up [--monitoring]|admin EMAIL [ROLE]|backup|restore FILE|reset|compose ARGS..." ;;
	esac
}

main "$@"
