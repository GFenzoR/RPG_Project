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
| `sounds.yaml` | Manifiesto: archivo y canal de cada sonido, eventos → sonidos, ambiente por isla, y la música: las pools de temas de cada lugar (islas, cuevas, título, jefes), las medidas de cada tema y los tiempos del director | Sí |
| `sounds/{sfx,ui,music,ambient}/*.ogg` | Obra propia (CC0) generada por `make sounds` (`tools/soundgen`) | Sí |
| `livingworld/sounds/ambience/*.ogg` | Obra propia (CC0) generada por `make sounds` (`tools/soundgen`, `src/ambience.ts`): el ambiente posicional del mundo vivo | Sí |
| `livingworld/sounds/steps/<sonido>_<n>.ogg` | Obra propia (CC0) generada por `make sounds` (`tools/soundgen`, `src/steps.ts`): una pisada por superficie (pasto, pasto alto, tierra, arena, arena mojada, ceniza, piedra, madera, nieve, barro, agua baja), tres tomas de cada una, todas a la misma sonoridad | Sí |
| `sounds/music/gemini/<lugar>_<toma>.ogg` | Música elegida por el dueño entre las tomas de Gemini ("Generado con IA" en `CREDITS.md`), temas enteros en estéreo escritos por `make music-gemini` | Sí |
| `sounds/music/gemini.yaml` | Qué tiene cada lugar: la toma, varias tomas o `none`, las versiones extra de cada lugar, con fuente, título y medidas (puntos de entrada) | Sí (lo escribe `make music-gemini`) |

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
Volcán, Cuevas, combate y el guardián de la forja), más seis versiones de cueva pedidas
el mismo día (`cave_mine`, `cave_crystal`, `cave_flooded`, `cave_abyss`, `cave_ossuary`,
`cave_ember`) y, desde el 2026-11-25, dos versiones más por lugar en el mismo estilo
(`versions` de `music_slots.json`: `title_vigil`, `bosque_mist`...). Las tomas están fuera de git, en `build/music-gemini/<lugar>_<n>.mp4` con su
sidecar (la tercera de Puerto es `probe_1.mp4`), y las elecciones en
`build/music-gemini/picks.json`:
```json
{"picks": {"title": "1", "town_puerto": ["1", "2", "3"], "volcan": "2", "combat": "off",
           "cave": "1", "cave_pool": ["mine", "crystal", "ember"]}}
```
- **Una toma** (`"1"`, `"2"`, `"3"`) suena en su lugar. **Varias** (una lista) entran
  todas: la primera es el sonido del lugar (`music_puerto`), las demás sonidos propios
  (`music_puerto_2`, `music_puerto_3`), y todas forman la pool del lugar en `sounds.yaml`
  (`music.pools.town_puerto`), que el director de música baraja.
- **Las versiones de un lugar** (`<lugar>_pool`: `cave_pool`, `bosque_pool`, `title_pool`,
  `town_puerto_pool`, `volcan_pool`, `boss_forge_pool`; cada nombre como `"mine"`,
  `"cave_mine"` o `"cave_mine_1"`) se suman a la pool del lugar después de su toma
  (`music_cueva_mine`, `music_bosque_mist`...). Mientras el dueño no escriba esa clave,
  entran las de `Slot.extras` de `music_import.py` (las seis de cueva del 2026-11-18 y, de
  las del 2026-11-25, las que caben en el presupuesto de docs/07) que pasan las medidas
  (`music_convert.piece_problems`: tema entero de 2 minutos o más, volumen medible, ningún
  hueco de silencio de más de 6 s, al menos dos puntos de entrada), marcadas
  **provisionales** (en el manifiesto y en su fila de `CREDITS.md`); las que no pasan quedan
  en `skipped` con el motivo.
- **Un lugar sin elegir** suena con su toma 1, marcada `provisional`.
- **`none` u `off`** deja lo que sonaba antes de Gemini: el tema de soundgen de ese lugar
  (`puerto`, `bosque`, `volcan`, `cueva`: por eso siguen en el repo con sus recetas), o
  nada propio donde no había (título, jefe: sigue la música de la zona). **El combate solo
  acepta `none`/`off`**: el dueño no quiere música para peleas comunes (2026-11-18).

