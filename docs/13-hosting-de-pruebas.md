# 13 — Hosting de pruebas (en casa, antes de AWS)

Antes del deploy alpha en AWS (T1.18) conviene poder jugar con amigos usando tu propio
PC como servidor. Esta guía define qué se puede hostear dónde y cómo lo arma la tarea T1.19.

## Jugar en tu PC en 3 pasos
1. Instala **Docker** (Docker Desktop en Windows/macOS) y, en Windows, abre la terminal de
   **Ubuntu (WSL2)**. Detalle por sistema en el paso 1 de abajo.
2. Clona y arranca:
   ```bash
   git clone https://github.com/GFenzoR/RPG_Project.git && cd RPG_Project
   make home-up
   ```
3. Abre `http://localhost:8080`, crea tu cuenta con **Jugar** y hazte admin:
   `make home-admin EMAIL=tu@email.com`.

Para invitar amigos: `make home-tunnel` imprime un link `https://…` para compartir.

## ¿Sirve Vercel?
| Pieza | ¿En Vercel? | Por qué |
|---|---|---|
| Cliente y editor (build estático de Vite) | **Sí** | Son archivos estáticos; el plan gratis alcanza |
| Servidor de juego (Go) | **No** | Vercel ejecuta funciones serverless de vida corta. El juego necesita **un proceso siempre vivo** con el game loop de 50 ms en memoria y conexiones WebSocket largas (`01-architecture.md`) |
| PostgreSQL | Posible (Vercel Postgres/Neon) | Pero sin el servidor de juego no sirve de nada |

Conclusión: Vercel solo serviría para el front, y separar front y servidor en dominios
distintos agrega CORS y cookies cross-site al login. Para pruebas es más simple tener
**todo junto en casa** detrás de una sola URL. Si más adelante se quiere el front en
Vercel, se puede sumar sin cambiar el servidor.

## Topología en casa
```
Internet ──HTTPS/WSS──▶ Cloudflare Tunnel (o Tailscale) ──▶ tu PC (Docker Compose)
                                                            ├─ caddy (sitio en /, juego en /play, /api y /ws → gameserver)
                                                            ├─ gameserver
                                                            └─ postgres
```
- Mismo `docker compose` que producción (T1.18) con un override `deploy/docker-compose.home.yml`:
  sin backups a S3, Caddy en HTTP interno (el túnel pone el TLS).
- **No hay que abrir puertos del router** ni tener IP fija.
- Las rutas son las de producción (`deploy/caddy-routes.caddy`, compartido): el link que
  compartes abre el sitio público (landing, ranking, noticias; T4.3) y el botón "Jugar"
  lleva al juego en `/play/`. Si alguien tenía guardado el link viejo, verá la landing.

## Cómo exponerlo
| Opción | Para quién | Costo | Notas |
|---|---|---|---|
| **Cloudflare Tunnel con dominio** | Cualquiera con el link | Gratis (dominio ~USD 10/año) | URL fija tipo `juego.tudominio.com`; WebSockets funcionan |
| **Cloudflare Quick Tunnel** (`trycloudflare.com`) | Cualquiera con el link | Gratis, sin cuenta | URL aleatoria que cambia en cada arranque; ideal para una tarde de pruebas |
| **Tailscale** | Solo amigos invitados a tu red | Gratis (uso personal) | Privado; cada amigo instala Tailscale |

## Limitaciones
- El juego está online solo mientras tu PC está prendido (en Windows, que WSL2 y Docker
  Desktop no se suspendan).
- La subida de tu internet limita jugadores: con ~4 KB/s por jugador (`05-network-protocol.md`)
  1 Mbps de subida alcanza para ~25 jugadores con holgura.
- Los datos viven en el volumen Docker de tu PC; `make home-backup` hace un `pg_dump` local.

