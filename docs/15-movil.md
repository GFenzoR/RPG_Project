# 15 — Móvil: PWA instalable y Tauri Android/iOS

La plataforma no cambia (`00-vision.md`): **PC primero, móvil secundario**. T5.6 deja el
cliente web jugable con el dedo y lo hace instalable de dos formas:

| Camino | Qué es | Quién lo hace | Estado |
|---|---|---|---|
| **PWA** | El mismo sitio, instalado desde el navegador del teléfono. Sin tiendas ni firmas | Cualquier jugador | Listo: basta servirlo por HTTPS |
| **Tauri mobile** | App nativa Android/iOS que envuelve el build web, como la de escritorio | 👤 el dueño (SDKs, firmas, cuentas) | Preparado, sin compilar |

Lo marcado con 👤 necesita cuentas, pagos o máquinas del dueño: Claude no puede hacerlo.

## PWA (lo que ya funciona)

### Qué se instala
- `client/public/manifest.webmanifest`: nombre "Neque's Realm", `display: fullscreen` con
  `display_override: ["fullscreen", "standalone"]` (lote 21: sin interfaz del navegador),
  `orientation: any` (vertical y horizontal), `start_url` y `id` `/play/` (abre el juego,
  no la landing), color de fondo y de tema `#090807` (el `--ui-void` del tema gótico).
- Íconos con el emblema del juego (escudo y espada, sobre ese mismo fondo desde el lote 21)
  en `client/public/icons/`: 192, 512, 512 *maskable* (con el margen que
  recortan los launchers de Android) y 180 para iOS (`apple-touch-icon`). Son pixel art
  propio (CC0, `assets/CREDITS.md`) generado por
  `node --experimental-strip-types tools/spritegen/src/pwa-icons.ts`; para cambiarlos,
  edita el dibujo y vuelve a correr el script (el test de spritegen exige que los PNG
  coincidan con el código). Cuando haya un logo de verdad, reemplaza el dibujo.
- Las dos páginas (`client/index.html` y `client/play/index.html`) enlazan el manifest y
  traen `theme-color` y el viewport móvil:
  `viewport-fit=cover` (la página llega bajo el notch: el padding de `.game` usa
  `env(safe-area-inset-*)` una vez, y lo que va sobre el mapa mide desde ahí; lo que va
  `fixed` a la pantalla, fuera de ese padding, toma los insets en sus propios bordes: las
  ventanas en teléfono y el menú del toque largo) e `interactive-widget=resizes-content` (el teclado virtual
  achica la página en vez de taparla, para que el chat se vea al escribir).

### Service worker: solo el shell estático
`client/src/sw.ts` se compila como `/sw.js` (alcance `/`: sitio y juego). Qué hace con cada
request lo decide `client/src/sw/policy.ts` (puro, con tests):

| Request | Estrategia |
|---|---|
| `/api/*`, `/ws`, `/healthz`, `/grafana/*`, otro origen, no-GET, `Range` (audio), la música (`/audio/sounds/music/`), `/sw.js` | **Nunca** se intercepta: va a la red como sin worker |
| Páginas (navegación) | Red primero; la caché solo si no hay red |
| `/assets/*` (archivos con hash de Vite) | Caché primero (son inmutables) |
| Resto (atlas, sonidos, íconos, manifest) | Se sirve la caché y se actualiza en segundo plano |

- Cada build tiene su versión (`__RPG_SW_VERSION__` en `client/vite.config.ts`; fija con
  `RPG_BUILD_ID` si quieres builds reproducibles). Un deploy instala un worker nuevo que
  borra las cachés de versiones anteriores al activarse.
- Sin red el juego **no** se juega (es online): a lo sumo abre la pantalla de login, que
  dirá que no hay conexión. La caché es para cargar rápido, no para jugar offline.
- Se registra solo en un build de producción, en un contexto seguro y fuera de la app
  Tauri (`client/src/pwa.ts`, `shouldRegisterServiceWorker`). En `make dev` no hay worker.
- Caddy (`deploy/caddy-routes.caddy`, igual en AWS y en casa) sirve el manifest como
  `application/manifest+json` y `/sw.js` con `Cache-Control: no-cache, max-age=0` y
  `Service-Worker-Allowed: /` (ver `09-deployment-aws.md` y `13-hosting-de-pruebas.md`).

### Cómo se instala (jugador)
Hace falta **HTTPS** (el dominio real o el link del túnel de `13-hosting-de-pruebas.md`);
por `http://` en la LAN se juega, pero el navegador no ofrece instalar.

- **Android (Chrome, Edge, Samsung Internet):** abre `https://<servidor>/play/` → menú ⋮ →
  **Instalar app** (o el aviso "Agregar a la pantalla principal").
