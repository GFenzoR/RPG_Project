# 04 — Map editor y uso por IA

## Una librería, tres interfaces
```
                packages/map-format
      (leer/escribir chunks, validar, operaciones reversibles)
          ▲                 ▲                    ▲
   editor web          tools/mapcli          tools/mcp-world
  (humanos)        (scripts, CI, IA por CLI)   (IA por MCP)
```
Regla: **toda operación existe primero en `map-format/ops`**, con test. El editor, el CLI y
el MCP solo la exponen. Así un humano y una IA producen exactamente el mismo resultado.

## Operaciones (contrato estable)
Cada operación es JSON, se aplica sobre un mundo en memoria y devuelve su **inversa**
(para deshacer y para revisión).

Implementación: `packages/map-format/src/ops/` (entrada `@rpg/map-format/ops`, sin
dependencias de Node para que el editor la use en el navegador).
`applyOps(world, ops, { itemKind? }) → { world, inverse, touched }`:
- **Pura**: no muta el mundo de entrada; copia solo las islas y chunks que toca.
- **Atómica**: si una op es inválida lanza `OpError` (con el índice de la op) y no aplica
  ninguna. Inválido = celda fuera de toda isla o en un piso no listado, rect vacío,
  `remove_item` de algo que no está, índice fuera de la pila; con `itemKind`, además item
  desconocido, `paint_ground` con algo que no es `kind: ground` o `place_item` con un suelo.
- **Reversible**: `inverse` es una **lista** de ops que, aplicada al resultado, devuelve
  exactamente el mundo original (mismos bytes al guardar). La inversa de la inversa rehace.
- Un chunk que queda sin suelo ni items se elimina (y su archivo desaparece al guardar).
- `touched` lista cada chunk modificado con su isla (`{ island, z, cx, cy }`): los chunks
  son por isla, así que dos islas que compartieran un chunk nunca se mezclan.
  `touchedAux` lista las listas auxiliares cambiadas (`{ island, file }`, con `file` =
  `spawns`/`zones`/`portals`/`npcs`/`texts`/`houses`). `saveApplied(root, world, result)` escribe solo esos
  archivos (temporal + rename) y borra los que quedaron vacíos.
- `OpOptions` inyecta lo que vive en disco, para que el módulo siga sin Node: `itemKind`,
  `monsterKnown`, `npcKnown`, `borders` (la escalera de `data/borders.yaml`, la necesita
  `autoborder`) y `prefab` (lookup de `world/prefabs/`, lo necesita `stamp`).

| op | Campos | Efecto |
|---|---|---|
| `paint_ground` | `floor`, `rect` y/o `cells`, `item` | Pone suelo |
| `erase` | `floor`, `rect` y/o `cells`, `layer` (`ground`/`items`/`all`) | Borra |
| `place_item` | `pos`, `item`, `index?` | Agrega a la pila (`index` 0 = abajo; sin `index`, arriba) |
| `remove_item` | `pos`, `item`, `index?` | Quita de la pila (el de `index`, o el de más arriba) |
| `fill` | `pos`, `item` | Relleno por inundación del suelo contiguo igual |
| `autoborder` | `floor`, `rect` | Recalcula bordes con `data/borders.yaml` |
| `scatter` | `floor`, `rect`, `items[]`, `density`, `seed`, `on_ground[]` | Decoración aleatoria reproducible |
| `add_spawn` / `remove_spawn` | campos de spawns.yaml | |
| `add_zone` / `remove_zone` | campos de zones.yaml | |
| `place_npc` / `remove_npc` | `pos`, `npc` | Un NPC con acciones de diálogo de desarrollo (`train_skill`, `restore_mana`) o marcado `dev_only: true` (la instructora de la Isla de Pruebas) solo va en islas `dev_only`. Esta validación de mapas no lo mira: lo rechazan la de contenido (`make validate`) y el arranque del servidor (`06-content-data.md`, "Diálogos") |
| `add_text` / `remove_text` | campos de texts.yaml (`id`, `kind` `sign`/`book`, `pos`, `text`, `notes?`) | Un cartel o libro. No coloca el item del cartel: va aparte con `place_item` (`03-world-and-maps.md`, `texts.yaml`) |
| `add_portal` / `remove_portal` | campos de portals.yaml | No coloca el item que lo muestra: un `place_item` en su `from` (`stairs_down`, `ladder_up`, `hole`…, los items con bloque `portal`); sin él `make validate` y `make mapcompile` fallan (`03-world-and-maps.md`, "Validación") |
| `stamp` | `pos`, `prefab` | Coloca un prefab (casa, muelle, templo) de `world/prefabs/` |
| `add_house` | `id`, `rent`, `rects[]`, `doors[]`, `exit`, `notes?`, `name?`, `index?` | Agrega una casa a `houses.yaml` (T5.4) |
| `set_house` | `id` y los campos que cambian (`rent`, `rects`, `doors`, `exit`, `notes`; `notes: null` las quita) | Cambia una casa en su lugar; el `id` nunca cambia |
| `remove_house` | `id` | Quita una casa |

Detalle de las ops de T1.15 (las inversas se expresan siempre con ops primitivas):
- `fill`: inundación en 4 direcciones dentro del rectángulo de la isla de `pos`; también
  rellena casillas vacías.
- `autoborder`: en cada casilla del rect quita las piezas de borde que tenga (cualquier
  pieza de `data/borders.yaml`) y apila abajo las que tocan: en el agua primero la espuma,
  después el borde de cada suelo más alto que la toca, de abajo arriba por la escalera; lo
  demás de la pila queda encima; una casilla con un muro no lleva piezas. Repetirlo no
  cambia nada. Escalera y nombres de pieza en `06`, "Bordes". El look de cada pieza no va en
  el mapa: lo elige el renderer.
- `scatter`: PRNG mulberry32 con `seed`; dos números por casilla en orden de filas, pase lo
  que pase, así una casilla no desplaza el patrón del resto. Solo decora casillas con pila
  vacía y suelo en `on_ground` (cualquiera si se omite).
- Entidades: los IDs son únicos en todo el mundo y cada NPC se coloca una vez. La isla es
  la que contiene el centro del spawn, el primer rect de la zona (todos deben caer dentro),
  el `from` del portal o el `pos` del NPC. Las ops `add_*`/`place_npc` aceptan `index?`
  (posición en la lista; por defecto al final): la inversa de un `remove_*` lo usa para
  devolver el archivo byte a byte. Que el spawn o NPC esté sobre suelo caminable lo revisa
  el validador, no la op.
- `stamp`: la esquina superior izquierda del prefab va en `pos`. Formato en `03`.
- Casas (`houses.yaml`, formato en `03`): la isla es la del primer rect y todo (rects,
  puertas, salida) debe caer en ella; `set_house` no mueve una casa de isla. `name` es
  siempre `house.<id>.name` (se completa si falta). La op revisa la forma que necesitan el
  archivo y el servidor: alquiler 1..2³²−1, 1 a 16 rects de lado 1..255 sin casillas
  repetidas dentro de la isla y sus pisos, 1 a 8 puertas que sean casillas de la casa y la
  salida fuera de la casa. Lo demás (otra casa encima, suelo, caminable, puerta en el
  borde, salida junto a una puerta y nunca sobre una puerta, el nombre en `i18n/`) lo
  reporta el validador, como un
  spawn sobre el agua: una casa se puede trazar antes de pintar su suelo. La geometría que
  comparten las ops, el validador y el editor vive en `map-format/src/houses.ts`
  (`houseTiles`, `tilesToRects`, `onHouseEdge`, `disconnectedFloors`, `houseIssues`).

Generación procedural (`generate` en map-format, `mapcli generate`): una receta convierte
una semilla en una lista de ops, así que pasa por `applyOps` (atómica, reversible). Receta
`island`: masa de tierra de `size`x`size` centrada en la isla (ruido de valor + caída
radial), agua alrededor, arena en la costa, pasto adentro (el pasto nunca toca agua y el
centro siempre es tierra) y `autoborder` al final.

`mapcli ops apply ops.json` y la herramienta MCP `map_apply_ops` reciben una lista y la
aplican de forma atómica: si una falla la validación, no se aplica ninguna. Después de
escribir validan las islas tocadas y devuelven errores y advertencias (el mapa puede
quedar con errores mientras se construye: p. ej. un spawn antes de pintar su suelo). No
escriben nada si `world/` tiene errores de carga (un archivo roto se sobrescribiría).

## Cómo "ve" el mapa una IA
Leer JSON de chunks es caro y poco legible. Hay dos vistas pensadas para IA:

1. **Vista ASCII** (`mapcli view` / `map_view`): un área de hasta 64x64 como texto,
   un carácter por casilla, con leyenda generada. Barata en tokens.
   ```
   legend: . grass  , sand  ~ water_shallow  T oak_tree  # stone_wall  + door  M spawn(wolf)
   y\x 3200      3210      3220
   6400 ~~~~,,,,,.....TT......
   6401 ~~~,,,,......T.....#+##
   ```
2. **Render PNG** (`mapcli render` / `map_render`): imagen real con los sprites, para
   revisar con la herramienta Read. Úsalo después de editar para verificar.

## Herramientas MCP (`tools/mcp-world`)
| Herramienta | Uso |
|---|---|
| `map_info` | Resumen de una isla o del mundo |
| `map_view` | Vista ASCII de un área |
| `map_render` | PNG de un área (devuelve ruta del archivo) |
| `map_apply_ops` | Aplica una lista de operaciones (atómica) |
| `map_validate` | Valida isla o mundo; devuelve errores con posición |
| `map_find` | Busca items, spawns, NPCs o zonas por tipo/área |
| `content_search` | Busca en `data/` (items, monstruos, NPCs) por texto o etiqueta; una puerta trae su par y la llave que la abre, una llave su id (`02` "Puertas con llave") |
| `map_patch_create` | Genera un `.rpgpatch.json` (formato 2) con los cambios actuales |

Límites de seguridad del MCP: solo escribe dentro de `world/` del repo, nunca hace push
ni modifica `data/`, y cada llamada a `map_apply_ops` tiene un máximo de operaciones.
Se registra en `.mcp.json` en la raíz para que Claude Code lo cargue.

