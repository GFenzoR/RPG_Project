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
| Ambiente posicional (olas, viento, árboles, fuentes, fogatas, antorchas, fraguas, cuevas, pueblo) | `livingworld/client/src/ambience.ts` (`@rpg/living-world/ambience`, puro, sin Pixi ni Web Audio) | hecho (lote 18); ver "Ambiente" |
| Lógica y estado del servidor (rompibles, empujables, desgaste de senderos) | `livingworld/server/` (módulo Go propio `github.com/GFenzoR/RPG_Project/livingworld/server`; `server/go.mod` lo pide con `replace ../livingworld/server`) | desgaste de senderos: paquete `trail` (lote 17); rompibles y empujables: su ítem del lote |
| Contenido | `data/livingworld/*.yaml` (esquemas `packages/content-schema/schemas/livingworld-<nombre>.schema.json`) y `ground.surface` de `data/items` | `surfaces.yaml`, `plants.yaml`, `ambience.yaml` (cliente), `wear.yaml` (servidor) |
| Objetos del mapa (rompibles, empujables, placas y compuertas) | `livingworld/server` (paquete raíz), `livingworld/client/src/objects.ts`, `data/livingworld/objects.yaml` | hecho (lote 17); ver "Objetos del mapa" |
| Items nuevos (plantas) | `data/items/plants.yaml`, ids con `make gen-ids` en `data/ids.lock.yaml` | `grass_tuft`, `tall_grass`, `wildflowers`, `reeds` |
| Sprites | `assets/livingworld/sprites/` (los arma `tools/spritegen`, `recipes/living.ts`; `tools/spritepack` los empaqueta como `livingworld/<ruta>`) | arte propio |
| Sonidos | `assets/livingworld/sounds/` (registrados en `assets/sounds.yaml` y `assets/CREDITS.md`) | los loops del ambiente en `ambience/` (`tools/soundgen`, `src/ambience.ts`); los pasos por superficie, pendientes (usan `step`) |
| Mensajes | `proto/game/v1/livingworld.proto` (buf quiere los archivos de un paquete en su carpeta) | `TrailWear` (`ServerMessage.trail_wear` = 49 y `MapArea.wear`), `WorldClock` (`ServerMessage.world_clock` = 53) |
| Viento (árboles, arbustos y toda planta se mecen) | `livingworld/client/src/wind.ts` (puro) y `wind-mesh.ts` (tiras de Pixi), `data/livingworld/wind.yaml` y `wind_sprites.yaml` (lo escribe `make spritegen`), `tools/spritegen/src/wind.ts` | hecho (`feat/wind-flora`, lote 20); ver "Viento" |
| Día y noche (reloj, luz, luna, sombras proyectadas) | `livingworld/server/daynight` (reloj), `livingworld/client/src/sky.ts` (cielo), `data/livingworld/daynight.yaml` | hecho (`feat/day-night-shadows`); ver "Día y noche" |
| Sombras de los objetos del mapa (qué proyecta y cómo) | `livingworld/client/src/shadows.ts` (puro), `data/livingworld/shadows.yaml`; las dibuja el cliente (`client/src/render/object-shadows.ts`) | hecho (`feat/object-shadows`); ver "Sombras de los objetos" |
| Persistencia | tabla `trail_wear` (migración `server/migrations/00027_trail_wear.sql`) | una fila con el desgaste codificado |

## Contrato del cliente

El cliente lo monta con una API angosta (`livingworld/client/src/index.ts`):

