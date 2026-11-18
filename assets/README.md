# assets/

| Ruta | Qué es | ¿Se commitea? |
|---|---|---|
| `sprites.yaml` | Manifiesto: de dónde salen los píxeles de cada sprite de `data/` | Sí |
| `sprites/<ruta>.png` | Arte propio del proyecto (32x32 o múltiplos de 32) | Sí |
| `vendor/<pack>/` | Packs de terceros tal como se bajaron, con su archivo `LICENSE` | Sí |
| `CREDITS.md` | Registro de licencias de todo lo que hay en `vendor/`, y de lo generado con Gemini | Sí |
| `prompts/<ruta>.txt` | El prompt exacto de cada asset hecho con el Gemini del dueño (ver abajo) | Sí |
| `atlas/` | Salida de `make sprites` (`atlas.json`, `atlas-N.png/json`) | No (generado) |

## Sonido (T3.7)
| Ruta | Qué es | ¿Se commitea? |
|---|---|---|
| `sounds.yaml` | Manifiesto: archivo y canal de cada sonido, eventos → sonidos, loops por isla, música del título, de combate y de jefes | Sí |
| `sounds/{sfx,ui,music,ambient}/*.ogg` | Obra propia (CC0) generada por `make sounds` (`tools/soundgen`) | Sí |
| `sounds/music/gemini/<lugar>_<toma>.ogg` | Música elegida por el dueño entre las tomas de Gemini ("Generado con IA" en `CREDITS.md`), escrita por `make music-gemini` | Sí |
| `sounds/music/gemini.yaml` | Qué tiene cada lugar: la toma, varias tomas o `none`, con fuente, título y medidas | Sí (lo escribe `make music-gemini`) |

- Todo lo de `sounds/` sale de recetas en código (`tools/soundgen/src/sfx.ts` y
  `music.ts`): osciladores, ruido, envolventes y una cuerda pulsada (Karplus-Strong). Las
  progresiones y melodías son propias. `make sounds` las vuelve a renderizar y las
  encoda a Ogg Opus con **ffmpeg** (libopus); `make sounds ONLY=sfx/hit` regenera una
  sola. Los `.ogg` se commitean: el build, la CI y el juego no necesitan ffmpeg.
- El render es determinista (mismos samples con la misma receta). Los bytes del `.ogg`
  pueden variar entre versiones de libopus: es normal ver diffs binarios al regenerar.
- Presupuesto de tamaño en `docs/07-performance-budget.md`, "Audio".

### La música de Gemini (`make music-gemini`)
Desde el 2026-11-18 la música del juego es la que el dueño eligió entre las tomas que
Gemini hizo para cada lugar (`tools/gemini/music_slots.json`: título, Puerto, Bosque,
Volcán, Cuevas, combate y el guardián de la forja). Las tomas están fuera de git, en
`build/music-gemini/<lugar>_<n>.mp4` con su sidecar (la tercera de Puerto es `probe_1.mp4`),
y las elecciones en `build/music-gemini/picks.json`:
```json
{"picks": {"title": "1", "town_puerto": ["1", "2", "3"], "volcan": "2", "combat": "off"}}
```
- **Una toma** (`"1"`, `"2"`, `"3"`) suena en su lugar. **Varias** (una lista) entran
  todas: la primera es el sonido del lugar (`music_puerto`) y las demás, sonidos propios
  (`music_puerto_2`, `music_puerto_3`) para el director de música que las va a alternar
  (pendiente, `docs/14`).
- **Un lugar sin elegir** suena con su toma 1, marcada `provisional` en el manifiesto y en
  su fila de `CREDITS.md`.
- **`none` u `off`** deja lo que sonaba antes de Gemini: el tema de soundgen de ese lugar
  (`puerto`, `bosque`, `volcan`, `cueva`: por eso siguen en el repo con sus recetas), o
  nada propio donde no había (título, combate, jefe: sigue la música de la zona).

