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
| Memoria del portal de mapas (T4.5) | ≤ 40 MiB en total para subidas en curso | 4 lugares (`DefaultMapUploadSlots`) × ≈ 5 × 2 MiB, tomados antes de leer el cuerpo; `TestStalledUploadsGetBusy` |

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
- Puertas con llave (`session/door.go`): la sala detrás de cada puerta se calcula una vez
  al arrancar (un recorrido de hasta 4096 casillas por lado); en el tick, cerrar con llave
  mira una entrada de un mapa por jugador y abrir desde adentro una sola. Un jugador mueve
  una puerta como mucho cada 500 ms, así que una puerta no puede mandar su casilla 30
  veces por segundo. `BenchmarkDoorLockRefused` (un intento de cerrar con alguien sin llave
  en una sala de 3968 casillas, con 100 jugadores, en cada tick): ~2 µs y 10 asignaciones
  (los mensajes); recorrer la sala en cada intento costaba ~0,54 ms y 163 KB.
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

- Efectos, proyectiles y números flotantes (`client/src/render/effect-layer.ts`): los
  objetos de Pixi salen de pools y se reutilizan; dibujar un frame no crea objetos ni
  arrays (solo aparece algo nuevo con un efecto o un número nuevo, si el pool no alcanza).
  Los frames de los efectos salen del atlas (hoy una sola página, junto con el mapa).

### Audio (T3.7)
El audio no cuenta en la descarga inicial: cada archivo se pide la primera vez que suena
(carga perezosa) y queda decodificado en memoria.

| Métrica | Presupuesto | Hoy |
|---|---|---|
| Todos los archivos de `assets/sounds.yaml` | ≤ 1,5 MiB | ~645 KiB (34 archivos) |
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

### Resultados del stack T5.5–T5.7 (2026-11-16)
Medido en la punta del stack de PRs (`feat/volcanic-art`, 313eb38: táctil T5.6, tienda
cosmética T5.7 con cosméticos en `Creature`, puertas con llave, tiras de efectos,
condiciones PvP a distancia, arte volcánico) contra `main` (7a89e66) como línea base, el
mismo día, en la misma máquina y con el mismo script. Notebook con Windows 11 nativo (Git
Bash), Core i7-13650HX (14 núcleos, 20 hilos) y 32 GB; servidor, bots y Postgres 16
(Docker Desktop) en la misma máquina. Mundo: las 4 islas (135 sectores). Ventana estable
de **3 min** (no 10 y 5), con rampa de 20 s (base) y 60 s (stress).

| Métrica | Presupuesto | Base 100 · stack | Base 100 · main | Stress 300 · stack (2 corridas) | Stress 300 · main (2 corridas) |
|---|---|---|---|---|---|
| Tick p50 / p95 / p99 (ms) | p99 < 10 (100 jug.) | 0,03 / 0,70 / **1,78** | 0,03 / 0,73 / **1,75** | 0,72 / 4,15 / **5,49** · 0,57 / 2,84 / **3,98** | 0,51 / 2,45 / **3,69** · 0,58 / 2,86 / **3,98** |
| Tick máx. / ticks lentos (> 50 ms) | — | ≤ 4 / 0 de 3600 | ≤ 4 / 0 de 3600 | ≤ 8 · ≤ 6 / 0 | ≤ 8 · ≤ 6 / 0 |
| RSS máx. / al final (MB) | < 600 | 108,9 / 72,5 | 108,3 / 68,5 | 121,8 / 90,7 · 120,1 / 87,2 | 184,1 / 140,1 · 120,7 / 86,0 |
| CPU del servidor (núcleos) | — | 0,12 | 0,11 | 0,26 · 0,27 | 0,27 · 0,21 |
| Salida por jugador (B/s) | < 4096 | 308 | 318 | 880 · 753 | 800 · 771 |
| Latencia de comando p50 / p95 / p99 (ms) | p95 < 60 | 26,2 / **48,4** / 50,9 | 26,6 / **48,3** / 50,8 | 27,9 / **49,8** / 53,2 · 27,4 / **48,9** / 52,1 | 26,8 / **48,7** / 51,9 · 26,9 / **49,1** / 52,2 |
| Desconexiones / fallos al entrar | 0 | 0 / 0 | 0 / 0 (1 logout fallido) | 0 / 0 | 0 / 0 |

