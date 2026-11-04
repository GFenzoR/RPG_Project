# 08 — Testing y verificación

Claude Code trabaja casi siempre sin que nadie mire. Por eso cada tarea debe tener una
forma **automática** de comprobar que funciona. "Se ve terminado" no cuenta.

## Pirámide de pruebas
| Nivel | Herramienta | Qué cubre |
|---|---|---|
| Unitarias Go | `go test ./...` | Fórmulas, pathfinding, inventario, diálogos, parsers |
| Simulación determinista | `server/internal/sim` | Escenarios de juego completos con reloj falso |
| Integración Go | `go test -tags integration` | Postgres real, migraciones, login, guardado |
| Unitarias TS | Vitest | map-format, ops, validación, estado del cliente |
| Contrato | Golden files | Mismo mapa guardado por editor y mapcli = idéntico; proto Go/TS compatibles |
| E2E visual | Playwright | Cliente y editor reales en Chromium, screenshots |
| Carga | `tools/bots` | Rendimiento del servidor (ver 07) |
| Contenido | `make validate` | YAML, mapas, i18n, IDs |

## Simulación determinista (la herramienta más importante)
```go
func TestWolfDropsPeltEventually(t *testing.T) {
    s := sim.New(t, sim.WithSeed(42), sim.WithMap("testdata/arena_small"))
    p := s.SpawnPlayer("guardian", sim.Level(10), sim.At(10, 10, 7))
    w := s.SpawnMonster("wolf", sim.At(12, 10, 7))
    s.Command(p, game.SetTarget{ID: w.ID})
    s.RunUntil(func() bool { return w.Dead() }, sim.MaxSeconds(120))
    require.True(t, s.Player(p).Skill(skills.Sword).Progress > 0)
}
```
- El reloj y la aleatoriedad son inyectados: el mismo seed da el mismo resultado.
- Mapas de prueba pequeños en `server/testdata/`.
- Cada mecánica nueva (hechizo, condición, regla de muerte) llega con un escenario sim.

## E2E visual con Playwright
`make e2e`:
1. Levanta Postgres, servidor con una base de prueba y mapa de prueba, cliente con Vite.
2. Crea cuenta y personaje por la API.
3. Abre el cliente en Chromium (viewport 1280x800), entra, camina 5 pasos, abre el
   inventario, habla con un NPC.
4. Guarda screenshots en `client/e2e/screenshots/` y compara con referencias
   (tolerancia pequeña). También captura errores de consola: cualquier error = falla.

Para el editor, `editor/e2e` abre una isla de prueba, pinta, deshace, guarda y compara
el archivo y la imagen.

**Claude debe abrir los screenshots con la herramienta Read** cuando cambia algo visual,
y describir en el PR qué vio.

## Golden files
- `packages/map-format/testdata/golden/`: chunks de entrada y salida esperada.
- `proto`: un mensaje de ejemplo serializado en Go se decodifica en TS y viceversa.

## CI (GitHub Actions)
Workflow `ci.yml` en cada PR y en cada push a `main`. Los jobs corren en paralelo y una
corrida nueva de la misma rama cancela la anterior (`concurrency`). Caché de pnpm
(`setup-node`) y de módulos/build de Go (`setup-go`).

**Solo corre lo que el cambio necesita**, para ahorrar minutos de Actions.
- El job `changes` corre `.github/scripts/ci-changes.sh`. Ese script compara el PR contra
  su base (o el push contra el commit anterior) y decide qué jobs corren. Las reglas están
  en el script, que se autoverifica con `--test` en cada corrida.
- Un job saltado cuenta como aprobado para los checks requeridos.
- Algunos ejemplos:
  - un PR solo de docs no corre ningún job;
  - uno del editor corre `ts`, `validate`, `build` y `e2e`;
  - uno del servidor corre los jobs de Go, `integration`, `e2e` y el `stack`;
  - `desktop`, que compila Rust, solo corre por `apps/desktop/` o por el puente de red del
    cliente (`client/src/net/`, `client/package.json`).