Para cambiar una elección: editar `picks.json` y correr **`make music-gemini`** (con
`FROM=<carpeta>` si las tomas están en otro lado). Hace todo de nuevo desde las elecciones:
convierte cada toma con `music_convert.py` (sin fades, un loop de 54 a 72 s elegido donde
lo que sigue al corte se parece al comienzo, cerrado con un crossfade, una sola ganancia
hacia -14 LUFS sin pasar -1,5 dBTP, Ogg Opus **mono a 20 kbps**; una toma ya convertida
con los mismos ajustes no se vuelve a convertir), la copia a `sounds/music/gemini/`,
reescribe sus líneas de `sounds.yaml` (entre las marcas `# gemini-music:…`), el archivo de
prompt de cada toma (`assets/prompts/sounds/music/gemini/`), sus filas de `CREDITS.md` y
`sounds/music/gemini.yaml`, borra lo que ya no se usa y al final revisa el presupuesto
(`tools/soundgen check`). Los masters de Gemini vienen calientes (picos de +1,5 a +5 dBTP):
el techo de pico deja los loops entre -16 y -19,5 LUFS, y el volumen de `sounds.yaml`
devuelve esa diferencia hasta 1 (`volume_for`), así que suenan ~2 dB por debajo de los
temas de soundgen. Después: `make test` (el test de soundgen compara el manifiesto con
`sounds.yaml`, las filas y la carpeta), `make validate` y escucharlo con `make play`.

### Reemplazar sonidos por un pack de terceros
1. Copia el pack sin modificar a `assets/vendor/<pack>/` con su `LICENSE` (o `COPYING`), y
   agrega su fila en la tabla de `CREDITS.md` (CC0, CC-BY, OGA-BY o CC-BY-SA). Son las mismas reglas
   que para los sprites, y `make validate` comprueba las dos cosas. Se mantienen los
   nombres del pack (mayúsculas, espacios, subcarpetas como `Audio/impactMetal_000.ogg`);
   solo la carpeta `<pack>` va en minúsculas y sin espacios.
2. Si el pack no viene en Ogg Opus u Ogg Vorbis, conviértelo sin tocar el original. Por
   ejemplo:
   `ffmpeg -i vendor/<pack>/x.wav -ac 1 -c:a libopus -b:a 32k vendor/<pack>/x.ogg`.
   La conversión es una obra derivada: queda bajo la misma licencia y en la misma carpeta.
3. En `sounds.yaml`, cambia `file:` de cada sonido que reemplaces:
   `hit: { file: vendor/<pack>/x.ogg, channel: sfx, volume: 0.8 }`. Los `.ogg` propios
   que nadie use se pueden borrar. El test de soundgen exige que cada receta se use, así
   que también se borra su receta.
4. `make validate` (archivos, créditos, referencias) y `make test` (presupuesto de
   tamaño). Escucha el resultado con `make dev`: el panel Opciones permite subir o
   silenciar cada canal.

## Cómo se resuelve un sprite
El campo `sprite:` de `data/` es una ruta lógica (`weapons/iron_sword`). `tools/spritepack`
la resuelve en este orden:
1. `assets/sprites/weapons/iron_sword.png` (arte propio).
2. La entrada `weapons/iron_sword` de `sprites.yaml`: un recorte de un pack (`source`) o un
   placeholder explícito (`placeholder`, cuadro de color con sigla).
3. Si no hay nada: placeholder automático (sigla del nombre, color por categoría) y un
   aviso. `make sprites STRICT=1` lo convierte en error.

Una ruta no puede estar a la vez en `sprites/` y en `sprites.yaml`.

Límites: un PNG (propio o de un pack) puede tener hasta 2048 px de lado, lo que entra en
una página del atlas. Se mira en la cabecera antes de decodificarlo, porque el check de
PR de mapas arma el atlas con los sprites del PR (`docs/04`). Un `placeholder.size` llega
hasta 256 px por lado.

## Sprites animados (docs/17 ANI)
Los monstruos, NPCs y atuendos se animan con datos de `sprites.yaml`, no con código. El
detalle de cómo los juega el cliente está en `client/CLAUDE.md`, "Animación de criaturas".

**Frames y nombres.** Cada frame es un sprite del atlas llamado
`<sprite>/<acción>_<dir>_<n>` (ANI-4): `acción` es `idle`, `walk`, `attack` o `death`, `dir`
es `n`, `e`, `s` o `w`, y `n` arranca en 0. Hay tres maneras de tenerlos:
1. **Capas de un pack** (`animations` con `layers`): spritepack compone las hojas en orden
   (abajo primero), recolorea con `palettes` y corta los frames. Así salen los personajes
   de LPC (`vendor/ulpc`).
