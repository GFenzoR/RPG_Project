# 09 — Deploy en AWS

## Topología inicial (hasta ~100–200 jugadores)
Una sola instancia con Docker Compose:
```
deploy/
  docker-compose.yml   gameserver, postgres, caddy, backup
  Caddyfile            TLS automático, /ws y /api → gameserver, / → cliente, /editor → editor
  .env.example         variables necesarias (sin valores reales)
  backup.sh            pg_dump diario → S3 con retención
  deploy.sh            pull de imágenes y reinicio con anuncio previo a jugadores
```

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
- `gameserver`: build multi-stage de Go → imagen distroless (~20 MB), incluye
  `world.bin`, `data/` compilado e `i18n/`.
- Cliente y editor: build estático de Vite servido por Caddy.
- GitHub Actions construye las imágenes para `linux/amd64` y `linux/arm64` y las publica
  en GitHub Container Registry (ghcr.io).

## Proceso de release
1. Merge a `main` → CI verde → imagen `ghcr.io/<usuario>/rpg-project:<sha>`.
2. Tag `vX.Y.Z` → workflow `release.yml` publica la imagen `:latest` y el instalable de
   Tauri (Windows, macOS, Linux) como release de GitHub.
3. En el servidor, `deploy.sh`: anuncia reinicio en el juego (5 min), guarda a todos,
   hace pull y reinicia. Objetivo: < 1 minuto fuera de línea.

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
