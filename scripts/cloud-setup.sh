#!/bin/bash
# Setup script del entorno cloud de Claude Code (se pega en la configuración del entorno
# en claude.ai/code). Corre como root antes de que arranque Claude y su resultado queda
# en caché. Debe terminar en menos de ~5 minutos y salir con código 0.
#
# Go, Node 22, pnpm, PostgreSQL 16, Docker y Rust ya vienen preinstalados.
# Aquí solo agregamos lo que falta.

export GOBIN=/usr/local/bin
export GOFLAGS=-mod=mod

log() { echo "[cloud-setup] $*"; }

# Herramientas Go (en paralelo para no pasar el límite de tiempo)
( go install github.com/bufbuild/buf/cmd/buf@latest && log "buf ok" ) || log "buf FALLÓ" &
( go install github.com/pressly/goose/v3/cmd/goose@latest && log "goose ok" ) || log "goose FALLÓ" &
( go install honnef.co/go/tools/cmd/staticcheck@latest && log "staticcheck ok" ) || log "staticcheck FALLÓ" &
( CGO_ENABLED=1 go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest && log "sqlc ok" ) || log "sqlc FALLÓ" &
( curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/HEAD/install.sh \
    | sh -s -- -b /usr/local/bin && log "golangci-lint ok" ) || log "golangci-lint FALLÓ" &

# Chromium para Playwright (requiere los dominios de Playwright en el allowlist del entorno).
# Si la versión del proyecto difiere, scripts/session-start.sh instala la correcta.
( npx -y playwright@latest install --with-deps chromium && log "playwright chromium ok" ) \
  || log "playwright FALLÓ (revisa los dominios permitidos del entorno)" &

wait

# Base de datos de desarrollo (el servicio no queda corriendo en la caché;
# session-start.sh lo arranca en cada sesión)
service postgresql start || true
su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\"" || true
su postgres -c "createdb rpg" || true
su postgres -c "createdb rpg_test" || true
service postgresql stop || true

log "listo"
exit 0
