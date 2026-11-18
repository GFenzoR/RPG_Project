# Créditos de assets

Todo asset de terceros debe tener una entrada aquí antes de usarse en el juego.

**Licencias aceptadas:**
- Arte y sonido: CC0, CC-BY 3.0/4.0 y OGA-BY 3.0. Desde el 2026-11-17, por decisión del
  dueño, también **CC-BY-SA 3.0/4.0** (por ejemplo, Liberated Pixel Cup).
- Fuentes: **SIL OFL 1.1** (desde el 2026-11-17).

**No** se aceptan: assets sin licencia clara, GPL como única licencia del archivo, "no
comercial" (NC), "sin derivados" (ND), "solo uso personal", licencias de tienda que no dejan
redistribuir (el repo es público), ni nada sacado de otros juegos.

Reglas que vienen con eso (detalle en `docs/17-direccion-de-arte-y-ui.md`, "SRC"):
- **Licencia por archivo.** En packs como los de LPC cada archivo trae la suya (`CREDITS.csv`
  o `Credits.txt` del origen): solo entran los archivos con una licencia aceptada. Si un
  archivo tiene varias, se elige una aceptada y la fila lo dice.
- **Atribución.** CC-BY, CC-BY-SA y OGA-BY piden autor, título, licencia y enlace, visibles
  para el jugador. Hoy están en este archivo; la pantalla de créditos del juego y del sitio
  está pendiente (tarea A1 de docs/17).
- **CC-BY-SA.** Lo que se derive de un archivo BY-SA (recoloreado, recortado, combinado)
  sigue siendo BY-SA y va en "Obras derivadas", nunca como obra propia CC0. Una página del
  atlas solo junta sprites: cada uno conserva su licencia, y el código y el arte propio no
  cambian de licencia.
- **DRM.** CC-BY y CC-BY-SA no permiten poner medidas técnicas que restrinjan el material.
  Antes de publicar en tiendas móviles (docs/15), hay que revisar esto. OGA-BY sí lo permite.

`tools/spritepack` solo acepta un pack de `assets/vendor/<pack>/` si tiene una fila aquí
con esa carpeta y un archivo `LICENSE` dentro. `make validate` exige lo mismo para los
sonidos. Las fuentes siguen la misma regla (`assets/vendor/font-<familia>/`, con su
`OFL.txt` copiado como `LICENSE.txt`). Procedimiento completo: `assets/README.md`.

| Pack / archivo | Autor | Licencia | Fuente (URL) | Carpeta | Atribución requerida |
|---|---|---|---|---|---|
| Dungeon Crawl Stone Soup tiles (release Nov-2015) | Artistas de Dungeon Crawl Stone Soup (lista en `ARTISTS.md` del pack) | CC0 1.0 | https://github.com/crawl/tiles (también https://opengameart.org/content/dungeon-crawl-32x32-tiles) | `assets/vendor/dungeon-crawl/` | No (se acredita igual) |

## Obra propia

| Archivos | Autor | Licencia | Fuente reproducible |
|---|---|---|---|
| `assets/sounds/**/*.ogg` (efectos, interfaz, música y ambiente) | Neque's Realm (generado proceduralmente) | CC0 1.0 | `tools/soundgen` (`make sounds`). Recetas y melodías propias, sin muestras externas |
| `assets/sprites/**/*.png` dibujados por recetas (suelos, muros, decoración, items y criaturas listados en `tools/spritegen/src/recipes/`) | Neque's Realm (pixel art generado por código) | CC0 1.0 | `tools/spritegen` (`make spritegen`). Recetas propias, sin calcar ni copiar sprites de terceros |
| `assets/sprites/effects/<nombre>/<n>.png` (tiras animadas de efectos de combate y magia: golpe, bloqueo, curación, conjuro, cosecha, refuerzo y los 7 elementos) | Neque's Realm (pixel art generado por código) | CC0 1.0 | `tools/spritegen/src/recipes/effects.ts` (`make spritegen ONLY=effects/`). Partículas, destellos y estallidos propios, sin tomar formas ni tiempos de efectos de otros juegos |
| `assets/sprites/ui/marks/*.png`: marcas PvP (T5.2) del canvas y de la lista de batalla (espadas cruzadas del agresor, gota del asesino, escudo partido del proscrito) | Neque's Realm (pixel art propio) | CC0 1.0 | `tools/spritegen/src/recipes/ui.ts` (`make spritegen ONLY=ui/`). Diseño propio, sin calcar las marcas de otros juegos. Sin el sprite en el atlas, el cliente dibuja el placeholder de formas de antes (`drawSkull` en `client/src/render/game-canvas.ts`, `.skull` en `client/src/ui/client.css`) |
| `assets/sprites/decor/{ladder_up,ladder_down,hole,rope_spot,teleport}.png`: el aspecto de los portales (escalera de mano y su trampilla, agujero, hueco en el techo con luz, portal arcano) | Neque's Realm (pixel art propio) | CC0 1.0 | `tools/spritegen/src/recipes/portals.ts` (`make spritegen ONLY=decor/`). Diseño propio, sin calcar los de otros juegos. Las escaleras (`decor/stairs_down`, `decor/stairs_up`) siguen saliendo del pack Dungeon Crawl |
| `client/public/icons/*.png` (íconos placeholder de la PWA, T5.6: escudo con espada) | Neque's Realm (pixel art generado por código) | CC0 1.0 | `node --experimental-strip-types tools/spritegen/src/pwa-icons.ts`. Dibujo propio de 32x32 escalado; el test exige que los PNG coincidan con el código |
| Isla Volcánica (T5.5): música, ambiente, suelos, bordes y cartel | Neque's Realm | CC0 1.0 | Música y ambiente propios: `sounds/music/volcan.ogg` y `sounds/ambient/volcan.ogg` (`tools/soundgen`, recetas `music/volcan` y `ambient/volcan`). Suelos (`ground/ash`, `basalt`, `cinder_path`, `cooled_lava`, `lava`) y `decor/signpost` de `tools/spritegen`; sus bordes (`sprites/borders/{ash_sand,cooled_lava_*,cinder_path_ash}_*`) los recorta `gen-borders` de ese arte. El resto de sus sprites sale del pack Dungeon Crawl |
| Isla de Pruebas (sandbox, `docs/16-probar-el-juego.md`): llave de latón `tools/brass_key` | Neque's Realm (pixel art propio) | CC0 1.0 | `tools/spritegen/src/recipes/items.ts` (`make spritegen ONLY=tools/brass_key`). La puerta de práctica (`dngn/doors/closed_door.png`, `open_door.png`) y los tres NPCs (`mon/human.png`, `mon/unique/terence.png`, `mon/unique/harold.png`) salen del pack Dungeon Crawl |
| Auditoría de contenido (2026-11): grebas de acero de ascua `armor/embersteel_greaves` | Neque's Realm (pixel art propio) | CC0 1.0 | `tools/spritegen/src/recipes/items.ts` (`make spritegen ONLY=armor/embersteel_greaves`). Las demás armas, piezas, virotes y brebajes nuevos usan tiles del pack Dungeon Crawl (CC0, fila de arriba; mapeo en `assets/sprites.yaml`) |