Implementación (T1.15): `tools/mcp-world`, transporte stdio (JSON-RPC 2.0, un mensaje por
línea) escrito a mano, sin SDK, para no sumar dependencias; usa las funciones de
`tools/mapcli` (`edit.ts`, `render.ts`, `patch.ts`). Límites concretos:
- `map_apply_ops`: máximo 200 ops por llamada; `island` opcional rechaza ops que toquen
  otra isla; `dry_run` valida sin escribir. Las ediciones solo escriben chunks y YAML de
  `world/islands/<id>/` (rutas construidas desde IDs validados y comprobadas otra vez).
- `map_patch_create` escribe en `world/patches/<name>.rpgpatch.json` (ignorado por git);
  solo corre `git diff`, `git ls-files` y `git show` de lectura.
- `map_render` escribe el PNG en el directorio temporal del sistema (fuera del repo) y
  devuelve también la imagen en la respuesta.
- `content_search` y el resto solo leen.

`mapcli render` / `map_render`: mismo orden de dibujo que `packages/renderer`, con el atlas
de `tools/spritepack` armado en memoria (no hace falta `make sprites`), y el mismo arte del
mapa que el juego (`tile-art.ts`, docs/17): el look de suelo de cada casilla, la pieza de
cada muro según sus vecinos, árboles centrados, sombras proyectadas y el frame 0 de lo
animado; también dibuja las filas de abajo del área cuyos sprites altos entran en ella. Agrega reglas con
coordenadas absolutas, grilla y overlays: zonas (cian protección, naranja no_logout, rojo
pvp, verde no_pvp, violeta community_plot), spawns (anillo rojo del radio), NPCs (rombo
amarillo), portales (cuadro magenta; triángulo abajo = baja, arriba = sube), carteles
(cuadrito blanco) y templo (cruz blanca). Máximo 256x256 casillas; 4/8/16/32 px por casilla.

### Map patches
Formato (`.rpgpatch.json`, formato 2 desde T2.3):
`{ format: 2, kind: "rpg-map-patch", base_ref, files: [{ path, base, base_text?, content }] }`.
`base` = `sha256:<hex>` de la versión base (o `null` si el patch crea el archivo),
`base_text` = el texto de esa base (obligatorio en formato 2 cuando `base` no es `null`),
`content` = texto nuevo (o `null` si lo borra). `base_ref` es el commit contra el que se
hizo (`mapcli` y el MCP escriben el sha al que apunta el ref pedido, `HEAD` por defecto,
porque un ref simbólico no dice nada fuera de ese clon; T4.5) o `"editor"`. El formato 1 (T1.15, sin `base_text`) se sigue leyendo.

**Decisión: la base viaja en el patch.** Para mezclar hace falta la base completa, no solo
el hash. Se eligió incluirla (formato 2) en vez de sacarla con `git show base_ref:path`
porque el patch tiene que poder aplicarse donde ese ref no existe: otro clon, una rama
rebasada, el editor sin git o, más adelante, el editor público sin backend. Cuesta el
doble de tamaño, aceptable con chunks de 32x32. Con formato 1 la base se busca en el disco
(si el hash coincide) y luego en `git show base_ref:path`. Si no aparece, solo se aplican
los archivos sin cambios locales y el resto es conflicto.

La lógica vive en un solo lugar, `packages/map-format`:
- `src/patch/merge.ts` (sin Node, también lo usa el editor): `mergeChunk`, `mergeList`,
  `diffWorlds`, `chunkChanges`/`listChanges` y las ops que llevan el mundo al resultado
  (`chunkSyncOps`, `listSyncOps`).
- `src/patch/patch.ts` (Node): `parsePatch`, `parsePatchFile`, `mergePatchFile`,
  `summarizeFileChange` y `patchPath`.
`tools/mapcli/src/patch.ts` solo agrega lo que necesita git y disco (`createPatch`,
`planPatch`, `writePlanned`). El MCP (`map_patch_create`) usa `createPatch`, así que
también genera formato 2.

**Merge de tres vías** (base del patch, versión actual, contenido del patch):
- Primero se comparan textos: si un solo lado cambió, se toma ese lado.
- **Chunks**, por casilla (suelo + pila completa): una casilla que cambió de un solo lado
  se toma de ese lado; si cambió en los dos lados a valores distintos, es conflicto. Un
  chunk que no existe cuenta como vacío, así que crear y borrar archivos se mezcla igual.
  Si el resultado queda vacío, el archivo se borra.
- **YAML auxiliares** (`spawns`, `npcs`, `zones`, `portals`, `texts`): se mezclan por
  entrada con `id` como clave (`npc` en `npcs.yaml`). Si una entrada se borró en un lado y
  se cambió en el otro, es conflicto. Orden del resultado: la lista actual, con sus
  entradas reemplazadas o quitadas, y después las que agrega el patch. Si un lado no
  cambió, el otro se toma tal cual, orden incluido. Las listas con claves repetidas o sin
  clave son conflicto del archivo entero.
- `world.yaml`, `island.yaml` y prefabs: si cambiaron en los dos lados, es conflicto del
  archivo entero.
- **Siempre se escribe la forma canónica** (`canonicalPatchText`), también en el
  fast-forward y al crear un archivo. Es el mismo texto que `mapcli fmt`: un patch hecho a
  mano se acepta, pero nunca se escriben sus bytes tal cual (un `01056` u `0x4` en YAML se
  lee distinto en Go y en TS). Un chunk vacío o una lista vacía borran el archivo. Las
  comparaciones (base, actual, patch) también se hacen sobre texto canónico, así aplicar
  dos veces el mismo patch es un no-op aunque no esté en forma canónica.

`mapcli patch`:
- `create [isla] [--against REF] [--out FILE]`: los archivos de mapa que difieren del ref,
  en formato 2.
- `apply <file> [--dry-run] [--partial]`: hace el merge de cada archivo contra el disco.
  Es todo o nada: si hay conflictos no escribe nada, sale con código 1 y los lista como
  `{ path, reason, at: ["x,y,z" | id] }` (las primeras 100 casillas o entradas). Con
  `--partial` escribe todo lo demás y en las casillas o entradas en conflicto conserva la
  versión actual. La salida dice qué archivos se mezclaron (`merged`) y el resultado del
  validador.
- `diff <file>`: compara lo actual con lo que escribiría el merge, no con el contenido del
  patch, así las ediciones locales hechas en otras casillas o entradas no aparecen como
  revertidas. Da casillas cambiadas y bbox por chunk; entradas agregadas, quitadas y
  cambiadas por YAML; `base_matches` y, si la base no coincide, cuántos conflictos hay.
  Si el archivo entero es conflicto (no hay base, o un `island.yaml`/`world.yaml`/prefab
  cambió en los dos lados), `status` es `"conflict"` y el resumen muestra lo que cambia
  el contenido del patch.
  Sale con código 1 solo si hay conflictos.

