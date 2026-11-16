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
  world.yaml                     lista de islas (las rutas de barco están en data/boat_routes.yaml)
  islands/
    puerto/
      island.yaml                nombre (clave i18n), rectángulo, pisos usados, templo, nivel sugerido
      chunks/
        z07/
          c0100_0200.json        chunk cx=100, cy=200, piso 7
        z08/...
      spawns.yaml                puntos de aparición de monstruos
      npcs.yaml                  NPCs colocados (referencian data/npcs/)
      zones.yaml                 zonas: protección, no-logout, pvp, no_pvp, community-plot
      portals.yaml               teletransportes y conexiones especiales
      texts.yaml                 carteles y libros (claves i18n)
      houses.yaml                casas de jugadores (T5.4)
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
Se edita con las ops `add_text`/`remove_text` (`04-map-editor-and-ai.md`; el editor todavía
no tiene panel de textos). El servidor no carga `texts.yaml` (lo usan el editor, `mapcli`
y el validador). Para que un cartel se vea y se lea en el juego, la misma casilla lleva un
item fijo cuya `description` es esa clave (T5.5: `brasal_temple_sign`, ver
`06-content-data.md`); mirarlo muestra el texto. Todos los carteles de Puerto, el Bosque,
la Isla Volcánica y la Isla de Pruebas lo tienen (en Puerto, el Bosque y la Isla de
Pruebas el item se llama como su entrada de `texts.yaml`, p. ej.
`puerto_temple_sign`); solo el del templo de `testisle` queda sin item. El
validador los mantiene de acuerdo: un item de cartel (un item cuya `description` es una
clave `text.*`) tiene que estar en una casilla con un `kind: sign` de `texts.yaml` con ese
mismo texto, y un cartel de `texts.yaml` con un item de cartel en su casilla tiene que decir
lo mismo que el item. Un cartel sin item sigue siendo válido.

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
Zonas PvP (T5.2, reglas en `02-game-design.md` "PvP"): en `no_pvp` nadie ataca a jugadores
(ni desde ni hacia la zona); en `pvp` (arena) se pelea sin marcas ni castigo si los dos
están adentro; fuera de las dos rige el PvP abierto con marcas. Una casilla con
`protection` sigue sin combate aunque además sea `pvp`. Hoy: toda la isla `puerto` es
`no_pvp` (`puerto_no_pvp`, pisos 7 y 8: isla inicial y tutorial), la arena
`bosque_arena` (6x5 de piedra, al suroeste de Raigal) y `testisle_no_pvp` (al oeste del
templo, para el E2E). Una isla nueva cerca del inicio debería pensar si va `no_pvp`.

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
- `from` es la casilla del portal (en la isla del archivo) y `to` adonde llega el jugador
  (cualquier isla). Lo que hace cada `kind` en el juego está en `02-game-design.md`
  "Cambiar de piso": `stairs`, `hole` y `teleport` se pisan, `ladder` se usa, `rope_spot`
  pide una soga y `boat` no mueve a nadie (los barcos son `data/boat_routes.yaml`). El
  portal es la casilla, no un item, pero se ve por el item que lo muestra, que va en la
  pila de su `from` o como su suelo (un item con bloque `portal`, `06-content-data.md`):
  `stairs_down` / `stairs_up`, `ladder_up` (la escalera de mano de abajo, que sube) /
  `ladder_down` (la trampilla de arriba, que baja), `hole`, `rope_spot` y `teleport`. `make validate` y
  `mapcompile` lo exigen ("Validación", "Compilación": sin el item no hay `world.bin`); el
  servidor no lo mira para mover a nadie y al arrancar solo avisa en el log si falta, para
  un `world.bin` compilado antes de cambiar `data/items` (`world.bin` guarda números de
  item, no qué son: `NewMap` no puede comprobarlo, y lo hace `session` con el contenido
  cargado; avisa en vez de no arrancar porque un portal sin su item funciona igual, solo
  se ve como suelo, y los mapas de los tests de `session` ponen portales en casillas sin
  nada). `add_portal` no coloca el item: va aparte, con `place`/`place_item`. El atlas no
  anima items: el teletransporte es estático.
- Nadie se para sobre la entrada de un `stairs`, `hole` o `teleport`: ningún NPC ahí,
  ningún spawn de radio 0 centrado ahí (los monstruos no la pisan, quedaría vacío) y ni el
  templo ni la salida de una casa (el último recurso de despertar y de salir de una casa
  con todo lleno).
- Un portal por casilla de entrada, y nunca hacia su propia casilla. `to` no debería ser
  la casilla de otro portal que se pisa: el servidor deja al jugador en la libre más
  cercana (nadie se queda parado sobre una escalera).
