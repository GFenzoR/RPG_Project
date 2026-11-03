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
  prefabs/
    small_dock.yaml              piezas reutilizables para la op `stamp`
  patches/                       map patches generados (ignorado por git)
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

## Prefabs (`world/prefabs/<id>.yaml`)
Piezas de mapa reutilizables (muelle, casa) que la op `stamp` copia con su esquina superior
izquierda en `pos`, sobre un solo piso. `rows` es un dibujo, un carácter por casilla, que
se busca en `legend`: `ground` pinta ese suelo; `items` reemplaza la pila de la casilla
(`[]` la vacía); sin `items` la pila queda igual. El espacio nunca está en la leyenda y deja
la casilla intacta.
```yaml
id: small_dock
notes: "Muelle de madera..."
legend:
  - { char: "=", ground: dock_planks, items: [] }
  - { char: "P", ground: dock_planks, items: [mooring_post] }
rows:
  - " === "
  - "P===P"
```
Formato canónico (lo escribe `mapcli fmt`): claves `id`, `notes`, `legend`, `rows`; una
entrada de leyenda por línea en estilo flow, una fila por línea entre comillas dobles.
La validación revisa esquema, que `id` coincida con el nombre de archivo, caracteres de
leyenda únicos, filas sin caracteres fuera de la leyenda, items existentes, `ground` con
`kind: ground` e `items` sin suelos. Máximo 64x64.

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
**Isla inicial:** un personaje sin ciudad de residencia (`characters.town` vacío, como uno
recién creado) despierta en el templo de la **primera isla de `world.yaml`** (hoy `puerto`,
la isla inicial de `docs/02`). El servidor acepta `-start-town <isla>` (o `RPG_START_TOWN`)
para cambiarla; el E2E usa `-start-town testisle` porque sus pruebas dependen de esa isla.

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
| `blocks_sight` | Algún item **de la pila** tiene `blocks_sight: true`, o es `kind: wall` y **no** declara `blocks_sight: false`. El suelo nunca bloquea la vista. Lo usan la línea de visión y los proyectiles. |
| `protection`, `no_logout`, `pvp`, `no_pvp` | La casilla tiene suelo y cae en un rect de una zona de ese tipo de `zones.yaml`, en uno de sus `floors`. |

`community_plot` no marca ningún flag: solo le importa al editor y a los patches.
La regla de `blocks_movement` es la misma que `isWalkable` de `packages/map-format`:
`make test-parity` (parte de `make test` y de la CI) compara casilla por casilla el
veredicto de `mapcompile` con el de `packages/map-format`.

**Muros y línea de visión (decidido).** `kind: wall` bloquea la vista igual que el paso:
proyectiles, ataques a distancia y hechizos no atraviesan muros. Un muro que deba dejar
ver (una reja abierta, una ventana) declara `blocks_sight: false`. Es una regla de juego,
no de render: el cliente sigue mostrando toda la ventana de 15x11 del piso actual.
`packages/map-format` no calcula la vista (solo la caminabilidad), así que la regla vive
en `mapcompile`; el significado del bit no cambia y `world.bin` no sube de versión.

### Formato de `world.bin` (versión 3)
Binario little endian. Lo escribe y lee `server/internal/world` (`Encode`/`Decode`). Las
mismas fuentes producen siempre los mismos bytes.

```text
magic        8 bytes "RPGWORLD"
version      u16 = 3
speedCount   u32, luego speedCount × u16
             costo de terreno (ground.speed) indexado por ID numérico; 0 = 100 por defecto
islandCount  u16, luego por isla (en el orden de world.yaml):
  id         u8 largo + bytes UTF-8
  rect       4 × u32: x, y, w, h (alineados a 32)
  floors     u8 cantidad + bytes (ascendentes, sin repetir, 0..15)
  temple     u16 x, u16 y, u8 z
  spawns     u16 cantidad, luego por spawn (en el orden de spawns.yaml):
    id u8 largo + bytes, center u16 x, u16 y, u8 z, radius u8,
    respawn u32 segundos, monsters u8 cantidad, luego por monstruo:
    id u8 largo + bytes (data/monsters), count u16
  npcs       u16 cantidad, luego por NPC (en el orden de npcs.yaml):
    id u8 largo + bytes (data/npcs), x u16, y u16, z u8
  sectors    u32 cantidad, luego por sector, ordenados por z, cy, cx:
    z u8, cx u16, cy u16
    ground   1024 × u16   ID numérico del suelo, fila por fila; 0 = sin tile
    flags    1024 × u8    bit 0 blocks_movement, 1 blocks_sight, 2 protection,
                          3 no_logout, 4 pvp, 5 no_pvp
    stacks   u16 cantidad, luego por pila (índice ascendente):
             u16 índice (y*32+x), u8 n, n × u16 IDs de abajo hacia arriba
crc32        u32 (IEEE) de todos los bytes anteriores
```

