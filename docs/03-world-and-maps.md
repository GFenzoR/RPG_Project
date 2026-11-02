# 03 — Mundo y formato de mapas

## Coordenadas
- Un único espacio de coordenadas global: `x, y ∈ [0, 65535]`, `z ∈ [0, 15]`.
- Piso **7 = nivel del mar**. Números menores = más alto (6, 5, 4…), mayores =
  subterráneo (8, 9…). Igual convención que Tibia, porque facilita pensar el mapa.
- Las islas ocupan rectángulos disjuntos del espacio global, separados por mar.
- **Chunk** = 32x32 casillas de un piso. Índice de chunk: `cx = x / 32`, `cy = y / 32`.

## Estructura en disco
```
world/
  world.yaml                     lista de islas y rutas de barco
  islands/
    puerto/
      island.yaml                nombre (clave i18n), rectángulo, pisos usados, templo, nivel sugerido
      chunks/
        z07/
          c0100_0200.json        chunk cx=100, cy=200, piso 7
        z08/...
      spawns.yaml                puntos de aparición de monstruos
      npcs.yaml                  NPCs colocados (referencian data/npcs/)
      zones.yaml                 zonas: protección, no-logout, pvp (futuro), community-plot
      portals.yaml               teletransportes y conexiones especiales
      texts.yaml                 carteles y libros (claves i18n)
```

## Formato de chunk (versión 1)
JSON canónico: claves en orden fijo (`format`, `chunk`, `palette`, `ground`, `items`),
**una fila por línea**, indentación de 2 espacios, salto de línea final.
`mapcli fmt` y el editor siempre escriben exactamente este formato para que los diffs
sean limpios y revisables (implementación única: `packages/map-format/src/chunk.ts`;
ejemplos en `packages/map-format/testdata/golden/`). En el ejemplo, `...` reemplaza las
filas 3–31 (un chunk real siempre tiene las 32).

```json
{
  "format": 1,
  "chunk": { "cx": 100, "cy": 200, "z": 7 },
  "palette": ["grass", "sand", "water_shallow", "border_grass_sand_n", "oak_tree"],
  "ground": [
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,2,2,2,2,2,2,2,2,2],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,2,2,2,2,2,2,2,2,2],
    ...
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,2,2,2,2,2,2,2,2,2]
  ],
  "items": [
    { "x": 16, "y": 0, "stack": [3] },
    { "x": 4, "y": 9, "stack": [4] }
  ]
}
```
- `palette`: IDs de texto de items (`data/items/*.yaml`). El suelo también es un item
  con `kind: ground`. Orden canónico: **orden de primera aparición** (recorriendo
  `ground` fila por fila y luego las pilas de `items`), sin entradas sin usar. Así las
  mismas casillas producen siempre los mismos bytes, las guarde quien las guarde.
- `ground`: matriz 32x32 de índices a `palette`. `-1` = sin tile (vacío, no caminable).
  Solo items `kind: ground`.
- `items`: lista dispersa con coordenadas locales (0–31) y pila de abajo hacia arriba
  (bordes, decoración, objetos). Ordenada por `y`, luego `x`; una entrada por casilla,
  sin pilas vacías, sin items `kind: ground`.
- Nombre de archivo: `chunks/zNN/cXXXX_YYYY.json` (piso con 2 dígitos, `cx`/`cy` con 4);
  debe coincidir con el campo `chunk`.
- Los **bordes** (transición pasto→arena, etc.) se guardan explícitos en la pila. El
  editor y `mapcli` los generan con reglas de `data/borders.yaml` (autoborder), así el
  servidor no calcula nada en runtime.

## IDs de items
- Cada item tiene un ID de texto (`oak_tree`) para humanos e IA, y un ID numérico
  estable para la red y `world.bin`.
- `data/ids.lock.yaml` asigna los numéricos. **Nunca se reutiliza ni se cambia un
  número.** Lo actualiza `make gen-ids`; `make validate` falla si un ID cambió
  (detalle en `06-content-data.md`).

## Archivos auxiliares
Todos opcionales salvo `island.yaml`; una lista vacía equivale a no tener el archivo.
Esquemas en `packages/map-format/schemas/`. Formato canónico (lo escriben `mapcli fmt`,
el editor y el MCP): claves en orden fijo, mapas y listas de escalares en estilo flow
(`{ x: 1, y: 2, z: 7 }`), una línea en blanco entre entradas de primer nivel.
**Los comentarios no se conservan**: usa el campo `notes`.

`island.yaml`:
```yaml
id: puerto
name: island.puerto.name
rect: { x: 3072, y: 6272, w: 512, h: 512 }
floors: [6, 7, 8]
temple: { x: 3230, y: 6400, z: 7 }
level_hint: [1, 15]
```
- `id` = nombre del directorio; `name` es una clave i18n (`i18n/*/world.yaml`).
- `rect` y `level_hint` iguales a los de `world.yaml`. `rect` alineado a chunks: `x`, `y`,
  `w` y `h` múltiplos de 32 (así un chunk pertenece a una sola isla).
