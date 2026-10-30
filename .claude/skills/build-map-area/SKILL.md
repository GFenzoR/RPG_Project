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
   ciudades y templos, portales/escaleras con su pareja.
7. **Validar:** `map_validate` hasta cero errores. Revisa también las advertencias de
   balance.
8. **Revisión visual obligatoria:** `map_render` de cada área tocada (y de cada piso),
   ábrela con Read y corrige lo que se vea mal: bordes rotos, zonas vacías, caminos
   bloqueados, repetición evidente de decoración.
9. **Entrega:** `map_patch_create` y PR con los renders y una descripción del área.

## Criterios de calidad
- Caminos legibles: el jugador debe entender hacia dónde ir.
- Variedad sin ruido: decoración agrupada, no esparcida uniformemente.
- Spawns con espacio para pelear y salidas para huir.
- Nada inalcanzable (la validación de conectividad lo verifica).
