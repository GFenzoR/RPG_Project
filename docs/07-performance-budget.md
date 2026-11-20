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
- Pathfinding A* con límite de nodos y caché de flags por tile. Un monstruo cuya búsqueda
  no encontró camino (de vuelta a casa o hacia su objetivo) espera
  `combat.monster_path_retry_ms` (1 s) antes de buscar otra vez: uno trabado frente a
  agua no gasta la cuota del tick de los demás. Con correa, el que persigue a un objetivo
  fuera de su alcance hace una búsqueda por ese lapso aunque dé pasos (dos cuando decide
  que no llega), siempre dentro de su área de correa.
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
- Portales (`session/portal.go`): que una casilla sea escalera, agujero o teletransporte
  es el bit `portal_step` de sus flags (lo pone `world.NewMap`), no una búsqueda en un
  mapa de Go: A* (`reroute`, la persecución, `bot.Nav`) y `monsterCanEnter` lo leen por
  cada casilla que miran (un mapa sin portales ni lo lee). `BenchmarkTickMonsters` tiene
  una variante `/portal` (un teletransporte en una esquina) que mide ese costo, porque
  todas las islas reales tienen portales: sin diferencia medible (≈ 87 µs por tick con
  256 monstruos y ≈ 340 µs con 1024, con y sin portal). Cada paso por un portal manda un
  `FullMapView` (y ningún `MapSlice`): subir y bajar sin parar por la mina volcánica son
  unos 2260 B/s con un nivel 30 y la vista de 31x21 (950 con la de 15x11), dentro de los
  4 KB/s (`TestVolcanicMineStairsOnTheMap` lo
  mide y falla por encima). Hoy todas las islas tienen solo los pisos 7 y 8, así que la vista de la
  superficie lleva un piso; una isla con pisos altos pesaría más por paso.
- Habilidades de monstruos (`session/abilities.go`, lote 10): lo que cambia por fase
  (intervalos, alcance, velocidad) se calcula una vez por tipo al arrancar; un monstruo
  sin fases ni curas ni invocaciones paga dos comparaciones por tick. Un área recorre sus
  casillas (a lo sumo 137 con radio 6) con un buffer reutilizado y manda un `Effect` por
  casilla, como un hechizo de área. `BenchmarkTickMonsters` suma las variantes `/leash`
  (correa de 6, la de `data/balance.yaml`: antes `make bench-tick` corría sin correa) y
  `/areas` (cada lobo con un círculo de radio 2 cada 2 s). Medido (2026-11-19, i7-13650HX,
  medianas intercaladas contra la base): 1024 monstruos 492 → 468 µs, con portal 508 →
  481, con correa 483 → 488, `/areas` 608 µs (las casillas, sus `Effect` y más golpes);
  `BenchmarkCrowdTick` y `BenchmarkFullMapView` iguales. `BenchmarkTickConditions` sube
  ~9 % (456 → 495 µs con 4000 ticks, +26 asignaciones por tick): no es costo propio, es
  que la persecución ahora sigue su rodeo y llega a su objetivo (más golpes y más
  `hitEvents`); con el rodeo guardado apagado mide como la base (~450 µs).
  La revisión de la rama hizo que un área solo cuente si tendría a su objetivo adentro
  (`session.strikes`/`covers`: un recorrido por los ataques en uso y, para un rayo en
  línea, sus casillas): con correa 510 → 509 µs y sin áreas igual; `/areas` sube de ~630 a
  ~710 µs y de 149 a 205 KB por tick, y no por el chequeo: con el círculo sin daño mide
  igual que antes (545 → 548 µs). Es el juego: el círculo ya no gasta su ronda en un
  jugador en la esquina de su radio, espera y le pega, así hay más golpes, más muertes y
  más vueltas al templo en el benchmark.
- Estados del personaje (`session/status.go`, lote 13): `sendConditions` mira en cada
  tick, por jugador, una casilla del mapa (zona de protección) y tres ticks guardados, y
  solo manda la lista si algo empezó, terminó o un fin se movió 1 s o más (una pelea
  larga: a lo sumo una lista por segundo). Medido (2026-11-19, i7-13650HX, 3 corridas
  contra la base): `BenchmarkTickPlayersWalking` igual (100 jugadores ~36 µs, 300 ~163
  µs, sin asignaciones nuevas); `BenchmarkTickConditions` igual en tiempo (~1,0 ms) y
  +135 asignaciones y +12 KB por tick: las entradas `in_combat` que viajan en las listas
  que ya se mandaban (los envenenados están en combate).
- Movimiento fluido (cola de pasos de teclado y época, `session/move.go`): no agrega
  mensajes. Sigue siendo un `Walk` por paso (antes también: el cliente lo manda 50 ms
  antes, no más seguido) y un `CreatureMove` por paso; `walk_epoch` suma ~2 bytes a cada
  `Walk`, `WalkRejected` y `FullMapView`, y `seq`/`walk_seq` ~2-4 bytes a cada `Walk` y al
  `CreatureMove` del propio jugador (los de los observadores no cambian). En el tick, un `Walk` es un append a la cola del
  jugador (tope 4, sin asignar una vez que la cola creció) y una comparación de época;
  `moveSystem` no cambió. El rate limit del gateway (30/s) no se acerca: a la velocidad
  más alta (un paso por tick) son 20 `Walk` por segundo, y un cliente que manda de más
  solo llena la cola y la reinicia.
