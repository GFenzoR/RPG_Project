# assets/

| Ruta | Qué es | ¿Se commitea? |
|---|---|---|
| `sprites.yaml` | Manifiesto: de dónde salen los píxeles de cada sprite de `data/` | Sí |
| `sprites/<ruta>.png` | Arte propio del proyecto (32x32 o múltiplos de 32) | Sí |
| `vendor/<pack>/` | Packs de terceros tal como se bajaron, con su archivo `LICENSE` | Sí |
| `CREDITS.md` | Registro de licencias de todo lo que hay en `vendor/` | Sí |
| `atlas/` | Salida de `make sprites` (`atlas.json`, `atlas-N.png/json`) | No (generado) |

## Sonido (T3.7)
| Ruta | Qué es | ¿Se commitea? |
|---|---|---|
| `sounds.yaml` | Manifiesto: archivo y canal de cada sonido, eventos → sonidos, loops por isla | Sí |
| `sounds/{sfx,ui,music,ambient}/*.ogg` | Obra propia (CC0) generada por `make sounds` (`tools/soundgen`) | Sí |

- Todo lo de `sounds/` sale de recetas en código (`tools/soundgen/src/sfx.ts` y
  `music.ts`): osciladores, ruido, envolventes y una cuerda pulsada (Karplus-Strong). Las
  progresiones y melodías son propias. `make sounds` las vuelve a renderizar y las
  encoda a Ogg Opus con **ffmpeg** (libopus); `make sounds ONLY=sfx/hit` regenera una
  sola. Los `.ogg` se commitean: el build, la CI y el juego no necesitan ffmpeg.
- El render es determinista (mismos samples con la misma receta). Los bytes del `.ogg`
  pueden variar entre versiones de libopus: es normal ver diffs binarios al regenerar.
- Presupuesto de tamaño en `docs/07-performance-budget.md`, "Audio".

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
- Objetos más altos que una casilla (árboles, carteles) pueden medir 64x64 o 32x64: el
  renderer los ancla en la esquina inferior derecha de su casilla y crecen hacia arriba y a
  la izquierda. Items de inventario: 32x32 centrados con fondo transparente.
- Suelos y muros hacen mosaico sin costuras (el test lo comprueba).
- Las criaturas proyectan sombra, como las de Dungeon Crawl (ver abajo).
- Todo determinista: ruido con semilla, nunca `Math.random`.
- Efectos de casilla (`sprites/effects/<nombre>/<n>.png`, `recipes/effects.ts`): tiras de 6
  frames de 32x32 con fondo transparente, una por `effect_id` del servidor; el cliente las
  reparte en partes iguales sobre 600 ms (`client/CLAUDE.md`, "Sprites de efectos"). Los
  frames de una tira comparten semilla, así cada partícula sigue su trayectoria; el último
  frame ya casi vacío, para que el efecto no se corte de golpe. Ningún `data/` los nombra.

Para revisar: `node --experimental-strip-types tools/spritegen/src/cli.ts preview --out
shot.png --scale 4 [--only ground/]` (suelos y muros repetidos 3x3, el resto sobre pasto;
con `--only effects/`, cada tira en su fila sobre un jugador parado).
Revisa a 1x además de a 4x: un item que solo se entiende ampliado no se entiende en el
inventario.

### Sombra de las criaturas
Los monstruos de Dungeon Crawl traen pintada una sombra proyectada casi negra, hacia abajo
a la derecha y desde los hombros. Para que las criaturas propias se vean igual en el mapa,
spritegen agrega la misma sombra a toda receta `kind: creature`: monstruos, NPCs y cada
frame de outfit. La dibuja `castShadow` de `tools/spritegen/src/draw.ts`, como último paso
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

Si algún día se integra un pack de criaturas sin sombra, la decisión se toma ahí. Por
ejemplo, con una receta que la agregue sobre el recorte del pack.

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

## Atlas generado
`make sprites` escribe en `assets/atlas/`:
- `atlas.json`: índice para cliente y editor: `tileSize`, lista de páginas y, por sprite,
  `{page, origin}` con `origin` = `file | vendor | placeholder | auto`.
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
   licencia por archivo, mira "Packs con licencia por archivo" abajo.
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
   CC-BY-SA.

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
