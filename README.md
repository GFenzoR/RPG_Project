# RPG Project (nombre provisional)

MMORPG 2D de vista cenital inspirado en las mecánicas de los MMORPG clásicos de casillas:
mundo abierto de islas, skills que suben con el uso, grinding y quests por nivel.
Se juega en el navegador o instalado en PC, y la comunidad puede crear mapas con un
editor web que también puede usar una IA.

> Estado: preproducción. El repo contiene la documentación de diseño y la configuración
> para construirlo con Claude Code. El código se crea siguiendo `docs/10-roadmap.md`.

## Empieza aquí
- Visión y decisiones: [`docs/00-vision.md`](docs/00-vision.md)
- Cómo trabajar con Claude Code: [`docs/11-claude-code-workflow.md`](docs/11-claude-code-workflow.md)
- Roadmap: [`docs/10-roadmap.md`](docs/10-roadmap.md)

## Stack
Go (servidor) · PostgreSQL · WebSocket + Protobuf · TypeScript + PixiJS + Preact (cliente
y editor) · Tauri (escritorio) · Docker Compose en AWS.

## Créditos
Arte de terceros listado en [`assets/CREDITS.md`](assets/CREDITS.md).
Contribuidores de mapas en [`world/CONTRIBUTORS.md`](world/CONTRIBUTORS.md).