- **iPhone / iPad (Safari):** abre `https://<servidor>/play/` → botón Compartir →
  **Agregar a inicio**. En iOS solo Safari instala PWAs (desde iOS 16.4 también otros
  navegadores, con el mismo menú Compartir).
- **PC (Chrome, Edge):** ícono de instalar en la barra de direcciones. La app de escritorio
  (Tauri) sigue siendo la recomendada en PC.

Desde el lote 21 el propio juego ofrece los botones "Pantalla completa" e "Instalar como
app" (ver "Pantalla completa e instalar como app", abajo), así que el menú del navegador ya
no es el único camino.

Para actualizar no hay que hacer nada: al reabrir, la página llega de la red, y una app que
quedó abierta avisa "Hay una nueva versión disponible" con un botón para recargar. Si algo queda
raro después de un deploy: cerrar la app instalada y abrirla de nuevo; en último caso,
Ajustes del navegador → Sitios → borrar datos del sitio.

### Problemas comunes (PWA)
| Síntoma | Causa y arreglo |
|---|---|
| No aparece "Instalar" | No es HTTPS, o el manifest no llega como `application/manifest+json` (`curl -sI .../manifest.webmanifest`), o falta un ícono. DevTools → Application → Manifest muestra el error |
| El worker no se registra | `/sw.js` respondió HTML (no está en el build: revisa `build/client/sw.js`) o el sitio no es seguro. Consola: `[pwa] service worker not registered` |
| Se ve una versión vieja | El navegador revalida `/sw.js` al navegar; cierra y abre la app. Comprueba que Caddy mande `Cache-Control: no-cache` en `/sw.js` |
| El juego no conecta en la PWA | Igual que en el navegador: el worker no toca `/api` ni `/ws`. Revisa el servidor y el túnel |

## La interfaz en teléfonos y tablets

Desde el lote 21 la pantalla de juego de teléfonos y tablets es el **HUD móvil**: el mapa
sobre una barra gótica con orbes, experiencia, hotbar paginada y botones con íconos pixel;
las secciones en una hoja (vertical) o un cajón (apaisado); el chat como registro compacto
sobre el mapa. El diseño, los cortes por tamaño (qué recibe un teléfono, una tablet vertical
y una apaisada) y cómo se verifica están en `docs/17-direccion-de-arte-y-ui.md`, "UI móvil";
los gestos táctiles, en `client/CLAUDE.md` "Notas de T5.6". Vista previa sin servidor:
`make ui-preview SIZES=phone,tablet`.

## Controles táctiles (lote 21, rama `feat/mobile-touch`)

Pedido del dueño (2026-11-24): todo el juego con los dedos, cómodo, y sin perder el teclado
y el mouse si alguien los conecta a la tablet. Los gestos de T5.6 siguen (ver
`client/CLAUDE.md` "Notas de T5.6"); este lote suma la palanca, los botones de acción,
mantener para caminar, la entrada híbrida, la vibración y el modo app.

### Auditoría: cada acción y su camino táctil

Estado: **hecho** = de este lote, con test; **existía** = venía de T5.6 o del HUD móvil y no
cambió; **sin E2E** = el camino existe pero no tiene un E2E táctil propio; **pendiente** =
falta (está en `docs/14` "Pendientes conocidos").

