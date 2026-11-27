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
  src/input/             teclado (flechas/WASD, hotkeys), mouse y táctil (T5.6)
  src/ui/                Preact: pantalla de juego (GameView), ventanas, inventario, chat...
  src/preview/           vista previa de la UI sin servidor (make ui-preview)
  src/i18n/              carga de textos desde i18n/
  vite/fonts.ts          plugin: fuentes OFL recortadas a woff2 en /fonts/
  vite/credits.ts        créditos de /credits desde assets/CREDITS.md y los CREDITS.csv
  e2e/                   Playwright: tests y screenshots (y e2e/ui-preview.ts, un script)
```

## Reglas del cliente
- El cliente es "tonto": envía intenciones y dibuja lo que el servidor dice.
  Solo predice los pasos propios (teclado, pad, click para caminar y mouse mantenido;
  hasta `max_queued_steps`, ver "Movimiento fluido") y los corrige si el servidor los
  rechaza.
- Interpolación de movimiento entre casillas según la velocidad que manda el servidor;
  los pasos que da el servidor se dibujan sobre su línea de ticks, uno detrás del otro.
- Render de tiles 32x32 con orden de dibujo estilo Tibia: suelo → bordes → items →
  criaturas → efectos → textos flotantes, por fila de abajo hacia arriba.
- El servidor manda una ventana de 31x21 casillas (+1 de margen; `WorldState.view`, del
  `Welcome`). El canvas escala en múltiplos enteros (pixel-perfect, `roundPixels`, sin
  suavizado): por defecto la vista más grande que llena la caja del mapa a escala entera,
  sin bajar de 15x11; el jugador puede alejar hasta la ventana entera y acercar hasta 7x5
  (ver "Zoom del mapa").
- La UI (inventario, chat, diálogos) es DOM con Preact encima del canvas, no Pixi.
  Así es accesible, traducible y testeable con Playwright. En escritorio no hay encabezado
  ni columna fija: el mapa a pantalla completa, la barra gótica de abajo y ventanas que
  flotan sobre el mapa (ver "Notas de la pantalla completa").
- Ningún string visible hardcodeado: todo pasa por `t('clave')`.
- Pensado para PC primero (teclado + mouse). Mantén el input desacoplado para poder
  sumar controles táctiles sin reescribir.
- Dirección de arte, animación, sensación de movimiento y UI acordadas con el dueño el
  2026-11-17: `docs/17-direccion-de-arte-y-ui.md`. Las reglas de arriba cambian cuando se
  haga cada tarea de su plan (§7). A2 y A3 (tema, fuentes, dock y ventanas) ya están, A6
  (movimiento), A7 (vista de 31x21), y A4 y A5 (menú del click derecho con la
  ficha, diálogo y tienda sin scroll; ver "Notas de A4 y A5"): el click derecho sobre un
  item ya no lo usa por defecto.

## Notas de T1.5
- Sin servidor propio de assets: el plugin de Vite empaqueta el contenido de `data/` e
  `i18n/` (catálogos `client.yaml`, `vocations.yaml` y los nombres de monstruos/NPCs) y
  sirve el atlas de spritepack; `vite build` lo emite en `build/client/atlas/`.
- En desarrollo Vite hace de proxy de `/api` y `/ws` a `RPG_SERVER` (`:8080`): una sola
  origin, como detrás de Caddy, así la cookie `rpg_session` funciona sin pedir el token.
- Las criaturas se dibujan dentro de la capa de items de `MapView` (`placeEntity`), por
  casilla: sobre los items de su casilla y bajo los de las casillas siguientes.
- Arte del mapa (docs/17 ART-3 a ART-7; `assets/README.md`, "Arte del mapa"): el canvas
  le pasa a `MapView` el `TileArt` de cada item (`atlas.tileArt`, resuelto una vez por id)
  y la hora del frame, y `MapView` pone los looks de suelo, las piezas de muro, las anclas
  centradas, las sombras proyectadas (capa entre el suelo y los items) y avanza los tiles
  animados sin asignar. Cuando un muro de las filas de al sur tapa al jugador propio, ese
  muro se vuelve translúcido (`MapView.revealBehind` con `figureRect`, `REVEAL_ALPHA`): el
  jugador nunca palidece (pedido del dueño del 2026-11-23). En los pisos z ≥ 8 la luz
  de `render/light-layer.ts` (multiply, bajo efectos y nombres; da luz el jugador y cada
  item con `light`). Orden de capas del stage: mapa → luz → efectos → nombres → textos.
- Una criatura sin sprite es un bloque de color con una marca hacia donde mira (ver
  T0.5). Solo se dibuja el piso del jugador.
- Lo que sumó la rama `feat/world-art-2` (docs/17 "Hecho: el resto de A1, A10, A11 y A13"):
  - **Click sobre la cabeza** (ART-2): `render/creature-hits.ts` (`DrawnBoxes`, puro y con
    tests) guarda la caja de cada criatura dibujada; el click derecho, Mayús+click, el
    toque y el toque largo prueban primero esas cajas (la de adelante gana, el propio
    jugador no cuenta) y después la casilla. Una cabeza que sube a una casilla con algo
    propio que usar (puerta, item, escalera de mano: `GameCanvasOptions.ownUse` →
    `Game.ownUse`) no cuenta: el click es de esa casilla, como dice el texto del cursor.
  - **Criaturas tapadas:** quedan tapadas por la de adelante, sin más. No se dibuja nada
    sobre una criatura por otra criatura (la copia translúcida se retiró el 2026-11-26:
    teñía a los dos personajes; `render/overlap.test.ts`).
  - **Elevación** (ART-8): `MapView` sube lo apilado sobre un item con `elevation`
    (`ItemDef.elevation`) y el canvas sube a la criatura de esa casilla (`raisedBy`).
  - **Partículas** (A13): `render/particles.ts` (`ParticleLayer` en `view.overlay`), de los
    `particles` del atlas y polvo en las cuevas; nada con movimiento reducido. Los pasos
    (MOV-7): cuando una criatura empieza un paso (`animateBody` ve cambiar
    `AnimState.walkStart`), la casilla que deja patea lo de su suelo (`steps` de
    `atlas.json` `tiles`, `stepKindOf`) a la altura de los pies: `ParticleLayer.kick`
    (`dust`: 6 motas; `ripple`: un anillo de 8 gotas achatado). Las de ambiente dejan
    `STEP_RESERVE` (16) de las 100 libres para los pasos; los voladores no patean nada.
  - **Marco de puertas de casa:** `MapView` lee el mundo a través de un `DecoratedSource`
    (`packages/renderer`) que agrega `house_door_frame` en cada `content.houseDoors`; el
    estado del juego no lo tiene.
  - **Créditos en la app de escritorio** (A1): ver "Créditos (docs/17 A1)".
- Hooks de solo lectura para E2E en `window.__rpgClient` (`game.ts`) y `window.__rpgAudio`
  (`main.tsx`): solo con `__RPG_E2E_HOOKS__` (servidor de desarrollo o build con
  `RPG_E2E_HOOKS=1`, `vite.config.ts`); un hook nuevo va dentro de esa guarda
  (docs/08 "E2E del cliente", lote 16).

## Atlas: reintentos y "Reintentar"
- `Atlas.load` (`packages/renderer`) reintenta cada request por su cuenta (`atlas.json`, el
  JSON de cada página y su imagen) con `ASSET_RETRY` de `packages/renderer/src/retry.ts`
  (puro, con tests: 4 intentos, esperas de 0,5, 1 y 2 s; un estado HTTP de error cuenta
  como fallo). Dentro de un mismo `Atlas.load`, lo ya bajado no se pide de nuevo. Con
  "Reintentar" (un `Atlas.load` nuevo) se vuelven a pedir `atlas.json` y los JSON de las
  páginas; solo las imágenes ya cargadas salen del caché de `Assets` de PixiJS. Sin
  PixiJS: el sitio lo importa como `@rpg/renderer/retry` (`loadIcons` de la tienda).
- Si se agotan los intentos, `Game.startCanvas` no lo vuelve a intentar solo (cada batch
  del servidor lo haría): avisa `GameOptions.loadFailed` y `ui/LoadStatus.tsx` (sin hooks,
  con test) cambia "Conectando…" por el error y "Reintentar" (`load-failed`,
  `load-retry`), que llama a `Game.retryCanvas`. La sesión sigue abierta todo el tiempo:
  no se recarga la página ni se vuelve a entrar. E2E: `e2e/atlas.spec.ts` (docs/08).
- El editor usa el mismo `Atlas.load`: su error de carga trae "Reintentar"
  (`canvas-retry`), que vuelve a crear el canvas sin recargar.

## Notas de T1.6
- Combate: `WorldState` guarda vida (%) por criatura, objetivo, efectos, textos flotantes
  y un log corto de mensajes de sistema; `Game` publica un `GameUi` tras cada batch y
  la UI (Preact) dibuja vida/experiencia, lista de batalla, modo de combate y log.
- Click derecho sobre una criatura o click en la lista de batalla = `SetTarget` (otra vez
  la misma = dejar de atacar). Los monstruos usan su sprite del atlas
  (`monsterSprites`, de `data/monsters`).
- Los efectos son tiras de frames del atlas (ver "Sprites de efectos"); los números
  flotantes son `Text` de Pixi. Capas: mapa+criaturas → efectos → nombres y barras → números.
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
- Panel `ui/Inventory.tsx`: slots de equipo, capacidad (gramos, en g o kg: `state/units.ts`) y una ventana
  por contenedor abierto. Los iconos son el sprite del atlas como fondo CSS
  (`Atlas.icon`). Desde `feat/equipment-d2` el equipo es una figura al estilo Diablo II,
  con la mochila equipada abajo y la capacidad como barra: ver "Notas del equipo y el
  tooltip al estilo Diablo II".
- Arrastrar y soltar con eventos de puntero propios (no HTML5 DnD, para cruzar canvas y
  DOM): `Game.pressItem` / `startDrag` y `dropTarget` (un `[data-drop]` o un tile del
  canvas). En el canvas: arrastrar el item de arriba, click derecho = usar (o atacar si
  hay criatura), Mayús+click = mirar. En el DOM: click derecho = usar, Mayús+click = mirar.
  Desde A4 eso es el modo `classic`; por defecto el click derecho abre el menú (ver "Notas
  de A4 y A5").

## Notas de T1.9
- `content.spells` (de `data/spells.yaml`) alimenta la barra de hotkeys `ui/Hotbar.tsx`:
  F1–F12 lanzan el hechizo del slot (`CastSpell` por id), el lápiz deja elegir uno por
  slot y se guarda por vocación en `localStorage` (`state/hotkeys.ts`). La sombra de cada
  slot es lo que falta del cooldown propio o de grupo (`SpellCooldown`).
- La línea "Decir" manda `Say` en el canal local: si son palabras mágicas, el servidor
  lanza el hechizo (el chat completo está en T1.13).
- `WorldState.projectiles` guarda los `Projectile` 250 ms; los proyectiles son la flecha o
  el orbe de su elemento (`ELEMENTS`; ver "Sprites de efectos") y los efectos mágicos, la
  tira de su elemento.

## Notas de T1.10
- `WorldState.dialog` / `shop` (de `DialogOpen`, `DialogClose`, `ShopOpen`): la tienda se
  cierra con el `DialogClose` de su diálogo. `ui/Dialog.tsx` dibuja ambas ventanas sobre
  el mapa (arriba a la izquierda; desde A5, abajo al centro).
- Click derecho sobre un NPC (o `Game.attack` con un NPC) = `NpcTalk`. Con un diálogo
  abierto, 1–9 eligen el botón con ese número (desde A5 los botones van por tema:
  `state/dialog.ts` `dialogLayout`), 0 "Volver" y Escape manda `DialogChoose` 0.
- Los NPCs no van en la lista de batalla. El plugin de Vite incluye `dialog.yaml`,
  `npcs.yaml` y `quests.yaml` completos (los textos de los pasos, para el diario); un `content_id` llamado `quest`
  se traduce como `quest.<id>.name`.

## Notas de T1.11
- `WorldState.death` (del mensaje `death.died`, con `experience` y `blessings`) abre la
  pantalla de muerte (`.death` en `ui/App.tsx`) hasta que el jugador la cierra.
- El E2E de muerte deja al personaje con 1 de vida con `psql` (`DATABASE_URL`) antes de
  entrar y lo lleva a los lobos.
- Bloqueo de logout en combate (docs/02): un "Salir del juego" a menos de 12 s de una pelea
  lo rechaza el servidor con `combat.logout_locked` (`pvp.logout_locked` con el bloqueo
  PvP), con los segundos que faltan: el mensaje flota sobre el mapa (`notices.ts`) y va
  al log, y el jugador sigue en el juego con su objetivo. Antes del click, el botón ya se
  ve bloqueado: `ui/LogoutButton.tsx` (`LogoutLock` lee `logoutLockMs` de los estados
  `in_combat`/`pvp_locked` y redibuja cada segundo; `data-locked` y `logout-countdown` en
  la barra, `logout-menu` en el menú del teléfono). Cerrar o recargar en combate deja una
  nota (`state/stayed.ts`, `pagehide`) que la próxima pantalla muestra una vez. Un E2E que sale después de pelear
  usa `leaveAfterFight` (`e2e/game.spec.ts`), que reintenta cada 2 s hasta salir; el de la
  pelea con el lobo mira el rechazo (`07c-logout-locked`).

## Notas de T1.12
- `ItemDef.useWith` (items `kind: tool`): usarlo (click derecho) no manda `UseItem` sino que
  deja `Game.usingItem` y la clase `using-item` en `body` (cursor en cruz); el siguiente
  click en el mapa manda `UseItemOn` a esa casilla. Escape, click derecho o click sobre una
  criatura lo cancelan.
- Efectos 5 (cosecha) y 6 (intento fallido): tiras `effects/gather` y `effects/gather_miss`.

## Notas de T1.13
- `WorldState.chat` (últimas `CHAT_SIZE` líneas de `Message` no de sistema) aparte del log de
  sistema; `ui/Chat.tsx` las dibuja (`formatChat`, claves `client.chat.line.<modo>`) con el
  selector de canal y la línea para escribir. Todo es texto DOM: nunca `innerHTML`.
- Idioma: `pickLanguage` = `?lang=` → `localStorage` `rpg.lang` → navegador → es. `main.tsx`
  guarda el idioma en estado y `ui/LanguagePicker.tsx` lo cambia en vivo (esquina fuera del
  juego; dentro, la ventana Opciones en escritorio y el menú ☰ en teléfonos); el `Game`
  recibe `t` por un ref y el canvas renombra etiquetas.
- **Globos sobre las cabezas** (docs/17 UI-11): lo dicho en el canal local (y la línea del
  NPC en su diálogo) también va sobre quien habla. `WorldState.takeSpeech` (solo un
  `Message` con `pos`), reglas puras en `render/bubbles.ts` (estilo por canal, ajuste de
  línea, duración, apilado, separación) y la capa en `render/bubble-layer.ts`, entre los
  nombres y los números. Opción `chat-bubbles` en Opciones → Interfaz (`rpg.chat-bubbles`).
  Hook E2E `__rpgClient.bubbles()`.
- `translator(texts, lang)` soporta plurales ICU; `make validate` revisa las claves literales
  del código (cliente, editor y servidor).

## Verificación visual (obligatoria si tocas render o UI)
`make e2e` levanta servidor + cliente, crea un personaje de prueba, camina y guarda
screenshots en `client/e2e/screenshots/`. Ábrelos con Read y revísalos antes de cerrar.
Si cambia el render a propósito, actualiza las imágenes de referencia en el mismo PR.

## Notas de T1.16
- Los NPCs viven en Puerto; testisle sigue siendo la isla de inicio del E2E. El E2E de NPCs
  pone `town = 'puerto'` con `psql` para despertar en el templo del Farol.

## Notas de T2.6
- `MessageKind.BROADCAST` (anuncio de staff) va al chat con la clase `broadcast` y la
  etiqueta `client.chat.line.broadcast`. Los comandos `/` los escribe el jugador en la línea
  de chat: el cliente no sabe de roles ni los filtra.
- El login muestra el `notice` de la última desconexión: un ban revoca el token, así que
  después de `BANNED` el cliente cae al login y el motivo se ve ahí.

## Notas de T3.1
- `SpellDef.aimsAtPlayer` (una curación con `heal.range`): su hotkey no lanza, sino que pone
  la mira (`Game.pending`, clase `using-item`). El siguiente click en una criatura o casilla
  manda `CastSpell` con ese objetivo; Escape o click derecho lo cancelan.
- La mira (herramienta "usar con" o hechizo apuntado) vive en `state/aim.ts`, que es puro y
  tiene tests: cualquier otro hechizo o uso de item la descarta, y `resolveClick` decide qué
  hace el click.
- La munición se ve en el slot `ammo` con su cantidad (`.count`), como cualquier pila.

## Notas de T3.2
- `WorldState.conditions` (de `PlayerConditions`, solo las propias, y desde el lote 13 los
  estados del servidor; solo la zona de protección, `ENDLESS_STATUSES`, va sin fin, con
  `until: undefined`: otro id con `remaining_ms` 0 está terminando) alimenta la
  bandeja de estados (`ui/StatusTray.tsx`, ver "Notas de la bandeja de estados"; nombres
  `condition.<id>.name`, qué hace `condition.<id>.desc`).
  La velocidad aplicada llega en `PlayerStats.speed` / `CreatureSpeed`: el paso predicho y
  la interpolación ya la usan. Invisible: el propio cliente dibuja su criatura con alpha
  0.4 (los demás no la reciben). Efecto 7 = hechizo de condición o cura.

## Notas de T3.3
- `WorldState.party` (`state/party.ts`, puro y con tests) guarda el grupo de `PartyUpdate`
  y las invitaciones de `PartyInvitation` hasta que vencen o se contestan. `ui/Party.tsx`:
  panel del grupo (vida/maná solo de los miembros en vista, que es lo único que llega) y
  las invitaciones sobre el mapa. En la lista de batalla, un jugador tiene el botón "+"
  (invitar) si se lo puede invitar. El canal "Grupo" está en el selector del chat.
- **Invitar por nombre** (lote 19, docs/02 "Grupos"): `PartyInvite` de `ui/Party.tsx` (sin
  hooks) es el botón "Invitar" (sin grupo, o siendo el líder) o, abierto, el cuadro con el
  nombre; el estado es `GameUi.partyInviting` (`Game.partyInvitePrompt`), y
  `Game.partyInviteByName` manda `PartyCommand` `INVITE_NAME`. La respuesta es un mensaje
  del sistema. Test ids: `party-invite`, `party-invite-prompt`, `party-invite-name`,
  `party-invite-send`, `party-invite-cancel`. E2E: "party: the window's Invitar button…"
  de `e2e/game.spec.ts` (screenshots `24b`–`24d`).
- El plugin de Vite empaqueta los nombres de `world.yaml` (`island.<id>.name`).

## Notas de T3.4
- `WorldState.station` (de `StationOpen`) abre `ui/Crafting.tsx`: las recetas de
  `content.recipes` (de `data/recipes.yaml`) de esa estación, con lo que falta, el nivel, la
  herramienta y la chance (`state/recipes.ts`, puro y con tests). Lo que se lleva lo dice el
  servidor (`owned`, `tools`), porque el cliente no ve las mochilas cerradas. Se cierra con
  ×, Escape o al alejarse más de 1 casilla; "Hacer" manda `Craft`.

## Notas de la forja (docs/02 "Forja", rama `feat/item-forge`)
- `content.forge` (`ForgeRules`, de `balance.yaml → forge` con ids numéricos:
  `vite/content.ts` `loadForge`; ausente si está apagada). El yunque (`forge.station`) abre la
  ventana de la estación con dos pestañas (`data-station-tab`: `recipes`, `forge`;
  `ui/Crafting.tsx`); la de la forja es `ui/Forge.tsx`: `ForgePanel` guarda la pieza elegida,
  el interruptor del ámbar y el paso de confirmación; `ForgeBody` dibuja sin hooks
  (`ui/Forge.test.ts`). Las reglas y la vista son puras en `state/forge.ts` (`refineKind`,
  `forgeBand`, `forgeChance`, `refineGain`, `forgeCandidates`, `forgeView`, con tests): las
  mismas fórmulas que `server/internal/content/forge.go`. Lo que se lleva lo dice el
  `StationOpen` (`owned` con piedras y ámbar, `StationState.money`).
- `Game.refine(candidato, protect)` manda `Refine` con todos los `mods` que se ven
  (`refineMessage`; el servidor no refina otra pieza que subió a ese lugar salvo que sea igual
  en todo) y la ventana no manda otro hasta la respuesta (`refineInFlight`: un `RefineResult`
  o un mensaje de sistema después del envío, o `IN_FLIGHT_MS`; botones con `disabled`);
  `WorldState.refine` (`RefineState`) es el último `RefineResult`, que la ventana muestra
  `RESULT_MS` (8 s) arriba. La pieza elegida es `chosenPiece`: la de su lugar con el mismo
  item y los mismos `mods`, que siguen al resultado de los intentos sobre ella (una rota se
  suelta: la que sube a su índice del contenedor no es ella). El ámbar va solo si
  `ForgeView.protect` (pedido, donde cuenta y llevado): un interruptor que quedó prendido
  tras gastar el último no traba el botón. La skill del bono es
  `forge.smithingBonus.skill`, no un string del código.
- El nombre de una pieza refinada pasa siempre por `refinedName` (`client.item.refined`):
  la ficha (`cardTitle`, con la línea `card-refine` de `ItemCardView.refine`), el
  intercambio y el mercado (`ItemLabel`; el selector de cuál vender y las filas de ofertas
  ajenas, `instanceLine` de `ui/Market.tsx`, "+7 espada · +3 ataque") y los parámetros `item`
  de los mensajes (`state/messages.ts`). Color `--ui-item-refine`.
- Efectos 8 (`effects/refine`) y 9 (`effects/shatter`) en `render/effects.ts`, con su sonido
  (`effect.refine`, `effect.shatter` en `assets/sounds.yaml`).
- Test ids: `forge`, `forge-slot`, `forge-levels`, `forge-gain`, `forge-chance`,
  `forge-cost` (`[data-cost=stone|gold]`), `forge-protect`, `forge-risk`, `forge-attempt`,
  `forge-confirm`, `forge-go`, `forge-cancel`, `forge-result` (`data-outcome`),
  `.forge-item[data-forge-item]`, `card-refine`. Vista previa: escenas `forge`, `forgerisk` y
  `forgeresult` de `make ui-preview`.

## Notas de T3.5
- `WorldState.voyage` (del mensaje `travel.sailed`, parámetro `island`) dispara el fundido
  `.voyage` de `ui/App.tsx` (`VOYAGE_MS`, misma duración que la animación CSS) con
  `client.voyage.sailed`. Un `content_id` llamado `island` se traduce como
  `island.<id>.name`. Las opciones de ruta llegan como cualquier opción de diálogo.
- El E2E corre el servidor con `-boat-routes e2e/fixtures/boat_routes.yaml` (Puerto →
  testisle, solo para tests).

## Notas de T3.7
- Un solo `AudioEngine` (`audio/engine.ts`) por página, creado en `main.tsx`. Se desbloquea
  con el primer gesto: `pointerdown`, `pointerup`, `touchend`, `click` o `keydown`. En
  pantallas táctiles, `pointerdown` solo no cuenta. Todo `<button>` suena con `ui.click`.
  Mientras el contexto no esté `running`, los efectos se descartan; los loops no.
  `Game` recibe el motor en `GameOptions.audio`: traduce cada mensaje con `cuesOf`
  (`audio/cues.ts`, puro) y, después del batch, los reproduce alrededor de la posición
  propia. También fija la escena de la música (abajo) y, cada `AMBIENCE_STEP_MS` (250 ms)
  desde `frame`, el ambiente posicional (`audio/ambience.ts`, pegamento del mundo vivo:
  `livingworld/README.md` "Ambiente"; el motor lo refleja con `setAmbience`). La herramienta de recolección (`toolAt`: uso y casilla) solo define el sonido
  de un efecto 5 en esa misma casilla. Se olvida al fabricar o al usar otro item.
- Qué suena con cada evento está en `assets/sounds.yaml` (`content.sounds`). El plugin de
  Vite sirve esos archivos en `/audio/` y `vite build` los emite. No escribas nombres de
  archivo de sonido en el código.
- Preferencias en `audio/prefs.ts` (`localStorage` `rpg.audio`). El panel es
  `ui/AudioOptions.tsx` y va junto al selector de idioma, dentro y fuera del juego. Se
  vuelve a montar al entrar o salir del juego, y cada vez parte de
  `audio.currentPrefs()`.
- Hooks E2E de solo lectura: `window.__rpgAudio` (`unlocked`, `history`, `loops`: el
  tema que lleva la música y el ambiente; `music`: el estado del director, `MusicState`,
  con la pool, y cada voz con su ganancia, su posición y si tiene elemento; con uno,
  también `heard`, la ganancia que tiene el nodo ahora sobre el volumen del sonido, y
  `time`, dónde va el elemento en su archivo: lo que de verdad suena).
- **El director de música** (`audio/director.ts`, puro y con tests; pedido del dueño del
  2026-11-18, reglas en docs/02 "Sonido"): recibe una `Scene` (`title`, `silent` o `world`
  con las pools de la zona, del área de una quest importante y de un jefe a la vista), un
  reloj y un azar inyectados, y lleva una lista de `Voice` (un tema desde un segundo, con
  su envolvente de potencia constante: `gainAt`, `envelopePoints`). Baraja cada pool sin
  repetir, arranca en un punto de entrada (`entries` de `sounds.yaml`), recuerda por pool
  dónde iba (`resumeMs`; si vuelve mientras esa voz todavía se apaga, la misma voz vuelve
  a subir en espejo de la otra, no una copia del tema), espera `dwellMs` antes de cambiar
  de zona, sostiene al jefe `bossHoldMs`, deja respirar `gapMs` entre temas de una zona y
  no arranca un tema hasta que su archivo está (`ready` da un `Readiness`: `ready`,
  `loading` o `failed`; `wanted`). Un tema `failed` cede su lugar a otro de la pool; sin
  otro, sigue la música de antes hasta que el archivo vuelve. `lost(voz)`: el motor no
  puede tocarla (se va ya, también un loop). No sabe de combates: una pelea común no
  cambia nada.
- **El motor y la música** (`audio/engine.ts`): `setMusic(scene)` y una bomba cada
  `PUMP_MS` (250 ms) sobre el reloj de audio (`ctx.currentTime`); nada se mueve mientras el
  contexto no está `running`. Cada voz suena en un `<audio>` conectado al canal de música
  por su propia ganancia (`StreamLike`, `AudioPorts.createStream`), que sigue la envolvente
  con rampas lineales cada `RAMP_STEP_MS`; una voz que recibe su elemento tarde (archivo
  lento o música recién activada) entra con `ATTACH_MS` de fundido (si la envolvente cambia
  mientras tanto, sigue desde donde va esa rampa, sin salto). Cada tema se baja una
  vez a un object URL (`loadStream`): se puede saltar a cualquier segundo sin `Range` del
  servidor. Guarda `KEEP_STREAMS` (4) archivos; con la música silenciada no baja nada y
  suelta los elementos. La CSP de escritorio permite `media-src blob:` por eso. Un
  archivo que no llega o que el elemento no decodifica (`error` del `<audio>`,
  `StreamLike.onError`) queda `failed` y se pide de nuevo a los `STREAM_RETRY_MS` (5 s),
  doblando hasta `STREAM_RETRY_MAX_MS` (60 s); una voz sin elemento con su archivo
  fallado se suelta (`lost`). Uno que el elemento no sabe tocar (`onError` con
  `unsupported`: `MEDIA_ERR_SRC_NOT_SUPPORTED` o un `play()` con `NotSupportedError`) no se
  vuelve a pedir en la sesión, y si `AudioPorts.canStream()` (`canPlayType` de Ogg Opus,
  una vez al crear el motor) dice que no, ningún tema con `seconds` cuenta como listo ni
  se baja: antes cada uno se bajaba entero (~1 MB) y fallaba otra vez en cada reintento. Un tema sin `seconds` (soundgen, el `none` de un lugar) se
  decodifica y suena en un buffer source con `loop` (sin el hueco del `loop` de un
  `<audio>`), y se suelta apenas deja de sonar.
- **WebKit y los gestos** (Safari, iOS y el WKWebView de macOS): `unlock()` (cada gesto)
  crea los `MUSIC_DECKS` (4) elementos y "bendice" cada uno nuevo con un `play()`/`pause()`
  sin archivo dentro del gesto (`StreamLike.bless`): WebKit deja arrancar más tarde solo a
  un elemento que tuvo un `play()` en un gesto. Si igual rechaza un `play()`
  (`NotAllowedError`, `StreamLike.blocked`), el gesto siguiente lo vuelve a llamar desde
  donde va la voz. Falta probarlo en un iPhone y en la app de macOS (docs/14).
- `Screens` (`ui/App.tsx`) pone la escena `title` fuera del juego (sin ambiente,
  `setAmbience([])`); al salir, `Game.destroy` apaga el ambiente y el título entra con su fundido. Dentro,
  `Game.keepLoops` arma la escena con `sceneFor` (`audio/cues.ts`, puro: `loopFor` para la
  zona, `questPoolAt` para `content.questMusic`, de `music` en `data/quests`, y el primer
  jefe de `music.bosses` en la lista de batalla). Corre tras cada batch y cada
  `LOOPS_EVERY_MS` (500 ms) desde `frame`, porque un jefe sale de la vista sin mensaje.
- Memoria: el motor deja decodificados los loops de ambiente que suenan y `KEEP_LOOPS` (2)
  de los últimos (`isCached` para los tests); uno olvidado mientras cargaba no vuelve al
  caché. `loops()` del hook E2E trae `ambience` (los loops que suenan) y `ambient` (el más
  fuerte).
  La música no se decodifica entera (docs/07 "Audio").
- **Sonidos que no bajan** (lote 10): `load` (efectos y loops de ambiente) pide el archivo
  con `withRetry` y `ASSET_RETRY` de `@rpg/renderer/retry` (4 intentos, esperas de 0,5, 1
  y 2 s por `AudioPorts.sleep`: los tests usan un reloj falso). Agotados, lo anota en
  `soundFailed` (hora de `ports.now` en que vuelve a valer) y borra la entrada de `buffers`:
  una reproducción antes de esa hora no pide nada; después, lo pide de nuevo. La espera es
  `STREAM_RETRY_MS` (5 s), doblando hasta `STREAM_RETRY_MAX_MS` (60 s), como la música.
  El ambiente que se quiere vuelve solo: el juego llama `setAmbience` cada 250 ms y,
  vencida la espera, el archivo se pide de nuevo. Antes el fallo quedaba guardado (`undefined`) toda la sesión. Un archivo que
  llega pero `decodeAudioData` rechaza (un navegador sin Ogg) no se reintenta: `giveUp`
  lo anota con `Infinity`, como la música que el elemento no sabe tocar.

## Notas de T4.1
- Botón "!" de la lista de batalla en cada jugador: abre `ReportForm` (`ui/App.tsx`), que
  manda `ReportPlayer` solo con el motivo (`Game.reportPlayer`). El contexto lo pone el
  servidor; la respuesta llega como mensaje del sistema (`report.*`).
- `Disconnect{IDLE}` → `client.disconnect.idle` (la tabla de motivos es automática).
- `WorldState.presence` (de `PresenceCheck`) abre `ui/Presence.tsx` arriba del mapa: la
  pregunta y las opciones son claves i18n; no toma teclas ni bloquea el juego. Responder
  manda `PresenceAnswer` y la cierra; el servidor contesta igual con cualquier respuesta.
  Se cierra sola 3 s antes de su plazo (`WorldState.activePresence`, y un timer en `Game`
  porque al vencer el servidor no avisa); un click se manda siempre (el chequeo puede
  seguir pendiente en el servidor si el jugador estuvo ausente) e ignora el reenvío de un
  chequeo ya contestado.

## Notas de T4.2
- `WorldState.tutorial` (de `TutorialStep`, `state/tutorial.ts`, puro y con tests) es el paso
  que dice el servidor; `undefined` cuando terminó. `ui/Tutorial.tsx` dibuja el panel de
  pistas arriba a la derecha del mapa (en escritorio, a la izquierda de la columna del
  inventario y bajo las ventanas; no toma teclas) con "Saltar tutorial"
  (`Game.skipTutorial` → `TutorialSkip`; el panel se cierra cuando el servidor confirma).
  Se oculta mientras hay `dialog`, `shop` o `station` abiertos: en pantallas angostas
  (la app de escritorio a 960 px) la tienda llega a esa esquina. En escritorio también
  mientras la Ayuda, el gremio o la apariencia están abiertos en su lugar de fábrica
  (`covered`, `tutorialCovered` de `ui/windows.ts`): las ventanas van sobre el panel.
- Resaltado: el panel marca con `data-tutorial-active` el elemento cuyo `data-tutorial` es
  el `highlight` del paso, y `client.css` tiene una sola regla para eso. Valores:
  `inventory`, `hotbar`, `battle`, `chat`, `skills`, `stats`. Un elemento nuevo resaltable
  necesita su `data-tutorial`, el valor en `TUTORIAL_TARGETS` y en el enum del esquema.
- El plugin de Vite empaqueta `i18n/*/tutorial.yaml`. El E2E del tutorial usa un segundo
  servidor con `-start-town puerto` y su propio Vite (`puertoServerURL`/`puertoClientURL`
  de `playwright.config.ts`): el personaje se crea como cualquiera y despierta en Puerto
  sin tocar la base. Los E2E que ponen `town = 'puerto'` a un personaje nuevo también ven
  el panel.

## Notas de T4.3
- Dos páginas en el mismo build (`vite.config.ts`): `index.html` es el sitio público
  (`src/site/`: `main.tsx`, `Site.tsx`, `site.css`) en `/`, `/highscores` y `/news[/<slug>]`;
  `play/index.html` es el juego (`src/main.tsx`) en `/play/`. Comparten `i18n/`,
  `client.css` y `LanguagePicker`. La app de escritorio abre `play/index.html`.
- Bajo `/play/` las URLs relativas apuntarían a `/play/...`: el atlas y los sonidos se piden
  desde la raíz (`new URL("/atlas/", ...)`, `siteRoot()` en `audio/engine.ts`). No uses
  `<base href>`: la CSP de escritorio tiene `base-uri 'none'`.
- `virtual:rpg-site` (`vite/content.ts`, `loadSiteContent`): catálogos `client.yaml`,
  `vocations.yaml` y `site.yaml`, ids de vocaciones y skills (categorías del ranking) y las
  noticias de `data/news`, de la más nueva a la más vieja. Se lee al arrancar Vite.
- El router del sitio es History API (`navigate`, `Link` con `<a href>` reales);
  `site/routes.ts` (puro, con tests) parsea rutas y filtros del ranking, que viven en la
  query (`?category=&vocation=&page=`). "Jugar" lleva a `/play/` sin `?lang=`.
- Idioma entre páginas: las dos comparten `rpg.lang` en `localStorage`. Cada página lee
  `?lang=` una sola vez al arrancar (`takeLangParam`): lo guarda como elección y lo saca de
  la URL con `history.replaceState`. Si quedara en la URL, ganaría sobre un idioma elegido
  después y se perdería al recargar.
- Al navegar a otra ruta del sitio, el foco va a `#main` (`tabIndex=-1`); un cambio de
  filtros (solo query) no lo mueve. Una ruta desconocida muestra `site.not_found.*` (la SPA
  responde 200 a cualquier ruta).
- Noticias: `site/markdown.ts` (puro, con tests) arma bloques y `site/Markdown.tsx` los dibuja
  como texto: nunca `innerHTML`.
- E2E: `e2e/site.spec.ts` (landing es/en a 1280 y 375 px, ranking con un personaje creado,
  noticia, ruta desconocida, foco, paginación con 21 montaraces sembrados con `psql`, y
  "Jugar" → login → juego conservando el idioma elegido en el juego tras recargar). Los E2E
  del juego van a `/play/?lang=es`.

## Créditos (docs/17 A1)
- `/credits` del sitio (`site/Credits.tsx`, sin hooks): `SiteContent.credits` lo arma
  `vite/credits.ts` (`loadCredits`, puro en `creditsFrom`, con tests) desde
  `assets/CREDITS.md` y el `CREDITS.csv` de cada pack, con los lectores de spritepack.
  "Hecho con IA" (`credits-ai`, `aiCredits`) lista las filas de "Generado con IA": sus
  sprites, la fecha y el archivo de prompt (una fila sin fecha o sin prompt commiteado no
  se muestra; el test exige que cada prompt exista).
  Cada frase es i18n (`site.credits.*`); el nombre y autor de un pack,
  `site.credits.pack.<carpeta>.*` (guiones como `_`; `vite/credits.test.ts` exige las dos claves en es y en
  para cada pack, y un enlace en `site/credits.ts` `licenceUrl` para cada licencia).
- Enlaces: el pie del sitio (`site.nav.credits`) y `ui/CreditsLink.tsx` en Opciones (la
  ventana de escritorio y `AudioOptions` del login y del menú ☰), otra pestaña; en la app
  de escritorio, un botón que abre la misma página en una ventana sobre el juego
  (`CreditsWindow`, renderizada en su propio elemento de `<body>`; los datos llegan de
  `virtual:rpg-credits` al abrirla y las frases `site.credits.*` viajan en los catálogos
  del juego; las direcciones van como texto, `CreditsPage` con `plain`), con la dirección
  de `/credits` abajo (`client.options.credits_desktop`).
- Fuentes: `buildFont` conserva los name ids 0–6, 13 y 14 (`KEPT_NAME_IDS`): el
  copyright y la licencia OFL viajan en cada woff2.
- E2E: "credits" de `e2e/site.spec.ts` (screenshots `site-09` y `site-10`) y el enlace
  en el test de sonido de `e2e/game.spec.ts`.

## Notas de T4.5
- Portal de mapas en el sitio (`src/site/Maps.tsx`): `/maps/submit`, `/maps/mine` y
  `/maps/review[/<id>]` (rutas en `site/routes.ts`). Helpers puros con tests en
  `site/maps.ts` (prechequeo del archivo, clave i18n de cada error, tamaños, enlace del PR
  solo si es `https://github.com`). La API está en `net/api.ts` (`mapsApi`); `ApiError`
  trae `detail` (el código del chequeo del patch → `site.maps.patch_error.<código>`).
- Sin sesión, una página del portal muestra el login del propio sitio (cookie de `/api`,
  la misma del juego). El sitio no conoce roles: `GET .../mine` dice `can_review` y el
  servidor rechaza lo demás. Títulos, descripciones y motivos son texto del jugador:
  siempre como texto (`.user-text`, `pre-wrap`), nunca `innerHTML`.
- E2E: `e2e/maps.spec.ts` exporta un patch real con `mapcli` (pinta la parcela de comunidad
  de Puerto en una copia temporal de `world/`), lo envía por el sitio, y un gm sembrado
  con `psql` lo descarga y lo aprueba; un segundo envío se rechaza con motivo. Al final
  corre el worker (`tools/map-pr-worker`, `--once --only <id>`) contra un GitHub falso
  en el mismo proceso de Playwright y comprueba el PR y el enlace en "Mis envíos".
- `MySubmissions.pr_worker` decide el texto de un envío aprobado (se abre solo o a mano) y
  el aviso de la página de moderación; `failure` se traduce con `failureKey`
  (`site.maps.failure.<código>`).

## Notas de T5.1
- `WorldState.guild` (`state/guild.ts`, puro y con tests) guarda el gremio y las
  invitaciones de `GuildUpdate`; `guildPowers`/`memberActions` deciden qué botones mostrar
  con las mismas reglas que el servidor (que igual valida todo). `ui/Guild.tsx`: panel del
  gremio (su propia ventana con pestañas en escritorio, docs/17 UI-7; una pestaña del panel
  en teléfonos) y las invitaciones sobre el mapa (`.guild-invitations`, más
  arriba que las del grupo). El panel no usa hooks (formularios no controlados que leen sus
  campos al enviar): `ui/Guild.test.ts` recorre su árbol sin DOM. Si le agregas estado,
  mantén ese test posible o muévelo a otro componente.
- `CreatureState.guild` (de `Creature.guild` y `CreatureGuild`) se dibuja bajo el nombre
  en el canvas (`guild` en `CreatureSprite`, color `COLORS.guild`), el nombre sube.
- Mayús+click en una casilla con una criatura manda `LookAt{creature_id}`
  (`Game.lookCreature`); un `content_id` llamado `vocation` se traduce como
  `vocation.<id>.name` y uno llamado `rank` como `client.guild.rank.<id>`.
- `content.guild` (de `balance.yaml guild`, opcional en los fixtures) da costo, nivel y
  largos al panel. Canal "Gremio" en el selector del chat.
- Sitio: `/guilds` y `/guilds/<id>` en `site/Site.tsx` (`useJSON`, sin cuenta), rutas en
  `site/routes.ts`. E2E: el test "T5.1" de `e2e/game.spec.ts` siembra nivel y monedas
  con `psql`, funda, invita, habla por el canal, mira al otro y revisa el sitio
  (screenshots 45–48).

## Notas de T5.2
- `CreatureState.skull` (de `Creature.skull` y `CreatureSkull`): el canvas dibuja la marca a
  la izquierda del nombre y la lista de batalla un `.skull` (`data-skull`, `MarkIcon` en
  `ui/App.tsx`). La marca es el sprite `ui/marks/<id>` del atlas (arte propio de spritegen,
  `render/marks.ts`, puro y con tests): en el canvas, un `Sprite` a 1 px de pantalla por
  px del sprite, anclado en el centro de `MARK_BOX`; en la lista, `Game.markIcon` +
  `markIconStyle` como fondo CSS de 12x12 (clase `art`, `data-art`). Solo con arte real
  (origen distinto de `auto` y `placeholder`); si no, las formas de antes (`drawSkull`,
  colores de `state/pvp.ts` `skullColor`). La lista de batalla ya no deshabilita a los
  jugadores: un click = `SetTarget` (el servidor decide); también click derecho en el canvas.
- **Opciones guardadas (2026-11-26, docs/05 "Opciones guardadas" y "Opciones de la
  cuenta"):** toda opción o interruptor nuevo se declara en `OPTIONS` de
  `state/saved-options.ts` con dónde se guarda (`character`, `account`, `device-class` o
  `session` con su motivo); `saved-options.test.ts` falla si aparece una clave `rpg.*` de
  `localStorage` o un mensaje `Set*` sin declarar (solo ve eso: un interruptor que viaja en
  otro mensaje o vive en el estado de una pantalla se declara a mano). Lo que guarda una opción toma su
  storage de `optionStorage()` (`state/option-storage.ts`), nunca `window.localStorage`
  directo: así el cambio llega a la cuenta (`OptionsSync`, 2 s después del último; queda
  anotado en `rpg.optsUnsent` hasta que el servidor lo confirma, y lo anotado gana en el
  siguiente login). Una opción que dice algo de los personajes de la cuenta lleva
  `personal: true` (no se rellena con lo que dejó otra cuenta). Una
  opción de interfaz nueva necesita además su campo en `server/internal/accountopts`. La
  postura, perseguir y el modo seguro vienen de `Welcome.options` (`GameUi.fightStance`,
  `chase`, `safeMode`): el cliente ya no manda el modo seguro tras el `Welcome`.
- Modo seguro: `Game.safeMode`/`setSafeMode` (`localStorage` `rpg.safeMode`, activado por
  defecto, `state/pvp.ts`, solo como valor hasta que llega el `Welcome`); el vigente lo dice
  `Welcome.options` y se manda solo cuando el jugador cambia el interruptor. Interruptor `data-testid="safe-mode"` en "Modo de combate".
- `WorldState` suelta el objetivo con `combat.cannot_attack` y con los rechazos `pvp.*`
  (`TARGET_REFUSED`). Un `content_id` llamado `skull` se traduce como `client.skull.<id>`.
- Guerras: `GuildView.wars` (`state/guild.ts`, `warActions`/`warLine` puros y con tests),
  sección "Guerras" del panel (`data-testid="guild-wars"`, `guild-war-declare` para el
  líder), `Game.guildWar`. E2E "T5.2" de `e2e/game.spec.ts`: dos guardianes de nivel 25
  sembrados con `psql` en `testisle_no_pvp` (rechazo), bajan 3 casillas, el ataque marca
  al atacante y la víctima en modo seguro puede defenderse; el atacante no puede salir
  (screenshots 49–51).

## Notas de T5.3
- `WorldState.trade` / `market` (`state/market.ts`, puro y con tests: `tradeFrom`,
  `marketFrom`, `marketFee`, `createProblem`, `searchItems`). Un `TradeUpdate` que cierra con
  `reason` deja esa clave en el log. `ItemDef.tradeable` y `marketable` salen de
  `vite/content.ts`.
- `ui/Trade.tsx` (arriba a la derecha del mapa) y `ui/Market.tsx` (arriba a la izquierda)
  no usan hooks: formularios no controlados que leen sus campos al enviar, y
  `ui/Trade.test.ts` recorre sus árboles sin DOM. El intercambio se propone con el botón
  "⇄" de la lista de batalla (`data-trade`); lo ofrecible es lo `tradeable` de los
  contenedores abiertos. El mercado se abre con click derecho sobre un tablero (es un
  `UseItem` como cualquier item del mapa); la búsqueda es un `<datalist>` de los nombres
  traducidos: la búsqueda prefiere el nombre exacto, luego el prefijo (`searchItems`).
- Una `MarketUpdate` con `refresh` (el servidor la manda solo, por la acción de otro)
  pasa por `applyMarket`: actualiza la ventana si sigue abierta y nunca la reabre. Los
  formularios no controlados conservan lo escrito al refrescar. El precio que propone el
  formulario de crear es `MarketView.priceDefault` (el de referencia cuando se abrió ese
  item), que `applyMarket` mantiene mientras la ventana muestra el mismo item: un
  `defaultValue` que cambia reescribe el campo si el jugador no lo tocó. El formulario
  lleva `key` por item, así otro item empieza de cero.
- `MarketView.readOnly` (`MarketUpdate.read_only`) muestra el aviso
  `data-testid="market-read-only"`; `Disconnect{SAVE_FAILED}` y `{CHARACTER_LOCKED}` usan
  la tabla automática de motivos (`client.disconnect.*`).
- E2E "T5.3" de `e2e/game.spec.ts`: dos guardianes sembrados con `psql` junto al tablero de
  Puerto (3168, 6382) intercambian pescado por monedas, uno publica una oferta, el otro
  compra 3 y el primero retira el oro (screenshots 52–55).

## Notas de T5.4
- `WorldState.house` (`state/house.ts`, puro y con tests: `houseFrom`, `houseActions`,
  `daysLeft`). `ui/House.tsx` (arriba a la izquierda, como el mercado, y oculta si hay
  diálogo o mercado abiertos) no usa hooks; `ui/House.test.ts` recorre su árbol sin DOM.
- La ventana se abre con click derecho sobre una puerta: si la casilla no tiene nada
  encima, `useTile` manda `UseItem` con el suelo cuando la casilla está en
  `content.houseDoors` (de `world/islands/*/houses.yaml`, `vite/content.ts`). Un
  `content_id` llamado `house` se traduce como `house.<id>.name` (`world.yaml`, que ahora
  también va en los catálogos del sitio).
- La ventana tiene "Entrar" / "Salir" (`Game.houseEnter`/`houseExit`, según `access` e
  `inside`) y "Aceptar" manda el id y el precio que se ven (`Game.houseAccept`).
- Sitio: `/houses` (`site/Site.tsx` `HousesPage`, `GET /api/houses`), una tabla por
  pueblo con las mismas columnas (`.houses-table`).
- E2E "T5.4" de `e2e/game.spec.ts`: tres guardianes de nivel 15 sembrados con `psql` al
  sur de `puerto_house_net` (si una corrida anterior la dejó alquilada, un gm sembrado la
  libera con `/houseevict`); el dueño alquila, deja su mochila (con un pescado) adentro arrastrándola desde el slot de equipo (la página del dueño
  es más alta para que la mochila no quede bajo el chat), invita, el invitado entra y el
  tercero no; el sitio la muestra alquilada (screenshots 56–62).

## Notas de T2.5
- El mismo build corre en la app de escritorio (`apps/desktop`). `net/desktop.ts` detecta
  Tauri: la API va por el comando `api` (Rust guarda el token en el llavero; la página no
  lo ve) y el WS va a `server_info.ws_url`. En el navegador no cambia nada.
- La versión del `Hello` sale de `client/package.json` (`src/version.ts`): es la versión de
  la app de escritorio también. Súbela ahí y en ningún otro lado.
- La CSP de la app no tiene `'unsafe-eval'` ni estilos inline en HTML: por eso `main.tsx`
  importa `pixi.js/unsafe-eval`. No uses `eval`/`new Function` ni `<style>` inline.

## Notas de T2.1
- `ui/Account.tsx` (compartido por juego y sitio): `ForgotPasswordLink` y `VerifyNotice`;
  solo aparecen si `GET /api/auth/config` dice `email: true` (sin SMTP no se ofrece nada).
  En la app de escritorio no hay enlace de reset (abriría el sitio dentro de la app): se
  muestra la dirección `<servidor>/forgot-password` como texto para abrir en el navegador.
- `api.register` manda `lang` solo si el servidor tiene emails (`emailEnabled`, una vez por
  página): un servidor anterior a T2.1 rechaza campos desconocidos.
- `Disconnect{PASSWORD_CHANGED}` (un reset de contraseña) → `client.disconnect.password_changed`.
- `site/Account.tsx`: `/verify`, `/forgot-password`, `/reset-password`. El token llega en el
  fragmento (`#token=`, `routes.ts` `linkToken`), se manda en el cuerpo del `POST` y se
  borra de la URL con `history.replaceState`. Nunca lo pongas en una query.
