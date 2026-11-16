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
  (pixel-perfect, `roundPixels`, sin suavizado). El jugador puede acercar el mapa por
  escalas enteras (ver "Zoom del mapa"), nunca alejarlo por debajo de las 15x11.
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
  el mapa (arriba a la izquierda).
- Click derecho sobre un NPC (o `Game.attack` con un NPC) = `NpcTalk`. Con un diálogo
  abierto, 1–9 eligen la n-ésima opción mostrada y Escape manda `DialogChoose` 0.
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
  juego, header dentro); el `Game` recibe `t` por un ref y el canvas renombra etiquetas.
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
  condiciones del header (`ConditionBar` en `ui/App.tsx`, nombres `condition.<id>.name`).
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
  gremio en la columna lateral y las invitaciones sobre el mapa (`.guild-invitations`, más
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
  la horizontal: noreste mira al este); `outfitFrame` da 0 parado y, mientras interpola
  un paso, reparte los frames de caminar por el avance (con 3 frames: 1 la primera
  mitad, 2 la segunda), así pasos seguidos alternan 1, 2, 1, 2.
- El canvas usa el outfit solo si el atlas tiene arte real para todos sus frames (origen
  distinto de `auto` y `placeholder`); si no, el bloque. Los sprites de criatura van
  anclados abajo a la derecha de su casilla, como en `MapView` (uno de 64x64 crece hacia
  arriba y a la izquierda). Alpha de invisible, nombre, barras, marca PvP y marco de
  objetivo no cambian.

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
- Escritorio: en la columna lateral todo menos el chat va en `.side-scroll`, que se
  desplaza; el chat queda fijo debajo. Antes era `sticky` y tapaba el final del inventario
  y de "Apariencia" a 1280x800. Con pestañas o cajón, `.side-scroll` es
  `display: contents`. El log del sistema va al final de esa columna en escritorio y
  arriba de la pestaña del chat en el resto.
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
- `render/zoom.ts` (puro, con tests) decide la escala. El mínimo es la que muestra las
  15x11 casillas enteras (la de siempre, `pixelScale`). El máximo es la mayor que todavía
  muestra 7x5 (`MIN_VIEW`). Siempre escalas enteras. Acercado, el canvas se corta a la
  caja del mapa en píxeles de sprite enteros (`viewPixels`). `followCamera` centra en el
  jugador una vista de casillas fraccionarias. El servidor sigue mandando las 15x11 (+1):
  el zoom es solo de dibujo.
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
- Se recuerda por dispositivo en `localStorage` `rpg.zoom` (la escala). La vista ajustada
  no guarda nada: vuelve a seguir a la ventana. Si la ventana ya no admite la escala
  guardada, se dibuja la mayor posible y se conserva la elección.
- `GameUi.zoom` (`{ scale, min, max }`) llega a la UI desde el canvas
  (`GameCanvasOptions.zoomView`); `Game.zoom(steps)` es lo que llaman los botones. Hook
  E2E: `__rpgClient.zoom()`.
- Ubicación de los botones (`touch.css`): abajo a la derecha del mapa, sobre una hotbar
  de una línea y bajo el cajón. En vertical con pad van en la franja, sobre las flechas de
  la hotbar. Mientras hay un item elegido, el banner toma su lugar y se ocultan.

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
- Panel `ui/Appearance.tsx`, sin hooks (`ui/Appearance.test.ts` recorre su árbol). Va en la
  columna lateral y es una pestaña más (`appearance` en `PANEL_TABS`). Muestra por tipo lo
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
  todo (también el paso predicho). No hay estado propio de portales.
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
- E2E `e2e/sandbox.spec.ts`: corre en el servidor principal (inicio `testisle`). Un guardián
  con `town = 'pruebas'` y cuenta `gm` (sembrado con `psql`) despierta en el templo de la
  isla (2095,2086) junto a `pruebas_trainer`, y con `/tp` va a los corrales, al patio de
  portales y a la cueva del piso 8 (screenshots 90–93). El `-start-town pruebas` de
  `make play` se prueba a mano: elige el mismo templo para un personaje sin ciudad.