- Puertas con llave (`session/door.go`, `session/area.go`): la sala detrás de cada puerta
  se calcula una vez al arrancar (un recorrido de hasta 4096 casillas por lado) y queda un
  índice casilla → sala (`roomOf`). También al arrancar se numeran las **áreas** del mapa
  (un recorrido de cada casilla caminable, una vez) para el chequeo de escape y las
  búsquedas de casilla libre: un `[1024]int32` (4 KiB) por sector que tiene alguna
  casilla de un área. Las **áreas de casa** (las casillas de cada casa unidas a pie, para
  las búsquedas que empiezan en una casa) van en los mismos arreglos con id negativo: no
  suman memoria salvo un sector que solo tenga casillas de casa. En el mundo real (135
  sectores, 4 islas de 2 pisos): 12 áreas y 6 áreas de casa en 105 sectores, unos 420 KiB,
  y `initAreas` tarda ~7 ms (`session.New` entero, ~9 ms; medido de nuevo con las áreas
  de casa); el
  chequeo de escape es un recorrido de un grafo de áreas (una por puerta y portal) y no se
  nota. Crece con los sectores del mundo, no con los jugadores: un mundo 10 veces más
  grande serían ~4 MiB y ~70 ms al arrancar. `make validate` hace lo mismo en TS solo con
  las áreas que toca (las de los lados de las puertas, las de los portales y las de los
  templos): ~35 ms sobre el mundo real. En el tick, abrir desde adentro es una búsqueda
  en `roomOf`; cerrar con llave mira solo a los jugadores de los sectores de la sala (una
  búsqueda cada uno) y, de los que están adentro, busca la llave en sus bolsas cortando al
  encontrarla. Toda búsqueda de casilla libre por anillos (`freeNear`, `houseExit`) suma
  una búsqueda en el índice de áreas por casilla (un mapa por sector, como antes
  `roomOf`), sin asignar. Un jugador usa una puerta como mucho cada
  `inventory.door_cooldown_ms` (500 ms), **también cuando se lo rechazan**, así que ni la
  casilla ni los chequeos corren al ritmo del gateway. `BenchmarkDoorLockRefused` (el peor
  intento: 202 jugadores, 151 en una sala de 3968 casillas, 150 con la llave al fondo de
  un cofre de 40 items y el que no la tiene mirado último; la espera bajada a un tick para
  intentar en cada uno): ~39 µs y 10 asignaciones por tick, contra ~19 µs y 2
  asignaciones del mismo tick sin el intento, o sea ~20 µs y 8 asignaciones (los mensajes)
  por intento, una vez cada 500 ms por jugador. Antes (jugador sin llave segundo, mochilas
  vacías, 100 jugadores) medía ~2 µs: no era el peor caso.
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

## Capacidad del mundo (auditoría de contenido M1, 2026-11)
La meta de 100 jugadores no es solo del servidor: el mundo tiene que darles de cazar. La
mide `packages/content-schema/src/world-capacity.test.ts` (corre con `make test`), que lee
`data/` y `world/` y falla si una franja queda por debajo de su meta.

- **XP/h teórica de un monstruo:** Σ cantidad × 3600 / `respawn_seconds` × experiencia, sobre
  sus spawns de las islas de producción (las que no son `dev_only`).
- **XP/h que pide un jugador de la franja [a, b]:** (xp(b) − xp(a)) / (horas(b) − horas(a)),
  con la curva y el ritmo de `balance.yaml → experience` (ley de potencia entre los anclajes
  8 → 1 h, 20 → 8 h, 50 → 80 h; fuera de ellos, el tramo más cercano).
- **Eficiencia 2/3:** nadie mata a un monstruo en el instante en que reaparece (caminar,
  saquear, curarse, y un monstruo no reaparece cerca de un jugador: dentro de la ventana
  clásica de 15x11 + 1, también con la vista de 31x21, docs/02 "Monstruos" y "La vista").
  Jugadores de la franja = XP/h de sus monstruos × 2/3 / XP/h por jugador.
- Cada monstruo de producción pertenece a una sola franja (el test lo exige: uno nuevo
  obliga a ubicarlo). El jefe de la forja suma a la de 50–60.

| Franja | Meta | Monstruos | XP/h por jugador | XP/h teórica antes → ahora | Jugadores antes → ahora |
|---|---|---|---|---|---|
| 1–8 | 15 | gaviota, cangrejo, lobo, rata, murciélago | 4,7k | 42,6k → 118,6k | 6,0 → 16,7 |
| 8–15 | 15 | jabalí, araña, saqueador, escarabajo, minero ahogado | 9,7k | 59,3k → 223,7k | 4,1 → 15,4 |
| 15–20 | 14 | ciervo, sapo, espinoso | 13,4k | 188,3k → 343,6k | 9,4 → 17,1 |
| 20–25 | 14 | contrabandista, reptante | 14,3k | 109,6k → 307,2k | 5,1 → 14,3 |
| 25–40 | 16 | sabueso, salamandra | 17,6k | 298,7k → 455,3k | 11,3 → 17,2 |
| 40–50 | 14 | minero de obsidiana, gólem | 20,7k | 169,2k → 475,2k | 5,5 → 15,3 |
| 50–60 | 12 | dragoncillo, custodio | 22,9k | 72,6k → 433,0k | 2,1 → 12,6 |
| **Total** | **100** | 126 → 253 monstruos | | | **43,4 → 108,6** |

- **Cómo se llegó:** respawns más cortos (gaviota y rata 30 s, cangrejo 35, lobo y
  murciélago 45, jabalí, araña, ciervo, sabueso, salamandra, minero de obsidiana y gólem
  60, sapo 50, saqueador y escarabajo 70, espinoso y contrabandista 75, dragoncillo 75,
  minero ahogado y reptante 90; el custodio sigue en 1200), más monstruos por spawn y 20
  spawns nuevos (`world/islands/*/spawns.yaml`), separados unos 12–20 casilleros para que
  varios grupos cacen a la vez. Jabalíes y arañas también en el sur del Bosque; en el
  Volcán, gólems en los campos de lava enfriada del sur y dragoncillos en la ladera oeste
  del cráter y en el campo sureste.