Para cambiar una elección: editar `picks.json` y correr **`make music-gemini`** (con
`FROM=<carpeta>` si las tomas están en otro lado). Hace todo de nuevo desde las elecciones:
convierte cada toma **entera** con `music_convert.py` (`loop=False`: nada se corta, una
sola ganancia hacia -14 LUFS sin pasar -1,5 dBTP, Ogg Opus **estéreo a 48 kbps**, 40 las
cuevas; una toma ya convertida con los mismos ajustes no se vuelve a convertir) y mide
dónde puede empezar (`entries`: donde empieza una frase según la envolvente de nivel, a
15 s o más uno de otro, nunca en el segundo 0 ni en los últimos 30 s del cuerpo), dónde
termina su cuerpo (`end`: empieza el final compuesto) y su hueco más largo. Después la copia
a `sounds/music/gemini/`, reescribe sus líneas de `sounds.yaml` (sonidos con `seconds`,
`end` y `entries`, pools, título y jefes, entre las marcas `# gemini-music:…`), el archivo
de prompt de cada toma (`assets/prompts/sounds/music/gemini/`), sus filas de `CREDITS.md`
y `sounds/music/gemini.yaml`, borra lo que ya no se usa y al final revisa el presupuesto
(`tools/soundgen check`, que ahora suma también cada pool). Los masters de Gemini vienen
calientes (picos de +1,5 a +5 dBTP): donde el techo de pico deja una toma bajo -14 LUFS, el
volumen de `sounds.yaml` devuelve la diferencia hasta 1 (`volume_for`; el medidor lee un
archivo mono como dos parlantes, así que un tema estéreo y uno mono de soundgen al mismo
LUFS suenan igual). Después: `make test` (el test de soundgen compara el manifiesto con
`sounds.yaml`, las pools, las filas y la carpeta), `make validate` y escucharlo con
`make play`.

**Cómo suena en el juego** (el director de música, `client/src/audio/director.ts`; reglas
en `docs/02`, "Sonido"): cada tema se transmite (no se decodifica entero, docs/07 "Audio"),
empieza en un punto de entrada al azar, nunca se repite dos veces seguidas, y los cambios
de lugar son fundidos de potencia constante con su largo según qué cambió.

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
`<sprite>/<acción>_<dir>_<n>` (ANI-4): `acción` es `idle`, `walk`, `attack` (cuerpo a
cuerpo), `shoot` (a distancia), `cast` (conjurar) o `death`, `dir` es `n`, `e`, `s` o `w`, y
`n` arranca en 0. Hay tres maneras de tenerlos:
1. **Capas de un pack** (`animations` con `layers`): spritepack compone las hojas en orden
   (abajo primero), recolorea con `palettes` y corta los frames. Así salían los personajes
   de LPC (`vendor/ulpc`, hasta el 2026-11-19: los reemplazó el humanoide del motor).
2. **Arte propio con esos nombres** en `sprites/` (por ejemplo, del motor de spritegen:
   `sprites/creatures/bristleback_boar/walk_s_0.png` a `death_w_4.png`, o las hojas de
   Gemini de "Arte y música hechos con Gemini": `sprites/creatures/wolf/`). spritepack arma
   los clips solo: por acción, las direcciones que tienen frame 0 y tantos frames como
   tengan todas sin huecos. Si no hay `sprites/<sprite>.png` ni entrada en `sprites`, el
   nombre del sprite es un alias de su primer frame (quieto o caminar, hacia el sur).
3. **Ninguno:** el sprite único se anima por código (ANI-5). Una entrada de `animations`
   sin `layers` le da pistas.

```yaml
palettes:                                  # colores de claro a oscuro
  ulpc_cloth: ["#ffffff", "#e5e6c7", "#c4b59f", "#958080", "#4d4a5d"]   # base de las hojas ULPC
  cloth_navy: ["#7c96c4", "#5a76a8", "#435a87", "#304064", "#1d263e"]   # propia
animations:
  outfits/sailor:
    preset: lpc                            # hojas ULPC: idle, walk, slash, shoot, spellcast, hurt
    actions: [idle, walk]                  # opcional: un subconjunto del preset (NPCs)
    layers:                                # "<sheet>" = la hoja de cada acción
      - vendor/ulpc/spritesheets/body/bodies/male/<sheet>.png
      - { file: vendor/ulpc/spritesheets/legs/pants/male/<sheet>.png, recolor: { ulpc_cloth: cloth_navy } }
  creatures/hollow_crawler: { facing: left }   # pistas para un sprite de un solo frame
  creatures/wolf: { mirror: true, anchor: bc, shadow: ellipse, ms: { attack: 110, death: 200 } }   # frames de archivos
```
- **Preset `lpc`** (`tools/spritepack/src/anims.ts`, `PRESETS`): frames de 64x64, filas
  norte, oeste, sur y este. `idle` = 2 frames de 500 ms; `walk` = columnas 1 a 8 (la 0 es
  la pose quieta), 4 frames por casilla; `attack` = `slash`, 6 de 60 ms; `shoot` = `shoot`
  (el arco), sus 13 columnas tomadas de a una sí y una no (`step: 2`): 7 de 50 ms; `cast` =
  `spellcast`, 7 de 60 ms; `death` = `hurt`, 6 de 100 ms y solo hacia el sur (las otras
  direcciones usan esa). Un monstruo lista en `actions` solo las que usa: sus ataques de
  `data/monsters` (`distance` juega `shoot`, `spell` juega `cast`); los NPCs, `idle` y `walk`.
  El cliente elige el clip por `CreatureAttack.kind` (docs/17 ANI-2) y, si el sprite no lo
  tiene, juega `attack`.
