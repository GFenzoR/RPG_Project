# Créditos de assets

Todo asset de terceros debe tener una entrada aquí antes de usarse en el juego.

**Licencias aceptadas:**
- Arte y sonido: CC0, CC-BY 3.0/4.0 y OGA-BY 3.0. Desde el 2026-11-17, por decisión del
  dueño, también **CC-BY-SA 3.0/4.0** (por ejemplo, Liberated Pixel Cup).
- Fuentes: **SIL OFL 1.1** (desde el 2026-11-17).
- Arte y música **generados con la cuenta de Gemini del dueño** (desde el 2026-11-17, por
  decisión del dueño): van en "Generado con IA", al final, con su herramienta, su fecha y su
  prompt commiteado. El prompt describe contenido propio y nunca nombra otro juego,
  artista ni obra.

**No** se aceptan: assets sin licencia clara, GPL como única licencia del archivo, "no
comercial" (NC), "sin derivados" (ND), "solo uso personal", licencias de tienda que no dejan
redistribuir (el repo es público), ni nada sacado de otros juegos.

Reglas que vienen con eso (detalle en `docs/17-direccion-de-arte-y-ui.md`, "SRC"):
- **Licencia por archivo.** En packs como los de LPC cada archivo trae la suya (`CREDITS.csv`
  o `Credits.txt` del origen): solo entran los archivos con una licencia aceptada. Si un
  archivo tiene varias, se elige una aceptada y la fila lo dice.
- **Atribución.** CC-BY, CC-BY-SA y OGA-BY piden autor, título, licencia y enlace, visibles
  para el jugador. La página `/credits` del sitio (enlazada desde el pie de cada página y
  desde Opciones en el juego; tarea A1 de docs/17) se arma con este archivo al construir el
  cliente (`client/vite/credits.ts`): la tabla de packs, "Fuentes" y "Obras derivadas de
  terceros", más el `CREDITS.csv` de cada pack con licencia por archivo. Un pack nuevo
  necesita además su nombre y autor en `i18n/{es,en}/site.yaml`
  (`site.credits.pack.<carpeta>.title` y `.author`, con los guiones de la carpeta como `_`): `make test` lo exige.
- **CC-BY-SA.** Lo que se derive de un archivo BY-SA (recoloreado, recortado, combinado)
  sigue siendo BY-SA y va en "Obras derivadas", nunca como obra propia CC0. Una página del
  atlas solo junta sprites: cada uno conserva su licencia, y el código y el arte propio no
  cambian de licencia.
- **DRM.** CC-BY y CC-BY-SA no permiten poner medidas técnicas que restrinjan el material.
  Antes de publicar en tiendas móviles (docs/15), hay que revisar esto. OGA-BY sí lo permite.

`tools/spritepack` solo acepta un pack de `assets/vendor/<pack>/` si tiene una fila aquí
con esa carpeta y un archivo `LICENSE` dentro. `make validate` exige lo mismo para los
sonidos. Las fuentes siguen la misma regla (`assets/vendor/font-<familia>/`, con su
`OFL.txt` copiado como `LICENSE.txt`). En un pack con licencia por archivo (un
`CREDITS.csv` en su carpeta), `make test` (spritepack, `src/licences.ts`) exige además una
fila con una licencia aceptada para cada PNG: sin fila o solo con GPL, falla.
Procedimiento completo: `assets/README.md`.

| Pack / archivo | Autor | Licencia | Fuente (URL) | Carpeta | Atribución requerida |
|---|---|---|---|---|---|
| Dungeon Crawl Stone Soup tiles (release Nov-2015) | Artistas de Dungeon Crawl Stone Soup (lista en `ARTISTS.md` del pack) | CC0 1.0 | https://github.com/crawl/tiles (también https://opengameart.org/content/dungeon-crawl-32x32-tiles) | `assets/vendor/dungeon-crawl/` | No (se acredita igual) |
| Universal LPC Spritesheet Character Generator: capas de personaje (cuerpos, cabezas, ropa, pelo, barbas, sombreros; 138 archivos: caminar, quieto, `slash`, `shoot`, `spellcast` y `hurt` de cada capa) | Varios, por archivo: ver `assets/vendor/ulpc/CREDITS.csv` (columnas `authors` y `urls`) | Por archivo (`CREDITS.csv`): se usan bajo OGA-BY 3.0 cuando el archivo la lista y si no bajo CC-BY-SA 3.0 (pelo largo, despeinado y la barba). Nunca bajo GPL | https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator (commit `04140673ec02906f8233523639733c83690df750`) | `assets/vendor/ulpc/` | Sí |