2. **Arte propio con esos nombres** en `sprites/` (por ejemplo, de spritegen:
   `sprites/creatures/bristleback_boar/walk_w_0.png` a `walk_w_3.png`). spritepack arma los
   clips solo: por acción, las direcciones que tienen frame 0 y tantos frames como tengan
   todas sin huecos.
3. **Ninguno:** el sprite único se anima por código (ANI-5). Una entrada de `animations`
   sin `layers` le da pistas.

```yaml
palettes:                                  # colores de claro a oscuro
  ulpc_cloth: ["#ffffff", "#e5e6c7", "#c4b59f", "#958080", "#4d4a5d"]   # base de las hojas ULPC
  cloth_navy: ["#7c96c4", "#5a76a8", "#435a87", "#304064", "#1d263e"]   # propia
animations:
  outfits/sailor:
    preset: lpc                            # hojas del generador ULPC: idle, walk, slash, hurt
    actions: [idle, walk]                  # opcional: un subconjunto del preset (NPCs)
    layers:                                # "<sheet>" = la hoja de cada acción
      - vendor/ulpc/spritesheets/body/bodies/male/<sheet>.png
      - { file: vendor/ulpc/spritesheets/legs/pants/male/<sheet>.png, recolor: { ulpc_cloth: cloth_navy } }
  creatures/gloom_bat: { flying: true }    # pistas para un sprite de un solo frame
  creatures/wolf: { facing: left }
```
- **Preset `lpc`** (`tools/spritepack/src/anims.ts`, `PRESETS`): frames de 64x64, filas
  norte, oeste, sur y este. `idle` = 2 frames de 500 ms; `walk` = columnas 1 a 8 (la 0 es
  la pose quieta), 4 frames por casilla; `attack` = `slash`, 6 de 60 ms; `death` = `hurt`,
  6 de 100 ms y solo hacia el sur (las otras direcciones usan esa).
- **Sin preset**, cada acción se describe entera:
  `walk: { sheet: walk, frame: [64, 64], rows: { n: 0, w: 1, s: 2, e: 3 }, col: 1, count: 8, per_tile: 4 }`
  (`ms` para las demás acciones).
- **`recolor`** cambia cada color de la paleta de origen por el del mismo lugar de la de
  destino (mismo largo). Los píxeles de las capas quedan con alfa 0 o 255: lo que tiene
  menos de la mitad de opacidad se descarta.
- **Pistas** (con o sin capas): `facing: left | right` (hacia dónde mira el dibujo: se
  espeja para ir al otro lado), `flying: true` (flota, su sombra se achica, no salta),
  `shadow: baked | ellipse | none`. Con capas, la sombra por defecto es `ellipse` (la sombra
  de contacto del renderer, ART-5: los frames de LPC no traen sombra); sin capas,
  `baked` (Dungeon Crawl y spritegen la pintan).
- **Alias:** el nombre del sprite (`outfits/sailor`) apunta a su primer frame quieto (para
  las referencias de `data/`, los íconos y la tienda del sitio), y los frames viejos de un
  atuendo (`outfits/sailor/s_0`, `e_2`, T0.5) a la pose quieta y al ciclo de caminar.
  Comparten el rectángulo del atlas: no ocupan lugar.
- **Errores** (`make sprites`): una animación con capas no puede pisar un sprite que ya
  existe (archivo o entrada de `sprites`); una entrada con pistas tiene que nombrar uno que
  exista; falta una hoja o es más chica que lo que piden la acción y sus filas.
- **atlas.json** suma `anims`: por sprite, `w`, `h`, `anchor` (`bc` con capas: los pies
  sobre la casilla; `br`, el de siempre), `foot` (filas vacías bajo los pies), `top` (alto
  del dibujo), `shadow`, `facing`, `flying` y por acción `frames`, `ms`, `perTile` y `dirs`.
  `foot` y `top` se miden en los frames de caminar.
- **Revisar:** `node --experimental-strip-types tools/spritepack/src/cli.ts preview --page 1
  --scale 2 --out shot.png` muestra la página donde caen los personajes. Mirarlos a 1x y a
  2x con Read, y en el juego (screenshots del E2E).

