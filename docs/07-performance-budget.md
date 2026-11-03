# 07 — Presupuesto de rendimiento

Objetivo: **100 jugadores simultáneos en una instancia de 2 vCPU y 2–4 GB de RAM**, con
holgura para crecer a ~300 sin cambiar la arquitectura.

## Servidor
| Métrica | Presupuesto | Cómo se mide |
|---|---|---|
| Duración del tick p99 | < 10 ms con 100 jugadores (20 % del tick de 50 ms) | métrica `tick_duration_ms`, `make bots N=100` |
| RAM del proceso | < 600 MB con el mundo del hito 3 cargado | `/metrics`, bots |
| Salida de red por jugador | < 4 KB/s promedio en zona concurrida | métrica de bytes por sesión |
| Latencia de comando (recibido → evento enviado) | < 60 ms p95 en el servidor | bots |
| Arranque del servidor | < 10 s | log de arranque |
| Asignaciones por tick | sin crecimiento sostenido | `go test -bench` con `-benchmem` |

## Técnicas obligatorias
- Mundo en memoria con arrays planos por sector, no mapas de Go por casilla.
- Sectores inactivos no procesan IA ni movimiento de monstruos.
- Scheduler por min-heap para eventos con tiempo (respawns, condiciones, cooldowns):
  nada de recorrer todas las entidades cada tick.
- Pathfinding A* con límite de nodos y caché de flags por tile.
- Envío por deltas (MapSlice, TileUpdate). Un frame por jugador por tick como máximo.
- Pools para buffers de serialización.
- Persistencia fuera del loop con snapshots copiados.

## Cliente
| Métrica | Presupuesto |
|---|---|
| FPS en un notebook de gama media | 60 estable |
| Draw calls | atlas único por capa; < 50 por frame |
| Descarga inicial (web) | < 5 MB sin contar sprites; atlas cargados por demanda |
| Memoria | < 300 MB |

## Pruebas de carga
`tools/bots` simula jugadores que caminan, atacan monstruos, hablan y abren diálogos.
- Escenario base: 100 bots repartidos en la isla inicial durante 10 minutos.
- Escenario estrés: 300 bots concentrados en la ciudad.
- El reporte (JSON + resumen en el PR) incluye tick p50/p95/p99, RAM, CPU, latencias y
  desconexiones. Si un PR empeora el tick p99 más de 10 %, debe justificarlo.

Cómo correrlo: `make bots N=100` (base, 10 min) y `make bots N=300 SCENARIO=stress`
(5 min); detalle en `12-local-development.md`. Qué mide y de dónde sale cada número:
- **Tick, RAM, CPU, bytes por jugador**: del `/metrics` interno del servidor durante la
  ventana estable (todos los bots dentro). El tick es un histograma: los percentiles se
  interpolan dentro del bucket, como `histogram_quantile`. RAM = RSS del proceso; CPU =
  segundos de CPU del proceso por segundo de reloj.
- **Latencia de comando**: ida y vuelta de un `Ping` de cada bot cada 2 s. El servidor lo
  ejecuta en el siguiente tick y responde en el batch de ese tick, así que incluye la
  espera al tick (0–50 ms, ~25 ms de media) y la red local. Es el piso de la latencia
  de cualquier comando.
- **Comportamiento de los bots**: rutas A* sobre `world.bin` hacia su zona (base: 9 zonas
  de la Isla del Puerto en round robin; stress: todos a 8 casillas o menos del templo y
  la plaza). Después reparten su tiempo así:
  - base: vagar 45 %, pelear 25 %, hablar con un NPC 12 %, chat 10 %, nada 8 %;
  - stress (la ciudad es zona de protección, no se pelea): vagar 45 %, hablar con un
    NPC 37 %, chat 10 %, nada 8 %.

  Entre acciones hay 1–4 s de pausa, y cada comando, cada frame, pasa por el rate limit
  del bot: como mucho uno cada 250 ms (`-min-gap`).
- **Ventanas**: tick, RAM, CPU, bytes, latencia y lo recibido (pasos, mensajes) cubren
  la ventana estable. Las acciones de los bots (`actions_since_entry`) cuentan desde que
  cada bot entra: rampa más ventana.

### Resultados (T1.17, 2026-11-03)
Sesión cloud de 4 vCPU y 16 GB, con **servidor y bots en la misma máquina** (los bots
le quitan CPU al servidor: los números del servidor son conservadores). Postgres 16
local. Mundo: Isla del Puerto + isla de pruebas.

| Métrica | Presupuesto | Base: 100 bots, 10 min | Stress: 300 bots, 5 min |
|---|---|---|---|
| Tick p50 / p95 / p99 (ms) | p99 < 10 (100 jug.) | 0,28 / 0,90 / **1,69** | 0,79 / 2,41 / **3,76** |
| Ticks lentos (> 50 ms) | — | 0 de 11 998 | 1 de 5 997 (132 ms) |
| RSS máx. (MB) | < 600 | 86 | 99 |
| CPU del servidor (núcleos) | — | 0,05 | 0,14 |
| Salida por jugador (B/s) | < 4096 | 286 | 839 |
| Latencia de comando p50 / p95 / p99 (ms) | p95 < 60 | 26,3 / **49,0** / 50,7 | 27,9 / **49,8** / 52,9 |
| Desconexiones / fallos al entrar | 0 | 0 / 0 | 0 / 0 |
| Acciones desde la entrada (rampa + ventana) | — | 7811 caminatas, 190 ataques, 2174 chats, 62 diálogos abiertos | 17 609 caminatas, 4550 chats, 4534 diálogos abiertos |

Todo dentro del presupuesto, con mucha holgura en tick, RAM y red. La latencia de comando
está dominada por la espera al siguiente tick, no por el servidor. Pendientes:
- El único tick lento (132 ms con 24 comandos, en stress) no se reprodujo en base. Lo más
  probable es la contención de CPU con los 300 bots en la misma máquina. Falta repetirlo
  con los bots en otra máquina y `pprof` para descartar otra causa.
- En stress, ~91 % de las caminatas (`WalkPath`) se cortaron con `WalkRejected`: 16 044
  cortes en 17 609 caminatas, con 10 251 pasos confirmados, contados desde la conexión.
  Son 300 personajes en ~300 casillas libres. Es lo esperado en una ciudad llena, y la
  red y el tick lo aguantan. En los reportes nuevos este contador se llama
  `walks_rejected` y cubre solo la ventana estable.
- RAM medida con el mundo del hito 1. El presupuesto de 600 MB es para el mundo del
  hito 3: hay que repetir la prueba cuando crezca.
