# 14 — Continuar en tu PC (traspaso de la sesión cloud, noviembre 2026)

Hasta el 10 de noviembre de 2026 el desarrollo siguió en una sesión cloud que coordinaba
sesiones hijas: cada una hizo una tarea del roadmap en un PR, y la coordinadora corría
los checks y la revisión de cada PR antes de mergearlo. Este doc deja todo listo para
seguir con Claude Code en tu computador. El entorno local está en
`12-local-development.md`, y el hosting de pruebas en casa, en `13-hosting-de-pruebas.md`.

## Dónde quedó
- **Hitos 0 a 4:** completos, salvo T1.18 (deploy en AWS), que es tuya. T0.5 (sprites)
  quedó hecha en local (PR #77).
- **Hito 5:** hechas T5.1 a T5.5 (PRs #69 a #74):
  - gremios;
  - PvP con skulls y guerras de gremios;
  - mercado global e intercambio directo;
  - casas;
  - Isla Volcánica, con el Capítulo 3 y las monedas de plata y oro.
- **T5.6** (controles táctiles, layout para pantallas chicas, PWA y Tauri mobile
  preparado) está en el PR #78. Lo 👤: cuentas de las tiendas, firma y
  compilar el APK/IPA (`docs/15-movil.md`).
- **T5.7** (tienda cosmética con pagos) está hecha en la rama `feat/t5.7-cosmetic-shop`
  (PR #80): moneda "nácar", catálogo, proveedor falso y Mercado Pago, panel
  "Apariencia" en el juego y `/shop` en el sitio. Lo 👤: elegir el proveedor de
  producción y sus claves, y una compra real en el modo prueba del proveedor.
- **El roadmap está completo** salvo lo que es tuyo (tabla de abajo).
- Sin placeholders de sprites: 106 salen del pack Dungeon Crawl (CC0,
  `assets/vendor/dungeon-crawl/`) y el resto es arte propio de `tools/spritegen`
  (`make spritegen`), incluido el jugador (outfit `citizen`, 4 direcciones con caminata).

## Primer arranque en tu PC
1. Sigue "Instalar una vez" de `12-local-development.md`. En Windows, usa WSL2 con el repo
   dentro de WSL, o la vía "Windows nativo" del mismo doc (repo en `C:\`, Git Bash).
2. Corre `make setup`, `make db-up` y `make dev`, y abre `http://localhost:5173/` (sitio) y
   `http://localhost:5173/play/` (juego).
3. Para que otros entren desde tu red o desde internet, usa `make home-up` (`13-hosting-de-pruebas.md`).
4. Juega 10 minutos y anota lo que se siente mal. Es lo que la IA no puede juzgar sola. Lo
   más rápido es `make play`: la Isla de Pruebas tiene todos los sistemas a unos pasos del
   templo y una instructora que da experiencia, entrenamiento, dinero y curación
   (`16-probar-el-juego.md`).

## Lo que es tuyo 👤
| Qué | Para qué | Dónde está explicado |
|---|---|---|
| Confirmar CC BY 4.0 para los mapas que manda la comunidad | Portal de mapas (T4.5) | `04-map-editor-and-ai.md` |
| Cuenta de AWS y dominio | T1.18: servidor público | `09-deployment-aws.md` |
| Apps OAuth de Google y Discord, y SMTP | Login social y emails (T2.1) | `12-local-development.md` |
| Cuenta bot de GitHub (token classic con `public_repo`, fuera de MAINTAINERS) | Que los mapas aprobados se vuelvan PRs | `09-deployment-aws.md` |
| Protección de la rama `main` (check requerido: el status `map-pr/verdict`, fuente GitHub Actions; `.github/CODEOWNERS` con "Require review from Code Owners" y "Dismiss stale pull request approvals when new commits are pushed"; "Allow GitHub Actions to create and approve pull requests" apagado) y la variable `DESKTOP_SERVER_URL` del repo | Seguridad y builds de escritorio | `04-map-editor-and-ai.md` "PR de mapas en CI", `09-deployment-aws.md` |
| Copiar a `deploy/.env.example` las variables nuevas que lista docs/09 | Configuración del deploy | `09-deployment-aws.md` |
| Cuentas de Apple y Google Play (opcional) | Apps móviles nativas (T5.6) | `15-movil.md` |
| Elegir el proveedor de pagos | T5.7 en producción | brief de T5.7 |
| Decidir si la vocación "Druida" / "Druid" cambia de nombre: es igual a la de Tibia (regla legal). La auditoría de contenido (m12) renombró los hechizos parecidos, pero el nombre de una vocación es decisión tuya. Si cambia, es solo `vocation.druid.name` en `i18n/*/vocations.yaml` y los textos que la nombran (el id `druid` se queda) | Regla legal | `02-game-design.md` "Vocaciones (nombres provisionales)" |
| Las decisiones abiertas de la dirección de arte: (1) caminar más rápido al nivel bajo (`base_step_ms` 1000 → 800, MOV-8); (2) que el click derecho abra un menú por defecto y lo "clásico" quede como opción (UI-6); (3) humanoides de 1,25 a 1,5 casillas de alto, como LPC (ART-2); (4) antes de publicar en tiendas móviles, revisar lo de DRM con assets CC-BY y CC-BY-SA (SRC-1) | Prueba del 2026-11-17 | `17-direccion-de-arte-y-ui.md` |

## Orden sugerido
No quedan tareas del roadmap para la IA. Lo que sigue es tuyo (tabla de arriba), salvo
el punto 5:
1. Elegir el proveedor de pagos y cargar sus claves (T5.7, `09-deployment-aws.md`
   "Tienda y pagos"); probar una compra en su modo prueba con el webhook expuesto.
2. T1.18: cuenta de AWS, dominio y deploy.
3. Copiar a `deploy/.env.example` las variables nuevas de docs/09 (`RPG_ENV`,
   `PAYMENTS_PROVIDER`, `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `PAYMENTS_REF_SECRET` y
   `PAYMENTS_REF_SECRET_PREVIOUS`, comentadas): los permisos de la IA no le dejan editar
   ese archivo.
4. Jugar y anotar lo que se siente mal (`make play`, `16-probar-el-juego.md`); de ahí salen
   las próximas tareas.
5. De la primera prueba (2026-11-17) salió `17-direccion-de-arte-y-ui.md`. Su plan (§7, tareas
   A1–A13) es trabajo para la IA en lotes. Lo primero, por impacto y poco riesgo: A6
   (movimiento fluido, hecho en parte en la rama `feat/movement-feel`) y A8 (animación de
   los monstruos de un solo frame; hecho, junto con los personajes de LPC: ver "Pendientes
   conocidos").

## Cómo trabajar en local (lo que aprendimos en la nube)
- **Una tarea, una sesión, un PR.** Usa `/roadmap-task T5.6` o pega el brief. Pide un plan
  corto y deja que trabaje.
- **Antes de mergear:**
  - corre `make lint test validate`, `make test-integration` y `make e2e`, y mira los
    screenshots que cambiaron;
  - juega lo que cambió;
  - pide a la sesión que pase el diff por `code-reviewer`;
  - en tareas grandes, abre una segunda sesión solo para revisar ("revisa el PR #N buscando
    bugs reales, con un test que lo reproduzca") y pásale sus hallazgos a la primera.
- **Errores que se repitieron y conviene pedir que se revisen:**
  - mover items u oro entre personajes, el mercado o casas va siempre en un transfer del
    Saver, junto con los snapshots (docs/01 "Transacciones"), y con el modo de falla
    segura en mente;
  - el check `map-pr` valida el mapa con el `data/` y el `i18n/` de `main`: el contenido
    nuevo va en un PR antes del mapa que lo usa;
  - el vuelto de los pagos tiene que entrar en la mochila (T5.5);
  - nada de textos sin i18n, y nombres, textos y números originales (regla legal);
  - tests que digan lo que prueban y e2e que confirmen la respuesta del servidor, no
    solo el estado local del cliente.
- **Si la CI falla sin crear jobs**, es un problema de GitHub Actions: relánzala.
- **E2E en la CI:** el runner (2 CPU, sin GPU: WebGL por software) corre la suite varias
  veces más lento que tu PC. Cada test que falla se reintenta una vez; si pasa al
  reintento, el reporte lo marca `flaky`. Un `flaky` es un bug (casi siempre una espera
  mal puesta en el test, a veces del cliente): baja el artefacto `playwright-report`, mira
  el trace del reintento y arréglalo, no lo dejes. Detalle en docs/08 "E2E en la CI".

## Pendientes conocidos (no bloquean)
- **Dirección de arte y UI (prueba del dueño, 2026-11-17).** `17-direccion-de-arte-y-ui.md`
  deja escrito qué cambiar y cómo. A2 y A3 (la UI oscura: fuentes, tokens, dock con orbes,
  botonera y ventanas) ya están (rama `feat/ui-theme`, docs/17 §7 "Hecho: A2 y A3"), y A4 y
  A5 también (rama `feat/ui-interactions`, "Hecho: A4, A5 y los botones del gremio"): menú
  del click derecho con la ficha del item, tooltip, doble click, opción de controles,
  diálogo por temas y tienda sin scroll, y la ventana del gremio con botones; y A8 con la
  parte de criaturas de A10 y A12 (rama `feat/creature-animation`, abajo); y (rama
  `feat/world-art`) el arte del mundo de A10, A11 y A12 y la luz de A13 (abajo). Lo que falta,
  en el orden de su §7:
  - **A6, movimiento fluido (hecho):** ramas `feat/movement-feel` y `feat/movement-more`
    (ver abajo y docs/17 §4 "Hecho: A6, primera parte" y "segunda parte"). No fue solo del
    cliente como decía el plan: el servidor encola los pasos de teclado (protocolo en
    docs/05 "Caminar"); el click y el mouse mantenido caminan por esa misma cola. Quedan
    el polvo y las ondas al pisar (MOV-7, con las partículas de ART-7) y el toque corto
    que solo gira (MOV-2).
  - **Criaturas animadas (hecho).** Todas se mueven: animación por frames
    (`packages/renderer/src/anim.ts`, `client/src/render/creature-body.ts`) y, para los
    sprites de un solo frame, la procedural de ANI-5. Los atuendos, los 17 NPCs humanos y
    cuatro monstruos humanoides son personajes de LPC de 64x64 (`assets/vendor/ulpc`,
    `animations` de `assets/sprites.yaml`); jabalí y ciervo trotan con frames de spritegen.
    Lo que quedó pendiente de eso:
    - **A9 (protocolo):** quién ataca a quién y si una criatura murió o salió de la vista
      (ANI-7). Hasta entonces el cliente lo deduce (`render/creature-events.ts`) y puede
      animar al monstruo equivocado cuando varios rodean a un jugador.
    - **Conjurar y disparar:** las hojas `spellcast` y `shoot` de LPC no se usan todavía;
      un hechizo o un arco juega el ataque (`slash`).
    - **Animales:** los monstruos de Dungeon Crawl siguen con un frame y la animación
      procedural. Ningún repo oficial de LPC en GitHub trae animales con licencia al lado
      (el lobo del Starter Kit no la tiene); faltan ciclos propios de spritegen o hojas de
      OpenGameArt con licencia por archivo.
    - **Escala mezclada:** los personajes de LPC miden ~1,4 casillas y los monstruos de
      Dungeon Crawl, una (ART-2 lo acepta).
    - **Click sobre la cabeza** de un personaje alto: hecho (rama `feat/world-art-2`,
      ART-2). Elige a la criatura antes que la casilla; el propio jugador queda fuera.
      Y una criatura que otra más alta tapa desde adelante (el lobo al norte del jugador
      de `07-combat`) se dibuja otra vez, translúcida, encima del mapa.
    - **Atlas:** pasó de 1 a 2 páginas (docs/07).
    - **Pantalla de créditos (A1):** hecha: la página `/credits` del sitio, enlazada
      desde el pie del sitio y desde Opciones, y en la app de escritorio un botón de
      Opciones que abre la misma página en una ventana sobre el juego (rama
      `feat/world-art-2`). Falta probar ese botón en la app real (`make desktop-dev`): el E2E
      corre en el navegador, donde Opciones sigue mostrando el enlace.
  - **Lo que A4 y A5 dejaron** (docs/17 §7): texto del NPC letra por letra y retrato
    animado; color de los items de misión (`data/items` no los marca); tooltip sobre el
    canvas; arrastrar con Mayús para dividir una pila (hoy: "Mover parte…" del menú).
  - **Revisar en el E2E final de A4 y A5:** el click derecho sobre un item ya no lo usa
    (abre el menú): los specs usan doble click o Ctrl+click derecho (`useAt` en
    `e2e/game.spec.ts`) y el de la mochila y el del fogón pasan por el menú. La tienda ya
    no se desplaza: el E2E de la Isla de Pruebas busca la mochila y pagina.
  - **Lo que A3 dejó para después** (docs/17 §7, "Hecho: A2 y A3"): cada contenedor como
    ventana propia (hoy van dentro de Inventario); las ventanas del servidor (diálogo,
    tienda, crafteo, mercado, casa, intercambio) como `GameWindow` acoplables (hoy solo
    tienen el marco nuevo); mover ventanas con el teclado y cambiarles el tamaño; tamaño de
    fuente y escala de la UI (UI-3); Pixelify Sans en el canvas; íconos de slot vacío en el
    equipo; sacudida de cámara y destello de la hotbar (UI-9). El marco de hierro es CSS:
    el PNG 9-slice de spritegen (`ui/frame/iron`) queda como mejora.
  - **Revisar en el E2E final de la UI:** las ventanas flotantes (gremio, apariencia,
    opciones, ayuda) aparecen sobre el mapa: los specs las abren con `e2e/windows.ts` y
    cierran la del gremio antes de hacer click en el mapa. Un spec nuevo que abra una y
    después haga click en una casilla tiene que cerrarla o moverla.
  - **A7, vista de hasta 31x21:** hecha en la rama `feat/wide-view` (ver abajo).
  - **Arte del mundo (hecho, A10, A11, A12 y la luz de A13).** Muros con altura en 16
    piezas por material que el renderer elige por sus vecinos (también en el editor y en
    `mapcli render`), con la silueta del jugador propio detrás de un muro; suelos con
    looks; agua, bajío, lava, espuma de orilla, copas, fragua, fogón y cuatro props nuevos
    animados; árboles centrados con sombra proyectada; cuevas oscuras con luz del jugador
    y de los fuegos. Todo es spritegen propio (CC0): no hizo falta LPC para el mundo
    (docs/17 SRC-4). Lo que quedó:
    - **Props sin poner:** `wall_torch`, `wall_banner`, `brazier` y `fountain` existen
      (ids, i18n, arte animado) pero ningún mapa los usa todavía: es una tarea de mapa
      (`build-map-area`), por ejemplo antorchas en la mina y una fuente en cada plaza.
    - **Marco de puerta de casa:** hecho sin tocar mapas (rama `feat/world-art-2`): el
      cliente, el editor y `mapcli render` dibujan `house_door_frame` en cada puerta de
      `houses.yaml` (`DecoratedSource` de `packages/renderer`). Una puerta de dos casillas
      muestra un poste en el medio.
    - **Muralla (`rampart_wall`, 32x96) y muros con ventana** (`stone_wall_window`,
      `wooden_wall_window`): existen (ids, i18n, arte), pero ningún mapa los usa todavía:
      es tarea de mapa (`build-map-area`), como los props.
    - **Elevación** (ART-8): hecha para el dibujo (`elevation` en `data/items`; el cajón de
      carga, 8 px). No hay mesas ni barriles en `data/items` todavía, y el cajón bloquea el
      paso: por ahora solo sube lo que se tira encima.
    - **Bordes que faltan:** la tierra no tiene regla con el pasto ni con la arena
      (`data/borders.yaml`), así que los caminos y la herrería del Bosque terminan en línea
      recta. Sumar las reglas es fácil (gen-borders hace los sprites), pero ponerlas en las
      islas es `mapcli autoborder`: cambia mapas.
    - **Partículas de ambiente** (A13): hechas brasas (lava, fragua, fogón, brasero),
      polen junto a los árboles, rocío en la orilla del mar y polvo en las cuevas
      (`client/src/render/particles.ts`). Faltan el polvo y las ondas al pisar, el pasto
      que se agita, la niebla y las gaviotas sobre el mar (ART-7).
    - **Suelos viejos de la Isla Volcánica:** el basalto de Brasal (hexágonos muy
      contrastados) y la lava (muy cargada) son de T5.5; no tienen looks. La ceniza y la
      lava enfriada ya entran en la banda de valor de ART-6.
    - **Cara exterior de los muros delgados:** el suelo de la casilla del muro se ve a los
      dos lados de un tramo norte-sur (una franja de empedrado afuera del templo). Se lee
      como un zócalo; si molesta, la solución es de mapa (pasto bajo el muro) o un muro
      más ancho.
  - **A1 en las apps móviles** (docs/15): el botón de créditos de la app de escritorio
    sirve igual dentro de Tauri móvil (detecta Tauri), pero no se probó ahí.
  - **Las herramientas casi no leen la licencia.** spritepack y `make validate` solo piden
    la fila de `CREDITS.md` y el `LICENSE`. La excepción es la licencia por archivo de LPC:
    `make test` (spritepack, `src/licences.ts`) exige una licencia aceptada en
    `CREDITS.csv` para cada PNG del pack y que "Obras derivadas de terceros" de
    `CREDITS.md` dé a cada sprite compuesto la licencia de sus capas (OGA-BY 3.0, o
    CC-BY-SA 3.0 si una capa solo es BY-SA: hoy 2 monstruos y 13 NPCs). El resto de la
    política nueva (CC-BY-SA, OFL) la hace cumplir la revisión, igual que antes. El texto de las reglas que
    reciben los agentes del lote (`RULES` en `.claude/workflows/lote.js`) todavía dice
    "CC0/CC-BY/OGA-BY": hay que agregar CC-BY-SA y OFL.
  - Lo 👤 está en "Lo que es tuyo".
- **Vista ancha de 31x21 (rama `feat/wide-view`, apilada sobre `feat/movement-feel`;
  docs/17 A7).** Hecho: el servidor manda a todos una ventana de 31x21 (+1) y el `Welcome`
  se la dice al cliente; los monstruos
  siguen notando y persiguiendo solo la ventana clásica de 15x11 (+1); el cliente llena la
  caja del mapa con la vista más grande que la cubre a escala entera, sin bajar de 15x11
  (24x16 a 2x en 1920x1080 con el dock), y deja alejar hasta la ventana entera; medido en
  proceso dentro del presupuesto (docs/07 "Vista ancha"; reglas en docs/02 "La vista").
  Tras la revisión, los rangos con que apunta un jugador (armas, hechizos, condiciones)
  quedaron topados en 6 (`content.MaxRange`, esquema y carga): un monstruo golpeado desde
  tan lejos siempre lo nota y contesta. La segunda revisión topó también el `radius` de
  los hechizos de área, dejó que proponer un intercambio a un invisible conteste "no es
  posible" (antes "muy lejos" decía dónde estaba) y devolvió el bloqueo de los respawns a
  la ventana clásica (abajo). Quedó:
  - **Repetir `make e2e`:** la rama se rebasó sobre la punta de `feat/movement-feel`
    (`d9d80ca`, con f29dcc9 y f88d92a de `feat/ui-theme`); los screenshots de A7 (97b, 98b
    y los de teléfonos) se sacaron sin el CSS de hotbar y condiciones de f88d92a.
  - **`make bots` a 31x21:** hecho en el cierre del lote 6 contra un servidor real (docs/07,
    "Vista ancha"): base 624 B/s por jugador y tick p99 1,95 ms; stress 1580 B/s y 4,77
    ms. Todo dentro del presupuesto. Falta repetirlo con el monitoreo (Grafana) y con los
    bots en otra máquina.
  - **Ventana por cliente, descartada por ahora:** docs/17 proponía que el cliente pida su
    vista (de 15x11 a 31x21) y el servidor mande esa área. Se dejó una sola para todos:
    "A ve a B" sigue simétrico, nadie gana nada con un cliente modificado y el ancho de banda
    entra en el presupuesto (1,7 KB/s en el peor escenario). Si un día molesta (teléfonos
    con datos móviles), el `Hello` podría pedir una ventana menor y el servidor recortar
    solo lo que manda, sin tocar las reglas.
  - **Escala 1,5x "sharp-bilinear" (docs/17 UI-4), sin hacer:** dibujar a 2x y bajar a 1,5x
    con filtro lineal, como opción de Gráficos apagada por defecto.
  - **La escala por defecto, para que la pruebe el dueño:** es la vista más grande que
    llena la caja a escala entera sin bajar de 15x11 (docs/17 "Hecho: A7": a 1920x1080, 2x
    con 24x16; la regla de UI-4 daba 3x con 16x11 con el dock). Si prefiere ver las 31x21
    enteras de entrada (1x a 1920x1080, con caja oscura alrededor), basta con que
    `zoomRange` (`client/src/render/zoom.ts`) devuelva su `min` como `fit`; cada jugador
    ya puede alejar hasta ahí y queda recordado.
  - **Bordes de la vista, para decidir:** docs/17 pedía casillas enteras con lados impares
    y el resto en `--ui-void`; quedó el canvas lleno hasta los bordes con casillas
    fraccionarias, centrado en el jugador (como el zoom de antes). Revisarlo en el playtest
    con la UI oscura.
  - **Respawns y la vista ancha, para que lo confirme el dueño:** un monstruo no reaparece
    con un jugador dentro de la ventana clásica de 15x11 + 1 (`session.watched`), como
    antes de la vista ancha. Con la ventana entera, quien caza en un spawn frenaba los
    respawns de los vecinos (están a 12–20) y la capacidad del mundo (docs/07) quedaba
    optimista sin medirlo. El costo: un monstruo puede aparecer dentro de lo que se ve, a
    9–16 casillas a los lados o 7–11 arriba y abajo. Si el dueño prefiere que nada aparezca a la vista, es una línea
    (`watched` con `eachObserver`) más medir la capacidad (telemetría o un test
    espacial) y ajustar respawns y distancias.
  - **El cliente a 31x21 sin medir:** a 1x se dibujan unas 650 casillas por capa (165 con
    15x11) más las etiquetas. Anotar FPS y draw calls a 1x y a la escala por defecto en
    1920x1080 (docs/07 "Vista ancha"); pide un navegador real con GPU.
  - **Etiquetas a 1x:** alejado a la ventana entera los nombres se acomodan con la regla de
    zoom 1x (`render/labels.ts`); en una multitud se ocultan muchos. Revisarlo en el
    playtest.
- **Movimiento fluido (ramas `feat/movement-feel` y `feat/movement-more`).** Hecho: pasos
  de teclado predichos hasta 4 adelante y encolados en el servidor detrás de una época de
  caminata (protocolo en docs/05 "Caminar"), la cámara y las criaturas de a 1 px de
  pantalla, los pasos del servidor sobre su línea de ticks con colchón de jitter,
  correcciones que se deslizan, diagonal con dos flechas y deslizarse junto a un muro; y
  después el click previsto (camino del cliente, cada paso un `Walk`, rodeo en el
  cliente), caminar manteniendo el botón izquierdo hacia el cursor, el anillo del destino
  y el texto de la acción junto al cursor (docs/02 "Movimiento" y "Controles del mouse",
  client/CLAUDE.md "Movimiento fluido"). Quedó:
  - **Mantener el botón sobre un item:** arrastrar antes de 200 ms mueve el item y
    mantenerlo quieto camina hacia el cursor (docs/17 MOV-3). Si en el playtest se arrastra
    un item sin querer al empezar a caminar, la opción es exigir Ctrl para arrastrar desde
    el mapa, o que el mantener empiece solo fuera de las casillas con items.
  - **Polvo y ondas al pisar (MOV-7):** son arte por terreno; van con las partículas de
    ART-7 y A13.
  - **El texto junto al cursor** muestra la acción por defecto (atacar, hablar, trepar,
    abrir, usar una estación, el tablero o una puerta) apenas el mouse se apoya en la
    casilla, sin espera. Mirar en el playtest si molesta al caminar con el mouse por
    zonas con muchos monstruos; se podría pedir ~300 ms quieto, como el tooltip.
  - **Mantener el mouse con el dedo:** no hay (el toque largo es el menú y está el pad).
  - **Frames de caminar de los monstruos y NPCs:** hoy tienen un solo sprite; mientras
    tanto dan un saltito de 1 px por paso (`walkBob`). Cuando tengan frames, que usen el
    mismo esquema que los outfits (`outfitFrame`) y se apaga el saltito.
  - **Velocidad base:** a nivel 1 un paso dura 500 ms (2 casillas/s). Se siente lento al
    lado de Diablo 2, pero es balance (`base_step_ms`, `speed` de las vocaciones): no se
    tocó.
  - **Medirlo en una red real:** la simulación cubre RTT de 2 a 300 ms con jitter, un
    corte de 1 s y `Walk` perdidos, y el E2E `e2e/movement.spec.ts` corre con ~150 ms de
    latencia simulada en el WebSocket; falta jugarlo por el hosting de pruebas (docs/13) y
    mirar si los 40 ms de colchón alcanzan con Wi-Fi.
  - **Diagonal con dos flechas, para decidir:** hoy dos flechas perpendiculares
    mantenidas dan la diagonal, y también un toque perpendicular con otra mantenida
    (derecha mantenida + toque de arriba = un paso noreste, no uno al norte). Al cambiar
    de dirección con las teclas solapadas (se aprieta la nueva antes de soltar la vieja),
    si eso cae en los 50 ms en que se decide el paso, sale un paso diagonal que no se
    buscó (×1,5 de duración, otra casilla). Opciones: dejarlo; que un toque ya soltado
    dé el paso lateral; o que la diagonal pida las dos teclas juntas un instante (~60 ms,
    a costa de que el primer paso de una diagonal buscada salga recto).
  - **Eventos y pasos de los demás:** los pasos se dibujan sobre la línea de ticks
    (~40 ms después de llegar, como mucho 240 ms), pero los efectos, golpes, giros y
    desapariciones se aplican al llegar: una criatura puede girar o recibir un golpe
    ~40 ms antes de que se dibuje su paso. No se nota; se dejó así.
- **Prueba exploratoria de la Isla de Pruebas (rama `fix/playtest`).** Se arreglaron los
  muros en el cliente, el scroll de las ventanas, el foco tras un checkbox o un select, la
  correa de los monstruos, la mochila tras morir, la hotbar sobre la última fila, la
  puerta con un jugador encima, la confirmación de "Dejar la casa", el límite de logins de
  `make play`, la cantidad de la tienda y el pulido de textos. Quedó:
  - **Dividir pilas (m1), a medias.** Desde A4 el menú de una pila (click derecho o toque
    largo) tiene "Mover parte…": un campo con cuántos (la mitad por defecto) y el siguiente
    click o toque en una casilla, un slot o una celda manda `MoveItem` con ese `count`.
    Arrastrar sigue moviendo la pila entera; falta Mayús al soltar (una ventanita con la
    cantidad, la regla pura `shopCount` de `state/shop.ts`). El intercambio necesita
    protocolo: `TradeOffer` no lleva cantidad (`client.proto`), así
    que se suma `uint32 count = 6` (0 = la pila entera, compatible), el servidor separa la
    parte ofrecida al cerrar el trato (y revisa que siga habiendo esa cantidad) y la
    ventana de intercambio muestra un campo de cantidad junto a cada pila ofrecible. Tests:
    la regla pura, un test de sesión del trato parcial y el E2E de T5.3 con 10 de 100.
  - **Casa de Prueba:** los muros de troncos ya tienen altura y cara, y el piso es más
    oscuro: no se confunden. La puerta sigue siendo un hueco (falta el marco, arriba).
  - **Encimados:** a zoom 2 se pisan los nombres de jugadores contiguos
    (`render/labels.ts` solo los acomoda a zoom 1).
  - **Saludo con género fijo:** "Bienvenido, {name}" (sin género del personaje en los datos).
  - **401 en consola** al cargar `/play/` y `/shop` sin sesión: es el sondeo de sesión; se
    puede pedir a una ruta que conteste 204 sin sesión.
  - **Dificultad del corral 2:** tres lobos (0–16 cada 2 s) matan a un nivel 3 que sale
    del corral 1. Queda para el lote de balance, con la comida (m4).
  - **Correa, lo que quedó de la revisión** (`server/internal/session/monster.go`; el
    lote 5 resolvió el objetivo inalcanzable dentro de la correa y que el que tiene el
    aggro saliera del área le quitara la pelea al grupo, docs/02 "Correa"): la
    persecución sigue yendo y viniendo frente a un muro cuando el paso goloso y el primer
    paso de A* se alternan (ya pasaba sin correa; `walkHome` sigue el rodeo entero, la
    persecución no, y como da pasos no cuenta como trabada); nada valida que el centro de
    un spawn sea caminable (hoy todos lo son); la espera tras una búsqueda fallida (de
    casa o de la persecución) usa `readyAt`; un arquero que va pisando casillas
    inalcanzables nuevas entrena a ritmo completo los 2 s que cuesta cada una (el rechazo
    vale por casilla); y `make bench-tick` corre sin correa.
- **Auditoría de contenido (2026-11), lo que quedó afuera de la rama de balance de
  vocaciones** (`feat/balance-vocations`: maná, escalones de armas, ballesta y escudo del
  montaraz, áreas nuevas, comida, sello por jugador, cuerda y pala, bendiciones desde el
  nivel 9, nombres de hechizos y pulido de textos; detalle en `02-game-design.md`):
  - M1, M6, m3, m4, m7, m11 y m13 se hicieron en la rama `feat/world-capacity` (capacidad
    por franja y abedules, casas, defensa del arma, items huérfanos, tablero de Brasal,
    `testisle` dev-only, comisión del mercado; docs/02, docs/07 "Capacidad del mundo" y
    docs/10). De ahí quedó: un aviso por email antes de perder una casa por ausencia, y
    el cliente no muestra la regla en la ventana de la casa (solo el mensaje al entrar);
    al desplegarla, **los alquileres de las casas ya alquiladas suben entre 2 y 4 veces**
    desde su próximo vencimiento: anunciarlo (docs/09, "Notas de versión que tocan a los
    jugadores");
  - en la carrera simulada los magos de nivel 30-40 cazan en el Bosque (reptantes) más
    que en el Volcán: los monstruos del Volcán pegan fuerte para un cuerpo de mago. No es
    un error, pero es una pista (M1 sumó capacidad al Volcán sin tocar el daño);
  - la pala sigue en `data/items` sin fuente (inventarios guardados): si algún día se cava,
    es darle un destino y volver a venderla.
- **CI de PR de mapas sin `pull_request_target`** (GitHub lo bloquea por defecto en repos
  públicos desde el 2026-12-02): `map-pr-pending.yml` ya no existe. El aviso de
  "pendiente" sale ahora del `workflow_run` `requested` de `map-pr`, y el status de commit
  `map-pr/verdict` cierra el caso del push sin corrida (docs/04, "PR de mapas en CI"). Falta:
  - 👤 **apenas** se mezcle esto en `main`, marcar `map-pr/verdict` como check requerido
    (fuente GitHub Actions; en un ruleset se puede escribir el nombre sin esperar a la
    primera corrida). Hasta entonces, un push que borra o renombra `map-pr.yml` deja el
    ✅ anterior a la vista, solo con el aviso del pie (nombra su commit). Antes del
    2026-12-02 `map-pr-pending` lo habría marcado como pendiente (salvo en los cortes de
    prueba); después, ya no;
  - 👤 el status **no es a prueba de falsificación**: un PR (también de un fork) puede
    agregar un workflow con un job `name: map-pr/verdict`, cuyo check run satisface la
    regla con el mismo nombre, y cualquiera con permiso Write puede poner el status. El
    veredicto avisa (🚨 y `failure`) si ve ese check run, pero no lo impide. Lo que lo
    cierra es crear `.github/CODEOWNERS` (no existe) y activar "Require review from Code
    Owners" con "Dismiss stale pull request approvals when new commits are pushed";
    sin lo segundo, una aprobación vieja vale después de un push que agrega el workflow.
    Dejar apagado "Allow GitHub Actions to create and approve pull requests" (el token
    de `map-pr-comment` tiene `pull-requests: write`);
  - mirar en el primer PR real que el comentario pase a ⏳ al empujar y que el status
    aparezca en el commit (`pending`, y después `success` o `failure`). Los tests usan un
    GitHub en memoria. Sin verificar en GitHub: si `requested` llega también para la
    corrida de un contribuidor nuevo que espera aprobación (si no llega, el status falta
    hasta que se apruebe, que también bloquea); un `completed` con `action_required`
    se ignora, para no escribir `failure` antes de que `map-pr` corra. Tampoco se verificó que el anuncio del
    2026-12-02 deje fuera a `workflow_run`: por lo que se sabe solo cambia
    `pull_request_target`, pero vale leerlo antes de esa fecha;
  - un mismo commit como head de un PR hacia `main` y de otro hacia otra rama: el status
    lo escribe solo el de `main`, y una corrida que no dice para cuál PR es (el job
    `pending`, o sin reporte) no escribe nada. Raro, pero el comentario del PR hacia
    `main` puede quedar sin "pendiente" en ese caso, y su status queda como estaba
    (ninguno, o un veredicto anterior del mismo commit) hasta que termine su corrida. Si
    los dos salen de la misma rama, sus cuatro eventos comparten el grupo de
    `concurrency`, que deja uno corriendo y uno esperando (uno nuevo cancela al que
    espera, aunque `cancel-in-progress` sea `false`): el veredicto del PR hacia `main` se
    puede perder y su status queda como estaba. Lo corrige una corrida **nueva** de su
    `map-pr` (editar el título, cerrar y reabrir, o empujar: relanzar una vieja no
    escribe si hay una más nueva). No está verificado en GitHub que un job saltado por su
    `if` no ocupe lugar en el grupo;
  - un PR que cambia `world/`, se calculó hacia otra rama y después se pasó a `main` ya
    no puede dejar un `success` de la otra rama: el veredicto solo vale como status si la
    base del reporte es la punta actual de `main` (si no, `failure` y el comentario pide
    una corrida nueva). Lo mismo si `main` avanzó mientras corría el check. Y si el PR
    cambia de base, head o archivos mientras se calcula el veredicto, no se escribe nada.
    Sin verificar en GitHub: si la API de archivos de un PR tarda en recalcular después
    de un cambio de base (un PR que no toca `world/` contra la rama vieja podría llevarse
    un `success` "sin mapa" en ese hueco);
  - una copia de un PR (otro PR hacia `main` con el mismo commit, de otro autor u otro
    repo de origen: un fork con ese commit u otra rama con la misma punta, porque GitHub
    no deja dos PR abiertos desde la misma rama hacia la misma base) congela el status
    del commit: ninguna corrida lo escribe mientras la copia esté abierta. Antes la copia
    podía pasarlo a `failure` con cada `edited`. Se cierra la copia y el PR bueno
    necesita una corrida nueva de `map-pr`. Abrir y cerrar copias sigue sirviendo para
    trabar un PR (nunca para pasarlo);
  - 👤 opcional, ya existía: `release-desktop.yml` (`contents: write`) e `images.yml`
    (`packages: write` al publicar) usan tags mayores flotantes (`actions/checkout@v4`,
    `pnpm/action-setup@v4`, `docker/*@v3`...). Fijarlas por SHA, como `map-pr-comment`,
    reduce el riesgo de cadena de suministro, pero sin Dependabot (no hay
    `.github/dependabot.yml`) nadie las actualiza;
  - una merge queue necesitaría que `map-pr` corra en `merge_group` y ponga el status
    sobre ese commit; hoy se usa "Require branches to be up to date".
- **Móvil** (T5.6, falta probarlo en un dispositivo real): login de Android sin llavero
  (hay que entrar de nuevo en cada arranque) y el selector de servidor reinicia la app.
  Detalle en `15-movil.md`. El área segura (muesca, esquinas, barra de inicio) se cuenta
  una sola vez en todo el juego: el padding de `.game` para lo que cuelga del mapa, y
  `env(safe-area-inset-*)` en los bordes de lo que va fijo a la pantalla (las ventanas en
  teléfono y tablet, el selector de idioma fuera del juego) y en `menuPlacement` para el
  menú del toque largo. Un E2E con insets de CDP mide el pad, la hotbar, el zoom, el
  banner, el diálogo de un NPC y el menú; crafteo, mercado, casa e intercambio comparten
  la regla CSS del diálogo pero no tienen su propia medición. Falta verlo en un iPhone y
  un Android con muesca de verdad (el override de CDP solo existe en Chromium).
- **Herramientas de Gemini (`tools/gemini`, rama `feat/gemini-tools`).** El arte y la
  música hechos con la cuenta de Gemini del dueño están permitidos desde el 2026-11-17
  (docs/17 SRC-5) y ya hay con qué pedirlos, importarlos y registrarlos (`tools/CLAUDE.md`,
  "gemini"; `make test-gemini`, job `gemini` de la CI). El smoke de solo lectura
  (`gemini_web.py check --list-modes`) vio el 2026-11-18 el Chrome del dueño con sesión, en
  Hydrogen. Lo que falta:
  - **Ningún asset de Gemini entró todavía al juego.** Los 14 temas que pidió la sesión
    principal el 2026-11-17 (`build/music-gemini/` del repo principal, dos por lugar)
    esperan que el dueño elija; los elegidos pasan por `music_convert.py`, `sounds.yaml` y
    `credit.py`. La sección "Generado con IA" de `assets/CREDITS.md` está vacía.
  - **Presupuesto de música:** un tema de Gemini (~2:40) pesa ~650 KB en Opus estéreo a
    32 kbps y docs/07 da 256 KB por archivo de música (1,5 MB todo el audio). Hay que
    decidir con el dueño: subir el tope (el audio no cuenta en la descarga inicial),
    mono o menos kbps, o temas más cortos.
  - **La página `/credits` no lista lo generado con IA** (`client/vite/credits.ts` solo lee
    packs, fuentes y obras derivadas). Con el primer asset de Gemini, sumar una sección
    que diga "Hecho con Gemini" y sus textos en `i18n/{es,en}/site.yaml`.
  - **El pedido de imagen** (`gemini_web.py image`, eligiendo "Crear imagen" en el menú
    nuevo) no se probó contra la página todavía: es un port del de Ants of Neque, que sí
    funcionaba, y el primer pedido real es su prueba. Si "Crear imagen" pide controles
    propios (como la música: duración, voces), hay que sumarlos como en `music_web.py`.
  - **`import_art.py` sobre una hoja real** se probó con una de Ants of Neque (una palanca
    en 5x2): con 8 a 10 colores antes de la paleta queda limpia; con 16 salía con ruido. Las
    hojas que no son pixel art limpio (ilustración) quedan con algo de ruido: bajar
    `--colors` o pedir "pixel art, flat shading" con más fuerza.

- **Sonidos sin reintento:** un sonido que no se pudo bajar (`/audio/`, `audio/engine.ts`
  `load`) queda mudo el resto de la sesión (el fallo se guarda). El atlas sí reintenta
  (`packages/renderer/src/retry.ts`, y "Reintentar" en el juego y en el editor); si hace
  falta, los sonidos podrían usar la misma política.
- **Mercado en vivo:** cada refresco manda la ventana entera (`MarketUpdate` completa),
  no un delta (costo y tope en docs/07). Pasar a deltas necesita un mensaje nuevo y que el
  cliente fusione las listas; hacerlo solo si una medición con muchos espectadores de un
  mismo libro lo pide (antes, subir `market.push_every_ms`).
- **Caída con la calle de por medio (límite general, no del comercio):** un transfer
  descartado ya no duplica lo que su personaje soltó antes al suelo público: su estado del
  final de ese comando (o tick) se escribe antes del transfer (docs/01, "Guardado antes
  del transfer").
  Queda el caso de una **caída** (o de la base caída al apagar, que se trata como una):
  lo que alguien tiró a la calle y otro levantó puede quedar en las dos filas si el
  guardado de quien lo levantó entró y el de quien lo tiró no. Es el límite de guardar
  por personaje con el suelo en memoria, igual sin comercio. Lo mismo si la base rechaza
  el snapshot mismo, no solo el transfer (lo avisa `PersistenceDataLost`). Una salida
  sería reservar lo que se tira a la calle hasta escribir el estado de quien lo tiró (una
  escritura por tirada, acotada por jugador, y una demora para levantarlo); hacerlo solo
  si las alertas de economía lo muestran.
- **Mundo:**
  - cada cartel cuesta un item y un ID (hoy todos los de Puerto, el Bosque y la Isla
    Volcánica, incluido el de la puerta con llave del piso 8, tienen su `*_sign`; solo el
    del templo de `testisle` no). A futuro `mapcompile` podría llevar `texts.yaml` a
    `world.bin` y el servidor leerlo, sin items por cartel;
  - portales (`02-game-design.md` "Cambiar de piso"): el servidor mueve por escaleras,
    escaleras de mano, agujeros, sogas y teletransportes, y todos tienen su item con arte
    propio (`ladder_up`/`ladder_down`, `hole`, `rope_spot`, `teleport`; las escaleras son
    del pack), pero el mundo solo usa escaleras: poner los otros es diseño de mapa
    (`build-map-area`; `make validate` y `mapcompile` exigen el item en cada entrada). Sin
    una escalera de mano en el mundo, Ctrl+click derecho sobre una (usa el item de arriba
    en vez de trepar) y su toque largo (sin "Usar" ni "Mover" para su propio item) solo
    tienen tests unitarios (`state/portals.ts` `useMode`, `input/mouse.ts` `mapPress`,
    `state/items.ts` `menuItem`), no E2E. El teletransporte es estático: el atlas y el
    renderer no animan items (haría falta una tira de frames por item, como los efectos).
    Un portal sin su item lo rechazan `make validate` y `mapcompile`; el servidor solo
    **avisa** en el log (`initPortals`) si el `world.bin` es de antes de cambiar
    `data/items` (`world.NewMap` no conoce los items y los mapas de los tests de `session`
    ponen portales en casillas sin nada). `add_portal` (mapcli, MCP, panel del editor) no
    coloca el item: el editor podría ponerlo solo (hacerlo dentro de la operación cambia su
    inversa y los patches, por eso quedó aparte). Arrastrar con el mouse el item propio de
    un portal manda un `MoveItem` que el servidor rechaza (`inventory.not_possible`), como con
    cualquier item fijo del mapa. Los items tirados sobre una escalera, un agujero o un
    teletransporte caen al otro extremo (solo por `MoveItem`: el servidor nunca suelta
    nada en esas casillas, nadie se para ahí), sin efecto visual ni sonido propio; uno que
    ya está donde caería (un teletransporte del mismo piso) no se mueve ni avisa. Cada paso
    por un portal manda un `FullMapView` (hoy unos
    950 B/s subiendo y bajando sin parar, docs/07): una isla con pisos sobre el 7 lo haría
    más pesado, conviene medirlo de nuevo cuando exista;
  - chequeo de escape de las puertas con llave (`02-game-design.md`, "Chequeo de
    escape"): cuenta como salida de un área solo la puerta de una sala desde adentro y los
    portales que no piden nada (escalera, escalera de mano, agujero, teletransporte); las
    casas y las entradas de escaleras, agujeros y teletransportes son muro, y los puntos de
    soga, los teleports de diálogo y los viajes en barco no son aristas. El mundo son solo
    los templos. **Para que lo mire el dueño:** es más estricto que el brief, que contaba
    también las llegadas de barco; una llegada es una entrada, no una salida (con ella,
    una bóveda sin capitán pasaba y quien se colara adentro podía quedar encerrado). En el
    mapa de hoy no cambia nada. Si se quieren de vuelta, hay que sumar también la salida
    en barco como arista. Un diseño que solo deje salir por esos caminos se rechaza aunque
    sea seguro; si hace falta, sumarlos como aristas, igual en `session/door.go`
    (`escapeWay`, `portalSources`) y `packages/map-format/src/doors.ts` (`ESCAPE_WAYS`,
    `portalSources`), con casos nuevos en `door-rooms.json`. El chequeo de llaves es
    conservador (supone a un jugador en cualquier área fuera de las salas y en cualquier
    casa), y una escalera de mano cuenta solo desde el área de su casilla;
  - la búsqueda de casilla libre por anillos (`searchFrom` en `session/area.go`) ya tiene
    regla para cada origen fuera de las áreas (casa: su área de casa y la calle de la
    salida; puerta con llave: su afuera; escalera: las áreas de al lado; cualquier otro:
    ninguna, `02-game-design.md` "Nadie aparece adentro sin pasar la puerta"). La salida
    de una casa o el templo sobre una puerta (con llave o común, abierta o cerrada) o en
    una casilla no caminable, y el templo en una casa, ya no dejan arrancar ni pasan
    `make validate` (`checkArrivals`, casos en `testdata/arrivals.json`): con todo lleno,
    `houseExit` y `wakeAtTemple` dejan al jugador en esa casilla misma, y desde el umbral
    de una puerta con llave daba un paso a la sala sin la llave (el paso solo mira adonde
    va); una puerta común la puede cerrar cualquiera. Hoy ninguna de las 6 salidas ni
    ningún templo está sobre una puerta. Queda: quien sale del juego en el umbral de una
    puerta abierta vuelve afuera aunque hubiera entrado con la llave (no sabemos de qué
    lado venía), y un `Teleport` del servidor (`relocate`) no mira si la casilla es
    caminable: todo destino de último recurso nuevo tiene que quedar garantizado por la
    carga, como el templo y la salida;
  - **Para que lo decida el dueño (revisión del lote 3):**
    - portales de la comunidad entre islas: hoy el chequeo de parcelas los rechaza
      (`cross_island`, `packages/map-format/src/patch/plots.ts`), la opción segura, porque
      un teletransporte entre islas se saltea el barco, su precio y sus requisitos y
      `travel.combat_block_ms`. Si se quieren, hace falta una regla de viaje para ellos
      (como mínimo el bloqueo de combate del barco en el servidor) antes de aflojar el
      chequeo. En "Mis envíos" el rechazo se ve como el genérico de fuera de parcelas
      (`outside_plot`): un código propio necesita i18n, cliente y servidor;
    - agujeros y teletransportes sin salida: `make validate` solo **advierte** cuando desde
      su destino no se llega a un templo sin llaves ni herramientas (un pozo del que se
      sale con soga es un diseño válido, a la manera de Tibia). Si se prefiere que sea
      error, o exigir siempre una salida sin soga, es cambiar la advertencia de
      `checkPortalExits` (`validate.ts`) por un error;
    - quien veía a un jugador tomar una escalera recibe el paso y enseguida su
      desaparición, y el cliente lo borra en el acto: no ve el paso sobre la escalera. Se
      podría diferir el borrado hasta que termine la animación (solo para dibujar, sin que
      siga en la lista de batalla ni se pueda atacar);
    - con una tecla de movimiento mantenida, un paso rechazado no se reintenta hasta volver
      a pulsarla (así no se repite el aviso de la escalera o de la puerta de una casa).
      Eso incluye un paso rechazado porque alguien estaba en la casilla y después se fue.
  - un comando que suelta algo a la calle **dentro** de una pila o bolsa ajena y además
    cambia una casa todavía guarda el snapshot aparte, antes de la escritura de la casa,
    y lo registra con nivel error (`settleGave`): no se le puede reservar lo ajeno. Hoy
    ningún comando lo hace (solo un `MoveItem` suelta en algo que no se le puede reservar,
    y ningún `MoveItem` cambia además una casa): es una guarda;
  - el caso real que justificó reservar lo soltado con la escritura de la casa (una runa
    del suelo de la casa usada desde la calle que mata a un monstruo de una quest de
    muertes cuya recompensa no entra) lo juega `TestHouseRuneKillsAQuestMonsterFromTheStreet`
    con la runa, el monstruo y la recompensa de `data/`; la quest es del test porque
    ninguna quest de `data/` termina en una muerte (todas cierran hablando con un NPC). Si
    alguna llega a terminar en una muerte, conviene pasar el test a ella.
- **Isla de Pruebas: lo que dejó el recorrido simulado** (`server/internal/session/sandbox_test.go`,
  docs/16 secciones 4 y 8). Todo el recorrido de la guía funciona; lo que sigue son huecos
  de la herramienta, no errores del servidor:
  - **resuelto:** la instructora subía el **nivel**, no las **skills** ni el **nivel
    mágico** (un guardián de nivel 21 con espada, escudo y 20 cataplasmas moría en el
    corral 4 con las skills en 10; la runa de arco, nivel mágico 1, y `mend_other`, 2, no se
    podían usar recién hecho). Ahora "Entréname" → "El combate" deja las skills de la
    vocación y el nivel mágico en valores fijos (guardián: espada, hacha y maza 45, escudo
    40; arcanista y druida: nivel mágico 25...; docs/16 paso 1) con la acción de desarrollo
    `train_skill` (docs/06, "Diálogos"): ese guardián sobrevive al corral 4
    (`TestSandboxTraining`), la arcanista usa la runa en el acto (`TestSandboxArcRune`) y
    un druida de nivel 8 lanza `mend_other` (`TestSandboxTrainingByVocation`);
  - **resuelto:** "Cúrame" llena también el maná (acción de desarrollo `restore_mana`; la
    `heal` de los sacerdotes no cambió). Pociones de maná sigue sin haber en el juego real:
    las vocaciones mágicas esperan la regeneración (el sacerdote solo cura la vida);
  - **resuelto:** el yunque no tenía receta al alcance de un personaje nuevo (la más baja
    pide herrería 2). "Entréname" → "Los oficios" deja los oficios en 25 y la pesca en 40,
    y el mismo personaje hace un hacha de leñador en el yunque (`TestSandboxTrades`). No se
    tocó ninguna receta: el juego real sigue igual;
  - **las acciones de desarrollo no pueden llegar a producción**: `make validate` las
    rechaza en un NPC que no esté solo en islas `dev_only`; el servidor no arranca con uno
    así fuera de una isla marcada en `world.bin`, y al elegir la opción lo vuelve a mirar
    (`dialog.dev_only`). Y la guarda que pidió la auditoría: `mapcompile -dev` marca las
    islas de desarrollo en `world.bin` (versión 6) y el servidor no arranca con ese mundo
    con `RPG_ENV` de producción (vacía o `production`), como con el proveedor de pagos
    falso; `make run-server`, `make dev`, `make play`, `make bots` y el E2E corren con
    `RPG_ENV=development`. Un `world.bin` viejo (versión 5) no carga: `make mapcompile`;
  - la **pala** no sirve para nada en todo el juego (`tool.use: shovel` no tiene mecánica:
    usarla dice `gather.nothing`). Se sacó de la tienda de la isla
    (`TestSandboxToolsHaveAUse`); Puerto la sigue vendiendo (40) y comprando (12); y su
    proveedor todavía promete que "abre agujeros donde la arena suena hueca"
    (`npc.puerto_provisioner.tools`, es y en): o se le da la mecánica o se cambia el texto;
  - no es un error, pero sorprende probando: un monstruo no reaparece donde un jugador lo
    ve, así que quien vacía un corral y se queda mirando no ve volver a nadie (docs/16
    lo dice ahora), y los monstruos salen de los corrales por la abertura y siguen al
    jugador unas casillas por el sendero (la correa, `combat.monster_leash_tiles`, los
    devuelve a su corral: docs/02 "Monstruos").

## T5.6: brief (hecha, se deja como referencia)
Implementa **T5.6 Controles táctiles y cliente móvil** de docs/10-roadmap.md (Hito 5). docs/00 dice: plataforma PC primero, móvil secundario. Esta tarea hace que el cliente web se juegue bien en un teléfono o una tablet y en ventanas chicas de escritorio, y deja preparado Tauri mobile. Las apps nativas firmadas para las tiendas son 👤 del dueño (cuentas de Apple y Google).

### Alcance (rama `feat/t5.6-touch`, desde main)

#### 1. Controles táctiles (client/src/input, como prevé client/CLAUDE.md)
- **Caminar:**
  - tocar una casilla camina hasta ella, con el pathfinding que ya existe;
  - además, un pad direccional en pantalla, opcional y activable en Opciones, para pasos de a uno;
  - mantener presionado repite el paso.
- **Atacar o hablar:**
  - tocar una criatura la marca como objetivo, igual que el click derecho de hoy;
  - tocar a un NPC lo habla;
  - un toque largo, o un botón de acción contextual, reemplaza el click derecho sobre items y casillas: usar, abrir, mirar (Mayús+click) y mover.
- **Items:**
  - arrastrar con el dedo entre inventario, contenedores y suelo, con las mismas reglas del servidor;
  - una alternativa sin arrastre: tocar el item, después tocar el destino.
- **Hotbar:** tocable, y en pantallas chicas se reduce a los slots que entren con un deslizador.
- **Chat:** el teclado virtual no tapa el input. Al escribir, el juego no recibe teclas.
- **Lógica pura y testeable:** gestos (toque, toque largo, arrastre, pellizco si lo usas para zoom) separados del DOM, con Vitest. `pointer events` y no APIs viejas de touch, salvo que haga falta.

#### 2. Layout para pantallas chicas y ventanas chicas
Tres arreglos que vienen de screenshots de tareas anteriores:
- **Encabezado:** a 1280x800, un nombre largo con la experiencia hace que la ayuda de controles pase a 6 líneas. El encabezado crece y el mapa baja de zoom 2x a 1x (screenshots 47, 49, 50 y 63–66). Acórtalo o pliégalo para que el mapa no pierda zoom.
- **Mensajes del servidor:** el log de mensajes (`ul.log`, rechazos de PvP, bloqueo de logout y avisos del mercado o la casa) queda debajo del inventario y las habilidades en el panel lateral, fuera de vista a 1280x800. Haz que los avisos importantes se vean siempre; por ejemplo, un toast o una línea de estado sobre el mapa, además del log.
- **Nombres a zoom 1x:** los nombres, las etiquetas de gremio y las marcas de criaturas vecinas se pisan. Busca una regla simple: apilar, acortar o mostrar solo el objetivo y los cercanos.

Y en general:
- **Teléfono vertical y horizontal, y tablet:**
  - el mapa ocupa lo principal;
  - el panel lateral pasa a pestañas o a un cajón: batalla, grupo, gremio, inventario, habilidades y chat;
  - las ventanas (NPC, tienda, mercado, intercambio, casa, gremio y tutorial) entran en pantalla y se cierran con un botón grande.
- **Sitio público:** que las páginas también se vean bien en teléfono. Ya hay un e2e "desktop y phone"; amplíalo si cambias algo.
- **Accesibilidad:** objetivos táctiles de 44 px como mínimo, foco visible y nada que dependa solo de hover.

#### 3. Instalable
- **PWA:** manifest (nombre, íconos placeholder, `display: standalone`, orientación) y service worker *solo* para el shell estático; nunca para la API ni el WebSocket.
  - Se instala desde el navegador, sin tiendas.
  - Documenta en docs/09/12/13 que Caddy lo sirve con las cabeceras correctas.
- **Tauri mobile:**
  - Deja preparado `apps/desktop` (o un `apps/mobile` si es más limpio) para `tauri android init` / `tauri ios init`: configuración, capabilities y el selector de servidor de T2.x.
  - Documenta los pasos 👤 en un doc: SDKs, firma y cuentas de las tiendas.
  - No hace falta compilar el APK aquí si el entorno no tiene el SDK de Android. Dilo en el PR.

#### 4. Tests
- Vitest de la lógica de gestos y del layout responsivo, con los breakpoints como datos.
- E2E con Playwright y un dispositivo emulado (por ejemplo `devices['Pixel 7']` y `devices['iPad Mini']`):
  - entrar al juego, caminar tocando y con el pad;
  - atacar a una criatura con un toque;
  - hablar con un NPC;
  - mover un item del inventario al suelo con toque y destino;
  - abrir el chat.
  - Screenshots revisados con Read, en vertical y en horizontal.
- Que nada de escritorio cambie de comportamiento: los e2e existentes siguen en verde.
- Un screenshot a 1280x800 con un personaje de nombre largo muestra el mapa a 2x.

#### 5. Docs
- client/CLAUDE.md (input táctil, layout).
- docs/00 (la línea de plataforma no cambia: móvil sigue siendo secundario).
- docs/08 (e2e móvil) y el doc de instalación móvil.
- T5.6 marcada en el roadmap, con lo 👤 pendiente.

#### Reglas
- Servidor autoritativo: el cliente solo envía intenciones, igual que con el mouse.
- Nada de strings hardcodeados.
- Sin dependencias pesadas nuevas. Si agregas una, que tenga licencia compatible y esté justificada.

#### Cómo trabajar
1. **Lee primero:**
   - CLAUDE.md, client/CLAUDE.md y apps/desktop/CLAUDE.md;
   - docs/00, docs/05, docs/07 (presupuesto del cliente), docs/08 y docs/12/13;
   - `client/src/input`, `game.ts`, `ui/App.tsx`, `client.css` y los e2e.
2. **Haz un plan corto y síguelo** sin pedir confirmación.
3. **Definición de terminado:**
   - `make lint test validate` y `make e2e` en verde, más `make test-integration` si tocas algo del servidor;
   - screenshots revisados;
   - `code-reviewer` una vez;
   - docs actualizados;
   - si cambias rutas que filtra la CI, revisa `.github/scripts/ci-changes.sh` y su `self_test`.
4. Título del PR en inglés, estilo Conventional Commits (por ejemplo `feat(client): touch controls and small-screen layout (T5.6)`); la descripción, en español.

## T5.7: brief (hecha, se deja como referencia)
Implementa **T5.7 Tienda cosmética con pasarela de pago** de `10-roadmap.md`. Decisiones
cerradas (`00-vision.md`): la monetización es solo cosmética, nunca da ventaja de juego,
y el modelo ya prevé las tablas `cosmetics` y `account_cosmetics`.

### Alcance (rama `feat/t5.7-cosmetics`, desde main, idealmente después de T0.5)
- **Diseño en docs/02 ("Tienda cosmética"):**
  - Una moneda premium con nombre propio, comprada con dinero real. No se puede
    intercambiar, ni pasa por el mercado ni se convierte en oro: así no compra ventaja
    por la puerta de atrás.
  - Catálogo en `data/cosmetics.yaml`, validado con esquema e i18n: atuendos y colores
    del personaje, adornos visuales y quizá un marco del nombre.
  - Nada que cambie stats, velocidad, XP, botín, capacidad ni tiempos.
  - Sin cajas de botín: cada compra es exactamente lo que se ve.
  - Lo comprado es de la cuenta (`account_cosmetics`) y se equipa por personaje.
  - Política de reembolso y de cuentas suspendidas.
- **Pagos:**
  - Una interfaz de proveedor (`server/internal/payments`) con dos implementaciones:
    - un proveedor falso, para tests y e2e;
    - el del proveedor que elijas, en modo prueba (por ejemplo Stripe o Mercado Pago).
  - Checkout alojado por el proveedor: el servidor nunca toca datos de tarjeta.
  - Webhook con firma verificada e idempotencia por id de evento.
  - Acreditación en una transacción con un log auditable.
  - Reembolsos y contracargos que descuentan saldo, y si no alcanza, marcan la cuenta.
  - Límites por cuenta.
  - Las claves van por variables de entorno, nunca en el repo.
  - Todo apagado si no hay proveedor configurado.
- **Servidor:**
  - Compra con saldo y equipar o desequipar por mensaje de protocolo.
  - Los cosméticos equipados viajan en `Creature`, y el render los dibuja.
  - Comando de staff para dar o quitar saldo y ver compras, auditado.
- **Cliente y sitio:**
  - Tienda en el sitio (`/shop`, solo con sesión iniciada), con el saldo, el catálogo y el
    historial.
  - En el juego, un panel para equipar lo comprado.
  - Textos en es y en.
- **Tests:**
  - firma y webhook duplicado;
  - concurrencia de compras;
  - que ningún cosmético cambie el combate (sim);
  - integración con Postgres;
  - e2e con el proveedor falso: comprar saldo, comprar un atuendo, equiparlo y verlo en
    otro jugador.
- **Docs:** docs/01, 02, 05, 06 y 09 (variables del proveedor y webhook en Caddy), y el
  roadmap.

## Sprites: de dónde sale cada uno
T0.5 quedó hecha (PR #77) y ya no hay placeholders:
- **Pack Dungeon Crawl** (CC0, `assets/vendor/dungeon-crawl/`): suelos de pasto, arena,
  tierra, piedra y agua, muros de piedra y roca, árboles, casi todos los monstruos y NPCs,
  armas, armaduras e items de misión. El mapeo está en `assets/sprites.yaml`.
- **Arte propio** (`tools/spritegen`, CC0): lo que el pack no tenía (madera, muelle,
  yunque, cajón, bolardo, tablero, pino, peñasco, gaviota, jabalí, ciervo, el barquero,
  materiales, comida, herramientas, monedas de cobre y plata, mochila), el jugador
  (outfit `citizen` en `assets/sprites/outfits/citizen/<n|e|s|w>_<0|1|2>.png`, y los
  atuendos de la tienda) y las marcas PvP (`assets/sprites/ui/marks/`). Las criaturas
  propias llevan la misma sombra proyectada que las del pack (`assets/README.md`, "Sombra
  de las criaturas").
- **Efectos de combate y magia** (arte propio, `tools/spritegen/src/recipes/effects.ts`):
  una tira animada de 6 frames por cada `effect_id` del servidor, en
  `assets/sprites/effects/<nombre>/<n>.png`. El cliente la juega en 600 ms
  (`client/CLAUDE.md`, "Sprites de efectos"); sin arte, la forma Pixi de antes. Los
  proyectiles y los números flotantes siguen siendo formas y texto de Pixi.
- **Bordes** (`assets/sprites/borders/`): `gen-borders.ts` recorta la textura del suelo de
  origen.

Para cambiar un sprite: otro tile del pack en `sprites.yaml`, o una receta nueva en
`tools/spritegen/src/recipes/` y `make spritegen ONLY=<ruta>` (estilo y reglas en
`assets/README.md`, "Arte propio"). Después, `make sprites` y revisar con Read.

Qué reemplazar primero y con qué está en `17-direccion-de-arte-y-ui.md` (SRC-4): muros,
pasto y suelos, agua, atuendos, NPCs, monstruos y árboles. Desde el 2026-11-17 también se
pueden usar assets CC-BY-SA (Liberated Pixel Cup, con licencia por archivo) y fuentes OFL
(`assets/README.md`).