**Seguridad:** un patch es entrada no confiable. `parsePatch` rechaza:
- patches de más de 32 MB o con más de 4096 archivos;
- un `base_ref` que no parezca un ref (por ejemplo, uno que empiece con `-`);
- rutas fuera de `world.yaml`, `world/islands/<id>/{island,spawns,npcs,zones,portals,texts}.yaml`,
  `world/islands/<id>/chunks/zNN/cXXXX_YYYY.json` (piso ≤ 15) y `world/prefabs/<id>.yaml`:
  la regex no deja pasar `..`, rutas absolutas, `\`, NUL ni mayúsculas;
- rutas repetidas o un `base_text` cuyo hash no coincide con `base`;
- contenido o base que no pase su esquema, o un chunk cuyas coordenadas no coinciden con
  su ruta.
Al escribir, `mapcli` también comprueba que el directorio existente más profundo resuelva
(realpath) dentro de `world/` y que el destino no sea un symlink. Los tests de rutas
maliciosas están en `packages/map-format/src/patch/merge.test.ts`,
`tools/mapcli/src/edit.test.ts` (incluido el symlink) y `editor/server/store.test.ts`.

### PR de mapas en CI (T2.4)
Todo PR dispara dos workflows (sin filtro `paths`: GitHub solo mira los primeros 300
archivos, y un push que deja de tocar `world/` tiene que reemplazar el veredicto anterior):

1. **`map-pr.yml`** (`pull_request` con `opened`, `synchronize`, `reopened` y `edited`,
   `contents: read`, sin secretos). Hace checkout de la **rama base tal como está ahora**
   (`base.ref`, no el `base.sha` congelado del evento) con `persist-credentials: false`, y
   trae el head del PR solo como dato (`git fetch refs/pull/N/head`). El token (de solo
   lectura) va como cabecera de ese comando y no queda en `.git/config`, así que `pnpm
   install` y `mapcli` no lo leen de ahí (acciones como `setup-node` igual reciben
   `github.token` por su cuenta). Si el PR no cambia `world/`, termina ahí, antes de
   `pnpm install`. Si lo cambia, instala las dependencias **de la base** y corre
   `mapcli pr-check --base <sha base> --head <sha head> --author <login> --association <rel> --head-repo <o/r> --repo <o/r> --pr <n> --out map-pr`.
   Sube dos artefactos, `map-pr-report` (`report.json`) y `map-pr-renders` (PNG), y falla
   si el reporte falla. También deja una vista previa del comentario en el resumen.
2. **`map-pr-comment.yml`** (`workflow_run` de `map-pr` con `requested` y `completed`;
   sale siempre de la rama por defecto). Escribe dos cosas: **un** comentario por PR,
   marcado con `<!-- rpg-map-pr-check -->`, y el **status de commit `map-pr/verdict`**
   sobre el commit head del PR. El veredicto depende de la base y de quién abrió el PR y
   desde dónde (maintainer), pero el status es del commit. Por eso el status lo escribe
   **solo un PR hacia la rama por defecto** (`DEFAULT_BRANCH`, del `repository` del
   evento), solo si **ningún otro PR abierto hacia esa rama tiene el mismo commit desde
   otro repo o con otro autor**. Si el PR cambia `world/`, además, solo con un veredicto
   **calculado contra la punta actual de esa rama** (uno que no cambia `world/` no tiene
   mapa que juzgar: su `success` no depende de la base). Y no escribe nada si el PR
   cambió (base, head o cantidad de archivos) mientras se calculaba el veredicto:
   - el mismo commit puede ser el head de otro PR hacia una rama vieja del repo (con otras
     parcelas o un `prcheck` viejo) cuyo `success` aparecería en el PR hacia `main`. Un
     PR hacia otra rama recibe su comentario y nada más;
   - GitHub deja un solo PR abierto por rama de origen y base, así que una "copia" hacia
     `main` no sale de la misma rama: sale de un fork al que alguien subió el mismo commit,
     o de otra rama del repo con la misma punta. Las corridas de esa copia fallan `plots`
     (su autor no es maintainer) y, con cada `edited`, pasarían a `failure` el status del
     commit del maintainer. Mientras la copia esté abierta, ninguna de las dos corridas
     escribe el status: queda el que había (un `pending` o ninguno bloquean el merge). Se
     cierra la copia y el PR bueno necesita una corrida **nueva** de `map-pr` (abajo). Es
     solo un bloqueo: nunca da un `success` falso, porque el mismo commit hacia la misma
     base es el mismo merge;
   - el reporte dice contra qué commit de la base se calculó (`base`: la punta de
     `base.ref` cuando la corrida hizo checkout). Para un PR hacia la rama por defecto que
     cambia `world/`, `comment` lo compara con la punta actual de esa rama
     (`GET /git/ref/heads/<rama>`, con `contents: read`). Si no coincide, el reporte no
     vale (`other_base`): el comentario lo dice y el status, si este PR lo escribe (no con
     una copia abierta), queda en `failure`. Cierra el caso de un PR que se
     calculó hacia una rama vieja y después se pasó a `main`: el `completed` de esa
     corrida vieja no escribe un `success` de la rama vieja, por tarde que llegue y aunque
     otros PR compartan el commit. También cae ahí una corrida que `main` dejó atrás
     mientras corría (con "Require branches to be up to date" ese PR igual necesita
     actualizarse). El comentario no muestra el detalle de ese reporte; el resumen de la
     corrida de `map-pr` sí (la vista previa);
   - justo antes de escribir, `comment` vuelve a leer el PR: si su base, su head o su
     cantidad de archivos cambiaron desde que leyó los archivos, no escribe nada (la
     corrida del `edited` o del push que lo cambió escribe la suya). Así un PR que no
     cambia `world/` contra una rama vieja no se lleva su `success` "sin mapa" al pasar
     a `main` y volver. Si la API de archivos tarda en recalcular tras un cambio de base
     (no verificado en GitHub), esta lectura no lo ve.

   Tiene dos jobs, que corren de a uno por rama del PR (un grupo de `concurrency` a nivel
   de job, compartido):
   - `pending` (`requested`, cuando arranca una corrida de `map-pr`): pone el status en
     `pending` ("Revisando el commit …") y, si el comentario ya existe, lo cambia a
     "⏳ Pendiente: revisando el commit `<sha>`. El veredicto anterior ya no vale". Si la
     corrida ya terminó cuando llega, no hace nada: el veredicto lo escribe `comment`.
   - `comment` (`completed`, salvo corridas canceladas o que esperan que un maintainer
     apruebe los workflows de un contribuidor nuevo, `action_required`: esas no traen
     veredicto; `prcomment.ts` también las ignora): crea el comentario solo si el PR
     cambia `world/` y lo actualiza siempre que ya exista. Si el último commit ya no toca
     `world/`, lo reemplaza por un aviso de que la revisión anterior no aplica. Después
     pone el status final (abajo). Primero el comentario y después el status: si el
     status falla, el job queda en rojo y el commit con el status que tenía (`pending` si
     el job `pending` marcó esta corrida; ninguno si es un commit nuevo, que igual
     bloquea; el final anterior solo si es otra corrida del mismo commit y `pending` no
     alcanzó a correr).

   El grupo de `concurrency` es más débil de lo que parece: GitHub deja un job corriendo y
   **uno** esperando, y uno nuevo cancela al que espera aunque `cancel-in-progress` sea
   `false`. Con dos PR desde la misma rama (uno hacia `main` y otro hacia otra rama), el
   veredicto del de `main` se puede perder. Su status queda como estaba: el job `pending`
   no lo escribe con dos bases, así que es ninguno (bloquea) o un veredicto anterior del
   mismo commit. Lo corrige una corrida nueva de su `map-pr` (abajo: relanzar una vieja no
   alcanza si hay una más nueva). Tampoco está verificado en GitHub que un job saltado
   por su `if` no ocupe lugar en el grupo.

   Los dos validan los datos del evento con regex (`readEnv` en `prcomment.ts`: sha,
   repo, número de corrida y de PR, rama por defecto) y no hacen nada si:
   - el PR ya avanzó a otro commit: un reporte viejo nunca pisa uno nuevo ni el aviso de
     "pendiente";
   - el comentario lo escribió una corrida más nueva. Cada comentario lleva en su segunda
     línea, oculta, la corrida que lo escribió (`<!-- map-pr-run <id> -->`; los id de
     corrida solo crecen). GitHub puede entregar tarde un evento de `workflow_run`, y una
     corrida vieja del mismo commit (por ejemplo, antes de un `edited` que cambió la base)
     no debe pisar el comentario ni el status de la nueva. Relanzar la última corrida sí
     escribe (mismo id), salvo que haya una más nueva del mismo commit (por ejemplo, de un
     PR cerrado: ver el punto siguiente); relanzar una más vieja no cambia nada;
   - hay una corrida de `map-pr.yml` más nueva del mismo commit y del mismo repo de
     origen (`GET /actions/workflows/map-pr.yml/runs?head_sha=…&event=pull_request`, con
     `actions: read`), cuando el PR es el único abierto con ese head desde ese repo:
     entonces toda corrida de `map-pr.yml` así es de este PR, de uno cerrado o de uno
     abierto que ya avanzó a otro commit. Solo cuentan las de ese archivo: un PR que
     renombra el workflow (con el mismo `name: map-pr`) toca `.github/`, y eso nunca da
     `success` salvo a un maintainer. Cubre lo que el sello del comentario no ve: un PR
     que todavía no tiene comentario o que no cambia `world/`. Se leen todas las páginas
     hasta una incompleta: GitHub no documenta el orden de la lista, así que no se supone
     ninguno. Con varios PR del mismo commit desde el mismo repo no se pregunta (la
     corrida más nueva puede ser del otro PR) y quedan el sello del comentario y la base
     del reporte (arriba): un veredicto de `world/` calculado contra otra base nunca da
     `success`. Si la respuesta de la API no trae la lista, o hay 1000 corridas o más del
     commit (GitHub no lista más), el job falla sin escribir;
   - hay varios PR abiertos con ese commit (y ese repo de origen) hacia ramas distintas y
     la corrida no dice para cuál es. El número de PR del reporte elige entre ellos: no
     es de confianza, pero solo puede nombrar otro PR con el mismo commit, cuyos datos de
     confianza deciden después, y el reporte tiene que coincidir con ese PR. El job
     `pending` no tiene reporte, y una corrida sin reporte utilizable tampoco: en ese
     caso no escriben nada (un `pending` que ningún veredicto reemplazaría dejaría
     trabado al PR hacia `main`).

   Cualquier error de la API (rate limit, 5xx) deja el job en rojo, nunca "pasa" sin
   escribir.

   **El status `map-pr/verdict`** (`commitStatus` en `prcomment.ts`) se calcula del lado
   de confianza (la API y el `MAINTAINERS` de la rama por defecto):
   - `failure` siempre que el commit tenga un **check run** llamado `map-pr/verdict`
     (`GET /commits/{sha}/check-runs?check_name=…`, con `checks: read`): nuestro workflow
     solo pone un status, así que eso es el job de algún workflow haciéndose pasar por él
     (ver "Límite conocido"). El comentario lo avisa arriba con 🚨 y no muestra ✅. Solo
     ve los que existen cuando se escribe el veredicto;
   - `success` si el commit no cambia `world/` (salvo que la API no liste todos los
     archivos y el autor no sea maintainer: ahí `failure`, porque entre los que faltan
     podría haber uno de `world/`). No hay mapa que juzgar: lo que ese PR cambie en
     `.github/` u otra parte lo cuida `CODEOWNERS`, no este status;
   - `failure` si no hay un reporte utilizable o si hay alguna falla (`plots` según el
     maintainer de confianza, no el del reporte). Un reporte calculado contra otra base
     que la punta actual de la rama por defecto no es utilizable (`other_base`, arriba);
   - `failure` si el comentario no confía en el veredicto (el PR cambia algo fuera de
     `world/` y `docs/`, o la lista de archivos está cortada), salvo que el autor sea
     maintainer: a él el check ya le confía todo el mapa. El comentario igual dice qué
     revisar a mano;
   - `success` en el resto, que es exactamente el ✅ del comentario.

   **Por qué un status y no otro workflow "pendiente".** Hasta noviembre de 2026 había un
   tercer workflow, `map-pr-pending.yml` (`pull_request_target`), que marcaba el
   comentario como pendiente en cada push. GitHub bloquea `pull_request_target` por
   defecto en los repos públicos desde el 2026-12-02 (ya hubo cortes de prueba: el
   PR #82 no lo pudo correr), y habilitarlo pediría una política de eventos de Actions.
   Ahora el aviso sale del `requested` de la corrida de `map-pr`, y el hueco que cubría
   (un push que **no** produce corrida de `map-pr` porque el PR renombró o borró
   `map-pr.yml`) lo cierra el status: es **por commit**, así que el commit nuevo queda
   sin `map-pr/verdict`, y la protección de `main` que lo exige bloquea el merge. Un ✅
   viejo nunca vale para un commit nuevo. El comentario no cambia en ese caso, pero
   nombra su commit y su pie lo dice: "si el PR tiene uno más nuevo y esto no pasó a ⏳,
   el check no corrió para ese commit (le falta el status `map-pr/verdict`)". El status
   no es a prueba de falsificación (ver "Límite conocido"): lo que impide que un PR
   cambie los workflows sin revisión es `CODEOWNERS`.

`mapcli pr-check` (`tools/mapcli/src/prcheck.ts`):
- Arma el PR como map patch desde `merge-base(base, head)` hasta `head` y lo mezcla sobre
  la base actual en un worktree temporal, igual que `patch apply`. El resumen por archivo
  es el de `patch diff` (estado, casillas, bbox, entradas, `base_matches`, `conflict`), así
  lo que entró a la base después de abrir el PR no aparece como revertido.
- **Mismo merge que GitHub:** GitHub mezcla texto, no casillas. `git merge-tree
  --write-tree` calcula el árbol que haría git:
  - si git ve un conflicto textual, falla con `rebase`;
  - si para algún archivo tocado el texto de git (canónico) no es exactamente el que midió
    el merge por casilla, falla con `merge_mismatch`. Pasa con las paletas de los chunks,
    que van en orden de primer uso: un lado renumera y el otro agrega una fila con la
    numeración vieja.
- **Archivos inválidos:** fallan con `invalid`, también para maintainers, y quedan fuera
  del merge:
  - un archivo de mapa del PR que no pasa su esquema;
  - uno que no es UTF-8 válido: se lee como bytes y se decodifica en modo estricto, porque
    una decodificación con pérdida convertiría un `0xFF` en U+FFFD y parecería canónico;
  - uno cuyos **bytes** no son exactamente su forma canónica (`mapcli fmt`). Por ejemplo,
    `x: 03207` es 3207 para el parser TS y 1671 (octal) para el `yaml.v3` del servidor;
  - una ruta de `world/`, `data/`, `i18n/` o `assets/` que el PR cambia (merge-base → head)
    o que su merge cambia (base → árbol del merge) y cuyo modo ahí no es `100644`
    (symlink, ejecutable, submódulo), aunque el blob no cambie (`bad_mode_files`). Solo
    esas: un archivo raro que ya está en la base no hace fallar todos los PR;
  - una ruta de contenido del merge que el check no puede escribir como la deja el merge
    (`skipped_content`, ver "Contenido del después"): el "después" no sería el merge.
- La comparación con `git merge-tree` compara bytes: el blob crudo de git contra el
  archivo que escribió el merge por casilla, sin canonicalizar.
- **Caracteres prohibidos (decisión).** `parsePatchFile`, y con él `canonicalPatchText`,
  rechaza en cualquier archivo de mapa los controles C0 (salvo tab, LF y CR), DEL, los
  controles C1 y U+FFFE/U+FFFF, tanto crudos como escritos como escape YAML (`"\x7f"`).
  Se rechazan en vez de escaparlos al escribir porque el texto libre (`notes`) nunca los
  necesita, y porque así el parser TS y el `yaml.v3` de Go leen siempre lo mismo (Go los
  rechaza crudos). Acentos, ñ y el resto de Unicode pasan.
- **Parcelas** (`checkPlots` en `packages/map-format/src/patch/plots.ts`, reglas en
  `03-world-and-maps.md`): casillas y entradas fuera de toda parcela `community_plot` de la
  base, y portales entre islas (`cross_island`, abajo). Falla si hay alguno y el autor no es
  maintainer (`.github/MAINTAINERS` de la base u OWNER, y dueño del repo del head).
- **Portales de la comunidad (para moderadores).** Un portal mueve jugadores de verdad
  (escaleras, agujeros, teletransportes), así que un PR de la comunidad solo puede unir
  casillas de **una misma isla**, con sus dos extremos en parcelas. Un portal con un extremo
  en una parcela de otra isla es `cross_island` ("portal entre islas" en el comentario) y
  necesita un maintainer: se saltaría el barco, con su precio, sus requisitos y su bloqueo
  de combate (`travel.combat_block_ms`: nadie zarpa recién peleado), y serviría para huir
  de una pelea o para llegar gratis a una isla de nivel alto. Aun dentro de una isla, revisa
  todo portal de un PR de la comunidad antes de aprobarlo: adónde lleva (que no sea un
  atajo que se salte una cueva, un jefe o el camino pensado de la isla), si tiene vuelta y
  si el validador avisa que desde su destino no se llega a ningún templo.
- **Contenido del "después".** El mapa se lee con contenido (`data/` e `i18n/` para el
  validador y los renders, `assets/` para el atlas de los renders), y el "después" lleva
  **el contenido del árbol del merge** (`landContent`): el worktree sale de la base y se le
  escribe lo que difiere en esas carpetas entre la base y el árbol de `git merge-tree`
  (`git diff-tree -r --no-renames`). Así queda idéntico al merge también cuando la base
  renombró o movió un archivo que el PR edita, o convirtió en carpeta un archivo que el PR
  borra. Si git no puede mezclar (el check ya falla con `rebase`), se escriben los cambios
  del PR desde el merge-base, como los tiene el head. El "antes" sigue siendo el árbol
  completo de la base, con su propio contenido. Antes de esto, un PR que agrega un item y lo
  usa en el mapa fallaba siempre con `unknown item` (PR #81: 386 errores falsos), porque el
  mapa del head se validaba con el `data/` de la base.
  - Los archivos se leen como datos (`git cat-file --batch`, por id de objeto; nada del PR
    se ejecuta) y se escriben como archivos comunes: un symlink queda como un archivo con
    el texto de su destino y nunca se sigue.
  - Solo se borra un archivo que falta en el árbol del merge, nunca una carpeta con
    archivos. Las carpetas que quedan vacías se quitan después, de la más honda hacia
    arriba y siempre dentro del worktree, como en un checkout del merge. Así, si la base
    tiene `data/x/y/z.yaml` y el merge tiene el archivo `data/x`, el archivo entra.
  - Un objeto que no es un blob (un gitlink, o un tree con modo de archivo) no se escribe
    ni se borra.
  - Se saltan las rutas que podrían salir del worktree o nombrar otra cosa: segmentos
    `..`, `.` o vacíos, `.git` en cualquier mayúscula, `\`, `:`, NUL o un salto de línea.
    También una ruta cuya carpeta real (symlinks resueltos) queda fuera del worktree, y un
    archivo que choca con una carpeta. Toda ruta saltada **hace fallar el check con
    `invalid`**, también para maintainers: el "después" ya no sería el merge (un
    `data/items/x:y.yaml` es válido en Linux y el servidor lo cargaría). El reporte las
    lista en `skipped_content` (nota `content_skipped`). Cualquier otro error de escritura
    (disco lleno, permisos) corta el check en vez de contarse como ruta saltada.
  - En el reporte, toda ruta de `world/` o de contenido (`bad_mode_files`,
    `skipped_content`, `other_files`) sale con `reportPath`: cada carácter fuera de
    `[A-Za-z0-9_./-]`, y un punto seguido de otro, se vuelve `?`. Así un nombre raro se
    muestra y no anula el comentario entero.
  - **Límites:** como mucho 20 000 rutas de contenido para escribir (los borrados no
    cuentan) y 64 MB, sumados **por ruta**: mil rutas de un mismo blob grande pesan mil
    veces. Si el PR pasa alguno, no se escribe nada, el "después" se mide con el contenido
    de la base y el check falla con `limits` (nota `content_too_large`), en vez de quedar
    sin reporte. **Un pack de terceros grande** (el de Dungeon Crawl tocó 4396 archivos) va
    en un PR que no cambia `world/`: ese PR sale del check antes de leer contenido, y el
    mapa que lo usa llega en otro PR.
  - Además, `spritepack` no decodifica un PNG cuya cabecera declare más de 2048 px de lado
    (lo mira antes de descomprimir), ni más de 16 páginas de 2048×2048 px en PNG por
    armado (`MAX_TOTAL_PIXELS`), y un `placeholder.size` va hasta 256 px por lado.
- **Validación**: errores del validador en el mapa mezclado que la base no tenía. Cada
  lado se valida con su propio contenido (la base con el suyo; el merge con el que deja el
  merge), así que también cuenta lo que el PR rompe desde el contenido (un item que borra y
  el mapa usa), sea o no maintainer.
  - **Contenido de la comunidad (decisión).** Cambiar `data/`, `i18n/` o `assets/` requiere
    un maintainer. Si el autor no lo es y el PR cambia algo ahí, el mapa mezclado se valida
    **también con el contenido de la base**, y los errores nuevos son la unión de las dos
    validaciones. Así un PR de la comunidad no pasa trayendo los items o textos que usa
    (falla con `validation`, además de figurar en "Fuera de `world/`" y de que el
    comentario nunca muestre ✅). Su "después" también se dibuja con el contenido y los
    sprites de la base (nota `base_content`). La segunda validación usa el mismo contenido
    que el "antes", así que la comparación es pareja, y la unión no pierde errores de
    ninguna.
  - Límite conocido: el validador es el de la base. Si el PR también cambia las reglas de
    `packages/map-format`, el check mide con las reglas viejas hasta que se mezcle.
- **Conflictos** con la base actual: falla (hay que hacer rebase). Cada conflicto lleva un
  código fijo (`tiles`, `entries`, `changed_both_sides`, `no_base`, `invalid_file`), nunca
  el texto del parser.
- **Render**:
  - `changeBoxes` toma el bbox de las casillas cambiadas por chunk y la posición de cada
    entrada cambiada (spawn con su radio, ambos extremos del portal, rects de zona);
  - `renderAreas` les suma 4 casillas de margen, fusiona las que se tocan en el mismo piso,
    parte las de más de 64x64 y se queda con 6 como máximo (el resto se cuenta);
  - cada área se renderiza antes (base) y después (merge, con su contenido y sus sprites;
    para la comunidad que toca contenido, con los de la base) con `renderArea`, a
    32/16/8/4 px por casilla para no pasar de 1024 px de lado;
  - si un PNG pasa de 2 MB (arte detallado), el tile baja a la mitad hasta que los dos
    entren, con el mismo tile para ambos así se comparan; en 4 px, el PNG que siga
    pasando no se sube.
- Exit code 1 si falla. `report.json` (formato 2) lleva:
  - `ok`, `failures` (`plots`, `invalid`, `conflicts`, `rebase`, `merge_mismatch`,
    `validation`, `limits`) y `map_changes`;
  - `files`, `conflicts`, `invalid_files`, `noncanonical_files`, `bad_mode_files`,
    `skipped_content` (con su total) y `merge_mismatch`;
  - `plots` y `validation`, con sus totales;
  - `other_files` (con su total), `areas` y `omitted_areas`;
  - `notes`, cómo se midió el contenido, con códigos fijos: `base_content`,
    `content_too_large`, `content_skipped` y `atlas_fallback` (los sprites del merge no se
    pudieron armar, por ejemplo por un PNG demasiado grande, y el "después" se dibujó con
    los de la base en vez de dejar todo sin sprite). El comentario los muestra con textos
    propios en "Cómo se midió".

**Seguridad (los PR vienen de forks).** Modelo de confianza en dos capas:
1. **El check corre código de la base, no del PR.** `map-pr.yml` hace checkout de la rama
   base y corre su `pnpm install` y su `mapcli`. Del PR solo lee datos: el mapa y el
   contenido (`data/`, `i18n/`, `assets/`) con `git show`, `git cat-file`, `git diff-tree`
   y `git merge-tree`. Un `postinstall`, un cambio a `plots.ts` o a `prcheck.ts` del PR no se
   ejecutan. El token es de solo lectura, no hay secretos y no se usa `pull_request_target`.
2. **El comentario no cree en el reporte para lo importante.** `map-pr-comment.yml` corre
   desde la rama por defecto y solo hace checkout de `tools/mapcli/src/prcomment.ts`
   (autocontenido, sin `pnpm install`) y de `.github/MAINTAINERS`. No ejecuta nada del PR y:
   - toma la lista de archivos de `GET /pulls/{n}/files` (hasta 3000; un rename cuenta
     también por su origen, así que mover `.github/workflows/ci.yml` a `docs/` es tocar
     `.github/`) y arma con ella
     "Fuera de `world/`", con los archivos sensibles (`.github/`, `tools/`, `packages/`,
     `server/`, `package.json`, lockfile, `.npmrc`) primero;
   - decide si el autor es maintainer con los datos del PR en la API
     (`author_association`, `head.repo`) y el `MAINTAINERS` de la rama por defecto, y con
     eso decide la falla `plots` (para eso el `maintainer` del reporte no cuenta). El
     `maintainer` del check sí decide algo que el comentario no puede recalcular: si el
     mapa también se valida con el contenido de la base (`validation`). Un error ahí solo
     relaja a un PR que cambia contenido, y ese PR nunca muestra ✅ (ver abajo);
   - si la API lista menos archivos que el `changed_files` del PR, o llega al tope de
     3000, el veredicto no es confiable: los archivos que no se ven podrían ser cualquier
     cosa. El "… y N más" usa el total del PR;
   - si el PR cambia cualquier archivo fuera de `world/` y `docs/`, **nunca muestra ✅**:
     dice "El veredicto no es confiable: este PR cambia el código o la configuración del
     check";
   - trata `report.json` como dato no confiable. Lo rechaza si pasa de 1 MB, reconstruye
     cada campo con su tipo y valida cada string contra un patrón estricto (rutas de
     `world/`, IDs, logins, SHAs, nombres `before|after-N.png`, códigos con `oneOf`);
   - los motivos y errores salen de tablas fijas en español: ningún texto del parser llega
     al comentario. Lo único libre son los mensajes del validador, sin backticks ni saltos,
     dentro de un bloque de código;
   - busca el PR por `head_sha` y repo de origen del `workflow_run`, y exige que el número,
     el commit y el autor del reporte coincidan y, si el PR va hacia la rama por defecto,
     que su base sea la punta actual de esa rama;
   - pone el status `map-pr/verdict` (solo en un PR hacia la rama por defecto, y sin
     copias de otro autor o repo abiertas) con esos mismos datos de confianza: un PR de
     la comunidad que cambia `world/` y además
     `.github/` (o cualquier cosa fuera de `world/` y `docs/`) nunca tiene `success`, ni
     aunque su `map-pr` falso suba un reporte "perfecto". Uno que no cambia `world/` sí
     tiene `success`, porque no hay mapa que juzgar: sus cambios a `.github/` los frena
     `CODEOWNERS`, no este status.
- **Qué token corre dónde** (solo `GITHUB_TOKEN`; ningún workflow de PR usa otros secretos):

  | Workflow / job | Evento | Código que corre | Permisos del token |
  |---|---|---|---|
  | `map-pr` / `check` | `pull_request` (también forks) | **el YAML sale del PR** (del merge con la base), así que un PR que edita `map-pr.yml` corre sus propios steps. Tal como está en la base: checkout de `base.ref` y su `pnpm install` y `mapcli`; del PR, solo datos con git. El token va como cabecera de un único `git fetch`, con `persist-credentials: false` (`setup-node` y `pnpm` lo reciben por su cuenta) | `contents: read` (en un fork, solo lectura igual); sin secretos |
  | `map-pr-comment` / `pending` | `workflow_run` `requested` | `prcomment.ts --pending` de la rama por defecto (checkout `sparse`, sin credenciales); no descarga nada | `actions: read`, `contents: read`, `pull-requests: write`, `statuses: write` |
  | `map-pr-comment` / `comment` | `workflow_run` `completed`, salvo `cancelled` y `action_required` | `prcomment.ts` y `MAINTAINERS` de la rama por defecto; el artefacto `map-pr-report` va a `runner.temp` (fuera del checkout) y se trata como dato | `actions: read`, `checks: read`, `contents: read`, `pull-requests: write`, `statuses: write` |
  | `map-pr-comment` (nivel workflow) | — | — | `permissions: {}` |
  | `ci.yml` (todos los jobs) | `pull_request`, `push` a `main`, `workflow_dispatch` | el del PR | `contents: read`; sin secretos |
  | `images.yml` / `image` | `pull_request` (por rutas), `push` a `main` y tags, `workflow_dispatch` | el del PR | `packages: write`: solo lectura en un fork; en una rama del repo es escritura junto al código del PR (sus autores ya tienen Write). El login a ghcr con `secrets.GITHUB_TOKEN` solo corre si publica, nunca en un PR |
  | `images.yml` (los demás jobs) | igual | el del PR | `contents: read` |
  | `release-desktop.yml` / `check` | solo `push` de tags `desktop-v*` | el del tag | `contents: read`; ningún PR lo dispara |
  | `release-desktop.yml` / `build` | igual | el del tag | `contents: write` y `secrets.GITHUB_TOKEN` para `tauri-action`; ningún PR lo dispara |

  El token con escritura nunca hace checkout del PR (el checkout es `sparse` de la rama
  por defecto, con `persist-credentials: false`), no instala nada y no ejecuta nada del
  PR. El zip del reporte se descomprime en `runner.temp`, así que no puede pisar
  `prcomment.ts` ni `MAINTAINERS` antes de que corran. Los campos `head_*` del evento los
  elige el autor del PR: llegan a `prcomment.ts` solo como variables de entorno y se
  validan con regex antes de usarse en una ruta de la API. **Qué puede hacer ese token si
  algo sale mal:** `pull-requests: write` alcanza para comentar, pero también para editar
  el título y el cuerpo de cualquier PR, cerrarlos y, si está activo "Allow GitHub
  Actions to create and approve pull requests" (Settings → Actions → General), aprobarlos:
  ese ajuste tiene que quedar **apagado**. `statuses: write` sirve para cualquier commit
  del repo, no solo el del PR. No puede empujar código, tocar workflows ni releases.
  Estas reglas las comprueba `tools/mapcli/src/workflows.test.ts` sobre todos los
  workflows: ninguno usa `pull_request_target`, ningún `run:` tiene una expresión salvo un
  valor de `matrix` o `runner.os`/`arch`/`temp` (ni `github.event.*`, ni outputs de steps
  o jobs), los PR no ven más
  secreto que `GITHUB_TOKEN` (tampoco con `secrets['X']`, `toJSON(secrets)` ni `secrets:
  inherit`), y los `workflow_run` solo tienen esos permisos, ese checkout, la descarga en
  `runner.temp` y actions fijadas por SHA.
- Los topes nunca son silenciosos: el reporte guarda los totales y el comentario dice
  "… y N más".
- Las actions están fijadas por versión exacta. Las de `map-pr-comment` (el único
  workflow con token de escritura que disparan los PR) van por **SHA de commit**, con la
  versión en un comentario (`@11bd719… # v4.2.2`): un tag se puede mover a otro código, un
  SHA no. Para actualizarlas, `git ls-remote https://github.com/actions/checkout
  refs/tags/vX.Y.Z` da el SHA. `release-desktop.yml` (`contents: write`, solo tags) e
  `images.yml` (`packages: write` al publicar) usan todavía tags mayores (`@v4`); ver
  "Pendientes conocidos" en docs/14.
