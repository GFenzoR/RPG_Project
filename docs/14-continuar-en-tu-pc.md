# 14 — Continuar en tu PC (traspaso de la sesión cloud, noviembre 2026)

Hasta el 10 de noviembre de 2026 el desarrollo siguió en una sesión cloud que coordinaba
sesiones hijas: cada una hizo una tarea del roadmap en un PR, y la coordinadora corría
los checks y la revisión de cada PR antes de mergearlo. Este doc deja todo listo para
seguir con Claude Code en tu computador. El entorno local está en
`12-local-development.md`, y el hosting de pruebas en casa, en `13-hosting-de-pruebas.md`.

## Dónde quedó
- **Hitos 0 a 4:** completos, salvo T1.18 (deploy en AWS), que es tuya. T0.5 (sprites)
  quedó hecha en local (PR #77).
- **Hito 5:** hechas T5.1 a T5.5 (PRs #69 a #74):
  - gremios;
  - PvP con skulls y guerras de gremios;
  - mercado global e intercambio directo;
  - casas;
  - Isla Volcánica, con el Capítulo 3 y las monedas de plata y oro.
- **T5.6** (controles táctiles, layout para pantallas chicas, PWA y Tauri mobile
  preparado) está en el PR #78. Lo 👤: cuentas de las tiendas, firma y
  compilar el APK/IPA (`docs/15-movil.md`).
- **T5.7** (tienda cosmética con pagos) está hecha en la rama `feat/t5.7-cosmetic-shop`
  (PR #80): moneda "nácar", catálogo, proveedor falso y Mercado Pago, panel
  "Apariencia" en el juego y `/shop` en el sitio. Lo 👤: elegir el proveedor de
  producción y sus claves, y una compra real en el modo prueba del proveedor.
- **El roadmap está completo** salvo lo que es tuyo (tabla de abajo).
- Sin placeholders de sprites: 106 salen del pack Dungeon Crawl (CC0,
  `assets/vendor/dungeon-crawl/`) y el resto es arte propio de `tools/spritegen`
  (`make spritegen`), incluido el jugador (outfit `citizen`, 4 direcciones con caminata).

## Primer arranque en tu PC
1. Sigue "Instalar una vez" de `12-local-development.md`. En Windows, usa WSL2 con el repo
   dentro de WSL, o la vía "Windows nativo" del mismo doc (repo en `C:\`, Git Bash).
2. Corre `make setup`, `make db-up` y `make dev`, y abre `http://localhost:5173/` (sitio) y
   `http://localhost:5173/play/` (juego).
3. Para que otros entren desde tu red o desde internet, usa `make home-up` (`13-hosting-de-pruebas.md`).
4. Juega 10 minutos y anota lo que se siente mal. Es lo que la IA no puede juzgar sola.

## Lo que es tuyo 👤
| Qué | Para qué | Dónde está explicado |
|---|---|---|
| Confirmar CC BY 4.0 para los mapas que manda la comunidad | Portal de mapas (T4.5) | `04-map-editor-and-ai.md` |
| Cuenta de AWS y dominio | T1.18: servidor público | `09-deployment-aws.md` |
| Apps OAuth de Google y Discord, y SMTP | Login social y emails (T2.1) | `12-local-development.md` |
| Cuenta bot de GitHub (token classic con `public_repo`, fuera de MAINTAINERS) | Que los mapas aprobados se vuelvan PRs | `09-deployment-aws.md` |
| Protección de la rama `main` y la variable `DESKTOP_SERVER_URL` del repo | Seguridad y builds de escritorio | `09-deployment-aws.md` |
| Copiar a `deploy/.env.example` las variables nuevas que lista docs/09 | Configuración del deploy | `09-deployment-aws.md` |
| Cuentas de Apple y Google Play (opcional) | Apps móviles nativas (T5.6) | `15-movil.md` |
| Elegir el proveedor de pagos | T5.7 en producción | brief de T5.7 |

## Orden sugerido
No quedan tareas del roadmap para la IA. Lo que sigue es tuyo (tabla de arriba):
1. Elegir el proveedor de pagos y cargar sus claves (T5.7, `09-deployment-aws.md`
   "Tienda y pagos"); probar una compra en su modo prueba con el webhook expuesto.
2. T1.18: cuenta de AWS, dominio y deploy.
3. Copiar a `deploy/.env.example` las variables nuevas de docs/09 (`RPG_ENV`,
   `PAYMENTS_PROVIDER`, `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `PAYMENTS_REF_SECRET` y
   `PAYMENTS_REF_SECRET_PREVIOUS`, comentadas): los permisos de la IA no le dejan editar
   ese archivo.
4. Jugar y anotar lo que se siente mal; de ahí salen las próximas tareas.

## Cómo trabajar en local (lo que aprendimos en la nube)
- **Una tarea, una sesión, un PR.** Usa `/roadmap-task T5.6` o pega el brief. Pide un plan
  corto y deja que trabaje.
- **Antes de mergear:**
  - corre `make lint test validate`, `make test-integration` y `make e2e`, y mira los
    screenshots que cambiaron;
  - juega lo que cambió;
  - pide a la sesión que pase el diff por `code-reviewer`;
  - en tareas grandes, abre una segunda sesión solo para revisar ("revisa el PR #N buscando
    bugs reales, con un test que lo reproduzca") y pásale sus hallazgos a la primera.
- **Errores que se repitieron y conviene pedir que se revisen:**
  - mover items u oro entre personajes, el mercado o casas va siempre en un transfer del
    Saver, junto con los snapshots (docs/01 "Transacciones"), y con el modo de falla
    segura en mente;
  - el check `map-pr` valida el mapa con el `data/` y el `i18n/` de `main`: el contenido
    nuevo va en un PR antes del mapa que lo usa;
  - el vuelto de los pagos tiene que entrar en la mochila (T5.5);
  - nada de textos sin i18n, y nombres, textos y números originales (regla legal);
  - tests que digan lo que prueban y e2e que confirmen la respuesta del servidor, no
    solo el estado local del cliente.
- **Si la CI falla sin crear jobs**, es un problema de GitHub Actions: relánzala.
- **E2E en la CI:** el runner (2 CPU, sin GPU: WebGL por software) corre la suite varias
  veces más lento que tu PC. Cada test que falla se reintenta una vez; si pasa al
  reintento, el reporte lo marca `flaky`. Un `flaky` es un bug (casi siempre una espera
  mal puesta en el test, a veces del cliente): baja el artefacto `playwright-report`, mira
  el trace del reintento y arréglalo, no lo dejes. Detalle en docs/08 "E2E en la CI".

## Pendientes conocidos (no bloquean)
- **Móvil** (T5.6, falta probarlo en un dispositivo real): login de Android sin llavero
  (hay que entrar de nuevo en cada arranque) y el selector de servidor reinicia la app.
  Detalle en `15-movil.md`. El área segura (muesca, esquinas, barra de inicio) se cuenta
  una sola vez en todo el juego: el padding de `.game` para lo que cuelga del mapa, y
  `env(safe-area-inset-*)` en los bordes de lo que va fijo a la pantalla (las ventanas en
  teléfono y tablet, el selector de idioma fuera del juego) y en `menuPlacement` para el
  menú del toque largo. Un E2E con insets de CDP mide el pad, la hotbar, el zoom, el
  banner, el diálogo de un NPC y el menú; crafteo, mercado, casa e intercambio comparten
  la regla CSS del diálogo pero no tienen su propia medición. Falta verlo en un iPhone y
  un Android con muesca de verdad (el override de CDP solo existe en Chromium).
- **Sonidos sin reintento:** un sonido que no se pudo bajar (`/audio/`, `audio/engine.ts`
  `load`) queda mudo el resto de la sesión (el fallo se guarda). El atlas sí reintenta
  (`packages/renderer/src/retry.ts`, y "Reintentar" en el juego y en el editor); si hace
  falta, los sonidos podrían usar la misma política.
- **Mercado en vivo:** cada refresco manda la ventana entera (`MarketUpdate` completa),
  no un delta (costo y tope en docs/07). Pasar a deltas necesita un mensaje nuevo y que el
  cliente fusione las listas; hacerlo solo si una medición con muchos espectadores de un
  mismo libro lo pide (antes, subir `market.push_every_ms`).
- **Caída con la calle de por medio (límite general, no del comercio):** un transfer
  descartado ya no duplica lo que su personaje soltó antes al suelo público: su estado del
  final de ese comando (o tick) se escribe antes del transfer (docs/01, "Guardado antes
  del transfer").
  Queda el caso de una **caída** (o de la base caída al apagar, que se trata como una):
  lo que alguien tiró a la calle y otro levantó puede quedar en las dos filas si el
  guardado de quien lo levantó entró y el de quien lo tiró no. Es el límite de guardar
  por personaje con el suelo en memoria, igual sin comercio. Lo mismo si la base rechaza
  el snapshot mismo, no solo el transfer (lo avisa `PersistenceDataLost`). Una salida
  sería reservar lo que se tira a la calle hasta escribir el estado de quien lo tiró (una
  escritura por tirada, acotada por jugador, y una demora para levantarlo); hacerlo solo
  si las alertas de economía lo muestran.
- **Mundo:**
  - cada cartel cuesta un item y un ID (hoy todos los de Puerto, el Bosque y la Isla
    Volcánica, incluido el de la puerta con llave del piso 8, tienen su `*_sign`; solo el
    del templo de `testisle` no). A futuro `mapcompile` podría llevar `texts.yaml` a
    `world.bin` y el servidor leerlo, sin items por cartel;
  - portales (`02-game-design.md` "Cambiar de piso"): el servidor mueve por escaleras,
    escaleras de mano, agujeros, sogas y teletransportes, y todos tienen su item con arte
    propio (`ladder_up`/`ladder_down`, `hole`, `rope_spot`, `teleport`; las escaleras son
    del pack), pero el mundo solo usa escaleras: poner los otros es diseño de mapa
    (`build-map-area`; `make validate` y `mapcompile` exigen el item en cada entrada). Sin
    una escalera de mano en el mundo, Ctrl+click derecho sobre una (usa el item de arriba
    en vez de trepar) y su toque largo (sin "Usar" ni "Mover" para su propio item) solo
    tienen tests unitarios (`state/portals.ts` `useMode`, `input/mouse.ts` `mapPress`,
    `state/items.ts` `menuItem`), no E2E. El teletransporte es estático: el atlas y el
    renderer no animan items (haría falta una tira de frames por item, como los efectos).
    Un portal sin su item lo rechazan `make validate` y `mapcompile`; el servidor solo
    **avisa** en el log (`initPortals`) si el `world.bin` es de antes de cambiar
    `data/items` (`world.NewMap` no conoce los items y los mapas de los tests de `session`
    ponen portales en casillas sin nada). `add_portal` (mapcli, MCP, panel del editor) no
    coloca el item: el editor podría ponerlo solo (hacerlo dentro de la operación cambia su
    inversa y los patches, por eso quedó aparte). Arrastrar con el mouse el item propio de
    un portal manda un `MoveItem` que el servidor rechaza (`inventory.not_possible`), como con
    cualquier item fijo del mapa. Los items tirados sobre una escalera, un agujero o un
    teletransporte caen al otro extremo (solo por `MoveItem`: el servidor nunca suelta
    nada en esas casillas, nadie se para ahí), sin efecto visual ni sonido propio; uno que
    ya está donde caería (un teletransporte del mismo piso) no se mueve ni avisa. Cada paso
    por un portal manda un `FullMapView` (hoy unos
    950 B/s subiendo y bajando sin parar, docs/07): una isla con pisos sobre el 7 lo haría
    más pesado, conviene medirlo de nuevo cuando exista;
  - chequeo de escape de las puertas con llave (`02-game-design.md`, "Chequeo de
    escape"): cuenta como salida de un área solo la puerta de una sala desde adentro y los
    portales que no piden nada (escalera, escalera de mano, agujero, teletransporte); las
    casas y las entradas de escaleras, agujeros y teletransportes son muro, y los puntos de
    soga, los teleports de diálogo y los viajes en barco no son aristas. El mundo son solo
    los templos. **Para que lo mire el dueño:** es más estricto que el brief, que contaba
    también las llegadas de barco; una llegada es una entrada, no una salida (con ella,
    una bóveda sin capitán pasaba y quien se colara adentro podía quedar encerrado). En el
    mapa de hoy no cambia nada. Si se quieren de vuelta, hay que sumar también la salida
    en barco como arista. Un diseño que solo deje salir por esos caminos se rechaza aunque
    sea seguro; si hace falta, sumarlos como aristas, igual en `session/door.go`
    (`escapeWay`, `portalSources`) y `packages/map-format/src/doors.ts` (`ESCAPE_WAYS`,
    `portalSources`), con casos nuevos en `door-rooms.json`. El chequeo de llaves es
    conservador (supone a un jugador en cualquier área fuera de las salas y en cualquier
    casa), y una escalera de mano cuenta solo desde el área de su casilla;
  - la búsqueda de casilla libre por anillos (`searchFrom` en `session/area.go`) ya tiene
    regla para cada origen fuera de las áreas (casa: su área de casa y la calle de la
    salida; puerta con llave: su afuera; escalera: las áreas de al lado; cualquier otro:
    ninguna, `02-game-design.md` "Nadie aparece adentro sin pasar la puerta"). La salida
    de una casa o el templo sobre una puerta (con llave o común, abierta o cerrada) o en
    una casilla no caminable, y el templo en una casa, ya no dejan arrancar ni pasan
    `make validate` (`checkArrivals`, casos en `testdata/arrivals.json`): con todo lleno,
    `houseExit` y `wakeAtTemple` dejan al jugador en esa casilla misma, y desde el umbral
    de una puerta con llave daba un paso a la sala sin la llave (el paso solo mira adonde
    va); una puerta común la puede cerrar cualquiera. Hoy ninguna de las 6 salidas ni
    ningún templo está sobre una puerta. Queda: quien sale del juego en el umbral de una
    puerta abierta vuelve afuera aunque hubiera entrado con la llave (no sabemos de qué
    lado venía), y un `Teleport` del servidor (`relocate`) no mira si la casilla es
    caminable: todo destino de último recurso nuevo tiene que quedar garantizado por la
    carga, como el templo y la salida;
  - **Para que lo decida el dueño (revisión del lote 3):**
    - portales de la comunidad entre islas: hoy el chequeo de parcelas los rechaza
      (`cross_island`, `packages/map-format/src/patch/plots.ts`), la opción segura, porque
      un teletransporte entre islas se saltea el barco, su precio y sus requisitos y
      `travel.combat_block_ms`. Si se quieren, hace falta una regla de viaje para ellos
      (como mínimo el bloqueo de combate del barco en el servidor) antes de aflojar el
      chequeo. En "Mis envíos" el rechazo se ve como el genérico de fuera de parcelas
      (`outside_plot`): un código propio necesita i18n, cliente y servidor;
    - agujeros y teletransportes sin salida: `make validate` solo **advierte** cuando desde
      su destino no se llega a un templo sin llaves ni herramientas (un pozo del que se
      sale con soga es un diseño válido, a la manera de Tibia). Si se prefiere que sea
      error, o exigir siempre una salida sin soga, es cambiar la advertencia de
      `checkPortalExits` (`validate.ts`) por un error;
    - quien veía a un jugador tomar una escalera recibe el paso y enseguida su
      desaparición, y el cliente lo borra en el acto: no ve el paso sobre la escalera. Se
      podría diferir el borrado hasta que termine la animación (solo para dibujar, sin que
      siga en la lista de batalla ni se pueda atacar);
    - con una tecla de movimiento mantenida, un paso rechazado no se reintenta hasta volver
      a pulsarla (así no se repite el aviso de la escalera o de la puerta de una casa).
      Eso incluye un paso rechazado porque alguien estaba en la casilla y después se fue.
  - un comando que suelta algo a la calle **dentro** de una pila o bolsa ajena y además
    cambia una casa todavía guarda el snapshot aparte, antes de la escritura de la casa,
    y lo registra con nivel error (`settleGave`): no se le puede reservar lo ajeno. Hoy
    ningún comando lo hace (solo un `MoveItem` suelta en algo que no se le puede reservar,
    y ningún `MoveItem` cambia además una casa): es una guarda;
  - el caso real que justificó reservar lo soltado con la escritura de la casa (una runa
    del suelo de la casa usada desde la calle que mata a un monstruo de una quest de
    muertes cuya recompensa no entra) lo juega `TestHouseRuneKillsAQuestMonsterFromTheStreet`
    con la runa, el monstruo y la recompensa de `data/`; la quest es del test porque
    ninguna quest de `data/` termina en una muerte (todas cierran hablando con un NPC). Si
    alguna llega a terminar en una muerte, conviene pasar el test a ella.

## T5.6: brief (hecha, se deja como referencia)
Implementa **T5.6 Controles táctiles y cliente móvil** de docs/10-roadmap.md (Hito 5). docs/00 dice: plataforma PC primero, móvil secundario. Esta tarea hace que el cliente web se juegue bien en un teléfono o una tablet y en ventanas chicas de escritorio, y deja preparado Tauri mobile. Las apps nativas firmadas para las tiendas son 👤 del dueño (cuentas de Apple y Google).

### Alcance (rama `feat/t5.6-touch`, desde main)

#### 1. Controles táctiles (client/src/input, como prevé client/CLAUDE.md)
- **Caminar:**
  - tocar una casilla camina hasta ella, con el pathfinding que ya existe;
  - además, un pad direccional en pantalla, opcional y activable en Opciones, para pasos de a uno;
  - mantener presionado repite el paso.
- **Atacar o hablar:**
  - tocar una criatura la marca como objetivo, igual que el click derecho de hoy;
  - tocar a un NPC lo habla;
  - un toque largo, o un botón de acción contextual, reemplaza el click derecho sobre items y casillas: usar, abrir, mirar (Mayús+click) y mover.
- **Items:**
  - arrastrar con el dedo entre inventario, contenedores y suelo, con las mismas reglas del servidor;
  - una alternativa sin arrastre: tocar el item, después tocar el destino.
- **Hotbar:** tocable, y en pantallas chicas se reduce a los slots que entren con un deslizador.
- **Chat:** el teclado virtual no tapa el input. Al escribir, el juego no recibe teclas.
- **Lógica pura y testeable:** gestos (toque, toque largo, arrastre, pellizco si lo usas para zoom) separados del DOM, con Vitest. `pointer events` y no APIs viejas de touch, salvo que haga falta.

#### 2. Layout para pantallas chicas y ventanas chicas
Tres arreglos que vienen de screenshots de tareas anteriores:
- **Encabezado:** a 1280x800, un nombre largo con la experiencia hace que la ayuda de controles pase a 6 líneas. El encabezado crece y el mapa baja de zoom 2x a 1x (screenshots 47, 49, 50 y 63–66). Acórtalo o pliégalo para que el mapa no pierda zoom.
- **Mensajes del servidor:** el log de mensajes (`ul.log`, rechazos de PvP, bloqueo de logout y avisos del mercado o la casa) queda debajo del inventario y las habilidades en el panel lateral, fuera de vista a 1280x800. Haz que los avisos importantes se vean siempre; por ejemplo, un toast o una línea de estado sobre el mapa, además del log.
- **Nombres a zoom 1x:** los nombres, las etiquetas de gremio y las marcas de criaturas vecinas se pisan. Busca una regla simple: apilar, acortar o mostrar solo el objetivo y los cercanos.

Y en general:
- **Teléfono vertical y horizontal, y tablet:**
  - el mapa ocupa lo principal;
  - el panel lateral pasa a pestañas o a un cajón: batalla, grupo, gremio, inventario, habilidades y chat;
  - las ventanas (NPC, tienda, mercado, intercambio, casa, gremio y tutorial) entran en pantalla y se cierran con un botón grande.
- **Sitio público:** que las páginas también se vean bien en teléfono. Ya hay un e2e "desktop y phone"; amplíalo si cambias algo.
- **Accesibilidad:** objetivos táctiles de 44 px como mínimo, foco visible y nada que dependa solo de hover.

#### 3. Instalable
- **PWA:** manifest (nombre, íconos placeholder, `display: standalone`, orientación) y service worker *solo* para el shell estático; nunca para la API ni el WebSocket.
  - Se instala desde el navegador, sin tiendas.
  - Documenta en docs/09/12/13 que Caddy lo sirve con las cabeceras correctas.
- **Tauri mobile:**
  - Deja preparado `apps/desktop` (o un `apps/mobile` si es más limpio) para `tauri android init` / `tauri ios init`: configuración, capabilities y el selector de servidor de T2.x.
  - Documenta los pasos 👤 en un doc: SDKs, firma y cuentas de las tiendas.
  - No hace falta compilar el APK aquí si el entorno no tiene el SDK de Android. Dilo en el PR.

#### 4. Tests
- Vitest de la lógica de gestos y del layout responsivo, con los breakpoints como datos.
- E2E con Playwright y un dispositivo emulado (por ejemplo `devices['Pixel 7']` y `devices['iPad Mini']`):
  - entrar al juego, caminar tocando y con el pad;
  - atacar a una criatura con un toque;
  - hablar con un NPC;
  - mover un item del inventario al suelo con toque y destino;
  - abrir el chat.
  - Screenshots revisados con Read, en vertical y en horizontal.
- Que nada de escritorio cambie de comportamiento: los e2e existentes siguen en verde.
- Un screenshot a 1280x800 con un personaje de nombre largo muestra el mapa a 2x.

#### 5. Docs
- client/CLAUDE.md (input táctil, layout).
- docs/00 (la línea de plataforma no cambia: móvil sigue siendo secundario).
- docs/08 (e2e móvil) y el doc de instalación móvil.
- T5.6 marcada en el roadmap, con lo 👤 pendiente.

#### Reglas
- Servidor autoritativo: el cliente solo envía intenciones, igual que con el mouse.
- Nada de strings hardcodeados.
- Sin dependencias pesadas nuevas. Si agregas una, que tenga licencia compatible y esté justificada.

#### Cómo trabajar
1. **Lee primero:**
   - CLAUDE.md, client/CLAUDE.md y apps/desktop/CLAUDE.md;
   - docs/00, docs/05, docs/07 (presupuesto del cliente), docs/08 y docs/12/13;
   - `client/src/input`, `game.ts`, `ui/App.tsx`, `client.css` y los e2e.
2. **Haz un plan corto y síguelo** sin pedir confirmación.
3. **Definición de terminado:**
   - `make lint test validate` y `make e2e` en verde, más `make test-integration` si tocas algo del servidor;
   - screenshots revisados;
   - `code-reviewer` una vez;
   - docs actualizados;
   - si cambias rutas que filtra la CI, revisa `.github/scripts/ci-changes.sh` y su `self_test`.
4. Título del PR en inglés, estilo Conventional Commits (por ejemplo `feat(client): touch controls and small-screen layout (T5.6)`); la descripción, en español.

## T5.7: brief (hecha, se deja como referencia)
Implementa **T5.7 Tienda cosmética con pasarela de pago** de `10-roadmap.md`. Decisiones
cerradas (`00-vision.md`): la monetización es solo cosmética, nunca da ventaja de juego,
y el modelo ya prevé las tablas `cosmetics` y `account_cosmetics`.

### Alcance (rama `feat/t5.7-cosmetics`, desde main, idealmente después de T0.5)
- **Diseño en docs/02 ("Tienda cosmética"):**
  - Una moneda premium con nombre propio, comprada con dinero real. No se puede
    intercambiar, ni pasa por el mercado ni se convierte en oro: así no compra ventaja
    por la puerta de atrás.
  - Catálogo en `data/cosmetics.yaml`, validado con esquema e i18n: atuendos y colores
    del personaje, adornos visuales y quizá un marco del nombre.
  - Nada que cambie stats, velocidad, XP, botín, capacidad ni tiempos.
  - Sin cajas de botín: cada compra es exactamente lo que se ve.
  - Lo comprado es de la cuenta (`account_cosmetics`) y se equipa por personaje.
  - Política de reembolso y de cuentas suspendidas.
- **Pagos:**
  - Una interfaz de proveedor (`server/internal/payments`) con dos implementaciones:
    - un proveedor falso, para tests y e2e;
    - el del proveedor que elijas, en modo prueba (por ejemplo Stripe o Mercado Pago).
  - Checkout alojado por el proveedor: el servidor nunca toca datos de tarjeta.
  - Webhook con firma verificada e idempotencia por id de evento.
  - Acreditación en una transacción con un log auditable.
  - Reembolsos y contracargos que descuentan saldo, y si no alcanza, marcan la cuenta.
  - Límites por cuenta.
  - Las claves van por variables de entorno, nunca en el repo.
  - Todo apagado si no hay proveedor configurado.
- **Servidor:**
  - Compra con saldo y equipar o desequipar por mensaje de protocolo.
  - Los cosméticos equipados viajan en `Creature`, y el render los dibuja.
  - Comando de staff para dar o quitar saldo y ver compras, auditado.
- **Cliente y sitio:**
  - Tienda en el sitio (`/shop`, solo con sesión iniciada), con el saldo, el catálogo y el
    historial.
  - En el juego, un panel para equipar lo comprado.
  - Textos en es y en.
- **Tests:**
  - firma y webhook duplicado;
  - concurrencia de compras;
  - que ningún cosmético cambie el combate (sim);
  - integración con Postgres;
  - e2e con el proveedor falso: comprar saldo, comprar un atuendo, equiparlo y verlo en
    otro jugador.
- **Docs:** docs/01, 02, 05, 06 y 09 (variables del proveedor y webhook en Caddy), y el
  roadmap.

## Sprites: de dónde sale cada uno
T0.5 quedó hecha (PR #77) y ya no hay placeholders:
- **Pack Dungeon Crawl** (CC0, `assets/vendor/dungeon-crawl/`): suelos de pasto, arena,
  tierra, piedra y agua, muros de piedra y roca, árboles, casi todos los monstruos y NPCs,
  armas, armaduras e items de misión. El mapeo está en `assets/sprites.yaml`.
- **Arte propio** (`tools/spritegen`, CC0): lo que el pack no tenía (madera, muelle,
  yunque, cajón, bolardo, tablero, pino, peñasco, gaviota, jabalí, ciervo, el barquero,
  materiales, comida, herramientas, monedas de cobre y plata, mochila), el jugador
  (outfit `citizen` en `assets/sprites/outfits/citizen/<n|e|s|w>_<0|1|2>.png`, y los
  atuendos de la tienda) y las marcas PvP (`assets/sprites/ui/marks/`). Las criaturas
  propias llevan la misma sombra proyectada que las del pack (`assets/README.md`, "Sombra
  de las criaturas").
- **Efectos de combate y magia** (arte propio, `tools/spritegen/src/recipes/effects.ts`):
  una tira animada de 6 frames por cada `effect_id` del servidor, en
  `assets/sprites/effects/<nombre>/<n>.png`. El cliente la juega en 600 ms
  (`client/CLAUDE.md`, "Sprites de efectos"); sin arte, la forma Pixi de antes. Los
  proyectiles y los números flotantes siguen siendo formas y texto de Pixi.
- **Bordes** (`assets/sprites/borders/`): `gen-borders.ts` recorta la textura del suelo de
  origen.

Para cambiar un sprite: otro tile del pack en `sprites.yaml`, o una receta nueva en
`tools/spritegen/src/recipes/` y `make spritegen ONLY=<ruta>` (estilo y reglas en
`assets/README.md`, "Arte propio"). Después, `make sprites` y revisar con Read.
