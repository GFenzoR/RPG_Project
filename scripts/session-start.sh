#!/bin/bash
# Hook SessionStart (configurado en .claude/settings.json).
# Solo actúa en sesiones cloud; en tu máquina local sale de inmediato.

if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR" || exit 0

# 1. Postgres (no queda corriendo entre sesiones)
service postgresql start >/dev/null 2>&1 || true

# 2. Dependencias JS, solo si cambió el lockfile
if [ -f pnpm-lock.yaml ]; then
  stamp=node_modules/.session-start.sha256
  if ! sha256sum --check --status "$stamp" 2>/dev/null; then
    rm -f "$stamp"
    if pnpm install --frozen-lockfile >/dev/null 2>&1; then
      sha256sum pnpm-lock.yaml scripts/session-start.sh > "$stamp" || rm -f "$stamp"
    else
      echo "[session-start] pnpm install falló; corre 'pnpm install' para ver el error"
    fi
  fi
  # Chromium de la versión exacta de Playwright del proyecto (rápido si ya está)
  if [ -d node_modules/@playwright/test ]; then
    pnpm exec playwright install chromium >/dev/null 2>&1 \
      || echo "[session-start] no se pudo instalar Chromium de Playwright"
  fi
fi

# 3. Módulos Go
if [ -f server/go.mod ]; then
  (cd server && go mod download >/dev/null 2>&1) || true
fi

echo "[session-start] entorno listo (postgres arriba, dependencias al día)"
exit 0