| Acción | Escritorio | Táctil | Estado |
|---|---|---|---|
| Caminar en 8 direcciones | Flechas, WASD (dos teclas = diagonal) | Pad de 8 botones o palanca analógica (Opciones → Controles táctiles) | hecho (palanca), existía (pad) |
| Caminar a una casilla | Click izquierdo | Toque en la casilla | existía |
| Mantener para caminar | Botón izquierdo mantenido | Arrastrar el dedo sobre el mapa: camina hacia el dedo mientras esté abajo | hecho |
| Girar sin caminar | Toque corto de tecla, Ctrl+flecha | Toque corto en el pad o la palanca hacia otro lado | existía (pad), hecho (palanca) |
| Apuntar a una criatura | Click derecho, lista de batalla | Toque en la criatura; botón "Atacar al más cercano / Siguiente objetivo"; lista de batalla en la hoja | hecho (botón), existía (toque) |
| Perseguir | Casilla de la ventana de batalla | Botón de la bota en los botones de acción; la casilla en la sección Batalla | hecho |
| Postura y modo seguro | Ventana de batalla | Sección Batalla de la hoja | existía |
| Hechizos de la hotbar | F1–F12, click | Toque en el slot (cualquier dedo), y los dos primeros repetidos en los botones de acción | hecho (multitáctil) |
| Hechizo apuntado, runa en casilla u objetivo | Tecla y click | Toque en el slot y después en la criatura o la casilla | existía, sin E2E |
| Herramienta "usar con" (pico, hacha, soga) | Click derecho o doble click y click | Menú del toque largo → "Usar con…" y toque en la casilla | existía, sin E2E |
| Romper un objeto del mundo vivo | Click derecho / doble click | Botón de contexto ("Romper") frente al objeto; menú del toque largo → "Usar" | hecho (botón), sin E2E |
| Empujar una roca | Caminar contra ella | Pad o palanca contra ella; botón de contexto ("Empujar") | existía (pad), hecho (botón), sin E2E |
| Escaleras y rampas | Caminar | Caminar con pad, palanca o toque | existía |
| Escalera de mano, punto de soga | Click derecho | Botón de contexto ("Trepar" / "Usar"); menú del toque largo | hecho (botón), existía (menú) |
| Saquear un cuerpo, abrir un contenedor | Click derecho → Abrir, doble click | Botón de contexto ("Saquear" / "Abrir"); menú del toque largo → "Abrir" | hecho (botón), sin E2E |
| Hablar con un NPC | Click derecho | Toque en el NPC; botón de contexto ("Hablar") | hecho (botón, con E2E), existía (toque) |
| Mirar | Mayús+click | Botón del ojo y toque en lo que se quiere mirar; "Mirar" en el menú del toque largo | hecho (ojo), existía (menú) |
| Usar el item de arriba | Ctrl+click derecho | Menú del toque largo → "Usar" / "Abrir" (usan el item de arriba, también sobre una escalera de mano) | existía |
| Mover un item | Arrastrar | Tocar el item y después el destino; arrastrar con el dedo; "Mover" del menú | existía |
| Mover parte de una pila | Mayús+arrastrar | Menú del toque largo → "Mover parte…" | existía |
| Alijo, mercado, intercambio, tienda, forja | Ventanas | Hojas del lote 21 (`feat/mobile-windows`) | existía, sin E2E táctil del alijo |
| Minimapa: desplegar, mover, zoom, seguir objetivo | Mouse y rueda | Botón "Mapa", arrastre y botones del minimapa | existía (HUD móvil) |
| Zoom del mapa | Ctrl+rueda | Pellizco y botones + / − | existía |
| Chat: canal, susurro, comandos | Ventana del chat | Toque en el registro compacto → sección Chat, con el teclado virtual | existía |
| Teclas de ventana (I, K, L, B, P, G, O, H, M) | Teclado | Botones de sección de la consola o del cajón | existía |
| Ayuda | H | Menú ☰ → Ayuda (texto táctil primero) | hecho (texto) |
| Salir, opciones | Botonera, Escape | Menú ☰ (siempre a la vista: consola en vertical, barra en apaisado) | existía |
| Pantalla completa | F11 del navegador | Botón "Pantalla completa" (login, personajes, menú ☰, Opciones) | hecho |

### Palanca o pad
- **Pad** (`ui/TouchPad.tsx`): ocho botones de 44 px; el dedo puede deslizarse de uno a otro.
- **Palanca** (`ui/TouchStick.tsx`, reglas en `input/joystick.ts`): un aro de hierro con un
  pomo de borde dorado. El mundo es de casillas, así que la palanca no da velocidad: pasada
  la zona muerta (28 % del radio) sostiene una de ocho direcciones, con histéresis de 0,02
  de vuelta para que el pulgar apoyado en un borde no parpadee entre dos.
- Las dos llaman a `Game.padPress` / `padRelease`: girar con un toque, caminar manteniendo
  y empujar una roca caminando contra ella funcionan igual que con las teclas.
- **Por defecto queda el pad.** No se pudo comparar con dedos reales en esta rama (los E2E
  usan toques sintéticos), y el pad tiene test y uso desde T5.6: sus ocho blancos dicen
  exactamente qué paso se pide en un mundo de casillas. La palanca está a un toque en
  Opciones; que el dueño decida el valor por defecto al probar en su teléfono (`docs/14`).

### Botones de acción (`ui/ActionCluster.tsx`)
Un grupo de botones redondos de hierro junto al pulgar que no camina, sobre el mapa:
- **Atacar** (espadas): sin objetivo, el monstruo más cercano; con objetivo (diana roja), el
  siguiente de la lista de batalla. Nunca elige un jugador ni un NPC (`input/targeting.ts`):
  un pulgar no puede empezar una pelea PvP por accidente.
- **Contexto**: hace lo que corresponde en la casilla de enfrente, después en la propia y
  después en las de alrededor (`input/context-action.ts`): hablar, atacar, trepar, abrir,
  saquear, leer, romper, empujar (solo de frente y en línea recta) o usar. El ícono cambia
  con la acción y el botón se apaga si no hay nada que hacer. No levanta, come ni equipa lo
  que haya en el suelo: eso es del menú del item.
