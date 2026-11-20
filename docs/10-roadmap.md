# 10 — Roadmap

Cada tarea está pensada para **una sesión de Claude Code** (un PR). Cuando una sesión
termine una tarea, marca la casilla y agrega el número del PR.
Las dependencias van entre corchetes. No empieces una tarea si sus dependencias no
están marcadas.

Leyenda: 👤 = requiere acción tuya (cuentas, claves, decisiones, assets).

---

## Hito 0 — Fundaciones
Objetivo: repo que compila, se testea y valida, con los contratos base definidos.

- [x] **T0.1 Esqueleto del monorepo.** (PR #1) pnpm workspaces (`client`, `editor`, `packages/*`,
  `tools/*`), `go.mod` en `server/` y `tools/bots`, Makefile con todos los targets de
  CLAUDE.md (aunque algunos digan "pendiente"), ESLint/Prettier/tsconfig base,
  golangci-lint, `.editorconfig`, workflow `ci.yml` (lint + test). README con cómo correr.
  Debe funcionar igual en la sesión cloud y en local (WSL2/macOS/Linux): agrega
  `scripts/local-setup.sh` (lo llama `make setup`), `deploy/docker-compose.dev.yml` con
  Postgres y los targets `make db-up` / `make db-down`. Ver `12-local-development.md`.
