# 06 — Contenido como datos (YAML) e i18n

Todo el contenido vive en `data/` y se valida contra JSON Schemas de
`packages/content-schema/schemas/`. El servidor lo carga al arrancar; el editor y el
cliente lo reciben ya compilado. `make validate` corre en CI.

```
data/
  balance.yaml          constantes de balance (XP, skills, muerte, regeneración)
  vocations.yaml
  ids.lock.yaml         IDs numéricos estables (generado, se commitea)
  borders.yaml          reglas de autoborder
  items/                un archivo por categoría (ground.yaml, weapons.yaml, ...)
  monsters/             un archivo por monstruo
  npcs/                 un archivo por NPC (diálogo, tienda, viajes)
  quests/               un archivo por quest
  spells.yaml
  recipes.yaml          oficios
  effects.yaml          efectos visuales y proyectiles
  cosmetics.yaml        outfits y monturas (futuro)
i18n/
  es/*.yaml  en/*.yaml  mismas claves en ambos (la CI lo verifica)
```

## Esquemas y validador
- Esquemas (JSON Schema 2020-12) en `packages/content-schema/schemas/`: `balance`,
  `vocations`, `items`, `monster`, `npc`, `quest`, `spells`, `recipes`, `borders`, `i18n`,
  `ids-lock`, más `common` con las definiciones compartidas (IDs, claves i18n, condiciones,
  acciones, elementos, skills). Son la fuente de verdad del formato; este doc da ejemplos.
- Dos keywords propios: `x-ref: <tipo>` marca un ID que debe existir (`item`, `monster`,
  `npc`, `quest`, `vocation`, `spell`, `shop`) y `x-i18n: true` marca una clave que debe
  existir en todos los idiomas. El validador los recolecta y los resuelve al final.
- `make validate` (→ `node packages/content-schema/src/cli.ts validate`) revisa además lo
  que un esquema no puede expresar:
  - IDs únicos por tipo (items entre todos los archivos de `items/`, tiendas entre NPCs).
  - En `monsters/`, `npcs/` y `quests/` el `id` es igual al nombre del archivo.
  - Referencias cruzadas, nodos de diálogo (`start`, `goto`; aviso si un nodo no se
    alcanza), pasos de quest en `set_quest_step`/`quest_state`, nodos en `dialog_action`.
  - Un NPC solo abre su propia tienda con `open_shop`.
  - Tiendas: ninguna tienda compra un item a un precio igual o mayor que el menor precio
    al que alguna lo vende (bucle de oro infinito); aviso si compra por encima del `value`.
  - Bendiciones: los `blessing` distintos que venden los NPCs no superan
    `death.max_blessings` de `balance.yaml`.
  - Aviso si una quest no tiene ningún `start_quest` en `data/npcs/`.
  - Un bloque por tipo de item (`weapon:` solo con `kind: weapon`, etc.), `max_stack`
    solo con `stackable: true`, `count` de loot > 1 solo para items apilables,
    `min <= max` en ataques, bordes solo entre items `ground`.
  - `balance.yaml` define todas las skills y cada vocación todos sus factores.
  - i18n: mismas claves y en el mismo archivo para `es` y `en`, mismos `{parámetros}`,
    toda clave usada en `data/` existe; aviso si una clave `item.*`, `monster.*`, ... no se usa.
  - Archivos en `data/` sin esquema (p. ej. `effects.yaml`, `cosmetics.yaml`) fallan hasta
    que su tarea agregue el esquema.
  - `ids.lock.yaml` (ver abajo).
- Formato de mensajes: `error data/monsters/wolf.yaml:17:7 loot[0].item: unknown item
  "wolf_pelts" (did you mean "wolf_pelt"?)`. Los avisos (`warning`) no hacen fallar.
- Formas compactas: una condición `if` es un objeto con una sola clave, o una lista de
  ellas (todas deben cumplirse). Una acción es `close` o un objeto con una sola clave, o
  una lista de acciones. Toda opción de diálogo tiene `goto`, `action` o ambos.

## IDs numéricos (`ids.lock.yaml`)
```yaml
items:
  grass: 3
  iron_sword: 13
```
- `make gen-ids` asigna `max + 1` a cada item nuevo y reescribe el archivo ordenado por
  número. Commitea el resultado junto con el item.
- Solo se agrega: si borras un item su número queda en el lock (aviso "retired id") y
  nunca se reutiliza. `make validate` compara con la rama base (`origin/main`, o la ref
  de `CONTENT_BASE_REF`) y falla si un número cambió o desapareció.

