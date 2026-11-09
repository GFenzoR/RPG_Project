# 09 — Deploy en AWS

## Topología inicial (hasta ~100–200 jugadores)
Una sola instancia con Docker Compose:
```
deploy/
  docker-compose.yml        postgres, gameserver, caddy (web), backup; profile `monitoring`
                            (Prometheus, Alertmanager, Grafana, node-exporter; T4.4)
  Dockerfile.gameserver     Go → distroless, con world.bin, data/ e i18n/
  Dockerfile.web            Caddy + build estático del cliente
  Dockerfile.backup         pg_dump 16 + AWS CLI
  Caddyfile                 sitio con TLS automático; importa caddy-routes.caddy
  caddy-routes.caddy        /api, /ws y /healthz → gameserver; /play → juego; resto → sitio
                            público (landing, ranking, noticias; T4.3). Compartido con docs/13
  .env.example              variables necesarias (sin valores reales)
  backup.sh                 pg_dump comprimido con retención; copia a S3 opcional
  deploy.sh                 pull + backup + reinicio (migraciones al arrancar)
  healthcheck/              sonda HTTP mínima para el HEALTHCHECK de la imagen distroless
  smoke.sh                  prueba del stack levantado: login, /api/play, /ws, IP del cliente
  caddy-grafana-{off,on}.caddy  ruta /grafana/ opcional (apagada por defecto; T4.4)
  monitoring/               Prometheus (config, reglas de alertas y sus tests), entrypoint
                            de Alertmanager, Grafana (datasources y dashboard), check.sh
```
```
Internet ─:80/:443─▶ caddy ──red edge──▶ gameserver:8080 ──red internal──▶ postgres:5432
                                                       backup ──────────┘   (sin puertos)
```
- La red `internal` no tiene salida: Postgres solo es alcanzable desde gameserver y backup.
- `backup` también está en `edge` para la copia opcional a S3.
- El editor **no** se publica todavía: hoy guarda chunks en `world/` a través del backend
  de desarrollo local (`04-map-editor-and-ai.md`), así que un build estático no podría
  guardar. Llega con el envío de patches a revisión (hito 4–5); la ruta `/editor` está
  comentada en el `Caddyfile`.

## Instancia sugerida
| Opción | Specs | Costo aprox. | Comentario |
|---|---|---|---|
| Lightsail 2 GB | 2 vCPU, 2 GB, 60 GB SSD, tráfico incluido | ~USD 12/mes | La más simple para partir |
| EC2 t4g.small (ARM) | 2 vCPU, 2 GB | ~USD 12–15/mes + disco + tráfico | Más flexible; compila Go para arm64 |
| EC2 t4g.medium | 2 vCPU, 4 GB | ~USD 25–30/mes | Cuando haya más contenido o jugadores |

Precios aproximados: verifica en la calculadora de AWS antes de contratar. Elige la
región según tus jugadores (São Paulo `sa-east-1` para Latinoamérica tiene mejor ping,
pero es más cara; `us-east-1` es más barata).

## Imágenes
Las publica `.github/workflows/images.yml` en GitHub Container Registry, para
`linux/amd64` y `linux/arm64` (Graviton/t4g), usando solo `GITHUB_TOKEN`:

| Imagen | Contenido | Tamaño aprox. |
|---|---|---|
| `ghcr.io/gfenzor/rpg-project-gameserver` | binario estático, `world.bin`, `data/`, `i18n/`, usuario no root (65532) | ~7 MB comprimida |
| `ghcr.io/gfenzor/rpg-project-web` | Caddy 2.11 + `dist/` del cliente | ~25 MB |
| `ghcr.io/gfenzor/rpg-project-backup` | postgres:16-alpine (pg_dump) + AWS CLI, usuario `postgres` | la más grande (AWS CLI) |

- Go compila en la plataforma del runner (`$BUILDPLATFORM`) y cruza a la de destino: QEMU
  solo se usa para el `apk add` de la imagen de backup.
- `world.bin` se genera dentro del build con `cmd/mapcompile` desde `world/` + `data/`.
  Un mapa o contenido que no compila **rompe el build**: nunca sale una imagen sin mundo.
  El servidor lo carga con `-world=/app/build/world.bin` (también `$RPG_WORLD`).
- El cliente se compila con su script `build` (`pnpm --filter @rpg/client build`, que
  escribe `build/client/` con el atlas de sprites) y Caddy lo sirve desde `/srv/client`.
  Son dos páginas (T4.3): `index.html` es el sitio público (landing, `/highscores`,
  `/news/...`, con fallback a esa página) y `play/index.html` es el juego (`/play` y
  `/play/*`). Solo `/assets/*` (con hash) se cachea como inmutable; páginas, atlas y
  sonidos llevan `Cache-Control: no-cache` (revalidan con ETag), así un deploy se ve en la
  siguiente carga. `deploy/smoke.sh` revisa las dos páginas, `/api/status` y
  `/api/highscores`.