- `floors` en orden ascendente; solo esos pisos pueden tener chunks.

`npcs.yaml` (cada NPC de `data/npcs/` se coloca una sola vez en todo el mundo):
```yaml
- npc: harbor_master
  pos: { x: 3230, y: 6420, z: 7 }
```

`texts.yaml` (`kind`: `sign` | `book`; `text` es una clave i18n):
```yaml
- id: puerto_temple_sign
  kind: sign
  pos: { x: 3230, y: 6402, z: 7 }
  text: text.puerto.temple_sign
```

`spawns.yaml`:
```yaml
- id: puerto_wolves_north
  center: { x: 3215, y: 6410, z: 7 }
  radius: 5
  monsters:
    - { monster: wolf, count: 3 }
  respawn_seconds: 60
```

`zones.yaml` (`type`: `protection` | `no_logout` | `pvp` | `no_pvp` | `community_plot`):
```yaml
- id: puerto_town
  type: protection
  floors: [6, 7, 8]
  rects:
    - { x: 3200, y: 6380, w: 60, h: 45 }
```

`portals.yaml` (`kind`: `stairs` | `ladder` | `hole` | `rope_spot` | `teleport` | `boat`;
una escalera necesita su pareja de vuelta, ver "Validación"):
```yaml
- id: mine_entrance
  kind: stairs
  from: { x: 3290, y: 6402, z: 7 }
  to: { x: 3291, y: 6402, z: 8 }

- id: mine_exit
  kind: stairs
  from: { x: 3290, y: 6402, z: 8 }
  to: { x: 3289, y: 6402, z: 7 }
```

## world.yaml
```yaml
format: 1
islands:
  - id: puerto
    rect: { x: 3072, y: 6272, w: 512, h: 512 }
    level_hint: [1, 15]
boat_routes:
  - from_npc: puerto_captain
    to:
      island: bosque
      pos: { x: 4120, y: 6050, z: 7 }
    price: 80
    requires: { level: 10 }
```

## Compilación
`server/cmd/mapcompile` (`make mapcompile`) lee `world/` + `data/items/` +
`data/ids.lock.yaml`, valida lo necesario para compilar, resuelve IDs y escribe
`build/world.bin` (binario compacto: tiles por sector, flags precomputados). El servidor
solo carga `world.bin` (`-world`, por defecto `$RPG_WORLD` o `../build/world.bin` desde
`server/`). El editor y `mapcli` trabajan siempre con el JSON.

La validación completa del mapa (conectividad, spawns, i18n...) sigue siendo la de
`packages/map-format` (`make validate`). `mapcompile` solo rechaza lo que no puede
compilar: rect no alineado o distinto del de `world.yaml`, chunk fuera de la isla o en un
piso no listado, nombre de archivo incoherente, item desconocido o sin ID numérico, IDs
numéricos repetidos en `ids.lock.yaml`, tipo de zona desconocido.

### Flags de tile
Se calculan al compilar, uno por casilla (implementación: `server/internal/world/compile`):

| Flag | Se activa si… |
|---|---|
| `blocks_movement` | No hay suelo (`-1`), el suelo no tiene `ground.walkable: true`, o algún item de la pila tiene `blocks_movement: true`, o es `kind: wall` y **no** declara `blocks_movement: false`. |
| `blocks_sight` | Algún item **de la pila** tiene `blocks_sight: true`. El suelo nunca bloquea la vista. Lo usan la línea de visión y los proyectiles. |
| `protection`, `no_logout`, `pvp`, `no_pvp` | La casilla tiene suelo y cae en un rect de una zona de ese tipo de `zones.yaml`, en uno de sus `floors`. |

`community_plot` no marca ningún flag: solo le importa al editor y a los patches.
La regla de `blocks_movement` es la misma que `isWalkable` de `packages/map-format`:
`make test-parity` (parte de `make test` y de la CI) compara casilla por casilla el
veredicto de `mapcompile` con el de `packages/map-format`.

**Decisión pendiente (usuario): muros y línea de visión.** Hoy `kind: wall` implica
bloquear el paso pero **no** la vista: un muro sin `blocks_sight: true` deja pasar
proyectiles y hechizos. Opciones:
1. `kind: wall` bloquea también la vista salvo `blocks_sight: false` (simétrico con el paso).
2. Mantener la regla actual y que la validación de contenido exija `blocks_sight` explícito
   en todo item `kind: wall`.

Cualquiera de las dos cambia `mapcompile` y `packages/map-format` a la vez. Hasta que se
decida, todo muro nuevo debería declarar `blocks_sight: true`.

### Formato de `world.bin` (versión 1)
Binario little endian. Lo escribe y lee `server/internal/world` (`Encode`/`Decode`). Las
mismas fuentes producen siempre los mismos bytes.

