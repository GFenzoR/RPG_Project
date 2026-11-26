---
name: build-map-area
description: Diseña o modifica una zona del mapa (isla, ciudad, cueva, mazmorra) usando mapcli o las herramientas MCP de mapa, con validación y revisión visual. Úsala para cualquier pedido de crear, ampliar o arreglar mapas.
---

# Construir un área del mapa

Lee primero `docs/03-world-and-maps.md` y `docs/04-map-editor-and-ai.md`.
Usa las herramientas MCP `map_*` si están disponibles; si no, `pnpm mapcli ...`.

## Flujo
1. **Contexto:** `map_info` de la isla, `map_view` del área cercana y `content_search`
   para conocer los suelos, decoraciones, monstruos y NPCs disponibles.
2. **Plan en texto:** describe la zona (forma, accesos, pisos, nivel objetivo, puntos de
   interés) antes de editar.
3. **Base:** pinta suelos por rectángulos o usa `generate` con semilla fija.
4. **Bordes y decoración:** `autoborder` y luego `scatter` con semilla.
5. **Estructuras:** `stamp` de prefabs o paredes/puertas a mano.
6. **Vida:** spawns acordes al `level_hint` de la isla, NPCs, zonas de protección en
   ciudades y templos, portales/escaleras con su pareja y, en la entrada de cada uno, el item que lo muestra
   (`stairs_down`/`stairs_up`, `ladder_up`/`ladder_down`, `hole`, `rope_spot`, `teleport`).
7. **Validar:** `map_validate` hasta cero errores. Revisa también las advertencias de
   balance.
8. **Revisión visual obligatoria:** `map_render` de cada área tocada (y de cada piso),
   ábrela con Read y corrige lo que se vea mal: bordes rotos, zonas vacías, caminos
   bloqueados, repetición evidente de decoración.
9. **Entrega:** `map_patch_create` y PR con los renders y una descripción del área.

## Plantas y biomas nuevos (selva, pantano, desierto)
Árboles, arbustos y plantas se mecen con el viento del mundo vivo
(`livingworld/README.md` "Viento"). Si la zona necesita **plantas nuevas** (palmeras,
helechos, lianas, cactus): créalas con la skill `add-item`, cada una con su metadata de
viento (tipo y `pivot`), `make spritegen` y **`make sway-preview ONLY=<prefijo>`** para
mirar el vaivén con Read antes de colocarlas; `make sway-preview SCENE=forest` muestra un
trozo de bosque con ellas en cuatro momentos. `make validate` falla si una planta no
declara su viento. Un **suelo nuevo** del bioma dice su `surface`; si es una superficie
nueva, su fuerza de viento va en `exposure` de `data/livingworld/wind.yaml` (costas y
desiertos soplan más; un piso de interior, 0).

## Criterios de calidad
- Caminos legibles: el jugador debe entender hacia dónde ir.
- Variedad sin ruido: decoración agrupada, no esparcida uniformemente.
- Spawns con espacio para pelear y salidas para huir.
- Nada inalcanzable (la validación de conectividad lo verifica).