- En los PR que tocan algo que entra en una imagen, el workflow solo **construye** (sin
  push), así un Dockerfile roto falla en el PR.

Tags:
| Evento | Tags |
|---|---|
| push a `main` | `main`, `sha-<7>` |
| tag `vX.Y.Z` | `X.Y.Z`, `X.Y`, `sha-<7>`, `latest` |
| PR | se construye, no se publica |

Los paquetes de GHCR nacen **privados**. O los haces públicos (GitHub → Packages →
package settings → visibility), o en el servidor haces `docker login ghcr.io` con un token
personal con permiso `read:packages`.

## Proceso de release
1. Merge a `main` → CI verde → imágenes `:main` y `:sha-<7>`.
2. Tag `vX.Y.Z` → `images.yml` publica `:X.Y.Z` y `:latest`. El cliente de escritorio
   tiene su propio tag `desktop-vX.Y.Z` (ver "Cliente de escritorio" abajo).
3. En el servidor, `./deploy.sh vX.Y.Z`: fija `IMAGE_TAG` en `.env`, hace pull, backup,
   reinicia el gameserver (aplica migraciones al arrancar) y luego caddy y backup.
   Objetivo: < 1 minuto fuera de línea (en pruebas locales el gameserver vuelve en ~6 s).
   **Pendiente:** el anuncio de reinicio en el juego y el guardado explícito de jugadores
   (`TODO(admin-commands)` en `deploy.sh`), cuando exista el comando de admin. Hasta
   entonces el único punto de guardado es el apagado por SIGTERM (`stop_grace_period: 90s`).

## Guía de uso de `deploy/`

### Probar el stack completo en tu máquina
```
make docker-build   # construye gameserver, web y backup desde tu checkout
make docker-up      # levanta todo y espera a que los healthchecks pasen
# https://localhost  (CA local de Caddy: el navegador avisa del certificado)
make docker-logs    # logs de todos los servicios
make docker-down    # para el stack (los volúmenes quedan)
```
La primera vez se crea `deploy/.env` desde `.env.example` con `SITE_ADDRESS=localhost`,
un email de relleno y una contraseña de Postgres aleatoria. Si 80/443 están ocupados,
cambia `HTTP_PORT`/`HTTPS_PORT` en `deploy/.env` (entra por `https://localhost:<puerto>`).

### Variables (`deploy/.env`)
| Variable | Para qué |
|---|---|
| `IMAGE_REGISTRY`, `IMAGE_TAG` | De dónde salen las imágenes; en producción fija un `vX.Y.Z` |
| `SITE_ADDRESS` | Dominio público (TLS automático), `localhost` (CA local) o `:80` (HTTP plano detrás de un túnel, `13-hosting-de-pruebas.md`) |
| `ACME_EMAIL` | Contacto para la autoridad de certificados. Obligatorio: Caddy no arranca con el email vacío |
| `COOKIE_SECURE` | `true` salvo HTTP plano en un host que no sea localhost |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Credenciales internas; contraseña URL-safe (`openssl rand -hex 24`) porque va en `DATABASE_URL` |
| `BACKUP_RETENTION_DAYS`, `BACKUP_INTERVAL_SECONDS` | Retención local y periodicidad de los dumps |
| `BACKUP_S3_URI`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Copia a S3 opcional; en EC2 mejor un rol de instancia que claves |
| `HTTP_PORT`, `HTTPS_PORT` | Puertos del host (solo para pruebas locales) |
| `COMPOSE_PROFILES` | Perfiles opcionales separados por coma: `monitoring` (T4.4), `map-pr` (worker de PR de mapas, T4.5) |
| `GITHUB_MAP_PR_TOKEN` | Token del worker de PR de mapas (sección "Worker de PR de mapas"). Vacío = el worker no corre |
| `MAP_PR_REPOSITORY`, `MAP_PR_BASE` | Repo (`owner/repo`, por defecto `GFenzoR/RPG_Project`) y rama base (`main`) de esos PR |
| `PUBLIC_URL` | Dirección de los enlaces de los emails (T2.1). Por defecto `https://$SITE_ADDRESS` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` | Emails de la cuenta (sección "Emails de la cuenta"). Sin `SMTP_HOST` no hay emails |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Login con Google/Discord ("Login con Google y Discord"). Sin ninguno de los dos, ese proveedor queda apagado; con uno solo, el servidor no arranca y el log nombra la variable que falta |
| `REQUIRE_VERIFIED_EMAIL` | `true` = solo cuentas con email verificado juegan (necesita SMTP) |
| `RPG_WS_ORIGINS` | Orígenes extra en `/ws`. Sin definir = los del cliente de escritorio (`tauri://localhost,http://tauri.localhost`); vacío = solo el sitio |

