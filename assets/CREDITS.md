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
| Marcas PvP (T5.2): icono de skull del canvas y de la lista de batalla | Neque's Realm | CC0 1.0 | Dibujado con formas en el código, sin imagen (`client/src/render/game-canvas.ts` `drawSkull`, `client/src/ui/client.css` `.skull`). Placeholder hasta tener sprite |
| `client/public/icons/*.png` (íconos placeholder de la PWA, T5.6: escudo con espada) | Neque's Realm (pixel art generado por código) | CC0 1.0 | `node --experimental-strip-types tools/spritegen/src/pwa-icons.ts`. Dibujo propio de 32x32 escalado; el test exige que los PNG coincidan con el código |
| Isla Volcánica (T5.5): música y ambiente | Neque's Realm | CC0 1.0 | Placeholders que reutilizan `music_cueva` y `amb_olas` (`assets/sounds.yaml`). Sus sprites salen del pack Dungeon Crawl o de `tools/spritegen` |
