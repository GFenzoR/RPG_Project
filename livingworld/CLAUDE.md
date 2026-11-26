# livingworld/ — mundo vivo (guía corta para agentes)

**Propósito:** el entorno reacciona a quien pasa (huellas, plantas que se doblan, ondas,
polvo, hojas, bichos, pasos con sonido, día y noche, y en el servidor rompibles, empujables,
desgaste y el reloj del mundo).
La fuente única es `livingworld/README.md`: léela antes de tocar nada.

**Invariantes:**
- `livingworld/` nunca importa de `server/` ni de `client/`. Fuera de aquí solo lo importan
  los archivos de la lista de pegamento del README (`make lint` lo revisa).
- El cliente es cosmético: nada cambia reglas ni manda mensajes. Determinista: nada de
  `Math.random`, `Date.now` ni `time.Now()`. Todo con tope (docs/07).
- `livingworld/server` (módulo Go propio, paquete `trail` y los que vengan) corre en el
  game loop: sin locks, sin I/O, el tiempo es el tick. Guardar y mandar es del pegamento
  de `server/` (`session/trailwear.go`, `app/trailwear.go`).
- "Animaciones reducidas" apaga todos los efectos (el desgaste, que es estado, se sigue viendo).
- Ambiente posicional (`client/src/ambience.ts`, `data/livingworld/ambience.yaml`): puro,
  sin Web Audio; capas por la mezcla de casillas (incremental) y emisores por item. Nunca
  un salto de ganancia, tope de voces (liviano en teléfonos y con animaciones reducidas).
- Objetos del mapa (rompibles, empujables, placas y compuertas): aleatoriedad solo con el
  `Rand` del loop; muros, puertas, suelos y casas nunca se rompen ni se mueven; nada aparece
  sobre una criatura o un item suelto; el botín se tira una vez por rotura; su estado es
  transitorio (no se guarda). Ninguno que pida herramienta, empujable o compuerta es el
  único camino de una quest.
- Viento (`client/src/wind.ts` puro, `wind-mesh.ts`): las plantas están **quietas** y solo
  se doblan cuando pasa una ráfaga (cada tanto, al azar pero determinista del reloj
  compartido y la semilla: nunca `Math.random`, nunca un vaivén constante ni un aleteo);
  todos los números en `data/livingworld/wind.yaml`; la base del sprite plantada y la copa en tiras que se corren px enteros
  de pantalla; sin texturas por frame. Toda planta declara su viento en su sprite (receta de
  spritegen o pista de `assets/sprites.yaml`) o dice `wind: none`: `make validate` falla si
  no. `data/livingworld/wind_sprites.yaml` es generado (`make spritegen`): nunca a mano.
- Huellas y pasos (`footprints.ts`, `footsteps.ts`): una huella no tiene tiempo de vida; la
  borran el viento (las mismas ráfagas de `wind.ts`, por exposición; nada entre dos), las olas en la arena
  mojada, el pie de otra criatura o el tope (las más viejas se desvanecen, nunca saltan).
  Los dos pies dejan marca y suenan, cada uno con su voz y sin repetir la toma; el volumen
  es `steps.volume` de `surfaces.yaml`. Todo sale de la posición, el reloj y los datos.
- Contenido en `data/livingworld/*.yaml` (un esquema `livingworld-<nombre>.schema.json` por
  archivo), sprites en `assets/livingworld/`, mensajes en `proto/game/v1/livingworld.proto`.

**Comandos:**
```
make test-livingworld                       Go + vitest de la carpeta
cd livingworld/server && go test ./...      solo el módulo Go
make lint                                   incluye la frontera
make validate                               data/livingworld y ground.surface
make spritegen ONLY=livingworld/ && make sprites
make sway-preview [ONLY=decor/] [SCENE=forest|town]   las plantas meciéndose, para Read
```

**Nunca:** importar `server/internal` o `client/`; agregar un import del paquete fuera de la
lista de pegamento sin sumarlo al README; poner sprites en `assets/sprites/`; duplicar
contenido de los pipelines compartidos; dibujar algo que el servidor no dijo como estado
(el desgaste llega por `applyWear`); escribir en `world/` desde el servidor (el desgaste es
una capa, el mapa de autor no cambia).