### Personajes de LPC (`vendor/ulpc`)
92 capas del Universal LPC Spritesheet Character Generator (commit fijado en `CREDITS.md` y
en `vendor/ulpc/LICENSE.txt`), copiadas sin tocar con sus rutas: cuerpos (hombre, mujer,
esqueleto), cabezas (hombre, mujer, anciano), camisa de manga larga, armaduras de cuero, placas
y cota de malla, pantalones, botas y zapatos, cinco peinados, barba, capucha y pañuelo. Solo
entraron archivos cuya fila de `CREDITS.csv` lista OGA-BY o CC-BY-SA (el cuerpo zombi y los ojos
sueltos no tienen fila: quedaron afuera). Las hojas base vienen en colores neutros (piel
clara, tela blanca, pelo naranja): la variedad sale de las paletas propias de `palettes`.

Para un personaje nuevo: elegir capas de esa carpeta (o sumar otras del mismo commit, con su
fila de `CREDITS.csv` copiada al subconjunto de la carpeta), escribir su entrada en
`animations` en el orden cuerpo, piernas, pies, torso, cabeza, barba, pelo y sombrero, y
revisar el preview. El lobo del "RPG Maker MZ LPC Starter Kit" quedó afuera: no trae
licencia al lado del archivo (docs/17, SRC-2).

## Arte del mapa: looks, frames, muros, sombras y luz (docs/17 ART-3 a ART-7)
Un sprite que `data/` pone en el mapa (suelo o item) puede tener partes al lado, que
spritepack encuentra por nombre (arte propio o entradas de `sprites.yaml`):

| Parte | Qué es | Quién la usa |
|---|---|---|
| `<sprite>/var_<n>` (n = 1..) | Otro look del suelo; el sprite es el look 0 | El renderer elige uno por casilla con `tileHash(x, y, z)`, el 0 en el 70 % |
| `<sprite>/frame_<n>` (n = 1..) | Otro frame de un suelo o item animado; el sprite es el frame 0 | `MapView` los avanza con el reloj; `mapcli render` muestra el 0 |
| `<sprite>/wall_<m>` (m = 0..15, las 16) | La pieza de muro para cada máscara de vecinos muro (N=1, E=2, S=4, O=8), de 32x64 | El renderer pone en cada casilla la de sus vecinos |
| `<sprite>/shadow` | Su sombra proyectada, en negro, del tamaño del sprite | La capa de sombras, teñida y translúcida, entre el suelo y los items |

Lo que los nombres no dicen va en la sección `tiles` de `sprites.yaml`:
```yaml
tiles:
  ground/water_shallow: { ms: 240, sync: world }   # ms por frame y sincronía
  decor/oak_tree: { anchor: bc, ms: 800, sync: tile }   # centrado en su casilla
  decor/wall_torch: { ms: 110, sync: tile, light: 3 }   # da luz en cuevas (radio en casillas)
  doors/forge_gate: { joins_walls: true }   # los muros de al lado lo cuentan como muro
  ground/lava: { ms: 280, sync: world, particles: embers }   # partículas de ambiente
```
- `particles` (docs/17 ART-7, A13): `embers` (brasas que suben), `pollen` (polen que flota
  alrededor de un árbol), `spray` (rocío; un suelo `spray` solo emite donde toca otro
  suelo) o `dust` (polvo). El cliente las dibuja (`client/src/render/particles.ts`).
- Las piezas de muro pueden medir 32x96 (la muralla, `walls/rampart_wall`: cara de 64 px).
  El marco de las puertas de casa (`doors/house_door_frame`) también tiene 16 piezas: el
  renderer lo pone en cada puerta de `houses.yaml` sin que esté en el mapa.
- `sync`: `world` (todas las casillas en fase: agua, lava, espuma), `tile` (una fase por
  casilla: fuego, copas, estandartes) o `random` (un destello cada 3–5 s por casilla). Sin
  entrada: 250 ms y `world`.
- `weight`: la parte de las casillas que muestra el look 0 (por defecto 0,7).
- `ms` y `sync` sin frames, `weight` sin looks, piezas de muro incompletas o partes sin su
  sprite son errores de `make sprites`.