### Primer deploy (cuando haya cuenta AWS y dominio)
1. Instancia con Docker y el plugin compose; security group con 80/443 abiertos (y 443/udp
   para HTTP/3). Registro DNS `A`/`AAAA` del dominio → IP de la instancia.
2. Copia `deploy/docker-compose.yml`, `deploy/deploy.sh` y `deploy/.env.example` al
   servidor (no hace falta el repo entero); `cp .env.example .env` y complétalo.
3. Si las imágenes son privadas: `docker login ghcr.io`.
4. `./deploy.sh v0.1.0`. Caddy obtiene el certificado en el primer request al dominio.
5. Comprueba `https://<dominio>/healthz` → `{"status":"ok"}`.

### Migraciones
Van embebidas en el binario y el gameserver aplica las pendientes al arrancar (`-migrate`,
activo por defecto). El healthcheck solo pasa cuando la API HTTP está arriba, es decir,
después de migrar, y `deploy.sh` espera ese estado (`up --wait`). Por eso no hay un
servicio one-shot de migraciones. Antes de reiniciar, `deploy.sh` hace un backup.

### Roles de staff (T2.6)
Los roles (`player`, `gm`, `admin`) se asignan solo desde el servidor, nunca desde el juego.
Cada cambio queda en el log de auditoría con el usuario del sistema que lo hizo:
```
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec gameserver \
  /app/gameserver admin set-role -email ana@example.org -role gm -note "nueva GM"
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec gameserver \
  /app/gameserver admin audit -n 50
```
En local: `make set-role EMAIL=... ROLE=gm NOTE="..."` y `make audit-log`. El cambio revoca
los tokens de la cuenta. Si se quita un rol, los personajes conectados de esa cuenta lo
pierden en unos 5 s, sin reiniciar nada. Un rol nuevo vale desde el próximo login.

Los reportes de jugadores abiertos (T4.1), con el contexto que adjuntó el servidor, se
leen con `/app/gameserver admin reports -n 20` (en local `make reports`). Los GM los
cierran dentro del juego con `/closereport`. Las alertas de economía (posible duplicación,
personajes muy por encima de lo normal) van al log estructurado (`economy:`) y a la métrica
`economy_alerts_total{kind}`.

### Emails de la cuenta (T2.1)
Verificación de email y reset de contraseña necesitan SMTP; sin `SMTP_HOST` quedan
apagados (no se pide verificar y el sitio no ofrece el reset). Opciones en AWS:
- **Amazon SES** (recomendado en AWS): verifica el dominio en SES (registros DKIM en tu
  DNS), pide salir del sandbox, crea credenciales SMTP (SES → SMTP settings → Create SMTP
  credentials; no son tus claves de IAM) y usa `SMTP_HOST=email-smtp.<región>.amazonaws.com`,
  `SMTP_PORT=587`, `SMTP_SECURITY=starttls`, `SMTP_FROM=RPG Project <noreply@tudominio>`.
  EC2 bloquea el puerto 25 de salida: usa 587 (o 465 con `SMTP_SECURITY=tls`).
- Cualquier proveedor transaccional con SMTP (Brevo, Mailjet, Postmark, Resend…), o Gmail
  con contraseña de aplicación para pruebas (`13-hosting-de-pruebas.md`, paso 8b).

Configura SPF, DKIM y DMARC del dominio remitente o los emails caen en spam. `PUBLIC_URL`
debe ser la URL pública del sitio (`https://tudominio`): los enlaces apuntan ahí y el
servidor nunca la saca del header `Host`. El servidor manda en STARTTLS obligatorio (no
degrada a texto plano) y la contraseña SMTP no se registra nunca.

Enlace de reset a mano (sin SMTP, o para una cuenta sin email verificado):
```
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec gameserver \
  /app/gameserver admin reset-link -email ana@example.org
```
Imprime un enlace de un solo uso (1 h); queda auditado como `reset_link_issued`.

### Login con Google y Discord (T2.1)
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

En AWS, `PUBLIC_URL` es `https://tudominio.com` (el default es `https://$SITE_ADDRESS`).
Para el paso a paso en Google Cloud y Discord ver `13-hosting-de-pruebas.md` (paso 8c): es
igual, con la URI del dominio. Con la app de Google en modo "Prueba" solo entran los
usuarios de prueba: publícala antes de abrir el juego.

### Backups y restauración
- El servicio `backup` hace un `pg_dump` (formato custom, comprimido) al arrancar y luego
  cada `BACKUP_INTERVAL_SECONDS`, borra los locales de más de `BACKUP_RETENTION_DAYS` días
  y, si `BACKUP_S3_URI` está definido, sube cada dump. La retención en S3 se configura con
  una regla de lifecycle del bucket.
- Queda `unhealthy` si pasan dos intervalos sin un backup exitoso.
- Cada corrida escribe sus métricas (`rpg_backup_*`) en `/backups/metrics/backup.prom`.
  Con el monitoreo activo alimentan el panel de backups y las alertas `BackupFailed` y
  `BackupStale`.
