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
| Lógica y estado del servidor (rompibles, empujables, desgaste de senderos) | `livingworld/server/` (módulo Go propio `github.com/GFenzoR/RPG_Project/livingworld/server`) | lo arma otro ítem del lote 17 |
| Contenido | `data/livingworld/*.yaml` (esquemas `packages/content-schema/schemas/livingworld-<nombre>.schema.json`) y `ground.surface` de `data/items` | `surfaces.yaml`, `plants.yaml` |
| Items nuevos (plantas) | `data/items/plants.yaml`, ids con `make gen-ids` en `data/ids.lock.yaml` | `grass_tuft`, `tall_grass`, `wildflowers`, `reeds` |
| Sprites | `assets/livingworld/sprites/` (los arma `tools/spritegen`, `recipes/living.ts`; `tools/spritepack` los empaqueta como `livingworld/<ruta>`) | arte propio |
| Sonidos | `assets/livingworld/sounds/` (registrados en `assets/sounds.yaml` y `assets/CREDITS.md`) | pendiente: hoy los pasos usan `step` (abajo) |
| Mensajes | `proto/livingworld.proto` | lo arma el ítem del servidor; el cliente no lo necesita |

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
- **Desgaste** (`wear.ts`): parches más oscuros en las casillas que `applyWear` marca (0 a
  1). El cliente nunca lo inventa. Tope `MAX_WEAR_DRAWN` (128) en vista.

## Invariantes
1. **Cosmético y del cliente.** Nada de `livingworld/client` cambia reglas ni manda nada al
   servidor; el servidor no lee `surfaces.yaml` ni `plants.yaml`.
2. **Determinista.** Ráfagas, hogares de bichos y lados de las plantas salen de la casilla y
   del reloj; las hojas de un generador con semilla. Nunca `Math.random` ni `Date.now`.
3. **Barato** (docs/07 "Mundo vivo"): pools de sprites hechos una vez, cada efecto con tope,
   un frame no crea objetos para el dibujo, y la lista de plantas se rearma solo cuando cambia
   `MapView.version`.
4. **Efectos reducidos.** Con "Animaciones reducidas" (Opciones) o `prefers-reduced-motion`
   no se crea, dibuja ni mueve nada, y las plantas vuelven a su lugar.
5. **Frontera.** `livingworld/` nunca importa de `server/` ni de `client/`; fuera de
   `livingworld/` solo lo importan los archivos de la lista de pegamento (abajo). Lo revisa
   `make lint` (`livingworld/client/scripts/boundary.ts`).
6. Textos visibles por i18n (los nombres de las plantas están en `i18n/*/items.yaml`).

## Lista de pegamento
Los únicos archivos fuera de `livingworld/` que pueden importarlo:

<!-- glue:begin -->
- `client/src/render/living.ts`: monta el mundo vivo sobre el `MapView` (superficie de cada
  casilla, sprites de plantas, texturas del atlas) y arma los eventos de sonido del paso propio
- `client/vite/content.ts`: lee `data/livingworld/*.yaml` con `parseLivingWorldData`
- `client/src/content-types.ts`: el tipo `LivingWorldData` de `ClientContent.livingWorld`
<!-- glue:end -->

Lo usan a través de `client/src/render/living.ts`: `client/src/render/game-canvas.ts`
(monta, pasa pasos y frames) y `client/src/game.ts` (sonido del paso, por
`CueContext.stepEvents` de `client/src/audio/cues.ts`). El renderer compartido
(`packages/renderer`) suma `MapView.groundOverlay`, `MapView.version` y
`MapView.forEachItemSprite`, sin saber del mundo vivo.

## Datos

`data/items/ground.yaml`: cada suelo dice de qué está hecho, `ground: { …, surface: sand }`
(enum `surface` de `common.schema.json`: `sand`, `wet_sand`, `snow`, `mud`, `grass`,
`tall_grass`, `dirt`, `ash`, `stone`, `wood`, `water_shallow`, `lava`).

`data/livingworld/surfaces.yaml` (por superficie): `footprints` (ms), `wind`, `dust`,
`ripple`, `tint` (`#rrggbb`), `sound`, `critters`. `make validate` exige que toda superficie
que usa un suelo esté descrita.

`data/livingworld/plants.yaml` (lista): `item` (de `data/items`), `reaction` (`bend` |
`rustle`), `idle`, `leaves`. Cada item una sola vez.

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
- **Un sprite de efecto:** la receta `livingworld/fx/<nombre>` (`kind: effect`, máscara
  blanca: el cliente la tiñe) en `recipes/living.ts`.

## Cómo probar
- `make test-livingworld`: tests Go de `livingworld/server` (si existe) y vitest de
  `livingworld/client` (simulaciones puras, el montaje sobre contenedores de Pixi, la
  frontera).
- `make lint` corre la frontera; `make validate` los YAML.
- Fuera de la carpeta: `client/vite/content.test.ts` (superficies y datos al cliente),
  `client/src/audio/cues.test.ts` (sonido del paso), `packages/renderer/src/map-view.test.ts`
  (`groundOverlay`, `forEachItemSprite`), `packages/content-schema/src/validate.test.ts`,
  `tools/spritepack` y `tools/spritegen` (sprites en `assets/livingworld/sprites/`).
- A ojo: `node --experimental-strip-types tools/spritegen/src/cli.ts preview --only
  livingworld/ --scale 6 --out shot.png` y `make play` (arena de Thimblewick).

## Pendiente
- Sonidos de paso propios por superficie: sin ffmpeg no se pudieron generar; los eventos ya
  existen y caen en `step`.
- No hay día y noche: las luciérnagas esperan uno (`night()` da siempre falso).
- Plantas nuevas sin colocar en los mapas.