```ts
const lw = createLivingWorld(stage, surfaceLookup, options);
lw.onCreatureStep(step, now); // una criatura en vista empieza un paso (las plantas)
lw.onCreatureWalk(sample);    // cada frame, cada criatura en vista: su ciclo de caminar y sus pies
lw.forgetCreature(id);        // la criatura salió de la vista
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
  `plants` (`version()` y `forEach` sobre los sprites de items del piso, cada uno con el id
  de `data/items` de su item: `MapView.version` y `MapView.forEachItemSprite`), `reduced()`,
  `night()` (la noche del cielo, `client/src/render/sky.ts`: luciérnagas en vez de pájaros
  y mariposas, y viento más calmo),
  `sheltered()` (bajo tierra: sin viento) y `onFootfall(pisada, eventos)`: un pie de una criatura
  en vista tocó el suelo (con o sin efectos reducidos); `eventos` son los del sonido de un paso
  sobre ese suelo. Los dos objetos se reutilizan: se leen dentro del callback.
- `view` de `onTick`: además de las casillas en vista, `zoom` (px de pantalla por px de
  sprite): el viento mueve las plantas en px enteros de pantalla.
- `CreatureStep`: `id`, `from`, `to` y `grounded` (una voladora no roza plantas).
- `WalkSample` (un objeto que el pegamento reutiliza): `id`, `x`, `y` (dónde se dibujan sus
  pies: el medio del cuerpo a lo ancho y la fila más baja de sus frames de caminar, en px de
  sprite del mundo), `z`, `phase` (el ciclo de caminar dibujado, 0 a 1, `Pose.walk` de
  `packages/renderer/src/anim.ts`; -1 si no camina), `frames` (los del clip de caminar; 0
  sin clip), `dx`, `dy` (hacia dónde se mueve en el mapa), `cyclePx` (px de pantalla que
  avanza el cuerpo en un ciclo entero), `gait` (su forma de andar, `gaitOf`), `sliding` (el
  dibujo se desliza por una corrección), `self` y `stepMs`.

### Qué hace
- **Pisadas** (`gait.ts`, "Huellas que coinciden con los pasos" abajo): el momento y el
  lugar en que cada pie toca el suelo, leídos del ciclo de caminar que el cliente dibuja.
  De cada pisada salen la huella, la onda, el polvo, las motas de MOV-7 y el sonido del
  paso: un solo golpe con la animación.
- **Huellas** (`footprints.ts`, "Huellas: qué las borra" abajo): cada pie que se apoya en
  `sand`, `wet_sand`, `snow`, `mud` o `ash` deja su marca en el lugar de ese pie, girada
  hacia donde camina; la del pie izquierdo y la del derecho se dibujan en dos hileras
  (`print_spread`). **No tienen tiempo de vida:** las borra lo que pasa en ese lugar (el
  viento, una ola, otra criatura que las pisa) o el tope (`MAX_FOOTPRINTS`, 64: pasadas las
  `SOFT_FOOTPRINTS`, 56, las más viejas se desvanecen; nunca desaparecen de golpe). Los
  objetos se reutilizan (ninguno nuevo por huella).
- **Plantas** (`sway.ts`): un paso dobla la planta de la casilla y, a la mitad, las 8
  vecinas, hacia donde camina (de frente o de espaldas, las de los lados hacia afuera): un
  resorte amortiguado de `SWAY_MS` (900 ms). Una planta sólida (arbusto, árboles:
  `blocks_movement` en `data/items`, docs/06 "Qué bloquea el paso") nunca se pisa: solo recibe
  el roce de quien pasa por una casilla vecina (`NEIGHBOUR`, 0,45 del doblez). Tope `MAX_SWAYS`
  (48) plantas moviéndose por pasos. En una planta con viento (casi todas) el doblez se suma al vaivén como px en la
  punta (`bendPx`) y lo mueven las mismas tiras: nunca salta. `bend` inclina la copa;
  `rustle` (árboles) la sacude 1,4 px. Una planta sin datos de viento (`wind: none`) se
  dobla como antes: un skew del sprite, o un corrimiento de 1 px.
- **Viento** (`wind.ts`, `wind-mesh.ts`): árboles, arbustos, hierba, juncos, flores y
  enredaderas se mecen con un viento que recorre el mapa. Ver "Viento".
- **Ondas y polvo** (`puffs.ts`): anillos que se abren donde un pie pisa agua (`ripple`,
  en vez de huella) y una nube de polvo bajo el pie al correr (`dust`, paso de
  `RUN_STEP_MS` = 232 ms o menos: los 260 de antes con el +15 % del 2026-11-26). Tope `MAX_PUFFS` (24). Las motas de MOV-7
  (`client/src/render/particles.ts`) salen también de la pisada, bajo el pie: en cada una
  si el cuerpo anda en dos pies, en una de cada dos si tiene más (`kicksUp` del pegamento).
- **Hojas** (`leaves.ts`): caen de los árboles con `leaves` en vista (`LEAF_RATE` por árbol y
  segundo) y al rozarlos; caen balanceándose, quedan en el suelo y se desvanecen. Tope
  `MAX_LEAVES` (24).
- **Bichos** (`critters.ts`): pájaros y mariposas de día que huyen cuando el jugador se
  acerca a `FLEE_TILES` (2,5) y no vuelven a ese lugar por `RETURN_MS` (20 s); luciérnagas de
  noche; sombras de peces en el agua. Dónde viven sale del hash de la casilla y de los
  `critters` de su superficie; se buscan cada `SCAN_MS` (1 s), no cada frame. Tope
  `MAX_CRITTERS` (10).
- **Pasos con sonido** (`footsteps.ts`, "Los dos pies" abajo): cada pisada del jugador
  propio pide `step.self.<sound>` (el de la superficie **bajo ese pie**) y después
  `step.self`; suena el primero que `assets/sounds.yaml` mapea. Cada `sound` de
  `surfaces.yaml` tiene tres tomas propias (`tools/soundgen/src/steps.ts`), bajas y a la
  misma sonoridad. `StepVoicer` le da a cada pisada su voz: el pie izquierdo y el derecho
  apenas distintos, un pequeño cambio de tono por paso y nunca la misma toma dos veces
  seguidas. El volumen de todos los pasos es un número: `steps.volume` de `surfaces.yaml`.
  Suena también con "Animaciones reducidas" (un sonido no es una animación). Sin
  `gaits.yaml` vuelve a sonar con el paso del servidor.

### Los dos pies (rama `feat/labels-and-steps`; el dueño, 2026-11-25)
"El sonido de los pasos se lo pusiste solo al pie derecho, pareciera que está cojeando", y
"los pasos se marcan en el piso de uno de los dos pies, debiesen ser de los 2".
- **Qué pasaba.** El rastreador ya avisaba los dos pies (derecho en `at: 0`, izquierdo en
  `at: 0.5`), pero nada los distinguía:
  - *Huellas:* caminando al este u oeste la vista 3/4 aplasta la separación de los pies
    (2,2 px a cada lado en el cuerpo, 1,3 px en pantalla) y las dos marcas, iguales, caían
    en una sola fila: se leía como las de un solo pie.
  - *Sonido:* la toma salía al azar entre tres, podía repetirse, y los dos pies sonaban
    idénticos; a paso rápido, o caminando al norte o en diagonal (hasta 4 pisadas por
    casilla), la misma toma se pisaba a sí misma y el motor descartaba la que pasaba de
    `max_voices`: un ritmo disparejo.
- **Huellas en dos hileras.** `print_spread` (`gaits.yaml`, 1,5 px para `biped`, 2 para
  `big_biped`) corre el dibujo de cada marca hacia el lado de su pie (`printOffset`, en px
  de pantalla, perpendicular al camino). La pisada (dónde suena, qué superficie, las motas)
  sigue siendo la del pie real; solo el dibujo se abre. Caminando al este quedan dos
  filas a 5,6 px; en diagonal y al norte también.
- **Cada pie con su voz** (`StepVoicer`, determinista: nada de `Math.random`):
  - el izquierdo y el derecho con unos puntos de diferencia (`steps.left`,
    `steps.right`: `pitch` y `gain`; hoy −3 % y 0,94 contra +2 % y 1);
  - un cambio de tono por paso de hasta ±`steps.jitter` (4 %), sacado del número del paso;
  - la toma: cualquiera menos la anterior (`pick(n)`), así que con tres tomas ninguna se
    pisa a sí misma y los dos pies las usan todas.
  El módulo entrega la voz (`StepVoice`: `gain`, `rate`, `pick`) en `onFootfall`; el
  motor de audio del cliente la aplica (`AudioEngine.play(events, at, listener, voice)`:
  ganancia sobre el volumen del sonido y `playbackRate`).
- **Volumen.** `steps.volume` (0,7) multiplica el `volume` de cada toma de
  `assets/sounds.yaml` (0,15, todas iguales): 0,105, un fondo. Es el único número que hay
  que tocar; un test (`client/vite/step-sounds.test.ts`) exige que quede bajo 0,12 y a
  menos de un quinto de un golpe (0,8) y de la música (0,7); la capa de ambiente más baja
  está en 0,15.
- **Según el piso.** La superficie es la del suelo bajo el pie (`surfaceAt` de la casilla
  donde cae, no la del cuerpo). `client/vite/step-sounds.test.ts` recorre todas las
  casillas de `world/`: cada suelo caminable tiene superficie, cada superficie su evento
  con tres tomas, y ningún archivo se comparte entre superficies; pasto, tierra y piedra
  existen en el mapa y suenan con archivos distintos. (El dueño los oyó iguales porque
  las tomas por superficie entraron el mismo día, rama `feat/step-sounds`; antes todo caía
  en `step`.)
- **Otras criaturas:** dejan sus dos (o cuatro, u ocho) pies igual que el jugador; su paso
  no suena (pendiente, abajo).

### Huellas: qué las borra (rama `feat/labels-and-steps`; el dueño, 2026-11-25)
"En la arena no debiesen borrarse después de un rato necesariamente; es según el viento o
según las olas, dinámico." Una huella guarda cuánto se borró (`wear`, de 0 a 1) y se ve con
`depth × (1 − wear)`. Nada la gasta por sí solo. Todo sale de su posición, del reloj y de
`data/livingworld` (sin azar y sin estado del servidor: dos clientes con el mismo reloj ven
la misma playa).
- **Viento.** Las mismas ráfagas que doblan las plantas (`wind.ts`: `gustAt`, la fuerza
  de la ráfaga sobre un lugar: 0 en la calma, hasta la fuerza de la ráfaga mientras su
  cuerpo pasa, unos 2 s), con su mismo reloj (`windClock`).
  Cada huella guarda la exposición de su lugar al nacer (`exposureOf` sobre las 5x5
  casillas: arena y orilla soplan fuerte, madera y piedra casi nada, un bosque denso
  calma). Por segundo se borra `prints.wind × (fuerza − still)²` (`windErosion`), con
  fuerza = exposición × ráfaga; bajo `prints.still` (0,35) no se toca. **Entre dos
  ráfagas la fuerza es 0: solo una ráfaga borra** (desde el 2026-11-26; antes soplaba
  siempre un poco). En una playa abierta (exposición ~1,3) una ráfaga mediana se lleva
  más de la mitad de una huella de arena (`wind: 1,4`) y una fuerte, casi toda: un rastro
  dura de una a tres ráfagas, de medio minuto a un par de minutos. Como el frente viaja,
  el rastro se va **huella por huella**, cada una cuando el frente llega a su casilla (un
  test lo comprueba contra `nextGust`). En un rincón al abrigo (exposición bajo 0,35) la
  fuerza nunca pasa de `still`: la huella queda hasta el tope.
  De noche el viento es más suave (`field.night`); bajo tierra no hay (`sheltered`).
- **Olas.** En `wet_sand` (`waves: true`) junto al agua. Hay una ola cada
  `waves.period_ms` (7680 ms: ocho vueltas del bucle del agua, 4 frames de 240 ms, así
  llega con la rompiente dibujada; no hay otro ciclo de mar con el que sincronizar: el
  ambiente es un loop continuo). Cada ola sube una distancia propia (`waveReach`, de 0,75
  casillas a `reach_tiles`, la mayoría cortas, por el número de ola) y llega `lag_ms` más
  tarde por casilla a lo largo de la costa (`waveTime`). Al nacer, la huella mide su
  distancia al borde del agua (`shoreDistance`) y calcula la primera ola que llega hasta
  ella (`nextWash`); cuando llega, se borra en `wash_ms` (0,5 s). Pegada al agua se va con
  la ola siguiente; más arriba espera una ola grande; fuera de alcance, queda al viento.
- **Otras criaturas.** El pie de otra criatura que cae a `tread_px` (5 px) de una huella
  le borra `tread` de la superficie (0,5 en arena: dos pisadas la deshacen). Los pies
  propios no borran las propias.
- **Lluvia:** no hay clima todavía; el gancho es `FootprintSim.rain` (parte borrada por
  segundo, hoy 0).
- **Bajo techo o bajo tierra** (polvo, ceniza de una cueva): sin viento ni olas, quedan
  hasta el tope.
- **Tope:** `MAX_FOOTPRINTS` (64) en total. Pasadas `SOFT_FOOTPRINTS` (56), las más
  viejas se marcan y se desvanecen en `fade_ms` (0,7 s): la reserva de 8 hace que nunca
  haya que sacar una de golpe (solo una ráfaga de más de 8 huellas en un frame pisa la
  más borrada).
- **Datos** (`surfaces.yaml`): arriba, `prints` (`still`, `fade_ms`, `tread_px`, `waves`);
  por superficie, `prints: { wind, waves, tread }` (ausente: no deja huellas).

### Huellas que coinciden con los pasos (rama `feat/footprint-sync`; el dueño, 2026-11-24)
"Las marcas al caminar, por ejemplo en la arena, tienen que coincidir con los pasos que da
el personaje; si no, se ve muy falso." Antes salía una marca por casilla (`onCreatureStep`),
sin relación con los pies. Ahora:

- **De dónde sale el ritmo.** La animación de caminar avanza por distancia
  (`packages/renderer/src/anim.ts`, docs/17 "La regla de la zancada"). `animate` deja en
  `Pose.walk` dónde va el ciclo dibujado, de 0 a 1 (con clip: por sus frames; sin clip, el
  salto de un paso, ANI-5), o -1 si la criatura no camina sobre sus patas ese frame (quieta,
  entre pasos, con un clip de ataque o muriendo, o voladora). `walkCyclesPerStep` dice
  cuántos ciclos hace un paso (para el humanoide, 8/8 en los cuatro sentidos y 11,31/8 en
  diagonal desde el 2026-11-26: un solo ritmo, docs/17 "La regla de la zancada"; antes
  13,86/8 al norte y 16/8 en diagonal), de donde sale `cyclePx`.
- **Cuándo toca cada pie.** Un andar (`Gait`, de `data/livingworld/gaits.yaml`) lista los
  contactos de un ciclo: `at` (cuándo), `side` (qué lado) y `along` (a qué altura del
  cuerpo). El humanoide del motor apoya el pie derecho desde el frame 0 y el izquierdo
  desde el 4 (`walkKeys` de `tools/spritegen`): `at: 0` y `at: 0.5`. `FootfallTracker`
  guarda la fase de cada criatura y, cuando el ciclo pasa por un contacto, avisa una
  pisada. Con clip, el contacto se ajusta al borde de frame: la pisada sale en el frame en
  que ese pie aparece apoyado, no antes. Si el ciclo no avanza no hay pisada: quieto,
  girando en el lugar o teletransportado no deja nada; al frenar a mitad de ciclo queda solo
  el último pie apoyado, y al seguir el ciclo continúa donde quedó (un contacto justo en la
  costura de dos pasos cuenta una vez).
- **Dónde.** El lugar del cuerpo cuando el pie tocó (el frame puede llegar un poco después:
  se retrocede lo que el ciclo se pasó, así el resultado no depende de los FPS ni de la
  velocidad), más `reach` × `cyclePx` hacia adelante (el pie del humanoide cae media zancada
  delante del cuerpo: 8 px en los cuatro sentidos; al norte y al sur el pie dibujado patina
  6,8 px bajo el cuerpo y la huella queda en el medio de ese recorrido), más `stance` hacia su lado y `along`
  a lo largo del cuerpo (`footOffset`). La vista 3/4 acorta el eje norte-sur (`view.depth`,
  0,577): caminando al este los pies quedan 1,3 px arriba y abajo de la línea; en diagonal
  el cuerpo está girado 60° y los pies se separan según eso. `rise` sube del borde inferior
  del sprite al punto del suelo bajo el cuerpo. La huella gira a la dirección real del
  movimiento (8 direcciones) y queda separada por lo que el cuerpo avanza entre pisadas: 16 px
  en los cuatro sentidos, (11,3; 11,3) en diagonal.
- **Deslizamientos.** Una corrección del servidor desliza el dibujo sin que camine
  (`Slide` de `client/src/state/motion.ts`): mientras al deslizamiento le falten más de
  `slide_px` (2 px), la pisada no deja huella, onda ni polvo (el sonido sigue).
- **Todas las criaturas, mismo sistema.** Jugadores, NPCs y monstruos en vista pasan por
  `onCreatureWalk`. Las huellas de otro jugador salen de su animación dibujada en este
  cliente, así que también coinciden. El andar sale de `gaitOf`: el propio de la criatura
  (`creatures`, por id) o el de su tipo de cuerpo (`defaults`): humanoide (`biped`), bestia
  (`quadruped`: cuatro huellas por ciclo, traseras y delanteras, más chicas), bestia grande
  (`big_quadruped`: más grandes y más hondas), muchas patas (`many_legs`: dos líneas de
  puntos), cuerpo arrastrado (`slither`: un surco), saltarín (`hop`: los dos pies donde
  cae) y voladora (ninguna). Para una criatura con clip dibujado a mano (las de Gemini) los
  contactos son una aproximación por fracción del ciclo: se ajustan en su entrada de
  `creatures` con un andar propio.
- **Rendimiento** (docs/07): un estado por criatura en vista (tope 256, reutilizados), una
  `Footfall` y un `WalkSample` reutilizados; las huellas salen de una lista libre. Un frame
  no crea objetos.
- **Efectos reducidos:** ni huellas, ni ondas, ni polvo, ni motas; el sonido sí.
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

## Día y noche

Pedido del dueño (2026-11-23): que los personajes no parezcan flotar (sombras que siguen su
forma), un ciclo de día y noche, y sombras que siguen al sol. Decisión del dueño: **180
minutos reales de día y 60 de noche** (240 por ciclo).

**Datos** (`data/livingworld/daynight.yaml`, esquema `livingworld-daynight.schema.json`):
`cycle` lo leen servidor y cliente (`day_minutes` 180, `night_minutes` 60, `dawn_minutes`
15, `dusk_minutes` 15, `lunar_days` 8, `sync_seconds` 60); `sky` solo el cliente (colores
de amanecer, día, atardecer y de la noche con luna nueva y llena; `floor` 0,5, la
luminancia mínima de la noche; `sun_shadow` 0,42 y `moon_shadow` 0,16, la opacidad de las
sombras; `max_shadow` 1,4 alturas). El servidor rechaza una clave desconocida de `cycle` y
no mira `sky`. El amanecer y el atardecer duran cada uno, como mucho, la mitad del día: el
servidor rechaza más (`Cycle.Check`) y el cliente lo recorta ahí, así los dos nombran
siempre la misma fase.

**Servidor** (`livingworld/server/daynight`): un `Clock` en el loop. El tiempo del mundo son
milisegundos que corren a `rate` (1 normal) desde un ancla; el ancla inicial es la hora
Unix del reloj inyectado del servidor al arrancar (`Config.DayNightEpochMs`, que pone
`app`): el ciclo sigue entre reinicios y es el mismo para todos. Avanza con el número de
tick: determinista, sin `time.Now()`.

```go
k := daynight.New(cycle, tickMs, epochMs)
t := k.At(tick)        // Day (ciclos desde la época) y CycleMs (0 = empieza el amanecer)
cycle.Phase(t)         // Dawn, Day, Dusk, Night
cycle.MoonPhase(t)     // luna del cielo: 0 nueva .. lunar_days/2 llena (en el amanecer, la de la noche anterior)
k.Set(tick, ms)        // staff: otra hora del mismo día
k.SetMoon(tick, fase)  // staff: el próximo día en que el cielo de esta hora tiene esa fase
k.SetRate(tick, r)     // staff: 0 lo detiene, hasta 600
k.SyncDue(tick)        // toca mandar el WorldClock (cada sync_seconds si corre, o tras un cambio)
k.Frozen()             // recién creado: detenido (-world-time del E2E); detenido no pide sync periódico
```

El pegamento (`server/internal/session/daynight.go`) manda `WorldClock` (`day`,
`cycle_ms`, `rate`) al entrar (justo después del `Welcome`), a todos cada `sync_seconds`
mientras el reloj corre y en el acto tras un `/time` (docs/16). Ninguna regla del juego lee la hora.

**Cliente** (`livingworld/client/src/sky.ts`, puro): `parseDayNight`, `advance` (corre el
reloj entre dos `WorldClock`), `skyAt(datos, día, cycleMs)` → `Sky` (fase, `ambient` el
color multiplicado sobre la superficie, `lamps` 0..1, `moon`, `night`, `shadow`) y
`shadowTransform` (el skew y la escala de Pixi que tumban un sprite parado en el suelo). El
sol sale por el este al empezar el día y se pone por el oeste al terminar: la sombra
apunta al oeste a la mañana, queda corta bajo los pies al mediodía y apunta al este a la
tarde, siempre hacia el "norte" de la vista 3/4; la luna cruza la noche igual. El
pegamento `client/src/render/sky.ts` (`SkyView`) lo lee cada frame sin crear objetos
(`advance`, `skyAt` y `shadowTransform` escriben en los objetos que `SkyView` reutiliza), y
el renderer del cliente dibuja:
- la luz (`render/light-layer.ts`): en la superficie, el `ambient` del cielo como fondo del
  mapa de luz y las luces del jugador y de cada item con `light` atenuadas por `lamps`; de
  día, ninguna pasada. Las cuevas no cambian;
- las sombras proyectadas de las criaturas (`render/cast-shadows.ts`,
  `CreatureBody.castShadow`): las capas del frame de cada criatura del piso, oscuras,
  desde la línea donde está parada (`stance` de `atlas.json`), en un contenedor sobre
  `MapView.groundOverlay` que se desvanece entero con un `AlphaFilter`. La sombra de
  contacto (la elipse) solo se dibuja donde no hay sombra proyectada (bajo tierra, bajo
  techo, noche sin luna, un cuerpo a menos de media opacidad): nunca las dos juntas
  (dueño, 2026-11-25). Un cuerpo que cae muerto o se desvanece sigue proyectando la suya
  hasta bajar de media opacidad. Bajo tierra y bajo techo no hay. "Animaciones reducidas"
  no las apaga (ni la luz ni el tinte de la noche: no son movimiento);
- las sombras de los objetos del mapa (`render/object-shadows.ts`), en el mismo
  contenedor: "Sombras de los objetos", abajo. Las sombras dibujadas de árboles y casas
  (`<sprite>/shadow`) ya no se ven en el juego (`MapView.castShadowStrength` 0);
- `night()` del mundo vivo (luciérnagas).

Sin `daynight.yaml` no hay `WorldClock` ni cielo; antes del primer `WorldClock` (o con un
servidor viejo) el cliente dibuja el mediodía.

### Sombras de las luces

Pedido del dueño (2026-11-26): bajo techo la sombra sigue a la luz del edificio, no al sol.
`client/src/light-shadows.ts` (puro, sin Pixi, con tests): `lightCast(reglas, luces, x, y,
lado, out)` da el vector de la sombra (este y norte, por px de altura, como el del sol) y
su fuerza para quien está en esa casilla; `parseLightShadows` lee `lights` de
`data/livingworld/shadows.yaml`; `lightBreath` es el respiro de la llama (dos senos, del
reloj del frame). Las luces llegan en una lista plana (`LIGHT_STRIDE`: x, y, radio, lado:
`SIDE_OUT`, `SIDE_IN`, `SIDE_BOTH`). Mezcla las dos más cercanas con pesos `n1 - n3` y
`n2 - n3` (la cercanía de cada una menos la de la tercera) sobre `n1 + n2`: continua cuando
dos luces cambian de puesto, que es lo que evita el salto. Determinista y sin asignar nada.
Dirección de arte en docs/17 "Sombras de las luces"; costo en docs/07.

### Sombras de los objetos

Pedido del dueño (2026-11-25): la sombra dinámica "para todos los objetos, incluidos los
árboles". Dirección de arte y decisiones en docs/17 "Sombras de los objetos"; costo en
docs/07. Cosmético: el servidor no lee nada de esto.

**Datos** (`data/livingworld/shadows.yaml`, esquema `livingworld-shadows.schema.json`):
quién proyecta se dice por regla, no por lista. Una sombra es `none`, `silhouette` (el
dibujo del objeto tumbado desde su base), `block` (la caja que llena su casilla: muros y
portones, que se unen en una sombra continua) o un mapa `{ cast, length, height }`
(`length` 0,1..1,5: la parte del largo a la que se dibuja una silueta; `height` 1..96: el
alto de la caja en px, por defecto lo que el dibujo sube sobre su casilla). Se resuelve en
este orden, el primero que aplique:
1. `items`: el id del item;
2. `families`: una palabra del id (partido en `_`, en singular o plural); gana la primera
   palabra del id que tenga familia;
3. `kinds`: el `kind` del item.

Por familia o por `kind` solo proyecta lo que está fijo en el mapa (`pickupable: false`, y
los muros); un item suelto no proyecta salvo que `items` lo nombre. `make validate` exige
que cada `kind` y cada item existan, que cada familia sea una palabra del id de algún
objeto fijo, y que un objeto con dos familias que no coinciden (`cut_bush`: `cut` no
proyecta, un `bush` sí lo haría) tenga su línea en `items`.

**Código puro** (`livingworld/client/src/shadows.ts`): `parseShadows`, `shadowFamilies` y
`shadowOf(reglas, { id, kind, fixed })` → `ObjectShadow | undefined`. El plugin de Vite del
cliente resuelve la sombra de cada item al construir (`ItemDef.shadow`); el lienzo no
conoce las reglas.

**Viento:** `LivingWorld.windStrips(sprite)` da la malla de tiras de un sprite que se mece
ahora (o `undefined`) y `windVersion()` cambia cada vez que una malla nace o muere. El
cliente monta la sombra de ese árbol como una segunda malla sobre **la misma geometría**:
la sombra de la copa se mece con la copa y la del tronco queda quieta. La geometría es del
viento: quien la comparte nunca la destruye, y no la guarda más allá de un cambio de
`windVersion`.

**Cómo agregar:** un objeto nuevo fijo en el mapa proyecta solo, por su `kind`. Si es plano
(una alfombra, un charco, una placa) o cuelga de un muro, sumar su familia con `none` (o
el item en `items`). Si es parte de un muro, `block`.

## Viento

Pedido del dueño (2026-11-24): que el mundo vivo anime también lo **grande** del mapa
(árboles, arbustos, plantas en general), con un movimiento chico pero **orgánico**; y que
toda planta **futura** (mapas de selva y otros) lo herede sin trabajo manual.

**Cómo se mueve un sprite** (`wind-mesh.ts`). Un skew o un giro del sprite entero se ve
falso: se mueve el tronco. Cada planta con viento se dibuja como una malla de Pixi cortada
en **tiras horizontales**: una rígida para todo lo que está bajo el *pivot* (donde termina
el tronco o el tallo) y hasta `MAX_STRIPS` (16) de `STRIP_PX` (2 px) o más sobre él. Cada
tira se corre de lado, entera, lo que mueve la punta por **el cuadrado de su altura** sobre
el pivot (`rowWeight`): la base queda plantada y la copa se mueve. Los corrimientos son
**px enteros de pantalla** al zoom actual (`snapSteps`), así el pixel art nunca se
desenfoca: cada tira muestra siempre sus propios texels. No se genera ninguna textura por
frame y la malla va en el mismo batch que los sprites del mapa (`batchMode: "batch"`, un
solo draw call). La malla ocupa el lugar del sprite del mapa (mismo padre, posición y
`zIndex`, ordenada justo después), que queda oculto; `MapView` no sabe nada de esto. Las
mallas se conservan mientras vive su sprite: al entrar un chunk solo se crean las suyas.

**Quietas, salvo cuando pasa una ráfaga** (`wind.ts`, puro; el dueño, 2026-11-26: "el
movimiento que le agregaste a las plantas es demasiado, pareciera que tienen vida o que se
están como quemando; tiene que ser un movimiento generado por un random y cada cierto
rato, como si pasara una ráfaga de viento"). El vaivén constante y el aleteo de la copa
del lote 20 ya no existen. Una planta está **quieta** (exactamente en su lugar: ninguna
tira se reescribe) hasta que le llega el frente de una ráfaga:

- **Cuándo viene una ráfaga.** El reloj se parte en tramos de `gusts.every_s` (45 s) y
  cada tramo tiene **una** ráfaga, la número *k*. De *k* y de `gusts.seed` (un hash, sin
  `Math.random`) salen su momento dentro del tramo (`jitter`: dos ráfagas quedan entre 0,7
  y 1,3 tramos una de otra, nunca como un metrónomo), su fuerza (`strength: [0,6, 1,0]`),
  su dirección (`field.direction` ± `spread` grados) y dónde nace.
- **Cómo cruza el mapa.** El frente es una línea atravesada a la dirección de la ráfaga,
  un poco ondulada (`FRONT_WOBBLE`, 3 casillas) y con tramos más flojos; avanza a
  `field.speed` (8 casillas por segundo), recorre `travel_tiles` (64, unas dos pantallas)
  y muere: nace y se apaga de a poco (el 15 % de cada punta), así que una ráfaga puede
  "levantarse" en medio de la pantalla. Cada casilla la recibe exactamente una vez.
  `nextGust(campo, x, y, ms, min)` dice cuándo y con qué fuerza llega la próxima a una
  casilla (tests, E2E y la vista previa; un frame nunca lo pregunta).
- **Qué hace la planta** (`gustShape`, `gustLean`, `swayAt`): al llegar el frente entra a
  la inclinación con suavidad (`rise_ms`, 450 ms), la sostiene mientras la ráfaga le sopla
  encima (`hold_ms`, 1,1 s) y al soltarla hace `swings` (2) balanceos a su propio período,
  cada uno menor que el anterior (el primero vuelve a un 67 % hacia el otro lado), hasta
  quedar **exactamente quieta** un balanceo y medio después. Tamaño y período propios del
  hash de su casilla: las vecinas no se mueven como un coro. Nunca más que su `amplitude`.
- **La calma es larga y es un dato.** Con los números de hoy, una casilla ve una ráfaga
  cada 24 a 67 s y la planta más lenta (un árbol) se mueve unos 7 s: un árbol a campo
  abierto está quieto más del 80 % del tiempo. `make validate` exige que entre el último
  balanceo de una ráfaga y el frente de la siguiente queden **al menos 10 s** en cualquier
  casilla (`checkWindGusts`); si `every_s` baja o `travel_tiles` sube demasiado, falla.
- **Deriva en la calma (`drift`, apagada).** Cada tipo puede derivar menos de 1 px, lento
  (`gusts.drift_ms`), entre ráfagas. Hoy es **0 para todos los tipos**: a zoom 2 medio
  píxel de sprite ya es un píxel de pantalla que va y viene, y en muchas plantas a la vez
  se lee como el hormigueo que el dueño pidió sacar. Queda como perilla; nunca para
  plantas chicas del suelo.
- **Igual para todos.** Todo sale de la casilla, del reloj, de la semilla y de los datos.
  El reloj de las ráfagas es `windClock`, que el cliente del juego llena con **el reloj
  del servidor** (`Date.now() + clockOffset` del `Welcome`): dos jugadores lado a lado ven
  la misma ráfaga doblar los mismos árboles en el mismo momento. Sin `windClock` (tests,
  herramientas) se usa el reloj del frame.
- **Costo.** `gustActive` dice si hay alguna ráfaga viva en el mapa; en la calma (la
  mayor parte del tiempo) el frame no le pregunta nada a ninguna planta.

Un arbusto se mueve menos que un árbol; un cactus o un árbol seco, casi nada: `stiffness`
hace que una planta rígida ignore una ráfaga floja y solo ceda a una fuerte.

**Dónde sopla** (`exposureOf`, calculado una vez por planta al armar la lista, no por
frame): el promedio de `exposure` de las superficies de las 25 casillas de alrededor (así
la costa sopla unas casillas tierra adentro): más en arena, arena mojada, agua baja, ceniza
y nieve, normal en el pasto, la mitad sobre piedra (pueblos) y **nada sobre madera** (los
pisos de adentro); menos dentro de un bosque (`forest`: los árboles de alrededor lo
calman hasta un 25 %); **nada bajo tierra** (`sheltered`, las cuevas); y un 20 % menos de
noche (`night`, con una transición de 20 s). No hay clima todavía: cuando lo haya, es un
factor más sobre la fuerza.

**Sombras:** la sombra de un árbol se dobla con él en la ráfaga y queda quieta en la calma: es una segunda malla del cliente sobre
las mismas tiras (`windStrips`; "Sombras de los objetos" en "Día y noche"), así la de la
copa se mueve y la del tronco no. La sombra dibujada (`<sprite>/shadow`) ya no se usa en
el juego. Las sombras proyectadas de las criaturas no cambian.

**Con "Animaciones reducidas"** (o `prefers-reduced-motion`) no hay mallas: vuelven los
sprites quietos del mapa.

**Datos.** Todo está en `data/livingworld/wind.yaml` (ningún número del movimiento vive
en el código): `field` (`direction` en grados, `speed` del frente en casillas por
segundo, `exposure` por superficie, `open`, `forest`, `night`); `gusts` (`every_s`,
`jitter`, `strength: [mín, máx]`, `spread` en grados, `travel_tiles`, `rise_ms`,
`hold_ms`, `swings`, `drift_ms`, `seed`); y `kinds`, los valores por **tipo de planta**
(`tree`, `palm`, `bush`, `tall_grass`, `reed`, `flower`, `vine`, `cactus`,
`dead_tree`): `stiffness` (0 a 1), `amplitude` (px en la punta con ráfaga plena, hasta
4), `drift` (px de deriva en la calma, menos de 1; hoy 0), `period_ms` (un balanceo
después de la ráfaga) y `pivot` (la parte del alto que queda plantada cuando el sprite no
lo dice). Un árbol nuevo no necesita ningún número. **Para afinarlo sin código:** más o
menos seguido, `gusts.every_s`; más o menos fuerte, `gusts.strength` o
`kinds.<tipo>.amplitude`; más o menos balanceo, `gusts.swings`.

**De dónde sale el viento de cada planta** (`resolveWind`), de menos a más específico:
1. los valores de su tipo (`wind.yaml` `kinds`);
2. lo que dice **su sprite**: `data/livingworld/wind_sprites.yaml`, un archivo **generado**
   por `make spritegen` (nunca a mano) con `kind`, `pivot` y `top` (la fila más alta
   dibujada), en px sobre el borde de abajo del sprite. Sale de la metadata `wind` de cada
   receta de `tools/spritegen` y de las pistas `wind` de `assets/sprites.yaml` (sprites de
   packs o de Gemini);
3. lo que dice **su item** en `plants.yaml` (`wind: <tipo>`, `wind: { kind, pivot,
   stiffness, amplitude }` o `wind: none`).

Un item cuyo sprite tiene metadata se mece **aunque no esté en `plants.yaml`** (reacciona
al paso según su tipo: los de tronco se sacuden, el resto se dobla). Los estandartes y la
bandera no usan el viento: tienen su propio bucle de frames (docs/17 ART-7).

**Nadie se olvida de una planta.** `make validate` falla si un item que es una planta no
tiene metadata de viento ni un `wind: none` explícito. Es una planta todo item listado en
`plants.yaml` y toda decoración cuyo id o ruta de sprite nombra una (`tree`, `bush`,
`grass`, `reeds`, `flower`, `vine`, `fern`, `palm`, `cactus`, `bamboo`, `hedge`, `ivy`...;
`PLANT_WORD` de `packages/content-schema/src/validate.ts`) o cuyo sprite vive en una
carpeta `plants/`. También falla un árbol declarado a mano sin `pivot`, y un
`wind_sprites.yaml` viejo o faltante (lo revisan además `spritegen check` y el test de
spritegen).

### Cómo agregar una planta
1. El item en `data/items` (`kind: decoration`), `make gen-ids`, sus nombres en
   `i18n/{es,en}/items.yaml`.
2. Su sprite **con su viento**:
   - **dibujada por spritegen:** la receta declara `wind: plantWind("<tipo>", { pivot })`
     (`recipes/trees.ts`, `recipes/living.ts`; un spec del motor, `wind:` en el spec).
     `plantWind("reed")` alcanza para lo que se dobla desde el suelo; un árbol, una
     palmera, un cactus o un árbol seco dicen su `pivot` (px sobre el borde de abajo donde
     termina el tronco). Solo si la planta no se parece a su tipo: `stiffness`,
     `amplitude`;
   - **de un pack o de Gemini:** el PNG en `assets/sprites/` (con su fila en
     `assets/CREDITS.md`) y, en `tiles:` de `assets/sprites.yaml`,
     `<sprite>: { wind: { kind: <tipo>, pivot: N } }` (el `pivot` es obligatorio;
     `tools/gemini/import_art.py --wind <tipo> --pivot N` deja la línea escrita en
     `import.json`).
3. `make spritegen` (escribe `wind_sprites.yaml` y revisa el dibujo) y `make sprites`.
4. **Mirar el vaivén:** `make sway-preview ONLY=<prefijo>` y abrir
   `build/spritegen/sway.png` con Read (cada planta quieta y en 8 momentos, con la misma
   matemática del cliente); `make sway-preview SCENE=forest` (o `town`) escribe cuatro
   momentos de un trozo de mapa en el campo de viento real.
5. Solo si hace falta: su fila en `plants.yaml` (`leaves`, `trample`, otra `reaction`, o
   `wind: none` con el motivo en un comentario).
6. `make validate test`.

**Reglas de dibujo para que se deforme bien** (las revisa `spriteWind` de
`tools/spritegen/src/wind.ts`; fallan `make spritegen`, `spritegen check` y el test):
- **tronco y copa bien separados** en un árbol o una palmera: bajo el pivot, el tronco
  mide menos del 60 % del ancho de la copa. El pivot va justo donde termina el tronco
  visible;
- **ningún píxel suelto:** todo lo que se mueve está unido (8 vecinos) a la base plantada.
  Un pétalo o una semilla flotando quedaría al lado de la planta mientras se mece;
- **margen a los lados:** las filas que se mueven dejan al menos 1 px transparente a cada
  lado del lienzo (mejor 2 o 3: la copa de un árbol se corre hasta 2 px);
- el pivot cae dentro del dibujo, debajo de su punta.

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
   un frame no crea objetos para el dibujo, y la lista de plantas (con la exposición al
   viento y la malla de cada una) se rearma solo cuando cambia `MapView.version`. El viento
   solo mueve las plantas en vista y solo sube vértices cuando una tira cambió de píxel.
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
- `client/src/audio/ambience.ts`: monta el ambiente posicional sobre el mapa del cliente
  (casillas de `WorldState`, id y superficie de cada item, el tope liviano) y le da a
  `Game` las voces que pasa a `AudioEngine.setAmbience`
- `client/src/render/living.ts`: monta el mundo vivo sobre el `MapView` (superficie de cada
  casilla, sprites de plantas, texturas del atlas), da el andar de cada criatura
  (`creatureGait`, `bodyKindOf`), pasa las pisadas al canvas (`onFootfall`, `kicksUp`) y arma
  los eventos de sonido del paso propio
- `client/vite/content.ts`: lee `data/livingworld/*.yaml` con `parseLivingWorldData` (y le
  da el sprite de cada item, para unir el viento de los sprites con las plantas)
- `tools/spritegen/src/wind.ts`: la metadata de viento de los sprites de plantas
  (`wind_sprites.yaml`), las reglas de dibujo y el preview del vaivén, con la misma
  matemática del cliente (`@rpg/living-world/wind`, puro, sin Pixi)
- `client/src/content-types.ts`: el tipo `LivingWorldData` de `ClientContent.livingWorld`
- `server/internal/session/trailwear.go`: el desgaste de senderos en el game loop (pasos,
  tick, cambios a los clientes, `MapArea.wear`, la copia para guardar)
- `server/internal/session/livingworld.go`: los objetos del mapa: el `Host`, los comandos y
  los ganchos del loop
- `server/internal/session/daynight.go`: el reloj del mundo en el game loop (el
  `WorldClock` al entrar, cada `sync_seconds` y tras un `/time` del staff)
- `client/src/render/sky.ts`: el cielo de cada frame (el reloj del servidor llevado
  adelante, la luz, las lámparas, la sombra del sol o de la luna, la noche de los bichos)
- `client/src/render/light-shadows.ts`: las sombras de lámparas, antorchas y fuegos (las
  luces del `MapView`, de qué lado del techo está cada una, y la capa que las dibuja)
<!-- glue:end -->

El ambiente lo usa `client/src/game.ts` a través de `client/src/audio/ambience.ts`
(`mountAmbience`, `ambienceAt` cada `AMBIENCE_STEP_MS` desde `frame`); el motor
(`client/src/audio/engine.ts`, `setAmbience`) recibe voces con un tipo propio
(`AmbientLoop`, la misma forma que `AmbienceVoice`) y no importa el módulo.

Lo demás lo usan a través de `client/src/render/living.ts`: `client/src/render/game-canvas.ts`
(monta, pasa pasos, frames y el ciclo de caminar de cada criatura; en cada pisada levanta las
motas de MOV-7 y avisa la del jugador propio por `GameCanvasOptions.footstep`) y
`client/src/game.ts` (el sonido del paso en esa pisada; `CueContext.footfalls` de
`client/src/audio/cues.ts` apaga el del `CreatureMove` del servidor, que sigue de respaldo
sin `gaits.yaml` por `CueContext.stepEvents`). `packages/renderer/src/anim.ts` suma
`Pose.walk` y `walkCyclesPerStep`, sin saber del mundo vivo. El renderer compartido
(`packages/renderer`) suma `MapView.groundOverlay`, `MapView.version` y
`MapView.forEachItemSprite`, sin saber del mundo vivo (la malla de una planta con viento
la agrega el módulo al padre del sprite que `MapView` le presta). El desgaste que manda el servidor
lo guarda `client/src/state/trail-wear.ts` (sin importar el módulo) y `game-canvas.ts` se lo
pasa a `applyWear` cuando cambia.

En el servidor, `server/internal/session/trailwear.go` exporta los alias `TrailConfig` y
`TrailSnapshot` y `LoadTrailWear`: `app` y `cmd/gameserver` usan esos nombres y no
importan el módulo.

Además, sin importar el módulo: `server/go.mod` lo requiere con
`replace ../livingworld/server` (y `tools/bots/go.mod` repite el `replace`, porque un
`replace` de una dependencia no se hereda); `client/package.json` depende de
`@rpg/living-world` (y `tools/spritegen/package.json`, por el preview del vaivén);
`tools/spritepack/src/tiles.ts` acepta la pista `wind` de `assets/sprites.yaml` y repite
la lista de tipos (`WIND_HINT_KINDS`; un test de spritegen la compara con `WIND_KINDS`),
igual que `tools/gemini/import_art.py`; `packages/content-schema` revisa los archivos de
viento (`checkPlantWind`); `pnpm-workspace.yaml` y `vitest.config.ts` lo listan; el Dockerfile
del servidor copia `livingworld/server/`; la CI tiene el job `go (livingworld/server)` y
`govulncheck`; `deploy/tests/check-go-version.sh` mira su `go.mod` (misma versión de Go que
los demás módulos).

## Datos

`data/items/ground.yaml`: cada suelo dice de qué está hecho, `ground: { …, surface: sand }`
(enum `surface` de `common.schema.json`: `sand`, `wet_sand`, `snow`, `mud`, `grass`,
`tall_grass`, `dirt`, `ash`, `stone`, `wood`, `water_shallow`, `lava`).

`data/livingworld/surfaces.yaml`: arriba, `prints` (qué borra las huellas en todas partes:
`still`, `fade_ms`, `tread_px`, `waves: { period_ms, reach_tiles, lag_ms, wash_ms }`) y
`steps` (cómo suenan los pasos: `volume`, el único número del volumen; `jitter`; `left` y
`right` con `pitch` y `gain`); por superficie: `prints` (`wind`, `waves`, `tread`; ausente:
no deja huellas), `dust`, `ripple`, `tint` (`#rrggbb`), `sound`, `critters`. `make validate` exige que toda superficie
que usa un suelo esté descrita.

`data/livingworld/gaits.yaml` (cliente, "Huellas que coinciden con los pasos" arriba):
`view.depth` (cuánto acorta la vista 3/4 el eje norte-sur; el `PROJECTION.depth` del motor
de sprites), `slide_px`, `gaits` (por nombre: `print` = `feet` | `paw` | `big_paw` | `dot` |
`trail`, el sprite `livingworld/fx/footprint_<print>`; `stance`, `reach`, `rise`, `scale`,
`depth` = opacidad de la huella fresca; `print_spread` = px que el dibujo de la huella se
abre hacia el lado de su pie; `contacts`: lista de `{ at, side: left | right |
centre, along }`; vacía: no deja pisadas), `defaults` (`humanoid`, `beast`, `big_beast`,
`flying`) y `creatures` (id de monstruo o NPC → andar). `make validate` exige que cada
andar nombrado exista y que cada criatura sea un monstruo o un NPC de `data/`.

`data/livingworld/plants.yaml` (lista): `item` (de `data/items`), `reaction` (`bend` |
`rustle`; sin ella, la de su tipo de viento), `leaves`, `trample` (aplastada sobre una
casilla gastada) y `wind` (un tipo, un mapa o `none`; sin él, lo que dice su sprite). Cada
item una sola vez; con `reaction` o con `wind`. La clave `idle` del lote 17 ya no existe:
la reemplaza el viento.

`data/livingworld/wind.yaml` y `data/livingworld/wind_sprites.yaml` (generado): "Viento",
arriba.

`data/livingworld/shadows.yaml` (cliente): qué objeto del mapa proyecta sombra y cómo
(`kinds`, `families`, `items`): "Sombras de los objetos", arriba.

`data/livingworld/ambience.yaml` (cliente, "Ambiente" abajo): `radius`, `fade_ms`,
`voices`, `voices_lite`, `rescan_ms`, `beds` (por id: `sound`, `volume`, `floors`, `full`,
`base`, `surfaces`, `items`) y `emitters` (por id de item: `sound`, `volume`, `radius`,
`falloff`). `make validate` exige que cada sonido sea de canal `ambient` en
`assets/sounds.yaml`, que cada item exista, que ningún emisor pase el radio de la ventana
y que `voices_lite` no pase `voices`.

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
  `surface: snow` en `data/items`; su fila en `surfaces.yaml` (`prints` con lo que la borra: `wind`, `waves`, `tread`; `tint`,
  `sound`).
  Sin código.
- **Una planta** (se mece con el viento y reacciona al paso): "Cómo agregar una planta",
  en "Viento". Su sprite declara el viento; `make validate` no deja olvidarlo.
- **Un tipo de planta nuevo** (p. ej. `mushroom`): su nombre en `WIND_KINDS` (`wind.ts`),
  en `WIND_HINT_KINDS` (`tools/spritepack/src/tiles.ts`), en `WIND_KINDS` de
  `tools/gemini/import_art.py` y en los dos esquemas (`livingworld-wind` y
  `livingworld-wind_sprites`), y sus valores en `kinds` de `wind.yaml`.
- **El andar de un monstruo nuevo:** nada si le sirve el de su cuerpo (bestia, bestia
  grande, voladora, o humanoide si tiene `look`); si no, su fila en `creatures` de
  `gaits.yaml` (`moss_spider: many_legs`). Un andar nuevo: su entrada en `gaits` con sus
  contactos; una marca nueva, su receta `livingworld/fx/footprint_<print>` en
  `tools/spritegen/src/recipes/living.ts` y el nombre en `PRINT_KINDS` y en el esquema.
- **Una planta que se mueve:** el item en `data/items/plants.yaml` (o el que ya exista),
  `make gen-ids`, sus nombres en `i18n/{es,en}/items.yaml`, su receta en
  `tools/spritegen/src/recipes/living.ts` (`livingworld/plants/<id>`), `make spritegen
  ONLY=livingworld/` y `make sprites`; su fila en `plants.yaml`.
- **Un sonido de paso:** su receta en `RECIPES` de `tools/soundgen/src/steps.ts` (salen
  tres tomas, `assets/livingworld/sounds/steps/<sound>_<n>.ogg`, con `make sounds
  ONLY=livingworld/steps/<sound>_<n>`; o un archivo de un pack con su fila en
  `assets/CREDITS.md`), los sonidos en `sounds:` de `assets/sounds.yaml` y el evento
  `step.self.<sound>: [<ids>]` en `events:` (suena uno al azar).
- **Un emisor de sonido** (p. ej. una cascada o un molino): el item en el mapa y su fila
  en `emitters` de `ambience.yaml` (`sound`, `volume`, `radius`). Sin código. Un sonido
  nuevo: su receta en `tools/soundgen/src/ambience.ts` (`livingworld/ambience/<nombre>`,
  `make sounds ONLY=livingworld/ambience/<nombre>`) o un archivo de Gemini o de un pack
  con su fila en `assets/CREDITS.md`, y su línea `amb_<nombre>` (canal `ambient`) en
  `assets/sounds.yaml`.
- **Una capa de zona** (p. ej. nieve con viento helado): su entrada en `beds` con las
  superficies o items que la hacen sonar y su `full`. Sin código.
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
- Viento: `livingworld/client/src/wind.test.ts` (las ráfagas: una planta exactamente
  quieta en la calma; al pasar el frente entra suave, se inclina, se balancea cada vez
  menos y queda en cero; deterministas, iguales en otro cliente y distintas con otra
  semilla; tantas por hora como dice `every_s`, nunca como un reloj; el frente viaja a
  `speed` y cada ráfaga viene de su lado; la exposición por superficie, bosque e
  interior; el tope por tipo; la deriva solo si el tipo la pide; los datos reales del
  juego: deriva 0 y un árbol quieto más del 80 % del tiempo; el desplazamiento: cero en
  la base, crece con el cuadrado de la altura, en px enteros de pantalla, y nada que
  subir mientras está quieta; los datos por tipo y su unión con sprites e items; la malla
  sobre sprites reales de Pixi, el reloj compartido (`windClock`), el roce de una
  criatura sin saltos, solo y sumado a una ráfaga, "Animaciones reducidas", cuevas e
  interiores, los chunks que entran y salen; y el presupuesto de un frame con 999 árboles
  mientras una ráfaga los cruza),
  `tools/spritegen/src/wind.test.ts` (toda receta de planta declara su viento, las reglas
  de dibujo, el archivo generado al día, las pistas de `sprites.yaml`, el preview),
  `packages/content-schema/src/validate.test.ts` (ninguna planta sin viento),
  `tools/spritepack` (la pista `wind`), `tools/gemini/test_import_art.py` (`--wind`),
  `client/vite/content.test.ts` (los datos reales) y `client/src/render/living.test.ts`
  (cada sprite con el id de su item). A ojo: `make sway-preview`.
- Día y noche: `livingworld/server/daynight/clock_test.go` (ciclo, fases, luna, época del
  reloj inyectado, `/time`, ritmo, sincronía), `livingworld/client/src/sky.test.ts` (sol,
  tinte, piso de luminancia, lámparas, luna, transformación de la sombra),
  `server/internal/session/daynight_test.go` (login, sincronía, `/time` y su auditoría),
  `client/src/render/sky.test.ts`, `cast-shadows.test.ts` y `light-layer.test.ts`; E2E
  "sandbox day and night" (`99b-daynight-noon`, `99c-daynight-night`).
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
- Ambiente: `livingworld/client/src/ambience.test.ts` (la composición contra un conteo
  entero en 300 pasos al azar con saltos, las casillas que llegan tarde, el peso de las
  capas y su paneo, atenuación, paneo y descarte de emisores, la mezcla por sonido, los
  fundidos sin saltos, una voz que vuelve sin reiniciarse, el punto de arranque lejos del
  anterior, el tope de voces y el liviano, y el determinismo de una caminata del mar al
  bosque); `client/src/audio/engine.test.ts` ("the ambience": el motor sobre un contexto
  falso); `client/vite/content.test.ts` (los datos reales); `packages/content-schema`
  (los errores de `ambience.yaml`); `tools/soundgen` (loops sin costura, nivel y tope).
- Pisadas: `livingworld/client/src/gait.test.ts` corre `anim.ts` frame a frame como el
  canvas (el pie se avisa en el frame en que aparece apoyado, el 0 y el 4; pies alternados;
  las 8 direcciones con su zancada, su giro y su separación; mismas huellas a 20, 60 y 144
  FPS y a cualquier velocidad; un giro a mitad de caminata; quieto; frenar a mitad de
  ciclo; pasos de a una casilla; teletransporte; deslizamiento; una criatura vista a mitad
  de su caminata; cuadrúpedo, saltarín, muchas patas, voladora; los datos reales).
  `gait-humanoid.test.ts` renderiza cada pie del humanoide del motor solo, frame a frame,
  y exige que su huella quede bajo él en las 8 direcciones (a 2,5 px en cada frame y a 1,75
  de media: el pie se dibuja en píxeles enteros y avanza de a un frame). `index.test.ts`:
  huella, onda y polvo en la pisada, el sonido en la pisada (también con efectos
  reducidos), nada al deslizarse.
- Captura sin navegador: `node --experimental-strip-types
  livingworld/client/scripts/footfall-shot.ts --out DIR` escribe `footfalls-east.png`,
  `-south`, `-south-east` y `-north-west`: los frames reales del humanoide sobre arena en
  el momento de cada pisada, sólido a la izquierda y traslúcido a la derecha, para mirar
  cada huella contra el pie que tiene encima.
- Fuera de la carpeta: `client/vite/content.test.ts` (superficies y datos al cliente),
  `client/src/audio/cues.test.ts` (sonido del paso), `client/src/render/living.test.ts`
  (el andar de cada cuerpo, qué pisadas levantan motas), `packages/renderer/src/anim.test.ts`
  (`Pose.walk`), `client/vite/step-sounds.test.ts` (el sonido del paso sobre todas las
  casillas de `world/`), `client/src/audio/engine.test.ts` (la voz de una pisada),
  `client/e2e/sandbox.spec.ts` ("sandbox footprints": la playa de Thimblewick, recto y en
  diagonal, los dos pies con su huella y su sonido, y el rastro antes y después de una
  ráfaga y de una ola, capturas `99h` a `99n`), `packages/renderer/src/map-view.test.ts`
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
| `ClearItems(pos)` | corre los items sueltos de la casilla (nunca unos restos de criatura: se pudren solos) a la casilla más cercana dentro de `travel.arrival_radius` a la que llega a pie quien está junto al objeto, caminable, sin casa, puerta, entrada de portal ni otro objeto, y con lugar; la reserva de un item (`heldGround`) va con él. Dice si la casilla quedó sin items sueltos |
| `Occupied(pos)` | hay una criatura (jugador, monstruo o NPC) |
| `Watched(pos)` | algún jugador tiene la casilla en su vista (la regla de los respawns del servidor, docs/02 "Respawns": la ventana entera, los pisos que se ven juntos; el staff invisible no cuenta). El módulo no sabe de jugadores ni de ventanas: solo pregunta |
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
5. **Nada aparece encima de algo, ni a la vista.** Un objeto roto reaparece, y uno
   empujado vuelve a su lugar, solo cuando ningún jugador ve la casilla (`Watched`; para
   la roca, ni donde está ni su lugar: decisión del dueño del 2026-11-26, "si el jugador
   está viendo un área el respawn no debiese pasar") y no hay una criatura en ella; si
   no, reintenta cada segundo. Primero se pregunta `Watched`: una casilla vigilada
   conserva sus items donde están. Un puzzle no se rearma con alguien mirándolo.
   Los items sueltos de la casilla (el botín que nadie levantó, una moneda tirada para
   trabarlo) se corren antes a una vecina (`ClearItems`), así que nadie traba un objeto,
   una roca ni una compuerta abierta tirando algo encima; solo unos restos de criatura,
   que se pudren solos, lo hacen esperar. Un empuje solo entra a una casilla libre y sin
   otro objeto (tampoco uno roto que va a reaparecer ahí), que no sea la casilla de
   llegada de un portal (escalera, escala, teleport). Una compuerta no se cierra sobre
   nadie.
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
| Sprites | `assets/livingworld/sprites/` (`tools/spritepack` los empaqueta como `livingworld/<nombre>`), dibujados por `tools/spritegen/src/engine/specs/livingworld.ts` |
| Sonidos | ids de `assets/sounds.yaml` (los de siempre: `hit`, `woodcutting`, `mining`...); uno nuevo iría en `assets/livingworld/sounds/` con su fila en `assets/CREDITS.md` |
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
    respawn_seconds: 240            # vuelve a estar, si nadie la ve y la casilla está libre
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

## Ambiente

Pedido del dueño del 2026-11-23: "en el pueblo se escucha el mar aunque no está tan cerca".
Antes sonaba un loop por isla (`amb_olas` en toda Velmara); ahora, bajo la música y en el
canal `ambient`, suena lo que hay alrededor del jugador (`ambience.ts`, puro y
determinista):

- **Capas de zona** (`beds`): una ventana cuadrada de `radius` (10) casillas alrededor del
  jugador. Cada casilla pesa, para cada capa, lo más pesado de su suelo (`surfaces`) y de
  sus items (`items`); el nivel es la parte de las casillas conocidas sobre `full`, hasta
  1, más `base`. Así el mar suena a 10 casillas del agua y un pueblo tierra adentro no lo
  oye. Cada capa se panea un poco (`BED_PAN`, 0,5) hacia donde están sus casillas.
  **Incremental:** al caminar, `Composition.moveTo` suma la fila o columna que entra y
  resta la que sale; cada casilla de la ventana guarda en un anillo lo que sumó, así resta
  exactamente eso (sumas enteras: el resultado es igual a contar todo de nuevo, lo prueba
  el test). Cada `rescan_ms` (2 s) cuenta la ventana entera (casillas que cambiaron), y un
  cambio de piso o un salto más largo que el radio también.
- **Emisores** (`emitters`): items del mapa que suenan solos (fuente, pozo, fogón,
  brasero, antorcha, farol, fragua), hallados en la misma ventana. Se oyen dentro de su
  `radius` (nunca más que el de la ventana), más bajos con la distancia (`smooth`:
  (1 − d/r)²; `linear`: 1 − d/r), paneados por su x contra la del jugador (`PAN_TILES` 6,
  `MAX_PAN` 0,8, como los efectos) y descartados más allá. Los de un mismo sonido son una
  sola voz (√Σg², paneada al promedio), y una capa y un emisor del mismo sonido también.
- **Mezcla** (`AmbienceMixer`): las más fuertes primero, como mucho `voices` (6) a la vez,
  `voices_lite` (3) en un teléfono (puntero grueso) o con "Animaciones reducidas" (que
  también se usa en equipos lentos). Una ganancia nunca salta: se mueve como mucho una
  escala entera por `fade_ms` (2,5 s), así una capa que se va se apaga y una que vuelve
  mientras se apaga es la misma voz que sube, sin reiniciarse. Una voz nueva arranca su
  loop en un punto al azar (con semilla) a por lo menos un cuarto de loop de donde arrancó
  la vez anterior: dos loops nunca vuelven a coincidir en el mismo segundo. Si el tope
  está lleno, la voz más baja que se apaga lo hace cuatro veces más rápido
  (`FAST_FADE`) y la nueva entra después. El paneo se mueve en `PAN_MS` (800 ms).
- **Motor** (pegamento): `Game` llama `ambienceAt` cada `AMBIENCE_STEP_MS` (250 ms) y pasa
  las voces a `AudioEngine.setAmbience`; el motor las refleja en buffer sources con `loop`,
  arrancados en su `offset`, con rampas de `AMBIENCE_RAMP_MS` (300 ms) entre pasos, y
  apaga en `AMBIENCE_RELEASE_MS` (1,5 s) una que ya no llega (al salir del juego). Con el
  canal de ambiente silenciado no baja ni toca nada. Deja decodificados los loops que
  suenan y `KEEP_LOOPS` (2) de los últimos. La música sigue igual, con sus pools y sus
  transiciones, en su propio canal.
- **Sonidos**: nueve loops propios de 16 s (`tools/soundgen/src/ambience.ts`): olas en una
  orilla, viento del desierto (también la brisa suave del pasto), viento en los árboles,
  cueva con gotas, murmullo de pueblo, fuente de piedra (y pozo, más bajo), fogata
  (fogón y brasero), antorcha (y farol) y fragua; la lava usa el `amb_volcan` de siempre.
  Ruido con filtros y envolventes periódicas, eventos (gotas, chasquidos) que dan la
  vuelta al final, y la cola doblada sobre la cabeza con un fundido de potencia constante
  (`seamless`, `XF_S` 0,75 s): sin costura. Todos al mismo RMS (`TARGET_RMS`, con techo de
  pico `PEAK`), así la mezcla es solo `ambience.yaml`. Ogg Opus mono a 24 kbps, ~42 KB
  cada uno (docs/07 "Audio").
- **Mapa:** fuentes en Velmara, Selvaine y Karvask; pozos en Selvaine y Karvask; fogones,
  braseros, antorchas, faroles y fraguas en todas las islas grandes. Thimblewick tiene
  fragua y fogón, sin fuente. No hay item de fogata suelta ni de cascada: el fogón hace de
  fogata. Lo que suena en cada templo (medido con los mapas reales): Velmara, el murmullo
  y algo de brisa con el fogón lejos; la isla del E2E, solo la brisa del pasto; en la
  orilla de Velmara, olas fuertes paneadas hacia el mar.


## Pendiente
- Huellas: descalzo o con botas dejan la misma marca; los contactos de las criaturas
  dibujadas a mano (Gemini) son los de su tipo de cuerpo, sin medir sus frames; una
  criatura sin sprite en el atlas (el bloque de color) no deja pisadas ni suena; el
  sonido de paso es solo el del jugador propio (los de otros jugadores cerca, posicionales
  y más bajos, serían `AudioEngine.play` con `at`: falta decidir si se quieren).
- Huellas: la marca del pie izquierdo y la del derecho son el mismo sprite (simétrico);
  una horma por pie pide otro sprite de spritegen. No hay lluvia (`FootprintSim.rain` es
  el gancho). Las olas no se dibujan subiendo por la arena: la huella se borra con el
  ritmo de la rompiente, pero no hay lámina de agua que la tape.
- Pasos: caminando al norte, al sur o en diagonal la animación da más pisadas por casilla
  (3,5 y 4 contra 2 al este), y suenan todas; si cansa, bajar `steps.volume`.
- Sonidos de paso propios por superficie: sin ffmpeg no se pudieron generar; los eventos ya
  existen y caen en `step`.
- Día y noche: una sombra no se aleja de una fogata cercana; no hay hora en el HUD; bajo
  techo no se ven las huellas ni las ondas (el suelo de adentro tapa la capa); las
  criaturas con sombra pintada en el sprite la llevan además de la proyectada (docs/14).
- Plantas nuevas sin colocar en los mapas.
- Viento: no hay clima (lluvia, tormenta) que cambie su fuerza ni su dirección; las hojas
  que caen no derivan con él; estandartes y bandera siguen con su bucle de frames, sin
  seguir las ráfagas; una planta con frames propios (`<sprite>/frame_<n>`) y viento
  mostraría solo su primer frame en la malla (hoy no hay ninguna); el editor de mapas no
  muestra el vaivén.
- Ambiente: los loops son de soundgen; probar Gemini (el Chrome del dueño no estaba
  abierto el 2026-11-24) y que el dueño los escuche; una cascada y una fogata suelta
  necesitan su item; las paredes no tapan el sonido de un emisor.
