# 06 — Contenido como datos (YAML) e i18n

Todo el contenido vive en `data/` y se valida contra JSON Schemas de
`packages/content-schema/schemas/`. El servidor lo carga al arrancar; el editor y el
cliente lo reciben ya compilado. `make validate` corre en CI.

```
data/
  balance.yaml          constantes de balance (XP, skills, muerte, regeneración, condiciones, grupos,
                        economía, reportes e inactividad)
  vocations.yaml
  ids.lock.yaml         IDs numéricos estables (generado, se commitea)
  borders.yaml          reglas de autoborder
  items/                un archivo por categoría (ground.yaml, weapons.yaml, ...)
  monsters/             un archivo por monstruo
  npcs/                 un archivo por NPC (diálogo, tienda)
  quests/               un archivo por quest
  spells.yaml
  recipes.yaml          oficios
  boat_routes.yaml      rutas de barco (T3.5)
  effects.yaml          efectos visuales y proyectiles
  cosmetics.yaml        outfits y monturas (futuro)
i18n/
  es/*.yaml  en/*.yaml  mismas claves en ambos (la CI lo verifica)
```

## Esquemas y validador
- Esquemas (JSON Schema 2020-12) en `packages/content-schema/schemas/`: `balance`,
  `vocations`, `items`, `monster`, `npc`, `quest`, `spells`, `recipes`, `boat_routes`,
  `borders`, `i18n`,
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
  - i18n en código (T1.13): todo literal con forma de clave (`"chat.flood"`, `t("client.title")`)
    en `server/internal/**/*.go`, `client/src` y `editor/src` (sin tests ni código generado)
    cuyo primer segmento sea un espacio de nombres de los catálogos debe existir en todos los
    idiomas. Las claves armadas en tiempo de ejecución (`skill.${id}.name`) no se revisan.
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
  kind: weapon            # ground | wall | decoration | container | weapon | armor | shield | tool | consumable | currency | material | rune | ammo
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
- **Distancia y munición** (T3.1): un arma `type: distance` exige `range` y `ammo` (el
  `ammo.type` que dispara). La munición es `kind: ammo` con `ammo: { type: arrow, attack }`,
  apilable, y va en el slot de munición. Cada disparo gasta una y suma su `attack` al del
  arma:
  ```yaml
  - id: short_bow
    kind: weapon
    weapon: { type: distance, attack: 2, range: 5, hands: 2, ammo: arrow }
    requires: { vocations: [ranger] }
  - id: arrow
    kind: ammo
    stackable: true
    max_stack: 100
    ammo: { type: arrow, attack: 9 }
  ```
- **Contenedores** (`kind: container`, T1.8): `container.slots` es cuántos items caben.
  `creature_remains` (los restos de un monstruo) es un contenedor con `pickupable: false`.
  `pickupable: false` vale para cualquier item que no deba moverse de su tile.
- **Equipo:** `weapon`, `shield` y `armor` (con `armor.slot`) definen el slot; `requires`
  (`level`, `vocations`) y `vocations.yaml → weapons` limitan quién lo equipa.
- **Peso:** `weight` en gramos por unidad; la UI muestra oz = gramos / 100.
- **`balance.yaml → inventory`** (T1.8): `start_container` (item contenedor con que empieza
  un personaje nuevo), `max_open_containers`, `use_cooldown_ms` y `reach`.
- **Recursos** (T1.12): cualquier item del mapa (suelo o pila) puede ser un lugar de
  recolección con un bloque `resource`:
  ```yaml
  resource:
    tool: mining            # tool.use de la herramienta que lo cosecha
    skill: mining           # skill u oficio que da la chance y sube con cada intento
    reach: 1                # opcional (por defecto inventory.reach), con línea de visión
    charges: 4              # cosechas por casilla antes de agotarse
    regen_ms: 300000        # se llena este tiempo después de la última cosecha
    chance: { base: 0.3, per_level: 0.02, max: 0.85 }
    drops:                  # uno por cosecha, por peso, entre los que el nivel alcanza
      - { item: rough_stone, weight: 6, count: [1, 3] }
      - { item: quartz_crystal, weight: 1, min_level: 5 }
  ```
  `balance.yaml → gathering`: `use_interval_ms` (rate limit por jugador) y
  `afk: { after_ms, factor }` (anti-AFK, ver `02-game-design.md`).
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
  sells: [{ item: rope, price: 45 }, { item: fishing_rod, price: 140 }]
  buys:  [{ item: rope, price: 14 }, { item: wolf_pelt, price: 5 }]
