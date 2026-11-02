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
JSON canónico: claves ordenadas, **una fila por línea**, indentación de 2 espacios.
`mapcli fmt` y el editor siempre escriben exactamente este formato para que los diffs
sean limpios y revisables.

```json
{
  "format": 1,
  "chunk": { "cx": 100, "cy": 200, "z": 7 },
  "palette": ["grass", "sand", "water_shallow", "oak_tree", "border_grass_sand_n"],
  "ground": [
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,2,2,2,2,2,2,2,2,2],
    "... 32 filas en total, índices a palette, -1 = vacío ..."
  ],
  "items": [
    { "x": 4, "y": 9, "stack": [3] },
    { "x": 16, "y": 0, "stack": [4] }
  ]
}
```
- `palette`: IDs de texto de items (`data/items/*.yaml`). El suelo también es un item
  con `kind: ground`.
- `ground`: matriz 32x32 de índices a `palette`. `-1` = sin tile (vacío, no caminable).
- `items`: lista dispersa con coordenadas locales (0–31) y pila de abajo hacia arriba
  (bordes, decoración, objetos). Ordenada por `y`, luego `x`.
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
```yaml
# spawns.yaml
- id: puerto_wolves_north
  center: { x: 3215, y: 6410, z: 7 }
  radius: 5
  monsters:
    - { monster: wolf, count: 3 }
  respawn_seconds: 60

# zones.yaml
- id: puerto_town
  type: protection          # protection | no_logout | pvp | no_pvp | community_plot
  floors: [6, 7, 8]
  rects: [{ x: 3200, y: 6380, w: 60, h: 45 }]

# portals.yaml
- id: mine_entrance
  from: { x: 3290, y: 6402, z: 7 }
  to:   { x: 3290, y: 6402, z: 8 }
  kind: stairs              # stairs | ladder | hole | rope_spot | teleport | boat
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
    to: { island: bosque, pos: { x: 4120, y: 6050, z: 7 } }
    price: 80
    requires: { level: 10 }
```

## Compilación
`server/cmd/mapcompile` lee `world/` + `data/`, valida, resuelve IDs y escribe
`build/world.bin` (binario compacto: tiles por sector, flags precomputados). El servidor
solo carga `world.bin`. El editor y `mapcli` trabajan siempre con el JSON.

## Validación (misma lógica en editor, mapcli y CI)
- Todo item referenciado existe en `data/`.
- Cada tile caminable tiene suelo; spawns y NPCs están sobre tiles caminables.
- Portales llevan a tiles caminables existentes; escaleras tienen pareja.
- Zonas de protección cubren templos y depósitos.
- Islas no se superponen; chunks fuera del rectángulo de su isla = error.
- Conectividad: desde el templo se puede llegar caminando a todo spawn y NPC de la
  isla (BFS por pisos y portales). Islas y zonas inalcanzables = error.
- **Balance de spawns**: densidad y nivel de monstruos dentro del rango `level_hint`
  de la isla (advertencia, no error).

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