## Archivos
```
deploy/
  docker-compose.home.yml   override del compose de producción: sin backups a S3, Caddy en
                            HTTP en 127.0.0.1:8080, servicios cloudflared (Quick Tunnel y con dominio)
  Caddyfile.home            HTTP plano; confía solo en la red del túnel para CF-Connecting-IP
  env.home.template         todas las variables comentadas; make home-up genera deploy/.env.home
  home.sh                   la lógica de make home-* (Linux, macOS y WSL2 por igual)
  home-tunnel.sh            levanta el Quick Tunnel e imprime la URL (lo usa make home-tunnel)
  check-tunnel-ip.sh        comprueba la IP real detrás del túnel
  smoke.sh                  prueba del stack: salud, cliente, login, /ws y rate limit por IP
```
`deploy/.env.home` es tu configuración local (git lo ignora). Lo crea `make home-up` desde
`deploy/env.home.template` con contraseñas aleatorias (base de datos y Grafana). Las
siguientes veces solo **agrega** las variables nuevas que traiga una actualización: nunca
cambia las que ya tienes. Todo lo demás tiene valor por defecto en el compose, así que
solo descomentas una línea para cambiarla. (Hasta T1.19 existía `deploy/.env.home.example`;
lo reemplaza la plantilla, y un `deploy/.env.home` viejo sigue sirviendo tal cual.)

| Comando | Qué hace |
|---|---|
| `make home-up` | Genera lo que falte de `deploy/.env.home`, construye las imágenes desde tu checkout, levanta postgres + gameserver + caddy, espera a que estén sanos e imprime qué abrir. `BUILD=0` arranca sin reconstruir |
| `make home-admin EMAIL=…` | Da rol `admin` a una cuenta ya registrada (`ROLE=gm` o `ROLE=player` para otros roles). Corre dentro del compose: no necesitas `psql` |
| `make home-tunnel` | Quick Tunnel de Cloudflare (cloudflared en Docker); imprime `https://….trycloudflare.com` |
| `make home-tunnel-domain` | Túnel con nombre y dominio propio (`CLOUDFLARE_TUNNEL_TOKEN`) |
| `make home-monitoring-up` | Lo mismo que `home-up` más el monitoreo: Grafana en `http://localhost:3000/grafana/` |
| `make home-logs` | Logs en vivo de todo el stack |
| `make home-backup` | `pg_dump` a `deploy/backups/home-<fecha>.dump` |
| `make home-restore FILE=…` | Reemplaza la base por ese backup (pregunta antes y guarda un backup del estado actual) |
| `make home-down` | Apaga todo, túneles y monitoreo incluidos. **Los datos quedan** |
| `make home-reset` | **Borra todos los datos** (cuentas, personajes, envíos de mapas, Grafana). Pide escribir `borrar`; `CONFIRM=yes` lo salta. Deja los backups y `deploy/.env.home` |

## Paso a paso

### 1. Instalar Docker y make
Necesitas Docker con Compose **2.24 o más nuevo** (`docker compose version`), `make` y `git`.
No hace falta Go, Node ni `psql`: todo se compila y corre dentro de Docker.

- **Windows (WSL2).** Instala [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)
  con el backend WSL2 y activa tu distro en *Settings → Resources → WSL integration*. En
  la terminal de Ubuntu: `sudo apt install make git`. Clona el repo **dentro** de WSL
  (`cd ~` y luego `git clone ...`, no en `/mnt/c/...`): el build es mucho más rápido y no hay
  problemas de permisos ni de fin de línea. `make home-up` avisa si el repo está en `/mnt/`.
  El repo trae `.gitattributes` para que los scripts mantengan fin de línea LF aunque git
  esté configurado con `core.autocrlf=true`. Para que el juego siga online, desactiva la
  suspensión de Windows mientras juegan.
- **macOS.** Instala Docker Desktop (o OrbStack/Colima, que también traen `docker compose`).
  `make` y `git` vienen con `xcode-select --install`. El PC no debe dormirse:
  *Ajustes → Batería/Energía* o `caffeinate -d` en una terminal mientras juegan.
- **Linux.** Instala Docker Engine y el plugin Compose desde los repos oficiales de Docker
  (`docker-compose-plugin`), agrega tu usuario al grupo `docker` (`sudo usermod -aG docker $USER`,
  cierra sesión y vuelve a entrar) y `sudo apt install make git` (o el equivalente).

### 2. Levantar el juego
```bash
git clone https://github.com/GFenzoR/RPG_Project.git && cd RPG_Project
make home-up
```
La primera vez crea `deploy/.env.home` y compila las imágenes (varios minutos; las
siguientes, segundos). Termina cuando todo está *healthy* e imprime:
```
    Website  http://localhost:8080/
    Game     http://localhost:8080/play/
```
- `http://localhost:8080` es el **sitio**: portada, ranking (se actualiza cada minuto),
  noticias y el portal de mapas. **Jugar** lleva al juego en `/play/`.