- **Abedules:** de 5 a 29 (13 en Puerto fuera del Farol, 16 en arboledas del Bosque).
  Cada uno da 3 troncos y vuelve a los 6 min: 150 → 870 troncos/h; el test pide 600.
- **Rendimiento:** 253 monstruos en producción, lejos de los 1024 que mide
  `BenchmarkTickMonsters` (≈ 340 µs), y solo piensan en sectores activos.
- **Para retocar:** subir o bajar `count` y `respawn_seconds` con `mapcli ops apply`
  (`remove_spawn` + `add_spawn` con su `index`; nunca a mano) y correr el test; si cambia el
  ritmo de `balance.yaml`, la XP por jugador cambia sola. Un respawn que escale con los jugadores cercanos quedó descartado: con la
  regla de no reaparecer a la vista, más jugadores en el mismo punto no matan más.

## Cliente
| Métrica | Presupuesto |
|---|---|
| FPS en un notebook de gama media | 60 estable |
| Draw calls | atlas único por capa; < 50 por frame |
| Descarga inicial (web) | < 5 MB sin contar sprites; atlas cargados por demanda |
| Memoria | < 300 MB |

- Movimiento fluido (`client/src/state/motion.ts`, `world.ts`): por frame y criatura,
  `drawPos`/`facing`/`activeWalk` miran a lo sumo la cadena de pasos que se dibujan (uno o
  dos) y no recorren nada más; el colchón de jitter (`Playout`) es una cuenta por batch
  sobre 8 baldes fijos (no asigna).
  El rastro de posiciones para el E2E (`MotionTrail`) es un `Float64Array` fijo de 1024
  frames (24 KiB): grabar un frame no asigna. Costo visible: las demás criaturas se
  dibujan ~40 ms (más el jitter de la red) después de que llega su paso, nunca más de
  240 ms (`PLAYOUT_MAX_JITTER_MS` + margen); tras un corte de la red vuelven a eso en
  unos 4 s.
- Efectos, proyectiles y números flotantes (`client/src/render/effect-layer.ts`): los
  objetos de Pixi salen de pools y se reutilizan; dibujar un frame no crea objetos ni
  arrays (solo aparece algo nuevo con un efecto o un número nuevo, si el pool no alcanza).
  Los frames de los efectos salen del atlas (hoy una sola página, junto con el mapa).
- Animación de criaturas (docs/17 ANI, `client/CLAUDE.md` "Animación de criaturas"): cada
  criatura tiene un estado de animación (uno por criatura, mientras está en vista) y todas
  comparten una entrada y una pose que `animate` sobrescribe; las texturas de cada sprite
  se indexan una sola vez (`render/clips.ts`) y las sombras de contacto comparten un
  `GraphicsContext`. Dibujar un frame no crea objetos para animar. Con los personajes de LPC
  el atlas pasó a **2 páginas** (2048x2048 y 2048x640): Pixi agrupa hasta 16 texturas por
  batch, así que no suma draw calls por página.
- Arte del mapa (docs/17 ART-3 a ART-7): los looks de suelo y las piezas de muro se eligen
  al armar el chunk, no por frame. Los tiles animados (agua, lava, espuma, copas, fuego) van
  en una lista plana que `MapView.render` recorre una vez por frame: por cada uno, una
  cuenta (`frameAt`) y, solo si cambió el frame, un cambio de textura. Sin asignar. La
  capa de sombras proyectadas es un render group más (un batch). La luz de las cuevas
  (z ≥ 8) suma un pase a un render texture de un cuarto de la pantalla, con un sprite de
  brillo por luz sacado de un pool; en la superficie no dibuja.

### Audio (T3.7)
El audio no cuenta en la descarga inicial: cada archivo se pide la primera vez que suena
(carga perezosa). Los efectos y el ambiente quedan decodificados en memoria; la música se
transmite (ver abajo).

| Métrica | Presupuesto | Hoy (2026-11-18) |
|---|---|---|
| Todos los archivos de `assets/sounds.yaml` | ≤ 16 MiB | ~13,4 MiB (44 archivos; 13,3 MiB de música) |
| Una pool de música (`music.pools`) | ≤ 8 MiB | Cuevas ~6,0 MiB (7 temas), Puerto ~3,2 MiB (3), las demás ~1 MiB |
| Un efecto (`sfx`) / interfaz (`ui`) | ≤ 32 KiB / ≤ 16 KiB | máx. ~11 KiB |
| Un tema de música / un loop de ambiente | ≤ 1,5 MiB / ≤ 96 KiB | máx. ~1,1 MiB / ~29 KiB |
| Descarga al cambiar de zona | el tema que suena y el siguiente de su pool (≤ 3 MiB) | ~1,7–2,2 MiB |
| Música en memoria | `KEEP_STREAMS` (4) archivos comprimidos sin usar, más los que suenan o se esperan si son más (como mucho 6: 4 voces y 2 pedidos), + los decodificadores de 2–4 elementos | ~4–5 MB; ~7 MB en el peor caso |
| Música en la caché de la PWA | nada (`client/src/sw/policy.ts`: `/audio/sounds/music/` va a la red) | 0 |
| Voces simultáneas (efectos + UI) | ≤ 16, y `max_voices` por sonido | — |
| Memoria decodificada (PCM float, 48 kHz) | < 40 MB | ~9 MB en el peor caso (efectos, interfaz y dos ambientes); +~10 MB mientras suena un tema de soundgen (solo en un lugar con `none`) |

- **Por qué cambió (pedido del dueño, 2026-11-18):** al escuchar la música de Gemini pidió
  transiciones cuidadas, temas que no empiecen siempre por el principio, las tres tomas de
  Puerto y más versiones de cueva. Los loops de ~1 minuto mono a 20 kbps del lote 7 eran
  justo la monotonía que no quiere y sonaban finos. Ahora cada toma entra **entera** (~3 min)
  en **Ogg Opus estéreo**, y el tope pasó de 1,5 MiB a 16 MiB en total, con 8 MiB por pool.
