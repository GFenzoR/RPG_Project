# editor/ — map editor web

Lee `docs/04-map-editor-and-ai.md` y `docs/03-world-and-maps.md` antes de cambiar algo aquí.

## Principio central
El editor, `tools/mapcli` y `tools/mcp-world` son **tres interfaces sobre la misma librería**
`packages/map-format`. Toda operación de edición (pintar suelo, poner item, crear spawn,
marcar zona) se implementa primero como una función pura en `packages/map-format/ops/`,
con test, y recién después se expone en el editor, el CLI y el MCP. Nunca implementes una
operación solo en la UI.

## Estructura
```
editor/
  src/canvas/      vista del mapa (reusa packages/renderer), zoom, pisos, grilla
  src/tools/       herramientas: pincel, borrador, relleno, rectángulo, selección, spawn, zona
  src/palette/     paleta de tiles/items con búsqueda y categorías desde data/
  src/history/     deshacer/rehacer basado en las ops de map-format (cada op es reversible)
  src/io/          abrir/guardar chunks, exportar "map patch" para enviar a revisión
  src/review/      vista de diff entre el mundo oficial y un patch (antes/después)
  src/ui/          Preact: paneles, propiedades, validación en vivo
  src/state/       EditorController: estado y acciones, sin Preact ni Pixi
  server/          backend local (plugin de Vite, Node): bootstrap, guardar, validar, atlas;
                   solo acepta llamadas del mismo origen (guard.ts) y guarda contra la base
  e2e/             Playwright: abre el editor, pinta, guarda, revisa screenshots
```
Aún no existe (T2.3): `src/review/` (patches y vista de diff). Relleno, rectángulo,
selección/copiar/pegar, autoborder automático y paneles de entidades: T2.2 (`src/ui/EntityPanel.tsx`).

## Correr
- `make editor` (o `pnpm --filter @rpg/editor dev`): http://localhost:5174, edita `world/`
  del repo. `EDITOR_ROOT=/otra/copia` apunta a otra raíz.
- `make e2e`: Playwright sobre una copia temporal del repo; screenshots en
  `e2e/screenshots/actual/` (revisarlos con Read). `window.__rpgEditor` expone ganchos de
  solo lectura para los tests (tile, coordenadas de pantalla de una casilla, estado).

## Reglas
- La edición ocurre 100% en el navegador (las ops de map-format corren ahí), sin login
  para editar localmente. El backend local solo lee/escribe archivos y corre el validador
  (viven en Node). Enviar un patch a revisión sí requiere cuenta (hito posterior).
- Ningún texto visible hardcodeado: claves `editor.*` en `i18n/{es,en}/editor.yaml`.
- La validación (`map-format/validate`) corre en vivo y muestra errores en el panel:
  tiles sin suelo, spawns en tiles bloqueados, portales a destinos inexistentes, etc.
- Formato de salida idéntico al que produce `mapcli`: si guardas el mismo mapa desde los
  dos, el diff debe ser vacío (`server/store.test.ts` y el E2E corren `mapcli fmt --check`).
