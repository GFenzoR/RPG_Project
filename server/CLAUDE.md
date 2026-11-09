# server/ — servidor de juego en Go

Lee `docs/01-architecture.md` y `docs/07-performance-budget.md` antes de cambiar el game loop,
la red o la persistencia.

## Estructura
```
server/
  cmd/gameserver/      main: carga config, contenido, mapa compilado; arranca loop + HTTP + WS
  cmd/mapcompile/      compila world/ (JSON) a binario world.bin para carga rápida
  cmd/gameserver admin herramienta del operador: roles y log de auditoría (T2.6)
  internal/game/       game loop, tick, cola de comandos, scheduler de eventos
  internal/world/      tiles, pisos, sectores, islas, pathfinding (A* por casillas)
  internal/entity/     jugadores, monstruos, NPCs; IDs estables (uint32)
  internal/antibot/    señales de comportamiento y puntaje de sospecha (T4.1, puro)
  internal/combat/     daño y fórmulas (las condiciones viven en session/condition.go:
                       necesitan el scheduler, el AOI y los monstruos)
  internal/skills/     progreso de skills por uso, niveles, experiencia
  internal/ai/         (aún no existe: la IA de monstruos vive en session/monster.go porque
                       depende del índice de sectores y del AOI; separarla cuando crezca)
  internal/dialog/     motor de diálogos de NPC dirigido por YAML (puro: condiciones, costos)
  internal/quest/      estado de quests, flags (storage values) por personaje
                       (los NPCs en el mundo, tiendas y dinero viven en session/npc.go)
  internal/content/    carga y validación de data/*.yaml
  internal/net/        WebSocket, framing, (de)serialización protobuf, rate limits
  internal/session/    sesión de jugador: AOI, caminar, envío de deltas, ping, guardado
  internal/net/gateway/ WebSocket /ws: Hello, lector/escritor por conexión, rate limit
  internal/app/        ensambla loop + session + persistencia + gateway + API (main y tests);
                       admin.go: goroutine de auditoría y bans (T2.6)
  pkg/bot/             cliente sin UI para tests de integración y tools/bots (fuera de
                       internal/ para que otro módulo lo importe)
  internal/store/      PostgreSQL: repositorios generados con sqlc, migraciones goose
  internal/guild/      reglas puras de gremios: rangos, permisos y nombres (T5.1)
  internal/auth/       cuentas, contraseñas (argon2id), OAuth Google/Discord, tokens
  internal/httpapi/    API HTTP: login, lista de personajes, health; public.go: status y
                       ranking públicos con cache (T4.3)
  internal/mappatch/   chequeo de un map patch subido como entrada no confiable (T4.5, puro)
  internal/metrics/    métricas Prometheus (tick, red, proceso); /metrics en -metrics-addr
  internal/clock/      reloj inyectable (real y falso para tests)
  internal/sim/        harness de simulación determinista para tests
  migrations/          SQL de goose
  queries/             SQL de sqlc
```

## Reglas del servidor
- **Solo la goroutine del game loop muta el mundo.** Las goroutines de red envían
  `Command` por un canal con buffer y reciben `[]Event` ya serializables.
- Un panic dentro de un comando, evento o sistema se recupera en `game.Loop`, se registra
  con su stack y se descarta esa unidad; el tick sigue. No es licencia para usar `panic`.
- Todo lo temporal usa `clock.Clock` y el número de tick, nunca `time.Now()`.
- Aleatoriedad con un `*rand.Rand` sembrado e inyectado (deterministas en tests).
- Sin asignaciones en el hot path del tick cuando sea razonable: reutiliza slices,
  usa pools para buffers de red.
- El cliente nunca decide resultados: el servidor valida rango, línea de visión,
  cooldowns, capacidad, distancia de movimiento y velocidad.
- Rate limit por conexión (comandos por segundo) y desconexión ante abuso.
- Guardado de jugador: al salir y autoguardado escalonado cada 5 minutos fuera del tick
  (snapshot inmutable → goroutine de persistencia).
- Logs estructurados con `log/slog`. Métricas Prometheus en `/metrics` (solo interno).
- **Economía (T4.1):** todo camino que crea, destruye o saca de un personaje oro o items
  lo dice con `econItem`/`econGold` (fuente `Econ*` de `session/economy.go`), y lo que pasa
  entre un personaje y el suelo con `Player.ground`. Los tests de `session` reconcilian en
  cada tick: si te olvidas, falla `economy mismatch`.
- **Tutorial (T4.2):** `session/tutorial.go`. Un evento nuevo del tutorial necesita una
  constante `content.Trigger*`, su caso en `Tutorial.Check`, el enum del esquema y una
  llamada `w.tutorialEvent(p, evento, ref)` donde el evento ya ocurrió y fue validado.
  `tutorialEvent` cuesta una comparación para quien no está en el tutorial (`Player.tut`).
