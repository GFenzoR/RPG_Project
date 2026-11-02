# 12 — Desarrollo local (después del 5 de noviembre)

Desde el 5 de noviembre el trabajo sigue con Claude Code en tu computador. El repo, los
docs, las skills y el roadmap son los mismos; cambia el entorno y que ahora puedes probar
el juego tú mismo mientras Claude trabaja.

## Sistema recomendado
| Tu equipo | Recomendación |
|---|---|
| Windows | **WSL2 con Ubuntu 24.04** y el repo dentro de WSL (`~/rpg-project`, no en `C:\`). Así los scripts, el Makefile y las rutas son idénticos a los de las sesiones cloud. Docker Desktop con integración WSL activada. |
| macOS | Nativo, con Homebrew. Docker Desktop u OrbStack. |
| Linux | Nativo. |

## Instalar una vez
1. Git, Go (la versión de `server/go.mod`), Node 22 y pnpm (`corepack enable`).
2. Docker (para Postgres en local; no hace falta instalar Postgres a mano).
3. Claude Code (CLI o app de escritorio) con tu cuenta.
4. Clona el repo y corre:
   ```
   make setup        # instala buf, sqlc, goose, golangci-lint, dependencias y Chromium de Playwright
   make db-up        # levanta Postgres en Docker en el puerto 5432
   make dev          # servidor + cliente + editor
   ```
   `make setup` usa `scripts/local-setup.sh`, que crea la tarea T0.1.

## Servidor de juego solo
El servidor carga el mapa compilado (`build/world.bin`), no el JSON de `world/`:
```
make run-server   # make mapcompile + gameserver con RPG_WORLD=<repo>/build/world.bin
```
A mano: `make mapcompile` y luego `RPG_WORLD=$PWD/build/world.bin go run ./cmd/gameserver`
desde `server/` (o `-world <ruta>`). Vuelve a compilar el mapa cada vez que cambie
`world/` o `data/items/`. `make test-parity` compara la caminabilidad que calcula
`mapcompile` con la de `packages/map-format` (necesita `pnpm install`).

## Diferencias con las sesiones cloud
| | Cloud (hasta 4 nov) | Local (desde 5 nov) |
|---|---|---|
| Postgres | Servicio del VM (`service postgresql start`) | Contenedor Docker (`make db-up`) |
| Hook de inicio | Instala dependencias | Sale de inmediato (no hace nada) |
| Paralelismo | Varias sesiones a la vez | Una o dos a la vez; usa `git worktree` para dos sesiones en ramas distintas |
| Pruebas visuales | Solo screenshots | Screenshots + tú jugando en `http://localhost:5173` |
| Costo | Crédito cloud | Límites de tu plan de Claude |

## Ritmo sugerido en local
- Sigue usando una tarea del roadmap por sesión y la skill `/roadmap-task T1.x`.
- Aprovecha que puedes jugar: después de cada PR jugable, prueba 5 minutos y anota en
  un issue lo que se siente mal (ritmo, balance, controles). Eso es lo que la IA no
  puede juzgar sola.
- Para dos tareas en paralelo sin choques:
  ```
  git worktree add ../rpg-t1-9 -b t1-9
  git worktree add ../rpg-t1-10 -b t1-10
  ```
  y abre una sesión de Claude Code en cada carpeta.
