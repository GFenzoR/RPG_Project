# Mundo vivo (`livingworld/`)

El entorno reacciona a quien pasa, para que el mundo se sienta vivo (pedido del dueño del
2026-11-23). Todo el **código** del mundo vivo está en esta carpeta, para auditarlo y
desarrollarlo aparte; su **contenido y sus assets** siguen en los pipelines compartidos, en
subcarpetas propias. Este archivo es la fuente única: contrato, invariantes, lista de
pegamento, dónde viven datos, assets y protocolo, cómo agregar algo y cómo probarlo.
`docs/19-mundo-vivo.md` solo apunta acá.

## Qué hay

| Parte | Dónde | Estado |
|---|---|---|
| Efectos del cliente (huellas, plantas, ondas, polvo, hojas, bichos, pasos con sonido, desgaste dibujado) | `livingworld/client/` (paquete pnpm `@rpg/living-world`, TS strict) | hecho (lote 17) |
| Lógica y estado del servidor (rompibles, empujables, desgaste de senderos) | `livingworld/server/` (módulo Go propio `github.com/GFenzoR/RPG_Project/livingworld/server`; `server/go.mod` lo pide con `replace ../livingworld/server`) | desgaste de senderos: paquete `trail` (lote 17); rompibles y empujables: su ítem del lote |
| Contenido | `data/livingworld/*.yaml` (esquemas `packages/content-schema/schemas/livingworld-<nombre>.schema.json`) y `ground.surface` de `data/items` | `surfaces.yaml`, `plants.yaml` (cliente), `wear.yaml` (servidor) |
| Objetos del mapa (rompibles, empujables, placas y compuertas) | `livingworld/server` (paquete raíz), `livingworld/client/src/objects.ts`, `data/livingworld/objects.yaml` | hecho (lote 17); ver "Objetos del mapa" |
| Items nuevos (plantas) | `data/items/plants.yaml`, ids con `make gen-ids` en `data/ids.lock.yaml` | `grass_tuft`, `tall_grass`, `wildflowers`, `reeds` |
| Sprites | `assets/livingworld/sprites/` (los arma `tools/spritegen`, `recipes/living.ts`; `tools/spritepack` los empaqueta como `livingworld/<ruta>`) | arte propio |
| Sonidos | `assets/livingworld/sounds/` (registrados en `assets/sounds.yaml` y `assets/CREDITS.md`) | pendiente: hoy los pasos usan `step` (abajo) |
| Mensajes | `proto/game/v1/livingworld.proto` (buf quiere los archivos de un paquete en su carpeta) | `TrailWear` (`ServerMessage.trail_wear` = 49 y `MapArea.wear`) |
| Persistencia | tabla `trail_wear` (migración `server/migrations/00027_trail_wear.sql`) | una fila con el desgaste codificado |

## Contrato del cliente

El cliente lo monta con una API angosta (`livingworld/client/src/index.ts`):

```ts
const lw = createLivingWorld(stage, surfaceLookup, options);
lw.onCreatureStep(step, now); // una criatura en vista empieza un paso
lw.onTick(now, view);         // cada frame: casillas en vista, piso y casilla propia
lw.applyWear(tiles);          // desgaste de senderos que manda el servidor
lw.footstepEvents(to);        // eventos de sonido del paso propio
lw.destroy();
```

- `stage`: dos contenedores en espacio de mundo (1 unidad = 1 px de sprite). `ground` va
  sobre los suelos y sus bordes y bajo sombras, items y criaturas (`MapView.groundOverlay`);
  `air` va sobre el mapa (`MapView.overlay`).
- `surfaceLookup(x, y, z)`: la superficie de la casilla (`ground.surface` de su suelo).
- `options`: `tileSize`, `data` (de `data/livingworld/`), `texture(nombre)` (el atlas),
  `plants` (`version()` y `forEach` sobre los sprites de items del piso: `MapView.version` y
  `MapView.forEachItemSprite`), `reduced()` y `night()`.
- `CreatureStep`: `id`, `from`, `to`, `durationMs` y `print` (`feet` humanoide, `paw` bestia,
  `big_paw` bestia grande, `none` voladora).

### Qué hace
- **Huellas** (`footprints.ts`): al dejar una casilla de `sand`, `wet_sand`, `snow`, `mud` o
  `ash`, una marca orientada hacia donde camina (pies alternados a cada lado de la línea;
  patas sobre ella). Se gasta 1 ms por ms; con viento (`wind`, en la arena) se gasta más en
  ráfagas que salen de la posición y la hora (`gust`, sin `Math.random`). Se desvanece en la
  segunda mitad de su vida. Tope `MAX_FOOTPRINTS` (64): una nueva reemplaza a la más gastada.
