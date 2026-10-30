# server/ — servidor de juego en Go

Lee `docs/01-architecture.md` y `docs/07-performance-budget.md` antes de cambiar el game loop,
la red o la persistencia.

## Estructura
```
server/
  cmd/gameserver/      main: carga config, contenido, mapa compilado; arranca loop + HTTP + WS
  cmd/mapcompile/      compila world/ (JSON) a binario world.bin para carga rápida
  internal/game/       game loop, tick, cola de comandos, scheduler de eventos
  internal/world/      tiles, pisos, sectores, islas, pathfinding (A* por casillas)
  internal/entity/     jugadores, monstruos, NPCs; IDs estables (uint32)
  internal/combat/     daño, fórmulas, condiciones (veneno, fuego, paralyze)
  internal/skills/     progreso de skills por uso, niveles, experiencia
  internal/ai/         comportamiento de monstruos (máquina de estados simple)
  internal/dialog/     motor de diálogos de NPC dirigido por YAML
  internal/quest/      estado de quests, flags (storage values) por personaje
  internal/content/    carga y validación de data/*.yaml
  internal/net/        WebSocket, framing, (de)serialización protobuf, rate limits
  internal/session/    sesión de jugador: AOI, envío de deltas, ping
  internal/store/      PostgreSQL: repositorios generados con sqlc, migraciones goose
  internal/auth/       cuentas, contraseñas (argon2id), OAuth Google/Discord, tokens
  internal/httpapi/    API HTTP: login, lista de personajes, health, métricas
  internal/clock/      reloj inyectable (real y falso para tests)
  internal/sim/        harness de simulación determinista para tests
  migrations/          SQL de goose
  queries/             SQL de sqlc
```

## Reglas del servidor
- **Solo la goroutine del game loop muta el mundo.** Las goroutines de red envían
  `Command` por un canal con buffer y reciben `[]Event` ya serializables.
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

## Tests
- `go test ./...` debe correr sin red ni Postgres (usa fakes).
- Tests de integración con Postgres llevan build tag `integration`.
- Para lógica de juego, prefiere tests de simulación con `internal/sim`: crea un mundo
  pequeño, inyecta comandos, avanza N ticks y verifica el estado.
- Benchmarks del tick en `internal/game/bench_test.go`; no deben empeorar más de 10%.