- Crea una cuenta y un personaje: aparece en **Puerto** con el **tutorial** (panel arriba a la
  derecha: caminar, hablar con la sacerdotisa, inventario, comprar...). Se puede saltar.
- Si 8080 está ocupado, descomenta `HOME_HTTP_PORT` en `deploy/.env.home` y repite
  `make home-up`.

### 3. Hacerte admin (o gm)
Los roles nunca se dan desde el juego. Registra tu cuenta en el sitio y luego:
```bash
make home-admin EMAIL=tu@email.com            # admin
make home-admin EMAIL=amigo@email.com ROLE=gm # moderador: revisa los mapas enviados
```
El rol nuevo vale desde el siguiente login del personaje. Queda en el registro de auditoría.

### 4. Compartir el link (Quick Tunnel, sin cuenta)
```bash
make home-tunnel
```
Imprime algo como `https://palabras-al-azar.trycloudflare.com`. Ese link es el que mandas
a tus amigos: HTTPS, WebSocket incluido, sin abrir puertos del router. Cambia cada vez que
el túnel arranca de nuevo. El túnel corre en Docker (`cloudflared-quick`), no hay que
instalar nada más. Cloudflare limita los Quick Tunnels a pruebas: para algo estable usa el
paso 5.

### 5. Cloudflare Tunnel con dominio propio (URL fija)
1. Compra o mueve un dominio a Cloudflare (plan gratis) y entra al panel *Zero Trust*.
2. *Networks → Tunnels → Create a tunnel* → tipo **Cloudflared** → ponle nombre.
3. En la pantalla de instalación copia **solo el token** (la cadena larga después de
   `--token`); no instales el conector en tu PC: corre en Docker.
4. *Public hostname*: subdominio `juego`, tu dominio, servicio **HTTP** con URL `caddy:80`.
5. En `deploy/.env.home` descomenta `CLOUDFLARE_TUNNEL_TOKEN=<token>` y corre
   `make home-tunnel-domain`. Tu juego queda en `https://juego.tudominio.com`.

WebSockets funcionan sin configurar nada. El token es un secreto: no lo subas al repo
(`deploy/.env.home` está en `.gitignore`).

### 6. Tailscale (alternativa privada)
Solo entran las personas invitadas a tu red de Tailscale; nada queda público.
1. Instala Tailscale en tu PC y que cada amigo lo instale en el suyo; invítalos a tu
   tailnet (*Share* o *Invite users* en el panel).
2. En tu PC: `tailscale serve --bg http://localhost:8080` (en WSL2 instala Tailscale dentro
   de la distro o usa el de Windows: Docker Desktop publica el puerto en `localhost` de
   ambos). Tailscale te da `https://<tu-pc>.<tailnet>.ts.net` con certificado válido.
3. Tus amigos abren esa URL. La cookie sigue `Secure` porque es HTTPS.

Sin `tailscale serve` también funciona por la IP de Tailscale (o de tu LAN) en HTTP plano:
pon `HOME_BIND=0.0.0.0` (o tu IP `100.x.y.z`) y `COOKIE_SECURE=false` en `deploy/.env.home` y
repite `make home-up`. Con Tailscale todos los jugadores llegan desde la misma IP vista por
Caddy, así que comparten el cupo de logins por IP (10 seguidos, luego 1 cada 6 s): de sobra
para un grupo de amigos.

### 7. App de escritorio contra tu PC
La app (Tauri, `apps/desktop`) es el mismo juego en una ventana propia. Para conseguirla:
- **Instaladores:** cuando hay un release (`desktop-vX.Y.Z`, `09-deployment-aws.md`,
  "Cliente de escritorio"), en la página *Releases* de GitHub: `.msi`/`.exe` (Windows),
  `.dmg` (macOS), `.deb`/`.rpm`/`.AppImage` (Linux). Los instaladores no están firmados:
  Windows SmartScreen pide *Más información → Ejecutar de todas formas* y macOS, clic
  derecho → *Abrir* la primera vez.
- **Compilarla tú:** dependencias de `12-local-development.md` ("Cliente de escritorio") y
  `pnpm install && make desktop-build`. En Windows compílala en Windows nativo (no en WSL)
  para obtener el `.msi`.

