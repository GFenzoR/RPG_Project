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
| `e2e` | E2E del editor y del cliente en Chromium, y los táctiles de `mobile.spec.ts` también en WebKit (Playwright 1.63.0 del workspace), con un service container `postgres:16` para el servidor; un reintento por test fallado y 40 min de tope (ver "E2E en la CI") | `e2e-screenshots`, `playwright-report` (también si falla) |
| `integration` | `make test-integration` contra un service container `postgres:16` (`TEST_DATABASE_URL`) | — |
| `bench` | `make bench`: benchmarks de `server/internal/game` y `server/internal/world` con `-benchmem` | `bench` (salida compatible con benchstat) + resumen en el run |

Además, dos workflows para los PR de mapas (T2.4, detalle en `04`, "PR de mapas en
CI"): `map-pr.yml` (`pull_request`, solo lectura, con el código de la rama base) corre `mapcli pr-check` y sube los
artefactos `map-pr-report` y `map-pr-renders`; `map-pr-comment.yml` (`workflow_run`
`requested` y `completed`, desde la rama por defecto) publica o actualiza un único
comentario en el PR y pone el status de commit `map-pr/verdict` (pendiente mientras
`map-pr` corre, después éxito o falla). Ningún workflow usa `pull_request_target` (GitHub
lo bloquea por defecto en repos públicos desde el 2026-12-02); las reglas de seguridad de
todos los workflows las comprueba `tools/mapcli/src/workflows.test.ts`, que corre en el
job `ts` también cuando el cambio solo toca `.github/workflows/`. Para probarlo en local sin GitHub:
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
- En cada dispositivo: layout esperado (`data-layout`) y nada que ensanche la página,
  también con el encabezado en una fuente ancha (`"DejaVu Sans", Verdana`: la de Linux, y
  Verdana, igual de ancha, lo reproduce en Windows y macOS): el ☰ queda en pantalla y vida
  y maná enteros (`headerFit`, screenshot `mobile-*-00-wide-font`); caminar tocando una casilla y con el pad (un toque = un paso, mantener = varios); mover
  la mochila al suelo con "tocar item → tocar destino" y devolverla con el toque largo
  ("Mover" → slot vacío), comprobando la casilla y el slot que manda el servidor; escribir
  en la pestaña del chat y ver el eco del servidor. La casilla se compara entera (la pila
  de antes más la mochila, y después la pila de antes): todos los tests táctiles nacen en
  el mismo lugar y caminan igual, así que uno que falló antes en la corrida (o el primer
  intento de un reintento) puede haber dejado su mochila ahí. Los items del suelo duran
  lo que dura el servidor.
- El toque largo mantiene el dedo 1,2 s: el menú abre a los 500 ms y el dedo se levanta
  mucho después, como en un runner lento. Con eventos táctiles de CDP, Chromium manda al
  levantar el dedo un click a lo que esté debajo, lo haya mantenido lo que lo haya
  mantenido (no hay `contextmenu` de toque largo); en un teléfono horizontal eso es el
  menú, que ocupa el alto. El menú solo acepta clicks después de un toque que empezó en
  él (`menuClickCounts`, ver client/CLAUDE.md). Antes ignoraba clicks durante 350 ms, y
  en la CI el dedo se levantó más tarde: el click eligió "Mirar" y el menú se cerró.
- En `Pixel 7` vertical y horizontal (Chromium), con un área segura de iPhone 13 puesta
  por CDP (`Emulation.setSafeAreaInsetsOverride`; la emulación de dispositivos no tiene
  insets): `.game` toma los insets como padding, el encabezado empieza en el inset de
  arriba, el cuerpo (el mapa y, en vertical, el panel de abajo) termina en el de abajo,
  la caja del mapa queda dentro y el pad,
  la hotbar, los botones de zoom y el banner del item elegido guardan su margen desde los
  bordes del mapa, sin sumar el inset otra vez (antes, 47 px de más en horizontal).
  Screenshot `mobile-pixel7-*-09-safe-area`. Lo que va fijo a la pantalla
  (`position: fixed`, fuera de ese padding) toma los insets una vez: el personaje despierta
  en Puerto (`psql`), habla con la sacerdotisa y la hoja del diálogo termina en los bordes
  del área segura (abajo, derecha y, en vertical, izquierda; en horizontal, arriba), con
  su "Cerrar" adentro (screenshot `10-safe-dialog`). En vertical la hoja llega a la
  última fila del pad y se dibuja encima (`overThePad`, una grilla de puntos sobre lo que
  comparten; también en `07-dialog` de cada dispositivo: en iPad Mini e iPhone 13 ya se
  tocaban, y antes el pad quedaba encima). Después acerca el mapa al máximo y
  mantiene el dedo en la primera columna del mapa: el menú del toque largo queda entero
  dentro del área segura, a 8 px de su borde izquierdo y no del de la pantalla (en
  horizontal, antes quedaba bajo la muesca; screenshot `11-safe-menu`).
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

### E2E del atlas que falla (`client/e2e/atlas.spec.ts`)
Cada request del atlas (`atlas.json`, el JSON de cada página y su imagen) se reintenta
sola con la política de `packages/renderer/src/retry.ts` (4 intentos, esperas de 0,5, 1 y
2 s). Dos tests de escritorio en Chromium con rutas de Playwright:
- **Falla una vez:** la primera request de cada archivo del atlas se aborta
  (`connectionrefused`) y la segunda pasa: el juego arranca igual (`ready`, mapa
  dibujado, sin el aviso de error). La imagen de la página solo cuenta si la ruta ve el
  `fetch` de PixiJS (puede venir de un worker); el fondo CSS de un icono nunca se aborta
  (el navegador no lo reintenta). Screenshot `atlas-00-flaky`.
- **Sigue fallando:** `atlas.json` falla siempre; tras los 4 intentos aparece el aviso
  (`load-failed`) con "Reintentar" (`load-retry`), sin canvas ni `__rpgClient`, y la sesión
  sigue abierta (vida en el encabezado, ningún batch del servidor vuelve a pedir el
  atlas). Con la red de vuelta, el botón arranca el canvas en la misma página (sin
  recargar ni volver a entrar). Screenshots `atlas-01-failed` y `atlas-02-retried`.

El editor tiene su versión en `editor/e2e/editor.spec.ts` ("the atlas does not load"): el
error con "Reintentar" y el mapa de vuelta sin recargar (screenshots `52-atlas-failed` y
`53-atlas-retried`).

### E2E en la CI
El job `e2e` corre en `ubuntu-latest`: 2 CPU y sin GPU, así que cada página dibuja WebGL
por software (SwiftShader) y la suite va varias veces más lenta que en un PC (en Windows,
`playwright.config.ts` usa la GPU por ANGLE/D3D11). Lo que pasa en local y falla ahí casi
siempre es una espera que dependía de la velocidad.
- **Reintentos:** con `CI` definido (GitHub lo pone), cada test que falla se corre una vez
  más (`retries: 1`) y, si pasa, el reporte lo marca `flaky`: se ve, no se esconde, y no
  tumba el job. Un `flaky` se investiga igual. `forbidOnly` hace fallar un `test.only`
  olvidado.
- **Trace:** en la CI solo el reintento graba trace (`on-first-retry`); el primer intento
  deja un screenshot del fallo y el `error-context.md`. Grabar trace filma la página y le
  quita CPU a un runner que no la tiene. En local se guarda el trace de cada fallo
  (`retain-on-failure`). Todo va en el artefacto `playwright-report` (con
  `test-results/`).
- **Tiempo:** el job tiene 40 min (la suite del cliente sola tardaba 13,5 min antes de
  los tests de WebKit). Un test con varias páginas de juego a la vez fija su propio
  `test.setTimeout` (por ejemplo "T5.4": tres jugadores y la lista de casas del sitio, que
  puede tardar su caché de 60 s), en vez de subir el de todos. `workers: 1`: los tests
  comparten servidor, base y lugares del mapa.
- **Reglas para tests nuevos:** nada de esperas fijas; esperar la condición (estado del
  servidor por `__rpgClient`, un request, `mapDrawn` antes de un screenshot). No suponer
  que el mapa está limpio: otro test pudo dejar items en el mismo lugar. Un gesto táctil
  de CDP manda un click al levantar el dedo sobre lo que haya debajo.
- **Fuentes:** el runner dibuja `system-ui` con DejaVu Sans, mucho más ancha que Segoe UI
  (Windows) o San Francisco (iOS). Un texto que "entra" en local puede salirse en la CI: el
  encabezado del iPhone 13 (390 px, WebKit) se salía ~20 px y `scrollWidth <=
  clientWidth` fallaba en #81 y en los dos intentos de #82. Para probar un layout de texto
  angosto en local, forzar `"DejaVu Sans", Verdana` (como hace `mobile.spec.ts`).
- **`ready` antes del primer frame:** el ticker de Pixi se salta un primer frame cuya hora
  es anterior a su arranque (página ocupada, lo normal en la CI), así que el primer dibujo
  puede llegar uno o más frames después de `__rpgClient.ready`. Antes la cámara recién se
  fijaba en ese dibujo: un `tileToClient` justo después de `ready` daba un punto a 100.000
  px, fuera del canvas, y el Mayús+click al cartel del Farol ("talk to NPCs", flaky en
  #82) no leía nada (y seleccionaba el nombre del encabezado). Ahora la cámara se fija al
  crear el canvas, y ese test comprueba, en el instante en que se publican los hooks, que
  la casilla propia cae dentro del canvas.
- **Ruido conocido:** líneas `[WebServer] [vite] ws proxy error: read ECONNRESET` (y
  `ws proxy socket error`). Las escribe el proxy de Vite cuando una página se cierra con
  su WebSocket abierto: el fin de un test, o el cierre de uno que se pasó de tiempo (en
  la CI de #80 salieron justo después del timeout de "T5.4" y al final de otro test que
  pasó). No son la causa de un fallo; el cliente no reconecta solo.

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
