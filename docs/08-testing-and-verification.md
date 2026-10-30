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
Workflow `ci.yml` en cada PR: lint, tests Go y TS, validate, build del cliente y editor,
E2E con Playwright, y un benchmark corto del tick. Los artefactos (screenshots, reporte
de bots) se suben al run.

## Checklist del PR
- [ ] `make lint test validate` pasa
- [ ] Tests nuevos para la lógica nueva
- [ ] Screenshots revisados (si hubo cambios visuales)
- [ ] Docs actualizados si cambió un contrato
- [ ] Tarea marcada en `docs/10-roadmap.md`