- **Mirar** (ojo): el siguiente toque en el mapa mira en vez de actuar.
- **Perseguir** (bota): el mismo interruptor de la ventana de batalla.
- **Dos hechizos**: los dos primeros slots de la hotbar que tengan uno.

Opciones → Controles táctiles: mostrarlos u ocultarlos, **para zurdos** (botones a la
izquierda y pad o palanca a la derecha), **tamaño** (chico 44 px, normal 52, grande 62) y
**mantenerlos en pantalla** con teclado o mouse. Se guardan en el dispositivo
(`rpg.touch`, `state/touch-controls.ts`), no en la cuenta: otro teléfono se sostiene distinto.

### Multitáctil y gestos que no se pelean
- Cada control sigue a **un** dedo (`PointerOwner`, `input/pointers.ts`): un segundo contacto
  sobre el pad (la base del pulgar) ni cambia la dirección ni detiene la caminata al
  levantarse, y un contacto de 70 px o más (la palma) se ignora.
- Los navegadores solo mandan `click` para un dedo solo. Por eso los botones de acción y
  los slots de la hotbar actúan en el `pointerup` de un dedo (`ui/tap.ts`, `TapGuard`) y
  descartan el `click` que pueda seguirle: se puede caminar con un pulgar y lanzar o
  apuntar con el otro.
- `.game` lleva `touch-action: pan-x pan-y` y `overscroll-behavior: none`: sin zoom de
  página por pellizco o doble toque, sin "tirar para recargar"; el mapa, el pad, la palanca
  y los botones llevan `touch-action: none`. En pantallas táctiles no se selecciona texto
  ni sale el menú del sistema con el toque largo, salvo en campos de texto.

### Entrada híbrida (teclado y mouse en una tablet o un teléfono)
El método de entrada se decide **por evento**, nunca por el layout ni por el tipo de
dispositivo: `pointerType` (`mouse`, `touch`, `pen`) en el canvas y en los items, y eventos
de tecla reales en la ventana. En el layout móvil funcionan las flechas y WASD con
diagonales, F1–F12, las teclas de ventana, Escape (cierra la hoja de arriba), Enter para el
chat, Ctrl y Mayús; y con un mouse, click para caminar y mantener, click derecho según el
modo de controles, Mayús+click, Ctrl+click derecho, doble click, Ctrl+rueda, arrastrar y
soltar. Al revés, una laptop con pantalla táctil en el layout de escritorio conserva sus
gestos.

`input/input-mode.ts` recuerda el último método (`InputMode`): con mouse o teclado
(`.game[data-input]`, `data-controls="faded"`) el pad o la palanca y los botones se
atenúan, y donde hay un puntero fino dejan pasar el mouse al mapa; vuelven con el siguiente
toque. Escribir en un campo de texto o las teclas de un teclado virtual no cuentan como
teclado. "Mantener los controles en pantalla" los fija.

### Vibración
`state/haptics.ts`: un pulso corto al recibir un golpe (más largo si es fuerte), al subir de
nivel y cuando el servidor rechaza un paso. Los golpes se espacian 250 ms. El interruptor
solo aparece donde `navigator.vibrate` existe (Safari de iOS no vibra).

### Rendimiento en teléfonos
Al primer arranque, una prueba rápida (`lowEndDevice`: pantalla táctil con 4 GB o menos, o 4
núcleos o menos) elige **Efectos reducidos**: sin partículas de ambiente y con el mundo vivo
quieto (viento, bichos), pero con pasos, ataques y muertes animados. Se cambia en Opciones
(`rpg.effects`). Las sombras no tienen todavía un interruptor propio (`docs/14`).

## Pantalla completa e instalar como app (lote 21)

Pedido del dueño (2026-11-24): en el móvil el juego llena la pantalla, sin la barra de
direcciones, y hay un botón para dejarlo instalado y entrar directo.

| Plataforma | Pantalla completa | Instalar | Qué muestra el juego |
|---|---|---|---|
| Android (Chrome, Edge, Samsung) | Fullscreen API | `beforeinstallprompt` → `prompt()` | Botón "Pantalla completa" y, cuando el navegador lo permite, "Instalar como app" |
| PC (Chrome, Edge) | Fullscreen API | igual | Los dos botones (la app de escritorio sigue siendo la recomendada) |
| iPadOS (Safari) | Fullscreen API | Compartir → "Agregar a pantalla de inicio" | "Pantalla completa" e "Instalar como app", que abre los pasos ilustrados |
| iPhone (Safari y demás) | **No existe para páginas** | Compartir → "Agregar a pantalla de inicio" | Sin botón de pantalla completa; "Instalar como app" abre los pasos, y Opciones explica que es la única forma de perder la barra |
| Firefox y otros | Fullscreen API | menú del navegador | Solo "Pantalla completa" |
| Ya instalada (`display-mode` standalone o fullscreen, `navigator.standalone`) | no hace falta | ya está | Ningún botón |
| App de escritorio (Tauri) | la ventana | es la app | Ningún botón |