- **Sin preset**, cada acción se describe entera:
  `walk: { sheet: walk, frame: [64, 64], rows: { n: 0, w: 1, s: 2, e: 3 }, col: 1, count: 8, per_tile: 4 }`
  (`ms` para las demás acciones; `step`, columnas de un frame al siguiente, 1 por defecto).
- **`recolor`** cambia cada color de la paleta de origen por el del mismo lugar de la de
  destino (mismo largo). Los píxeles de las capas quedan con alfa 0 o 255: lo que tiene
  menos de la mitad de opacidad se descarta.
- **Pistas** (con o sin capas): `facing: left | right` (hacia dónde mira el dibujo: se
  espeja para ir al otro lado), `flying: true` (flota, su sombra se achica, no salta),
  `shadow: baked | ellipse | none`. Con capas, la sombra por defecto es `ellipse` (la sombra
  de contacto del renderer, ART-5: los frames de LPC no traen sombra); sin capas,
  `baked` (Dungeon Crawl y spritegen la pintan).
- **Pistas de frames de archivos** (solo sin capas, y solo si el sprite tiene frames en
  `sprites/<sprite>/`; si no, error; `trim`, `per_tile` y `per_tile_ns` en "Humanoides del
  motor", abajo):
  - `mirror: true` (ANI-1): en cada acción con frames al oeste y ninguno al este (o al
    revés), spritepack agrega los del otro lado espejados (`<sprite>/walk_e_<n>`, origen
    `file`). Un lado que ya tiene frames nunca se pisa. Para criaturas sin nada en un solo
    brazo; con `mirror` no se usa `facing` (los dos lados tienen frames);
  - `anchor: br | bc` (por defecto `br`): `bc` para frames de 64x64 o que no llenan la
    casilla: los pies van a `FEET_LINE`, medidos en los frames de caminar;
  - `ms: { idle: 500, attack: 110, death: 200 }`: ms por frame de cada acción que se juega
    por tiempo (sin esto, 500 quieto, 60 atacar y conjurar, 50 disparar y 100 morir;
    caminar va por distancia). Un `ms` de una acción
    sin frames es error.
- **Quieto y atacar solo hacia sus lados** (`OWN_FACINGS`, `packages/renderer/src/anim.ts`):
  una criatura que mira hacia un lado sin frames de `idle` o de `attack` no toma los de
  otro lado: usa el frame parado de esa dirección (el 0 de caminar) y, al atacar, la
  embestida de ANI-5. Así un mordisco dibujado solo de perfil no hace girar al lobo cuando
  muerde hacia el sur. Caminar y morir siguen tomando el sur (o la primera dirección).
- **Alias:** el nombre del sprite (`outfits/sailor`) apunta a su primer frame quieto (para
  las referencias de `data/`, los íconos y la tienda del sitio), y los frames viejos de un
  atuendo (`outfits/sailor/s_0`, `e_2`, T0.5) a la pose quieta y al ciclo de caminar.
  Comparten el rectángulo del atlas: no ocupan lugar.
- **Errores** (`make sprites`): una animación con capas no puede pisar un sprite que ya
  existe (archivo o entrada de `sprites`); una entrada con pistas tiene que nombrar uno que
  exista; falta una hoja o es más chica que lo que piden la acción y sus filas; `mirror`,
  `anchor` o `ms` con capas o sin frames de archivos.
- **atlas.json** suma `anims`: por sprite, `w`, `h`, `anchor` (`bc` con capas: los pies
  sobre la casilla; `br`, el de siempre), `foot` (filas vacías bajo los pies), `top` (alto
  del dibujo), `shadow`, `facing`, `flying` y por acción `frames`, `ms`, `perTile` y `dirs`.
  `foot` y `top` se miden en los frames de caminar.
- **Revisar:** `node --experimental-strip-types tools/spritepack/src/cli.ts preview --page 1
  --scale 2 --out shot.png` muestra la página donde caen los personajes. Mirarlos a 1x y a
  2x con Read, y en el juego (screenshots del E2E).

### Humanoides del motor: el muñeco de capas (docs/17 "Humanoides del motor")
Jugadores, NPCs que son personas y monstruos humanoides son arte propio del motor de
spritegen (`tools/spritegen/src/engine/specs/humanoid/`): `sprites/humans/body_<cuerpo>`,
`humans/hair_<peinado>`, `humans/beard_<barba>` y `sprites/worn/<lugar>_<forma>` (el torso
por cuerpo: `worn/torso_<forma>_<cuerpo>`), con frames `<acción>_<dir>_<n>` de 64x64 en un
tono neutro que el cliente tiñe (`data/looks.yaml`, docs/06 "Looks"). Cada capa tiene su
entrada de `animations` con pistas de frames de archivos:
```yaml
  humans/body_sturdy: { anchor: bc, shadow: ellipse, trim: true, per_tile: 8, per_tile_ns: 13.86, ms: { ... } }
  worn/weapon_sword: { anchor: bc, shadow: none, trim: true, per_tile: 8, per_tile_ns: 13.86, ms: { ... } }
```
- `shadow: none` en las capas: la sombra de contacto es la del cuerpo.
- `trim: true`: cada frame va al atlas recortado a su caja opaca (`trimmed`,
  `spriteSourceSize` y `sourceSize` en el JSON de la página; PixiJS lo ubica como el frame
  entero); un frame vacío queda de 1x1. Son 3612 frames: enteros serían 3,5 páginas, así
  ocupan 0,15 (docs/07).
- `per_tile` y `per_tile_ns`: frames de caminar por casilla (`perTile` y `perTileNS` del
  clip) al este y al oeste, y al norte y al sur (la regla de la zancada de docs/17).
- `spritegen check` exige que estas pistas sean las del rig. `data/looks.yaml` nombra cada
  capa (spritepack la cuenta como usada por `data/`).
- `sprites/outfits/<atuendo>/<dir>_0.png` y `sprites/npcs/<npc>.png` son quietos compuestos
  de las capas (la tienda, el retrato del diálogo y el respaldo del cliente).

## Arte del mapa: looks, frames, muros, sombras y luz (docs/17 ART-3 a ART-7)
Un sprite que `data/` pone en el mapa (suelo o item) puede tener partes al lado, que
spritepack encuentra por nombre (arte propio o entradas de `sprites.yaml`):

| Parte | Qué es | Quién la usa |
|---|---|---|
| `<sprite>/var_<n>` (n = 1..) | Otro look del suelo; el sprite es el look 0 | El renderer elige uno por casilla con `groundLook` (docs/17 ART-4: zonas que tiran a looks vecinos, nunca el mismo look alternativo en dos casillas de lado), el 0 en la parte `weight` |
| `<sprite>/decal_<n>` (n = 1..) | Un detalle suelto de un suelo (una concha, una flor), transparente, chico y en el centro | El renderer lo pone plano sobre unas pocas casillas (`groundDecal`), solo donde las cuatro vecinas son del mismo suelo; no es un item |
| `<sprite>/frame_<n>` (n = 1..) | Otro frame de un suelo o item animado; el sprite es el frame 0 | `MapView` los avanza con el reloj; `mapcli render` muestra el 0 |
| `<sprite>/wall_<m>` (m = 0..15, las 16) | La pieza de muro para cada máscara de vecinos muro (N=1, E=2, S=4, O=8), de 32x64 | El renderer pone en cada casilla la de sus vecinos |
| `<sprite>/shadow` | Su sombra proyectada, en negro, del tamaño del sprite | La capa de sombras, teñida y translúcida, entre el suelo y los items |

Lo que los nombres no dicen va en la sección `tiles` de `sprites.yaml`:
```yaml
tiles:
  ground/water_shallow: { ms: 240, sync: world }   # ms por frame y sincronía
  decor/oak_tree: { anchor: bc, particles: pollen }   # centrado en su casilla
  plants/jungle_palm: { anchor: bc, wind: { kind: palm, pivot: 30 } }   # planta de un pack: su viento ("Plantas y viento")
  decor/wall_torch: { ms: 110, sync: tile, light: 3 }   # da luz en cuevas (radio en casillas)
  doors/forge_gate: { joins_walls: true }   # los muros de al lado lo cuentan como muro
  ground/lava: { ms: 280, sync: world, particles: embers }   # partículas de ambiente
  ground/sand: { steps: dust }   # lo que patea cada paso sobre este suelo
```
- `particles` (docs/17 ART-7, A13): `embers` (brasas que suben), `pollen` (polen que flota
  alrededor de un árbol), `spray` (rocío; un suelo `spray` solo emite donde toca otro
  suelo) o `dust` (polvo). El cliente las dibuja (`client/src/render/particles.ts`).
- `steps` (docs/17 MOV-7), solo para suelos: lo que patea cada paso que sale de una casilla
  de ese suelo, a la altura de los pies: `dust` (unas motas de polvo que suben y se
  asientan: arena, tierra, ceniza, senda de escoria) o `ripple` (un anillo de gotas que se
  abre: la arena mojada). Partículas del mismo pool que `particles`.
- Las piezas de muro pueden medir 32x96 (la muralla, `walls/rampart_wall`: cara de 64 px).
  El marco de las puertas de casa (`doors/house_door_frame`) también tiene 16 piezas: el
  renderer lo pone en cada puerta de `houses.yaml` sin que esté en el mapa.
- `sync`: `world` (todas las casillas en fase: agua, lava, espuma), `tile` (una fase por
  casilla: fuego, copas, estandartes) o `random` (un destello cada 3–5 s por casilla). Sin
  entrada: 250 ms y `world`.
- `weight`: la parte de las casillas que muestra el look 0 (por defecto 0,7 en un suelo; en
  un item, las piezas de borde, los looks salen parejos). Los suelos cuyos looks son otros
  corazones de la misma textura (arena, pasto, tierra, ceniza...) la bajan a 0,2-0,35.
- Además del look, el renderer tiñe cada suelo y cada pieza plana con `groundTone` (un
  ruido lento de la posición: zonas un poco más oscuras o más cálidas, docs/17 ART-4).
- `ms` y `sync` sin frames, `weight` sin looks, piezas de muro incompletas o partes sin su
  sprite son errores de `make sprites`.

spritepack escribe lo que tiene cada sprite en `atlas.json` `tiles` (`TileMeta` de
`packages/renderer/src/tile-art.ts`, puro y compartido con `mapcli render`). Los bordes de
piezas de borde (`borders/<suelo>/<pieza>`, 4 looks cada una) y la espuma de la orilla
(`borders/surf/<pieza>`, con 3 frames más en cada look: `<pieza>/frame_<n>` y
`<pieza>/var_<n>/frame_<m>`) las hace `make borders` (`gen-borders`), no spritegen. Un look
de un sprite animado lleva sus propios frames, tantos como el sprite (si no, error de
`make sprites`). Todo sprite de `borders/` (que no sea una de esas partes) lleva `flat`: el
renderer lo dibuja con los suelos, bajo las sombras, los items y las criaturas.

## Plantas y viento (lote 20; `livingworld/README.md` "Viento")
Árboles, arbustos, hierba, juncos, flores y enredaderas se mecen con el viento del mundo
vivo: el cliente corta el sprite en tiras horizontales y las corre de lado, con la base
plantada. No hay frames de viento que dibujar. Para eso **todo sprite de planta lleva su
metadata de viento**, y `make validate` falla si a un item que es una planta le falta
(o no dice `wind: none` en `data/livingworld/plants.yaml`).

| De dónde viene el sprite | Dónde se declara |
|---|---|
| `tools/spritegen` (receta o spec) | `wind: plantWind("<tipo>", { pivot })` en la receta |
| Un pack, Gemini o hecho a mano (`assets/sprites/<ruta>.png`, o una entrada de `sprites:`) | `tiles:` de `sprites.yaml`: `<ruta>: { wind: { kind: <tipo>, pivot: N } }` (`pivot` obligatorio; opcionales `stiffness`, `amplitude`, `flutter`) |

Tipos: `tree`, `palm`, `bush`, `tall_grass`, `reed`, `flower`, `vine`, `cactus`,
`dead_tree` (sus valores, en `data/livingworld/wind.yaml`). `pivot`: dónde termina el
tronco o el tallo, en px sobre el borde de abajo del sprite; nada se mueve debajo.
`make spritegen` junta las dos fuentes en `data/livingworld/wind_sprites.yaml` (generado:
no se edita) y el cliente lo lee solo.

Cómo dibujar (o elegir) una planta para que se deforme bien; `make spritegen` lo revisa en
todo sprite que tenga su PNG en `assets/`:
- **tronco y copa bien separados**: el tronco visible, menos del 60 % del ancho de la
  copa; el pivot justo donde termina;
- **ningún píxel suelto**: todo unido a la planta (un pétalo flotando quedaría al lado
  mientras se mece);
- **margen a los lados**: 2 o 3 px transparentes a cada lado de la copa (1 como mínimo);
- sin sombra pintada en el sprite: la sombra va aparte (`<sprite>/shadow`) y queda quieta.

Después, `make sway-preview ONLY=<prefijo>` y mirar `build/spritegen/sway.png` con Read.
Al importar de Gemini: `import_art.py ... --layer object --wind <tipo> --pivot N`.

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
  casilla (`anchor: bc`), con la copa en 3/4, sombra proyectada y su metadata de viento
  (sin frames: el cliente mece la copa, "Plantas y viento").
  Items de inventario: 32x32 centrados con fondo transparente.
- Muros (`recipes/walls.ts`): 16 piezas de 32x64 por material, la tapa levantada 32 px
  sobre la cara (ver "Arte del mapa" arriba y docs/17 ART-3).
- Suelos (`recipes/ground.ts`, `recipes/variety.ts`): textura de baja frecuencia, looks que
  conservan el anillo de 1 px del principal y redibujan el corazón (otra semilla, más
  ondas, más grano, más seco...; el test exige el anillo igual), detalles sueltos
  `decal_<n>` chicos y centrados, y una media de L* entre 20 y 50 (ART-6, lo revisa el
  test; la lava no, brilla). Un suelo nuevo de textura continua (nieve, piso de cueva) se
  escribe como `LevelGround` y entra con `levelLooks`.
- Suelos y muros hacen mosaico sin costuras (el test lo comprueba).
- Las criaturas proyectan sombra, como las de Dungeon Crawl (ver abajo), salvo las del
  motor de sprites (jabalí, ciervo y eco de la forja), que se paran sobre la sombra de
  contacto.
- Todo determinista: ruido con semilla, nunca `Math.random`.
- Ciclos de animación: frames `<sprite>/<acción>_<dir>_<n>` (ver "Sprites animados"). Los
  dibuja el motor de sprites a partir de un modelo (abajo, "Sprites del motor").
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

### Sprites del motor (`tools/spritegen/src/engine`, desde el 2026-11-18)
El motor de sprites (docs/17, "Motor de sprites"; cómo escribir un spec y un rig en
`tools/CLAUDE.md`, "spritegen: el motor") dibuja un sprite a partir de un modelo con
volumen y, si es una criatura, de un rig con acciones. Sus reglas de estilo (cámara 3/4,
luz, tonos de `palette.ts`, contorno selectivo, tamaños y anclas de ART-2, frames y
tiempos de ANI-2) están en un solo lugar, `engine/style.ts`.
- **Hoy:** `creatures/bristleback_boar` y `creatures/bramble_stag` (quieto, caminar,
  atacar y morir: 68 frames cada uno), `npcs/forge_echo` (quieto y caminar: 32 frames),
  `decor/anvil`, `decor/cargo_crate` y `decor/signpost` (una imagen) y
  `decor/market_board` (animado: 4 frames), los restos de los monstruos (`decor/remains_*`
  y `decor/creature_remains`) y, desde el lote 11, los íconos de todo el equipo
  (`weapons/`, `shields/`, `armor/`, `jewelry/`, `ammo/`: 86, uno por pieza; docs/17
  "Íconos de items"). El bolardo (`decor/mooring_post`) sigue de `recipes/terrain.ts`: el
  del motor no se leyó mejor.
- **Íconos de items:** la clase `icon` (32x32, la figura centrada en el lienzo, contorno
  oscuro); se revisan en `build/spritegen/icons.slots.png` (en el slot del inventario a 2x
  y 1x y sobre el pasto) e `icons.detail.png` (a 4x), que escribe `spritegen sheet`.
- **Frames:** una criatura tiene `sprites/<sprite>/<acción>_<dir>_<n>.png` en las cuatro
  direcciones, dibujadas desde el modelo (el este no es el oeste espejado: la luz sigue a
  la izquierda), de 64x64 sin sombra pintada. No hay `sprites/<sprite>.png`: el nombre del
  sprite es un alias de su primer frame quieto hacia el sur.
- **Pistas:** su entrada de `animations` dice `anchor: bc`, `shadow: ellipse`, `flying`
  si flota y los `ms` del rig; nada de `facing` ni `mirror`, y ninguna entrada en
  `sprites`. `spritegen check` y `make test` fallan si no coinciden con el spec.
- **Props animados:** un objeto con `loop` en su spec sale como `sprites/<sprite>.png` (el
  frame 0) y `sprites/<sprite>/frame_<n>.png`, como los props animados de
  `recipes/props.ts`, y su entrada de `tiles` en `assets/sprites.yaml` lleva los `ms` y el
  `sync` del loop (`decor/market_board: { ms: 180, sync: tile }`); `spritegen check` lo
  exige.
- **Revisar:** `node --experimental-strip-types tools/spritegen/src/cli.ts sheet --only
  <sprite>` deja en `build/spritegen/` la hoja de contacto (todos los frames a 4x) y el
  lineup (a 1x, sobre su suelo, al lado del lobo y de una persona de LPC). Mirarlas con
  Read, y en el juego (E2E).
- Es obra propia (CC0), como el resto de spritegen: las reglas se aprendieron de las
  referencias de docs/17 §1, pero ningún sprite de otro juego se copió ni se calcó.

### Sombra de las criaturas
Los monstruos de Dungeon Crawl traen pintada una sombra proyectada casi negra, hacia abajo
a la derecha y desde los hombros. Para que las criaturas propias se vean igual en el mapa,
spritegen agrega la misma sombra a toda receta `kind: creature`: monstruos y cada frame de sus ciclos. La dibuja `castShadow` de `tools/spritegen/src/draw.ts`, como último paso
de `render`:
- empuja la silueta hasta 3 px a la derecha y 1 px hacia abajo, con todos los pasos
  intermedios, para que nunca quede un trozo de sombra suelto (por ejemplo, el de un carcaj);
- pinta solo píxeles transparentes, desde el 40 % de la altura de la figura hacia abajo;
- usa el color `SHADOW` (casi negro y opaco, como todo en un sprite).

Una receta puede ajustarla con `shadow: { dx, dy, from }`, o quitarla con `shadow: false`
cuando la criatura se para sobre la sombra de contacto del renderer como los animales
animados (`shadow: ellipse` en `assets/sprites.yaml`): las criaturas del motor de sprites
(docs/17 ART-2, "Animales medianos").

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

Y los slots vacíos del equipo (docs/17 UI-5) `ui/slots/<slot>` (`head`, `neck`,
`backpack`, `armor`, `right_hand`, `left_hand`, `legs`, `feet`, `ring`, `ammo`): un
yelmo, un amuleto, una mochila, una túnica, una espada, un escudo con cruz, un pantalón,
una bota, un anillo y tres flechas. Van dentro de `UI_SLOT_BOX` (20x20 en el centro;
`uiIconBox` dice la caja de cada grupo) y el cliente los muestra enteros, como el ícono de
un item, desvaídos bajo el slot que no tiene nada (`client/src/ui/Inventory.tsx`). Son
máscaras de 20x20 en color hueso, sin contorno: el borde de arriba a la izquierda se
aclara y el de abajo a la derecha se oscurece, como grabados en la piedra.

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

**Criaturas animadas de una sola hoja** (así se hicieron las catorce del 2026-11-18: lobo,
rata de sentina, cangrejo de marea, murciélago lóbrego, araña de musgo, sapo de ciénaga y
espinoso, y en la segunda tanda reptante hueco, escarabajo de mena y los cinco del Volcán;
prompts en `assets/prompts/sprites/creatures/`):
- **El prompt** describe la criatura con nuestros datos (`data/monsters`, su nombre de
  `i18n/`, sus `tags`, `notes`, botín y resistencias: un lobo gris de la costa, una araña
  cubierta de musgo que escupe savia) y pide **ocho filas, cada una una tira**: caminar
  hacia la cámara, de espaldas y de perfil (4 frames cada una), quieto (2 de frente, 2 de
  espaldas, 2 de perfil), atacar hacia la cámara, de espaldas y de perfil (3 cada una) y
  morir de frente (3). "Vista desde arriba y adelante, la cámara a 45 grados" en las de
  frente y espaldas. El perfil se pide **hacia la derecha** (Gemini lo dibuja así aunque se
  pida a la izquierda) y se espeja al importar.
- **Lo que Gemini hace bien y mal** (siete hojas): las filas de caminar y de quieto salen
  casi siempre; los ataques de frente y de espaldas casi nunca (dibuja otro perfil o una
  pose parada) y la cantidad de frames por fila varía. No se pide de nuevo por eso: un
  ataque que falta en una dirección lo hace la embestida de ANI-5 ("Quieto y atacar solo
  hacia sus lados", arriba), o se arma con el frame parado, el de golpe que sí haya y el
  parado otra vez. Una hoja con frames que no son la misma criatura se pide otra vez (dos
  veces como mucho) o la criatura se deja. **Sí se pide otra vez** (segunda tanda, con
  una frase más en el prompt): una fila de frente dibujada de costado ("straight toward the
  camera, head-on ... never turned to the side"), una hoja con líneas de grilla o paneles
  entre los dibujos (no son magenta y el corte las toma por dibujo: "Draw no lines,
  borders, boxes or panels between the frames") y una criatura casi negra que no se leería
  sobre los suelos oscuros (se pide con bordes más claros donde da la luz). Un dibujo con
  algo escrito encima (un "10" en la cabeza del gólem) se descarta con `-`.
- **Una hoja nueva para los ataques que faltan** no sirvió (cangrejo, sapo y espinoso,
  con un frame del juego como `--ref`): Gemini sigue sin dibujar el ataque de frente o de
  espaldas que faltaba y cambia el aspecto (más verde, más liso). No se usó ninguna.
- **El corte** no es una grilla pareja: `--cut rows` toma las filas tal como vinieron
  (cada una en partes iguales si sus dibujos caen una en cada parte, así conserva el
  registro con que se dibujaron; el que se sale de su parte no se corta y el vecino no se
  cuela) y `--cut blobs` cada dibujo suelto, para una hoja en dos paneles o filas torcidas,
  centrado en su masa (una cola o un látigo no corren el cuerpo). Las dos escriben
  `_drawings.png`: la hoja con cada dibujo numerado, contra la que se escribe `--names`
  (`-` descarta uno, `idle_s_0+attack_s_0` lo guarda dos veces). `--mirror` espeja los
  frames de perfil, `--shared-colours` reduce los colores de todos juntos (de a uno, el
  pelaje titilaba entre frames) y `--scale` fija la escala (fuente por píxel) cuando el
  dibujo más ancho, una muerte tendida o unas alas abiertas, achicaría al resto.
  **`--colors 0`** cuando la criatura tiene un brillo chico (grietas de lava, una garganta
  encendida, un horno): reducir los colores de todos juntos a 16 los funde con el marrón
  de al lado; sin límite cada color va directo a la paleta, que tiene el naranja de
  `ember`.
- **El mismo tamaño en cada dirección:** con `--cut blobs` todos los dibujos van a una
  escala, así que un "quieto de espaldas" dibujado más chico que su caminar hace que la
  criatura se encoja al parar. Se mide con las cajas de cada frame (el sabueso: 33 px
  caminando al norte, 24 quieto); si salta mucho, se deja esa dirección sin quieto y la
  criatura se para en el primer frame de caminar.
- **Tamaño** (ART-2, "Animales medianos": al lado de un personaje de LPC de ~46 px, ~25 px
  por metro): rata, cangrejo y escarabajo en 32x32; lobo, araña, sapo, murciélago,
  espinoso, reptante, sabueso, salamandra, gólem y dragoncillo en 64x64 con `anchor: bc`
  (el lobo mide ~39 px de largo, el sabueso ~40, el gólem ~50 de alto); el jefe del Volcán
  en 96x96 (~77 px de alto). Todos con `shadow: ellipse` y `mirror: true`. La escala se
  elige con `--scale` mirando el dibujo de perfil (el largo) o de frente (el alto).
- **Revisar** con Read: `_drawings.png`, `_preview.png`, `anim_sheet.py
  assets/sprites/creatures/<c>` y una fila de criaturas sobre pasto armada del atlas; en el
  juego, los screenshots del E2E. Después, `credit.py build/gemini/import/<c>/import.json
  --asset "assets/sprites/creatures/<c>/*.png" --prompt-file
  assets/prompts/sprites/creatures/<c>.txt`: con el `import.json` (y no el sidecar) el
  archivo de prompt suma la hoja que volvió (sha256) y el comando exacto que la cortó.

Música, del MP4 al juego:
1. `python tools/gemini/music_queue.py run` pide los temas de `tools/gemini/music_slots.json`
   uno a la vez (o `music_web.py ask` uno suelto) y deja `build/gemini/music/<tema>_<n>.mp4`
   con su `.json`. Con `--slots <id>,... --takes 1` pide **versiones** (`versions` del mismo
   archivo): otro tema del estilo de un lugar, con su texto y otro instrumento, ánimo o
   tempo, para ampliar su pool.
2. Se escuchan (para probar una conversión suelta: `python tools/gemini/music_convert.py
   build/gemini/music/<tema>_<n>.mp4 --no-loop`, el tema entero a -14 LUFS en Ogg Opus con
   sus puntos de entrada en el `.json`; sin `--no-loop` hace un loop cerrado con crossfade,
   como antes del 2026-11-18).
3. El dueño elige en `build/music-gemini/picks.json` y `make music-gemini` lo pone en el
   juego con sus créditos ("La música de Gemini", arriba): temas enteros en estéreo
   (~1 MiB cada uno), que el cliente transmite. El presupuesto (docs/07 "Audio") se
   revisó para eso el 2026-11-18.

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
