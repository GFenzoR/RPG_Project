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
  - en los PR, `image` solo compila para amd64, sin QEMU, y solo si cambia un Dockerfile
    o lo que la imagen del worker de PR de mapas corre tal cual (`tools/map-pr-worker/`,
    `packages/map-format/`, `packages/content-schema/`; T4.5). En ese caso también arranca
    el contenedor del worker sin token y con `--self-check` (`on.pull_request.paths` de
    `images.yml` incluye `tools/map-pr-worker/**` y `pnpm-workspace.yaml`);
  - `stack` ya compila las imágenes del gameserver y la web para cualquier cambio de la
    app;
  - `home-stack` solo corre por cambios en `deploy/`;
  - el paso `monitoring config` de `deploy-lint` (T4.4: `deploy/monitoring/check.sh`, con
    `promtool`, los tests de las reglas, `amtool`, la ruta `/grafana/` de Caddy con
    credenciales a medias y el JSON del dashboard) solo corre si cambia
    `deploy/monitoring/`, `deploy/docker-compose.yml` o los archivos de Caddy de esa ruta. En local es
    `make monitoring-check`;
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
| `e2e` | E2E del editor y del cliente en Chromium, y los táctiles de `mobile.spec.ts` también en WebKit (Playwright 1.63.0 del workspace), con un service container `postgres:16` para el servidor | `e2e-screenshots`, `playwright-report` (también si falla) |
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

### E2E móvil (T5.6)
`client/e2e/mobile.spec.ts` corre el juego en dispositivos emulados de Playwright, con el
mismo servidor y Vite del E2E de escritorio (de `devices[...]` se toman tamaño, densidad,
`isMobile` y `hasTouch`; el navegador lo pone el proyecto):
- **Chromium** (proyecto `chromium`, el de todos los E2E): `Pixel 7` (vertical),
  `Pixel 7 landscape` y `iPad Mini` (vertical).
- **WebKit** (proyecto `webkit-mobile`, como Safari en iOS): `iPhone 13` (vertical),
  `iPhone 13 landscape` e `iPad Mini`. Toma solo los tests de `mobile.spec.ts` cuyo
  título dice `(webkit)`; sus screenshots empiezan con `mobile-webkit-`. Necesita
  `pnpm exec playwright install webkit` (`make setup` y el CI lo instalan; en Linux,
  `--with-deps`). Sin WebKit instalado, o con `CLIENT_E2E_WEBKIT=0`, el proyecto queda
  fuera con un aviso y Chromium corre solo. El WebKit de Playwright funciona en Windows
  (WebGL incluido); avisa en consola que no conoce `interactive-widget` del viewport,
  pero eso pasa al cargar la página, antes de que el test empiece a contar errores.
  Ese WebKit descarta la cookie `Secure` en `http://localhost` (Chromium la guarda): el
  servidor principal del E2E corre con `-cookie-secure=false`, si no el login no se
  mantiene. En Windows además muestra negro el canvas WebGL en los screenshots apenas
  cambia de tamaño (un zoom o un resize, igual que antes del zoom), aunque se dibuje: los
  `mobile-webkit-*-08-zoomed.png` salen con el mapa negro. Por eso el test lee unos
  píxeles del buffer justo después del frame (`mapDrawn`) en vez de fiarse de la imagen.

Todo con toques: `page.touchscreen.tap` en los dos navegadores. El toque largo, el pad
mantenido y el pellizco usan, en Chromium, eventos táctiles de CDP
(`Input.dispatchTouchEvent`), que llegan como `pointerType: "touch"`. WebKit no tiene
CDP y Playwright solo toca: ahí son `PointerEvent` sintéticos de tipo `touch` sobre el
elemento bajo cada dedo. El primer dedo usa el id 1, el único que `setPointerCapture`
acepta en un evento sintético; el pad captura su dedo.
- En cada dispositivo: layout esperado (`data-layout`) y nada que ensanche la página;
  caminar tocando una casilla y con el pad (un toque = un paso, mantener = varios); mover
  la mochila al suelo con "tocar item → tocar destino" y devolverla con el toque largo
  ("Mover" → slot vacío), comprobando la casilla y el slot que manda el servidor; escribir
  en la pestaña del chat y ver el eco del servidor.
- En vertical, la hotbar muestra al menos 4 slots enteros a la derecha del pad, bajo el
  mapa y sin nada encima.
- En cada dispositivo, el zoom del mapa: `+` sube una escala entera y se recuerda
  (`localStorage` `rpg.zoom`); el canvas sigue dentro de la caja del mapa (en vertical,
  sobre el pad); `−` vuelve a la escala que muestra las 15x11 casillas y la olvida; un
  pellizco al doble de distancia acerca, y se vuelve con `−`. Acercado, el mapa sigue
  dibujado (`mapDrawn`).
- Pixel 7 vertical además marca un lobo con un toque y espera golpes (vida que baja).
- En cada dispositivo, un toque sobre la sacerdotisa de Puerto abre su diálogo (estado
  del cliente y ventana), que entra en pantalla y se cierra con un botón de 44 px.
- A 1280x800 (escritorio), un nombre de 20 caracteres con experiencia deja el encabezado
  en una línea y el mapa en 2x (`__rpgClient.scale()`); sin pad ni botones de zoom. El
  final del inventario y del panel "Apariencia" se ven sobre el chat al desplazar la
  columna lateral. Ctrl+rueda sobre el mapa sube a 3x (el canvas llena la caja del mapa y
  queda dentro) y la rueda al revés vuelve a 2x; la rueda sin Ctrl no hace zoom.