- Backup manual: `docker compose -f docker-compose.yml run --rm backup --once`.
- Listar y copiar: `docker compose exec backup ls -lh /backups` y
  `docker compose cp backup:/backups/rpg-<fecha>.dump .`.
- Restaurar (con el gameserver parado):
  ```
  docker compose stop gameserver
  docker compose exec backup sh -c \
    'pg_restore --clean --if-exists --no-owner -d "$PGDATABASE" /backups/rpg-<fecha>.dump'
  docker compose start gameserver
  ```
  Probado localmente: dump → `pg_restore` en una base nueva → datos presentes.
  Haz una prueba de restauración al mes.

### Monitoreo (T4.4)
Stack opcional en el profile `monitoring` del mismo compose. No se levanta con el `up`
normal ni con `deploy.sh`: hay que pedirlo.

| Servicio | Imagen (fija) | Licencia | Límite de RAM | Puerto en el host |
|---|---|---|---|---|
| `prometheus` | `prom/prometheus:v3.5.0` | Apache-2.0 | 256 MB | `127.0.0.1:9090` |
| `alertmanager` | `prom/alertmanager:v0.28.1` | Apache-2.0 | 64 MB | `127.0.0.1:9093` |
| `grafana` | `grafana/grafana:12.1.1` (OSS) | AGPL-3.0 | 256 MB | `127.0.0.1:3000` |
| `node-exporter` | `prom/node-exporter:v1.9.1` | Apache-2.0 | 64 MB | ninguno |

- Las imágenes corren sin modificar. La AGPL de Grafana solo obliga a publicar el código
  si lo modificamos y lo ofrecemos por red, y no lo hacemos. Las cuatro se configuran
  con archivos montados desde `deploy/monitoring/`.
- **Por qué Prometheus y no VictoriaMetrics:** VictoriaMetrics single-node usa menos RAM
  para guardar series. Pero no evalúa reglas: necesitaría además `vmalert`. Con nuestras
  ~2000 series, Prometheus solo usó 34 MB, y así las reglas y sus tests se
  validan con `promtool`. El consumo medido está en `07-performance-budget.md`.
- **Retención:** 15 días o 1 GB de disco, lo que llegue primero (`PROMETHEUS_RETENTION`,
  `PROMETHEUS_RETENTION_SIZE`). Scrape cada 15 s.
- **Red:** red `monitoring` interna, sin salida. El gameserver escucha `/metrics` en
  `:9100` sin publicarlo en el host. Prometheus lo lee por `monitoring`, pero los otros
  contenedores del stack también lo alcanzan por sus redes. Caddy no tiene ruta a
  `/metrics`, a Prometheus ni a Alertmanager.
  Alertmanager también está en `edge`, para llegar a Discord, Telegram o al SMTP.
- **node-exporter** monta `/` del host en solo lectura (CPU, RAM, disco) y el volumen de
  backups (métricas de `backup.sh`).

Activarlo en el servidor:
1. Copia `deploy/monitoring/` junto a `docker-compose.yml`. Las rutas son relativas al
   compose.
2. En `.env`, agrega `GRAFANA_ADMIN_PASSWORD=<openssl rand -hex 16>`. Grafana no
   arranca sin él. Opcionalmente, agrega los canales de alertas (tabla de abajo).
3. `docker compose -f docker-compose.yml --env-file .env --profile monitoring up -d --wait`.
   Para apagarlo: `docker compose ... stop prometheus alertmanager grafana node-exporter`.
4. Entra por **túnel SSH**. Nada del monitoreo se publica a internet:
   ```
   ssh -N -L 3000:127.0.0.1:3000 -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 usuario@<servidor>
   # Grafana:      http://localhost:3000/grafana/   (usuario admin)
   # Prometheus:   http://localhost:9090            Alertmanager: http://localhost:9093
   ```
   El dashboard "RPG Project — servidor" es la página de inicio de Grafana.
5. Si cambias reglas o el dashboard: `make monitoring-check`, copia los archivos y
   recarga. Prometheus se recarga con `curl -X POST localhost:9090/-/reload` desde el
   túnel. Grafana relee los dashboards cada minuto.

Variables del monitoreo (en `deploy/.env`; ninguna va al repo). Todas tienen un default
en `docker-compose.yml`; solo `GRAFANA_ADMIN_PASSWORD` hay que definirla:

| Variable | Default | Para qué |
|---|---|---|
| `GRAFANA_ADMIN_PASSWORD` | vacía: Grafana no arranca | Contraseña del login de Grafana. `make monitoring-up` genera una si falta |
| `GRAFANA_ADMIN_USER` | `admin` | Usuario del login de Grafana |
| `GRAFANA_ROOT_URL` | `http://localhost:3000/grafana/` | URL pública de Grafana; con la ruta pública, `https://<dominio>/grafana/` |
| `GRAFANA_PUBLIC` | `off` | `on` activa la ruta `/grafana/` de Caddy (ver abajo) |
| `GRAFANA_BASIC_AUTH_USER` | `disabled` | Usuario del basic auth de esa ruta |
| `GRAFANA_BASIC_AUTH_HASH` | hash bcrypt de un secreto aleatorio que nadie tiene | Hash del basic auth (`caddy hash-password --bcrypt-cost 10`) |
| `GRAFANA_ALLOW_IPS` | `192.0.2.0/32` (TEST-NET: nadie) | IPs que pueden intentar el basic auth, en formato del matcher `client_ip` de Caddy (`203.0.113.7/32`, varias separadas por espacio); el resto recibe 403. Sin definirla, todos reciben 403 |
| `ALERT_DISCORD_WEBHOOK_URL` | vacía | Webhook de un canal de Discord |
| `ALERT_TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID` | vacías | Bot de Telegram y chat de destino (hacen falta las dos) |
| `ALERT_WEBHOOK_URL` | vacía | Cualquier endpoint HTTP (POST JSON de Alertmanager) |
| `ALERT_EMAIL_TO`, `ALERT_SMTP_SMARTHOST` (`host:puerto`), `ALERT_SMTP_FROM` | vacías | Email (hacen falta las tres) |
| `ALERT_SMTP_USER`, `ALERT_SMTP_PASSWORD` | vacías | Credenciales SMTP, si el servidor las pide |
| `PROMETHEUS_RETENTION`, `PROMETHEUS_RETENTION_SIZE` | `15d`, `1GB` | Retención del TSDB (lo que llegue primero) |
| `GRAFANA_PORT`, `PROMETHEUS_PORT`, `ALERTMANAGER_PORT` | `3000`, `9090`, `9093` | Puertos en `127.0.0.1` del host |

- Los canales se combinan: se usan todos los que estén definidos. Sin ninguno, las
  alertas solo se ven en Grafana y en Alertmanager.
- El entrypoint de Alertmanager (`deploy/monitoring/alertmanager/entrypoint.sh`) genera
  la configuración al arrancar. Los secretos van a archivos en un tmpfs, nunca al YAML.
- Al cambiar un canal: `docker compose ... --profile monitoring up -d alertmanager`.
- Alertas, umbrales y métricas: `01-architecture.md` ("Observabilidad").

Ruta pública opcional `/grafana/` (desactivada por defecto). Úsala solo si el túnel SSH
no te sirve. Cada intento de basic auth cuesta una comparación bcrypt en la misma máquina
que corre el tick de 50 ms. Con usuarios desconocidos, Caddy compara contra un hash
interno de costo 14 (alrededor de 1 s de CPU), así que unas pocas peticiones por segundo
con credenciales al azar saturan 2 vCPU. Por eso la ruta filtra por IP antes de
autenticar.
1. Genera el hash con costo bajo:
   `docker run --rm caddy:2.11-alpine caddy hash-password --bcrypt-cost 10 --plaintext '<contraseña>'`.
2. En `.env`, pon:
   - `GRAFANA_PUBLIC=on`;
   - `GRAFANA_BASIC_AUTH_USER=<usuario>` (que no sea el admin de Grafana);
   - `GRAFANA_BASIC_AUTH_HASH='<hash>'` (entre comillas simples, porque lleva `$`);
   - `GRAFANA_ALLOW_IPS=<tu IP IPv4>/32`. Sin ella, todos reciben 403. Con Tailscale,
     usa la IP de tu equipo en la tailnet (`100.x.y.z/32`; `100.64.0.0/10` no es un rango
     privado para Caddy);
   - `GRAFANA_ROOT_URL=https://<dominio>/grafana/`.
3. Recrea `caddy` y `grafana`.

Cómo responde la ruta:
- Fuera de `GRAFANA_ALLOW_IPS`: 403, sin trabajo de bcrypt. `client_ip` respeta los
  proxies de confianza, así que en casa se usa la IP real que llega por el túnel.
- **IPv6:** la red `edge` de Docker es solo IPv4. En un host con IPv6 (registro `AAAA`),
  Docker reenvía las conexiones IPv6 con `docker-proxy` desde el gateway de la red
  (`172.x.0.1`), así que Caddy ve esa IP y no la del visitante. No pongas
  `private_ranges` ni el rango `172.16.0.0/12` en `GRAFANA_ALLOW_IPS`: dejarías entrar a
  cualquier visitante por IPv6. Si tu navegador prefiere IPv6 y recibes 403 con tu IPv4
  en la lista, entra por IPv4 (`curl -4`, o un nombre sin `AAAA`) o usa el túnel SSH.
