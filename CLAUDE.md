# RPG Project — guía para Claude Code

MMORPG 2D de vista cenital, inspirado en las mecánicas de Tibia (movimiento por casillas,
skills que suben con el uso, grinding, mundo abierto). Nombre provisional: "RPG Project".
Toda la visión y las decisiones cerradas están en `docs/00-vision.md`. No reabras decisiones
de esa tabla sin que el usuario lo pida; si algo te parece un error, propónlo en el PR.

## Regla legal (no negociable)
- Copiamos MECÁNICAS de Tibia, nunca sus assets: ni sprites, ni nombres de ciudades, NPCs,
  monstruos, items, ni mapas, ni textos, ni fórmulas copiadas literalmente.
- Todo asset de terceros debe tener licencia compatible (CC0, CC-BY, OGA-BY) y quedar
  registrado en `assets/CREDITS.md`. Si no puedes verificar la licencia, no lo agregues.

## Stack (decidido)
| Pieza | Tecnología |
|---|---|
| Servidor de juego + API HTTP | Go (un binario: `server/`) |
| Base de datos | PostgreSQL 16 (pgx + sqlc, migraciones con goose) |
| Protocolo | WebSocket binario con Protobuf (`proto/`, generado con buf) |
| Cliente | TypeScript + Vite + PixiJS v8, UI en DOM con Preact (`client/`) |
| Escritorio | Tauri 2 envolviendo el build web (`apps/desktop/`) |
| Map editor | Web, TypeScript + PixiJS, reutiliza el renderer (`editor/`) |
| Herramientas IA | `tools/mapcli` (CLI) y `tools/mcp-world` (servidor MCP) |
| Paquetes TS compartidos | `packages/` (map-format, content-schema, renderer, protocol) |
| Monorepo TS | pnpm workspaces |
| Deploy | Docker Compose en una instancia AWS (EC2/Lightsail) + Caddy |

## Mapa del repo
```
server/        Go: game loop, mundo, combate, red, persistencia, auth (ver server/CLAUDE.md)
client/        Cliente web del juego (ver client/CLAUDE.md)
editor/        Map editor web (ver editor/CLAUDE.md)
apps/desktop/  Envoltorio Tauri
packages/      Librerías TS compartidas
tools/         mapcli, mcp-world, bots de carga, generadores (ver tools/CLAUDE.md)
proto/         Esquemas Protobuf: fuente de verdad del protocolo
data/          Contenido del juego en YAML (items, monstruos, NPCs, quests, hechizos...)
world/         Mapas en formato de chunks JSON + metadatos de islas
assets/        Sprites, sonidos, atlas generados, CREDITS.md
i18n/          Textos traducibles (es, en)
deploy/        docker-compose, Caddyfile, scripts de backup
docs/          Diseño y arquitectura. Lee el doc relevante ANTES de tocar un área.
```

## Docs a consultar según la tarea
- Reglas de juego, fórmulas, vocaciones, skills, muerte → `docs/02-game-design.md`
- Arquitectura, game loop, concurrencia → `docs/01-architecture.md`
- Formato de mapas, pisos, chunks, islas → `docs/03-world-and-maps.md`
- Map editor, mapcli, MCP para IA → `docs/04-map-editor-and-ai.md`
- Mensajes cliente/servidor → `docs/05-network-protocol.md`
- YAML de contenido e i18n → `docs/06-content-data.md`
- Presupuestos de rendimiento → `docs/07-performance-budget.md`
- Cómo verificar tu trabajo → `docs/08-testing-and-verification.md`
- Deploy AWS → `docs/09-deployment-aws.md`
- Entorno local → `docs/12-local-development.md`
- Qué construir ahora → `docs/10-roadmap.md` y `docs/11-claude-code-workflow.md`

## Principios de arquitectura
1. **Servidor autoritativo.** El cliente envía intenciones (moverse, atacar, usar item);
   el servidor valida todo. Nunca confíes en datos del cliente.
2. **Un solo dueño del estado del mundo.** El game loop corre en una goroutine que es la
   única que muta el mundo. Las conexiones solo encolan comandos y leen snapshots/eventos.
   Nada de mutexes sobre entidades del juego.
3. **Tick fijo de 50 ms** con reloj inyectable. La lógica nunca llama a `time.Now()`
   directamente: así los tests son deterministas.
4. **Contenido como datos.** Items, monstruos, NPCs, diálogos, quests y hechizos viven en
   `data/*.yaml` validados con JSON Schema. Agregar un monstruo no debería requerir Go.
5. **Mapas como texto diffeable.** Chunks JSON de 32x32 por piso, para que la comunidad y
   la IA propongan cambios revisables como un PR.
6. **Textos traducibles siempre.** Ningún string visible al jugador va hardcodeado: usa
   claves de `i18n/`.
7. **Preparado, no construido.** PvP, mercado global y tienda cosmética llegan después,
   pero el modelo de datos ya los contempla (ver `docs/00-vision.md`). No los implementes
   antes de su hito.

## Convenciones
- Código, identificadores, commits y comentarios en inglés. Docs en español.
- Go: `gofmt`, `go vet`, `staticcheck`; errores envueltos con `%w`; sin `panic` en runtime
  del juego; paquetes pequeños bajo `server/internal/`.
- TS: `strict: true`, sin `any` salvo en límites justificados; ESLint + Prettier.
- Commits estilo Conventional Commits (`feat(server): ...`, `fix(client): ...`).
- Un PR = una tarea del roadmap. Incluye en la descripción qué verificaste y cómo.

## Comandos (Makefile en la raíz)
```
make setup        # instala dependencias Go y pnpm, genera código de proto
make gen          # buf generate + sqlc generate
make test         # tests Go + TS
make lint         # golangci-lint + eslint + validación de data/ y world/
make validate     # valida YAML de contenido y mapas contra los esquemas
make dev          # postgres + servidor + cliente + editor en modo desarrollo
make e2e          # Playwright: levanta todo, juega un login y saca screenshots
make bots N=100   # prueba de carga con N bots
```
Si un comando del Makefile todavía no existe, créalo como parte de tu tarea.

## Definición de "terminado"
Una tarea está terminada solo si:
1. `make lint test validate` pasa.
2. Hay tests nuevos para la lógica nueva (unitarios o de simulación determinista).
3. Si tocaste algo visual (cliente o editor), corriste `make e2e` y revisaste los
   screenshots en `client/e2e/screenshots/` con la herramienta Read.
4. Actualizaste el doc relevante si cambió un contrato (protocolo, formato de mapa, YAML).
5. Si tocaste `server/` o `proto/`, pasaste el diff por el subagente `code-reviewer` y
   resolviste lo bloqueante.
6. Marcaste la tarea en `docs/10-roadmap.md`.

Skills del proyecto: `roadmap-task`, `add-monster`, `add-item`, `build-map-area`.

## Entornos
Detecta dónde corres con `CLAUDE_CODE_REMOTE` (`true` = sesión cloud).
- **Local** (`docs/12-local-development.md`): Postgres en Docker con `make db-up`.
  Todo debe funcionar en WSL2, macOS y Linux; no asumas rutas del VM cloud.
- **Cloud**: PostgreSQL 16, Go, Node 22, pnpm y Docker vienen preinstalados. Postgres
  corre como servicio (`service postgresql start`, lo hace el hook de inicio).
- La red solo alcanza registros de paquetes y GitHub. No intentes descargar assets de
  sitios externos: si falta un asset, usa un placeholder generado y anótalo.
- Si el contexto se llena, resume el avance en el PR y deja la tarea lista para retomar.
