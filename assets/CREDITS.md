# Créditos de assets

Todo asset de terceros debe tener una entrada aquí antes de usarse en el juego.
Licencias aceptadas: CC0, CC-BY 3.0/4.0, OGA-BY. **No** se aceptan assets sin licencia
clara, con licencia "no comercial" ni sacados de otros juegos.

`tools/spritepack` solo acepta un pack de `assets/vendor/<pack>/` si tiene una fila aquí
con esa carpeta y un archivo `LICENSE` dentro. Procedimiento completo: `assets/README.md`.

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
| `client/public/icons/*.png` (íconos placeholder de la PWA, T5.6: escudo con espada) | Neque's Realm (pixel art generado por código) | CC0 1.0 | `node --experimental-strip-types tools/spritegen/src/pwa-icons.ts`. Dibujo propio de 32x32 escalado; el test exige que los PNG coincidan con el código |
| Isla Volcánica (T5.5): música, ambiente, suelos, bordes y cartel | Neque's Realm | CC0 1.0 | Música y ambiente propios: `sounds/music/volcan.ogg` y `sounds/ambient/volcan.ogg` (`tools/soundgen`, recetas `music/volcan` y `ambient/volcan`). Suelos (`ground/ash`, `basalt`, `cinder_path`, `cooled_lava`, `lava`) y `decor/signpost` de `tools/spritegen`; sus bordes (`sprites/borders/{ash_sand,cooled_lava_*,cinder_path_ash}_*`) los recorta `gen-borders` de ese arte. El resto de sus sprites sale del pack Dungeon Crawl |