- **Bitrate medido** (2026-11-18, la toma 1 de Puerto y la 1 de Cuevas contra el AAC de
  Gemini, error por tercio de octava y ancho estéreo): a 24 kbps el códec junta los canales
  (se pierde un cuarto a un tercio del ancho); desde 32 kbps el estéreo queda entero y el
  error baja despacio (Puerto 2,25 / 2,10 / 2,01 / 1,86 dB a 32 / 40 / 48 / 56 kbps; Cuevas
  2,01 / 1,72 / 1,61 / 1,20). Los temas van a **48 kbps** (~1,1 MiB por toma); las cuevas,
  drones y goteos ralos cuya fuente corta en 14 kHz, a **40 kbps** (~0,85 MiB), para que su
  pool de 7 entre en el presupuesto con lugar para dos versiones más.
- **Streaming:** un tema de 3 minutos en estéreo decodificado entero ocuparía ~66 MB, más que
  todo el presupuesto de memoria. El motor (`client/src/audio/engine.ts`) baja el archivo una
  vez a un object URL (los bytes comprimidos) y lo toca con un `<audio>` conectado a Web Audio
  (`MediaElementAudioSourceNode`), que decodifica de a poco y puede saltar a cualquier
  segundo sin depender de que el servidor acepte rangos (`Range`). Guarda los últimos
  `KEEP_STREAMS` archivos (4) que no estén sonando ni esperándose; los que suenan o se
  esperan se guardan además de esos, así que en el peor caso (cuatro voces durante un
  corte y dos temas pedidos) son seis. Con la música silenciada no baja nada. Un archivo
  que no llega (o que el elemento no puede decodificar) se vuelve a pedir a los
  `STREAM_RETRY_MS` (5 s), con la espera doblada en cada falla hasta 60 s. Uno que el
  elemento no sabe tocar (`MEDIA_ERR_SRC_NOT_SUPPORTED`, un códec que le falta) no se vuelve
  a pedir en la sesión, y si el navegador dice que no toca Ogg Opus en `<audio>`
  (`canPlayType`, WebKit viejo) no se baja ningún tema: la música queda en silencio en vez
  de bajar ~1 MB por minuto para nada.
- **La PWA no guarda la música:** el service worker deja `/audio/sounds/music/` a la red
  (como `/api`). Con stale-while-revalidate una PWA instalada terminaba guardando los
  ~13 MiB de música y escribía un tema entero (~1 MB) en su caché en cada cambio de zona;
  el motor ya baja cada tema una sola vez por sesión y el navegador lo cachea por HTTP.
  Efectos y ambiente (chicos) siguen en la caché.
- **Los temas de soundgen** (sin `seconds`: lo que suena en un lugar que el dueño marca
  `none`) son loops cortos: se decodifican (~10 MB de PCM mono cada uno) y suenan en un
  `AudioBufferSourceNode` con `loop`, sin hueco en la vuelta (el `loop` de un `<audio>`
  deja uno en Chromium). Se sueltan apenas dejan de sonar y de esperarse.
- **Formatos:** efectos y ambiente **Ogg Opus mono** 48 kHz (32 kbps los efectos, 16 el
  ambiente); los temas de soundgen mono a 24 kbps (son loops cortos, siguen igual); la
  música de Gemini estéreo a 48 kbps (40 las cuevas). `make music-gemini` escribe ese
  formato (`tools/gemini/music_import.py`, `KBPS` y `AMBIENT_KBPS`).
- El test de `tools/soundgen` (`checkBudget`) falla si algún archivo, una pool o el total se
  pasan. También lo comprueban `make sounds` y `make music-gemini`. Los límites están en
  `BUDGET` (`tools/soundgen/src/index.ts`): si se cambian, se actualiza esta tabla.
- Un sonido silenciado no ocupa voz. Si el archivo de un efecto llega más de 300 ms tarde,
  ese sonido se descarta. Un tema que tarda en llegar no corta nada: la música anterior
  sigue hasta que el nuevo puede sonar.

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

**Atlas con criaturas animadas** (2026-11-17, `feat/creature-animation`): 2 páginas,
1,84 MB + 652 KB de PNG y 374 KB + 209 KB de JSON, más 158 KB de `atlas.json` (antes, 1
página de 287 KB). Son ~1300 frames de 64x64 de los personajes de LPC: 4 atuendos y 4
monstruos con quieto, caminar, atacar y caer, y 17 NPCs con quieto y caminar. Se bajan
aparte del bundle (el presupuesto de 5 MB no cuenta sprites), pero es lo primero que espera
el juego. Pendiente si molesta: PNG indexado (las capas usan pocas decenas de colores) o
una página por demanda para los NPCs.

**Atlas con el arte del mapa** (2026-11-18, `feat/world-art`): sigue en 2 páginas (2048x2016
y 2048x896), 1,83 MB + 884 KB de PNG y 358 KB + 289 KB de JSON, más 176 KB de
`atlas.json`: unos 220 KB más de PNG y 80 KB más de JSON que con las criaturas. Son ~200
sprites nuevos del mapa: 16 piezas de 32x64 por muro (5 materiales), looks de suelo, frames de
agua, lava, espuma, copas y fuego, y sombras.

**Disparar y conjurar de LPC** (2026-11-18, `feat/lpc-actions`): 336 frames más de 64x64
(`shoot` y `cast` de los 4 atuendos, 7 por dirección cada uno, y el de su ataque de 4
monstruos). Sigue en 2 páginas, las dos de 2048x2016: 1,67 MB + 1,88 MB de PNG y 361 KB +
520 KB de JSON, más 240 KB de `atlas.json`. La próxima tanda de frames abre una tercera
página: ahí conviene lo pendiente de arriba (PNG indexado, o los NPCs por demanda).