```
Viaje en barco (de `data/npcs/harbor_master.yaml`): el nodo marcado ofrece las rutas de
`data/boat_routes.yaml` cuyo `captain` es este NPC (ver "Rutas de barco"):
```yaml
    travel:
      text: npc.harbor_master.travel
      boat_routes: true             # las rutas van antes de las opciones del nodo
      options:
        - { text: dialog.back, goto: greet }
```
Condiciones disponibles (`if`): `level_at_least`, `vocation_in`, `has_item`,
`lacks_item` (tiene menos de `count`, por defecto 1: lo contrario de `has_item`),
`quest_state`, `quest_not_started`, `flag_equals`, `skill_at_least`.
Acciones: `goto`, `close`, `give_item`, `take_item`, `give_xp`, `give_gold`,
`take_gold`, `start_quest`, `set_quest_step`, `set_flag`, `open_shop`, `heal`,
`teleport`, `bless`. (La acción `travel` de T1.10 se quitó en T3.5: los viajes son rutas.)
Semántica del motor (T1.10):
- Una opción se muestra si se cumplen todas sus condiciones; al elegirla el servidor las
  vuelve a evaluar. Después revisa los costos de todas sus acciones juntas (`take_gold`,
  precio de `bless`, `take_item`, bendición ya comprada, destino de `teleport`
  inexistente): si alguno falla no ejecuta ninguna acción. Si pasan, ejecuta
  las acciones en orden y luego sigue el `goto`. Una opción sin `goto` deja el diálogo en
  el mismo nodo (por ejemplo `open_shop`); `close` y `teleport` lo cierran.
- `has_item`/`lacks_item` cuentan todo el inventario (equipo y contenedores anidados).
  Un contenedor con algo adentro no cuenta ni se puede quitar o vender (se perdería su
  contenido).
- Abrir el diálogo cuenta como llegar a su nodo `start` (`dialog_action`).
- Tiendas: precio entre 0 y 1 000 000 000, y ningún NPC puede comprar un item por más de
  lo que otro lo vende (`make test` lo verifica con `content.CheckRefs`; el servidor no
  arranca si no se cumple).
- `give_item` da una unidad a la mochila; si no cabe (lugar o capacidad) cae al suelo
  bajo el jugador. `give_gold`/`take_gold` usan el dinero (`currency.worth`).
- `bless` guarda la bendición en `quest_state` (`bless.<id>` = 1) y cobra el precio; al
  morir reduce la pérdida y se consume (reglas en `02-game-design.md`, "Muerte"). `heal` cura toda la vida.
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

Ejemplos reales: `data/quests/ch1_shipwreck.yaml` (Capítulo 1), la cadena del Capítulo 2
(`ch2_roots` → `ch2_coffer`, T3.6: la segunda se ofrece con `quest_state` de la primera
`completed` y su propio `level_at_least`; entregas con `has_item` + `take_item` con
`count`) y las quests secundarias `foreman_ore` y `diver_locket`.

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
  (mismos factores; con `range`, T3.1, cura a otro jugador, el objetivo, a esa distancia y
  con línea de visión, nunca al que lanza) o `conjure: { item, count }` (crea ese item en la
  mochila: una runa con todas sus cargas o, con `count`, esa cantidad de un item apilable,
  juntada con las pilas que ya hay; si no entra entera, el hechizo falla sin gastar maná).
- T3.1: `damage` y `heal` aceptan `skill` (`fist`, `sword`, `axe`, `club`, `distance` o
  `shield`) junto con `per_skill`. Ese par va siempre junto y suma `nivel de la skill ×
  per_skill`. Los hechizos del montaraz escalan así con la distancia. `light` está en el
  esquema para un hito futuro y el servidor lo rechaza todavía.
- T3.2: dos efectos más. `condition: { id, duration_ms | ticks + damage, chance, range }`
  pone una condición al que lanza o, con `range`, a un monstruo a esa distancia con línea
  de visión (los chequeos de un hechizo de un objetivo). `cure: [ids]` quita esas
  condiciones al que lanza; si no tiene ninguna, falla sin gastar maná. Un `damage` acepta
  también `condition`: se aplica, con su `chance`, a cada monstruo al que el golpe le hizo
  daño. Ver "Condiciones".
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

## Condiciones (T3.2)
Las reglas de cada condición viven en `balance.yaml → conditions` (`balance.schema.json
#/$defs/condition`); las fuentes dicen cuánto y cuánto tiempo:
```yaml
# data/balance.yaml
conditions:
  poison: { kind: damage, element: earth, interval_ms: 2200, max_ticks: 25, stacking: add, persists: true }
  hasted: { kind: speed, speed_pct: 35, max_ms: 45000, stacking: refresh, cancels: [slowed] }
# una fuente (common.schema.json#/$defs/conditionApply): en un hechizo, un damage o un ataque
- { type: melee, min: 0, max: 26, interval_ms: 2000, condition: { id: poison, chance: 0.3, ticks: 5, damage: 3 } }
```
- `kind`: `damage` (un golpe de `element` cada `interval_ms`; exige `element`,
  `interval_ms` y `max_ticks`), `speed` (`speed_pct`, negativo frena), `skill` (`skill` +
  `amount` niveles en combate) o `invisible`. Las que no son de daño exigen `max_ms`.