spritepack escribe lo que tiene cada sprite en `atlas.json` `tiles` (`TileMeta` de
`packages/renderer/src/tile-art.ts`, puro y compartido con `mapcli render`). Los bordes de
orilla (`borders/sand_water_*`) traen 3 frames de espuma que hace `gen-borders`, no
spritegen.

## Arte propio (spritegen)
Parte de `sprites/` sale de `tools/spritegen`: recetas en TypeScript que dibujan cada
sprite píxel a píxel (`tools/spritegen/src/recipes/`). Son obra propia (CC0, ver
`CREDITS.md`) y se commitean; `make spritegen` los regenera (`ONLY=decor/` para un prefijo)
y después `make sprites` rearma el atlas. Al pasar una ruta a spritegen hay que borrar su
entrada de `sprites.yaml` (la regla de arriba). El test de spritegen falla si un PNG
commiteado no coincide con su receta.

Estilo (el de los MMORPG 2D clásicos, sin copiar ni calcar ningún sprite concreto). La
dirección de arte acordada el 2026-11-17 está en `docs/17-direccion-de-arte-y-ui.md`:
proyección, muros con altura, variantes de suelo, valores, animación y el orden en que se
reemplazan los sprites. Las reglas de abajo son las de hoy y cambian con sus tareas.
- 32x32, vista cenital oblicua 3/4: se ve la cara de arriba y la frontal (sur).
- Contorno de 1 px en un tono oscuro del color local (no negro puro), luz desde arriba a la
  izquierda, 3-4 tonos por material, poco o nada de tramado, alfa solo 0 o 255.
- Paleta apagada y algo oscura que combine con Dungeon Crawl (`tools/spritegen/src/palette.ts`).
- Objetos más altos que una casilla (carteles, la fragua) pueden medir 64x64 o 32x64: el
  renderer los ancla en la esquina inferior derecha de su casilla y crecen hacia arriba y a
  la izquierda. Los árboles (`recipes/trees.ts`, 64x96) van centrados en su
  casilla (`anchor: bc`), con la copa en 3/4, sombra proyectada y 4 frames de viento.
  Items de inventario: 32x32 centrados con fondo transparente.
- Muros (`recipes/walls.ts`): 16 piezas de 32x64 por material, la tapa levantada 32 px
  sobre la cara (ver "Arte del mapa" arriba y docs/17 ART-3).
- Suelos (`recipes/ground.ts`): textura de baja frecuencia, looks con detalles lejos de los
  bordes y una media de L* entre 20 y 50 (ART-6, lo revisa el test; la lava no, brilla).
- Suelos y muros hacen mosaico sin costuras (el test lo comprueba).
- Las criaturas proyectan sombra, como las de Dungeon Crawl (ver abajo).
- Todo determinista: ruido con semilla, nunca `Math.random`.
- Ciclos de animación: frames `<sprite>/<acción>_<dir>_<n>` (ver "Sprites animados"). El
  jabalí y el ciervo tienen un trote de 4 frames mirando a la izquierda (`walk_w_0..3`,
  `TROT` en `recipes/creatures.ts`): las patas van en pares diagonales.
- Efectos de casilla (`sprites/effects/<nombre>/<n>.png`, `recipes/effects.ts`): tiras de 6
  frames de 32x32 con fondo transparente, una por `effect_id` del servidor; el cliente las
  reparte en partes iguales sobre 600 ms (`client/CLAUDE.md`, "Sprites de efectos"). Los
  frames de una tira comparten semilla, así cada partícula sigue su trayectoria; el último
  frame ya casi vacío, para que el efecto no se corte de golpe. Ningún `data/` los nombra.

Para revisar: `node --experimental-strip-types tools/spritegen/src/cli.ts preview --out
shot.png --scale 4 [--only ground/]` (suelos y muros repetidos 3x3, el resto sobre pasto;
con `--only effects/`, cada tira en su fila sobre el jabalí parado).
Revisa a 1x además de a 4x: un item que solo se entiende ampliado no se entiende en el
inventario.