- Si solo definiste el usuario o solo el hash, el otro valor queda con un placeholder.
  Solo autentica la combinación configurada (por ejemplo, el usuario `disabled` con la
  contraseña de tu hash). Con los dos placeholders, nadie entra. El compose nunca le pasa
  a Caddy valores vacíos, así que Caddy arranca igual y el sitio no se cae.
  `deploy/monitoring/check.sh` lo comprueba.
- Las dos capas quedan separadas: Caddy no reenvía el header `Authorization` y Grafana
  tiene el basic auth apagado (`GF_AUTH_BASIC_ENABLED=false`). Siempre se entra por el
  formulario de login de Grafana.
- `GRAFANA_PUBLIC` solo acepta `on` u `off` (es el nombre de un archivo
  `caddy-grafana-*.caddy`).

El gameserver tiene `stop_grace_period: 90s`: las etapas de apagado más
`-metrics-linger` (20 s, solo si se abandonaron escrituras; ver `01-architecture.md`).

### Worker de PR de mapas (T4.5)
Un envío del portal de mapas (`/maps/submit`) que un moderador aprueba queda `approved`. El
servicio `map-pr-worker` (perfil `map-pr`, `tools/map-pr-worker`) lo toma, mezcla el patch
sobre la rama base **actual** con el merge de `packages/map-format` y abre un PR en este repo
desde la rama `map-submission/<id>-<sha256[:12]>` (el sha del patch en el nombre: dos bases
que comparten el repo, como producción y un servidor de pruebas, nunca comparten rama). El PR toca solo archivos de mapa de `world/` y
`world/CONTRIBUTORS.md` (el crédito). Sobre ese PR corren los checks de mapas de siempre
(`map-pr`, docs/04). El worker no expone puertos: habla con Postgres (red `internal`) y con la
API de GitHub (red `edge`).

**Cómo activarlo**
1. **Una cuenta de bot.** Crea una cuenta de GitHub aparte (por ejemplo `rpg-map-bot`),
   invítala al repo como colaboradora con permiso **Write** y **no** la agregues a
   `.github/MAINTAINERS`. El check de mapas decide si un PR puede tocar fuera de las
   parcelas mirando a su autor: un PR abierto con el token del dueño del repo (`OWNER`) o de
   un maintainer saldría eximido de esa regla aunque traiga el cambio de un jugador. Por eso
   el worker **se niega a correr** si el token es del dueño o de alguien de `MAINTAINERS`
   (lo comprueba al arrancar con `GET /user` y el `MAINTAINERS` de la rama base, y queda en
   pausa con un log de nivel `error`). Además rechaza por su cuenta los cambios fuera de
   parcelas (`outside_plot`).
2. **El token: un PAT clásico con solo `public_repo`.** Este repo es de una cuenta de
   usuario (`GFenzoR`), y un token *fine-grained* solo puede apuntar a repos de su propia
   cuenta o de organizaciones de las que es miembro: GitHub no los admite para un
   colaborador externo. Así que, con la sesión de la cuenta del bot: *Settings → Developer
   settings → Personal access tokens → Tokens (classic) → Generate new token (classic)*.
   - *Note*: `rpg map PR worker`.
   - *Expiration*: un año como máximo; anota la fecha para rotarlo.
   - *Scopes*: **solo `public_repo`** (el repo es público). Ni `repo` completo, ni
     `workflow` (sin él no puede tocar `.github/workflows/`), ni nada de cuenta u
     organización.
   Lo que ese token puede tocar lo limita el permiso de la cuenta del bot: **Write** en este
   repo (y nada en los demás). El worker, aparte, rechaza toda ruta fuera de `world/`.

   **Alternativas.** Si el repo pasa a una **organización**, el bot (miembro de la org)
   puede usar un token *fine-grained* de solo este repo con **Contents** y **Pull
   requests** de lectura y escritura, que es lo más acotado. Una **GitHub App** instalada
   solo en este repo (mismos permisos) evitaría la cuenta de bot; el worker de hoy no la
   implementa (habría que firmar un JWT y pedir el token de instalación antes de cada
   ronda).
3. En el servidor, en `deploy/.env`:
   ```
   COMPOSE_PROFILES=map-pr            # o monitoring,map-pr
   GITHUB_MAP_PR_TOKEN=ghp_...
   MAP_PR_REPOSITORY=GFenzoR/RPG_Project
   ```
   y `./deploy.sh` (o `docker compose up -d map-pr-worker`). `deploy/.env` no se commitea
   (`.gitignore`) y debe quedar con permisos `600`. El gameserver recibe
   `RPG_MAP_PR_WORKER=on` cuando hay token, y la página de moderación deja de mostrar el
   aviso de "ábrelo a mano".
4. Comprueba con `docker compose logs map-pr-worker`: `map PR worker started`, `map PR
   worker token` con el login del bot y, al aprobar un envío, `map submission pull request`
   con su número. El token nunca aparece en los logs.