- Las reglas son puras en `state/install.ts` (`detectPlatform`, `installOffer`,
  `fullscreenOffer`, `fullscreenReoffer`, `appModeReduce`, con tests de cada caso de la
  tabla); `ui/app-mode.ts` es el único almacén de la página (se importa al arrancar: Chromium
  manda `beforeinstallprompt` una vez, temprano) y `ui/AppMode.tsx` los botones.
- **Dónde:** en la esquina del login y de la pantalla de personajes, en el menú ☰ del juego
  y en Opciones. La oferta de instalar se puede cerrar ("No mostrar más") y queda
  recordada (`rpg.appMode`); desde entonces solo está en Opciones. Rechazar el aviso del
  navegador cuenta como cerrarla.
- **Pantalla completa** se pide en el gesto del botón, con `navigationUI: "hide"`. Se
  recuerda: si el navegador la abandona (rotación, gesto atrás, recarga), el botón queda
  resaltado y sobre el mapa aparece una oferta de un toque para volver (entrar exige un
  gesto, no se puede hacer solo). Las áreas seguras siguen las reglas de `.game`.
- **Manifest:** `display: fullscreen` con `display_override: ["fullscreen", "standalone"]`,
  `start_url` `/play/`, `orientation: any` (no se bloquea), colores `#090807` (`--ui-void`);
  `src/manifest.test.ts` lo comprueba. iOS: `apple-mobile-web-app-capable`,
  `black-translucent`, `apple-mobile-web-app-title` y `apple-touch-icon`. Sin pantallas de
  inicio (*splash*) propias para iOS: piden una imagen por tamaño de dispositivo (`docs/14`).
- **Instalada**, la app abre `/play/` directo en el login, con el email recordado (reglas de
  sesión del lote 17), sin interfaz del navegador.
- **Actualizaciones:** el worker nuevo toma la página (`skipWaiting` + `clients.claim`);
  `pwa.ts` lo anuncia (`isAppUpdate`) y aparece "Hay una nueva versión disponible.
  Recargar". Una app que quedó abierta busca una versión nueva al volver al frente.
- **Rotación:** el layout cambia sin reemplazar el canvas (las `key` de `.viewport` y
  `.game-body`). **Pantalla encendida:** mientras se juega se pide el *wake lock*
  (`keepAwake`), y se vuelve a pedir al regresar a la pestaña.

## QA móvil (lote 21, rama `feat/mobile-qa`)

Sin funciones nuevas: buscar y arreglar lo roto o feo en teléfonos y tablets.

### Cómo se revisa
- **Auditoría táctil** (`client/e2e/touch-audit.ts`, `docs/08` "Auditoría táctil"): mide
  áreas de toque de 44 px, textos cortados, controles fuera de pantalla, desplazamiento
  lateral y áreas seguras. Corre sobre las 49 escenas de `make ui-preview AUDIT=1` en cinco
  tamaños táctiles (390x844, 844x390, **748x298**, 768x1024, 1024x768), en español y en
  inglés (`UILANG=en`), y en el juego con los tests "lote 21 QA on …" de
  `e2e/mobile.spec.ts`.
- **Hojas de contacto** (`client/e2e/contact-sheet.ts`): todas las capturas de un tamaño en
  pocas imágenes, para mirarlas de una vez.
- **Pasada en un teléfono real** (`client/e2e/device-check.ts`, abajo).