## Convenciones
- IDs en `snake_case` en inglés (`wolf`, `harbor_master`, `iron_sword`).
- Ningún texto visible en `data/`: solo claves i18n (`name: item.iron_sword.name`).
  Excepción: el campo `notes` para comentarios internos.
- Referencias cruzadas por ID; la validación falla si una referencia no existe.

## Item
```yaml
# data/items/weapons.yaml
- id: iron_sword
  kind: weapon            # ground | wall | decoration | container | weapon | armor | shield | tool | consumable | currency | material | rune
  sprite: weapons/iron_sword
  name: item.iron_sword.name
  description: item.iron_sword.desc
  weight: 3300            # en gramos (capacidad en "oz" se muestra derivada)
  stackable: false
  tradeable: true
  weapon:
    type: sword           # sword | axe | club | distance | wand
    attack: 13
    defense: 9
    hands: 1
  requires: { level: 5 }
  value: 120              # precio base que usan los NPCs como referencia
```
- **Contenedores** (`kind: container`, T1.8): `container.slots` es cuántos items caben.
  `creature_remains` (los restos de un monstruo) es un contenedor con `pickupable: false`.
  `pickupable: false` vale para cualquier item que no deba moverse de su tile.
- **Equipo:** `weapon`, `shield` y `armor` (con `armor.slot`) definen el slot; `requires`
  (`level`, `vocations`) y `vocations.yaml → weapons` limitan quién lo equipa.
- **Peso:** `weight` en gramos por unidad; la UI muestra oz = gramos / 100.
- **`balance.yaml → inventory`** (T1.8): `start_container` (item contenedor con que empieza
  un personaje nuevo), `max_open_containers`, `use_cooldown_ms` y `reach`.
- **Paso bloqueado** (regla del contrato, la aplican el validador de mapas y
  `mapcompile`): un item bloquea el paso si tiene `blocks_movement: true`. Los items
  `kind: wall` bloquean **por defecto**, aunque no declaren `blocks_movement`; un muro
  atravesable (arco, cortina) declara `blocks_movement: false`. El suelo decide con
  `ground.walkable`.

## Monstruo
```yaml
# data/monsters/wolf.yaml
id: wolf
name: monster.wolf.name
sprite: creatures/wolf
health: 25
experience: 28
speed: 190
armor: 2
defense: 5
behavior:
  aggressive: true
  flee_at_health_pct: 10
  target_distance: 1       # 1 = cuerpo a cuerpo; >1 = mantiene distancia
attacks:
  - type: melee
    min: 0
    max: 16
    interval_ms: 2000
resistances: { physical: 0, fire: -10, ice: 10 }
loot:
  - { item: wolf_pelt, chance: 0.25 }
  - { item: copper_coin, chance: 0.6, count: [1, 8] }
tags: [beast, puerto]
```

## NPC con diálogo de ventana
Extracto recortado de `data/npcs/puerto_foreman.yaml` (las tiendas, de
`data/npcs/puerto_provisioner.yaml`). Los archivos reales son la referencia completa.
```yaml
id: puerto_foreman
name: npc.puerto_foreman.name
sprite: npcs/miner_old
dialog:
  start: greet
  nodes:
    greet:
      text: npc.puerto_foreman.greet
      options:
        - text: npc.puerto_foreman.opt_ch1_bosun
          if: { quest_state: { quest: ch1_shipwreck, state: in_progress, step: talk_foreman } }
          action: { give_item: bosun_logbook }
          goto: ch1_logbook             # completa el paso talk_foreman (dialog_action)
        - text: npc.puerto_foreman.opt_ch1_lost
          if:                           # lista = todas deben cumplirse
            - { quest_state: { quest: ch1_shipwreck, state: in_progress, step: return_logbook } }
            - { lacks_item: { item: bosun_logbook } }
          action: { give_item: bosun_logbook }
          goto: ch1_logbook_again
        - text: npc.puerto_foreman.opt_work
          if: [{ quest_not_started: foreman_ore }, { level_at_least: 10 }]
          goto: ore_offer
        - text: dialog.bye
          action: close
    ore_offer:
      text: npc.puerto_foreman.ore_offer
      options:
        - text: dialog.accept
          action: { start_quest: foreman_ore }
          goto: ore_accepted
        - text: dialog.decline
          goto: greet
    # ... ch1_logbook, ch1_logbook_again, ore_accepted ...
# Tienda (data/npcs/puerto_provisioner.yaml): solo la abre su propio NPC con
# action: { open_shop: provisions_shop }
shop:
  id: provisions_shop
  sells: [{ item: rope, price: 50 }, { item: fishing_rod, price: 150 }]
  buys:  [{ item: rope, price: 15 }, { item: wolf_pelt, price: 5 }]
```
Viaje en barco (de `data/npcs/harbor_master.yaml`):
```yaml
        - text: npc.harbor_master.to_forest
          if:
            - { flag_equals: { key: forest_route_unlocked, value: 1 } }
            - { level_at_least: 10 }
          action: { travel: { island: bosque, price: 80 } }
```
Condiciones disponibles (`if`): `level_at_least`, `vocation_in`, `has_item`,
`lacks_item` (tiene menos de `count`, por defecto 1: lo contrario de `has_item`),
`quest_state`, `quest_not_started`, `flag_equals`, `skill_at_least`.
Acciones: `goto`, `close`, `give_item`, `take_item`, `give_xp`, `give_gold`,
`take_gold`, `start_quest`, `set_quest_step`, `set_flag`, `open_shop`, `travel`, `heal`,
`teleport`, `bless`.
Semántica del motor (T1.10):
- Una opción se muestra si se cumplen todas sus condiciones; al elegirla el servidor las
  vuelve a evaluar. Después revisa los costos de todas sus acciones juntas (`take_gold`,
  precio de `bless` y `travel`, `take_item`, bendición ya comprada, destino de `travel` o
  `teleport` inexistente): si alguno falla no ejecuta ninguna acción. Si pasan, ejecuta
  las acciones en orden y luego sigue el `goto`. Una opción sin `goto` deja el diálogo en
  el mismo nodo (por ejemplo `open_shop`); `close`, `travel` y `teleport` lo cierran.