Screenshots `client/e2e/screenshots/actual/mobile-<dispositivo>-NN-*.png` (`08-zoomed`: el
mapa una escala más cerca), `mobile-desktop-1280-long-name.png`,
`mobile-desktop-1280-side-end.png` (la columna lateral al final) y
`mobile-desktop-1280-zoom3.png`; se revisan con Read como los de escritorio. Corre
dentro de `make e2e`. Los E2E de escritorio siguen igual y deben quedar en verde: ningún
cambio táctil altera el mouse ni el teclado. La PWA no entra en el E2E (Vite de desarrollo
no registra el service worker); su lógica se prueba con Vitest (`client/src/pwa.test.ts`,
`client/src/sw/policy.test.ts`).

### E2E de la tienda (T5.7)
`client/e2e/shop.spec.ts` usa el servidor principal del E2E, que corre con
`RPG_ENV=development` y `PAYMENTS_PROVIDER=fake` (`playwright.config.ts`). Patrón nuevo:
el **proveedor de pagos falso**. El checkout devuelve una URL local
(`/api/shop/fake-checkout/<sesión>`); el sitio le hace `POST` con la sesión del comprador
(solo esa cuenta puede pagarla; un `GET` no paga), lo que paga por el mismo camino del
webhook, con firma válida, y después va a `/shop?checkout=success`. Así el test pasa por
la vuelta completa, como con un proveedor real, sin red externa. El test comprueba
también que un `GET` del enlace y otra cuenta no cambian nada.
- Cada jugador usa su propio `browser.newContext()` (cookies separadas): el comprador en
  el sitio, el comprador en el juego y un segundo jugador que mira.
- El test inicia sesión en `/shop` y compra un paquete con el checkout falso. Después
  compra un atuendo (con el `confirm` del navegador aceptado y otro rechazado) y prueba un
  saldo insuficiente (409, el único error de consola esperado). Compara la página con
  `GET /api/shop`.
- Con el comprador en el juego, una compra en el sitio llega como `CosmeticsState`
  (push). Equipa desde el panel Apariencia y el segundo jugador ve los cosméticos en
  `__rpgClient.players()`. Al volver al atuendo por defecto, el otro también lo ve.
- Screenshots `63-shop-desktop`, `64-shop-phone` (375 px, sin scroll horizontal),
  `65-appearance-panel`, `66-shop-buyer` y `67-shop-watcher`.
- Sin esperas fijas: cada paso espera el request que dispara (el `POST` de la compra y el
  `GET /api/shop` que la sigue) o el estado que empuja el servidor. Cuenta los `POST` de
  compra (un `confirm` rechazado no manda ninguno) y revisa el texto del `confirm`
  fuera del handler del diálogo (un `expect` que falla ahí deja el diálogo abierto y
  cuelga el click). Equipa de a un cosmético y espera que el segundo jugador vea al
  comprador antes de cambiar nada. Las cargas de página y los pushes entre navegadores
  esperan hasta 30 s (el test corre tarde en un E2E completo, con tres contextos y dos
  sesiones de juego; 180 s en total).
- La misma regla vale para "Play leads to the login and into the game" de
  `site.spec.ts`: la primera carga de `/play/` en un contexto nuevo pide a Vite todos los
  módulos del juego y una vez pasó los 5 s del `expect` por defecto al final de un E2E
  completo. Ahora espera el `GET /api/characters` del login, hasta 30 s por cada carga, y
  la casilla propia más dos frames dibujados en vez de 300 ms fijos antes del screenshot.

### Audio (T3.7)
- **Unitarias** (`client/src/audio/*.test.ts`): el motor corre sobre un `AudioContext`
  falso que registra ganancias, fuentes y rampas. Se prueban los canales y sus volúmenes,
  el silencio, el desbloqueo tras el primer gesto, la caché de decodificación, el límite de
  voces, la atenuación y el paneo, y el fundido cruzado de loops. También el mapeo
  mensaje → evento (`cues.ts`) y que `assets/sounds.yaml` cubra los eventos principales.
- **Contenido**: `make validate` valida `assets/sounds.yaml` contra
  `sounds.schema.json`. Comprueba además que existan los archivos, que cada pack de
  `vendor/` tenga su fila en `CREDITS.md`, que cada referencia apunte a un sonido del canal
  correcto y que las islas existan.
- **Generador** (`tools/soundgen`): mismos samples en cada render, duración exacta de los
  loops y el presupuesto de tamaño (07). No encoda: la CI no necesita ffmpeg.
- **E2E** (`T3.7: sound starts…`): en headless no se escucha nada, así que se espía
  `AudioBufferSourceNode.prototype.start`. El test comprueba que nada empiece antes del
  primer gesto, que al entrar suenen el loop y el ambiente de la isla, que los clicks y
  los pasos programen reproducciones, que un canal silenciado no gaste voz y que el slider
  y el silencio persistan tras recargar. Screenshots: `34-sound-options` a
  `36-sound-options-login`.

## Checklist del PR
- [ ] `make lint test validate` pasa
- [ ] Tests nuevos para la lógica nueva
- [ ] Screenshots revisados (si hubo cambios visuales)
- [ ] Docs actualizados si cambió un contrato
- [ ] Tarea marcada en `docs/10-roadmap.md`