**Por qué no el `GITHUB_TOKEN` de Actions.** Un PR o un push hecho con el `GITHUB_TOKEN` de
un workflow **no dispara otros workflows** (GitHub lo evita para que no haya ejecuciones en
cadena). Un PR abierto así no correría `map-pr`, ni `map-pr-pending`, ni la CI, y quedaría
sin veredicto. Además, ese token solo existe dentro de un job de Actions y el worker corre en
el servidor del juego, que es quien ve la cola en Postgres.

`RPG_MAP_PR_WORKER=on` sale de que haya token, no de que el perfil esté activo: pon los dos
(paso 3) o ninguno, si no el sitio dirá que el PR se abre solo.

**Sin token**, el servicio arranca, avisa una vez `GITHUB_MAP_PR_TOKEN is not set` y queda
inactivo hasta que se lo detiene (así `docker compose up --wait` con el perfil activo no
falla). Los envíos aprobados quedan `approved` y la página de moderación explica cómo
abrirlos a mano: descargar el patch, aplicarlo con `mapcli patch apply <archivo>` en la rama
**exacta** que muestra (`map-submission/<id>-<sha12>`) y abrir el PR pegando en la
descripción la línea de marca que también muestra
(`<!-- rpg-map-submission: <id> sha256:<sha> -->`). Cuando el worker se active, encuentra
ese PR por la rama y la marca, y lo registra en lugar de abrir otro.

**Qué hace con cada envío** (contrato de la migración 00010, docs/04):
- Lo reserva con `FOR UPDATE SKIP LOCKED` y un lease de 10 min (`attempts + 1`).
- Si ya hay un PR desde su rama **y** su cuerpo lleva la marca de ese envío, lo registra.
  Si la rama existe sin PR y su commit lleva los trailers `Map-Submission`/`Sha256` del
  envío, abre el PR. Si no hay nada, mezcla el patch sobre la base y escribe árbol (con el
  texto de los archivos en el mismo pedido: uno solo, sin importar cuántos archivos),
  commit y rama con la API Git Data (sin `git clone`). Cada paso se puede repetir después de
  una caída sin abrir dos PR.
- Resultado: `pr_opened` con la URL, o `failed` con un código fijo que el autor ve en "Mis
  envíos": `conflict` (la base cambió en las mismas casillas), `outside_plot`,
  `invalid_patch`, `no_changes` (la base ya lo tiene) o `github` (10 intentos fallidos).
  Antes de dejar un envío en `failed`/`github`, el worker vuelve a buscar su PR: si el
  último intento murió justo después de que GitHub lo creara, lo registra.
- Un error de red, un 5xx o una respuesta cortada lo deja `approved` y reintenta con espera
  creciente (1, 2, 4… minutos, hasta 6 h).
- Las pausas son **de todo el worker**, no por envío, y no gastan el intento de nadie:
  - **rate limit** (429, o 403 con `retry-after` o sin pedidos restantes): espera lo que
    pida GitHub (`Retry-After`, `x-ratelimit-reset`, como mínimo 60 s);
  - **configuración** (401, 403 sin rate limit, 404: token vencido o revocado, permiso que
    falta, repo o rama base mal escritos): 15 min, con un log de nivel `error`. Un token
    vencido nunca deja en `failed` los envíos de nadie.
- El título del jugador va al título del PR y del commit con `#`, `@`, `GH-`, las palabras
  que cierran issues (`fixes`, `closes`, `resolves`…) y las URL neutralizados con un carácter
  de ancho cero: no cierra issues al mergear ni menciona a nadie. El propio worker escribe
  "envío n.º 12", nunca "#12", que enlazaría a otro issue o PR.

**Rotar o revocar.** Genera el token nuevo, cámbialo en `deploy/.env` y
`docker compose up -d map-pr-worker`; después borra el viejo en GitHub. Si se filtra:
revócalo en GitHub de inmediato (los PR ya abiertos siguen siendo PR comunes; revisa los
que abrió el bot).

### IP del cliente y rate limits
Los límites por IP de login/registro (T1.3) usan la IP que ve el gameserver. La cadena es:

1. Caddy recibe la conexión. `{client_ip}` es el par TCP, salvo que ese par esté en
   `trusted_proxies`. En producción **no hay proxies de confianza** (Caddy es el borde).
2. `caddy-routes.caddy` hace `header_up X-Forwarded-For {client_ip}`: el gameserver recibe
   **un solo** valor. Un `X-Forwarded-For` o `CF-Connecting-IP` falsificado por el cliente
   se descarta, no se concatena.
3. El gameserver corre con `-trust-proxy` y toma la última entrada de `X-Forwarded-For`.
   Es seguro solo porque el puerto 8080 no se publica: todo pasa por Caddy.

`deploy/smoke.sh` lo comprueba contra el stack levantado (job `stack` de
`.github/workflows/images.yml`): diez logins fallidos con `X-Forwarded-For` distinto cada
uno agotan igual el cupo de la IP real (el undécimo responde 429).

