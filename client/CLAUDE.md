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

## Notas de T1.9
- `content.spells` (de `data/spells.yaml`) alimenta la barra de hotkeys `ui/Hotbar.tsx`:
  F1–F12 lanzan el hechizo del slot (`CastSpell` por id), el lápiz deja elegir uno por
  slot y se guarda por vocación en `localStorage` (`state/hotkeys.ts`). La sombra de cada
  slot es lo que falta del cooldown propio o de grupo (`SpellCooldown`).
- La línea "Decir" manda `Say` en el canal local: si son palabras mágicas, el servidor
  lanza el hechizo (el chat completo está en T1.13).
- `WorldState.projectiles` guarda los `Projectile` 250 ms; efectos y proyectiles mágicos
  son formas Pixi coloreadas por elemento (`ELEMENTS`).

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
- Efectos 5 (cosecha) y 6 (intento fallido) son formas Pixi en `drawEffect`.

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
  la izquierda del nombre con formas (`drawSkull`, colores en `state/pvp.ts` `skullColor`)
  y la lista de batalla un `.skull` del mismo color (`data-skull`). Placeholder hasta tener
  sprite. La lista de batalla ya no deshabilita a los jugadores: un click = `SetTarget`
  (el servidor decide); también click derecho en el canvas.
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
- `MarketView.readOnly` (`MarketUpdate.read_only`) muestra el aviso
  `data-testid="market-read-only"`; `Disconnect{SAVE_FAILED}` y `{CHARACTER_LOCKED}` usan
  la tabla automática de motivos (`client.disconnect.*`).
- E2E "T5.3" de `e2e/game.spec.ts`: dos guardianes sembrados con `psql` junto al tablero de
  Puerto (3168, 6382) intercambian pescado por monedas, uno publica una oferta, el otro
  compra 3 y el primero retira el oro (screenshots 52–55).

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
