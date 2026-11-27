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
- `client/public/manifest.webmanifest`: nombre "Neque's Realm", `display: standalone`,
  `orientation: any` (vertical y horizontal), `start_url` y `id` `/play/` (abre el juego,
  no la landing), color de fondo y de tema `#12151b` (el `--bg` del cliente).
- Íconos placeholder en `client/public/icons/`: 192, 512, 512 *maskable* (con el margen que
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

Para actualizar no hay que hacer nada: al reabrir, la página llega de la red. Si algo queda
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