### Reutilización para hosting en casa (T1.19)
`docs/13` reutiliza este compose con un override: Caddy en HTTP plano (el túnel pone el
TLS) y `COOKIE_SECURE` sigue en `true` porque el jugador ve HTTPS. Detrás del túnel,
`Caddyfile.home` confía solo en la red del túnel y toma la IP real de `CF-Connecting-IP`.

## Cliente de escritorio (T2.5)
`.github/workflows/release-desktop.yml` compila la app de Tauri con un tag `desktop-vX.Y.Z`:
```bash
# 1. sube la versión en client/package.json (única fuente de la versión) y mergea
# 2. tag con la misma versión
git tag desktop-v0.2.0 && git push origin desktop-v0.2.0
```
- Requiere la variable del repo `DESKTOP_SERVER_URL` (Settings → Secrets and variables →
  Actions → Variables) con el origen `https://` de producción: queda compilada como
  servidor por defecto. El job `check` falla si falta, si el tag no coincide con la
  versión o si la URL no pasa la validación de la propia app (corre el test
  `compiled_default_is_valid` con `RPG_DESKTOP_SERVER_URL`): ruta, query, credenciales o
  IPv6 darían instaladores que se cierran al abrir.
- Matriz: `windows-latest` (`.msi` y `.exe` NSIS), `macos-latest` (`.dmg`/`.app`
  universal, arm64 + x64) y `ubuntu-22.04` (`.deb`, `.rpm`, `.AppImage`). Linux se
  compila en el runner más viejo a propósito: los paquetes enlazan glibc/GTK/WebKitGTK del
  host, y compilados en 24.04 (glibc 2.39) fallan en Ubuntu 22.04 y Debian 12. Los sube
  `tauri-action` a un **Release en borrador**: lo revisas y lo publicas a mano. Solo este
  workflow tiene `contents: write`.
- El servidor acepta los orígenes del webview por `RPG_WS_ORIGINS` (default del compose).
  `/ws` se autentica con el token de un uso del `Hello`, nunca con cookie, así que permitir
  esos orígenes no habilita que otra página use la sesión de nadie.
- Para dejar fuera apps viejas: sube `-min-client-version` del gameserver (docs/05).
- La app abre directo el juego (`play/index.html`, `app.windows[0].url` de
  `tauri.conf.json`), nunca la landing (T4.3).

### Sin firma de código (por ahora)
- **Windows:** SmartScreen muestra "Windows protegió tu PC" → "Más información" →
  "Ejecutar de todas formas". Desaparece con un certificado de firma (OV/EV o Azure
  Trusted Signing) y reputación acumulada.
- **macOS:** Gatekeeper dice que la app "no se puede abrir" o "está dañada". Clic derecho →
  Abrir (o Ajustes → Privacidad y seguridad → "Abrir igualmente"); si dice dañada:
  `xattr -dr com.apple.quarantine "/Applications/RPG Project.app"`.
- **Linux:** sin avisos; el `.AppImage` necesita `chmod +x`. Requiere webkit2gtk 4.1
  (Ubuntu 22.04+, Debian 12+, Fedora 37+).

### Agregar firma, notarización y auto-update después
- **Windows:** certificado en secrets y `bundle.windows.certificateThumbprint` o
  `bundle.windows.signCommand` (p. ej. `trusted-signing-cli`) en `tauri.conf.json`.
- **macOS:** cuenta de Apple Developer; secrets `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` y para notarizar `APPLE_ID`,
  `APPLE_PASSWORD`, `APPLE_TEAM_ID` en el env de `tauri-action` (los lee el bundler).
- **Auto-update:** `tauri-plugin-updater` con un par de claves (`tauri signer generate`),
  la pública en `plugins.updater.pubkey`, la privada en el secret
  `TAURI_SIGNING_PRIVATE_KEY`, `bundle.createUpdaterArtifacts: true` y
  `uploadUpdaterJson: true` en el workflow. Hay que sumar el permiso del updater a la
  capability y `https://github.com` al endpoint.

## Seguridad operativa
- Solo puertos 80 y 443 abiertos. SSH restringido a tu IP o con SSM Session Manager.
- Monitoreo (Grafana, Prometheus, Alertmanager) solo en `127.0.0.1`, por túnel SSH.
- Postgres sin puerto expuesto (solo red interna de Docker).
- Secretos (OAuth, clave de sesiones) en `.env` del servidor, nunca en el repo.
- Backups diarios a S3 y prueba de restauración mensual.
- Actualizaciones automáticas de seguridad del sistema operativo.

## Cuándo crecer
- Tick p99 > 25 ms sostenido o CPU > 70 %: subir de instancia.
- > 300 jugadores: separar Postgres a RDS y evaluar varios mundos (un proceso por mundo).
- Varios mundos = varias instancias del gameserver con su propia base de personajes y
  login central. La arquitectura actual lo permite sin reescribir el loop.