Todo dentro del presupuesto, y el stack no empeora a `main`:
- **Tick.** En stress, la primera corrida del stack dio p99 5,49 ms y la segunda 3,98,
  igual que la segunda de `main` (3,98; la primera, 3,69). Es ruido entre corridas: el
  p99 cae en el bucket de 4–8 ms del histograma y se interpola dentro de él. Los
  benchmarks de `make bench-tick` (`internal/session`) lo confirman sin ruido de red:
  mismas asignaciones por tick que `main` (332 con 100 jugadores caminando, 1341 con 300,
  1005 con 256 monstruos, ~1490 con 1024 y ~1496 con las condiciones) y el mismo tiempo
  dentro del ruido (300 jugadores caminando, 8 muestras de cada uno intercaladas:
  ~120 µs de mediana en los dos).
- **RAM.** El máximo se alcanza en la rampa: cada login verifica la contraseña con
  argon2id (19 MiB por hash) y los bots entran de a varios. Depende de cuántos coinciden
  y de cuándo devuelve memoria el GC, así que varía entre corridas (en `main`, 184 y
  121 MB en stress). La primera corrida base del stack, que además creó las 10 cuentas y
  los 100 personajes, llegó a 163 MB y terminó en 126 (tick p99 1,73 ms, 335 B/s por
  jugador); la tabla muestra la segunda. Con todos adentro, el heap vivo del servidor
  anda entre 31 y 52 MB con 100 jugadores.
- **Red.** Los bots no llevan cosméticos (no tienen saldo), así que la tienda no suma
  bytes a esta medición. El peor caso: un jugador con los tres cosméticos agrega a su
  `Creature` unos 45 bytes (tres ids de ≤ 13 caracteres), y eso solo cuando aparece ante
  alguien o cambia de look (con el anti-flood de `data/cosmetics.yaml`), nunca por paso.
- **Fuera de esta medición.** Los bots no usan el mercado, las casas, las puertas ni la
  tienda; esos caminos tienen sus propios costos acotados más arriba y abajo
  (`BenchmarkDoorLockRefused`, Saver, casas). Las ventanas del mercado en vivo
  (`fix/market-refresh`) son una rama paralela que no está en este stack.
- **Windows.** `make bots` quedaba colgado al final: Git Bash no le llega con SIGINT a un
  proceso nativo. `loadtest.sh` ahora espera a que se escriban los guardados y lo mata
  (`12-local-development.md`, "Prueba de carga"). El logout fallido de la corrida base de
  `main` (un bot desconectado durante el `Logout`) no se repitió en el stack.

**Cliente** (`make build-client`; FPS, draw calls y memoria no se midieron en esta
corrida: no hay instrumentación y piden un navegador real con GPU):

| Métrica | Presupuesto | Stack | `main` |
|---|---|---|---|
| JS + CSS de `build/client/assets` (sin sprites ni audio) | < 5 MB | 1,33 MB (381 KB con gzip) | 1,20 MB (347 KB con gzip) |
| Chunk del juego (`play-*.js`) | — | 681 KB (195 KB con gzip) | 658 KB (190 KB con gzip) |
| Atlas (aparte, por demanda) | una página por capa | 1 página: 287 KB PNG + 160 KB JSON | 1 página: 38 KB PNG (placeholders) |

El bundle creció 128 KB (34 KB con gzip) con lo nuevo del cliente: el layout táctil y la
PWA (T5.6), la tienda (T5.7), el zoom y las tiras de efectos. Los efectos siguen saliendo
del atlas único y de pools (ver "Cliente" arriba).

## Medir con el dashboard (T4.4)
Con el profile `monitoring` (`make monitoring-up` en local; `09-deployment-aws.md` en
producción), el dashboard "Neque's Realm — servidor" de Grafana muestra en vivo los mismos
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

## Escrituras del Saver (T5.3)
Una sola goroutine escribe en orden los autoguardados y los transfers del intercambio y
del mercado. Un transfer de dos personajes con ~20 filas de inventario cada uno tarda
~4 ms en Postgres local (unos 240 por segundo como techo). El presupuesto: autoguardados
escalonados (N jugadores / 300 s) más las acciones del comercio, acotadas por los
anti-flood de `balance.yaml` (`trade.action_*`: un intercambio completo necesita varias
acciones de cada lado y no se confirma vacío; `market.action_*`). Si la cola (4096) se
llena, el loop retiene los trabajos en orden. El gauge `persistence_backlog` (cola del
Saver más lo que retiene el loop, publicado por el loop sin costo en el tick) lo mide
aunque ninguna escritura falle, y la alerta `PersistenceBacklog` avisa si pasa de 1000
durante 5 minutos. `persistence_errors_total{outcome="retry"}` solo cuenta escrituras que
fallaron.