- Historial: la versión 3 (T1.10) agregó `npcs` por isla: `mapcompile` comprueba que cada
  NPC tenga su `data/npcs/<id>.yaml` y `Decode`/`NewMap` rechazan un NPC fuera de su isla,
  en un piso que no lista o colocado dos veces en el mundo. El servidor los pone en su
  casilla al arrancar (no caminan) y bloquean el paso como cualquier criatura.
- La versión 2 (T1.6) agregó `spawns` por isla. `mapcompile` comprueba que
  cada monstruo tenga su `data/monsters/<id>.yaml`; `Decode` rechaza spawns con el centro
  fuera de la isla o en un piso que no lista, sin id, sin monstruos o con
  `respawn_seconds` 0.
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

## Islas actuales
- `testisle` (64x64, pisos 7–8): isla de pruebas de herramientas, tests y E2E. Va primera en
  `world.yaml`, así que sigue siendo la isla de inicio de un personaje sin `town`. Desde
  T1.16 ya no tiene NPCs (cada NPC se coloca una vez en el mundo).
- `puerto` (192x192 en 3072,6272; pisos 7–8; nivel 1–15; T1.16): forma base con
  `mapcli generate --recipe island --seed 42 --size 184`, luego ops. Superficie: pueblo del
  Farol (templo, plaza, depósito, armería, casas y almacén con muros), muelle (prefab
  `small_dock`) en la bahía sureste, playa del naufragio (NO: saqueadores, cangrejos,
  gaviotas), bosque (O: jabalíes, arañas), campo de lobos (NE). Piso 8: la mina vieja
  (escalera en 3176,6322): murciélagos al oeste, galería de vetas de hierro con escarabajos
  al este y mina inundada con mineros ahogados al norte. Los 6 NPCs del Capítulo 1 viven
  aquí. Protección en templo, plaza y depósito (el item depósito aún no existe).
  Pendiente: la ruta de barco del capitán de puerto a `bosque` (T3.6).

## Contribuciones de la comunidad al mapa principal
Elegiste que los aportes se integren al mapa oficial. Para que eso sea manejable:

1. **Parcelas de comunidad.** Las zonas `community_plot` marcan áreas del mundo abiertas
   a contribuciones (bordes de islas, cuevas sin hacer, islotes nuevos). Un patch que
   toca chunks fuera de una parcela abierta solo puede venir de un maintainer.
   Reglas concretas (T2.4, las aplica la CI con `mapcli pr-check`):
   - **Abierta** = toda zona `community_plot` de la rama base. Cerrar una parcela es
     quitarla o cambiarle el tipo. Las parcelas se leen siempre de la base, nunca del PR.
   - Cuenta cada **casilla** cambiada de un chunk (no el chunk entero): tiene que caer en
     el rect de una parcela, en uno de sus `floors`.
   - Las entradas de los YAML cuentan por su **posición**, antes y después del cambio:
     spawns por su centro, NPCs y textos por su casilla, portales por sus dos extremos
     (`from` y `to`) y zonas por todas las casillas de sus rects en cada piso.
   - Crear, mover o quitar una zona `community_plot`, y cambiar `world.yaml`,
     `island.yaml` o prefabs, es siempre de maintainer.
   - `world/CONTRIBUTORS.md` lo puede tocar cualquiera.
   - **Maintainer** = login de GitHub listado en `.github/MAINTAINERS` (uno por línea),
     leído de la rama base, así que un PR no puede agregarse a sí mismo. Se eligió un
     archivo propio en vez de `CODEOWNERS` porque CODEOWNERS admite equipos
     (`@org/equipo`) que la CI no puede resolver sin un token con permisos de lectura de
     la organización.
   Primera parcela: `puerto_north_shore_plot`, la playa norte de Puerto
   (3200,6296 16x12, piso 7).
2. **Map patch.** El editor (o `mapcli patch create`) exporta un `.rpgpatch.json`
   (formato 2) con el hash y el texto de la versión base de cada archivo tocado, más su
   contenido nuevo: chunks y spawns/zonas/NPCs/portales. `mapcli patch apply` y el
   "Importar patch" del editor hacen un merge de tres vías: por casilla en los chunks y
   por entrada (`id`) en los YAML. Si algo cambió en los dos lados, es conflicto: no se
   aplica nada y se listan las casillas o entradas. Detalle y reglas de seguridad en
   `04-map-editor-and-ai.md`, "Map patches".
3. **Revisión.** Hito 2: el patch se envía como pull request de GitHub (a mano o por la
   herramienta). La CI valida y publica imágenes antes/después del área (T2.4: un
   comentario en el PR que se actualiza en cada push, ver `04-map-editor-and-ai.md`,
   "PR de mapas en CI"). Hito 5: portal web con cola
   de moderación que crea el PR automáticamente al aprobar.
4. **Contenido nuevo** (monstruos, items) no entra por patch de mapa: va en un PR de
   `data/` revisado por maintainers, porque afecta el balance.
5. **Créditos.** Cada patch fusionado agrega al autor en `world/CONTRIBUTORS.md`.
