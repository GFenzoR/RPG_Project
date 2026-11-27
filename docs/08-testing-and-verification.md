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

### Vista previa de la UI sin servidor (`make ui-preview`)
Para iterar sobre la interfaz sin Docker, Postgres ni el servidor del juego:
`make ui-preview` (o `ONLY=<escena>`) construye una página de vista previa
(`client/preview/`, `client/src/preview/`: solo con `RPG_UI_PREVIEW=1`, nunca va al build
normal) que monta la pantalla de juego con estados inventados
(`client/src/preview/fixtures.ts`) y un pedazo de Puerto dibujado por `mapcli render` en
lugar del canvas: las 33x23 casillas de la ventana del servidor con su margen, al tamaño y
la escala que tendría el canvas en la vista ajustada (la misma cuenta de
`render/zoom.ts`). `client/e2e/ui-preview.ts` la abre en Chromium respondiendo cada pedido
desde el build (no levanta servidores) y guarda en
`client/e2e/screenshots/actual/ui-preview/` las escenas `game`, `allwindows` (todas las
ventanas de la botonera abiertas a la vez: las que tienen otro lugar de fábrica lo toman,
docs/17 UI-5), `trade` (el intercambio, fuera de las casillas al norte del jugador),
`chattabs` (la pestaña Local del chat y líneas de otros canales que llegan después, con
sus puntos de no leído), `tutorialhelp` (el panel del tutorial se oculta con la Ayuda) y
`tutorialshop` (la tienda de un personaje del tutorial: el diálogo se acorta hasta el pie
del inventario a 960x700), `windows`, `magnet` (ventanas
borde con borde, como las deja el imán), `migrated` (un `rpg.windows` guardado con el dock de
antes: las ventanas acopladas flotan en su lugar de fábrica), `chat` (el chat bajo el mouse,
ya no translúcido), `server` (el
fogón y el intercambio como ventanas, unos restos abiertos flotando y el cuadro de
Mayús+arrastrar), `groundtip` (la ficha de un item del mapa bajo el mouse), `scale` (la
interfaz al 125 % con el texto al 115 %; la página toma `?ui=` y `?text=`), `options`,
`dialog`, `shop` (la tienda con dos páginas), `dialog18` (18 opciones sin scroll),
`itemmenu` (el menú del click derecho con la ficha), `inventory` (el equipo al estilo
Diablo II con una espada arrastrada encima: los slots que la aceptan brillan, el que no, rojo
bajo el puntero), `pockets` (sin mochila, como después de una muerte: los cuatro
bolsillos bajo la figura, con la ficha del brebaje de uno; docs/02 "Bolsillos"),
`inventoryfloat` (el inventario flotando y más ancho), `tooltip` y
`tooltipcoin` (la ficha compacta con el mouse sobre la espada de la mano derecha y sobre
las monedas de la mochila; en teléfono y tablet esas escenas abren la pestaña del
inventario), `guild` (la ventana del gremio), `danger` (vida baja y subida de nivel), `death`,
`login` y `characters` a
1920x1080, 1280x800, 1280x720, 960x700, un teléfono (390x844 y 844x390) y una tablet
(768x1024). No reemplaza a `make e2e`: no hay mapa real, ni red, ni criaturas en el canvas.
Sirve para revisar con Read el tema, el layout y las ventanas en todos los tamaños.

### Auditoría táctil (`client/e2e/touch-audit.ts`, lote 21)

Mide lo que un dedo puede alcanzar en la pantalla que la página muestra en ese momento. No
compara imágenes: recorre los controles (`button`, `a[href]`, `input`, `select`, `summary`,
los `role` de botón, pestaña, interruptor…) que están a la vista y de verdad reciben el
toque (`elementFromPoint`), y reporta:

