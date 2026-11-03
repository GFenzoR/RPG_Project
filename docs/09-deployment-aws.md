# 09 — Deploy en AWS

## Topología inicial (hasta ~100–200 jugadores)
Una sola instancia con Docker Compose:
```
deploy/
  docker-compose.yml        postgres, gameserver, caddy (web), backup
  Dockerfile.gameserver     Go → distroless, con world.bin, data/ e i18n/
  Dockerfile.web            Caddy + build estático del cliente
  Dockerfile.backup         pg_dump 16 + AWS CLI
  Caddyfile                 sitio con TLS automático; importa caddy-routes.caddy
  caddy-routes.caddy        /api, /ws y /healthz → gameserver, / → cliente (compartido con docs/13)
  .env.example              variables necesarias (sin valores reales)
  backup.sh                 pg_dump comprimido con retención; copia a S3 opcional
  deploy.sh                 pull + backup + reinicio (migraciones al arrancar)
  healthcheck/              sonda HTTP mínima para el HEALTHCHECK de la imagen distroless
  smoke.sh                  prueba del stack levantado: login, /api/play, /ws, IP del cliente
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
   entonces el único punto de guardado es el apagado por SIGTERM (`stop_grace_period: 30s`).

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

### Backups y restauración
- El servicio `backup` hace un `pg_dump` (formato custom, comprimido) al arrancar y luego
  cada `BACKUP_INTERVAL_SECONDS`, borra los locales de más de `BACKUP_RETENTION_DAYS` días
  y, si `BACKUP_S3_URI` está definido, sube cada dump. La retención en S3 se configura con
  una regla de lifecycle del bucket.
- Queda `unhealthy` si pasan dos intervalos sin un backup exitoso.
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
  servidor por defecto. El job `check` falla si falta o si el tag no coincide con la versión.
- Matriz: `windows-latest` (`.msi` y `.exe` NSIS), `macos-latest` (`.dmg`/`.app`
  universal, arm64 + x64) y `ubuntu-latest` (`.deb`, `.rpm`, `.AppImage`). Los sube
  `tauri-action` a un **Release en borrador**: lo revisas y lo publicas a mano. Solo este
  workflow tiene `contents: write`.
- El servidor acepta los orígenes del webview por `RPG_WS_ORIGINS` (default del compose).
  `/ws` se autentica con el token de un uso del `Hello`, nunca con cookie, así que permitir
  esos orígenes no habilita que otra página use la sesión de nadie.
- Para dejar fuera apps viejas: sube `-min-client-version` del gameserver (docs/05).

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
- Postgres sin puerto expuesto (solo red interna de Docker).
- Secretos (OAuth, clave de sesiones) en `.env` del servidor, nunca en el repo.
- Backups diarios a S3 y prueba de restauración mensual.
- Actualizaciones automáticas de seguridad del sistema operativo.

## Cuándo crecer
- Tick p99 > 25 ms sostenido o CPU > 70 %: subir de instancia.
- > 300 jugadores: separar Postgres a RDS y evaluar varios mundos (un proceso por mundo).
- Varios mundos = varias instancias del gameserver con su propia base de personajes y
  login central. La arquitectura actual lo permite sin reescribir el loop.