- Corren todos los jobs cuando el cambio toca la CI, el `Makefile`, el lockfile o la
  config del workspace, cuando no se puede calcular el diff (por ejemplo, tras un force
  push) y al lanzar `ci.yml` a mano (`workflow_dispatch`).
- En `images.yml` el criterio es este:
  - en los PR, `image` solo compila para amd64, sin QEMU, y solo si cambia un Dockerfile;
  - `stack` ya compila las imágenes del gameserver y la web para cualquier cambio de la
    app;
  - `home-stack` solo corre por cambios en `deploy/`;
  - en `main` y en los tags de versión se compila y publica todo, multi-arch.
- Una regla nueva va en el script, con su caso en `self_test`. Ante la duda, el patrón
  pertenece al job: equivocarse ahí solo cuesta minutos.

| Job | Qué corre | Artefactos |
|---|---|---|
| `go (server)`, `go (tools/bots)` | gofmt, `go vet`, golangci-lint, `go test -race ./...` | — |
| `ts` | ESLint + Prettier, `pnpm typecheck`, Vitest | — |
| `validate` | `make validate` (contenido, i18n, mapas, IDs append-only) y `make test-parity` | — |
| `actionlint` | lint de `.github/workflows/` (actionlint fijado) | — |
| `build` | `make build`: bundle de producción del editor y del cliente (`build/client`, con el atlas en `atlas/`) | — |
| `e2e` | E2E del editor y del cliente en Chromium (Playwright 1.63.0 del workspace), con un service container `postgres:16` para el servidor | `e2e-screenshots`, `playwright-report` (también si falla) |
| `integration` | `make test-integration` contra un service container `postgres:16` (`TEST_DATABASE_URL`) | — |
| `bench` | `make bench`: benchmarks de `server/internal/game` y `server/internal/world` con `-benchmem` | `bench` (salida compatible con benchstat) + resumen en el run |

Además, dos workflows para los PR de mapas (T2.4, detalle en `04`, "PR de mapas en
CI"): `map-pr.yml` (`pull_request`, solo lectura, con el código de la rama base) corre `mapcli pr-check` y sube los
artefactos `map-pr-report` y `map-pr-renders`; `map-pr-comment.yml` (`workflow_run`) publica
o actualiza un único comentario en el PR. Para probarlo en local sin GitHub:
`make map-pr BASE=main HEAD=<rama>` deja el reporte y los PNG en `build/map-pr/` e imprime
el Markdown del comentario.

El job `bench` **no falla por tiempos**: los runners compartidos son ruidosos. Por ahora la
regla de "no empeorar más de 10 %" (ver 07) se comprueba a mano: descargar el artefacto
`bench` del PR y el del último run de `main`, y comparar con
`benchstat main.txt pr.txt`. Las asignaciones (`allocs/op`) sí son estables: cualquier
subida en el hot path del tick se explica en el PR.

### E2E del cliente (`client/e2e`)
`make e2e` corre también el E2E del cliente: Playwright levanta el servidor Go (compila
`world/` con `mapcompile` y lo arranca en `:18080` contra `DATABASE_URL`, que debe tener
Postgres arriba; aplica las migraciones solo) y el Vite del cliente en `:5176`, que hace de
proxy de `/api` y `/ws`. El test crea cuenta y personaje por la API, entra por la UI
(login con error y luego correcto, lista de personajes, Jugar), comprueba que el canvas es
15x11 casillas con escala entera, camina 3 pasos con teclado (flechas y WASD, cada uno
predicho y confirmado) y 2 con click (`WalkPath`), y sale del juego. Cualquier error de
consola o excepción no capturada hace fallar el test. Screenshots en
`client/e2e/screenshots/actual/` (`01-register` … `06-walked-click`); el job `e2e` los sube
junto con los del editor.

## Checklist del PR
- [ ] `make lint test validate` pasa
- [ ] Tests nuevos para la lógica nueva
- [ ] Screenshots revisados (si hubo cambios visuales)
- [ ] Docs actualizados si cambió un contrato
- [ ] Tarea marcada en `docs/10-roadmap.md`