| Hallazgo | Qué es |
|---|---|
| `tap` | Un control cuya área de toque mide menos de 44x44 px CSS (1 px de gracia por el redondeo). Se mide con pruebas de toque alrededor del centro, no con la caja: una casilla chica dentro de una etiqueta de 44 px cuenta por la etiqueta |
| `clip` | Un botón, pestaña, etiqueta o título cuyo texto no entra en su caja (también si lo corta un "…") |
| `offscreen` | Un control que se sale de la pantalla y que ningún contenedor desplaza |
| `overflow` | La página se desplaza de lado |
| `unsafe` | Con los *insets* de un notch y una barra de inicio emulados, un control cuyo centro queda debajo |
| `covered` (opcional) | Un control de tamaño suficiente que otro tapa en parte. Apagado por defecto (una hoja tapa el HUD a propósito); sirve para cazar solapamientos |

Dónde corre:

- **Sin servidor:** `make ui-preview AUDIT=1 SIZES=phone,tablet` audita cada escena en los
  cuatro tamaños táctiles (teléfono 390x844 y 844x390, tablet 768x1024 y 1024x768), deja el
  detalle en `build/ui-preview/touch-audit-<idioma>.json` y sale con error si hay
  hallazgos. `UILANG=en` cambia el idioma (los textos en inglés tienen otro largo),
  `NOTCH=1` dibuja con las áreas seguras de un teléfono con notch y barra de inicio (y
  activa `unsafe`), `COVERED=1` suma los solapamientos. Lo que se deja pasar está en
  `AUDIT_ALLOW` de `e2e/ui-preview.ts`, cada entrada con su motivo.
- **En el juego:** los tests "lote 21 QA on …" de `e2e/mobile.spec.ts` entran con toques en
  Pixel 7 vertical y apaisado (con *insets* de CDP), iPad Mini vertical y apaisado, e iPhone
  13 vertical y apaisado (WebKit), y auditan el login, la lista de personajes, el HUD, cada
  sección de la hoja, el menú, el tutorial y el diálogo de un NPC (capturas
  `mobile-qa-<dispositivo>-<pantalla>.png`). Un test nuevo de una pantalla táctil llama a
  `touchAudit(page)` y exige `[]`.

Una pantalla nueva para teléfonos entra a la auditoría con su escena en `make ui-preview`.

### Hojas de contacto (`client/e2e/contact-sheet.ts`)

Para revisar una corrida entera de capturas sin abrirlas una por una:

```
node --experimental-strip-types client/e2e/contact-sheet.ts   client/e2e/screenshots/actual/ui-preview phone-390x844 --per 14 --cols 7
```

arma hojas con las capturas cuyo nombre contiene ese texto, cada una con su nombre debajo
(en `<carpeta>/sheets/`, o `--out`). Se mira la hoja y se abre a tamaño real solo la
captura que se ve mal.

## Golden files
- `packages/map-format/testdata/golden/`: chunks de entrada y salida esperada.
- `proto`: un mensaje de ejemplo serializado en Go se decodifica en TS y viceversa.

## Fuzzing (lote 16)
Fuzz nativo de Go (`testing.F`) sobre lo que llega de afuera:

| Target | Paquete | Qué prueba |
|---|---|---|
| `FuzzClientFrame` | `server/internal/net/gateway` | Un frame cualquiera tras un handshake bueno, por el gateway real: uno malformado (texto, protobuf roto, sin `oneof`) termina en `KICKED`; cualquier otro deja la conexión contestando un `Ping` (`Logout` termina en `LOGGED_OUT`) |
| `FuzzInputDispatch` | `server/internal/session` | Cualquier `ClientMessage` decodificable contra un mundo con el `data/` real (dos personajes junto a los NPCs del puerto, lobos): ningún panic recuperado por el loop, la economía reconcilia y ningún cliente oye un ataque de una criatura que no conoce. Sus semillas cubren cada `oneof` en cero y en valores extremos (enteros máximos y mínimos, enums fuera de rango, strings largos con bidi) |
| `FuzzJSONRoutes` | `server/internal/httpapi` | Cualquier cuerpo en cada endpoint JSON (registro, login, personajes, `play`, OAuth start/link/pending, desvincular, verificar y resetear, tienda, webhook, entregas y revisión de mapas) contra fakes: nunca un 500 ni un error que no sea JSON con código. Cada pedido lleva lo que su ruta pide para pasar la puerta (sesión de jugador, sesión de staff para la revisión, cookie de un login de Google pendiente, firma del proveedor falso en el webhook), y `TestFuzzSeedsReachTheirHandlers` comprueba que cada semilla obtiene la respuesta de su handler y no un 401/403. `password/forgot` no tiene correo en ese armado: decodifica el cuerpo y contesta `email_disabled` |