- `has_item`/`lacks_item` cuentan todo el inventario (equipo y contenedores anidados).
- `give_item` da una unidad a la mochila; si no cabe (lugar o capacidad) cae al suelo
  bajo el jugador. `give_gold`/`take_gold` usan el dinero (`currency.worth`).
- `bless` guarda la bendición en `quest_state` (`bless.<id>` = 1) y cobra el precio; su
  efecto al morir es de T1.11. `heal` cura toda la vida. `travel` cobra y lleva al
  jugador junto al templo de la isla destino; si esa isla aún no existe en el mapa (hoy
  `bosque`), la opción se rechaza con `dialog.cannot_travel`.
- `skill_at_least` usa el nivel de skill actual; `level_at_least`, el nivel del jugador.

Estado por personaje en `quest_state` (clave → valor; una clave ausente vale 0):
`quest.<id>` (1 en curso, 2 completada), `quest.<id>.step` (índice del paso actual),
`quest.<id>.kills` (muertes del paso actual), `flag.<key>` (los `set_flag` y
`flag_equals`) y `bless.<id>`. Se guarda con el personaje, en la misma transacción.

El motor de diálogos (`server/internal/dialog`) solo interpreta este YAML: no hay
scripting libre en el MVP (más seguro y más fácil para la IA). Si algún día hace falta
lógica compleja, se evaluará Lua embebido con sandbox.

## Quest
Extracto de `data/quests/ch1_shipwreck.yaml`:
```yaml
id: ch1_shipwreck
name: quest.ch1_shipwreck.name
chapter: 1
min_level: 1
steps:
  - id: clear_wolves
    description: quest.ch1_shipwreck.step_clear_wolves
    complete_when: { kill: { monster: wolf, count: 6 } }
  # ... mine_bats, talk_foreman ...
  - id: return_logbook
    description: quest.ch1_shipwreck.step_return_logbook
    complete_when: { dialog_action: { npc: harbor_master, node: ch1_logbook_read } }
rewards:
  - { xp: 800 }
  - { gold: 150 }
  - { set_flag: { key: forest_route_unlocked, value: 1 } }
```
Las recompensas de `rewards` son iguales para todos. Lo que depende de la vocación se da
con `give_item`/`give_gold` en opciones de diálogo condicionadas con `vocation_in` (ver
`harbor_master`: espada para el guardián, monedas para el arcanista).

Semántica que asume el contenido (la implementa el motor de T1.10):
- Los pasos se cumplen en orden; solo se evalúa el `complete_when` del paso actual. Al
  cumplirse el último, se entregan las `rewards` y la quest pasa a `completed`.
- `quest_state` con `step` se cumple si la quest está `in_progress` y su paso actual es ese.
- `dialog_action` se cumple cuando el jugador llega a ese nodo del NPC (las acciones de la
  opción se ejecutan antes de entrar al nodo). Las opciones que llevan a ese nodo deben
  estar condicionadas al paso correcto con `quest_state`.
