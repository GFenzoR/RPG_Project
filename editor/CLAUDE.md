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
  e2e/             Playwright: abre el editor, pinta, guarda, compara screenshot
```

## Reglas
- El editor funciona 100% en el navegador, sin login para editar localmente.
  Enviar un patch a revisión sí requiere cuenta (hito posterior).
- La validación (`map-format/validate`) corre en vivo y muestra errores en el panel:
  tiles sin suelo, spawns en tiles bloqueados, portales a destinos inexistentes, etc.
- Formato de salida idéntico al que produce `mapcli`: si guardas el mismo mapa desde los
  dos, el diff debe ser vacío (hay un test para eso).
