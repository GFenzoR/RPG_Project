# client/ — cliente del juego (TypeScript + PixiJS)

Lee `docs/05-network-protocol.md` antes de tocar red y `docs/03-world-and-maps.md` antes de
tocar el renderer.

## Estructura
```
client/
  src/main.ts            bootstrap: carga atlas, conecta, arranca loop de render
  src/net/               WebSocket, mensajes protobuf (de packages/protocol), reconexión
  src/state/             estado local del juego reconstruido desde eventos del servidor
  src/render/            capa de juego sobre packages/renderer (tiles, criaturas, efectos)
  src/input/             teclado (flechas/WASD, hotkeys), mouse, y luego táctil
  src/ui/                Preact: inventario, chat, diálogos de NPC, skills, login
  src/i18n/              carga de textos desde i18n/
  e2e/                   Playwright: tests y screenshots
```

## Reglas del cliente
- El cliente es "tonto": envía intenciones y dibuja lo que el servidor dice.
  Solo predice el movimiento propio (un paso) y lo corrige si el servidor lo rechaza.
- Interpolación de movimiento entre casillas según la velocidad que manda el servidor.
- Render de tiles 32x32 con orden de dibujo estilo Tibia: suelo → bordes → items →
  criaturas → efectos → textos flotantes, por fila de abajo hacia arriba.
- Ventana visible por defecto 15x11 casillas; el canvas escala en múltiplos enteros
  (pixel-perfect, `roundPixels`, sin suavizado).
- La UI (inventario, chat, diálogos) es DOM con Preact encima del canvas, no Pixi.
  Así es accesible, traducible y testeable con Playwright.
- Ningún string visible hardcodeado: todo pasa por `t('clave')`.
- Pensado para PC primero (teclado + mouse). Mantén el input desacoplado para poder
  sumar controles táctiles sin reescribir.

## Verificación visual (obligatoria si tocas render o UI)
`make e2e` levanta servidor + cliente, crea un personaje de prueba, camina y guarda
screenshots en `client/e2e/screenshots/`. Ábrelos con Read y revísalos antes de cerrar.
Si cambia el render a propósito, actualiza las imágenes de referencia en el mismo PR.
