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
   agrega su fila en la tabla de `CREDITS.md` (CC0, CC-BY o OGA-BY). Son las mismas reglas
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
2. Agrega una fila a `CREDITS.md` con autor, licencia (CC0, CC-BY 3.0/4.0, OGA-BY), URL de
   origen y la carpeta `` `assets/vendor/<pack>/` ``. Sin esa fila spritepack rechaza el
   pack.
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