- **Las semillas corren en `make test`** como tests normales (las de `f.Add` y las de
  `testdata/fuzz/<Target>/` si las hay); ahí no se muta nada.
- **`make fuzz`** muta cada target `FUZZTIME` (30 s por defecto) uno tras otro:
  `make fuzz FUZZTIME=10m` o uno solo con
  `make fuzz FUZZ_TARGETS=internal/session:FuzzInputDispatch`.
- Si encuentra algo, Go guarda la entrada en `testdata/fuzz/<Target>/` del paquete: se
  arregla, se commitea esa entrada (queda como test de regresión) y se nombra en el PR.
- `FuzzClientFrame` y `FuzzJSONRoutes` arman su servidor por entrada (decenas por segundo);
  `FuzzInputDispatch`, cientos. Un target nuevo se agrega a `FUZZ_TARGETS` del Makefile y a
  esta tabla.

## Auditoría de dependencias y secretos (lote 16)
`make audit` corre govulncheck (fijado en el Makefile) en `server`, `tools/bots`,
`tools/launcher` y `deploy/healthcheck` (falla solo si nuestro código llega a la función
vulnerable), `pnpm audit --prod --audit-level high` y gitleaks sobre la historia si está
instalado (si no, avisa y sigue; la CI lo corre siempre). Lo mismo corre en
`security.yml`. Un hallazgo se arregla subiendo la versión; si no es alcanzable o no
aplica, se explica en el PR y en `docs/18-seguridad.md`.

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
| `go (server)`, `go (tools/bots)`, `go (tools/launcher)` | gofmt, `go vet`, golangci-lint, `go test -race ./...` | — |
| `ts` | ESLint + Prettier, `pnpm typecheck`, Vitest | — |
| `validate` | `make validate` (contenido, i18n, mapas, IDs append-only) y `make test-parity` | — |
| `actionlint` | lint de `.github/workflows/` (actionlint fijado) y que cada `uses:` sea un commit de 40 hex (`.github/scripts/check-action-pins.sh`, con su autoprueba) | — |
| `livingworld-boundary` | `make lint-livingworld test-livingworld-boundary`: la frontera del mundo vivo (`livingworld/README.md`) y sus tests. Corre con cambios en `livingworld/`, `server/`, `client/`, `editor/`, `packages/`, `tools/` o `apps/` | — |
| `build` | `make build`: bundle de producción del editor y del cliente (`build/client`, con el atlas en `atlas/`) | — |
| `e2e` | E2E del editor y del cliente en Chromium, y los táctiles de `mobile.spec.ts` también en WebKit (Playwright 1.63.0 del workspace), con un service container `postgres:16` para el servidor; un reintento por test fallado y 40 min de tope (ver "E2E en la CI") | `e2e-screenshots`, `playwright-report` (también si falla) |
| `integration` | `make test-integration` contra un service container `postgres:16` (`TEST_DATABASE_URL`) | — |
| `bench` | `make bench`: benchmarks de `server/internal/game` y `server/internal/world` con `-benchmem` | `bench` (salida compatible con benchstat) + resumen en el run |
| `ci` | Espera a todos los jobs de arriba (`if: always()`) y falla si alguno falló o se canceló; saltado cuenta como aprobado. Es el check que `main` requiere (GitHub los elige por nombre de job; docs/18 "Checklist del operador") | — |
| `gemini` | `make test-gemini`: los tests de `tools/gemini` (Python 3.12 y Pillow; las herramientas de solo desarrollo que manejan el Gemini del dueño, ver `tools/CLAUDE.md`). Solo corre si cambia `tools/gemini/`, `tools/spritegen/src/palette.ts` o `assets/sounds/music/` (o la CI, el `Makefile`...); los tests con ffmpeg se saltan si el runner no lo tiene | — |

