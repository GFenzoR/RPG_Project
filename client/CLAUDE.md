# client/ — cliente del juego (TypeScript + PixiJS)

Lee `docs/05-network-protocol.md` antes de tocar red y `docs/03-world-and-maps.md` antes de
tocar el renderer.

## Estructura
```
client/
  src/main.tsx           bootstrap: idioma, textos y pantallas (Preact)
  src/game.ts            una sesión de juego: WS + estado + teclado + canvas
  vite/content.ts        plugin: items/movimiento/i18n como `virtual:rpg-content` y /atlas/
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

## Notas de T1.5
- Sin servidor propio de assets: el plugin de Vite empaqueta el contenido de `data/` e
  `i18n/` (catálogos `client.yaml`, `vocations.yaml` y los nombres de monstruos/NPCs) y
  sirve el atlas de spritepack; `vite build` lo emite en `build/client/atlas/`.
- En desarrollo Vite hace de proxy de `/api` y `/ws` a `RPG_SERVER` (`:8080`): una sola
  origin, como detrás de Caddy, así la cookie `rpg_session` funciona sin pedir el token.
- Las criaturas se dibujan dentro de la capa de items de `MapView` (`placeEntity`), por
  casilla: sobre los items de su casilla y bajo los de las casillas siguientes.
- Mientras no haya outfits ni sprites de jugador, las criaturas son un bloque de color con
  una marca hacia donde miran. Solo se dibuja el piso del jugador.
- Hooks de solo lectura para E2E en `window.__rpgClient` (`game.ts`).

## Notas de T1.6
- Combate: `WorldState` guarda vida (%) por criatura, objetivo, efectos, textos flotantes
  y un log corto de mensajes de sistema; `Game` publica un `GameUi` tras cada batch y
  la UI (Preact) dibuja vida/experiencia, lista de batalla, modo de combate y log.
- Click derecho sobre una criatura o click en la lista de batalla = `SetTarget` (otra vez
  la misma = dejar de atacar). Los monstruos usan su sprite del atlas
  (`monsterSprites`, de `data/monsters`).
- Efectos y números flotantes son formas Pixi procedurales hasta tener sprites de efectos.
  Capas: mapa+criaturas → efectos → nombres y barras → números.
- Los mensajes (`state/messages.ts`) se traducen con su clave y parámetros; los `item`
  repetidos forman `{items}`.

## Notas de T1.7
- `WorldState` guarda `skills` (de `PlayerSkills`), maná y % de nivel de `PlayerStats` y el
  último `progress.level_up` (`levelUp`); la UI muestra el panel de skills (orden fijo en
  `SKILL_ORDER`, nombres `skill.<id>.name`) y un aviso de subida de nivel unos segundos.
- Un parámetro `content_id` llamado `skill` se traduce como `skill.<id>.name`.

## Notas de T1.8
- `WorldState` guarda `inventory` (slot → item), `containers` (ventanas abiertas) y el
  `count` de cada item de los tiles (`tileCounts`). `state/items.ts` arma las
  `ItemLocation` del protocolo y el item de arriba de un tile.
- Panel `ui/Inventory.tsx`: slots de equipo, capacidad (oz = gramos / 100) y una ventana
  por contenedor abierto. Los iconos son el sprite del atlas como fondo CSS
  (`Atlas.icon`).
- Arrastrar y soltar con eventos de puntero propios (no HTML5 DnD, para cruzar canvas y
  DOM): `Game.pressItem` / `startDrag` y `dropTarget` (un `[data-drop]` o un tile del
  canvas). En el canvas: arrastrar el item de arriba, click derecho = usar (o atacar si
  hay criatura), Mayús+click = mirar. En el DOM: click derecho = usar, Mayús+click = mirar.

## Verificación visual (obligatoria si tocas render o UI)
`make e2e` levanta servidor + cliente, crea un personaje de prueba, camina y guarda
screenshots en `client/e2e/screenshots/`. Ábrelos con Read y revísalos antes de cerrar.
Si cambia el render a propósito, actualiza las imágenes de referencia en el mismo PR.
