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
| `map_patch_create` | Genera un `.rpgpatch.json` con los cambios actuales |

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

Map patch mínimo (`mapcli patch`, formato 1):
`{ format: 1, kind: "rpg-map-patch", base_ref, files: [{ path, base, content }] }`, con
`base` = `sha256:<hex>` de la versión base (o `null` si el patch crea el archivo) y
`content` = texto nuevo (o `null` si lo borra). Solo admite rutas de mapas de `world/`
(`world.yaml`, archivos de islas, chunks, prefabs). `create` toma los cambios del árbol de
trabajo contra un ref de git; `apply` escribe todo o nada y solo si cada base coincide (si
no, lista los conflictos); `diff` resume casillas cambiadas por chunk y entradas
agregadas/quitadas/cambiadas por YAML. Pendiente: merge a nivel de casilla.

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
  y pila de items de cada casilla; `Ctrl+X` copia y borra; `Supr` borra (capa del
  borrador); `Esc` cancela. `Ctrl+V` (o el botón Pegar) entra en modo pegar: la vista
  previa sigue al mouse y el clic pega con la esquina superior izquierda en esa casilla,
  **en el piso actual** (así se copia entre pisos e islas). Pegar = `paint_ground` por
  suelo + `erase` de items + `place_item` en orden: cada casilla copiada reemplaza el
  suelo (si tenía) y la pila completa del destino; las casillas vacías no se pegan y lo
  que cae fuera de las islas se descarta.
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
  NPCs conocidos (bootstrap manda los IDs de `data/monsters` y `data/npcs`); si rechazan,
  el error sale en la barra de estado y no cambia nada. El botón ⌖ toma la próxima
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

**Hito 4–5:** prefabs, generación procedural desde el editor, envío de patch a revisión
con cuenta, cola de moderación, comentarios por casilla.

## Experiencia de usuario del editor
- Atajos tipo editores de mapas clásicos: `B` pincel, `E` borrador, `G` relleno,
  `R` rectángulo, `V` selección, `PgUp/PgDn` piso, rueda = zoom, espacio + arrastrar = mover.
- Panel de validación siempre visible; click en un error lleva a la casilla.
- Previsualización de la vista del jugador (rectángulo 15x11) para revisar composición.