- `stacking`: `refresh` (queda el tiempo o los golpes mayores y el daño mayor) o `add`
  (se suman hasta `max_ticks` / `max_ms`). `cancels` lista las que quita al aplicarse.
- `persists: true` = sobrevive a un relogueo (ver `02-game-design.md`, "Condiciones").
- Una fuente de daño da `ticks` y `damage`; las demás `duration_ms`. `chance` vacío =
  siempre. Los ids son el enum `conditionId` de `common.schema.json`; el servidor revisa
  al arrancar que cada fuente nombre una condición de `balance.yaml`.
- Un monstruo con `behavior.sees_invisible: true` ve (y ataca) a los invisibles.
- Nombres de la UI: `condition.<id>.name` en `i18n/*/client.yaml`.

## Grupos (T3.3)
Las reglas de los grupos y de la experiencia compartida viven en `balance.yaml → party`
(`balance.schema.json`, todas obligatorias). Qué hace cada una: `02-game-design.md`,
"Grupos".
```yaml
party:
  max_members: 6            # 2..32, el líder incluido
  invite_ms: 45000          # vida de una invitación (máx. 600000)
  update_ms: 1000           # cada cuánto, como mucho, se refresca vida/maná/nivel
  share_distance: 24        # casillas (Chebyshev, mismo piso) desde la muerte del monstruo
  contribution_ms: 75000    # ventana de "contribuyó hace poco"
  level_range_pct: 70       # nivel mínimo, en % del más alto que comparte (anti-carry)
  level_gap_always: 3       # o a lo sumo estos niveles por debajo
  bonus_pct_per_member: 6   # bonus del pozo por cada miembro que comparte después del primero
  max_bonus_pct: 24         # tope del bonus
```
- Textos de la UI: `client.party.*` y los mensajes del servidor `party.*` en
  `i18n/*/client.yaml`. El nombre de la isla de un miembro fuera de vista es
  `island.<id>.name` (`i18n/*/world.yaml`, que el cliente ahora empaqueta solo por nombres).

## Receta de oficio
```yaml
# data/recipes.yaml (T3.4)
- id: smith_felling_axe
  craft: smithing          # skill que da la chance y gana `xp` intentos por intento
  station: anvil           # item del mapa (no recogible) junto al que hay que estar
  tool: smithing           # opcional: tool.use de una herramienta que hay que llevar
  level: 2                 # nivel mínimo del oficio
  time_ms: 4000            # sin otro intento de oficio o recolección hasta entonces
  inputs: [{ item: iron_ingot, count: 2 }, { item: birch_log, count: 1 }]
  output: { item: felling_axe, count: 1 }
  base_success: 0.55       # chance = min(max_success, base + per_level × (nivel − level))
  success_per_level: 0.04
  max_success: 0.9         # opcional, por defecto 1
  xp: 2
```
- Cada ingrediente aparece una vez; cada intento gasta todos, salga o no. El servidor (y
  `make validate`) rechazan estaciones, ingredientes o resultados desconocidos.
- Una estación es un item cualquiera del mapa que alguna receta nombra: no lleva campo
  propio. Usarla manda `StationOpen` (`05-network-protocol.md`).
- Textos: `craft.*` (mensajes del servidor) y `client.craft.*` en `i18n/*/client.yaml`.

## Rutas de barco (T3.5)
```yaml
# data/boat_routes.yaml (esquema boat_routes.schema.json)
- id: puerto_to_bosque
  captain: harbor_master           # NPC que la vende, a ≤ 8 casillas del muelle
  text: npc.harbor_master.to_forest  # texto de la opción (destino y precio, a mano)
  from: { x: 3201, y: 6434, z: 7 } # muelle de salida (caminable)
  to: { x: 4120, y: 6050, z: 7 }   # casilla de llegada (caminable, cualquier isla)
  price: 80                        # 0..1 000 000 000
  requires:                        # opcional; todas deben cumplirse
    level: 10
    quest: ch1_shipwreck           # completada
    item: { item: boat_ticket, count: 1, consume: true }  # consume: false = solo llevarlo
```
- `requires.item` no puede ser una moneda (el oro se cobra con `price`).
- Rutas actuales (T3.6): `puerto_to_bosque` (Maren Holt, 80 monedas, nivel 10 y Capítulo 1
  completo) y `bosque_to_puerto` (Tavin Rema, 60 monedas, sin requisitos). El texto de la
  opción dice destino y precio (`npc.<capitán>.to_*`).