### Sombra de las criaturas
Los monstruos de Dungeon Crawl traen pintada una sombra proyectada casi negra, hacia abajo
a la derecha y desde los hombros. Para que las criaturas propias se vean igual en el mapa,
spritegen agrega la misma sombra a toda receta `kind: creature`: monstruos y cada frame de sus ciclos. La dibuja `castShadow` de `tools/spritegen/src/draw.ts`, como último paso
de `render`:
- empuja la silueta hasta 3 px a la derecha y 1 px hacia abajo, con todos los pasos
  intermedios, para que nunca quede un trozo de sombra suelto (por ejemplo, el de un carcaj);
- pinta solo píxeles transparentes, desde el 40 % de la altura de la figura hacia abajo;
- usa el color `SHADOW` (casi negro y opaco, como todo en un sprite).

Una receta puede ajustarla con `shadow: { dx, dy, from }`.

Se hace en spritegen y no en el renderer por tres razones:
- los PNG de `vendor/` no se tocan, así que no se les puede quitar la sombra que traen;
- una sombra del renderer se sumaría a esa, y las de Dungeon Crawl tendrían dos;
- así cada criatura tiene una sola sombra, pixel-perfect, y el renderer no cambia.

Los personajes de LPC no traen sombra: los dibuja el renderer con la sombra de contacto
(`shadow: ellipse`, una elipse de 20x6 al 35 % bajo los pies, ART-5), que no tiembla con
los frames.

### Iconos de interfaz (`ui/`)
`tools/spritegen/src/recipes/ui.ts` dibuja iconos del cliente que ningún archivo de
`data/` nombra: rutas `ui/<grupo>/<id>`, `kind: ui`. `spritegen check` los acepta sin
referencia. El atlas trabaja en múltiplos de 32, así que son de 32x32 con el dibujo dentro
de `UI_ICON_BOX` (12x12 en el centro). El cliente recorta esa caja: `MARK_BOX` en
`client/src/render/marks.ts`, y un test exige que las dos coincidan.

Hoy son las marcas PvP `ui/marks/{aggressor,murderer,outlaw}`:
- agresor: espadas cruzadas, ámbar;
- asesino: una gota de sangre, carmesí;
- proscrito: un escudo partido, violeta.

Son mapas de píxeles hechos a mano, con un contorno casi negro por fuera. Cada marca tiene
su propia silueta, para que se distinga también sin color. El canvas las dibuja junto al
nombre a 1 píxel de pantalla por píxel del sprite (como el texto de 12 px), y la lista de
batalla las usa como fondo CSS. Sin el sprite en el atlas, vuelven las formas de antes.

## Arte y música hechos con Gemini (desde el 2026-11-17)
Desde el 2026-11-17 el dueño permite arte y música generados con **su** cuenta de Gemini
(la app web, la misma que usa en Ants of Neque). Las herramientas están en `tools/gemini`
(`tools/CLAUDE.md`, "gemini") y las reglas son estas:
- **El prompt describe nuestro contenido**: qué es (un puerto al atardecer, un lobo que
  trota hacia el sur) y cómo suena o se ve, nunca a qué se parece. **Nunca nombra otro
  juego, artista, compositor ni obra**, ni pide "al estilo de" o "inspirado en". Las
  herramientas se niegan a enviar un prompt así (`tools/gemini/prompt_guard.py`).
- **Una referencia (`--ref`) es solo un archivo commiteado en `assets/`, ya acreditado**
  (arte propio o de un pack de `CREDITS.md`). Lo que se sube es parte del pedido tanto
  como el texto, y con `--edit` se pide algo parecido: un sprite o un audio de terceros
  (y menos de Tibia u otro juego) nunca se manda. Los drivers rechazan otra ruta; el
  sidecar guarda la ruta y el sha256, y `credit.py` los escribe en el archivo de prompt y
  en la fila (y no acredita si la referencia ya no está en el repo tal como se mandó).
- **Cada archivo que se usa queda registrado** en `CREDITS.md`, sección "Generado con
  IA": los archivos, la herramienta (Gemini, app web de la cuenta del dueño, y el modo),
  la fecha y un **archivo de prompt commiteado** en `assets/prompts/<ruta del asset sin
  "assets/" ni extensión>.txt` con el prompt exacto (para los frames de una hoja, uno solo
  con el nombre del sprite). `python tools/gemini/credit.py <sidecar.json> --asset <ruta>`
  escribe ese archivo e imprime la fila.
