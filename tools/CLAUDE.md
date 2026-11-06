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
mapcli pr-check --base REF --head REF --out DIR   check de PR de mapas (T2.4, docs/04)
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

## map-pr-worker (TypeScript, T4.5)
`tools/map-pr-worker`: abre un PR por cada envío aprobado del portal de mapas. Toma la cola
de `map_submissions` (`src/queue.ts`, contrato en la migración 00010), mezcla el patch sobre
la rama base actual con `mergePatchFile` de `packages/map-format` (`src/build.ts`, puro:
también repite rutas y parcelas y arma los textos) y escribe con la API Git Data
(`src/github.ts`). `src/worker.ts` hace los pasos idempotentes: PR existente (con la marca del envío) → rama
existente (con sus trailers) → construir. Un rate limit o un error de configuración (401/403/404)
pausan todo el worker sin gastar intentos (`pausedUntil`); al arrancar, `checkIdentity` se
niega a usar el token del dueño o de un maintainer; sin token queda inactivo hasta SIGTERM
(el temporizador de la espera está ref'd: un pool pg ocioso no mantiene vivo a Node);
`--self-check` es el smoke de la imagen. No expone puertos; config por entorno (`src/config.ts`, docs/09). Tests:
`src/*.test.ts` contra `test/fake-github.ts` (un GitHub en memoria, también lo usa el E2E
de `client/e2e/maps.spec.ts`) y `queue.integration.test.ts` con Postgres
(`MAP_PR_WORKER_DATABASE_URL`, `make test-integration`). Nunca loguees el token ni metas un
merge propio: si el formato cambia, se cambia en `packages/map-format`.

## bots (Go)
`tools/bots` (T1.17): prueba de carga con clientes headless (`server/pkg/bot`) que se
registran, crean personaje y juegan en la Isla del Puerto: caminan con rutas A* sobre
`build/world.bin` (`bot.Nav`), atacan monstruos, hablan por chat y abren diálogos con NPCs,
con su propio rate limit (`-min-gap`). Escenarios en `cmd/bots/scenario.go`: `base`
(repartidos por la isla) y `stress` (todos en la ciudad). Reporte JSON (`-report`) y
resumen Markdown con tick, RAM, CPU (de `/metrics` del servidor), latencia de comando
(Ping→Pong), bytes por jugador y desconexiones, comparados con `docs/07`. `make bots N=100`
levanta su propio servidor (`loadtest.sh`); con `URL=` juega contra uno existente. Sale
con código 1 si algún bot no entra o se desconecta. `-profile human|mechanical` (T4.1) les da
el ritmo de los perfiles de `server/pkg/bot` (los mismos del test de la detección de bots):
el humano varía, hace pausas y contesta los chequeos de presencia; el mecánico no.

## soundgen
`tools/soundgen` (T3.7) genera los efectos, la música y el ambiente propios de
`assets/sounds/`. Es un sintetizador determinista en TS (`synth.ts`) con las recetas en
`sfx.ts` y `music.ts`, y encoda a Ogg Opus con ffmpeg. Uso: `make sounds` (o
`ONLY=sfx/hit`). `cli.ts check` solo revisa el presupuesto de tamaño. Los `.ogg` se
commitean. Cómo cambiar a un pack de terceros: `assets/README.md`, "Sonido".

## spritepack
Empaqueta `assets/sprites/**` en atlas PNG + JSON para el cliente y el editor, y genera
placeholders (cuadros de color con la sigla del item) cuando falta un sprite.
Los PNG de bordes de `assets/sprites/borders/` salen de
`node --experimental-strip-types tools/spritepack/src/gen-borders.ts` (regenéralos si
cambia `data/borders.yaml` o el color de un suelo). Uso: `make sprites` (`STRICT=1` falla si algún sprite de `data/` no tiene arte ni entrada en
`assets/sprites.yaml`). Formato del manifiesto, del atlas y cómo integrar un pack de
terceros: `assets/README.md`.