- Lo carga el servidor desde `world.bin` (versión 5, "Formato de `world.bin`"), como las
  casas: un cambio de `portals.yaml` necesita `make mapcompile` y reiniciar. El cliente
  también lo empaqueta (el plugin de Vite, `loadPortals`, de las islas de `world.yaml`):
  hay que reiniciar `vite` o reconstruir el cliente. Un `portals.yaml` que no se puede
  leer corta el build del cliente. El cliente recibe la entrada y el tipo de cada portal
  (así un camino por click no pisa una escalera ni un teletransporte): no hay portales
  ocultos.

`houses.yaml` (T5.4, reglas de juego en `02-game-design.md` "Casas"):
```yaml
- id: puerto_house_net
  name: house.puerto_house_net.name
  rent: 800
  rects:
    - { x: 3151, y: 6396, z: 7, w: 6, h: 5 }
    - { x: 3153, y: 6401, z: 7, w: 2, h: 1 }
  doors:
    - { x: 3153, y: 6401, z: 7 }
    - { x: 3154, y: 6401, z: 7 }
  exit: { x: 3153, y: 6402, z: 7 }
```
- `id` único en todo el mundo (es la clave de las tablas `house_owners`, `house_guests` y
  `house_items`: **no se cambia** una vez publicado). `name` es siempre
  `house.<id>.name` (los mensajes del servidor nombran la casa por su id). Una casa quitada o renombrada deja
  sus filas en la base: el servidor ignora la casa con un aviso, la cuenta de su dueño no
  puede alquilar otra hasta que un operador borre esa fila, y los items guardados que ya
  no caen en la casa (rects achicados) se descartan al arrancar y desaparecen de la base
  con el próximo cambio de esa casa: antes de achicar una casa ocupada, libérala con
  `/houseevict`. `name` es una clave i18n de
  `i18n/*/world.yaml` (`house.<id>.name`). El pueblo de la casa es su isla.
- `rent`: precio de un período (`balance.yaml houses.period_days`) en cobre (se paga con cualquier moneda, `02-game-design.md` "Economía").
- `rects`: las casillas de la casa, cada rect en un piso (`z`), de 1 a 255 de lado, hasta
  16. Las paredes no van: solo lo caminable de adentro y las puertas. El tamaño de la casa
  es la cantidad de casillas.
- `doors`: casillas de la casa por donde se entra (1 a 8). La ventana de la casa se abre
  usando una puerta; mirarla dice de quién es. `exit`: casilla fuera de toda casa, junto
  (a una casilla, mismo piso) a una puerta: ahí va quien no puede quedarse adentro.
- Validación (`mapcli validate`, editor y CI): rects dentro de la isla y en sus pisos,
  todas sus casillas con suelo, ninguna casilla en dos casas ni en dos rects de la misma, puertas caminables dentro de
  la casa y en su borde (junto a una casilla de afuera; advertencia si las casillas de un
  piso no forman un solo bloque) y sin un item de puerta (bloque `door`: usarlo abriría la
  puerta, nunca la ventana de la casa), salida caminable, fuera de toda casa, junto a una puerta y alcanzable a pie desde
  el templo, y nunca sobre una puerta (es el último recurso de sacar a alguien de la casa
  con todo lleno: sobre una con llave, abierta o cerrada, quedaría en el umbral, a un paso
  de la sala sin la llave; una común la puede cerrar cualquiera, y quedaría dentro de una
  puerta cerrada; el servidor tampoco arranca con eso, `checkArrivals`), nombre con texto en
  todos los idiomas, id único en el mundo. Adentro de una
  casa no puede haber NPCs, centros de spawn, textos, el templo ni extremos de portales, y
  ninguna zona `no_logout` puede cubrir una casa (salir del juego adentro es seguro). Un
  portal de otra isla tampoco puede llegar a una casa (lo rechazan el servidor y
  `make validate`).