**Atlas con la segunda tanda de criaturas de Gemini** (2026-11-18,
`feat/gemini-creatures-2`): sigue en 2 páginas (2048x2016 y 2048x1888; la segunda era de
2048x1344), 1,82 MB + 1,77 MB de PNG (antes 1,67 + 1,30) y 346 KB + 501 KB de JSON, más
235 KB de `atlas.json`: unos 625 KB más de PNG y 110 KB más de JSON. Son ~235 frames: los
siete monstruos que eran un tile de Dungeon Crawl (con sus espejos al este; el custodio en
96x96) y el jabalí y el ciervo de spritegen, que pasaron de 32x32 a 64x64. A la segunda
página le quedan 160 px de alto: unos 60 frames de 64x64 más y el atlas pasa a 3 páginas.

**Atlas con los humanoides del motor** (2026-11-19, lote 13, `feat/humanoid-art`; docs/17
"Humanoides del motor"). Antes, en la base del lote 12: 3 páginas (2048x2016, 2048x2048 y
2048x1056), 1,75 + 1,79 + 1,03 = 4,57 MB de PNG y 346 + 374 + 375 KB de JSON, más 300 KB de
`atlas.json` (3110 sprites; ~1730 eran frames de personajes de LPC de 64x64). Después: **2
páginas** (2048x2032 y 2048x138), 1,99 + 0,37 = 2,36 MB de PNG y 841 + 945 KB de JSON, más
498 KB de `atlas.json` (5069 sprites): lo que baja el juego pasa de 5,97 a 4,64 MB.
- El muñeco de capas son 43 capas (2 cuerpos, 6 peinados, 2 barbas, 5 piezas de cabeza, 5 de
  torso por cuerpo, 2 de piernas, 3 de pies, 4 escudos y 9 armas) de 84 frames cada una
  (quieto 2, caminar 8, atacar 4, disparar 3 y conjurar 3 en cuatro direcciones, y morir 4 al
  sur): **3612 frames**. Enteros de 64x64 serían 14,8 Mpx, 3,5 páginas; se empaquetan
  **recortados** a su caja opaca (`trim: true` en `assets/sprites.yaml`: el frame de la página
  del atlas lleva `trimmed`, `spriteSourceSize` y `sourceSize` y PixiJS lo ubica como el frame
  entero): **0,61 Mpx, 0,15 de página**. Un frame vacío (una barba vista de espaldas) es 1x1.
- Formas y no piezas: cada capa se dibuja una vez en un tono neutro y el cliente la tiñe; las
  76 piezas del catálogo que se ven son una forma y un tinte (`worn`), sin un píxel propio.
- Lo que creció es el JSON: 3612 nombres de frame más (las páginas ~1,8 MB, `atlas.json`
  +200 KB). Pendiente si molesta: nombres más cortos para los frames del muñeco, o un JSON
  sin espacios.
- **En el cliente** (`render/creature-body.ts`): una persona es un sprite por capa (hasta 9:
  cuerpo, piernas, pies, torso, pelo, barba, cabeza, escudo y arma), del mismo atlas, así que
  se agrupan en el mismo batch. Salen de un pool compartido (`LAYER_POOL`): una criatura que
  sale de la vista devuelve los suyos (`release`) y la siguiente los reusa; dibujar un frame
  solo cambia texturas, posiciones y tintes, sin crear objetos ni strings (el orden por
  dirección está precalculado y se reapila solo al girar). Las texturas de cada capa se
  indexan una vez por sprite (`render/clips.ts`, el mismo caché de antes).
- En el repo: 3612 PNG de 64x64 (~1,3 MB), que el test de spritegen compara con el motor
  (renderizar todas las capas lleva ~3,6 s; el proyecto de tests de spritegen, ~17 s).

**Bordes de suelo** (2026-11-19, lote 13, `feat/terrain-borders`, docs/06 "Bordes"): la
escalera de suelos cambió las 120 piezas de borde (84 + 36 frames de espuma) por 624: 9
bordes x 12 piezas x 4 looks y la espuma, 12 piezas x 4 looks x 4 frames, todas de 32x32. El
atlas ya tenía 3 páginas en la base (2048x2016, 2048x2048 y 2048x1056); la tercera pasa a
2048x1312: 4,59 MB de PNG en total (+239 KB) y 635 KB de JSON (+88 KB), más 220 KB de
`atlas.json` (+31 KB). El look de cada pieza se elige al armar el chunk (`lookOf`), como los
de suelo: ni cuentas ni objetos por frame; las piezas van en el contenedor de suelo de su
chunk (`flat`), así no entran en el orden de la capa de items que se reordena cuando llega un
chunk o se mueve una criatura; la espuma va en la lista plana de tiles animados
(una por casilla de orilla). En los mapas, las piezas pasaron de 6297 a 12273 (cada orilla
natural tiene las suyas, también bajo los muros). Medido contra la base en la misma
máquina: `FullMapView` en el Farol pasó de 1146 a 1487 bytes (más pilas distintas en la
paleta del área; presupuesto < 20 KB) y en la mina volcánica quedó en 858;
`TestCrowdBandwidth`, de 586 a 599 B/s por jugador en base y de 1515 a 1521 en stress,
lejos de los 4096.

**Partículas de ambiente** (2026-11-18, docs/17 A13): como mucho 100 en pantalla
(`MAX_PARTICLES`), en arreglos tipados y dibujadas por un pool fijo de 100 sprites de 1 px
hecho al crear el canvas; un frame no asigna nada (las fuentes salen de listas planas por
chunk, `MapView.forEachEmitter`). Se apagan con movimiento reducido. Las cajas de las
criaturas (click en la cabeza, siluetas) reusan sus objetos frame a frame; las siluetas
salen de un pool que solo crece hasta las que se vieron juntas. Los pasos (MOV-7) usan el
mismo pool: el ambiente deja 16 de las 100 libres para ellos (`STEP_RESERVE`), y cada paso
sobre arena, tierra o ceniza suma 6 y sobre arena mojada 8, de 220 a 460 ms de vida.

