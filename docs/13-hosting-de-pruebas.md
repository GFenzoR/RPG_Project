# 13 — Hosting de pruebas (en casa, antes de AWS)

Antes del deploy alpha en AWS (T1.18) conviene poder jugar con amigos usando tu propio
PC como servidor. Esta guía define qué se puede hostear dónde y cómo lo arma la tarea T1.19.

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

## Archivos (T1.19)
```
deploy/
  docker-compose.home.yml   override del compose de producción: sin backups a S3, Caddy en
                            HTTP en 127.0.0.1:8080, servicios cloudflared (Quick Tunnel y con dominio)
  Caddyfile.home            HTTP plano; confía solo en la red del túnel para CF-Connecting-IP
  .env.home.example         variables; `make home-up` lo copia a deploy/.env.home (ignorado por git)
  home-tunnel.sh            levanta el Quick Tunnel e imprime la URL (lo usa make home-tunnel)
  check-tunnel-ip.sh        comprueba la IP real detrás del túnel
  smoke.sh                  prueba del stack: salud, cliente, login, /ws y rate limit por IP
```
| Comando | Qué hace |
|---|---|
| `make home-up` | Construye las imágenes desde tu checkout y levanta postgres + gameserver + caddy. Queda en `http://localhost:8080` |
| `make home-tunnel` | Quick Tunnel de Cloudflare (cloudflared en Docker); imprime `https://….trycloudflare.com` |
| `make home-tunnel-domain` | Túnel con nombre y dominio propio (`CLOUDFLARE_TUNNEL_TOKEN`) |
| `make home-logs` | Logs en vivo de todo el stack |
| `make home-backup` | `pg_dump` a `deploy/backups/home-<fecha>.dump` |
| `make home-monitoring-up` | Monitoreo opcional (T4.4): Grafana en `http://localhost:3000/grafana/`, ver "Monitoreo en casa" |
| `make home-down` | Apaga todo, monitoreo incluido (los datos quedan en el volumen `rpg-home_pgdata`) |

## Paso a paso

### 1. Instalar Docker y make
Necesitas Docker con Compose **2.24 o más nuevo** (`docker compose version`), `make`, `git`
y `openssl` (este último solo para generar la contraseña de la base).

- **Windows (WSL2).** Instala [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)
  con el backend WSL2 y activa tu distro en *Settings → Resources → WSL integration*. En
  la terminal de Ubuntu: `sudo apt install make git openssl`. Clona el repo **dentro** de
  WSL (`~/RPG_Project`, no en `/mnt/c/...`): el build es mucho más rápido. Para que el
  juego siga online, desactiva la suspensión de Windows mientras juegan.
- **macOS.** Instala Docker Desktop (o OrbStack/Colima, que también traen `docker compose`).
  `make`, `git` y `openssl` vienen con `xcode-select --install`. El PC no debe dormirse:
  *Ajustes → Batería/Energía* o `caffeinate -d` en una terminal mientras juegan.
- **Linux.** Instala Docker Engine y el plugin Compose desde los repos oficiales de Docker
  (`docker-compose-plugin`), agrega tu usuario al grupo `docker` (`sudo usermod -aG docker $USER`,
  cierra sesión y vuelve a entrar) y `sudo apt install make git openssl` (o el equivalente).

### 2. Levantar el juego
```bash
git clone https://github.com/GFenzoR/RPG_Project.git && cd RPG_Project
make home-up
```
La primera vez crea `deploy/.env.home` con una contraseña aleatoria y compila las imágenes
(varios minutos). Termina cuando todos los servicios están *healthy*. Abre
`http://localhost:8080`, crea una cuenta y entra. Si el puerto 8080 está ocupado, cambia
`HOME_HTTP_PORT` en `deploy/.env.home` y repite `make home-up`.

Para actualizar después de un `git pull`, vuelve a correr `make home-up`: reconstruye lo que
cambió y el servidor aplica las migraciones al arrancar. Los datos no se pierden.

### 3. Compartir el link (Quick Tunnel, sin cuenta)
```bash
make home-tunnel
```
Imprime algo como `https://palabras-al-azar.trycloudflare.com`. Ese link es el que mandas
a tus amigos: HTTPS, WebSocket incluido, sin abrir puertos del router. Cambia cada vez que
el túnel arranca de nuevo. El túnel corre en Docker (`cloudflared-quick`), no hay que
instalar nada más. Cloudflare limita los Quick Tunnels a pruebas: para algo estable usa el
paso 4.

**Cliente de escritorio:** quien use la app de Tauri pone ese link en `config.json`
(`{"server_url": "https://palabras-al-azar.trycloudflare.com"}`, ruta según el SO en
`12-local-development.md`, "Cliente de escritorio") o lanza la app con
`RPG_SERVER_URL=...`. El compose ya permite los orígenes de la app en `/ws`. Usa un
nombre de host o una IPv4 (en LAN, `http://192.168.x.x:8080`): la app rechaza IPv6.