- `kill` cuenta las muertes desde que el paso pasó a ser el actual. Cuenta para cada
  jugador que hizo daño al monstruo (los mismos que reparten la experiencia).
- `has_item` y `flag_equals` se evalúan cuando el paso pasa a ser el actual y después de
  cada cambio relevante (de inventario o del flag) en el mismo tick. `has_item` cuenta el
  inventario completo, incluidos los contenedores anidados y los slots equipados.
  `lacks_item` usa el mismo conteo.
- Un paso cumplido no vuelve atrás aunque el jugador después pierda o venda el item. Por
  eso las opciones de entrega repiten `has_item` en su `if` y quitan el item con
  `take_item`.
- `make validate` exige que todo item de un paso `has_item` se pueda conseguir (loot, tienda,
  `give_item` o recompensa de quest). `server/internal/sim/balance_test.go` comprueba además que la
  fuente más fácil no esté más de 4 niveles por encima del `min_level` de la quest.

Ejemplos reales: `data/quests/ch1_shipwreck.yaml` (Capítulo 1) y las quests secundarias
`foreman_ore` y `diver_locket`.

## Hechizo
```yaml
- id: light_heal
  name: spell.light_heal.name
  words: "vita lumen"        # palabras propias, nunca las de Tibia
  vocations: [druid, arcanist]
  level: 6
  mana: 25
  group: healing
  cooldown_ms: 1500
  group_cooldown_ms: 1000
  effect: { heal: { base: 18, per_level: 0.25, per_magic_level: 1.4 } }
  visual: heal_sparkle
```
Implementado en T1.9 (`data/spells.yaml`, `server/internal/content/spells.go`):
- `effect` tiene exactamente uno de: `damage` (`element`, `base`, `per_level`,
  `per_magic_level`, `spread`; con `range` golpea a un objetivo a esa distancia, con
  `radius` a todo monstruo en un círculo alrededor del que lanza; uno de los dos), `heal`
  (mismos factores) o `conjure: { item }` (crea ese item, una runa con todas sus cargas, en
  la mochila). `haste` y `light` están en el esquema para hitos futuros y el servidor los
  rechaza todavía.
- `group` es `attack`, `healing` o `support`; `cooldown_ms` bloquea el hechizo y
  `group_cooldown_ms` a todo su grupo. `magic_level` es el nivel mágico mínimo.
- Las palabras deben ser únicas (el validador lo revisa) y propias. Los nombres van en
  `i18n/*/spells.yaml` (`spell.<id>.name`). `visual` todavía no se usa: el efecto sale del
  elemento.
- **Runas** (`kind: rune`): `rune: { spell, charges, magic_level }`. Lanzan el efecto de
  `spell` sin maná ni palabras, exigen `magic_level` y gastan una carga por uso. El
  servidor solo acepta runas de hechizos de daño a un objetivo (`damage.range`). Una runa
  conjurada o de botín trae todas sus cargas.
- **Varitas**: `weapon: { type: wand, attack, range, element }`; golpean
  `aleatorio(attack × combat.wand_min_factor, attack)` del elemento (`balance.yaml`).

## Receta de oficio
```yaml
- id: iron_ingot
  craft: smithing
  station: furnace
  level: 5
  inputs: [{ item: iron_ore, count: 3 }, { item: coal, count: 1 }]
  output: { item: iron_ingot, count: 1 }
  base_success: 0.6
  success_per_level: 0.02
  xp: 12
```

## Bordes (autoborder)
```yaml
# data/borders.yaml: cuando "from" toca a "to", las piezas se apilan sobre las casillas "to"
- id: grass_sand
  from: grass
  to: sand
  priority: 10             # mayor prioridad se dibuja encima
  pieces: { n: border_grass_sand_n, s: ..., e: ..., w: ..., ne: ..., nw: ..., se: ..., sw: ... }
  # opcionales: inner_ne, inner_nw, inner_se, inner_sw (esquinas cóncavas)
```

## i18n
```yaml
# i18n/es/items.yaml
item.iron_sword.name: "espada de hierro"
item.iron_sword.desc: "Una espada sencilla pero confiable."
# i18n/en/items.yaml
item.iron_sword.name: "iron sword"
item.iron_sword.desc: "A simple but reliable sword."
```
- Parámetros con llaves: `"Ganaste {xp} puntos de experiencia."`.
- Plurales con formato ICU cuando haga falta.
- La CI falla si una clave usada no existe en algún idioma.
