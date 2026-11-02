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
                                                            ├─ caddy (cliente, editor, /api y /ws → gameserver)
                                                            ├─ gameserver
                                                            └─ postgres
```
- Mismo `docker compose` que producción (T1.18) con un override `deploy/docker-compose.home.yml`:
  sin backups a S3, Caddy en HTTP interno (el túnel pone el TLS).
- **No hay que abrir puertos del router** ni tener IP fija.

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

## Qué entrega T1.19
- `deploy/docker-compose.home.yml`, `deploy/Caddyfile.home`, `deploy/.env.home.example`.
- `make home-up` / `make home-down` / `make home-logs` / `make home-backup`.
- `make home-tunnel` que levanta un Quick Tunnel de Cloudflare e imprime la URL pública.
- Guía paso a paso para WSL2, macOS y Linux, incluyendo Cloudflare Tunnel con dominio y Tailscale.
