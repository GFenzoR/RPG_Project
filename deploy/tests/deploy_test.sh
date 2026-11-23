#!/usr/bin/env bash
# deploy/deploy.sh against a stub docker and cosign (lote 16): every project image is
# pinned to its registry digest in .env, each digest's signature is checked with the
# repository's workflow identity, COSIGN_REQUIRED fails closed, and .env stays owner-only.
#
#   bash deploy/tests/deploy_test.sh     (make test-deploy)
# Stub bodies and grep patterns are single-quoted on purpose.
# shellcheck disable=SC2016
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/tests/lib.sh
source "$here/lib.sh"
script="$here/../deploy.sh"
HEX=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

setup() {
	t_begin "$1"
	mkdir -p "$T_DIR/deploy"
	cp "$script" "$T_DIR/deploy/deploy.sh"
	chmod +x "$T_DIR/deploy/deploy.sh"
	{
		echo "POSTGRES_PASSWORD=secret"
		echo "IMAGE_REGISTRY=ghcr.io/gfenzor"
		echo "IMAGE_TAG=v1.0.0"
		echo "GAMESERVER_IMAGE=ghcr.io/gfenzor/rpg-project-gameserver@sha256:$(printf 'f%.0s' {1..64})"
	} >"$T_DIR/deploy/.env"
	chmod 600 "$T_DIR/deploy/.env" 2>/dev/null || true
	# docker: `compose ... config --services` lists the services (FAKE_WORKER adds the map PR
	# worker); `image inspect` prints a foreign digest first, then the image's own one
	# (FAKE_NO_DIGEST: none); everything else succeeds.
	stub docker 'args=" $* "
case $args in
*" config --services "*) printf "%s\n" postgres gameserver caddy backup; [[ -z ${FAKE_WORKER:-} ]] || echo map-pr-worker ;;
*" pull "*) echo "PULL_ENV GAMESERVER_IMAGE=${GAMESERVER_IMAGE-unset} IMAGE_TAG=${IMAGE_TAG-unset}" >>"'"$T_LOG"'" ;;
*" image inspect "*)
	ref=${@: -1}; repo=${ref%:*}
	echo "docker.io/library/mirror@sha256:'"$HEX"'"
	[[ -n ${FAKE_NO_DIGEST:-} ]] || echo "$repo@sha256:'"$HEX"'" ;;
esac
exit 0'
	stub cosign '[[ -z ${FAKE_COSIGN_FAIL:-} ]] || [[ $* != *${FAKE_COSIGN_FAIL}* ]]'
}