- **Plantas** (`sway.ts`): un paso dobla la planta de la casilla y, a la mitad, las 8
  vecinas, hacia donde camina (de frente o de espaldas, las de los lados hacia afuera): un
  resorte amortiguado de `SWAY_MS` (900 ms). `bend` es un skew del sprite (sin shaders);
  `rustle` (árboles) un corrimiento de 1 px. Las `idle` se mecen solas con el viento. Tope
  `MAX_SWAYS` (48) plantas moviéndose por pasos.
- **Ondas y polvo** (`puffs.ts`): anillos que se abren al pisar agua (`ripple`) y una nube
  de polvo al correr (`dust`, paso de `RUN_STEP_MS` = 260 ms o menos). Tope `MAX_PUFFS` (24).
  Las motas de MOV-7 de cada paso (`client/src/render/particles.ts`) siguen como estaban.
- **Hojas** (`leaves.ts`): caen de los árboles con `leaves` en vista (`LEAF_RATE` por árbol y
  segundo) y al rozarlos; caen balanceándose, quedan en el suelo y se desvanecen. Tope
  `MAX_LEAVES` (24).
- **Bichos** (`critters.ts`): pájaros y mariposas de día que huyen cuando el jugador se
  acerca a `FLEE_TILES` (2,5) y no vuelven a ese lugar por `RETURN_MS` (20 s); luciérnagas de
  noche; sombras de peces en el agua. Dónde viven sale del hash de la casilla y de los
  `critters` de su superficie; se buscan cada `SCAN_MS` (1 s), no cada frame. Tope
  `MAX_CRITTERS` (10).
- **Pasos con sonido** (`footsteps.ts`): el paso propio pide `step.self.<sound>` y después
  `step.self`; suena el primero que `assets/sounds.yaml` mapea.
- **Desgaste de senderos** (`wear.ts`): el nivel (1 a 3) de cada casilla que el servidor
  marcó, por `applyWear(tiles, replace)`. Cada casilla gastada lleva el sprite
  `livingworld/fx/trail_<nivel>_<vecinas>` (vecinas gastadas: N 1, E 2, S 4, O 8;
  `wearSprite`), así un sendero se une y sus lados abiertos se deshacen sobre el pasto; las
  plantas con `trample` de una casilla gastada se dibujan aplastadas (`TRAMPLE_SCALE`). Es
  estado del servidor: su capa propia (`living world: trail wear`, bajo los efectos) se
  sigue dibujando con "Animaciones reducidas". El cliente nunca lo inventa. Tope
  `MAX_WEAR_DRAWN` (256) en vista; la lista se rearma solo cuando cambia el desgaste o las
  casillas de la vista. Sin el sprite en el atlas, un cuadrado del color de la tierra.

## Contrato del servidor (`livingworld/server`)

Módulo Go propio. El game loop lo llama por una interfaz chica y le da lo que necesita del
mapa como datos simples; persistencia y red son del servidor (el pegamento).