- **Solo maintainers:** `houses.yaml` no es parte de los map patches (docs/04): un PR que
  lo cambia queda fuera de las parcelas de comunidad. Se edita con el panel de casas del
  editor (dibuja casillas, puertas y salida, y escribe también los nombres en
  `i18n/*/world.yaml`), con `mapcli house add|set|remove` o con las ops
  `add_house`/`set_house`/`remove_house` (docs/04 "Casas"); a mano, con `mapcli fmt` para
  el formato canónico. Para construir una casa: `stamp` de los prefabs `house_wood_small` /
  `house_wood_medium` y luego su entrada en `houses.yaml`.

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
```
`dev_only: true` (opcional) marca una isla de desarrollo, hoy solo `pruebas` (la Isla de
Pruebas, `16-probar-el-juego.md`): `mapcompile` la deja afuera salvo con `-dev`, así que la
imagen de producción no la tiene (ver "Compilación" y "Validación"). La primera isla de la
lista no puede serlo.

Las rutas de barco no van aquí: desde T3.5 viven en `data/boat_routes.yaml` (las vende un
NPC, con precio y requisitos, como el resto del contenido; formato en
`06-content-data.md`). El campo `boat_routes` de este archivo quedó obsoleto en T3.5 y se
quitó en T3.6 (el esquema todavía lo acepta, opcional y vacío, para no romper ramas viejas). Lo que toca al mapa lo valida `mapcli validate` (ver "Validación").
**Isla inicial:** un personaje sin ciudad de residencia (`characters.town` vacío, como uno
recién creado) despierta en el templo de la **primera isla de `world.yaml`** (hoy `puerto`,
la isla inicial de `docs/02`). El servidor acepta `-start-town <isla>` (o `RPG_START_TOWN`)
para cambiarla; el E2E usa `-start-town testisle` porque sus pruebas dependen de esa isla, y
`make play` usa `-start-town pruebas` (la Isla de Pruebas, `16-probar-el-juego.md`).

## Compilación
`server/cmd/mapcompile` (`make mapcompile`) lee `world/` + `data/items/` +
`data/ids.lock.yaml`, valida lo necesario para compilar, resuelve IDs y escribe
`build/world.bin` (binario compacto: tiles por sector, flags precomputados), sin las islas
`dev_only` de `world.yaml` salvo con `-dev` (`make mapcompile` lo pasa, igual que el E2E; la
imagen de producción, `deploy/Dockerfile.gameserver`, no). El servidor
solo carga `world.bin` (`-world`, por defecto `$RPG_WORLD` o `../build/world.bin` desde
`server/`). El editor y `mapcli` trabajan siempre con el JSON.

La validación completa del mapa (conectividad, spawns, i18n...) sigue siendo la de
`packages/map-format` (`make validate`). `mapcompile` solo rechaza lo que no puede
compilar: rect no alineado o distinto del de `world.yaml`, chunk fuera de la isla o en un
piso no listado, nombre de archivo incoherente, item desconocido o sin ID numérico, IDs
numéricos repetidos en `ids.lock.yaml`, tipo de zona o de portal desconocido, un portal
(salvo un `boat`) sin el item que lo muestra en su entrada (la misma regla que
"Validación": un servidor nunca carga un mapa con suelo que mueve sin verse) y lo que
`world.NewMap` no acepta (ver "Historial" de `world.bin`).

### Flags de tile
Se calculan al compilar, uno por casilla (implementación: `server/internal/world/compile`):

| Flag | Se activa si… |
|---|---|
| `blocks_movement` | No hay suelo (`-1`), el suelo no tiene `ground.walkable: true`, o algún item de la pila tiene `blocks_movement: true`, o es `kind: wall` y **no** declara `blocks_movement: false`. |
| `blocks_sight` | Algún item **de la pila** tiene `blocks_sight: true`, o es `kind: wall` y **no** declara `blocks_sight: false`. El suelo nunca bloquea la vista. Lo usan la línea de visión y los proyectiles. |
| `protection`, `no_logout`, `pvp`, `no_pvp` | La casilla tiene suelo y cae en un rect de una zona de ese tipo de `zones.yaml`, en uno de sus `floors`. |
| `house` (y `protection`) | La casilla tiene suelo y es de una casa de `houses.yaml` (T5.4). Lo calcula `world.NewMap` al cargar a partir de las casas, también en tests con `worldtest.WithHouses`. |
| `portal_step` | La casilla es la entrada de una escalera, un agujero o un teletransporte de `portals.yaml` (quien la pisa aparece en el otro extremo). Tampoco lo calcula la compilación: lo pone `world.NewMap` al cargar a partir de los portales (también en tests con `worldtest.WithPortals`) y borra el que traiga el archivo. `Map.MovesOnStep` lo lee para que A* y las búsquedas de casilla libre no consulten el índice de portales en cada casilla. |

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

### Formato de `world.bin` (versión 5)
Binario little endian. Lo escribe y lee `server/internal/world` (`Encode`/`Decode`). Las
mismas fuentes producen siempre los mismos bytes.

```text
magic        8 bytes "RPGWORLD"
version      u16 = 5
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
  houses     u16 cantidad, luego por casa (en el orden de houses.yaml, T5.4):
    id u8 largo + bytes, name u8 largo + bytes (clave i18n), rent u32,
    rects u8 cantidad × (x u16, y u16, z u8, w u8, h u8),
    doors u8 cantidad × (x u16, y u16, z u8), exit x u16, y u16, z u8
  portals    u16 cantidad, luego por portal (en el orden de portals.yaml, v5):
    id u8 largo + bytes, kind u8 (1 stairs, 2 ladder, 3 hole, 4 rope_spot,
    5 teleport, 6 boat), from x u16, y u16, z u8, to x u16, y u16, z u8
  sectors    u32 cantidad, luego por sector, ordenados por z, cy, cx:
    z u8, cx u16, cy u16
    ground   1024 × u16   ID numérico del suelo, fila por fila; 0 = sin tile
    flags    1024 × u8    bit 0 blocks_movement, 1 blocks_sight, 2 protection,
                          3 no_logout, 4 pvp, 5 no_pvp, 6 house, 7 portal_step
    stacks   u16 cantidad, luego por pila (índice ascendente):
             u16 índice (y*32+x), u8 n, n × u16 IDs de abajo hacia arriba
