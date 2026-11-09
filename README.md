# RPG Project (nombre provisional)

MMORPG 2D de vista cenital inspirado en las mecánicas de los MMORPG clásicos de casillas:
mundo abierto de islas, skills que suben con el uso, grinding y quests por nivel.
Se juega en el navegador o instalado en PC, y la comunidad puede crear mapas con un
editor web que también puede usar una IA.

> Estado: preproducción. Existe el esqueleto del monorepo (T0.1); el código se construye
> siguiendo `docs/10-roadmap.md`.

## Jugar en tu PC en 3 pasos
Sin instalar Go ni Node: solo Docker (Docker Desktop en Windows/macOS), `make` y `git`. En
Windows, usa la terminal de Ubuntu (WSL2) y clona dentro de ella, no en `/mnt/c`.
1. `git clone https://github.com/GFenzoR/RPG_Project.git && cd RPG_Project`
2. `make home-up` (la primera vez tarda unos minutos; al final imprime qué abrir)
3. Abre `http://localhost:8080`, entra con **Jugar**, crea tu cuenta y hazte admin con
   `make home-admin EMAIL=tu@email.com`.

`make home-tunnel` te da un link `https://…` para invitar amigos. Guía completa (túneles,
app de escritorio, backups, actualizar, problemas comunes):
[`docs/13-hosting-de-pruebas.md`](docs/13-hosting-de-pruebas.md).

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
| `deploy/` | Compose de producción (`docs/09`), del home stack (`docs/13`) y `docker-compose.dev.yml` (Postgres local) |
| `docs/` | Diseño y arquitectura |

## Stack
Go (servidor) · PostgreSQL · WebSocket + Protobuf · TypeScript + PixiJS + Preact (cliente
y editor) · Tauri (escritorio) · Docker Compose en AWS.

## Créditos
Arte de terceros listado en [`assets/CREDITS.md`](assets/CREDITS.md).
Contribuidores de mapas en [`world/CONTRIBUTORS.md`](world/CONTRIBUTORS.md).