**Desgaste de senderos** (`livingworld/server/trail`, pedido del dueño del 2026-11-23: "si
muchos jugadores caminan sobre el pasto, empieza a verse la tierra; cuando dejan de pasar,
se recupera"; reglas en docs/02 "Senderos"):

```go
m := trail.New(cfg, tickMs)          // cfg: data/livingworld/wear.yaml (trail.LoadConfig)
m.Restore(data, downtimeMs)          // lo guardado y la recuperación del tiempo apagado
m.OnStep(pos, surface, trail.WalkerPlayer) // un paso (WalkerMonster pesa monster_step)
save := m.OnTick(tick)               // recuperación; true: toca guardar
changes = m.TakeChanges(changes[:0]) // casillas cuyo nivel cambió (0..3)
m.EachInRect(x0, y0, x1, y1, z, fn)  // lo gastado de un área (MapArea.wear)
s := m.Snapshot()                    // copia, en el loop; s.Encode() fuera de él
```

- Disperso por chunk de 32x32 (2 KiB por chunk con algo de desgaste); un entero por
  casilla, cuantizado a niveles con `levels`. Los cambios solo se reportan cuando cambia
  el nivel (es lo que viaja a los clientes).
- El pegamento (`server/internal/session/trailwear.go`) da la superficie de cada suelo
  (`ground.surface` de `data/items`), llama a `OnStep` en `move` (pasos propios, no los de
  un portal ni los de un jugador invisible) y en `stepMonster`, a `OnTick`/`TakeChanges` en `flushSystem` (cada cambio a
  quien ve la casilla, `TrailWear`), a `EachInRect` en `mapArea` (solo el piso del jugador:
  los cambios llegan a quien está en el piso de la casilla), y pasa el `Snapshot` a
  `Config.SaveTrail`. `server/internal/app/trailwear.go` lo escribe (`trail_wear`) desde
  su goroutine y lo lee al arrancar (`TrailStore`); sin Postgres (los fakes) vive solo en
  memoria.
- El mapa de autor nunca cambia: el desgaste es una capa encima. Un camino de tierra ya
  dibujado no se gasta (la superficie `dirt` no está en `surfaces`).

## Invariantes
1. **El cliente es cosmético.** Nada de `livingworld/client` cambia reglas ni manda nada al
   servidor; el servidor no lee `surfaces.yaml` ni `plants.yaml`. Lo que es estado
   compartido (el desgaste) lo decide `livingworld/server` y el cliente solo lo dibuja.
2. **El servidor, en el loop.** Todo `livingworld/server` corre en la goroutine del game
   loop: sin locks, sin `time.Now()` (el tiempo es el número de tick), sin I/O. La
   persistencia y la red son interfaces o funciones que da `server/`.
3. **Determinista.** Ráfagas, hogares de bichos y lados de las plantas salen de la casilla y
   del reloj; las hojas de un generador con semilla. Nunca `Math.random` ni `Date.now`.
4. **Barato** (docs/07 "Mundo vivo"): pools de sprites hechos una vez, cada efecto con tope,
   un frame no crea objetos para el dibujo, y la lista de plantas se rearma solo cuando cambia
   `MapView.version`.
5. **Efectos reducidos.** Con "Animaciones reducidas" (Opciones) o `prefers-reduced-motion`
   no se crea, dibuja ni mueve ningún efecto, y las plantas vuelven a su lugar (el desgaste,
   que es estado y no animación, se sigue viendo).
6. **Frontera.** `livingworld/` nunca importa de `server/` ni de `client/`; fuera de
   `livingworld/` solo lo importan los archivos de la lista de pegamento (abajo). Lo revisa
   `make lint` (`livingworld/client/scripts/boundary.ts`).
7. Textos visibles por i18n (los nombres de las plantas están en `i18n/*/items.yaml`).

## Lista de pegamento
Los únicos archivos fuera de `livingworld/` que pueden importarlo:

<!-- glue:begin --><!-- glue:start -->
- `client/src/render/living.ts`: monta el mundo vivo sobre el `MapView` (superficie de cada
  casilla, sprites de plantas, texturas del atlas) y arma los eventos de sonido del paso propio
- `client/vite/content.ts`: lee `data/livingworld/*.yaml` con `parseLivingWorldData`
- `client/src/content-types.ts`: el tipo `LivingWorldData` de `ClientContent.livingWorld`
- `server/internal/session/trailwear.go`: el desgaste de senderos en el game loop (pasos,
  tick, cambios a los clientes, `MapArea.wear`, la copia para guardar)
- `server/internal/session/livingworld.go`: los objetos del mapa: el `Host`, los comandos y
  los ganchos del loop
<!-- glue:end -->

Lo usan a través de `client/src/render/living.ts`: `client/src/render/game-canvas.ts`
(monta, pasa pasos y frames) y `client/src/game.ts` (sonido del paso, por
`CueContext.stepEvents` de `client/src/audio/cues.ts`). El renderer compartido
(`packages/renderer`) suma `MapView.groundOverlay`, `MapView.version` y
`MapView.forEachItemSprite`, sin saber del mundo vivo. El desgaste que manda el servidor
lo guarda `client/src/state/trail-wear.ts` (sin importar el módulo) y `game-canvas.ts` se lo
pasa a `applyWear` cuando cambia.

En el servidor, `server/internal/session/trailwear.go` exporta los alias `TrailConfig` y
`TrailSnapshot` y `LoadTrailWear`: `app` y `cmd/gameserver` usan esos nombres y no
importan el módulo.

Además, sin importar el módulo: `server/go.mod` lo requiere con
`replace ../livingworld/server` (y `tools/bots/go.mod` repite el `replace`, porque un
`replace` de una dependencia no se hereda); `client/package.json` depende de
`@rpg/living-world`; `pnpm-workspace.yaml` y `vitest.config.ts` lo listan; el Dockerfile
del servidor copia `livingworld/server/`; la CI tiene el job `go (livingworld/server)` y
`govulncheck`; `deploy/tests/check-go-version.sh` mira su `go.mod` (misma versión de Go que
los demás módulos).

## Datos

`data/items/ground.yaml`: cada suelo dice de qué está hecho, `ground: { …, surface: sand }`
(enum `surface` de `common.schema.json`: `sand`, `wet_sand`, `snow`, `mud`, `grass`,
`tall_grass`, `dirt`, `ash`, `stone`, `wood`, `water_shallow`, `lava`).

`data/livingworld/surfaces.yaml` (por superficie): `footprints` (ms), `wind`, `dust`,
`ripple`, `tint` (`#rrggbb`), `sound`, `critters`. `make validate` exige que toda superficie
que usa un suelo esté descrita.

`data/livingworld/plants.yaml` (lista): `item` (de `data/items`), `reaction` (`bend` |
`rustle`), `idle`, `leaves`, `trample` (aplastada sobre una casilla gastada). Cada item una
sola vez.

`data/livingworld/wear.yaml` (lo lee el **servidor**, `trail.LoadConfig`; `KnownFields`:
una clave desconocida no arranca): `surfaces`, `player_step`, `monster_step`, `max`,
`levels` (los puntos de los niveles 1, 2 y 3), `decay_every_ms`, `decay`, `save_every_ms`.
Hoy: un paso de jugador 4, los monstruos 0, tope 2400, niveles 400/1000/1800, 2 puntos por
minuto de recuperación (20 h desde el tope), guardado cada 5 min.

Cada archivo `data/livingworld/<nombre>.yaml` se valida con
`livingworld-<nombre>.schema.json`; uno sin esquema es un error. El editor de mapas muestra
la superficie de un suelo y la reacción de una planta en la paleta.

## Cómo agregar
- **Una superficie que deja huellas** (p. ej. nieve en una isla nueva): el suelo con
  `surface: snow` en `data/items`; su fila en `surfaces.yaml` (`footprints`, `tint`, `sound`).
  Sin código.
- **Una planta que se mueve:** el item en `data/items/plants.yaml` (o el que ya exista),
  `make gen-ids`, sus nombres en `i18n/{es,en}/items.yaml`, su receta en
  `tools/spritegen/src/recipes/living.ts` (`livingworld/plants/<id>`), `make spritegen
  ONLY=livingworld/` y `make sprites`; su fila en `plants.yaml`.
- **Un sonido de paso:** el archivo en `assets/livingworld/sounds/`, su fila en
  `assets/CREDITS.md` (o una receta de soundgen), el sonido en `sounds:` de
  `assets/sounds.yaml` y el evento `step.self.<sound>: <id>` en `events:`.
- **Una reacción nueva:** su simulación pura en `livingworld/client/src/<efecto>.ts` (con
  tope y sin `Math.random`), sus tests, su pool y su dibujo en `index.ts`, sus campos en
  `data.ts` y en el esquema; si necesita un dato del cliente, se pide por
  `LivingWorldOptions` y lo da `client/src/render/living.ts`.
- **Una superficie que se gasta en senderos** (p. ej. `snow`): sumarla a `surfaces` de
  `wear.yaml`. Si su sendero debe verse distinto que el del pasto, una receta propia como
  `recipes/trail.ts` y elegir la textura por superficie en `wear.ts`.
- **Otra reacción del servidor** (algo que el mundo recuerda y todos ven): un paquete
  nuevo en `livingworld/server/<nombre>` con su estado, sus tests y una API como la de
  `trail` (pasos o eventos, tick, cambios, copia para guardar); su archivo de pegamento en
  `server/internal/session/` (en la lista de arriba), sus mensajes en
  `proto/game/v1/livingworld.proto` y, si se guarda, su migración y su `app/<nombre>.go`.
- **Un sprite de efecto:** la receta `livingworld/fx/<nombre>` (`kind: effect`, máscara
  blanca: el cliente la tiñe) en `recipes/living.ts`.

## Cómo probar
- `make test-livingworld`: tests Go de `livingworld/server` (el desgaste: sube con los
  pasos, tope, recuperación con el tick, niveles, cambios solo al cambiar de nivel, ida y
  vuelta de la copia, bytes rotos, el ritmo de `wear.yaml`) y vitest de `livingworld/client`
  (simulaciones puras, la forma de cada casilla gastada, el montaje sobre contenedores de
  Pixi, la frontera).
- Del servidor, fuera de la carpeta: `server/internal/session/trailwear_test.go`
  (simulación del loop: pasos de jugadores sobre pasto y no sobre el camino, el aviso a
  quien ve, el área al entrar, la recuperación, la copia al guardar y un reinicio),
  `server/internal/app/trailwear_test.go` (el escritor y la carga) y
  `server/internal/store/trailwear_integration_test.go` (la fila, con Postgres).
- Del cliente: `client/src/state/trail-wear.test.ts` (deltas, áreas, poda).
- `make lint` corre la frontera; `make validate` los YAML.
- Fuera de la carpeta: `client/vite/content.test.ts` (superficies y datos al cliente),
  `client/src/audio/cues.test.ts` (sonido del paso), `packages/renderer/src/map-view.test.ts`
  (`groundOverlay`, `forEachItemSprite`), `packages/content-schema/src/validate.test.ts`,
  `tools/spritepack` y `tools/spritegen` (sprites en `assets/livingworld/sprites/`).
- A ojo: `node --experimental-strip-types tools/spritegen/src/cli.ts preview --only
  livingworld/ --scale 6 --out shot.png` y `make play` (arena de Thimblewick; un sendero
  se ve caminando ida y vuelta muchas veces por el pasto, o con `levels` bajos en local).

## Objetos del mapa (rompibles, empujables, compuertas)

El mapa reacciona: cajas, barriles y vasijas que se rompen, enredaderas y matorrales que se
cortan, rocas agrietadas que se parten con pico, barricadas podridas y telarañas, rocas y
cajones pesados que se empujan, y placas de presión que abren un rastrillo. **Los muros
nunca se rompen**: lo que se rompe o se mueve son objetos puestos para eso (pedido del dueño,
2026-11-23).

```
livingworld/
  server/            módulo Go github.com/GFenzoR/RPG_Project/livingworld/server (go.mod propio)
    defs.go          lectura y chequeo de data/livingworld (Resolve)
    world.go         World: estado, Place/Link, ItemAt, OnStep, OnTick, Snapshot; la interfaz Host
    breakable.go     OnAttackObject, restos, desvanecido, reaparición, botín
    push.go          Push, vuelta a casa de lo empujado, placas y compuertas
    world_test.go    simulación determinista con un Host falso
  client/            paquete pnpm @rpg/living-world (TS strict)
    src/index.ts     createLivingWorld(stage, surfaceLookup, options)
    src/effects.ts   partículas y fantasmas como números (sin PixiJS)
  check-boundary.sh  el chequeo de frontera de `make lint` (y su test)
  CLAUDE.md          guía corta para agentes
```

### Servidor (objetos, `livingworld/server` paquete raíz)

El game loop llama al módulo **solo** desde el pegamento (`server/internal/session/livingworld.go`):

| Llamada | Cuándo |
|---|---|
| `Resolve(defs, items, sounds, tps)` → `Catalog` | al arrancar: chequea `data/livingworld` contra los items |
| `New(cat, host)`, `Place(pos, item)`, `Link()` | al arrancar: el pegamento recorre las pilas del mapa; cada objeto sale de la pila del mapa (`world.Map.TakeItem`) y lo dibuja el módulo; las placas quedan en el mapa |
| `ItemAt(pos)` | al armar una casilla para el cliente (`mapArea`, `tileChanged`, `staticCount`/`staticAt`): el objeto es un item más, encima de los del mapa y debajo de los sueltos |
| `OnAttackObject(pos, Hit, rand)` | un golpe ya validado (alcance, línea de visión, ritmo) |
| `Push(pos, dx, dy)` | un `PushObject` ya validado (al lado, en línea recta) |
| `OnStep(from, to)` | cada paso de una criatura (`observeMove`): placas al instante |
| `OnTick(tick)` | cada tick (`combatSystem`): los temporizadores vencidos (restos que se desvanecen, reapariciones, vuelta a casa), de una cola ordenada por tick; después las placas (un `Occupied` por placa: una criatura también deja o pisa una placa por teleport, muerte, login o logout, que el módulo no oye) |
| `Gates()` | al arrancar (`checkEscapes`): las casillas de las compuertas |
| `Snapshot()` | tests y herramientas de staff (`World.LivingObjects`) |

El módulo pide lo demás a un `Host` que implementa el pegamento:

| `Host` | Qué hace el servidor |
|---|---|
| `Free(pos)` | casilla caminable (mapa y objetos), sin criatura, sin items sueltos, sin zona de protección, casa, entrada de portal ni puerta (ni abierta: se cerraría sobre el objeto, y en el umbral de una puerta con llave podría encerrar una sala) |
| `Occupied(pos)` | hay una criatura (jugador, monstruo o NPC) |
| `SetBlock(pos, move, sight)` | combina lo que bloquea el objeto con lo que bloquean los items del mapa (`world.Map.SetBlockFlags`): A*, monstruos, línea de visión y el cliente lo ven igual |
| `TileChanged(pos)` | manda el `TileUpdate` a quien ve la casilla |
| `Event(e)` | manda `LivingObjectEvent` a quien ve la casilla |
| `DropLoot(pos, actor, objeto, drops)` | crea el botín en la casilla con las reglas de siempre (`w.created`, pilas) y lo registra en la economía como botín de `actor` (`econLoot`) |

### Cliente (objetos)

El cliente monta los efectos de los objetos (aparte de `createLivingWorld`) desde `client/src/render/living.ts`:

```ts
const objs = createLivingObjects(stage, surfaceLookup, options); // src/objects.ts
objs.onObjectEvent(evento, ahora); // cada LivingObjectEvent (WorldState.takeLiving)
objs.onStep(desde, hasta, ahora);  // un paso empieza (los restos crujen)
objs.onTick(ahora, piso);          // cada frame
```

`stage` es el overlay del mapa (espacio de mundo, `tileSize` px por casilla); `surfaceLookup`
dice la elevación de una casilla y si tiene restos; `options` da las texturas por item, el
sonido (`AudioEngine.playId`) y el movimiento reducido (sin partículas). El objeto en sí lo
dibuja el renderer como cualquier item de la casilla: el módulo solo dibuja los efectos
(astillas de un golpe, la explosión de una rotura, el deslizamiento de un empuje, el
desvanecido de los restos) y pide los sonidos. Un paso con una tecla contra un objeto
empujable manda `PushObject` (`Game.pushAhead`, `WorldState.pushableAhead`).

### Invariantes de los objetos

1. **El servidor decide todo.** El cliente manda intenciones (`UseItem` sobre el objeto,
   `UseItemOn` con una herramienta, un hechizo, `PushObject`); el servidor valida alcance,
   línea de visión, ritmo (`nextGather` de los oficios, `nextPush`) y forma.
2. **Un solo dueño.** Todo corre en la goroutine del loop: sin locks, sin I/O, sin
   `time.Now()` (el tiempo es el número de tick), aleatoriedad solo con el `Rand` del loop.
3. **Muros, puertas, suelos y casas nunca.** `Resolve` y `make validate` rechazan un muro,
   una puerta o un suelo en `data/livingworld`; el validador de mapas rechaza un objeto en
   una zona de protección, una casa, la casilla de una puerta o un muro, la entrada de un
   portal, sobre suelo no caminable o dos objetos en una casilla (el servidor deja esos
   como items comunes del mapa). Tampoco en la pared de una sala con llave: un objeto (o
   un grupo de objetos pegados) con una sala de un lado y otra sala o el exterior del otro
   dejaría entrar sin llave al romperse, empujarse o abrirse; el servidor no arranca
   (`checkLivingRooms`, `errObjectInRoomWall`) y `make validate` lo marca (`doorRooms`,
   error `object`). Uno del todo dentro de una sala, o del todo afuera, sí vale.
4. **Nada se duplica.** El botín se tira una vez por rotura (golpear los restos no hace
   nada) y se crea en el suelo como el de un monstruo: un item, un lugar. Lo que se levanta
   sigue el camino normal de inventario y guardado.
5. **Nada aparece encima de algo.** Un objeto roto reaparece, y uno empujado vuelve a su
   lugar, solo cuando la casilla está libre (`Free`): sin criatura y sin items sueltos;
   si no, reintenta cada segundo. Un empuje solo entra a una casilla libre y sin otro
   objeto (tampoco uno roto que va a reaparecer ahí), que no sea la casilla de llegada de
   un portal (escalera, escala, teleport). Una compuerta no se cierra sobre nadie.
   Consecuencia aceptada: un item suelto que no es un cadáver (no se pudre) en la casilla
   de un objeto roto, en el lugar de una roca o debajo de una compuerta abierta lo frena
   hasta que alguien lo levanta: el objeto no reaparece, la roca no vuelve y la compuerta
   no se cierra. Levantar el item lo destraba.
6. **Una compuerta no encierra a nadie.** Se cierra sola cuando las rocas vuelven a casa,
   cuando otro jugador saca una de su placa o tras un reinicio, así que cada lado de una
   compuerta cerrada llega a un templo sin pasar por ella (a pie, saliendo de salas, por
   escaleras, escalas, agujeros y teleports): el servidor no arranca si no
   (`checkEscapes`, `errGateNoEscape`) y `make validate` lo marca (`doorRooms`, error
   `gate`). La bóveda del rastrillo de Thimblewick tiene un teleport de salida.
7. **Estado transitorio.** Roto, empujado y abierto no se guardan: un reinicio deja todo
   como está en el mapa. Es más simple, no puede romper un guardado y los puzzles vuelven a
   empezar solos (`reset_seconds`, obligatorio y mayor que 0: una roca que no vuelve nunca
   podría tapar un pasillo hasta el reinicio).
8. **Un objeto por casilla**, siempre arriba de los items del mapa (el índice de pila que
   usa el cliente es `1 + len(pila del mapa)`).

### Dónde vive cada cosa (objetos)

| Qué | Dónde |
|---|---|
| Items (intacto, roto, compuerta abierta, placa) | `data/items/livingworld.yaml`, ids con `make gen-ids` (`data/ids.lock.yaml`) |
| Comportamiento | `data/livingworld/*.yaml`, esquema `packages/content-schema/schemas/livingworld-objects.schema.json` |
| Nombres y descripciones | `i18n/<idioma>/items.yaml` (`item.<id>.*`); mensajes `living.*` en `client.yaml`; paleta `editor.living_*` en `editor.yaml` |
| Sprites | `assets/sprites/livingworld/` (el pipeline de sprites lee solo `assets/sprites/`), dibujados por `tools/spritegen/src/engine/specs/livingworld.ts` |
| Sonidos | ids de `assets/sounds.yaml` (los de siempre: `hit`, `woodcutting`, `mining`...); uno nuevo iría en `assets/sounds/livingworld/` con su fila en `assets/CREDITS.md` |
| Mensajes | `proto/game/v1/livingworld.proto` (paquete `game.v1`: buf exige el archivo en el directorio de su paquete) |
| Mapa | objetos colocados como items comunes en los chunks (`world/`) |

El arte es propio (motor de sprites); no hay assets de terceros nuevos.

### `data/livingworld/objects.yaml`

```yaml
- item: weathered_crate          # un item de data/items
  breakable:
    hp: 24
    by: [melee, any_attack, fire]   # melee | any_attack | tool:axe | tool:pick | fire
    becomes: weathered_crate_debris # restos caminables, o none
    debris_seconds: 20              # los restos se desvanecen (≤ respawn_seconds)
    respawn_seconds: 240            # vuelve a estar, si la casilla está libre
    loot: [{ item: gold_coin, chance: 0.6, count: [2, 9] }]
    effect: wood                    # wood | stone | plant | web | clay (partículas)
    sound: woodcutting              # al romperse; hit_sound al golpearlo
- item: mossy_boulder
  pushable: { reset_seconds: 180, effect: stone, sound: spell_earth }
- item: portcullis_closed
  gate: { open: portcullis_open, sound: smithing }
- item: pressure_plate
  plate: { radius: 6 }              # se enlaza con las compuertas a ≤ 6 casillas
```

Cómo pega cada forma (reglas del juego, no datos del objeto; `livingworld.go`):

| `by` | Qué cuenta | Daño |
|---|---|---|
| `melee` | `UseItem` sobre el objeto desde al lado, con el arma de la mano derecha o a mano limpia | ataque del arma (`balance.living.fist_damage` a mano limpia) |
| `any_attack` | lo anterior, o un arma a distancia (gasta una munición) o una varita dentro de su rango y con línea de visión | ataque del arma |
| `tool:axe` | un hacha: herramienta de `woodcutting` usada sobre él, o un arma de tipo `axe` | `balance.living.tool_damage` la herramienta; el arma, su ataque |
| `tool:pick` | una herramienta de `mining` usada sobre él | `balance.living.tool_damage` |
| `fire` | un hechizo o runa de área de fuego que cubre su casilla (con línea de visión), o una varita de fuego | daño del hechizo, o ataque de la varita |

Una placa la presiona una criatura o un objeto empujable encima. Una compuerta se abre
mientras **todas** sus placas están presionadas y se cierra cuando una deja de estarlo (si no
hay nadie en ella). Un empuje es recto (norte, este, sur u oeste), desde la casilla de al
lado; el jugador no se mueve.

Para la alcanzabilidad del validador de mapas (qué se alcanza desde el templo, áreas a las
que nadie llega: `isPassableBreaking`), un objeto que cualquiera rompe sin herramienta
(`melee`, `any_attack` o `fire`) es paso, como una puerta; uno que pide pico o hacha, un
empujable y una compuerta, no: nunca se pone uno de esos como único camino de una quest.
Las salas detrás de puertas con llave, su chequeo de escape y las llegadas, en cambio, son
los recorridos del servidor y los repite el validador paso a paso (`isPassable`): ahí todo
objeto que bloquea, aun el que cualquiera rompe, es un muro (caso compartido en
`packages/map-format/src/testdata/door-rooms.json`).

Los números que no son de un objeto están en `data/balance.yaml`, bloque `living`:
`fist_damage` (golpe a mano limpia, 5), `tool_damage` (un uso de hacha o pico, 10) y
`push_cooldown_ms` (entre dos empujes de un jugador, 400). Un arma a distancia gasta una
munición de su tipo por golpe, como en una pelea (sin munición no golpea); una varita no
gasta nada, como en una pelea.

Las áreas del servidor (`initAreas`, que usa la búsqueda de lugar libre de un login) se
calculan al arrancar con cada objeto entero: la casilla de un objeto es un muro para ellas.
Quien se desconecta parado sobre los restos de un objeto que ya reapareció cuando vuelve
cae en el templo (no hay lugar del área desde esa casilla). Es raro y no encierra a nadie.

### Cómo agregar un objeto

1. Sus items en `data/items/livingworld.yaml` (el intacto bloquea; los restos o la compuerta
   abierta no), `make gen-ids`, textos en `i18n/es` e `i18n/en`.
2. Su entrada en `data/livingworld/objects.yaml`.
3. Sprites: un spec en `tools/spritegen/src/engine/specs/livingworld.ts` (en `LIVING_WORLD`),
   `make spritegen ONLY=livingworld/` y `make sprites STRICT=1`; revisar el preview con Read.
4. Colocarlo con `mapcli`/MCP (`place_item`), `mapcli validate`, `mapcli render` y mirar.
5. `make validate test`.

### Cómo agregar una reacción nueva de los objetos

Una forma nueva de romper (`by`), un comportamiento nuevo o un evento nuevo:

1. El módulo: la constante y la regla en `server/` (con su test en `world_test.go`), el
   esquema `livingworld-objects.schema.json` y `checkLivingWorld` de `packages/content-schema`.
2. Si el loop tiene que avisar algo nuevo, un método más en `World` y su llamada en el
   pegamento; si el módulo necesita algo del mundo, un método más en `Host`.
3. Un evento nuevo: su valor en `LivingObjectKind` (`livingworld.proto`, `make gen-proto`),
   en `EventKind` (mismo orden) y en `KINDS` de `client/src/render/living.ts`; su efecto
   en `livingworld/client/src/objects.ts`.
4. Los docs: este README y el resumen de `docs/02`.

### Cómo probar los objetos

```
make test-livingworld      # go test del módulo, vitest de @rpg/living-world y el test del chequeo de frontera
make lint                  # incluye lint-livingworld (la frontera) y golangci-lint del módulo
cd server && go test ./internal/session -run 'Living'   # el pegamento con el loop real
```

- `livingworld/server/world_test.go`: golpe con la forma correcta e incorrecta, restos que
  se desvanecen, reaparición bloqueada por un ocupante, botín una sola vez, empuje contra un
  muro, una criatura o items, dos empujes de la misma roca en un tick, vuelta a casa,
  placas y compuerta, datos inválidos.
- `server/internal/session/livingworld_test.go`: lo mismo por el protocolo, con la economía
  reconciliada cada tick; `TestSandboxLivingWorld` en el mapa real de Thimblewick.
- `client/src/state/living.test.ts`, `client/src/render/living.test.ts` y
  `livingworld/client/src/objects.test.ts`: eventos, empuje y efectos.
- A mano: `docs/16-probar-el-juego.md`, "Mundo vivo".

## Pendiente
- Sonidos de paso propios por superficie: sin ffmpeg no se pudieron generar; los eventos ya
  existen y caen en `step`.
- No hay día y noche: las luciérnagas esperan uno (`night()` da siempre falso).
- Plantas nuevas sin colocar en los mapas.
