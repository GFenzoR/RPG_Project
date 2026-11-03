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
  `spawns`/`zones`/`portals`/`npcs`). `saveApplied(root, world, result)` escribe solo esos
  archivos (temporal + rename) y borra los que quedaron vacíos.
- `OpOptions` inyecta lo que vive en disco, para que el módulo siga sin Node: `itemKind`,
  `monsterKnown`, `npcKnown`, `borders` (reglas de `data/borders.yaml`, las necesita
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
| `place_npc` / `remove_npc` | `pos`, `npc` | |
| `add_portal` / `remove_portal` | campos de portals.yaml | |
| `stamp` | `pos`, `prefab` | Coloca un prefab (casa, muelle, templo) de `world/prefabs/` |

Detalle de las ops de T1.15 (las inversas se expresan siempre con ops primitivas):
- `fill`: inundación en 4 direcciones dentro del rectángulo de la isla de `pos`; también
  rellena casillas vacías.
- `autoborder`: en cada casilla del rect quita las piezas de borde que tenga (cualquier
  pieza de `data/borders.yaml`) y apila abajo las que tocan, en orden de `priority`; lo
  demás de la pila queda encima. Repetirlo no cambia nada. Nombres de pieza en `06`.
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
| `content_search` | Busca en `data/` (items, monstruos, NPCs) por texto o etiqueta |
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
de `tools/spritepack` armado en memoria (no hace falta `make sprites`). Agrega reglas con
coordenadas absolutas, grilla y overlays: zonas (cian protección, naranja no_logout, rojo
pvp, verde no_pvp, violeta community_plot), spawns (anillo rojo del radio), NPCs (rombo
amarillo), portales (cuadro magenta; triángulo abajo = baja, arriba = sube), carteles
(cuadrito blanco) y templo (cruz blanca). Máximo 256x256 casillas; 4/8/16/32 px por casilla.

### Map patches
Formato (`.rpgpatch.json`, formato 2 desde T2.3):
`{ format: 2, kind: "rpg-map-patch", base_ref, files: [{ path, base, base_text?, content }] }`.
`base` = `sha256:<hex>` de la versión base (o `null` si el patch crea el archivo),
`base_text` = el texto de esa base (obligatorio en formato 2 cuando `base` no es `null`),
`content` = texto nuevo (o `null` si lo borra). `base_ref` es el ref de git contra el que se
hizo (`mapcli`, MCP) o `"editor"`. El formato 1 (T1.15, sin `base_text`) se sigue leyendo.

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

`mapcli patch`:
- `create [isla] [--against REF] [--out FILE]`: los archivos de mapa que difieren del ref,
  en formato 2.
- `apply <file> [--dry-run] [--partial]`: hace el merge de cada archivo contra el disco.
  Es todo o nada: si hay conflictos no escribe nada, sale con código 1 y los lista como
  `{ path, reason, at: ["x,y,z" | id] }` (las primeras 100 casillas o entradas). Con
  `--partial` escribe todo lo demás y en las casillas o entradas en conflicto conserva la
  versión actual. La salida dice qué archivos se mezclaron (`merged`) y el resultado del
  validador.
- `diff <file>`: casillas cambiadas y bbox por chunk; entradas agregadas, quitadas y
  cambiadas por YAML; `base_matches` y, si la base no coincide, cuántos conflictos daría.
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

## Flujo recomendado para que una IA construya una zona
1. `map_info` y `content_search` para saber qué hay disponible.
2. Generar base: `mapcli generate` (forma de isla, costas, ríos con semilla) o pintar
   a mano con `paint_ground` en rectángulos.
3. `autoborder`, luego `scatter` para vegetación y rocas.
4. Colocar estructuras con `stamp` y prefabs.
5. Spawns, NPCs, zonas, portales.
6. `map_validate` hasta que no haya errores.
7. `map_render` de cada área tocada y revisar las imágenes.
8. `map_patch_create` y abrir PR.

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
  la inversa) más un borde de 1, recortado a las islas, con las reglas de
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
  `listSyncOps`). Se aplica como una sola entrada de historial (un `Ctrl+Z` la deshace),
  sin autoborde automático, porque el patch trae sus propios bordes. Los archivos quedan
  pendientes de guardar como cualquier edición. Si hay conflictos no se aplica nada: el
  panel los lista (casilla, entrada o archivo; clic = ir) y el canvas marca en rojo las
  casillas en conflicto. Un patch con formato 1 usa como base el archivo en disco si su
  hash coincide.
- **Vista de diff**: lista de chunks cambiados (casillas por chunk) y de entradas
  agregadas, quitadas o cambiadas por lista. Clic = centrar en el cambio (piso incluido).
  El canvas marca las casillas cambiadas del piso en magenta. "Antes/Después" alterna el
  canvas entre la línea base y el mundo actual. En "Antes" el mapa es solo de lectura.
- Tests: `editor/src/state/editor.test.ts` (exportar, importar con merge y deshacer,
  conflicto, patch rechazado, vista "Antes"), `editor/server/store.test.ts` (round-trip
  con `mapcli patch apply`, rutas maliciosas, formato 1) y el E2E "map patches", que
  exporta, alterna antes/después, importa con y sin conflicto e intenta un patch
  malicioso.

**Hito 4–5:** prefabs, generación procedural desde el editor, envío de patch a revisión
con cuenta, cola de moderación, comentarios por casilla.

## Experiencia de usuario del editor
- Atajos tipo editores de mapas clásicos: `B` pincel, `E` borrador, `G` relleno,
  `R` rectángulo, `V` selección, `PgUp/PgDn` piso, rueda = zoom, espacio + arrastrar = mover.
- Panel de validación siempre visible; click en un error lleva a la casilla.
- Previsualización de la vista del jugador (rectángulo 15x11) para revisar composición.
