# RPG Project (nombre provisional)

MMORPG 2D de vista cenital inspirado en las mecánicas de los MMORPG clásicos de casillas:
mundo abierto de islas, skills que suben con el uso, grinding y quests por nivel.
Se juega en el navegador o instalado en PC, y la comunidad puede crear mapas con un
editor web que también puede usar una IA.

> Estado: preproducción. Existe el esqueleto del monorepo (T0.1); el código se construye
> siguiendo `docs/10-roadmap.md`.

## Empieza aquí
- Visión y decisiones: [`docs/00-vision.md`](docs/00-vision.md)
- Cómo trabajar con Claude Code: [`docs/11-claude-code-workflow.md`](docs/11-claude-code-workflow.md)
- Roadmap: [`docs/10-roadmap.md`](docs/10-roadmap.md)

## Cómo correrlo
Requisitos: Git, Go (versión de `server/go.mod`), Node 22, pnpm (`corepack enable`) y
Docker para Postgres local. En Windows usa WSL2 (ver
[`docs/12-local-development.md`](docs/12-local-development.md)).

```
make setup        # herramientas Go (buf, sqlc, goose, golangci-lint), pnpm install, Chromium
make db-up        # Postgres 16 en Docker (en sesiones cloud usa el servicio del VM)
make lint test validate
make help         # lista todos los targets
```
Algunos targets (`gen`, `validate`, `dev`, `e2e`) todavía solo indican la tarea del
roadmap que los implementa. `make db-down` detiene Postgres; los datos quedan en un
volumen Docker. Copia `.env.example` a `.env` si necesitas `DATABASE_URL`.

## Estructura
| Carpeta | Contenido |
|---|---|
| `server/` | Servidor de juego en Go (módulo propio) |
| `tools/bots/` | Bots de carga en Go (módulo propio) |
| `client/`, `editor/` | Cliente del juego y map editor (TypeScript) |
| `packages/*` | Librerías TS compartidas: `map-format`, `content-schema`, `renderer`, `protocol` |
| `tools/mapcli`, `tools/mcp-world`, `tools/spritepack` | Herramientas TS de mapas y sprites |
| `deploy/` | `docker-compose.dev.yml` (Postgres local); producción en T1.18 |
| `docs/` | Diseño y arquitectura |

## Stack
Go (servidor) · PostgreSQL · WebSocket + Protobuf · TypeScript + PixiJS + Preact (cliente
y editor) · Tauri (escritorio) · Docker Compose en AWS.

## Créditos
Arte de terceros listado en [`assets/CREDITS.md`](assets/CREDITS.md).
Contribuidores de mapas en [`world/CONTRIBUTORS.md`](world/CONTRIBUTORS.md).