- OAuth (2/2): `OAuthButtons` (`ui/Account.tsx`, solo los proveedores de
  `/api/auth/config`; en escritorio, un texto que manda al sitio) y `site/OAuth.tsx`:
  `/account` (vínculos), `/oauth/confirm` y `/oauth/error` (códigos fijos en
  `routes.ts` `OAUTH_ERRORS`). El navegador sale al proveedor con `location.assign` de la
  URL que dio el servidor. E2E: `e2e/oauth.spec.ts` contra `server/cmd/fakeoauth`.
  Fuera del origen de `public_url` (de `/api/auth/config`) los botones no se muestran: el
  login no puede volver ahí. El aviso de `/account?linked=` solo aparece para un proveedor
  que la cuenta tiene vinculado (`routes.ts` `linkedProvider`).
- E2E: `e2e/account.spec.ts` contra un tercer servidor (solo HTTP, emails activados) y un
  SMTP falso (`e2e/fake-smtp.ts`, mensajes en `smtpMessagesURL`).

## Notas de T0.5
- Los NPCs usan su sprite del atlas como los monstruos (`content.npcSprites`, de
  `data/npcs`); sin textura, el bloque de color de siempre.
- Jugadores (propio y ajenos): outfit `citizen` de `content.outfits` (`data/outfits.yaml`).
  Frames en el atlas: `<sprite>/<dir>_<frame>` (`outfits/citizen/s_0`). La dirección la elige
  `turnTo` (`packages/renderer/src/anim.ts`, docs/17 ANI-1) con `AnimState.facing`: una
  figura con diagonales en todas sus capas (`ClipSet.eight`, `CreatureBody.eight`; los
  humanoides del motor) gira a la diagonal; una de 4 direcciones conserva la mitad de la
  diagonal que ya mira, o toma la horizontal. Nunca se mezclan. El canvas llama a `faceTo`
  (mismo archivo) por criatura y por frame: mira hacia su ataque (`startAttack`, por octante)
  mientras dura el clip o la embestida y hasta que camina o gira; si no, hacia su paso o su
  `dir`. El servidor no gira a un jugador que ataca: es solo dibujo. El frame lo elige la animación ("Animación de
  criaturas"): con 3 frames T0.5, 0 parado y, durante un paso, 1 la primera mitad y 2 la
  segunda, así pasos seguidos alternan 1, 2, 1, 2.
- El canvas usa el outfit solo si el atlas lo anima (`anims`) o tiene arte real para todos
  sus frames (origen distinto de `auto` y `placeholder`); si no, el bloque. Desde el lote 13
  un atuendo con `look` es un humanoide del motor (ver "Humanoides del motor"); su quieto
  compuesto `outfits/<atuendo>/<dir>_0` queda como respaldo. Alpha de invisible, nombre,
  barras, marca PvP y marco de objetivo no cambian.

## Animación de criaturas (docs/17 ANI)
- Todo cuerpo de criatura (monstruo, NPC o el atuendo de un jugador) es un `CreatureBody`
  (`render/creature-body.ts`): la sombra de contacto (solo `shadow: ellipse`) y un sprite
  anclado abajo al centro. Los `br` conservan la esquina de abajo a la derecha en la de su
  casilla (como `MapView`); los `bc` (de 64x64: los humanoides del motor y las criaturas
  animadas) pisan `FEET_LINE` px por encima del borde de abajo. Nombre, gremio y barra suben `lift` px (el alto del dibujo
  sobre su casilla, de `top` y `foot` de `atlas.json`).
- `render/clips.ts` (puro, con tests) arma una vez por sprite sus texturas por acción,
  dirección y frame: las de `atlas.json` `anims`; para un atuendo T0.5 sin animación, sus
  `<dir>_<n>` como quieto (0) y caminar (1..); si no, la textura única. Una acción sin todas
  sus texturas se descarta. Quieto y atacar (`OWN_FACINGS` de `packages/renderer`) quedan
  vacíos hacia una dirección que no tiene frames (las criaturas de Gemini muerden de
  perfil y no siempre de frente): ahí `clipTexture` da el frame parado de esa dirección y
  `animate` hace la embestida procedural, en vez de girar hacia otro lado. Disparar
  (`shoot`) y conjurar (`cast`) son ataques también: `OWN_FACINGS` los incluye. Caminar y
  morir toman el sur (o la primera) como antes.
- Cada frame, `animate` (`packages/renderer/src/anim.ts`, puro, con tests) escribe la pose
  en un único objeto reutilizado: caminar por distancia (el ciclo sigue entre casillas,
  `perTile` frames por casilla), quieto con fase por id, el frame de caminar se sostiene
  100 ms entre pasos encadenados (ANI-3), ataque y muerte una vez. Sin clip, lo procedural
  de ANI-5: salto de 2 px por casilla, inclinación de 1 px, aplastado al aterrizar,
  respiración, embestida de 6 px, flotar (`flying`), espejo según `facing`, caída aplastada
  con desvanecido. Además, para todos: destello rojo y empujón de 2 px al recibir un golpe
  y aparición con fundido de 300 ms. Un frame no crea objetos para esto (docs/07).
- **Al ritmo de su paso** (docs/17 "Criaturas al ritmo de su paso", lote 20e): un sprite con
  `body` o `stride` en `atlas.json` `anims` camina por distancia sobre su zancada
  (`strideOf`, `walkPerStep` con ella; sin frames, la marcha procedural de su cuerpo), un
  volador (`isFlyer`) bate por tiempo y da `Pose.walk` -1, y un `slither` ondula. Sin las
  dos, la regla de `perTile` de arriba. Hook E2E `__rpgClient.gaits()` (`GaitView`: cuerpo,
  zancada, si camina, ciclos jugados, frame y dónde se dibuja, en px de sprite).
- Quién ataca a quién (`render/creature-events.ts`, puro, con tests; ANI-7, A9): con
  `Welcome.attack_events` lo dice el servidor. Cada `CreatureAttack` que llegó desde el
  frame anterior (`WorldState.attacks`) juega el ataque de su atacante hacia el objetivo
  donde el cliente lo dibuja, o hacia `to` (`attackDir`; un área, hacia donde mira), con el
  clip de su tipo (`attackAction`: `RANGED` → `shoot`; `SPELL` → `cast`; `MELEE` →
  `attack`; un muñeco de capas cuyo arma se conoce, por esa arma: `figureAttack`, ver
  "Humanoides del motor"; `startAttack` con la acción, y `attackClip` de `anim.ts` cae en
  `attack` si el sprite no tiene ese clip, y en la embestida si no tiene ninguno); un
  número de daño hace destellar a la víctima y la empuja lejos del ataque de ese batch que
  la apuntó o del centro del área que la cubre (`attackerOf`, `pushFrom`). Con un servidor
  viejo (sin `attack_events`) se deduce como antes: un `Projectile` anima a la criatura de
  su casilla de salida; un efecto de golpe, bloqueo o elemento sin proyectil en el mismo
  batch, al atacante cuerpo a cuerpo (el propio jugador si su objetivo está ahí y al lado;
  si no, una criatura del otro bando al lado, primero la que mira esa casilla).
- Salidas (ANI-7): el canvas juega cada `CreatureDisappear` que llegó desde el frame
  anterior una sola vez (`DepartureFeed` de `render/creature-events.ts`, por la hora del
  batch, sobre `WorldState.departures`), antes de dibujar las criaturas, sobre el cuerpo
  dibujado en el frame anterior. `leaveStyle` decide: `DEATH` (o, con un servidor viejo,
  salir con la barra en 0: `leavesDying`) cae; `TELEPORT` y `LOGOUT` se desvanecen
  (`startVanish`, `VANISH_MS` 350 ms: se angosta, se estira, tinte `SHIMMER_TINT`,
  parpadea); `OUT_OF_VIEW` y `DESPAWN` salen en el acto. El cuerpo que cae o se desvanece
  queda como "fantasma" (`ghosts`, una lista: puede convivir con la criatura de vuelta)
  sin nombre ni barra hasta que termina. Así un jugador que muere a la vista y despierta
  en un templo también a la vista (sale y vuelve en el mismo batch) deja su cuerpo cayendo
  donde murió, y la criatura de vuelta es un sprite nuevo, con estado nuevo y su fundido
  de 300 ms. Una criatura que deja de dibujarse sin salida propia (otro piso, un mapa
  nuevo) se borra. Un fantasma tapado por una criatura más alta queda tapado (sin copia
  translúcida desde el 2026-11-26).
- **Muerte continua** (docs/17, rama `feat/death-anim`): la caída termina en la pose del
  cadáver y se funde sobre él `DEATH_SETTLE_MS` (100 ms); ya no se desvanece a nada. El
  cuerpo baja `CreatureBody.fallY(dir)` px (`fallShift` con `rest`/`rests` de
  `atlas.json`, `restFor`); una sola imagen se vuelca (`Pose.tip`, `tipPlacement`).
- **Un cadáver por dirección** (docs/17, rama `feat/corpse-dirs`): la caída ya no es al sur.
  `AnimState.fallDir` (`s`, `e`, `n`, `w`; `startDeath(s, now, fallY, dir)`) y `fallArt` de
  `packages/renderer/src/anim.ts` deciden los frames (los de esa dirección, o los del sur
  espejados al norte y al oeste si la muerte solo se dibujó al sur) y el sentido del vuelco
  de una imagen; spritegen hace cada cadáver con la misma regla. Los restos traen
  `ItemMods.facing` y `body_sex` (`ItemMods.facing`/`bodySex` del cliente,
  `state/mods.ts`); `state/corpse-art.ts`: `corpseDir`, la clave `<item>@<quién>[/<e|n|w>]`
  (`mapItemKey`, `parseMapItemKey`, `keyFallDir`), `corpseSprite(quién, dir)` y los
  respaldos (`corpseSpriteIn`: esa dirección, el sur, la familia). El canvas (`leave`, con
  `followRemains` de `render/death-fall.ts`) hace caer el cuerpo hacia donde miraba y, apenas `CorpseVeil` conoce los
  restos de esa muerte (`FallHandle.laid`, de `begin` o de un `update` posterior), hacia
  donde dice su clave. `WorldState.withBodySex` solo adivina el sexo si el servidor no lo
  mandó. `hasEightFacings` no cuenta la muerte (los humanoides caen en cuatro direcciones
  y siguen girando en ocho). Hook E2E: `poses().dying[]` trae `way` y `corpseWay`.
  Una caída solo toma restos de la criatura que murió (`remainsWho` al canvas, `remainsAre`
  en `CorpseVeil.claim`), los más cercanos a su muerte: nunca un cadáver arrastrado a esa
  casilla. `render/fall-atlas.test.ts` compara la caída con el cadáver sobre el atlas real
  manejando el `CreatureBody` y el `animate` de verdad (se salta sin `make sprites`; en CI,
  que arma el atlas antes de vitest, falla si falta).
- Lo demás de la muerte continua: `render/death-fall.ts` (puro, con tests): `CorpseVeil` esconde
  (`renderable`) los restos de esa muerte (`WorldState.remainsLaid`, de un `TileUpdate`)
  mientras dura la caída y nunca más; `settle` termina el paso de quien muere caminando.
  Con movimiento reducido no hay fantasma de caída.
- `WorldState` no borra una salida cuando la criatura vuelve: la marca `back`, y
  `departureOf` la ignora (así un jugador que murió y despertó a la vista no "muere" al
  salir después del piso dibujado); el canvas igual la juega una vez.
- E2E: `__rpgClient.attacks(ms)`, `departures(ms)` (el motivo por su nombre, `DEATH`...)
  y `poses()` (quién está en pose de ataque, quién cae y quién se desvanece, cuánto lleva,
  el clip, `attack`, `shoot`, `cast` o `lunge`, y su casilla); `shotPose` de
  `e2e/game.spec.ts` espera un frame en medio de la pose, retiene `requestAnimationFrame`
  (el juego no dibuja otro), saca la captura y devuelve lo que vio en ese frame
  (`Caught`: quiénes estaban en la pose, dónde, y los ataques y salidas que el cliente
  guardaba). Una caída se saca en sus últimos 300 ms (`FALL_SHOT_MS`: el efecto del golpe
  ya termina) y en primer plano, 9x7 casillas alrededor del cuerpo (`closeShot`).
  Con un servidor sin eventos el cliente igual deduce poses y caídas, así que los tests
  exigen el evento: un `CreatureAttack` del jugador o su lobo y uno de una criatura en
  la pose (`07b-attack-pose`), y `DEATH` para cada criatura que cae (`11b-death-1-mid`, `-2-end`, `-3-corpse`: `shotFall`,
  tres cuadros de la misma caída con los frames y el reloj de la página retenidos).

## Humanoides del motor (rama `feat/humanoid-art`, lote 13)
- Jugadores, NPCs que son personas y monstruos humanoides se dibujan como **muñecos de
  capas** (docs/17 "Humanoides del motor", docs/06 "Looks"): un `CreatureBody` con un sprite
  por capa (cuerpo, piernas, pies, torso, pelo, barba, cabeza, escudo, arma), cada una con
  sus clips (`spriteClips` de su ruta `humans/...` o `worn/...`) y su tinte (un multiply),
  en la misma pose y frame. El orden por dirección es `LAYER_ORDER` de
  `packages/renderer/src/look.ts` (puro, con tests: `lookSprites`, `lookLayers`,
  `attackActionFor`); el cuerpo se reapila solo al girar (`layerOrder`). Lo que se lleva en
  la mano va sobre la ropa (docs/17 "Humanoides del motor"; 8 órdenes, uno por dirección: la
  oclusión del cuerpo ya viene en sus frames). Los sprites salen de `LAYER_POOL` y vuelven con
  `release()` (`dropSprite`, `dropGhost`): dibujar un frame no crea objetos. La capa del
  cuerpo es `figure.sprite` (la caja de `figureRect` para el muro translúcido).
- **Se desvanece entero:** las capas van en un contenedor propio dentro de `figure.root`
  (después de la sombra). Pixi multiplica el alfa de un contenedor en cada hijo, así que el
  alfa de la pose no va en las capas: mientras es menor que 1, el contenedor se dibuja a
  través de un `AlphaFilter` (uno por cuerpo, creado la primera vez y liberado con
  `release()`; opaco, sin filtro ni pasada de más). La invisibilidad del propio jugador
  (T3.2) es `CreatureBody.opacity` (0,4), no el alfa de su contenedor: el canvas lo pone
  antes de dibujarlo. Las copias translúcidas siguen `figure.alpha`.
- `render/look.ts` (puro, con tests): `wornFromVisible` (lo que muestran los slots visibles
  de un jugador, ids que manda el servidor: cada pieza con `worn` en su lugar, sin importar
  la mano), `dressPlayer` (la ropa del atuendo por defecto llena lo vacío; un disfraz,
  `costume`, tapa torso, piernas y pies), `wornKey`, `mulTint` y `dollSprites` (las capas
  que apila `dollOf`, con el color de la tienda en la ropa del atuendo).
- `game-canvas.ts` `personOf` (rama `feat/character-look`): todo sale del servidor
  (`CreatureState.look`, `equipment` y `worn`, `state/look.ts`): un jugador lleva los items
  de sus slots visibles sobre la ropa de su atuendo; un NPC o un monstruo, las piezas de su
  dato. Sin `look` (una bestia, o un servidor sin `data/looks.yaml`), o sin el cuerpo en el
  atlas, el camino de antes (el sprite del atuendo o del NPC, después el bloque). El
  contenido ya no trae `npcLooks` ni `monsterLooks`. La figura se rearma cuando cambia
  `CreatureState.lookRev` (`drawnLook`, un número: sube con `CreatureLook`,
  `CreatureCosmetics`, el `CosmeticsState` propio y cada vez que la criatura reaparece).
- El ataque de un muñeco elige el clip por el arma que lleva (`attackActionOf` →
  `figureAttack` de `render/creature-events.ts` → `attackActionFor`: arco y ballesta
  `shoot`, varita y vara `cast`, un hechizo `cast`, el resto `attack`), si se sabe qué
  lleva (`CreatureSprite.held`: lo que tiene en la mano cualquier muñeco, también otro
  jugador). Un cuerpo que no es muñeco juega el clip de su tipo (`attackAction`). Caminar usa `perTileNS` mirando al norte o
  al sur si el clip lo trae (`anim.ts`; los humanoides del motor ya no: un solo ritmo en
  todas las direcciones desde el 2026-11-26, docs/17 "La regla de la zancada"); la fase se cuenta en frames, así girar en
  medio de una caminata no hace saltar las piernas.

## Personalización (rama `feat/character-look`, lote 13; docs/02 "Apariencia")
- `state/look.ts` (puro, con tests): `lookView`, `equipmentView` y `wornView` leen el
  `Creature` y el `CreatureLook` del protocolo; `startingLook`, `randomLook` y `choosable`
  sobre las elecciones de `content.lookOptions` (de `data/looks.yaml`, en orden y sin las
  pieles `creatures_only`: `vite/content.ts` `loadLookOptions`).
- `ui/LookPickers.tsx` (sin hooks, `ui/LookPickers.test.ts`): un `fieldset` por parte
  (sexo primero, con dos botones de 44 px, "Hombre" y "Mujer"; cuerpo, piel, peinado,
  color de pelo, barba; elegir "Mujer" deja la barba en `none`, `withSex` de
  `state/look.ts`); los estilos con su nombre
  (`appearance.<parte>.<id>`, armado en tiempo de ejecución: `make validate` no lo revisa,
  lo revisa `vite/content.test.ts`), los colores como muestras con `aria-label`. Cada botón
  lleva `data-look="<campo>:<id>"` y `aria-pressed`; el elegido no manda nada.
- `ui/LookPreview.tsx` (con hooks) + `render/look-preview.ts` (puro, con tests): la figura en
  vivo, sin Pixi. Lee `/atlas/` una vez (`loadPreviewAtlas`, solo los frames `humans/` y
  `worn/` con su recorte), apila las capas con `lookLayers` y las dibuja en un canvas 2D
  (`drawDoll`: cada una en un canvas de trabajo, multiply con su tinte y `destination-in`
  para recortarla) a escala entera, solo la ventana de 48x48 del frame donde se dibuja
  (`PREVIEW_VIEW`). Camina en el lugar (110 ms por frame; quieto con movimiento reducido) y
  gira con ‹ › (`turn`, `TURN_ORDER`). Test ids: `look-preview` (o el `testid` que se le
  pase), `look-turn-left`, `look-turn-right`.
- **Crear personaje** (`ui/App.tsx` `Characters`): `create-look` con la figura (la ropa de
  `citizen`), los selectores y "Al azar" (`look-random`); empieza en el cuerpo de `citizen`.
  `api.createCharacter(name, vocation, look)` manda `look` en snake_case.
- **Apariencia → Personalizar** (`ui/Appearance.tsx` `Customize`, sin hooks): el borrador
  vive en el `Game` (`setLookDraft`, `GameUi.lookDraft`); `GameUi.look` y `selfEquipment`
  son los del servidor. "Guardar aspecto" (`look-apply`) manda `SetLook`
  (`Game.applyLook`), "Deshacer" (`look-revert`) suelta el borrador; volver a elegir el
  aspecto que se tiene también. La figura lleva lo que se lleva puesto, menos la pieza de
  cabeza (taparía el pelo que se elige). Las respuestas del servidor son
  `appearance.invalid` / `appearance.unavailable` (no `look.*`: esos son de "mirar", rutina
  que no flota).
- Hook E2E: `__rpgClient.players()` trae `look` y `equipment` de cada jugador que se ve.
- Vista previa: escenas `characters` (el formulario con la figura) y `appearance` (la
  ventana con un borrador sin guardar) de `make ui-preview`.

## Sprites de efectos
- Cada `effect_id` que manda el servidor (1–16, docs/05) tiene una tira de frames
  en el atlas: `effects/<nombre>/<n>` (`n` = 0, 1, …), 32x32, arte propio de
  `tools/spritegen` (`recipes/effects.ts`, 6 frames por tira). Nombres: `hit`, `block`,
  `heal`, `conjure`, `gather`, `gather_miss`, `buff`, `refine` y `shatter` (8 y 9, la
  forja) y los 7 elementos de `ELEMENTS` (`physical` … `death`, ids 10 + índice).
- `render/effects.ts` (puro, con tests): `effectFolder(id)` da la carpeta de un id;
  `effectFrames(id, hasArt)` lista los frames con arte real hasta el primero que falte
  (máximo `MAX_EFFECT_FRAMES`); `effectFrame(elapsed, frames)` reparte los frames en
  partes iguales sobre `EFFECT_MS` (600 ms, lo que el mundo guarda un efecto): el primero
  antes de empezar, el último desde el final. Se juega una vez, sin bucle.
- `render/effect-layer.ts` (`EffectLayer`, con tests sobre contenedores de Pixi sin
  render) dibuja efectos, proyectiles y números. Un id sin frames con arte real (id
  desconocido, o atlas con `auto`/`placeholder`) cae en la forma Pixi procedural de
  siempre, que se desvanece. Los sprites van anclados abajo a la derecha de su casilla,
  como los de criatura.
- Presupuesto (docs/07): todo sale de pools y se reutiliza; las formas procedurales
  comparten un `GraphicsContext` por id; un frame no asigna nada (los sprites y formas se
  toman por orden y los sobrantes se ocultan; un número conserva su `Text` mientras el
  mundo lo guarde y vuelve a una reserva al terminar). `WorldState.expire` filtra las
  listas en el lugar (`dropFinished`), sin un array nuevo por frame. Con la pestaña en
  segundo plano no hay frames: `apply` las filtra también al agregar (`pushLive`, una
  pasada por batch como mucho), así no crecen sin tope hasta que vuelve.
- Para cambiar un efecto: su receta en `tools/spritegen/src/recipes/effects.ts`,
  `make spritegen ONLY=effects/<nombre>/` y `make sprites`. Para un efecto nuevo del
  servidor: su carpeta en `FOLDERS` de `render/effects.ts` y su tira en la receta.
- **Proyectiles** (`Projectile.projectile_id` = `PROJECTILE_ELEMENT` + elemento; rama
  `feat/combat-visuals`): el arte es de spritegen (`recipes/effects.ts`, "missiles"),
  32x32 con el dibujo en los 16x16 del medio, alrededor de la esquina entre los píxeles
  (15, 15) y (16, 16). `render/effects.ts` (puro, con tests): `missileArt(id, hasArt)` da
  la flecha de uno físico (`ARROW_STRAIGHT` = `missiles/arrow/e`, `ARROW_DIAGONAL` =
  `missiles/arrow/se`; hacen falta las dos) o el orbe de un elemento
  (`missiles/<elemento>/0`, `/1`… hasta el primero que falte, y `missiles/<elemento>/trail`
  si está), o nada (id desconocido o sin arte real: el punto de siempre, `projectileShape`);
  `octant(dx, dy)` da el paso de 45° hacia el objetivo (0 este, en el sentido del reloj) y
  `ARROW_POSES`/`arrowPose` el dibujo y el espejo y giro de cuartos de vuelta de cada uno
  (exactos: ningún píxel se remuestrea; el lado iluminado queda arriba o a la izquierda);
  `orbFrame(elapsed, frames)` el frame del bucle del orbe (`ORB_FRAME_MS`, 80). En
  `EffectLayer`, un pool propio de sprites anclados al centro (`missileGroup`, después de
  las formas de proyectil): la flecha, o el orbe con hasta tres chispas detrás (`TRAIL`:
  0,3, 0,6 y 0,9 casillas atrás por su camino, más transparentes; ninguna antes de la
  casilla de salida), primero las chispas y después el orbe. Las texturas de un id se
  buscan una vez (`missileOf`). Flecha, virote, cuchillo y botella son la misma flecha:
  distinguirlos pide un campo en `Projectile` (docs/14).

## Notas de T5.5 (carteles y descripciones)
- `ItemDef.desc` es la clave del `description` del item en `data/items`; mirar un item
  agrega ese texto (sin `desc`, la convención `item.<id>.desc`). El plugin de Vite
  empaqueta esas claves aunque vivan en un catálogo de solo nombres (`items.yaml`,
  `world.yaml`): así un cartel (`brasal_dock_sign`, `description: text.volcan.dock_sign`)
  se lee con Mayús+click.
- El cliente nombra los items por `item.<id>.name`. Un item con un `name` compartido (las
  piezas de borde, los carteles con `item.signpost.name`) recibe esa clave con el texto
  compartido en el plugin; el código sigue pidiendo `item.<id>.name`.
- Las piezas de borde (`ItemDef.border`, las de `data/borders.yaml` que arma
  `vite/content.ts`) nunca son el item de arriba: `topItem` las saltea, así mirar una
  casilla de la orilla nombra su suelo y una casilla con solo piezas no ofrece "usar" ni
  "mover". `MapView` las dibuja con los suelos (`flat` del atlas), bajo las criaturas.
- E2E: el test "T5.5: wake up at the temple of Cinderstead" lee el cartel del templo
  (screenshot `65b-volcan-temple-sign`) y el de NPCs ("talk to NPCs"), que despierta en
  el templo del Farol, lee el de Puerto desde adentro (3163,6384, screenshot
  `12b-puerto-temple-sign`).

## Notas de libros y cofres (docs/02 "Libros y cofres", rama `feat/chests-books`)
- `ItemDef.book` (`BookDef`: claves de título y páginas) y `ItemDef.chest` salen de
  `cardFields` (`vite/content.ts`); el plugin empaqueta `books.yaml` entero (`CATALOGS`).
- **Ventana de lectura, sin servidor** (`state/book.ts`, `ui/Book.tsx`): `Game.useItem` de
  un item con `book` no manda `UseItem`: `openBook` publica `GameUi.book` (`BookState`:
  item y hora) y `closeBook` lo borra (×, Escape del `Game`). En escritorio es la ventana
  `book` de `SERVER_WINDOWS` (`serverWindows` con `book`, `serverClose` → `closeBook`),
  centrada (`windows.css`) y con el ícono `book`; en tablets y teléfonos, una hoja sobre el
  mapa como las del servidor (`client.css`). `BookWindow` lleva `key` por la hora de
  apertura: cada uso empieza en la página 1. `BookBody` no usa hooks (`ui/Book.test.ts`).
  Test ids: `book` (el marco), `book-page`, `book-prev`, `book-next`,
  `book-page-number`. Hook E2E `__rpgClient.book()`.
- **Cofres:** un `UseItem` común; el servidor contesta `chest.found`, `chest.empty` o
  `chest.no_room`. `ItemFacts.chest` da "Abrir" y `ItemFacts.book` "Leer"
  (`input/actions.ts`, `client.touch.action.read`, `client.action.read`); los dos cuentan
  como `usable` (el texto del cursor). Vista previa: escenas `book` y `scroll`.

## Notas de T5.6
- **Input táctil** (`input/gestures.ts`, `dpad.ts`, `actions.ts`, puros y con tests). Los
  listeners de puntero del canvas y de los items del DOM separan por `pointerType`
  (`isTouchPointer`: `touch` y `pen` van al reconocedor de gestos, el mouse sigue con su
  código de siempre). Nada de APIs viejas de touch. Los gestos mandan las mismas
  intenciones que el mouse: el servidor no sabe si fue un dedo.
  - Tocar una casilla = click izquierdo (caminar, o colocar el item elegido); tocar una
    criatura = click derecho (objetivo, o hablar si es NPC). Una herramienta "usar con"
    apunta a la casilla aunque haya criatura.
  - Toque largo (500 ms) = menú contextual (`ui/ActionMenu.tsx`, `GameUi.menu`): atacar,
    hablar, usar, abrir, mirar, mover. Los navegadores móviles mandan además
    `contextmenu` (y a veces cancelan el puntero antes): el canvas y `Game.touchContextMenu`
    lo toman como ese mismo toque largo, sin usar el item. El fondo del menú se cierra en
    `pointerdown`, no en `click`: al levantar el dedo el navegador puede mandar un click
    a lo que quede debajo, lo haya mantenido lo que lo haya mantenido (Chromium con
    toques de CDP lo hace siempre). En una pantalla baja (teléfono horizontal) el menú
    ocupa el alto y queda bajo el dedo (`menuPlacement` con `menuHeight`). Por eso sus
    botones solo aceptan un click después de un `pointerdown` sobre el propio menú
    (`Game.menuPress`/`menuPressed`, regla pura `menuClickCounts`) o del teclado
    (`detail` 0). El dedo que lo abrió bajó sobre el mapa o el item, nunca sobre el menú.
    Sin temporizador: antes eran 350 ms (`MENU_ARM_MS`) y en la CI, más lenta, el dedo se
    levantó después y el click eligió el botón de abajo.
  - Mover items sin arrastre: tocar el item (`Game.pickItem`, `GameUi.picked`, banner
    `PickBanner`, clase `picking-item` en `body`) y luego el destino: una casilla del mapa
    o cualquier `[data-drop]` (slot vacío o celda de contenedor), con un listener de
    captura en `window`. Arrastrar con el dedo sigue funcionando como con el mouse.
  - Pad direccional (`ui/TouchPad.tsx`, `HeldDirection`): se lee en `frame` como las
    teclas (`keys.take() ?? pad.take()`); un toque es un paso (o, quieto y hacia otro
    lado, solo un giro: MOV-2, ver "Movimiento fluido") y mantenerlo repite al ritmo de
    caminar. Interruptor en Opciones (`AudioOptions` tiene un hueco `children`; el
    estado vive en `main.tsx`), guardado en `localStorage` `rpg.touchPad`; sin elegir, se
    muestra con puntero grueso (pantalla táctil). Con pad, `.game[data-pad]`: la hotbar
    empieza después (`PAD_RESERVE_PX`) y en vertical el mapa sube y el pad va debajo.
  - Escape cierra primero el menú, después suelta el item elegido. Si un campo de texto
    toma el foco (`focusin`), se sueltan las teclas de movimiento.
- **Área segura** (muesca, esquinas, barra de inicio; las páginas piden
  `viewport-fit=cover`): la cuenta una sola vez el padding `env(safe-area-inset-*)` de
  `.game` (`client.css`). Lo que va sobre el mapa (pad, hotbar, botones de zoom, banner
  del item elegido, en `touch.css`) cuelga de `.viewport`, que ya está dentro de ese
  padding: sus márgenes son desde los bordes del mapa y no suman `env()` otra vez. Lo
  que usa `position: fixed` se mide contra la pantalla, fuera de ese padding, y toma los
  insets una vez en sus propios bordes: las ventanas en teléfono y tablet (diálogo,
  crafteo, mercado, casa, intercambio: `left/right/top/bottom: env(...)` en `client.css`),
  el selector de idioma fuera del juego (`.corner`) y el menú del toque largo, que lee
  los insets del padding de `.game` (`paddingInsets`, `ui/ActionMenu.tsx`) y deja sus
  8 px desde el borde del área segura (`menuPlacement`, puro y con tests). Algo nuevo con
  `position: fixed` hace lo mismo; algo nuevo dentro de `.viewport`, nunca. El pad
  (`.touch-pad-dock`, z-index 9) va sobre el mapa y el cajón (8) y bajo esas ventanas
  (12): en vertical la hoja del diálogo puede llegar a su última fila (iPad Mini, iPhone
  13, y más con muesca). E2E con
  insets de CDP en `mobile.spec.ts` (también el diálogo de un NPC y el menú).
- **Layout** (`ui/layout.ts`, breakpoints como datos): `.game` lleva `data-layout`
  (`desktop`, `tablet`, `phone-portrait`, `phone-landscape`), `data-panel` (`sidebar`,
  `tabs`, `drawer`) y `data-flow` (`row`, `column`); `client.css` cuelga sus reglas de
  esos atributos. Las pestañas son un `tablist` ARIA; el cajón está `inert` cerrado y
  recortado (`overflow: clip`, con `hidden` de respaldo) para que el teléfono no ensanche
  la página, ni un script o un campo con foco desplace el mapa de lado. Un resaltado
  del tutorial cambia a su pestaña. El encabezado es siempre una línea: la ayuda de
  controles se corta con "…" y se abre al tocarla; en teléfonos y tablets en vertical, un
  menú ☰ guarda experiencia, ayuda, idioma, opciones y salir. Ese encabezado compacto no
  ensancha la página con una fuente ancha (Linux dibuja `system-ui` con DejaVu Sans: en la
  CI se salía ~20 px a 390 px), en inglés o con números más grandes: sin lugar, cede
  primero el nombre (hasta sus 3rem; su letra encoge, `ui/fit-text.ts`, nunca se corta) y
  después el nivel (`.stat.level`), con "…"; vida y
  maná quedan enteros (solo ellos y el ☰ tienen que entrar). El `flex-shrink` enorme del
  nombre hace que el nivel espere (flex reparte por factor × ancho, y quitarle un pelo al
  nivel ya muestra su "…"). La barra de condiciones vacía no ocupa lugar (`:empty`) y el
  ☰ (y "Abrir panel") van a la derecha con margen `auto`, sin un ítem espaciador que
  costaba otro `gap`.
- Mientras un campo de texto tiene el foco y solo cambió la altura (teclado virtual), el
  layout no cambia; `--game-height` sigue al `visualViewport` (iOS). El chat hace
  `scrollIntoView` del input y no le llegan teclas al juego.
- Avisos del servidor sobre el mapa (`ui/notices.ts`, `data-testid="notices"`): en
  escritorio los importantes (no `look.*` ni el botín); con pestañas o cajón, todos. Los 3
  más nuevos, 6 s, sin tomar clicks.
- Nombres a zoom 1x (`render/labels.ts`): prioridad propio → objetivo → más cercano; si
  se pisa, pierde la línea del gremio, sube una línea o se oculta (salvo propio, objetivo o
  a 1 casilla). Un nombre nunca se acorta ni lleva "…" (dueño, 2026-11-26): si no entra,
  se dibuja más chico (`fitName`; ver "Nombres nítidos y NPCs en dos líneas"). Desde
  `feat/labels-and-steps` las reglas rigen mientras la casilla mide menos de 4 alturas de
  nombre (`labelsFull(tilePx, fontPx)`): con los tamaños de hoy, solo a zoom 1 ("grande"
  son 15 px a zoom 2 sobre una casilla de 64). En el DOM (placa del nombre, encabezado
  compacto, título del menú de acciones) rige lo mismo: `ui/fit-text.ts` (`fitTextRef`,
  puro en `fitText`, con tests) encoge la letra hasta que el nombre entra, piso de 9 px, y
  después lo parte en líneas (`data-fit="wrap"`); esas reglas CSS no llevan
  `text-overflow`. Un nombre nuevo en el DOM lleva `ref={fitTextRef}` y `key` con su texto.
- Hotbar: con poco ancho muestra los slots enteros que entran, con flechas ‹ › de 44 px y
  deslizamiento nativo; F1–F12 siguen en el DOM. En vertical con pad (`stacked` en
  `ui/Hotbar.tsx`) va a la derecha del pad: flechas y lápiz en una línea, y debajo los
  slots más angostos (3.2rem). Así entran 4 en un teléfono de 390–412 px
  (`layout.ts` `hotbarRoom`). La franja bajo el mapa (154 px, el alto del pad) es el
  `padding-bottom` de `.viewport`; el canvas se mide con la caja de contenido. El tutorial
  se pliega con "×" sin saltarse.
- Con pestañas o cajón, `.side-scroll` es `display: contents` y el log del sistema va
  arriba de la pestaña del chat. El escritorio ya no tiene columna lateral (ver "Notas de
  la UI oscura").
- **PWA:** `public/manifest.webmanifest`, íconos placeholder (`make pwa-icons`,
  `tools/spritegen/src/pwa-icons.ts`), `src/sw.ts` (emitido como `/sw.js` por
  `vite.config.ts`) con la política pura de `sw/policy.ts`: nunca `/api`, `/ws`,
  `/healthz`, la música (`/audio/sounds/music/`, docs/07 "Audio") ni otros orígenes;
  páginas network-first, `/assets/*` cache-first.
  `pwa.ts` lo registra solo en un build de producción, en contexto seguro y fuera de
  Tauri (lo importan `main.tsx` y `site/main.tsx`). Instalación y Tauri mobile:
  `docs/15-movil.md`.
- E2E: `e2e/mobile.spec.ts` (Pixel 7 vertical y horizontal e iPad Mini sobre Chromium;
  iPhone 13 vertical y horizontal e iPad Mini sobre WebKit, en el proyecto
  `webkit-mobile`, tests con "(webkit)" en el título). Toques con `page.touchscreen`; los
  toques largos y el pellizco usan eventos táctiles de CDP en Chromium y `PointerEvent`
  sintéticos en WebKit (`fingers`, id 1 para el primer dedo). El toque largo dura 1,2 s
  (el dedo se levanta mucho después de abrir el menú) y la casilla de la mochila se
  compara entera: otro test pudo dejar la suya en el mismo lugar (docs/08). Test ids:
  `touch-pad`, `[data-dir=north]`, `action-menu`, `[data-action=…]`, `pick-banner`,
  `pick-cancel`, `touch-pad-toggle`, `panel-tabs` `[data-tab=…]`, `panel-toggle`,
  `hud-menu`, `notices`. Hook `__rpgClient.monsters()` para tocar un monstruo.
- Un diálogo de NPC pasa `{name}` (el nombre del jugador) a su texto.

## Notas del HUD móvil (lote 21, rama `feat/mobile-hud`; docs/17 "UI móvil")
**Reemplaza** lo que "Notas de T5.6" y "Notas de la UI oscura" dicen del encabezado compacto,
el menú ☰, las pestañas bajo el mapa, la hotbar junto al pad (`PAD_RESERVE_PX`, la franja de
154 px) y los botones de zoom en esa franja. Los gestos, el área segura, el teclado virtual
y la PWA de T5.6 siguen igual.
- **Layout** (`ui/layout.ts`, la tabla de cortes está en su cabecera): `Layout` ya no tiene
  `compactHeader`; `PanelMode` es `sidebar` (escritorio), `sheet` (vertical) o `drawer`
  (apaisado); `isMobile(layout)`. `.game` lleva además `data-ui="mobile"` (como
  `data-ui="windows"` en escritorio) y `data-sheet` con la hoja abierta. `MOBILE_HUD` son
  las medidas (slot 48, botón 44, columna del orbe 68…), `mobileHotbarFit(ancho, flow)` los
  slots que entran y `consoleColumns` las columnas de botones; `ui/mobile.css` repite esas
  medidas como `--m-*` y `mobile-hud.test.ts` las compara.
- **Árbol** (`GameView.tsx`, rama no `windowed`): `.game-body` es siempre columna:
  `.viewport` (el mapa y lo que flota: bandeja de estados arriba a la derecha, minimapa
  arriba a la izquierda, `ChatGlance` abajo a la izquierda, avisos, zoom en apaisado),
  `MobileBar` (`section.hud-bar.mobile-bar[data-flow]`, test id `hud-bar` como en
  escritorio: orbes, `ExperienceBar`, la `Hotbar` con `margin={0}` y `stacked` en vertical,
  y en apaisado el pad flotando sobre la barra y los botones del panel y del menú),
  `.sheet-anchor > aside.side#side-panel` (la hoja: alto 0 y la hoja `bottom: 0`, así sube
  desde el techo de la consola sin medir nada; en apaisado el ancla es `display: contents`
  y el cajón cuelga de `.game-body` hasta `--m-row-h`) y, solo en vertical, `.mconsole`
  (test id `mobile-console`: el pad y `.mconsole-tools` con el tablist, el menú y el zoom).
  `.viewport` y `.game-body` conservan sus `key`: cruzar un corte no reemplaza el canvas.
- **Dónde va cada botón** (`ui/mobile-hud.ts`, puro): `tabsPlace` → `console` (vertical,
  siempre: la hoja no tapa la consola), `sheet` (apaisado con el cajón abierto) o `none`;
  `togglePlace` → `bar` (apaisado), `sheet` (la × de la hoja en vertical) o `none`. Un toque
  en un botón de sección siempre la muestra (`openTab`); no la cierra. Las teclas de ventana
  (I, K, L…) abren la hoja en su sección. Un paso del tutorial resalta el botón de su
  sección (`data-tutorial` en cada tab) y no abre la hoja.
- **Test ids**: se conservan `panel-tabs` `[data-tab=…]` (ahora botones de ícono con
  `aria-label`), `panel-toggle` (`aria-expanded`; en vertical solo existe con la hoja
  abierta), `hud-menu` (el `<details>` del menú; `hud-menu-close`), `logout-menu`,
  `controls-help`, `touch-pad`, `zoom-buttons`, `health`, `mana`, `level`, `experience` (la
  barra; el número del menú es `experience-total`). Nuevos: `chat-glance` (`data-lines`),
  `side-panel`, `mobile-console`. En el E2E, `showTab` y `closeDrawer` de
  `e2e/mobile.spec.ts` sirven para las dos formas.
- **Chat**: `ChatGlance` (el único componente del HUD móvil con hooks: su reloj) usa
  `glanceLines`/`glanceExpiry`; `KIND_CLASS` de `ui/Chat.tsx` da el color de cada línea. La
  sección del chat en la hoja lleva `ChatTabs` (las de escritorio); "visto" cuenta solo con
  la hoja abierta en esa sección (`viewedTab`).
- **Tablet táctil apaisada** (≥ 1024 px): pantalla de escritorio con
  `.game[data-ui="windows"][data-touch]` (`windows.css`, al final).
- **Vista previa**: `make ui-preview ONLY=game,social SIZES=phone,tablet`; en tamaños
  táctiles muestra el pad (`?pad=0` lo quita: escena `mobilenopad`).

## Notas de las hojas móviles (lote 21, rama `feat/mobile-windows`)
- `ui/sheets.ts` (puro, `sheets.test.ts`): pila de hojas (`syncStack`, `topSheet`, `closeTop`,
  `raise`), pares con inventario (`pairMode`, `sheetView`) y `isCloseSwipe`.
- `ui/use-sheets.ts` (`useSheets`, llamado en `GameView` solo con `tabbed && entered`): una
  entrada de History por hoja, `popstate`/Escape/deslizar sobre `[data-sheet-head]` llaman al
  cierre de la hoja de arriba (`closeDialog`, `closeStation`, `marketClose`, `houseClose`,
  `tradeCancel`, `stashClose`, `closeBook`, o la hoja del panel). Un encabezado nuevo de hoja
  lleva `data-sheet-head`.

## Notas de los controles táctiles (lote 21, rama `feat/mobile-touch`; docs/15)
- **Reglas puras, con tests** (`input/`): `joystick.ts` (`stickState`: 8 direcciones, zona
  muerta, histéresis), `pointers.ts` (`PointerOwner`: un dedo por control; `isPalm`;
  `TapGuard`: el `click` que sigue a un toque ya atendido se descarta), `input-mode.ts`
  (`InputMode`, `controlsShow`: el método de entrada es el del último evento),
  `targeting.ts` (`nearestTarget`, `nextTarget`: solo monstruos), `context-action.ts`
  (`tileContext`, `contextAction`) y `touchDrag` en `gestures.ts`.
- **`Game`**: `targetNext()`, `interact()` (la acción de contexto: manda `NpcTalk`,
  `SetTarget`, `PushObject` o `UseItem` como un click), `setInspect(on)` (el siguiente
  `tapTile` mira; clase `inspecting` en `body`), `setChase(on)`; `GameUi.context` e
  `inspect`; `GameOptions.haptic(kind)`; hook E2E `__rpgClient.lastCast()`.
- **Mantener para caminar con el dedo** (reemplaza "El dedo no mantiene" de "Movimiento
  fluido"): `GameCanvasOptions.touchDrag` → `Game.touchDragOn`: un arrastre desde una
  casilla sin item movible es `holdAt`/`holdEnd` siguiendo al dedo; con item, lo arrastra;
  con mira, item elegido o el modo mirar, nada. El dedo quieto sigue siendo el toque largo.
- **UI**: `ui/TouchStick.tsx` (test id `touch-stick`, `data-held`), `ui/ActionCluster.tsx`
  (sin hooks; `touch-cluster`, `touch-attack` con `data-targeting`, `touch-interact` con
  `data-context`, `touch-look` y `touch-chase` con `aria-pressed`, `touch-quick-<n>`),
  `ui/tap.ts` (`tapProps`: úsalo en todo botón que deba responder mientras otro dedo está
  en el pad; la hotbar ya lo usa), `ui/TouchOptions.tsx` (`touch-options`,
  `[data-touch-pad=dpad|stick]`, `touch-opt-size`, `touch-opt-actions|mirrored|pinned|haptics`,
  `effects-reduced`).
- **`.game`** suma `data-input` (`touch`, `mouse`, `keyboard`), `data-controls="faded"`,
  `data-mirror`, `data-touch-size` y `data-cluster`; todo el CSS está al final de
  `ui/touch.css`. El atenuado solo rige con `data-touch`; `pointer-events: none` solo con
  `any-pointer: fine` (un mouse real): en la emulación de Playwright los controles
  atenuados siguen tomando toques.
- **Preferencias del dispositivo** (`state/touch-controls.ts`, declaradas `session` en
  `saved-options.ts`): `rpg.touch` (`TouchPrefs`), `rpg.effects` (`data-effects="reduced"`
  en `<html>`, que `game-canvas.ts` lee en `reducedEffects`) y `rpg.appMode`.
- **Modo app**: `state/install.ts` (puro), `ui/app-mode.ts` (el almacén de la página:
  `beforeinstallprompt`, `appinstalled`, `fullscreenchange`, `UPDATE_EVENT` de `pwa.ts`,
  `keepAwake`) y `ui/AppMode.tsx` (`AppModeButtons` con `where` y `fallback`,
  `FullscreenReoffer`, `IosSteps`). Test ids: `app-mode` (`data-platform`, `data-where`),
  `fullscreen-button`, `fullscreen-hint`, `fullscreen-reoffer`, `install-button`
  (`data-install=prompt|ios-steps`), `install-dismiss`, `install-steps`,
  `install-steps-close`, `app-update`, `app-update-reload`.
- **Vista previa**: escenas `touchstick` y `touchleft` (`?stick=1&mirror=1&size=large`).
- **E2E** (`e2e/mobile.spec.ts`, grupos "lote 21 …"): `preferStick` (siembra `rpg.touch`
  antes de cargar), `clusterFits`. Un `.click()` de Playwright es un mouse: después de uno,
  `data-input` es `mouse` y los controles salen atenuados en la captura.

## Notas del QA móvil (lote 21, rama `feat/mobile-qa`; docs/15 "QA móvil")
- **Auditoría táctil**: `e2e/touch-audit.ts` (`touchAudit(page, { insets, allow, covered })`,
  `formatFindings`). La usan `e2e/ui-preview.ts` (`--audit`, `--lang`, `--notch`,
  `--covered`; `make ui-preview AUDIT=1 UILANG=en NOTCH=1 COVERED=1`; `AUDIT_ALLOW` con el
  motivo de cada excepción), los tests "lote 21 QA on …" de `e2e/mobile.spec.ts` y
  `e2e/device-check.ts` (un Chrome de Android por CDP). Una pantalla táctil nueva pasa por
  ella: 44 px de área de toque, sin texto cortado, nada fuera de pantalla.
- `e2e/contact-sheet.ts`: hojas de contacto de una carpeta de capturas.
- La vista previa tiene un quinto tamaño táctil, `phone-748x298`: un teléfono apaisado
  dentro del navegador, medido en uno real.
- **CSS** (`mobile-css.test.ts` lo fija): con `pointer: coarse` todo `button`/`summary`
  mide 44 px de ancho y de alto y la etiqueta de un checkbox o radio es el objetivo; un
  botón más angosto a propósito necesita su regla y su entrada en `AUDIT_ALLOW`.
  `.alerts` (`GameView`) envuelve invitaciones y chequeo de presencia: `display: contents`
  salvo en el HUD móvil, donde es una columna. `.touch-cluster` se oculta con `data-sheet`.
  `.corner` deja de ser `fixed` hasta 640 px de ancho o 500 de alto.

## Zoom del mapa
- **Vista ancha** (decisión del dueño, `docs/02` "La vista", `docs/17` UI-4): el servidor
  manda 31x21 (+1) a todos (`Welcome.view_width`/`view_height` → `WorldState.view`,
  `state/view.ts`; 0 = un servidor viejo: 15x11). El zoom es solo de dibujo.
- `render/zoom.ts` (puro, con tests) decide la escala (`ZoomRange {min, fit, max}`):
  - `fit`, la vista ajustada (sin elección guardada): la vista más grande sin parte vacía,
    es decir la escala más chica a la que la ventana cubre la caja (`fillScale`). En
    teléfonos y tablets nunca una que muestre menos que las 15x11 clásicas (`pixelScale`,
    la de antes de la vista ancha): `min(pixelScale, fillScale)`; ahí `pixelScale` suele
    ser la menor y no cambia nada. **El escritorio es pantalla completa** (docs/17 UI-4,
    rama `feat/hud-fullscreen`): la caja es la pantalla entera sobre la barra de abajo
    (`--bar-px` = 88 px por la escala de la interfaz: el `padding-bottom` de `.viewport`)
    y `windows.css` pone `--map-cover: 1`, que `game-canvas.ts` lee: con `cover`, `fit` es
    `fillScale` a secas, para que el mapa siempre cubra la pantalla. En CSS px al 100 %:
    1920x1080 (caja de 1920x992) 2x con 30x15,5 casillas; 2560x1440 (2560x1352) 3x con
    26,7x14,1; 1280x800 (1280x712) 2x con 20x11,1; 1280x720 (1280x632) 2x con 20x9,9 (la
    regla de los teléfonos daba 1x, con franjas oscuras a los lados: cubrir manda); la app
    a 960x700 (960x612) 1x con 30x19,1. Con un servidor de 15x11, `fit` es `pixelScale`.
  - `min`: la mayor que muestra la ventana entera (`wholeScale`), al menos 1 y como mucho
    `fit`. A 1920x1080, 1280x800, 1280x720 y 960x700, 1x (a 1280x720, 31x19,75: lo que
    entra de las 21 filas); a 2560x1440, 2x.
  - `max`: la mayor que todavía muestra 7x5 (`MIN_VIEW`): 6 a 1920x1080, 8 a 2560x1440, 4 a
    1280x800, 3 a 1280x720 y 960x700.
  Siempre escalas enteras. El canvas muestra la ventana entera si entra y si no se corta
  a la caja del mapa en píxeles de sprite enteros (`viewPixels`), centrado en ella: como en
  el escritorio la caja termina donde empieza la barra, el jugador queda al centro del área
  sobre la barra y nada del mapa se esconde debajo (ya no hay franja de la hotbar ni
  `mapLift`: la hotbar está en la barra). `followCamera` centra en el jugador una vista de
  casillas fraccionarias (`shownTiles`), con la cámara en píxeles de pantalla enteros (ver
  "Movimiento fluido"). Si llegara otra ventana, el canvas se reajusta en el siguiente
  frame. Si la escala de la interfaz cambia el alto de la barra, cambia la caja de contenido
  de `.viewport` y el `ResizeObserver` del canvas lo ve.
- La cámara (`follow` en `game-canvas.ts`) se fija en cada frame y también en cada
  `resize`, incluido el de la creación: cuando el juego publica `__rpgClient` con
  `ready`, `tileToClient` y los clicks ya apuntan al mapa. Antes solo la fijaba el primer
  frame, que el ticker de Pixi se salta si su hora es anterior a su arranque (página
  ocupada): en la CI un Mayús+click justo después de `ready` cayó a 100.000 px, fuera del
  canvas. "talk to NPCs" lo comprueba en el instante en que se publican los hooks.
- Entradas: pellizco (`pinch` del reconocedor de gestos, escala inicial × separación,
  redondeada); botones +/− (`ui/ZoomButtons.tsx`, sin hooks, solo con puntero grueso,
  ocultos si la pantalla admite una sola escala); Ctrl+rueda sobre el canvas
  (`WheelZoom`: una muesca o un pellizco corto de trackpad = un paso, `preventDefault`
  para que la página no haga zoom). La rueda sin Ctrl no hace nada.
- Se recuerda por dispositivo en `localStorage` `rpg.zoom` (la escala, también alejada).
  La vista ajustada no guarda nada: vuelve a seguir a la ventana. Si la ventana ya no
  admite la escala guardada, se dibuja la más cercana posible y se conserva la elección.
- `GameUi.zoom` (`{ scale, min, fit, max }`) llega a la UI desde el canvas
  (`GameCanvasOptions.zoomView`); `Game.zoom(steps)` es lo que llaman los botones. Hooks
  E2E: `__rpgClient.zoom()` y `__rpgClient.view()` (`{ server, shown }`: la ventana del
  `Welcome` y las casillas, fraccionarias, que muestra el canvas).
- Ubicación de los botones (`touch.css`): abajo a la derecha del mapa, sobre una hotbar
  de una línea y bajo el cajón. En vertical con pad van en la franja, sobre las flechas de
  la hotbar. Mientras hay un item elegido, el banner toma su lugar y se ocultan.

## Movimiento fluido
Pedido del dueño: "fluidez de movimiento como en Diablo 2", por casillas y con el servidor
como juez. Medido antes del cambio (simulación de `state/walking.test.ts` con la lógica
vieja): a escala 3 la cámara saltaba de a 3 px de pantalla y 6 cada ~15 frames (7 % de
los frames) porque se fijaba a píxeles de sprite; un camino por click y las demás
criaturas arrancaban cada paso al llegar su batch (con 20–60 ms de jitter: 4–10 frames
disparejos cada 10 pasos y tirones hacia adelante); con RTT alto el teclado esperaba la
confirmación de cada paso (6 frames quietos y 3 ticks de hueco en el servidor cada 12
pasos a 400 ms); dos flechas no daban diagonal; un rechazo era un salto.
- **Pasos de teclado** (`state/world.ts`): `predicted` guarda hasta
  `movement.max_queued_steps` (`balance.yaml`, 4; llega en `Welcome.max_queued_steps`, no
  en el contenido empaquetado) pasos mandados sin confirmar. `canStep` deja decidir el siguiente cuando al paso
  dibujado le faltan `STEP_LEAD_MS` (50 ms, `state/motion.ts`) o menos; `chooseStep`
  prueba la dirección y, si es una diagonal bloqueada, su mitad horizontal y luego la
  vertical (`stepChoices`); si nada está libre, gira (manda `Turn` solo si cambia y sin
  pasos sin confirmar: el servidor gira en el acto y cada paso de su cola vuelve a fijar
  la dirección, así que uno se vería girado y los demás no; una tecla mantenida gira
  cuando se confirman). El
  paso nuevo empieza cuando termina el dibujado (`Walk.prev` mantiene el anterior hasta
  entonces) y se manda con `walkEpoch` y su número (`seq`, `PredictedStep.seq`, uno más
  por paso). El `CreatureMove` propio con el `walk_seq` del más viejo y sus mismas
  casillas lo confirma: conserva su inicio local y toma la duración del servidor (corre
  los de atrás). Cualquier otro paso propio con predicciones pendientes es `ownStep`: un
  paso sin `walk_seq` (uno de persecución, o de un `WalkPath` de otro cliente, que el
  servidor dio antes de recibir el `Walk`) o con el de una predicción ya abandonada va
  antes de los `Walk` pendientes; uno con `walk_seq` k responde también a los anteriores
  a k, que se perdieron. El paso del servidor se dibuja en el lugar de la predicción más
  vieja, las que quedan se mueven tras él (mismas direcciones, desde donde termina, una
  detrás de otra) y el dibujo se desliza. Así nunca queda una confirmación desfasada (antes
  el paso del camino "confirmaba" el `Walk`, y cada confirmación siguiente era la del
  `Walk` anterior). `expirePredicted` (cada `frame`) abandona las predicciones si la más
  vieja no tuvo respuesta `PREDICT_TIMEOUT_MS` (3 s) después de dibujada: su `Walk` se
  perdió y ninguno lo sigue; el personaje vuelve deslizándose. Un `WalkRejected` vacía
  `predicted`. `game.ts` `decideStep` (cada `frame`, y en el acto tras un click) solo pide
  `keys.take() ?? pad.take()` cuando `canStep` y se lo pasa a `Steering.next` con el
  punto bajo el mouse mantenido (abajo).
- **Época** (docs/05 "Caminar"): `walkEpoch` sale del último `WalkRejected` o
  `FullMapView` y va en cada `Walk`; el servidor descarta los de otra época sin contestar.
- **Click y mouse mantenido** (docs/17 MOV-3 y MOV-4, `state/steering.ts`, puro y con
  tests): `Steering.next(world, now, { key, toward })` decide el paso cuando `canStep`:
  la tecla o el pad primero (termina el camino), después el mouse mantenido, después el
  camino del click. Todo sale como `Walk` predicho (`predictStep`), igual que una tecla:
  el cliente ya no manda `WalkPath` ni `StopWalk`.
  - **Click** (`walkTo`): A* (`state/path.ts`, `pathPassable`) desde `self.pos`, es decir
    después de los pasos ya predichos, que se siguen dando; no espera `unconfirmed` 0.
    `Game.walkTo` llama a `decideStep` en el acto: sin paso dibujado, el primero sale en el
    mismo evento. El camino se rearma (`replan`, hasta `ROUTE_REPLANS`, 10) si el
    personaje no está donde el camino esperaba (un paso de persecución, una predicción
    abandonada), si el próximo paso ya no está libre (una criatura) o tras un
    `WalkRejected` (`Steering.heard`, que `game.ts` llama tras `world.apply` de cada
    mensaje): esa casilla va a `avoid`, y el segundo rechazo lo termina
    (`ROUTE_REFUSALS`: un aviso por rechazo, como `house.no_access` o
    `pvp.protection_locked`, no se repite casilla por casilla). Sin camino, o un
    `FullMapView`, lo termina. Un click es una intención nueva, como una tecla pulsada de
    nuevo: `walkTo` llama a `retryWalk`, así que un paso rechazado antes (`refused`) se
    vuelve a intentar una vez (un rechazo y un aviso por click). Mientras sigue rechazado,
    `plan` no pasa por esa casilla si planea desde donde empezó ese paso
    (`WorldState.refusedStep`): `predictStep` no lo daría y el camino no llevaría a nada.
    `mark` (`WalkMark`: casilla, hora, si hay camino) es el anillo de MOV-7.
  - **Mouse mantenido** (`toward`, el punto bajo el cursor en casillas fraccionarias,
    `GameCanvas.worldAt`): dirección por el ángulo desde el centro del personaje dibujado
    (`towardDirection` de `motion.ts`, 45° cada una; nada sobre la casilla propia); si no
    está libre, `stepChoices` (la mitad libre de una diagonal) y después el primer paso de
    un A* hacia la casilla bajo el cursor, guardado como camino con `heading`: se sigue
    mientras el cursor apunte igual (si no, en una U de muros entraba y salía). Sin nada,
    gira (`WorldState.turn`). Nunca pisa en línea recta una escalera, un agujero o un
    teletransporte que no sea la casilla bajo el cursor (`movesOnStep`; el A* ya los
    rodea, `pathPassable`): arrastrar el cursor por encima de un agujero no cambia de piso.
    Una búsqueda sin camino (o cuyo primer paso no se puede dar) no se repite desde la
    misma casilla hacia la misma durante `NO_WAY_MS` (250 ms): parado contra un muro,
    `canStep` está abierto en cada frame. Ese frame no crea objetos (docs/07): `drawPos` y
    `GameCanvas.worldAt` escriben en uno reutilizado y `stepChoices` es una tabla fija.
  - **Botón izquierdo en el canvas** (`input/mouse.ts` `LeftPress`, puro y con tests):
    `GameCanvasOptions.pressTile` le pregunta al `Game` (`Game.pressTile`, la regla pura
    es `pressAnswer`) qué puede hacer la presión: con una mira o un item elegido, solo
    click al soltar (y arrastre);
    sobre una casilla con un item movible (`topItem` sin `fixed`), arrastrar antes de
    `HOLD_WALK_MS` (200 ms) lo mueve y el click camina al soltar; sin item, camina en el
    acto (`walked`: el soltar ya no es click) y arrastrar es mantener. Quieto 200 ms (lo
    revisa el ticker del canvas antes de `frame`) o arrastrado: `holdAt` con la posición
    del cursor en la página, en cada `pointermove`; `setPointerCapture` sigue fuera del
    canvas; `pointerup`, `lostpointercapture` o un `pointermove` sin el botón llaman
    `holdEnd` (y el `blur` de la ventana lo suelta en el `Game`). Soltar no manda nada:
    se dan los pasos ya mandados. Cada presión (sin mira ni item elegido) llama a
    `retryWalk`, como una tecla pulsada de nuevo; el mantener en que se convierte no lo
    vuelve a llamar (un rechazo y un aviso por presión).
    El dedo mantiene arrastrando desde el lote 21 ("Notas de los controles táctiles").
  - **Doble click** (controles de menú): `Steering.cancel()` termina el camino del primer
    click, sin `StopWalk` (dejaría `Walk` sin respuesta).
- **Respuesta visual** (MOV-7): el anillo (`render/walk-mark.ts` `markRing`, puro: 300 ms,
  de 0,5 a 0,25 casillas, se desvanece; dorado o rojo sin camino) es un `Graphics` del
  stage entre la luz y los efectos (`drawWalkMark`). El texto junto al mouse sobre el
  mapa (sale apenas el mouse pasa por la casilla, sin esperar a que se quede quieto; al
  caminar con el cursor quieto cambia a medida que el mapa pasa por debajo): un
  `div.map-hint` en `body` que el canvas mueve en `pointermove` y llena en el
  ticker cuando cambia la casilla bajo el cursor (o cada `HINT_REFRESH_MS`, 250) con
  `GameCanvasOptions.hoverText` → `Game.hoverText`: `defaultAction` (`input/actions.ts`,
  la primera opción del menú de esa casilla, nunca solo "Mirar", ni el "Usar" de un
  adorno fijo sin `ItemFacts.usable`: puerta, estación de `recipes` o tablero
  `ItemDef.board`) con `client.action.<tipo>` y el nombre, o el verbo solo
  (`client.touch.action.<tipo>`) sin nombre o para trepar. El texto va en `data-text` y
  lo muestra un `::after { content: attr(data-text) }`: no es texto de la página (ni los
  locators de Playwright ni un lector de pantalla lo encuentran, `aria-hidden`). Se
  oculta al apretar un botón, con una mira, un item elegido, un arrastre o un menú
  abierto (`Game.hoverText` da `""`; el texto, con z-index 70, quedaría sobre el menú).
- **Pasos del servidor** (las demás criaturas y los pasos propios que el servidor da por
  su cuenta, como los de persecución): `Game` pide
  `world.batchTime(batch.tick, now)` por batch y pasa ese `at` a `apply`; el paso empieza
  en `at` y se encadena tras el que se sigue dibujando (`prev`, sin saltos): si ese
  termina después de `at`, el nuevo lo espera y se dibuja hasta `PLAYOUT_CATCH_UP` (25 %)
  más rápido hasta volver a su hora; más de `PLAYOUT_MAX_LAG_MS` (500) atrasado, salta
  deslizándose. `Playout` es un colchón de jitter: retraso = la llegada más tardía de los
  últimos `PLAYOUT_WINDOW_MS` (2 s, en 8 baldes fijos), pero no más de
  `PLAYOUT_MAX_JITTER_MS` (200) sobre la más temprana, + `PLAYOUT_MARGIN_MS` (40). Una
  llegada más tardía lo sube de golpe; cuando la ventana la olvida, baja a
  `PLAYOUT_FALL` (100 ms/s), y la cadena con alcance hace que esa bajada no se vea. Un
  batch más tarde que el retraso arranca al llegar (la única pausa que queda) y ninguno
  espera más de 240 ms tras llegar: un corte de la red cuesta una pausa, no un atraso
  que dura. Antes la envolvente olvidaba a 5 ms/s y un corte de 1 s dejaba el mundo
  dibujado ~1 s tarde durante minutos (con `c.pos`, los clicks y los efectos a tiempo).
- **Correcciones**: `CreatureState.slide` (`slideBetween`/`slideLeft`) desliza en
  `SLIDE_MS` (160 ms, ease-out) cualquier salto del dibujo de hasta `SLIDE_MAX_TILES` (3);
  más es un teletransporte y salta. Las del propio jugador (`WalkRejected`,
  `expirePredicted`, `ownStep`) llegan hasta `ownSlideMaxTiles` (`max_queued_steps` + 1,
  5 con 4): con 4 pasos predichos el dibujo puede ir casi 4 casillas adelante del
  servidor, y eso también se desliza.
- **Dibujo**: `drawPos` usa `activeWalk` (el paso que se dibuja ahora: el último o los de
  antes mientras duren) más lo que queda del deslizamiento; `facing` es la dirección de
  ese paso mientras camina; `stepProgress` es `undefined` antes de empezar (parado). La
  cámara (`followCamera`) y las criaturas (`devicePixels`) se fijan a píxeles de
  pantalla, no de sprite: el mapa se mueve de a 1 px y la criatura seguida queda quieta
  en pantalla; los sprites siguen enteros (escala entera, desplazamientos enteros). Una
  criatura sin frames de caminar da el salto procedural de ANI-5 por casilla (`animate`
  de `packages/renderer/src/anim.ts`, ver "Animación de criaturas"; el viejo `walkBob` ya
  no existe).
- **Teclado**: dos teclas perpendiculares a la vez dan la diagonal (`MovementKeys.take`
  con `combine`), también un toque perpendicular con otra tecla mantenida.
- **Girar sin caminar** (docs/17 MOV-2, `input/keyboard.ts` `TurnTap`, puro y con tests):
  `decideStep` pasa la dirección de las teclas o del pad por `TurnTap.decide` con
  `WorldState.standingStill` (sin paso dibujado ni predicho) y la dirección propia. Quieto
  y hacia otro lado: `turn` (manda `Turn` en el acto) y después `wait` hasta que la tecla
  lleve `TURN_TAP_MS` (80 ms) apretada; soltada antes, solo giró. Un segundo toque antes
  de esos 80 ms (soltar y volver a apretar entre dos cuadros: `MovementKeys.fresh` y
  `HeldDirection.fresh` dicen si `take()` dio una pulsación nueva) no espera con el
  primero: ya mira hacia ahí, así que camina. Mirando ya hacia ahí, o caminando, `walk`
  como antes. Ctrl+flecha (`turnKeyDirection`, WASD no) solo gira. Un
  botón del pad activado con el teclado (`padStep`) es un paso siempre. En el E2E, un paso
  es `stepKey` / `stepToward` (`e2e/keys.ts`): un toque para girar si hace falta (y
  comprueba que no se movió) y otro para caminar; `faceKey` solo gira (los tests de tecla
  mantenida de `movement.spec.ts` giran antes de medir); `__rpgClient.self()` trae `dir`. Falta que el
  dueño decida si un cambio de dirección con las teclas solapadas debe dar ese paso
  diagonal (docs/14).
- **Tests**: `state/motion.test.ts` (puros), `state/world.test.ts` y
  `state/walking.test.ts`: este último simula cliente (el `WorldState` real y el `frame`
  de `game.ts`), un observador y las reglas de la cola del servidor sobre enlaces de 2 a
  300 ms con jitter, a 60, 144 y 40 fps, y exige cero frames quietos con tecla mantenida,
  camino por click y para el observador, cero huecos en el servidor y un rechazo sin
  saltos; con el `Steering` real, también el mouse mantenido y el click previsto (sale en
  el frame del click, sin frames quietos, rodeo tras un rechazo); además un click y
  después una flecha (cada `Walk` respondido por su paso), `Walk` perdidos y un corte de
  1 s de la red del observador (sin atraso que dure). Si cambias tiempos de `motion.ts`,
  córrelo. `state/steering.test.ts` prueba el camino (primer paso en el acto, después de
  los predichos, rodeos, `ROUTE_REFUSALS`, `ROUTE_REPLANS`, teletransporte) y el mouse
  (ángulo, deslizarse, el rodeo de una U sin volver atrás, girar, `NO_WAY_MS`, rodear un
  paso rechazado, no pisar un agujero que no está bajo el cursor) y que un click vuelve a
  intentar un paso rechazado. E2E `e2e/movement.spec.ts`: mantiene una
  flecha 2 s (4 o 5 pasos; como mucho los que entran en el tiempo medido) sobre una recta
  libre y lee `__rpgClient.trail(ms)` (el `drawPos` del modelo en cada `frame`,
  `MotionTrail`, un anillo fijo): ningún frame quieto ni hacia atrás (screenshot
  `96-movement-held-key`, sacado al soltar la tecla). El segundo test pasa el WebSocket
  por un proxy de Playwright (`page.routeWebSocket`, 75 ms + 0–40 ms por sentido, en
  orden; docs/17 MOV-9): una flecha 10 casillas tarda la suma de sus pasos
  (`__rpgClient.stepMs`) ± un frame; el mouse mantenido y un click a 5–7 casillas, sin
  frames quietos y saliendo < 150 ms después del botón (screenshots
  `96b-movement-lag-mouse-held`, `96c-movement-lag-click`). Las rectas evitan escaleras,
  agujeros y teletransportes, y el mouse aprieta una casilla sin items sobre el canvas
  (`elementFromPoint`). Mide el modelo, no el sprite ni la cámara en pantalla: su
  redondeo a píxeles de pantalla lo cubre `render/viewport.test.ts`.

## Notas de T5.7
- `CreatureState.cosmetics` (de `Creature.cosmetics` y `CreatureCosmetics`, con `""` = el
  aspecto por defecto) y `WorldState.cosmetics` (de `CosmeticsState`: `owned`, `balance`
  y `equipped`; también fija los cosméticos de la criatura propia). `GameUi.cosmetics` los
  publica. Hooks E2E: `__rpgClient.cosmetics()` y `players()`.
- Canvas: `render/cosmetics.ts` (puro, con tests) decide el atuendo (`outfitFor`, con
  citizen si no hay), el tinte multiplicado del sprite (`tintFor`) y el estilo del nombre
  (`nameStyleFor`, se mezcla en el `TextStyle`). `outfitReady` se calcula y guarda por
  atuendo: uno sin arte real cae a citizen y después al bloque. Cuando cambian sus
  cosméticos (`CreatureState.lookRev`), se tiran los sprites de un jugador y se arman de
  nuevo.
- Panel `ui/Appearance.tsx`, sin hooks (`ui/Appearance.test.ts` recorre su árbol). Es la
  ventana Apariencia de la botonera en escritorio y una pestaña más en teléfonos
  (`appearance` en `PANEL_TABS`). Muestra por tipo lo
  que la cuenta tiene, con la opción por defecto primero (manda `UnequipCosmetic`) y
  botones de 44 px con `aria-pressed`; tocar lo que ya se lleva no manda nada.
  El enlace a `/shop` se abre en otra pestaña; en la app de escritorio se muestra la
  dirección como texto (`client.appearance.shop_desktop`). Nada se compra por el socket
  del juego.
- Sitio `/shop` (`site/Shop.tsx`, helpers puros en `site/shop.ts` con tests):
  - Sin sesión muestra `SiteLogin`, que ahora acepta `hint`.
  - Un paquete hace `POST /api/shop/checkout` (con `lang`, para el nombre del paquete en
    la página del proveedor) y luego `location.assign(url)`. Con el proveedor falso
    (`isLocalCheckout`: la ruta propia `/api/shop/fake-checkout/`) el sitio hace `POST` a
    esa URL con su sesión y va a `/shop?checkout=success`: un `GET` no paga. La vuelta
    `?checkout=success|pending|failure` muestra su aviso una vez y se borra de la URL.
  - Un cosmético se compra con `confirm` y `POST /api/shop/buy`.
  - Cada código de error tiene su clave en `shopErrorKey`.
  - Los precios están en la unidad menor de la moneda: `formatPrice` divide según los
    decimales de `Intl` (CLP no tiene) y agrupa siempre.
  - La vista previa de un atuendo es su frame `s_0`, leído del atlas `/atlas/` como fondo
    CSS a 2x (`loadIcons`). `SiteContent.outfits` sale de `data/outfits.yaml`.
- El enlace "Tienda" del menú del sitio aparece solo si `GET /api/auth/config` dice
  `shop: true` (servidor con proveedor de pagos).
- E2E: `e2e/shop.spec.ts`; el servidor principal corre con `PAYMENTS_PROVIDER=fake`
  (docs/08 "E2E de la tienda").

## Notas de portales (escaleras, agujeros, sogas, teletransportes)
- El servidor mueve al jugador (`02-game-design.md` "Cambiar de piso"); el cliente solo ve
  un teletransporte: `CreatureMove` del paso y `FullMapView` del piso nuevo, que reemplaza
  todo (también los pasos predichos, y trae la época de caminata nueva). No hay estado
  propio de portales; solo `canStep` no predice más allá de un paso sobre una escalera,
  un agujero o un teletransporte (`movesOnStep`), y el mouse mantenido no pisa uno que no
  esté bajo el cursor (`Steering`, "Movimiento fluido").
- `content.portals` (de `world/islands/<id>/portals.yaml` de las islas de `world.yaml`,
  `vite/content.ts` `loadPortals`; un archivo que no se puede leer corta el build):
  casilla de entrada `"x,y,z"` → `kind`. `state/portals.ts` (puro, con tests):
  `pathPassable` hace que un camino por click rodee escaleras, agujeros y teletransportes
  salvo que sean el destino; `usedBare` hace que el click derecho (o "Usar" del toque
  largo) sobre un punto de soga sin items mande `UseItem` con el suelo, como la puerta de
  una casa; `climbable` hace que el click derecho sobre una escalera de mano mande
  siempre el suelo, aunque tenga algo encima (`state/items.ts` `tileUse`, modo
  `"first"`): un cadáver o una moneda no la tapan. **Ctrl+click derecho** (escritorio:
  `input/mouse.ts` `mapPress`, puro y con tests, da `use` con `top` = `e.ctrlKey`, y el
  canvas llama `useTile(x, y, z, top)`) usa el item de arriba aunque sea una escalera de
  mano; sin nada encima usa el item del portal (`ladder_up`/`ladder_down`), y el servidor
  trepa igual. Lo decide `useMode`
  (`state/portals.ts`, puro y con tests): `"first"` en una escalera de mano salvo con
  `top`, `"bare"` si la casilla se usa por el suelo (`Game.usesGround`), `"never"` en el
  resto. El toque largo sobre una escalera de mano muestra "Trepar"
  (`client.touch.action.climb`) y "Mirar"; si hay un item tirado encima, también sus
  botones ("Abrir"/"Usar" usan ese item, no trepan: pasan `top` como Ctrl; "Mover"). El
  item propio de un portal (`ItemDef.portal`, del bloque `portal` de `data/items`) nunca
  tiene botones: `state/items.ts` `menuItem` lo salta (el título del menú sí es su
  nombre). Así una escalera, un agujero o un teletransporte sin nada encima solo ofrecen
  "Mirar", y un punto de soga "Usar" (el servidor pide la soga) y "Mirar". La soga es
  una herramienta "usar con" como el pico. El teclado sí pisa una escalera: es la forma
  de bajar.
- Los items de los portales (`ladder_up`, `ladder_down`, `hole`, `rope_spot`, `teleport`,
  `stairs_*`) son items de mapa comunes: se dibujan del atlas como cualquier otro. Tirar
  un item sobre una escalera, un agujero o un teletransporte es un `MoveItem` normal: el
  servidor lo deja del otro lado y manda el `TileUpdate` de donde cae (el cliente no
  predice nada).
- Un paso predicho que el servidor rechaza (`WalkRejected` desde donde empezó y en esa
  dirección: sin lugar del otro lado de la escalera, `portal.blocked`, o la puerta de una
  casa sin acceso, `house.no_access`) queda en `WorldState` (`refused`): `predictStep` no
  lo vuelve a predecir ni mandar, así que una tecla mantenida no repite el aviso en cada
  paso. Se olvida con `retryWalk` (`game.ts`: tecla de movimiento pulsada de nuevo, sin
  contar la autorrepetición, o soltada; pad con otra dirección, soltado o tocado; pérdida
  del foco; un click, `Steering.walkTo`; una presión nueva del botón izquierdo sobre el
  mapa, `Game.pressTile`), con cualquier movimiento propio y con un `FullMapView`.
  Mientras dura, el camino por click y el mouse mantenido lo rodean: `Steering.plan` no
  pasa por esa casilla al planear desde donde empezó el paso (`refusedStep`).
- E2E "portals" de `e2e/game.spec.ts`: un guardián de nivel 30 de Karvask
  sembrado con `psql` en 3690,5796,7 hace click en 3693,5796 (el camino rodea la escalera
  de 3692,5796), baja con la flecha izquierda a 3692,5797,8 (el cliente tiene la
  `stairs_up` de 3692,5796,8) y sube con la flecha arriba a 3692,5797,7 (screenshots
  73–75: la escalera en la superficie, la mina en el piso 8 y de vuelta arriba).

## Notas de Thimblewick (`make play`, docs/16)
- La isla es `dev_only`: el servidor principal del E2E compila el mapa con
  `mapcompile -dev` (`playwright.config.ts`); el de Puerto no la necesita.
- E2E `e2e/sandbox.spec.ts`: corre en el servidor principal (inicio `testisle`). Un guardián
  con `town = 'pruebas'` y cuenta `gm` (sembrado con `psql`) despierta en el templo de la
  isla (2095,2086) junto a `pruebas_trainer`, y con `/tp` va a los corrales, al patio de
  portales y a la cueva del piso 8 (screenshots 90–93). El `-start-town pruebas` de
  `make play` se prueba a mano: elige el mismo templo para un personaje sin ciudad.
- El test de música del mismo archivo (otro guardián gm de la isla) espera el tema de la
  pool de Puerto solo, baja con `/tp` a la cueva y muestrea `__rpgAudio.music()` durante el
  fundido: la voz de la isla baja, la de las cuevas sube y out² + in² = 1 en cada muestra,
  sobre las envolventes del director y sobre las ganancias reales de los nodos (`heard`,
  con un margen de 0,05: los dos nodos se leen hasta un render quantum aparte); después
  queda solo el tema de cueva, con su elemento a menos de 1,5 s de donde el director cree
  que va (`time` contra `position`), sin errores de consola (screenshot `93b-music-cave`).

## Notas de la prueba exploratoria (rama `fix/playtest`)
- `ItemDef.blocks` aplica la regla de `packages/map-format`: un `kind: wall` bloquea salvo
  `blocks_movement: false`. `vite/content.test.ts` compara cada item con `loadContent` de
  map-format (paridad); antes el click para caminar atravesaba los muros.
- Teclado: `takesText` (`input/keyboard.ts`, puro y con tests) decide qué foco se lleva las
  teclas. Solo los campos de texto: un checkbox, un botón, un slider o un `select` con el
  foco dejan caminar con flechas/WASD (el select ya no cambia de opción con las flechas).
- Ventanas sobre el mapa en escritorio: `.npc-windows` va de `top` a `bottom: 5rem` (alto
  definido, deja pasar los clicks y solo sus ventanas los toman), así diálogo y tienda se
  desplazan adentro; `.viewport` usa `overflow: clip` (Tab no corre el mapa) y los avisos
  van debajo de las ventanas (`z-index: 1`).
- Hotbar de escritorio más baja y el canvas sube sobre ella cuando hay lugar
  (`--map-reserve-bottom` en `client.css`, `mapLift` de `render/viewport.ts`): a 1280x800
  tapaba la última fila del mapa. Ya no existen: desde la pantalla completa la hotbar va
  en la barra de abajo y el mapa termina en su techo ("Notas de la pantalla completa").
- Click derecho sobre una puerta (item `door` o puerta de casa) con otro jugador encima usa
  la puerta (`mapPress` con `playerInDoor`); la lista de batalla sigue apuntándole.
- `translator` agrupa los números con `Intl.NumberFormat` del idioma (no `x`, `y`, `z`,
  `id`...). "Dejar la casa" pide confirmación con un `<details>` (sin hooks). La cantidad
  de la tienda se limita y se muestra con `shopCount` (`ui/Dialog.tsx`).
- E2E: el segundo test de `e2e/sandbox.spec.ts` (screenshots 94 y 95).

## Notas de la UI oscura (docs/17, A2 y A3)
- **Fuentes OFL** (UI-3): Cinzel (títulos), Grenze Gotisch (logo, subida de nivel, muerte),
  Alegreya Sans (interfaz) y Alegreya (lo que dicen los NPCs, ayuda). Los `.ttf` de
  google/fonts están tal cual en `assets/vendor/font-*/` (`CREDITS.md`); `vite/fonts.ts`
  (tabla `FONTS`) los recorta al latín del juego, los sirve como woff2 en `/fonts/` y los
  emite en el build; `ui/fonts.css` tiene un `@font-face` por fila (`vite/fonts.test.ts`
  compara los dos). Nada se baja de la red: la CSP de escritorio es `font-src 'self'`.
- **La fuente del canvas** (rama `feat/combat-visuals`): nombres, gremios y números
  flotantes en Pixelify Sans (`render/canvas-font.ts`: `CANVAS_FONT`, la familia con
  `sans-serif` de respaldo; `CANVAS_FONT_SIZE` 11, una celda de su grilla de 1/11 de em por
  píxel de alto, aunque los avances no son celdas enteras y las letras caen entre píxeles a
  lo ancho; `CANVAS_TEXT_STROKE` 3), en `game-canvas.ts` y `effect-layer.ts`. Pixi mide y
  rasteriza un `Text` una vez, y `CanvasTextMetrics` guarda las medidas por fuente: por eso
  `createGameCanvas` espera `loadCanvasFont(document.fonts)` junto con el atlas
  (`CANVAS_FONT_WAIT_MS`, 2,5 s; sin `FontFaceSet` o si falla, sigue) y, si llega después,
  `onLate` limpia las medidas y llama `style.update()` de los nombres y gremios que hay
  (`redrawLabels`). Un número dura un segundo: el siguiente ya sale bien.
  `vite/canvas-font.test.ts` lee las tablas del `.ttf`: todo nombre de criatura tiene sus
  letras, uno acortado a zoom 1 (`labelText`) mide como mucho 96 px, las letras miden 7 y
  5 px de alto y los avances no son píxeles enteros (lo que dice `canvas-font.ts`).
- **Nombres nítidos y NPCs en dos líneas** (rama `feat/labels-and-steps`, 2026-11-25;
  docs/17 "Hecho: nombres nítidos y los NPCs en dos líneas"): **reemplaza** lo que dicen
  este bloque y "Nombres a zoom 1x" sobre la fuente y el tamaño de los nombres. Los nombres,
  el rol y el gremio ya no usan la fuente pixel ni `labelScale`: son Alegreya Sans
  (`LABEL_FONT`, 700 el nombre, 500 las líneas de abajo) rasterizada al tamaño que se ve en
  px de dispositivo (`labelFontPx(zoom, devicePixelRatio, tamaño)`, `subFontPx`,
  `labelStroke`), con el `Text` a escala 1. `render/labels.ts`: `fitName` (el nombre siempre entero en
  una línea: nunca se corta ni lleva "…"; si no entra, encoge hasta el piso `minNamePx(dpr)`,
  9 px CSS, y si aun así no entra se dibuja más ancho que su lugar. Con todas las etiquetas
  a la vista, el nombre más largo permitido, `CREATURE_NAME_MAX_CHARS` = 16, queda en
  `SHRINK_MIN` o más), `wrapRole` (el rol del NPC en una o
  dos líneas por palabras, sin "…"), `stackLabel` (gremio, rol, nombre, y el tope donde se
  apoya el globo), `labelsFull(tilePx, fontPx)` y `placeLabels(boxes, tilePx, fontPx)`. El
  rol sale de `content.npcRoles` (`vite/content.ts`, `npcRoleKey` de
  `@rpg/content-schema`). `labelScale` queda para los números flotantes y los globos.
  Hook E2E `__rpgClient.labels()`: `fontPx`, `dpr` y, por nombre, `text`, `fontPx`, `role`,
  `roleFontPx`, `scale` (siempre 1) y `top`.
- **Pisadas con voz** (misma rama, `livingworld/README.md` "Los dos pies"):
  `GameCanvasOptions.footstep(events, voice)` y `AudioEngine.play(events, at, listener,
  voice)` (`PlayVoice`: `gain`, `rate`, `pick`). Hook `__rpgClient.footfalls()`: `own` con
  `sound` y `rate`, y `prints` (lado, lugar, `wear`, superficie).
- **Tamaño y color de los nombres** (rama `feat/name-labels`, docs/17 "Hecho: nombres más
  grandes y legibles"): `render/label-style.ts` (puro, con tests) tiene los tokens de color
  (`LABEL_COLORS`, `SKULL_COLORS`, `LABEL_OUTLINE`; contraste ≥ `LABEL_MIN_CONTRAST`, 4,5,
  comprobado en `label-style.test.ts`: un color nuevo va ahí, nunca suelto) y `labelScale`
  (zoom, `NameSize`): los píxeles por celda de la fuente. Cada frame el canvas escala por
  ese entero el nombre, el gremio, la marca y los números flotantes (`EffectLayer.draw`,
  `textScale`), todos con `textureStyle` `nearest`; los huecos de `labels.ts` y de la marca
  también. La opción es `rpg.name-size` (`loadNameSize`/`saveNameSize` de
  `state/ui-prefs.ts`, `name-size` en `InterfaceOptions`), que llega como
  `GameSettings.nameSize` → `GameOptions.nameSize()` → `GameCanvasOptions.nameSize()`.
  Hooks E2E: `__rpgClient.labels()` (escala y caja en la página de cada nombre visible) y
  `wallFade(x, y)` (el alfa de las piezas de muro de una casilla, `MapView.wallAlphaAt`, y
  cuántas copias translúcidas se dibujaron).
- **Tokens** (UI-2) en `:root` de `client.css` (`--ui-*`; `--bg`, `--panel`, `--text`,
  `--muted`, `--accent` y `--error` quedan como alias para el sitio). El marco de hierro
  (`--ui-frame-shadow`) y la veta de piedra (`--ui-grain`, SVG en línea) los comparten
  todas las ventanas: la lista de selectores de "Frames" en `client.css`. Una ventana nueva
  se suma ahí. No uses colores sueltos: usa un token.
- **Escritorio** (`layout.panel === "sidebar"`, `.game[data-ui="windows"]`, `windows.css`):
  sin encabezado y **a pantalla completa** desde la rama `feat/hud-fullscreen` (antes era
  el mapa con el dock a su derecha; ver "Notas de la pantalla completa"). `ui/GameView.tsx`
  dibuja el mapa en toda la pantalla (`.viewport`, con la barra como `padding-bottom`), la
  barra gótica de abajo (`ui/HudBar.tsx`, la única pieza fija) y la capa de ventanas
  (`.win-layer`, la pantalla sobre la barra). En la barra:
  - `ui/Vitals.tsx`: orbes de vida y maná en sus engastes de hierro (se llenan con
    `transform`, el "fantasma" marca lo perdido, el de vida late bajo el 25 %;
    `orbFill`/`lowHealth` puros) y la barra de experiencia con la placa del nombre
    (`ExperienceBar`, `data-tutorial="stats"`; desde el lote 13 la placa de sobre el orbe
    de vida se fue: ver "Notas de la bandeja de estados");
  - la hotbar (`ui/Hotbar.tsx`, ya no sobre el mapa) y `ui/Toolbar.tsx`: botones con íconos
    propios (`ui/icons.tsx`, pixel art de 16x16 como texto; dos filas de seis a 1x, o una
    fila a 2x desde 1600 px) que abren y cierran las ventanas, el mercado (solo lo cierra:
    se abre desde un tablero) y "Salir del juego";
  - el chat ya no está en una columna: es una ventana más, flotante y translúcida, con sus
    pestañas en la barra de título (`ChatTabs`: Todo, Local, Grupo, Gremio, Global y el log,
    "Registro"; mientras el log no se ve, todos los avisos flotan sobre el mapa, no solo los
    importantes).
- **Ventanas** (UI-5): `ui/windows.ts` (puro, con tests) guarda cuáles están abiertas,
  dónde, plegadas y en qué orden; se recuerda por dispositivo en `localStorage`
  `rpg.windows` (si no se puede leer, vuelven las de fábrica: batalla, inventario y chat
  abiertos). `ui/GameWindow.tsx` es el marco (barra con ícono, título, mover, plegar y
  cerrar; `role="dialog"`). Desde `feat/hud-fullscreen` ninguna se acopla: todas flotan y se
  arrastran por la barra, con el imán (`snapPlace`). Doble click en la barra la pliega. Cierran con un
  fundido de 100 ms (`CLOSE_MS`, `[data-closing]`). Teclas (`WINDOW_KEYS`, solo fuera de
  un campo de texto y después del listener del `Game`): I inventario, K habilidades,
  L misiones, B batalla, P grupo, G gremio, O apariencia, H ayuda, M cierra el mercado; Escape cierra
  la de arriba de la pila (la última abierta o tocada; el chat nunca) o, si no hay, abre
  Opciones. Un resaltado del tutorial abre su
  ventana (`windowForHighlight`). Desde `feat/ui-windows-2` las ventanas del servidor
  (diálogo, tienda, crafteo, mercado, casa, intercambio) y cada contenedor son
  `GameWindow` también, y todas se mueven y cambian de tamaño con el mouse y el teclado:
  ver "Notas de lo que quedaba de A3, A4 y A5".
- **Gremio** (UI-7): ventana propia con pestañas Resumen, Miembros y Guerras
  (`GuildPanel` con `tab`; sin `tab` muestra todo, como en la pestaña de los teléfonos).
  Sigue sin hooks y `ui/Guild.test.ts` recorre las pestañas.
- **Opciones**: Sonido (`SoundOptions` de `ui/AudioOptions.tsx`; la esquina del login y el
  menú ☰ siguen con `AudioOptions`), Controles (pad), Interfaz (idioma, "Animaciones
  reducidas", escala, texto, sacudida, opacidad del chat y "Restablecer ventanas").
  `main.tsx` arma esas piezas (`GameSettings`).
- **Animaciones** (UI-9): solo `transform` y `opacity`, ≤ 240 ms salvo los bucles (ola de
  los orbes, latido). `prefers-reduced-motion` o la opción (`state/ui-prefs.ts`,
  `localStorage` `rpg.motion`, `data-motion="reduced"` en `<html>`) las cortan con una
  regla global al final de `windows.css`; el viaje en barco conserva su fundido.
- **Teléfonos y tablets**: el encabezado compacto, las pestañas y el cajón de T5.6 con el
  tema nuevo. La hotbar solo lleva su correa en escritorio: en el teléfono con pad cada
  píxel cuenta para sus 4 slots (`Hotbar` resta el padding y el borde de la barra).
- **Vista previa sin servidor**: `make ui-preview [ONLY=<escena>]` (`e2e/ui-preview.ts`)
  construye `preview/index.html` (`src/preview/`, solo con `RPG_UI_PREVIEW=1`: nunca va
  al build normal), dibuja un pedazo de Puerto con `mapcli render` en lugar del canvas
  (las 33x23 casillas de la ventana con su margen, del tamaño del canvas en la vista
  ajustada: `zoomRange` con `cover` y `viewPixels`, como `render/game-canvas.ts`) y
  saca screenshots de cada escena (game, windows, options, dialog, danger, death, login,
  characters) a 1920x1080, 1280x800, 1280x720, 960x700, teléfono vertical y horizontal y
  tablet, en `e2e/screenshots/actual/ui-preview/`. Playwright contesta cada pedido desde el
  build: no levanta servidores. Los estados están en `src/preview/fixtures.ts`.
- **E2E**: `e2e/windows.ts` (`openWindow`, `closeWindow`) abre las ventanas desde la
  botonera. Test ids nuevos: `toolbar`, `toolbar-<id>` (`options-button` para Opciones,
  `toolbar-market`, `logout`), `window-<id>` (`options` para Opciones; el chat es
  `window-chat`), `window-close-<id>`, `window-fold-<id>`, las esquinas
  `.gwin-resize[data-corner=nw|ne|sw|se]` (desde `feat/window-resize`; ya no hay `window-move-<id>`),
  `[data-window-button]`, `[data-chat-tab]`, `[data-guild-tab]`, `reduced-motion`,
  `windows-reset`, `hud-bar`; la ayuda es `controls-help`. El mapa empieza en la esquina
  de arriba a la izquierda de la página, pero ahí flota la ventana de batalla: un click en
  (1, 1) cae en ella. Para que las teclas vayan al juego, `keysToGame`
  (`e2e/game.spec.ts`) le quita el foco al campo de texto, sin clicks. La ventana de
  batalla, angosta, dice "Perseguir"; la casilla conserva su nombre entero (`aria-label`,
  "Perseguir al objetivo"). `.viewport` lleva `min-width: 0`: con `overflow: clip` (que no es un
  contenedor de scroll) el canvas fijaba su ancho mínimo y, al achicar la ventana, el mapa
  empujaba el dock fuera de la pantalla.

## Notas de A4 y A5 (docs/17 UI-6, UI-7 y UI-8)
- **Controles** (`state/controls.ts`, `localStorage` `rpg.controls`, `menu` por defecto o
  `classic`): Opciones → Controles (`ui/ControlsOptions.tsx`, `data-testid="controls-mode"`,
  radios `[data-controls=…]`). `main.tsx` guarda la elección y la pasa por
  `GameSettings.controlsMode`; `App.tsx` se la da al `Game` como `GameOptions.controls()`
  (la lee en cada click). Las reglas son puras en `input/mouse.ts`: `mapPress` (con el modo
  como quinto argumento: `menu` en una casilla sin criatura, Mayús+derecho siempre menú,
  Ctrl+derecho usa) e `itemContext` (el click derecho en un item del DOM). La criatura
  sigue con un click derecho: ataca o habla.
- **Menú del item** (`ui/ActionMenu.tsx`, el del toque largo): `ActionMenuView` suma
  `card` (la ficha), `mouse` (abierto con el mouse: `mousePlacement`, en el cursor, botones
  de 30 px, `data-pointer="mouse"`) y `stack` (para "Mover parte…"). Las acciones van
  arriba (la primera con la clase `default`), la ficha debajo y el alto nunca pasa el borde
  del área segura (se desplaza adentro). Acciones nuevas (`input/actions.ts`): `use_with`,
  `eat`, `equip` (`equipSlot` de `state/item-card.ts`; `MoveItem` al slot) y `split`
  (un `<details>` con un campo: `Game.menuSplit` elige la parte con `ItemPicker`).
  `ItemFacts.fixed` (`pickupable: false`) quita Mover. "Mover" y "Mover parte…" funcionan
  con el mouse: el siguiente click en una casilla (`clickTile` mira `picker.picked`), un
  slot o una celda deja el item.
- **Doble click**: en un item del DOM, `Game.itemDefault` (la primera acción); en el mapa
  (solo modo `menu`), el `dblclick` del canvas va a `Game.doubleClickTile`: termina el
  camino que empezó el primer click (`Steering.cancel`, sin `StopWalk`: desde A6 los
  pasos del click son `Walk` que esperan respuesta) y hace lo del click derecho clásico.
  Un toque de dedo reciente lo ignora.
- **Ficha** (`state/item-card.ts` `itemCard`, puro, y `ui/ItemCard.tsx`, sin hooks): los
  datos salen de `ItemDef` (`vite/content.ts` `cardFields`: `kind`, `weight`, `weapon`,
  `ammo`, `armor`, `shield`, `consumable`, `rune`, `requires`, `fixed`; opcionales).
  Quién mira (nivel, vocación, nivel mágico) decide si un requisito está en rojo
  (`GameUi.vocation`). `BigIcon` dibuja un ícono del atlas a 2x (`.big-icon`).
- **Tooltip** (`ui/ItemTooltip.tsx`, montado en `GameView` junto al menú): delegación en
  `document` sobre `[data-tip-item]` (+ `data-tip-count`), 350 ms de mouse, o foco del
  teclado con `:focus-visible`. Los items del inventario tienen `tabIndex=0`: Enter =
  acción por defecto, tecla de menú o Mayús+F10 = menú. Test id `item-tooltip`. Desde
  `feat/equipment-d2` sale sin espera, arriba del item y con la ficha compacta
  (`TipCard`): ver "Notas del equipo y el tooltip al estilo Diablo II".
- **Diálogo** (`ui/Dialog.tsx`): `DialogView` y `ShopView` son funciones sin hooks
  (`ui/Dialog.test.ts`); `DialogBox` (el filtro) y `ShopWindow` (pestaña, filtro,
  búsqueda, página, elegido, cantidad, columnas medidas con `ResizeObserver`) tienen el
  estado. En tablets y teléfonos `.npc-windows` va de lado a lado sobre el mapa; en el
  escritorio diálogo y tienda son `GameWindow` ("Notas de lo que quedaba de A3, A4 y A5"),
  abajo al centro, y con la tienda `.game-body[data-shop]` la pone a la izquierda del
  diálogo, que se angosta a una columna. Los temas vienen de
  `content.dialogTopics` (por NPC, `vite/content.ts` `dialogTopics`, `tag` del YAML) y
  `state/dialog.ts` arma la grilla. El retrato del NPC cabe en 64 px (`BigIcon` con `fit`,
  `PORTRAIT_PX`): un sprite de 32 px a 2x y el retrato de 64 px de una persona (el quieto
  del humanoide del motor, `npcs/<npc>`) a 1x (a 2x medía 128 px y el diálogo no entraba en
  un teléfono horizontal). Test ids: `dialog-filter`, `dialog-bye`,
  `[data-topic]`, `shop-search`, `[data-filter]`, `[data-shop-tab]`, `shop-grid`,
  `shop-prev`/`shop-next`, `shop-bar`, `shop-count`, `shop-minus`/`shop-plus`/`shop-max`,
  `shop-total`, `shop-act`. Las reglas de la tienda son puras en `state/shop.ts`
  (`shopLines`, `shopFilters`, `filterShop`, `shopPage`, `shopMax`, `shopCount`,
  `shopGrid`).
- **Gremio** (`ui/Guild.tsx`, sigue sin hooks): `GUILD_TABS` = summary, members, ranks,
  invite, wars, motd, cada botón con su ícono (`ui/icons.tsx`: `ranks`, `invite`, `motd`
  nuevos); las acciones sobre un miembro bajo un `<details class="member-menu">` "⋯". Test
  ids nuevos: `guild-summary`, `guild-ranks` (`[data-rank]`), `guild-motd-form`.
- **Vista previa:** escenas `shop`, `dialog18`, `itemmenu`, `tooltip` y `guild` en
  `make ui-preview` (`src/preview/fixtures.ts`).
- **E2E:** `useAt` (Ctrl+click derecho) en `e2e/game.spec.ts` para usar algo del mapa; la
  mochila y el fogón pasan por el menú, el pico y las mochilas del intercambio por el doble
  click. Screenshots nuevos: `09a-item-menu`, `09b-item-tooltip` y `14b-shop-sell`.

## Notas de lo que quedaba de A3, A4 y A5 (rama `feat/ui-windows-2`)
- **Tres clases de ventana, un solo estado** (`ui/windows.ts`, puro y con tests): las de la
  botonera (`WINDOW_IDS`), las del servidor (`SERVER_WINDOWS`: `dialog`, `shop`,
  `crafting`, `market`, `house`, `trade`) y una por contenedor abierto
  (`container-<item>`, `-2`, `-3`… si hay varios del mismo item: `containerKeys` le deja
  su clave mientras sigue abierto, así un segundo contenedor no toma el lugar del primero).
  Los restos de cualquier familia y el cuerpo de un jugador (contenedores `fixed`, que no
  se levantan) comparten `container-remains` (`REMAINS_PLACE`): se abren donde el jugador
  dejó los últimos y ocupan uno o dos de los `MAX_CONTAINER_PLACES`, no uno por familia.
  Las dos últimas viven en `WindowsState.others`; `placeOf(s, id)` da el lugar de
  cualquiera. El servidor las abre y las cierra: `GameView` calcula cuáles muestra
  (`serverWindows`, con la precedencia de antes: la tienda solo con su diálogo, el crafteo
  y el mercado esperan al diálogo, la casa al diálogo y al mercado) y las sigue con
  `syncWindows` en un `useLayoutEffect` (se ven en el mismo frame). Cerrar una (×, Escape
  si es la flotante de arriba) se lo pide al servidor (`serverClose`: `closeDialog`,
  `closeStation`, `marketClose`, `houseClose`, `tradeCancel`, `closeContainer`); la tienda
  no tiene × (se cierra con su diálogo). `rpg.windows` pasa a `v: 2` con `others` (sin
  `open`: el servidor las vuelve a abrir); una `v: 1` se sigue leyendo. Se recuerdan hasta
  `MAX_CONTAINER_PLACES` contenedores (24), los que cambiaron último: `withPlace` deja al
  final de `others` el contenedor que cambia, y `saveWindows` y `loadWindows` se quedan
  con los últimos. "Restablecer ventanas" (`resetWindows`) deja abiertas
  las del servidor que lo estaban, en su lugar de fábrica.
- **Dónde salen la primera vez** (`windows.css`): desde la pantalla completa, los lugares de
  "Notas de la pantalla completa" (los contenedores bajo el inventario, arriba a la
  derecha; diálogo, crafteo, mercado y casa abajo al centro sobre la barra, con la tienda a
  la izquierda del diálogo, `.game-body[data-shop]`, `--shop-w`; el intercambio arriba al
  centro). Movidas, guardan su lugar. Desde el lote 10 ese lugar mira las ventanas
  abiertas ("Lugares de fábrica que miran las ventanas abiertas", abajo).
- **Componentes `framed`:** `DialogView`/`ShopView`, `CraftingWindow`, `MarketWindow`,
  `HouseWindow`, `TradeWindow` y `ContainerView` (`ui/Inventory.tsx`) toman `framed`: sin
  su encabezado (la barra del `GameWindow` lo nombra y lo cierra) y **sin su `data-testid`,
  que pasa al marco**: `dialog`, `shop`, `crafting`, `market`, `house`, `trade` siguen
  siendo los mismos test ids, y el marco tiene el título como `h2` (`dialog` →
  `getByRole("heading")` da el nombre del NPC; `house-name` es el `titleTestid` del título)
  y los mismos nombres del botón cerrar de antes (`closeLabel`). Un contenedor es
  `window-container-<item>` con el `[data-testid=container][data-container-item=…]` adentro
  (envuelto en `.inventory.container-window` para heredar los slots). En tablets y
  teléfonos todo sigue como antes: hojas sobre el mapa y los contenedores bajo el equipo
  (`InventoryPanel` con `containers`).
- **Mover y cambiar el tamaño** (`GameWindow`, `useWindows` de `GameView` y
  `ui/window-dom.ts`; desde la pantalla completa nada se acopla y hay imán): la barra
  arrastra (`dragWindow`); las cuatro esquinas cambian el tamaño (desde `feat/window-resize`,
  ver "Cambiar el tamaño desde las cuatro esquinas"). El botón ✥ y su teclado se quitaron
  (decisión del dueño del 2026-11-23). La ayuda (H) lo explica (`client.help.windows`).
- **Escala de la interfaz y tamaño del texto** (UI-3, `state/ui-prefs.ts`,
  `ui/InterfaceOptions.tsx`, Opciones → Interfaz y el menú ☰ del teléfono): `rpg.ui-scale`
  (`UI_SCALES`, 80 % a 150 %) es el `zoom` CSS de la barra de abajo (con la hotbar
  adentro, que mide sus slots en sus propios px: `cssZoom` de `ui/Hotbar.tsx`) y de las
  ventanas flotantes (`--ui-zoom` en `<html>`); `rpg.text-scale` (`TEXT_SCALES`, 90 % a
  130 %) es el tamaño de letra de la raíz (`--ui-text-scale`), así todo lo que está en
  `rem` crece. La escala agranda la barra (`--bar-px`) y el mapa se mide sobre ella. Los
  lugares y tamaños de `rpg.windows` son px de pantalla: `GameWindow` los divide por la
  escala (`zoom`, `placeStyle` de `ui/window-dom.ts`).
- **Sacudida de cámara y destello de la hotbar** (UI-9): `WorldState.heavyHitAt` se marca
  cuando un `PlayerStats` baja la vida un 10 % del máximo o más (`render/shake.ts`
  `heavyHit`); `game-canvas.ts` corre la cámara `shakeOffset` (2 px, 120 ms, un patrón fijo
  que se apaga, en px enteros del dispositivo) si `GameOptions.cameraShake()` (Opciones,
  `rpg.shake`, encendida por defecto) y no hay movimiento reducido. Usar un hechizo de la
  hotbar (tecla o click) publica `GameUi.cast` y su slot pinta un `.flash` de 150 ms
  (`flashes` en `ui/Hotbar.tsx`); con movimiento reducido no se dibuja.
- **Texto del NPC letra por letra** (UI-8): `DialogBox` cuenta el tiempo
  (`typedLength`, 90 caracteres/s, `state/dialog.ts`) y `DialogView` recibe `typed`: lo que
  falta va en `.npc-rest` invisible (la caja no crece mientras aparece) y el texto entero
  en un `.visually-hidden` para lectores de pantalla y para los E2E (`toContainText` sigue
  andando). Un click en el texto o Espacio (si el foco no está en un botón) lo completa;
  con movimiento reducido sale entero. El retrato respira (`npc-idle`, 3,2 s, 1 px).
- **Items de misión:** `ItemDef.quest` (`quest: true` en `data/items`, docs/06): el nombre
  en `--ui-item-quest` en la ficha y el menú, la marca `client.card.mark.quest` y un anillo
  dorado en la celda (`.item[data-quest]`). Los demás nombres pasaron a `--ui-text` (UI-6).
- **Slots vacíos:** `emptySlotStyle` (`ui/Inventory.tsx`) pone el sprite `ui/slots/<slot>`
  del atlas (spritegen, `kind: ui`, `UI_SLOT_BOX`) como `--slot-icon` del slot; el CSS lo
  dibuja al 30 % detrás (`.doll .slot::before`; desde `feat/equipment-d2`, a la escala de
  su slot, `--slot-scale`). Sin atlas, no hay nada.
- **Ficha sobre el mapa:** `game-canvas.ts` avisa `restTile` cuando el mouse queda 350 ms
  quieto en una casilla (y `undefined` al salir, apretar o usar la rueda); `Game.restTile`
  elige `menuItem` si es algo que se lleva (`groundCard` de `state/item-card.ts`: ni
  suelos, ni muros, ni decoración, ni estaciones) y publica `GameUi.groundTip`;
  `ItemTooltip` lo muestra debajo del texto del cursor (`data-ground`). Desde
  `feat/equipment-d2`, sin espera y arriba de la casilla (ver abajo).
- **Mayús+arrastrar** (`Game.pressItem`, y en el canvas un Mayús+click es una "pulsación de
  mirar" que mira al soltar y arrastra si se mueve): con una pila (`splittable`) suelta
  `GameUi.split` y `ui/SplitPrompt.tsx` pregunta cuántas (la mitad para empezar,
  `halfStack`; `splitCount` de `state/items.ts`, el mismo de "Mover parte…": de 1 a la pila
  menos una). Enter o "Mover" manda `MoveItem` con esa cantidad; Escape o "Cancelar" no
  mueve nada. Mayús+click sigue mirando.
- **Vista previa:** escenas `server`, `groundtip` y `scale` (`?ui=1.25&text=1.15`) en
  `make ui-preview`; la base tiene un item de misión en la mochila y slots vacíos (desde
  `feat/equipment-d2` la mochila es `ui.backpack`, abajo de la figura).
- **E2E:** `e2e/game.spec.ts` busca la mochila fuera de la ventana del inventario
  (`page.locator('[data-container-item="backpack"]')`, `window-container-backpack`).
  Desde `feat/equipment-d2` la mochila equipada va dentro del inventario (abajo).

## Notas del equipo y el tooltip al estilo Diablo II (rama `feat/equipment-d2`)
Los dos pedidos del dueño del 2026-11-18 (docs/17 UI-5 y UI-6, "Hecho: el equipo y el
tooltip al estilo Diablo II"). Solo la idea de esos paneles: arte, nombres y textos propios.
- **La figura** (`state/equipment.ts`, puro y con tests; `ui/Inventory.tsx`): `DOLL` da el
  lugar (columna y fila desde 1) y el tamaño en celdas de cada slot en una grilla de
  `DOLL_COLS` x `DOLL_ROWS` (8x9). `InventoryPanel` mide el ancho que tiene (`.doll-box`,
  `ResizeObserver`, en un `useLayoutEffect`: el primer cuadro ya sale a su tamaño; lo que el
  observador ve después se aplica en el cuadro siguiente, `deferredMeasure` de
  `ui/next-frame.ts`: dentro de su entrega, la figura agrandada alargaba la caja y WebKit le
  daba a la página un error "ResizeObserver loop" al mostrar la pestaña en un teléfono) y
  `dollCell` elige la celda: el mayor número par de px enteros que entra, entre
  `DOLL_MIN_CELL` (24) y `DOLL_MAX_CELL` (44), con `DOLL_GAP` (2) entre celdas; la grilla
  se centra con un margen entero. Con celda y separación pares, todo ícono cae en píxeles
  enteros. `slotBox` da la caja de un slot e `iconScale` la escala entera de su ícono (la
  mayor que entra dejando `SLOT_PAD`, nunca menos de 1x): `ItemCell` dibuja el item como
  una caja de ese tamaño con el sprite adentro (`.item > .sprite`, `transform: scale(n)`
  desde la esquina, `data-scale`). Las celdas de contenedor no pasan caja: 1x. Una pestaña
  oculta mide 0: la celda mínima, hasta que se muestra. Un ícono de 32 px en un anillo o
  cuello más chico sobresale de su borde (`overflow: visible`), píxel por píxel.
- **Brillo y rojo:** `GameUi.dragging` (el item que se arrastra: `Game.startDrag` lo
  publica y lo borra al soltar, o con un `pointercancel`, sin mover nada) o `GameUi.picked`; `.doll[data-holding]` y cada slot con
  `data-accepts="yes|no|store"` (`slotDrop`; `slotAccepts`: `wornIn` es el `slotFor` del
  servidor, con `equipSlot` de `state/item-card.ts` más el contenedor en la espalda, y nada
  para lo `fixed`; el slot de la mochila guarda lo demás, `store`, sin brillo ni rojo: el
  servidor lo mete en la mochila o, sin ella, en los bolsillos). El CSS ilumina los `yes` y tiñe de rojo un `no` con `:hover` (un arrastre no
  captura el puntero, así que el `:hover` sigue al mouse), solo con `@media (hover: hover)`:
  una pantalla táctil deja el `:hover` donde estuvo el último dedo. Nivel, vocación y manos libres
  los sigue diciendo el servidor al soltar.
- **La mochila equipada** (`state/backpack.ts`, puro y con tests): `WorldState.backpack`
  (`EquippedBackpack`) sabe qué contenedor abierto es el de la espalda: un uso de algo en
  el slot `BACKPACK` (`Game.sendUse`, de `useItem` y de `openBackpack`) llama `used`, y el
  `ContainerOpen` de ese item, sin padre y dentro de `BACKPACK_ANSWER_MS` (3 s), es la
  mochila (`opened`). El servidor alterna esa misma mochila: si su ventana ya estaba
  abierta, el uso la cierra, y el `ContainerClose` de una ventana de ese item sin padre
  (`closed`, con la ventana como era) termina la espera. `equipped` (cada `Inventory`): si
  la mochila deja el slot, su ventana pasa a ser una más y **no vuelve sola** abajo de la
  figura cuando se equipa una mochila del mismo tipo: el cliente no sabe si es la misma
  (revisión final del lote 9: con otra igual, el botín arrastrado abajo iba a la del
  suelo). Con la misma, un uso del slot cierra su ventana y el siguiente la abre abajo; con
  otra, el primer uso ya la abre abajo. El servidor nunca cambia un slot ocupado, así que
  otra mochila llega siempre después de un `Inventory` con el slot vacío. `Game.publish` separa
  (`split`): `GameUi.containers` son solo los que tienen ventana propia (así `GameView`
  no le da una a la mochila) y `GameUi.backpack` es la de la espalda, que `InventoryPanel`
  dibuja bajo la figura con `ContainerView docked` (`data-docked`, el mismo
  `data-testid="container"` y `data-container-item`, con su encabezado y su ×). El
  intercambio ofrece también lo de `ui.backpack`. `__rpgClient.containers()` (E2E) sigue
  dando todos.
- **Se abre sola** (`autoOpen`, puro y con tests; un `useEffect` de `InventoryPanel`): con
  un contenedor en el slot, sin mochila abajo, sin tutorial y sin otra ventana de ese item
  abierta, llama `Game.openBackpack` (un `UseItem` del slot, como el doble click, pero sin
  pasar por `useItem`: no descarta la runa o la herramienta que el jugador apuntaba). Una vez
  por mochila mientras el inventario está montado (`done`): cerrarla con su × la deja
  cerrada hasta que el inventario se vuelva a abrir o se equipe otra. Mientras un uso del
  slot espera su respuesta (`EquippedBackpack.waiting`, `Game.backpackWaiting`) no manda
  otro: I dos veces antes del `ContainerOpen` mandaba dos usos y el servidor, que alterna,
  la dejaba cerrada. Durante el tutorial
  no (su paso `open_backpack` lo enseña; el `TutorialStep` llega en el mismo batch que el
  `Inventory` al entrar). En teléfonos el panel está montado aunque su pestaña no se vea:
  se abre al entrar.
- **Capacidad:** `Capacity` (`data-testid="capacity"` en el bloque) con `.cap-bar`
  (`capacityLoad`: la fracción cargada; `heavy` desde `HEAVY_LOAD`, 85 %, `full` sin lugar)
  y el texto de siempre.
- **El tooltip** (`ui/ItemTooltip.tsx`): sin espera (`pointerover` muestra en el acto),
  `TOOLTIP_GRACE_MS` (80) al salir de un item antes de irse, así el siguiente lo toma sin
  parpadeo; tras una presión vuelve con el siguiente `pointermove` sin botones; nada
  mientras `GameUi.dragging` o `body.dragging-item`. Después de que una ventana se abre,
  cierra o pliega (`windows`: `shownKey` en escritorio), nada hasta el primer
  `pointermove` que mueve el mouse (`TipGate`, puro y con tests: el `pointerover` que el
  navegador manda cuando una ventana aparece bajo un mouse quieto no cuenta; la tienda
  sacaba la ficha sobre sus filtros); el foco del teclado lo abre igual. Se dibuja oculto, un
  `useLayoutEffect` mide su tamaño real (solo cuando cambia `placeKey`: el item, su
  cantidad, su caja y quién mira; no en cada publish del `Game`) y `tipPlacement` (puro y con tests) lo pone
  centrado arriba del item (`TIP_GAP` 6, `TIP_MARGIN` 6), abajo si no entra, y si no entra
  en ninguno, del lado con más lugar cortado a ese lugar (`maxHeight`): nunca sobre el
  item, así nunca bajo el cursor. `data-side` dice dónde quedó. Sin animación de entrada.
- **La ficha compacta** (`TipCard` de `ui/ItemCard.tsx`, sin hooks; `ItemCard` con `tip`):
  `.item-card.tip`, cada línea centrada y sin ícono; `nameClass` (`card-name`, `quest` o
  `coin`: `ItemCardView.currency` para `kind: currency`); stats con
  `client.card.stat_line` ("{stat}: {value}"); requisitos, efectos, marcas y la
  descripción al final. Colores: tokens `--ui-item-plain`, `--ui-item-coin`,
  `--ui-item-stat` y `--ui-item-effect`; los requisitos sin cumplir en `--ui-danger`. El
  menú y la tienda siguen con la ficha entera.
- **Sobre el mapa:** `game-canvas.ts` llama `restTile` en el acto cada vez que cambia la
  casilla bajo el mouse (ya no espera 350 ms quieto); `Game.restTile` suma `tile`, la
  casilla en coordenadas de página (`tileToClient` de ella y de la siguiente), y no publica
  nada mientras se arrastra. Un cambio solo de la ficha no arma de nuevo el `GameUi`
  (`publishTip`: el último publicado, `shown`, con el `groundTip` nuevo; sin la lista de
  batalla ni copias del log y el chat por cada casilla que cruza el mouse). `ItemTooltip` usa `groundAnchor`: la casilla, estirada hacia
  abajo hasta pasar el texto del cursor (`GROUND_HINT_PX`), así colocada abajo no lo tapa.
- **Para las ventanas flotantes** (rama `feat/hud-fullscreen`): nada del interior depende
  del dock. La figura toma el ancho de la ventana: 2x en los slots grandes desde unos 286
  px de cuerpo (una ventana de unos 19 rem); a 16 rem los íconos van a 1x.
- **Vista previa:** escenas `inventory` (una espada arrastrada sobre el equipo: la mano
  derecha brilla y la izquierda, bajo el puntero, se tiñe de rojo), `inventoryfloat` (el
  inventario flotando, de 420 px), `tooltip` (la espada de la mano derecha) y
  `tooltipcoin` (las monedas de la mochila); en teléfono y tablet abren la pestaña del
  inventario. `withHeld` y `ui.backpack` en `src/preview/fixtures.ts`. Desde
  `feat/item-icons` la base tiene los diez slots llenos (la banda 3 del catálogo y la
  espada de hierro) y la mochila lleva piezas de las bandas siguientes, y la tienda (`shop`)
  muestra 24 piezas de equipo antes de 6 de las otras categorías: así esas escenas muestran
  los íconos del motor de sprites (docs/17 "Íconos de items").
- **E2E:** el primer test de `e2e/game.spec.ts` encuentra la mochila abierta bajo la figura
  (`[data-container-item="backpack"][data-docked]` dentro de `inventory`, 24 celdas, sin
  `window-container-backpack`), la cierra con su ×, la abre de nuevo con "Abrir" del menú
  (otra vez bajo la figura), pasa el mouse por ella (la ficha compacta, sin taparla) y,
  tirada al suelo, la encuentra en `window-container-backpack`; vuelta al slot, sigue en
  su ventana; un doble click en el slot la cierra y otro la abre abajo. El del intercambio ya no le hace doble click (la cerraría): espera que esté
  abierta. Un spec nuevo que abra la mochila equipada con un doble click o "Abrir" la
  cierra si ya estaba abierta.

## Notas de los bolsillos (docs/02 "Bolsillos", lote 13, rama `feat/pockets`)
- `WorldState.pockets` (`PocketsState` de `state/pockets.ts`, puro y con tests:
  `pocketCells`, `pocketRef`, `pocketOffers`) sale de cada `Inventory` (`pockets`,
  `pocket_slots`); `GameUi.pockets`. Un bolsillo es `ItemLoc` `{ kind: "pocket", index }`
  (`locationInit` → `ItemLocation.pocket`, `locKey`, `sameLoc` de `input/actions.ts` y de
  `state/forge.ts`). No es una ventana de contenedor: nunca tiene `container_id`.
- `PocketsRow` (`ui/Inventory.tsx`, sin hooks, `ui/Pockets.test.ts`): la fila
  "Bolsillos" bajo la figura y arriba de la mochila; cada celda es `[data-drop="pocket"]`
  con `data-index` (`Game.dropTarget`) y su item tiene el menú, la ficha, el arrastre y el
  doble click de cualquier otro (`ItemCell`). El intercambio ofrece la mochila, después
  los bolsillos y después las demás ventanas (`offerable` de `ui/Trade.tsx`); la forja,
  el equipo y después los bolsillos (`forgeCandidates`). El mercado ya los cuenta en el
  servidor (`owned_mods`).
- Test ids: `pockets`, `pocket-<n>`. Hook E2E `__rpgClient.pockets()` (`capacity` e
  `items`). Vista previa: escena `pockets` de `make ui-preview` (sin mochila, como después
  de una muerte, con la ficha del brebaje del bolsillo); la base lleva dos items en los
  bolsillos. E2E: "die to a wolf" despierta sin mochila y con los cuatro bolsillos vacíos
  (`14-respawn`).

## Notas de la pantalla completa (docs/17 UI-4 y UI-5, rama `feat/hud-fullscreen`)
El dueño (2026-11-18): el juego a pantalla completa, como Diablo 2 o Ragnarok Online, con
los menús flotando donde el jugador los acomode; abajo una barra gótica (orbes de vida y
maná en las esquinas; en el medio la experiencia, la hotbar y la botonera), lo único fijo; y
ventanas libres con imán. Solo escritorio: tablets y teléfonos siguen con pestañas y cajón.
- **El mapa** (`.viewport`) ocupa `.game-body` entero; su `padding-bottom` es la barra
  (`--bar-px` = `--bar-h` de 88 px por `--ui-zoom`), así el canvas se mide sobre la barra
  (la caja de contenido, como el pad de T5.6) y `--map-cover: 1` le dice a
  `render/game-canvas.ts` (y a la vista previa) que cubra esa caja (`zoomRange` con
  `cover`, "Zoom del mapa"). Sin marco ni viñeta alrededor del canvas. Se fueron
  `--dock-w`, `aside.side` en escritorio, `--map-reserve-bottom` y `mapLift`.
  `.game-body` recorta (`overflow: clip`): los pináculos de los hombros del orbe de maná
  sobresalen 7 px del borde derecho y la página medía 1287 px a 1280 (un `scrollIntoView`
  corría el juego de lado; `mobile.spec` exige que la página mida justo la pantalla).
- **La barra** (`ui/HudBar.tsx`, `section.hud-bar`, test id `hud-bar`, `aria-label`
  `client.hud.bar`): `position: absolute` abajo, `zoom: var(--ui-zoom)` (la escala de la
  interfaz la agranda como a las ventanas), grilla de tres columnas: orbe de vida
  (`--orb-col`, 112 px), el medio (`.bar-centre`: la experiencia arriba y debajo `.bar-row`,
  un pozo con la hotbar y la botonera) y orbe de maná. Los engastes (`.orb-socket`, 106 px)
  salen 18 px por encima de la barra; la bandeja de estados (`.status-box`, `--tray-w` 132
  px; antes la placa `.vitals`) va sobre el orbe de vida. Piedra en sillares (un SVG en línea de juntas), una banda de hierro con
  remaches arriba, pilares de hierro con filo dorado a los lados del medio y, al centro, la
  placa del nombre con un pináculo en cada hombro (`.nameplate`, desde el lote 13; antes
  una cresta de pináculos). La hotbar mide sus slots en sus propios px aunque la barra tenga
  `zoom` (`cssZoom` de `ui/Hotbar.tsx`: `getBoundingClientRect` da px de pantalla y
  `clientWidth` y los estilos computados los propios); en la barra no deja margen
  (`margin={0}`) y pagina con sus flechas cuando no entran los 12 (a 960x700, 6).
- **Ornamentos** (`ui/ornaments.ts`, puro y con tests): pixel art propio escrito como texto,
  como los íconos (esquina, pináculo, remache), pasado a SVG `data:` y puesto como
  variables `--orn-*` en el `style` de `.game` (CSSOM: la CSP de escritorio no deja
  `<style>` en línea, sí imágenes `data:`). Las esquinas doradas con un granate van en
  `.gwin::after`; los remaches en la banda de la barra y en los engastes; los pináculos en
  los hombros de cada engaste y de la placa del nombre.
- **Ventanas** (`ui/windows.ts`, versión 3 de `rpg.windows`): sin `dock` ni `order`; todas
  flotan en `.win-layer` (la pantalla sobre la barra: `%` de su CSS es de esa área).
  `placeOf` da `x`/`y` en px de pantalla desde su esquina; sin `x`/`y` la ventana está en
  su lugar de fábrica (`windows.css`, `:not([data-placed])`): batalla arriba a la izquierda
  (hasta el 50 % del alto), grupo a su derecha, habilidades debajo (desde el 50 %);
  inventario arriba a la derecha, gremio y apariencia a su izquierda, los contenedores debajo
  del inventario (`top: var(--containers-top)`: el alto del inventario en sus propios px,
  que `GameView` mide con un `ResizeObserver` sobre su ventana, `boxRef` de `GameWindow`,
  y pone en `.win-layer`; `containersTop` de `ui/windows.ts` da 0 con el inventario
  cerrado o movido, y la columna empieza arriba. Con la figura y la mochila de
  `feat/equipment-d2` mide unos 500 px: el `15rem` de antes abría cada contenedor sobre la
  mochila. El n-ésimo va un paso más abajo y a la izquierda: `--nth`, que pone
  `GameWindow`; nunca más abajo que `100% - 2rem`, así su barra de título se ve aunque haya
  muchos abiertos en una pantalla baja); el chat abajo a la izquierda pasando la placa; opciones y ayuda al
  medio; el intercambio arriba al centro; diálogo, crafteo, mercado y casa abajo al centro
  sobre la barra, y la tienda a la izquierda del diálogo, los dos sin pisar la columna del
  inventario (`--pair-left`). Movida, `GameWindow` pone `left`/`top` y un `max-height` de
  `calc(100% - top)`: nunca baja de la barra (`placeStyle` de `ui/window-dom.ts`).
  - **Arrastrar y cambiar el tamaño** (`dragWindow`, `resizeDrag` de `ui/window-dom.ts`,
    con tests sin DOM): mientras dura, el elemento sigue al puntero con estilos en línea;
    al soltar, `settleStyle` le escribe los largos de su lugar nuevo (los mismos de
    `placeStyle`) en vez de borrarlos: Preact solo escribe las propiedades de `style` que
    cambiaron desde su render anterior, y una que el arrastre pisó y el estado conservó (la
    `x` de una ventana deslizada por un borde, todo menos el tamaño en un resize, o soltarla
    donde estaba) quedaba vacía y la ventana saltaba a la esquina de arriba a la izquierda.
    Los tests aplican la regla de Preact (`preact/src/diff/props.js`) a lo que dibuja
    `GameWindow`.
  - **Pila y orden en la página:** la pila (`openWindows`) es solo el `z-index` de cada una
    (20 + su lugar); en la página van siempre en el mismo orden (`pageOrder`: las de la
    botonera, las del servidor y los contenedores por clave), así traer una al frente no
    mueve su nodo (movido, repetía su animación de entrada y perdía el foco y el scroll de
    adentro). Tab las recorre en ese orden fijo.
  - **Qué tapa a qué:** `.win-layer` tiene `z-index: 20` (su propio contexto de
    apilamiento): sobre la barra (15), los avisos, el tutorial y la subida de nivel; bajo
    el chequeo de presencia (21) y la pantalla de muerte (22), que ninguna ventana puede
    tapar (un chequeo escondido vence y cuenta como fallado). Las invitaciones de grupo y
    de gremio (`.invitations`, que también vencen) van a 21: el chat en su lugar de
    fábrica (x 144–528) llega debajo de ellas, centradas, a 1280 y 960 px; las del gremio
    con su propia regla de escritorio, 3,5rem más arriba (la de `.invitations` les ganaba
    por especificidad a `.guild-invitations` y las dos quedaban en el mismo lugar).
    `ui/windows-css.test.ts` lo comprueba leyendo `windows.css`.
  - **Imán** (`snapPlace`, puro): al arrastrar (y en los bordes que mueve una esquina), cada eje va al
    borde más cercano a menos de `SNAP_PX` (10): los de la pantalla, el techo de la barra y
    los de las otras ventanas, de lado (la izquierda de una con la derecha de la otra) o
    alineados (izquierda con izquierda), solo si las dos están cerca en el otro eje. Después
    `clampPlace` la deja entera dentro del área (antes bastaba que se viera la barra).
  - **Al achicar la pantalla** (o subir la escala), un `ResizeObserver` sobre `.win-layer`
    mete adentro las ventanas movidas que quedaron afuera (`pullInside` de `GameView` con
    `outsiders` de `ui/window-dom.ts`, con tests sobre elementos falsos; `placeWindow`, sin
    cambiar la pila); lo mismo al cargar un lugar guardado en una pantalla más grande. Se
    engancha por el ref (`watchedRef` de `ui/window-dom.ts`, `ref={win.layer.set}`), no en
    un efecto del primer render: la capa solo existe en el layout de escritorio, así que un
    juego que arranca angosto la monta tarde y cada vuelta de tablet a escritorio monta una
    nueva. El observador solo ve cambiar el área: una ventana cerrada entonces conservaba
    su `x` (las habilidades dejadas en x 1600 a 1920 px se abrían invisibles a 1280), así
    que la misma revisión corre en un `useLayoutEffect` cada vez que cambian las ventanas
    que se ven (`shownKey` de `ui/windows.ts`: abrir, cerrar, plegar o desplegar; traer al
    frente no), antes de pintarla. Cada ventana cuenta con el alto de `keptHeight`: el que
    muestra ahora si es al menos `MIN_SIZE.height` (72; aplastada por su `max-height` se
    queda donde está, con el cuerpo desplazable, como una lista de batalla que creció) y si
    no, su alto propio (`naturalHeight`: se levanta el `max-height` para medir y se vuelve
    a poner), así sube hasta verse entera: medida aplastada, una ventana con el techo por
    debajo del área nueva medía unos px y se quedaba con la barra de título sobre la barra
    gótica. Se mide sin la escala de la animación de entrada (`gwin-in` arranca en 0,96:
    `transformScale` del `transform` computado).
  - **Migración:** una `rpg.windows` v1 o v2 se sigue leyendo; lo que estaba acoplado vuelve a
    su lugar de fábrica (pierde `x`, `y`, `w` y `h`, que eran del dock); lo que flotaba
    conserva todo. Se guarda como v3, con los últimos `MAX_CONTAINER_PLACES` (24)
    contenedores que cambiaron, como en el lote 8 (`lastContainers`).
  - **El chat** es `chat` en `WINDOW_IDS` (sin botón ni tecla), en `FIXED_WINDOWS`: no se
    cierra (sin ×; `closeWindow` no hace nada) y Escape lo salta; se pliega y se mueve como
    las demás. Sus pestañas van en la barra de título (`GameWindow` `barExtra`, con el título
    solo para lectores de pantalla: `hideTitle`, y sin ícono, para que entren las seis).
    Translúcido (`::before` con la piedra a `--chat-opacity`, 50 % salvo que el jugador
    elija otra en Opciones → Interfaz) y casi opaco con el mouse encima o escribiendo
    (`:hover`, `:focus-within`; solo cambia `opacity`, UI-9).
  - **Pestañas del chat** (docs/17 UI-10, lote 10; `state/chat.ts`, puro y con tests):
    `CHAT_TABS` = `chat` (Todo: su id es el de antes), `local` (decir, gritar, susurrar y
    NPCs), `party`, `guild`, `global` y `log` (el registro del sistema). `chatFilter` da las
    líneas de una pestaña (un `BROADCAST` sale en todas) y `ChatPanel` (`tab`) dibuja solo
    esas; la pestaña elegida fija el canal del selector (`tabChannel`: Local → decir; Todo
    y el log no lo cambian). Punto de no leído (`data-unread`, `unreadTabs`): una pestaña
    con líneas que no se vieron en ninguna (las de la pestaña abierta se marcan vistas al
    dibujarse, un `WeakSet` de `ChatLine`: el `Game` publica los mismos objetos) y que no
    dijo el propio jugador; el del log, como antes, por la hora de su último mensaje. Con
    el chat plegado no se ve ninguna pestaña (`viewedTab` da `undefined`): nada se marca
    visto (`markSeen`), la abierta también lleva su punto y todos los avisos flotan. Las
    flechas recorren las pestañas (`nextTab`); con el texto al 130 % no entran en la barra
    y la rueda las corre de lado (`wheelAlong`: un giro vertical, en px o en líneas de
    `WHEEL_LINE_PX`). Opacidad: `rpg.chat-opacity` (30–100,
    pasos de 5, `CHAT_OPACITY`; `loadChatOpacity`/`saveChatOpacity` con try/catch,
    `applyChatOpacity` pone `--chat-opacity` en `<html>`), deslizador `chat-opacity` en
    `InterfaceOptions`.
  - **Escape** cierra la de arriba de `z` (la última abierta, movida o tocada) que se pueda
    cerrar; la batalla y el inventario del principio no están en `z` hasta que se tocan,
    así Escape en una pantalla recién abierta sigue abriendo Opciones. El `Game` cierra
    antes, con su propio Escape, el diálogo y la estación.
  - **Abiertas juntas** (`syncWindows`): los contenedores primero, así un diálogo o una
    estación que abre con ellos queda encima.
- **Sobre el mapa**, encima de la barra: los avisos (`.notices`), las invitaciones (sobre
  las ventanas, las del gremio más arriba), el pad y los botones de zoom de una pantalla
  táctil; el tutorial se corre a la izquierda de la
  columna del inventario y la viñeta roja de poca vida termina en la barra.
- **Vista previa:** escenas `magnet` (ventanas borde con borde), `migrated` (un
  `rpg.windows` v1 con el dock) y `chat` (el chat bajo el mouse) en `make ui-preview`.
- **E2E:** los screenshots de `.side` (`16-chat`, `18-gm-announce`, `25-party-panel`,
  `37-report-form`, `51-pvp-battle-list`) son ahora de su ventana; `mobile.spec.ts` comprueba
  a 1280x800 que el canvas va de (0, 0) al techo de la barra y que el chat queda sobre ella
  (`mobile-desktop-1280-full-screen`). A 1280x800 el inventario flota sobre la 6.ª columna al
  este del jugador y el chat sobre la 2.ª a la 7.ª al oeste y la 3.ª a la 5.ª al sur: los
  caminos por clicks de `game.spec.ts` saltan 5 columnas como mucho, `mapPoint` da el punto
  de una casilla solo si lo que hay ahí es el canvas, y `clickTile` de `sandbox.spec.ts`
  falla si una ventana tapa la casilla. Que el cuerpo de la tienda no se desplace se mide
  en `.gwin-body` (el marco no es un contenedor de scroll y sus esquinas góticas sobresalen
  5 px).

## Cambiar el tamaño desde las cuatro esquinas (docs/17 UI-5, rama `feat/window-resize`)
Pedido del dueño del 2026-11-23: como en Ragnarok Online. Solo escritorio.
- **Las esquinas** (`GameWindow`): cuatro `span.gwin-resize[data-corner=nw|ne|sw|se]` de
  12 px, 5 px fuera del marco, sobre los adornos de `.gwin::after`; no hay en una ventana
  plegada. Los bordes no cambian el tamaño (decisión del dueño). Cursor por esquina
  (`cornerCursor`: `nwse-resize` en nw y se, `nesw-resize` en ne y sw). Con el puntero
  encima, un brillo dorado en su `::before` (solo `opacity`); mientras dura, la ventana
  lleva `data-resizing="<esquina>"` y esa esquina sigue encendida, y `body` lleva
  `resizing-window` (y `resizing-nesw` en ne y sw: el cursor en toda la página).
- **Geometría** (`resizeFrom` de `ui/windows.ts`, pura y con tests): los dos bordes de la
  esquina siguen al puntero (deltas redondeados), la esquina contraria queda; imán en los
  bordes que se mueven (`SNAP_PX`: pantalla, techo de la barra y las otras ventanas, con
  la misma regla de "cerca en el otro eje" de `snapPlace`; `nearest` es de los dos);
  después dentro del área y nunca bajo `MIN_SIZE` (cede el borde que se mueve; si la
  esquina fija está más cerca del borde del área que eso, `clampPlace` corre la caja).
  `clampSize` ya no existe.
- **DOM** (`resizeDrag(env, el, corner, press, area, others, place, done)` de
  `ui/window-dom.ts`): mide la caja de la ventana una vez, escribe `left`, `top`, `width` y
  `height` en sus propios px (`/ --ui-zoom`) en cada `pointermove`, y al soltar
  `settleStyle` y `done(x, y, w, h)` (GameView: `placeWindow` + `resizeWindow`). Las otras
  ventanas se miden una vez al empezar (`otherRects`, como al arrastrar).
- **Qué ventanas:** todas las flotantes, el chat también; se revisó cada una y ninguna
  tiene contenido de tamaño fijo (la figura del equipo escala, el resto se desplaza
  adentro). Tablets y teléfonos no tienen `GameWindow`.
- **Se quitó el ✥** (`.gwin-move`, `window-move-<id>`, `windowNudge`, `KEY_STEP`,
  `NudgeContext`, el ícono `move` y las claves `client.window.move` y
  `client.window.move_hint`): las ventanas ya no se mueven con el teclado.
- **Tests:** `ui/windows.test.ts` ("resizing from the corners"), `ui/window-dom.test.ts`
  ("resizing a window by a corner", con la regla de `style` de Preact) y
  `ui/Toolbar.test.ts`. E2E: el test del chat de `e2e/game.spec.ts` arrastra la esquina de
  arriba a la izquierda del chat (screenshot `16b-chat-resized-top-left`).

## Lugares de fábrica que miran las ventanas abiertas (lote 10, docs/17 UI-5)
- **La regla** (`defaultPlace` de `ui/windows.ts`, pura y con tests): una ventana que se abre
  en su lugar de fábrica (sin `x`/`y`) se mide ahí (`usual`); si tapa a otra ventana
  abierta, o, el intercambio, la casilla del jugador y las `TRADE_CLEAR_TILES` (3) al norte
  (`northOfPlayer`: ahí suele estar el compañero), prueba otros lugares en orden y toma el
  primero que no tapa nada; si no hay, el que menos tapa (área en px², `overlapArea`), si
  tapa menos que el de siempre. Solo tres clases tienen otros lugares (`movesAside`):
  - `trade`: por la fila de arriba, contra los bordes, la columna del jugador u otra
    ventana (`PLACE_GAP`, 4 px), el más cercano primero, y después los mismos lugares
    pegados (bordes que se tocan no tapan: a 1280x800 entre la batalla y la columna del
    jugador hay justo sus 352 px); nunca sobre esas casillas;
  - `dialog`, `crafting`, `market`, `house`: más bajas, con su fondo donde estaba, hasta el
    pie de lo que baja hasta ellas (`givingWay`), si les quedan al menos
    `GIVE_WAY_MIN_PX` (120): `short`, su `max-height` es su alto y el cuerpo se desplaza;
  - `skills`: al lado de la batalla o del grupo, a la izquierda de la apariencia, el gremio
    o el inventario, y al final acortadas sobre el chat.
- **El DOM** (`placeOpened` de `ui/window-dom.ts`, con tests sobre elementos falsos): mide
  las ventanas de la capa sin la escala de su animación de entrada (`unscaledIn`), deja
  afuera las que se cierran, y las que deciden primero cuentan en su lugar nuevo para las
  siguientes. Las que mira, en su lugar de siempre: `usualBox` levanta por esa medida los
  largos en línea de un lugar anterior (`left`, `top`, `right`, `bottom`, `max-height`) y
  los vuelve a poner. `useWindows` (`GameView`) lo corre en un `useLayoutEffect` cada vez
  que cambia el estado o el contexto, antes de pintar; `toLookAt` de `ui/windows.ts` (puro)
  elige cuáles: las que se abrieron desde la última vez (todas al montar o tras un cambio
  del área) y las que siguen abiertas pero cuyo lugar de siempre se movió (`placeContext`:
  para el diálogo, su id y si la ventana de la tienda está abierta; la tienda llega un
  render después del diálogo y la regla de la pareja de `windows.css` lo corre y angosta);
  esas pierden su lugar anterior. `Game.selfTile` da la casilla del jugador en la página
  (`tileToClient`).
- **Dónde vive:** `WindowsApi.auto` (un `Map` de `AutoPlace`, px de pantalla), no en
  `rpg.windows`: no es un lugar del jugador. Se olvida al cerrar o mover la ventana; si el
  área cambia de tamaño (el `ResizeObserver` de la capa ve otro tamaño), se vacía y todas
  las abiertas se miran de nuevo en su lugar de siempre. `GameWindow` lo recibe en `auto`
  y `placeStyle` lo escribe como `left`/`top` con `right`/`bottom` en `auto` (el lugar de
  siempre puede colgar de la derecha o de abajo) y `data-auto`; arrastrarla la deja en
  `x`/`y` como siempre.
- **El tutorial** se oculta mientras la Ayuda, el gremio o la apariencia están abiertos en
  su lugar de fábrica (`tutorialCovered`; ver "Notas de T4.2").
- **Vista previa:** escenas `allwindows` (todas las de la botonera abiertas), `trade`,
  `chattabs` (la pestaña Local elegida y líneas de otros canales que llegan después, con
  sus puntos), `tutorialhelp` y `tutorialshop` (un personaje del tutorial, con la mochila
  cerrada: el inventario corto del E2E `43-tutorial-shop-960`). El `selfTile` de la vista
  previa es el centro de la caja del mapa (`mapBox`), a la escala ajustada.
- **E2E:** sin specs nuevos (no se corrió en la rama). `[data-chat-tab]` vale `chat`,
  `local`, `party`, `guild`, `global` o `log`; `chat-opacity` es el deslizador; una ventana
  en un lugar que eligió `defaultPlace` lleva `data-auto`. A 1280x800 el intercambio de
  `52-trade-window` ya no sale arriba al centro si eso tapa al compañero de arriba.

## Notas del diario de misiones (lote 12, rama `feat/quest-engine`)
- `WorldState.quests` (de `QuestLog`, `state/quests.ts`, puro y con tests: `questLogFrom`,
  `questTabs`, `cooldownLeft`, `timeLeft`) es el diario entero que manda el servidor al
  entrar y en cada tick en que cambia una quest; `undefined` hasta entonces.
  `WorldState.clockOffset` es el reloj del servidor menos el del cliente al llegar el
  `Welcome` (`server_time`): la cuenta atrás de una tarea (`available_at`, ms Unix del
  servidor) va sobre `Date.now() + clockOffset`. `GameUi.quests` y `GameUi.clockOffset`.
- `ui/Quests.tsx`: `QuestsBody` sin hooks (`ui/Quests.test.ts` recorre su árbol, expandiendo
  `QuestItem`) y `QuestsPanel` con la pestaña abierta y un intervalo de 1 s solo mientras
  una tarea espera (`cooling`). Ventana `quests` de `WINDOW_IDS` (tecla L, `normal`, su
  lugar de fábrica a la izquierda del inventario, 6rem abajo, como el gremio y la
  apariencia; tapa el tutorial como ellos, `tutorialCovered`), ícono `journal` en la
  botonera y pestaña `quests` del panel en teléfonos.
- Test ids: `quests`, `[data-quest-tab=active|finished]`, `.quest[data-quest=<id>]`
  (`data-state` `active`, `done` o `cooling`), `quest-step`, `quest-kills`,
  `quest-cooldown`, `quest-done`, `quests-empty`; la ventana es `window-quests` y su botón
  `toolbar-quests`.
- Vista previa: escenas `quests` y `questsdone` (la pestaña de terminadas) de
  `make ui-preview`; `allwindows` la abre también.
- **Quests de hito** (docs/02 "Quests de hito"): `QuestEntryView.milestone`
  (`MilestoneView`, de `QuestLogEntry.milestone`) y el estado `open` (un hito sin empezar,
  `QUEST_LOG_STATE_OPEN`). `questTabs` da tres pestañas: `active` (sin hitos),
  `milestones` (todos los hitos, primero los sin empezar, después en curso y terminados) y
  `finished` (un hito terminado con su título, `quest-title`). `MilestoneReqs` dibuja cada
  requisito (`.quest-req[data-req=level|gear|players]`, `data-met`); las marcas son las
  del propio personaje que manda el servidor. `QuestsPanel` recibe `content` (el nombre del
  item pedido). Vista previa: escena `questsmilestones`. E2E "milestones" de
  `e2e/game.spec.ts` (screenshots `99-milestone-*`).
- E2E: "sandbox: the quest log, a lectern's book and a reward chest that gives once"
  (`e2e/sandbox.spec.ts`) siembra el capítulo 1 en 2/6 lobos y la tarea de práctica en
  espera con `psql`, abre `quests` con `openWindow` (`WindowId` de `e2e/windows.ts` incluye
  `quests`) y mira las dos pestañas; después lee el atril del templo y abre su cofre dos
  veces (screenshots `96-sandbox-quests`, `96b-sandbox-quests-finished`, `97-sandbox-book`,
  `98-sandbox-chest`).

## Notas de la bandeja de estados (lote 13, rama `feat/hud-status`)
Lo que pidió el dueño en la prueba del 2026-11-19: ver los estados del personaje junto al
chat, y el nombre y el nivel al medio, en la barra de experiencia (docs/17 "Hecho: bandeja
de estados y placa del nombre").
- **Estado puro** (`state/status.ts`, con tests): `trayEntries(condiciones, ahora,
  reducido)` da lo que se dibuja: orden fijo (`STATUS_ORDER`: lo que daña, los bloqueos y
  la zona, lo que ayuda; un id desconocido al final como ventaja), tipo (`STATUS_KIND`:
  `buff` o `harm`), segundos redondeados para arriba, sin lo que ya terminó y con `flash`
  en los últimos `FLASH_MS` (5 s) salvo con movimiento reducido. `nextTrayChange` dice en
  cuántos ms cambia un segundo escrito (o nada sin fin). `statusIconStyle` corta
  `STATUS_BOX` (8, 8, 16, 16, el `UI_STATUS_BOX` de spritegen: un test los compara) de
  `ui/status/<id>` del atlas como variables CSS.
- **Vista** (`ui/StatusTray.tsx`): `StatusTrayView` sin hooks (`ui/StatusTray.test.ts`
  recorre su árbol) y `StatusTray`, con un `setTimeout` al próximo segundo y el tooltip
  que abrió un toque o un click (`data-open`; el mouse y el foco lo abren con CSS). Se
  cierra con otro en el mismo ícono, con una presión fuera de la bandeja o con Escape
  (`closesTip`, puro y con tests; el Escape queda `preventDefault`, así no cierra además
  una ventana ni abre Opciones). Cada ícono es un
  `li` enfocable con `data-condition`, `data-kind`, `data-flash`, `aria-label` (nombre y
  tiempo) y su tooltip (`role="tooltip"`, `aria-describedby`); sin sprite, la inicial.
  Textos: `client.status.*`, `condition.<id>.desc`.
- **Dónde va:** en escritorio dentro de `HudBar` (prop `tray`), `position: absolute` sobre
  el orbe de vida y a la izquierda del chat (`windows.css`, íconos a 2x, filas que crecen
  hacia arriba); mientras un tooltip se ve, `.hud-bar:has(...)` sube la barra a `z-index`
  21, sobre las ventanas. En teléfonos y tablets, en el encabezado (`client.css`, 1,5x):
  toma el lugar que sobra (`flex: 1 1 0`, al menos un ícono), lo que no entra baja a una
  segunda línea recortada y el tooltip cuelga del `.hud` (nada posicionado en el medio,
  así el recorte de la fila no lo corta).
- **Placa del nombre** (`ExperienceBar`): nombre y nivel (`client.vitals.level`) sobre la
  barra (el resaltado `stats` del tutorial está en `.xp`; la placa, que sobresale de su
  caja, hereda su contorno: `.xp[data-tutorial-active] > .nameplate`), el porcentaje en la barra (`.xppercent`) y en su `title` y `aria-valuetext` la
  experiencia exacta y lo que falta (`experienceTip`, con `content.experience`, la curva de
  `balance.yaml` que pasa `vite/content.ts`; `state/experience.ts` es la fórmula del
  servidor). Test ids: `level` en el nivel, `experience` en la barra, `conditions` en la
  bandeja.
- **Vista previa:** escena `status` (y `game`, `danger`) de `make ui-preview`.
- **E2E:** "T3.2: a guardian casts haste" (`22-haste`, `23-conditions-hud`) y "T5.6: at
  1280x800 a long name" (la placa).

## Notas del minimapa (rama `feat/minimap`, docs/02 y docs/17 "Minimapa")
- **Click para ir** (rama `feat/minimap-nav`): `ui/Minimap.tsx` llama `Game.minimapWalk`
  con la casilla de `clickTile` si la presión fue un click (`isMinimapClick`); el camino es
  `Steering.walkFar` + `state/far-path.ts` (`findFarPath`), sobre el mapa que se tiene y,
  más allá, `minimapPassable` (`SteerConfig.farPassable`). Es un camino más del `Steering`
  (`Route.far`): mismos `Walk` predichos, mismas cancelaciones, más `cancelFar` (Escape en
  `Game.onKeyDown`) y `farGoal` → `MinimapUi.dest` → `minimap-dest`. Tests:
  `far-path.test.ts`, `steering.test.ts` ("a click on the minimap"), `minimap.test.ts`.
- `WorldState.minimap` (`state/minimap.ts`, puro y con tests) guarda lo explorado del
  servidor (`MinimapIndex`, `MinimapSectors`) y la pista (`ObjectiveHint`); `Game.publish`
  explora la vista propia (`revealView`, la misma regla que el servidor) y publica
  `GameUi.minimap`. `ui/Minimap.tsx` pinta el terreno con `paintTerrain` solo cuando cambia
  la versión, el centro o el zoom, y pide los sectores que le faltan (`wanted`,
  `Game.minimapRequest`). El color de un item es `atlas.json` `minimap`
  (`GameCanvas.itemColor`). Nunca pintes una casilla que `isExplored` no da.
- El item de color de una casilla sale de `MinimapState.item`, nunca de `WorldState.tile`:
  `WorldState.setTile` lo anota (`noteTile`) al recibir cada casilla, porque el mapa se
  olvida lejos del jugador y en cada `FullMapView`. Solo `MinimapSectors.answer` da un
  sector por pedido; un delta no.
- Seguir una quest: `Game.trackQuest` (botón `quest-track` del diario), recordado por
  personaje en `localStorage` `rpg.track` y reenviado tras cada `Welcome`.
