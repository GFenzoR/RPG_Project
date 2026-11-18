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
  Solo predice los pasos propios de teclado (hasta `max_queued_steps`, ver "Movimiento
  fluido") y los corrige si el servidor los rechaza.
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
  ni columna fija: el mapa, el dock a su derecha y ventanas separadas (ver "Notas de la UI
  oscura").
- Ningún string visible hardcodeado: todo pasa por `t('clave')`.
- Pensado para PC primero (teclado + mouse). Mantén el input desacoplado para poder
  sumar controles táctiles sin reescribir.
- Dirección de arte, animación, sensación de movimiento y UI acordadas con el dueño el
  2026-11-17: `docs/17-direccion-de-arte-y-ui.md`. Las reglas de arriba cambian cuando se
  haga cada tarea de su plan (§7). A2 y A3 (tema, fuentes, dock y ventanas) ya están, A6
  en parte (movimiento), A7 (vista de 31x21), y A4 y A5 (menú del click derecho con la
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
  animados sin asignar. Encima del mapa: la silueta del jugador propio cuando lo tapa el
  muro de la casilla de al sur (`behindWall`, `view.wallAt`), y en los pisos z ≥ 8 la luz
  de `render/light-layer.ts` (multiply, bajo efectos y nombres; da luz el jugador y cada
  item con `light`). Orden de capas del stage: mapa → luz → efectos → nombres → textos.
- Una criatura sin sprite es un bloque de color con una marca hacia donde mira (ver
  T0.5). Solo se dibuja el piso del jugador.
- Hooks de solo lectura para E2E en `window.__rpgClient` (`game.ts`).

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
- Panel `ui/Inventory.tsx`: slots de equipo, capacidad (oz = gramos / 100) y una ventana
  por contenedor abierto. Los iconos son el sprite del atlas como fondo CSS
  (`Atlas.icon`).
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
- `WorldState.projectiles` guarda los `Projectile` 250 ms; los proyectiles son formas Pixi
  coloreadas por elemento (`ELEMENTS`) y los efectos mágicos, la tira de su elemento.

## Notas de T1.10
- `WorldState.dialog` / `shop` (de `DialogOpen`, `DialogClose`, `ShopOpen`): la tienda se
  cierra con el `DialogClose` de su diálogo. `ui/Dialog.tsx` dibuja ambas ventanas sobre
  el mapa (arriba a la izquierda; desde A5, abajo al centro).
- Click derecho sobre un NPC (o `Game.attack` con un NPC) = `NpcTalk`. Con un diálogo
  abierto, 1–9 eligen el botón con ese número (desde A5 los botones van por tema:
  `state/dialog.ts` `dialogLayout`), 0 "Volver" y Escape manda `DialogChoose` 0.
- Los NPCs no van en la lista de batalla. El plugin de Vite incluye `dialog.yaml` y
  `npcs.yaml` completos y los nombres de `quests.yaml`; un `content_id` llamado `quest`
  se traduce como `quest.<id>.name`.

## Notas de T1.11
- `WorldState.death` (del mensaje `death.died`, con `experience` y `blessings`) abre la
  pantalla de muerte (`.death` en `ui/App.tsx`) hasta que el jugador la cierra.
- El E2E de muerte deja al personaje con 1 de vida con `psql` (`DATABASE_URL`) antes de
  entrar y lo lleva a los lobos.

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
- `WorldState.conditions` (de `PlayerConditions`, solo las propias) alimenta la barra de
  condiciones (`ConditionBar` en `ui/GameView.tsx`, bajo los orbes en escritorio y en el
  encabezado de los teléfonos; nombres `condition.<id>.name`).
  La velocidad aplicada llega en `PlayerStats.speed` / `CreatureSpeed`: el paso predicho y
  la interpolación ya la usan. Invisible: el propio cliente dibuja su criatura con alpha
  0.4 (los demás no la reciben). Efecto 7 = hechizo de condición o cura.

## Notas de T3.3
- `WorldState.party` (`state/party.ts`, puro y con tests) guarda el grupo de `PartyUpdate`
  y las invitaciones de `PartyInvitation` hasta que vencen o se contestan. `ui/Party.tsx`:
  panel del grupo (vida/maná solo de los miembros en vista, que es lo único que llega) y
  las invitaciones sobre el mapa. En la lista de batalla, un jugador tiene el botón "+"
  (invitar) si se lo puede invitar. El canal "Grupo" está en el selector del chat.
- El plugin de Vite empaqueta los nombres de `world.yaml` (`island.<id>.name`).

## Notas de T3.4
- `WorldState.station` (de `StationOpen`) abre `ui/Crafting.tsx`: las recetas de
  `content.recipes` (de `data/recipes.yaml`) de esa estación, con lo que falta, el nivel, la
  herramienta y la chance (`state/recipes.ts`, puro y con tests). Lo que se lleva lo dice el
  servidor (`owned`, `tools`), porque el cliente no ve las mochilas cerradas. Se cierra con
  ×, Escape o al alejarse más de 1 casilla; "Hacer" manda `Craft`.

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
  propia. También fija la música y el ambiente con `loopFor` (isla de `content.islands` o
  subsuelo). La herramienta de recolección (`toolAt`: uso y casilla) solo define el sonido
  de un efecto 5 en esa misma casilla. Se olvida al fabricar o al usar otro item.
- Qué suena con cada evento está en `assets/sounds.yaml` (`content.sounds`). El plugin de
  Vite sirve esos archivos en `/audio/` y `vite build` los emite. No escribas nombres de
  archivo de sonido en el código.
- Preferencias en `audio/prefs.ts` (`localStorage` `rpg.audio`). El panel es
  `ui/AudioOptions.tsx` y va junto al selector de idioma, dentro y fuera del juego. Se
  vuelve a montar al entrar o salir del juego, y cada vez parte de
  `audio.currentPrefs()`.
- Hooks E2E de solo lectura: `window.__rpgAudio` (`unlocked`, `history`, `loops`).

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
  pistas arriba a la derecha del mapa (no toma teclas) con "Saltar tutorial"
  (`Game.skipTutorial` → `TutorialSkip`; el panel se cierra cuando el servidor confirma).
  Se oculta mientras hay `dialog`, `shop` o `station` abiertos: en pantallas angostas
  (la app de escritorio a 960 px) la tienda llega a esa esquina.
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
  Cada frase es i18n (`site.credits.*`); el nombre y autor de un pack,
  `site.credits.pack.<carpeta>.*` (guiones como `_`; `vite/credits.test.ts` exige las dos claves en es y en
  para cada pack, y un enlace en `site/credits.ts` `licenceUrl` para cada licencia).
- Enlaces: el pie del sitio (`site.nav.credits`) y `ui/CreditsLink.tsx` en Opciones (la
  ventana de escritorio y `AudioOptions` del login y del menú ☰), otra pestaña; en la app
  de escritorio, la dirección como texto (`client.options.credits_desktop`).
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
- Modo seguro: `Game.safeMode`/`setSafeMode` (`localStorage` `rpg.safeMode`, activado por
  defecto, `state/pvp.ts`); se manda tras el `Welcome` solo si está apagado (el servidor
  empieza activado). Interruptor `data-testid="safe-mode"` en "Modo de combate".
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
  Frames en el atlas: `<sprite>/<dir>_<frame>` (`outfits/citizen/s_0`). `render/outfit.ts`
  (puro, con tests): `outfitDir` lleva las 8 direcciones a n/e/s/w (las diagonales usan
  la horizontal: noreste mira al este). El frame lo elige la animación ("Animación de
  criaturas"): con 3 frames T0.5, 0 parado y, durante un paso, 1 la primera mitad y 2 la
  segunda, así pasos seguidos alternan 1, 2, 1, 2.
- El canvas usa el outfit solo si el atlas lo anima (`anims`) o tiene arte real para todos
  sus frames (origen distinto de `auto` y `placeholder`); si no, el bloque. Desde docs/17
  los cuatro atuendos son personajes de LPC: ver "Animación de criaturas". Alpha de
  invisible, nombre, barras, marca PvP y marco de objetivo no cambian.

## Animación de criaturas (docs/17 ANI)
- Todo cuerpo de criatura (monstruo, NPC o el atuendo de un jugador) es un `CreatureBody`
  (`render/creature-body.ts`): la sombra de contacto (solo `shadow: ellipse`) y un sprite
  anclado abajo al centro. Los `br` conservan la esquina de abajo a la derecha en la de su
  casilla (como `MapView`); los `bc` (personajes de LPC de 64x64) pisan `FEET_LINE` px por
  encima del borde de abajo. Nombre, gremio y barra suben `lift` px (el alto del dibujo
  sobre su casilla, de `top` y `foot` de `atlas.json`).
- `render/clips.ts` (puro, con tests) arma una vez por sprite sus texturas por acción,
  dirección y frame: las de `atlas.json` `anims`; para un atuendo T0.5 sin animación, sus
  `<dir>_<n>` como quieto (0) y caminar (1..); si no, la textura única. Una acción sin todas
  sus texturas se descarta.
- Cada frame, `animate` (`packages/renderer/src/anim.ts`, puro, con tests) escribe la pose
  en un único objeto reutilizado: caminar por distancia (el ciclo sigue entre casillas,
  `perTile` frames por casilla), quieto con fase por id, el frame de caminar se sostiene
  100 ms entre pasos encadenados (ANI-3), ataque y muerte una vez. Sin clip, lo procedural
  de ANI-5: salto de 2 px por casilla, inclinación de 1 px, aplastado al aterrizar,
  respiración, embestida de 6 px, flotar (`flying`), espejo según `facing`, caída aplastada
  con desvanecido. Además, para todos: destello rojo y empujón de 2 px al recibir un golpe
  y aparición con fundido de 300 ms. Un frame no crea objetos para esto (docs/07).
- Quién ataca a quién (`render/creature-events.ts`, puro, con tests) se deduce de lo que
  llegó desde el frame anterior, hasta que el protocolo lo diga (ANI-7, tarea A9): un
  `Projectile` anima a la criatura de su casilla de salida; un efecto de golpe, bloqueo o
  elemento sin proyectil en el mismo batch, al atacante cuerpo a cuerpo (el propio jugador
  si su objetivo está ahí y al lado; si no, una criatura del otro bando al lado, primero la
  que mira esa casilla); un número de daño hace destellar a la víctima.
- Muerte: una criatura que sale de la vista con la barra en 0 murió ahí (el servidor manda
  `CreatureHealth` 0 antes de `CreatureDisappear`). Su cuerpo queda como "fantasma" sin
  nombre ni barra mientras juega su caída (`death` de LPC, o la procedural) sobre el
  cadáver, y se borra al terminar o si la criatura vuelve.

## Sprites de efectos
- Cada `effect_id` que manda el servidor (1–7 y 10–16, docs/05) tiene una tira de frames
  en el atlas: `effects/<nombre>/<n>` (`n` = 0, 1, …), 32x32, arte propio de
  `tools/spritegen` (`recipes/effects.ts`, 6 frames por tira). Nombres: `hit`, `block`,
  `heal`, `conjure`, `gather`, `gather_miss`, `buff` y los 7 elementos de `ELEMENTS`
  (`physical` … `death`, ids 10 + índice).
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
  listas en el lugar (`dropFinished`), sin un array nuevo por frame.
- Para cambiar un efecto: su receta en `tools/spritegen/src/recipes/effects.ts`,
  `make spritegen ONLY=effects/<nombre>/` y `make sprites`. Para un efecto nuevo del
  servidor: su carpeta en `FOLDERS` de `render/effects.ts` y su tira en la receta.

## Notas de T5.5 (carteles y descripciones)
- `ItemDef.desc` es la clave del `description` del item en `data/items`; mirar un item
  agrega ese texto (sin `desc`, la convención `item.<id>.desc`). El plugin de Vite
  empaqueta esas claves aunque vivan en un catálogo de solo nombres (`items.yaml`,
  `world.yaml`): así un cartel (`brasal_dock_sign`, `description: text.volcan.dock_sign`)
  se lee con Mayús+click.
- El cliente nombra los items por `item.<id>.name`. Un item con un `name` compartido (las
  piezas de borde, los carteles con `item.signpost.name`) recibe esa clave con el texto
  compartido en el plugin; el código sigue pidiendo `item.<id>.name`.
- E2E: el test "T5.5: wake up at the temple of Brasal" lee el cartel del templo
  (screenshot `65b-volcan-temple-sign`) y el de NPCs ("talk to NPCs"), que despierta en
  el templo del Farol, lee el de Puerto desde adentro (3163,6384, screenshot
  `12b-puerto-temple-sign`).

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
    teclas (`keys.take() ?? pad.take()`); un toque es un paso y mantenerlo repite al ritmo
    de caminar. Interruptor en Opciones (`AudioOptions` tiene un hueco `children`; el
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
  primero el nombre (hasta sus 3rem) y después el nivel (`.stat.level`), con "…"; vida y
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
  a 1 casilla); nombres de más de 12 caracteres se acortan con "…". Desde zoom 2 no cambia
  nada.
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
  `/healthz` ni otros orígenes; páginas network-first, `/assets/*` cache-first.
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

## Zoom del mapa
- **Vista ancha** (decisión del dueño, `docs/02` "La vista", `docs/17` UI-4): el servidor
  manda 31x21 (+1) a todos (`Welcome.view_width`/`view_height` → `WorldState.view`,
  `state/view.ts`; 0 = un servidor viejo: 15x11). El zoom es solo de dibujo.
- `render/zoom.ts` (puro, con tests) decide la escala (`ZoomRange {min, fit, max}`):
  - `fit`, la vista ajustada (sin elección guardada): la vista más grande sin parte vacía,
    es decir la escala más chica a la que la ventana cubre la caja (`fillScale`), pero
    nunca una que muestre menos que las 15x11 clásicas (`pixelScale`, la de antes de la
    vista ancha): `min(pixelScale, fillScale)`. Con el dock: 1920x1080 (caja de
    1536x1080) 2x, no 3x; 2560x1440 3x, no 4x; 1280x800 (960x800) y 1280x720 2x; la app
    a 960x700 1x, como antes. En un teléfono `pixelScale` suele ser la menor: no cambia.
    Con un servidor de 15x11, `fit` es `pixelScale`.
  - `min`: la mayor que muestra la ventana entera (`wholeScale`), al menos 1 y como mucho
    `fit`. A 1280x800 y 1920x1080, 1x (31x21, o 30x21 en los 960 px de 1280x800); a
    2560x1440, 2x.
  - `max`: la mayor que todavía muestra 7x5 (`MIN_VIEW`).
  Siempre escalas enteras. El canvas muestra la ventana entera si entra y si no se corta
  a la caja del mapa en píxeles de sprite enteros (`viewPixels`): a 2x en 1920x1080 son
  24x16 casillas. Cortado, deja libre la franja de la hotbar de escritorio
  (`--map-reserve-bottom`) salvo que eso le quite filas a las 11 clásicas; la ventana
  entera nunca se achica por ella (`mapLift` la sube). `followCamera` centra en el
  jugador una vista de casillas fraccionarias (`shownTiles`), con la cámara en píxeles de
  pantalla enteros (ver "Movimiento fluido"). Si llegara otra ventana, el canvas se
  reajusta en el siguiente frame.
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
  paso sin `walk_seq` (el siguiente de un camino por click, uno de persecución, que el
  servidor dio antes de recibir el `Walk`) o con el de una predicción ya abandonada va
  antes de los `Walk` pendientes; uno con `walk_seq` k responde también a los anteriores
  a k, que se perdieron. El paso del servidor se dibuja en el lugar de la predicción más
  vieja, las que quedan se mueven tras él (mismas direcciones, desde donde termina, una
  detrás de otra) y el dibujo se desliza. Así nunca queda una confirmación desfasada (antes
  el paso del camino "confirmaba" el `Walk`, y cada confirmación siguiente era la del
  `Walk` anterior). `expirePredicted` (cada `frame`) abandona las predicciones si la más
  vieja no tuvo respuesta `PREDICT_TIMEOUT_MS` (3 s) después de dibujada: su `Walk` se
  perdió y ninguno lo sigue; el personaje vuelve deslizándose. Un `WalkRejected` vacía
  `predicted`. `game.ts` `frame` solo pide `keys.take() ?? pad.take()` cuando `canStep`;
  un click espera `unconfirmed === 0` para mandar el camino desde donde está el
  servidor.
- **Época** (docs/05 "Caminar"): `walkEpoch` sale del último `WalkRejected` o
  `FullMapView` y va en cada `Walk`; el servidor descarta los de otra época sin contestar.
- **Pasos del servidor** (las demás criaturas y el camino propio por click): `Game` pide
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
  criatura sin frames de caminar (sin outfit) sube 1 px en la mitad central de cada paso
  (`walkBob`).
- **Teclado**: dos teclas perpendiculares a la vez dan la diagonal (`MovementKeys.take`
  con `combine`), también un toque perpendicular con otra tecla mantenida. Falta que el
  dueño decida si un cambio de dirección con las teclas solapadas debe dar ese paso
  diagonal (docs/14).
- **Tests**: `state/motion.test.ts` (puros), `state/world.test.ts` y
  `state/walking.test.ts`: este último simula cliente (el `WorldState` real y el `frame`
  de `game.ts`), un observador y las reglas de la cola del servidor sobre enlaces de 2 a
  300 ms con jitter, a 60, 144 y 40 fps, y exige cero frames quietos con tecla mantenida,
  camino por click y para el observador, cero huecos en el servidor y un rechazo sin
  saltos; además un click y después una flecha (cada `Walk` respondido por su paso),
  `Walk` perdidos y un corte de 1 s de la red del observador (sin atraso que dure). Si
  cambias tiempos de `motion.ts`, córrelo. E2E `e2e/movement.spec.ts`: mantiene una
  flecha 2 s (4 o 5 pasos; como mucho los que entran en el tiempo medido) sobre una recta
  libre y lee `__rpgClient.trail(ms)` (el `drawPos` del modelo en cada `frame`,
  `MotionTrail`, un anillo fijo): ningún frame quieto ni hacia atrás (screenshot
  `96-movement-held-key`, sacado al soltar la tecla). Mide el modelo, no el sprite ni la
  cámara en pantalla: su redondeo a píxeles de pantalla lo cubre `render/viewport.test.ts`.

## Notas de T5.7
- `CreatureState.cosmetics` (de `Creature.cosmetics` y `CreatureCosmetics`, con `""` = el
  aspecto por defecto) y `WorldState.cosmetics` (de `CosmeticsState`: `owned`, `balance`
  y `equipped`; también fija los cosméticos de la criatura propia). `GameUi.cosmetics` los
  publica. Hooks E2E: `__rpgClient.cosmetics()` y `players()`.
- Canvas: `render/cosmetics.ts` (puro, con tests) decide el atuendo (`outfitFor`, con
  citizen si no hay), el tinte multiplicado del sprite (`tintFor`) y el estilo del nombre
  (`nameStyleFor`, se mezcla en el `TextStyle`). `outfitReady` se calcula y guarda por
  atuendo: uno sin arte real cae a citizen y después al bloque. Cuando cambia el `lookKey`
  de un jugador, se tiran sus sprites y se arman de nuevo.
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
  un agujero o un teletransporte (`movesOnStep`).
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
  del foco), con cualquier movimiento propio y con un `FullMapView`. El click para caminar
  no lo mira.
- E2E "portals" de `e2e/game.spec.ts`: un guardián de nivel 30 de la Isla Volcánica
  sembrado con `psql` en 3690,5796,7 hace click en 3693,5796 (el camino rodea la escalera
  de 3692,5796), baja con la flecha izquierda a 3692,5797,8 (el cliente tiene la
  `stairs_up` de 3692,5796,8) y sube con la flecha arriba a 3692,5797,7 (screenshots
  73–75: la escalera en la superficie, la mina en el piso 8 y de vuelta arriba).

## Notas de la Isla de Pruebas (`make play`, docs/16)
- La isla es `dev_only`: el servidor principal del E2E compila el mapa con
  `mapcompile -dev` (`playwright.config.ts`); el de Puerto no la necesita.
- E2E `e2e/sandbox.spec.ts`: corre en el servidor principal (inicio `testisle`). Un guardián
  con `town = 'pruebas'` y cuenta `gm` (sembrado con `psql`) despierta en el templo de la
  isla (2095,2086) junto a `pruebas_trainer`, y con `/tp` va a los corrales, al patio de
  portales y a la cueva del piso 8 (screenshots 90–93). El `-start-town pruebas` de
  `make play` se prueba a mano: elige el mismo templo para un personaje sin ciudad.

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
  (`--map-reserve-bottom` en `client.css`, `mapLift` de `render/viewport.ts`, puro y con
  tests): a 1280x800 tapaba la última fila del mapa.
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
- **Tokens** (UI-2) en `:root` de `client.css` (`--ui-*`; `--bg`, `--panel`, `--text`,
  `--muted`, `--accent` y `--error` quedan como alias para el sitio). El marco de hierro
  (`--ui-frame-shadow`) y la veta de piedra (`--ui-grain`, SVG en línea) los comparten
  todas las ventanas: la lista de selectores de "Frames" en `client.css`. Una ventana nueva
  se suma ahí. No uses colores sueltos: usa un token.
- **Escritorio** (`layout.panel === "sidebar"`, `.game[data-ui="windows"]`, `windows.css`):
  sin encabezado. `ui/GameView.tsx` dibuja el mapa y a su derecha el dock (`aside.side`,
  `#side-panel`, ancho `--dock-w`: el más angosto que deja a las 15x11 clásicas su
  próxima escala entera, 2x a 1280 px y 3x a 1920x1080; con la ventana de 31x21 la vista
  ajustada a 1920x1080 es 2x con 24x16, ver "Zoom del mapa") con:
  - `ui/Vitals.tsx`: orbes de vida y maná (se llenan con `transform`, el "fantasma" marca
    lo perdido, laten bajo el 25 %; `orbFill`/`lowHealth` puros), nombre, nivel, barra de
    experiencia y condiciones. Los test ids `health`, `mana`, `level`, `experience` y
    `conditions` siguen ahí con los mismos textos;
  - `ui/Toolbar.tsx`: botones con íconos propios (`ui/icons.tsx`, pixel art de 16x16 como
    texto, 1x en el dock angosto y 2x desde 1344 px) que abren y cierran las ventanas, el
    mercado (solo lo cierra: se abre desde un tablero) y "Salir del juego";
  - las ventanas acopladas (`.dock-stack`, se desplaza si no entran) y el chat con el log
    como segunda pestaña (`ChatBox`; mientras el log no se ve, todos los avisos flotan sobre
    el mapa, no solo los importantes).
- **Ventanas** (UI-5): `ui/windows.ts` (puro, con tests) guarda cuáles están abiertas,
  acopladas o flotando, dónde, plegadas y en qué orden; se recuerda por dispositivo en
  `localStorage` `rpg.windows` (si no se puede leer, vuelven las de fábrica: batalla e
  inventario acopladas). `ui/GameWindow.tsx` es el marco (barra con ícono, título, plegar
  y cerrar; `role="dialog"` flotando, `region` acoplada). Se arrastran por la barra: una
  flotante sigue al puntero, una acoplada deja un fantasma; soltada sobre el dock se acopla
  antes de la ventana bajo el puntero. Doble click en la barra la pliega. Cierran con un
  fundido de 100 ms (`CLOSE_MS`, `[data-closing]`). Teclas (`WINDOW_KEYS`, solo fuera de
  un campo de texto y después del listener del `Game`): I inventario, K habilidades,
  B batalla, P grupo, G gremio, O apariencia, H ayuda, M cierra el mercado; Escape cierra
  la flotante de arriba o, si no hay, abre Opciones. Un resaltado del tutorial abre su
  ventana (`windowForHighlight`). Las ventanas del servidor (diálogo, tienda, crafteo,
  mercado, casa, intercambio) siguen donde estaban, con el mismo marco.
- **Gremio** (UI-7): ventana propia con pestañas Resumen, Miembros y Guerras
  (`GuildPanel` con `tab`; sin `tab` muestra todo, como en la pestaña de los teléfonos).
  Sigue sin hooks y `ui/Guild.test.ts` recorre las pestañas.
- **Opciones**: Sonido (`SoundOptions` de `ui/AudioOptions.tsx`; la esquina del login y el
  menú ☰ siguen con `AudioOptions`), Controles (pad), Interfaz (idioma, "Animaciones
  reducidas" y "Restablecer ventanas"). `main.tsx` arma esas piezas (`GameSettings`).
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
  ajustada: `zoomRange`, `viewPixels` y `mapLift`, como `render/game-canvas.ts`) y
  saca screenshots de cada escena (game, windows, options, dialog, danger, death, login,
  characters) a 1920x1080, 1280x800, 1280x720, 960x700, teléfono vertical y horizontal y
  tablet, en `e2e/screenshots/actual/ui-preview/`. Playwright contesta cada pedido desde el
  build: no levanta servidores. Los estados están en `src/preview/fixtures.ts`.
- **E2E**: `e2e/windows.ts` (`openWindow`, `closeWindow`) abre las ventanas desde la
  botonera. Test ids nuevos: `toolbar`, `toolbar-<id>` (`options-button` para Opciones,
  `toolbar-market`, `logout`), `window-<id>` (`options` para Opciones),
  `window-close-<id>`, `window-fold-<id>`, `[data-window-button]`, `[data-chat-tab]`,
  `[data-guild-tab]`, `reduced-motion`, `windows-reset`; la ayuda es `controls-help`.

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
  (solo modo `menu`), el `dblclick` del canvas va a `Game.doubleClickTile`: manda
  `StopWalk` si el primer click mandó un `WalkPath` hace menos de `DOUBLE_CLICK_STOP_MS`
  y hace lo del click derecho clásico. Un toque de dedo reciente lo ignora.
- **Ficha** (`state/item-card.ts` `itemCard`, puro, y `ui/ItemCard.tsx`, sin hooks): los
  datos salen de `ItemDef` (`vite/content.ts` `cardFields`: `kind`, `weight`, `weapon`,
  `ammo`, `armor`, `shield`, `consumable`, `rune`, `requires`, `fixed`; opcionales).
  Quién mira (nivel, vocación, nivel mágico) decide si un requisito está en rojo
  (`GameUi.vocation`). `BigIcon` dibuja un ícono del atlas a 2x (`.big-icon`).
- **Tooltip** (`ui/ItemTooltip.tsx`, montado en `GameView` junto al menú): delegación en
  `document` sobre `[data-tip-item]` (+ `data-tip-count`), 350 ms de mouse, o foco del
  teclado con `:focus-visible`. Los items del inventario tienen `tabIndex=0`: Enter =
  acción por defecto, tecla de menú o Mayús+F10 = menú. Test id `item-tooltip`.
- **Diálogo** (`ui/Dialog.tsx`): `DialogView` y `ShopView` son funciones sin hooks
  (`ui/Dialog.test.ts`); `DialogBox` (el filtro) y `ShopWindow` (pestaña, filtro,
  búsqueda, página, elegido, cantidad, columnas medidas con `ResizeObserver`) tienen el
  estado. `.npc-windows` va de lado a lado sobre el mapa, abajo al centro; con la tienda,
  `data-shop` pone la tienda a la izquierda y el diálogo en una columna. Los temas vienen de
  `content.dialogTopics` (por NPC, `vite/content.ts` `dialogTopics`, `tag` del YAML) y
  `state/dialog.ts` arma la grilla. Test ids: `dialog-filter`, `dialog-bye`,
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