## Fuentes (OFL 1.1)

Las de la UI (`docs/17-direccion-de-arte-y-ui.md`, UI-3). Cada familia va con una fila:
los `.ttf` de `https://github.com/google/fonts` tal cual, en `assets/vendor/font-<familia>/`,
junto con su `OFL.txt` y una copia como `LICENSE.txt`. Una familia con "Reserved Font
Name" en su `OFL.txt` no se recorta ni se convierte con su nombre: ninguna de estas lo
tiene. El cliente no usa los `.ttf` tal cual:
`client/vite/fonts.ts` los recorta al latín que usa el juego y los pasa a woff2 al servirlos
(`/fonts/`) y en el build; esos woff2 no se guardan en el repo.

| Familia | Autor (copyright del `OFL.txt`) | Licencia | Fuente (URL con commit) | Carpeta |
|---|---|---|---|---|
| Cinzel (`Cinzel[wght].ttf`) | Copyright 2020 The Cinzel Project Authors (https://github.com/NDISCOVER/Cinzel) | OFL 1.1 | https://github.com/google/fonts/tree/7af0d90b4d532ffa4b041937b560c6df4e7b1e95/ofl/cinzel | `assets/vendor/font-cinzel/` |
| Grenze Gotisch (`GrenzeGotisch[wght].ttf`) | Copyright 2020 The Grenze Gotisch Project Authors (https://github.com/Omnibus-Type/Grenze-Gotisch) | OFL 1.1 | https://github.com/google/fonts/tree/7af0d90b4d532ffa4b041937b560c6df4e7b1e95/ofl/grenzegotisch | `assets/vendor/font-grenzegotisch/` |
| Alegreya Sans (`AlegreyaSans-{Regular,Italic,Medium,Bold}.ttf`) | Copyright 2013 The Alegreya Sans Project Authors (https://github.com/huertatipografica/Alegreya-Sans) | OFL 1.1 | https://github.com/google/fonts/tree/7af0d90b4d532ffa4b041937b560c6df4e7b1e95/ofl/alegreyasans | `assets/vendor/font-alegreyasans/` |
| Alegreya (`Alegreya[wght].ttf`, `Alegreya-Italic[wght].ttf`) | Copyright 2011 The Alegreya Project Authors (https://github.com/huertatipografica/Alegreya) | OFL 1.1 | https://github.com/google/fonts/tree/7af0d90b4d532ffa4b041937b560c6df4e7b1e95/ofl/alegreya | `assets/vendor/font-alegreya/` |

## Obras derivadas de terceros

Todavía ninguna. Son sprites que una herramienta propia arma a partir de archivos de
`assets/vendor/` (capas de LPC compuestas en un atuendo, recoloreados). Van en
`assets/sprites/derived/<pack>/` con la licencia de su origen: lo que sale de un archivo
CC-BY-SA sigue siendo CC-BY-SA.

| Archivos | Sale de (pack y archivos de origen) | Licencia | Herramienta que los genera |
|---|---|---|---|
