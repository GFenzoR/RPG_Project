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
  un portal) y en `stepMonster`, a `OnTick`/`TakeChanges` en `flushSystem` (cada cambio a
  quien ve la casilla, `TrailWear`), a `EachInRect` en `mapArea`, y pasa el `Snapshot` a
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

<!-- glue:begin -->
- `client/src/render/living.ts`: monta el mundo vivo sobre el `MapView` (superficie de cada
  casilla, sprites de plantas, texturas del atlas) y arma los eventos de sonido del paso propio
- `client/vite/content.ts`: lee `data/livingworld/*.yaml` con `parseLivingWorldData`
- `client/src/content-types.ts`: el tipo `LivingWorldData` de `ClientContent.livingWorld`
- `server/internal/session/trailwear.go`: el desgaste de senderos en el game loop (pasos,
  tick, cambios a los clientes, `MapArea.wear`, la copia para guardar)
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

## Pendiente
- Sonidos de paso propios por superficie: sin ffmpeg no se pudieron generar; los eventos ya
  existen y caen en `step`.
- No hay día y noche: las luciérnagas esperan uno (`night()` da siempre falso).
- Plantas nuevas sin colocar en los mapas.