### Qué se encontró y se arregló
| Problema | Dónde | Arreglo |
|---|---|---|
| 577 hallazgos de la auditoría en la primera corrida: botones de ícono, casillas de la forja, flechas de página, la × de un item ofrecido y filtros de la tienda de 29 a 41 px de ancho; muestras de color de 32 px; casillas de verificación de 24 px; "Cuenta y seguridad" de 20 px de alto | todos los tamaños | Con puntero grueso, todo `button` y `summary` mide 44 px también de ancho, la etiqueta de una casilla o un radio es el objetivo (44 px) y las muestras miden 44 px (`client.css`, bloque `pointer: coarse`) |
| El chequeo de presencia, la invitación al grupo y la del gremio se dibujaban una sobre otra, bajo los botones de acción (vertical) y sobre la columna derecha del pad (apaisado) | teléfono y tablet vertical | Van en una sola columna (`.alerts` de `GameView`), el chequeo primero; lo que no entra se desplaza. Apaisado, entre el pad y los botones |
| Los botones de acción flotaban sobre la hoja o el cajón y se quedaban con los toques (en inglés, la tercera pestaña del diario quedaba bajo "atacar") | teléfono | Se ocultan mientras la hoja o el cajón están abiertos |
| Modo zurdo, apaisado: los botones de acción quedaban sobre la palanca | 844x390 | `right: auto` en la regla espejada (la de la fila era más específica) |
| Apaisado: los botones de acción tapaban el texto del tutorial y "Saltar tutorial" | 844x390 | Las pistas cuelgan a la izquierda de los botones |
| **Teléfono real** apaisado dentro del navegador (748x298): el botón del chat subía bajo la barra del minimapa y salía de la pantalla | Galaxy S22 Ultra | Con menos de 350 px de alto, el chat va a la derecha del pad. `make ui-preview` dibuja ese tamaño |
| **Teléfono real** (384 px de ancho): la esquina del login ("Pantalla completa", "Instalar como app", idioma, "Opciones") tapaba el nombre del juego, el título "Entrar" y la etiqueta del email; idioma y "Opciones" medían 31 y 32 px de alto | Galaxy S22 Ultra | En pantallas de hasta 640 px de ancho o 500 de alto la esquina es una franja propia arriba del título, con sus áreas seguras; sus controles miden 44 px |

Después de los arreglos la auditoría da **0 hallazgos** en las escenas de la vista previa
(es y en) y en el teléfono real. Lo que se deja pasar a propósito (`AUDIT_ALLOW`): el menú
de item de la escena `itemmenu` (es el del mouse), el nombre de un hechizo cortado en su
slot y el título de una ventana flotante angosta.

### Pasada en un teléfono real
Hecha el 2026-11-27 en un **Samsung Galaxy S22 Ultra** (SM-S908E, Android 16, Chrome 158,
1080x2316, tres botones de sistema), por USB. Sin servidor de juego en esa etapa (la regla
del lote: Docker y el servidor corren una vez al final), así que el teléfono abrió la **vista
previa** (`build/ui-preview`, la interfaz real con estados inventados y una imagen por mapa)
y el **build de producción** del cliente (login, manifest y service worker) desde un
servidor de archivos en la PC, con `adb reverse`.

| Qué | Resultado |
|---|---|
| Página en Chrome, vertical | 384x692 px CSS a 2,8125x: más angosta y mucho más baja que el 390x844 de la emulación (barra de estado, de direcciones y botones del sistema) |
| Página en Chrome, apaisado | **748x298**: la barra de direcciones se queda. Por eso "Pantalla completa" importa tanto en un teléfono |
| Áreas seguras (`env(safe-area-inset-*)`) en una pestaña | 0 en los cuatro lados: Chrome deja la página fuera del notch y de los botones. A pantalla completa o instalada no se midieron (ver pendientes) |
| Auditoría táctil | 0 hallazgos en 11 escenas en vertical y 8 en apaisado, después de los dos arreglos de arriba |
| Cuadros por segundo de la interfaz (sin el canvas del juego) | 59 a 60, peor cuadro 17 a 34 ms |
| Manifest | 200, `application/manifest+json`; color de tema `#090807` aplicado a la barra de Chrome |
| Service worker | activo y controlando la página; con el servidor apagado, recargar abre igual el login (el shell en caché) |
| Instalar | Chrome mandó `beforeinstallprompt`: aparece "Instalar como app". No se instaló (no hace falta para ninguna prueba y es el teléfono personal del dueño) |
| Pantalla completa | Un toque real en el botón entra (`fullscreenElement`, el botón pasa a "Salir de pantalla completa"); que la barra de direcciones desaparezca no quedó confirmado en la captura |
| Aviso de versión nueva | Tras un build nuevo apareció "Hay una nueva versión disponible. Recargar" |
| `navigator.vibrate`, *wake lock* | Existen; no se comprobó que vibre ni que la pantalla no se apague |
| Teclado virtual | Sin comprobar: al tocar el campo del email, Chrome abrió su hoja de contraseñas guardadas en lugar del teclado, y no se siguió |

Para repetirla (el teléfono con depuración USB y Chrome abierto), en una sola línea cada
comando:

```
adb reverse tcp:8080 tcp:8080
adb forward tcp:9333 localabstract:chrome_devtools_remote
node --experimental-strip-types client/e2e/device-check.ts --cdp http://localhost:9333 --base http://localhost:8080 --pages "play/?lang=es" --out build/device --tag vertical
adb forward --remove tcp:9333
adb reverse --remove-all
```

El script abre una pestaña propia, mide (tamaño, áreas seguras, modo, cuadros por segundo,
auditoría), guarda una captura por página y cierra su pestaña; no mira las demás. No uses el
puerto 9222: suele tenerlo el Chrome de la PC. Con `make ui-preview` hecho, las escenas se
sirven con cualquier servidor de archivos sobre `build/ui-preview` y `--pages
"preview/?scene=game&mapx=35&mapy=13&lang=es"`.

