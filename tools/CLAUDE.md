# tools/ — herramientas de desarrollo e IA

## mapcli (TypeScript, usa packages/map-format)
CLI para que humanos e IA editen mapas sin abrir el editor. Toda salida es JSON por stdout
para que sea fácil de encadenar. Comandos mínimos:
```
mapcli info [isla]                         resumen: tamaño, pisos, spawns, NPCs, zonas
mapcli fmt [isla] [--check]                reescribe chunks y YAML en formato canónico
mapcli view <isla> --floor 7 --area x,y,w,h [--format text]   vista ASCII (máx. 64x64)
mapcli render <isla> --floor 7 --area x,y,w,h --out shot.png   imagen para revisar con Read
mapcli paint <isla> --floor 7 --rect x,y,w,h --ground grass
mapcli place <isla> --pos x,y,z --item oak_tree
mapcli spawn add <isla> --pos x,y,z --monster wolf --count 3 --radius 4 --respawn 60
mapcli zone add <isla> --rect x,y,w,h --floor 7 --type protection
mapcli npc place <isla> --pos x,y,z --npc harbor_master
mapcli generate <isla> --recipe island --seed 42 --size 128   generación procedural base
mapcli validate [isla] [--format text]     mismo validador que el editor y la CI
mapcli patch create|apply|diff             trabajar con map patches
mapcli ops apply ops.json                  aplica una lista de operaciones en lote
```
Todos existen desde T1.15 (además `erase`, `fill`, `remove`, `autoborder`, `stamp`); la
lista exacta de opciones está en `mapcli` sin argumentos. Los comandos de edición aceptan
`--dry-run` y escriben solo los archivos tocados.
Se ejecuta desde la raíz (`--root` para otra) con
`node --experimental-strip-types tools/mapcli/src/cli.ts <comando>`; el flag hace falta en
Node 22.13–22.17 (desde 22.18 los tipos se quitan sin él). `make validate` lo usa así.
`mapcli render` es clave para la IA: después de editar, renderiza el área y revisa la
imagen con la herramienta Read.

## mcp-world (servidor MCP, TypeScript)
Expone las mismas operaciones de map-format como herramientas MCP (`map_info`, `map_view`,
`map_render`, `map_apply_ops`, `map_validate`, `map_find`, `content_search`,
`map_patch_create`). Se registra en `.mcp.json` (servidor `rpg-world`) para que Claude Code
lo use directamente; a mano: `node --experimental-strip-types tools/mcp-world/src/cli.ts
[--root DIR]`. Límites y detalle en `docs/04-map-editor-and-ai.md`.

## bots (Go)
`tools/bots`: clientes headless que hacen login, caminan, atacan y chatean. Se usan para
pruebas de carga (`make bots N=200`) y deben reportar latencia p50/p95/p99 y desconexiones.

## spritepack
Empaqueta `assets/sprites/**` en atlas PNG + JSON para el cliente y el editor, y genera
placeholders (cuadros de color con la sigla del item) cuando falta un sprite.
Los PNG de bordes de `assets/sprites/borders/` salen de
`node --experimental-strip-types tools/spritepack/src/gen-borders.ts` (regenéralos si
cambia `data/borders.yaml` o el color de un suelo). Uso: `make sprites` (`STRICT=1` falla si algún sprite de `data/` no tiene arte ni entrada en
`assets/sprites.yaml`). Formato del manifiesto, del atlas y cómo integrar un pack de
terceros: `assets/README.md`.