- [x] **T0.2 Protocolo v1.** (PR #3) `proto/game/v1/*.proto` con los mensajes de
  `05-network-protocol.md`, `buf.yaml`/`buf.gen.yaml`, generación Go y TS, test de
  ida y vuelta Go↔TS con golden files. [T0.1]
- [x] **T0.3 Esquemas de contenido.** (PR #4) JSON Schemas para balance, vocations, items,
  monsters, npcs, quests, spells, recipes, borders, i18n. Validador (`make validate`)
  con mensajes claros. Datos semilla: suelos básicos, 10 items, 3 monstruos, 1 NPC,
  `ids.lock.yaml`, i18n es/en. [T0.1]
- [x] **T0.4 map-format + mapcli básico.** (PR #8) Lectura/escritura canónica de chunks,
  islas y archivos auxiliares, validación (sección de 03), `mapcli info|fmt|validate|view`.
  Golden tests. Isla de prueba 64x64 en `world/islands/testisle/`. [T0.3]
- [x] **T0.5 Assets y spritepack.** (PR #5: spritepack; PR #77: pack Dungeon Crawl CC0 para 106 sprites, `tools/spritegen` con arte propio para el resto, NPCs con sprite y jugador animado en 4 direcciones) 👤 Tú bajas 1–2 packs CC0/CC-BY de 32x32 (ver
  `11-claude-code-workflow.md`) y los subes a `assets/vendor/`. La sesión arma
  `tools/spritepack` (atlas + JSON), generador de placeholders para sprites faltantes,
  `assets/CREDITS.md`, y mapea sprites a los items semilla. [T0.3]

## Hito 1 — Rebanada vertical (primer juego online)
Objetivo: entrar desde el navegador, caminar por una isla chica, matar monstruos, subir
skills, hablar con un NPC, hacer una quest, morir y reaparecer, con el editor básico.

**Servidor base**
- [x] **T1.1 Núcleo del servidor.** (#2) `clock`, game loop de 50 ms, cola de comandos,
  scheduler min-heap, harness `sim` y primeros tests deterministas. [T0.1]
- [x] **T1.2 Mundo en el servidor.** (#15) `mapcompile` → `world.bin`, carga, sectores,
  flags de tile, pathfinding A*, línea de visión. Benchmarks. [T1.1, T0.4]
- [x] **T1.3 Base de datos y cuentas.** (PR #9) Migraciones goose (accounts, characters,
  inventory, skills, quest_state, sessions, economy_log, cosmetics), sqlc, API HTTP de
  registro/login con email y contraseña, lista y creación de personajes. [T1.1]
- [x] **T1.4 Red y caminar.** (PR #23) Gateway WS, handshake, sesiones, AOI, Walk/WalkPath,
  FullMapView/MapSlice/CreatureMove, rate limits, logout y guardado. Bot mínimo que
  entra y camina (test de integración). [T0.2, T1.2, T1.3]

**Cliente base**
- [x] **T1.5 Cliente: login y mundo.** (PR #24) Vite + Pixi + Preact, `packages/renderer`,
  pantalla de login/creación de personaje, render de mapa con orden de capas, caminar con
  teclado y click, predicción e interpolación. Playwright con screenshot. [T1.4, T0.5]

**Jugabilidad**
- [x] **T1.6 Monstruos y combate cuerpo a cuerpo.** Spawns, IA por estados, objetivo,
  ataque cada 2 s, daño/armadura/defensa, muerte de monstruo, cadáver con loot, XP.
  Cliente: barras de vida, efectos, texto flotante, lista de batalla. [T1.4, T1.5]
- [x] **T1.7 Skills por uso y niveles.** Progreso de skills de armas, escudo y puños,
  experiencia y niveles, stats por vocación, regeneración. Panel de skills. Escenarios sim. [T1.6]
- [x] **T1.8 Items, inventario y contenedores.** Slots de equipo, mochila, mover items
  (suelo↔inventario↔contenedor), capacidad, usar items, mirar. UI de inventario. [T1.6]
- [x] **T1.9 Magia (Arcanista).** (PR #30) Maná, nivel mágico, 4 hechizos (ataque, área, curación,
  utilidad), palabras propias, cooldowns, hotkeys F1–F12, runas básicas. [T1.7, T1.8]
- [x] **T1.10 NPCs, diálogos, tiendas y quest.** (PR #31) Motor de diálogos YAML, ventana de
  diálogo, tienda compra/venta, motor de quests con pasos y flags, Capítulo 1 jugable.
  [T1.8]
- [x] **T1.11 Muerte y reaparición.** (PR #32) Reglas de muerte de balance.yaml, protección de
  novato, bendiciones compradas a NPC, cuerpo del jugador, templo. Autoguardado
  escalonado. [T1.7, T1.10]
- [x] **T1.12 Pesca y minería.** (PR #33) Skill de pesca, oficio de minería, recursos que se
  agotan y regeneran, herramientas. [T1.8]
- [x] **T1.13 Chat e i18n del cliente.** Canal local (decir, gritar, susurrar), canal
  global, mensajes del sistema por clave i18n, selector de idioma es/en. [T1.5]

**Editor e IA**
- [x] **T1.14 Map editor v1.** (PR #13) Funciones del hito 1 en `04-map-editor-and-ai.md`, con
  ops de map-format, deshacer/rehacer, validación en vivo, E2E. [T0.4, T0.5]
- [x] **T1.15 mapcli completo + mcp-world.** Todas las ops, `render` a PNG, `generate`
  procedural básico, servidor MCP registrado en `.mcp.json`. [T1.14] (#35)
- [x] **T1.16 Isla del Puerto.** Construir con mapcli/MCP la isla inicial (~192x192):
  ciudad con templo, puerto, tiendas, campo de lobos, cueva con mina y monstruos de
  nivel 5–15, un subsuelo. Validar, renderizar y revisar imágenes. [T1.15, T1.10, T1.12]
  Hecho: `world/islands/puerto` (192x192, pisos 7–8), ver "Islas actuales" en `03`.
  La ruta de barco a Bosque llegó con T3.6.

**Operación**
- [x] **T1.17 Prueba de carga.** `tools/bots` completo, escenario de 100 y 300 bots,
  reporte y ajustes de rendimiento. [T1.11] (resultados en `07-performance-budget.md`)
- [ ] **T1.18 Deploy alpha.** 👤 Necesita tu cuenta AWS y un dominio. docker-compose,
  Caddy, backups a S3, workflow de imágenes, guía paso a paso para el primer deploy. [T1.17] (parcial, PR #19: archivos listos, falta cuenta AWS y dominio)
- [x] **T1.19 Hosting de pruebas en casa.** Docker Compose del juego completo en tu PC
  expuesto con Cloudflare Tunnel o Tailscale, targets `make home-*`, guía para
  WSL2/macOS/Linux. Ver `13-hosting-de-pruebas.md`. [T1.5]
  - [x] Puesta al día tras T4.1–T4.5: `make home-up` de un comando (plantilla
    `deploy/env.home.template`, secretos, espera y URLs), `home-admin`, `home-restore`,
    `home-reset`, `.gitattributes` para WSL2, selector de servidor en la app de escritorio
    y ayuda de controles plegable a 960 px.

## Hito 2 — Cuentas completas, comunidad y escritorio
- [x] **T2.1 OAuth Google y Discord** 👤 (crear apps y claves), verificación de email,
  reset de contraseña, vincular cuentas. (#66, #67) Apagados hasta que el dueño ponga las
  claves de SMTP y de las apps (docs/13 pasos 8b y 8c). Pendiente: OAuth en la app de
  escritorio (navegador del sistema + deep link o loopback).
- [x] **T2.2 Editor v2.** Relleno, rectángulo, selección/copiar/pegar, autoborder,
  paneles de spawns/NPCs/zonas/portales.
- [x] **T2.3 Map patches.** Exportar/importar/aplicar, merge por casilla, vista de diff.
- [x] **T2.4 PR de mapas en CI.** Validación de parcelas y render antes/después
  comentado en el PR.
- [x] **T2.5 Cliente de escritorio Tauri** para Windows, macOS y Linux con release
  automático por tag.
- [x] **T2.6 Herramientas de admin.** Comandos de GM (teleport, crear item, kick, ban,
  anuncio), log de auditoría. Roles por cuenta asignados por el operador
  (`make set-role`), comandos `/` por chat validados en el loop, bans por cuenta con
  `Disconnect{BANNED}` y `audit_log` append-only escrito fuera del tick.

## Hito 3 — Contenido y las 4 vocaciones
- [x] **T3.1 Montaraz y Druida** con sus hechizos y equipo (#47).
- [x] **T3.2 Condiciones** (veneno, fuego, eléctrico, paralyze, haste, invisibilidad).
  Motor por eventos del scheduler, reglas en `balance.yaml`, invisibilidad filtrada en el
  servidor, persistencia de las de daño y `slowed`. Pendiente: campos en el suelo y
  antídoto como item.
- [x] **T3.3 Grupos** con experiencia compartida. Invitación con vencimiento, liderazgo,
  expulsión, salida al desconectar, experiencia compartida con anti-carry y bonus en
  `balance.yaml`, información filtrada por vista, chat de grupo y panel en el cliente. Los
  grupos no se persisten.
- [x] **T3.4 Herrería, leñador y cocina** con recetas y estaciones.
- [x] **T3.5 Barcos y viajes** entre islas con requisitos (#53). Rutas en
  `data/boat_routes.yaml` (nivel, quest, item o pasaje) ofrecidas por el diálogo del
  capitán, cobro atómico, bloqueo en combate, llegada libre o la más cercana, validación
  de muelles en `make validate`. Pendiente: viajar con el grupo.
- [x] **T3.6 Isla del Bosque** y Capítulo 2. (PR #54 contenido, PR #55 mapa y rutas)
  Isla `bosque` con Raigal, muelle, olmos talables, cuatro zonas de caza y cueva en el piso
  8; 5 monstruos, 4 NPCs, recetas de olmo y el Capítulo 2 en dos quests. Pendiente: arte
  real (todo es placeholder), depósito (no hay item), puertas.
- [x] **T3.7 Sonido y música** (assets libres) con volumen por canal. Motor Web Audio en
  `client/src/audio/` con canales, voces y sonido posicional; eventos → sonidos en
  `assets/sounds.yaml`. Hay 27 efectos y 3 loops de música (Puerto, Bosque y Cueva) más 2
  de ambiente, todos generados por `make sounds` (`tools/soundgen`, CC0), y el panel
  Opciones. Pendiente: sonidos de packs del usuario si los trae (`assets/README.md`) y
  probar Opus en el WKWebView de macOS. Desde el 2026-11-18 la música es la que el dueño
  eligió entre las tomas de Gemini (`make music-gemini`), con música del título y del
  guardián de la forja, y la toca el director de música (2026-11-18, pedido del dueño:
  temas enteros transmitidos, pools por lugar con las tres de Puerto y siete de cueva,
  arranque en un punto de entrada, fundidos de potencia constante y sin música de combate
  común; solo jefes o el área de una quest importante la cambian). Pendiente: que el dueño
  elija las versiones de cueva y escucharlo en el juego (docs/14).

## Hito 4 — Alpha pública
- [x] **T4.1 Anti-bot y anti-AFK.** Todo del lado del servidor; no hay anticheat en el
  cliente (`01-architecture.md`, "Trampas y anti-bot"). [T2.6]
  - **Señales por personaje.** Se calculan fuera del tick, o a costo constante dentro de
    él (`07-performance-budget.md`):
    - regularidad de los tiempos entre acciones (varianza demasiado baja);
    - reacciones inhumanas y constantes, como curarse siempre a los pocos ms de recibir
      daño;
    - rutas idénticas que se repiten;
    - sesiones muy largas sin pausas;
    - experiencia y oro por hora muy por encima de la mediana de su nivel.
  - **Puntaje de sospecha** con pesos y umbrales en `balance.yaml`. Las respuestas son
    graduales: registrar, avisar a los GM, pedir un chequeo de presencia dentro del juego
    (por ejemplo, un NPC que hace una pregunta) y suspender temporalmente. El ban lo decide
    siempre un GM (T2.6). Todo queda en el log de auditoría.
  - **Reportes de jugadores**, con un botón y un comando. Cada reporte adjunta contexto
    automático (posición y últimos eventos) y entra en una cola para los GM. Tienen rate
    limit para que no se usen como acoso.
  - **Log de economía.** Registra la creación y destrucción de oro e items por fuente:
    loot, NPC, trade y recolección. Alerta cuando no cuadra (posible duplicación) y cuando
    un personaje se aleja mucho de lo normal.
  - **Auditoría de información.** Tests que verifican que el servidor no manda lo que el
    jugador no puede ver: criaturas invisibles, pisos ocultos, cosas fuera de la ventana
    y vida exacta de otros.
  - **Simulación determinista con `tools/bots`.** Un bot con ritmo "humano" (pausas y
    variación) y otro "mecánico". El detector tiene que marcar al segundo y no al primero.
  - **Anti-AFK.** Revisar los límites que ya existen en el entrenamiento y la recolección
    (`02-game-design.md`) y agregar la desconexión por inactividad.
  - Hecha en dos PR: #57 (log de economía con cuadratura y atípicos, reportes, auditoría
    de información y sus arreglos, desconexión por inactividad) y la parte 2 (señales,
    puntaje de sospecha con respuestas graduales y chequeo de presencia, perfiles humano y
    mecánico en `server/pkg/bot` y `tools/bots -profile`).
- [x] **T4.2 Tutorial** guiado en la isla inicial.
  - Pasos como datos en `data/tutorial.yaml` (eventos fijos del servidor, texto i18n,
    resaltado opcional, filtro por vocación, premio chico), progreso en `quest_state`,
    mensaje `TutorialStep`/`TutorialSkip` y panel de pistas en el cliente. Termina al
    aceptar `ch1_shipwreck`; se puede saltar; los personajes previos no lo ven.
- [x] **T4.3 Landing page**, ranking (highscores), noticias.
  - Sitio público en `/` (build multipágina de Vite: landing, `/highscores`, `/news`) y el
    juego en `/play/`; `GET /api/status` (contador atómico del game loop) y
    `GET /api/highscores` (sqlc, cache de 60 s por filtros, excluye staff y cuentas
    deshabilitadas o baneadas); noticias en `data/news/*.yaml` validadas con esquema.
- [x] **T4.4 Observabilidad**: dashboard de métricas y alertas básicas.
  - Profile `monitoring` del compose (Prometheus, Alertmanager, Grafana y node-exporter;
    solo en 127.0.0.1, por túnel SSH) con config versionada en `deploy/monitoring/`.
    Dashboard provisionado; 14 alertas con umbrales en un solo archivo y tests de
    `promtool`; notificaciones a Discord, Telegram, webhook o email por variables de
    entorno. Métricas nuevas: `persistence_errors_total`, `players_online` y
    `http_requests_total`/`http_request_duration_seconds` por ruta. Métricas de backup por
    textfile. Pendiente: postgres_exporter y una métrica de la detección de bots.
- [x] **T4.5 Portal de envío de mapas** con cola de moderación que abre PR.
  - [x] Pendientes de T4.1/T4.4/T4.5/T2.1: aviso en el juego a los gm/admin por cada
    envío de mapa (agrupado), métricas `antibot_*` en Prometheus y su panel en el
    dashboard, cache de JWKS sin lock durante el fetch y `ConfirmPending` atómico.
  - [x] 1/2 (PR #63): envío desde el sitio (`/maps/submit`), "Mis envíos", cola de
    moderación para gm/admin con auditoría, chequeo del patch en Go
    (`server/internal/mappatch`), tabla `map_submissions` con el contrato para el worker.
    Licencia: CC BY 4.0 (docs/04, a confirmar por el dueño).
  - [x] 2/2: worker `tools/map-pr-worker` (Node, merge de `packages/map-format`, API Git
    Data, idempotente por rama `map-submission/<id>`), servicio `map-pr-worker` del compose
    (perfil `map-pr`, solo con token fine-grained), crédito en `world/CONTRIBUTORS.md`,
    fallas visibles en "Mis envíos". Pendiente: soporte de GitHub App (hoy token fijo) y
    avisar a los gm cuando llega un envío.

## Hito 5 — Post-lanzamiento
Objetivo: las piezas sociales y de economía que el modelo de datos ya contemplaba
(`00-vision.md`), más la segunda isla de contenido avanzado y el cliente táctil. Las
decisiones cerradas no cambian: monetización solo cosmética y móvil como plataforma
secundaria.

- [x] **T5.1 Gremios.** Fundar (costo en oro y nivel mínimo), nombre único validado,
  rangos líder/vicelíder/miembro, invitaciones que vencen, mensaje del día, canal de chat
  "Gremio", nombre bajo el personaje y página pública `/guilds`. Persistidos fuera del
  game loop. [T3.3, T2.6]
  - Hecha: `session/guild.go` (el loop carga todos al arrancar y escribe cada cambio en
    orden por la goroutine de admin), migración 00013 (`guilds`, `guild_members`,
    `guild_invites` y `guild_wars` vacía para T5.2), `GuildCommand`/`GuildUpdate`/
    `CreatureGuild`, `/guild ...`, `/guildrename` y `/guilddisband` auditados, `LookAt` de
    criaturas, panel y canal en el cliente, `/guilds` en el sitio. Pendiente: avisar a un
    jugador desconectado que lo expulsaron (hoy lo ve al entrar) y borrar de la base las
    invitaciones vencidas sin reiniciar.
- [x] **T5.2 PvP con skulls.** Zonas `pvp`/`no_pvp` del mapa, ataque entre jugadores,
  skulls por asesinatos injustificados con su castigo, y guerras de gremios sobre lo que
  T5.1 dejó preparado. [T5.1]
  - Hecha: `session/pvp.go` y `session/guildwar.go` (`balance.yaml pvp`), migración 00014
    (`pvp_kills`, `pvp_unjust_kills`, `guild_wars` con estados y `war_high`),
    `SetSafeMode`, `Creature.skull`/`CreatureSkull`, acciones de guerra en `GuildCommand`
    y `GuildUpdate.wars`, `/unskull` auditado, toda Puerto `no_pvp`, arena en Raigal,
    marca en el mapa y la lista de batalla, modo seguro y guerras en el panel del gremio.
    Después: una condición de otro jugador guarda a su autor (personaje) y el recuerdo de
    su ataque en `characters.conditions`, sin migración, y sobrevive al relogueo de
    cualquiera de los dos (su tiempo corre mientras la víctima está fuera); los hechizos de
    condición a distancia alcanzan a jugadores con las reglas de un ataque directo; un
    corte de la conexión por el servidor (cliente lento, reseteo de contraseña) con
    bloqueo deja al personaje link-dead. Las marcas ya tienen sprites propios
    (`assets/sprites/ui/marks/`, `client/src/render/marks.ts`).
- [x] **T5.3 Mercado global e intercambio directo.** Ventana de intercambio entre dos
  jugadores adyacentes con confirmación doble, y ofertas de compra y venta de items
  `tradeable` entre jugadores, con depósito, buzón y comisión en oro (sumidero),
  transaccional y con log de economía. [T4.1]
  - Hecha: `session/trade.go` y `session/market.go` (el loop tiene el mercado en memoria;
    cada movimiento es un `Transfer` del Saver que escribe los snapshots y el mercado en
    una transacción), migración 00015 (`market_offers`, buzón de items y de oro,
    `market_history`, `market_id_high`), `MarketCommand`/`MarketUpdate` y los mensajes de
    trade, `/marketoffers` y `/marketcancel` auditados, tableros en Puerto y Raigal,
    ventanas en el cliente. Pendiente: sprite del tablero, refrescar las ventanas abiertas
    de otros cuando cambia un libro que miran, y ocultar en el momento las ofertas de una
    cuenta suspendida por la herramienta del operador (hoy, desde el próximo arranque).
- [x] **T5.4 Casas.** Casas del mapa que se alquilan con oro, con lista de invitados y
  puertas; los items dentro persisten entre reinicios. [T5.1]
  Hecho: `houses.yaml` por isla (5 casas en el Farol y Raigal, `world.bin` v4), alquiler en
  la puerta con renovación desde el buzón del mercado, una casa por cuenta, invitados y
  gremio, transferir y dejar, items del suelo persistentes (`house_owners`, `house_guests`,
  `house_items`) escritos por transfers agrupados por tick, staff `/house*` y `/houses`.
- [x] **T5.5 Isla Volcánica y Capítulo 3.** Tercera isla con su mapa, monstruos, NPCs,
  recetas y la continuación de la historia. 👤 arte si se quiere reemplazar placeholders.
  [T3.6] (PR #73 contenido y monedas de plata y oro; el PR siguiente, mapa y rutas)
  Hecho: Brasal, muelle con rutas al Bosque y al Puerto, llano de ceniza, ladera, cráter y
  la mina del piso 8 con la puerta sellada y la forja antigua; 5 monstruos y un jefe,
  acero de ascua, Capítulo 3 (`ch3_embers` → `ch3_gate` → `ch3_warden`). Después: suelos
  volcánicos propios (ceniza, basalto, escoria, lava enfriada y lava fundida, con bordes),
  la superficie repintada, música y ambiente propios y los carteles de Brasal (templo,
  muelle y mina, que se leen mirándolos). Fuera de la tarea: puertas con llave (la puerta
  sellada de la mina se abre con la llave de ascua del Capítulo 3, ver
  `02-game-design.md` "Puertas con llave"). Después: el cartel de esa puerta (piso 8,
  junto a ella del lado de la mina, con texto nuevo), los carteles de Puerto y del Bosque
  con su item y los pozos de lava redibujados como manchas irregulares. Después (rama
  `feat/portals`): portales para cambiar de piso (`portals.yaml` por isla, `world.bin` v5):
  escaleras, escaleras de mano, agujeros, puntos de soga y teletransportes que mueve el
  servidor; las escaleras de la mina volcánica, del Puerto, del Bosque y de la isla de
  prueba ya se usan. Reglas en `02-game-design.md` "Cambiar de piso"; la llegada nunca cae
  en una casa ni en la sala de una puerta con llave. Después (rama `feat/portal-items`):
  arte propio e items de la escalera de mano (y su trampilla), el agujero, el punto de
  soga y el teletransporte; `make validate` exige en cada portal el item que lo muestra;
  lo que se tira sobre una escalera, un agujero o un teletransporte cae al otro extremo; y
  Ctrl+click derecho usa el item de arriba aunque esté sobre una escalera de mano.
- [x] **T5.6 Controles táctiles y cliente móvil.** Caminar, atacar y usar items con toques
  en el cliente web; UI que entre en pantallas chicas; build de Tauri mobile. 👤 las apps
  nativas necesitan cuentas de las tiendas (Apple y Google) y su firma. (PR #78)
  Hecho: gestos puros con tests (toque, toque largo, arrastre y pellizco) sobre pointer
  events; tocar una casilla camina, tocar una criatura la ataca y un NPC lo habla; toque
  largo = menú contextual (usar, abrir, mirar, mover, atacar, hablar); items con "tocar el
  item → tocar el destino" además del arrastre; pad direccional opcional en Opciones
  (mantener repite el paso). Layout por breakpoints como datos (`ui/layout.ts`):
  teléfono vertical con pestañas bajo el mapa, horizontal con cajón, tablet; encabezado de
  una línea (el mapa queda en 2x a 1280x800 con un nombre largo), avisos del servidor sobre
  el mapa, nombres que no se pisan a zoom 1x, hotbar con deslizador, ventanas como hojas
  con botón de cierre grande, objetivos de 44 px y foco visible. PWA instalable (manifest,
  íconos placeholder, service worker solo para el shell estático) y `apps/desktop`
  preparado para `tauri android/ios init` (`docs/15-movil.md`). E2E
  `client/e2e/mobile.spec.ts` con Pixel 7 (vertical y horizontal) e iPad Mini.
  Después (rama `fix/client-ux`): zoom del mapa por escalas enteras con el pellizco, botones
  +/− en pantallas táctiles y Ctrl+rueda en PC (recordado en el dispositivo; desde la
  vista ancha de 2026-11, rama `feat/wide-view`, por defecto la vista más grande que llena
  la caja a escala entera sin bajar de 15x11, y alejando hasta la ventana entera de 31x21,
  docs/02 "La vista");
  hotbar en dos líneas a la derecha del pad en vertical (4 slots en un teléfono de
  390–412 px); el chat del panel lateral ya no tapa el final del
  inventario a 1280x800; E2E también en WebKit (iPhone 13 e iPad Mini).
  👤 Pendiente: cuentas de Google Play y Apple Developer, firma (keystore, Team ID), y
  compilar y probar el APK/IPA en un dispositivo real (este PC no tiene Rust ni NDK).
- [x] **T5.7 Tienda cosmética con pasarela de pago.** Moneda premium, catálogo de
  `cosmetics` y compras en `account_cosmetics`, siempre sin ventaja de juego. Se arma
  contra el modo prueba del proveedor. 👤 elegir el proveedor de pagos y darle las claves
  de producción. (PR #80)
  Hecho: moneda premium "nácar" de la cuenta (no se intercambia, no pasa por el mercado ni
  se convierte en oro); `data/cosmetics.yaml` con 3 atuendos originales (marinero,
  batidor, noble), 4 colores y 2 efectos de nombre, y 3 paquetes en CLP, con esquema e
  i18n. `server/internal/payments`: proveedor falso (rechazado en producción) y Mercado
  Pago (checkout alojado, webhook con firma `x-signature`, consulta del pago);
  acreditación, compra, reembolso y contracargo en una transacción con
  `premium_ledger` append-only, idempotencia por `(provider, event_id)`, cuenta marcada si
  un reverso no alcanza, límite diario por cuenta. Protocolo: `Creature.cosmetics`,
  `CreatureCosmetics`, `CosmeticsState`, `EquipCosmetic`/`UnequipCosmetic`; staff
  `/premium` y `/purchases` auditados. Cliente: el canvas dibuja atuendo, tinte y efecto de
  nombre; panel "Apariencia" (también en las pestañas del teléfono); sitio `/shop` (saldo,
  paquetes, catálogo con vista previa, historial) enlazado solo si hay proveedor. Test de
  simulación que prueba que los cosméticos no cambian el combate; integración con Postgres
  (webhooks duplicados y compras concurrentes); E2E `client/e2e/shop.spec.ts` con el
  proveedor falso y un segundo jugador que ve el atuendo.
  👤 Pendiente: elegir el proveedor de producción y cargar sus claves (`PAYMENTS_PROVIDER`,
  `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `PAYMENTS_REF_SECRET`, `PUBLIC_URL`; docs/09). El adaptador de Mercado
  Pago solo se probó contra servidores falsos (httptest): falta una compra real en su
  modo prueba (sandbox) con un webhook que llegue desde internet. Copiar las variables
  nuevas a `deploy/.env.example` (la sesión no tenía permiso para editarlo).

## Extras (pedidos fuera de los hitos)
- [x] **Isla de Pruebas y `make play`.** Isla sandbox `pruebas` (96x96 en 2048,2048, pisos 7
  y 8) para probar todos los sistemas a mano: templo con instructora (experiencia, dinero,
  curación y la misión `pruebas_rats`), proveedor con herramientas, runas, equipo de cada
  vocación y la llave de la puerta de práctica, cinco corrales de caza de débil a fuerte,
  recolección y oficios, mercado, casa, puerta con llave, patio de portales con sótano (un
  portal de cada tipo), arena PvP y barquero de ida a las tres islas. Fuera del juego normal:
  `dev_only` en `world.yaml` (la imagen de producción no la compila; `mapcompile -dev` sí) y
  nada de las otras islas lleva a ella. Ops `add_text`/`remove_text` para `texts.yaml`.
  Guía: `16-probar-el-juego.md`.
  Después (rama `test/sandbox-sim`): el recorrido de la guía jugado por tests de simulación
  sobre el mundo real (`server/internal/session/sandbox_test.go`, docs/16 sección 8); la
  pala sale de la tienda de la isla (no tiene uso). Y para probar sin grindear: la
  instructora entrena el combate de cada vocación (skills y nivel mágico) y los oficios, y
  "Cúrame" llena también el maná, con las acciones de desarrollo `train_skill` y
  `restore_mana` (docs/06, "Diálogos"), que solo valen en NPCs de islas `dev_only`
  (`make validate`, arranque del servidor y al elegir la opción). `mapcompile -dev` marca
  esas islas en `world.bin` (v6) y el servidor no carga ese mundo con `RPG_ENV` de
  producción (docs/03).
- [x] **Balance de vocaciones e items (auditoría de contenido, rama `feat/balance-vocations`).**
  Brebajes de maná en las tres ciudades y una carrera simulada del 1 al 50 para arcanista,
  druida y montaraz con presupuesto de maná real (`sim/balance_vocations_test.go`); maza,
  arco, ballesta, varita y vara hasta la Isla Volcánica, y piezas de cabeza, piernas y pies;
  ballestas de una mano para que el montaraz lleve escudo; `tempest_ring` y `rime_burst`
  para las islas que resisten fuego y tierra; la comida regenera (`well_fed`); el sello de
  la forja para cada uno del grupo (botín `each_player`); la cuerda con destino (socavón de
  la playa del naufragio) y la pala fuera de la tienda, con una regla de `make validate`;
  bendiciones desde el nivel 9; varita inicial del arcanista; hechizos renombrados y textos
  pulidos. Lo que quedó de la auditoría: docs/14, "Pendientes conocidos".
- [x] **Progresión de hechizos y brebajes de vida (auditoría del 2026-11-18, rama
  `feat/spells-progression`).** El guardián tiene hechizos propios (una cura y dos golpes de
  área que escalan con el arma en la mano: `skill: weapon`) y cada vocación aprende hasta
  el nivel ~50 (9 hechizos nuevos, tabla en docs/02 "Hechizos por vocación"); brebaje de
  vida (110) y concentrado (250) por isla, sin recompra; la carrera simulada juega también
  al guardián y exige maná, nivel mágico y uso de cada hechizo. Lo que queda: docs/14,
  "Pendientes conocidos".
- [x] **Capacidad del mundo, casas y servicios (auditoría de contenido, rama `feat/world-capacity`).**
  Capacidad para unos 100 jugadores por franja de nivel (respawns más cortos, más monstruos
  y 20 spawns nuevos: de 43 a 109 jugadores efectivos, test `world-capacity.test.ts`,
  docs/07 "Capacidad del mundo") y 24 abedules más; casas: alquiler por tamaño y pueblo,
  13 casas, liberación tras 28 días sin que entre la cuenta del dueño (con aviso al entrar),
  bendiciones de 50 + 20 por nivel; la defensa del arma bloquea con la del escudo; regla
  de `make validate` para items sin fuente, sin comprador o de quest que siguen cayendo;
  tablero del mercado en Brasal; `testisle` dev-only y renombrada; comisión del mercado
  con tope de 50 000 y precio de referencia por mediana.
- [x] **Movimiento fluido (docs/17 A6; ramas `feat/movement-feel` y
  `feat/movement-more`).** Pasos de teclado predichos hasta `max_queued_steps` (4) y
  encolados en el servidor detrás de una época de caminata, con su número
  (`seq`/`walk_seq`, docs/05 "Caminar"); los pasos del servidor sobre su línea de ticks con
  colchón de jitter; cámara y criaturas a píxel de pantalla; diagonal con dos flechas;
  correcciones que se deslizan. Segunda parte (docs/17 §4, "Hecho: A6, segunda parte"):
  click previsto (el camino lo arma el cliente y lo camina como `Walk`, MOV-4), caminar
  manteniendo el mouse (MOV-3), anillo en el destino y texto de la acción junto al cursor
  (MOV-7), y el E2E de MOV-9 con ~150 ms de latencia simulada. El polvo y las ondas al
  pisar y el toque corto que solo gira (MOV-2), después: entrada de abajo.
- [x] **Criaturas animadas con Gemini (docs/17 SRC-4 #6 y SRC-5; rama `feat/gemini-creatures`).**
  Lobo, rata de sentina, cangrejo de marea, murciélago lóbrego, araña de musgo, sapo de
  ciénaga y espinoso con caminar, quieto, atacar y morir (sur, norte y oeste; el este
  espejado), una hoja de Gemini cada uno cortada con `tools/gemini/import_art.py`
  (`--cut rows|blobs`); pistas `mirror`, `anchor` y `ms` en spritepack; quieto y atacar solo
  hacia sus lados (embestida de ANI-5 en los otros); "Hecho con IA" en `/credits`. Lo que
  falta: docs/14, "Pendientes conocidos" (los demás animales y los ataques que no vinieron).
- [x] **Disparar, conjurar, desvanecerse, pasos y girar (docs/17 ANI y MOV; rama
  `feat/lpc-actions`).** Hojas `shoot` y `spellcast` de las 23 capas de LPC (46 archivos
  del mismo commit, con sus créditos por archivo) y el clip por `CreatureAttack.kind`;
  `TELEPORT` y `LOGOUT` se desvanecen; una muerte con reaparición a la vista deja el cuerpo
  cayendo; polvo y ondas al pisar por suelo (`steps`, partículas de A13); el toque corto
  que solo gira (MOV-2) y Ctrl+flecha; `11b-death` en primer plano. Lo que queda: docs/14,
  "Pendientes conocidos".
- [x] **Criaturas de Gemini, segunda tanda (docs/17 "Hecho: criaturas de Gemini"; rama
  `feat/gemini-creatures-2`).** Reptante hueco, escarabajo de mena y los cinco del Volcán
  (sabueso de ceniza, salamandra de brasa, gólem de escoria, dragoncillo de ascua y el
  custodio de escoria, jefe de 96x96) con caminar, quieto, atacar y morir; ningún monstruo
  queda con un solo frame de Dungeon Crawl. Escala revisada (ART-2, "Animales medianos"): el
  jabalí y el ciervo de spritegen pasan a 64x64 más grandes, con los pies en la casilla y la
  sombra de contacto. La gaviota sigue de spritegen (decisión del dueño).
- [x] **Motor de sprites (docs/17 "Motor de sprites"; rama `feat/sprite-engine`).** Pedido
  del dueño del 2026-11-18: `tools/spritegen/src/engine/` dibuja sprites desde un modelo
  con volumen (elipsoides, cajas, cilindros, cápsulas, extrusiones) y un rig de acciones
  con keyframes, con las reglas de docs/17 como datos en un solo lugar y puertas de calidad
  (paleta, alfa, tramado, contorno, tamaño y ancla de ART-2, siluetas, pistas de
  `sprites.yaml`) en `make test` y `spritegen check`; `spritegen sheet` deja la hoja de
  contacto y el lineup de cada sprite. El jabalí y el ciervo pasan a quieto, caminar,
  atacar y morir en cuatro direcciones; el eco de la forja (era Dungeon Crawl) y el yunque
  también salen del motor. Tras revisar las hojas, el jabalí ganó ancho de frente y de
  espaldas (puerta `frontWidth`) y el eco se rehízo como espíritu de fuego con forma de
  herrero y el martillo en alto. Después pasaron al motor el tablero del mercado (con una
  nota que se levanta con el viento: el `loop` de ART-7, `frame_<n>`), el cartel y el
  cajón; el bolardo no le ganó al dibujado a mano. Lo que queda: docs/14, "Pendientes
  conocidos".
- [x] **El equipo y el tooltip al estilo Diablo II (docs/17 UI-5 y UI-6, "Hecho: el equipo
  y el tooltip al estilo Diablo II"; rama `feat/equipment-d2`).** Los dos pedidos del dueño
  del 2026-11-18, solo cliente: el equipo es una figura sobre una grilla de 8x9 celdas con
  slots grandes (íconos a 2x cuando la ventana tiene lugar), los slots que aceptan lo que se
  arrastra brillan y el que no se tiñe de rojo, la mochila equipada se abre sola abajo de
  la figura (no durante el tutorial) y la capacidad es una barra; el tooltip sale al
  instante, compacto y centrado arriba del item o de la casilla del mapa. Lo que queda:
  docs/14, "Pendientes conocidos" (un campo en `ContainerOpen` que diga dónde está un
  contenedor haría exacta la mochila equipada).
- [x] **Pantalla completa, ventanas flotantes y la barra gótica (docs/17 A14; rama
  `feat/hud-fullscreen`).** Lo que pidió el dueño el 2026-11-18: en escritorio el mapa
  ocupa toda la pantalla (sin dock ni marco) y siempre la cubre a escala entera; abajo, la
  barra gótica con el orbe de vida y el de maná en engastes de hierro, la experiencia, la
  hotbar y la botonera; todas las ventanas (también el chat, translúcido, los contenedores y
  las del servidor) flotan donde el jugador las suelte, con imán a los bordes de la
  pantalla, de la barra y de las otras ventanas, y nunca quedan fuera ni bajo la barra;
  `rpg.windows` v3 (lee las de antes). Ornamentos de pixel art propio
  (`client/src/ui/ornaments.ts`). Lo que queda: docs/14, "Pendientes conocidos".
- [x] **Bloqueo de logout en combate (auditoría del 2026-11-18; rama
  `feat/pve-logout-lock`).** El bloqueo de logout del PvP vale para toda pelea: no se sale
  del juego a menos de `travel.combat_block_ms` (12 s) de un golpe dado o recibido
  (`combat.logout_locked`), y quien cierra la conexión en ese tiempo queda link-dead
  (atacable, presa de los monstruos, con sus condiciones, sin entrenar ni aportar al
  grupo) hasta que la pelea termina o pasa `travel.link_dead_max_ms` (2 min); una
  muerte así paga lo de siempre y sale con un solo guardado, y un relogueo retoma al mismo
  personaje con su pelea. Expulsiones, bans, guardados fallidos y el apagado sacan en el
  acto, como antes. `server/internal/session/linkdead.go`, docs/02 "Bloqueo de logout en
  combate". Lo que queda: docs/14, "Pendientes conocidos".
- [x] **Íconos de equipo del motor de sprites (docs/17 "Íconos de items"; lote 11, rama
  `feat/item-icons`).** Pedido del dueño del 2026-11-18: cada pieza del catálogo compacto
  con su propio sprite del motor. 86 íconos (las 78 piezas, las 6 retiradas y las dos
  municiones) con la clase `icon` (32x32 centrado, contorno oscuro, puertas de centrado y
  tamaño), un constructor por línea y una banda que se reconoce por su material y su acento
  (óxido, hierro, acero, acero de ascua con brasa, hueso y escamas con oro, acero de marea
  con runas); ninguna pieza de equipo usa ya un ícono de Dungeon Crawl. `spritegen sheet`
  deja las hojas en el slot del inventario a 1x y 2x. Lo que queda: docs/14, "Pendientes
  conocidos".
- [x] **Motor de quests: llegar a un lugar, tareas repetibles y diario de misiones (lote 12,
  rama `feat/quest-engine`; auditoría de juego del lote 10).** Lo que pide cada isla nueva:
  un paso `reach` (una zona del mapa o un punto con radio; cuenta al caminar, al
  reubicarse y al entrar, sin costo por tick), quests repetibles con espera
  (`repeatable: { cooldown_hours }`, recompensa cada vez, `quest_state` `available` y
  `cooling_down`) y el diario de misiones: el mensaje `QuestLog` y la ventana "Misiones"
  (tecla L; pestaña en teléfonos) con el paso actual, las muertes y la espera de una tarea.
  `world.bin` v7 guarda las zonas por id. Como prueba: el paso `reach_gate` de `ch3_gate`
  y la tarea de práctica de la Isla de Pruebas. Lo que queda: docs/14, "Pendientes
  conocidos" (las tareas de caza son de `feat/side-quests`).
- [x] **Libros y cofres (auditoría del 2026-11-19, game.items[12]; lote 12, rama
  `feat/chests-books`).** Explorar paga: nueve libros y pergaminos con lore propio (el
  imperio hundido, las islas, los capítulos 1 a 3) en los templos, el archivo de Casia, el
  atril de Velia, el naufragio, la cueva de los contrabandistas y la mina inundada, que se
  leen en una ventana del cliente sin pedirle nada al servidor; y cinco cofres de
  recompensa (bloque `chest`) que dan una vez por personaje, todo o nada, con lo de su
  banda, registrados en `economy_log` con la fuente `chest`. Arte del motor de sprites.
  docs/02 "Libros y cofres"; lo que queda: docs/14, "Pendientes conocidos".
- [x] **Pueblos amueblados y minas con luz (auditoría del 2026-11-19, art.items[0] y [3];
  lote 12, rama `feat/town-props`).** Un kit de doce props de una casilla del motor de
  sprites (barril y mesa con elevación, banco, estante, cama, farol con luz, pozo, sacos,
  red de pesca, jardinera, puesto de mercado y mástil con bandera; el toldo, la bandera y
  la llama del farol animados con `sync: tile`), los templos, plazas, depósito, tiendas y
  casas del Farol, Raigal y Brasal amueblados con `mapcli`, y el arte que no estaba en
  ningún mapa en su lugar: fuentes, braseros, estandartes, muros con ventana y una
  antorcha de pared cada 7 casillas en las tres minas. docs/17 "Kit de props de pueblo",
  docs/03 "Muebles y luces"; lo que queda: docs/14, "Pendientes conocidos".
- [x] **Quests secundarias y tareas de caza del Bosque y del Volcán (lote 12, rama
  `feat/side-quests`; auditoría de juego del lote 10).** Cinco quests secundarias para los
  huecos de nivel (22–28 en el Bosque; 30–33 y 42–48 en el Volcán) con NPCs que ya estaban,
  pasos `reach`, `flag_equals` y una que termina en su muerte, y seis tareas de caza de 20
  horas en Raigal y Brasal con dos NPCs nuevos (Fenn Zarzal y Orso Pedernal), todo en
  datos. Recompensas medidas contra la caza simulada (`sim/balance_tasks_test.go`; docs/02
  "Quests secundarias", "Tareas" y "Economía"). Lo que queda: docs/14, "Pendientes
  conocidos".
- [x] **Bordes de suelo que nunca se ven cuadrados (prueba del dueño del 2026-11-19; lote 13,
  rama `feat/terrain-borders`).** "Todo tiene cortes demasiado cuadrados": `data/borders.yaml`
  pasó de 7 reglas de a pares a una escalera de suelos (un borde por suelo natural, sobre
  todo suelo más bajo que toca; madera y muelles rectos), cada pieza con 4 looks de orilla
  irregular que el renderer elige por casilla con los mismos puntos de cruce en los lados, la
  orilla propia de cada suelo (matas de pasto, piedritas, terrones, juntas, granos) y la
  espuma debajo de los bordes en el agua; las cinco islas pasaron por `mapcli autoborder`.
  docs/06 "Bordes", docs/17 ART-4; lo que queda: docs/14, "Pendientes conocidos".
- [x] **Bandeja de estados y placa del nombre (prueba del dueño del 2026-11-19; lote 13,
  rama `feat/hud-status`).** Un ícono de pixel art propio por condición y por estado del
  servidor (`in_combat`, `pvp_locked`, `protection_zone`, nuevos en `PlayerConditions`) en
  una bandeja junto al chat (en teléfonos, una fila en el encabezado): marco verde o rojo,
  los segundos que quedan, un parpadeo en los últimos 5 s y un tooltip con qué hace. El
  nombre y el nivel pasan al medio, sobre la barra de experiencia, con el porcentaje en la
  barra y lo que falta para el nivel siguiente en su tooltip. docs/17 "Bandeja de estados",
  docs/02 "Estados del personaje"; lo que queda: docs/14, "Pendientes conocidos".
- [x] **Bolsillos (prueba del dueño del 2026-11-19; lote 13, rama `feat/pockets`).** Todo
  personaje tiene 4 bolsillos propios (`inventory.pocket_slots`), parte de él y nunca un
  item; la mochila equipada suma sus lugares. Lo que se recibe va primero a la mochila y
  después a los bolsillos, los pagos y chequeos leen los dos, y la muerte ya no da una
  mochila gratis: lo de los bolsillos cae con la mochila, en su misma tirada. Protocolo
  aditivo (`ItemLocation.pocket`, `Inventory.pockets`/`pocket_slots`), migración 00020 y la
  fila "Bolsillos" bajo la figura del inventario. docs/02 "Bolsillos"; lo que queda:
  docs/14, "Pendientes conocidos".