### Lo que esta etapa no pudo comprobar
Sin servidor de juego no se jugó nada de punta a punta en el teléfono ni se corrió
`make e2e`: los E2E nuevos se escribieron a ciegas, como los de las otras ramas del lote, y
los corre la etapa final. La lista para el dueño, con los pasos, está en `docs/14`
("Móvil, QA").

## Tauri mobile (preparado; compilarlo es 👤)

### Por qué en `apps/desktop` y no en `apps/mobile`
Tauri 2 compila el mismo proyecto para escritorio, Android e iOS. La parte propia en Rust
(elegir servidor, la API con el token fuera del webview, la CSP con el origen del WS) es la
misma en todos: un `apps/mobile` la duplicaría o tendría que sacarla a otro crate. Así
`config.rs`, `api.rs`, los comandos, las capabilities y el selector de servidor de T2.x
valen para los tres. Los proyectos nativos que generan `tauri android init` y
`tauri ios init` quedan en `apps/desktop/src-tauri/gen/android` y `gen/apple`, y **se
commitean** (Tauri los trata como código fuente; `gen/schemas` sigue ignorado).

### Qué quedó listo en el repo
- `Cargo.toml`: la librería ya es `crate-type = ["staticlib", "cdylib", "rlib"]` (lo que
  cargan Android e iOS).
- `src/lib.rs`: `run()` lleva `#[cfg_attr(mobile, tauri::mobile_entry_point)]`; en
  escritorio lo sigue llamando `main.rs`.
- `tauri.conf.json`: identificador `dev.rpgproject.client` (válido como *package name* de
  Android y *bundle id* de iOS; **no lo cambies** después de publicar), `android.minSdkVersion`
  24 (Android 7) e `iOS.minimumSystemVersion` 14.0. La ventana `main` abre
  `play/index.html` igual que en escritorio (ancho y alto se ignoran en móvil).
- `capabilities/default.json`: la misma capability (solo `server_info`, `api` y
  `set_server`) declarada para `linux`, `macOS`, `windows`, `android` e `iOS`.
- `config.rs`: en Android el `config.json` del selector de servidor vive en el
  almacenamiento interno de la app (`/data/data/dev.rpgproject.client/files/`); en iOS, en
  `Library/Application Support/dev.rpgproject.client/` dentro del sandbox. El selector de
  la pantalla de login funciona igual.
- `client/vite.config.ts`: con `TAURI_DEV_HOST` (lo define `tauri android dev`) Vite escucha
  en tu IP de la LAN para que el teléfono cargue el cliente en desarrollo.

### Pendiente de comprobar en un dispositivo 👤
Nada de esto se compiló: el entorno donde se preparó no tiene Rust ni el NDK. En la
primera compilación revisa:
1. **Sesión:** desde el lote 17 el juego nunca guarda el login en ninguna plataforma: el
   token vive solo en memoria y hay que entrar de nuevo cada vez que se abre la app (en
   Android el borrado del token viejo del llavero no hace nada: `keyring` 3 no tiene
   backend de Android).
2. **Selector de servidor:** después de "Guardar y reiniciar" la app intenta reiniciarse
   (`AppHandle::restart`). En móvil puede que solo se cierre: ábrela de nuevo y debería
   usar el servidor nuevo.
3. **HTTP plano:** Android (release) e iOS bloquean `http://` en el webview. Usa siempre
   un servidor `https://` (el dominio o el túnel). Para probar contra la LAN usa un build de
   debug de Android (`tauri android dev` permite *cleartext*).
4. **Orígenes del WebSocket:** el webview de Android usa `http://tauri.localhost` y el de
   iOS `tauri://localhost`. El compose de producción ya permite los dos en
   `RPG_WS_ORIGINS`; si lo cambiaste, inclúyelos.
5. **Íconos nativos:** genera los de Android/iOS desde el ícono de escritorio:
   `pnpm --filter @rpg/desktop tauri icon src-tauri/icons/icon.png` (después de `init`).

### Android 👤
1. **Herramientas** (Windows, macOS o Linux):
   - Android Studio. En *SDK Manager*: Android SDK Platform (34 o la que pida Play),
     *Android SDK Build-Tools*, *Platform-Tools*, *Command-line Tools* y **NDK (Side by side)**.
   - Rust: `rustup` y
     `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`.
   - Variables de entorno (ejemplo en Windows con Git Bash):
     ```bash
     export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
     export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
     export NDK_HOME="$ANDROID_HOME/ndk/<versión instalada>"
     ```