### Vista ancha (31x21, 2026-11)
La ventana de cada jugador pasó de 15x11 + 1 (17x13 = 221 casillas) a 31x21 + 1 (33x23 =
759): 3,4 veces más área, así que cada paso y cada golpe en una zona llena llega a más
clientes (`02-game-design.md`, "La vista"). Sin Docker en esa tarea, se midió en proceso
con `TestCrowdBandwidth` (`internal/session/crowd_test.go`, corre con `make test` y falla
por encima de 4 KB/s): los escenarios de `tools/bots` (base: 100 bots repartidos en las 9
zonas de Puerto, 60 s; stress: 300 en el pueblo, 30 s; ambos tras 10 s de rampa) sobre el
mundo y los datos reales, con el reloj simulado y el mismo comportamiento de los bots
(vagar 45 %, pelear 25 %, NPC 12 %, chat 10 %, nada 8 %; descansos de 1–4 s; un ping cada
2 s). Los bytes son `proto.Size` de cada `ServerBatch` (lo que escribe el gateway, sin los
2–4 B del frame). Con 15x11 da lo mismo que `make bots` (base 309 B/s contra 308; stress
785 contra 753–880), así que el modelo sirve. Mismo notebook (i7-13650HX), Windows nativo;
tiempos de `go test -bench` (mediana de 3):

| Métrica | 15x11 | 31x21 | Presupuesto |
|---|---|---|---|
| Salida por jugador, base 100 (B/s) | 309 | 490 | < 4096 |
| Salida por jugador, stress 300 (B/s) | 785 | 1676 | < 4096 |
| Tick, base 100 (`BenchmarkCrowdTick`, µs) | 87 | 98 | p99 < 10 ms |
| Tick, stress 300 (µs / asignaciones) | 912 / 1733 | 1020 / 1045 | sin crecimiento |
| `BenchmarkTickPlayersWalking` 300 (µs / asignaciones) | 140 / 1341 | 177 / 1392 | |
| `BenchmarkTickMonsters` 100 + 256 (µs / asignaciones) | 250 / 1005 | 237 / 589 | |
| `FullMapView` en el Farol, superficie (bytes / µs para armarlo) | 352 / 14 | 967 / 42 | < 20 KB |
| `FullMapView` en la mina volcánica, piso 8 (bytes / µs) | 295 / 6 | 843 / 13 | |
| Subir y bajar sin parar por la mina (B/s) | 950 | 2262 | < 4096 |

- **Optimización:** con la vista ancha un paso en una multitud va a cientos de clientes.
  `observeMove` (pasos de jugadores y monstruos) y `hitEvents` (efecto, número y barra de
  un golpe) arman cada mensaje una vez y se lo dan a todos los que lo ven: los batches
  solo se leen después del tick, y protobuf deja serializar el mismo mensaje desde varias
  goroutines. Por eso las asignaciones por tick bajaron aunque se mandan más mensajes.
- **Tick:** +12 a 15 % en los escenarios de bots, por el área 3,4 veces mayor, y muy lejos
  de los 10 ms. En stress el 70 % del tick es el A* de los rodeos (300 bots en ~300
  casillas libres), no el AOI; el tiempo medido incluye `proto.Size` de cada batch, que en
  producción corre en las goroutines de escritura. `BenchmarkTickPlayersWalking` (todos
  caminando sin pausa, el peor caso) sube más: +26 % con 300 jugadores.
- **El índice espacial no cambió:** sectores de 32x32. La ventana de 33x23 toca a lo sumo
  2x2 sectores por piso (el rectángulo de un paso, 34x24, hasta 3x2) y `eachInRect` filtra
  por casilla. Armar un `FullMapView` busca cada pila en la paleta del área en forma
  lineal: con unas pocas decenas de pilas distintas, 42 µs en el pueblo, una vez por
  teletransporte. Cada piso se arma en un búfer del `World` y solo se copia si tiene
  casillas: los 7 pisos vacíos de la superficie no asignan (5,8 KB por vista, no 27).
- **Monstruos:** lo que nota un monstruo sigue siendo la ventana clásica (`InSight`) y
  `pickTarget` recorre solo ese rectángulo: la IA no cuesta más. Los sectores activos (2
  sectores alrededor de cada jugador, 64 casillas o más) ya cubrían la ventana ancha.
- **Respawns:** el bloqueo de un respawn (`watched`) mira la ventana clásica, no la
  ancha: con la ancha, quien caza en un spawn frenaba los vecinos (a 12–20 casillas) y la
  "Eficiencia 2/3" de "Capacidad del mundo" quedaba optimista. Así la capacidad sigue
  como se midió con 15x11 (`TestRespawnWaitsOnlyForTheClassicWindow`).