En la pantalla de login de la app abre **"Servidor: …"**, escribe `http://localhost:8080`
(o el link del túnel, o la IP de tu LAN como `http://192.168.1.20:8080`) y pulsa
**Guardar y reiniciar**. El mismo instalador sirve para tu PC, el túnel y el servidor real.
También puedes editar `config.json` a mano o lanzar la app con `RPG_SERVER_URL=...`
(ruta y prioridades en `12-local-development.md`). El compose ya permite los orígenes de la
app en `/ws` y la CSP de la app agrega el servidor elegido; la app no usa cookies (guarda
el token en el llavero del SO), así que HTTP plano en `localhost` funciona. Usa un nombre
de host o una IPv4: la app rechaza IPv6.

### 8. Portal de mapas y worker de PRs
El sitio tiene **Mapas** (`/maps/submit`): cualquier cuenta sube un *map patch* exportado
del editor (`04-map-editor-and-ai.md`) y un gm o admin lo revisa en `/maps/review`. En casa
una cuenta nueva puede enviar al instante (`MAP_SUBMIT_MIN_ACCOUNT_AGE=0s` en la plantilla;
producción espera 24 h). Sin el worker, aprobar un envío muestra cómo aplicarlo a mano con
`mapcli patch apply`. El worker opcional abre el PR solo: ver "Worker de PR de mapas".

### 8b. Emails de la cuenta (verificación y "olvidé mi contraseña", T2.1)
Por defecto el servidor de casa **no manda emails**: nadie tiene que confirmar su email y
el sitio no ofrece "¿Olvidaste tu contraseña?". Si alguien la olvida:
```
make home-reset-password EMAIL=ana@example.org
```
imprime un enlace de un solo uso que vence en 1 hora (queda en el log de auditoría, el
enlace no). Pásaselo por un canal de confianza: quien lo tenga puede tomar la cuenta. El
enlace apunta a `PUBLIC_URL` (por defecto `http://localhost:8080`; si tus amigos entran por
el túnel con dominio, pon `PUBLIC_URL=https://juego.tudominio.com` en `deploy/.env.home`).

**Probar los emails sin bandeja real (Mailpit):** en `deploy/.env.home` descomenta
`COMPOSE_PROFILES=mail` (o agrega `mail` a la lista, p. ej. `map-pr,mail`) y las líneas
`SMTP_HOST=mailpit`, `SMTP_PORT=1025`, `SMTP_SECURITY=none`, `SMTP_FROM=…`; luego
`make home-up`. Los emails aparecen en http://localhost:8025 (solo en tu PC).

**SMTP real** (para que lleguen a los jugadores), en `deploy/.env.home`:
- *Gmail* (lo más rápido para pocos jugadores; límite de ~500 emails al día): activa la
  verificación en dos pasos de la cuenta, crea una contraseña de aplicación
  (myaccount.google.com → Seguridad → Contraseñas de aplicaciones) y pon
  `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_SECURITY=starttls`,
  `SMTP_USERNAME=tu@gmail.com`, `SMTP_PASSWORD=<la contraseña de aplicación>`,
  `SMTP_FROM=RPG Project <tu@gmail.com>`.
- *Proveedor transaccional* (Brevo, Mailjet, Resend, Postmark, Amazon SES…): te da host,
  puerto, usuario y clave SMTP; verifica tu dominio (SPF/DKIM) para no caer en spam.

Después `make home-up`. Qué cambia: al registrarse llega un email para confirmar; sin
confirmar se puede jugar pero no enviar mapas ni pedir un reset por email; aparece
"¿Olvidaste tu contraseña?" en el login. `REQUIRE_VERIFIED_EMAIL=true` exige el email
confirmado también para jugar. Las contraseñas SMTP solo viven en `deploy/.env.home`
(ignorado por git) y nunca van a los logs.

### 8c. Login con Google y Discord (T2.1)
Apagado hasta que pongas las claves de **tus** apps (el proyecto no trae ninguna). Cada
proveedor necesita una "redirect URI" exacta, que el servidor arma como
`<PUBLIC_URL>/api/auth/oauth/<proveedor>/callback`:

| Dónde juegan | `PUBLIC_URL` | Redirect URI de Google | Redirect URI de Discord |
|---|---|---|---|
| Tu PC | `http://localhost:8080` | `http://localhost:8080/api/auth/oauth/google/callback` | `http://localhost:8080/api/auth/oauth/discord/callback` |
| Túnel de Cloudflare con dominio (paso 5) | `https://juego.tudominio.com` | `https://juego.tudominio.com/api/auth/oauth/google/callback` | `https://juego.tudominio.com/api/auth/oauth/discord/callback` |
| AWS (docs/09) | `https://tudominio.com` | `https://tudominio.com/api/auth/oauth/google/callback` | `https://tudominio.com/api/auth/oauth/discord/callback` |

