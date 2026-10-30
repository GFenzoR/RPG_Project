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
  weight: 3500            # en gramos (capacidad en "oz" se muestra derivada)
  stackable: false
  tradeable: true
  weapon:
    type: sword           # sword | axe | club | distance | wand
    attack: 14
    defense: 10
    hands: 1
  requires: { level: 5 }
  value: 120              # precio base que usan los NPCs como referencia
```

## Monstruo
```yaml
# data/monsters/wolf.yaml
id: wolf
name: monster.wolf.name
sprite: creatures/wolf
health: 25
experience: 18
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
    max: 12
    interval_ms: 2000
resistances: { physical: 0, fire: -10, ice: 10 }
loot:
  - { item: wolf_pelt, chance: 0.25 }
  - { item: copper_coin, chance: 0.6, count: [1, 8] }
tags: [beast, puerto]
```

## NPC con diálogo de ventana
```yaml
# data/npcs/harbor_master.yaml
id: harbor_master
name: npc.harbor_master.name
sprite: npcs/sailor_old
dialog:
  start: greet
  nodes:
    greet:
      text: npc.harbor_master.greet
      options:
        - text: dialog.ask_travel
          goto: travel
        - text: npc.harbor_master.opt_work
          goto: work
          if: { quest_not_started: ch1_shipwreck }
        - text: dialog.trade
          action: { open_shop: harbor_shop }
        - text: dialog.bye
          action: close
    work:
      text: npc.harbor_master.work_offer
      options:
        - text: dialog.accept
          action:
            - { start_quest: ch1_shipwreck }
            - { give_item: rusty_key }
          goto: work_accepted
        - text: dialog.decline
          goto: greet
    work_accepted:
      text: npc.harbor_master.work_accepted
      options:
        - { text: dialog.bye, action: close }
    travel:
      text: npc.harbor_master.travel
      options:
        - text: npc.harbor_master.to_forest
          if: { level_at_least: 10 }
          action: { travel: { island: bosque, price: 80 } }
        - { text: dialog.back, goto: greet }
shop:
  id: harbor_shop
  sells: [{ item: fishing_rod, price: 150 }, { item: rope, price: 50 }]
  buys:  [{ item: wolf_pelt, price: 15 }, { item: raw_fish, price: 2 }]
```
Condiciones disponibles (`if`): `level_at_least`, `vocation_in`, `has_item`,
`quest_state`, `quest_not_started`, `flag_equals`, `skill_at_least`.
Acciones: `goto`, `close`, `give_item`, `take_item`, `give_xp`, `give_gold`,
`take_gold`, `start_quest`, `set_quest_step`, `set_flag`, `open_shop`, `travel`, `heal`,
`teleport`, `bless`.
El motor de diálogos (`server/internal/dialog`) solo interpreta este YAML: no hay
scripting libre en el MVP (más seguro y más fácil para la IA). Si algún día hace falta
lógica compleja, se evaluará Lua embebido con sandbox.

## Quest
```yaml
# data/quests/ch1_shipwreck.yaml
id: ch1_shipwreck
name: quest.ch1_shipwreck.name
chapter: 1
min_level: 1
steps:
  - id: find_crate
    description: quest.ch1_shipwreck.step_find_crate
    complete_when: { has_item: { item: salvaged_crate, count: 1 } }
  - id: return
    description: quest.ch1_shipwreck.step_return
    complete_when: { dialog_action: { npc: harbor_master, node: crate_returned } }
rewards:
  - { xp: 300 }
  - { item: leather_backpack }
  - { set_flag: { key: unlocked_forest_route, value: 1 } }
```

## Hechizo
```yaml
- id: light_heal
  name: spell.light_heal.name
  words: "vita lumen"        # palabras propias, nunca las de Tibia
  vocations: [druid, arcanist, ranger]
  level: 8
  mana: 20
  group: healing
  cooldown_ms: 1000
  group_cooldown_ms: 1000
  effect: { heal: { base: 15, per_level: 0.2, per_magic_level: 1.5 } }
  visual: magic_blue
```

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