crc32        u32 (IEEE) de todos los bytes anteriores
```

- Historial: la versión 5 agregó `portals` por isla (escaleras y demás de
  `portals.yaml`, que antes solo veían el editor y el validador): `NewMap` rechaza ids
  repetidos en el mundo o fuera del formato de id, un tipo desconocido, una entrada que
  no es una casilla caminable de su isla en un piso que lista, un destino que no es una
  casilla caminable de alguna isla, un portal hacia su propia casilla, una escalera,
  escalera de mano, agujero o soga que no cambia de piso, un agujero que sube, una soga
  que baja, dos portales en una casilla, un extremo en una casa (de cualquier isla), y
  un NPC, un spawn de radio 0, el templo o la salida de una casa sobre la entrada de un
  `stairs`/`hole`/`teleport`; los indexa por su entrada (`Map.PortalAt`) y marca esas
  entradas con el bit 7 (`portal_step`) de `flags` (`Map.MovesOnStep`). Con él, `flags`
  (un byte) se quedó sin bits libres: el próximo flag ensancha el campo (o va en otra
  tabla) y sube la versión. La pareja de vuelta de escaleras y escaleras de mano, el
  alcance a pie desde el templo y que la llegada se conecte a pie los mira solo
  `make validate`. La
  prueba de paridad (`make test-parity`) compara también los portales que leen
  `mapcompile` y `packages/map-format`.
- La versión 4 (T5.4) agregó `houses` por isla y el bit 6 (`house`) de
  `flags`: `NewMap` rechaza ids repetidos en el mundo, rects fuera de la isla o en pisos
  que no lista, casillas en dos casas, puertas fuera de su casa y salidas dentro de una
  casa, fuera de la isla o lejos de toda puerta, y marca las casillas con `house` y
  `protection`.
- La versión 3 (T1.10) agregó `npcs` por isla: `mapcompile` comprueba que cada
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
  origen. `hole` baja, `rope_spot` sube. Un portal por casilla y ninguno hacia su propia
  casilla (el servidor los indexa por la entrada). Ningún NPC, spawn de radio 0, templo ni
  salida de casa sobre la entrada de un `stairs`/`hole`/`teleport`. Un id de portal no se
  repite en todo el mundo (como en el servidor). **El item que lo muestra:** la entrada de
  todo portal salvo un `boat` tiene (en su pila o como suelo) un item cuyo bloque `portal`
  es de su `kind` y, si dice `leads`, del sentido en que cambia de piso (`down` si
  `to.z > from.z`, `up` si es menor; un teletransporte del mismo piso solo con un item sin
  `leads`); el error nombra los items de `data/items` que sirven. **Advertencia:** un item
  de portal en una casilla de la que no sale un portal que muestre (los jugadores lo
  tomarían por un camino). **Llegada:** toda casilla caminable fuera de casas, sin NPC y fuera de las entradas de `stairs`/`hole`/`teleport` a
  `travel.arrival_radius` del destino (de `data/balance.yaml`; 5, el máximo, si no se
  cargó) se conecta a pie con el destino (8 direcciones, un piso, puertas abiertas, sin
  cruzar esas entradas, casillas de casa ni NPCs: el servidor busca solo en el área del
  destino, donde una casa es muro, y un NPC nunca deja su casilla, así que un pasillo que
  tapa es muro para los jugadores): el servidor busca la casilla libre por anillos y, con
  el destino ocupado, podría dejar a alguien del otro lado de un muro. Advertencia: un
  portal `boat` no mueve a nadie en el juego. **Advertencia de salida:** desde el destino
  de un `hole` o de un `teleport` se llega a algún templo sin llaves ni herramientas: a
  pie dentro de su área y por `stairs`, `ladder`, `hole` y `teleport` (ni `rope_spot` ni
  `boat`; las mismas áreas y caminos del chequeo de escape de las puertas con llave, ver
  "Puertas"). Si el destino es la entrada de otro `stairs`/`hole`/`teleport`, cuenta cada
  área junto a ella (ahí lo deja el servidor). Es advertencia y no error porque un pozo del
  que se sale con soga es un diseño válido (un agujero solo baja y no tiene vuelta); uno
  hecho por descuido deja atrapado a quien cae, y reconectarse lo devuelve al mismo
  lugar.
- Alcance a pie desde el templo (spawns, NPCs, salidas de casa, zonas y el aviso de áreas
  inalcanzables): se recorre como el servidor mueve. Una casilla de `stairs`, `hole` o
  `teleport` lleva solo a su destino (nadie la cruza caminando: una escalera en un túnel
  de una casilla corta el paso a pie y deja aparte lo de atrás), una `ladder` o un
  `rope_spot` es una casilla más que además lleva a su destino, y un `boat` no lleva a
  ningún lado.
- Zonas de protección cubren el templo. (Depósitos: cuando exista el item, hito 1.)
- Carteles (T5.5): un item de cartel (`description` = clave `text.*`) está sobre un
  `kind: sign` de `texts.yaml` con ese texto, y un cartel con item de cartel en su casilla
  dice lo mismo que el item (ver "Islas", `texts.yaml`).
- Rectángulos de isla alineados a chunks (múltiplos de 32). Islas no se superponen ni
  salen del mundo; chunks o tiles fuera del rectángulo de
  su isla, o en un piso no listado = error.
- Conectividad: desde el templo se puede llegar caminando a todo spawn y NPC de la
  isla (BFS en 8 direcciones por tiles caminables y portales; una **puerta**, item con
  bloque `door`, cuenta como abierta aunque esté cerrada o con llave: en el juego se abre,
  ver `02-game-design.md` "Puertas con llave"). Zonas sin ningún tile
  alcanzable = error, salvo `community_plot` (pueden ser áreas sin construir).
- **Puertas** (`02-game-design.md` "Puertas con llave"; el servidor no arranca con lo que
  aquí es error): un solo item de puerta (bloque `door`) por casilla; advertencia si una
  puerta está colocada abierta (vuelve a estar abierta tras cada reinicio). Cada puerta
  con llave (cerrada o abierta) necesita una **sala** determinable: se recorre a pie cada
  lado (8 direcciones, mismo piso, hasta 4096 casillas por lado, las demás puertas con
  llave como muro y las sin llave como abiertas si su casilla deja pasar, regla
  `isPassable`); un lado sin terminar es el de afuera y, si todos terminan, el más grande.
  Es error una puerta que abierta no deja pasar a nadie (en su casilla hay otro bloqueo o
  el suelo no es caminable), una sobre un extremo de un portal (sale de su casilla o llega
  a ella), amurallada (sin lados), con un solo lado, con más de un lado
  sin terminar o con los dos lados más grandes del mismo tamaño. Varias puertas pueden
  compartir una sala solo con la misma llave. La sala no puede tener el templo, NPCs, casas
  (casillas o salida), extremos de portales, llegadas de rutas de barco ni destinos de un
  `teleport` de un diálogo de NPC; los spawns sí. Después, el **chequeo de escape** sobre
  las áreas del mapa (casillas unidas a pie, 8 direcciones, un piso, con las puertas con
  llave, las casas y las entradas de `stairs`, `hole` y `teleport` como muro): sin llaves
  se va de la sala de una puerta a cada lado de ella y por los portales que no piden nada
  (`stairs`, `ladder`, `hole`, `teleport`; no `rope_spot`, que pide una soga, ni `boat`)
  de un área a otra (una escalera de mano desde el área de su casilla; los que se pisan,
  desde las áreas de al lado y desde la sala de una puerta con llave de al lado), y el
  mundo son las áreas de los templos (una llegada de `data/boat_routes.yaml` no cuenta: es
  una entrada, no una salida). Es error un lado de una puerta que no llega al mundo así
  (una bóveda que ninguna puerta guarda: el mensaje da la casilla de ese lado) y una sala
  a la que entra sin su llave un jugador con todas las demás, parado fuera de las salas o
  en una casa (un ciclo de puertas de llaves distintas: el mensaje nombra la puerta de
  otra llave que da a esa sala desde la suya). Los ciclos de puertas de una misma llave
  valen. El recorrido y el chequeo son los del servidor
  (`packages/map-format/src/doors.ts`, `session/door.go` y `session/area.go`), y los
  dos leen los casos de `packages/map-format/src/testdata/door-rooms.json`.
  Advertencia (T3.6): un área caminable conexa (8 direcciones, un piso) de 10 casillas o
  más a la que no se llega desde el templo, fuera de parcelas `community_plot` (un muelle
  suelto, un banco de arena del generador, una sala sin escalera). Una por área, con una
  de sus casillas.
- **Balance de spawns**: advertencia si hay más de 0,25 monstruos por tile caminable en
  el cuadrado del radio. (Nivel de monstruos vs. `level_hint`: pendiente, los monstruos
  aún no tienen nivel en `data/`.)
- **Rutas de barco** (`data/boat_routes.yaml`, T3.5): el capitán está colocado en
  algún `npcs.yaml` a ≤ 8 casillas (Chebyshev, mismo piso) del muelle `from`, y `from` y
  `to` son casillas caminables de una isla. Los errores llevan la posición; con
  `--island` se muestran los de rutas cuyo muelle o llegada cae en esa isla.
- **Llegadas de barco y teleports de diálogo**: ni la llegada `to` de una ruta ni el
  destino de un `teleport` de un diálogo de NPC (`data/npcs`) caen en una casilla de casa
  (una llegada no deja a nadie adentro de una casa) ni sobre una puerta con llave colocada
  abierta (una puerta no es lugar para llegar: el que llega quedaría en el umbral). El
  destino de un `teleport` es además una casilla caminable de una isla, como la llegada de
  un barco (una puerta con llave cerrada no lo es). La salida de una casa y el templo de
  cada isla, los últimos recursos de salir de una casa y de despertar con todo lleno,
  tampoco caen sobre una puerta, con llave o común, abierta o cerrada, ni en una casilla no
  caminable (ver `houses.yaml`), y el templo tampoco en una casilla de casa. El error de
  una casa o de una puerta nombra la isla y la casilla; el de una casilla no caminable
  nombra la ruta, el NPC, la casa o el templo, con la casilla en la posición del error,
  pero no siempre la isla (el destino de un `teleport` puede no estar en ninguna). Lo mismo que los
  extremos de portal en una casa (`world.NewMap`): el servidor no arranca con eso
  (`checkArrivals` en `session/travel.go`, que corre en cuanto `initDoors` encuentra las
  puertas, antes del chequeo de escape), y los dos lados leen los casos de
  `packages/map-format/src/testdata/arrivals.json`.
- **Islas `dev_only`**: como la imagen de producción no las tiene, nada de lo que el
  servidor revisa contra su mapa puede necesitarlas: ninguna ruta de barco sale de una,
  llega a una ni tiene ahí a su capitán, ningún teleport de un diálogo llega a una (el
  servidor no arrancaría) y ningún portal de otra isla lleva a una (`mapcompile` rechazaría
  el mapa). La primera isla de `world.yaml` no puede ser `dev_only`.
- Pendiente: alcanzabilidad entre islas por rutas de barco (que desde la isla inicial se
  llegue a todas).

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
  Oficios (T3.4): fragua, yunque y fogón al norte del templo (3166–3172, 6366) y una
  arboleda de abedules talables al borde del bosque (≈3145–3150, 6369–6377). Las
  estaciones son items comunes del mapa (`place`): lo que las hace estación es que una
  receta de `data/recipes.yaml` las nombre.
  Casas (T5.4): las casas de madera del pueblo, `puerto_house_net` (3150–3157,
  6395–6401) y `puerto_house_oar` (3160–3167, 6395–6401), con puerta al sur, y la más
  grande, `puerto_house_anchor` (3180–3188, 6408–6414), con puerta al norte.
  Muelle del capitán de puerto (`harbor_master`, 3201,6433): tablones 3200–3202,
  6429–6434; las rutas salen de 3201,6434 (`puerto_to_bosque`) y la vuelta desde el Bosque
  llega a 3201,6432 (la de la Isla Volcánica, `volcan_to_puerto`, a 3201,6431).
  Carteles (`texts.yaml` y un item `puerto_*_sign` del mismo id en la misma casilla, que
  bloquea): templo en 3163,6384 (afuera de la puerta este), muelle en 3198,6428 (en el
  camino de tierra al muelle) y mina en 3175,6328 (en el camino a la escalera).
- `bosque` (192x192 en 4096,6016; pisos 7–8; nivel 10–30; T3.6): forma base con
  `mapcli generate --recipe island --seed 23 --size 180` y luego una lista de ops
  (scatter con semillas 2301–2304, autoborder al final). Superficie: pueblo de **Raigal**
  al oeste (templo de piedra con el sacerdote en 4146–4154, 6100–6108, puerta al sur;
  plaza de tierra con fragua, yunque y fogón; curtiduría de madera al sur de la plaza),
  muelle de tablones al oeste (4115–4127, 6099–6101, con el barquero `bosque_ferryman` en
  4122,6100; la llegada desde Puerto cae en 4120,6100 y la desde la Volcánica en
  4119,6101), arboleda de olmos talables al este del pueblo con la druida, bosque de
  ciervos al noroeste (10–13), ciénaga de sapos al sur (12–15), bosque profundo de
  espinosos al noreste (18–22) y el campamento de contrabandistas en la costa este
  (15–18), unidos por caminos de tierra. Piso 8: la cueva de los contrabandistas
  (escalera en 4248,6146) con dos cámaras de reptantes huecos (22–26). Protección en el
  templo y la plaza; `no_logout` en el muelle. Parcela de comunidad
  `bosque_north_cove_plot` (4168,6032 24x16, piso 7): la caleta norte y su islote.
  Sin depósito (el item todavía no existe).
  Casas (T5.4): `bosque_house_moss` (prefab `house_wood_small` en 4156,6087) y
  `bosque_house_resin` (prefab `house_wood_medium` en 4165,6086), en la playa al norte del
  pueblo, con la puerta al sur.
  Carteles (`texts.yaml` y un item `bosque_*_sign` del mismo id en la misma casilla, que
  bloquea): templo en 4149,6109 (junto a la puerta sur), muelle en 4128,6099 (al final de
  los tablones) y cueva en 4247,6144 (junto a la escalera de la cueva).

- `volcan` (192x192 en 3584,5696; pisos 7–8; nivel 25–60; T5.5): forma base con
  `mapcli generate --recipe island --seed 55 --size 180` y una lista de ops (el pasto pasa a
  tierra con `fill`; scatter con semillas 5501–5505, autoborder al final). Superficie:
  pueblo de **Brasal** al oeste (plaza de piedra 3636–3667, 5782–5806; templo de piedra
  3638–3646, 5784–5792 con la puerta al sur y la sacerdotisa; fragua, yunque y fogón con el
  herrero; el archivo de madera de Casia 3658–3666, 5795–5801, puerta al norte), muelle de
  tablones al oeste (3610–3635, 5794–5796) con la capitana `volcan_ferryman` en 3615,5794:
  las rutas salen de 3612,5795 y las llegadas caen en 3617,5795. Llano de ceniza
  al norte con sabuesos (26–30), ladera de lava enfriada al sureste con salamandras (29–33) y
  algunas vetas de ascua, y el cráter (anillo de `rock_wall` con centro 3712,5760, abierto
  al sur; el anillo es 4-conexo, sin esquinas diagonales abiertas, así que solo se entra por
  el hueco) con dragoncillos (48+). Escalera de la mina en 3692,5796 (`stairs_down` /
  `stairs_up`), al final del camino de piedra que sale de la plaza. Piso 8: la mina, con la
  sala de entrada, la galería de los mineros de obsidiana al oeste (33–37) y la de los
  gólems de escoria al este (39–44), ambas con vetas de ascua, y al sur la sala de la
  puerta sellada (el eco `volcan_forge_echo` en 3692,5826) y la forja antigua con el
  custodio de escoria (3692,5845, respawn 1200 s). Entre las dos, el pasillo se angosta a
  una casilla (`rock_wall` en 3691,5832) con la puerta con llave `forge_gate` en
  3692,5832: se abre con la llave de ascua del Capítulo 3. Protección en el templo y la plaza;
  `no_logout` en el muelle; el resto es PvP abierto. Casa (T5.4): `volcan_house_cinder`
  (prefab `house_wood_small` en 3646,5797, puerta al sur).
  Suelos propios (T5.5, piso 7): ceniza (`ash`) en todo el interior, losas de basalto
  (`basalt`) en la plaza (el templo conserva su piso de piedra), escoria (`cinder_path`)
  en el camino de la plaza a la escalera de la mina y en tres caminos de 2 de ancho (de la
  plaza al llano del norte, del camino a la boca del cráter y del camino a la ladera); las
  manchas de arena que el generador había dejado tierra adentro son afloramientos de lava
  enfriada sobre la ceniza; la ladera y el cráter
  son de lava enfriada (`cooled_lava`) con seis pozos de lava fundida (`lava`, no
  caminable) siempre rodeados de costra, fuera de los spawns y sin tapar vetas de ascua.
  La playa sigue siendo arena (`ash_sand`, `cooled_lava_sand`), también entre la lava
  enfriada y el mar en la costa sur. Las losas de basalto de la plaza y el final de los
  caminos de escoria en la ladera y el cráter tienen el borde recto a propósito (un
  empedrado y un camino que termina), como la piedra de los pueblos. Se pintó con un script de
  ops (`paint_ground` por celdas, `remove_item` de tres rocas bajo la lava, `place_item`
  de los carteles y `autoborder` de toda la isla) sobre el mapa anterior, sin mover
  spawns, NPCs, portales, zonas ni la casa. Carteles (`texts.yaml` y un item
  `brasal_*_sign` en la misma casilla, que bloquea): templo en 3641,5793 (junto a la
  puerta), muelle en 3635,5793 (al final de los tablones) y mina en 3691,5794 (junto a la
  escalera). El de la puerta con llave (`volcan_gate_sign`, `text.volcan.gate_sign`) está
  en el piso 8, en 3693,5830: del lado de la mina, junto a la boca del pasillo de la puerta
  (fuera de la sala de la forja); 3691–3692,5831, delante de la puerta, quedan libres.
  Pozos de lava (después de T5.5): los seis se redibujaron a mano como manchas irregulares
  (gota, medialuna, hoja, poroto) con `paint_ground` por celdas y `autoborder` en su
  rectángulo. Reglas que siguen (`tools/mapcli/src/world.test.ts`): cada pozo llena menos
  del 70 % de su rectángulo (los viejos, 77–93 %), las 8 vecinas de cada casilla de lava son
  lava o lava enfriada (siempre hay costra antes de otro suelo), cada casilla de lava está
  en algún bloque de 2x2 de lava (sin tiras de una casilla, donde la costra pellizcaría) y
  ninguna cae en el cuadrado de un spawn. Al dibujarlos se dejaron además dos casillas
  caminables hacia muros y vetas, una hacia rocas, y ningún hueco encerrado.
- `pruebas` (96x96 en 2048,2048; pisos 7–8; nivel 1–60): **Isla de Pruebas**, el sandbox
  para probar el juego a mano (`16-probar-el-juego.md`, `make play`). Fuera del juego normal
  a propósito: es `dev_only` (la imagen de producción no la tiene) y ninguna ruta de barco,
  portal ni diálogo de otra isla llega a ella (lo comprueban `tools/mapcli/src/world.test.ts`
  y `TestCompilePruebas`); en local se entra con `-start-town pruebas` o con un `/tp` del
  personal. Su barquero lleva de ida con teleports de diálogo, no con rutas de barco. Forma base con `mapcli generate --recipe island --seed 11 --size 90` y luego una lista
  de ops (el parche de arena del centro pasa a pasto; scatter con semillas 1601–1608 en
  bosquecillos; `autoborder` al final). Superficie: templo de piedra (2090–2100 ×
  2083–2091, puerta al sur; despertar en 2095,2086) con la instructora `pruebas_trainer`
  (experiencia, dinero, curación y la misión `pruebas_rats`), plaza de piedra (2083–2107 ×
  2092–2103) con el proveedor `pruebas_merchant` (2086,2100) y el tablero del mercado
  (2091,2103); protección `pruebas_town` en 2081–2109 × 2083–2104. Al norte, cinco corrales
  de troncos (2076–2119 × 2073–2079, abiertos al sendero de y 2080–2081) de débil a fuerte:
  ratas, lobos, jabalíes con una araña, espinosos y un dragoncillo. Al oeste, cantera de
  vetas de hierro, abedules, taller con fragua, yunque y fogón, y un muelle de pesca con
  agua con peces (nunca junto a la arena: los bordes quedan enteros). Al este, el patio de
  portales (2113–2124 × 2088–2100: escalera, trampilla `ladder_down` y agujero) y la bóveda
  de la puerta de práctica (`pruebas_gate` en 2117,2101, llave `pruebas_key`). Al sur, la
  casa `pruebas_house` (prefab `house_wood_medium` en 2085,2108), la arena `pruebas_arena`
  (zona `pvp`, 2102–2112 × 2111–2119, entrada por el oeste) y el muelle (prefab
  `small_dock` en 2093,2133) con el barquero `pruebas_ferryman` (2097,2133), que por 20
  monedas deja donde llegan los barcos de Puerto, el Bosque y la Isla Volcánica. Piso 8: cueva
  de tierra y `rock_wall` bajo el patio con la escalera de vuelta, la escalera de mano, el
  pozo bajo el agujero con su `rope_spot` (2119,2094), murciélagos y un teletransporte
  (2113,2104) que vuelve a la plaza (2095,2094). Carteles: uno por sector
  (`pruebas_*_sign`, mismo id en `texts.yaml`).

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
     spawns por todo el cuadrado centro±radio (donde andan sus monstruos), NPCs y textos
     por su casilla, portales por sus dos extremos
     (`from` y `to`) y zonas por todas las casillas de sus rects en cada piso.
   - Un **portal** con sus dos extremos en parcelas de **islas distintas** también es de
     maintainer (`cross_island`): un teletransporte entre islas se saltaría el barco y su
     `travel.combat_block_ms`. Uno de la comunidad une casillas de una misma isla.
   - Crear, mover o quitar una zona `community_plot`, y cambiar `world.yaml`,
     `island.yaml` o prefabs, es siempre de maintainer.
   - `world/CONTRIBUTORS.md` lo puede tocar cualquiera.
   - **Maintainer** = login de GitHub listado en `.github/MAINTAINERS` (uno por línea),
     leído de la rama base, así que un PR no puede agregarse a sí mismo, más el dueño del
     repo (`author_association: OWNER` del evento de GitHub), y solo si nadie más puede
     empujar a la rama del PR: es una rama del repo base o el autor es dueño del fork.
     Se eligió un
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
   comentario en el PR que se actualiza en cada corrida de `map-pr` y un status
   `map-pr/verdict` por commit, ver `04-map-editor-and-ai.md`, "PR de mapas en CI"). Hito 5: portal web con cola
   de moderación que crea el PR automáticamente al aprobar.
4. **Contenido nuevo** (monstruos, items) no entra por patch de mapa: va en un PR de
   `data/` revisado por maintainers, porque afecta el balance.
5. **Créditos.** Cada patch fusionado agrega al autor en `world/CONTRIBUTORS.md`.