- **Sitio público (T4.3):** `GET /api/status` lee `session.World.PublishedOnline` (un
  `atomic` que el loop actualiza al entrar o salir un jugador) y `App.running`; nunca
  llames a métodos "Loop goroutine only" desde un handler. `GET /api/highscores` usa
  `queries/highscores.sql` vía `store.Highscores` (el `app` la conecta si el `Store` la
  implementa) con una cache de 60 s por filtros en `httpapi`. Ninguna query del ranking
  puede ordenar todos los personajes: cada una lee un índice y corta en la página (costos
  en docs/07); si cambias una, mírala con `EXPLAIN ANALYZE` sobre muchos personajes. Las
  exclusiones (staff, deshabilitadas, baneadas) viven en las queries: si agregas borrado
  de personajes, filtra ahí.
- **Portal de mapas (T4.5):** `httpapi/mapsubmit.go` + `store/mapsubmissions.go` +
  `mappatch`. El patch es entrada no confiable: `mappatch.Validate` sigue las reglas de
  `parsePatch` (rutas con el fixture compartido `packages/map-format/src/patch/testdata/
  paths.json`) y es más estricto donde Go y JS leerían distinto. Sus errores son códigos
  fijos, nunca texto del patch. El merge y las parcelas no se hacen en Go: los hace el
  check del PR (TS). El rol de moderación se lee en cada pedido y otra vez en la
  transacción de la decisión; toda acción va a `audit_log` con fuente `web`. La cola del
  worker es la tabla (contrato en la migración 00010 y en docs/04).

- **Emails de la cuenta (T2.1):** `internal/mail` (Mailer SMTP/log, `Queue` con su propia
  goroutine, plantillas de `i18n/<idioma>/email.yaml`) + `auth/email.go` + `httpapi/email.go`
  + `store/accounttokens.go`. Un token de enlace nunca va a un log, a una URL que vea el
  servidor ni a la base en claro (solo SHA-256). Sin `Config.Mail` todo se comporta como
  antes: cualquier chequeo nuevo de "email verificado" pasa por `Service.RequireVerified`.
  `forgot` contesta igual para cualquier email y trabaja en segundo plano: no agregues
  respuestas ni tiempos que dependan de la cuenta.

- **OAuth (T2.1 2/2):** `internal/oauth` (protocolo: URL con PKCE, canje del code, `id_token`
  de Google contra JWKS, `/users/@me` de Discord; `oauthtest` es el proveedor falso de los
  tests y de `cmd/fakeoauth`) + `auth/oauth.go` (reglas de cuentas) + `httpapi/oauth.go` +
  `store/oauth.go`. Nunca vincules una identidad por coincidencia de email; todo login
  emite la sesión con `Service.loginAccount`; toda ruta de vuelta pasa por
  `auth.SafeReturn`; el `redirect_uri` sale de `PUBLIC_URL`.

- **Gremios (T5.1):** `session/guild.go` + `guild` (puro) + `store/guilds.go` +
  `httpapi/guilds.go`. El loop es dueño de todos los gremios: `app` los carga una vez
  (`GuildStore.LoadGuilds`) antes de arrancar y cada cambio sale como `AdminJob{Kind:
  AdminGuild}` por `queueAdmin` (en orden, nunca se pierde); nada vuelve al loop. No leas
  gremios de la base desde el loop ni desde un handler del juego. Un cambio nuevo necesita
  su `GuildOp` en `session` y en `store` (mismos valores) y su caso en `applyGuild`. Todo
  comando de gremio pasa por `chatAllowed`. Si un jugador recibe o pierde un gremio,
  llama a `announceGuild` (el nombre bajo el personaje) y `queueGuildSend`. Lo que sale
  por `/api/guilds` es público: nunca el mensaje del día ni quién está en línea.

## Tests
- `go test ./...` debe correr sin red ni Postgres (usa fakes).
- Tests de integración con Postgres llevan build tag `integration` (`make test-integration`,
  usa `TEST_DATABASE_URL`, por defecto la base `rpg_test`). Cada paquete abre su propio
  schema con `internal/store/storetest`, así corren en paralelo sin pisarse.
- Para lógica de juego, prefiere tests de simulación con `internal/sim`: crea un mundo
  pequeño, inyecta comandos, avanza N ticks y verifica el estado.
- Benchmarks del tick en `internal/game/bench_test.go` y con N jugadores caminando en
  `internal/session/bench_test.go` (`make bench-tick`); no deben empeorar más de 10%.
- Mapas de prueba chicos con `internal/world/worldtest` (dibujos ASCII).

## Base de datos
- Migraciones goose en `migrations/` (embebidas en el binario; el servidor aplica las
  pendientes al arrancar). Nueva migración: `make migrate-new NAME=...`. Nunca edites una
  migración ya mergeada: crea otra.
- Queries en `queries/*.sql` → `make gen-sqlc` → `internal/store/db` (generado, se
  commitea). `internal/store` envuelve las queries y traduce errores de Postgres a
  errores propios (`store.ErrNameTaken`...); los servicios dependen de interfaces para
  poder testearse sin Postgres (ver `internal/auth/authtest`).