**OAuth funciona solo desde exactamente `PUBLIC_URL`.** El proveedor devuelve el navegador a
esa dirección y la cookie que ata el intento vive en la dirección donde se apretó el
botón: si alguien juega por otra (`localhost` cuando `PUBLIC_URL` es el dominio, una IP de
la LAN o de Tailscale), el login termina en `/oauth/error?code=state`. Por eso, en una
dirección distinta, el juego esconde los botones y dice dónde abrirlo. Registrar varias
URIs en la app solo sirve para cambiar `PUBLIC_URL` sin tocar la app, no para usar varias
direcciones a la vez. Quien entre por la LAN o Tailscale usa email y contraseña (o pon
como `PUBLIC_URL` el nombre https de `tailscale serve`, si todos entran por ahí).
**El Quick Tunnel (`make home-tunnel`) no sirve para OAuth:** su URL
`https://….trycloudflare.com` cambia cada vez que arranca, y los proveedores solo
aceptan redirect URIs registradas de antemano y escritas exactas. Usa el túnel con
dominio propio, o prueba solo en `http://localhost:8080`.

**Google** (Google Cloud Console, console.cloud.google.com):
1. Crea un proyecto (o elige uno) → "APIs y servicios" → "Pantalla de consentimiento de
   OAuth" (o "Google Auth Platform" → "Branding"): tipo **Externo**, nombre de la app,
   email de soporte. Permisos: `openid` y `email` (no hace falta verificar la app para
   esos dos). Mientras esté en modo "Prueba", agrega los emails de quienes van a probar
   en "Usuarios de prueba"; "Publicar" la abre a todos.
   Si usas un dominio, agrégalo en "Dominios autorizados" (por ejemplo `tudominio.com`);
   `localhost` no hace falta.
2. "Credenciales" (o "Clients") → "Crear credenciales" → "ID de cliente de OAuth" → tipo
   **Aplicación web**. En "URIs de redireccionamiento autorizados" pega las de la tabla.
   (Los "orígenes de JavaScript" no hacen falta: el login no usa JS de Google.)