2. **Inicializar** (una vez, y commitear `apps/desktop/src-tauri/gen/android`):
   ```bash
   pnpm install
   pnpm --filter @rpg/desktop tauri android init
   pnpm --filter @rpg/desktop tauri icon src-tauri/icons/icon.png
   ```
3. **Probar** con el teléfono en *Depuración USB* (o un emulador):
   ```bash
   make run-server     # o el servidor de casa / el túnel
   pnpm --filter @rpg/desktop tauri android dev
   ```
   En la pantalla de login, "Servidor: …" → la IP de tu PC (`http://192.168.1.20:8080`) o
   el link HTTPS del túnel.
4. **Firmar** (la llave es para siempre: si se pierde no se puede actualizar la app):
   ```bash
   keytool -genkey -v -keystore ~/rpg-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
   ```
   Crea `apps/desktop/src-tauri/gen/android/keystore.properties` (**no se commitea**:
   agrégalo a `.gitignore`) con `password`, `keyAlias` y `storeFile`, y conecta un
   `signingConfig` de release en `gen/android/app/build.gradle.kts` siguiendo la guía de
   Tauri "Android Code Signing". Guarda el `.jks` y sus contraseñas fuera del repo (gestor
   de contraseñas + copia de seguridad).
5. **Compilar:** `pnpm --filter @rpg/desktop tauri android build --aab` (para Play) o
   `--apk` (para instalar a mano). La versión sale de `client/package.json`.
6. **Google Play** 👤:
   - Cuenta de desarrollador de Google Play (pago único de USD 25, verificación de
     identidad).
   - Crear la app con el paquete `dev.rpgproject.client`, activar *Play App Signing* (Google
     guarda la llave de la app; tú subes con la de *upload*).
   - Completar ficha, clasificación de contenido, formulario de seguridad de datos (cuenta,
     email, chat entre jugadores) y público objetivo.
   - Subir el `.aab` a **Prueba interna** primero; las cuentas nuevas deben pasar por una
     prueba cerrada con testers antes de producción.

### iOS 👤
1. **Herramientas:** un Mac con **Xcode** (App Store) y sus *Command Line Tools*
   (`xcode-select --install`), Rust y
   `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`.
   `tauri ios init` avisa si falta algo más (por ejemplo `xcodegen` o CocoaPods vía
   Homebrew).
2. **Cuenta:** Apple Developer Program (USD 99 al año). En Xcode → Settings → Accounts,
   agrega tu Apple ID. El *Team ID* va en `APPLE_DEVELOPMENT_TEAM` (variable de entorno) o en
   `bundle.iOS.developmentTeam` de `tauri.conf.json`; no hace falta commitearlo.
3. **Inicializar** (y commitear `apps/desktop/src-tauri/gen/apple`):
   ```bash
   pnpm --filter @rpg/desktop tauri ios init
   pnpm --filter @rpg/desktop tauri ios dev      # simulador o iPhone conectado
   ```
4. **Firmar y publicar:** con firma automática de Xcode alcanza para empezar.
   `pnpm --filter @rpg/desktop tauri ios build --export-method app-store-connect` y subir
   con Transporter o Xcode → App Store Connect → **TestFlight** para probar con amigos, y
   después revisión de la App Store.
5. **App Store Connect:** crear la app con el *bundle id* `dev.rpgproject.client`, política
   de privacidad (URL pública), clasificación por edad (chat entre jugadores) y datos que se
   recopilan.

### Antes de publicar en tiendas 👤
- **Compras dentro de la app (T5.7):** Apple y Google exigen su propio sistema de pago para
  bienes digitales (cosméticos) vendidos dentro de una app de sus tiendas. La pasarela web
  de T5.7 no sirve tal cual en las apps de tienda: hay que decidir si la tienda cosmética
  se oculta en esas apps, se compra solo en el sitio o se integra el pago de cada tienda.
  La PWA no tiene esta restricción.
- **Política de privacidad y borrado de cuenta:** ambas tiendas piden una URL pública de
  privacidad y una forma de borrar la cuenta desde la app o la web.
- **Íconos y capturas finales:** los íconos actuales son placeholders.

## Checklist del dueño 👤
- [ ] Servir el sitio por HTTPS y probar "Instalar app" en un Android y "Agregar a inicio"
      en un iPhone.
- [ ] Android: Android Studio + SDK + NDK, `tauri android init`, probar en un teléfono,
      llave de *upload* guardada, cuenta de Google Play.
- [ ] iOS: Mac con Xcode, Apple Developer Program, `tauri ios init`, TestFlight.
- [ ] Revisar los puntos de "Pendiente de comprobar en un dispositivo".
- [ ] Decidir cómo se venden los cosméticos en las apps de tienda (T5.7).