- **`make bots` contra un servidor real (lote 6, 2026-11-18).** Punta del lote
  (`lote6/verify`), mismo notebook y mismo script que "Resultados del stack T5.5–T5.7":
  Windows nativo, servidor, bots y Postgres (Docker) en la misma máquina, 5 islas (146
  sectores), ventana estable de 3 min con rampa de 20 s (base) y 60 s (stress). Sin
  Grafana: los números salen del `/metrics` interno, como en las corridas anteriores.

  | Métrica | Presupuesto | Base 100 · 31x21 | Stress 300 · 31x21 | 15x11 (stack T5.5–T5.7) |
  |---|---|---|---|---|
  | Tick p50 / p95 / p99 (ms) | p99 < 10 (100 jug.) | 0,03 / 1,03 / **1,95** | 0,73 / 3,69 / **4,77** | base 1,78 · stress 3,98–5,49 (p99) |
  | Tick máx. / ticks lentos (> 50 ms) | — | ≤ 6 / 0 de 3600 | ≤ 8 / 0 de 3600 | ≤ 4 · ≤ 8 / 0 |
  | RSS máx. / al final (MB) | < 600 | 163,3 / 125,1 | 125,7 / 91,7 | 108,9 · 120–122 |
  | CPU del servidor (núcleos) | — | 0,13 | 0,32 | 0,12 · 0,26–0,27 |
  | Salida por jugador (B/s) | < 4096 | **624** | **1580** | 308 · 753–880 |
  | Latencia de comando p50 / p95 / p99 (ms) | p95 < 60 | 26,4 / **48,6** / 51,0 | 27,8 / **49,8** / 52,8 | p95 48,4 · 48,9–49,8 |
  | Desconexiones / fallos al entrar | 0 | 0 / 0 | 0 / 0 | 0 / 0 |

  Todo dentro del presupuesto. Stress da lo que predijo `TestCrowdBandwidth` (1580 contra
  1676 B/s). Base da más que el modelo (624 contra 490), y la diferencia no se investigó:
  el modelo cuenta 60 s con el reloj simulado y la corrida real, 3 min de bots reales. Es
  el doble que con 15x11 y queda en un 15 % de los 4 KB/s. El RSS máximo de base incluye la
  primera corrida sobre la base nueva, que creó las cuentas y los 100 personajes (argon2id
  en la rampa, como en "Resultados del stack T5.5–T5.7"). El tick sube poco: p99 de 1,78 a
  1,95 ms en base, y stress queda dentro del ruido de las corridas de 15x11.
- **Pendiente, el cliente:** a 1x en 1920x1080 se dibuja la ventana entera, unas 650
  casillas por capa en vez de las 165 de 15x11, más las etiquetas de una multitud. No se
  midieron FPS ni draw calls (no hay instrumentación y piden un navegador real con GPU,
  como en "Cliente" arriba): anotar FPS y draw calls a 1x y a la escala por defecto en
  1920x1080, en el pueblo con bots, contra el presupuesto (60 fps, < 50 draw calls).

### Eventos de ataque (A9, 2026-11-18)
`CreatureAttack` por cada ataque que ocurre (a quien conoce al atacante) y el motivo de
cada `CreatureDisappear` (docs/05, "Quién ataca y por qué sale una criatura"). Medido como
la vista ancha: `TestCrowdBandwidth` y `go test -bench` en proceso (sin Docker en esa
tarea), mismo notebook, Windows nativo, antes y después en la misma sesión (mediana de 3;
otra tarea del lote corría en paralelo, así que los µs tienen ruido; los bytes y las
asignaciones no):

| Métrica | Antes | Con A9 | Presupuesto |
|---|---|---|---|
| Salida por jugador, base 100 (B/s) | 490 | 532 (+8,6 %) | < 4096 |
| Salida por jugador, stress 300 (B/s) | 1676 | 1684 (+0,5 %) | < 4096 |
| Tick medio en `TestCrowdBandwidth`, base / stress (µs) | 105 / 954 | 108 / 970 | p99 < 10 ms |
| `BenchmarkCrowdTick` base (µs / asignaciones) | 98,6 / 308 | 96,7 / 310 | |
| `BenchmarkCrowdTick` stress (µs / asignaciones) | 1036 / 1005 | 1033 / 1005 | |
| `BenchmarkTickMonsters` 100 + 256 (µs / asignaciones) | 278 / 486 | 234 / 489 | |
| `BenchmarkTickMonsters` 100 + 1024 (µs / asignaciones) | 613 / 563 | 505 / 576 | |
| `BenchmarkTickPlayersWalking` 300 (µs / asignaciones) | 180 / 1152 | 160 / 1151 | |

- **Bytes:** un `CreatureAttack` pesa unos 23 B (con el campo del `oneof`) por cliente
  que lo recibe; el motivo de un `CreatureDisappear`, 2 B. Base sube más que stress porque
  ahí los bots pelean con monstruos y cada ronda (de ellos y de los monstruos) es un
  ataque más para todos los que miran; en el pueblo de stress casi no hay monstruos. Queda
  muy lejos de los 4 KB/s.
- **Tick:** el ataque se arma una vez y se comparte entre todos los que lo ven (como
  `hitEvents`); solo un cliente que ve al atacante pero no al objetivo recibe uno propio
  (el borde de su ventana). Las asignaciones suben de 2 a 13 por tick en los benchmarks con
  monstruos peleando; los tiempos quedan dentro del ruido.
- **Pendiente:** `make bots` contra un servidor real con A9 (base y stress), para
  confirmar los números de arriba como en "`make bots` contra un servidor real".

### Diario de misiones (`QuestLog`, 2026-11-19)
El `QuestLog` (docs/05 "Diario de misiones") sale entero al entrar y en el flush de cada
tick en que cambió una quest del jugador: también con cada muerte que cuenta un paso
`kill`, y lleva todas las quests empezadas o terminadas. Una entrada con todos sus campos
pesa unos 100 B (`proto.Size`, con los ids y las claves de `data/quests`). Medido el
2026-11-19 con las 20 quests de hoy (capítulos, quests secundarias y tareas de caza), un
personaje con todas empezadas, cada una en su paso más largo y un paso `kill` a una muerte
de cumplirse, recibe un `QuestLog` de **1937 B** (96 B por entrada,
`TestQuestLogSize` en `session/questlog_size_test.go`). Un jugador que caza una criatura
cada 3 s suma ≤ 0,65 KB/s, lejos de los 4 KB/s (la base de `TestCrowdBandwidth` gasta
~0,5 KB/s). Crece con el catálogo: unos 100 B por quest más.
- **Disparador:** `TestQuestLogSize` falla si ese diario pasa de **4096 B** (unas 42 quests
  empezadas a la vez; a una muerte cada 3 s, un tercio del presupuesto por jugador). Ese
  día, mandar solo la entrada que cambió (un delta) en lugar del diario entero, y medirlo
  con `TestCrowdBandwidth` con tareas activas.