- **Imágenes:** quedan en el artefacto `map-pr-renders` y el comentario enlaza a él (hace
  falta sesión de GitHub para descargarlo). No se suben a servicios externos ni a una rama
  del repo, porque eso pediría `contents: write` en el workflow con token.
- **Límite conocido: ni el job ni el status son a prueba de falsificación; lo que cierra
  `.github/` es `CODEOWNERS`.** En `pull_request`, el YAML de los workflows sale del PR
  (del merge con la base), también desde un fork:
  - un PR que edite `map-pr.yml`, lo renombre (`name: map-pr2`) o lo borre puede falsear
    el job `map-pr / check`, y un job `check` de otro workflow del PR podría ocupar su
    lugar;
  - un PR puede **agregar un workflow con un job `name: map-pr/verdict`** que pase. Ese
    job crea un check run con ese nombre, de la app GitHub Actions, sobre el head del PR.
    La protección de rama busca los checks requeridos **solo por nombre** (status de
    commit y check runs comparten ese espacio), y fijar la fuente a GitHub Actions no los
    distingue: los dos son de esa app. Quien arma el PR elige cuál llega último. Pasa
    también desde un fork: el token de solo lectura no importa, el check run lo crea
    GitHub para el job;
  - cualquiera con permiso de escritura (Write) en el repo puede poner el status a mano
    con la API, o con un workflow en una rama que empuje.
  Lo que lo contiene:
  - el comentario marca como no confiable a todo PR que toque `.github/` (también por
    rename), y el status de un PR así que también cambia `world/` no es `success` salvo
    que el autor sea maintainer. Si el PR no cambia `world/`, el status es `success` (no
    hay mapa que juzgar);
  - el veredicto busca check runs llamados `map-pr/verdict` en el commit: si hay alguno,
    el status es `failure` y el comentario lo avisa con 🚨. No impide nada (el check run
    falso igual puede satisfacer la regla) y no ve uno que se cree después (un job con
    `needs:` de otro lento), pero deja a la vista el caso simple;
  - un push que no produce corrida de `map-pr` deja su commit sin status (bloqueado), y
    uno que la produce pasa el comentario a "pendiente" en cuanto arranca;
  - **`CODEOWNERS` con revisión obligatoria y aprobaciones que caducan** (abajo): ningún
    PR que agregue o cambie un workflow entra sin que un maintainer lo apruebe después
    de su último push. Es el único cierre real, para forks y para ramas del repo.
  El token del check es de lectura, así que el daño no pasa del veredicto.