`security.yml` (lote 16, `contents: read`) corre en cada PR, en `main` y cada lunes, sin
filtro de rutas: `govulncheck` (matriz de los cuatro módulos Go), `pnpm-audit` (`pnpm audit
--prod --audit-level high`) y `gitleaks` (binario de la release con su SHA-256 verificado,
sobre toda la historia, con `.gitleaks.toml`), y el job final `security`, que espera a
los tres como `ci` y es el check requerido. Detalle y checklist en `18-seguridad.md`.

**Acciones fijadas por commit:** todo `uses:` va como `owner/repo@<sha de 40 hex> # vX.Y.Z`
(un tag se puede mover, un commit no). Para cambiar una versión, resolver el commit con
`git ls-remote https://github.com/<owner>/<repo> refs/tags/<tag>` (si el tag es anotado,
usar la línea `^{}`) y actualizar el comentario; dependabot (`.github/dependabot.yml`) abre
esos PR cada semana.

Además, dos workflows para los PR de mapas (T2.4, detalle en `04`, "PR de mapas en
CI"): `map-pr.yml` (`pull_request`, solo lectura; su YAML sale del PR, pero tal como está en la base corre el código de la rama base) corre `mapcli pr-check` y sube los
artefactos `map-pr-report` y `map-pr-renders`; `map-pr-comment.yml` (`workflow_run`
`requested` y `completed`, desde la rama por defecto) publica o actualiza un único
comentario en el PR y, si el PR va hacia la rama por defecto (y no hay otro PR abierto hacia ella con el mismo commit desde otro repo o autor), pone el status de commit
`map-pr/verdict` (pendiente mientras `map-pr` corre, después éxito o falla; en un PR que cambia
`world/`, un reporte calculado contra otra base que la punta actual de esa rama da falla). Ningún workflow usa `pull_request_target` (GitHub
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
**Hooks E2E (`window.__rpgClient`, `window.__rpgAudio`):** de solo lectura, existen solo en
el servidor de desarrollo de Vite (Playwright, `make dev`, `make play`) y en un build hecho
con `RPG_E2E_HOOKS=1`. Un build de producción (`pnpm build`, la imagen web del deploy y
del lanzador de docs/13) no los trae (lote 16: no le damos ayudas a un bot);
`client/vite/e2e-hooks.buildtest.ts` (en `make lint`, no en `make test`: hace dos builds) construye la página del juego y lo comprueba. Un E2E
contra un build (no contra el Vite de desarrollo) tiene que construirlo con esa variable.

`make e2e` corre también el E2E del cliente: Playwright levanta el servidor Go (compila
`world/` con `mapcompile` y lo arranca en `:18080` contra `DATABASE_URL`, que debe tener
Postgres arriba; aplica las migraciones solo) y el Vite del cliente en `:5176`, que hace de
proxy de `/api` y `/ws`. El test crea cuenta y personaje por la API, entra por la UI
(login con error y luego correcto, lista de personajes, Jugar), comprueba que el canvas usa
una escala entera y muestra al menos 15x11 casillas de la ventana de 31x21, camina 3 pasos con teclado (flechas y WASD, cada uno
predicho y confirmado) y 2 con click (el camino del cliente, cada paso un `Walk`
predicho), y sale del juego. Cualquier error de
consola o excepción no capturada hace fallar el test. Screenshots en
`client/e2e/screenshots/actual/` (`01-register` … `06-walked-click`); el job `e2e` los sube
junto con los del editor.

`client/e2e/movement.spec.ts` mide la fluidez: mantiene una flecha 2 s (4 o 5 pasos) por
una recta libre y lee las posiciones que el cliente dibujó en cada frame
(`__rpgClient.trail`). Falla si algún frame entre la primera y la última casilla se quedó
quieto o volvió atrás, o si dio más pasos de los que entran en el tiempo que la tecla
estuvo apretada, medido con `performance.now()` (screenshot `96-movement-held-key`, al
soltar la tecla, en el último paso: sacarlo con la tecla apretada alargaba el tiempo en
una CI lenta). Mide las posiciones del modelo
(`WorldState.drawPos` en cada `frame`), no el sprite ni la cámara en pantalla: su
redondeo a píxeles de pantalla lo cubre `client/src/render/viewport.test.ts`. El segundo
test del archivo hace lo mismo con ~150 ms de RTT y jitter en el WebSocket del juego
(docs/17 MOV-9): un proxy en Playwright (`page.routeWebSocket`, 75 ms más 0–40 ms por
sentido, en orden) entre la página y el servidor. Una flecha mantenida 10 casillas tiene
que tardar la suma de sus pasos (`__rpgClient.stepMs`) ± un frame; el botón izquierdo
mantenido unas casillas adelante y un click a 5–7 casillas tienen que caminar sin frames
quietos ni hacia atrás y salir menos de 150 ms después del botón (screenshots
`96b-movement-lag-mouse-held` y `96c-movement-lag-click`, con el anillo si la captura
llega a tiempo). La misma regla, con red simulada (latencia, jitter, 40 a 144 fps, tecla,
mouse mantenido y click previsto, un click y después una flecha, un rodeo tras un rechazo,
`Walk` perdidos, un corte de la red), la cubre `client/src/state/walking.test.ts` en
`make test`.

`client/e2e/view.spec.ts` revisa la vista ancha (`02-game-design.md`, "La vista"): a
1920x1080 (caja de 1920x992: la pantalla sobre la barra de abajo) entra a 2x y la cubre con
30x15,5 casillas (`__rpgClient.view()`: la ventana del `Welcome` y las casillas que muestra
el canvas; `zoom()` da `{min 1, fit 2, max 6}`), casillas a 11 a los lados y 7 arriba y
abajo en el canvas; Ctrl+rueda hacia abajo aleja a 1x con la ventana entera de 31x21
(992x672 px, casillas a 15 y 10 en el canvas, a 17 no) y se recuerda; hacia arriba
vuelve y lo olvida. A 1280x800 (caja de 1280x712), 2x con 20 columnas y algo más de 11
filas, y 1x con la ventana entera de 31x21 (casillas a 14 y 10 en el canvas). Screenshots `97-view-1920x1080`,
`97b-view-1920x1080-1x`, `98-view-1280x800` y `98b-view-1280x800-1x`.

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
  sobre el pad); `−` vuelve a la vista ajustada y la olvida; si se puede, `−` aleja una
  escala más (más casillas de la ventana de 31x21: en horizontal el ancho ya puede ser el
  de la ventana entera y gana filas; se recuerda, screenshot `08b-zoomed-out`) y `+`
  vuelve; un pellizco al doble de distancia acerca, y
  se vuelve con `−`. La vista ajustada muestra entre 15x11 y 31x21 casillas. Acercado, el mapa sigue
  dibujado (`mapDrawn`).
- Pixel 7 vertical además marca un lobo con un toque y espera golpes (vida que baja).
- En cada dispositivo, un toque sobre la sacerdotisa de Puerto abre su diálogo (estado
  del cliente y ventana), que entra en pantalla y se cierra con un botón de 44 px.
- **Nombres de los personajes de un E2E:** siempre `characterName("Etiqueta")` de
  `client/e2e/names.ts` (la etiqueta y letras al azar, 16 caracteres como mucho; lanza un
  error si la etiqueta no deja lugar). Ningún spec arma el nombre a mano: una etiqueta de
  8 letras más 8 al azar daba 17 y el servidor contestaba `invalid_name`.
  `client/vite/e2e-names.test.ts` (vitest, sin levantar nada) lo comprueba: en cada spec y
  en el smoke de escritorio (`apps/desktop/e2e/smoke.ts`), el nombre de cada personaje que
  se crea (un `POST /api/characters` o el campo "Nombre" del formulario) sale de
  `characterName`, sea cual sea la forma en que se arme a mano.
- **Nombres largos en la interfaz DOM:** `client/src/ui/fit-text.test.ts` prueba, sin
  navegador, que un nombre de 20 letras encoge hasta entrar en su caja, que en el piso se
  marca para partirse en líneas, que las reglas de `.vname`, `.hud .name` y
  `.touch-menu-name` no tienen `text-overflow` ni recorte, y que los tres elementos llevan
  el `ref` que ajusta.
- A 1280x800 (escritorio), un nombre de 16 caracteres (el máximo) con experiencia se ve
  entero en la placa sobre el orbe de vida y el mapa en 2x (`__rpgClient.scale()`); sin pad
  ni botones de zoom. Pantalla completa (docs/17 UI-4): el canvas empieza en (0, 0), tiene
  los 1280 px de ancho y termina justo donde empieza la barra de abajo (`hud-bar`); el chat
  queda sobre la barra y nada tapa el final del inventario ni del panel "Apariencia". A 2x
  el canvas llena la caja (20 columnas y algo más de 11 filas). Ctrl+rueda sobre el mapa
  sube a 3x (el canvas sigue sobre la barra y muestra menos casillas), la rueda al revés
  vuelve a 2x y luego aleja a 1x con la ventana entera de 31x21 (se recuerda), y vuelve; la
  rueda sin Ctrl no hace zoom.

Screenshots `client/e2e/screenshots/actual/mobile-<dispositivo>-NN-*.png` (`08-zoomed`: el
mapa una escala más cerca), `mobile-desktop-1280-long-name.png`,
`mobile-desktop-1280-full-screen.png` (el mapa a pantalla completa con la barra) y
`mobile-desktop-1280-zoom3.png` y `mobile-desktop-1280-zoom1.png` (la ventana entera); se
revisan con Read como los de escritorio. Corre
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
- **Cooldowns del servidor:** se cuentan en ticks, y el reloj del navegador no los mide.
  Dos acciones seguidas de un mismo jugador que un cooldown separa (dos usos de una
  puerta, `inventory.door_cooldown_ms`) llevan en el medio algo que el servidor marca en
  ticks, como los pasos de una caminata, nunca solo lo que tarde la página. "keyed doors"
  separaba dos usos de la puerta con el cierre de la página de otro jugador: con trace (en
  local Playwright lo guarda al cerrar) quedaban 0,6–1,8 s; sin trace (el primer intento
  en la CI) 0,15–0,25 s, y el servidor contestaba "Espera un momento antes de mover la
  puerta otra vez.". Y un test que cambia el mundo (abre una puerta) lo deja como lo
  encontró, así un `--repeat-each` o el reintento de la CI empiezan igual.
- **Fuentes:** el runner dibuja `system-ui` con DejaVu Sans, mucho más ancha que Segoe UI
  (Windows) o San Francisco (iOS). Un texto que "entra" en local puede salirse en la CI: el
  encabezado del iPhone 13 (390 px, WebKit) se salía ~20 px y `scrollWidth <=
  clientWidth` fallaba en #81 y en los dos intentos de #82. Para probar un layout de texto
  angosto en local, forzar `"DejaVu Sans", Verdana` (como hace `mobile.spec.ts`).
- **`ready` antes del primer frame:** el ticker de Pixi se salta un primer frame cuya hora
  es anterior a su arranque (página ocupada, lo normal en la CI), así que el primer dibujo
  puede llegar uno o más frames después de `__rpgClient.ready`. Antes la cámara recién se
  fijaba en ese dibujo: un `tileToClient` justo después de `ready` daba un punto a 100.000
  px, fuera del canvas, y el Mayús+click al cartel de Lanternby ("talk to NPCs", flaky en
  #82) no leía nada (y seleccionaba el nombre del encabezado). Ahora la cámara se fija al
  crear el canvas, y ese test comprueba, en el instante en que se publican los hooks, que
  la casilla propia cae dentro del canvas.
- **Páginas propias se cierran:** un test que abre páginas con `browser.newPage()` o
  `browser.newContext()` las cierra al final; el `browser` es del worker y lo que quede
  abierto sigue andando durante el resto de la suite. "a GM announces..." dejaba sus tres
  páginas (una con el juego corriendo); en la verificación del lote 5 el test siguiente
  ("T3.2") quedó en negro porque Vite rechazó un módulo (`ERR_CONNECTION_REFUSED` en
  `src/net/desktop.ts`, uno de los ~20 que la página pide a la vez al cargar `/play/`), y
  el `login-form` nunca apareció. No se reprodujo (6 pares seguidos con las páginas
  abiertas) y la corrida siguiente pasó entera; desde entonces las cierra. Si una página
  queda en negro, mira en el trace la red: un módulo con estado -1.
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