- El NPC necesita un nodo con `boat_routes: true`: ahí el servidor agrega una opción por
  ruta (antes de las del nodo, `option_id` 101, 102…). Rutas + opciones del nodo ≤ 9.
  Todas las rutas se muestran; un requisito que falla se explica al elegirla.
- Validación: `make validate` (`content-schema`) revisa el esquema y que existan capitán,
  quest e item; `mapcli validate` (`packages/map-format`) revisa que el capitán esté
  colocado a ≤ 8 casillas del muelle (mismo piso) y que `from` y `to` sean casillas
  caminables de una isla. El servidor repite todo al arrancar y no arranca si falla.
- `-boat-routes <archivo>` (o `RPG_BOAT_ROUTES`) reemplaza `data/boat_routes.yaml`: el
  E2E usa `client/e2e/fixtures/boat_routes.yaml` (Puerto → testisle).
- Reglas del viaje (combate, cobro, llegada): `02-game-design.md`, "Viajes en barco";
  números en `balance.yaml → travel` (`combat_block_ms`, `arrival_radius`).
- Textos: `travel.*` en `i18n/*/dialog.yaml` y `client.voyage.sailed` en `client.yaml`.

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
Cada nombre de pieza dice dónde está el suelo `from` respecto de la casilla `to`:
`n`/`s`/`e`/`w` = de ese lado; `ne`/`nw`/`se`/`sw` = solo en esa diagonal (ninguno de los
dos lados vecinos); `inner_*` = en los dos lados vecinos (si falta, se apilan los dos
lados). Las piezas son items `kind: decoration`, `pickupable: false`, sin bloquear. Hoy hay
reglas `grass_sand` y `sand_water`; su arte placeholder propio lo genera
`tools/spritepack/src/gen-borders.ts` en `assets/sprites/borders/` (un test verifica que
los PNG commiteados son los que produce).

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
- Plurales con formato ICU cuando haga falta:
  `"{seconds, plural, one {# segundo} other {# segundos}}"` (`=N` exacto tiene prioridad;
  categorías de `Intl.PluralRules` del idioma). Lo implementa `translator` del cliente.
- Los valores de los parámetros se insertan tal cual y nunca se vuelven a interpretar: el
  texto de un jugador no puede inyectar `{...}` ni HTML.
- La CI falla si una clave usada no existe en algún idioma.

## Anti-bot y anti-AFK (T4.1)
Tres bloques de `balance.yaml` (esquema en `balance.schema.json`, diseño en
`01-architecture.md`, "Trampas y anti-bot"):
```yaml
economy:
  coin_ratio: 100
  log: { flush_ms: 2000, batch_size: 500 }   # lotes del log de economía, fuera del tick
  check_every_ms: 60000                      # cuadratura de cada personaje en línea (0 = nunca)
  outlier:                                   # alerta si crea más que esto por hora de juego
    window_ms: 3600000
    gold_per_hour: { base: 20000, per_level: 2000 }   # en cobre: base + per_level × nivel
    items_per_hour: { base: 5000, per_level: 50 }     # unidades
reports: { burst: 3, refill_ms: 600000, same_target_ms: 3600000, max_reason: 200, events: 20 }
idle: { kick_after_ms: 900000, warn_before_ms: 60000 } # kick_after_ms 0 lo apaga
```
- `reports`: por cuenta, `burst` reportes seguidos y luego uno cada `refill_ms`; la misma
  cuenta reporta al mismo personaje una vez cada `same_target_ms`. `max_reason` ≤ 200 y
  `events` ≤ 32 (el anillo de eventos recientes de cada jugador).
- `idle`: `kick_after_ms` es 0 o al menos 60000, y `warn_before_ms` menor que él.
- `antibot` (detección de bots): `eval_every_ms` (0 la apaga), `half_life_ms`, `pause_ms`,
  `signals.<regularity|reaction|route|session|income>` con su `weight` y sus límites,
  `thresholds` (`log < notify < presence < suspend`, y ningún peso solo puede llegar a
  `notify`: `peso / (1 − 0,5^(eval_every_ms / half_life_ms)) < notify`), `presence` (`timeout_ms` y
  `defer_alert_ms` ≥ 60000, `delay_ms`, `fail_points`, `confirm_ms`, `random_per_hour`
  0..1) y `suspend_ms` (hasta 30 días). Qué mide cada señal y por qué
  esos números: `01-architecture.md`, "Detección de bots". Textos del chequeo:
  `presence.question.<color>` y `presence.option.<color>` en `i18n/*/client.yaml`.