### 4. Cloudflare Tunnel con dominio propio (URL fija)
1. Compra o mueve un dominio a Cloudflare (plan gratis) y entra al panel *Zero Trust*.
2. *Networks → Tunnels → Create a tunnel* → tipo **Cloudflared** → ponle nombre.
3. En la pantalla de instalación copia **solo el token** (la cadena larga después de
   `--token`); no instales el conector en tu PC: corre en Docker.
4. *Public hostname*: subdominio `juego`, tu dominio, servicio **HTTP** con URL `caddy:80`.
5. En `deploy/.env.home` pon `CLOUDFLARE_TUNNEL_TOKEN=<token>` y corre
   `make home-tunnel-domain`. Tu juego queda en `https://juego.tudominio.com`.

WebSockets funcionan sin configurar nada. El token es un secreto: no lo subas al repo
(`deploy/.env.home` está en `.gitignore`).

### 5. Tailscale (alternativa privada)
Solo entran las personas invitadas a tu red de Tailscale; nada queda público.
1. Instala Tailscale en tu PC y que cada amigo lo instale en el suyo; invítalos a tu
   tailnet (*Share* o *Invite users* en el panel).
2. En tu PC: `tailscale serve --bg http://localhost:8080` (en WSL2 instala Tailscale dentro
   de la distro o usa el de Windows: Docker Desktop publica el puerto en `localhost` de
   ambos). Tailscale te da `https://<tu-pc>.<tailnet>.ts.net` con certificado válido.
3. Tus amigos abren esa URL. La cookie sigue `Secure` porque es HTTPS.

Sin `tailscale serve` también funciona por la IP de Tailscale en HTTP plano: pon
`HOME_BIND=0.0.0.0` (o tu IP `100.x.y.z`) y `COOKIE_SECURE=false` en `deploy/.env.home` y
repite `make home-up`. Con Tailscale todos los jugadores llegan desde la misma IP vista por
Caddy, así que comparten el cupo de logins por IP (10 seguidos, luego 1 cada 6 s): de sobra
para un grupo de amigos.

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
`make home-backup` deja `deploy/backups/home-<fecha>.dump` (formato custom de `pg_dump`).
Para restaurar:
```bash
C="docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.home.yml --env-file deploy/.env.home"
$C stop gameserver
$C exec -T postgres sh -c 'pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < deploy/backups/home-<fecha>.dump
$C start gameserver
```
Para borrar todo y empezar de cero: `make home-down` y `docker volume rm rpg-home_pgdata`.

## Monitoreo en casa (T4.4)
El mismo profile `monitoring` de producción funciona en casa:
```
make home-monitoring-up   # Prometheus, Alertmanager, Grafana y node-exporter sobre el stack de casa
# Grafana: http://localhost:3000/grafana/  (admin / GRAFANA_ADMIN_PASSWORD de deploy/.env.home)
```
- **Nada del monitoreo pasa por el túnel.** Grafana (3000), Prometheus (9090) y
  Alertmanager (9093) escuchan solo en `127.0.0.1` de tu PC. Los túneles solo llevan a
  Caddy, y la ruta `/grafana/` está apagada (`GRAFANA_PUBLIC=off`). No la actives con un
  Quick Tunnel: cualquiera con la URL llegaría al login.
- **Gasta unos 300 MB más de RAM** (medido en `07-performance-budget.md`).
- **Backups:** en casa no corre el servicio `backup` (los dumps son `make home-backup`).
  Por eso el panel de backups queda vacío y `BackupStale` no se dispara.
- **Notificaciones:** si quieres recibirlas (Discord o Telegram es lo más simple), pon
  las variables `ALERT_*` en `deploy/.env.home` (tabla en `09-deployment-aws.md`,
  "Monitoreo") y repite `make home-monitoring-up`.
- **Puertos:** si 3000 está ocupado (por ejemplo, por otro dev server), cambia
  `GRAFANA_PORT` en `deploy/.env.home`.
- `make home-down` también apaga el monitoreo.

## Problemas comunes
| Síntoma | Causa y solución |
|---|---|
| `make home-up` falla con `!override` | Compose < 2.24: actualiza Docker Desktop o el plugin |
| `port is already allocated` | Otro programa usa 8080: cambia `HOME_HTTP_PORT` |
| `Pool overlaps with other one on this address space` | `TUNNEL_SUBNET` choca con otra red: elige otra `/24` privada |
| `make home-tunnel` no imprime URL | Sin salida a internet o Cloudflare limitó Quick Tunnels: mira `make home-logs` y reintenta |
| El login no mantiene la sesión en `http://` | `COOKIE_SECURE=true` en HTTP plano no-localhost: ponlo en `false` (solo LAN/Tailscale sin serve) |
