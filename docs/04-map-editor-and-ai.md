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

| op | Campos | Efecto |
|---|---|---|
| `paint_ground` | `floor`, `rect` o `cells`, `item` | Pone suelo |
| `erase` | `floor`, `rect`, `layer` (`ground`/`items`/`all`) | Borra |
| `place_item` | `pos`, `item`, `index?` | Agrega a la pila |
| `remove_item` | `pos`, `item` | Quita de la pila |
| `fill` | `pos`, `item` | Relleno por inundación del suelo contiguo igual |
| `autoborder` | `floor`, `rect` | Recalcula bordes con `data/borders.yaml` |
| `scatter` | `floor`, `rect`, `items[]`, `density`, `seed`, `on_ground[]` | Decoración aleatoria reproducible |
| `add_spawn` / `remove_spawn` | campos de spawns.yaml | |
| `add_zone` / `remove_zone` | campos de zones.yaml | |
| `place_npc` / `remove_npc` | `pos`, `npc` | |
| `add_portal` / `remove_portal` | campos de portals.yaml | |
| `stamp` | `pos`, `prefab` | Coloca un prefab (casa, muelle, templo) de `world/prefabs/` |

`mapcli ops apply ops.json` y la herramienta MCP `map_apply_ops` reciben una lista y la
aplican de forma atómica: si una falla la validación, no se aplica ninguna.

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

**Hito 2:** relleno, rectángulo, selección + copiar/pegar, autoborder automático al
pintar, spawns, NPCs, zonas y portales con su panel, exportar/importar patch, vista de
diff antes/después.

**Hito 4–5:** prefabs, generación procedural desde el editor, envío de patch a revisión
con cuenta, cola de moderación, comentarios por casilla.

## Experiencia de usuario del editor
- Atajos tipo editores de mapas clásicos: `B` pincel, `E` borrador, `G` relleno,
  `R` rectángulo, `V` selección, `PgUp/PgDn` piso, rueda = zoom, espacio + arrastrar = mover.
- Panel de validación siempre visible; click en un error lleva a la casilla.
- Previsualización de la vista del jugador (rectángulo 15x11) para revisar composición.
