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
  outfits.yaml          outfits del personaje (T0.5)
  effects.yaml          efectos visuales y proyectiles
  cosmetics.yaml        tienda cosmética: moneda premium, paquetes y cosméticos (T5.7)
i18n/
  es/*.yaml  en/*.yaml  mismas claves en ambos (la CI lo verifica)
```

## Esquemas y validador
- Esquemas (JSON Schema 2020-12) en `packages/content-schema/schemas/`: `balance`,
  `vocations`, `items`, `monster`, `npc`, `quest`, `spells`, `recipes`, `boat_routes`,
  `borders`, `outfits`, `cosmetics`, `i18n`,
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
  - Items que no llevan a ningún lado (auditoría de contenido m4; con `world/`, cuentan
    solo los NPCs colocados en islas que no son `dev_only`): lo que un NPC compra tiene
    una fuente (botín, drop de un recurso, receta, tienda, `give_item`, recompensa o
    hechizo de conjurar); un arma, armadura o escudo comerciable con `value` que se puede
    conseguir tiene un NPC que lo compra, y un material así, un comprador, una receta o
    una quest que lo toma; un item de quest (`tradeable: false`, el `has_item` de un paso)
    que suelta un monstruo va con `each_player: true`.
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
  - Archivos en `data/` sin esquema (p. ej. `effects.yaml`) fallan hasta
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
- **Descripción:** `description` es la clave i18n que el cliente muestra al mirar el item
  (`item.<id>.desc` por convención). Un cartel (T5.5) es un item fijo cuya descripción es
  su texto del mapa: `brasal_dock_sign` tiene `description: text.volcan.dock_sign`, la
  misma clave de su entrada en `world/islands/volcan/texts.yaml`. Los de Puerto y el
  Bosque (y el de la puerta con llave, `volcan_gate_sign`) se llaman como su entrada de
  `texts.yaml` (`puerto_harbour_sign`); todos usan `sprite: decor/signpost`, el nombre
  compartido `item.signpost.name` y `blocks_movement: true`. El cliente empaqueta
  solo las claves que algún item usa como descripción.
- **Suelos volcánicos** (T5.5, `data/items/ground.yaml`, `speed` = costo de terreno en %):
  `ash` (ceniza, 140, como la tierra), `basalt` (losas de basalto de Brasal, 100, como la
  piedra), `cinder_path` (camino de escoria, 110), `cooled_lava` (lava enfriada, 100, como
  la piedra) y `lava` (fundida, no caminable, como el agua). Cada uno camina como el suelo
  que reemplazó en la isla, así que no cambian el ritmo con que se balanceó la caza.
- **Distancia y munición** (T3.1): un arma `type: distance` exige `range` (de 1 a 6, ver
  "Tope de los rangos" en Hechizos) y `ammo` (el `ammo.type` que dispara). La munición
  es `kind: ammo` con `ammo: { type, attack }` (`arrow` para los arcos, `bolt` para las
  ballestas de una mano de la auditoría de contenido M4), apilable, y va en el slot de
  munición. Cada disparo gasta una y suma su
  `attack` al del arma:
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
  `creature_remains` (los restos por defecto de un monstruo, y el cuerpo de un jugador) es
  un contenedor con `pickupable: false`, como los restos de cada familia de monstruos
  (`remains_fur`, `remains_chitin`, `remains_scales`, `remains_slag`, `remains_bones`,
  `remains_feathers`, `remains_humanoid`, `remains_bramble`; ver `corpse` en "Monstruo").
  `pickupable: false` vale para cualquier item que no deba moverse de su tile.
- **Item de misión** (`quest: true`, docs/17 UI-6, solo de dibujo): un item que existe
  para una quest (lo que pide el `has_item` de un paso o de un diálogo: `bosun_logbook`,
  `smuggler_tally`, `sealed_coffer`, `delver_chart`, `forge_seal`, `tarnished_locket`). El cliente pone su
  nombre en el color de misión (`--ui-item-quest`) en la ficha, el tooltip y el menú, le
  suma la marca "Objeto de misión" y lo enmarca en oro en el equipo y los contenedores. No
  cambia ninguna regla: que se pueda comerciar lo sigue diciendo `tradeable`. El servidor
  lo ignora.
- **Elevación** (`elevation`, docs/17 ART-8, solo de dibujo): cuántos píxeles de sprite
  sube lo que se apila encima de este item del mapa, y la criatura que pisa su casilla
  (mesas y cajones: 8). Las de una pila se suman hasta 24. El servidor la ignora; la leen
  el cliente, el editor y `mapcli render`.
- **Equipo:** `weapon`, `shield` y `armor` (con `armor.slot`) definen el slot; `requires`
  (`level`, `vocations`) y `vocations.yaml → weapons` limitan quién lo equipa.
- **Peso:** `weight` en gramos por unidad; la UI muestra oz = gramos / 100.
- **`balance.yaml → inventory`** (T1.8): `start_container` (item contenedor con que empieza
  un personaje nuevo), `max_open_containers`, `use_cooldown_ms`, `door_cooldown_ms` (espera
  entre dos usos de una puerta del mapa por un jugador, rechazados o no; mayor que 0) y
  `reach` (de 1 a 6: el medio alto de la ventana clásica de 15x11 + 1, lo que nota un
  monstruo; la vista ancha de 31x21 no lo estiró, `02-game-design.md` "La vista"; el esquema
  y `content.MaxReach` lo exigen).
- **Recursos** (T1.12): cualquier item del mapa (suelo o pila) puede ser un lugar de
  recolección con un bloque `resource`:
  ```yaml
  resource:
    tool: mining            # tool.use de la herramienta que lo cosecha
    skill: mining           # skill u oficio que da la chance y sube con cada intento
    reach: 1                # opcional (por defecto inventory.reach), con línea de visión;
                            # como mucho 6 (esquema y content.MaxReach), como las manos
    charges: 4              # cosechas por casilla antes de agotarse
    regen_ms: 300000        # se llena este tiempo después de la última cosecha
    chance: { base: 0.3, per_level: 0.02, max: 0.85 }
    drops:                  # uno por cosecha, por peso, entre los que el nivel alcanza
      - { item: rough_stone, weight: 6, count: [1, 3] }
      - { item: quartz_crystal, weight: 1, min_level: 5 }
  ```
  `balance.yaml → gathering`: `use_interval_ms` (rate limit por jugador) y
  `afk: { after_ms, factor }` (anti-AFK, ver `02-game-design.md`).
- **Soga:** una herramienta con `tool.use: rope` (la `rope` de `data/items/tools.yaml`)
  usada sobre un punto de soga (`rope_spot` de `portals.yaml`) sube al jugador
  (`02-game-design.md`, "Cambiar de piso"); sobre cualquier otra casilla sigue como una
  herramienta de recolección. El valor `rope` lo nombra el servidor (`session/portal.go`).
- **Destino de las herramientas** (auditoría de contenido m1): `make validate` exige que
  toda herramienta que un jugador puede conseguir en producción (la vende o la da un NPC
  colocado en una isla que no es `dev_only`, la suelta un monstruo, sale de una receta o
  de una recompensa) tenga dónde usarse en el mapa de producción: un recurso de su
  `tool` (pesca, minería, tala) o una estación de una receta que la pide (herrería)
  colocados en los chunks de esas islas, o un portal `rope_spot` (la cuerda). La pala
  (`tool.use: shovel`) no tiene nada todavía: por eso ya no se vende.
- **Consumibles** (`consumable`): `heal_hp` y `heal_mp` curan vida y maná (los brebajes de
  maná de M2, `data/items/misc.yaml`); `food_ms` (auditoría de contenido m2) es cuánto
  tiempo de la condición `well_fed` da comerlo (ver "Condiciones").
- **Portales** (`portal`): un item fijo del mapa que muestra un portal de `portals.yaml`
  (`02-game-design.md` "Cambiar de piso"): `kind` (`stairs`, `ladder`, `hole`,
  `rope_spot`, `teleport`) y, opcional, `leads` (`up` o `down`: el sentido en que cambia
  de piso). Va en la entrada del portal, en la pila o como suelo; no mueve a nadie.
  Ejemplo (`data/items/decoration.yaml`):
  ```yaml
  - id: ladder_up
    kind: decoration
    sprite: decor/ladder_up
    name: item.ladder_up.name
    description: item.ladder_up.desc
    pickupable: false
    portal: { kind: ladder, leads: up }
  ```
  El validador de contenido exige `pickupable: false`, que no bloquee el paso (la entrada
  de un portal es caminable) y que un `hole` no diga `leads: up` ni un `rope_spot`
  `leads: down`. Dónde va lo valida el mapa (`03-world-and-maps.md`, "Validación"): todo
  portal salvo un `boat` tiene en su entrada un item que lo muestre, y un item de portal
  donde no sale ninguno es advertencia. Hoy: `stairs_down`/`stairs_up`, `ladder_up`/
  `ladder_down`, `hole`, `rope_spot` y `teleport` (arte propio de
  `tools/spritegen/src/recipes/portals.ts`, salvo las escaleras). El servidor lo lee como
  `content.PortalLook`: `mapcompile` rechaza un portal sin su item y la sesión avisa al
  arrancar si falta (para un `world.bin` compilado antes de cambiar `data/items`).
- **Paso bloqueado** (regla del contrato, la aplican el validador de mapas y
  `mapcompile`): un item bloquea el paso si tiene `blocks_movement: true`. Los items
  `kind: wall` bloquean **por defecto**, aunque no declaren `blocks_movement`; un muro
  atravesable (arco, cortina) declara `blocks_movement: false`. El suelo decide con
  `ground.walkable`.
- **Puertas y llaves** (reglas en `02-game-design.md` "Puertas con llave"): una puerta es
  un par de items fijos con bloque `door`; la cerrada nombra la abierta (`open`) y puede
  llevar `key` (id de llave, mismo formato que un id); la abierta nombra la cerrada
  (`closed`). Una llave es cualquier item con `key` en la raíz: el id de las puertas que
  abre. Ejemplo (`data/items/doors.yaml` y la llave en `misc.yaml`):
  ```yaml
  - id: forge_gate
    kind: decoration
    sprite: doors/forge_gate
    name: item.forge_gate.name
    pickupable: false
    blocks_movement: true
    blocks_sight: true
    door: { key: forge_gate, open: forge_gate_open }
  - id: forge_gate_open
    kind: decoration
    sprite: doors/forge_gate_open
    name: item.forge_gate_open.name
    pickupable: false
    door: { closed: forge_gate }
  - id: ember_key
    kind: material
    sprite: quest/ember_key
    name: item.ember_key.name
    tradeable: false
    key: forge_gate
  ```
  El validador (y `content.CheckDoors` al arrancar el servidor) exige: exactamente uno de
  `open` y `closed`; que el par se nombre de vuelta; `pickupable: false` en los dos; la
  cerrada bloquea el paso y la abierta no; `key` solo en la cerrada y con al menos un
  item llave que lo tenga; que toda llave se pueda levantar (sin `pickupable: false`: un
  jugador la lleva encima); y que ninguna puerta sea llave. Agregar otra puerta con llave
  es solo datos: un par nuevo, su llave, textos y sprites; el mapa la coloca como
  cualquier item. Dónde se coloca lo valida el mapa (`03-world-and-maps.md`,
  "Validación"): un item de puerta por casilla, una sala determinable detrás de cada
  puerta con llave, nada de afuera en ella (tampoco el destino de un `teleport` de un
  diálogo de `data/npcs`) y el chequeo de escape (cada lado llega a un templo sin llaves
  ni herramientas; nadie entra a una sala sin su llave).

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
corpse: remains_fur        # opcional: los restos que deja (por defecto, creature_remains)
```
- **Restos** (`corpse`, opcional): el item que el servidor deja donde muere, con el botín
  adentro. Es el cuerpo caído de su familia: `remains_fur` (bestias con pelo: lobo, sabueso,
  rata, ciervo, jabalí, murciélago), `remains_chitin` (cangrejo, araña, escarabajo,
  reptante), `remains_scales` (salamandra, dragoncillo, sapo), `remains_slag` (los gólems de
  escoria), `remains_bones` (el minero ahogado), `remains_feathers` (la gaviota),
  `remains_humanoid` (saqueadores, contrabandistas, mineros de obsidiana) y
  `remains_bramble` (el espinoso). Tiene que ser un item de `kind: container` con
  `pickupable: false` (`make validate` y el arranque del servidor exigen lo mismo); sin
  `corpse`, el monstruo deja `creature_remains`. Los restos duran
  `combat.monster_corpse_ms` como siempre y el botín que no entra en sus `container.slots`
  se pierde. Todo monstruo de `data/monsters` tiene el
  suyo. Un monstruo nuevo de una familia nueva suma su item (`data/items/decoration.yaml`,
  `make gen-ids`, nombre en es y en) y su modelo en `tools/spritegen/src/engine/specs/remains.ts`.
- **Habilidades** (reglas en `02-game-design.md` "Monstruos", "Habilidades"; el esquema
  es `monster.schema.json`, `$defs/attack`):
  ```yaml
  attacks:
    # Área: un círculo (radius 1-6, center self por defecto o target) o un rayo (length
    # 1-6, desde el monstruo hacia su objetivo). Sirve con melee, distance o spell.
    - { type: spell, element: fire, min: 22, max: 52, interval_ms: 2000, chance: 0.3,
        area: { shape: beam, length: 4 } }
    - { type: distance, min: 0, max: 34, interval_ms: 2000, range: 4,
        area: { shape: circle, radius: 1, center: target } }
    # below_hp_pct (1-100, cualquier ataque): solo con la vida por debajo de ese %.
    # heal_self: min-max de vida, solo herido y peleando; sin element, range, area ni condition.
    - { type: heal_self, min: 60, max: 90, interval_ms: 4000, chance: 0.5, below_hp_pct: 50 }
    # summon: count (1-8) en casillas libres a su lado, max_alive (1-8, por defecto count)
    # vivas a la vez; sin min ni max. La invocada no puede invocar.
    - { type: summon, interval_ms: 60000, below_hp_pct: 60,
        summon: { monster: cinder_salamander, count: 2, max_alive: 2 } }
  phases:                      # de jefe; below_hp_pct 1-99, distinto en cada una
    - below_hp_pct: 30
      speed_mult: 1.3          # (0, 4], por defecto 1
      attack_interval_mult: 0.75
      attacks_add: [ { type: melee, element: fire, min: 10, max: 30, interval_ms: 3000 } ]
  ```
  El alcance de un ataque con área (a qué distancia de su objetivo lo usa) es el radio de
  un círculo alrededor de sí, el largo de un rayo o, en un círculo alrededor del
  objetivo, el del ataque sin área (`range`, 1 cuerpo a cuerpo); un rayo solo lo usa con
  su objetivo en una de sus 8 líneas y un círculo alrededor de sí con él dentro de su área
  redonda (docs/02 "Habilidades"). `make validate` y el
  arranque del servidor (`content.ParseMonster`, `session.checkSummons`) rechazan lo mismo:
  un tipo, una forma o un centro que no existe, un círculo sin `radius` o un rayo sin
  `length` (o con `radius`, o centrado en el objetivo), un `range` en un rayo o en un
  círculo alrededor de sí (no cuenta: su alcance es su largo o su radio), radios y
  largos de más de 6 (lo
  que nota un monstruo), un `range` de más de 6, un círculo alrededor del objetivo que
  llega más lejos que eso (`range` + `radius`, 1 + `radius` cuerpo a cuerpo: dañaría a
  un jugador que ni conoce al monstruo), un `heal_self` o `summon` con `element`, `range`, `area` o
  `condition`, un `summon` con `min`/`max` o sin `summon` (el arranque también uno armado
  en Go sin `summon` o con `max_alive` 0), uno de un monstruo que no
  existe o que invoca a su vez, y dos fases con el mismo `below_hp_pct`. Los duelos de
  balance (`server/internal/sim/foe_test.go`) los simulan: un monstruo nuevo con
  habilidades no necesita más que su caso en el test de su isla.
- **Botín de quest** (`each_player: true` en una entrada de `loot`, auditoría de
  contenido m9): en vez de uno en los restos, a cada jugador que le hizo daño al monstruo
  y cuya quest en curso pide ese item (un paso `has_item` de ese item, el actual o el
  recién cumplido mientras su entrega es el paso actual, que el jugador ya no cumple: si lo
  perdió antes de entregarlo, el próximo custodio le da otro) le llega el suyo a la mochila, o a los pies si no entra, con su
  propia tirada de `chance`, y un mensaje (`dialog.quest_drop`). Nadie más lo recibe y los
  restos no lo llevan. Como no se distingue un item perdido de uno ya entregado,
  `make validate` y el arranque del servidor exigen lo mismo: que sea el `has_item` de
  algún paso de quest; que el paso siguiente sea su entrega, un paso `dialog_action` cuyo
  nodo no es el `start` del diálogo de ese NPC (se llega con solo abrirlo) y al que
  **todas** las opciones que llevan (`goto`, al menos una) lo toman con `take_item` (una
  vez entregado la quest deja atrás la entrega y el item no cae más, aunque la quest
  siga, como `ch2_coffer` después de las tarjas; un camino a la entrega que no lo tomara
  se lo dejaría al jugador); y que el item tenga `tradeable: false` y `value: 0` (las copias que alguien
  junte tirándolas al piso no valen nada ni se comercian). Lo usan el sello de la forja del
  custodio (`ch3_warden`) y, desde m4, la tarja de los contrabandistas y el cofre sellado
  de los reptantes (`ch2_coffer`) y la carta del minero de obsidiana (`ch3_gate`):
  `make validate` exige `each_player` en todo item de quest que cae de un monstruo, así
  deja de caer cuando la quest terminó.
- **Comida y `well_fed`:** si algún item tiene `food_ms`, el arranque exige la condición
  `well_fed` de `kind: regen` con `stacking: add` (cada comida suma su tiempo) y que
  ninguna comida pura dure más que su `max_ms` (no se podría comer nunca).

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
`teleport`, `bless`, y las de desarrollo `train_skill` y `restore_mana` (abajo). (La
acción `travel` de T1.10 se quitó en T3.5: los viajes son rutas.)

**Tema de una opción (`tag`, opcional; docs/17 UI-8).** La ventana del diálogo agrupa los
botones por tema, con un ícono y un borde de color: Misiones, Comercio, Viajes, Servicios y
Conversación (más "Volver" y "Adiós" en su fila). El cliente lo deduce al compilar
(`client/vite/content.ts` `dialogTopics`, por NPC): `close` o `dialog.bye` → Adiós;
`dialog.back` → Volver; `open_shop` → Comercio; una condición o acción `quest_*` →
Misiones; `heal`, `bless`, `train_skill` o `restore_mana` → Servicios; `teleport` o un
nodo con `boat_routes` → Viajes; lo demás, Conversación. Una opción de conversación con
`goto` mira el nodo siguiente: si ahí hay misiones, viajes o servicios, toma ese tema.
`tag` manda sobre todo eso cuando la deducción se equivoca:
```yaml
        - text: npc.puerto_armorer.opt_advice
          tag: trade                 # quests | trade | travel | services | talk
          goto: advice
```
Es solo de presentación: el servidor lo ignora. Una misma clave de texto con dos temas en un
mismo NPC hace fallar el test del cliente (`vite/content.test.ts`): ponle `tag` a una de
las dos. Guía de escritura: como mucho 300 caracteres por texto de nodo y textos de opción
cortos (el botón muestra 2 líneas y el resto va al `title`).

**Acciones de desarrollo** (solo la instructora de la Isla de Pruebas,
`16-probar-el-juego.md`): en el juego real regalarían lo que se gana jugando (y un maná
gratis junto al templo entrenaría el nivel mágico sin límite), así que solo existen en NPCs
de islas `dev_only` (`world.yaml`), que la imagen de producción no compila.
```yaml
        - text: npc.pruebas_trainer.opt_train_combat
          if: { vocation_in: [guardian] }
          action:
            - { train_skill: { skill: sword, level: 45 } }   # sube la skill a 45, nunca la baja
            - { train_skill: { skill: magic, level: 2 } }    # el nivel mágico es la skill magic
          goto: trained
        - text: npc.pruebas_trainer.opt_heal
          action: [{ heal: true }, { restore_mana: true }]   # vida y maná
          goto: healed
```
- `train_skill: { skill, level }`: `skill` es una skill de `balance.yaml` (combate,
  `magic`, `fishing` u oficio) y `level` va de 1 a 500. Si la skill está más abajo, queda en
  `level` con el progreso hacia el siguiente en 0 y el cliente recibe `PlayerSkills` y el
  aviso `progress.skill_up`, como una subida por uso; si ya está en `level` o más arriba, no
  cambia nada.
- `restore_mana: true`: llena el maná (`heal` sigue llenando solo la vida).
- **Dónde valen** (tres capas): `make validate` rechaza un NPC con una de ellas que no
  esté colocado (`world/islands/<id>/npcs.yaml`) o que esté en alguna isla que no sea
  `dev_only` (`packages/content-schema`, `checkDevOnlyActions`); el servidor no arranca si
  coloca un NPC así en una isla sin la marca `dev` de `world.bin` (la pone
  `mapcompile -dev`; `content.CheckDevPlacement` en `session.initNPCs`), y al elegir la
  opción vuelve a mirar la isla del NPC: fuera de una isla de desarrollo no corre nada de
  la opción (tampoco sus otras acciones) y contesta `dialog.dev_only` (`dialog.Check`).
  Además, un `world.bin` con islas de desarrollo no carga con `RPG_ENV` de producción
  (`03-world-and-maps.md`, "Compilación").
- **NPC de desarrollo** (`dev_only: true` a nivel del NPC, revisión del lote 5): vuelve de
  desarrollo **todas** sus acciones, también las que no lo son por sí solas (el oro y la
  experiencia gratis de la instructora, `give_gold: 10000` y `give_xp: 50000`, que antes
  solo protegía que ella también tuviera `train_skill`). Pasa por las mismas tres capas:
  `make validate` lo rechaza sin colocar o fuera de islas `dev_only`; el servidor no
  arranca con él en una isla sin la marca `dev` (`content.CheckDevPlacement`); y fuera de
  una isla de desarrollo `dialog.Check` rechaza con `dialog.dev_only` cualquier opción
  suya salvo la que solo cierra (`close`), también la que solo navega con `goto`: de su
  diálogo no se ve más que el saludo.
  Úsalo en todo NPC pensado solo para probar.
- Una acción de desarrollo nueva se suma a `content.Action.DevOnly` (Go) y a
  `DEV_ONLY_ACTIONS` (`packages/content-schema/src/validate.ts`).
Semántica del motor (T1.10):
- Una opción se muestra si se cumplen todas sus condiciones; al elegirla el servidor las
  vuelve a evaluar. Después revisa los costos de todas sus acciones juntas (`take_gold`,
  precio de `bless`, `take_item`, bendición ya comprada, destino de `teleport`
  inexistente): si alguno falla no ejecuta ninguna acción. Si pasan, ejecuta
  las acciones en orden y luego sigue el `goto`. Una opción sin `goto` deja el diálogo en
  el mismo nodo (por ejemplo `open_shop`); `close` y `teleport` lo cierran.
- `teleport` deja al jugador en su destino o, si está ocupado, en la casilla libre más
  cercana a 1 de distancia, solo en el área del destino y nunca en una casilla de casa
  (como la llegada de un barco o de un portal). Si no hay ninguna, el destino cuenta como
  inexistente. El destino tiene que ser una casilla caminable de una isla, fuera de las
  casas y no sobre una puerta con llave colocada abierta: si no, ni el servidor arranca ni
  pasa `make validate` (docs/03 "Validación"; lo mismo vale para la llegada `to` de una
  ruta de barco).
- `has_item`/`lacks_item` cuentan todo el inventario (equipo y contenedores anidados).
  Un contenedor con algo adentro no cuenta ni se puede quitar o vender (se perdería su
  contenido).
- Abrir el diálogo cuenta como llegar a su nodo `start` (`dialog_action`).
- Tiendas: precio entre 0 y 1 000 000 000, y ningún NPC puede comprar un item por más de
  lo que otro lo vende (`make test` lo verifica con `content.CheckRefs`; el servidor no
  arranca si no se cumple).
- `give_item` da una unidad a la mochila; si no cabe (lugar o capacidad) cae al suelo
  bajo el jugador. `give_gold`/`take_gold` usan el dinero (`currency.worth`).
- `bless: { blessing, price, per_level }` guarda la bendición en `quest_state`
  (`bless.<id>` = 1) y cobra `price + per_level × nivel` del que la compra (auditoría de
  contenido M6; `per_level` es opcional, 0 = precio fijo; nunca menos de 0). Una opción
  con `bless` no puede tener `give_xp` (lo rechazan `make validate` y el arranque: cobraría
  con otro nivel que el que mostró), y si el nivel cambió desde que se mostró el nodo, el
  servidor no cobra, avisa (`dialog.price_changed`) y lo vuelve a mandar. El texto de la opción recibe ese
  total como `{price}` (la opción de diálogo lleva parámetros, docs/05); al
  morir reduce la pérdida y se consume (reglas en `02-game-design.md`, "Muerte"). `heal` cura toda la vida (no el maná).
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

Una quest importante puede declarar `music` (una pool de `assets/sounds.yaml` que suena en
unos rectángulos de unos pisos): ver "Música de una quest importante", en "Sonido".

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
`count`), la del Capítulo 3 (`ch3_embers` → `ch3_gate` → `ch3_warden`, T5.5: "ir a un
lugar y abrir" es un `dialog_action` con un NPC puesto en ese lugar, el eco de la forja,
que toma la llave con `take_item`) y las quests secundarias `foreman_ore` y
`diver_locket`.

## Hechizo
```yaml
- id: light_heal
  name: spell.light_heal.name
  words: "vita lumen"        # palabras propias, nunca las de Tibia
  vocations: [arcanist]       # el druida tiene sus propias curas (verdant_mend, mend_other)
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
- T3.1: `damage` y `heal` aceptan `skill` (`fist`, `sword`, `axe`, `club`, `distance`,
  `shield` o `weapon`) junto con `per_skill`. Ese par va siempre junto y suma `nivel de la
  skill × per_skill` (en combate: con las condiciones de skill, como `keen_eye`). Los
  hechizos del montaraz escalan así con la distancia. **`skill: weapon`** (progresión de
  hechizos, 2026-11) es la skill del arma que el que lanza tiene en la mano: la de su tipo
  (`sword`, `axe`, `club`; `distance` con un arco o una ballesta) y `fist` sin arma o con
  una varita, que no entrena skill (`session/magic.go` `scalingSkill`, la misma regla que
  el golpe cuerpo a cuerpo). Así los golpes de área del guardián crecen con la espada, el
  hacha o la maza que entrena. `light` está en el esquema para un hito futuro y el
  servidor lo rechaza todavía.
- T3.2: dos efectos más. `condition: { id, duration_ms | ticks + damage, chance, range }`
  pone una condición al que lanza o, con `range`, a un monstruo o, con PvP (T5.2), a un
  jugador, a esa distancia con línea de visión (los chequeos de un hechizo de un objetivo;
  contra un jugador, además, las reglas de un ataque directo). `range` solo vale en una
  condición dañina (`kind: damage`, o `speed` con `speed_pct` negativo): el validador lo
  rechaza en una beneficiosa, que contra un jugador contaría como un ataque. `cure: [ids]` quita esas
  condiciones al que lanza; si no tiene ninguna, falla sin gastar maná. Un `damage` acepta
  también `condition`: se aplica, con su `chance`, a cada monstruo al que el golpe le hizo
  daño. Ver "Condiciones".
- **Tope de los rangos:** el `range` de un arma (`weapon.range`), de `damage`, de `heal`,
  de una `condition` y del ataque de un monstruo va de 1 a 6, y el `radius` de un `damage` de área de 0 a 6 (el
  esquema y `content.MaxRange`): el medio alto de la ventana clásica de 15x11 + 1, lo que
  nota un monstruo. Así un monstruo golpeado desde tan lejos como apunta un jugador, o
  por un área, siempre lo nota y devuelve el golpe; la vista ancha de 31x21 no lo estiró
  (`02-game-design.md` "La vista").
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
  `amount` niveles en combate), `invisible` o `regen` (auditoría de contenido m2: la
  regeneración de la vocación es `regen_pct` % más fuerte; la da la comida, `well_fed`).
  Las que no son de daño exigen `max_ms`.
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

## Gremios (T5.1)
Las reglas de los gremios viven en `balance.yaml → guild` (`balance.schema.json`, todas
obligatorias). Qué hace cada una: `02-game-design.md`, "Gremios". El cliente también lee
`found_cost`, `found_min_level`, `name_max` y `motd_max` (panel e inputs).
```yaml
guild:
  found_cost: 2000          # en cobre; se pagan (con vuelto) y se destruyen (sumidero)
  found_min_level: 18
  max_members: 50           # 2..500, el líder incluido
  max_vice_leaders: 4
  max_invites: 15           # invitaciones pendientes por gremio (1..100)
  invite_hours: 36          # vida de una invitación (1..720)
  name_min: 3               # caracteres
  name_max: 24              # hasta 32 (guilds.name)
  name_max_words: 4
  motd_max: 160             # hasta 255 (largo del chat)
  reserved_parts: [admin, staff, ...]   # minúsculas, sin espacios, como subcadena
  reserved_words: [gm, mod, ...]        # minúsculas, como palabra entera
```
- Textos: `client.guild.*` (panel), `guild.*` y `look.player*` (mensajes del servidor) en
  `i18n/*/client.yaml`; la página pública usa `site.guilds.*` (`i18n/*/site.yaml`). El
  rango de un miembro se traduce con `client.guild.rank.<leader|vice|member>`.

## PvP (T5.2)
`balance.yaml → pvp` (`balance.schema.json`; el bloque es obligatorio en los datos del
juego, opcional para el servidor: sin él, PvP apagado). Qué hace cada valor y por qué esos
números: `02-game-design.md`, "PvP". Los números son propios.
```yaml
pvp:
  enabled: true             # false: nadie hiere a otro jugador (solo PvE)
  min_level: 20             # por debajo, ni ataca ni lo atacan jugadores
  damage_pct: 60            # 1..100: todo golpe entre jugadores se escala a esto
  aggressor_ms: 420000      # marca de agresor y derecho a defensa propia
  lock_ms: 40000            # bloqueo PvP (salir del juego; el atacante, zonas protegidas)
  kill_lock_ms: 540000      # bloqueo tras una muerte injustificada (>= lock_ms, <= 1 h)
  kill_credit_ms: 40000     # quién se lleva la muerte (<= aggressor_ms y <= lock_ms)
  murderer:                 # y outlaw, con la misma forma
    hours: 60               # duración desde la última muerte injustificada
    windows: [{hours: 20, kills: 4}, {hours: 120, kills: 9}]   # 1..4 ventanas, hours <= 1440, kills <= 256
    equipment_drop_pct: 40  # caída mínima al morir con la marca (ignora bendiciones)
    backpack_drop_pct: 100
  war:
    kill_limit: 30
    hours: 96
    answer_hours: 24
    max_wars: 3
```
- Textos: `pvp.*` y `guild.war_*` (servidor), `client.skull.*`, `client.pvp.*` y
  `client.guild.war*` (cliente) en `i18n/*/client.yaml`.
- Zonas `pvp` y `no_pvp` del mapa: `03-world-and-maps.md`.

## Casas (T5.4)
`balance.yaml → houses` (`balance.schema.json`; sin bloque o `enabled: false`, apagadas;
necesitan el mercado, que cobra el alquiler y recibe los items). Reglas: `02-game-design.md`,
"Casas". Las casas mismas (casillas, puertas, alquiler) son datos del mapa:
`world/islands/<isla>/houses.yaml` (`03-world-and-maps.md`), y sus nombres van en
`i18n/*/world.yaml` (`house.<id>.name`; el panel de casas del editor los escribe al guardar,
docs/04 "Casas en el editor"). Los números son propios.
```yaml
houses:
  enabled: true
  min_level: 12             # para alquilar o recibir una casa
  period_days: 7            # período de alquiler, pagado por adelantado (1..90)
  max_periods: 4            # períodos pagados por delante (1..12)
  max_guests: 20            # nombres en la lista de invitados (0..100)
  items_per_tile: 3         # instancias de items por casilla de la casa (1..50)
  transfer_minutes: 10      # una oferta de transferencia espera (1..120)
  action_burst: 8           # anti-flood de acciones y movimientos de items en casas
  action_refill_ms: 300
  inactive_days: 28         # M6: sin nadie de la cuenta del dueño en el juego tanto, al
                            # vencer el alquiler la casa se libera (0..365; 0 = nunca;
                            # el servidor o la base caídos no cuentan)
```
- El alquiler de cada casa es dato del mapa (`houses.yaml → rent`): casillas × 60 en
  Puerto, × 90 en el Bosque, × 120 en la Volcánica (auditoría de contenido M6, lo revisa
  `packages/content-schema/src/house-rent.test.ts`; una isla nueva con casas necesita su
  tarifa ahí).
- Textos: `house.*` y `gm.house_*` (servidor), `client.house.*` (ventana) en
  `i18n/*/client.yaml`; `site.houses.*` en `site.yaml`.

## Mercado e intercambio (T5.3)
`balance.yaml → market` y `→ trade` (`balance.schema.json`; obligatorios en los datos del
juego, opcionales para el servidor: sin bloque o `enabled: false`, apagados). Reglas:
`02-game-design.md`, "Economía". Los números son propios.
```yaml
market:
  enabled: true
  fee_permille: 20          # comisión: milésimas de cantidad × precio, destruida (sumidero)
  fee_min: 5                # y entre fee_min y fee_max, en cobre
  fee_max: 50000
  max_offers: 15            # ofertas activas por personaje (1..100)
  max_amount: 2000          # unidades por oferta (1..100000)
  max_price: 5000000        # cobre por unidad (1..1000000000)
  durations_hours: [12, 48, 120]   # 1..8 opciones, cada una 1..1440
  list_size: 15             # ofertas por lado en una búsqueda
  history_size: 25          # operaciones propias que se ven
  reference_days: 5         # ventana del precio de referencia (mediana de votos, m13)
  reference_min_votes: 3    # sin referencia con menos votos (uno por cuenta vendedora y día)
  reference_min_sellers: 2  # ni con menos cuentas vendedoras distintas (<= min_votes, make validate)
  reference_min_accounts: 3 # ni con menos cuentas en total; las que se vendieron entre sí no cuentan
  mailbox_shown: 30         # items del buzón por ventana
  action_burst: 6           # anti-flood: ráfaga y recarga por acción
  action_refill_ms: 400
  push_every_ms: 500        # refresco en vivo de una ventana abierta: como mucho uno cada tanto (50..60000)