## Obra propia

| Archivos | Autor | Licencia | Fuente reproducible |
|---|---|---|---|
| `assets/sounds/**/*.ogg` (efectos, interfaz, música y ambiente), salvo `assets/sounds/music/gemini/` (música de Gemini, en "Generado con IA") | Neque's Realm (generado proceduralmente) | CC0 1.0 | `tools/soundgen` (`make sounds`). Recetas y melodías propias, sin muestras externas. Los temas de `sounds/music/{puerto,bosque,volcan,cueva}.ogg` siguen en el repo con sus recetas aunque un tema de Gemini los reemplace: son los que vuelven a sonar si el dueño elige `none` (`assets/sounds/music/gemini.yaml`) |
| `assets/sprites/**/*.png` dibujados por recetas (suelos, muros, decoración, items y criaturas listados en `tools/spritegen/src/recipes/`) | Neque's Realm (pixel art generado por código) | CC0 1.0 | `tools/spritegen` (`make spritegen`). Recetas propias, sin calcar ni copiar sprites de terceros |
| `assets/sprites/creatures/{bristleback_boar,bramble_stag}/*.png`, `assets/sprites/npcs/forge_echo/*.png`, `assets/sprites/decor/{anvil,cargo_crate,signpost,market_board}.png` y `assets/sprites/decor/market_board/frame_<n>.png`: frames del motor de sprites (jabalí y ciervo: quieto, caminar, atacar y morir en cuatro direcciones; el eco de la forja: quieto y caminar; el yunque, el cajón y el cartel; el tablero del mercado, animado: una nota que se levanta con el viento) | Neque's Realm (pixel art generado por código) | CC0 1.0 | `tools/spritegen/src/engine/` (`make spritegen`): modelos propios en `engine/specs/` con las reglas de estilo de `docs/17` (aprendidas de las referencias, sin copiar ni calcar ningún sprite de otro juego). El eco reemplaza al `mon/nonliving/fire_elemental.png` de Dungeon Crawl, que sigue en `assets/vendor/dungeon-crawl/` |
| `assets/sprites/effects/<nombre>/<n>.png` (tiras animadas de efectos de combate y magia: golpe, bloqueo, curación, conjuro, cosecha, refuerzo y los 7 elementos) | Neque's Realm (pixel art generado por código) | CC0 1.0 | `tools/spritegen/src/recipes/effects.ts` (`make spritegen ONLY=effects/`). Partículas, destellos y estallidos propios, sin tomar formas ni tiempos de efectos de otros juegos |
| `assets/sprites/ui/slots/*.png`: siluetas de los slots vacíos del equipo (docs/17 UI-5: yelmo, amuleto, mochila, túnica, espada, escudo, pantalón, bota, anillo, flechas) | Neque's Realm (pixel art propio) | CC0 1.0 | `tools/spritegen/src/recipes/ui.ts` (`make spritegen ONLY=ui/slots/`). Máscaras propias de 20x20 dibujadas a mano, sin calcar los íconos de equipo de otros juegos |
| `assets/sprites/ui/marks/*.png`: marcas PvP (T5.2) del canvas y de la lista de batalla (espadas cruzadas del agresor, gota del asesino, escudo partido del proscrito) | Neque's Realm (pixel art propio) | CC0 1.0 | `tools/spritegen/src/recipes/ui.ts` (`make spritegen ONLY=ui/`). Diseño propio, sin calcar las marcas de otros juegos. Sin el sprite en el atlas, el cliente dibuja el placeholder de formas de antes (`drawSkull` en `client/src/render/game-canvas.ts`, `.skull` en `client/src/ui/client.css`) |
| `assets/sprites/decor/{ladder_up,ladder_down,hole,rope_spot,teleport}.png`: el aspecto de los portales (escalera de mano y su trampilla, agujero, hueco en el techo con luz, portal arcano) | Neque's Realm (pixel art propio) | CC0 1.0 | `tools/spritegen/src/recipes/portals.ts` (`make spritegen ONLY=decor/`). Diseño propio, sin calcar los de otros juegos. Las escaleras (`decor/stairs_down`, `decor/stairs_up`) siguen saliendo del pack Dungeon Crawl |
| La interfaz dibujada en código (docs/17 UI-2 y UI-4): los íconos de 16x16 de la botonera y las ventanas (`client/src/ui/icons.tsx`), los ornamentos góticos de las ventanas y de la barra de abajo (esquina dorada con granate, pináculo y remache: `client/src/ui/ornaments.ts`) y los SVG en línea del CSS (veta de piedra, sillares de la barra, ola de los orbes: `client/src/ui/client.css` y `windows.css`) | Neque's Realm (pixel art y SVG propios) | CC0 1.0 | Escritos como texto en esos archivos (un carácter por píxel, o el SVG tal cual). Diseño propio en el espíritu de piedra, hierro y oro viejo de docs/17; sin calcar marcos, orbes, íconos ni fuentes de Diablo, Tibia ni otros juegos |
| `client/public/icons/*.png` (íconos placeholder de la PWA, T5.6: escudo con espada) | Neque's Realm (pixel art generado por código) | CC0 1.0 | `node --experimental-strip-types tools/spritegen/src/pwa-icons.ts`. Dibujo propio de 32x32 escalado; el test exige que los PNG coincidan con el código |
| Isla Volcánica (T5.5): música, ambiente, suelos, bordes y cartel | Neque's Realm | CC0 1.0 | Música y ambiente propios: `sounds/music/volcan.ogg` y `sounds/ambient/volcan.ogg` (`tools/soundgen`, recetas `music/volcan` y `ambient/volcan`). Suelos (`ground/ash`, `basalt`, `cinder_path`, `cooled_lava`, `lava`) y `decor/signpost` de `tools/spritegen`; sus bordes (`sprites/borders/{ash_sand,cooled_lava_*,cinder_path_ash}_*`) los recorta `gen-borders` de ese arte. El resto de sus sprites sale del pack Dungeon Crawl, salvo las vetas, la puerta de la forja, la fragua y los muros (arte del mapa, fila de abajo) |
| Isla de Pruebas (sandbox, `docs/16-probar-el-juego.md`): llave de latón `tools/brass_key` | Neque's Realm (pixel art propio) | CC0 1.0 | `tools/spritegen/src/recipes/items.ts` (`make spritegen ONLY=tools/brass_key`). La puerta de práctica es arte del mapa (fila de abajo) y los tres NPCs, personajes de LPC (filas de "Obras derivadas de terceros") |
| Arte del mapa (docs/17 ART-3 a ART-7, 2026-11-18): las 16 piezas de 32x64 de cada muro (`walls/{stone_wall,wooden_wall,rock_wall}/wall_<n>`, `decor/{iron_vein,ember_vein}/wall_<n>`), las puertas `doors/{forge_gate,pruebas_gate}` (cerradas y abiertas), los suelos `ground/{grass,dirt,sand,wet_sand,stone_floor}` con sus looks (`var_<n>`), el agua, el bajío y la lava con sus frames (`frame_<n>`), los árboles y el arbusto con sus frames de viento y sus sombras (`shadow`), la fragua, el fogón, la antorcha y el estandarte de pared, el brasero y la fuente | Neque's Realm (pixel art generado por código) | CC0 1.0 | `tools/spritegen/src/recipes/{walls,ground,trees,props}.ts` (`make spritegen`). Diseño propio en 3/4 frontal; de Tibia y de los demás juegos de referencia solo se tomó la idea de muros con altura y suelos con variantes, sin mirar ni calcar ningún sprite. Reemplaza los tiles de Dungeon Crawl que esos sprites usaban (`brick_gray0`, `lab-rock0`, `grass0`, `mangrove1`, etc.) |
| `assets/sprites/borders/**` (bordes entre suelos y la espuma de orilla en 4 frames) | Neque's Realm (generado por código) | CC0 1.0 | `node --experimental-strip-types tools/spritepack/src/gen-borders.ts`: recorta el arte propio de cada suelo con una orilla ondulada |
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
| Pixelify Sans (`PixelifySans[wght].ttf`; nombres, gremios y números del canvas) | Copyright 2021 The Pixelify Sans Project Authors (https://github.com/eifetx/Pixelify-Sans) | OFL 1.1 | https://github.com/google/fonts/tree/7af0d90b4d532ffa4b041937b560c6df4e7b1e95/ofl/pixelifysans | `assets/vendor/font-pixelifysans/` |

## Obras derivadas de terceros

Son sprites que una herramienta propia arma a partir de archivos de `assets/vendor/` (capas
de LPC compuestas en un personaje, recoloreadas). Llevan la licencia de su origen, la de
la capa más restrictiva: si todas las capas listan OGA-BY 3.0 en `CREDITS.csv`, se usan
bajo esa y el sprite sale OGA-BY 3.0; con una sola capa que solo es CC-BY-SA (además de
GPL, que no se usa), el sprite entero sigue siendo CC-BY-SA. Los que arma
`tools/spritepack` desde `assets/sprites.yaml` (`animations`) no se commitean como PNG:
salen en el atlas generado, y su receta (capas y paletas) es la entrada de `sprites.yaml`.

Cada fila nombra sus sprites uno por uno, entre comillas invertidas: `make test`
(spritepack, `src/licences.ts`) calcula la licencia de cada sprite desde las filas de
`CREDITS.csv` de sus capas y falla si un sprite compuesto falta aquí o está con otra
licencia. Un personaje nuevo de LPC va en la fila de su licencia.

| Archivos | Sale de (pack y archivos de origen) | Licencia | Herramienta que los genera |
|---|---|---|---|
| Frames `<sprite>/<acción>_<dir>_<n>` del atlas (caminar, quieto y, los que pelean, ataque, disparo o conjuro y caída) de los atuendos `outfits/citizen`, `outfits/sailor`, `outfits/ranger` y `outfits/noble`, los monstruos `creatures/wreck_looter` y `creatures/coffer_smuggler` y los NPCs `npcs/merchant`, `npcs/priest_forest`, `npcs/sandbox_merchant` y `npcs/ferryman_volcanic` | Capas de `assets/vendor/ulpc/spritesheets/` que nombra cada entrada de `animations` de `assets/sprites.yaml` (autores en `assets/vendor/ulpc/CREDITS.csv`); todas listan OGA-BY 3.0 y se usan bajo esa. Recoloreadas con las paletas propias de `palettes` | OGA-BY 3.0 | `tools/spritepack` (`make sprites`): compone las capas, recolorea y corta los frames (`src/anims.ts`) |
| Frames `<sprite>/<acción>_<dir>_<n>` del atlas (los mismos) de los monstruos `creatures/obsidian_delver` y `creatures/drowned_miner` y los NPCs `npcs/sailor_old`, `npcs/armorer`, `npcs/priestess`, `npcs/miner_old`, `npcs/diver_old`, `npcs/druid_elder`, `npcs/tanner`, `npcs/ferryman`, `npcs/sandbox_trainer`, `npcs/sandbox_ferryman`, `npcs/forge_keeper`, `npcs/priest_volcanic` y `npcs/smith_volcanic` | Las mismas capas, más al menos una que solo es CC-BY-SA 3.0 (y GPL): la barba (`beards/beard/basic/`), el pelo largo (`hair/long/adult/`) o el despeinado (`hair/bedhead/adult/`). Recoloreadas con las paletas propias de `palettes` | CC-BY-SA 3.0 | `tools/spritepack` (`make sprites`): compone las capas, recolorea y corta los frames (`src/anims.ts`) |

## Generado con IA

Arte y música hechos con la cuenta de Gemini del dueño (la app web), permitidos desde el
2026-11-17 por decisión del dueño (`docs/17-direccion-de-arte-y-ui.md`, SRC-5). Reglas:
- **El prompt describe nuestro contenido** y nunca nombra otro juego, artista, compositor
  ni obra, ni pide imitarlos. `tools/gemini` se niega a enviar uno que lo haga.
- **Cada fila lleva su prompt commiteado**: `assets/prompts/<ruta del asset sin "assets/"
  ni extensión>.txt`, con el prompt exacto y su encabezado (herramienta, modo, fecha y
  referencias). `python tools/gemini/credit.py <sidecar.json> --asset <ruta>` lo escribe e
  imprime la fila de abajo.
- **Las referencias subidas con el pedido** (`--ref`) son solo archivos de `assets/` ya
  acreditados aquí (u obra propia); la fila las nombra en "Notas" y el archivo de prompt
  da su sha256.
- **Se acredita a Gemini como herramienta**, nunca como obra hecha a mano. Google no
  reclama la propiedad de lo generado. Estos archivos no son "Obra propia" (spritegen,
  soundgen) ni de terceros: la página `/credits` los lista en "Hecho con IA" (cada fila
  con sus sprites, su fecha y su archivo de prompt; `client/vite/credits.ts`).
- **Los sprites de criaturas** (2026-11-18): una hoja por criatura, pedida con
  `tools/gemini/gemini_web.py image` y cortada con `tools/gemini/import_art.py`. El archivo
  de prompt da también la hoja que volvió (sha256) y el comando exacto que la cortó (frames,
  espejados, escala), así se puede rehacer. El este de cada acción es el oeste espejado
  (`mirror: true` en `assets/sprites.yaml`). Reemplazan a los sprites de Dungeon Crawl que
  esas criaturas usaban (`wolf`, `zombie_rat`, `fire_crab`, `bat`, `jumping_spider`,
  `giant_frog`, `thorn_hunter` y, desde la segunda tanda, `giant_centipede`,
  `boulder_beetle`, `war_dog`, `salamander`, `earth_elemental`, `eastern_dragon` e
  `iron_elemental`), que siguen en `assets/vendor/dungeon-crawl/`.

| Archivos | Herramienta | Fecha | Prompt | Notas |
|---|---|---|---|---|
| `assets/sounds/music/gemini/title_1.ogg` | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-17 | `assets/prompts/sounds/music/gemini/title_1.txt` | «Salt on the Ancient Altar» (título de Gemini): toma 1 del tema `title`, para la pantalla de título (login y personajes). Tema completo (2:56), Ogg Opus estéreo a 48 kbps, con 7 puntos de entrada (`make music-gemini`) |
| `assets/sounds/music/gemini/town_puerto_1.ogg` | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-17 | `assets/prompts/sounds/music/gemini/town_puerto_1.txt` | «Salt-Stained Shore» (título de Gemini): toma 1 del tema `town_puerto`, para Puerto (también la isla de inicio y la de pruebas) (uno de los 3 temas que alterna el director de música). Tema completo (2:56), Ogg Opus estéreo a 48 kbps, con 7 puntos de entrada (`make music-gemini`) |
| `assets/sounds/music/gemini/town_puerto_2.ogg` | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-17 | `assets/prompts/sounds/music/gemini/town_puerto_2.txt` | Sin título (Gemini no le dio uno): toma 2 del tema `town_puerto`, para Puerto (también la isla de inicio y la de pruebas) (uno de los 3 temas que alterna el director de música). Tema completo (3:01), Ogg Opus estéreo a 48 kbps, con 7 puntos de entrada (`make music-gemini`) |
| `assets/sounds/music/gemini/town_puerto_3.ogg` | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-17 | `assets/prompts/sounds/music/gemini/town_puerto_3.txt` | «Beneath the Citadel Wall» (título de Gemini): toma 3 del tema `town_puerto`, para Puerto (también la isla de inicio y la de pruebas) (uno de los 3 temas que alterna el director de música). Tema completo (2:56), Ogg Opus estéreo a 48 kbps, con 7 puntos de entrada (`make music-gemini`) |
| `assets/sounds/music/gemini/bosque_1.ogg` | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-17 | `assets/prompts/sounds/music/gemini/bosque_1.txt` | «Beneath The Blackened Boughs» (título de Gemini): toma 1 del tema `bosque`, para la Isla del Bosque. Tema completo (2:59), Ogg Opus estéreo a 48 kbps, con 6 puntos de entrada (`make music-gemini`) |
| `assets/sounds/music/gemini/volcan_2.ogg` | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sounds/music/gemini/volcan_2.txt` | «Beneath the Obsidian Ridge» (título de Gemini): toma 2 del tema `volcan`, para la Isla Volcánica. Tema completo (2:59), Ogg Opus estéreo a 48 kbps, con 8 puntos de entrada (`make music-gemini`) |
| `assets/sounds/music/gemini/cave_1.ogg` | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-17 | `assets/prompts/sounds/music/gemini/cave_1.txt` | «Iron in the Deep» (título de Gemini): toma 1 del tema `cave`, para las minas y cuevas (pisos bajo el mar) (uno de los 7 temas que alterna el director de música). Tema completo (2:48), Ogg Opus estéreo a 40 kbps, con 5 puntos de entrada (`make music-gemini`) |
| `assets/sounds/music/gemini/cave_mine_1.ogg` | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sounds/music/gemini/cave_mine_1.txt` | «Weight of the Mountain» (título de Gemini): versión `mine_1` del tema `cave`, para las minas y cuevas (pisos bajo el mar) (uno de los 7 temas que alterna el director de música). Tema completo (2:59), Ogg Opus estéreo a 40 kbps, con 7 puntos de entrada (`make music-gemini`). **Provisional**: el dueño todavía no eligió |
| `assets/sounds/music/gemini/cave_crystal_1.ogg` | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sounds/music/gemini/cave_crystal_1.txt` | «Beneath the Cursed Spire» (título de Gemini): versión `crystal_1` del tema `cave`, para las minas y cuevas (pisos bajo el mar) (uno de los 7 temas que alterna el director de música). Tema completo (2:57), Ogg Opus estéreo a 40 kbps, con 6 puntos de entrada (`make music-gemini`). **Provisional**: el dueño todavía no eligió |
| `assets/sounds/music/gemini/cave_flooded_1.ogg` | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sounds/music/gemini/cave_flooded_1.txt` | «Beneath the Sunken Arch» (título de Gemini): versión `flooded_1` del tema `cave`, para las minas y cuevas (pisos bajo el mar) (uno de los 7 temas que alterna el director de música). Tema completo (2:58), Ogg Opus estéreo a 40 kbps, con 7 puntos de entrada (`make music-gemini`). **Provisional**: el dueño todavía no eligió |
| `assets/sounds/music/gemini/cave_abyss_1.ogg` | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sounds/music/gemini/cave_abyss_1.txt` | «The Sunless Vault» (título de Gemini): versión `abyss_1` del tema `cave`, para las minas y cuevas (pisos bajo el mar) (uno de los 7 temas que alterna el director de música). Tema completo (3:00), Ogg Opus estéreo a 40 kbps, con 7 puntos de entrada (`make music-gemini`). **Provisional**: el dueño todavía no eligió |
| `assets/sounds/music/gemini/cave_ossuary_1.ogg` | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sounds/music/gemini/cave_ossuary_1.txt` | «Beneath The Frozen Stone» (título de Gemini): versión `ossuary_1` del tema `cave`, para las minas y cuevas (pisos bajo el mar) (uno de los 7 temas que alterna el director de música). Tema completo (2:51), Ogg Opus estéreo a 40 kbps, con 7 puntos de entrada (`make music-gemini`). **Provisional**: el dueño todavía no eligió |
| `assets/sounds/music/gemini/cave_ember_1.ogg` | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sounds/music/gemini/cave_ember_1.txt` | «Beneath the Blackened Ridge» (título de Gemini): versión `ember_1` del tema `cave`, para las minas y cuevas (pisos bajo el mar) (uno de los 7 temas que alterna el director de música). Tema completo (2:57), Ogg Opus estéreo a 40 kbps, con 8 puntos de entrada (`make music-gemini`). **Provisional**: el dueño todavía no eligió |
| `assets/sounds/music/gemini/boss_forge_1.ogg` | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-17 | `assets/prompts/sounds/music/gemini/boss_forge_1.txt` | «Anvil of the Cursed Forge» (título de Gemini): toma 1 del tema `boss_forge`, para el guardián de la forja. Tema completo (2:59), Ogg Opus estéreo a 48 kbps, con 8 puntos de entrada (`make music-gemini`) |
| `assets/sprites/creatures/wolf/*.png` (frames de `creatures/wolf`, el lobo) | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sprites/creatures/wolf.txt` | 64x64; caminar, quieto, morder y morir |
| `assets/sprites/creatures/bilge_rat/*.png` (frames de `creatures/bilge_rat`, la rata de sentina) | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sprites/creatures/bilge_rat.txt` | 32x32; caminar, quieto, morder y morir |
| `assets/sprites/creatures/tide_crab/*.png` (frames de `creatures/tide_crab`, el cangrejo de marea) | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sprites/creatures/tide_crab.txt` | 32x32; caminar, quieto, pinzar (al norte y a los lados) y morir |
| `assets/sprites/creatures/gloom_bat/*.png` (frames de `creatures/gloom_bat`, el murciélago lóbrego) | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sprites/creatures/gloom_bat.txt` | 64x64; volar, quieto, morder (al sur y a los lados) y morir |
| `assets/sprites/creatures/moss_spider/*.png` (frames de `creatures/moss_spider`, la araña de musgo) | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sprites/creatures/moss_spider.txt` | 64x64; caminar, quieto, morder y morir |
| `assets/sprites/creatures/mire_toad/*.png` (frames de `creatures/mire_toad`, el sapo de ciénaga) | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sprites/creatures/mire_toad.txt` | 64x64; saltar, quieto (al sur y a los lados), atacar a los lados y morir |
| `assets/sprites/creatures/thornling/*.png` (frames de `creatures/thornling`, el espinoso) | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sprites/creatures/thornling.txt` | 64x64; caminar, quieto, azotar (al sur y a los lados) y morir |
| `assets/sprites/creatures/hollow_crawler/*.png` (frames de `creatures/hollow_crawler`, el reptante hueco) | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sprites/creatures/hollow_crawler.txt` | 64x64; caminar, quieto, morder (al sur y a los lados) y morir |
| `assets/sprites/creatures/ore_beetle/*.png` (frames de `creatures/ore_beetle`, el escarabajo de mena) | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sprites/creatures/ore_beetle.txt` | 32x32; caminar, quieto y morir (ataca con la embestida) |
| `assets/sprites/creatures/ash_hound/*.png` (frames de `creatures/ash_hound`, el sabueso de ceniza) | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sprites/creatures/ash_hound.txt` | 64x64; correr, quieto (al sur y a los lados), morder (al sur y a los lados) y morir. Segunda hoja (la primera caminaba de costado hacia la cámara) |
| `assets/sprites/creatures/cinder_salamander/*.png` (frames de `creatures/cinder_salamander`, la salamandra de brasa) | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sprites/creatures/cinder_salamander.txt` | 64x64; caminar, quieto, morder a los lados y morir |
| `assets/sprites/creatures/slag_golem/*.png` (frames de `creatures/slag_golem`, el gólem de escoria) | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sprites/creatures/slag_golem.txt` | 64x64; caminar, quieto, golpear y morir. Segunda hoja (la primera era casi negra y chica) |
| `assets/sprites/creatures/ember_wyrmling/*.png` (frames de `creatures/ember_wyrmling`, el dragoncillo de ascua) | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sprites/creatures/ember_wyrmling.txt` | 64x64; caminar, quieto, morder a los lados y morir |
| `assets/sprites/creatures/slagbound_warden/*.png` (frames de `creatures/slagbound_warden`, el custodio de escoria, jefe del capítulo 3) | Gemini, app web con la cuenta del dueño (modo Hydrogen) | 2026-11-18 | `assets/prompts/sprites/creatures/slagbound_warden.txt` | 96x96; marchar, quieto, golpear con el martillo (al sur y al norte) y morir. Segunda hoja (la primera venía con líneas de grilla y el martillo cambiaba de mano) |