### Aspecto y equipo visible (lote 13, 2026-11-19)
Cada `Creature` humanoide lleva su cuerpo (`BodyLook`, cinco ids de `data/looks.yaml`); el
de un jugador, los ids de sus slots visibles (`VisibleEquipment`), y el de un NPC o un
monstruo, sus piezas (`Worn`, forma y tinte por lugar). Un `CreatureLook` (unos 50 B) va a
quien conoce al jugador solo cuando cambian el cuerpo (`SetLook`, con el anti-flood de
`looks.yaml`) o un slot visible: nunca por paso. Medido con `TestCrowdBandwidth` (que corre
con los datos reales: los bots entran sin aspecto y reciben el de su id) y `go test
-bench`, antes (`feat/humanoid-art`) y después en la misma sesión, mismo notebook, Windows
nativo:

| Métrica | Antes | Con el aspecto | Presupuesto |
|---|---|---|---|
| Salida por jugador, base 100 (B/s) | 586 | 612 (+4,4 %) | < 4096 |
| Salida por jugador, stress 300 (B/s) | 1515 | 1629 (+7,5 %) | < 4096 |
| `BenchmarkCrowdTick` base (µs / asignaciones) | 106 / 321 | 106 / 321 | |
| `BenchmarkCrowdTick` stress (µs / asignaciones) | 846 / 949 | 879 / 947 | |

- **Sin asignaciones nuevas en el tick:** el `BodyLook` y el `VisibleEquipment` de un
  jugador se arman cuando cambian (`Player.lookMsg`, `equipMsg`) y cada `Creature` apunta a
  ellos; los de un NPC o un monstruo, una vez por definición al arrancar. Un mensaje no se
  toca después de emitido, así que compartirlos es seguro (docs/05, "Vista").
- **Cuánto pesa:** un jugador con cuerpo y seis piezas suma ~50 B a su `Creature`; un
  monstruo humanoide con cinco piezas, ~110 B. Solo al aparecer, en un `FullMapView` y en un
  `MapSlice`: en stress (300 en el pueblo, todos se ven y entran y salen de la vista) eso es
  el +7,5 %.
- **Cliente:** la figura se rearma solo cuando sube `CreatureState.lookRev` (un número; antes
  se comparaba un string de los cosméticos por criatura y por frame). La figura del
  formulario y de la ventana Apariencia es un canvas 2D de 192x192 (o 144x144) que se
  redibuja cada 110 ms solo mientras está abierta (con movimiento reducido, nunca), con un
  canvas de trabajo de 64x64 reutilizado; no carga Pixi ni un atlas nuevo (lee el mismo
  `/atlas/`, que el juego ya bajó o va a bajar).

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

**Guardado antes del transfer (falla segura, docs/01).** Un personaje que soltó algo al
suelo público desde su último snapshot escribe ese estado justo antes de su próximo
transfer: como mucho una escritura más por personaje y transfer (lo que cuesta un
autoguardado), y solo la primera vez después de soltar algo, porque cualquier snapshot
posterior la reemplaza. Queda acotada por los mismos anti-flood que los transfers: en el
peor caso duplica las escrituras de transfers de quien alterna tirar algo a la calle con
cada transfer que le permiten los tres anti-flood juntos (`market.action_*` ≈ 2,5 por
segundo, `trade.action_*` ≈ 3,3 y `houses.action_*` ≈ 3,3: ≈ 9 transfers por segundo →
≈ 18 escrituras, 9 de ellas de este guardado). Sin transfers no se escribe nada más. En
el loop, cada comando (o tick, para lo que el servidor deja caer fuera de un comando) en
que algo cae a la calle toma un snapshot en memoria al terminar, uno solo aunque caigan
muchas pilas (`BenchmarkThrowAway`, tirar una moneda y levantarla con un cofre de 40
items: ≈ 3 µs y ≈ 8 KB más por tirada, 11 asignaciones). Con el rate limit de 30
comandos por segundo son a lo sumo ≈ 0,1 ms por segundo por jugador que no hace otra cosa
que tirar items, y la memoria es un snapshot por jugador (el último), hasta su próximo
guardado. Marcar a quien soltó algo es un bool y una lista que casi siempre está vacía
(`World.givers`), que se mira al principio y al final de cada comando de un jugador y al
final de cada tick. Lo que alguien saca de una casa a la calle guarda además un puntero
por pila hasta la escritura de la casa, al final del mismo comando (`Player.left`).

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
  casillas instancias (hoy, la más grande: 38 × 3 = 114 filas de `house_items`, que se
  reescriben con `COPY` dentro de la transacción) y cada movimiento cuenta contra el
  anti-flood de casas (`houses.action_burst` 8, `action_refill_ms` 300): un jugador
  sostiene como mucho ~3 transfers por segundo moviendo cosas en su casa, del orden de un
  intercambio (≈ 4–6 ms cada uno en Postgres local). Cien jugadores ordenando sus casas a
  la vez (imposible: hay 13 casas) seguirían por debajo del techo del Saver.
- **En el tick:** el paso de un jugador mira un bit de la casilla (`FlagHouse`) y solo en
  casillas de casa busca la casa en un mapa; un cambio de casilla marca su casa sucia con
  el mismo bit. Contar los items de una casa (límite) recorre sus casillas (≤ unas
  decenas). El barrido de alquiler es una vez por segundo, de a lo sumo 32 casas, y el de
  intrusos recorre los jugadores conectados mirando un bit. Nada lee la base en el loop.
- **Arranque:** `LoadHouses` lee tres tablas chicas (dueños, invitados, items) una vez.
