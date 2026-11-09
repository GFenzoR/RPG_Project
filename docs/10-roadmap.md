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
- [ ] **T0.5 Assets y spritepack.** (parcial, PR #5: falta integrar packs del usuario) 👤 Tú bajas 1–2 packs CC0/CC-BY de 32x32 (ver
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
  Opciones. Pendiente: sonidos de packs del usuario si los trae (`assets/README.md`),
  música de combate y probar Opus en el WKWebView de macOS.

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
    Pendiente: que una condición recuerde a su autor tras un relogueo,
    hechizos de condición a distancia contra jugadores y sprites de las marcas.
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
- [ ] **T5.5 Isla Volcánica y Capítulo 3.** Tercera isla con su mapa, monstruos, NPCs,
  recetas y la continuación de la historia. 👤 arte si se quiere reemplazar placeholders.
  [T3.6]
- [ ] **T5.6 Controles táctiles y cliente móvil.** Caminar, atacar y usar items con toques
  en el cliente web; UI que entre en pantallas chicas; build de Tauri mobile. 👤 las apps
  nativas necesitan cuentas de las tiendas (Apple y Google) y su firma.
- [ ] **T5.7 Tienda cosmética con pasarela de pago.** Moneda premium, catálogo de
  `cosmetics` y compras en `account_cosmetics`, siempre sin ventaja de juego. Se arma
  contra el modo prueba del proveedor. 👤 elegir el proveedor de pagos y darle las claves
  de producción.