- **Se acredita a Gemini como herramienta** y no se presenta como hecho a mano (Google no
  reclama la propiedad de lo generado, y su política pide no ocultar el origen). Un
  archivo de Gemini no entra en las filas de "Obra propia" (que son de spritegen y
  soundgen): si reemplaza uno de ellos, esa fila lo excluye.
- **Nada llega a `assets/` sin que alguien lo mire o lo escuche.** Todo sale primero a
  `build/gemini/` (no se commitea).

Arte, de la hoja al sprite:
1. `python tools/gemini/gemini_web.py image "<prompt>" --name wolf_walk_s [--ref assets/sprites/....png]`
   deja `build/gemini/art/wolf_walk_s.png` y su `.json`. Al prompt se le suman las reglas
   de la casa (`HOUSE_RULES`): fondo magenta plano, grilla pareja sin textos, 3/4 frontal,
   luz desde arriba a la izquierda, contorno oscuro del color local, colores apagados, y
   nada magenta, rosa, púrpura ni violeta en el sujeto (la clave por tono se los lleva).
2. `python tools/gemini/import_art.py build/gemini/art/wolf_walk_s.png --grid 4x1 --size 32
   --layer creature --prefix walk_s` deja en `build/gemini/import/wolf_walk_s/` los frames
   en nuestra grilla (vecino más cercano), con la paleta de spritegen dentro de la banda
   de ART-6 de su capa, el contorno oscuro (en criaturas, personajes, objetos y muros; los
   suelos y los efectos no llevan) y alfa 0 o 255, más `_preview.png` (mirarlo con Read) e
   `import.json`.
3. Los frames buenos se copian a `assets/sprites/` con los nombres de ANI-4
   (`<sprite>/<acción>_<dir>_<n>.png`), `make sprites STRICT=1`, y `credit.py`.

Música, del MP4 al loop:
1. `python tools/gemini/music_queue.py run` pide los temas de `tools/gemini/music_slots.json`
   uno a la vez (o `music_web.py ask` uno suelto) y deja `build/gemini/music/<tema>_<n>.mp4`
   con su `.json`.
2. Se escuchan, y el elegido pasa por `python tools/gemini/music_convert.py
   build/gemini/music/<tema>_<n>.mp4`: sin fades, cerrado en bucle con un crossfade de la
   cola sobre la cabeza, a -14 LUFS (el nivel de la música que ya tiene el juego) y en
   Ogg Opus, con la costura medida después de
   codificar (`build/gemini/convert/<tema>_<n>.ogg` y su `.json`).
3. El dueño elige en `build/music-gemini/picks.json` y `make music-gemini` lo pone en el
   juego con sus créditos ("La música de Gemini", arriba). El presupuesto se respeta sin
   subirlo: mono, 20 kbps y loops de ~1 minuto (un tema entero de ~3 min pesaría ~650 KB
   en estéreo a 32 kbps y ocuparía ~33 MB decodificado).