# run_deploy [VAR=value...] -- [deploy.sh args...]: its exit status.
run_deploy() {
	local vars=()
	while (($#)) && [[ $1 != -- ]]; do
		vars+=("$1")
		shift
	done
	shift
	env PATH="$T_STUBS:$PATH" COSIGN="$T_STUBS/cosign" ${vars[@]+"${vars[@]}"} \
		"$T_DIR/deploy/deploy.sh" "$@" >"$T_DIR/out.log" 2>&1
}

envv() { sed -n "s/^$1=//p" "$T_DIR/deploy/.env"; }
# The identity deploy.sh trusts: this repository's images workflow on main or a vX.Y.Z tag.
ID='--certificate-identity-regexp ^https://github\.com/GFenzoR/RPG_Project/\.github/workflows/images\.yml@refs/(heads/main|tags/v'

# 1. A tag deploy: pins every image to its digest, verified, and runs them.
setup "pin and verify"
run_deploy -- v1.2.3 || fail "exit $?: $(cat "$T_DIR/out.log")"
[[ $(envv IMAGE_TAG) == v1.2.3 ]] || fail "IMAGE_TAG=$(envv IMAGE_TAG)"
for pair in gameserver:GAMESERVER_IMAGE web:WEB_IMAGE backup:BACKUP_IMAGE; do
	[[ $(envv "${pair#*:}") == "ghcr.io/gfenzor/rpg-project-${pair%%:*}@sha256:$HEX" ]] ||
		fail "${pair#*:}=$(envv "${pair#*:}")"
	grep -F -- "$ID" "$T_LOG" | grep -F -- "--certificate-oidc-issuer https://token.actions.githubusercontent.com ghcr.io/gfenzor/rpg-project-${pair%%:*}@sha256:$HEX" |
		grep -q '^cosign verify ' || fail "no signature check of ${pair%%:*}: $(grep cosign "$T_LOG")"
done
[[ $(grep -c '^GAMESERVER_IMAGE=' "$T_DIR/deploy/.env") == 1 ]] || fail "old pin kept"
[[ -z $(envv MAP_PR_WORKER_IMAGE) ]] || fail "worker pinned without its profile"
called '^docker compose .* pull --quiet gameserver caddy backup postgres$' || fail "pull: $(cat "$T_LOG")"
called '^docker compose .* up -d --wait --no-deps gameserver$' || fail "gameserver not restarted"
# The pull happens before the pins are written, by tag: the old pin is emptied for it.
called '^PULL_ENV GAMESERVER_IMAGE= IMAGE_TAG=v1.2.3$' || fail "pulled with the old pin: $(grep PULL_ENV "$T_LOG")"
[[ $(grep -n 'pull --quiet' "$T_LOG" | cut -d: -f1) -lt $(grep -n '^cosign' "$T_LOG" | head -n1 | cut -d: -f1) ]] ||
	fail "verified before pulling"
if perms_supported; then
	[[ $(mode_of "$T_DIR/deploy/.env") == 600 ]] || fail ".env mode $(mode_of "$T_DIR/deploy/.env")"
fi
t_end

# 2. The map PR worker's image is pinned too when its profile is on.
setup "worker"
run_deploy FAKE_WORKER=1 -- || fail "exit $?: $(cat "$T_DIR/out.log")"
[[ $(envv MAP_PR_WORKER_IMAGE) == "ghcr.io/gfenzor/rpg-project-map-pr-worker@sha256:$HEX" ]] || fail "worker pin"
called '^docker compose .* up -d --no-deps map-pr-worker$' || fail "worker not restarted"
t_end

# 3. A bad signature stops the deploy before anything restarts and leaves the previous
# deploy's pins (none of the new ones, not even the verified gameserver), with the refused
# tag dropped locally: a later `compose up` runs what was verified last time.
setup "bad signature"
old_pin=$(envv GAMESERVER_IMAGE)
if run_deploy FAKE_COSIGN_FAIL=rpg-project-web -- v9.9.9; then fail "deployed an unverified image"; fi
called ' up ' && fail "restarted something: $(grep ' up ' "$T_LOG")"
grep -q 'signature check failed' "$T_DIR/out.log" || fail "message: $(cat "$T_DIR/out.log")"
[[ -z $(envv WEB_IMAGE) ]] || fail "pinned the unverified web image"
[[ $(envv GAMESERVER_IMAGE) == "$old_pin" ]] || fail "previous pin lost: GAMESERVER_IMAGE=$(envv GAMESERVER_IMAGE)"
called '^docker image rm ghcr.io/gfenzor/rpg-project-web:v9.9.9$' || fail "refused tag kept: $(grep 'image rm' "$T_LOG")"
t_end

# 4. COSIGN_REQUIRED=1 without cosign fails closed; without it, a warning only.
setup "cosign missing"
if run_deploy COSIGN=/nonexistent/cosign COSIGN_REQUIRED=1 --; then fail "deployed without cosign"; fi
called ' up ' && fail "restarted something"
grep -q 'COSIGN_REQUIRED=1 but cosign is not installed' "$T_DIR/out.log" || fail "message: $(cat "$T_DIR/out.log")"
run_deploy COSIGN=/nonexistent/cosign -- || fail "exit $? without COSIGN_REQUIRED"
grep -q 'signatures are NOT verified' "$T_DIR/out.log" || fail "no warning"
[[ $(envv GAMESERVER_IMAGE) == *"@sha256:$HEX" ]] || fail "not pinned"
t_end

# 5. An image without a registry digest is refused.
setup "no digest"
old_pin=$(envv GAMESERVER_IMAGE)
if run_deploy FAKE_NO_DIGEST=1 --; then fail "deployed an image without a digest"; fi
called ' up ' && fail "restarted something"
[[ $(envv GAMESERVER_IMAGE) == "$old_pin" ]] || fail "previous pin lost"
t_end

# 6. --no-pull (local images): the old pins go and none are written.
setup "no pull"
run_deploy -- --no-pull --no-backup || fail "exit $?: $(cat "$T_DIR/out.log")"
[[ -z $(envv GAMESERVER_IMAGE) ]] || fail "stale pin kept: $(envv GAMESERVER_IMAGE)"
called 'pull' && fail "pulled"
t_end

# 7. A world-readable .env is made private, with a warning.
setup "env mode"
if perms_supported; then
	chmod 644 "$T_DIR/deploy/.env"
	run_deploy -- --no-pull --no-backup || fail "exit $?"
	[[ $(mode_of "$T_DIR/deploy/.env") == 600 ]] || fail ".env mode $(mode_of "$T_DIR/deploy/.env")"
	grep -q 'was readable by other users (mode 644): now 600' "$T_DIR/out.log" || fail "no warning: $(cat "$T_DIR/out.log")"
fi
t_end

# 8. COSIGN_REQUIRED=1 written in .env (as docs/09 says) fails closed too.
setup "cosign required in .env"
echo "COSIGN_REQUIRED=1" >>"$T_DIR/deploy/.env"
if run_deploy COSIGN=/nonexistent/cosign --; then fail "deployed without cosign"; fi
called ' up ' && fail "restarted something"
grep -q 'COSIGN_REQUIRED=1 but cosign is not installed' "$T_DIR/out.log" || fail "message: $(cat "$T_DIR/out.log")"
t_end

# 9. The identity to check can come from .env as well (forks).
setup "identity in .env"
echo 'COSIGN_IDENTITY_REGEXP=^https://github\.com/fork/' >>"$T_DIR/deploy/.env"
run_deploy -- || fail "exit $?: $(cat "$T_DIR/out.log")"
grep -F -- '--certificate-identity-regexp ^https://github\.com/fork/ ' "$T_LOG" | grep -q '^cosign verify ' ||
	fail "identity: $(grep cosign "$T_LOG")"
t_end

# 10. IMAGE_TAG exported in the shell wins, as it does for compose: the pull and the pins
# use the same tag. A quoted value in .env is read without its quotes.
setup "tag from the shell"
sed -i.bak 's/^IMAGE_TAG=.*/IMAGE_TAG="v1.0.0"/' "$T_DIR/deploy/.env" && rm -f "$T_DIR/deploy/.env.bak"
run_deploy IMAGE_TAG=v2.0.0 -- || fail "exit $?: $(cat "$T_DIR/out.log")"
called '^docker image inspect .* ghcr.io/gfenzor/rpg-project-gameserver:v2\.0\.0$' || fail "inspected: $(grep inspect "$T_LOG")"
called '^PULL_ENV .* IMAGE_TAG=v2\.0\.0$' || fail "pulled: $(grep PULL_ENV "$T_LOG")"
: >"$T_LOG"
run_deploy -- || fail "exit $?: $(cat "$T_DIR/out.log")"
called '^docker image inspect .* ghcr.io/gfenzor/rpg-project-gameserver:v1\.0\.0$' || fail "quoted tag: $(grep inspect "$T_LOG")"
t_end

t_summary "deploy_test"