3. Copia el ID y el secreto a `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.

**Discord** (Discord Developer Portal, discord.com/developers/applications):
1. "New Application" → nombre → acepta los términos.
2. "OAuth2" → "Redirects" → "Add Redirect" con las URIs de la tabla → "Save Changes".
3. En la misma página: "Client ID" y "Reset Secret" (se ve una sola vez) →
   `DISCORD_CLIENT_ID` y `DISCORD_CLIENT_SECRET`. Permisos que pide el juego: `identify` y
   `email` (no hace falta bot ni marcar la app como pública).

Pon los cuatro valores en `deploy/.env.home` (y `PUBLIC_URL` si no es localhost) y
`make home-up`. Sin ninguno de los dos valores de un proveedor, queda apagado; con uno
solo (el ID sin el secreto, o al revés), el servidor **no arranca** y `make home-logs`
dice qué variable falta. Aparecen los botones "Continuar con Google/Discord" en el login del juego
y del sitio, y la página "Mi cuenta". Los secretos solo viven en `deploy/.env.home`, nunca
en los logs ni en `/api/auth/config`. La app de escritorio no ofrece estos botones (dice
que se use el sitio). Una cuenta creada con Google o Discord no tiene contraseña: para
entrar desde la app de escritorio, su dueño le pone una con "¿Olvidaste tu contraseña?",
que **necesita SMTP** (paso 8b) y el email confirmado; sin SMTP, `make home-reset-password`.

### 9. Actualizar después de un `git pull`
```bash
git pull
make home-up
```
Reconstruye solo lo que cambió, agrega a `deploy/.env.home` las variables nuevas (sin tocar
las tuyas) y el servidor aplica las migraciones de base al arrancar. Los datos no se
pierden. Si quieres ir a la segura, corre `make home-backup` antes.

### 10. Apagar, reiniciar y borrar
- `make home-down` apaga todo; `make home-up` lo vuelve a levantar con los mismos datos.
  Docker no reinicia el juego solo después de `home-down`; sí después de reiniciar el PC si
  estaba corriendo (los servicios tienen `restart: unless-stopped`).
- `make home-reset` borra **todos** los datos para empezar de cero (pide confirmación).

## Variables (`deploy/.env.home`)
Todas son opcionales salvo las dos contraseñas, que se generan solas.

| Variable | Default | Para qué |
|---|---|---|
| `POSTGRES_PASSWORD` | generada | Contraseña de la base (no se publica fuera de Docker). No la cambies con datos dentro: Postgres guarda la primera |
| `GRAFANA_ADMIN_PASSWORD` | generada | Login `admin` de Grafana |
| `SITE_ADDRESS`, `ACME_EMAIL` | `localhost`, `home@example.com` | Las exige el compose de producción; en casa no se usan (Caddy va en HTTP) |
| `MAP_SUBMIT_MIN_ACCOUNT_AGE` | `0s` (plantilla); `24h` en producción | Antigüedad mínima de la cuenta para enviar mapas |
| `COOKIE_SECURE` | `true` | `false` solo si juegan por `http://<IP de LAN o Tailscale>` |
| `HOME_HTTP_PORT` | `8080` | Puerto del sitio y el juego en tu PC |
| `HOME_BIND` | `127.0.0.1` | `0.0.0.0` lo abre a tu LAN (o pon tu IP de Tailscale) |
| `CLOUDFLARE_TUNNEL_TOKEN` | — | Token del túnel con dominio (paso 5) |
| `CLOUDFLARED_VERSION` | `2025.2.0` | Imagen de cloudflared |
| `TUNNEL_SUBNET` | `172.31.250.0/24` | Red entre cloudflared y Caddy; cámbiala si choca con una tuya |
| `RPG_WS_ORIGINS` | orígenes de la app de escritorio | Orígenes extra permitidos en `/ws`; vacío = solo el sitio |
| `GRAFANA_PORT`, `PROMETHEUS_PORT`, `ALERTMANAGER_PORT` | `3000`, `9090`, `9093` | Puertos del monitoreo (solo `127.0.0.1`) |
| `ALERT_DISCORD_WEBHOOK_URL`, `ALERT_TELEGRAM_*`, `ALERT_EMAIL_TO`, `ALERT_SMTP_*`, `ALERT_WEBHOOK_URL` | — | Canales de alertas (`09-deployment-aws.md`, "Monitoreo") |
| `PROMETHEUS_RETENTION`, `PROMETHEUS_RETENTION_SIZE` | `15d`, `1GB` | Cuánto guarda Prometheus |
| `GRAFANA_PUBLIC` y `GRAFANA_*` de la ruta pública | `off` | No la actives en casa (ver "Monitoreo en casa") |
| `COMPOSE_PROFILES` | — | `map-pr` enciende el worker de PRs de mapas; `mail`, Mailpit (paso 8b) |
| `PUBLIC_URL` | `http://localhost:8080` | Dirección de los enlaces de los emails (T2.1) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` | — (sin emails), `587`, `starttls` | Servidor de correo (paso 8b) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | — (botón apagado) | Login con Google/Discord (paso 8c) |
| `REQUIRE_VERIFIED_EMAIL` | `false` | `true`: solo cuentas con email confirmado pueden jugar |
| `MAILPIT_UI_PORT` | `8025` | Puerto de Mailpit (perfil `mail`, solo `127.0.0.1`) |
| `GITHUB_MAP_PR_TOKEN` | — | Token del bot del worker |
| `MAP_PR_REPOSITORY`, `MAP_PR_BASE`, `MAP_PR_POLL_SECONDS` | `GFenzoR/RPG_Project`, `main`, `30` | Repo, rama y frecuencia del worker |
| `POSTGRES_USER`, `POSTGRES_DB` | `rpg` | Usuario y base; déjalos así |

## IP real del jugador
Los límites de login/registro por IP (T1.3) necesitan la IP del jugador, no la del túnel:
```
jugador ─▶ Cloudflare (pone CF-Connecting-IP) ─▶ cloudflared ─red tunnel─▶ caddy ─▶ gameserver
```
- `cloudflared` y Caddy comparten la red `tunnel` con subred fija (`TUNNEL_SUBNET`,
  `172.31.250.0/24` por defecto; cámbiala si choca con una red tuya). `Caddyfile.home`
  confía **solo** en esa subred (`trusted_proxies`) y de ella toma la IP de
  `CF-Connecting-IP`, que el borde de Cloudflare siempre sobrescribe.
- Lo que llega por el puerto publicado (localhost, LAN, Tailscale) no es de confianza: un
  `CF-Connecting-IP` o `X-Forwarded-For` falsificado se ignora y vale la IP TCP.
- Un jugador que intente mandar su propio `CF-Connecting-IP` a la URL pública recibe 403 del
  borde de Cloudflare (verificado en CI); un `X-Forwarded-For` falso pasa, pero se ignora.
- Caddy manda al gameserver un único `X-Forwarded-For` con esa IP (`caddy-routes.caddy`,
  igual que en producción, `09-deployment-aws.md`).

`deploy/check-tunnel-ip.sh rpg-home_tunnel` lo demuestra: desde un contenedor en la red del
túnel, el jugador A agota su cupo (429) mientras el jugador B sigue entrando (401), aunque
cada request trae un `X-Forwarded-For` distinto. El job `home-stack` de
`.github/workflows/images.yml` corre esto, `smoke.sh` en local y a través de un Quick Tunnel
real, y bots que juegan por `wss://` a través del túnel.