trade:
  enabled: true
  max_items: 6              # items (pilas o contenedores vacíos) por lado (1..32)
  request_ms: 25000         # la invitación vence (1000..600000)
  action_burst: 6           # anti-flood de las acciones del intercambio
  action_refill_ms: 300
```
- Items: `tradeable: true` permite el intercambio y, si además no es moneda ni fijo del
  mapa, el mercado. `market_board: true` (en un item fijo del mapa) lo hace tablero del
  mercado (`market_board`, en Puerto, en Raigal y en Brasal).
- Textos: `trade.*`, `market.*` y `gm.market_*` (servidor), `client.trade.*`,
  `client.market.*` y `client.battle.trade` (cliente) en `i18n/*/client.yaml`.

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
  completo) y `bosque_to_puerto` (Tavin Rema, 60 monedas, sin requisitos); T5.5:
  `bosque_to_volcan` (Tavin Rema, 150, nivel 25), `volcan_to_bosque` (Nerea Vado, 100) y
  `volcan_to_puerto` (Nerea Vado, 140), sin requisitos de vuelta. El texto de la
  opción dice destino y precio (`npc.<capitán>.to_*`).
- Una isla `dev_only` (la Isla de Pruebas, docs/03) no puede tener rutas: el servidor de
  producción las revisa contra un mapa sin ella. Su barquero (`pruebas_ferryman`) usa
  opciones con `take_gold` y `teleport` a las llegadas de las rutas de verdad.
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
  números en `balance.yaml → travel` (`combat_block_ms`, `arrival_radius`). La llegada
  por un portal (escaleras y demás) usa el mismo `arrival_radius`. `combat_block_ms`
  también es el bloqueo de logout de cualquier pelea (`02-game-design.md`, "Bloqueo de
  logout en combate").
- Textos: `travel.*` en `i18n/*/dialog.yaml` y `client.voyage.sailed` en `client.yaml`.

## Tutorial (T4.2)
```yaml
# data/tutorial.yaml (esquema tutorial.schema.json); sin archivo no hay tutorial
island: puerto                 # isla de world/world.yaml: solo sus personajes nuevos lo ven
steps:                         # en orden; 1..64
  - id: first_steps
    text: tutorial.step.first_steps   # clave i18n; puede usar {count}
    when: { event: walk, count: 5 }   # count por defecto 1, máximo 1000
  - id: meet_priestess
    text: tutorial.step.meet_priestess
    when: { event: talk_npc, ref: puerto_priest }
  - id: first_spell
    text: tutorial.step.first_spell
    when: { event: cast_spell }
    highlight: hotbar                 # opcional: data-tutorial del elemento a resaltar
    vocations: [arcanist, druid]      # opcional: las demás vocaciones lo saltan