Cada snapshot guardado (también los autoguardados) vuelve al loop como un comando
`World.Saved` (la espera de la falla segura, docs/01 "Transacciones"): N / 300 por
segundo más uno por personaje de cada transfer, cada uno un par de búsquedas en un mapa.
Cada acuse recorre además `World.heldGround` si no está vacío (cada reserva se libera con
el acuse que la cubre: el cadáver que dejó un personaje en espera, lo que el servidor dejó
a sus pies y lo que alguien sacó de una casa a la calle hasta que se confirma), que casi
siempre está vacío o casi: una entrada se borra también cuando su item deja el suelo (las
de un personaje marcado quedan hasta reiniciar o hasta que el cadáver se pudre; son
pocas, porque un transfer descartado es un error raro). Tomar, usar o meter algo en el
suelo mira ese mapa solo si no está vacío. Un acuse que no entra en la cola del loop
(llena) queda en el reintento del `app` (`app/acks.go`): una sola goroutine mientras haya
pendientes y una entrada por personaje (el `Seq` más alto, que vale por los anteriores),
que vuelve a probar cada tick por turnos (cada vuelta empieza después del último
personaje que entregó). Con la cola llena por mucho tiempo cuesta lo que tenga ese mapa,
no una goroutine por acuse.

**Ventanas del mercado en vivo.** Cada acción del mercado encola a quienes miran ese
libro; `flushMarket` les manda una `MarketUpdate` completa (lo que cuesta una respuesta
normal: `list_size` ofertas por lado, las propias, el buzón y el historial) como mucho
una cada `market.push_every_ms` por ventana (500 ms en `balance.yaml`). Con E
espectadores de un libro muy activo son a lo sumo 2·E mensajes por segundo, sin ninguna
lectura de la base. Cada refresco es la ventana **entera**, no un delta: mandar solo lo
que cambió necesitaría un mensaje nuevo y que el cliente fusione listas, y hoy el tope de
2·E por segundo ya acota el costo. Si una medición con muchos espectadores lo pide, el
primer ajuste es subir `push_every_ms`; el delta queda pendiente (docs/14). Una
suspensión (ban o unban) junta los items con ofertas de esa cuenta recorriendo las listas
de ofertas por personaje (`byOwner`, a lo sumo `max_offers` cada una; ningún libro) y
encola solo a los espectadores de esos libros. El paso a solo lectura refresca todas las
ventanas una vez; otra marca después no vuelve a mandar nada.

### Casas (T5.4)
- **Transfers de items de casa:** como mucho uno por tick para todas las casas que
  cambiaron en ese tick (`flushHouses`), con la lista entera de items de cada casa sucia y
  el snapshot de quienes las tocaron. Una casa tiene a lo sumo `items_per_tile` (3) ×
  casillas instancias (hoy, la más grande: 37 × 3 = 111 filas de `house_items`, que se
  reescriben con `COPY` dentro de la transacción) y cada movimiento cuenta contra el
  anti-flood de casas (`houses.action_burst` 8, `action_refill_ms` 300): un jugador
  sostiene como mucho ~3 transfers por segundo moviendo cosas en su casa, del orden de un
  intercambio (≈ 4–6 ms cada uno en Postgres local). Cien jugadores ordenando sus casas a
  la vez (imposible: hay 5 casas) seguirían por debajo del techo del Saver.
- **En el tick:** el paso de un jugador mira un bit de la casilla (`FlagHouse`) y solo en
  casillas de casa busca la casa en un mapa; un cambio de casilla marca su casa sucia con
  el mismo bit. Contar los items de una casa (límite) recorre sus casillas (≤ unas
  decenas). El barrido de alquiler es una vez por segundo, de a lo sumo 32 casas, y el de
  intrusos recorre los jugadores conectados mirando un bit. Nada lee la base en el loop.
- **Arranque:** `LoadHouses` lee tres tablas chicas (dueños, invitados, items) una vez.