## Backups y restauración
```bash
make home-backup                                        # deploy/backups/home-<fecha>.dump
make home-restore FILE=deploy/backups/home-<fecha>.dump # pregunta antes de reemplazar
```
`home-restore` primero comprueba que el archivo sea un dump válido (si no, no toca nada),
detiene el juego, guarda un backup del estado actual (`…-before-restore.dump`), recrea la base desde el archivo y vuelve a levantar todo (con las
migraciones nuevas, si el backup es más viejo que tu checkout). Si algo falla a mitad,
imprime el comando para volver al backup de seguridad. Los dumps son formato
custom de `pg_dump`; cópialos fuera del PC si te importan.

## Monitoreo en casa (T4.4)
El mismo profile `monitoring` de producción funciona en casa:
```
make home-monitoring-up   # el juego + Prometheus, Alertmanager, Grafana y node-exporter
# Grafana: http://localhost:3000/grafana/  (admin / GRAFANA_ADMIN_PASSWORD de deploy/.env.home)
```
- **Nada del monitoreo pasa por el túnel.** Grafana (3000), Prometheus (9090) y
  Alertmanager (9093) escuchan solo en `127.0.0.1` de tu PC. Los túneles solo llevan a
  Caddy, y la ruta `/grafana/` está apagada (`GRAFANA_PUBLIC=off`). No la actives con un
  Quick Tunnel: cualquiera con la URL llegaría al login.
- **Gasta unos 300 MB más de RAM** (medido en `07-performance-budget.md`).
- **Backups:** en casa no corre el servicio `backup` (los dumps son `make home-backup`).
  Por eso el panel de backups queda vacío y `BackupStale` no se dispara.
- La contraseña de Grafana (`GRAFANA_ADMIN_PASSWORD`) la genera `make home-up` en
  `deploy/.env.home` la primera vez; `make home-up` imprime la URL de Grafana mientras el
  monitoreo esté corriendo.
- **Notificaciones:** si quieres recibirlas (Discord o Telegram es lo más simple), pon
  las variables `ALERT_*` en `deploy/.env.home` (tabla en `09-deployment-aws.md`,
  "Monitoreo") y repite `make home-monitoring-up`.
- **Puertos:** si 3000 está ocupado (por ejemplo, por otro dev server), cambia
  `GRAFANA_PORT` en `deploy/.env.home`.
- `make home-down` también apaga el monitoreo.

## Worker de PR de mapas (T4.5)
Igual que en AWS (docs/09, "Worker de PR de mapas"): en `deploy/.env.home` agrega
`COMPOSE_PROFILES=map-pr` (con los otros perfiles que uses, separados por coma) y
`GITHUB_MAP_PR_TOKEN` con el token clásico de una cuenta de bot colaboradora con permiso
Write, solo con el scope `public_repo`, que no sea la dueña del repo ni esté en
`.github/MAINTAINERS` (si lo es, el worker no corre). `make home-down` y `make home-logs`
incluyen el perfil `map-pr`. Sale a Internet por la red `edge`, igual que las
copias a S3; no abre puertos en tu casa. Sin token queda inactivo, y los envíos aprobados se
abren a mano con `mapcli patch apply` en la rama y con la marca que muestra la página de
moderación. Para probarlo sin tocar el repo real, usa un fork tuyo
como `MAP_PR_REPOSITORY`.