- **Configuración que hace el dueño del repo** (👤, no la puede hacer la CI):
  - marcar el status **`map-pr/verdict`** como check requerido en la protección de
    `main` **apenas se mezcle este cambio**: hasta entonces, un push que borra o renombra
    `map-pr.yml` deja a la vista el ✅ anterior (solo con el aviso del pie). En la
    protección de rama clásica aparece en la lista después de la primera corrida de
    `map-pr-comment` con este cambio ya en `main`; en un ruleset ("Require status checks
    to pass") se puede escribir el nombre antes. Con "Require branches to be up to date before merging",
    para que un cambio en `main` (cerrar una parcela, quitar un maintainer) obligue a
    recorrer el check. `map-pr / check` puede quedar requerido también, pero solo no
    alcanza: un PR que edita su workflow lo falsea. Una merge queue no sirve tal cual:
    `map-pr` no corre en `merge_group`, así que el commit de la cola nunca tendría el
    status;
  - en la regla del check requerido, fijar la fuente esperada a **GitHub Actions** (la
    app). Eso solo descarta otras integraciones: un job de cualquier workflow con ese
    nombre también es de GitHub Actions (ver "Límite conocido");
  - crear `.github/CODEOWNERS` (no existe todavía) con, por ejemplo, `/.github/ @gfenzor`,
    `/tools/ @gfenzor` y `/packages/ @gfenzor`, y en la protección de `main` activar
    "Require a pull request before merging" con **"Require review from Code Owners"** y
    **"Dismiss stale pull request approvals when new commits are pushed"** (o, en un
    ruleset, "Require approval of the most recent reviewable push"). Sin lo segundo, una
    aprobación dada antes sigue valiendo después de un push que agrega el workflow falso.
    Mientras el dueño sea el único code owner, sus propios PR que tocan esas carpetas
    (nadie puede aprobar su propio PR) se fusionan con el bypass de administrador;
  - dejar **apagado** "Allow GitHub Actions to create and approve pull requests"
    (Settings → Actions → General → Workflow permissions): con eso activo, el token de
    `map-pr-comment` podría aprobar PRs;
  - opcional: "Require approval for all external contributors" (Settings → Actions →
    General → Fork pull request workflows). Así un maintainer ve el PR (y si agrega
    workflows) antes de que corra cualquier workflow de un fork, incluido `map-pr`. Cuesta
    un clic por push de la comunidad;
  - **no hace falta** ninguna política de eventos de Actions: ya no se usa
    `pull_request_target`.
  - Un PR de un maintainer que toca `world/` y además otras cosas tiene `success` si su
    reporte no tiene fallas. Uno de la comunidad así queda en `failure` y, después de
    revisarlo a mano, se fusiona con el bypass de administrador.
  - Si el status de un commit queda en `pending`, no aparece o dice que el reporte es de
    otra base (el job `comment` falló por la API, alguien canceló la corrida de `map-pr`,
    la `concurrency` canceló el job que esperaba, `main` avanzó durante la corrida, o hay
    otro PR abierto hacia `main` con el mismo commit desde otro repo o autor: el log del
    job lo dice), cierra esa copia si la hay y haz que `map-pr` corra de nuevo con una
    corrida **nueva**: edita el título del PR, ciérralo y reábrelo, o empuja (un commit
    vacío sirve). Relanzar desde Actions reusa el id de la corrida: solo sirve para la
    última, y no escribe nada si hay una más nueva del mismo commit (el comentario guarda
    qué corrida lo escribió, y se busca una más nueva).
- Arranque: mientras la base no tenga `tools/mapcli/src/prcheck.ts`, el check se salta y
  lo dice en el resumen. La base es de confianza: un PR no puede quitárselo.

Prueba local, sin GitHub: `make map-pr BASE=main HEAD=<rama>` (reporte y PNG en
`build/map-pr/`, imprime el comentario con `prcomment.ts --dry-run`, que toma los datos de
confianza del propio reporte y por eso es solo una vista previa). Tests:
`packages/map-format/src/patch/plots.test.ts`, `tools/mapcli/src/prcheck.test.ts` (check
y Markdown), `tools/mapcli/src/prcomment.test.ts` (los dos jobs de `map-pr-comment` contra
un GitHub en memoria: qué comentario y qué status escribe cada uno, y cuándo nada) y
`tools/mapcli/src/workflows.test.ts` (las reglas de seguridad de todos los workflows).

### Portal de envío de mapas (T4.5)
Para quien no usa git: el editor (o `mapcli patch create`) exporta un map patch y el sitio
lo manda a revisión. Un moderador lo aprueba o rechaza, y uno aprobado se abre como PR en
este repo, donde corren los checks de siempre (sección anterior). El portal y la cola son
el servidor y el sitio; el PR lo abre el worker `tools/map-pr-worker` (deploy y token en
docs/09, "Worker de PR de mapas").

**Flujo:**
1. El jugador, con sesión, entra a `/maps/submit` (sitio público, `client/src/site/Maps.tsx`;
   si no tiene sesión, el mismo sitio le muestra un login). Sube el `.rpgpatch.json`, pone
   título y descripción, elige con qué personaje se lo acredita y acepta la licencia.
2. El servidor (`httpapi/mapsubmit.go`) chequea el patch como entrada no confiable
   (`server/internal/mappatch`) y lo guarda en `map_submissions` (migración 00010) como
   `pending`, con su `audit_log` (`map_submit`).
3. `/maps/mine` muestra al autor el estado de cada envío y, si se rechazó, el motivo.
4. Un gm o admin abre `/maps/review` (la cola, por estado), mira el detalle (archivos
   tocados agrupados por isla, tamaño, autor, sha256, descripción), descarga el patch para
   revisarlo con `mapcli patch diff` o en el editor (Importar patch), y lo aprueba o lo
   rechaza con motivo. Cada decisión y cada descarga quedan en `audit_log`
   (`map_approve`, `map_reject`, `map_download`, fuente `web`).
5. Aprobado = `approved`. El worker lo toma de la cola de la base (contrato abajo) y lo
   deja en `pr_opened` (con la URL) o `failed` (con un código fijo).

**El worker** (`tools/map-pr-worker`, Node; reutiliza `packages/map-format`, nunca un merge
propio):
- Lee la rama base **actual** con la API de contenidos de GitHub y mezcla cada archivo del
  patch con `mergePatchFile` (el mismo merge de tres vías que `mapcli patch apply`, con la
  `base_text` del patch como base). Escribe el resultado con la API Git Data (árbol sobre
  el de la base con el texto de los archivos en el mismo pedido, commit con la base como
  padre, rama `map-submission/<id>-<sha12>`): sin `git clone` ni nada que ejecutar en el
  contenedor. Un PR o una rama que ya existen solo se reusan si llevan la marca o los
  trailers de ese envío.
- Vuelve a chequear todo lo que importa, sin confiar en el servidor: `parsePatch`, solo
  formato 2, y cada ruta tiene que ser un archivo de mapa de `world/` (`writablePath`).
  También repite el chequeo de **parcelas** contra las zonas de la base (`checkPlots`):
  el portal es para cambios dentro de `community_plot`, y el autor del PR es el token del
  worker, no el jugador. Cualquier hallazgo, también un portal entre islas
  (`cross_island`), termina en la falla `outside_plot`. El worker se niega a correr con el
  token del dueño del repo o de alguien de `MAINTAINERS` (docs/09: una cuenta de bot
  colaboradora con un PAT clásico `public_repo`).
- **Crédito:** el mismo commit agrega a `world/CONTRIBUTORS.md` una fila
  `| <personaje> | <islas> | envío n.º <id> | <fecha de aprobación> |`. Es el archivo que
  `PLOT_FREE_FILES` deja tocar a cualquiera. Va el número de envío y no el del PR porque
  el PR todavía no existe cuando se escribe el commit. Dos PR del portal abiertos a la vez
  agregan filas al final del mismo archivo: el segundo en mergearse tiene un conflicto de
  una línea que se resuelve con "Resolve conflicts" en GitHub.
- **El PR** se titula `map: <título> (envío n.º <id>)`, con `#`, `@` y `GH-` del título
  neutralizados (no cierra issues ni menciona a nadie), y su cuerpo dice autor (personaje),
  licencia, islas, archivos y sha256 del patch, y lleva la descripción del autor dentro de
  un bloque de código con un cerco más largo que cualquier secuencia de backticks: no se
  renderiza como Markdown, y sus `@menciones` o `#referencias` no avisan a nadie. Nunca el
  email ni nada interno.
- **Fallas** (`failure`, las ve el autor en "Mis envíos"): `conflict`, `outside_plot`,
  `invalid_patch`, `no_changes` y `github`. Un error de red o de GitHub reintenta con
  espera creciente y, después de 10 intentos, pasa a `github`.

**Qué chequea el servidor (y qué no).** Es una primera barrera barata, no la validación
del mapa: el merge, los esquemas, las parcelas `community_plot` y el validador los corre
el check del PR (`mapcli pr-check`) con el mismo código TS de siempre. `mappatch.Validate`:
- tamaño (`-map-submit-max-bytes`, 2 MiB, muy por debajo de los 32 MB de `parsePatch`) y
  hasta 256 archivos;
- UTF-8 válido, un solo valor JSON, sin claves repetidas (Go y JS se quedarían con copias
  distintas), sin campos desconocidos (comparados byte a byte: `encoding/json` ignora
  mayúsculas) y a lo sumo 8 niveles;
- `kind: "rpg-map-patch"` y **solo formato 2** (la base viaja en el patch; el worker no
  tiene que buscarla en git);
- `base_ref` con la misma regex que `parsePatch`; las rutas, con la misma lista que
  `patchPath` (el fixture `packages/map-format/src/patch/testdata/paths.json` lo leen los
  tests de los dos lados, así no se separan);
- `base` (`sha256:<hex>` o `null`), `base_text` obligatorio con base y con su hash
  correcto, `content` string o `null`, nunca los dos `null`, y sin archivos sin cambios;
- los caracteres prohibidos de los mapas (`FORBIDDEN_CHARS`) en `content` y `base_text`,
  más U+FFFD: es lo que el decodificador de Go hace de un `\ud800` suelto que JS
  conservaría. Los escapes YAML (`"\x7f"`) los rechaza después `parsePatch`.
El error es un código fijo (`site.maps.patch_error.<código>` en el sitio) y, a lo sumo, el
índice del archivo: nunca texto del patch. El patch se guarda tal cual (sha256 de esos
bytes) y nunca se ejecuta ni se interpreta fuera de estos chequeos.

**Retención.** Los bytes del patch de un envío `rejected`, `pr_opened` o `failed` se borran
30 días después de su último cambio (`-map-patch-retention`; job horario del servidor).
Quedan el sha256, los archivos tocados y el resto de los datos, y la descarga responde
`410`. Un envío `pending` o `approved` nunca pierde su patch.

**Límites y abuso.** 3 envíos guardados por cuenta en 24 h (`-map-submit-per-day`, contado
en la misma transacción con la cuenta bloqueada `FOR UPDATE`), cuentas de al menos 24 h
(`-map-submit-min-account-age`), 5 intentos por minuto por cuenta, 2 chequeos a la vez, y
el mismo patch de una cuenta no puede estar dos veces pendiente. Una cuenta baneada o
deshabilitada no envía. La memoria tiene un tope antes de leer cualquier cuerpo: 4 subidas
en curso a la vez (el resto, `503`), 30 s por subida y un solo buffer por cuerpo (≈ 40 MiB
como máximo; detalle en docs/05 y docs/07). Las descargas del patch tienen su propio
límite por cuenta y 2 lugares.

**Licencia (decisión, a confirmar por el dueño del repo).** Ni `docs/00` ni
`world/CONTRIBUTORS.md` fijaban una. El checkbox acepta **CC BY 4.0**
(`httpapi.MapLicense = "cc-by-4.0"`): la misma familia que el arte (`assets/CREDITS.md`),
permite usar y modificar el mapa con atribución, y la atribución es justamente la fila de
`world/CONTRIBUTORS.md` y el crédito del PR. Cada envío guarda el id de la licencia que su
autor aceptó; cambiarla es un id nuevo, no reescribir los viejos. El crédito es siempre el
nombre del personaje elegido, nunca el email.

**Moderación.** Solo gm y admin (rol de `accounts`, que asigna `gameserver admin set-role`),
leído en cada pedido y otra vez dentro de la transacción de la decisión. Un player que
conoce las URLs recibe `403` en la cola y en la decisión, y `404` en el detalle y la
descarga de envíos ajenos. Un moderador no decide sobre su propio envío
(`own_submission`): lo revisa otro, así nadie manda su patch directo al worker. Los
intentos de un player contra la API de moderación van al log del servidor, no a
`audit_log` (que no se llene con ruido de una cuenta cualquiera). Los gm y admin conectados
reciben en el juego un aviso con el número y el título de cada envío nuevo, agrupado si
llegan muchos seguidos (docs/05, "Envío de mapas").

**Contrato con el worker (PR 2/2).** La cola es la tabla, y ninguna transacción queda
abierta mientras se habla con GitHub:
1. **Reservar**, en una transacción corta: el aprobado más viejo que toque,
   `SELECT … FROM map_submissions WHERE status = 'approved' AND (next_attempt_at IS NULL OR
   next_attempt_at <= now) ORDER BY reviewed_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`
   (índice parcial `map_submissions_approved_idx`); se le suma `attempts + 1` y
   `next_attempt_at = now + lease` (minutos), y se confirma. El lease aleja a otros
   workers; si el worker muere, vence solo.
2. **Trabajar** sin transacción. Es idempotente por construcción: la rama es siempre
   `map-submission/<id>-<sha12>`, y un PR desde esa rama con la marca
   `<!-- rpg-map-submission: <id> sha256:<sha> -->` se reusa (también uno abierto a mano
   siguiendo la página de moderación), nunca se abre otro. Un reinicio a mitad de camino no
   duplica nada; antes de un `failed`/`github` final se vuelve a buscar el PR.
3. **Cerrar**, en otra transacción corta con `status = 'approved'` como guarda: `pr_opened`
   (`pr_url`, `pr_number`) o `failed` (`failure`, un código `[a-z_]` fijo, nunca un
   mensaje de GitHub o del merge). Un error reintentable lo deja `approved` con espera
   creciente; un rate limit o un rechazo de configuración pausan todo el worker y devuelven
   el intento (`attempts - 1`).
La tabla exige `pr_url` y `pr_number` en `pr_opened`, `failure` en `failed` y `reason` en
`rejected`.

## Flujo recomendado para que una IA construya una zona
1. `map_info` y `content_search` para saber qué hay disponible.
2. Generar base: `mapcli generate` (forma de isla, costas, ríos con semilla) o pintar
   a mano con `paint_ground` en rectángulos.
3. `autoborder`, luego `scatter` para vegetación y rocas.
4. Colocar estructuras con `stamp` y prefabs.
5. Spawns, NPCs, zonas, portales (cada uno con el item que lo muestra en su entrada).
6. `map_validate` hasta que no haya errores, y lee las advertencias: p. ej. desde el
   destino de un `hole` o un `teleport` no se llega a ningún templo sin soga (bien para un
   pozo, un error si fue sin querer; `03-world-and-maps.md`, "Validación").
7. `map_render` de cada área tocada y revisar las imágenes.
8. `map_patch_create` y abrir PR. Fuera de una parcela `community_plot` hace falta un
   maintainer (ver "PR de mapas en CI").

## Editor web — funciones por hito
**Hito 1 (rebanada vertical):** abrir una isla, navegar, zoom, cambiar de piso, pincel de
suelo, colocar/quitar item, borrador, deshacer/rehacer, guardar chunks, validación en
vivo, paleta con búsqueda.

Implementación (T1.14): `editor/` (Vite + Preact + PixiJS, renderer de
`packages/renderer`). Las ops corren en el navegador; un servidor local de desarrollo
(plugin de Vite, `editor/server/`) solo lee `world/` y `data/`, guarda y valida con
`map-format`, porque los archivos y el validador viven en disco. `make editor` lo levanta
en http://localhost:5174 y edita `world/` del repo en el lugar.
- Guardar escribe los mismos bytes que `mapcli fmt` (test en `editor/server/store.test.ts`
  y en el E2E), y **solo los chunks que el editor tocó** (`applyOps` devuelve `touched`).
  Cada archivo viaja con el hash que tenía al abrirse (`base`, enviado en el bootstrap); si
  en disco ya no coincide (git pull, `mapcli`, otra pestaña) o el archivo no cargó, no se
  guarda nada y la UI muestra el conflicto (409). Los archivos que el editor no tocó nunca
  se escriben ni se borran. `island.yaml` y los auxiliares no se editan en el hito 1 (los
  auxiliares sí desde T2.2, ver abajo).
- Seguridad del backend local: toda llamada a `/api` exige la cabecera `x-rpg-editor`
  (una web de otro sitio no puede mandarla sin un preflight CORS que el servidor nunca
  aprueba), `Origin`/`Sec-Fetch-Site` del mismo origen y cuerpo JSON. Guardar solo acepta
  rutas `world/islands/<id>/chunks/zNN/cXXXX_YYYY.json` de islas listadas en `world.yaml`
  en disco, verifica que la ruta resuelta quede dentro de esa isla y que el chunk pase el
  esquema antes de escribir.
  El servidor de desarrollo tiene CORS apagado (`cors: false`: ninguna otra página, ni
  siquiera de otro puerto de localhost, consigue aprobar el preflight) y `/@fs/` solo
  sirve `editor/`, `packages/` y `node_modules/`.
- Guardado en dos fases: primero escribe cada chunk a un temporal junto al destino (si
  falla, los borra y no cambió nada); después renombra. Si un renombre falla a mitad, la
  respuesta (500) incluye lo que sí quedó en disco y el editor avanza esas bases, así el
  siguiente guardado no choca con su propia escritura.
- Validación en vivo: tras cada cambio (300 ms de espera) el servidor corre
  `validateLoaded(world, content)` de map-format sobre el mundo en memoria (las mismas
  reglas que `validateWorld`, menos las de archivos en disco), con las líneas YAML del disco.
- Pendiente para un hito posterior: el editor público y estático para la comunidad
  (`docs/00-vision.md`) no tendrá este backend. Tendrá que validar en el navegador
  (map-format sin Node: esquemas empaquetados, contenido enviado como datos) y guardar
  como map patch descargable o por la API del servidor, no escribiendo `world/`.
- Isla: selector en la barra y `?island=<id>` en la URL (centra en su templo). Al salir
  con cambios sin guardar, el navegador pide confirmación.
- Atajos implementados: `B` pincel, `I` item, `E` borrador, `PgUp/PgDn` piso, rueda = zoom,
  espacio + arrastrar o botón central = mover, `Ctrl+Z` / `Ctrl+Y` (o `Ctrl+Shift+Z`),
  `Ctrl+S`. Clic derecho o Mayús+clic con la herramienta Item quita el item de arriba.
  Los atajos se ignoran solo mientras se escribe texto (no con un checkbox o select en foco).
- Puertas y llaves (`02-game-design.md` "Puertas con llave"): la paleta y el panel de la
  casilla dicen de cada puerta si está cerrada sin llave, abierta o con llave (y su id de
  llave), y de cada llave el id que abre. Solo se muestra: la llave es del tipo de item
  (`data/items`), no de la casilla, así que una puerta con otra llave es otro par de items
  de la paleta. Se coloca como cualquier item (`place_item`).

**Hito 2:** relleno, rectángulo, selección + copiar/pegar, autoborder automático al
pintar, spawns, NPCs, zonas y portales con su panel, exportar/importar patch, vista de
diff antes/después.

Implementación (T2.2, editor v2). Las herramientas solo arman ops de map-format
(`editor/src/tools/tools.ts`); aplicar, deshacer, validar y guardar es igual para todas:
- **Relleno** (`G`): un clic genera la op `fill` con el suelo elegido.
- **Rectángulo** (`R`): arrastrar muestra el rectángulo y al soltar aplica `paint_ground`
  con `rect` (recortado a cada isla del piso); con clic derecho o Mayús borra con `erase`
  en la capa del borrador. Una entrada de historial por arrastre.
- **Selección** (`V`): arrastrar marca un rectángulo del piso actual. `Ctrl+C` copia suelo
  y pila de items de cada casilla; `Ctrl+X` copia y borra todas las capas; `Supr` borra (capa del
  borrador); `Esc` cancela. `Ctrl+V` (o el botón Pegar) entra en modo pegar: la vista
  previa sigue al mouse y el clic pega con la esquina superior izquierda en esa casilla,
  **en el piso actual** (así se copia entre pisos e islas). Pegar = `paint_ground` por
  suelo + `erase` de items + `place_item` en orden: cada casilla copiada reemplaza el
  suelo (si tenía) y la pila completa del destino; las casillas vacías no se pegan y lo
  que cae fuera de las islas se descarta. Con autoborde activo, pegar recalcula también
  los bordes de toda el área pegada (la pila copiada puede traer bordes del origen).
- **Autoborder automático** (casilla "Autoborde" en la barra, activa por defecto): tras
  cada cambio de suelo (pincel, relleno, rectángulo, borrador, pegar) el editor agrega
  una op `autoborder` sobre el rectángulo de las casillas cuyo suelo cambió (las lista
  la inversa) más un borde de 1, recortado a las islas, con la escalera de
  `data/borders.yaml` que manda el bootstrap. Va en la misma entrada de historial;
  deshacer usa la inversa primitiva y rehacer vuelve a correr la op con las reglas.
- **Paneles de entidades** (derecha): pestañas spawns / NPCs / zonas / portales de la
  isla actual, lista (clic = seleccionar y centrar), Nuevo, Borrar y un formulario.
  Crear = `add_spawn`/`place_npc`/`add_zone`/`add_portal`; editar = `remove_*` + `add_*`
  en una sola entrada de historial, con el mismo `index` si sigue en la misma isla (el
  archivo no cambia de orden); borrar = `remove_*`. Las ops validan IDs, monstruos y
  NPCs conocidos (bootstrap manda los IDs de `data/monsters` y `data/npcs`); antes, el editor revisa los
  errores típicos del formulario (ID snake_case y único, campos requeridos, posiciones y
  rects dentro de una isla con ese piso) con mensajes i18n (`editor.entity.err.*`); si aun
  así la op rechaza, su error sale en la barra de estado y no cambia nada. El botón ⌖ toma la próxima
  casilla clicada en el mapa; "Usar la selección" pone el rect de la zona. El canvas
  dibuja zonas, spawns (radio), NPCs y portales del piso con los colores de `mapcli
  render`. `texts.yaml` todavía no se edita.
- Guardar: los YAML auxiliares tocados (`touchedAux`) viajan con su hash base igual que los
  chunks (el bootstrap envía la base de `spawns/npcs/zones/portals.yaml`), así que un
  cambio en disco da conflicto 409. El backend acepta solo
  `world/islands/<id>/(spawns|npcs|zones|portals).yaml` de islas de `world.yaml` (nunca
  `island.yaml`, `texts.yaml` ni `world.yaml`), comprueba que la ruta quede dentro de la
  isla, escribe `formatYaml(lista)` (los mismos bytes que `mapcli fmt`), comprueba que ese
  texto pase el esquema del archivo antes de escribir y borra el archivo si la lista quedó
  vacía (como `saveApplied`). Tests en `editor/server/store.test.ts`.
- Atajos nuevos: `G`, `R`, `V`, `Ctrl+C/X/V`, `Supr`, `Esc`.

Implementación (T2.3, map patches en el editor). Botón "Revisar cambios" en la barra →
panel de revisión (`editor/src/review/`):
- **Línea base** = el mundo tal como se cargó del disco al abrir el editor (no avanza al
  guardar). Contra ella se calculan el diff y el patch exportado.
- **Exportar patch**: el navegador calcula con `diffWorlds` los chunks y listas que
  cambiaron y los manda con los dos mundos a `POST /api/patch/export`. El backend arma el
  texto canónico de cada versión con las mismas comprobaciones que guardar y devuelve un
  formato 2 con `base_ref: "editor"`. Se descarga como `<isla>.rpgpatch.json` y no se
  escribe nada en `world/`.
- **Importar patch**: el archivo (máx. 32 MB) va a `POST /api/patch/parse`, que corre
  `parsePatch` y además rechaza lo que el editor no edita (`world.yaml`, `island.yaml`,
  `texts.yaml`, prefabs e islas que no están en `world.yaml`): eso se aplica con
  `mapcli`. El navegador hace el merge contra el mundo en memoria con las mismas
  funciones (`mergeChunk`/`mergeList`) y lo convierte en ops (`chunkSyncOps`/
  `listSyncOps`). Una entrada nueva o cambiada que cae fuera de la isla de su archivo
  (rect y pisos; en zonas, todos los rects) es conflicto de archivo, porque las ops de
  entidades eligen la isla por la posición. Se aplica como una sola entrada de historial (un `Ctrl+Z` la deshace),
  sin autoborde automático, porque el patch trae sus propios bordes. Los archivos quedan
  pendientes de guardar como cualquier edición. Si hay conflictos no se aplica nada: el
  panel los lista (casilla, entrada o archivo; clic = ir) y el canvas marca en rojo las
  casillas en conflicto. Un patch con formato 1 usa como base el archivo en disco si su
  hash coincide.
- **Vista de diff**: lista de chunks cambiados (casillas por chunk) y de entradas
  agregadas, quitadas o cambiadas por lista. Clic = centrar en el cambio (piso incluido).
  El canvas marca las casillas cambiadas del piso en magenta. "Antes/Después" alterna el
  canvas entre la línea base y el mundo actual. En "Antes" nada edita el mundo oculto
  (`readOnly()` en herramientas, Supr, cortar, pegar, paneles y deshacer/rehacer); importar
  desde "Antes" pasa primero a "Después".
- Tests: `editor/src/state/editor.test.ts` (exportar, importar con merge y deshacer,
  conflicto, patch rechazado, vista "Antes"), `editor/server/store.test.ts` (round-trip
  con `mapcli patch apply`, rutas maliciosas, formato 1) y el E2E "map patches", que
  exporta, alterna antes/después, importa con y sin conflicto e intenta un patch
  malicioso.

**Casas (T5.4).** `houses.yaml` (formato en `03-world-and-maps.md`) se edita con las ops
`add_house`/`set_house`/`remove_house` y nunca entra en map patches (la ruta no es
parcheable: un PR que lo cambia es de maintainer). `mapcli validate`/`fmt`, el MCP
`map_validate` y el editor la cargan y validan (`validateWorld`); `mapcli info` y
`map_info` listan cada casa con su tamaño, alquiler y salida. Prefabs de casas:
`house_wood_small` y `house_wood_medium`.
- **mapcli:** `mapcli house add <isla> --id ID --floor Z --rects x,y,w,h[;x,y,w,h...]
  --doors x,y,z[;x,y,z...] --exit x,y,z --rent N [--notes TEXTO]`, `mapcli house set <isla>
  --id ID [...]` (solo los campos dados; `--notes ""` las quita) y `mapcli house remove
  <isla> --id ID`. El MCP las aplica con `map_apply_ops`. Ninguno escribe el nombre: la
  clave `house.<id>.name` va a mano en `i18n/{es,en}/world.yaml`, y la validación de la
  salida la reporta mientras falte.

**Casas en el editor.** Panel "Casas de la isla" (`src/ui/HousePanel.tsx`) y herramienta
Casa (`H`). La lógica pura es `src/houses/draft.ts` (borrador → casa) sobre
`map-format/src/houses.ts`; el controlador guarda el borrador en su estado y el canvas lo
dibuja (relleno violeta con los rects que va a tener, puertas en amarillo, salida en verde).
- **Lista:** las casas de la isla actual con su tamaño; clic = abrirla y centrar la vista.
  Con la herramienta Casa y sin borrador, un clic sobre una casa la abre.
- **Nueva casa:** abre un borrador con un id libre (`<isla>_house_<n>`) y elige la
  herramienta Casa. Modos en el mapa: **Casillas** (arrastrar agrega el rectángulo; clic
  derecho o Mayús lo quita; las casillas fuera de toda isla no entran), **Puertas** (clic
  pone o quita una puerta; clic derecho solo quita) y **Salida** (clic la pone; clic
  derecho la borra). "Agregar la selección" suma el área de la herramienta Selección. Los
  `rects` del YAML salen de las casillas (`tilesToRects`: por piso, de arriba abajo y de
  izquierda a derecha, cada rect crece a la derecha y después hacia abajo), así que nunca se
  escriben a mano; una casa dibujada como sala + umbral da los mismos dos rects que las
  casas hechas a mano.
- **Formulario:** id (editable solo mientras la casa es nueva: es la clave de su dueño en
  la base), nombre en cada idioma (`house.<id>.name`, una línea de hasta 80 caracteres sin
  llaves), alquiler por período en cobre y notas.
- **Problemas en vivo** (`houseIssues`, clic = ir a la casilla): id inválido o repetido,
  alquiler, sin casillas, más de 16 rects o un lado de más de 255, casillas fuera de la isla
  o en dos islas, casillas de otra casa, sin puertas o más de 8, puerta fuera de la casa o
  que no está en su borde, salida que falta, fuera de la isla, dentro de una casa o lejos de
  una puerta, nombre que falta. Advertencias (no impiden aplicar): casillas de un piso que no
  forman un solo bloque y casillas sin suelo. Lo que depende de los items (caminable,
  alcanzable desde el templo, salida sobre una puerta, NPCs adentro) lo sigue diciendo el
  panel de validación.
- **Aplicar** convierte el borrador en una sola entrada de historial (`add_house` o
  `set_house`; `Ctrl+Z` la deshace) y se niega con el primer error en la barra de estado.
  "Borrar casa" es `remove_house` (también deshacible); su nombre queda en `world.yaml`.
- **Guardar** escribe `houses.yaml` (mismo texto canónico que `mapcli fmt`, revisado contra
  su hash como cualquier archivo) y los nombres cambiados en `i18n/<idioma>/world.yaml`:
  solo claves `house.<id>.name`, reemplazando su línea o agregándola después del último
  nombre de casa, sin tocar comentarios ni el resto. Cada nombre lleva el texto que tenía al
  cargar: si en disco cambió, es conflicto y no se guarda nada. Hasta guardarlos, la
  validación en vivo da por presentes los nombres nuevos (`pendingKeys` de
  `/api/validate`). Exportar un patch no lleva casas ni nombres (la barra de estado lo
  avisa).
- Tests: `editor/src/houses/draft.test.ts`, `editor/src/state/editor.test.ts` ("house
  panel"), `editor/server/store.test.ts` (houses.yaml y nombres, conflictos, textos
  rechazados) y el E2E "houses", que dibuja una casa con errores a la vista, la aplica,
  prueba una superpuesta, guarda y compara los archivos.

**Hito 4–5:** prefabs, generación procedural desde el editor, envío de patch a revisión
con cuenta, cola de moderación, comentarios por casilla.

## Experiencia de usuario del editor
- Atajos tipo editores de mapas clásicos: `B` pincel, `E` borrador, `G` relleno,
  `R` rectángulo, `V` selección, `H` casa, `PgUp/PgDn` piso, rueda = zoom, espacio +
  arrastrar = mover.
- Panel de validación siempre visible; click en un error lleva a la casilla.
- Previsualización de la vista del jugador (rectángulos de 15x11 y 31x21: la vista
  mínima, la de un teléfono o una ventana chica, y la entera, a la que se llega alejando;
  por defecto cada cliente ve la mayor que llena su pantalla, p. ej. 24x16 a 1920x1080,
  `02-game-design.md` "La vista") para revisar composición.