## Atlas generado
`make sprites` escribe en `assets/atlas/`:
- `atlas.json`: índice para cliente y editor: `tileSize`, lista de páginas y, por sprite,
  `{page, origin}` con `origin` = `file | vendor | placeholder | auto` (un frame compuesto
  de capas de un pack es `vendor`). `anims`: las animaciones y pistas (ver "Sprites
  animados"). `tiles`: el arte del mapa de cada sprite (ver "Arte del mapa").
- `atlas-N.png` + `atlas-N.json`: páginas de hasta 2048x2048 en formato Spritesheet de
  PixiJS (hash). Las claves de `frames` son las rutas lógicas. Cada página lista a las
  demás en `meta.related_multi_packs`.

La salida es determinista: mismo input, mismos bytes. Para revisar el atlas con Read:
`node --experimental-strip-types tools/spritepack/src/cli.ts preview --scale 6 --out shot.png`.

## Integrar un pack de terceros (checklist)
1. Copia el pack sin modificar a `assets/vendor/<pack>/` (nombre en minúsculas, sin
   espacios) junto con su texto de licencia como `LICENSE` o `LICENSE.txt`.
2. Agrega una fila a `CREDITS.md` con autor, licencia (CC0, CC-BY 3.0/4.0, OGA-BY 3.0 o,
   desde el 2026-11-17, CC-BY-SA 3.0/4.0), URL de origen y la carpeta
   `` `assets/vendor/<pack>/` ``. Sin esa fila spritepack rechaza el pack. Si el pack trae
   licencia por archivo, mira "Packs con licencia por archivo" abajo. La fila sale también
   en la página `/credits` del sitio: agrega `site.credits.pack.<pack>.title` y `.author` (guiones como `_`)
   en `i18n/es/site.yaml` y `i18n/en/site.yaml` (`client/vite/credits.test.ts` lo exige).
3. En `sprites.yaml`, cambia `placeholder` por `source` en cada sprite que el pack cubra:
   ```yaml
   weapons/iron_sword: { source: vendor/<pack>/items.png, tile: [4, 2] }   # columna, fila (32 px)
   decor/oak_tree: { source: vendor/<pack>/trees.png, rect: [0, 64, 64, 64] }  # x, y, w, h
   creatures/wolf: { source: vendor/<pack>/wolf.png }   # imagen completa
   ```
   Ancho y alto deben ser múltiplos de 32. Si el pack es de 16x16, no lo uses tal cual:
   los tiles del juego son de 32x32 (`docs/00-vision.md`); reescalarlo es una decisión a
   consultar con el usuario.
4. `make sprites` y revisa la imagen con Read; `make test` comprueba que todo sprite de
   `data/` sigue resolviéndose.

### Packs con licencia por archivo (Liberated Pixel Cup)
Los packs de LPC no tienen una licencia para todo el pack: cada archivo trae la suya en el
`CREDITS.csv` del Universal LPC Spritesheet Character Generator o en los `Credits.txt` de
LPC Revised. Repositorios y detalle en `docs/17-direccion-de-arte-y-ui.md` (SRC-2 y SRC-3).
1. Anota el commit de origen.
2. Copia solo los archivos con una licencia aceptada (CC0, CC-BY, OGA-BY, CC-BY-SA). Si un
   archivo tiene varias, elige una aceptada. Si solo tiene GPL o no tiene fila, no entra.
   Del repo del generador se copia arte, nunca código (es GPL-3.0).
3. Respeta las rutas del origen dentro de `assets/vendor/<pack>/`. Deja al lado un
   `LICENSE.txt` con el texto de cada licencia que aparece y el subconjunto de créditos de
   lo copiado (`CREDITS.csv` solo con esas filas, o los `Credits.txt`).
4. La fila de `CREDITS.md` dice "por archivo" en la licencia, remite a ese archivo de
   créditos y pone la URL con el commit.
5. Lo que una herramienta propia derive de esos archivos (capas compuestas, recoloreados)
   va en `assets/sprites/derived/<pack>/`, con una fila en "Obras derivadas de terceros"
   de `CREDITS.md`. Lleva la licencia del origen: un derivado de CC-BY-SA sigue siendo
   CC-BY-SA. Los sprites que spritepack compone desde capas (`animations`) van nombrados uno
   por uno en la fila de su licencia; `make test` la calcula desde `CREDITS.csv` (la capa más
   restrictiva) y falla si no coincide (`tools/spritepack/src/licences.ts`).

## Fuentes (OFL)
Las fuentes de la interfaz son OFL 1.1 y van auto-alojadas: la CSP de escritorio solo
deja `font-src 'self'`. Las elegidas y sus rutas en `https://github.com/google/fonts` están
en `docs/17-direccion-de-arte-y-ui.md` (UI-3).
- `assets/vendor/font-<familia>/`: los `.ttf` tal como están en google/fonts, su `OFL.txt` y
  una copia como `LICENSE.txt` (el validador busca un archivo que empiece por `LICENSE`).
- Una fila en la tabla "Fuentes" de `CREDITS.md`: el copyright de la primera línea del
  `OFL.txt`, OFL 1.1 y la URL de la carpeta con el commit.
- Los woff2 recortados que usa el cliente los genera `client/vite/fonts.ts` (tabla `FONTS`:
  una fila por archivo, con su `@font-face` en `client/src/ui/fonts.css`) al servirlos en
  `/fonts/` y en el build, y no se commitean. Recortar
  o convertir es crear una versión modificada: no se hace con las familias que declaran un
  "Reserved Font Name" en su `OFL.txt`.
