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
- [ ] **T1.6 Monstruos y combate cuerpo a cuerpo.** Spawns, IA por estados, objetivo,
  ataque cada 2 s, daño/armadura/defensa, muerte de monstruo, cadáver con loot, XP.
  Cliente: barras de vida, efectos, texto flotante, lista de batalla. [T1.4, T1.5]
- [ ] **T1.7 Skills por uso y niveles.** Progreso de skills de armas, escudo y puños,
  experiencia y niveles, stats por vocación, regeneración. Panel de skills. Escenarios sim. [T1.6]
- [ ] **T1.8 Items, inventario y contenedores.** Slots de equipo, mochila, mover items
  (suelo↔inventario↔contenedor), capacidad, usar items, mirar. UI de inventario. [T1.6]
- [ ] **T1.9 Magia (Arcanista).** Maná, nivel mágico, 4 hechizos (ataque, área, curación,
  utilidad), palabras propias, cooldowns, hotkeys F1–F12, runas básicas. [T1.7, T1.8]
- [ ] **T1.10 NPCs, diálogos, tiendas y quest.** Motor de diálogos YAML, ventana de
  diálogo, tienda compra/venta, motor de quests con pasos y flags, Capítulo 1 jugable.
  [T1.8]
- [ ] **T1.11 Muerte y reaparición.** Reglas de muerte de balance.yaml, protección de
  novato, bendiciones compradas a NPC, cuerpo del jugador, templo. Autoguardado
  escalonado. [T1.7, T1.10]
- [ ] **T1.12 Pesca y minería.** Skill de pesca, oficio de minería, recursos que se
  agotan y regeneran, herramientas. [T1.8]
- [ ] **T1.13 Chat e i18n del cliente.** Canal local (decir, gritar, susurrar), canal
  global, mensajes del sistema por clave i18n, selector de idioma es/en. [T1.5]

**Editor e IA**
- [x] **T1.14 Map editor v1.** (PR #13) Funciones del hito 1 en `04-map-editor-and-ai.md`, con
  ops de map-format, deshacer/rehacer, validación en vivo, E2E. [T0.4, T0.5]
- [ ] **T1.15 mapcli completo + mcp-world.** Todas las ops, `render` a PNG, `generate`
  procedural básico, servidor MCP registrado en `.mcp.json`. [T1.14]
- [ ] **T1.16 Isla del Puerto.** Construir con mapcli/MCP la isla inicial (~192x192):
  ciudad con templo, puerto, tiendas, campo de lobos, cueva con mina y monstruos de
  nivel 5–15, un subsuelo. Validar, renderizar y revisar imágenes. [T1.15, T1.10, T1.12]

**Operación**
- [ ] **T1.17 Prueba de carga.** `tools/bots` completo, escenario de 100 y 300 bots,
  reporte y ajustes de rendimiento. [T1.11]
- [ ] **T1.18 Deploy alpha.** 👤 Necesita tu cuenta AWS y un dominio. docker-compose,
  Caddy, backups a S3, workflow de imágenes, guía paso a paso para el primer deploy. [T1.17] (parcial, PR #19: archivos listos, falta cuenta AWS y dominio)
- [ ] **T1.19 Hosting de pruebas en casa.** Docker Compose del juego completo en tu PC
  expuesto con Cloudflare Tunnel o Tailscale, targets `make home-*`, guía para
  WSL2/macOS/Linux. Ver `13-hosting-de-pruebas.md`. [T1.5]

## Hito 2 — Cuentas completas, comunidad y escritorio
- [ ] **T2.1 OAuth Google y Discord** 👤 (crear apps y claves), verificación de email,
  reset de contraseña, vincular cuentas.
- [ ] **T2.2 Editor v2.** Relleno, rectángulo, selección/copiar/pegar, autoborder,
  paneles de spawns/NPCs/zonas/portales.
- [ ] **T2.3 Map patches.** Exportar/importar/aplicar, merge por casilla, vista de diff.
- [ ] **T2.4 PR de mapas en CI.** Validación de parcelas y render antes/después
  comentado en el PR.
- [ ] **T2.5 Cliente de escritorio Tauri** para Windows, macOS y Linux con release
  automático por tag.
- [ ] **T2.6 Herramientas de admin.** Comandos de GM (teleport, crear item, kick, ban,
  anuncio), log de auditoría.

## Hito 3 — Contenido y las 4 vocaciones
- [ ] **T3.1 Montaraz y Druida** con sus hechizos y equipo.
- [ ] **T3.2 Condiciones** (veneno, fuego, eléctrico, paralyze, haste, invisibilidad).
- [ ] **T3.3 Grupos** con experiencia compartida.
- [ ] **T3.4 Herrería, leñador y cocina** con recetas y estaciones.
- [ ] **T3.5 Barcos y viajes** entre islas con requisitos.
- [ ] **T3.6 Isla del Bosque** y Capítulo 2.
- [ ] **T3.7 Sonido y música** (assets libres) con volumen por canal.

## Hito 4 — Alpha pública
- [ ] **T4.1 Anti-bot y anti-AFK** (detección de patrones, límites, reportes).
- [ ] **T4.2 Tutorial** guiado en la isla inicial.
- [ ] **T4.3 Landing page**, ranking (highscores), noticias.
- [ ] **T4.4 Observabilidad**: dashboard de métricas y alertas básicas.
- [ ] **T4.5 Portal de envío de mapas** con cola de moderación que abre PR.

## Hito 5 — Post-lanzamiento
- Mercado global · Tienda cosmética con pasarela de pago · PvP con skulls · Casas ·
  Gremios · Cliente móvil (controles táctiles + Tauri mobile) · Isla Volcánica y
  Capítulo 3.