rewards:                         # opcional; al terminar, nunca al saltar
  - { gold: 20 }                 # 1..1000
  - { item: seaweed_poultice, count: 2 }   # 1..100
```
- Eventos (`when.event`) y su `ref` opcional (vacío = cualquiera): `walk` (pasos
  caminados; sin `ref`), `target` y `kill` (monstruo), `open_container`, `pick_up`
  (un item que entra al equipo desde afuera), `equip`, `use_item` (consumible), `gather`
  (el item obtenido) → item; `cast_spell` → hechizo; `talk_npc` → NPC; `craft` → receta de
  `recipes.yaml`; `quest_start` → quest (si la quest ya empezó antes de llegar al paso, el
  paso se da por cumplido: una quest no se puede empezar dos veces). Mover un item del
  suelo a un slot cuenta como `equip`, no como `pick_up`. Agregar un evento nuevo sí requiere Go
  (`session/tutorial.go` y un enganche donde ocurre).
- `highlight`: `inventory`, `hotbar`, `battle`, `chat`, `skills` o `stats`.
- Progreso en `quest_state` del personaje: `tutorial.step` (índice + 1), `tutorial.count`
  y `tutorial.done` (1 = terminado, 2 = saltado). Reordenar o quitar pasos mueve a quien
  está en medio; si su paso ya no existe, el tutorial termina sin premio.
- Validación: `make validate` revisa esquema, referencias, ids únicos, la isla y las
  recetas; el servidor repite todo al arrancar (`content.Tutorial.Check`) y no arranca si
  falla. Textos en `i18n/*/tutorial.yaml` (pasos y `tutorial.completed`/`skipped`) y el
  panel en `client.tutorial.*` de `client.yaml`.

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
reglas `grass_sand` y `sand_water`, y las de la Isla Volcánica (T5.5): `ash_sand`,
`cooled_lava_sand`, `cooled_lava_ash`, `cinder_path_ash` y `cooled_lava_lava` (la costra
sobre la lava fundida). Su arte lo genera `tools/spritepack/src/gen-borders.ts` en
`assets/sprites/borders/`: cada pieza recorta el suelo `from` de su arte propio
(`assets/sprites/<sprite>.png`, de `tools/spritegen`), de su textura de pack o de su color
placeholder, en ese orden (un test verifica que los PNG commiteados son los que produce).
Si cambia la receta de un suelo, corre `make spritegen` y después `gen-borders`.

## Outfits (T0.5)
`data/outfits.yaml` (esquema `outfits`): cómo se dibuja un personaje jugador.
```yaml
- id: citizen
  sprite: outfits/citizen   # carpeta de frames
  frames: 3                 # 0 = parado, 1 y 2 = los dos pasos (máximo 3)
```
- El `sprite` de un outfit es una carpeta: el atlas tiene `<sprite>/<dir>_<frame>`
  (`outfits/citizen/s_0`), con `dir` en `n`, `e`, `s`, `w`. spritepack cuenta cada frame
  como un sprite usado por `data/` (un frame sin arte recibe el placeholder automático,
  como cualquier sprite).
- **Desde docs/17 (A12) los cuatro atuendos son personajes animados de LPC:** la entrada
  `animations` de su `sprite` en `assets/sprites.yaml` arma sus frames (quieto, caminar,
  atacar y caer, de 64x64) y los nombres `<sprite>/<dir>_<frame>` de arriba pasan a ser
  alias de esos frames (0 = la pose quieta, 1.. = el ciclo de caminar). `frames` sigue en
  el esquema y en el servidor; con una animación, el cliente usa la animación
  (`assets/README.md`, "Sprites animados").
- Todos los jugadores usan `citizen` hasta que `Outfit.look_id` elija otro. El cliente
  elige el frame según la dirección y el avance del paso (`client/CLAUDE.md`, "Animación de
  criaturas").
- IDs únicos; el validador no exige que los PNG existan (eso lo revisa spritepack).

## Animación de criaturas (docs/17 ANI)
El `sprite` de un monstruo, un NPC o un outfit sigue siendo una ruta lógica: **cómo se
anima es un dato del sprite, no del monstruo**, y vive en `assets/sprites.yaml`
(`palettes` y `animations`; formato en `assets/README.md`, "Sprites animados"). Así dos
monstruos con el mismo sprite se mueven igual y el servidor no se entera: el YAML de
`data/monsters` y `data/npcs` no cambia.
- **Con frames:** una entrada con `layers` compone hojas de un pack (personajes de LPC) en
  frames `<sprite>/<acción>_<dir>_<n>` (`idle`, `walk`, `attack`, `death`). Arte propio:
  archivos con esos nombres en `assets/sprites/` (los del motor de sprites de spritegen,
  como `creatures/bristleback_boar/walk_s_0..3`, o las hojas de Gemini de
  `creatures/wolf/`). Una entrada sin `layers` les da `mirror: true` (el este es el oeste
  espejado), `anchor: bc` (los pies sobre la casilla) y `ms` por acción
  (`{ attack: 110, death: 200 }`). Quieto y atacar se dibujan solo hacia las direcciones
  que tienen frames; hacia las otras, el frame parado y la embestida de ANI-5.
- **Sin frames:** el cliente mueve el sprite único (salto por casilla, inclinación,
  respiración, embestida, golpe y caída: ANI-5). Una entrada sin `layers` le da pistas:
  `facing: left | right` (hacia dónde mira el dibujo; se espeja para caminar al otro lado)
  y `flying: true` (flota y nunca salta).
- Un monstruo humanoide o un NPC nuevo: su `sprite:` en `data/` y su entrada en
  `animations` con las capas de `assets/vendor/ulpc/` (o arte propio), revisada con el
  preview de `assets/README.md`.

## Tienda cosmética (T5.7)
`data/cosmetics.yaml` (esquema `cosmetics`; reglas de juego en `02-game-design.md`, "Tienda
cosmética"). Solo apariencia: el esquema no tiene ningún campo que pueda tocar el juego.
```yaml
currency:
  id: premium                 # la única moneda premium (nácar); siempre "premium"
limits:                       # obligatorio (reglas en 02-game-design.md, "Límites por cuenta")
  daily_premium: 5000         # nácar comprable con dinero por cuenta en 24 h (1..1 000 000)
  equip_burst: 5              # anti-flood de equipar: cambios de golpe (1..100)
  equip_refill_ms: 500        # ... y uno más cada tantos ms (50..60 000)
  max_premium_grant: 100000   # tope de un /premium del staff (1..1 000 000)
packs:                        # nácar que se vende por dinero real (checkout del proveedor)
  - { id: pack_small, amount: 100, price: 1990, currency: CLP }
cosmetics:
  - { id: outfit_sailor, kind: outfit, price: 300, outfit: sailor }          # un look de outfits.yaml
  - { id: color_tide, kind: outfit_color, price: 120, tint: "#7fa8d8" }      # tinte multiplicativo
  - { id: name_gilded, kind: name_effect, price: 200, style: gold }          # gold | ember | frost
```
- `packs[].price` es un entero en la **unidad menor** de `currency` (código ISO 4217, en
  mayúsculas), como lo pide el `unit_price` de Mercado Pago: el CLP no tiene decimales, así
  que `1990` son $1.990; en USD `499` serían $4,99. `amount` es el nácar que se acredita, y
  nunca puede pasar `limits.daily_premium` (ese paquete no se podría comprar nunca).
- `cosmetics[].kind`: `outfit`, `outfit_color` o `name_effect` (los valores del `CHECK` de
  `cosmetics.kind`; `mount` queda reservado). Cada tipo lleva solo su campo: `outfit` (id de
  `data/outfits.yaml`), `tint` (`#rrggbb` en minúsculas) o `style`. `price` es en nácar.
- Un atuendo nuevo: su entrada en `animations` de `assets/sprites.yaml` (capas de LPC y
  paletas, como `outfits/citizen`), su entrada en `data/outfits.yaml` y después el
  cosmético que lo vende.
- Textos en `i18n/<idioma>/cosmetics.yaml`, con claves que salen del id (no se escriben en
  el YAML): `cosmetic.<id>.name` y `cosmetic.<id>.desc`, `cosmetic_pack.<id>.name`, y
  `premium.name` / `premium.amount` (`{count}`) para la moneda. El servidor lee
  `cosmetic_pack.<id>.name` (`content.CosmeticShop.LoadTexts`) para el título del ítem en
  la página del proveedor, en el idioma del sitio; si falta en `es`, no arranca.
- `make validate` revisa además: ids únicos (paquetes y cosméticos por separado), que
  ningún paquete pase `limits.daily_premium`, que el `outfit` exista en `outfits.yaml` y no
  sea `citizen` (gratis para todos; el servidor lo vuelve a revisar al cargar), que dos colores
  no usen el mismo tinte, que cada campo vaya con su tipo y que existan todos los textos en
  todos los idiomas (y avisa de claves `cosmetic.*` que nadie usa).
- El servidor sincroniza el catálogo con la tabla `cosmetics` al arrancar; el cliente lo
  recibe en `content.cosmetics` (`client/vite/content.ts`) y lo dibuja con
  `client/src/render/cosmetics.ts`.

## Noticias (T4.3)
Una noticia es un archivo `data/news/<YYYY-MM-DD>-<slug>.yaml` (slug: `a-z`, `0-9` y `-`).
El nombre del archivo es su URL en el sitio (`/news/2026-11-01-bienvenida`) y su fecha. Se
publican con el build del cliente (`virtual:rpg-site` en `client/vite/content.ts`): no hay
admin web ni base de datos, así que una noticia se propone y se revisa como un PR.
Esquema: `packages/content-schema/schemas/news.schema.json`; `make validate` revisa además
que `date` coincida con el nombre del archivo.

```yaml
date: "2026-11-01"           # igual al prefijo del nombre del archivo
title:                       # una línea, máx. 120 caracteres, sin < >
  es: "Bienvenidos a Neque's Realm"
  en: "Welcome to Neque's Realm"
body:                        # obligatorios es y en
  es: |
    Primer párrafo. Un salto de línea simple se une con un espacio.

    Una lista:
    - con **negrita**
    - y *cursiva*
  en: |
    ...
```

El título y el cuerpo se escriben en la misma noticia, no en `i18n/`: son contenido de un
solo uso. El cuerpo es un subconjunto mínimo de Markdown (`client/src/site/markdown.ts`):
párrafos separados por una línea en blanco, líneas que empiezan con `- ` como lista, y
`**negrita**` y `*cursiva*` (sin espacio justo dentro de los marcadores, sin anidar). Nada
más: ni HTML ni links. Se dibuja como nodos de texto de Preact, nunca con `innerHTML`, así
que un `<` en el cuerpo se ve tal cual. Los textos fijos del sitio están en
`i18n/<lang>/site.yaml` (claves `site.*`).

## Sonido (`assets/sounds.yaml`, T3.7)
El manifiesto de sonido vive en `assets/` (no en `data/`) pero se valida igual
(`sounds.schema.json` y `make validate`); el cliente lo empaqueta como `content.sounds`.
Qué suena con cada evento y cómo se juega está en `02-game-design.md`, "Sonido"; los
archivos, su origen y su presupuesto, en `assets/README.md` "Sonido" y `07`, "Audio".
```yaml
format: 1
sounds:          # id: archivo bajo assets/, canal, volumen 0..1, copias a la vez
  hit: { file: sounds/sfx/hit.ogg, channel: sfx, volume: 0.8, max_voices: 4 }
  # Un tema entero (make music-gemini): su largo, dónde termina su cuerpo (empieza el final
  # compuesto) y los segundos desde los que el director puede arrancarlo. Sin `seconds`, el
  # archivo es un loop (los de soundgen) y se repite.
  music_puerto: { file: sounds/music/gemini/town_puerto_1.ogg, channel: music, volume: 0.7,
                  seconds: 176.43, end: 171.83, entries: [10, 26.7, 53.4, 73.4, 100, 126.7, 141.7] }
events:          # evento del cliente → sonido, o lista para elegir uno al azar
  effect.hit: hit
music:           # el director de música (client/src/audio/director.ts)
  fades: { zone: 5000, boss_in: 1500, boss_out: 6000, title: 3000, next: 4000 }   # ms
  dwell_ms: 3000            # una zona nueva manda recién tras este tiempo en ella
  boss_hold_ms: 5000        # la música del jefe sigue esto tras perderlo de vista
  resume_ms: 180000         # de vuelta en una zona antes de esto, su tema sigue donde iba
  gap_ms: [6000, 15000]     # entre dos temas de una zona, este silencio (al azar)
  islands: { puerto: town_puerto }   # isla de world.yaml → pool
  underground: cave                  # pisos z > 7 → pool
  pools:                             # pool → sus temas (sonidos del canal music)
    town_puerto: [music_puerto, music_puerto_2, music_puerto_3]
    cave: [music_cueva, music_cueva_mine]
    boss_forge: [music_boss_forge]
  title: title                       # pool de fuera del juego (login y personajes)
  bosses: { slagbound_warden: boss_forge }   # monstruo de data/monsters → pool
ambient:
  fade_ms: 2000
  islands: { puerto: amb_olas }
```
- **Pools:** cada lugar nombra una pool y el director la baraja: cada tema una vez por
  vuelta y nunca el mismo dos veces seguidas. Una pool de un solo tema lo repite desde otro
  punto de entrada. Los lugares son las islas, el subsuelo, el título, cada jefe y el área de
  una quest importante (abajo). **Las peleas comunes no tienen música propia** (el dueño,
  2026-11-18): ya no existen `combat` ni `combat_hold_ms`.
- **Temas enteros:** `seconds`, `end` y `entries` solo van en sonidos `music`. `entries`
  sube, nunca es 0 y nunca pasa de `end`; `end` no pasa de `seconds`. Los escribe
  `make music-gemini` (medidos sobre la envolvente de nivel: dónde empieza una frase, a 15 s
  o más uno de otro y nunca en los últimos 30 s del cuerpo); a mano solo para un tema de otro
  origen.
- `make validate` exige que cada archivo exista (y uno de `vendor/` tenga su fila en
  `CREDITS.md`), que cada evento nombre un sonido `sfx` o `ui`, que cada pool liste sonidos
  del canal `music`, que islas, subsuelo, título, jefes y las quests nombren pools que
  existen, que los loops de `ambient` sean de su canal, que las islas existan en
  `world/world.yaml`, que las claves de `bosses` sean monstruos de `data/monsters`, que
  `gap_ms` sea `[mínimo, máximo]` y que las medidas de cada tema quepan en él.
- **Música de Gemini:** las líneas entre `# gemini-music:sounds:begin`/`end` (sonidos),
  `# gemini-music:pools:begin`/`end` (las pools de cada lugar con música de Gemini, dentro
  de `pools:`) y `# gemini-music:rules:begin`/`end` (`title`, `bosses`) las escribe
  `make music-gemini` desde las elecciones del dueño; no se editan a mano. Una pool hecha a
  mano va en `pools:` fuera de las marcas. Lo que tiene cada lugar está en
  `assets/sounds/music/gemini.yaml` (`format: 2`): `pick`, `provisional`, `extras` (las
  versiones extra de las cuevas), `skipped` (las que quedaron afuera y por qué),
  `file`/`volume` del sonido del lugar, `fallback` (el tema de soundgen que vuelve con
  `none`), `pool` y `tracks` (cada toma con su fuente, el título que le dio Gemini, su
  prompt, si es provisional, y sus medidas: `seconds`, `end`, `entries`, `longest_quiet`,
  `lufs`, `kbps`, `bytes`). El resto del archivo es a mano.

### Música de una quest importante (`music` en `data/quests/<id>.yaml`)
Una quest importante puede tener música propia en un lugar: mientras el jugador está en uno
de sus rectángulos, en uno de sus pisos, suena su pool en vez de la de la zona (un jefe a la
vista igual le gana). Entra y sale como una zona: tras `dwell_ms` y con el fundido `zone`.
```yaml
music:
  pool: boss_forge                     # una pool de assets/sounds.yaml music.pools
  floors: [9]
  rects:
    - { x: 3690, y: 5790, w: 12, h: 10 }
```
- Lo lee solo el cliente (`vite/content.ts` `loadQuestMusic`, `audio/cues.ts`
  `questPoolAt`); el servidor no lo usa ni lo necesita. `make validate` revisa la forma
  (`quest.schema.json`) y que la pool exista.
- Es por lugar, no por paso de la quest: el cliente no sabe en qué paso va el jugador. Una
  música que dependa del paso necesitaría que el servidor lo mande (docs/14, pendientes).
- Hoy ninguna quest la usa: falta un tema propio para la que la merezca.

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
