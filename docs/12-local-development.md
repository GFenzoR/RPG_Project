# 12 — Desarrollo local (después del 5 de noviembre)

Desde el 5 de noviembre el trabajo sigue con Claude Code en tu computador. El repo, los
docs, las skills y el roadmap son los mismos; cambia el entorno y que ahora puedes probar
el juego tú mismo mientras Claude trabaja.

## Sistema recomendado
| Tu equipo | Recomendación |
|---|---|
| Windows | **WSL2 con Ubuntu 24.04** y el repo dentro de WSL (`~/rpg-project`, no en `C:\`). Así los scripts, el Makefile y las rutas son idénticos a los de las sesiones cloud. Docker Desktop con integración WSL activada. |
| macOS | Nativo, con Homebrew. Docker Desktop u OrbStack. |
| Linux | Nativo. |

## Instalar una vez
1. Git, Go (la versión de `server/go.mod`), Node 22 y pnpm (`corepack enable`).
2. Docker (para Postgres en local; no hace falta instalar Postgres a mano).
3. Claude Code (CLI o app de escritorio) con tu cuenta.
4. Clona el repo y corre:
   ```
   make setup        # instala buf, sqlc, goose, golangci-lint, dependencias y Chromium de Playwright
   make db-up        # levanta Postgres en Docker en el puerto 5432
   make dev          # servidor + cliente + editor
   ```
   `make setup` usa `scripts/local-setup.sh`, que crea la tarea T0.1.

### Base de datos y servidor solo
```
make migrate-status    # estado de las migraciones en DATABASE_URL (por defecto la base rpg)
make test-integration  # tests Go con Postgres real (base rpg_test)
cd server && DATABASE_URL=postgres://postgres:postgres@localhost:5432/rpg go run ./cmd/gameserver
```
El servidor aplica las migraciones pendientes al arrancar y sirve la API HTTP en `:8080`
(ver "API HTTP" en `05-network-protocol.md`).

### Sitio público y juego (T4.3)
`make client` (o `make dev`) levanta un solo Vite en `http://localhost:5173` con las dos
páginas del cliente, como detrás de Caddy:
- `http://localhost:5173/` → sitio público: landing, `/highscores`, `/news` (las rutas
  desconocidas caen en esta página);
- `http://localhost:5173/play/` → el juego (también en `/play`, sin redirección, como Caddy).

Las rutas que el sitio no conoce (`/ranking`, `/foo`) responden 200 con la página del sitio,
que muestra "Página no encontrada": es una SPA, en Vite y detrás de Caddy. El idioma se
comparte entre las dos páginas (`localStorage` `rpg.lang`): un `?lang=` se lee una vez, se
guarda y se quita de la URL, y "Jugar" lleva a `/play/` sin `?lang=`.

Vite hace de proxy de `/api` y `/ws` al servidor (`RPG_SERVER`, por defecto `:8080`): el
estado del servidor y el ranking de la landing necesitan el servidor en marcha. Una noticia
nueva en `data/news/` se ve al reiniciar Vite. El ranking se cachea 60 s en el servidor: un
personaje recién creado puede tardar ese minuto en aparecer.

### Roles de staff (T2.6)
Para probar los comandos de GM, dale un rol a tu cuenta de desarrollo y vuelve a entrar:
`make set-role EMAIL=tu@correo ROLE=admin NOTE="dev"`. `make audit-log` muestra el log de
auditoría y `make reports` la cola de reportes de jugadores (T4.1). Comandos en
`02-game-design.md` ("Moderación").

### Portal de mapas (T4.5)
`http://localhost:5173/maps/submit`: sube un patch de `mapcli patch create` o del editor
(Exportar patch) con una cuenta que tenga personaje. `make dev` y `make run-server` arrancan
el servidor con `-map-submit-min-account-age 0` (`DEV_SERVER_FLAGS`), así una cuenta recién
creada puede enviar; en producción tiene que tener 24 h. Para revisar la cola
(`/maps/review`), dale `gm` a otra cuenta con `make set-role` y entra con ella. El PR en
GitHub lo abre el worker de T4.5 (2/2); mientras tanto, un envío aprobado se aplica a mano
con `mapcli patch apply` sobre el patch descargado.

### Mapa del servidor
El servidor carga el mapa compilado (`build/world.bin`), no el JSON de `world/`:
```
make run-server   # make mapcompile + gameserver con RPG_WORLD=<repo>/build/world.bin y DATABASE_URL
```
A mano: `make mapcompile` y luego el comando de arriba desde `server/` (por defecto lee
`../build/world.bin`; otra ruta con `RPG_WORLD` o `-world <ruta>`, y `-world ""` arranca
sin mundo). Vuelve a compilar el mapa cada vez que cambie `world/` o `data/items/`.
`make test-parity` compara la caminabilidad que calcula `mapcompile` con la de
`packages/map-format` (necesita `pnpm install`; forma parte de `make test`).

### Prueba de carga
```
make bots N=100                     # escenario base, 10 min, con su propio servidor
make bots N=300 SCENARIO=stress     # 300 bots en la ciudad, 5 min
make bots N=20 DURATION=60s         # corrida corta
make bots N=10 URL=http://localhost:8080   # contra un servidor ya levantado
```
Sin `URL`, `tools/bots/loadtest.sh` compila el mapa y el servidor, lo levanta en
`127.0.0.1:8090` contra `LOAD_DATABASE_URL` (por defecto `DATABASE_URL` o la base `rpg`),
con `/metrics` en `127.0.0.1:9190` y `-auth-rate-burst 1000` (todos los bots salen de una
IP), corre los bots y lo apaga. Deja el reporte en `build/loadtest-<escenario>-<N>.json` y
el log del servidor en `build/loadtest-server.log`. Los bots reusan cuentas y personajes
del mismo `PREFIX` (por defecto `load`), así que se puede repetir sin limpiar la base.
`PREFIX` son 2–12 letras minúsculas y pasa a ser la segunda palabra del nombre
(`Botaa Load`). Se rechazan los prefijos que darían un nombre reservado para staff (`dev`;
`mine`, porque genera `Botad Mine`, que contiene "admin"). El script falla si algo ya
responde en sus puertos (`LOAD_PORT`, `LOAD_METRICS_PORT`). Con `URL` en esta máquina, los
bots leen `/metrics` de `127.0.0.1:9100`; para otro servidor, pasa `METRICS=...`.
Detalle y resultados en `07-performance-budget.md`.

### Monitoreo (T4.4)
El stack de producción en Docker más el profile `monitoring`: Prometheus, Alertmanager,
Grafana y node-exporter. Todo queda solo en `127.0.0.1`:
```
make monitoring-up     # make docker-up + monitoreo; agrega GRAFANA_ADMIN_PASSWORD a deploy/.env si falta
# Grafana       http://localhost:3000/grafana/   (admin / GRAFANA_ADMIN_PASSWORD de deploy/.env)
# Prometheus    http://localhost:9090            Alertmanager  http://localhost:9093
make bots N=20 URL=https://localhost DURATION=5m   # carga (ver abajo: certificado local)
make monitoring-test   # detiene el gameserver y espera la alerta GameServerDown en un webhook de prueba
make monitoring-check  # promtool/amtool, tests de las reglas y JSON del dashboard (solo Docker)
make monitoring-down   # apaga todo (los volúmenes quedan)
```
- Con `https://localhost`, los bots (Go) tienen que confiar en la CA local de Caddy:
  `docker compose -f deploy/docker-compose.yml --env-file deploy/.env cp caddy:/data/caddy/pki/authorities/local/root.crt .`
  y `SSL_CERT_FILE=<bundle del sistema + root.crt>`.
- `monitoring-test` usa las imágenes ya construidas (`--no-build`): corre antes
  `make monitoring-up` (o `make docker-build`). Recrea Alertmanager apuntando al receptor de prueba (`alert-receiver`,
  profile `monitoring-test`). Después, `make monitoring-up` vuelve a los canales de
  `deploy/.env`.
- Para cambiar un umbral, edita `deploy/monitoring/prometheus/rules/alerts.yml` (y su test
  en `prometheus/tests/alerts_test.yml`), corre `make monitoring-check` y recarga:
  `curl -X POST localhost:9090/-/reload`.
- El dashboard es `deploy/monitoring/grafana/dashboards/rpg-overview.json`. Grafana no
  guarda cambios hechos en la UI: exporta el JSON y commitéalo.

## Cliente de escritorio (Tauri 2, T2.5)
`apps/desktop/` envuelve el build web del cliente (`build/client`) en un webview de Tauri 2;
no duplica código del cliente. Lo único propio está en Rust (`apps/desktop/src-tauri/src`):
elegir el servidor y llamar a la API HTTP guardando el token de cuenta en el llavero del SO.

### Dependencias del sistema (una vez)
Rust estable (`rustup`, la versión mínima está en `Cargo.toml`) más:
| SO | Qué instalar |
|---|---|
| Linux / WSL2 (Ubuntu 22.04+) | `sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev libxdo-dev libssl-dev build-essential` |
| macOS | Xcode Command Line Tools (`xcode-select --install`) |
| Windows (nativo) | Visual Studio Build Tools con "Desktop development with C++" y WebView2 (viene con Windows 10/11) |

En **WSL2** la ventana se abre con WSLg (Windows 11 o Windows 10 21H2+); si no tienes
WSLg, compila desde Windows nativo. El llavero de Linux es el Secret Service
(gnome-keyring, KWallet): en WSL2 normalmente no hay, y la app guarda la sesión solo en
memoria (hay que entrar de nuevo al abrirla).

### Comandos
```bash
make desktop-dev          # webview sobre el Vite del cliente (:5173), API y WS a RPG_SERVER_URL
make desktop-build        # instaladores de tu SO en apps/desktop/src-tauri/target/release/bundle/
make desktop-test         # cargo fmt --check + clippy + cargo test (config de URL, API, CSP, versión)
make desktop-smoke        # Linux: la app real bajo Xvfb con tauri-driver: login, entrar, screenshots
```
`make desktop-dev` necesita el servidor en marcha (`make run-server` o `make dev`); la ventana
abre `http://localhost:5173/play/index.html` (el juego, no la landing); en dev el
origen del webview es `http://localhost:5173`, que ambos permiten en `-ws-origins`
(`DEV_WS_ORIGINS` del Makefile; `RPG_WS_ORIGINS` lo reemplaza).
`make desktop-smoke` necesita además `webkit2gtk-driver` (apt), `tauri-driver`
(`cargo install tauri-driver --locked`) y `Xvfb`; deja los screenshots en
`apps/desktop/e2e/screenshots/`.

### A qué servidor se conecta
De mayor a menor prioridad (`src-tauri/src/config.rs`):
1. Variable `RPG_SERVER_URL` al lanzar la app (`RPG_SERVER_URL=http://localhost:8080 make desktop-dev`).
2. `config.json` en la carpeta de configuración de la app (identificador `dev.rpgproject.client`):
   - Linux/WSL2: `~/.config/dev.rpgproject.client/config.json`
   - macOS: `~/Library/Application Support/dev.rpgproject.client/config.json`
   - Windows: `%APPDATA%\dev.rpgproject.client\config.json`
   ```json
   { "server_url": "https://palabras-al-azar.trycloudflare.com" }
   ```
3. El default compilado: `RPG_DESKTOP_SERVER_URL` al compilar (el release usa la variable
   del repo `DESKTOP_SERVER_URL`); si no, `http://localhost:8080` en debug y un placeholder
   en release.

Solo se acepta el origen (`https://host[:puerto]`, sin ruta); `http://` solo para
localhost o una red privada (192.168.x.x, 10.x.x.x…). El host debe ser un **nombre o una
IPv4**: una IPv6 literal (`[::1]`) se rechaza porque la CSP no puede nombrarla y el
WebSocket quedaría bloqueado (usa `localhost`). Un override inválido se ignora con un
aviso en la consola, no se "corrige". La app imprime al arrancar qué servidor usa.

Si la app no puede arrancar (p. ej. un default compilado inválido), escribe el error en
`startup-error.log`, en la misma carpeta que `config.json`: en Windows el build de release
no tiene consola donde verlo.

### Qué hace distinto el cliente en la app
- La API HTTP va por el comando `api` de Rust (`client/src/net/desktop.ts`), que agrega
  `Authorization: Bearer`, pide `token_in_body` al hacer login y guarda el token en el
  llavero (Keychain, Credential Manager, Secret Service): **la página nunca ve el token**.
  Un 401 o el logout lo borran. Hay una entrada por servidor.
- El WebSocket va directo a `wss://<servidor>/ws`. El origen del webview es
  `tauri://localhost` (macOS/Linux) o `http://tauri.localhost` (Windows): el servidor debe
  permitirlos en `-ws-origins`/`RPG_WS_ORIGINS` (el compose de producción ya lo hace).
- La versión de la app es la de `client/package.json` (`tauri.conf.json` apunta a ese
  archivo) y viaja en el `Hello`: subir `-min-client-version` deja fuera a las apps viejas.

## Diferencias con las sesiones cloud
| | Cloud (hasta 4 nov) | Local (desde 5 nov) |
|---|---|---|
| Postgres | Servicio del VM (`service postgresql start`) | Contenedor Docker (`make db-up`) |
| Hook de inicio | Instala dependencias | Sale de inmediato (no hace nada) |
| Paralelismo | Varias sesiones a la vez | Una o dos a la vez; usa `git worktree` para dos sesiones en ramas distintas |
| Pruebas visuales | Solo screenshots | Screenshots + tú jugando en `http://localhost:5173` |
| Costo | Crédito cloud | Límites de tu plan de Claude |

## Ritmo sugerido en local
- Sigue usando una tarea del roadmap por sesión y la skill `/roadmap-task T1.x`.
- Aprovecha que puedes jugar: después de cada PR jugable, prueba 5 minutos y anota en
  un issue lo que se siente mal (ritmo, balance, controles). Eso es lo que la IA no
  puede juzgar sola.
- Para dos tareas en paralelo sin choques:
  ```
  git worktree add ../rpg-t1-9 -b t1-9
  git worktree add ../rpg-t1-10 -b t1-10
  ```
  y abre una sesión de Claude Code en cada carpeta.