## Problemas comunes
| Síntoma | Causa y solución |
|---|---|
| `docker not found` / `Docker is not running` | Abre Docker Desktop y espera a que diga *running*. En WSL2, revisa *Settings → Resources → WSL integration*. En Linux: `sudo systemctl start docker` |
| `this user may not use Docker` (Linux: `permission denied` en `/var/run/docker.sock`) | Tu usuario no está en el grupo `docker`, o lo agregaste y no volviste a entrar: `sudo usermod -aG docker $USER`, cierra sesión y vuelve a entrar (o reinicia) |
| `docker compose ... is too old` o falla con `!override` | Compose < 2.24: actualiza Docker Desktop o el plugin |
| `port is already allocated` | Otro programa usa 8080 (o 3000 con monitoreo): cambia `HOME_HTTP_PORT` (o `GRAFANA_PORT`) en `deploy/.env.home`. Para ver quién lo usa: `sudo lsof -i :8080` (Linux/macOS) o `netstat -ano \| findstr 8080` (Windows) |
| El build muere a mitad, `exit code 137` o `no space left on device` | Docker Desktop sin memoria o disco: *Settings → Resources*, dale al menos 4 GB de RAM y 20 GB de disco. Libera espacio con `docker system prune` (no borra volúmenes) |
| `files have Windows line endings (CRLF)` o `$'\r': command not found` | El clon convirtió los fines de línea. Con este repo ya no pasa (`.gitattributes`); en un clon viejo: `git config core.autocrlf false && git rm -rq --cached . && git reset -q --hard` (descarta cambios sin commitear) |
| En Windows el juego deja de responder al rato | WSL o Docker Desktop se durmieron, o Windows suspendió el PC. Desactiva la suspensión; en Docker Desktop desactiva *Resource Saver*. Vuelve con `make home-up` |
| `make home-up` muy lento en Windows | El repo está en `/mnt/c/...` (el aviso de `home-up` lo dice): clónalo en `~` dentro de WSL |
| El servidor no arranca después de poner claves de Google o Discord | Falta una de las dos variables de ese proveedor (`*_CLIENT_ID` o `*_CLIENT_SECRET`): `make home-logs` la nombra. Pon las dos, o ninguna |
| Login con Google/Discord termina en `/oauth/error?code=state` | Abriste el juego en una dirección distinta de `PUBLIC_URL` (otra IP, `localhost` en vez del dominio), tardaste más de 10 minutos, o el navegador bloquea cookies. Entra por exactamente `PUBLIC_URL` (paso 8c) |
| Google dice `redirect_uri_mismatch` (o Discord `Invalid OAuth2 redirect_uri`) | La URI registrada en la app no es exactamente `<PUBLIC_URL>/api/auth/oauth/<proveedor>/callback` (http/https, puerto, barra final). Cópiala de la tabla del paso 8c |
| Mis amigos no entran por la LAN | `HOME_BIND=0.0.0.0` y `COOKIE_SECURE=false` en `deploy/.env.home`, y permite el puerto en el firewall: Windows Defender Firewall (Docker Desktop lo pide la primera vez; acepta *Redes privadas*), `sudo ufw allow 8080/tcp` en Linux, macOS *Ajustes → Red → Firewall*. Por Internet usa el túnel: no necesita firewall ni router |
| `Pool overlaps with other one on this address space` | `TUNNEL_SUBNET` choca con otra red: elige otra `/24` privada |
| `make home-tunnel` no imprime URL | Sin salida a internet o Cloudflare limitó Quick Tunnels: mira `make home-logs` y reintenta |
| El login no mantiene la sesión en `http://` | `COOKIE_SECURE=true` en HTTP plano no-localhost: ponlo en `false` (solo LAN/Tailscale sin serve) |
| `no account with email` en `make home-admin` | La cuenta todavía no existe: regístrala primero en el sitio |
| El ranking no muestra mi personaje nuevo | Se actualiza cada minuto |
| `make bots URL=http://localhost:8080` avisa `no map` y `could not read …:9100/metrics` | Esperado con el home stack: los bots caminan al azar y las métricas del servidor no se publican (míralas en Grafana). `make bots` necesita Go instalado |
