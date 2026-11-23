# livingworld/ — mundo vivo (guía corta para agentes)

**Propósito:** el entorno reacciona a quien pasa (huellas, plantas que se doblan, ondas,
polvo, hojas, bichos, pasos con sonido, y en el servidor rompibles, empujables y desgaste).
La fuente única es `livingworld/README.md`: léela antes de tocar nada.

**Invariantes:**
- `livingworld/` nunca importa de `server/` ni de `client/`. Fuera de aquí solo lo importan
  los archivos de la lista de pegamento del README (`make lint` lo revisa).
- El cliente es cosmético: nada cambia reglas ni manda mensajes. Determinista: nada de
  `Math.random`, `Date.now` ni `time.Now()`. Todo con tope (docs/07).
- "Animaciones reducidas" apaga todo.
- Contenido en `data/livingworld/*.yaml` (un esquema `livingworld-<nombre>.schema.json` por
  archivo), sprites en `assets/livingworld/`, mensajes en `proto/livingworld.proto`.

**Comandos:**
```
make test-livingworld                       Go + vitest de la carpeta
make lint                                   incluye la frontera
make validate                               data/livingworld y ground.surface
make spritegen ONLY=livingworld/ && make sprites
```

**Nunca:** importar `server/internal` o `client/`; agregar un import del paquete fuera de la
lista de pegamento sin sumarlo al README; poner sprites en `assets/sprites/`; duplicar
contenido de los pipelines compartidos; dibujar algo que el servidor no dijo como estado
(el desgaste llega por `applyWear`).
