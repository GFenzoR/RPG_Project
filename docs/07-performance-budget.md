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
- Log de economía (T4.1): el loop agrega cada entrada por valor a un buffer reutilizado y
  la entrega por canal en el flush; nada de mapas ni JSON en el tick (los arma la
  goroutine del log). Los eventos recientes de cada jugador (contexto de los reportes)
  van a un anillo fijo. La cuadratura recorre el inventario de un jugador cada
  `economy.check_every_ms` (60 s, escalonado), no cada tick; la inactividad se mira una vez
  por segundo. Con `make bench-tick` las asignaciones por tick no cambiaron (341 con 100
  jugadores caminando, 1013 con 256 monstruos) y el tiempo quedó dentro del ruido aun con
  la cuadratura en cada tick, como en los tests.
- Detección de bots (T4.1): cada acción, paso, golpe o cura actualiza medias móviles y
  anillos fijos del personaje (costo constante, sin asignar). La evaluación es una por
  personaje por minuto, escalonada, y las medianas de ingreso se calculan una vez por ronda.
  No está medida con `make bench-tick` (sus benchmarks la tienen apagada); los tests de
  simulación juegan entre 6 y 8 h de juego de un personaje en menos de un segundo cada uno.
- Ranking público (T4.3, `queries/highscores.sql`): fuera del tick, pero comparte el pool de
  Postgres con los guardados. Hay como mucho 2 consultas a la vez, con 5 s de presupuesto;
  cada página se cachea 60 s por clave. Ninguna consulta ordena todos los personajes:
  - el ranking de nivel recorre `characters_highscore_level_idx`;
  - el de una skill recorre `character_skills_highscore_idx` (skill, level, tries,
    personaje), y solo si eso no llena la página sigue con los personajes que no tienen
    fila de esa skill, por la clave primaria.

  Medido con `EXPLAIN ANALYZE` (Postgres 16, en local) sobre 200k personajes, 1,9M filas
  de skills y 167 bans:

  | Consulta | Tiempo |
  |---|---|
  | Nivel, página 1 | 0,3 ms |
  | Nivel, página 50 filtrada por vocación | 6 ms |
  | Skill, página 1 | 3 ms |
  | Skill, página 50 filtrada por vocación (lee 1001 filas del índice) | 21 ms |
  | Skill sin filas (todos en el nivel base), página 50 | 2 ms |

  En ningún plan hay seq scans. La versión anterior (`LEFT JOIN` + `COALESCE` en el
  `ORDER BY`) hacía un seq scan y ordenaba todo: unos 100 ms por página. Peor caso
  sostenido: 2 consultas de ~20 ms a la vez.

## Cliente
| Métrica | Presupuesto |
|---|---|
| FPS en un notebook de gama media | 60 estable |
| Draw calls | atlas único por capa; < 50 por frame |
| Descarga inicial (web) | < 5 MB sin contar sprites; atlas cargados por demanda |
| Memoria | < 300 MB |

### Audio (T3.7)
El audio no cuenta en la descarga inicial: cada archivo se pide la primera vez que suena
(carga perezosa) y queda decodificado en memoria.

| Métrica | Presupuesto | Hoy |
|---|---|---|
| Todos los archivos de `assets/sounds.yaml` | ≤ 1,5 MiB | ~526 KiB (32 archivos) |
| Un efecto (`sfx`) / interfaz (`ui`) | ≤ 32 KiB / ≤ 16 KiB | máx. ~11 KiB |
| Un loop de música / de ambiente | ≤ 256 KiB / ≤ 96 KiB | máx. ~154 KiB / ~29 KiB |
| Voces simultáneas (efectos + UI) | ≤ 16, y `max_voices` por sonido | — |
| Memoria decodificada (PCM float, 48 kHz mono) | < 40 MB | ~27 MB con todo cargado |

- Formato: **Ogg Opus mono**, 48 kHz. Bitrates: 32 kbps en efectos, 24 en música y 16 en
  ambiente.
- El test de `tools/soundgen` (`checkBudget`) falla si algún archivo o el total se pasan.
  También lo comprueba `make sounds`. Los límites están en `BUDGET`
  (`tools/soundgen/src/index.ts`): si se cambian, se actualiza esta tabla.
- Un sonido silenciado no ocupa voz. Si el archivo llega más de 300 ms tarde, ese sonido
  se descarta.

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

## Medir con el dashboard (T4.4)
Con el profile `monitoring` (`make monitoring-up` en local; `09-deployment-aws.md` en
producción), el dashboard "RPG Project — servidor" de Grafana muestra en vivo los mismos
números de esta tabla:
- **Tick:** p50/p95/p99 con ventana de 1 min y una línea roja en 10 ms. El tile de arriba
  es el p99 de 5 min, el mismo que usa la alerta `TickP99OverBudget`. Los ticks de más de
  50 ms aparecen en "Ticks lentos".
- **RAM y CPU:** RSS y CPU del gameserver contra la máquina (node-exporter).
- **Salida por jugador:** `rate(ws_sent_bytes_total[1m]) / players_online`, con una línea
  en 4 KB/s.
- **Comandos y cola:** comandos por segundo y lo que queda en cola tras cada tick. Si la
  cola crece sostenida, el loop no da abasto.

Para una prueba de carga, corre `make bots N=... URL=...` contra el stack con monitoreo
y mira la ventana estable. El reporte JSON de `tools/bots` sigue siendo la referencia de
los PR. El dashboard sirve para verlo en vivo y para producción.

### Consumo del monitoreo (medido 2026-11-05)
Medido en la sesión cloud (4 vCPU, 16 GB) con el stack de producción y 20 bots durante
6 min, con `docker stats`. Hay ~2000 series activas, con scrape cada 15 s.

| Servicio | RAM medida | Límite (`mem_limit`) |
|---|---|---|
| Prometheus | 34 MB | 256 MB |
| Grafana | 91 MB | 256 MB |
| Alertmanager | 22 MB | 64 MB |
| node-exporter | 8 MB | 64 MB |
| **Total** | **~155 MB** | 640 MB |

En la misma corrida, el resto del stack usaba: gameserver 35–66 MB, Postgres 45 MB, Caddy
16 MB. En una instancia de 2 GB, todo junto queda bajo ~400 MB. La RAM de Prometheus crece
con las series y con la ventana de la cabeza del TSDB (~2 h). Con la retención de 15 días
y estas series, el disco no pasa de unos cientos de MB, y el tope es 1 GB
(`PROMETHEUS_RETENTION_SIZE`). Grafana sube un poco mientras alguien mira dashboards.
Repite la medición cuando aparezcan métricas con muchas series.