```text
magic        8 bytes "RPGWORLD"
version      u16 = 1
speedCount   u32, luego speedCount × u16
             costo de terreno (ground.speed) indexado por ID numérico; 0 = 100 por defecto
islandCount  u16, luego por isla (en el orden de world.yaml):
  id         u8 largo + bytes UTF-8
  rect       4 × u32: x, y, w, h (alineados a 32)
  floors     u8 cantidad + bytes (ascendentes, sin repetir, 0..15)
  temple     u16 x, u16 y, u8 z
  sectors    u32 cantidad, luego por sector, ordenados por z, cy, cx:
    z u8, cx u16, cy u16
    ground   1024 × u16   ID numérico del suelo, fila por fila; 0 = sin tile
    flags    1024 × u8    bit 0 blocks_movement, 1 blocks_sight, 2 protection,
                          3 no_logout, 4 pvp, 5 no_pvp
    stacks   u16 cantidad, luego por pila (índice ascendente):
             u16 índice (y*32+x), u8 n, n × u16 IDs de abajo hacia arriba
crc32        u32 (IEEE) de todos los bytes anteriores
```

- Un sector es un chunk de `world/` ya resuelto: solo existen los sectores con archivo.
- `Decode` rechaza archivos con checksum, magic o versión incorrectos, datos truncados o
  sobrantes, y metadatos inválidos (rect fuera del mundo o desalineado, pisos fuera de
  rango o desordenados, templo fuera de la isla, sectores fuera de su isla, islas
  superpuestas o repetidas). Nunca entra en panic.
- **Versionado.** `world.bin` es un artefacto de build: no se commitea ni se migra; se
  regenera con `make mapcompile` en cada versión. Cualquier cambio de layout (campos
  nuevos como spawns, NPCs, portales o textos; flags nuevos; tamaños) sube `version` en
  uno y actualiza esta sección en el mismo PR. El servidor solo lee su propia versión y
  falla al arrancar con un mensaje claro si no coincide. Asignar un bit libre de `flags`
  a un flag nuevo también sube la versión, porque cambia el significado de los datos.

## Validación (misma lógica en editor, mapcli y CI)
Implementada una sola vez en `packages/map-format` (`validateWorld`); `mapcli validate`
y `make validate` la llaman. Cada error trae archivo, línea (YAML) y posición del mundo.
- Archivos en formato canónico (si no: `mapcli fmt`) y conformes a su esquema.
- Todo item, monstruo y NPC referenciado existe en `data/`; claves i18n existen en
  todos los idiomas.
- Cada tile con items tiene suelo; templo, spawns y NPCs están sobre tiles caminables:
  suelo `walkable` y ningún item de la pila que bloquee el paso. Bloquea el paso un item
  con `blocks_movement: true`, y **todo item `kind: wall` salvo que declare
  `blocks_movement: false`** (regla del contrato: `mapcompile` la aplica igual).
- Portales salen de un tile caminable de la isla y llegan a uno caminable de cualquier
  isla. `stairs`/`ladder` cambian de piso y tienen pareja: otro portal
  `stairs`/`ladder` que sale a distancia ≤ 1 del destino y llega a distancia ≤ 1 del
  origen. `hole` baja, `rope_spot` sube.
- Zonas de protección cubren el templo. (Depósitos: cuando exista el item, hito 1.)
- Rectángulos de isla alineados a chunks (múltiplos de 32). Islas no se superponen ni
  salen del mundo; chunks o tiles fuera del rectángulo de
  su isla, o en un piso no listado = error.
- Conectividad: desde el templo se puede llegar caminando a todo spawn y NPC de la
  isla (BFS en 8 direcciones por tiles caminables y portales). Zonas sin ningún tile
  alcanzable = error, salvo `community_plot` (pueden ser áreas sin construir).
- **Balance de spawns**: advertencia si hay más de 0,25 monstruos por tile caminable en
  el cuadrado del radio. (Nivel de monstruos vs. `level_hint`: pendiente, los monstruos
  aún no tienen nivel en `data/`.)
- Pendiente: alcanzabilidad entre islas por rutas de barco (falta decidir la isla de
  inicio).

## Contribuciones de la comunidad al mapa principal
Elegiste que los aportes se integren al mapa oficial. Para que eso sea manejable:

1. **Parcelas de comunidad.** Las zonas `community_plot` marcan áreas del mundo abiertas
   a contribuciones (bordes de islas, cuevas sin hacer, islotes nuevos). Un patch que
   toca chunks fuera de una parcela abierta solo puede venir de un maintainer.
2. **Map patch.** El editor exporta un archivo `.rpgpatch.json` con: hash de la versión
   base de cada chunk tocado, el contenido nuevo de esos chunks y los cambios a
   spawns/zonas/NPCs/portales. `mapcli patch apply` lo aplica; si la base cambió, intenta
   un merge a nivel de casilla y marca conflictos.
3. **Revisión.** Hito 2: el patch se envía como pull request de GitHub (a mano o por la
   herramienta). La CI valida y publica imágenes antes/después del área. Hito 5: portal
   web con cola de moderación que crea el PR automáticamente al aprobar.
4. **Contenido nuevo** (monstruos, items) no entra por patch de mapa: va en un PR de
   `data/` revisado por maintainers, porque afecta el balance.
5. **Créditos.** Cada patch fusionado agrega al autor en `world/CONTRIBUTORS.md`.
